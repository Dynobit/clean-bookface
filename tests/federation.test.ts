import test from 'node:test';
import dns from 'node:dns/promises';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request as httpsRequest, type Server } from 'node:https';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/storage.js';
import { Core } from '../src/core.js';
import {
  Federation,
  CONTEXT,
  PROFILE,
  validateRemoteURL,
  publicAddress,
  safeFederationNetwork,
  type FederationAdapter,
} from '../src/federation.js';
import type { FederationNetwork } from '../src/federation/network.js';
import { randomUUID } from 'node:crypto';
import { signRequest } from '@fedify/fedify/sig';
import { Temporal } from 'temporal-polyfill';

const password = 'fictional-test-passphrase-only';
const A = 'https://alpha.example',
  B = 'https://beta.example';
const note = (id: string, actor: string, recipient: string, text: string, revision = 1) => ({
  '@context': CONTEXT,
  'cb:profile': PROFILE,
  'cb:revision': revision,
  id: `${new URL(actor).origin}/federation/activities/${randomUUID()}`,
  type: 'Create',
  actor,
  to: [recipient],
  object: {
    id,
    type: 'Note',
    attributedTo: actor,
    to: [recipient],
    mediaType: 'text/plain',
    content: text,
    'cb:revision': revision,
    published: new Date().toISOString(),
    updated: new Date().toISOString(),
    attachment: [],
  },
});

test('production URL policy rejects private, mapped, metadata, credentials and ambiguous destinations', () => {
  for (const url of [
    'http://alpha.example',
    'https://localhost',
    'https://foo.local',
    'https://127.0.0.1',
    'https://2130706433',
    'https://0x7f000001',
    'https://169.254.169.254/latest',
    'https://100.64.0.1',
    'https://192.168.0.1',
    'https://10.0.0.1',
    'https://[::1]',
    'https://[::ffff:127.0.0.1]',
    'https://user:pass@alpha.example',
    'https://alpha.example:444',
    'https://alpha.example./',
    'https://alpha.example/#key',
  ])
    assert.throws(() => validateRemoteURL(url), url);
  for (const ip of [
    '127.0.0.1',
    '10.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
    '169.254.1.1',
    '100.64.0.1',
    'fc00::1',
    '2001:db8::1',
  ])
    assert.equal(publicAddress(ip), false, ip);
  assert.equal(validateRemoteURL('https://alpha.example/users/alice').hostname, 'alpha.example');
  assert.equal(publicAddress('8.8.8.8'), true);
});

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'bookface-federation-test-'));
  // Fresh synthetic TLS credentials live only in the temporary test directory.
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
      '-subj',
      '/CN=alpha.example',
      '-addext',
      'subjectAltName=DNS:alpha.example,DNS:beta.example',
    ],
    { stdio: 'ignore' },
  );
  const key = await readFile(join(dir, 'key.pem'));
  const cert = await readFile(join(dir, 'cert.pem'));
  const servers: Server[] = [];
  const ports = new Map<string, number>();
  const captures: { url: string; body: Record<string, unknown>; status: number }[] = [];
  let offline = false;
  let lostAck = false;
  let forgedOwner = false;
  let afterNetwork: ((request: Request) => void) | undefined;
  // Actual independent TLS servers and HTTP requests. Only this test's explicit
  // transport maps reserved synthetic hosts to loopback; production has no flag.
  const network: FederationNetwork = async (req, maxBytes = 262144) => {
    const u = new URL(req.url);
    const port = ports.get(u.origin);
    if (!port) throw Error('Unregistered test host');
    if (offline && u.origin === B) throw Error('Synthetic offline peer');
    const bytes = req.body ? Buffer.from(await req.arrayBuffer()) : undefined;
    const result = await new Promise<Awaited<ReturnType<FederationNetwork>>>((resolve, reject) => {
      const call = httpsRequest(
        {
          hostname: '127.0.0.1',
          port,
          servername: u.hostname,
          ca: cert,
          path: u.pathname + u.search,
          method: req.method,
          headers: { ...Object.fromEntries(req.headers), host: u.host },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let count = 0;
          res.on('data', (b: Buffer) => {
            count += b.length;
            if (count > maxBytes) {
              res.destroy();
              reject(Error('Too large'));
            } else chunks.push(b);
          });
          res.on('end', () =>
            resolve({
              status: res.statusCode!,
              headers: new Headers(
                Object.entries(res.headers)
                  .filter(([, v]) => v !== undefined)
                  .map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v)]),
              ),
              body: Buffer.concat(chunks),
            }),
          );
          res.on('error', reject);
        },
      );
      call.on('error', reject);
      call.end(bytes);
    });
    if (forgedOwner && req.url === `${A}/users/alice`) {
      const actor = JSON.parse(Buffer.from(result.body).toString());
      actor.publicKey.owner = `${B}/users/bob`;
      result.body = Buffer.from(JSON.stringify(actor));
    }
    if (bytes) {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(bytes.toString());
      } catch {
        body = { invalid: true };
      }
      captures.push({ url: req.url, body, status: result.status });
    }
    afterNetwork?.(req);
    if (lostAck && req.method === 'POST' && u.origin === B) {
      lostAck = false;
      throw Error('Synthetic lost acknowledgement');
    }
    return result;
  };
  const stores = [new Store(join(dir, 'a')), new Store(join(dir, 'b'))];
  const cores = stores.map(
    (store, i) => new Core(store, { origin: i === 0 ? A : B, validateMedia: () => {} }),
  );
  const mediaPath = join(stores[0]!.dataDir, 'shared.webp');
  await writeFile(mediaPath, Buffer.from('synthetic-shared-derivative'));
  function adapter(i: number): FederationAdapter {
    const core = cores[i]!;
    return {
      localActor: (name) => core.localActor(name),
      pendingEvents: (limit, cursor) => core.pendingEvents(limit, cursor),
      outboundEvent: (id) => core.outboundEvent(id),
      ackEvent: (id) => core.ackEvent(id),
      receiveActivity: (id, actor, event) => core.receiveActivity(id, actor, event),
      federationObject: (url, actor) => core.federationObject(url, actor),
      federationMedia: (id, actor) => {
        const p = stores[i]!.db.prepare(
          'SELECT id,media_ids FROM publications WHERE author_id IS NOT NULL AND deleted_at IS NULL',
        ).all() as { id: string; media_ids: string }[];
        return p.some((p) => JSON.parse(p.media_ids).includes(id) && core.canActorRead(p.id, actor))
          ? { path: mediaPath, mime: 'image/webp' }
          : null;
      },
      sharingAllowed: () => stores[i]!.setting('sharing_disabled') !== '1',
    };
  }
  const federations = [
    new Federation(stores[0]!, adapter(0), { origin: A, enabled: true, network }),
    new Federation(stores[1]!, adapter(1), { origin: B, enabled: true, network }),
  ];
  for (let i = 0; i < 2; i++) {
    const server = createServer({ key, cert }, async (req, res) => {
      try {
        const buffers: Buffer[] = [];
        for await (const b of req) buffers.push(Buffer.from(b));
        const request = new Request(`${i === 0 ? A : B}${req.url}`, {
          method: req.method,
          headers: new Headers(
            Object.entries(req.headers)
              .filter(([, v]) => v !== undefined)
              .map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v)]),
          ),
          ...(['GET', 'HEAD'].includes(req.method ?? 'GET')
            ? {}
            : { body: Buffer.concat(buffers) }),
        });
        const result =
          (await federations[i]!.handle(request)) ?? new Response('Not found', { status: 404 });
        res.writeHead(result.status, Object.fromEntries(result.headers));
        res.end(Buffer.from(await result.arrayBuffer()));
      } catch {
        res.writeHead(500);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    ports.set(i === 0 ? A : B, (server.address() as AddressInfo).port);
  }
  const alice = (
    await cores[0]!.setup({ username: 'alice', displayName: 'Alice Example', password })
  ).user;
  const bob = (await cores[1]!.setup({ username: 'bob', displayName: 'Bob Example', password }))
    .user;
  const charlie = (
    await cores[1]!.register({
      username: 'charlie',
      displayName: 'Charlie Example',
      password,
      inviteToken: cores[1]!.createInvite(bob.id, 'registration').token,
    })
  ).user;
  return {
    dir,
    stores,
    cores,
    federations,
    alice,
    bob,
    charlie,
    captures,
    network,
    setOffline(v: boolean) {
      offline = v;
    },
    loseAck() {
      lostAck = true;
    },
    forgeOwner(v: boolean) {
      forgedOwner = v;
    },
    afterNetwork(fn: ((request: Request) => void) | undefined) {
      afterNetwork = fn;
    },
    retry(i: number) {
      stores[i]!.db.exec('UPDATE federation_deliveries SET next_attempt=0,lease_until=0');
    },
    restart(i: number) {
      federations[i] = new Federation(stores[i]!, adapter(i), {
        origin: i === 0 ? A : B,
        enabled: true,
        network,
      });
    },
    restartProcess(i: number) {
      const dataDir = stores[i]!.dataDir;
      stores[i]!.close();
      stores[i] = new Store(dataDir);
      cores[i] = new Core(stores[i]!, { origin: i === 0 ? A : B, validateMedia: () => {} });
      federations[i] = new Federation(stores[i]!, adapter(i), {
        origin: i === 0 ? A : B,
        enabled: true,
        network,
      });
    },
    async close() {
      for (const server of servers)
        await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const store of stores) store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function befriend(h: Awaited<ReturnType<typeof harness>>, person: 'bob' | 'charlie' = 'bob') {
  const request = h.cores[0]!.requestFriend(h.alice.id, h[person].actor);
  const outbound = await h.federations[0]!.flush();
  assert.equal(outbound.delivered, 1, JSON.stringify(h.captures.at(-1)) ?? 'No captured delivery');
  const pending = h.cores[1]!.pendingFriends(h[person].id).find((f) => f.actor === h.alice.actor)!;
  assert.ok(pending);
  h.cores[1]!.acceptFriend(h[person].id, pending.id);
  assert.equal(
    (await h.federations[1]!.flush()).delivered,
    1,
    JSON.stringify(h.captures.at(-1)) ?? 'No captured delivery',
  );
  assert.equal(
    h.cores[0]!.friends(h.alice.id).some((f) => f.actor === h[person].actor),
    true,
  );
  return request;
}

test('stopping delivery drains only the in-flight request and preserves unsent work for restart', async () => {
  const h = await harness();
  try {
    await befriend(h);
    const posts = Array.from({ length: 3 }, (_, i) =>
      h.cores[0]!.publish(h.alice.id, { body: `Shutdown memory ${i}`, audience: 'friends' }),
    );
    const before = h.captures.length;
    h.afterNetwork((req) => {
      if (req.url === h.bob.actor) h.federations[0]!.stop();
    });
    assert.deepEqual(await h.federations[0]!.flush(), { delivered: 0, pending: 3 });
    assert.equal(h.captures.length, before);
    assert.equal(
      h.stores[0]!.db.prepare(
        "SELECT count(*) AS n FROM federation_deliveries WHERE state='pending' AND (lease_until>0 OR attempts>0)",
      ).get()!.n,
      0,
    );
    assert.deepEqual(await h.federations[0]!.flush(), { delivered: 0, pending: 0 });
    h.restart(0);
    h.afterNetwork((req) => {
      if (req.method === 'POST' && req.url === `${h.bob.actor}/inbox`) h.federations[0]!.stop();
    });
    assert.deepEqual(await h.federations[0]!.flush(), { delivered: 1, pending: 2 });
    assert.equal(h.captures.length, before + 1);
    h.afterNetwork(undefined);
    h.restartProcess(0);
    assert.deepEqual(await h.federations[0]!.flush(), { delivered: 2, pending: 0 });
    for (const post of posts)
      assert.equal(h.cores[1]!.canRead(`${A}/federation/objects/${post.id}`, h.bob.id), true);
  } finally {
    await h.close();
  }
});

test('two HTTPS hosts enforce mutual friendship and recipient-bound posts/media, edits, interactions and deletion', async () => {
  const h = await harness();
  try {
    const [a, b] = h.cores;
    const [fa, fb] = h.federations;
    assert.equal(
      (await h.network(new Request(`${A}/.well-known/webfinger?resource=acct:alice@alpha.example`)))
        .status,
      404,
    );
    assert.equal((await fa!.discover(`${B}/users/bob`, 'alice')).id, h.bob.actor);
    assert.equal((await fa!.signedFetch('alice', `${B}/users/bob`)).status, 200);
    await befriend(h);
    const post = a!.publish(h.alice.id, {
      body: 'A quiet Saturday',
      audience: 'selected',
      recipientActors: [h.bob.actor],
      mediaIds: ['synthetic-photo'],
    });
    assert.equal(
      (await fa!.flush()).delivered,
      1,
      JSON.stringify(h.captures.at(-1)) ?? 'No captured delivery',
    );
    const remoteId = `${A}/federation/objects/${post.id}`;
    assert.equal(b!.post(remoteId, h.bob.id).body, 'A quiet Saturday');
    assert.equal(b!.canRead(remoteId, h.charlie.id), false);
    const delivered = h.captures.at(-1)!.body;
    assert.deepEqual(delivered.to, [h.bob.actor]);
    assert.equal(JSON.stringify(delivered).includes('charlie'), false);
    assert.equal((await h.network(new Request(remoteId))).status, 403);
    assert.equal((await fb!.signedFetch('bob', remoteId)).status, 200);
    assert.equal((await fb!.signedFetch('charlie', remoteId)).status, 404);
    assert.equal(
      (await fb!.signedFetch('bob', `${A}/federation/media/synthetic-photo`)).status,
      200,
    );
    assert.equal(
      (await fb!.signedFetch('charlie', `${A}/federation/media/synthetic-photo`)).status,
      404,
    );
    await befriend(h, 'charlie');
    assert.equal((await fb!.signedFetch('charlie', remoteId)).status, 404);
    a!.editPost(h.alice.id, post.id, { body: 'A quiet Sunday' });
    await fa!.flush();
    assert.equal(b!.post(remoteId, h.bob.id).body, 'A quiet Sunday');
    b!.comment(h.bob.id, remoteId, 'See you there.');
    await fb!.flush();
    assert.equal(a!.post(post.id, h.alice.id).comments.length, 1);
    b!.like(h.bob.id, remoteId);
    await fb!.flush();
    assert.equal(a!.post(post.id, h.alice.id).likes, 1);
    b!.like(h.bob.id, remoteId, false);
    await fb!.flush();
    assert.equal(a!.post(post.id, h.alice.id).likes, 0);
    a!.deletePost(h.alice.id, post.id);
    await fa!.flush();
    assert.equal(b!.canRead(remoteId, h.bob.id), false);
    assert.equal((await fb!.signedFetch('bob', remoteId)).status, 404);
  } finally {
    await h.close();
  }
});

test('replaying a still-valid signed GET after revocation cannot fetch the object or media', async () => {
  const h = await harness();
  try {
    await befriend(h);
    const post = h.cores[0]!.publish(h.alice.id, {
      body: 'A revocable memory',
      audience: 'selected',
      recipientActors: [h.bob.actor],
      mediaIds: ['synthetic-photo'],
    });
    const requests = await Promise.all(
      [`${A}/federation/objects/${post.id}`, `${A}/federation/media/synthetic-photo`].map((url) =>
        h.federations[1]!.sign('bob', new Request(url)),
      ),
    );
    for (const request of requests) assert.equal((await h.network(request.clone())).status, 200);
    h.cores[0]!.revokeRecipients(h.alice.id, post.id, [h.bob.actor]);
    // Replay identical signature bytes, before their timestamp expires.
    for (const request of requests) assert.equal((await h.network(request.clone())).status, 404);
  } finally {
    await h.close();
  }
});

test('offline delivery, lost acknowledgement, restart and stale replay cannot duplicate or resurrect content', async () => {
  const h = await harness();
  try {
    await befriend(h);
    const [a, b] = h.cores;
    const post = a!.publish(h.alice.id, { body: 'Before the edit', audience: 'friends' });
    h.setOffline(true);
    assert.equal((await h.federations[0]!.flush()).pending, 1);
    a!.editPost(h.alice.id, post.id, { body: 'Latest revision' });
    h.restart(0);
    h.setOffline(false);
    h.retry(0);
    h.loseAck();
    await h.federations[0]!.flush();
    h.retry(0);
    await h.federations[0]!.flush();
    const id = `${A}/federation/objects/${post.id}`;
    assert.equal(b!.post(id, h.bob.id).body, 'Latest revision');
    assert.equal(b!.feed(h.bob.id).filter((p) => p.id === id).length, 1);
    const stale = note(id, h.alice.actor, h.bob.actor, 'Stale create', 1);
    a!.revokeRecipients(h.alice.id, post.id, [h.bob.actor]);
    h.setOffline(true);
    await h.federations[0]!.flush();
    assert.ok([403, 404].includes((await h.federations[1]!.signedFetch('bob', id)).status));
    h.setOffline(false);
    h.restart(0);
    h.retry(0);
    await h.federations[0]!.flush();
    assert.equal(b!.canRead(id, h.bob.id), false);
    const replay = await h.federations[0]!.sign(
      'alice',
      new Request(`${h.bob.actor}/inbox`, {
        method: 'POST',
        headers: { 'content-type': 'application/activity+json' },
        body: JSON.stringify(stale),
      }),
    );
    await h.network(replay);
    assert.equal(b!.canRead(id, h.bob.id), false);
    // Simulated process death after lease acquisition recovers only after expiry.
    const p2 = a!.publish(h.alice.id, { body: 'Lease test', audience: 'friends' });
    h.setOffline(true);
    await h.federations[0]!.flush();
    h.stores[0]!.db.exec(
      "UPDATE federation_deliveries SET lease_until=9999999999999,next_attempt=0 WHERE state='pending'",
    );
    h.setOffline(false);
    h.restart(0);
    assert.equal((await h.federations[0]!.flush()).delivered, 0);
    h.retry(0);
    assert.equal((await h.federations[0]!.flush()).delivered, 1);
    assert.equal(b!.canRead(`${A}/federation/objects/${p2.id}`, h.bob.id), true);
  } finally {
    await h.close();
  }
});

test('forged signatures, wrong actors, changed audiences, oversized bodies and restore gate fail closed', async () => {
  const h = await harness();
  try {
    await befriend(h);
    const post = h.cores[0]!.publish(h.alice.id, { body: 'Only Bob', audience: 'friends' });
    await h.federations[0]!.flush();
    const id = `${A}/federation/objects/${post.id}`;
    const target = `${h.bob.actor}/inbox`;
    const good = note(
      `${A}/federation/objects/${randomUUID()}`,
      h.alice.actor,
      h.bob.actor,
      'Allowed',
    );
    const signed = await h.federations[0]!.sign(
      'alice',
      new Request(target, {
        method: 'POST',
        headers: { 'content-type': 'application/activity+json' },
        body: JSON.stringify(good),
      }),
    );
    const bad = new Request(signed, { body: JSON.stringify({ ...good, actor: h.charlie.actor }) });
    assert.equal((await h.network(bad)).status, 403);
    const wrongActor = note(
      `${B}/federation/objects/${randomUUID()}`,
      h.charlie.actor,
      h.bob.actor,
      'Forged author',
    );
    assert.equal(
      (
        await h.network(
          await h.federations[0]!.sign(
            'alice',
            new Request(target, {
              method: 'POST',
              headers: { 'content-type': 'application/activity+json' },
              body: JSON.stringify(wrongActor),
            }),
          ),
        )
      ).status,
      403,
    );
    const cc = { ...good, cc: [h.charlie.actor] };
    assert.equal(
      (
        await h.network(
          await h.federations[0]!.sign(
            'alice',
            new Request(target, {
              method: 'POST',
              headers: { 'content-type': 'application/activity+json' },
              body: JSON.stringify(cc),
            }),
          ),
        )
      ).status,
      403,
    );
    const validRequest = () =>
      h.federations[0]!.sign(
        'alice',
        new Request(target, {
          method: 'POST',
          headers: { 'content-type': 'application/activity+json' },
          body: JSON.stringify(good),
        }),
      );
    h.forgeOwner(true);
    assert.equal((await h.network(await validRequest())).status, 403);
    h.forgeOwner(false);
    assert.equal((await h.network(await validRequest())).status, 202);
    const reused = {
      ...good,
      object: { ...good.object, content: 'An altered body under the same ID' },
    };
    assert.equal(
      (
        await h.network(
          await h.federations[0]!.sign(
            'alice',
            new Request(target, {
              method: 'POST',
              headers: { 'content-type': 'application/activity+json' },
              body: JSON.stringify(reused),
            }),
          ),
        )
      ).status,
      403,
    );
    const syntheticKey = h.stores[0]!.db.prepare(
      'SELECT private_jwk FROM federation_keys WHERE actor=?',
    ).get(h.alice.actor) as { private_jwk: string };
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      JSON.parse(syntheticKey.private_jwk),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      true,
      ['sign'],
    );
    const expired = await signRequest(
      new Request(target, {
        method: 'POST',
        headers: { 'content-type': 'application/activity+json' },
        body: JSON.stringify(good),
      }),
      privateKey,
      new URL(`${h.alice.actor}#main-key`),
      {
        spec: 'rfc9421',
        currentTime: Temporal.Now.instant().subtract({ minutes: 6 }),
        rfc9421: { expires: true },
      },
    );
    assert.equal((await h.network(expired)).status, 403);
    const legacy = await validRequest();
    legacy.headers.delete('signature-input');
    assert.equal((await h.network(legacy)).status, 403);
    const oversized = new Request(target, {
      method: 'POST',
      headers: { 'content-type': 'application/activity+json' },
      body: 'x'.repeat(262145),
    });
    assert.equal((await h.network(oversized)).status, 413);
    h.stores[0]!.setSetting('sharing_disabled', '1');
    assert.equal((await h.federations[1]!.signedFetch('bob', id)).status, 404);
    assert.equal((await h.federations[0]!.flush()).delivered, 0);
  } finally {
    await h.close();
  }
});

test('blocking, account deletion and a complete SQLite reopen preserve revocation and signing identity', async () => {
  const h = await harness();
  try {
    await befriend(h);
    await befriend(h, 'charlie');
    const a = h.cores[0]!;
    const p = a.publish(h.alice.id, { body: 'Shared with two people', audience: 'friends' });
    await h.federations[0]!.flush();
    const id = `${A}/federation/objects/${p.id}`;
    a.revokeRecipients(h.alice.id, p.id, [h.bob.actor]);
    await h.federations[0]!.flush();
    assert.equal(h.cores[1]!.canRead(id, h.bob.id), false);
    assert.equal(h.cores[1]!.canRead(id, h.charlie.id), true);
    h.restartProcess(1);
    assert.equal(h.cores[1]!.canRead(id, h.bob.id), false);
    assert.equal(h.cores[1]!.canRead(id, h.charlie.id), true);
    a.block(h.alice.id, h.bob.actor);
    await h.federations[0]!.flush();
    assert.equal(h.cores[1]!.friends(h.bob.id).length, 0);
    assert.throws(() => a.requestFriend(h.alice.id, h.bob.actor));
    const caretaker = (
      await a.register({
        username: 'caretaker',
        displayName: 'Caretaker Example',
        password,
        inviteToken: a.createInvite(h.alice.id, 'registration').token,
      })
    ).user;
    a.transferAdministration(h.alice.id, caretaker.id);
    a.deleteAccount(h.alice.id);
    h.restartProcess(0);
    const result = await h.federations[0]!.flush();
    assert.ok(result.delivered > 0, JSON.stringify(h.captures.slice(-3)));
    assert.equal(h.cores[1]!.canRead(id, h.charlie.id), false);
    const bootstrap = await h.network(new Request(h.alice.actor));
    assert.equal(bootstrap.status, 200);
    assert.equal(JSON.parse(Buffer.from(bootstrap.body).toString()).name, undefined);
    await assert.rejects(() => h.federations[0]!.signedFetch('alice', h.charlie.actor));
  } finally {
    await h.close();
  }
});

test('production transport rejects mixed DNS answers and pins the checked address before connecting', async (t) => {
  let resolutions = 0;
  let connections = 0;
  let mixed = true;
  let pinned = '';
  t.mock.method(dns, 'lookup', async () => {
    resolutions++;
    return mixed
      ? [
          { address: '8.8.8.8', family: 4 },
          { address: '127.0.0.1', family: 4 },
        ]
      : [{ address: resolutions === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }];
  });
  t.mock.method(https, 'request', (_url: URL, options: any) => {
    connections++;
    options.lookup('alpha.example', {}, (_error: unknown, address: string) => {
      pinned = address;
    });
    const outgoing = new EventEmitter() as EventEmitter & {
      end: () => void;
      destroy: (error: Error) => void;
    };
    outgoing.destroy = (error) => {
      outgoing.emit('error', error);
      outgoing.emit('close');
    };
    outgoing.end = () =>
      queueMicrotask(() => outgoing.destroy(new Error('Connection probe completed')));
    return outgoing;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      () => safeFederationNetwork(new Request(`${A}/users/alice`)),
      /Unsafe DNS answer/,
    );
    assert.equal(connections, 0);
    mixed = false;
    resolutions = 0;
    await assert.rejects(
      () => safeFederationNetwork(new Request(`${A}/users/alice`)),
      /Connection probe completed/,
    );
    assert.equal(resolutions, 1);
    assert.equal(connections, 1);
    assert.equal(pinned, '8.8.8.8');
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('delayed relationship removal and Undo cannot cancel a later accepted friendship', async () => {
  const h = await harness();
  try {
    const oldId = await befriend(h);
    const oldFollow = `${A}/federation/activities/${oldId}`;
    h.cores[0]!.unfriend(h.alice.id, h.bob.actor);
    await h.federations[0]!.flush();
    await befriend(h);
    for (const type of ['Remove', 'Undo']) {
      const activity = {
        '@context': CONTEXT,
        'cb:profile': PROFILE,
        'cb:revision': 1,
        id: `${A}/federation/activities/${randomUUID()}`,
        type,
        actor: h.alice.actor,
        to: [h.bob.actor],
        object: type === 'Remove' ? h.bob.actor : oldFollow,
        'cb:relationship': true,
        'cb:relationshipId': oldFollow,
      };
      const response = await h.network(
        await h.federations[0]!.sign(
          'alice',
          new Request(`${h.bob.actor}/inbox`, {
            method: 'POST',
            headers: { 'content-type': 'application/activity+json' },
            body: JSON.stringify(activity),
          }),
        ),
      );
      assert.equal(response.status, 202);
      assert.equal(
        h.cores[1]!.friends(h.bob.id).some((f) => f.actor === h.alice.actor),
        true,
      );
    }
  } finally {
    await h.close();
  }
});

test('administrator peer blocks persist, deny signed reads and discovery, and preserve pending removal for unblock', async () => {
  const h = await harness();
  try {
    await befriend(h);
    const p = h.cores[0]!.publish(h.alice.id, { body: 'A host policy test', audience: 'friends' });
    const id = `${A}/federation/objects/${p.id}`;
    h.federations[0]!.setBlockedHost('beta.example');
    h.restartProcess(0);
    assert.equal(h.federations[0]!.listBlockedHosts()[0]!.host, 'beta.example');
    assert.equal(h.federations[0]!.isHostBlocked(h.bob.actor), true);
    await assert.rejects(() => h.federations[0]!.discover(h.bob.actor, 'alice'), /blocked/);
    assert.equal((await h.federations[0]!.flush()).pending, 1);
    assert.equal((await h.federations[1]!.signedFetch('bob', id)).status, 403);
    h.federations[0]!.setBlockedHost('beta.example', false);
    h.retry(0);
    assert.equal((await h.federations[0]!.flush()).delivered, 1);
    h.federations[0]!.setBlockedHost('beta.example');
    h.cores[0]!.revokeRecipients(h.alice.id, p.id, [h.bob.actor]);
    assert.equal((await h.federations[0]!.flush()).pending, 1);
    h.federations[0]!.setBlockedHost('beta.example', false);
    h.retry(0);
    assert.equal((await h.federations[0]!.flush()).delivered, 1);
    assert.equal(h.cores[1]!.canRead(id, h.bob.id), false);
    for (const host of [
      'alpha.example',
      'beta.example/path',
      'beta.example:444',
      '127.0.0.1',
      'user@beta.example',
    ])
      assert.throws(() => h.federations[0]!.setBlockedHost(host));
    const schema = h.stores[0]!.db.prepare(
      "SELECT version FROM schema_versions WHERE component='federation'",
    ).get() as { version: number };
    assert.equal(schema.version, 1);
    h.stores[0]!.db.prepare(
      "UPDATE schema_versions SET version=2 WHERE component='federation'",
    ).run();
    assert.throws(() => h.restart(0), /newer/);
  } finally {
    await h.close();
  }
});
