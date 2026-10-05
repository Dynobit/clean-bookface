import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import yazl from 'yazl';
import yauzl from 'yauzl';
import { createApplication } from '../src/app.js';
import { Archive } from '../src/archive.js';
import { Store } from '../src/storage.js';

async function zipFiles(files: Map<string, Buffer>): Promise<Buffer> {
  const zip = new yazl.ZipFile(),
    chunks: Buffer[] = [];
  zip.outputStream.on('data', (b) => chunks.push(b));
  for (const [name, bytes] of files) zip.addBuffer(bytes, name);
  zip.end();
  await once(zip.outputStream, 'end');
  return Buffer.concat(chunks);
}
async function unzip(bytes: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) =>
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(error);
        return;
      }
      const files = new Map<string, Buffer>();
      zip.on('error', reject);
      zip.on('end', () => resolve(files));
      zip.on('entry', (entry) =>
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) {
            reject(e);
            return;
          }
          const parts: Buffer[] = [];
          stream.on('error', reject);
          stream.on('data', (b) => parts.push(b));
          stream.on('end', () => {
            files.set(entry.fileName, Buffer.concat(parts));
            zip.readEntry();
          });
        }),
      );
      zip.readEntry();
    }),
  );
}
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'bookface-portable-test-'));
  const origin = 'http://old-circle.example';
  const runtime = createApplication({
    origin,
    dataDir: join(root, 'source'),
    production: false,
    federation: false,
    host: '127.0.0.1',
    port: 3000,
    maxUploadBytes: 1024 ** 2,
    instanceName: 'Synthetic circle',
  });
  t.after(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  const { user } = await runtime.core.setup({
    username: 'alice',
    displayName: 'Alice Example',
    password: 'fictional-portable-password',
  });
  const input = join(root, 'facebook');
  await mkdir(join(input, 'photos'), { recursive: true });
  await mkdir(join(input, 'messages'), { recursive: true });
  await sharp({ create: { width: 30, height: 20, channels: 3, background: '#486594' } })
    .jpeg()
    .toFile(join(input, 'photos', 'memory.jpg'));
  const posts = [
    {
      id: 'history',
      timestamp: 946684800,
      data: [{ post: 'Original memory — Café שלום 🌻\nA second line.' }],
    },
    {
      id: 'photo',
      timestamp: 946684810,
      attachments: [{ data: [{ media: { uri: 'photos/memory.jpg' } }] }],
    },
  ];
  await writeFile(join(input, 'posts.json'), JSON.stringify(posts));
  await writeFile(
    join(input, 'messages', 'message_1.json'),
    JSON.stringify({
      thread_path: 'synthetic-thread',
      title: 'Private conversation',
      messages: [
        {
          message_id: 'one',
          timestamp_ms: 946684800000,
          sender_name: 'Morgan Example',
          content: 'A private message remains private.',
        },
      ],
    }),
  );
  await runtime.archive.importDirectory(user.id, input);
  const first = runtime.archive.list(user.id).find((p) => p.body.startsWith('Original memory'))!;
  posts[0]!.data![0]!.post = 'Revised memory — Café שלום 🌻\nThe complete revised text.';
  await writeFile(join(input, 'posts.json'), JSON.stringify(posts));
  await runtime.archive.importDirectory(user.id, input);
  const photo = runtime.archive.list(user.id).find((p) => p.mediaIds.length)!;
  const shared = await runtime.archive.shareCopy(user.id, photo.id);
  const native = runtime.core.publish(user.id, {
    body: 'My own native post',
    audience: 'private',
    mediaIds: shared.media.map((m) => m.id),
  });
  runtime.core.comment(user.id, native.id, 'My own portable comment');
  const session = await runtime.core.login('alice', 'fictional-portable-password');
  const response = await runtime.app.fetch(
    new Request(`${origin}/actions/export`, {
      method: 'POST',
      headers: {
        origin,
        cookie: `bookface=${session.token}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ csrf: session.csrf }),
    }),
  );
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  return { root, runtime, user, bytes, sourceKey: first.sourceKey, shared, photo };
}
async function target(t: test.TestContext, root: string, limits = {}) {
  const store = new Store(join(root, `target-${Math.random().toString(16).slice(2)}`));
  const archive = new Archive(store, { limits });
  t.after(() => store.close());
  return { store, archive };
}

test('the actual HTTP member export imports privately on a fresh host, with exact text/media and idempotent revisions', async (t) => {
  const f = await fixture(t),
    { store, archive } = await target(t, f.root);
  const path = join(f.root, 'account-export.zip');
  await writeFile(path, f.bytes);
  const report = await archive.importZip('new-owner', path);
  assert.equal(report.added, 6);
  const records = archive.list('new-owner'),
    current = records.find((r) => r.sourceKey === f.sourceKey)!;
  assert.equal(current.body, 'Revised memory — Café שלום 🌻\nThe complete revised text.');
  assert.equal(current.occurredAt, 946684800000);
  assert.equal((current.metadata.portable as any).sourceVersion, 2);
  const history = records.find((r) => r.title.startsWith('Earlier version 1:'))!;
  assert.equal(history.body, 'Original memory — Café שלום 🌻\nA second line.');
  const native = records.find(
    (r) => (r.metadata.portable as any)?.category === 'authored-publication',
  )!;
  assert.equal(native.body, 'My own native post');
  const comment = records.find(
    (r) => (r.metadata.portable as any)?.category === 'authored-comment',
  )!;
  assert.equal(comment.kind, 'message');
  assert.equal(comment.body, 'My own portable comment');
  await assert.rejects(() => archive.shareCopy('new-owner', comment.id), /Only your posts/);
  const original = records.find((r) => r.sourceKey === f.photo.sourceKey)!;
  assert.deepEqual(
    await readFile(archive.media('new-owner', original.mediaIds[0]!)!.path),
    await readFile(f.runtime.archive.media(f.user.id, f.photo.mediaIds[0]!)!.path),
  );
  const importedDerivative = archive.media('new-owner', native.mediaIds[0]!)!;
  assert.equal(importedDerivative.purpose, 'original');
  assert.equal(archive.isShareableMedia('new-owner', importedDerivative.id), false);
  assert.deepEqual(
    await readFile(importedDerivative.path),
    await readFile(f.shared.media[0]!.path),
  );
  assert.equal(archive.get('stranger', current.id), null);
  assert.equal(archive.media('stranger', importedDerivative.id), null);
  assert.equal(archive.count('stranger'), 0);
  const usage = archive.usage('new-owner');
  const repeated = await archive.importZip('new-owner', path);
  assert.equal(repeated.added, 0);
  assert.equal(repeated.unchanged, 6);
  assert.equal(archive.usage('new-owner'), usage);
  assert.equal(
    store.db
      .prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('users','friendships','recipients','publications','domain_events','federation_keys')",
      )
      .get()!.n,
    0,
  );
  const secondExport: Buffer[] = [];
  for await (const chunk of archive.exportZip('new-owner')) secondExport.push(chunk as Buffer);
  const secondFile = join(f.root, 'second-host.zip');
  await writeFile(secondFile, Buffer.concat(secondExport));
  const second = await target(t, f.root);
  await second.archive.importZip('third-owner', secondFile);
  assert.equal(second.archive.count('third-owner'), 6);
  const secondNative = second.archive
    .list('third-owner')
    .find((r) => r.sourceKey === native.sourceKey)!;
  assert.equal(secondNative.body, native.body);
  assert.equal((secondNative.metadata.portable as any).category, 'authored-publication');
  assert.equal((secondNative.metadata.portable as any).sourceActor, f.user.actor);
  assert.equal(
    second.archive.list('third-owner').find((r) => r.sourceKey === history.sourceKey)!.body,
    history.body,
  );
});

test('portable imports ignore account credentials, roles and live relationships, and accept an extracted export folder', async (t) => {
  const f = await fixture(t),
    { archive, store } = await target(t, f.root);
  const outer = await unzip(f.bytes),
    account = JSON.parse(outer.get('account.json')!.toString());
  account.account.password_hash = 'DO_NOT_IMPORT_AUTH';
  account.account.privateKey = 'DO_NOT_IMPORT_AUTH';
  account.sessions = ['DO_NOT_IMPORT_AUTH'];
  account.recoveryCodes = ['DO_NOT_IMPORT_AUTH'];
  account.friendships = [{ actor: 'https://peer.example/users/friend', state: 'accepted' }];
  outer.set('account.json', Buffer.from(JSON.stringify(account)));
  const folder = join(f.root, 'unzipped', 'My export');
  await mkdir(folder, { recursive: true });
  for (const [name, bytes] of outer) await writeFile(join(folder, name), bytes);
  await archive.importDirectory('owner', join(f.root, 'unzipped'));
  assert.equal(archive.count('owner'), 6);
  for (const row of store.db.prepare('SELECT body,metadata FROM archive_items').all())
    assert.equal(JSON.stringify(row).includes('DO_NOT_IMPORT_AUTH'), false);
  assert.equal(archive.list('owner', { kind: 'friend' }).length, 0);
});

test('portable manifests reject missing or altered media and unsafe paths before committing records', async (t) => {
  const f = await fixture(t);
  const outer = await unzip(f.bytes),
    baseline = await unzip(outer.get('private-archive.zip')!);
  for (const change of [
    'missing',
    'hash',
    'path',
    'reference',
    'nested',
    'invalid-media',
  ] as const) {
    const { archive } = await target(t, f.root);
    const inner = new Map(baseline);
    const manifest = JSON.parse(inner.get('manifest.json')!.toString());
    if (change === 'missing') inner.delete(manifest.media[0].file);
    if (change === 'hash') manifest.media[0].sha256 = '0'.repeat(64);
    if (change === 'path') manifest.media[0].file = '../../outside.original';
    if (change === 'reference') {
      const rows = inner
        .get('archive.ndjson')!
        .toString()
        .trim()
        .split('\n')
        .map((s) => JSON.parse(s));
      rows[0].mediaIds = ['unknown-media'];
      inner.set(
        'archive.ndjson',
        Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + '\n'),
      );
    }
    if (change === 'nested') inner.set('another.zip', Buffer.from('untrusted nested content'));
    if (change === 'invalid-media') {
      const invalid = Buffer.from('This is not a supported image or media file.');
      for (const medium of manifest.media) {
        inner.set(medium.file, invalid);
        medium.size = invalid.length;
        medium.sha256 = createHash('sha256').update(invalid).digest('hex');
      }
    }
    inner.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
    const edited = new Map(outer);
    edited.set('private-archive.zip', await zipFiles(inner));
    const input = join(f.root, `${change}.zip`);
    await writeFile(input, await zipFiles(edited));
    await assert.rejects(
      () => archive.importZip('owner', input),
      /missing|integrity|Unsafe|unsafe|Unexpected|Unsupported|supported|image/i,
    );
    assert.equal(archive.count('owner'), 0);
    assert.equal(archive.mediaUsage('owner'), 0);
  }
});

test('the single nested portable ZIP shares the outer expansion and file-count budgets', async (t) => {
  const f = await fixture(t),
    outer = await unzip(f.bytes),
    inner = await unzip(outer.get('private-archive.zip')!);
  const outerSize = [...outer.values()].reduce((n, b) => n + b.length, 0),
    innerSize = [...inner.values()].reduce((n, b) => n + b.length, 0);
  const limit = Math.max(outerSize, innerSize) + 1;
  assert.ok(limit < outerSize + innerSize);
  const file = join(f.root, 'budget.zip');
  await writeFile(file, f.bytes);
  const bytes = await target(t, f.root, { maxExpandedBytes: limit });
  await assert.rejects(() => bytes.archive.importZip('owner', file), /expansion|expanded|budget/);
  assert.equal(bytes.archive.count('owner'), 0);
  const files = await target(t, f.root, { maxFiles: inner.size + 1 });
  await assert.rejects(() => files.archive.importZip('owner', file), /count|budget/);
  assert.equal(files.archive.count('owner'), 0);
  const records = await target(t, f.root, { maxRecords: 5 });
  await assert.rejects(() => records.archive.importZip('owner', file), /record limit/);
  assert.equal(records.archive.count('owner'), 0);
  assert.equal(records.archive.mediaUsage('owner'), 0);
});

test('standalone private archive export also imports without inventing social content', async (t) => {
  const f = await fixture(t),
    outer = await unzip(f.bytes),
    { archive } = await target(t, f.root);
  const file = join(f.root, 'archive-only.zip');
  await writeFile(file, outer.get('private-archive.zip')!);
  const result = await archive.importZip('owner', file);
  assert.equal(result.added, 4);
  assert.equal(
    archive
      .list('owner')
      .some((r) => (r.metadata.portable as any)?.category === 'authored-publication'),
    false,
  );
});
