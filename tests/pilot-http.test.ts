import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../src/app.js';
import { readConfig } from '../src/config.js';

const origin = 'https://pilot.example.org';
const password = 'fictional pilot testing passphrase';
const readOnly = Date.parse('2027-01-01T00:00:00Z');
const end = Date.parse('2027-01-15T00:00:00Z');
async function fixture(t: test.TestContext, extra: NodeJS.ProcessEnv = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'bookface-pilot-http-'));
  let time = readOnly - 1;
  const config = readConfig({
    NODE_ENV: 'production',
    APP_ORIGIN: origin,
    DATA_DIR: dataDir,
    MAX_ACCOUNTS: '2',
    ARCHIVE_ACCOUNT_BYTES: '1048576',
    CLOUDFLARE_PROXY: 'true',
    FEDERATION_ENABLED: 'true',
    PILOT_READ_ONLY_AT: '2027-01-01T00:00:00Z',
    PILOT_ENDS_AT: '2027-01-15T00:00:00Z',
    ...extra,
  });
  const runtime = createApplication(config, { now: () => time });
  t.after(async () => {
    await runtime.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const request = (path: string, init: RequestInit = {}) =>
    runtime.app.request(new Request(origin + path, init));
  const post = (path: string, data: unknown = {}, headers: Record<string, string> = {}) =>
    request(path, {
      method: 'POST',
      headers: {
        origin,
        accept: 'application/json',
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(data),
    });
  const alice = (
    await runtime.core.setup({ username: 'alice', displayName: 'Alice Example', password })
  ).user;
  const login = await post('/actions/login', { username: 'alice', password });
  assert.equal(login.status, 200);
  const loginData = await login.json();
  const headers = {
    cookie: login.headers.get('set-cookie')!.split(';')[0]!,
    'x-csrf-token': loginData.csrf,
  };
  return {
    ...runtime,
    request,
    post,
    alice,
    headers,
    setTime: (value: number) => {
      time = value;
    },
  };
}

test('pilot HTTP gates precede federation and close private reads exactly at the deadline', async (t) => {
  const c = await fixture(t);
  for (const path of ['/login', '/imports', '/', '/privacy']) {
    const response = await c.request(path, { headers: path === '/login' ? {} : c.headers });
    assert.equal(response.status, 200, path);
    const html = await response.text();
    assert.match(html, /temporary pilot/);
    assert.match(html, /Cloudflare can access traffic/);
  }
  const upload = c.chunks.begin(c.alice.id, [{ name: 'posts.json', size: 2 }]);
  c.setTime(readOnly);
  for (const path of [
    '/actions/posts',
    '/actions/register',
    '/actions/setup',
    '/api/imports',
    '/api/uploads',
    `/api/uploads/${upload.id}/commit`,
    '/actions/friends/request',
    '/users/alice/inbox',
  ])
    assert.equal((await c.post(path, {}, c.headers)).status, 403, path);
  assert.equal((await c.request('/users/alice/inbox', { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await c.request('/setup')).status, 403);
  assert.equal((await c.post(`/api/uploads/${upload.id}/cancel`, {}, c.headers)).status, 200);
  assert.equal(c.chunks.active(c.alice.id), null);
  assert.equal((await c.post('/actions/login', { username: 'alice', password })).status, 200);
  assert.equal((await c.request('/archive', { headers: c.headers })).status, 200);
  const exported = await c.post('/actions/export', {}, c.headers);
  assert.equal(exported.status, 200, await exported.clone().text());
  await exported.arrayBuffer();
  c.setTime(end - 1);
  assert.equal((await c.request('/settings', { headers: c.headers })).status, 200);
  c.setTime(end);
  for (const path of [
    '/',
    '/login',
    '/api/me',
    '/archive',
    '/settings',
    '/admin',
    '/users/alice',
    '/.well-known/webfinger',
    '/api/uploads',
  ])
    assert.equal((await c.request(path, { headers: c.headers })).status, 410, path);
  for (const path of [
    '/actions/login',
    '/actions/export',
    '/actions/delete-account',
    '/users/alice/inbox',
  ])
    assert.equal((await c.post(path, {}, c.headers)).status, 410, path);
  for (const path of ['/healthz', '/privacy', '/rules', '/favicon.svg'])
    assert.equal((await c.request(path, { headers: c.headers })).status, 200, path);
  assert.doesNotMatch(
    await (await c.request('/privacy', { headers: c.headers })).text(),
    /Alice Example/,
  );
});

test('configured quotas reach their consumers and export-only still permits account deletion', async (t) => {
  const c = await fixture(t);
  assert.equal(c.archive.limits.ownerBytes, 1048576);
  const inviteToken = c.core.createInvite(c.alice.id, 'registration').token;
  await c.core.register({ username: 'bob', displayName: 'Bob Example', password, inviteToken });
  const thirdInvite = c.core.createInvite(c.alice.id, 'registration').token;
  const denied = await c.post('/actions/register', {
    username: 'carol',
    displayName: 'Carol Example',
    password,
    inviteToken: thirdInvite,
    acceptRules: true,
  });
  assert.equal(denied.status, 409, await denied.clone().text());
  assert.equal(c.core.adminMemberCount(c.alice.id), 2);
  c.setTime(readOnly);
  const bobLogin = await c.post('/actions/login', { username: 'bob', password });
  const bobSession = await bobLogin.json();
  const deleted = await c.post(
    '/actions/delete-account',
    { confirmation: 'bob' },
    {
      cookie: bobLogin.headers.get('set-cookie')!.split(';')[0]!,
      'x-csrf-token': bobSession.csrf,
    },
  );
  assert.equal(deleted.status, 200, await deleted.clone().text());
  assert.equal(c.core.userByName('bob'), null);
});

test('admin HTTP paginates all members and denies nonadministrators', async (t) => {
  const c = await fixture(t, { MAX_ACCOUNTS: '1000' });
  const insert = c.store.db.prepare(
    'INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,?,?)',
  );
  for (let i = 0; i < 550; i++) {
    const name = `fixture_${String(i).padStart(4, '0')}`;
    insert.run(name, name, name, 'fictional-not-a-password-hash', 1800000000000);
  }
  const first = await (await c.request('/admin', { headers: c.headers })).text();
  assert.match(first, /Member page 1 of 6/);
  assert.match(first, /Next members/);
  assert.doesNotMatch(first, /fixture_0549/);
  const last = await (await c.request('/admin?page=6', { headers: c.headers })).text();
  assert.match(last, /fixture_0549/);
  assert.match(last, /Previous members/);
  assert.doesNotMatch(last, /Next members/);
  assert.equal((await c.request('/admin?page=-1', { headers: c.headers })).status, 400);
  const bob = await c.core.register({
    username: 'bob',
    displayName: 'Bob',
    password,
    inviteToken: c.core.createInvite(c.alice.id, 'registration').token,
  });
  const login = await c.post('/actions/login', { username: bob.user.username, password });
  assert.equal(
    (
      await c.request('/admin?page=6', {
        headers: { cookie: login.headers.get('set-cookie')!.split(';')[0]! },
      })
    ).status,
    403,
  );
});
