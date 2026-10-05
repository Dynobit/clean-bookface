import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import sharp from 'sharp';
import yazl from 'yazl';
import yauzl from 'yauzl';
import { Archive } from '../src/archive.js';
import { Store } from '../src/storage.js';

async function context(t: test.TestContext, limits = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bookface-archive-test-'));
  const store = new Store(join(root, 'data'));
  const archive = new Archive(store, { limits });
  t.after(async () => {
    await archive.stopWorker();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const input = join(root, 'input');
  await mkdir(input);
  return { root, store, archive, input };
}
async function json(root: string, name: string, value: unknown) {
  const path = join(root, name);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}
async function photo(root: string, name = 'photos/synthetic.jpg') {
  const path = join(root, name);
  await mkdir(join(path, '..'), { recursive: true });
  await sharp({ create: { width: 24, height: 12, channels: 3, background: '#406590' } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toFile(path);
  return path;
}
async function zipBytes(files: Array<{ name: string; bytes: Buffer; mode?: number }>) {
  const zip = new yazl.ZipFile();
  const chunks: Buffer[] = [];
  zip.outputStream.on('data', (b) => chunks.push(b));
  for (const file of files) zip.addBuffer(file.bytes, file.name, { mode: file.mode });
  zip.end();
  await once(zip.outputStream, 'end');
  return Buffer.concat(chunks);
}
async function unZip(input: Buffer) {
  return new Promise<Map<string, Buffer>>((resolve, reject) => {
    yauzl.fromBuffer(input, { lazyEntries: true }, (e, zip) => {
      if (e || !zip) {
        reject(e);
        return;
      }
      const entries = new Map<string, Buffer>();
      zip.on('error', reject);
      zip.on('end', () => resolve(entries));
      zip.on('entry', (entry) =>
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) {
            reject(error);
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('error', reject);
          stream.on('data', (b) => chunks.push(b));
          stream.on('end', () => {
            entries.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        }),
      );
      zip.readEntry();
    });
  });
}

test('old dates, exact Unicode, equal text and attachment-only posts survive; imports remain owner scoped', async (t) => {
  const { archive, input } = await context(t);
  await photo(input);
  await json(
    input,
    'your_facebook_activity/posts/your_posts__check_ins__photos_and_videos_1.json',
    [
      { id: 'old', timestamp: 946684800, data: [{ post: 'Café שלום 🐦' }] },
      { id: 'same-a', timestamp: 1000000000, data: [{ post: 'Same' }] },
      { id: 'same-b', timestamp: 1000000100, data: [{ post: 'Same' }] },
      { id: 'missing-date', data: [{ post: 'Date deliberately unknown' }] },
      {
        id: 'photo',
        timestamp: 1000000200,
        attachments: [{ data: [{ media: { uri: 'photos/synthetic.jpg' } }] }],
      },
    ],
  );
  const report = await archive.importDirectory('alice', input);
  assert.equal(report.added, 5);
  const items = archive.list('alice');
  assert.equal(items.length, 5);
  assert.equal(items.find((i) => i.body.startsWith('Café'))?.occurredAt, 946684800000);
  assert.equal(items.at(-1)?.occurredAt, null);
  assert.equal(archive.list('bob').length, 0);
  assert.equal(archive.list('alice', { query: 'שלום' }).length, 1);
  const attached = items.find((i) => i.mediaIds.length)!;
  assert.equal(attached.body, '');
  assert.equal(archive.get('bob', attached.id), null);
  assert.equal(archive.media('bob', attached.mediaIds[0]!), null);
  assert.equal(archive.media('alice', attached.mediaIds[0]!)?.purpose, 'original');
  const repeat = await archive.importDirectory('alice', input);
  assert.equal(repeat.added, 0);
  assert.equal(repeat.unchanged, 5);
  assert.equal(archive.count('alice'), 5);
});

test('stable provider identities revise without losing previous history and isolate owners', async (t) => {
  const { archive, input, store } = await context(t);
  await json(input, 'posts.json', [{ id: '42', timestamp: 42, data: [{ post: 'Original' }] }]);
  await archive.importDirectory('alice', input);
  const original = archive.list('alice')[0]!;
  await json(input, 'posts.json', [{ id: '42', timestamp: 42, data: [{ post: 'Revised' }] }]);
  const revised = await archive.importDirectory('alice', input);
  assert.equal(revised.revised, 1);
  assert.equal(archive.get('alice', original.id)?.body, 'Revised');
  assert.equal(archive.get('alice', original.id)?.version, 2);
  const historical = store.db
    .prepare('SELECT record FROM archive_versions WHERE owner_id=?')
    .get('alice')!;
  assert.equal(JSON.parse(String(historical.record)).body, 'Original');
  await archive.importDirectory('bob', input);
  assert.equal(archive.count('bob'), 1);
  assert.equal(archive.get('bob', original.id), null);
});

test('split conversations dedupe explicit IDs within their thread without cross-thread collision', async (t) => {
  const { archive, input } = await context(t);
  const message = {
    message_id: 'm1',
    timestamp_ms: 1000,
    sender_name: 'Morgan',
    content: 'Hello 🌱',
  };
  await json(input, 'messages/inbox/thread-a/message_1.json', {
    thread_path: 'thread-a',
    title: 'A',
    messages: [message],
  });
  await json(input, 'messages/inbox/thread-a/message_2.json', {
    thread_path: 'thread-a',
    title: 'A',
    messages: [message, { ...message, message_id: 'm2', timestamp_ms: 2000 }],
  });
  await json(input, 'messages/inbox/thread-b/message_1.json', {
    thread_path: 'thread-b',
    title: 'B',
    messages: [message],
  });
  await json(input, 'friends/friends.json', {
    friends_v2: [{ name: 'Fictional Friend', timestamp: 1 }],
  });
  await json(input, 'profile_information/profile.json', {
    profile_v2: { name: { full_name: 'Fictional Owner' } },
  });
  const report = await archive.importDirectory('alice', input);
  assert.equal(report.added, 5);
  assert.equal(report.skipped, 1);
  const messages = archive.list('alice', { kind: 'message' });
  assert.equal(messages.length, 3);
  for (const item of archive.list('alice'))
    await assert.rejects(archive.shareCopy('alice', item.id), /Only your posts/);
});

test('sharing creates orientation-correct metadata-free derivatives and excludes third-party comments', async (t) => {
  const { archive, input } = await context(t);
  await photo(input);
  await json(input, 'posts.json', [
    {
      id: 'p',
      data: [{ post: 'My memory' }],
      comments: [{ text: 'PRIVATE THIRD PARTY' }],
      attachments: [{ data: [{ media: { uri: 'photos/synthetic.jpg' } }] }],
    },
  ]);
  await archive.importDirectory('alice', input);
  const item = archive.list('alice')[0]!;
  const shared = await archive.shareCopy('alice', item.id);
  assert.equal(shared.body, 'My memory');
  assert.equal(JSON.stringify(shared).includes('PRIVATE THIRD PARTY'), false);
  assert.notEqual(shared.media[0]!.id, item.mediaIds[0]);
  assert.equal(archive.isShareableMedia('alice', item.mediaIds[0]!), false);
  assert.equal(archive.isShareableMedia('alice', shared.media[0]!.id), true);
  assert.equal(archive.isShareableMedia('bob', shared.media[0]!.id), false);
  const m = await sharp(shared.media[0]!.path).metadata();
  assert.equal(m.exif, undefined);
  assert.equal(m.orientation, undefined);
  assert.equal(m.width, 12);
  assert.equal(m.height, 24);
  const original = await sharp(archive.media('alice', item.mediaIds[0]!)!.path).metadata();
  assert.equal(original.orientation, 6);
});

test('malformed JSON rolls back all staged items and media, leaving previous archive untouched', async (t) => {
  const { archive, input, store } = await context(t);
  await photo(input);
  await json(input, 'posts.json', [
    { id: 'p', attachments: [{ data: [{ media: { uri: 'photos/synthetic.jpg' } }] }] },
  ]);
  await writeFile(join(input, 'zz-malformed.json'), '{not json');
  await assert.rejects(archive.importDirectory('alice', input), /malformed/);
  assert.equal(archive.count('alice'), 0);
  assert.equal(archive.mediaUsage('alice'), 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM archive_stage').get()!.n, 0);
  assert.equal(archive.jobs('alice')[0]?.status, 'failed');
});

test('paths, symlinks, expansion, pixel and owner storage limits fail closed', async (t) => {
  const { archive, input } = await context(t, { ownerBytes: 10 });
  await photo(input);
  await json(input, 'posts.json', [
    { id: 'p', attachments: [{ data: [{ media: { uri: 'photos/synthetic.jpg' } }] }] },
  ]);
  await assert.rejects(archive.importDirectory('alice', input), /allowance/);
  await json(input, 'posts.json', [
    { id: 'p', attachments: [{ data: [{ media: { uri: '../secret.jpg' } }] }] },
  ]);
  // Invalid references are left unlinked; this tiny account still cannot admit the text.
  await assert.rejects(archive.importDirectory('alice', input), /allowance/);
  await symlink(join(input, 'posts.json'), join(input, 'link.json'));
  await assert.rejects(archive.importDirectory('alice', input), /links/);
});

test('ZIP import accepts valid content and rejects traversal, symlinks and compression bombs', async (t) => {
  const { archive, root } = await context(t, { maxExpandedBytes: 2 * 1024 * 1024 });
  const good = await zipBytes([
    {
      name: 'part1/posts.json',
      bytes: Buffer.from(JSON.stringify([{ id: 'z', data: [{ post: 'ZIP works' }] }])),
    },
  ]);
  const zipPath = join(root, 'input.zip');
  await writeFile(zipPath, good);
  assert.equal((await archive.importZip('alice', zipPath)).added, 1);
  const traversal = await zipBytes([{ name: 'aa/posts.json', bytes: Buffer.from('[]') }]);
  // Same-length replacement changes local and central filenames, preserving ZIP framing.
  await writeFile(
    zipPath,
    Buffer.from(
      traversal.toString('binary').replaceAll('aa/posts.json', '../posts.json'),
      'binary',
    ),
  );
  await assert.rejects(archive.importZip('alice', zipPath));
  await writeFile(
    zipPath,
    await zipBytes([{ name: 'link', bytes: Buffer.from('/etc/passwd'), mode: 0o120777 }]),
  );
  await assert.rejects(archive.importZip('alice', zipPath), /links/);
  await writeFile(
    zipPath,
    await zipBytes([{ name: 'posts.json', bytes: Buffer.alloc(3 * 1024 * 1024, 32) }]),
  );
  await assert.rejects(archive.importZip('alice', zipPath), /expansion/);
  assert.equal(archive.count('alice'), 1);
});

test('queued cancellation never commits and export contains only owner records and media', async (t) => {
  const { archive, input } = await context(t);
  await photo(input);
  await json(input, 'posts.json', [
    {
      id: 'p',
      data: [{ post: 'Alice private' }],
      attachments: [{ data: [{ media: { uri: 'photos/synthetic.jpg' } }] }],
    },
  ]);
  const cancelled = archive.enqueueImport('alice', input);
  assert.equal(archive.cancelJob('bob', cancelled), false);
  assert.equal(archive.cancelJob('alice', cancelled), true);
  await assert.rejects(archive.runJob(cancelled), /cancelled/);
  assert.equal(archive.job('alice', cancelled)?.status, 'cancelled');
  assert.equal(archive.job('bob', cancelled), null);
  await archive.importDirectory('alice', input);
  await json(input, 'posts.json', [{ id: 'p', data: [{ post: 'Bob private' }] }]);
  await archive.importDirectory('bob', input);
  const chunks = [];
  for await (const chunk of archive.exportZip('alice')) chunks.push(chunk);
  const exported = await unZip(Buffer.concat(chunks));
  const text = exported.get('archive.ndjson')!.toString('utf8');
  assert.ok(text.includes('Alice private'));
  assert.ok(!text.includes('Bob private'));
  const manifest = JSON.parse(exported.get('manifest.json')!.toString('utf8'));
  assert.equal(manifest.media.length, 1);
  assert.ok(exported.has(manifest.media[0].file));
  await archive.deleteOwner('alice');
  assert.equal(archive.count('alice'), 0);
  assert.equal(archive.mediaUsage('alice'), 0);
  assert.equal(archive.count('bob'), 1);
});

test('bounded worker consumes durable queued jobs across application restart', async (t) => {
  const { archive, input, store } = await context(t);
  await json(input, 'posts.json', [{ id: 'worker', data: [{ post: 'Imported in worker' }] }]);
  const id = archive.enqueueImport('alice', input);
  // A process interruption leaves a claimed job. Startup requeues it before visibility.
  store.db.prepare("UPDATE archive_jobs SET status='running' WHERE id=?").run(id);
  archive.startWorker();
  const deadline = Date.now() + 20000;
  while (
    Date.now() < deadline &&
    !['completed', 'failed'].includes(archive.job('alice', id)!.status)
  )
    await new Promise((r) => setTimeout(r, 50));
  assert.equal(
    archive.job('alice', id)?.status,
    'completed',
    archive.job('alice', id)?.error ?? 'Worker did not complete',
  );
  assert.equal(archive.list('alice')[0]?.body, 'Imported in worker');
});

test('multipart ZIP sets resolve media across parts without exposing partial results', async (t) => {
  const { archive, input, root } = await context(t);
  const image = await photo(root);
  const post = [
    { id: 'multipart', attachments: [{ data: [{ media: { uri: 'photos/synthetic.jpg' } }] }] },
  ];
  await writeFile(
    join(input, 'part1.zip'),
    await zipBytes([{ name: 'posts.json', bytes: Buffer.from(JSON.stringify(post)) }]),
  );
  await writeFile(
    join(input, 'part2.zip'),
    await zipBytes([{ name: 'photos/synthetic.jpg', bytes: await readFile(image) }]),
  );
  const report = await archive.importDirectory('alice', input);
  assert.equal(report.added, 1);
  assert.equal(archive.list('alice')[0]!.mediaIds.length, 1);
});

test('owner-wide text quotas cannot be bypassed with repeated imports or new provider IDs', async (t) => {
  const { archive, input } = await context(t, { ownerBytes: 1000 });
  await json(input, 'posts.json', [{ id: 'small', data: [{ post: 'Small' }] }]);
  await archive.importDirectory('alice', input);
  await json(input, 'posts.json', [{ id: 'large', data: [{ post: 'z'.repeat(1200) }] }]);
  await assert.rejects(archive.importDirectory('alice', input), /allowance/);
  assert.equal(archive.count('alice'), 1);
  assert.equal(archive.list('alice')[0]!.body, 'Small');
});

test('deleting an archive memory removes its original while explicitly shared copy stays independent', async (t) => {
  const { archive, input } = await context(t);
  await photo(input);
  await json(input, 'posts.json', [
    { id: 'delete', attachments: [{ data: [{ media: { uri: 'photos/synthetic.jpg' } }] }] },
  ]);
  await archive.importDirectory('alice', input);
  const item = archive.list('alice')[0]!;
  const shared = (await archive.shareCopy('alice', item.id)).media[0]!;
  const original = archive.media('alice', item.mediaIds[0]!)!;
  assert.equal(archive.deleteItem('bob', item.id), false);
  assert.equal(archive.deleteItem('alice', item.id), true);
  await assert.rejects(readFile(original.path));
  assert.equal(archive.media('alice', original.id), null);
  assert.equal(archive.media('alice', shared.id)?.purpose, 'shared');
  assert.equal(archive.deleteSharedMedia('bob', shared.id), false);
  assert.equal(archive.deleteSharedMedia('alice', shared.id), true);
  await assert.rejects(readFile(shared.path));
});

test('explicit millisecond timestamps and valid Unicode are not guessed or rewritten', async (t) => {
  const { archive, input } = await context(t);
  await json(input, 'messages/inbox/one/message_1.json', {
    messages: [{ message_id: 'epoch', timestamp_ms: 1000, content: 'Résumé עברית 😀' }],
  });
  await archive.importDirectory('alice', input);
  const message = archive.list('alice')[0]!;
  assert.equal(message.occurredAt, 1000);
  assert.equal(message.body, 'Résumé עברית 😀');
});

test('account deletion interrupts its worker, purges all data and continues other owners queued work', async (t) => {
  const { archive, input, root } = await context(t);
  await json(
    input,
    'posts.json',
    Array.from({ length: 5000 }, (_, i) => ({
      id: `alice-${i}`,
      data: [{ post: 'Synthetic stress fixture' }],
    })),
  );
  const other = join(root, 'other');
  await mkdir(other);
  await json(other, 'posts.json', [{ id: 'bob', data: [{ post: 'Bob remains' }] }]);
  const aliceJob = archive.enqueueImport('alice', input);
  const bobJob = archive.enqueueImport('bob', other);
  archive.startWorker();
  const startDeadline = Date.now() + 10000;
  while (Date.now() < startDeadline && archive.job('alice', aliceJob)?.status === 'queued')
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(archive.job('alice', aliceJob)?.status, 'running');
  assert.equal(archive.count('alice'), 0, 'A running import must not expose partial results');
  await archive.deleteOwner('alice');
  const deadline = Date.now() + 20000;
  while (
    Date.now() < deadline &&
    !['completed', 'failed'].includes(archive.job('bob', bobJob)!.status)
  )
    await new Promise((r) => setTimeout(r, 50));
  assert.equal(archive.count('alice'), 0);
  assert.equal(archive.mediaUsage('alice'), 0);
  assert.equal(archive.jobs('alice').length, 0);
  assert.equal(
    archive.job('bob', bobJob)?.status,
    'completed',
    archive.job('bob', bobJob)?.error ?? 'Bob job stalled',
  );
  assert.equal(archive.list('bob')[0]?.body, 'Bob remains');
});

test('native uploads reject active SVG and oversized pixel images; derivatives have no metadata', async (t) => {
  const { archive, input } = await context(t, { maxPixels: 500 });
  const native = await photo(input);
  const derivative = await archive.uploadPhoto('alice', native);
  assert.equal(derivative.mime, 'image/webp');
  assert.equal(derivative.purpose, 'shared');
  assert.equal((await sharp(derivative.path).metadata()).exif, undefined);
  const svg = join(input, 'active.svg');
  await writeFile(
    svg,
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><script>alert(1)</script></svg>',
  );
  await assert.rejects(archive.uploadPhoto('alice', svg), /Unsupported/);
  const huge = join(input, 'pixel-budget.png');
  await sharp({ create: { width: 30, height: 30, channels: 3, background: '#fff' } })
    .png()
    .toFile(huge);
  await assert.rejects(archive.uploadPhoto('alice', huge), /pixel/);
});

test('cancellation while a worker is running discards records and cleanup permits a fresh import', async (t) => {
  const { archive, input } = await context(t);
  await json(
    input,
    'posts.json',
    Array.from({ length: 5000 }, (_, i) => ({
      id: `cancel-${i}`,
      data: [{ post: 'Private staging' }],
    })),
  );
  const id = archive.enqueueImport('alice', input);
  archive.startWorker();
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && archive.job('alice', id)?.status === 'queued')
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(archive.job('alice', id)?.status, 'running');
  assert.equal(archive.cancelJob('alice', id), true);
  while (Date.now() < deadline && archive.job('alice', id)?.status === 'running')
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(archive.job('alice', id)?.status, 'cancelled');
  assert.equal(archive.count('alice'), 0);
  await archive.stopWorker();
  await json(input, 'posts.json', [{ id: 'fresh', data: [{ post: 'Fresh import' }] }]);
  assert.equal((await archive.importDirectory('alice', input)).added, 1);
});

test('checked-in fictional export is usable and idempotent', async (t) => {
  const { archive } = await context(t);
  const fixture = new URL('./fixtures/synthetic/facebook/', import.meta.url).pathname;
  const first = await archive.importDirectory('alice', fixture);
  assert.equal(first.added, 7);
  assert.equal(first.media, 1);
  const repeat = await archive.importDirectory('alice', fixture);
  assert.equal(repeat.unchanged, 7);
  assert.equal(repeat.added, 0);
});

test('archive component records its schema and rejects unknown future schemas', async (t) => {
  const { archive, store } = await context(t);
  assert.equal(
    store.db.prepare("SELECT version FROM schema_versions WHERE component='archive'").get()!
      .version,
    1,
  );
  store.db.prepare("UPDATE schema_versions SET version=99 WHERE component='archive'").run();
  assert.throws(() => new Archive(store), /newer/);
  assert.equal(archive.count('alice'), 0);
});

test('native originals are browsable private photos and albums link their actual media', async (t) => {
  const { archive, input } = await context(t);
  const native = await photo(input);
  const shared = await archive.uploadPhoto('alice', native);
  const personal = archive.photoItems('alice');
  assert.equal(personal.length, 1);
  assert.equal(personal[0]!.kind, 'photo');
  assert.equal(personal[0]!.mediaIds[0], shared.originalId);
  assert.equal(archive.photoItems('bob').length, 0);
  await json(input, 'photos/album.json', {
    name: 'Synthetic album',
    photos: [{ id: 'album-photo', uri: 'photos/synthetic.jpg', title: 'A blue postcard' }],
  });
  await archive.importDirectory('alice', input);
  const album = archive.albums('alice')[0]!;
  assert.equal(album.title, 'Synthetic album');
  assert.equal(album.mediaIds.length, 1);
  assert.equal(album.itemIds.length, 1);
  assert.equal(archive.albums('bob').length, 0);
});

test('atomic import quota tracks exact revision deltas and admits the exact byte boundary', async (t) => {
  const { archive, input } = await context(t);
  await json(input, 'posts.json', [{ id: 'revision-quota', data: [{ post: 'aaaa' }] }]);
  await archive.importDirectory('alice', input);
  const before = archive.list('alice')[0]!;
  const boundary = archive.usage('alice') + Buffer.byteLength(JSON.stringify(before));
  archive.limits.ownerBytes = boundary;
  await json(input, 'posts.json', [{ id: 'revision-quota', data: [{ post: 'bbbb' }] }]);
  assert.equal((await archive.importDirectory('alice', input)).revised, 1);
  assert.equal(archive.usage('alice'), boundary);
  assert.equal(archive.get('alice', before.id)?.version, 2);
  await json(input, 'posts.json', [{ id: 'revision-quota', data: [{ post: 'bbbbb' }] }]);
  await assert.rejects(archive.importDirectory('alice', input), /allowance/);
  assert.equal(archive.usage('alice'), boundary);
  assert.equal(archive.get('alice', before.id)?.body, 'bbbb');
  assert.equal(archive.get('alice', before.id)?.version, 2);
});

test('transaction-local count admits unchanged records at quota but rolls back a new record over it', async (t) => {
  const { archive, input } = await context(t, { maxRecords: 2 });
  await json(input, 'posts.json', [
    { id: 'one', data: [{ post: 'One' }] },
    { id: 'two', data: [{ post: 'Two' }] },
  ]);
  await archive.importDirectory('alice', input);
  assert.equal((await archive.importDirectory('alice', input)).unchanged, 2);
  await json(input, 'posts.json', [{ id: 'three', data: [{ post: 'Three' }] }]);
  await assert.rejects(archive.importDirectory('alice', input), /record limit/);
  assert.equal(archive.count('alice'), 2);
});

test('successful and failed imports remove only their complete managed HTTP upload stage', async (t) => {
  const { archive, store, input } = await context(t);
  const incoming = join(store.dataDir, 'incoming');
  const good = join(incoming, 'upload-goodfixture');
  const bad = join(incoming, 'upload-badfixture');
  await mkdir(good, { recursive: true });
  await mkdir(bad, { recursive: true });
  const zipPath = join(good, 'export.zip');
  await writeFile(
    zipPath,
    await zipBytes([
      { name: 'posts.json', bytes: Buffer.from('[{"id":"good","data":[{"post":"Kept memory"}]}]') },
    ]),
  );
  await archive.importZip('alice', zipPath);
  await assert.rejects(readFile(zipPath));
  await assert.rejects((await import('node:fs/promises')).stat(good));
  await writeFile(join(bad, 'posts.json'), '{');
  await assert.rejects(archive.importDirectory('alice', bad));
  await assert.rejects((await import('node:fs/promises')).stat(bad));
  await json(input, 'posts.json', [{ id: 'external', data: [{ post: 'Operator folder' }] }]);
  await archive.importDirectory('alice', input);
  assert.ok(
    (await readFile(join(input, 'posts.json'))).length,
    'Operator-selected folders outside managed staging must remain',
  );
});

test('bounded collection removes abandoned stages and unused old derivatives while preserving active uploads and originals', async (t) => {
  const { archive, store, input } = await context(t);
  const { utimes, stat } = await import('node:fs/promises');
  const now = Date.now();
  const past = new Date(now - 48 * 60 * 60 * 1000);
  const incoming = join(store.dataDir, 'incoming');
  const stale = join(incoming, 'upload-abandoned');
  const active = join(incoming, 'upload-queued');
  const fresh = join(incoming, 'upload-fresh');
  for (const path of [stale, active, fresh]) {
    await mkdir(path, { recursive: true });
    await json(path, 'posts.json', []);
  }
  await utimes(stale, past, past);
  await utimes(active, past, past);
  archive.enqueueImport('alice', active);
  const source = await photo(input);
  const unused = await archive.uploadPhoto('alice', source);
  const original = archive.media('alice', unused.originalId!)!;
  store.db
    .prepare('UPDATE archive_media SET created_at=? WHERE id=?')
    .run(past.getTime(), unused.id);
  // A second derivative is attached to a currently visible publication.
  const source2 = join(input, 'different.png');
  await sharp({ create: { width: 8, height: 8, channels: 3, background: '#123456' } })
    .png()
    .toFile(source2);
  const published = await archive.uploadPhoto('alice', source2);
  store.db
    .prepare('UPDATE archive_media SET created_at=? WHERE id=?')
    .run(past.getTime(), published.id);
  store.db.exec('CREATE TABLE publications(id TEXT PRIMARY KEY,media_ids TEXT,deleted_at INTEGER)');
  store.db
    .prepare('INSERT INTO publications VALUES(?,?,NULL)')
    .run('synthetic-publication', JSON.stringify([published.id]));
  const result = await archive.maintenance({ now, limit: 1 });
  assert.deepEqual(result, { stages: 1, derivatives: 1 });
  await assert.rejects(stat(stale));
  assert.ok(await stat(active));
  assert.ok(await stat(fresh));
  assert.equal(archive.media('alice', unused.id), null);
  assert.ok(await stat(original.path));
  assert.equal(archive.photoItems('alice').length, 2);
  assert.ok(archive.media('alice', published.id));
  assert.ok(await stat(published.path));
});

test('worker startup database contention is caught and retried without losing queued work', async (t) => {
  const { archive, store, input } = await context(t);
  await json(input, 'posts.json', [{ id: 'after-lock', data: [{ post: 'Recovered after lock' }] }]);
  const id = archive.enqueueImport('alice', input);
  const { DatabaseSync } = await import('node:sqlite');
  const locker = new DatabaseSync(store.path);
  locker.exec('BEGIN IMMEDIATE');
  store.db.exec('PRAGMA busy_timeout=1');
  const unexpected: unknown[] = [];
  const onRejection = (error: unknown) => unexpected.push(error);
  process.on('unhandledRejection', onRejection);
  try {
    archive.startWorker();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(archive.job('alice', id)?.status, 'queued');
    locker.exec('ROLLBACK');
    locker.close();
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && archive.job('alice', id)?.status !== 'completed')
      await new Promise((r) => setTimeout(r, 25));
    assert.equal(archive.job('alice', id)?.status, 'completed');
    assert.deepEqual(unexpected, []);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

test('stopping a running worker waits for cleanup and permits immediate safe store closure and restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'bookface-worker-stop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, 'data');
  const input = join(root, 'input');
  await mkdir(input);
  await json(
    input,
    'posts.json',
    Array.from({ length: 2000 }, (_, i) => ({
      id: `restart-${i}`,
      data: [{ post: 'A retained synthetic input' }],
    })),
  );
  const first = new Store(data);
  const firstArchive = new Archive(first);
  const id = firstArchive.enqueueImport('alice', input);
  firstArchive.startWorker();
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && firstArchive.job('alice', id)?.status === 'queued')
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(firstArchive.job('alice', id)?.status, 'running');
  await firstArchive.stopWorker();
  assert.equal(firstArchive.job('alice', id)?.status, 'queued');
  first.close();
  const next = new Store(data);
  const nextArchive = new Archive(next);
  try {
    nextArchive.startWorker();
    while (Date.now() < deadline && nextArchive.job('alice', id)?.status !== 'completed')
      await new Promise((r) => setTimeout(r, 20));
    assert.equal(nextArchive.job('alice', id)?.status, 'completed');
    assert.equal(nextArchive.count('alice'), 2000);
  } finally {
    await nextArchive.stopWorker();
    next.close();
  }
});
