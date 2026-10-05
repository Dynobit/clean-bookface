import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../src/app.js';
import { readConfig } from '../src/config.js';
import sharp from 'sharp';
import yazl from 'yazl';

const origin = 'https://forms.example';
const password = 'a fictional forms test password';

async function fixture(t: test.TestContext, federation = false) {
  const dataDir = await mkdtemp(join(tmpdir(), 'bookface-form-review-'));
  const runtime = createApplication(
    readConfig({
      NODE_ENV: 'production',
      APP_ORIGIN: origin,
      DATA_DIR: dataDir,
      FEDERATION_ENABLED: String(federation),
    }),
    { startWorkers: false },
  );
  t.after(async () => {
    await runtime.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const owner = await runtime.core.setup({ username: 'owner', displayName: 'Owner', password });
  const session = await runtime.core.login('owner', password);
  const post = (path: string, fields: Record<string, string | boolean | string[]>, form = false) =>
    runtime.app.request(origin + path, {
      method: 'POST',
      headers: {
        origin,
        accept: 'application/json',
        cookie: `__Host-bookface=${session.token}`,
        'x-csrf-token': session.csrf,
        'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json',
      },
      body: form
        ? new URLSearchParams(fields as Record<string, string>).toString()
        : JSON.stringify(fields),
    });
  const get = (
    path: string,
    accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  ) =>
    runtime.app.request(origin + path, {
      headers: { accept, cookie: `__Host-bookface=${session.token}` },
    });
  return { ...runtime, dataDir, owner: owner.user, session, post, get };
}

test('maximum-length Unicode posts survive encoded create/edit forms without weakening text limits', async (t) => {
  const f = await fixture(t);
  const body = '界'.repeat(20_000);
  assert.ok(Buffer.byteLength(new URLSearchParams({ body }).toString()) > 65_536);
  const response = await f.post('/actions/posts', { body, audience: 'private' }, true);
  assert.equal(response.status, 200, await response.clone().text());
  const { post } = await response.json();
  assert.equal(post.body, body);

  const edited = '日'.repeat(20_000);
  const edit = await f.post(`/actions/posts/${post.id}/edit`, { body: edited }, true);
  assert.equal(edit.status, 200, await edit.clone().text());
  assert.equal(f.core.post(post.id, f.owner.id).body, edited);
  assert.equal(
    (await f.post(`/actions/posts/${post.id}/edit`, { body: edited + '一' }, true)).status,
    400,
  );
  assert.equal(f.core.post(post.id, f.owner.id).body, edited);
  assert.equal(
    (await f.post('/actions/posts', { body: '界'.repeat(40_000), audience: 'private' }, true))
      .status,
    413,
  );
  // Ordinary small forms retain their original 64 KiB transport budget.
  assert.equal((await f.post('/actions/settings', { bio: 'x'.repeat(70_000) })).status, 413);
});

test('explicit false friend preferences clear mute and favorite for JSON and form clients', async (t) => {
  const f = await fixture(t);
  const invitation = f.core.createInvite(f.owner.id, 'registration');
  const member = await f.core.register({
    username: 'member',
    displayName: 'Member',
    password,
    inviteToken: invitation.token,
  });
  const request = f.core.requestFriend(f.owner.id, member.user.actor);
  f.core.acceptFriend(member.user.id, request);
  for (const form of [false, true]) {
    for (const value of [false, 'false', 'off', '0']) {
      f.core.setFriendPreference(f.owner.id, member.user.actor, { muted: true, favorite: true });
      const response = await f.post(
        '/actions/friends/preferences',
        { actor: member.user.actor, muted: value, favorite: value },
        form,
      );
      assert.equal(response.status, 200);
      const friend = f.core.friends(f.owner.id)[0]!;
      assert.equal(friend.muted, false);
      assert.equal(friend.favorite, false);
    }
    const enabled = await f.post(
      '/actions/friends/preferences',
      { actor: member.user.actor, muted: 'on', favorite: 'true' },
      form,
    );
    assert.equal(enabled.status, 200);
    assert.equal(f.core.friends(f.owner.id)[0]!.muted, true);
    assert.equal(f.core.friends(f.owner.id)[0]!.favorite, true);
  }
});

test('ordinary browser profile navigation renders HTML instead of entering the disabled federation route', async (t) => {
  const f = await fixture(t);
  for (const accept of [
    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'text/html, application/activity+json;q=0',
    'text/html, application/ld+json;q=0.0',
  ]) {
    const response = await f.get('/users/owner', accept);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await response.text(), /Owner/);
  }
  assert.equal((await f.get('/users/owner', 'application/activity+json')).status, 404);
});

test('a private reply-management page permits retraction after revocation without exposing the conversation', async (t) => {
  const f = await fixture(t);
  const invitation = f.core.createInvite(f.owner.id, 'registration');
  const member = await f.core.register({
    username: 'member',
    displayName: 'Member',
    password,
    inviteToken: invitation.token,
  });
  f.core.acceptFriend(member.user.id, f.core.requestFriend(f.owner.id, member.user.actor));
  const shared = f.core.publish(member.user.id, {
    body: 'Another person’s conversation must remain unavailable',
    audience: 'selected',
    recipientActors: [f.owner.actor],
  });
  const own = f.core.comment(f.owner.id, shared.id, 'My words <script>fictional</script>');
  const other = f.core.comment(member.user.id, shared.id, 'Another person’s reply is private');
  f.core.revokeRecipients(member.user.id, shared.id, [f.owner.actor]);
  assert.equal((await f.get('/posts/' + shared.id)).status, 404);
  const response = await f.get('/settings/comments');
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /My words &lt;script&gt;fictional&lt;\/script&gt;/);
  assert.match(html, /You no longer have access/);
  assert.ok(!html.includes(shared.body));
  assert.ok(!html.includes(other.body));
  assert.ok(!html.includes('/posts/' + shared.id));
  assert.equal(
    (await f.post('/actions/comments/' + encodeURIComponent(other.id) + '/delete', {})).status,
    404,
  );
  const removed = await f.app.request(
    origin + '/actions/comments/' + encodeURIComponent(own.id) + '/delete',
    {
      method: 'POST',
      headers: {
        origin,
        cookie: `__Host-bookface=${f.session.token}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ csrf: f.session.csrf, returnTo: 'comments' }).toString(),
    },
  );
  assert.equal(removed.status, 303);
  assert.equal(removed.headers.get('location'), '/settings/comments');
  assert.match(await (await f.get('/settings/comments')).text(), /No replies to manage/);
  assert.equal((await f.app.request(origin + '/settings/comments')).status, 401);
  assert.equal((await f.get('/settings/comments?before=Infinity')).status, 400);
});

test('overlapping account closures wait for both durable archive cleanup entries', async (t) => {
  const f = await fixture(t);
  const makeMember = async (username: string) => {
    const invitation = f.core.createInvite(f.owner.id, 'registration');
    const account = await f.core.register({
      username,
      displayName: username,
      password,
      inviteToken: invitation.token,
    });
    return { user: account.user, session: await f.core.login(username, password) };
  };
  const first = await makeMember('first');
  const second = await makeMember('second');
  const close = (account: Awaited<ReturnType<typeof makeMember>>) =>
    f.app.request(origin + '/actions/delete-account', {
      method: 'POST',
      headers: {
        origin,
        accept: 'application/json',
        cookie: `__Host-bookface=${account.session.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ csrf: account.session.csrf, confirmation: account.user.username }),
    });
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const secondMarked = Promise.withResolvers<void>();
  const originalDelete = f.archive.deleteOwner.bind(f.archive);
  const originalClose = f.core.deleteAccount.bind(f.core);
  const cleaned: string[] = [];
  f.archive.deleteOwner = async (id) => {
    if (id === first.user.id) {
      entered.resolve();
      await released.promise;
    }
    await originalDelete(id);
    cleaned.push(id);
  };
  f.core.deleteAccount = (id) => {
    originalClose(id);
    if (id === second.user.id) secondMarked.resolve();
  };
  try {
    const a = close(first);
    await entered.promise;
    const b = close(second);
    await secondMarked.promise;
    released.resolve();
    for (const response of await Promise.all([a, b])) {
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        closed: true,
        cleanupPending: false,
        redirect: '/login',
      });
    }
    assert.deepEqual(new Set(cleaned), new Set([first.user.id, second.user.id]));
    assert.deepEqual(f.core.pendingAccountDeletions(), []);
  } finally {
    released.resolve();
    f.archive.deleteOwner = originalDelete;
    f.core.deleteAccount = originalClose;
  }
});

test('an account closes immediately but reports pending cleanup honestly after an I/O failure', async (t) => {
  const f = await fixture(t);
  const invitation = f.core.createInvite(f.owner.id, 'registration');
  const account = await f.core.register({
    username: 'member',
    displayName: 'Member',
    password,
    inviteToken: invitation.token,
  });
  const session = await f.core.login('member', password);
  const original = f.archive.deleteOwner.bind(f.archive);
  f.archive.deleteOwner = async () => {
    throw Object.assign(new Error('synthetic failure'), { code: 'EIO' });
  };
  try {
    const response = await f.app.request(origin + '/actions/delete-account', {
      method: 'POST',
      headers: {
        origin,
        accept: 'application/json',
        cookie: `__Host-bookface=${session.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ csrf: session.csrf, confirmation: 'member' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      closed: true,
      cleanupPending: true,
      redirect: '/login?notice=cleanup-pending',
    });
    assert.equal(f.core.session(session.token), null);
    assert.deepEqual(f.core.pendingAccountDeletions(), [account.user.id]);
  } finally {
    f.archive.deleteOwner = original;
  }
  await f.maintenance();
  assert.deepEqual(f.core.pendingAccountDeletions(), []);
});

test('browser notices are fixed messages and signed-in invitation links keep their destination', async (t) => {
  const f = await fixture(t);
  assert.doesNotMatch(
    await (await f.get('/settings?notice=Send-your-password-to-an-attacker')).text(),
    /Send-your-password/,
  );
  assert.match(await (await f.get('/settings?notice=saved')).text(), /Preferences saved/);
  const invitation = f.core.createInvite(f.owner.id, 'friendship');
  const next = `/invite/${invitation.token}`;
  assert.equal(
    (await f.get('/login?next=' + encodeURIComponent(next))).headers.get('location'),
    next,
  );
  for (const bad of ['https://evil.example/', '//evil.example/', '/\\evil.example/', '/settings'])
    assert.equal(
      (await f.get('/login?next=' + encodeURIComponent(bad))).headers.get('location'),
      '/',
    );
});

test('discoverable profiles hide biographies from strangers and suspended members can see their own profile', async (t) => {
  const f = await fixture(t);
  const invite = f.core.createInvite(f.owner.id, 'registration');
  const { user } = await f.core.register({
    username: 'member',
    displayName: 'Member',
    password,
    inviteToken: invite.token,
  });
  f.core.updateSettings(user.id, {
    displayName: 'Member',
    bio: 'Friends-only biography',
    discoverable: true,
  });
  assert.equal(f.core.profile(undefined, 'member').bio, '');
  assert.doesNotMatch(await (await f.get('/users/member')).text(), /Friends-only biography/);
  f.core.suspend(f.owner.id, user.id, true);
  const login = await f.core.login('member', password);
  assert.equal((await f.get('/users/member')).status, 404);
  const own = await f.app.request(origin + '/users/member', {
    headers: { cookie: `__Host-bookface=${login.token}` },
  });
  assert.equal(own.status, 200);
  assert.match(await own.text(), /Friends-only biography/);
});

test('host setup checklist is owner-only, reports observed state and keeps restore guidance public', async (t) => {
  const f = await fixture(t);
  const before = await f.get('/admin/setup');
  assert.equal(before.status, 200);
  assert.match(await before.text(), /No successful backup has been recorded yet/);
  assert.equal((await f.app.request(origin + '/admin/setup')).status, 401);
  const invite = f.core.createInvite(f.owner.id, 'registration');
  await f.core.register({
    username: 'member',
    displayName: 'Member',
    password,
    inviteToken: invite.token,
  });
  const member = await f.core.login('member', password);
  assert.equal(
    (
      await f.app.request(origin + '/admin/setup', {
        headers: { cookie: `__Host-bookface=${member.token}` },
      })
    ).status,
    403,
  );
  f.store.setSetting('last_backup_at', new Date().toISOString());
  const html = await (await f.get('/admin/setup')).text();
  assert.match(html, /A successful backup was recorded/);
  assert.match(html, /does not prove a restore/);
  f.store.setSetting('restore_reconciliation_required', 'true');
  assert.equal((await f.get('/getting-started')).status, 200);
  assert.equal((await f.get('/admin/setup')).status, 503);
});

test('a no-JavaScript ZIP form redirects to import history and renders readable HTML failures', async (t) => {
  const f = await fixture(t);
  const zip = new yazl.ZipFile();
  zip.addBuffer(
    Buffer.from(
      JSON.stringify([{ timestamp: 946684800, data: [{ post: 'A private form memory' }] }]),
    ),
    'posts.json',
  );
  zip.end();
  const parts: Buffer[] = [];
  for await (const part of zip.outputStream) parts.push(part);
  const form = new FormData();
  form.set('csrf', f.session.csrf);
  form.set('files', new File([Buffer.concat(parts)], 'facebook.zip', { type: 'application/zip' }));
  const response = await f.app.request(origin + '/api/imports', {
    method: 'POST',
    headers: {
      origin,
      accept: 'text/html,application/xhtml+xml',
      cookie: `__Host-bookface=${f.session.token}`,
    },
    body: form,
  });
  assert.equal(response.status, 303, await response.clone().text());
  assert.equal(response.headers.get('location'), '/imports');
  assert.equal(f.archive.jobs(f.owner.id).length, 1);
  const denied = await f.app.request(origin + '/api/imports', {
    method: 'POST',
    headers: { origin, accept: 'text/html' },
    body: new FormData(),
  });
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get('content-type')!, /text\/html/);
  assert.match(await denied.text(), /Please log in/);
});

test('large mixed-media memories allow deliberate photo selection and server-checked deletion', async (t) => {
  const f = await fixture(t);
  const input = join(f.dataDir, 'synthetic-selection');
  await mkdir(input);
  const attachments = [];
  for (let i = 0; i < 9; i++) {
    const name = `photo-${i}.png`;
    await writeFile(
      join(input, name),
      await sharp({
        create: { width: 8, height: 8, channels: 3, background: { r: i * 20, g: 90, b: 140 } },
      })
        .png()
        .toBuffer(),
    );
    attachments.push({ media: { uri: name } });
  }
  // Minimal MP4 signature is retained privately; it is never sent to an image decoder.
  await writeFile(
    join(input, 'movie.mp4'),
    Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex'),
  );
  attachments.push({ media: { uri: 'movie.mp4' } });
  await writeFile(
    join(input, 'posts.json'),
    JSON.stringify([
      {
        id: 'many-attachments',
        data: [{ post: 'Choose photos deliberately' }],
        attachments: [{ data: attachments }],
      },
    ]),
  );
  await f.archive.importDirectory(f.owner.id, input);
  const item = f.archive.list(f.owner.id).find((x) => x.body === 'Choose photos deliberately')!;
  assert.equal(item.mediaIds.length, 10);
  const page = await f.get(`/archive/${item.id}`);
  const html = await page.text();
  assert.match(html, /choose up to 8/);
  assert.match(html, /Videos and other attachments stay in your private archive/);
  assert.doesNotMatch(html, /name="mediaIds"[^>]*checked/);
  const images = item.mediaIds.filter((id) =>
    f.archive.media(f.owner.id, id)!.mime.startsWith('image/'),
  );
  assert.equal(
    (
      await f.post(`/actions/archive/${item.id}/prepare`, {
        selectionPresent: true,
        mediaIds: images,
      })
    ).status,
    400,
  );
  const chosen = await f.post(`/actions/archive/${item.id}/prepare`, {
    selectionPresent: true,
    mediaIds: [images[0]!],
  });
  assert.equal(chosen.status, 200, await chosen.clone().text());
  assert.equal((await chosen.json()).mediaIds.length, 1);
  const textOnly = await f.post(`/actions/archive/${item.id}/prepare`, { selectionPresent: true });
  assert.deepEqual((await textOnly.json()).mediaIds, []);
  const media = await f.get(`/media/${images[0]}`);
  assert.equal(media.status, 200);
  assert.match(media.headers.get('content-security-policy')!, /object-src 'none'/);
  assert.equal(media.headers.get('x-frame-options'), 'DENY');
  await media.arrayBuffer();
  assert.equal((await f.post(`/actions/archive/${item.id}/delete`, {})).status, 400);
  assert.ok(f.archive.get(f.owner.id, item.id));
  assert.equal(
    (await f.post(`/actions/archive/${item.id}/delete`, { confirmed: true })).status,
    200,
  );
  assert.equal(f.archive.get(f.owner.id, item.id), null);
});

test('remote photo transport failures are retryable and still recheck audience revocation', async (t) => {
  const f = await fixture(t, true);
  const actor = 'https://peer.example/users/friend';
  const follow = 'https://peer.example/federation/activities/follow';
  const post = 'https://peer.example/federation/objects/memory';
  const photo = 'https://peer.example/federation/media/photo';
  f.core.receiveActivity(f.owner.id, actor, {
    id: follow,
    actor,
    type: 'Follow',
    to: [f.owner.actor],
    object: f.owner.actor,
  });
  f.core.acceptFriend(f.owner.id, follow);
  f.core.receiveActivity(f.owner.id, actor, {
    id: 'https://peer.example/federation/activities/create',
    actor,
    type: 'Create',
    to: [f.owner.actor],
    object: {
      id: post,
      type: 'Note',
      mediaType: 'text/plain',
      attributedTo: actor,
      to: [f.owner.actor],
      content: 'A shared photo',
      published: new Date().toISOString(),
      'cb:revision': 1,
      attachment: [{ type: 'Image', mediaType: 'image/webp', url: photo }],
    },
  });
  const original = f.federation.signedFetch;
  const path = `/posts/${encodeURIComponent(post)}/media/${encodeURIComponent(photo)}`;
  try {
    f.federation.signedFetch = async () => {
      throw new Error('Synthetic private network diagnostic');
    };
    const failed = await f.get(path, 'application/json');
    assert.equal(failed.status, 503, await failed.clone().text());
    assert.equal(failed.headers.get('retry-after'), '60');
    assert.doesNotMatch(await failed.text(), /private network diagnostic/);
    f.federation.signedFetch = async () => {
      f.core.unfriend(f.owner.id, actor);
      throw new Error('Synthetic timeout after revocation');
    };
    const revoked = await f.get(path, 'application/json');
    assert.equal(revoked.status, 404);
    assert.equal(revoked.headers.get('retry-after'), null);
  } finally {
    f.federation.signedFetch = original;
  }
});
