import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOrigin } from '../src/identity';
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
