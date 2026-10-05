import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { Store } from '../src/storage.js';
import { Archive } from '../src/archive.js';
import { createApplication } from '../src/app.js';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'bookface-export-'));
  const store = new Store(dir);
  const archive = new Archive(store);
  // Enough incompressible synthetic records to keep the lazy SQLite producer
  // backpressured while its consumer cancels or the service shuts down.
  const insert = store.db.prepare(
    "INSERT INTO archive_items(id,owner_id,kind,body,title,occurred_at,imported_at,version,source,source_key,content_hash,media_ids,metadata) VALUES(?,'alice','post',?,'',0,0,1,'synthetic',?,'test','[]','{}')",
  );
  store.transaction(() => {
    for (let i = 0; i < 300; i++)
      insert.run(`synthetic-${i}`, randomBytes(8192).toString('hex'), `synthetic-${i}`);
  });
  return { dir, store, archive };
}

test('shutdown cancels an unconsumed ZIP before SQLite closes and refuses later exports', async () => {
  const { dir, store, archive } = await fixture();
  try {
    const output = archive.exportZip('alice');
    await archive.stopExports();
    assert.equal(output.destroyed, true);
    assert.throws(() => archive.exportZip('alice'), /shutting down/);
    store.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    if (store.db.isOpen) store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('web-stream cancellation closes lazy producers and releases their SQLite iterators', async () => {
  const { dir, store, archive } = await fixture();
  try {
    const output = archive.exportZip('alice');
    const reader = (Readable.toWeb(output) as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.ok(first.value!.byteLength > 0);
    await reader.cancel();
    await archive.stopExports();
    assert.equal(output.destroyed, true);
    // A released iterator no longer holds a live statement when this table goes.
    store.db.exec('DROP TABLE archive_items');
    store.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    if (store.db.isOpen) store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a photo removed during export fails the download without an unhandled source error', async () => {
  const { dir, store, archive } = await fixture();
  try {
    const photo = join(dir, 'synthetic.png');
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#aabbcc' } })
      .png()
      .toFile(photo);
    const media = await archive.uploadPhoto('alice', photo);
    const output = archive.exportZip('alice');
    await rm(media.path);
    await assert.rejects(async () => {
      for await (const chunk of output) assert.ok(chunk.length);
    }, /Export incomplete:.*missing or damaged.*matching private media backup/);
    await archive.stopExports();
    store.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    if (store.db.isOpen) store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('an unconsumed outer HTTP account export is interrupted before application shutdown closes SQLite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bookface-http-export-'));
  const origin = 'https://circle.example';
  const runtime = createApplication({
    origin,
    dataDir: dir,
    production: true,
    federation: false,
    host: '127.0.0.1',
    port: 3000,
    maxUploadBytes: 1024 * 1024,
    instanceName: 'Fictional circle',
  });
  try {
    const user = (
      await runtime.core.setup({
        username: 'alice',
        displayName: 'Alice Example',
        password: 'fictional export test password',
      })
    ).user;
    const session = await runtime.core.login('alice', 'fictional export test password');
    const insert = runtime.store.db.prepare(
      "INSERT INTO archive_items(id,owner_id,kind,body,title,occurred_at,imported_at,version,source,source_key,content_hash,media_ids,metadata) VALUES(?,?,'post',?,'',0,0,1,'synthetic',?,'test','[]','{}')",
    );
    runtime.store.transaction(() => {
      for (let i = 0; i < 300; i++)
        insert.run(`record-${i}`, user.id, randomBytes(8192).toString('hex'), `record-${i}`);
    });
    const response = await runtime.app.request(
      new Request(origin + '/actions/export', {
        method: 'POST',
        headers: {
          origin,
          accept: 'application/json',
          'content-type': 'application/json',
          cookie: `__Host-bookface=${session.token}`,
          'x-csrf-token': session.csrf,
        },
        body: '{}',
      }),
    );
    assert.equal(response.status, 200);
    await runtime.close();
    assert.equal(runtime.store.db.isOpen, false);
    await assert.rejects(response.arrayBuffer(), /Export interrupted/);
  } finally {
    if (runtime.store.db.isOpen) await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});
