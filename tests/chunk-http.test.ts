import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../src/app.js';
import { readConfig } from '../src/config.js';
const origin = 'http://localhost:3000';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t: test.TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'bookface-chunk-http-'));
  const runtime = createApplication(
    readConfig({
      APP_ORIGIN: origin,
      DATA_DIR: dataDir,
      MAX_UPLOAD_BYTES: String(128 * 1024 * 1024),
      MAX_DIRECT_UPLOAD_BYTES: '1048576',
    }),
    { startWorkers: false },
  );
  t.after(async () => {
    await runtime.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const request = (path: string, init: RequestInit = {}) =>
    runtime.app.request(new Request(origin + path, init));
  const create = async (username: string, inviteToken?: string) => {
    const r = await request(inviteToken ? '/actions/register' : '/actions/setup', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        username,
        displayName: username,
        password: 'fictional upload test passphrase',
        acceptRules: true,
        inviteToken,
        ...(!inviteToken ? { setupToken: (await readFile(runtime.setupPath, 'utf8')).trim() } : {}),
      }),
    });
    assert.equal(r.status, 200, await r.clone().text());
    const data = await r.json();
    return {
      id: data.user.id,
      headers: {
        origin,
        cookie: r.headers.get('set-cookie')!.split(';')[0]!,
        'x-csrf-token': data.csrf,
        accept: 'application/json',
      },
    };
  };
  const alice = await create('alice');
  const bob = await create('bob', runtime.core.createInvite(alice.id, 'registration').token);
  const post = (path: string, data: unknown = {}, headers = alice.headers) =>
    request(path, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });
  return { ...runtime, request, post, alice, bob };
}
test('chunk HTTP requires origin, CSRF and owner; commit retry creates one job and pending imports block new uploads', async (t) => {
  const c = await fixture(t);
  const manifest = JSON.stringify([{ name: 'posts.json', size: 2 }]);
  assert.equal(
    (
      await c.request('/api/uploads', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ manifest }),
      })
    ).status,
    401,
  );
  assert.equal(
    (await c.post('/api/uploads', { manifest }, { ...c.alice.headers, 'x-csrf-token': 'wrong' }))
      .status,
    403,
  );
  assert.equal(
    (
      await c.post(
        '/api/uploads',
        { manifest },
        { ...c.alice.headers, origin: 'https://other.example' },
      )
    ).status,
    403,
  );
  const emptyActive = await (await c.request('/api/uploads', { headers: c.bob.headers })).json();
  assert.equal(emptyActive.upload, null);
  const begin = await c.post('/api/uploads', { manifest });
  assert.equal(begin.status, 201);
  const u = await begin.json();
  const recover = await (await c.request('/api/uploads', { headers: c.alice.headers })).json();
  assert.equal(recover.upload.id, u.id);
  assert.equal((await c.request(`/api/uploads/${u.id}`, { headers: c.bob.headers })).status, 404);
  const bytes = Buffer.from('{}');
  const put = (headers = c.alice.headers) =>
    c.request(`/api/uploads/${u.id}/files/0?offset=0`, {
      method: 'PUT',
      headers: { ...headers, 'x-chunk-sha256': hash(bytes) },
      body: bytes,
    });
  assert.equal((await put(c.bob.headers)).status, 404);
  assert.equal((await put({ ...c.alice.headers, 'x-csrf-token': 'wrong' })).status, 403);
  assert.equal((await c.post(`/api/uploads/${u.id}/commit`)).status, 409);
  assert.equal((await put()).status, 200);
  const status = await (
    await c.request(`/api/uploads/${u.id}`, { headers: c.alice.headers })
  ).json();
  assert.equal(status.files[0].offset, 2);
  assert.equal(status.chunks[0].sha256, hash(bytes));
  assert.equal((await c.post(`/api/uploads/${u.id}/commit`, {}, c.bob.headers)).status, 404);
  const job = await (await c.post(`/api/uploads/${u.id}/commit`)).json();
  const again = await (await c.post(`/api/uploads/${u.id}/commit`)).json();
  assert.equal(again.jobId, job.jobId);
  assert.equal(c.archive.jobs(c.alice.id).length, 1);
  assert.equal((await c.post('/api/uploads', { manifest })).status, 409);
});
test('direct request cap and chunk reservations share capacity; cancellation and account deletion remove unfinished chunks', async (t) => {
  const c = await fixture(t);
  const u = await (
    await c.post('/api/uploads', { manifest: JSON.stringify([{ name: 'a', size: 3 }]) })
  ).json();
  const form = new FormData();
  form.append('files', new Blob([Buffer.from('abc')]), 'a.zip');
  assert.equal(
    (await c.request('/api/imports', { method: 'POST', headers: c.alice.headers, body: form }))
      .status,
    409,
  );
  assert.equal(
    (await c.request('/actions/photo', { method: 'POST', headers: c.alice.headers, body: form }))
      .status,
    409,
  );
  assert.equal((await c.post(`/api/uploads/${u.id}/cancel`, {}, c.bob.headers)).status, 404);
  assert.equal((await c.post(`/api/uploads/${u.id}/cancel`)).status, 200);
  const oversized = new FormData();
  oversized.append('files', new Blob([Buffer.alloc(1048577)]), 'a.zip');
  assert.equal(
    (await c.request('/api/imports', { method: 'POST', headers: c.alice.headers, body: oversized }))
      .status,
    413,
  );
  const next = await (
    await c.post('/api/uploads', { manifest: JSON.stringify([{ name: 'a', size: 3 }]) })
  ).json();
  c.core.transferAdministration(c.alice.id, c.bob.id);
  assert.equal((await c.post('/actions/delete-account', { confirmation: 'alice' })).status, 200);
  assert.throws(() => c.chunks.status(c.alice.id, next.id), /unavailable/);
});
test('suspended accounts cannot start, read, write, cancel or commit an upload', async (t) => {
  const c = await fixture(t);
  const u = await (
    await c.post(
      '/api/uploads',
      { manifest: JSON.stringify([{ name: 'a', size: 1 }]) },
      c.bob.headers,
    )
  ).json();
  c.core.suspend(c.alice.id, c.bob.id, true);
  assert.equal((await c.post('/api/uploads', { manifest: '[]' }, c.bob.headers)).status, 401);
  assert.equal((await c.request(`/api/uploads/${u.id}`, { headers: c.bob.headers })).status, 401);
  assert.equal(
    (
      await c.request(`/api/uploads/${u.id}/files/0?offset=0`, {
        method: 'PUT',
        headers: { ...c.bob.headers, 'x-chunk-sha256': hash(Buffer.from('a')) },
        body: 'a',
      })
    ).status,
    401,
  );
  assert.equal((await c.post(`/api/uploads/${u.id}/cancel`, {}, c.bob.headers)).status, 401);
  assert.equal((await c.post(`/api/uploads/${u.id}/commit`, {}, c.bob.headers)).status, 401);
});
