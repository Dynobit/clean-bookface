import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../src/app.js';
import { readConfig } from '../src/config.js';
import type { Session } from '../src/core.js';

const origin = 'https://revocation.example';
const password = 'synthetic session review passphrase';
type Login = Session & { token: string };

async function fixture(t: test.TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'bookface-session-revocation-'));
  const runtime = createApplication(
    readConfig({
      NODE_ENV: 'production',
      APP_ORIGIN: origin,
      DATA_DIR: dataDir,
      FEDERATION_ENABLED: 'true',
      MAX_UPLOAD_BYTES: String(1024 * 1024),
    }),
    { startWorkers: false },
  );
  t.after(async () => {
    await runtime.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const owner = await runtime.core.setup({
    username: 'owner',
    displayName: 'Synthetic owner',
    password,
  });
  const admin = await runtime.core.login(owner.user.username, password);
  const member = async (username: string) => {
    const invite = runtime.core.createInvite(admin.user.id, 'registration');
    const account = await runtime.core.register({
      username,
      displayName: 'Synthetic member',
      password,
      inviteToken: invite.token,
    });
    return runtime.core.login(account.user.username, password);
  };
  const headers = (session: Login) => ({
    origin,
    cookie: `__Host-bookface=${session.token}`,
    accept: 'application/json',
  });
  const form = (session: Login, fields: Record<string, string> = {}) =>
    new TextEncoder().encode(new URLSearchParams({ csrf: session.csrf, ...fields }).toString());
  const delayed = async (
    path: string,
    session: Login,
    extraHeaders: Record<string, string> = {},
    method = 'POST',
  ) => {
    const reading = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    // A zero high-water mark signals only when the handler actually starts reading.
    const body = new ReadableStream<Uint8Array>(
      {
        start(c) {
          controller = c;
        },
        pull() {
          reading.resolve();
          return released.promise;
        },
      },
      { highWaterMark: 0 },
    );
    const response = runtime.app.request(
      new Request(origin + path, {
        method,
        headers: {
          ...headers(session),
          'content-type': 'application/x-www-form-urlencoded',
          ...extraHeaders,
        },
        body,
        duplex: 'half',
      } as RequestInit),
    );
    await reading.promise;
    return {
      finish(bytes: Uint8Array) {
        controller.enqueue(bytes);
        controller.close();
        released.resolve();
        return response;
      },
    };
  };
  return { ...runtime, dataDir, admin, member, headers, form, delayed };
}

test('logout-all revokes a delayed admin transfer before its body is accepted', async (t) => {
  const ctx = await fixture(t),
    recipient = await ctx.member('recipient');
  const request = await ctx.delayed('/actions/admin/transfer', ctx.admin);
  ctx.core.logoutAll(ctx.admin.user.id);
  const response = await request.finish(ctx.form(ctx.admin, { recipientId: recipient.user.id }));
  assert.equal(response.status, 401, await response.text());
  assert.equal(ctx.core.user(recipient.user.id).admin, false);
  assert.equal(ctx.core.user(ctx.admin.user.id).admin, true);
  assert.equal(ctx.core.session(ctx.admin.token), null);
});

test('a still-valid session loses administrative authority when its role changes during body reading', async (t) => {
  const ctx = await fixture(t),
    successor = await ctx.member('successor'),
    target = await ctx.member('target');
  const request = await ctx.delayed('/actions/admin/transfer', ctx.admin);
  ctx.core.transferAdministration(ctx.admin.user.id, successor.user.id);
  assert.ok(ctx.core.session(ctx.admin.token), 'role changes do not need to delete the session');
  const response = await request.finish(ctx.form(ctx.admin, { recipientId: target.user.id }));
  assert.equal(response.status, 403, await response.text());
  assert.equal(ctx.core.user(successor.user.id).admin, true);
  assert.equal(ctx.core.user(target.user.id).admin, false);
});

test('suspended, deleted and expired sessions cannot complete delayed publication requests', async (t) => {
  const ctx = await fixture(t);
  for (const change of ['suspended', 'deleted', 'expired'] as const) {
    const member = await ctx.member(change);
    const request = await ctx.delayed('/actions/posts', member);
    if (change === 'suspended') ctx.core.suspend(ctx.admin.user.id, member.user.id);
    if (change === 'deleted') ctx.core.deleteAccount(member.user.id);
    if (change === 'expired')
      ctx.store.db.prepare('UPDATE sessions SET expires_at=0 WHERE user_id=?').run(member.user.id);
    const response = await request.finish(
      ctx.form(member, { body: 'Must never publish', audience: 'private' }),
    );
    assert.equal(response.status, 401, `${change}: ${await response.text()}`);
    assert.equal(
      ctx.store.db
        .prepare('SELECT count(*) AS n FROM publications WHERE author_id=?')
        .get(member.user.id)!.n,
      0,
    );
  }
});

test('a delayed export cannot create or return archive data after session revocation', async (t) => {
  const ctx = await fixture(t);
  let constructed = false;
  const original = ctx.archive.exportZip.bind(ctx.archive);
  ctx.archive.exportZip = (owner) => {
    constructed = true;
    return original(owner);
  };
  const request = await ctx.delayed('/actions/export', ctx.admin);
  ctx.core.logoutAll(ctx.admin.user.id);
  const response = await request.finish(ctx.form(ctx.admin));
  assert.equal(response.status, 401, await response.text());
  assert.equal(constructed, false);
});

test('revoking a multipart uploader prevents enqueue and removes its staged bytes', async (t) => {
  const ctx = await fixture(t),
    member = await ctx.member('uploader');
  const multipart = new FormData();
  multipart.set('csrf', member.csrf);
  multipart.set('files', new Blob(['{"posts":[]}'], { type: 'application/json' }), 'posts.json');
  const encoded = new Request(origin, { method: 'POST', body: multipart });
  const bytes = new Uint8Array(await encoded.arrayBuffer());
  const request = await ctx.delayed('/api/imports', member, {
    'content-type': encoded.headers.get('content-type')!,
  });
  ctx.core.logoutAll(member.user.id);
  const response = await request.finish(bytes);
  assert.equal(response.status, 401, await response.text());
  assert.deepEqual(ctx.archive.jobs(member.user.id), []);
  assert.equal(ctx.chunks.active(member.user.id), null);
  assert.deepEqual(await readdir(join(ctx.dataDir, 'incoming')), []);
});

test('revocation before the final chunk prevents acknowledgment and rolls back received bytes', async (t) => {
  const ctx = await fixture(t),
    member = await ctx.member('chunker');
  const bytes = Buffer.from('synthetic private chunk');
  const upload = ctx.chunks.begin(member.user.id, [{ name: 'posts.json', size: bytes.length }]);
  const request = await ctx.delayed(
    `/api/uploads/${upload.id}/files/0?offset=0`,
    member,
    {
      'content-type': 'application/octet-stream',
      'x-csrf-token': member.csrf,
      'x-chunk-sha256': createHash('sha256').update(bytes).digest('hex'),
    },
    'PUT',
  );
  ctx.core.logoutAll(member.user.id);
  const response = await request.finish(bytes);
  assert.equal(response.status, 401, await response.text());
  assert.equal(ctx.chunks.status(member.user.id, upload.id).files[0].offset, 0);
  assert.equal(
    (await stat(join(ctx.dataDir, 'incoming', `upload-${upload.id}`, 'posts.json'))).size,
    0,
  );
  assert.deepEqual(ctx.archive.jobs(member.user.id), []);
});

test('a revoked session cannot create a resumable upload after its manifest body arrives', async (t) => {
  const ctx = await fixture(t),
    member = await ctx.member('manifest');
  const request = await ctx.delayed('/api/uploads', member, { 'x-csrf-token': member.csrf });
  ctx.core.logoutAll(member.user.id);
  const response = await request.finish(
    ctx.form(member, {
      manifest: JSON.stringify([{ name: 'posts.json', size: 12 }]),
    }),
  );
  assert.equal(response.status, 401, await response.text());
  assert.equal(ctx.chunks.active(member.user.id), null);
});

test('peer discovery cannot create a friendship after the requesting session is revoked', async (t) => {
  const ctx = await fixture(t);
  const discovering = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  ctx.federation.discover = async () => {
    discovering.resolve();
    await release.promise;
    return { id: 'https://peer.example/users/friend', username: 'friend' };
  };
  const request = ctx.app.request(origin + '/actions/friends/request', {
    method: 'POST',
    headers: { ...ctx.headers(ctx.admin), 'content-type': 'application/x-www-form-urlencoded' },
    body: ctx.form(ctx.admin, { actor: 'https://peer.example/users/friend' }),
  });
  await discovering.promise;
  ctx.core.logoutAll(ctx.admin.user.id);
  release.resolve();
  const response = await request;
  assert.equal(response.status, 401, await response.text());
  assert.deepEqual(ctx.core.pendingFriends(ctx.admin.user.id), []);
});

test('session revocation during password hashing prevents its credential commit', async (t) => {
  const ctx = await fixture(t);
  const hashing = Promise.withResolvers<void>();
  const original = ctx.core.changePassword.bind(ctx.core);
  ctx.core.changePassword = (...args) => {
    const result = original(...args);
    hashing.resolve();
    return result;
  };
  const request = ctx.app.request(origin + '/actions/password', {
    method: 'POST',
    headers: { ...ctx.headers(ctx.admin), 'content-type': 'application/x-www-form-urlencoded' },
    body: ctx.form(ctx.admin, {
      currentPassword: password,
      newPassword: 'a different synthetic passphrase',
    }),
  });
  await hashing.promise;
  ctx.core.logoutAll(ctx.admin.user.id);
  const response = await request;
  assert.equal(response.status, 401, await response.text());
  assert.ok(await ctx.core.login(ctx.admin.user.username, password));
  await assert.rejects(
    ctx.core.login(ctx.admin.user.username, 'a different synthetic passphrase'),
    /incorrect/,
  );
});
