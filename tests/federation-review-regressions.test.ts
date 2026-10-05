import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage.js';
import {
  Federation,
  CONTEXT,
  PROFILE,
  safeFederationNetwork,
  type FederationAdapter,
  type DomainEvent,
} from '../src/federation.js';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'federation-review-'));
  const stores = [new Store(join(dir, 'a')), new Store(join(dir, 'b'))];
  let sharing = true,
    suspended = false,
    received = 0,
    networkCalls = 0;
  let lastActivity: Record<string, unknown> | undefined;
  let duringDiscovery: (() => void) | undefined;
  const events: DomainEvent[] = [];
  const actors = ['https://alpha.example/users/alice', 'https://beta.example/users/bobby'];
  const adapters = actors.map((id, i): FederationAdapter => ({
    localActor: (username) =>
      username === (i ? 'bobby' : 'alice')
        ? {
            id,
            username,
            userId: String(i),
            displayName: 'Example',
            discoverable: true,
            suspended: i === 1 && suspended,
          }
        : null,
    sharingAllowed: () => i === 0 || sharing,
    pendingEvents: () => (i === 0 ? events : []),
    outboundEvent: (id) => events.find((e) => e.id === id) ?? null,
    ackEvent: (id) => {
      const index = events.findIndex((e) => e.id === id);
      if (index >= 0) events.splice(index, 1);
    },
    receiveActivity: (_recipient, _actor, activity) => {
      received++;
      lastActivity = activity;
    },
    federationObject: () => null,
    federationMedia: () => null,
  }));
  const federations: Federation[] = [];
  for (let i = 0; i < 2; i++)
    federations.push(
      new Federation(stores[i]!, adapters[i]!, {
        origin: new URL(actors[i]!).origin,
        enabled: true,
        network: async (req) => {
          networkCalls++;
          const destination = req.url.startsWith('https://alpha.example') ? 0 : 1;
          const response = await federations[destination]!.handle(req);
          if (i === 1 && destination === 0) duringDiscovery?.();
          assert.ok(response);
          return {
            status: response.status,
            headers: response.headers,
            body: new Uint8Array(await response.arrayBuffer()),
          };
        },
      }),
    );
  const activity = {
    '@context': CONTEXT,
    'cb:profile': PROFILE,
    'cb:revision': 1,
    id: 'https://alpha.example/federation/activities/one',
    type: 'Follow',
    actor: actors[0],
    to: [actors[1]],
    object: actors[1],
  };
  const signed = () =>
    federations[0]!.sign(
      'alice',
      new Request(`${actors[1]}/inbox`, {
        method: 'POST',
        headers: { 'content-type': 'application/activity+json' },
        body: JSON.stringify(activity),
      }),
    );
  return {
    stores,
    federations,
    actors,
    activity,
    signed,
    events,
    get networkCalls() {
      return networkCalls;
    },
    get lastActivity() {
      return lastActivity;
    },
    get received() {
      return received;
    },
    setHook(fn: () => void) {
      duringDiscovery = fn;
    },
    suspend() {
      suspended = true;
    },
    disable() {
      sharing = false;
    },
    async close() {
      stores.forEach((s) => s.close());
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('same-actor signed body tampering fails before receipt and original bytes still succeed', async () => {
  const h = await fixture();
  try {
    const signed = await h.signed();
    const changed = { ...h.activity, 'cb:revision': 2 };
    const bad = new Request(signed.url, {
      method: 'POST',
      headers: signed.headers,
      body: JSON.stringify(changed),
    });
    assert.equal((await h.federations[1]!.handle(bad))!.status, 403);
    assert.equal(h.received, 0);
    assert.equal((await h.federations[1]!.handle(signed))!.status, 202);
    assert.equal(h.received, 1);
  } finally {
    await h.close();
  }
});

for (const change of ['suspend', 'disable'] as const)
  test(`inbox rechecks ${change} after actor discovery`, async () => {
    const h = await fixture();
    try {
      const signed = await h.signed();
      h.setHook(() => h[change]());
      assert.equal((await h.federations[1]!.handle(signed))!.status, 403);
      assert.equal(h.received, 0);
      assert.equal(
        (
          h.stores[1]!.db.prepare('SELECT count(*) AS n FROM federation_received').get() as {
            n: number;
          }
        ).n,
        0,
      );
    } finally {
      await h.close();
    }
  });

test('forged signature does not debit claimed actor bucket; blocked host rejected before body read', async () => {
  const h = await fixture();
  try {
    const signed = await h.signed();
    const headers = new Headers(signed.headers);
    headers.set('signature', `sig1=:${Buffer.alloc(256).toString('base64')}:`);
    const forged = new Request(signed.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(h.activity),
    });
    assert.equal((await h.federations[1]!.handle(forged))!.status, 403);
    assert.equal(
      (
        h.stores[1]!.db.prepare(
          "SELECT count(*) AS n FROM federation_rate WHERE subject LIKE 'key:%'",
        ).get() as { n: number }
      ).n,
      0,
    );
    assert.equal((await h.federations[1]!.handle(signed))!.status, 202);
    h.federations[1]!.setBlockedHost('alpha.example');
    let pulls = 0;
    const stream = new ReadableStream(
      {
        pull(controller) {
          pulls++;
          controller.error(Error('Must not read'));
        },
      },
      { highWaterMark: 0 },
    );
    const blocked = new Request(signed.url, {
      method: 'POST',
      headers: signed.headers,
      body: stream,
      duplex: 'half',
    } as RequestInit);
    assert.equal((await h.federations[1]!.handle(blocked))!.status, 403);
    assert.equal(pulls, 0);
  } finally {
    await h.close();
  }
});

test('mixed-case handle host is normalized for WebFinger and origin comparison', async () => {
  const h = await fixture();
  try {
    assert.equal(
      (await h.federations[0]!.discover('@bobby@Beta.Example', 'alice')).id,
      h.actors[1],
    );
  } finally {
    await h.close();
  }
});

test('production connector explicitly enforces TLS and offers all vetted families without re-resolution', async (t) => {
  const answers = [
    { address: '2606:4700:4700::1111', family: 6 },
    { address: '1.1.1.1', family: 4 },
  ];
  let resolutions = 0;
  t.mock.method(dns, 'lookup', async () => {
    resolutions++;
    return answers;
  });
  t.mock.method(https, 'request', (_url: URL, options: any) => {
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.minVersion, 'TLSv1.2');
    assert.equal(options.servername, 'alpha.example');
    assert.equal(options.autoSelectFamily, true);
    options.lookup('alpha.example', { all: true }, (err: unknown, result: unknown) => {
      assert.equal(err, null);
      assert.deepEqual(result, answers);
    });
    const req = new EventEmitter() as EventEmitter & { end(): void; destroy(error: Error): void };
    req.destroy = (error) => {
      req.emit('error', error);
      req.emit('close');
    };
    req.end = () => queueMicrotask(() => req.destroy(Error('Probe finished')));
    return req;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      safeFederationNetwork(new Request('https://alpha.example/')),
      /Probe finished/,
    );
    assert.equal(resolutions, 1);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('attachment identifiers are encoded and invalid local envelopes never fetch peers', async () => {
  const h = await fixture();
  try {
    const event: DomainEvent = {
      id: 'post-event',
      kind: 'post.create',
      actor: h.actors[0]!,
      recipientActor: h.actors[1]!,
      objectId: 'post',
      revision: 1,
      createdAt: Date.now(),
      payload: {
        id: 'post',
        body: 'A photo',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        mediaIds: ['photo with space/part'],
      },
    };
    h.events.push(event);
    assert.equal((await h.federations[0]!.flush()).delivered, 1);
    const object = h.lastActivity!.object as { attachment: { url: string }[] };
    assert.equal(
      object.attachment[0]!.url,
      'https://alpha.example/federation/media/photo%20with%20space%2Fpart',
    );
    h.events.push({ ...event, id: 'invalid-event', kind: 'unsupported' });
    const calls = h.networkCalls;
    assert.equal((await h.federations[0]!.flush()).pending, 1);
    assert.equal(h.networkCalls, calls);
  } finally {
    await h.close();
  }
});
