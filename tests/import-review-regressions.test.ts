import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import sharp from 'sharp';
import { Store } from '../src/storage.js';
import { Archive } from '../src/archive.js';
import { ChunkUploads, CHUNK_BYTES } from '../src/chunk-uploads.js';
import { stageUpload } from '../src/uploads.js';
import { DEFAULT_LIMITS, type ArchiveLimits } from '../src/archive/types.js';
import { scanDirectory, safeRelative } from '../src/archive/input.js';

async function fixture(t: test.TestContext, limits: Partial<ArchiveLimits> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'import-review-'));
  const store = new Store(join(root, 'data'));
  const archive = new Archive(store, { limits });
  const input = join(root, 'input');
  await mkdir(input);
  t.after(async () => {
    await archive.stopExports();
    await archive.stopWorker();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, store, archive, input };
}
function multipart(files: { name: string; data: string }[]) {
  const boundary = 'fictional-import-review-boundary';
  const body =
    files
      .map(
        ({ name, data }) =>
          `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n${data}\r\n`,
      )
      .join('') + `--${boundary}--\r\n`;
  return new Request('http://localhost/import', {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
}
const record = (id: string, body: string, uri?: string) => ({
  id,
  data: [{ post: body }],
  ...(uri === undefined ? {} : { attachments: [{ data: [{ media: { uri } }] }] }),
});
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('invalid referenced Facebook URIs leave text intact and links absent', async (t) => {
  const { archive, input } = await fixture(t);
  const uris = [
    '',
    '../private',
    '//cdn.example/photo',
    'file:photo',
    'C:\\photo',
    'x'.repeat(256),
  ];
  await writeFile(
    join(input, 'posts.json'),
    JSON.stringify(uris.map((uri, i) => record(String(i), `Memory ${i}`, uri))),
  );
  const result = await archive.importDirectory('owner', input);
  assert.equal(result.added, uris.length);
  assert.ok(result.warnings.some((w) => /paths were invalid/.test(w)));
  assert.ok(archive.list('owner').every((item) => item.mediaIds.length === 0));
});

test('chunk admission applies type-specific limits and rejects equivalent or oversized path components', async (t) => {
  const { store } = await fixture(t);
  const chunks = new ChunkUploads(store, {
    maxBytes: 1000,
    maxFileBytes: 10,
    maxJsonBytes: 5,
    maxCompressedBytes: 100,
    minFreeBytes: 0,
  });
  for (const [name, size] of [
    ['video.mp4', 11],
    ['posts.json', 6],
    ['export.zip', 101],
  ] as const)
    assert.throws(() => chunks.begin('owner', [{ name, size }]), /archive limit/);
  for (const names of [
    ['A.jpg', 'a.jpg'],
    ['é.jpg', 'e\u0301.jpg'],
    ['x:photo'],
    ['é'.repeat(128)],
  ])
    assert.throws(
      () =>
        chunks.begin(
          'owner',
          names.map((name) => ({ name, size: 1 })),
        ),
      /unsafe|equivalent|255/,
    );
  const accepted = chunks.begin('owner', [{ name: 'export.zip', size: 100 }]);
  chunks.cancel('owner', accepted.id);
  assert.throws(() => safeRelative('é'.repeat(128)), /Unsafe/);
});

test('multipart applies JSON/media limits while allowing compressed ZIP limit and cleans failures', async (t) => {
  const { store } = await fixture(t);
  const limits = { maxFileBytes: 10, maxJsonBytes: 5, maxCompressedBytes: 100 };
  for (const file of [
    { name: 'posts.json', data: '123456' },
    { name: 'video.mp4', data: 'a'.repeat(11) },
    { name: 'bad:name', data: 'a' },
  ]) {
    await assert.rejects(
      stageUpload(multipart([file]), store.dataDir, 4096, 10, { limits }),
      /limit|unsafe/,
    );
    assert.deepEqual(await readdir(join(store.dataDir, 'incoming')), []);
  }
  await assert.rejects(
    stageUpload(
      multipart([
        { name: 'A.jpg', data: 'a' },
        { name: 'a.jpg', data: 'b' },
      ]),
      store.dataDir,
      4096,
      10,
      { limits },
    ),
    /Duplicate/,
  );
  const upload = await stageUpload(
    multipart([{ name: 'archive.zip', data: 'a'.repeat(100) }]),
    store.dataDir,
    4096,
    10,
    { limits },
  );
  assert.equal(upload.files.length, 1);
});

test('directory scan permits ZIPs above media cap but rejects ZIPs above compressed cap', async (t) => {
  const { input } = await fixture(t);
  await writeFile(join(input, 'part.zip'), 'a'.repeat(20));
  const limits = { ...DEFAULT_LIMITS, maxFileBytes: 10, maxCompressedBytes: 20 };
  assert.equal((await scanDirectory(input, limits, () => {})).size, 1);
  await writeFile(join(input, 'part.zip'), 'a'.repeat(21));
  await assert.rejects(
    scanDirectory(input, limits, () => {}),
    /size limit/,
  );
});

test('missing acknowledged chunk file produces actionable 409 without advancing receipt', async (t) => {
  const { store } = await fixture(t);
  const chunks = new ChunkUploads(store, { maxBytes: CHUNK_BYTES * 2, minFreeBytes: 0 });
  const upload = chunks.begin('owner', [{ name: 'photo.bin', size: CHUNK_BYTES + 1 }]);
  const first = Buffer.alloc(CHUNK_BYTES, 1);
  await chunks.writeChunk('owner', upload.id, 0, 0, first, hash(first));
  await rm(join(store.dataDir, 'incoming', `upload-${upload.id}`, 'photo.bin'));
  await assert.rejects(
    chunks.writeChunk('owner', upload.id, 0, CHUNK_BYTES, Buffer.from('x'), hash(Buffer.from('x'))),
    (error: any) => error.status === 409 && /Start again/.test(error.message),
  );
  assert.equal(chunks.status('owner', upload.id).files[0]!.offset, CHUNK_BYTES);
});

test('suspension in a separate archive instance during image work cannot commit text', async (t) => {
  const { store, input } = await fixture(t);
  store.db.exec(
    "CREATE TABLE users(id TEXT PRIMARY KEY,deleted INTEGER,suspended INTEGER); INSERT INTO users VALUES('owner',0,0)",
  );
  const workerArchive = new Archive(store);
  await sharp({ create: { width: 8, height: 8, channels: 3, background: '#445566' } })
    .png()
    .toFile(join(input, 'photo.png'));
  await writeFile(
    join(input, 'posts.json'),
    JSON.stringify([record('1', 'Private memory', 'photo.png')]),
  );
  const original = sharp.prototype.toBuffer;
  t.mock.method(
    sharp.prototype,
    'toBuffer',
    async function (this: sharp.Sharp, ...args: unknown[]) {
      const output = await Reflect.apply(original, this, args);
      const worker = new Worker(
        `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(require('node:worker_threads').workerData); db.exec("UPDATE users SET suspended=1 WHERE id='owner'"); db.close();`,
        { eval: true, workerData: store.path },
      );
      await new Promise<void>((resolve, reject) => {
        worker.once('error', reject);
        worker.once('exit', (code) =>
          code ? reject(new Error(`worker exited ${code}`)) : resolve(),
        );
      });
      return output;
    },
  );
  await assert.rejects(workerArchive.importDirectory('owner', input), /no longer available/);
  assert.equal(workerArchive.count('owner'), 0);
  assert.equal(workerArchive.mediaUsage('owner'), 0);
});

test('unchanged full-quota reimport needs no staging rows and oversized new record fails before staging', async (t) => {
  const { store, archive, input } = await fixture(t);
  await writeFile(join(input, 'posts.json'), JSON.stringify([record('1', 'Memory')]));
  await archive.importDirectory('owner', input);
  const exact = new Archive(store, { limits: { ownerBytes: archive.usage('owner') } });
  store.db.exec(
    "CREATE TRIGGER reject_stage BEFORE INSERT ON archive_stage BEGIN SELECT RAISE(FAIL,'unexpected stage write'); END",
  );
  assert.equal((await exact.importDirectory('owner', input)).unchanged, 1);
  await writeFile(join(input, 'posts.json'), JSON.stringify([record('2', 'too much'.repeat(100))]));
  await assert.rejects(exact.importDirectory('owner', input), /allowance/);
  assert.equal(store.db.prepare('SELECT count(*) n FROM archive_stage').get()!.n, 0);
});

test('malformed portable JSON records persist static diagnostics without private excerpts', async (t) => {
  const { archive, input } = await fixture(t);
  await writeFile(join(input, 'manifest.json'), '{"format":"clean-bookface-archive/1","media":[]}');
  await writeFile(join(input, 'archive.ndjson'), '{"body":"PRIVATE_SENTINEL", broken}');
  await writeFile(join(input, 'revisions.ndjson'), '');
  await assert.rejects(archive.importDirectory('owner', input), /malformed/);
  assert.match(archive.jobs('owner')[0]!.error!, /malformed/);
  assert.doesNotMatch(archive.jobs('owner')[0]!.error!, /PRIVATE_SENTINEL/);
});

test('owner deletion aborts a stalled multipart reservation and waits for writer cleanup', async (t) => {
  const { store } = await fixture(t);
  const chunks = new ChunkUploads(store, { maxBytes: 4096, minFreeBytes: 0 });
  const reservation = chunks.begin(
    'owner',
    [{ name: 'direct-upload-reservation', size: 4096 }],
    10,
  );
  const boundary = 'fictional-stalled-upload';
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="photo.bin"\r\n\r\nprivate`,
        ),
      );
      started();
    },
  });
  const request = new Request('http://localhost/import', {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body,
    duplex: 'half',
  } as RequestInit);
  const pending = chunks.withReservation('owner', reservation.id, (signal) =>
    stageUpload(request, store.dataDir, 4096, 10, { signal }),
  );
  const rejected = assert.rejects(pending, /abort|deleted/i);
  await ready;
  await chunks.deleteOwner('owner');
  await rejected;
  assert.equal(store.db.prepare('SELECT count(*) n FROM chunk_uploads').get()!.n, 0);
  assert.deepEqual(await readdir(join(store.dataDir, 'incoming')), []);
});

test('final text-only import transaction rechecks durable owner deletion before committing', async (t) => {
  const { store, input } = await fixture(t);
  store.db.exec(
    "CREATE TABLE users(id TEXT PRIMARY KEY,deleted INTEGER,suspended INTEGER); INSERT INTO users VALUES('owner',0,0)",
  );
  const workerArchive = new Archive(store);
  await writeFile(join(input, 'posts.json'), JSON.stringify([record('1', 'Private text')]));
  const transaction = store.transaction.bind(store);
  t.mock.method(store, 'transaction', function <T>(fn: () => T): T {
    if (Number(store.db.prepare('SELECT count(*) n FROM archive_stage').get()!.n) > 0)
      store.db.exec("UPDATE users SET deleted=1 WHERE id='owner'");
    return transaction(fn);
  });
  await assert.rejects(workerArchive.importDirectory('owner', input), /no longer available/);
  assert.equal(workerArchive.count('owner'), 0);
  assert.equal(store.db.prepare('SELECT count(*) n FROM archive_stage').get()!.n, 0);
});
