import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/storage.js';
import { Federation, type FederationAdapter } from '../src/federation.js';
import type { FederationNetwork } from '../src/federation/network.js';
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

test('canonical local actor identity prevents invisible requests and ineffective blocks', async (t) => {
  const { core, alice, register, store } = await circle(t);
  const bob = await register('bob');
  core.block(bob.id, alice.actor);
  denied(() => core.requestFriend(alice.id, bob.actor.replace('/bob', '/Bob')));
  denied(() => core.block(alice.id, bob.actor.replace('/bob', '/Bob')));
  assert.equal((store.db.prepare('SELECT count(*) n FROM friendships').get() as any).n, 0);
});
test('comment authors can retract after revocation; active grants are idempotent and historical grants remain revoked', async (t) => {
  const { core, alice, register } = await circle(t);
  const bob = await register('bob');
  const carol = await register('carol');
  friend(core, alice, bob);
  friend(core, alice, carol);
  const p = core.publish(alice.id, {
    body: 'Shared',
    audience: 'selected',
    recipientActors: [bob.actor],
  });
  const c = core.comment(bob.id, p.id, 'Retractable');
  core.grantRecipients(alice.id, p.id, [bob.actor, carol.actor]);
  assert.equal(core.canRead(p.id, carol.id), true);
  core.revokeRecipients(alice.id, p.id, [bob.actor]);
  core.deleteComment(bob.id, c.id);
  assert.equal(core.post(p.id, carol.id).comments.length, 0);
  denied(() => core.grantRecipients(alice.id, p.id, [bob.actor]), 409);
});
test('equal current revision restores wiped content only to new recipients without reviving old grants or accepting stale content', async (t) => {
  const a = await circle(t, 'https://a.example'),
    b = await circle(t, 'https://b.example');
  const carol = await b.register('carol');
  await remoteFriends(a, b, b.alice);
  await remoteFriends(a, b, carol);
  const p = a.core.publish(a.alice.id, {
    body: 'Current',
    audience: 'selected',
    recipientActors: [b.alice.actor],
  });
  a.core.editPost(a.alice.id, p.id, { body: 'Revision two' });
  const url = a.core.objectUrl(p.id),
    note = a.core.federationObject(url, b.alice.actor)!;
  b.core.receiveActivity(
    b.alice.id,
    a.alice.actor,
    envelope(a.alice.actor, b.alice.actor, 'Create', note),
  );
  b.core.receiveActivity(
    b.alice.id,
    a.alice.actor,
    envelope(a.alice.actor, b.alice.actor, 'Remove', url, { target: b.alice.actor }),
  );
  b.core.receiveActivity(
    carol.id,
    a.alice.actor,
    envelope(a.alice.actor, carol.actor, 'Create', {
      ...note,
      to: [carol.actor],
      'cb:revision': 1,
      content: 'Stale',
    }),
  );
  assert.equal(b.core.canRead(url, carol.id), false);
  b.core.receiveActivity(
    carol.id,
    a.alice.actor,
    envelope(a.alice.actor, carol.actor, 'Create', { ...note, to: [carol.actor] }),
  );
  assert.equal(b.core.post(url, carol.id).body, 'Revision two');
  denied(
    () =>
      b.core.receiveActivity(
        b.alice.id,
        a.alice.actor,
        envelope(a.alice.actor, b.alice.actor, 'Create', note),
      ),
    410,
  );
});
test('structured Undo before Follow permanently withdraws the exact request', async (t) => {
  const { core, alice } = await circle(t);
  const actor = 'https://peer.example/users/friend';
  const follow = envelope(actor, alice.actor, 'Follow', alice.actor);
  core.receiveActivity(alice.id, actor, envelope(actor, alice.actor, 'Undo', follow));
  denied(() => core.receiveActivity(alice.id, actor, follow), 410);
  assert.equal(core.pendingFriends(alice.id).length, 0);
});
test('duplicate Like identities cannot fan out conflicting ids', async (t) => {
  const a = await circle(t, 'https://a.example'),
    b = await circle(t, 'https://b.example');
  await remoteFriends(a, b, b.alice);
  const p = a.core.publish(a.alice.id, { body: 'Like target', audience: 'friends' });
  const like = envelope(b.alice.actor, a.alice.actor, 'Like', a.core.objectUrl(p.id));
  a.core.receiveActivity(a.alice.id, b.alice.actor, like);
  const count = a.core.pendingEvents().length;
  denied(
    () =>
      a.core.receiveActivity(
        a.alice.id,
        b.alice.actor,
        envelope(b.alice.actor, a.alice.actor, 'Like', a.core.objectUrl(p.id)),
      ),
    409,
  );
  assert.equal(a.core.pendingEvents().length, count);
  a.core.receiveActivity(
    a.alice.id,
    b.alice.actor,
    envelope(b.alice.actor, a.alice.actor, 'Undo', like),
  );
  assert.equal(a.core.post(p.id, a.alice.id).likes, 0);
});
test('unsolicited Follow limits bound each origin without consuming outbound friendship capacity', async (t) => {
  const { core, alice, store } = await circle(t);
  for (let i = 0; i < 20; i++) {
    const actor = `https://hostile.example/users/p${i}`;
    core.receiveActivity(alice.id, actor, envelope(actor, alice.actor, 'Follow', alice.actor));
  }
  const actor = 'https://hostile.example/users/overflow';
  denied(
    () =>
      core.receiveActivity(alice.id, actor, envelope(actor, alice.actor, 'Follow', alice.actor)),
    429,
  );
  // A full pending inbox from distinct origins must not consume outbound capacity.
  const insert = store.db.prepare(
    "INSERT INTO friendships(id,from_actor,to_actor,state,expires_at,created_at,updated_at) VALUES(?,?,?,'pending',?,?,?)",
  );
  for (let i = 20; i < 500; i++)
    insert.run(
      `pending-${i}`,
      `https://host${i}.example/users/person`,
      alice.actor,
      Date.parse('2026-10-09'),
      1,
      1,
    );
  assert.ok(core.requestFriend(alice.id, 'https://trusted.example/users/person'));
});
test('historical archive dates remain accepted but non-string dates are rejected', async (t) => {
  const a = await circle(t, 'https://a.example'),
    b = await circle(t, 'https://b.example');
  await remoteFriends(a, b, b.alice);
  const p = a.core.publish(a.alice.id, { body: 'Old archive', audience: 'friends' }),
    note = a.core.federationObject(a.core.objectUrl(p.id), b.alice.actor)!;
  denied(
    () =>
      b.core.receiveActivity(
        b.alice.id,
        a.alice.actor,
        envelope(a.alice.actor, b.alice.actor, 'Create', { ...note, published: 2000 }),
      ),
    400,
  );
  b.core.receiveActivity(
    b.alice.id,
    a.alice.actor,
    envelope(a.alice.actor, b.alice.actor, 'Create', {
      ...note,
      published: '1900-01-01T00:00:00Z',
    }),
  );
  assert.equal(b.core.post(a.core.objectUrl(p.id), b.alice.id).body, 'Old archive');
});

test('revoked commenter can delete without a separate audience-grant action', async (t) => {
  const { core, alice, register } = await circle(t);
  const bob = await register('bob');
  friend(core, alice, bob);
  const post = core.publish(alice.id, { body: 'Shared', audience: 'friends' });
  const comment = core.comment(bob.id, post.id, 'My words');
  core.unfriend(alice.id, bob.actor);
  assert.equal(core.canRead(post.id, bob.id), false);
  core.deleteComment(bob.id, comment.id);
  assert.equal(core.post(post.id, alice.id).comments.length, 0);
});

test('revocation scrubs a pending Create even when no edit has occurred', async (t) => {
  const a = await circle(t, 'https://a.example');
  const b = await circle(t, 'https://b.example');
  await remoteFriends(a, b, b.alice);
  const post = a.core.publish(a.alice.id, { body: 'Private payload', audience: 'friends' });
  const event = a.core.pendingEvents().find((e) => e.kind === 'post.create')!;
  a.core.revokeRecipients(a.alice.id, post.id, [b.alice.actor]);
  const row = a.store.db
    .prepare('SELECT payload,cancelled_at FROM domain_events WHERE id=?')
    .get(event.id) as any;
  assert.equal(row.payload, '{}');
  assert.ok(row.cancelled_at);
});

test('full unsolicited inbox leaves owner outbound capacity but acceptance retains the friend cap', async (t) => {
  const { core, store, alice } = await circle(t);
  const insert = store.db.prepare(
    "INSERT INTO friendships(id,from_actor,to_actor,state,expires_at,created_at,updated_at) VALUES(?,?,?,'pending',?,?,?)",
  );
  for (let i = 0; i < 500; i++)
    insert.run(
      `pending-${i}`,
      `https://host${i}.example/users/person`,
      alice.actor,
      Date.parse('2026-10-09'),
      1,
      1,
    );
  assert.ok(core.requestFriend(alice.id, 'https://trusted.example/users/person'));
  store.db
    .prepare(
      "UPDATE friendships SET state='accepted' WHERE id LIKE 'pending-%' AND id<>'pending-0'",
    )
    .run();
  denied(() => core.acceptFriend(alice.id, 'pending-0'), 429);
});

test('signed federation retracts a locally owned reply after last-recipient Remove without restoring private content', async (t) => {
  const a = await circle(t, 'https://alpha.example');
  const b = await circle(t, 'https://beta.example');
  const c = await circle(t, 'https://gamma.example');
  const peers = new Map<string, Federation>();
  const network: FederationNetwork = async (request) => {
    const peer = peers.get(new URL(request.url).origin);
    assert.ok(peer, 'only synthetic registered peers may be contacted');
    const response = await peer.handle(request);
    assert.ok(response);
    return {
      status: response.status,
      headers: response.headers,
      body: new Uint8Array(await response.arrayBuffer()),
    };
  };
  for (const circle of [a, b, c]) {
    const core = circle.core;
    const adapter: FederationAdapter = {
      localActor: (name) => core.localActor(name),
      pendingEvents: (limit, cursor) => core.pendingEvents(limit, cursor),
      outboundEvent: (id) => core.outboundEvent(id),
      ackEvent: (id) => core.ackEvent(id),
      receiveActivity: (recipient, actor, activity) =>
        core.receiveActivity(recipient, actor, activity),
      federationObject: (url, actor) => core.federationObject(url, actor),
      federationMedia: () => null,
      sharingAllowed: () => true,
    };
    peers.set(
      core.origin,
      new Federation(circle.store, adapter, { origin: core.origin, enabled: true, network }),
    );
  }
  const fa = peers.get(a.core.origin)!,
    fb = peers.get(b.core.origin)!;
  for (const target of [b, c]) {
    a.core.requestFriend(a.alice.id, target.alice.actor);
    await fa.flush();
    const incoming = target.core
      .pendingFriends(target.alice.id)
      .find((row) => row.direction === 'incoming')!;
    target.core.acceptFriend(target.alice.id, incoming.id);
    await peers.get(target.core.origin)!.flush();
  }
  const post = a.core.publish(a.alice.id, { body: 'Private parent', audience: 'friends' });
  await fa.flush();
  const url = a.core.objectUrl(post.id);
  const comment = b.core.comment(b.alice.id, url, 'Owned reply');
  await fb.flush();
  await fa.flush();
  a.core.comment(a.alice.id, post.id, 'Foreign reply');
  await fa.flush();
  assert.equal(c.core.post(url, c.alice.id).comments.length, 2);
  a.core.revokeRecipients(a.alice.id, post.id, [b.alice.actor]);
  await fa.flush();
  denied(() => b.core.post(url, b.alice.id));
  assert.equal((await fb.signedFetch('alice', url)).status, 404);
  assert.deepEqual(b.core.ownComments(b.alice.id), [
    { id: comment.id, postId: url, body: '', createdAt: comment.createdAt, postAvailable: false },
  ]);
  assert.equal(
    (b.store.db.prepare('SELECT count(*) n FROM comments WHERE post_id=?').get(url) as any).n,
    1,
  );
  const remoteCommentId = `${b.core.origin}/federation/comments/${comment.id}`;
  const forged = envelope(c.alice.actor, a.alice.actor, 'Delete', remoteCommentId, {
    'cb:inReplyTo': url,
    'cb:interactionActor': b.alice.actor,
  });
  // Verified third-party authors cannot use the withdrawal path to delete this reply.
  denied(() => a.core.receiveActivity(a.alice.id, c.alice.actor, forged), 403);
  denied(() => b.core.comment(b.alice.id, url, 'Cannot add content'));
  // Explicit new-recipient publication refresh must not resurrect scrubbed conversations.
  const newcomer = await b.register('newcomer');
  await remoteFriends(a, b, newcomer);
  a.core.grantRecipients(a.alice.id, post.id, [newcomer.actor]);
  await fa.flush();
  assert.equal(b.core.post(url, newcomer.id).comments.length, 0);
  assert.equal(b.core.ownComments(b.alice.id)[0]!.body, '');
  denied(() => b.core.post(url, b.alice.id));
  b.core.deleteComment(b.alice.id, comment.id);
  assert.equal((await fb.flush()).delivered, 1);
  await fa.flush();
  assert.deepEqual(
    a.core.post(post.id, a.alice.id).comments.map((row) => row.body),
    ['Foreign reply'],
  );
  assert.deepEqual(
    c.core.post(url, c.alice.id).comments.map((row) => row.body),
    ['Foreign reply'],
  );
  assert.deepEqual(b.core.ownComments(b.alice.id), []);
  denied(() => b.core.post(url, b.alice.id));
});

test('own replies paginate by timestamp and identity and never list another account replies', async (t) => {
  const { core, alice, register } = await circle(t);
  const bob = await register('bob');
  friend(core, alice, bob);
  const post = core.publish(alice.id, { body: 'Parent', audience: 'friends' });
  const one = core.comment(bob.id, post.id, 'One');
  const two = core.comment(bob.id, post.id, 'Two');
  core.comment(alice.id, post.id, 'Not Bob');
  const first = core.ownComments(bob.id, { limit: 1 });
  const second = core.ownComments(bob.id, {
    limit: 1,
    before: first[0]!.createdAt,
    beforeId: first[0]!.id,
  });
  assert.deepEqual(new Set([...first, ...second].map((row) => row.id)), new Set([one.id, two.id]));
  core.revokeRecipients(alice.id, post.id, [bob.actor]);
  assert.ok(core.ownComments(bob.id).every((row) => !row.postAvailable));
});
