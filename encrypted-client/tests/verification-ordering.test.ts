import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomMessageRequest } from '@matrix-org/matrix-sdk-crypto-wasm';
import { Identity, createArchiveClient } from '../src/identity';

// Use the installed SDK processor and its real 429 backoff. Only the HTTP
// homeserver is synthetic; the native requests, retry loop and adapter are real.
async function fixture(ordered: boolean, failure = 429) {
  const attempts: string[] = [],
    delivered: string[] = [];
  let macAttempts = 0;
  const session = {
    baseUrl: 'https://synthetic.invalid',
    userId: '@a:synthetic.invalid',
    deviceId: 'A',
    accessToken: 'fictional',
  };
  const client = createArchiveClient({
    ...session,
    fetchFn: async (input) => {
      const path = new URL(String(input)).pathname;
      const kind = path.includes('/m.key.verification.mac/')
        ? 'mac'
        : path.includes('/m.key.verification.done/')
          ? 'done'
          : 'other';
      if (kind === 'other')
        return Response.json(
          { errcode: 'M_NOT_FOUND', error: 'No synthetic resource' },
          { status: 404 },
        );
      attempts.push(kind);
      if (kind === 'mac' && ++macAttempts === 1)
        return Response.json(
          {
            errcode: failure === 429 ? 'M_LIMIT_EXCEEDED' : 'M_FORBIDDEN',
            error: 'Synthetic MAC transport failure',
            retry_after_ms: 5,
          },
          { status: failure },
        );
      delivered.push(kind);
      return Response.json({ event_id: '$synthetic-event' });
    },
  });
  await client.initRustCrypto({ useIndexedDB: false });
  const identity: any = Reflect.construct(Identity, [session, client]);
  if (ordered) identity.installVerificationOrdering();
  const processor = (client.getCrypto() as any).outgoingRequestProcessor;
  const roomId = '!room:synthetic.invalid',
    transactionId = '$exact-check';
  const request = (kind: string, relation = transactionId) =>
    new RoomMessageRequest(
      '',
      roomId,
      `${kind}-transaction`,
      `m.key.verification.${kind}`,
      JSON.stringify({
        'm.relates_to': { rel_type: 'm.reference', event_id: relation },
        ...(kind === 'mac' ? { mac: {}, keys: 'synthetic-mac' } : {}),
      }),
    );
  return {
    attempts,
    delivered,
    identity,
    processor,
    request,
    scope: { roomId, transactionId },
    close: () => identity.close(),
  };
}

test('installed SDK43 Done overtakes a rate-limited MAC; adapter preserves MAC-before-Done across real retries', async () => {
  for (const ordered of [false, true]) {
    const f = await fixture(ordered);
    const mac = f.request('mac'),
      done = f.request('done');
    try {
      if (ordered) f.identity.beginVerificationConfirmation(f.scope);
      await Promise.all([
        f.processor.makeOutgoingRequest(mac),
        f.processor.makeOutgoingRequest(done),
      ]);
      assert.deepEqual(
        f.attempts.filter((x) => x === 'mac'),
        ['mac', 'mac'],
      );
      assert.deepEqual(f.delivered, ordered ? ['mac', 'done'] : ['done', 'mac']);
    } finally {
      mac.free();
      done.free();
      f.close();
    }
  }
});

test('Done also waits when dispatched before MAC registration and cannot cross another request or a failed MAC', async () => {
  const f = await fixture(true);
  const mac = f.request('mac'),
    done = f.request('done'),
    other = f.request('done', '$different-check');
  try {
    f.identity.beginVerificationConfirmation(f.scope);
    const finishing = f.processor.makeOutgoingRequest(done);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(f.attempts, []);
    await assert.rejects(f.processor.makeOutgoingRequest(other), /not been confirmed/);
    await f.processor.makeOutgoingRequest(mac);
    await finishing;
    assert.deepEqual(f.delivered, ['mac', 'done']);
  } finally {
    mac.free();
    done.free();
    other.free();
    f.close();
  }
  const failed = await fixture(true, 403);
  const deniedMac = failed.request('mac'),
    deniedDone = failed.request('done');
  try {
    failed.identity.beginVerificationConfirmation(failed.scope);
    const results = await Promise.allSettled([
      failed.processor.makeOutgoingRequest(deniedMac),
      failed.processor.makeOutgoingRequest(deniedDone),
    ]);
    assert.deepEqual(
      results.map((result) => result.status),
      ['rejected', 'rejected'],
    );
    assert.deepEqual(failed.attempts, ['mac']);
  } finally {
    deniedMac.free();
    deniedDone.free();
    failed.close();
  }
});

test('cancellation releases waiting Done without sending it', async () => {
  const f = await fixture(true);
  const done = f.request('done');
  try {
    f.identity.beginVerificationConfirmation(f.scope);
    const finishing = f.processor.makeOutgoingRequest(done);
    f.identity.cancelVerificationOrdering(f.scope);
    await assert.rejects(finishing, /cancelled/);
    assert.deepEqual(f.attempts, []);
  } finally {
    done.free();
    f.close();
  }
});
