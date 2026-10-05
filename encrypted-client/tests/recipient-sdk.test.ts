/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomEncryptor } from 'matrix-js-sdk/lib/rust-crypto/RoomEncryptor.js';
import { AllDevicesIsolationMode } from 'matrix-js-sdk/lib/crypto-api/index.js';
import { initAsync } from '@matrix-org/matrix-sdk-crypto-wasm';
import type { Room } from 'matrix-js-sdk';
import { enforceRecipientBoundary } from '../src/recipient-boundary';

// Exercise the installed SDK's actual queued encryption and recipient selection.
// The native transport spy records who would receive keys; it does not mark any
// device trusted or stand in for the browser's separate crypto acceptance.
test('actual SDK queue rejects a third verified user inserted after the app guard', async () => {
  await initAsync();
  const alice = '@alice:example.org',
    bob = '@bob:example.org',
    carol = '@carol:example.org';
  let members = [alice, bob].map((userId) => ({ userId, membership: 'join' }));
  let release!: () => void;
  let collected!: () => void;
  const collecting = new Promise<void>((resolve) => {
    collected = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  const shared: string[][] = [];
  let discards = 0;
  const room = {
    roomId: '!pair:example.org',
    getJoinedMembers: () => members,
    getEncryptionTargetMembers: async () => {
      collected();
      await paused;
      return members;
    },
    shouldEncryptForInvitedMembers: () => false,
    getHistoryVisibility: () => 'joined',
    getBlacklistUnverifiedDevices: () => true,
  } as unknown as Room;
  const quiet = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    trace() {},
    getChild() {
      return quiet;
    },
  };
  const machine = {
    updateTrackedUsers: async () => {},
    shareRoomKey: async (_room: unknown, users: { toString(): string }[]) => {
      shared.push(users.map((user) => user.toString()));
      return [];
    },
  };
  const encryptor = new RoomEncryptor(
    quiet,
    machine as never,
    { ensureSessionsForUsers: async () => {} } as never,
    {
      doProcessOutgoingRequests: async () => {},
      outgoingRequestProcessor: { makeOutgoingRequest: async () => {} },
    } as never,
    room,
    { algorithm: 'm.megolm.v1.aes-sha2' },
  );
  enforceRecipientBoundary(
    room,
    [alice, bob],
    () => {},
    async () => {
      discards++;
    },
  );
  const sending = encryptor.prepareForEncryption(true, new AllDevicesIsolationMode(true));
  await collecting;
  // All three may already be verified. Verification is not audience consent.
  members = [...members, { userId: carol, membership: 'join' }];
  release();
  await assert.rejects(sending, /recipients differ/);
  assert.equal(discards, 1);
  assert.deepEqual(shared, []);
  members = members.filter((m) => m.userId !== carol);
  await encryptor.prepareForEncryption(true, new AllDevicesIsolationMode(true));
  assert.deepEqual(shared, [[alice, bob]]);
  assert.equal(discards, 1);
});
