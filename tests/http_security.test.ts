import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import yauzl from 'yauzl';
import { createApplication } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { backupGuideScreen } from '../src/screens.js';

const origin = 'https://circle.example';
const password = 'a fictional HTTP testing passphrase';
type Login = {
  cookie: string;
  csrf: string;
  user: { id: string; username: string; actor: string };
};
async function fixture(t: test.TestContext, setup = true) {
  const dataDir = await mkdtemp(join(tmpdir(), 'bookface-http-'));
  const runtime = createApplication(
    {
      ...readConfig({}),
      origin,
      dataDir,
      production: true,
      federation: false,
      host: '127.0.0.1',
      port: 3000,
      maxUploadBytes: 2 * 1024 * 1024,
      instanceName: 'Fictional Circle',
    },
    { startWorkers: false },
  );
  t.after(async () => {
    try {
      await runtime.close();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
  const request = (path: string, init: RequestInit = {}) =>
    runtime.app.request(new Request(origin + path, init));
  const mutate = (
    path: string,
    data: Record<string, unknown>,
    session?: Login,
    extraHeaders: Record<string, string> = {},
  ) =>
    request(path, {
      method: 'POST',
      headers: {
        origin,
        accept: 'application/json',
        'content-type': 'application/json',
        ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}),
        ...extraHeaders,
      },
      body: JSON.stringify(data),
    });
  const account = async (username: string, inviteToken?: string): Promise<Login> => {
    const path = inviteToken ? '/actions/register' : '/actions/setup';
    const response = await mutate(path, {
      username,
      displayName: `${username} Example`,
      password,
      inviteToken,
      acceptRules: true,
      ...(!inviteToken ? { setupToken: (await readFile(runtime.setupPath, 'utf8')).trim() } : {}),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    return {
      cookie: response.headers.get('set-cookie')!.split(';')[0]!,
      csrf: result.csrf,
      user: result.user,
    };
  };
  const alice = setup ? await account('alice') : undefined;
  const member = async (username: string) =>
    account(username, runtime.core.createInvite(alice!.user.id, 'registration').token);
  return { ...runtime, request, mutate, account, alice: alice!, member };
}

test('multipart routes reject missing sessions and invalid header CSRF before reading bytes', async (t) => {
  const ctx = await fixture(t);
  for (const path of ['/actions/photo', '/api/imports']) {
    for (const authenticated of [false, true]) {
      let reads = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          pull() {
            reads++;
          },
        },
        { highWaterMark: 0 },
      );
      const response = await ctx.request(path, {
        method: 'POST',
        headers: {
          origin,
          accept: 'application/json',
          'content-type': 'multipart/form-data; boundary=fictional-boundary',
          ...(authenticated ? { cookie: ctx.alice.cookie, 'x-csrf-token': 'invalid' } : {}),
        },
        body,
        duplex: 'half',
      } as RequestInit);
      assert.equal(response.status, authenticated ? 403 : 401);
      assert.equal(reads, 0, `${path} consumed an unauthorized body`);
      await body.cancel();
    }
  }
});

test('unknown-name login flood is bounded without spending real members’ login budget', async (t) => {
  const ctx = await fixture(t);
  for (let index = 0; index < 60; index++) {
    const response = await ctx.mutate('/actions/login', {
      username: `unknown_${index}`,
      password,
    });
    assert.equal(response.status, 401);
  }
  assert.equal(
    (
      await ctx.mutate('/actions/login', {
        username: 'another_unknown',
        password,
      })
    ).status,
    429,
  );
  assert.equal((await ctx.mutate('/actions/login', { username: 'alice', password })).status, 200);
});

test('anonymous mutation flood cannot exhaust authenticated posting or export access', async (t) => {
  const ctx = await fixture(t);
  for (let index = 0; index < 1000; index++) await ctx.mutate('/actions/not-a-real-route', {});
  assert.equal((await ctx.mutate('/actions/not-a-real-route', {})).status, 429);
  const posted = await ctx.mutate(
    '/actions/posts',
    { body: 'A fictional private post', audience: 'private' },
    ctx.alice,
  );
  assert.equal(posted.status, 200, await posted.clone().text());
  const exported = await ctx.mutate('/actions/export', {}, ctx.alice);
  assert.equal(exported.status, 200);
  await exported.arrayBuffer();
});

test('setup requires private server code and production cookies carry session protections', async (t) => {
  const ctx = await fixture(t, false);
  const wrong = await ctx.mutate('/actions/setup', {
    username: 'alice',
    displayName: 'Alice',
    password,
    acceptRules: true,
    setupToken: 'guess',
  });
  assert.equal(wrong.status, 403);
  assert.equal(ctx.core.isSetup(), false);
  const setup = await ctx.mutate('/actions/setup', {
    username: 'alice',
    displayName: 'Alice',
    password,
    acceptRules: true,
    setupToken: (await readFile(ctx.setupPath, 'utf8')).trim(),
  });
  assert.equal(setup.status, 200);
  const cookie = setup.headers.get('set-cookie')!;
  assert.match(cookie, /^__Host-bookface=/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/i);
  assert.match(cookie, /Path=\//);
  await assert.rejects(readFile(ctx.setupPath, 'utf8'));
  const second = await ctx.mutate('/actions/setup', {
    username: 'second',
    displayName: 'Second',
    password,
    setupToken: 'guess',
    acceptRules: true,
  });
  assert.equal(second.status, 403);
});

test('session and mutation origin/CSRF checks guard every social mutation', async (t) => {
  const ctx = await fixture(t);
  const input = { body: 'A protected post', audience: 'private' };
  assert.equal((await ctx.mutate('/actions/posts', input)).status, 401);
  assert.equal(
    (await ctx.mutate('/actions/posts', input, ctx.alice, { 'x-csrf-token': 'wrong' })).status,
    403,
  );
  assert.equal(
    (await ctx.mutate('/actions/posts', input, ctx.alice, { origin: 'https://attacker.example' }))
      .status,
    403,
  );
  assert.equal(
    (await ctx.mutate('/actions/posts', input, ctx.alice, { 'sec-fetch-site': 'cross-site' }))
      .status,
    403,
  );
  const missingOrigin = await ctx.request('/actions/posts', {
    method: 'POST',
    headers: {
      cookie: ctx.alice.cookie,
      'content-type': 'application/json',
      'x-csrf-token': ctx.alice.csrf,
    },
    body: JSON.stringify(input),
  });
  assert.equal(missingOrigin.status, 403);
  const valid = await ctx.mutate('/actions/posts', input, ctx.alice);
  assert.equal(valid.status, 200);
  assert.equal(ctx.core.feed(ctx.alice.user.id).length, 1);
  assert.equal(
    (
      await ctx.app.request(
        new Request('https://attacker.example/api/me', { headers: { cookie: ctx.alice.cookie } }),
      )
    ).status,
    400,
  );
});

test('HTTP imports remain private across archive, media, search, jobs and publication routes', async (t) => {
  const ctx = await fixture(t);
  const bob = await ctx.member('bob');
  const data = new FormData();
  data.set('csrf', ctx.alice.csrf);
  data.append(
    'files',
    new Blob(
      [
        JSON.stringify([
          {
            id: 'synthetic-post',
            timestamp: 946684800,
            data: [{ post: 'A private café memory' }],
            attachments: [{ data: [{ media: { uri: 'photos/synthetic.png' } }] }],
          },
        ]),
      ],
      { type: 'application/json' },
    ),
    'posts.json',
  );
  const photo = await sharp({
    create: { width: 16, height: 12, channels: 3, background: '#557799' },
  })
    .png()
    .toBuffer();
  data.append(
    'files',
    new Blob([new Uint8Array(photo)], { type: 'image/png' }),
    'photos/synthetic.png',
  );
  data.append(
    'files',
    new Blob(
      [
        JSON.stringify({
          thread_path: 'synthetic-thread',
          messages: [
            {
              message_id: '1',
              timestamp_ms: 1000,
              sender_name: 'Fictional Friend',
              content: 'A private conversation',
            },
          ],
        }),
      ],
      { type: 'application/json' },
    ),
    'messages/inbox/synthetic/message_1.json',
  );
  const accepted = await ctx.request('/api/imports', {
    method: 'POST',
    headers: { origin, accept: 'application/json', cookie: ctx.alice.cookie },
    body: data,
  });
  assert.equal(accepted.status, 202, await accepted.clone().text());
  const { jobId } = await accepted.json();
  await ctx.archive.runJob(jobId);
  const items = ctx.archive.list(ctx.alice.user.id);
  assert.equal(items.length, 2);
  assert.deepEqual(ctx.core.feed(ctx.alice.user.id), []);
  assert.deepEqual(ctx.core.pendingEvents(), []);
  const memory = items.find((i) => i.kind === 'post')!;
  const message = items.find((i) => i.kind === 'message')!;
  const mediaId = memory.mediaIds[0]!;
  const ownMemory = await ctx.request(`/archive/${memory.id}`, {
    headers: { cookie: ctx.alice.cookie },
  });
  assert.match(await ownMemory.text(), /Jan 1, 2000/);
  for (const path of ['/api/archive', '/api/imports', `/archive/${memory.id}`, `/media/${mediaId}`])
    assert.equal(
      (await ctx.request(path, { headers: { accept: 'application/json' } })).status,
      401,
      path,
    );
  for (const path of [`/archive/${memory.id}`, `/media/${mediaId}`])
    assert.equal(
      (await ctx.request(path, { headers: { cookie: bob.cookie, accept: 'application/json' } }))
        .status,
      404,
      path,
    );
  const bobArchive = await ctx.request('/api/archive?q=caf%C3%A9', {
    headers: { cookie: bob.cookie },
  });
  assert.deepEqual((await bobArchive.json()).items, []);
  const bobJobs = await ctx.request('/api/imports', { headers: { cookie: bob.cookie } });
  assert.deepEqual((await bobJobs.json()).jobs, []);
  assert.equal(
    (
      await ctx.mutate(
        '/actions/posts',
        { body: 'Trying to share conversation', audience: 'private', archiveSourceId: message.id },
        ctx.alice,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await ctx.mutate(
        '/actions/posts',
        { body: 'Trying to share original', audience: 'private', mediaIds: [mediaId] },
        ctx.alice,
      )
    ).status,
    400,
  );
  const ownMedia = await ctx.request(`/media/${mediaId}`, {
    headers: { cookie: ctx.alice.cookie },
  });
  assert.equal(ownMedia.status, 200);
  assert.match(ownMedia.headers.get('cache-control')!, /no-store/);
  await ownMedia.arrayBuffer();
});

test('third account cannot read a shared post, interaction, or prepared shared photo', async (t) => {
  const ctx = await fixture(t);
  const bob = await ctx.member('bob');
  const carol = await ctx.member('carol');
  const requestId = ctx.core.requestFriend(ctx.alice.user.id, bob.user.actor);
  ctx.core.acceptFriend(bob.user.id, requestId);
  const payload = '<script>alert("stored-xss")</script><img src=x onerror=alert(1)>';
  const upload = new FormData();
  upload.set('csrf', ctx.alice.csrf);
  const pixels = await sharp({
    create: { width: 16, height: 12, channels: 3, background: '#557799' },
  })
    .png()
    .toBuffer();
  upload.set('files', new Blob([new Uint8Array(pixels)]), 'synthetic.png');
  const photoResponse = await ctx.request('/actions/photo', {
    method: 'POST',
    headers: { origin, accept: 'application/json', cookie: ctx.alice.cookie },
    body: upload,
  });
  assert.equal(photoResponse.status, 200);
  const { mediaIds } = await photoResponse.json();
  const mediaId = mediaIds[0];
  const created = await ctx.mutate(
    '/actions/posts',
    { body: payload, audience: 'friends', mediaIds: [mediaId] },
    ctx.alice,
  );
  assert.equal(created.status, 200, await created.clone().text());
  const post = (await created.json()).post;
  assert.equal(
    (await ctx.request(`/api/posts/${post.id}`, { headers: { cookie: bob.cookie } })).status,
    200,
  );
  const allowedMedia = await ctx.request(`/posts/${post.id}/media/${mediaId}`, {
    headers: { cookie: bob.cookie },
  });
  assert.equal(allowedMedia.status, 200);
  assert.equal(allowedMedia.headers.get('content-type'), 'image/webp');
  assert.ok((await allowedMedia.arrayBuffer()).byteLength > 0);
  for (const path of [
    `/api/posts/${post.id}`,
    `/posts/${post.id}`,
    `/posts/${post.id}/media/${mediaId}`,
  ])
    assert.equal(
      (await ctx.request(path, { headers: { cookie: carol.cookie, accept: 'application/json' } }))
        .status,
      404,
      path,
    );
  assert.equal(
    (await ctx.mutate(`/actions/posts/${post.id}/comment`, { body: 'Unauthorized' }, carol)).status,
    404,
  );
  assert.equal(
    (await ctx.mutate(`/actions/posts/${post.id}/like`, { enabled: true }, carol)).status,
    404,
  );
  const rendered = await ctx.request(`/posts/${post.id}`, { headers: { cookie: bob.cookie } });
  const html = await rendered.text();
  assert.equal(html.includes(payload), false);
  assert.match(html, /&lt;script&gt;/);
  assert.match(rendered.headers.get('content-security-policy')!, /object-src 'none'/);
  const feed = await ctx.request('/api/feed', { headers: { cookie: carol.cookie } });
  assert.deepEqual((await feed.json()).posts, []);
  assert.equal((await ctx.mutate(`/actions/posts/${post.id}/delete`, {}, bob)).status, 404);
});

async function importPhoto(ctx: Awaited<ReturnType<typeof fixture>>, owner: Login, suffix: string) {
  const input = join(ctx.config.dataDir, `synthetic-input-${suffix}`);
  await mkdir(input, { recursive: true });
  const pixels = await sharp({
    create: { width: 14, height: 9, channels: 3, background: '#b7c9dc' },
  })
    .png()
    .toBuffer();
  await writeFile(join(input, 'photo.png'), pixels);
  await writeFile(
    join(input, 'posts.json'),
    JSON.stringify([
      {
        id: suffix,
        timestamp: 946684800,
        data: [{ post: `Private ${suffix} body` }],
        attachments: [{ data: [{ media: { uri: 'photo.png' } }] }],
      },
    ]),
  );
  await ctx.archive.importDirectory(owner.user.id, input);
  const item = ctx.archive
    .list(owner.user.id)
    .find((item) => item.body === `Private ${suffix} body`)!;
  return { item, pixels };
}

test('archive deletion removes linked publication and derivative by default, with explicit archive-only choice', async (t) => {
  const ctx = await fixture(t);
  const bob = await ctx.member('bob');
  const request = ctx.core.requestFriend(ctx.alice.user.id, bob.user.actor);
  ctx.core.acceptFriend(bob.user.id, request);
  for (const archiveOnly of [false, true]) {
    const { item } = await importPhoto(
      ctx,
      ctx.alice,
      archiveOnly ? 'keep-publication' : 'erase-publication',
    );
    const prepared = await ctx.mutate(`/actions/archive/${item.id}/prepare`, {}, ctx.alice);
    assert.equal(prepared.status, 200);
    const mediaId = (await prepared.json()).mediaIds[0];
    const derivativePath = ctx.archive.media(ctx.alice.user.id, mediaId)!.path;
    const originalPath = ctx.archive.media(ctx.alice.user.id, item.mediaIds[0]!)!.path;
    const published = await ctx.mutate(
      '/actions/posts',
      { body: item.body, audience: 'friends', archiveSourceId: item.id, mediaIds: [mediaId] },
      ctx.alice,
    );
    const post = (await published.json()).post;
    const removed = await ctx.mutate(
      `/actions/archive/${item.id}/delete`,
      { archiveOnly: archiveOnly ? 'true' : 'false', confirmed: 'true' },
      ctx.alice,
    );
    assert.equal(removed.status, 200);
    assert.equal(ctx.archive.get(ctx.alice.user.id, item.id), null);
    await assert.rejects(access(originalPath));
    const postResponse = await ctx.request(`/api/posts/${post.id}`, {
      headers: { cookie: bob.cookie },
    });
    assert.equal(postResponse.status, archiveOnly ? 200 : 404);
    const photoResponse = await ctx.request(`/posts/${post.id}/media/${mediaId}`, {
      headers: { cookie: bob.cookie },
    });
    assert.equal(photoResponse.status, archiveOnly ? 200 : 404);
    await photoResponse.arrayBuffer();
    if (archiveOnly) await access(derivativePath);
    else await assert.rejects(access(derivativePath));
  }
});

function unzip(bytes: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) =>
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error);
      const files = new Map<string, Buffer>();
      zip.on('error', reject);
      zip.on('end', () => resolve(files));
      zip.on('entry', (entry) =>
        zip.openReadStream(entry, (failure, stream) => {
          if (failure || !stream) return reject(failure);
          const chunks: Buffer[] = [];
          stream.on('error', reject);
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('end', () => {
            files.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        }),
      );
      zip.readEntry();
    }),
  );
}

test('portable HTTP export contains exact owner media bytes and excludes other archives and credentials', async (t) => {
  const ctx = await fixture(t);
  const bob = await ctx.member('bob');
  const own = await importPhoto(ctx, ctx.alice, 'alice-private');
  await importPhoto(ctx, bob, 'bob-private');
  const downloaded = await ctx.mutate('/actions/export', {}, ctx.alice);
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get('content-type'), 'application/zip');
  const files = await unzip(Buffer.from(await downloaded.arrayBuffer()));
  assert.deepEqual([...files.keys()].sort(), ['account.json', 'private-archive.zip']);
  const account = files.get('account.json')!.toString('utf8');
  assert.equal(account.includes('password_hash'), false);
  assert.equal(account.includes(ctx.alice.csrf), false);
  assert.equal(account.includes(ctx.alice.cookie), false);
  const archive = await unzip(files.get('private-archive.zip')!);
  const manifest = JSON.parse(archive.get('manifest.json')!.toString('utf8'));
  assert.equal(manifest.media.length, 1);
  assert.deepEqual(archive.get(manifest.media[0].file), own.pixels);
  const records = archive.get('archive.ndjson')!.toString('utf8');
  assert.match(records, /alice-private/);
  assert.equal(records.includes('bob-private'), false);
  assert.equal(
    [...archive.keys()].some((name) => /key|session|recovery|secret/.test(name)),
    false,
  );
});

test('suspended members retain export access while imports and native photos are refused', async (t) => {
  const ctx = await fixture(t);
  const bob = await ctx.member('bob');
  ctx.core.suspend(ctx.alice.user.id, bob.user.id);
  const login = await ctx.mutate('/actions/login', { username: 'bob', password });
  assert.equal(login.status, 200);
  const result = await login.json();
  const suspended = {
    ...bob,
    cookie: login.headers.get('set-cookie')!.split(';')[0]!,
    csrf: result.csrf,
  };
  const photo = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#c0c0c0' } })
    .png()
    .toBuffer();
  for (const path of ['/api/imports', '/actions/photo']) {
    const form = new FormData();
    form.set('csrf', suspended.csrf);
    form.set('files', new Blob([new Uint8Array(photo)]), 'synthetic.png');
    const response = await ctx.request(path, {
      method: 'POST',
      headers: { origin, accept: 'application/json', cookie: suspended.cookie },
      body: form,
    });
    assert.equal(response.status, 403, path);
  }
  const exported = await ctx.mutate('/actions/export', {}, suspended);
  assert.equal(exported.status, 200);
  await exported.arrayBuffer();
});

test('password changes invalidate existing HTTP sessions and stale in-flight login credentials', async (t) => {
  const ctx = await fixture(t);
  const bob = await ctx.member('bob');
  const changed = await ctx.mutate(
    '/actions/password',
    { currentPassword: password, newPassword: 'a replacement fictional passphrase' },
    bob,
  );
  assert.equal(changed.status, 200);
  assert.equal((await ctx.request('/api/me', { headers: { cookie: bob.cookie } })).status, 401);
  const currentCookie = changed.headers.get('set-cookie')!.split(';')[0]!;
  assert.equal((await ctx.request('/api/me', { headers: { cookie: currentCookie } })).status, 200);
  const staleLogin = ctx.core.login('bob', 'a replacement fictional passphrase');
  // Simulate the committed credential change occurring while Argon2 is working.
  // This is a real pending verify, not a stubbed password check.
  const freshHash = ctx.store.db
    .prepare('SELECT password_hash FROM users WHERE id=?')
    .get(ctx.alice.user.id)!.password_hash;
  ctx.store.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(freshHash, bob.user.id);
  await assert.rejects(staleLogin, /Credentials changed/);
});

test('restore reconciliation blocks all account access until newer deletions are applied', async (t) => {
  const ctx = await fixture(t);
  const bob = await ctx.member('bob');
  const requestId = ctx.core.requestFriend(ctx.alice.user.id, bob.user.actor);
  ctx.core.acceptFriend(bob.user.id, requestId);
  const post = ctx.core.publish(ctx.alice.user.id, {
    body: 'A grant from a restored snapshot',
    audience: 'friends',
  });
  ctx.store.setSetting('restore_reconciliation_required', 'true');
  assert.equal(ctx.core.canRead(post.id, bob.user.id), false);
  for (const path of [
    `/api/posts/${post.id}`,
    '/api/feed',
    '/api/me',
    '/archive',
    '/settings',
    '/login',
    '/recover',
    '/',
  ]) {
    assert.equal((await ctx.request(path, { headers: { cookie: bob.cookie } })).status, 503, path);
    assert.equal(
      (await ctx.request(path, { headers: { cookie: ctx.alice.cookie } })).status,
      503,
      path,
    );
  }
  assert.equal(
    (
      await ctx.mutate(
        '/actions/posts',
        { body: 'Sharing is paused', audience: 'friends' },
        ctx.alice,
      )
    ).status,
    503,
  );
  assert.equal((await ctx.mutate('/actions/login', { username: 'bob', password })).status, 503);
  assert.equal((await ctx.request('/healthz')).status, 200);
  assert.equal((await ctx.request('/privacy')).status, 200);
});

test('handle discovery does not publish biographies and large forms are bounded', async (t) => {
  const ctx = await fixture(t);
  ctx.core.updateSettings(ctx.alice.user.id, {
    discoverable: true,
    bio: 'A biography for friends only.',
  });
  const profile = await ctx.request('/users/alice');
  assert.equal(profile.status, 200);
  assert.equal((await profile.text()).includes('A biography for friends only.'), false);
  const large = await ctx.mutate(
    '/actions/posts',
    { body: 'x'.repeat(300_000), audience: 'private' },
    ctx.alice,
  );
  assert.equal(large.status, 413);
  assert.equal(ctx.core.feed(ctx.alice.user.id).length, 0);
});

test('notification routes recheck audience and account deletion completes its durable archive cleanup', async (t) => {
  const ctx = await fixture(t);
  const bob = await ctx.member('bob');
  const carol = await ctx.member('carol');
  const request = ctx.core.requestFriend(ctx.alice.user.id, bob.user.actor);
  ctx.core.acceptFriend(bob.user.id, request);
  ctx.core.updateSettings(bob.user.id, { quietNotifications: false });
  const post = ctx.core.publish(ctx.alice.user.id, { body: 'For Bob only', audience: 'friends' });
  const notifications = await ctx.request('/notifications', { headers: { cookie: bob.cookie } });
  assert.equal(notifications.status, 200);
  assert.match(await notifications.text(), new RegExp(`/posts/${post.id}`));
  const outsiders = await ctx.request('/notifications', { headers: { cookie: carol.cookie } });
  assert.equal((await outsiders.text()).includes(post.id), false);
  assert.equal(
    (await ctx.mutate('/actions/notifications/read', {}, bob, { 'x-csrf-token': 'forged' })).status,
    403,
  );
  assert.equal((await ctx.mutate('/actions/notifications/read', {}, bob)).status, 200);
  assert.ok(ctx.core.notifications(bob.user.id).every((n) => n.read));
  ctx.core.revokeRecipients(ctx.alice.user.id, post.id, [bob.user.actor]);
  const revoked = await ctx.request('/notifications', { headers: { cookie: bob.cookie } });
  assert.equal((await revoked.text()).includes(post.id), false);
  const privateArchive = await importPhoto(ctx, bob, 'deleted-member');
  const privatePath = ctx.archive.media(bob.user.id, privateArchive.item.mediaIds[0]!)!.path;
  const deleted = await ctx.mutate('/actions/delete-account', { confirmation: 'bob' }, bob);
  assert.equal(deleted.status, 200);
  assert.equal(ctx.core.userByName('bob'), null);
  assert.deepEqual(ctx.core.pendingAccountDeletions(), []);
  assert.equal(ctx.archive.count(bob.user.id), 0);
  await assert.rejects(access(privatePath));
  assert.equal((await ctx.request('/api/me', { headers: { cookie: bob.cookie } })).status, 401);
});

test('maintenance defers a real SQLite writer lock and resumes after the commit', async (t) => {
  const ctx = await fixture(t);
  const writer = new DatabaseSync(ctx.store.path);
  ctx.store.db
    .prepare('INSERT INTO rate_buckets(key,started_at,count) VALUES(?,?,?)')
    .run('expired-maintenance-test', Date.now() - 3 * 86_400_000, 1);
  ctx.store.db.exec('PRAGMA busy_timeout=1');
  try {
    writer.exec('BEGIN IMMEDIATE');
    assert.equal(await ctx.maintenance(), false);
    assert.equal((await ctx.request('/healthz')).status, 200);
    assert.ok(
      ctx.store.db
        .prepare('SELECT 1 FROM rate_buckets WHERE key=?')
        .get('expired-maintenance-test'),
    );
    writer.exec('COMMIT');
    assert.equal(await ctx.maintenance(), true);
    assert.equal(
      ctx.store.db
        .prepare('SELECT 1 FROM rate_buckets WHERE key=?')
        .get('expired-maintenance-test'),
      undefined,
    );
  } finally {
    if (writer.isTransaction) writer.exec('ROLLBACK');
    writer.close();
  }
});

test('production logout and logout-all clear secure host cookies without throwing', async (t) => {
  const ctx = await fixture(t);
  for (const path of ['/actions/logout', '/actions/logout-all']) {
    const login = await ctx.mutate('/actions/login', { username: 'alice', password });
    const result = await login.json();
    const session = {
      ...ctx.alice,
      cookie: login.headers.get('set-cookie')!.split(';')[0]!,
      csrf: result.csrf,
    };
    const response = await ctx.mutate(path, {}, session);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie')!, /^__Host-bookface=;/);
    assert.match(response.headers.get('set-cookie')!, /Secure/);
    assert.match(response.headers.get('set-cookie')!, /Max-Age=0/);
    assert.equal(
      (await ctx.request('/api/me', { headers: { cookie: session.cookie } })).status,
      401,
    );
  }
});

test('shutdown keeps SQLite open until a slow in-flight handler finishes', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'bookface-drain-'));
  const ctx = createApplication(
    {
      ...readConfig({}),
      origin,
      dataDir,
      production: true,
      federation: false,
      host: '127.0.0.1',
      port: 3000,
      maxUploadBytes: 2 * 1024 * 1024,
      instanceName: 'Fictional Circle',
    },
    { startWorkers: false },
  );
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let signalRead!: () => void;
  const reading = new Promise<void>((resolve) => {
    signalRead = resolve;
  });
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    pull() {
      signalRead();
    },
  });
  let closed = false;
  try {
    await ctx.core.setup({ username: 'alice', displayName: 'Alice Example', password });
    const session = await ctx.core.login('alice', password);
    const request = new Request(origin + '/actions/posts', {
      method: 'POST',
      headers: {
        origin,
        accept: 'application/json',
        'content-type': 'application/json',
        cookie: `__Host-bookface=${session.token}`,
        'x-csrf-token': session.csrf,
      },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    const response = ctx.app.request(request);
    await reading;
    const stopping = ctx.close().then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    assert.equal(ctx.store.db.prepare('SELECT 1 AS n').get()!.n, 1);
    controller.enqueue(
      new TextEncoder().encode(
        JSON.stringify({ body: 'Committed before shutdown', audience: 'private' }),
      ),
    );
    controller.close();
    const completed = await response;
    assert.equal(completed.status, 200, await completed.clone().text());
    await completed.arrayBuffer();
    await stopping;
    assert.equal(closed, true);
    assert.throws(() => ctx.store.db.prepare('SELECT 1'));
  } finally {
    if (!closed) await ctx.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('guided host backups are administrator-only and show only recorded backup evidence', async (t) => {
  const ctx = await fixture(t);
  const bob = await ctx.member('bob');
  assert.equal(
    (await ctx.request('/admin/backups', { headers: { accept: 'application/json' } })).status,
    401,
  );
  assert.equal(
    (
      await ctx.request('/admin/backups', {
        headers: { cookie: bob.cookie, accept: 'application/json' },
      })
    ).status,
    403,
  );
  const guide = await ctx.request('/admin/backups', { headers: { cookie: ctx.alice.cookie } });
  assert.equal(guide.status, 200);
  const empty = await guide.text();
  assert.match(empty, /No successful backup has been recorded/);
  assert.match(empty, /does not run host commands or receive backup passwords/);
  assert.match(empty, /This page does not record a restore practice run as verified/);
  assert.match(empty, /init-backup-secrets/);
  assert.match(empty, /reconciliation-export/);
  assert.match(empty, /--keep-within 30d/);
  for (let step = 1; step <= 5; step++) assert.match(empty, new RegExp(`id="backup-step-${step}"`));
  assert.match(empty, /\/srv\/bookface-restore:\/restore/);
  assert.doesNotMatch(empty, /<input[^>]+type="password"/);
  assert.match(guide.headers.get('cache-control')!, /no-store/);
  assert.equal(ctx.store.setting('last_backup_at'), null);
  const recorded = '2026-10-02T12:00:00.000Z';
  const snapshot = 'a'.repeat(64);
  ctx.store.setSetting('last_backup_at', recorded);
  ctx.store.setSetting('last_backup_snapshot', snapshot);
  const updated = await ctx.request('/admin/backups', { headers: { cookie: ctx.alice.cookie } });
  const html = await updated.text();
  assert.match(html, new RegExp(recorded.replaceAll('.', '\\.')));
  assert.match(html, new RegExp(snapshot));
  assert.doesNotMatch(html, /No successful backup has been recorded/);
  assert.match(html, /does not prove that a replacement host has been restored successfully/);
});

test('backup guidance escapes displayed state and does not treat a malicious value as markup', () => {
  const hostile = '<img src=x onerror="alert(1)">';
  const html = backupGuideScreen({
    origin: `https://circle.example/${hostile}`,
    lastBackupAt: hostile,
    lastBackupSnapshot: hostile,
    restorePending: true,
  });
  assert.equal(html.includes(hostile), false);
  assert.match(html, /&lt;img/);
  assert.match(html, /Account and sharing access remain closed/);
  assert.match(html, /MAINTENANCE_MODE=true/);
  assert.match(html, /MAINTENANCE_MODE=false/);
});
