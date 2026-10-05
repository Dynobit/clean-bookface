import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, utimes, stat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import yazl from 'yazl';
import { Archive } from '../src/archive.js';
import { Store } from '../src/storage.js';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'archive-review-'));
  const store = new Store(root);
  const archive = new Archive(store);
  t.after(async () => {
    await archive.stopExports();
    await archive.stopWorker();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, store, archive };
}
function seed(store: Store, count: number) {
  const insert = store.db.prepare(
    "INSERT INTO archive_items VALUES (?,'owner','post',?,'',NULL,1,1,'test',?,'hash','[]','{}')",
  );
  store.transaction(() => {
    for (let i = 0; i < count; i++)
      insert.run(String(i).padStart(5, '0'), `body-${i}`, `source-${i}`);
  });
}
async function workerCommit(path: string) {
  const worker = new Worker(
    `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(require('node:worker_threads').workerData); db.exec("UPDATE archive_items SET body='changed' WHERE id='00599'"); db.close();`,
    { eval: true, workerData: path },
  );
  await new Promise<void>((resolve, reject) => {
    worker.once('error', reject);
    worker.once('exit', (code) => (code ? reject(new Error(`worker exit ${code}`)) : resolve()));
  });
}

test('paused export uses a coherent snapshot while a second SQLite worker and main writer commit', async (t) => {
  const { store, archive } = await fixture(t);
  seed(store, 600);
  const captured: Readable[] = [];
  // Capture the actual production generators before yazl starts consuming them.
  t.mock.method(yazl.ZipFile.prototype, 'addReadStream', (stream: Readable) => {
    captured.push(stream);
  });
  const output = archive.exportZip('owner');
  const iterator = captured[0]![Symbol.asyncIterator]();
  assert.match(String((await iterator.next()).value), /body-0/);
  await workerCommit(store.path);
  assert.doesNotThrow(() => store.setSetting('main-write', 'committed'));
  let text = '';
  for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) text += String(chunk);
  assert.equal(text.trim().split('\n').length, 599);
  assert.match(text, /body-599/);
  assert.doesNotMatch(text, /changed/);
  captured[1]!.destroy();
  output.destroy();
});

test('orphan sweep preserves reservations and row-owned pending files, reclaims abandoned files', async (t) => {
  const { store, archive } = await fixture(t);
  const files = Array.from({ length: 4 }, () => `${randomUUID()}.original`);
  for (const file of files) {
    const path = join(archive.mediaDir, file);
    await writeFile(path, 'private');
    await utimes(path, 1, 1);
  }
  (archive as any).reserveFile(files[0]!, null);
  store.db
    .prepare(
      "INSERT INTO archive_media VALUES (?,'owner','image/png',7,'hash',?,NULL,NULL,'original',NULL,'pending-job',1)",
    )
    .run(randomUUID(), files[1]!);
  // A terminated import worker leaves a durable reservation; its exit handler releases it.
  store.db
    .prepare('INSERT INTO archive_file_writes (filename,pid,job_id) VALUES (?,?,?)')
    .run(files[2]!, process.pid, 'exited-worker');
  (archive as any).pendingExits.set('exited-worker', true);
  await (archive as any).finishExitedWorkers();
  await archive.maintenance({ ttlMs: 60_000 });
  await stat(join(archive.mediaDir, files[0]!));
  await stat(join(archive.mediaDir, files[1]!));
  await assert.rejects(stat(join(archive.mediaDir, files[2]!)), { code: 'ENOENT' });
  await assert.rejects(stat(join(archive.mediaDir, files[3]!)), { code: 'ENOENT' });
});

test('rows-before-unlink failure leaves an orphan that maintenance can reclaim', async (t) => {
  const { store, archive } = await fixture(t);
  const id = randomUUID();
  const file = `${id}.webp`;
  const path = join(archive.mediaDir, file);
  await mkdir(path); // force unlink failure without platform-dependent permissions
  store.db
    .prepare(
      "INSERT INTO archive_media VALUES (?,'owner','image/webp',7,'hash',?,NULL,NULL,'shared',NULL,NULL,1)",
    )
    .run(id, file);
  assert.throws(() => archive.deleteSharedMedia('owner', id));
  assert.equal(store.db.prepare('SELECT 1 FROM archive_media WHERE id=?').get(id), undefined);
  await rm(path, { recursive: true });
  await writeFile(path, 'private');
  await utimes(path, 1, 1);
  await archive.maintenance({ ttlMs: 60_000 });
  await assert.rejects(stat(path), { code: 'ENOENT' });
});

test('owner deletion restarts a previously running queue after cleanup fails', async (t) => {
  const { archive, store } = await fixture(t);
  store.db
    .prepare(
      "INSERT INTO archive_jobs (id,owner_id,input_path,format,status,created_at,updated_at) VALUES ('job','owner','/unused','directory','running',1,1)",
    )
    .run();
  (archive as any).timer = setInterval(() => {}, 100_000);
  (archive as any).workerJobId = 'job';
  (archive as any).activeWorker = {};
  t.mock.method(archive, 'stopWorker', async () => {
    clearInterval((archive as any).timer);
    (archive as any).timer = undefined;
    (archive as any).activeWorker = undefined;
    throw new Error('cleanup failed');
  });
  let restarted = false;
  t.mock.method(archive, 'startWorker', () => {
    restarted = true;
  });
  await assert.rejects(archive.deleteOwner('owner'), /cleanup failed/);
  assert.equal(restarted, true);
  t.mock.restoreAll();
});

test('missing export media fails with faithful recovery guidance', async (t) => {
  const { store, archive } = await fixture(t);
  const id = randomUUID();
  store.db
    .prepare(
      "INSERT INTO archive_media VALUES (?,'owner','image/png',7,'hash',?,NULL,NULL,'original',NULL,NULL,1)",
    )
    .run(id, `${id}.original`);
  const output = archive.exportZip('owner');
  await assert.rejects(async () => {
    for await (const chunk of output) void chunk;
  }, /missing or damaged.*matching private media backup/);
});

test('worker terminated after copying but before media-row commit leaves reclaimable private output', async (t) => {
  const { root, store, archive } = await fixture(t);
  const filename = `${randomUUID()}.original`;
  (archive as any).reserveFile('birth-probe', null);
  const birth = store.db
    .prepare("SELECT process_birth FROM archive_file_writes WHERE filename='birth-probe'")
    .get()!.process_birth;
  (archive as any).releaseFile('birth-probe');
  const source = join(root, 'source');
  await writeFile(source, 'private original');
  const worker = new Worker(
    `
    const { DatabaseSync } = require('node:sqlite');
    const { workerData: d, parentPort } = require('node:worker_threads');
    const fs = require('node:fs');
    const db = new DatabaseSync(d.database);
    db.prepare('INSERT INTO archive_file_writes (filename,pid,job_id,process_birth) VALUES (?,?,?,?)').run(d.filename, process.pid, 'copy-job', d.birth);
    fs.copyFileSync(d.source, d.target);
    parentPort.postMessage('copied');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  `,
    {
      eval: true,
      workerData: {
        database: store.path,
        birth,
        filename,
        source,
        target: join(archive.mediaDir, filename),
      },
    },
  );
  await new Promise<void>((resolve, reject) => {
    worker.once('message', () => resolve());
    worker.once('error', reject);
  });
  await utimes(join(archive.mediaDir, filename), 1, 1);
  await archive.maintenance({ ttlMs: 60_000 });
  await stat(join(archive.mediaDir, filename));
  await worker.terminate();
  (archive as any).pendingExits.set('copy-job', true);
  await (archive as any).finishExitedWorkers();
  await archive.maintenance({ ttlMs: 60_000 });
  await assert.rejects(stat(join(archive.mediaDir, filename)), { code: 'ENOENT' });
});

test('reopening reclaims PID-reuse reservations but preserves current-incarnation pending writes', async (t) => {
  const { store, archive } = await fixture(t);
  const names = Array.from({ length: 3 }, () => `${randomUUID()}.original`);
  for (const name of names) {
    await writeFile(join(archive.mediaDir, name), 'private');
    await utimes(join(archive.mediaDir, name), 1, 1);
  }
  // Same numeric live PID, but a previous process incarnation (including container PID 1).
  store.db
    .prepare(
      'INSERT INTO archive_file_writes (filename,pid,job_id,process_birth) VALUES (?,?,NULL,?)',
    )
    .run(names[0]!, process.pid, 'previous-boot:old-start');
  // Migration of a legacy PID-only reservation also proves staleness from output birth.
  store.db
    .prepare('INSERT INTO archive_file_writes (filename,pid,job_id) VALUES (?,?,NULL)')
    .run(names[1]!, process.pid);
  (archive as any).reserveFile(names[2]!, null);
  const reopened = new Archive(store);
  t.after(() => reopened.stopWorker());
  for (let i = 0; i < 3; i++) await reopened.maintenance({ now: Date.now() + 30 * 86400_000 });
  for (const name of names.slice(0, 2)) {
    await assert.rejects(stat(join(archive.mediaDir, name)), { code: 'ENOENT' });
    assert.equal(
      store.db.prepare('SELECT 1 FROM archive_file_writes WHERE filename=?').get(name),
      undefined,
    );
  }
  await stat(join(archive.mediaDir, names[2]!));
  assert.ok(store.db.prepare('SELECT 1 FROM archive_file_writes WHERE filename=?').get(names[2]!));
});

test('maintenance preserves a separate live process reservation past grace, then reclaims after exit', async (t) => {
  const { root, archive } = await fixture(t);
  const filename = `${randomUUID()}.original`;
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    import { Store } from './src/storage.ts';
    import { Archive } from './src/archive.ts';
    import { writeFileSync, utimesSync } from 'node:fs';
    import { join } from 'node:path';
    const archive = new Archive(new Store(process.argv[1]));
    archive.reserveFile(process.argv[2], null);
    const path = join(archive.mediaDir, process.argv[2]);
    writeFileSync(path, 'private'); utimesSync(path, 1, 1);
    console.log('reserved');
    process.stdin.resume();
  `,
      root,
      filename,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  t.after(() => {
    child.kill();
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout.once('data', () => resolve());
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`writer exited before reservation: ${code}`)));
  });
  await archive.maintenance({ now: Date.now() + 30 * 86400_000 });
  await stat(join(archive.mediaDir, filename));
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill();
  await exited;
  await archive.maintenance({ now: Date.now() + 30 * 86400_000 });
  await assert.rejects(stat(join(archive.mediaDir, filename)), { code: 'ENOENT' });
});

test('owner deletion retains legacy file ownership through unlink failure and a reopened retry', async (t) => {
  const { store, archive } = await fixture(t);
  const legacy = 'legacy_base64url-name.original';
  const path = join(archive.mediaDir, legacy);
  const unrelated = join(archive.mediaDir, 'unrelated_private-file.original');
  await mkdir(path); // Deterministic non-ENOENT unlink error; no broad directory removal is allowed.
  await writeFile(unrelated, 'other owner private data');
  store.db
    .prepare(
      "INSERT INTO archive_media (id,owner_id,mime,size,sha256,filename,purpose,created_at) VALUES ('legacy','owner','image/png',7,'hash',?,'original',1)",
    )
    .run(legacy);
  store.db
    .prepare(
      "INSERT INTO archive_media (id,owner_id,mime,size,sha256,filename,purpose,created_at) VALUES ('other','other-owner','image/png',24,'hash',?,'original',1)",
    )
    .run('unrelated_private-file.original');
  await assert.rejects(archive.deleteOwner('owner'));
  assert.equal(
    store.db.prepare("SELECT filename FROM archive_media WHERE owner_id='owner'").get()!.filename,
    legacy,
  );
  // Repair the storage failure, then retry from a new connection without a sweep or TTL.
  await rm(path, { recursive: true });
  await writeFile(path, 'private');
  const reopenedStore = new Store(store.dataDir);
  const reopenedArchive = new Archive(reopenedStore);
  try {
    await reopenedArchive.deleteOwner('owner');
  } finally {
    await reopenedArchive.stopWorker();
    reopenedStore.close();
  }
  await assert.rejects(stat(path), { code: 'ENOENT' });
  assert.equal(
    store.db.prepare("SELECT count(*) n FROM archive_media WHERE owner_id='owner'").get()!.n,
    0,
  );
  await stat(unrelated);
  assert.equal(
    store.db.prepare("SELECT count(*) n FROM archive_media WHERE owner_id='other-owner'").get()!.n,
    1,
  );
});
