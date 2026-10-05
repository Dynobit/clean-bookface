/// <reference types="node" />
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync, sign } from 'node:crypto';
// @ts-expect-error Same pinned Matrix canonical JSON used by the SDK.
import anotherJson from 'another-json';
const masterPair = generateKeyPairSync('ed25519');
const master = masterPair.publicKey
  .export({ type: 'spki', format: 'der' })
  .subarray(-32)
  .toString('base64')
  .replace(/=+$/u, '');
import assert from 'node:assert/strict';
import type { MatrixClient } from 'matrix-js-sdk';
import { ContentStore, CONTENT_LIMITS } from '../src/content.js';
import { exportArchives, importArchives, type MemoryRecord } from '../src/archive.js';
const me = '@alice:example.org',
  friend = '@ben:example.org';
const record: MemoryRecord = {
  id: 'fixture',
  kind: 'post',
  timestamp: 1000,
  text: 'PLANTED PRIVATE TEXT',
  title: 'A day',
  sourcePath: 'posts/private.json',
  privateOnly: false,
  provenance: { original: 'PRIVATE PROVENANCE' },
  attachments: [],
};
function fixture(purpose: 'archive' | 'pair' = 'archive') {
  const members = [
    { userId: me, membership: 'join' },
    ...(purpose === 'pair' ? [{ userId: friend, membership: 'join' }] : []),
  ];
  const state: Record<string, Record<string, unknown>> = {
    'm.room.encryption': { algorithm: 'm.megolm.v1.aes-sha2' },
    'm.room.history_visibility': { history_visibility: 'joined' },
    'org.cleanbookface.room.v1': { purpose },
  };
  const events: any[] = [];
  const sent: any[] = [];
  const uploaded: Blob[] = [];
  const verified: string[] = [];
  let shield = 0,
    deviceVerified = true,
    cryptoEnabled = true,
    afterUpload = () => {};
  const room: any = {
    roomId: '!fixture:example.org',
    currentState: {
      getStateEvents: (type: string) => (state[type] ? { getContent: () => state[type] } : null),
    },
    getMembers: () => members,
    getEncryptionTargetMembers: async () =>
      members.filter((member) => member.membership === 'join'),
    setBlacklistUnverifiedDevices: () => {},
    getMyMembership: () => members.find((m) => m.userId === me)?.membership,
    loadMembersIfNeeded: async () => true,
    oldState: { paginationToken: null },
    getLiveTimeline: () => ({ getEvents: () => events }),
  };
  const c: any = {
    getOlmMachineOrThrow: () => ({
      getIdentity: async () => ({
        free: () => {},
        isVerified: () => true,
        hasVerificationViolation: () => false,
        identityNeedsUserApproval: () => false,
        masterKey: JSON.stringify({
          user_id: me,
          usage: ['master'],
          keys: { [`ed25519:${master}`]: master },
        }),
      }),
    }),
    signObject: async (value: any) => {
      const copy = { ...value };
      delete copy.signatures;
      delete copy.unsigned;
      value.signatures = {
        [me]: {
          [`ed25519:${master}`]: sign(
            null,
            Buffer.from(anotherJson.stringify(copy)),
            masterPair.privateKey,
          )
            .toString('base64')
            .replace(/=+$/u, ''),
        },
      };
    },
    forceDiscardSession: async () => {},
    globalBlacklistUnverifiedDevices: false,
    setDeviceIsolationMode: () => {},
    getVersion: () => 'Rust SDK fixture',
    isEncryptionEnabledInRoom: async () => cryptoEnabled,
    getEncryptionInfoForEvent: async () => ({
      shieldColour: !deviceVerified ? 1 : shield ? 1 : 0,
      shieldReason: !deviceVerified ? 2 : shield || null,
    }),
    getUserDeviceInfo: async (users: string[]) =>
      new Map(
        users.map((u) => [
          u,
          new Map([['DEVICE', { deviceId: 'DEVICE', getIdentityKey: () => 'curve-key' }]]),
        ]),
      ),
    getDeviceVerificationStatus: async () => ({ isVerified: () => deviceVerified }),
  };
  const emitter = new EventEmitter();
  const client: any = {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    getMediaConfig: async () => ({ 'm.upload.size': 256 * 1024 * 1024 }),
    getUserId: () => me,
    getDeviceId: () => 'DEVICE',
    getCrypto: () => c,
    getRoom: () => room,
    getRooms: () => [room],
    getHomeserverUrl: () => 'https://example.org',
    getAccessToken: () => 'SECRET_TOKEN',
    mxcUrlToHttp: () => 'https://example.org/_matrix/client/v1/media/download/example.org/blob',
    decryptEventIfNeeded: async () => {},
    uploadContent: async (blob: Blob, options: unknown) => {
      assert.deepEqual(options, { type: 'application/octet-stream', includeFilename: false });
      uploaded.push(blob);
      afterUpload();
      return { content_uri: 'mxc://example.org/blob' };
    },
    sendEvent: async (...args: any[]) => {
      await room.getEncryptionTargetMembers();
      sent.push(args);
      return { event_id: '$event' };
    },
    leave: async () => {
      members[0].membership = 'leave';
    },
    joinRoom: async () => {
      members[0].membership = 'join';
    },
    createRoom: async () => ({ room_id: room.roomId }),
  };
  const store = new ContentStore(client as MatrixClient, async (id) => {
    verified.push(id);
  });
  function event(
    content: unknown,
    options: { encrypted?: boolean; sender?: string; key?: string } = {},
  ) {
    return {
      isEncrypted: () => options.encrypted ?? true,
      isDecryptionFailure: () => false,
      getType: () => 'org.cleanbookface.content.v1',
      getContent: () => content,
      getSender: () => options.sender ?? me,
      getSenderKey: () => options.key ?? 'curve-key',
      getRoomId: () => room.roomId,
      getId: () => `$${(content as any).payload?.id}`,
      getTs: () => 123,
    };
  }
  return {
    store,
    emitter,
    client,
    c,
    room,
    members,
    state,
    events,
    sent,
    uploaded,
    verified,
    event,
    setShield: (v: number) => {
      shield = v;
    },
    setDeviceVerified: (v: boolean) => {
      deviceVerified = v;
    },
    setCryptoEnabled: (v: boolean) => {
      cryptoEnabled = v;
    },
    afterUpload: (fn: () => void) => {
      afterUpload = fn;
    },
  };
}
test('archive ciphertext round trip preserves records and deterministic retry identity', async () => {
  const f = fixture();
  await f.store.saveArchive([record]);
  await f.store.saveArchive([record]);
  assert.equal(f.uploaded.length, 1);
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0][3], f.sent[1][3]);
  const bytes = await f.uploaded[0].text();
  assert.ok(!bytes.includes(record.text));
  assert.ok(!bytes.includes(record.sourcePath));
  assert.equal(f.uploaded[0].type, 'application/octet-stream');
  assert.ok(f.verified.includes(me));
  const p = f.sent[0][2];
  assert.deepEqual(Object.keys(p).sort(), [
    'domain',
    'payload',
    'room_id',
    'sender',
    'sender_device',
    'signatures',
    'version',
  ]);
  f.events.push(f.event(p));
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(new URL(String(input)).origin, 'https://example.org');
    assert.equal(init?.redirect, 'error');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer SECRET_TOKEN');
    return new Response(f.uploaded[0]);
  };
  try {
    assert.deepEqual(await f.store.privateArchive(), [record]);
  } finally {
    globalThis.fetch = original;
  }
});
test('room downgrade, no crypto, unexpected invited member and unsupported history fail before upload', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.state['m.room.encryption'].algorithm = 'plaintext';
    },
    (f: ReturnType<typeof fixture>) => {
      f.client.getCrypto = () => undefined;
    },
    (f: ReturnType<typeof fixture>) => {
      f.members.push({ userId: '@intruder:example.org', membership: 'invite' });
    },
    (f: ReturnType<typeof fixture>) => {
      f.state['m.room.history_visibility'].history_visibility = 'shared';
    },
    (f: ReturnType<typeof fixture>) => f.setCryptoEnabled(false),
  ]) {
    const f = fixture();
    mutate(f);
    await assert.rejects(f.store.saveArchive([record]));
    assert.equal(f.uploaded.length, 0);
    assert.equal(f.sent.length, 0);
  }
});
test('membership or encryption change during upload prevents the subsequent send', async () => {
  for (const change of ['member', 'algorithm']) {
    const f = fixture();
    f.afterUpload(() => {
      if (change === 'member')
        f.members.push({ userId: '@intruder:example.org', membership: 'invite' });
      else f.state['m.room.encryption'].algorithm = 'unknown';
    });
    await assert.rejects(f.store.saveArchive([record]));
    assert.equal(f.uploaded.length, 1);
    assert.equal(f.sent.length, 0);
  }
});
test('sharing strips provenance and source path; verified users required and retries deduplicate', async () => {
  const f = fixture('pair');
  await f.store.share(record, [friend, friend]);
  await f.store.share(record, [friend]);
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0][3], f.sent[1][3]);
  assert.ok(f.verified.includes(friend));
  f.events.push(f.event(f.sent[0][2]));
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(f.uploaded[0]);
  try {
    const [post] = await f.store.posts();
    assert.equal(post.record.text, record.text);
    assert.equal(post.record.sourcePath, '');
    assert.deepEqual(post.record.provenance, {});
    assert.equal(post.record.privateOnly, false);
  } finally {
    globalThis.fetch = original;
  }
});
test('private records and unsupported media never upload', async () => {
  for (const r of [
    { ...record, kind: 'message' as const },
    { ...record, kind: 'friend' as const },
    { ...record, privateOnly: true },
    {
      ...record,
      attachments: [{ path: 'movie.mp4', mimeType: 'video/mp4', bytes: new Blob(['data']) }],
    },
  ]) {
    const f = fixture('pair');
    await assert.rejects(f.store.share(r, [friend]));
    assert.equal(f.uploaded.length, 0);
    assert.equal(f.sent.length, 0);
  }
});
test('unverified identity fails before upload', async () => {
  const f = fixture('pair');
  const s = new ContentStore(f.client, async (id) => {
    if (id === friend) throw new Error('Changed identity');
  });
  await assert.rejects(s.share(record, [friend]), /Changed identity/);
  assert.equal(f.uploaded.length, 0);
});
test('incoming plaintext, forbidden shields and unexpected senders fail before downloads', async () => {
  for (const kind of ['plaintext', 'shield', 'device', 'outsider']) {
    const f = fixture();
    await f.store.saveArchive([record]);
    f.events.push(
      f.event(f.sent[0][2], {
        encrypted: kind !== 'plaintext',
        key: kind === 'key' ? 'forged' : 'curve-key',
        sender: kind === 'outsider' ? friend : me,
      }),
    );
    if (kind === 'shield') f.setShield(2);
    if (kind === 'device') f.setDeviceVerified(false);
    await assert.rejects(f.store.privateArchive());
  }
});
test('external media, extra payload fields and invalid encryption metadata fail closed', async () => {
  for (const change of ['url', 'fields', 'info', 'size']) {
    const f = fixture();
    await f.store.saveArchive([record]);
    const p = structuredClone(f.sent[0][2]);
    if (change === 'url') p.payload.file.url = 'https://evil.example/steal';
    if (change === 'fields') p.payload.text = 'plaintext';
    if (change === 'info') p.payload.file.info = '{}';
    if (change === 'size') p.payload.file.size = Number.MAX_SAFE_INTEGER;
    await f.c.signObject(p); // Even a valid signer cannot bypass the payload schema.
    f.events.push(f.event(p));
    await assert.rejects(f.store.privateArchive());
  }
});
test('media origin guard prevents bearer token disclosure and streaming limit refuses excess', async () => {
  const f = fixture();
  await f.store.saveArchive([record]);
  f.events.push(f.event(f.sent[0][2]));
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(new Blob([new Uint8Array(f.sent[0][2].payload.file.size + 1)]));
  };
  try {
    f.client.mxcUrlToHttp = () =>
      'https://evil.example/_matrix/client/v1/media/download/example.org/blob';
    await assert.rejects(f.store.privateArchive(), /Unsafe media/);
    assert.equal(calls, 0);
    f.client.mxcUrlToHttp = () =>
      'https://example.org/_matrix/client/v1/media/download/example.org/blob';
    await assert.rejects(f.store.privateArchive(), /exceeds limit/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});
test('revocation prevents subsequent sharing; malformed multi-peer invitation cannot join', async () => {
  const f = fixture('pair');
  await f.store.revokeFriend(friend);
  await assert.rejects(f.store.share(record, [friend]));
  assert.equal(f.sent.length, 0);
  const invite = fixture('pair');
  invite.members[0].membership = 'invite';
  invite.members.push({ userId: '@intruder:example.org', membership: 'join' });
  await assert.rejects(invite.store.acceptInvite(invite.room.roomId), /exactly one peer/);
  assert.equal(invite.members[0].membership, 'invite');
});

test('unverified friend produces an explicit locked room without breaking the feed', async () => {
  const f = fixture('pair');
  const store = new ContentStore(f.client, async (id) => {
    if (id === friend) throw new Error('Identity not checked');
  });
  assert.deepEqual(await store.posts(), []);
  assert.equal(store.lockedRooms().length, 1);
  assert.equal(store.lockedRooms()[0].userId, friend);
  assert.match(store.lockedRooms()[0].reason, /identity/);
});
test('homeserver upload limit rejects before uploading ciphertext', async () => {
  const f = fixture();
  f.client.getMediaConfig = async () => ({ 'm.upload.size': 8 });
  await assert.rejects(f.store.saveArchive([record]), /homeserver upload limit/);
  assert.equal(f.uploaded.length, 0);
  assert.equal(f.sent.length, 0);
});

test('ciphertext tampering is rejected by maintained attachment decryption', async () => {
  const f = fixture();
  await f.store.saveArchive([record]);
  f.events.push(f.event(f.sent[0][2]));
  const bytes = new Uint8Array(await f.uploaded[0].arrayBuffer());
  bytes[0] ^= 1;
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(bytes);
  try {
    await assert.rejects(f.store.privateArchive());
  } finally {
    globalThis.fetch = original;
  }
});
test('feed cache avoids repeated download but never bypasses changed device trust', async () => {
  const f = fixture('pair');
  await f.store.share(record, [friend]);
  f.events.push(f.event(f.sent[0][2]));
  let requests = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    requests++;
    return new Response(f.uploaded[0]);
  };
  try {
    assert.equal((await f.store.posts()).length, 1);
    assert.equal((await f.store.posts()).length, 1);
    assert.equal(requests, 1);
    f.setDeviceVerified(false);
    assert.deepEqual(await f.store.posts(), []);
    assert.equal(f.store.lockedRooms().length, 1);
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = original;
  }
});
test('downgraded friendship remains visible as locked instead of disappearing silently', async () => {
  const f = fixture('pair');
  f.state['m.room.encryption'].algorithm = 'plaintext';
  assert.deepEqual(await f.store.posts(), []);
  assert.equal(f.store.lockedRooms().length, 1);
});
test('stale archive snapshots form an immutable union without discarding another browser import', async () => {
  const f = fixture();
  const a = { ...record, id: 'first' },
    b = { ...record, id: 'second', text: 'second import' },
    c = { ...record, id: 'third', text: 'stale browser import' };
  const original = globalThis.fetch;
  let uploaded = 0;
  f.client.uploadContent = async (blob: Blob) => {
    f.uploaded.push(blob);
    return { content_uri: `mxc://example.org/blob${uploaded++}` };
  };
  f.client.mxcUrlToHttp = (mxc: string) =>
    `https://example.org/_matrix/client/v1/media/download/example.org/${mxc.split('/').at(-1)}`;
  globalThis.fetch = async (input) =>
    new Response(f.uploaded[Number(String(input).match(/blob(\d+)$/u)![1])]);
  try {
    await f.store.saveArchive([a]);
    f.events.push(f.event(f.sent.at(-1)[2]));
    await f.store.saveArchive([a, b]);
    f.events.push(f.event(f.sent.at(-1)[2]));
    await f.store.saveArchive([a, c]);
    f.events.push(f.event(f.sent.at(-1)[2]));
    assert.deepEqual(
      (await f.store.privateArchive()).map((r) => r.id),
      ['first', 'second', 'third'],
    );
    await f.store.saveArchive([a]);
    assert.equal(f.sent[0][3], f.sent.at(-1)[3]);
  } finally {
    globalThis.fetch = original;
  }
});

test('stripped invite state is checked in full after join and invalid full membership leaves', async () => {
  for (const hostile of [false, true]) {
    const f = fixture('pair');
    f.members[0].membership = 'invite';
    delete f.state['org.cleanbookface.room.v1'];
    delete f.state['m.room.history_visibility'];
    f.client.joinRoom = async () => {
      f.members[0].membership = 'join';
      f.state['org.cleanbookface.room.v1'] = { purpose: 'pair' };
      f.state['m.room.history_visibility'] = { history_visibility: 'joined' };
      if (hostile) f.members.push({ userId: '@intruder:example.org', membership: 'invite' });
    };
    if (hostile) {
      await assert.rejects(f.store.acceptInvite(f.room.roomId), /Unexpected room membership/);
      assert.equal(f.members[0].membership, 'leave');
    } else {
      await f.store.acceptInvite(f.room.roomId);
      assert.equal(f.store.friendRooms().length, 1);
    }
    assert.equal(f.uploaded.length, 0);
    assert.equal(f.sent.length, 0);
  }
});

test('historical unknown-device and backup-authenticity shields require a valid master signature', async () => {
  const original = globalThis.fetch;
  try {
    for (const reason of [3, 4]) {
      const f = fixture();
      await f.store.saveArchive([record]);
      f.events.push(f.event(f.sent[0][2]));
      f.setShield(reason);
      globalThis.fetch = async () => new Response(f.uploaded[0]);
      assert.deepEqual(await f.store.privateArchive(), [record]);
      const forged = structuredClone(f.sent[0][2]);
      forged.payload.file.info = '{}';
      f.events.splice(0, 1, f.event(forged));
      await assert.rejects(f.store.privateArchive(), /signature is invalid/);
    }
  } finally {
    globalThis.fetch = original;
  }
});
test('all other bad shield reasons remain rejected even with a valid master signature', async () => {
  const f = fixture();
  await f.store.saveArchive([record]);
  f.events.push(f.event(f.sent[0][2]));
  for (const reason of [1, 2, 5, 6, 7, 8, 99]) {
    f.setShield(reason);
    await assert.rejects(f.store.privateArchive(), /Untrusted encrypted sender/);
  }
});

test('room creation leaves implicit creator powers to room v12 while retaining strict state and invite levels', async () => {
  for (const pair of [false, true]) {
    const f = fixture(pair ? 'pair' : 'archive');
    f.client.getRooms = () => [];
    const requests: any[] = [];
    f.client.createRoom = async (request: unknown) => {
      requests.push(request);
      return { room_id: f.room.roomId };
    };
    if (pair) await f.store.inviteFriend(friend);
    else await f.store.saveArchive([record]);
    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.deepEqual(request.power_level_content_override, {
      events_default: 0,
      state_default: 100,
      invite: 100,
    });
    assert.equal(Object.hasOwn(request.power_level_content_override, 'users'), false);
    assert.deepEqual(request.invite, pair ? [friend] : []);
    assert.equal(
      request.initial_state.find((event: any) => event.type === 'm.room.encryption').content
        .algorithm,
      'm.megolm.v1.aes-sha2',
    );
    assert.equal(
      request.initial_state.find((event: any) => event.type === 'm.room.history_visibility').content
        .history_visibility,
      'joined',
    );
  }
});

test('fresh room waits for delayed Rust encryption recognition before any upload or send', async () => {
  const f = fixture();
  f.client.getRooms = () => [];
  f.setCryptoEnabled(false);
  let finished = false;
  const saving = f.store.saveArchive([record]).then(() => {
    finished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(finished, false);
  assert.equal(f.uploaded.length, 0);
  assert.equal(f.sent.length, 0);
  f.emitter.emit('Room', f.room);
  f.emitter.emit('sync', 'SYNCING');
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(f.uploaded.length, 0);
  assert.equal(f.sent.length, 0);
  f.setCryptoEnabled(true); // No later sync event: bounded timer observes Rust completion.
  await saving;
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0][2].version, 2);
  assert.equal(f.emitter.listenerCount('Room'), 0);
  assert.equal(f.emitter.listenerCount('sync'), 0);
});
test('fresh room rejects explicit encryption downgrade without waiting or uploading', async () => {
  const f = fixture();
  f.client.getRooms = () => [];
  f.state['m.room.encryption'].algorithm = 'plaintext';
  await assert.rejects(f.store.saveArchive([record]), /downgraded/);
  assert.equal(f.sent.length, 0);
  assert.equal(f.uploaded.length, 0);
  assert.equal(f.emitter.listenerCount('Room'), 0);
});

test('fresh encrypted-room readiness has a fixed deadline and cleans up without upload', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = fixture();
  f.client.getRooms = () => [];
  f.setCryptoEnabled(false);
  const rejected = assert.rejects(f.store.saveArchive([record]), /Encrypted room sync timed out/);
  for (let i = 0; i < 10 && f.emitter.listenerCount('Room') === 0; i++) await Promise.resolve();
  assert.equal(f.emitter.listenerCount('Room'), 1);
  t.mock.timers.tick(30001);
  await rejected;
  assert.equal(f.emitter.listenerCount('Room'), 0);
  assert.equal(f.uploaded.length, 0);
  assert.equal(f.sent.length, 0);
});

test('successful friend invitation waits for peer membership, purpose and history so immediate rendering finds it', async () => {
  const f = fixture('pair');
  f.members.splice(1);
  delete f.state['org.cleanbookface.room.v1'];
  delete f.state['m.room.history_visibility'];
  let complete = false;
  const inviting = f.store.inviteFriend(friend).then((id) => {
    complete = true;
    return id;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(complete, false);
  assert.deepEqual(f.store.friendRooms(), []);
  f.members.push({ userId: friend, membership: 'invite' });
  f.emitter.emit('sync', 'SYNCING');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(complete, false);
  f.state['org.cleanbookface.room.v1'] = { purpose: 'pair' };
  f.state['m.room.history_visibility'] = { history_visibility: 'joined' };
  f.emitter.emit('sync', 'SYNCING');
  assert.equal(await inviting, f.room.roomId);
  assert.deepEqual(f.store.friendRooms(), [{ roomId: f.room.roomId, userId: friend }]);
  assert.equal(f.uploaded.length, 0);
  assert.equal(f.sent.length, 0);
});

test('SDK recipient collection rejects a third verified user inserted after the application send guard', async () => {
  const f = fixture('pair');
  let keyShares = 0;
  f.client.sendEvent = async () => {
    // Simulates RoomEncryptor's queued work after ContentStore.guard resolved.
    f.members.push({ userId: '@already-verified-third:example.org', membership: 'join' });
    const targets = await f.room.getEncryptionTargetMembers();
    keyShares += targets.length;
  };
  await assert.rejects(
    f.store.share(record, [friend]),
    /Unexpected room membership|authorized room scope/,
  );
  assert.equal(keyShares, 0);
  assert.equal(f.sent.length, 0);
});
test('recipient boundary remains fixed and returns a stable array for the SDK key-sharing path', async () => {
  const f = fixture('pair');
  f.store.friendRooms();
  const targets = await f.room.getEncryptionTargetMembers();
  f.members.push({ userId: '@third:example.org', membership: 'join' });
  assert.deepEqual(
    targets.map((member: any) => member.userId),
    [me, friend],
  );
  await assert.rejects(f.room.getEncryptionTargetMembers(), /Unexpected room membership/);
  assert.throws(() => {
    f.room.getEncryptionTargetMembers = async () => f.members;
  }, TypeError);
});

test('verification preparation does not require prior peer verification and discards pre-boundary sessions', async () => {
  const f = fixture('pair');
  let discarded = 0;
  f.c.forceDiscardSession = async () => {
    discarded++;
  };
  const store = new ContentStore(f.client, async () => {
    throw new Error('Unverified peer');
  });
  await store.prepareVerification(f.room.roomId, friend);
  assert.equal(discarded, 1);
  await f.room.getEncryptionTargetMembers();
  assert.equal(discarded, 2);
  await f.room.getEncryptionTargetMembers();
  assert.equal(discarded, 2);
});

test('35 MiB archive crosses a 25 MiB homeserver limit in authenticated bounded chunks and recovers exactly', async () => {
  const f = fixture();
  f.client.getMediaConfig = async () => ({ 'm.upload.size': 25 * 1024 * 1024 });
  f.client.uploadContent = async (blob: Blob) => {
    assert.ok(blob.size <= CONTENT_LIMITS.chunkBytes);
    f.uploaded.push(blob);
    return { content_uri: `mxc://example.org/part${f.uploaded.length - 1}` };
  };
  f.client.mxcUrlToHttp = (url: string) =>
    `https://example.org/_matrix/client/v1/media/download/example.org/${url.split('/').at(-1)}`;
  const media = new Blob([new Uint8Array(35 * 1024 * 1024).fill(7)], { type: 'video/mp4' });
  const large = {
    ...record,
    attachments: [{ path: 'synthetic.mp4', mimeType: 'video/mp4', bytes: media }],
  };
  await f.store.saveArchive([large]);
  assert.equal(f.uploaded.length, 5);
  assert.equal(f.sent.length, 1);
  const envelope = f.sent[0][2],
    p = envelope.payload;
  assert.equal(p.chunks.length, 5);
  assert.equal(p.file, undefined);
  assert.equal(
    p.size,
    f.uploaded.reduce((n, b) => n + b.size, 0),
  );
  assert.ok(JSON.stringify(envelope).length < 32768);
  assert.equal(new Set(p.chunks.map((part: any) => JSON.parse(part.info).key.k)).size, 5);
  f.events.push(f.event(envelope));
  const original = globalThis.fetch;
  globalThis.fetch = async (input) =>
    new Response(f.uploaded[Number(String(input).match(/part(\d+)$/u)![1])]);
  try {
    const restored = await f.store.privateArchive();
    assert.equal(restored.length, 1);
    assert.deepEqual(
      await crypto.subtle.digest('SHA-256', await restored[0].attachments[0].bytes.arrayBuffer()),
      await crypto.subtle.digest('SHA-256', await media.arrayBuffer()),
    );
  } finally {
    globalThis.fetch = original;
  }
});
function chunkFixture() {
  const f = fixture();
  f.client.getMediaConfig = async () => ({ 'm.upload.size': 1024 });
  f.client.uploadContent = async (blob: Blob) => {
    f.uploaded.push(blob);
    return { content_uri: `mxc://example.org/part${f.uploaded.length - 1}` };
  };
  f.client.mxcUrlToHttp = (url: string) =>
    `https://example.org/_matrix/client/v1/media/download/example.org/${url.split('/').at(-1)}`;
  return f;
}
test('chunk retry reuses accepted ciphertext parts and publishes no partial manifest', async () => {
  const f = chunkFixture();
  const normal = f.client.uploadContent;
  let attempts = 0;
  f.client.uploadContent = async (blob: Blob) => {
    if (++attempts === 2) throw new Error('Synthetic temporary upload failure');
    return normal(blob);
  };
  const input = { ...record, text: 'synthetic text '.repeat(400) };
  await assert.rejects(f.store.saveArchive([input]), /temporary upload failure/);
  assert.equal(f.uploaded.length, 1);
  assert.equal(f.sent.length, 0);
  assert.deepEqual(await f.store.privateArchive(), []);
  const first = f.uploaded[0];
  await f.store.saveArchive([input]);
  assert.equal(f.uploaded[0], first);
  assert.equal(attempts, f.uploaded.length + 1);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0][2].payload.chunks[0].url, 'mxc://example.org/part0');
});
test('validly signed hostile chunk manifests reject wrong order, missing parts, duplicate keys and invalid totals', async () => {
  const f = chunkFixture();
  await f.store.saveArchive([{ ...record, text: 'synthetic '.repeat(400) }]);
  const original = f.sent[0][2];
  assert.ok(original.payload.chunks.length > 2);
  const mutations = [
    (p: any) => {
      [p.chunks[0], p.chunks[1]] = [p.chunks[1], p.chunks[0]];
    },
    (p: any) => {
      p.chunks.splice(1, 1);
    },
    (p: any) => {
      p.chunks[1].info = p.chunks[0].info;
    },
    (p: any) => {
      p.chunks[1].url = p.chunks[0].url;
    },
    (p: any) => {
      p.size++;
    },
    (p: any) => {
      p.chunks[0].size = CONTENT_LIMITS.chunkBytes + 1;
    },
    (p: any) => {
      p.file = p.chunks[0];
    },
    (p: any) => {
      p.chunks = Array.from({ length: 33 }, (_, index) => ({ ...p.chunks[0], index }));
    },
  ];
  for (const mutate of mutations) {
    const forged = structuredClone(original);
    mutate(forged.payload);
    await f.c.signObject(forged);
    f.events.splice(0, f.events.length, f.event(forged));
    await assert.rejects(f.store.privateArchive());
  }
});
test('chunk truncation, ciphertext tampering and reordered valid parts expose no partial archive', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const attack of ['truncated', 'tampered', 'reordered', 'missing-final']) {
      const f = chunkFixture();
      await f.store.saveArchive([{ ...record, text: 'synthetic '.repeat(400) }]);
      const signed = structuredClone(f.sent[0][2]);
      if (attack === 'reordered') {
        signed.payload.chunks.reverse();
        signed.payload.chunks.forEach((part: any, index: number) => (part.index = index));
        await f.c.signObject(signed);
      }
      if (attack === 'missing-final') {
        signed.payload.size -= signed.payload.chunks.pop().size;
        await f.c.signObject(signed);
      }
      f.events.push(f.event(signed));
      globalThis.fetch = async (input) => {
        const index = Number(String(input).match(/part(\d+)$/u)![1]);
        const blob = f.uploaded[index];
        if (index === 1 && attack === 'truncated')
          return new Response(blob.slice(0, blob.size - 1));
        if (index === 1 && attack === 'tampered') {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          bytes[0] ^= 1;
          return new Response(bytes);
        }
        return new Response(blob);
      };
      await assert.rejects(f.store.privateArchive());
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('known conflicting reimport is refused before upload and existing archive remains readable', async () => {
  const f = chunkFixture();
  await f.store.saveArchive([record]);
  f.events.push(f.event(f.sent[0][2]));
  const original = globalThis.fetch;
  globalThis.fetch = async (input) =>
    new Response(f.uploaded[Number(String(input).match(/part(\d+)$/u)![1])]);
  try {
    const uploads = f.uploaded.length,
      sends = f.sent.length;
    await assert.rejects(
      f.store.saveArchive([{ ...record, text: 'changed same identity' }]),
      /Conflicting imported record identity/,
    );
    assert.equal(f.uploaded.length, uploads);
    assert.equal(f.sent.length, sends);
    assert.deepEqual(await f.store.privateArchive(), [record]);
    assert.deepEqual(f.store.archiveConflicts(), []);
  } finally {
    globalThis.fetch = original;
  }
});
test('concurrent conflicting batches preserve both versions and unrelated records with portable original-ID metadata', async () => {
  const f = chunkFixture();
  const changed = { ...record, text: 'another browser version' },
    unrelated = { ...record, id: 'unrelated', text: 'still readable' };
  // Both writers observe an empty history before either remote echo arrives.
  await f.store.saveArchive([record, unrelated]);
  const other = new ContentStore(f.client, async () => {});
  await other.saveArchive([changed]);
  f.events.push(...f.sent.map((send) => f.event(send[2])));
  const original = globalThis.fetch;
  globalThis.fetch = async (input) =>
    new Response(f.uploaded[Number(String(input).match(/part(\d+)$/u)![1])]);
  try {
    const restored = await f.store.privateArchive();
    assert.equal(restored.length, 3);
    const versions = restored.filter((r) => r.conflictOf === record.id);
    assert.equal(versions.length, 2);
    assert.equal(new Set(versions.map((r) => r.id)).size, 2);
    assert.deepEqual(versions.map((r) => r.text).sort(), [record.text, changed.text].sort());
    for (const version of versions) {
      assert.equal(version.title, record.title);
      assert.equal(version.sourcePath, record.sourcePath);
      assert.deepEqual(version.provenance, record.provenance);
    }
    assert.equal(restored.find((r) => r.id === 'unrelated')!.text, 'still readable');
    assert.deepEqual(f.store.archiveConflicts(), [
      { originalId: record.id, versionIds: versions.map((r) => r.id).sort() },
    ]);
    const roundtrip = await importArchives([
      new File([await exportArchives(restored)], 'versions.zip'),
    ]);
    assert.deepEqual(roundtrip.records, restored);
    const fresh = chunkFixture();
    await fresh.store.saveArchive(roundtrip.records);
    assert.equal(fresh.sent.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('49,000 existing plus 2,000 new records refuse before upload; concurrent overflow stays readable and every batch exports', async () => {
  const f = chunkFixture();
  f.client.getMediaConfig = async () => ({ 'm.upload.size': 25 * 1024 * 1024 });
  const make = (prefix: string, count: number): MemoryRecord[] =>
    Array.from({ length: count }, (_, i) => ({
      id: `${prefix}-${i}`,
      kind: 'post',
      timestamp: 0,
      text: '',
      title: '',
      sourcePath: '',
      privateOnly: false,
      attachments: [],
    }));
  const before = make('existing', 49000),
    after = make('new', 2000),
    last = make('last', 1);
  await f.store.saveArchive(before);
  f.events.push(f.event(f.sent[0][2]));
  const original = globalThis.fetch;
  const fetched: string[] = [];
  globalThis.fetch = async (input) => {
    fetched.push(String(input));
    return new Response(f.uploaded[Number(String(input).match(/part(\d+)$/u)![1])]);
  };
  try {
    const uploads = f.uploaded.length,
      sends = f.sent.length;
    await assert.rejects(f.store.saveArchive(after), /Combined archive preview limit/);
    assert.equal(f.uploaded.length, uploads);
    assert.equal(f.sent.length, sends);
    assert.equal(f.store.archiveOverflow(), null);
    // A stale second browser observes no remote echoes and can independently
    // publish its valid batch. No single client can atomically stop that race.
    f.events.splice(0);
    const stale = new ContentStore(f.client, async () => {});
    await stale.saveArchive(after);
    await stale.saveArchive(last);
    f.events.push(...f.sent.map((send) => f.event(send[2])));
    fetched.splice(0);
    const visible = await f.store.privateArchive();
    assert.equal(visible.length, 50000);
    assert.equal(f.store.archiveOverflow()?.reason, 'records');
    assert.equal(f.store.archiveOverflow()?.visibleRecords, 50000);
    const lastPayload = f.sent.at(-1)[2].payload;
    assert.ok(!fetched.some((url) => url.endsWith(lastPayload.file.url.split('/').at(-1))));
    const first = await f.store.archiveBatches(undefined, 1);
    assert.equal(first.batches.length, 1);
    assert.ok(first.nextCursor);
    const second = await f.store.archiveBatches(first.nextCursor, 1);
    assert.equal(second.batches.length, 1);
    assert.ok(second.nextCursor);
    const third = await f.store.archiveBatches(second.nextCursor, 1);
    assert.equal(third.batches.length, 1);
    assert.equal(third.nextCursor, undefined);
    const exported = await f.store.downloadArchiveBatch(
      second.batches[0].roomId,
      second.batches[0].eventId,
    );
    assert.equal((await importArchives([new File([exported], 'batch.zip')])).records.length, 2000);
    const lastExport = await f.store.downloadArchiveBatch(
      third.batches[0].roomId,
      third.batches[0].eventId,
    );
    assert.equal(
      (await importArchives([new File([lastExport], 'last.zip')])).records[0].id,
      'last-0',
    );
    await assert.rejects(f.store.saveArchive(make('further', 1)), /preview limit reached/);
  } finally {
    globalThis.fetch = original;
  }
});

test('concurrent first imports in two validated archive rooms union and new writes select the deterministic room', async () => {
  const a = fixture(),
    b = fixture();
  a.room.roomId = '!a:example.org';
  b.room.roomId = '!b:example.org';
  const blobs: Blob[] = [];
  const upload = async (blob: Blob) => {
    blobs.push(blob);
    return { content_uri: `mxc://example.org/part${blobs.length - 1}` };
  };
  for (const f of [a, b]) {
    f.client.uploadContent = upload;
    f.client.mxcUrlToHttp = (url: string) =>
      `https://example.org/_matrix/client/v1/media/download/example.org/${url.split('/').at(-1)}`;
  }
  await a.store.saveArchive([{ ...record, id: 'first-device' }]);
  await b.store.saveArchive([{ ...record, id: 'second-device' }]);
  a.events.push(a.event(a.sent[0][2]));
  b.events.push(b.event(b.sent[0][2]));
  const client = {
    ...a.client,
    getRooms: () => [b.room, a.room],
    getRoom: (id: string) => [a.room, b.room].find((room) => room.roomId === id),
  };
  const store = new ContentStore(client, async () => {}),
    original = globalThis.fetch;
  globalThis.fetch = async (input) =>
    new Response(blobs[Number(String(input).match(/part(\d+)$/u)![1])]);
  try {
    assert.deepEqual(
      (await store.privateArchive()).map((r) => r.id),
      ['first-device', 'second-device'],
    );
    assert.equal(store.archiveOverflow(), null);
    await store.saveArchive([{ ...record, id: 'later' }]);
    assert.equal(a.sent.at(-1)[0], a.room.roomId);
    const page = await store.archiveBatches();
    assert.equal(page.batches.length, 2);
    for (const batch of page.batches)
      assert.equal(
        (
          await importArchives([
            new File([await store.downloadArchiveBatch(batch.roomId, batch.eventId)], 'batch.zip'),
          ])
        ).records.length,
        1,
      );
    b.members.push({ userId: '@intruder:example.org', membership: 'invite' });
    await assert.rejects(
      store.downloadArchiveBatch(b.room.roomId, b.events[0].getId()),
      /Unexpected room membership/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('archive manifest pagination stays bounded across rooms without downloading record bytes', async () => {
  const base = fixture();
  await base.store.saveArchive([record]);
  const rooms: ReturnType<typeof fixture>[] = [];
  for (let i = 0; i < 17; i++) {
    const f = fixture();
    f.room.roomId = `!room${String(i).padStart(2, '0')}:example.org`;
    const signed = structuredClone(base.sent[0][2]);
    signed.room_id = f.room.roomId;
    await f.c.signObject(signed);
    f.events.push(f.event(signed));
    rooms.push(f);
  }
  const client = {
    ...base.client,
    getRooms: () => rooms.map((f) => f.room),
    getRoom: (id: string) => rooms.find((f) => f.room.roomId === id)?.room,
  };
  const store = new ContentStore(client, async () => {}),
    original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('Manifest listing must not download media');
  };
  try {
    const first = await store.archiveBatches(undefined, 100);
    assert.equal(first.batches.length, 16);
    assert.ok(first.nextCursor);
    const second = await store.archiveBatches(first.nextCursor, 100);
    assert.equal(second.batches.length, 1);
    assert.equal(second.nextCursor, undefined);
    await assert.rejects(store.archiveBatches(undefined, 101), /page size/);
    await assert.rejects(
      store.archiveBatches(encodeURIComponent(JSON.stringify({ roomId: '!missing:example.org' }))),
      /stale/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('aggregate decoded-byte window stops before later batches while retaining already validated records', async () => {
  const f = fixture();
  for (let i = 0; i < 6; i++) await f.store.saveArchive([{ ...record, id: `batch-${i}` }]);
  f.events.push(...f.sent.map((send) => f.event(send[2])));
  // Isolate the window from transport: six individually legal decoded 60 MiB
  // batches share one immutable Blob allocation. Real chunk crypto is exercised
  // by the separate 35 MiB round-trip and tampering tests above.
  const media = new Blob([new Uint8Array(60 * 1024 * 1024)]);
  let decoded = 0;
  (f.store as unknown as { download: (p: unknown) => Promise<MemoryRecord[]> }).download =
    async () => [
      {
        ...record,
        id: `decoded-${decoded++}`,
        attachments: [{ path: 'synthetic.mp4', mimeType: 'video/mp4', bytes: media }],
      },
    ];
  const visible = await f.store.privateArchive();
  assert.equal(visible.length, 4);
  assert.equal(decoded, 5);
  assert.equal(f.store.archiveOverflow()?.reason, 'bytes');
  assert.ok(f.store.archiveOverflow()!.visibleBytes <= CONTENT_LIMITS.visibleBytes);
});

test('a conflict crossing the byte window preserves both versions and marks the view partial', async () => {
  const f = fixture();
  for (let i = 0; i < 6; i++) await f.store.saveArchive([{ ...record, id: `batch-${i}` }]);
  f.events.push(...f.sent.map((send) => f.event(send[2])));
  const media = new Blob([new Uint8Array(60 * 1024 * 1024)]);
  let decoded = 0;
  (f.store as unknown as { download: (p: unknown) => Promise<MemoryRecord[]> }).download =
    async () => {
      const index = decoded++;
      return [
        {
          ...record,
          id: index === 4 ? 'decoded-0' : `decoded-${index}`,
          text: `Version ${index}`,
          attachments: [{ path: 'synthetic.mp4', mimeType: 'video/mp4', bytes: media }],
        },
      ];
    };
  const visible = await f.store.privateArchive();
  assert.equal(decoded, 5);
  assert.equal(visible.length, 4);
  assert.deepEqual(
    visible
      .filter((r) => r.conflictOf === 'decoded-0')
      .map((r) => r.text)
      .sort(),
    ['Version 0', 'Version 4'],
  );
  assert.equal(
    visible.some((r) => r.id === 'decoded-3'),
    false,
  );
  assert.equal(f.store.archiveConflicts()[0].partial, true);
  assert.equal(f.store.archiveConflicts()[0].versionIds.length, 2);
  assert.equal(f.store.archiveOverflow()?.reason, 'bytes');
});

test('slow valid batch decoding preserves the visible archive with explicit history overflow', async () => {
  const f = fixture();
  await f.store.saveArchive([record]);
  await f.store.saveArchive([{ ...record, id: 'second' }]);
  f.events.push(...f.sent.map((send) => f.event(send[2])));
  const original = Date.now;
  let now = original();
  Date.now = () => now;
  (f.store as unknown as { download: (p: unknown) => Promise<MemoryRecord[]> }).download =
    async () => {
      now += 31000;
      return [record];
    };
  try {
    assert.equal((await f.store.privateArchive()).length, 1);
    assert.equal(f.store.archiveOverflow()?.reason, 'history');
  } finally {
    Date.now = original;
  }
});

test('scan time exhaustion returns validated manifest pages and resumes without hiding integrity errors', async () => {
  const f = fixture();
  await f.store.saveArchive([record]);
  await f.store.saveArchive([{ ...record, id: 'second' }]);
  f.events.push(...f.sent.map((send) => f.event(send[2])));
  const original = Date.now;
  let now = original();
  Date.now = () => now;
  const decrypt = f.client.decryptEventIfNeeded;
  f.client.decryptEventIfNeeded = async (...args: unknown[]) => {
    await decrypt(...args);
    now += 31000;
  };
  try {
    const first = await f.store.archiveBatches();
    assert.equal(first.batches.length, 1);
    assert.ok(first.nextCursor);
    const second = await f.store.archiveBatches(first.nextCursor);
    assert.equal(second.batches.length, 1);
    assert.notEqual(first.batches[0].eventId, second.batches[0].eventId);
    f.client.decryptEventIfNeeded = async () => {
      throw new Error('Integrity failure');
    };
    await assert.rejects(f.store.archiveBatches(), /Integrity failure/);
    await assert.rejects(f.store.privateArchive(), /Integrity failure/);
  } finally {
    Date.now = original;
  }
});
