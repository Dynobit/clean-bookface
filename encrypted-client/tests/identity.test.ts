import test from 'node:test';
import assert from 'node:assert/strict';
import { createArchiveClient, validateOrigin } from '../src/identity';
import { createClient, MatrixError } from 'matrix-js-sdk';

test('archive clients disable SDK call handlers and TURN requests in a calling-capable browser', async () => {
  const before = ['window', 'document'].map((key) =>
    Object.getOwnPropertyDescriptor(globalThis, key),
  );
  try {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { RTCPeerConnection: class {} },
    });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: {} });
    const ordinary = createClient({ baseUrl: 'https://matrix.example' });
    assert.equal(ordinary.supportsVoip(), true);
    let requests = 0;
    const client = createArchiveClient({
      baseUrl: 'https://matrix.example',
      disableVoip: false,
      fetchFn: async () => {
        requests++;
        throw new Error('Unexpected calling request');
      },
    });
    assert.equal(client.supportsVoip(), false);
    assert.equal(client.callEventHandler, undefined);
    assert.equal(client.groupCallEventHandler, undefined);
    await client.checkTurnServers();
    assert.equal(requests, 0);
  } finally {
    ['window', 'document'].forEach((key, i) => {
      if (before[i]) Object.defineProperty(globalThis, key, before[i]!);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
});
test('server origins enforce TLS and prevent URL credentials and routing injection', () => {
  assert.equal(validateOrigin('https://alice:secret@matrix.example/'), 'https://matrix.example');
  for (const origin of [
    'http://matrix.example',
    'https://matrix.example/path',
    'https://matrix.example/?token=secret',
    'https://matrix.example/#code',
    'javascript:alert(1)',
    'http://localhost.evil.example',
    'http://192.0.2.1',
  ])
    assert.throws(() => validateOrigin(origin));
  for (const origin of ['http://localhost:18008', 'http://127.0.0.1:18008', 'http://[::1]:18008'])
    assert.equal(validateOrigin(origin), origin);
});

test('legacy SDK logging and child logging emit no content', async () => {
  const { logger } = await import('matrix-js-sdk/lib/logger');
  const calls: unknown[][] = [];
  const methods = ['trace', 'debug', 'info', 'warn', 'error', 'log'] as const;
  const originals = methods.map((method) => console[method]);
  try {
    for (const method of methods)
      console[method] = (...args: unknown[]) => {
        calls.push(args);
      };
    for (const method of methods) logger[method]('fictional private-content marker');
    const child = logger.getChild('test');
    child.debug('fictional private-content marker');
    child.error('fictional private-content marker');
  } finally {
    methods.forEach((method, index) => {
      console[method] = originals[index];
    });
  }
  assert.deepEqual(calls, []);
});

import { createHmac, generateKeyPairSync } from 'node:crypto';
import { backupKeyCoversLocal } from '../src/identity';
import type { IMegolmSessionData } from 'matrix-js-sdk/lib/@types/crypto';

// Synthetic export fixture: v1, uint32 BE index, 128 ratchet bytes, Ed25519 key.
// Index 0 -> 1 advances R3 with HMAC-SHA256(R3, 0x03), as specified by Megolm:
// https://spec.matrix.org/v1.16/olm-megolm/megolm/#advancing-the-ratchet
// Production comparison is performed exclusively by installed Rust WASM, not this fixture code.
function ratchetFixtures(): { early: IMegolmSessionData; later: IMegolmSessionData } {
  const publicKey = generateKeyPairSync('ed25519')
    .publicKey.export({ format: 'der', type: 'spki' })
    .subarray(-32);
  const bytes = Buffer.alloc(165);
  bytes[0] = 1;
  for (let i = 5; i < 133; i++) bytes[i] = i;
  publicKey.copy(bytes, 133);
  const early: IMegolmSessionData = {
    algorithm: 'm.megolm.v1.aes-sha2',
    room_id: '!fixture:example.invalid',
    session_id: publicKey.toString('base64').replace(/=+$/, ''),
    sender_key: Buffer.alloc(32, 7).toString('base64').replace(/=+$/, ''),
    sender_claimed_keys: { ed25519: publicKey.toString('base64').replace(/=+$/, '') },
    forwarding_curve25519_key_chain: [],
    session_key: bytes.toString('base64').replace(/=+$/, ''),
  };
  bytes.writeUInt32BE(1, 1);
  createHmac('sha256', bytes.subarray(101, 133))
    .update(Buffer.from([3]))
    .digest()
    .copy(bytes, 101);
  return { early, later: { ...early, session_key: bytes.toString('base64').replace(/=+$/, '') } };
}

test('Rust proof accepts equal/earlier backups and rejects a later backup', async () => {
  const { early, later } = ratchetFixtures();
  assert.equal(await backupKeyCoversLocal(later, early), true);
  assert.equal(await backupKeyCoversLocal(early, later), false);
  assert.equal(await backupKeyCoversLocal(early, early), true);
  assert.equal(await backupKeyCoversLocal(later, later), true);
});

test('Rust proof rejects same-ID unconnected ratchets and metadata substitution', async () => {
  const { early, later } = ratchetFixtures();
  const forged = Buffer.from(early.session_key, 'base64');
  forged[105] ^= 1; // Different secret ratchet, preserving its index and public signing/session ID.
  assert.equal(
    await backupKeyCoversLocal(later, {
      ...early,
      session_key: forged.toString('base64').replace(/=+$/, ''),
    }),
    false,
  );
  assert.equal(
    await backupKeyCoversLocal(later, {
      ...early,
      sender_key: Buffer.alloc(32, 8).toString('base64').replace(/=+$/, ''),
    }),
    false,
  );
  assert.equal(await backupKeyCoversLocal(later, { ...early, session_key: 'invalid' }), false);
  assert.equal(
    await backupKeyCoversLocal(later, { ...early, room_id: '!other:example.invalid' }),
    false,
  );
});

import { EventEmitter } from 'node:events';
import { Identity } from '../src/identity';
import {
  VerificationPhase,
  VerificationRequestEvent,
  VerifierEvent,
} from 'matrix-js-sdk/lib/crypto-api';

test('friend SAS still exposes accept, comparison and confirmation for the selected peer', async () => {
  const identity: any = Reflect.construct(Identity, [{ userId: '@alice:example.org' }, {}]);
  const request: any = new EventEmitter();
  const verifier: any = new EventEmitter();
  let accepted = 0,
    started = 0,
    confirmed = 0;
  const sas = {
    sas: { decimal: [1234, 5678, 9012] },
    confirm: async () => {
      confirmed++;
    },
    mismatch() {},
  };
  Object.assign(verifier, { getShowSasCallbacks: () => null, verify: () => new Promise(() => {}) });
  Object.assign(request, {
    otherUserId: '@bob:example.org',
    transactionId: 'friend-check',
    phase: VerificationPhase.Requested,
    initiatedByMe: false,
    accept: async () => {
      accepted++;
    },
    cancel: async () => {},
    startVerification: async () => {
      started++;
      request.verifier = verifier;
      request.phase = VerificationPhase.Started;
    },
  });
  let view: any;
  identity.onVerification = (next: any) => {
    view = next;
  };
  identity.watch(request);
  assert.equal(view.peer, '@bob:example.org');
  await view.accept();
  request.phase = VerificationPhase.Ready;
  request.emit(VerificationRequestEvent.Change);
  await view.compare();
  verifier.emit(VerifierEvent.ShowSas, sas);
  assert.deepEqual(view.decimal, sas.sas.decimal);
  await view.confirm();
  assert.deepEqual([accepted, started, confirmed], [1, 1, 1]);
});

test('SAS Done waits for verifier completion and authenticated trust; exact terminal replay is suppressed', async () => {
  const scope = {
    baseUrl: 'https://synthetic.invalid',
    userId: '@a:synthetic.invalid',
    deviceId: 'A',
  };
  const stored = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    },
  });
  try {
    let finish!: () => void;
    let trust!: () => void;
    let upload!: () => void;
    const uploaded = new Promise<void>((resolve) => {
      upload = resolve;
    });
    const verified = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const trusted = new Promise<void>((resolve) => {
      trust = resolve;
    });
    const identity: any = Reflect.construct(Identity, [scope, {}]);
    identity.requireVerifiedUser = () => trusted;
    identity.waitForVerifiedUser = () => identity.requireVerifiedUser();
    const views: any[] = [];
    identity.onVerification = (view: any) => views.push(view);
    const verifier = Object.assign(new EventEmitter(), {
      verify: () => verified,
      getShowSasCallbacks: () => ({
        sas: { decimal: [1234, 5678, 9012] },
        confirm: () => uploaded,
      }),
    });
    const request = Object.assign(new EventEmitter(), {
      otherUserId: '@b:synthetic.invalid',
      transactionId: 'exact-request',
      phase: VerificationPhase.Started,
      verifier,
      cancel: async () => {},
    });
    identity.watch(request);
    const confirming = views.at(-1).confirm();
    request.phase = VerificationPhase.Done;
    request.emit(VerificationRequestEvent.Change);
    assert.equal(views.at(-1).phase, 'confirming');
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(views.at(-1).phase, 'confirming');
    trust();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(views.at(-1).phase, 'confirming');
    upload();
    await confirming;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(views.at(-1).phase, 'done');
    assert.equal(stored.size, 1);
    const reopened: any = Reflect.construct(Identity, [scope, {}]);
    let shown = 0,
      cancelled = 0;
    reopened.onVerification = () => shown++;
    reopened.watch(
      Object.assign(new EventEmitter(), {
        otherUserId: request.otherUserId,
        transactionId: request.transactionId,
        phase: VerificationPhase.Requested,
        cancel: async () => {
          cancelled++;
        },
      }),
    );
    assert.equal(shown, 0);
    assert.equal(cancelled, 1);
    reopened.watch(
      Object.assign(new EventEmitter(), {
        otherUserId: request.otherUserId,
        transactionId: 'fresh-request',
        phase: VerificationPhase.Requested,
        cancel: async () => {},
      }),
    );
    assert.equal(shown, 1, 'fresh checks remain available for changed identities');
    Identity.forgetVerificationHistory({ ...scope, deviceId: 'OTHER' });
    assert.equal(stored.size, 1);
    Identity.forgetVerificationHistory(scope);
    assert.equal(stored.size, 0);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('SAS completion fails closed when peer trust or durable terminal storage fails', async () => {
  for (const failed of ['trust', 'storage']) {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => {
          throw new Error('Synthetic quota');
        },
      },
    });
    try {
      const identity: any = Reflect.construct(Identity, [
        { baseUrl: 'https://synthetic.invalid', userId: '@a:synthetic.invalid', deviceId: 'A' },
        {},
      ]);
      identity.waitForVerifiedUser = () => identity.requireVerifiedUser();
      identity.requireVerifiedUser = async () => {
        if (failed === 'trust') throw new Error('Untrusted');
      };
      const views: any[] = [];
      identity.onVerification = (view: any) => views.push(view);
      const verifier = Object.assign(new EventEmitter(), {
        verify: async () => {},
        getShowSasCallbacks: () => null,
      });
      identity.watch(
        Object.assign(new EventEmitter(), {
          otherUserId: '@b:synthetic.invalid',
          transactionId: failed,
          phase: VerificationPhase.Done,
          verifier,
          cancel: async () => {},
        }),
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(views.at(-1).phase, 'confirming');
      assert.match(views.at(-1).failure, /could not be authenticated/);
      assert.equal(
        views.some((view) => view.phase === 'done'),
        false,
      );
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else Reflect.deleteProperty(globalThis, 'localStorage');
    }
  }
});

test('malformed terminal journal rejects checks and capacity stays bounded', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let value = '["not-a-tuple"]';
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => value,
      setItem: (_: string, next: string) => {
        value = next;
      },
    },
  });
  try {
    const scope = {
      baseUrl: 'https://synthetic.invalid',
      userId: '@a:synthetic.invalid',
      deviceId: 'A',
    };
    const identity: any = Reflect.construct(Identity, [scope, {}]);
    let rejected = 0,
      shown = 0;
    identity.onVerificationRejected = () => rejected++;
    identity.onVerification = () => shown++;
    identity.watch(
      Object.assign(new EventEmitter(), {
        otherUserId: '@b:synthetic.invalid',
        transactionId: 'fresh',
        phase: VerificationPhase.Requested,
      }),
    );
    assert.equal(rejected, 1);
    assert.equal(shown, 0);
    value = JSON.stringify(
      Array.from({ length: 512 }, (_, i) => JSON.stringify(['@b:synthetic.invalid', `old-${i}`])),
    );
    identity.terminalVerification('@b:synthetic.invalid', 'newest', true);
    assert.equal(JSON.parse(value).length, 512);
    assert.equal(identity.terminalVerification('@b:synthetic.invalid', 'newest'), true);
    assert.equal(identity.terminalVerification('@b:synthetic.invalid', 'old-0'), false);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('authenticated completion follows local trust events and times out without trusting an event alone', async () => {
  const client = new EventEmitter();
  const identity: any = Reflect.construct(Identity, [{ userId: '@a:synthetic.invalid' }, client]);
  let trusted = false;
  identity.requireVerifiedUser = async () => {
    if (!trusted) throw new Error('Still unverified');
  };
  const { CryptoEvent } = await import('matrix-js-sdk/lib/crypto-api');
  const waiting = identity.waitForVerifiedUser('@b:synthetic.invalid', 1000);
  await new Promise((resolve) => setImmediate(resolve));
  trusted = true;
  client.emit(CryptoEvent.UserTrustStatusChanged, '@b:synthetic.invalid');
  await waiting;
  assert.equal(client.listenerCount(CryptoEvent.UserTrustStatusChanged), 0);
  trusted = false;
  const denied = identity.waitForVerifiedUser('@b:synthetic.invalid', 10);
  client.emit(CryptoEvent.UserTrustStatusChanged, '@b:synthetic.invalid');
  await assert.rejects(denied, /Still unverified/);
  assert.equal(client.listenerCount(CryptoEvent.UserTrustStatusChanged), 0);
});

test('logout recognizes only confirmed unknown-token 401 and preserves transport failures', async () => {
  const oldFetch = globalThis.fetch;
  const session = {
    baseUrl: 'https://fictional.example',
    userId: '@a:fictional.example',
    deviceId: 'A',
    accessToken: 'synthetic',
  };
  try {
    for (const [status, errcode, ended] of [
      [401, 'M_UNKNOWN_TOKEN', true],
      [403, 'M_UNKNOWN_TOKEN', false],
      [401, 'M_FORBIDDEN', false],
    ] as const) {
      const error = new MatrixError({ errcode, error: 'Synthetic' }, status);
      assert.equal(Identity.sessionIsInvalid(error), ended);
      globalThis.fetch = async () => Response.json(error.data, { status });
      if (ended) await Identity.logoutSession(session);
      else
        await assert.rejects(
          Identity.logoutSession(session),
          (error) => error instanceof MatrixError && error.httpStatus === status,
        );
    }
    assert.equal(
      Identity.sessionIsInvalid({ httpStatus: 401, data: { errcode: 'M_UNKNOWN_TOKEN' } }),
      false,
    );
    globalThis.fetch = async () => {
      throw new Error('Synthetic network failure');
    };
    await assert.rejects(Identity.logoutSession(session), /Synthetic network failure/);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('SAS cancellation still reaches its peer when terminal storage fails and blocks queued Done first', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => null,
      setItem: () => {
        throw new Error('Synthetic journal quota');
      },
    },
  });
  try {
    for (const failTransport of [false, true]) {
      const identity: any = Reflect.construct(Identity, [
        { baseUrl: 'https://synthetic.invalid', userId: '@a:synthetic.invalid', deviceId: 'A' },
        {},
      ]);
      const scope = { roomId: '!room:synthetic.invalid', transactionId: 'cancel-during-quota' };
      identity.beginVerificationConfirmation(scope);
      const gate = identity.verificationMacs.get(
        JSON.stringify([scope.roomId, scope.transactionId]),
      );
      let attempts = 0,
        delivered = 0;
      const request = Object.assign(new EventEmitter(), {
        ...scope,
        otherUserId: '@b:synthetic.invalid',
        phase: VerificationPhase.Started,
        cancel: async () => {
          attempts++;
          assert.equal(
            gate.state,
            'failed',
            'queued Done is blocked before peer cancellation starts',
          );
          request.phase = VerificationPhase.Cancelled;
          request.emit(VerificationRequestEvent.Change);
          if (failTransport) throw new Error('Synthetic cancellation transport failure');
          delivered++;
        },
      });
      const views: any[] = [],
        failures: string[] = [];
      identity.onVerification = (view: any) => views.push(view);
      identity.onVerificationRejected = (message: string) => failures.push(message);
      identity.watch(request);
      await assert.rejects(views.at(-1).cancel(), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, failTransport ? 2 : 1);
        assert.match(
          error.message,
          failTransport ? /could not be sent or saved/ : /could not be saved/,
        );
        return true;
      });
      await assert.rejects(gate.promise, /cancelled/);
      assert.equal(attempts, 1);
      assert.equal(delivered, failTransport ? 0 : 1);
      assert.equal(views.at(-1).phase, 'cancelled');
      assert.equal(
        views.some((view) => view.phase === 'done'),
        false,
      );
      assert.equal(
        views.slice(1).every((view) => view.phase === 'cancelled'),
        true,
        'synchronous cancellation cannot reopen a recovery dialog',
      );
      assert.equal(
        identity.terminalVerifications.size,
        0,
        'failed persistence is never represented as durable',
      );
      assert.equal(failures.length, 1);
      assert.match(failures[0], /could not be.*saved/);
    }
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
