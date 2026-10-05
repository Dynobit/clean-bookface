import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
  appendFileSync,
  statSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage.js';
import { Archive } from '../src/archive.js';
import {
  ChunkUploads,
  CHUNK_BYTES,
  CHUNK_ENTRY_BYTES,
  type ChunkOptions,
} from '../src/chunk-uploads.js';
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
function context(t: test.TestContext, options: Partial<ChunkOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bookface-chunks-'));
  let store = new Store(root);
  const config = { maxBytes: CHUNK_BYTES * 3, minFreeBytes: 0, ...options };
  let uploads = new ChunkUploads(store, config);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    get store() {
      return store;
    },
    get uploads() {
      return uploads;
    },
    restart() {
      store.close();
      store = new Store(root);
      uploads = new ChunkUploads(store, config);
    },
  };
}

test('chunk paths, file counts, size limits, owner isolation and reservation bounds', async (t) => {
  const { uploads } = context(t, {
    maxBytes: 10,
    maxReservedBytes: 15 + 4 * CHUNK_ENTRY_BYTES,
    maxFiles: 3,
    maxActiveUploads: 2,
  });
  for (const name of [
    '../x',
    '/x',
    'C:/x',
    'a//b',
    'a/./b',
    'a/../b',
    'a\0b',
    'a/'.repeat(21) + 'b',
  ])
    assert.throws(() => uploads.begin('alice', [{ name, size: 1 }]), /unsafe/);
  assert.throws(
    () =>
      uploads.begin('alice', [
        { name: 'a', size: 1 },
        { name: 'a', size: 1 },
      ]),
    /Duplicate/,
  );
  assert.throws(
    () =>
      uploads.begin('alice', [
        { name: 'a', size: 1 },
        { name: 'a/b', size: 1 },
      ]),
    /same path/,
  );
  assert.throws(() => uploads.begin('alice', [{ name: 'a', size: -1 }]), /invalid size/);
  assert.throws(() => uploads.begin('alice', [{ name: 'a', size: 11 }]), /allowance/);
  assert.throws(
    () =>
      uploads.begin(
        'alice',
        Array.from({ length: 4 }, (_, i) => ({ name: String(i), size: 0 })),
      ),
    /Choose/,
  );
  const a = uploads.begin('alice', [{ name: 'a', size: 10 }]);
  assert.throws(() => uploads.begin('alice', [{ name: 'b', size: 1 }]), /existing upload/);
  assert.throws(() => uploads.status('bob', a.id), /unavailable/);
  assert.throws(() => uploads.cancel('bob', a.id), /unavailable/);
  assert.throws(() => uploads.commit('bob', a.id, () => 'no'), /unavailable/);
  await assert.rejects(
    uploads.writeChunk('bob', a.id, 0, 0, Buffer.alloc(10), hash(Buffer.alloc(10))),
    /unavailable/,
  );
  assert.throws(() => uploads.begin('bob', [{ name: 'b', size: 6 }]), /busy/);
  uploads.begin('bob', [{ name: 'b', size: 5 }]);
  assert.throws(() => uploads.begin('charlie', [{ name: 'c', size: 0 }]), /busy/);
  uploads.cancel('alice', a.id);
  assert.equal(uploads.begin('charlie', [{ name: 'c', size: 1 }]).state, 'active');
});

test('checksum failures, truncated streams and oversized chunks roll back and can be retried', async (t) => {
  const { uploads, root } = context(t);
  const bytes = Buffer.from('private memories');
  const upload = uploads.begin('alice', [{ name: 'folder/a.json', size: bytes.length }]);
  const path = join(root, 'incoming', `upload-${upload.id}`, 'folder/a.json');
  await assert.rejects(
    uploads.writeChunk('alice', upload.id, 0, 0, bytes, '0'.repeat(64)),
    /checksum/,
  );
  assert.equal(statSync(path).size, 0);
  const broken = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes.subarray(0, 3));
    },
    pull(c) {
      c.error(new Error('connection lost'));
    },
  });
  await assert.rejects(
    uploads.writeChunk('alice', upload.id, 0, 0, broken, hash(bytes)),
    /connection lost/,
  );
  assert.equal(statSync(path).size, 0);
  await assert.rejects(
    uploads.writeChunk('alice', upload.id, 0, 0, Buffer.alloc(bytes.length + 1), hash(bytes)),
    /expected size/,
  );
  assert.equal(uploads.status('alice', upload.id).files[0]!.offset, 0);
  await assert.rejects(
    uploads.writeChunk('alice', upload.id, 0, 0, bytes.subarray(0, 3), hash(bytes)),
    /incomplete/,
  );
  await uploads.writeChunk('alice', upload.id, 0, 0, bytes, hash(bytes));
  assert.deepEqual(readFileSync(path), bytes);
  await uploads.writeChunk('alice', upload.id, 0, 0, bytes, hash(bytes));
  await assert.rejects(
    uploads.writeChunk('alice', upload.id, 0, 0, Buffer.alloc(bytes.length), hash(bytes)),
    /checksum/,
  );
  await assert.rejects(
    uploads.writeChunk(
      'alice',
      upload.id,
      0,
      0,
      Buffer.alloc(bytes.length),
      hash(Buffer.alloc(bytes.length)),
    ),
    /conflicts/,
  );
  assert.deepEqual(readFileSync(path), bytes);
});

test('restart resumes durable offsets and discards unacknowledged file tails', async (t) => {
  const ctx = context(t);
  const first = Buffer.alloc(CHUNK_BYTES, 31),
    last = Buffer.from('end');
  const u = ctx.uploads.begin('alice', [{ name: 'data.zip', size: first.length + last.length }]);
  await assert.rejects(
    ctx.uploads.writeChunk('alice', u.id, 0, CHUNK_BYTES, last, hash(last)),
    /Invalid/,
  );
  await ctx.uploads.writeChunk('alice', u.id, 0, 0, first, hash(first));
  const path = join(ctx.root, 'incoming', `upload-${u.id}`, 'data.zip');
  appendFileSync(path, 'unacknowledged crash tail');
  ctx.restart();
  assert.equal(ctx.uploads.status('alice', u.id).files[0]!.offset, CHUNK_BYTES);
  assert.deepEqual(
    ctx.uploads.status('alice', u.id).chunks?.map((part) => ({ ...part })),
    [{ fileIndex: 0, offset: 0, size: CHUNK_BYTES, sha256: hash(first) }],
  );
  await ctx.uploads.writeChunk('alice', u.id, 0, CHUNK_BYTES, last, hash(last));
  assert.deepEqual(readFileSync(path), Buffer.concat([first, last]));
  const archive = new Archive(ctx.store);
  const job = ctx.uploads.commit('alice', u.id, (path, options) =>
    archive.enqueueImport('alice', path, options),
  );
  assert.equal(
    ctx.store.db.prepare('SELECT format FROM archive_jobs WHERE id=?').get(job)!.format,
    'zip',
  );
  ctx.restart();
  const again = ctx.uploads.commit('alice', u.id, () => {
    throw new Error('must not enqueue twice');
  });
  assert.equal(again, job);
  assert.equal(new Archive(ctx.store).jobs('alice').length, 1);
});

test('commit and job insert share a transaction; folders and empty files reach managed archive input', async (t) => {
  const { uploads, store, root } = context(t);
  const archive = new Archive(store);
  const bytes = Buffer.from('{}');
  const u = uploads.begin('alice', [
    { name: 'posts/a.json', size: 2 },
    { name: 'empty.txt', size: 0 },
  ]);
  assert.throws(() => uploads.commit('alice', u.id, () => 'bad'), /finish/);
  await uploads.writeChunk('alice', u.id, 0, 0, bytes, hash(bytes));
  assert.throws(
    () =>
      uploads.commit('alice', u.id, (path, options) => {
        archive.enqueueImport('alice', path, options);
        throw new Error('failed transaction');
      }),
    /failed transaction/,
  );
  assert.equal(archive.jobs('alice').length, 0);
  assert.equal(uploads.status('alice', u.id).state, 'active');
  const job = uploads.commit('alice', u.id, (path, options) =>
    archive.enqueueImport('alice', path, options),
  );
  const row = store.db.prepare('SELECT input_path,format FROM archive_jobs WHERE id=?').get(job)!;
  assert.equal(row.format, 'directory');
  assert.equal(row.input_path, join(root, 'incoming', `upload-${u.id}`));
  assert.deepEqual(readFileSync(join(String(row.input_path), 'posts/a.json')), bytes);
  assert.equal(statSync(join(String(row.input_path), 'empty.txt')).size, 0);
  assert.throws(() => uploads.cancel('alice', u.id), /already an import/);
});

test('TTL and owner deletion remove only unfinished payloads; free disk guard rejects reservations', async (t) => {
  let now = 1000;
  const { uploads, root, store } = context(t, { now: () => now, ttlMs: 100 });
  const a = uploads.begin('alice', [{ name: 'a', size: 5 }]);
  const b = uploads.begin('bob', [{ name: 'b', size: 0 }]);
  const archive = new Archive(store);
  uploads.commit('bob', b.id, (path, options) => archive.enqueueImport('bob', path, options));
  uploads.deleteOwner('alice');
  assert.equal(existsSync(join(root, 'incoming', `upload-${a.id}`)), false);
  now += 101;
  assert.throws(() => uploads.status('bob', b.id), /expired/);
  assert.equal(uploads.cleanup(), 1);
  assert.equal(existsSync(join(root, 'incoming', `upload-${b.id}`)), true);
  const c = uploads.begin('charlie', [{ name: 'c', size: 1 }]);
  now += 101;
  assert.equal(uploads.cleanup(), 1);
  assert.equal(existsSync(join(root, 'incoming', `upload-${c.id}`)), false);
  const noSpace = new ChunkUploads(store, { maxBytes: 10, minFreeBytes: Number.MAX_SAFE_INTEGER });
  assert.throws(() => noSpace.begin('alice', [{ name: 'a', size: 1 }]), /free storage/);
});

test('in-flight lock spans instances and rejects competing writes while owner deletion expires the upload', async (t) => {
  const { uploads, store } = context(t);
  const second = new ChunkUploads(store, { maxBytes: CHUNK_BYTES * 3, minFreeBytes: 0 });
  const bytes = Buffer.from('abc');
  const u = uploads.begin('alice', [{ name: 'a', size: 3 }]);
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const pending = uploads.writeChunk('alice', u.id, 0, 0, stream, hash(bytes));
  await assert.rejects(second.writeChunk('alice', u.id, 0, 0, bytes, hash(bytes)), /in progress/);
  assert.throws(() => second.cancel('alice', u.id), /in progress/);
  assert.throws(() => second.commit('alice', u.id, () => 'bad'), /in progress/);
  const rejected = assert.rejects(pending, /deleted|expired/);
  await second.deleteOwner('alice');
  await rejected;
  second.deleteOwner('alice');
  assert.throws(() => uploads.status('alice', u.id), /unavailable/);
});

test('stalled chunk deadline releases its reservation lock and rolls back bytes', async (t) => {
  const { uploads, root } = context(t, { chunkTimeoutMs: 20 });
  const bytes = Buffer.from('abc');
  const u = uploads.begin('alice', [{ name: 'a', size: 3 }]);
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes.subarray(0, 1));
    },
  });
  await assert.rejects(uploads.writeChunk('alice', u.id, 0, 0, stream, hash(bytes)), /timed out/);
  assert.equal(statSync(join(root, 'incoming', `upload-${u.id}`, 'a')).size, 0);
  await uploads.writeChunk('alice', u.id, 0, 0, bytes, hash(bytes));
  uploads.cancel('alice', u.id);
});

test('manifest resource bounds include directory entries and zero-byte metadata before filesystem work', (t) => {
  const c = context(t);
  const incoming = join(c.root, 'incoming');
  const crowded = Array.from({ length: 1100 }, (_, i) => ({
    name: `tree${i}/` + 'd/'.repeat(18) + 'memory',
    size: 1,
  }));
  assert.throws(() => c.uploads.begin('alice', crowded), /too many files and folders/);
  assert.deepEqual(readdirSync(incoming), []);
  assert.throws(
    () =>
      c.uploads.begin(
        'alice',
        Array.from({ length: 65 }, (_, i) => ({ name: `empty${i}`, size: 0 })),
      ),
    /64 empty files/,
  );
  for (const names of [
    ['a', 'a/b'],
    ['a/b', 'a'],
  ])
    assert.throws(
      () =>
        c.uploads.begin(
          'alice',
          names.map((name) => ({ name, size: 1 })),
        ),
      /same path/,
    );
  assert.deepEqual(readdirSync(incoming), []);
  assert.equal(c.store.db.prepare('SELECT COUNT(*) n FROM chunk_uploads').get()!.n, 0);
  const tiny = new ChunkUploads(c.store, { maxBytes: 1, maxReservedBytes: 1, minFreeBytes: 0 });
  assert.throws(() => tiny.begin('alice', [{ name: 'empty', size: 0 }]), /busy/);
  assert.deepEqual(readdirSync(incoming), []);
});

test('large manifests stage lazily and chunk acknowledgments and offset writes stay constant sized', async (t) => {
  const c = context(t);
  const manifest = Array.from({ length: 1500 }, (_, i) => ({
    name: `folder${i}/memory.json`,
    size: 1,
  }));
  const upload = c.uploads.begin('alice', manifest);
  const root = join(c.root, 'incoming', `upload-${upload.id}`);
  assert.deepEqual(readdirSync(root), []);
  assert.equal(
    c.store.db.prepare('SELECT reserved_bytes FROM chunk_uploads WHERE id=?').get(upload.id)!
      .reserved_bytes,
    1500 + 3001 * CHUNK_ENTRY_BYTES,
  );
  // Any whole-manifest rewrite would fail even if its response were small.
  c.store.db.exec(
    "CREATE TRIGGER forbid_manifest_rewrite BEFORE UPDATE OF files ON chunk_uploads BEGIN SELECT RAISE(ABORT,'manifest rewrite'); END",
  );
  const bytes = Buffer.from('x');
  const ack = await c.uploads.writeChunk('alice', upload.id, 1499, 0, bytes, hash(bytes));
  assert.deepEqual(ack, { id: upload.id, fileIndex: 1499, offset: 1, state: 'active' });
  assert.ok(JSON.stringify(ack).length < 150);
  assert.deepEqual(readdirSync(root), ['folder1499']);
  c.restart();
  assert.equal(c.uploads.status('alice', upload.id).files[1499]!.offset, 1);
  assert.equal(c.uploads.status('alice', upload.id).files[0]!.offset, 0);
});

test('legacy JSON offsets migrate once without losing resumability', async (t) => {
  const c = context(t);
  const bytes = Buffer.from('x');
  const upload = c.uploads.begin('alice', [{ name: 'a', size: 1 }]);
  await c.uploads.writeChunk('alice', upload.id, 0, 0, bytes, hash(bytes));
  const files = c.uploads.status('alice', upload.id).files;
  c.store.db
    .prepare('UPDATE chunk_uploads SET files=? WHERE id=?')
    .run(JSON.stringify(files), upload.id);
  c.store.db.exec('DROP TABLE chunk_upload_files');
  c.restart();
  assert.equal(c.uploads.status('alice', upload.id).files[0]!.offset, 1);
  assert.equal(
    (await c.uploads.writeChunk('alice', upload.id, 0, 0, bytes, hash(bytes))).offset,
    1,
  );
});
