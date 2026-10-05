/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import type { MatrixClient } from 'matrix-js-sdk';
import { PkDecryption, PkEncryption, initAsync } from '@matrix-org/matrix-sdk-crypto-wasm';
// @ts-expect-error Same pinned Matrix canonical JSON implementation as the SDK.
import anotherJson from 'another-json';
import { signContent, verifyContent } from '../src/signed-content.js';

const user = '@alice:example.org',
  room = '!private:example.org';
function signer() {
  const pair = generateKeyPairSync('ed25519');
  const master = pair.publicKey
    .export({ type: 'spki', format: 'der' })
    .subarray(-32)
    .toString('base64')
    .replace(/=+$/u, '');
  let verified = true,
    approval = false,
    violation = false,
    freed = 0;
  const backend: any = {
    getVersion: () => 'Rust SDK fixture',
    getOlmMachineOrThrow: () => ({
      getIdentity: async () => ({
        isVerified: () => verified,
        identityNeedsUserApproval: () => approval,
        hasVerificationViolation: () => violation,
        masterKey: JSON.stringify({
          user_id: user,
          usage: ['master'],
          keys: { [`ed25519:${master}`]: master },
        }),
        free: () => {
          freed++;
        },
      }),
    }),
    signObject: async (value: any) => {
      const unsigned = { ...value };
      delete unsigned.signatures;
      delete unsigned.unsigned;
      value.signatures = {
        [user]: {
          [`ed25519:${master}`]: sign(
            null,
            Buffer.from(anotherJson.stringify(unsigned)),
            pair.privateKey,
          )
            .toString('base64')
            .replace(/=+$/u, ''),
        },
      };
    },
  };
  const client = {
    getUserId: () => user,
    getDeviceId: () => 'OLDDEVICE',
    getCrypto: () => backend,
  } as unknown as MatrixClient;
  return {
    client,
    backend,
    master,
    reset: (v = true, a = false, x = false) => {
      verified = v;
      approval = a;
      violation = x;
    },
    freed: () => freed,
  };
}
const verifyUser = async () => {};
const content = {
  version: 2,
  purpose: 'archive',
  id: 'a'.repeat(64),
  file: { url: 'mxc://example.org/opaque', info: 'encrypted-file-information', size: 32 },
};

test('master signature verifies the complete contextual payload after device deletion', async () => {
  const s = signer();
  const signed = await signContent(s.client, verifyUser, room, content);
  // No current-device lookup participates: recovered content is authenticated by
  // the still-verified master identity, not by backup encryption alone.
  assert.deepEqual(await verifyContent(s.client, verifyUser, room, user, signed), content);
  assert.equal(s.freed(), 4);
});
test('copied proof cannot authorize modified attachment, purpose, ID, sender, device or room', async () => {
  const s = signer();
  const signed = await signContent(s.client, verifyUser, room, content);
  const mutations = [
    (v: any) => {
      v.payload.file.url = 'mxc://example.org/attacker';
    },
    (v: any) => {
      v.payload.file.info = 'attacker key';
    },
    (v: any) => {
      v.payload.purpose = 'post';
    },
    (v: any) => {
      v.payload.id = 'b'.repeat(64);
    },
    (v: any) => {
      v.sender_device = 'ATTACKER';
    },
    (v: any) => {
      v.sender = '@intruder:example.org';
    },
    (v: any) => {
      v.room_id = '!other:example.org';
    },
    (v: any) => {
      v.domain = 'other-app';
    },
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(signed);
    mutate(copy);
    await assert.rejects(verifyContent(s.client, verifyUser, room, user, copy));
  }
  await assert.rejects(
    verifyContent(s.client, verifyUser, '!another:example.org', user, signed),
    /context/,
  );
});
test('device-only signatures and missing adapter fail closed', async () => {
  const s = signer();
  s.backend.signObject = async (v: any) => {
    v.signatures = { [user]: { 'ed25519:OLDDEVICE': 'A'.repeat(86) } };
  };
  await assert.rejects(signContent(s.client, verifyUser, room, content), /master signature/);
  delete s.backend.getOlmMachineOrThrow;
  await assert.rejects(signContent(s.client, verifyUser, room, content), /unavailable/);
});
test('unverified, approval-needed and violated atomic identities cannot publish or read', async () => {
  const s = signer();
  const signed = await signContent(s.client, verifyUser, room, content);
  for (const state of [
    [false, false, false],
    [true, true, false],
    [true, false, true],
  ]) {
    s.reset(...(state as [boolean, boolean, boolean]));
    await assert.rejects(
      verifyContent(s.client, verifyUser, room, user, signed),
      /verified and unchanged/,
    );
    await assert.rejects(
      signContent(s.client, verifyUser, room, content),
      /verified and unchanged/,
    );
  }
});
test('identity change between signature verification and final atomic read is rejected', async () => {
  const first = signer(),
    second = signer();
  const signed = await signContent(first.client, verifyUser, room, content);
  let calls = 0;
  const original = first.backend.getOlmMachineOrThrow;
  first.backend.getOlmMachineOrThrow = () => {
    calls++;
    return calls === 1 ? original() : second.backend.getOlmMachineOrThrow();
  };
  await assert.rejects(
    verifyContent(first.client, verifyUser, room, user, signed),
    /changed during verification/,
  );
});
test('unknown schema, unsigned dev payload and untrusted master signature are rejected', async () => {
  const s = signer(),
    attacker = signer();
  const signed = await signContent(s.client, verifyUser, room, content);
  await assert.rejects(verifyContent(s.client, verifyUser, room, user, content), /context/);
  await assert.rejects(
    verifyContent(attacker.client, verifyUser, room, user, signed),
    /master signature/,
  );
  await assert.rejects(
    verifyContent(s.client, verifyUser, room, user, { ...signed, version: 1 }),
    /context/,
  );
});
test('attacker can encrypt forged backup with public key but cannot authenticate altered content', async () => {
  const s = signer();
  const genuine = await signContent(s.client, verifyUser, room, content);
  await initAsync();
  const receiver = new PkDecryption();
  const attacker = PkEncryption.fromKey(receiver.publicKey());
  const forged = structuredClone(genuine);
  forged.payload = { ...content, file: { ...content.file, url: 'mxc://example.org/forged' } };
  const message = attacker.encryptString(
    JSON.stringify({
      sender_key: 'copied victim key',
      sender_claimed_keys: { ed25519: 'copied public key' },
      content: forged,
    }),
  );
  try {
    const restored = JSON.parse(receiver.decryptString(message));
    assert.equal(restored.sender_key, 'copied victim key');
    await assert.rejects(
      verifyContent(s.client, verifyUser, room, user, restored.content),
      /signature is invalid/,
    );
  } finally {
    message.free();
    attacker.free();
    receiver.free();
  }
});
