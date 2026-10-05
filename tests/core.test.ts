import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/storage.js';
import { Core, CoreError, type User } from '../src/core.js';

const password = 'a completely fictional passphrase';
async function circle(t: { after(fn: () => void): void }, origin = 'https://circle.example') {
  const dir = mkdtempSync(join(tmpdir(), 'bookface-core-'));
  const store = new Store(dir);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let now = Date.parse('2026-10-02T12:00:00Z');
  const core = new Core(store, { origin, now: () => now });
  const result = await core.setup({ username: 'alice', displayName: 'Alice Example', password });
  const register = async (username: string) =>
    (
      await core.register({
        username,
        displayName: `${username} Example`,
        password,
        inviteToken: core.createInvite(result.user.id, 'registration').token,
      })
    ).user;
  return {
    core,
    store,
    alice: result.user,
    recoveryCodes: result.recoveryCodes,
    register,
    tick: (ms = 1) => {
      now += ms;
    },
  };
}
const denied = (fn: () => unknown, status = 404) =>
  assert.throws(fn, (error: unknown) => error instanceof CoreError && error.status === status);
function friend(core: Core, from: User, to: User) {
  const id = core.requestFriend(from.id, to.actor);
  core.acceptFriend(to.id, id);
}

test('registration consumes a hashed invitation once and creates no implicit friendship', async (t) => {
  const { core, store, alice } = await circle(t);
  const invite = core.createInvite(alice.id, 'registration');
  assert.equal(
    (
      store.db.prepare('SELECT hash FROM invitations WHERE id=?').get(invite.id) as any
    ).hash.includes(invite.token),
    false,
  );
  const bob = (
    await core.register({
      username: 'bob',
      displayName: 'Bob',
      password,
      inviteToken: invite.token,
    })
  ).user;
  assert.deepEqual(core.friends(bob.id), []);
  assert.equal(core.user(bob.id).discoverable, false);
  await assert.rejects(
    core.register({ username: 'carol', displayName: 'Carol', password, inviteToken: invite.token }),
    CoreError,
  );
  assert.equal(core.userByName('carol'), null);
  const revoked = core.createInvite(alice.id, 'registration');
  core.revokeInvite(alice.id, revoked.id);
  await assert.rejects(
    core.register({
      username: 'carol',
      displayName: 'Carol',
      password,
      inviteToken: revoked.token,
    }),
    CoreError,
  );
});

test('concurrent registration is atomic; setup cannot create a second administrator', async (t) => {
  const { core, alice } = await circle(t);
  const token = core.createInvite(alice.id, 'registration').token;
  const results = await Promise.allSettled(
    ['bob', 'carol'].map((username) =>
      core.register({ username, displayName: username, password, inviteToken: token }),
    ),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  await assert.rejects(
    core.setup({ username: 'mallory', displayName: 'Mallory', password }),
    CoreError,
  );
  assert.equal(core.adminMembers(alice.id).filter((u) => u.admin).length, 1);
});

test('recovery invalidates sessions and old recovery codes without exporting secrets', async (t) => {
  const { core, store, alice, recoveryCodes } = await circle(t);
  const session = await core.login('alice', password);
  assert.equal(core.validCsrf(session, session.csrf), true);
  assert.equal(core.validCsrf(session, 'wrong'), false);
  assert.equal(
    (store.db.prepare('SELECT hash FROM sessions').get() as any).hash.includes(session.token),
    false,
  );
  const recovered = await core.recover('alice', recoveryCodes[0]!, 'another fictional passphrase');
  assert.equal(core.session(session.token), null);
  await assert.rejects(core.recover('alice', recoveryCodes[1]!, password), CoreError);
  await assert.rejects(core.login('alice', password), CoreError);
  assert.equal((await core.login('alice', 'another fictional passphrase')).user.id, alice.id);
  assert.notDeepEqual(recovered.recoveryCodes, recoveryCodes);
  const exported = JSON.stringify(core.exportAccount(alice.id));
  assert.equal(exported.includes('password_hash'), false);
  assert.equal(exported.includes(session.csrf), false);
  assert.equal(exported.includes(recovered.recoveryCodes[0]!), false);
});

test('friendship requires consent and expired invites and requests grant no access', async (t) => {
  const { core, alice, register, tick } = await circle(t);
  const bob = await register('bob');
  const request = core.requestFriend(alice.id, bob.actor);
  assert.equal(core.areFriends(alice.actor, bob.actor), false);
  denied(() => core.acceptFriend(alice.id, request));
  tick(8 * 86_400_000);
  denied(() => core.acceptFriend(bob.id, request));
  const invite = core.createInvite(alice.id, 'friendship', 60_000);
  tick(60_001);
  denied(() => core.acceptFriendInvite(bob.id, invite.token), 400);
  const valid = core.createInvite(alice.id, 'friendship');
  core.acceptFriendInvite(bob.id, valid.token);
  assert.equal(core.areFriends(alice.actor, bob.actor), true);
  denied(() => core.acceptFriendInvite(bob.id, valid.token), 400);
});

test('saved audiences prevent new-friend backfill and deny comments, likes, search and media', async (t) => {
  const { core, alice, register, tick } = await circle(t);
  const bob = await register('bob');
  const carol = await register('carol');
  friend(core, alice, bob);
  const privatePost = core.publish(alice.id, { body: 'Only mine', audience: 'private' });
  tick();
  const old = core.publish(alice.id, {
    body: 'A memory with a unique needle',
    audience: 'friends',
  });
  friend(core, alice, carol);
  assert.equal(core.post(old.id, bob.id).body, old.body);
  assert.equal('recipientActors' in core.post(old.id, bob.id), false);
  denied(() => core.post(privatePost.id, bob.id));
  denied(() => core.post(old.id, carol.id));
  denied(() => core.comment(carol.id, old.id, 'Unauthorized'));
  denied(() => core.like(carol.id, old.id));
  assert.deepEqual(core.feed(carol.id, { query: 'needle' }), []);
  core.editPost(alice.id, old.id, { body: 'Edited needle' });
  denied(() => core.post(old.id, carol.id));
  core.comment(bob.id, old.id, 'Hello');
  core.like(bob.id, old.id);
  assert.equal(core.post(old.id, alice.id).comments.length, 1);
  assert.equal(core.post(old.id, alice.id).likes, 1);
  assert.equal(core.sharedMediaAllowed('unowned-original', bob.actor), false);
  denied(
    () =>
      core.publish(alice.id, {
        body: 'Photo',
        audience: 'friends',
        mediaIds: ['unowned-original'],
      }),
    400,
  );
});

test('unfriend, block and explicit revocation remove access without reviving old grants', async (t) => {
  const { core, alice, register } = await circle(t);
  const bob = await register('bob');
  friend(core, alice, bob);
  const first = core.publish(alice.id, { body: 'First', audience: 'friends' });
  core.unfriend(bob.id, alice.actor);
  denied(() => core.post(first.id, bob.id));
  friend(core, alice, bob);
  denied(() => core.post(first.id, bob.id));
  denied(() => core.grantRecipients(alice.id, first.id, [bob.actor]), 409);
  const next = core.publish(alice.id, { body: 'Next', audience: 'friends' });
  core.revokeRecipients(alice.id, next.id, [bob.actor]);
  denied(() => core.post(next.id, bob.id));
  const last = core.publish(alice.id, { body: 'Last', audience: 'friends' });
  core.block(bob.id, alice.actor);
  denied(() => core.post(last.id, bob.id));
  denied(() => core.requestFriend(alice.id, bob.actor), 400);
  core.unblock(bob.id, alice.actor);
  assert.equal(core.areFriends(alice.actor, bob.actor), false);
});

test('mute and favorites are explicit feed controls; delete erases active content', async (t) => {
  const { core, alice, register, store } = await circle(t);
  const bob = await register('bob');
  friend(core, alice, bob);
  const post = core.publish(alice.id, { body: 'Unranked moment', audience: 'friends' });
  core.setFriendPreference(bob.id, alice.actor, { muted: true });
  assert.deepEqual(core.feed(bob.id), []);
  assert.equal(core.post(post.id, bob.id).body, post.body);
  core.setFriendPreference(bob.id, alice.actor, { muted: false, favorite: true });
  assert.equal(core.feed(bob.id, { favoritesOnly: true }).length, 1);
  core.comment(bob.id, post.id, 'A comment');
  core.deletePost(alice.id, post.id);
  denied(() => core.post(post.id, alice.id));
  denied(() => core.post(post.id, bob.id));
  const stored = store.db
    .prepare('SELECT body,media_ids FROM publications WHERE id=?')
    .get(post.id) as any;
  assert.equal(stored.body, '');
  assert.equal(stored.media_ids, '[]');
  assert.equal((store.db.prepare('SELECT count(*) AS n FROM comments').get() as any).n, 0);
});

test('chronological pagination preserves every post with equal timestamps', async (t) => {
  const { core, alice } = await circle(t);
  for (let index = 0; index < 23; index++)
    core.publish(alice.id, { body: `Moment ${index}`, audience: 'private' });
  const first = core.feed(alice.id, { limit: 20 });
  assert.equal(first.length, 20);
  const last = first.at(-1)!;
  const second = core.feed(alice.id, { limit: 20, before: last.createdAt, beforeId: last.id });
  assert.equal(second.length, 3);
  assert.equal(new Set([...first, ...second].map((post) => post.id)).size, 23);
  assert.deepEqual(
    [...first, ...second].map((post) => post.id),
    [...first, ...second]
      .map((post) => post.id)
      .sort()
      .reverse(),
  );
});

test('moderation keeps appeal/export access while suspension blocks social actions', async (t) => {
  const { core, alice, register } = await circle(t);
  const bob = await register('bob');
  friend(core, alice, bob);
  const post = core.publish(bob.id, { body: 'A reported post', audience: 'friends' });
  const report = core.report(alice.id, bob.actor, 'Automated engagement', post.id);
  denied(() => core.adminReports(bob.id), 403);
  assert.equal(core.adminReports(alice.id)[0]!.evidence, post.body);
  core.suspend(alice.id, bob.id);
  assert.equal((await core.login('bob', password)).user.suspended, true);
  denied(() => core.publish(bob.id, { body: 'Bypass', audience: 'private' }), 403);
  assert.ok(core.exportAccount(bob.id));
  const appeal = core.appeal(bob.id, 'I use assistive technology.');
  core.resolveAppeal(alice.id, appeal, true, 'Thanks for explaining.');
  core.resolveReport(alice.id, report);
  assert.equal(core.user(bob.id).suspended, false);
  assert.deepEqual(core.friends(bob.id), []);
});

test('quiet notifications inherit exact audience and disappear when content or grants are removed', async (t) => {
  const { core, alice, register, store } = await circle(t);
  const bob = await register('bob');
  const carol = await register('carol');
  const request = core.requestFriend(alice.id, bob.actor);
  assert.equal(core.notifications(bob.id).filter((n) => n.kind === 'friend.request').length, 1);
  core.acceptFriend(bob.id, request);
  friend(core, alice, carol);
  assert.equal(core.notifications(bob.id).filter((n) => n.kind === 'friend.request').length, 0);
  const post = core.publish(alice.id, {
    body: 'A small conversation',
    audience: 'selected',
    recipientActors: [bob.actor],
  });
  const comment = core.comment(bob.id, post.id, 'Just for this audience.');
  core.like(bob.id, post.id);
  assert.equal(core.notifications(alice.id).filter((n) => n.postId === post.id).length, 1);
  assert.equal(core.notifications(bob.id).filter((n) => n.kind === 'post').length, 0);
  core.updateSettings(alice.id, { quietNotifications: false });
  core.updateSettings(bob.id, { quietNotifications: false });
  assert.equal(core.notifications(alice.id).filter((n) => n.postId === post.id).length, 2);
  assert.equal(core.notifications(carol.id).filter((n) => n.postId === post.id).length, 0);
  assert.equal(core.notifications(bob.id).filter((n) => n.kind === 'post').length, 1);
  core.markNotificationsRead(alice.id);
  assert.ok(core.notifications(alice.id).every((n) => n.read));
  core.deleteComment(bob.id, comment.id);
  core.like(bob.id, post.id, false);
  assert.equal(core.notifications(alice.id).filter((n) => n.postId === post.id).length, 0);
  core.revokeRecipients(alice.id, post.id, [bob.actor]);
  assert.equal(core.notifications(bob.id).filter((n) => n.postId === post.id).length, 0);
  const changed = core.updateSettings(alice.id, { compactFeed: true, quietNotifications: true });
  assert.equal(changed.compactFeed, true);
  const restarted = new Core(store, { origin: core.origin });
  assert.equal(restarted.user(alice.id).compactFeed, true);
  assert.equal(restarted.notifications(bob.id).filter((n) => n.postId === post.id).length, 0);
});

test('account deletion reserves actor identity and removes credentials and owned content', async (t) => {
  const { core, alice, register, store } = await circle(t);
  const bob = await register('bob');
  friend(core, alice, bob);
  core.publish(bob.id, { body: 'Removed forever here', audience: 'friends' });
  const session = await core.login('bob', password);
  core.deleteAccount(bob.id);
  assert.equal(core.userByName('bob'), null);
  assert.equal(core.session(session.token), null);
  assert.deepEqual(core.pendingAccountDeletions(), [bob.id]);
  const restarted = new Core(store, { origin: core.origin });
  assert.deepEqual(restarted.pendingAccountDeletions(), [bob.id]);
  restarted.completeAccountDeletion(bob.id);
  assert.deepEqual(core.pendingAccountDeletions(), []);
  assert.equal(core.localActor('bob')?.deleted, true);
  assert.equal(
    (store.db.prepare('SELECT password_hash FROM users WHERE id=?').get(bob.id) as any)
      .password_hash,
    '',
  );
  const invite = core.createInvite(alice.id, 'registration');
  await assert.rejects(
    core.register({ username: 'bob', displayName: 'New Bob', password, inviteToken: invite.token }),
    CoreError,
  );
  assert.equal(core.feed(alice.id).length, 0);
});

async function remoteFriends(
  a: Awaited<ReturnType<typeof circle>>,
  b: Awaited<ReturnType<typeof circle>>,
  target: User,
) {
  const request = a.core.requestFriend(a.alice.id, target.actor);
  const requestURL = `${a.core.origin}/federation/activities/${request}`;
  b.core.receiveActivity(target.id, a.alice.actor, {
    id: requestURL,
    type: 'Follow',
    actor: a.alice.actor,
    to: [target.actor],
    object: target.actor,
  });
  b.core.acceptFriend(target.id, requestURL);
  a.core.receiveActivity(a.alice.id, target.actor, {
    id: `${b.core.origin}/federation/activities/${randomUUID()}`,
    type: 'Accept',
    actor: target.actor,
    to: [a.alice.actor],
    object: requestURL,
  });
}
function envelope(
  actor: string,
  to: string,
  type: string,
  object: unknown,
  extra: Record<string, unknown> = {},
) {
  return {
    id: `${new URL(actor).origin}/federation/activities/${randomUUID()}`,
    type,
    actor,
    to: [to],
    object,
    ...extra,
  };
}

test('federation grants are per account, cannot widen on Update, and reject foreign authors', async (t) => {
  const a = await circle(t, 'https://a.example');
  const b = await circle(t, 'https://b.example');
  const bob = await b.register('bob');
  const charlie = await b.register('charlie');
  await remoteFriends(a, b, bob);
  await remoteFriends(a, b, charlie);
  b.core.updateSettings(bob.id, { quietNotifications: false });
  b.core.updateSettings(charlie.id, { quietNotifications: false });
  const post = a.core.publish(a.alice.id, {
    body: 'Only Bob across servers',
    audience: 'selected',
    recipientActors: [bob.actor],
  });
  const url = a.core.objectUrl(post.id);
  const note = a.core.federationObject(url, bob.actor)!;
  b.core.receiveActivity(bob.id, a.alice.actor, envelope(a.alice.actor, bob.actor, 'Create', note));
  assert.equal(b.core.post(url, bob.id).body, post.body);
  denied(() => b.core.post(url, charlie.id));
  assert.equal(b.core.notifications(bob.id).filter((n) => n.postId === url).length, 1);
  assert.equal(b.core.notifications(charlie.id).filter((n) => n.postId === url).length, 0);
  b.core.receiveActivity(bob.id, a.alice.actor, envelope(a.alice.actor, bob.actor, 'Create', note));
  assert.equal(b.core.notifications(bob.id).filter((n) => n.postId === url).length, 1);
  denied(
    () =>
      b.core.receiveActivity(
        charlie.id,
        a.alice.actor,
        envelope(a.alice.actor, charlie.actor, 'Update', {
          ...note,
          to: [charlie.actor],
          'cb:revision': 2,
        }),
      ),
    403,
  );
  denied(
    () =>
      b.core.receiveActivity(
        bob.id,
        a.alice.actor,
        envelope(a.alice.actor, bob.actor, 'Create', {
          ...note,
          attributedTo: 'https://forged.example/users/person',
        }),
      ),
    403,
  );
  assert.equal(a.core.federationObject(url, charlie.actor), null);
  const serialized = JSON.stringify(
    a.core.pendingEvents().find((e) => e.kind === 'post.create')?.payload,
  );
  assert.equal(serialized.includes(charlie.actor), false);
  assert.equal(serialized.includes('archive'), false);
});

test('federation tombstones reject delayed creates and pending delivery rechecks revocation', async (t) => {
  const a = await circle(t, 'https://a.example');
  const b = await circle(t, 'https://b.example');
  const bob = await b.register('bob');
  await remoteFriends(a, b, bob);
  const post = a.core.publish(a.alice.id, { body: 'A revocable post', audience: 'friends' });
  const url = a.core.objectUrl(post.id);
  const note = a.core.federationObject(url, bob.actor)!;
  const queued = a.core.pendingEvents().find((e) => e.kind === 'post.create')!;
  b.core.receiveActivity(
    bob.id,
    a.alice.actor,
    envelope(a.alice.actor, bob.actor, 'Remove', url, { target: bob.actor }),
  );
  denied(
    () =>
      b.core.receiveActivity(
        bob.id,
        a.alice.actor,
        envelope(a.alice.actor, bob.actor, 'Create', note),
      ),
    410,
  );
  a.core.revokeRecipients(a.alice.id, post.id, [bob.actor]);
  assert.equal(a.core.outboundEvent(queued.id), null);
  const second = a.core.publish(a.alice.id, {
    body: 'Deleted before delivery',
    audience: 'friends',
  });
  const secondURL = a.core.objectUrl(second.id);
  const secondNote = a.core.federationObject(secondURL, bob.actor)!;
  b.core.receiveActivity(
    bob.id,
    a.alice.actor,
    envelope(a.alice.actor, bob.actor, 'Delete', secondURL),
  );
  denied(
    () =>
      b.core.receiveActivity(
        bob.id,
        a.alice.actor,
        envelope(a.alice.actor, bob.actor, 'Create', secondNote),
      ),
    410,
  );
});

test('federation interactions inherit grants, bind exact author and exact undone like', async (t) => {
  const a = await circle(t, 'https://a.example');
  const b = await circle(t, 'https://b.example');
  const bob = await b.register('bob');
  const charlie = await b.register('charlie');
  await remoteFriends(a, b, bob);
  await remoteFriends(a, b, charlie);
  const post = a.core.publish(a.alice.id, {
    body: 'A private conversation',
    audience: 'selected',
    recipientActors: [bob.actor],
  });
  const url = a.core.objectUrl(post.id);
  const note = {
    type: 'Note',
    id: `${b.core.origin}/federation/comments/${randomUUID()}`,
    attributedTo: bob.actor,
    content: 'A reply',
    mediaType: 'text/plain',
    published: new Date(post.createdAt).toISOString(),
    inReplyTo: url,
    to: [a.alice.actor],
  };
  a.core.receiveActivity(a.alice.id, bob.actor, envelope(bob.actor, a.alice.actor, 'Create', note));
  assert.equal(a.core.post(post.id, a.alice.id).comments.length, 1);
  denied(
    () =>
      a.core.receiveActivity(
        a.alice.id,
        charlie.actor,
        envelope(charlie.actor, a.alice.actor, 'Create', {
          ...note,
          id: `${b.core.origin}/federation/comments/${randomUUID()}`,
          attributedTo: charlie.actor,
        }),
      ),
    403,
  );
  denied(
    () =>
      a.core.receiveActivity(
        a.alice.id,
        bob.actor,
        envelope(bob.actor, a.alice.actor, 'Create', { ...note, attributedTo: charlie.actor }),
      ),
    403,
  );
  const likeId = `${b.core.origin}/federation/activities/${randomUUID()}`;
  a.core.receiveActivity(
    a.alice.id,
    bob.actor,
    envelope(bob.actor, a.alice.actor, 'Like', url, { 'cb:interactionId': likeId }),
  );
  assert.equal(a.core.post(post.id, a.alice.id).likes, 1);
  denied(
    () =>
      a.core.receiveActivity(
        a.alice.id,
        bob.actor,
        envelope(
          bob.actor,
          a.alice.actor,
          'Undo',
          `${b.core.origin}/federation/activities/${randomUUID()}`,
          { 'cb:inReplyTo': url },
        ),
      ),
    403,
  );
  a.core.receiveActivity(
    a.alice.id,
    bob.actor,
    envelope(bob.actor, a.alice.actor, 'Undo', likeId, { 'cb:inReplyTo': url }),
  );
  assert.equal(a.core.post(post.id, a.alice.id).likes, 0);
  denied(
    () =>
      a.core.receiveActivity(
        a.alice.id,
        bob.actor,
        envelope(bob.actor, a.alice.actor, 'Like', url, { 'cb:interactionId': likeId }),
      ),
    410,
  );
});

test('delayed relationship removal and Undo cannot cancel a later consent cycle', async (t) => {
  const a = await circle(t, 'https://a.example');
  const b = await circle(t, 'https://b.example');
  const bob = await b.register('bob');
  await remoteFriends(a, b, bob);
  const previous = a.core.friends(a.alice.id)[0]!.id;
  const originalURL = `${a.core.origin}/federation/activities/${previous}`;
  const oldPost = a.core.publish(a.alice.id, { body: 'Before reconnection', audience: 'friends' });
  const oldURL = a.core.objectUrl(oldPost.id);
  b.core.receiveActivity(
    bob.id,
    a.alice.actor,
    envelope(a.alice.actor, bob.actor, 'Create', a.core.federationObject(oldURL, bob.actor)!),
  );
  a.core.unfriend(a.alice.id, bob.actor);
  // Deliver the new request before the previous removal, as an offline retry can.
  await remoteFriends(a, b, bob);
  assert.equal(b.core.areFriends(bob.actor, a.alice.actor), true);
  denied(() => b.core.post(oldURL, bob.id));
  b.core.receiveActivity(
    bob.id,
    a.alice.actor,
    envelope(a.alice.actor, bob.actor, 'Remove', bob.actor, {
      'cb:relationship': true,
      'cb:relationshipId': originalURL,
    }),
  );
  b.core.receiveActivity(
    bob.id,
    a.alice.actor,
    envelope(a.alice.actor, bob.actor, 'Undo', originalURL, { 'cb:relationship': true }),
  );
  assert.equal(b.core.areFriends(bob.actor, a.alice.actor), true);
  const fresh = a.core.publish(a.alice.id, { body: 'After reconnection', audience: 'friends' });
  const freshURL = a.core.objectUrl(fresh.id);
  b.core.receiveActivity(
    bob.id,
    a.alice.actor,
    envelope(a.alice.actor, bob.actor, 'Create', a.core.federationObject(freshURL, bob.actor)!),
  );
  assert.equal(b.core.post(freshURL, bob.id).body, 'After reconnection');
});

test('one remote account cannot preempt another account’s future grant tombstone', async (t) => {
  const a = await circle(t, 'https://a.example');
  const b = await circle(t, 'https://b.example');
  const bob = await b.register('bob');
  await remoteFriends(a, b, bob);
  const post = a.core.publish(a.alice.id, { body: 'Alice owns this object', audience: 'friends' });
  const url = a.core.objectUrl(post.id);
  const mallory = `${a.core.origin}/users/mallory`;
  b.core.receiveActivity(
    bob.id,
    mallory,
    envelope(mallory, bob.actor, 'Remove', url, { target: bob.actor }),
  );
  b.core.receiveActivity(
    bob.id,
    a.alice.actor,
    envelope(a.alice.actor, bob.actor, 'Create', a.core.federationObject(url, bob.actor)!),
  );
  assert.equal(b.core.post(url, bob.id).body, post.body);
});

test('a withdrawn friendship delivered before its original Follow cannot reappear', async (t) => {
  const b = await circle(t, 'https://b.example');
  const bob = await b.register('bob');
  const alice = 'https://a.example/users/alice';
  for (const type of ['Remove', 'Undo']) {
    const followId = `https://a.example/federation/activities/${randomUUID()}`;
    b.core.receiveActivity(
      bob.id,
      alice,
      envelope(alice, bob.actor, type, type === 'Remove' ? bob.actor : followId, {
        'cb:relationship': true,
        'cb:relationshipId': followId,
      }),
    );
    denied(
      () =>
        b.core.receiveActivity(bob.id, alice, {
          ...envelope(alice, bob.actor, 'Follow', bob.actor),
          id: followId,
        }),
      410,
    );
  }
  assert.deepEqual(b.core.pendingFriends(bob.id), []);
});

test('administrators can page through every member beyond 500 without exposing them to members', async (t) => {
  const { core, store, alice, register } = await circle(t);
  const bob = await register('bob');
  // Synthetic rows avoid hundreds of irrelevant password hashes. Equal timestamps
  // exercise deterministic page ordering when many people join together.
  const insert = store.db.prepare(
    'INSERT INTO users(id,username,display_name,password_hash,created_at,deleted) VALUES(?,?,?,?,?,?)',
  );
  for (let i = 0; i < 650; i++) {
    const name = `member_${String(i).padStart(4, '0')}`;
    insert.run(name, name, `Fictional Member ${i}`, 'not-a-login-hash', 1800000000000, 0);
  }
  insert.run(
    'deleted_member',
    'deleted_member',
    'Deleted Fictional Member',
    'not-a-login-hash',
    1800000000000,
    1,
  );
  assert.equal(core.adminMemberCount(alice.id), 652);
  assert.equal(core.adminMembers(alice.id).length, 500);
  const ids: string[] = [];
  for (let offset = 0; offset < core.adminMemberCount(alice.id); offset += 100)
    ids.push(...core.adminMembers(alice.id, { offset, limit: 100 }).map((user) => user.id));
  const expected = store.db
    .prepare('SELECT id FROM users WHERE deleted=0 ORDER BY created_at,id')
    .all()
    .map((row) => row.id);
  assert.deepEqual(ids, expected);
  assert.equal(new Set(ids).size, 652);
  assert.equal(ids.at(-1), 'member_0649');
  assert.deepEqual(core.adminMembers(alice.id, { offset: 652, limit: 100 }), []);
  denied(() => core.adminMembers(bob.id, { offset: 500, limit: 100 }), 403);
  denied(() => core.adminMemberCount(bob.id), 403);
  for (const options of [
    { offset: -1 },
    { offset: 0.5 },
    { offset: Infinity },
    { offset: Number.MAX_SAFE_INTEGER + 1 },
    { limit: 0 },
    { limit: 501 },
    { limit: 1.5 },
    { limit: NaN },
  ])
    denied(() => core.adminMembers(alice.id, options), 400);
});
