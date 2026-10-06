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
    getLiveTimeline: () => ({
      getEvents: () => events,
      setPaginationToken: (token: string | null) => {
        room.oldState.paginationToken = token;
      },
    }),
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
    isUserIgnored: () => false,
    getAccountData: () => undefined,
    getUserId: () => me,
    getDeviceId: () => 'DEVICE',
    getCrypto: () => c,
    getRoom: () => room,
    getRooms: () => [room],
    http: { authedRequest: async () => ({ event: { event_id: events[0]?.getId() }, start: null }) },
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
  assert.equal(f.uploaded.length, 2);
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
    assert.equal(f.uploaded.length, 2);
    assert.equal(f.sent.length, 0);
  }
});
test('sharing strips provenance and source path; verified users required and retries deduplicate', async () => {
  const f = fixture('pair');
  await f.store.share(record, [friend, friend], 'stable-share-operation');
  await f.store.share(record, [friend], 'stable-share-operation');
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
    assert.deepEqual(post.record.provenance ?? {}, {});
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
test('signed text feed avoids media download but never bypasses changed device trust', async () => {
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
    assert.equal(requests, 0);
    f.setDeviceVerified(false);
    assert.deepEqual(await f.store.posts(), []);
    assert.equal(f.store.lockedRooms().length, 1);
    assert.equal(requests, 0);
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

test('a deliberate valid reinvitation restores a revoked friendship in the same session', async () => {
  const f = fixture('pair');
  await f.store.revokeFriend(friend);
  f.client.isUserIgnored = (id: string) => id === friend;
  f.members[0].membership = 'invite';
  await assert.rejects(f.store.acceptInvite(f.room.roomId), /blocked/);
  assert.equal(f.members[0].membership, 'invite');
  f.client.isUserIgnored = () => false;
  await f.store.acceptInvite(f.room.roomId);
  assert.deepEqual(f.store.friendRooms(), [{ roomId: f.room.roomId, userId: friend }]);
  await f.store.share(record, [friend]);
  assert.equal(f.sent.length, 1);
});

test('reinvitation keeps revocation after hostile joined state or a new block', async () => {
  for (const attack of ['extra-member', 'block-during-join']) {
    const f = fixture('pair');
    await f.store.revokeFriend(friend);
    f.members[0].membership = 'invite';
    f.client.joinRoom = async () => {
      f.members[0].membership = 'join';
      if (attack === 'extra-member')
        f.members.push({ userId: '@intruder:example.org', membership: 'join' });
      else f.client.isUserIgnored = (id: string) => id === friend;
    };
    await assert.rejects(f.store.acceptInvite(f.room.roomId), /membership|blocked/);
    assert.equal(f.members[0].membership, 'leave');
    f.members.splice(2);
    f.client.isUserIgnored = () => false;
    // Even if the host now reports an ordinary joined room, a failed
    // acceptance must not have lifted this session's prior revocation.
    f.members[0].membership = 'join';
    assert.deepEqual(f.store.friendRooms(), []);
    await assert.rejects(f.store.share(record, [friend]));
    assert.equal(f.sent.length, 0);
    assert.equal(f.uploaded.length, 0);
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
  assert.equal(f.uploaded.length, 6);
  assert.equal(f.sent.length, 1);
  const envelope = f.sent[0][2],
    p = envelope.payload;
  assert.equal(p.chunks.length, 5);
  assert.equal(p.file, undefined);
  assert.equal(
    p.size,
    f.uploaded.slice(0, p.chunks.length).reduce((n, b) => n + b.size, 0),
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

test('encrypted social writes bind room and post, retry and remove through authenticated history', async () => {
  const f = fixture('pair');
  await f.store.share(record, [friend]);
  f.events.push(f.event(f.sent[0][2]));
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(f.uploaded[0]);
  try {
    const [post] = await f.store.posts();
    const op = 'comment-operation-1';
    await f.store.addComment(post, 'COMMENT MARKER', op);
    const first = f.sent.at(-1);
    assert.equal(first[2].room_id, post.roomId);
    assert.equal(first[2].payload.postId, post.id);
    assert.equal(first[2].payload.postSender, me);
    f.events.push(f.event(first[2]));
    await f.store.addComment(post, 'COMMENT MARKER', op);
    assert.equal(f.sent.at(-1)[3], first[3]);
    assert.equal((await f.store.posts())[0].comments.length, 1);
    await assert.rejects(f.store.addComment(post, 'changed', op), /Conflicting/);
    await f.store.removeComment(post, op, 'remove-comment-operation');
    f.events.push(f.event(f.sent.at(-1)[2]));
    assert.deepEqual((await f.store.posts())[0].comments, []);
    await f.store.removePost(post, 'remove-post-operation');
    f.events.push(f.event(f.sent.at(-1)[2]));
    assert.deepEqual(await f.store.posts(), []);
    await assert.rejects(f.store.addComment(post, 'later', 'another-operation'), /removed/);
  } finally {
    globalThis.fetch = original;
  }
});

test('social plaintext and forged signatures are quarantined without hiding valid posts', async () => {
  for (const mode of ['plaintext', 'forged']) {
    const f = fixture('pair');
    await f.store.share(record, [friend]);
    f.events.push(f.event(f.sent[0][2]));
    const post = {
      eventId: '$post',
      id: f.sent[0][2].payload.id,
      roomId: f.room.roomId,
      sender: me,
      timestamp: 1,
      record,
      comments: [],
      reactions: [],
    };
    await f.store.addComment(post, 'secret', 'comment-operation');
    const signed = structuredClone(f.sent.at(-1)[2]);
    if (mode === 'forged') signed.payload.postSender = friend;
    f.events.push(f.event(signed, { encrypted: mode !== 'plaintext' }));
    const posts = await f.store.posts();
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].comments, []);
    assert.equal(f.store.unavailableContent().length, 1);
    assert.equal(f.store.lockedRooms().length, 1);
  }
});

test('persistent ignored users cannot invite, accept, read or send into pairwise rooms', async () => {
  const f = fixture('pair');
  await f.store.share(record, [friend]);
  const post = {
    eventId: '$post',
    id: f.sent[0][2].payload.id,
    roomId: f.room.roomId,
    sender: me,
    timestamp: 1,
    record,
    comments: [],
    reactions: [],
  };
  f.client.isUserIgnored = (id: string) => id === friend;
  assert.deepEqual(f.store.friendRooms(), []);
  assert.deepEqual(await f.store.posts(), []);
  await assert.rejects(f.store.inviteFriend(friend), /blocked/);
  await assert.rejects(f.store.acceptInvite(f.room.roomId), /blocked/);
  await assert.rejects(f.store.addComment(post, 'blocked', 'blocked-operation'), /friendship/);
  await assert.rejects(f.store.prepareVerification(f.room.roomId, friend), /blocked/);
});

test('large-archive batch retry authenticates prior parts without downloading their media', async () => {
  const f = fixture();
  const first = await f.store.appendArchiveBatch([record]);
  assert.equal(first.stored, true);
  f.events.push(f.event(f.sent[0][2]));
  const resumed = new ContentStore(f.client, async () => {});
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('Old media must not be downloaded to resume an import');
  };
  try {
    const retry = await resumed.appendArchiveBatch([record]);
    assert.deepEqual(retry, { ...first, stored: false });
    assert.equal(f.uploaded.length, 2);
    assert.equal(f.sent.length, 1);
    const second = await resumed.appendArchiveBatch([
      { ...record, id: 'second', text: 'Another private memory' },
    ]);
    assert.equal(second.stored, true);
    assert.notEqual(second.id, first.id);
    assert.equal(f.uploaded.length, 4);
  } finally {
    globalThis.fetch = original;
  }
});

test('batch append refuses tampered existing history before uploading anything new', async () => {
  const f = fixture();
  await f.store.appendArchiveBatch([record]);
  const forged = structuredClone(f.sent[0][2]);
  forged.payload.id = '0'.repeat(64);
  f.events.push(f.event(forged));
  await assert.rejects(f.store.appendArchiveBatch([{ ...record, id: 'other' }]));
  assert.equal(f.uploaded.length, 2);
});

test('archive search decrypts locally and returns bounded excerpts without media or provenance', async () => {
  const f = fixture();
  await f.store.appendArchiveBatch([
    record,
    { ...record, id: 'another', text: 'PLANTED PRIVATE TEXT again' },
  ]);
  f.events.push(f.event(f.sent[0][2]));
  const original = globalThis.fetch;
  const fetched: string[] = [];
  globalThis.fetch = async (input) => {
    fetched.push(String(input));
    return new Response(f.uploaded[0]);
  };
  try {
    const result = await f.store.searchArchive('planted', 1);
    assert.equal(result.matches.length, 1);
    assert.equal(result.limited, true);
    assert.equal(result.matches[0].recordId, record.id);
    assert.ok(result.matches[0].excerpt.includes(record.text));
    assert.ok(!JSON.stringify(result).includes('PRIVATE PROVENANCE'));
    assert.ok(fetched.every((url) => !url.includes('planted')));
    const all = await f.store.searchArchive('planted', 50);
    assert.equal(all.matches.length, 2);
    assert.equal(all.limited, false);
    assert.equal(all.partsChecked, 1);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(f.store.searchArchive('planted', 50, undefined, controller.signal));
    await assert.rejects(f.store.searchArchive('x'));
  } finally {
    globalThis.fetch = original;
  }
});

test('partial archive view quarantines a bad event while verified parts remain readable and exportable', async () => {
  for (const mode of ['missing-key', 'plaintext', 'forged-signature', 'wrong-sender']) {
    const f = fixture();
    await f.store.saveArchive([record]);
    const signed = f.sent[0][2];
    const invalid = structuredClone(signed);
    if (mode === 'forged-signature') invalid.payload.id = '0'.repeat(64);
    const bad = f.event(invalid, {
      encrypted: mode !== 'plaintext',
      sender: mode === 'wrong-sender' ? '@outsider:example.org' : me,
    });
    bad.getId = () => '$unavailable';
    if (mode === 'missing-key') bad.isDecryptionFailure = () => true;
    const good = f.event(signed);
    f.events.push(bad, good);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(await f.uploaded[0].arrayBuffer());
    try {
      await assert.rejects(f.store.privateArchive());
      assert.deepEqual(await f.store.privateArchiveView(), [record]);
      assert.deepEqual(f.store.unavailableContent(), [
        {
          roomId: f.room.roomId,
          eventId: '$unavailable',
          reason: mode === 'missing-key' ? 'missing-key' : 'integrity',
        },
      ]);
      const page = await f.store.archiveBatches(undefined, 50, true);
      assert.equal(page.batches.length, 1);
      assert.equal(page.batches[0].eventId, good.getId());
      const bytes = await f.store.downloadArchiveBatch(f.room.roomId, good.getId());
      const imported = await importArchives([new File([bytes], 'available.zip')]);
      assert.deepEqual(imported.records, [record]);
      await assert.rejects(f.store.downloadArchiveBatch(f.room.roomId, '$unavailable'));
      assert.deepEqual(
        (await f.store.searchArchive('PLANTED')).matches.map((r) => r.recordId),
        [record.id],
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});

test('deliberate re-sharing after removal has a fresh identity while retries keep one identity', async () => {
  const f = fixture('pair');
  await f.store.share(record, [friend], 'first-share-operation');
  f.events.push(f.event(f.sent.at(-1)[2]));
  const first = (await f.store.posts())[0];
  await f.store.removePost(first, 'remove-first-operation');
  f.events.push(f.event(f.sent.at(-1)[2]));
  await f.store.share(record, [friend], 'second-share-operation');
  const second = f.sent.at(-1);
  f.events.push(f.event(second[2]));
  await f.store.share(record, [friend], 'second-share-operation');
  assert.equal(f.sent.at(-1)[3], second[3]);
  const posts = await f.store.posts();
  assert.equal(posts.length, 1);
  assert.notEqual(posts[0].id, first.id);
  assert.equal(posts[0].sharedAt, 123);
  assert.equal(posts[0].originalTimestamp, 1000);
});

test('a blocked recipient does not prevent a separately verified recipient receiving a share', async () => {
  const f = fixture('pair'),
    blocked = '@blocked:example.org';
  f.client.isUserIgnored = (user: string) => user === blocked;
  const result = await f.store.share(record, [blocked, friend], 'mixed-share-operation');
  assert.deepEqual(
    result.outcomes.map((o) => [o.userId, o.status]),
    [
      [blocked, 'failed'],
      [friend, 'sent'],
    ],
  );
  assert.equal(f.sent.length, 1);
  await assert.rejects(f.store.share(record, [blocked], 'blocked-share-operation'), /Friendship/);
});

test('feed pages merge authenticated room metadata chronologically before downloading media', async () => {
  const a = fixture('pair'),
    b = fixture('pair');
  b.room.roomId = '!second:example.org';
  await a.store.share({ ...record, text: 'Older' }, [friend]);
  a.events.push({ ...a.event(a.sent[0][2]), getTs: () => 100 });
  await b.store.share({ ...record, text: 'Newest' }, [friend]);
  b.events.push({ ...b.event(b.sent[0][2]), getTs: () => 200 });
  a.client.getRooms = () => [a.room, b.room];
  a.client.getRoom = (id: string) => (id === a.room.roomId ? a.room : b.room);
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('Text metadata must not fetch media');
  };
  try {
    const first = await a.store.postsPage(undefined, 1);
    assert.equal(first.posts[0].record.text, 'Newest');
    assert.ok(first.nextCursor);
    const next = await a.store.postsPage(first.nextCursor, 1);
    assert.equal(next.posts[0].record.text, 'Older');
    assert.equal(next.nextCursor, undefined);
  } finally {
    globalThis.fetch = fetch;
  }
});

test('departed conversation history exports private posts and removed comments across explicit pages', async () => {
  const f = fixture('pair');
  await f.store.share(record, [friend]);
  f.events.push(f.event(f.sent[0][2]));
  const post = (await f.store.posts())[0];
  await f.store.addComment(post, 'OWN COMMENT TO KEEP', 'export-comment-operation');
  f.events.push(f.event(f.sent.at(-1)[2]));
  await f.store.removeComment(post, 'export-comment-operation', 'export-remove-operation');
  f.events.push(f.event(f.sent.at(-1)[2]));
  f.members[1].membership = 'leave';
  assert.equal(f.store.conversationRooms()[0].readOnly, true);
  assert.equal((await f.store.posts())[0].readOnly, true);
  await assert.rejects(
    f.store.addComment(post, 'must not send', 'after-leave-operation'),
    /friendship/,
  );
  const first = await f.store.exportConversationPage(f.room.roomId, undefined, 1);
  assert.ok(first.nextCursor);
  const next = await f.store.exportConversationPage(f.room.roomId, first.nextCursor, 1);
  assert.equal(next.nextCursor, undefined);
  const records = [
    ...(await importArchives([new File([first.blob], 'part1.zip')])).records,
    ...(await importArchives([new File([next.blob], 'part2.zip')])).records,
  ];
  assert.ok(records.every((r) => r.privateOnly));
  assert.ok(records.some((r) => r.text === record.text));
  const summary = records.find((r) => r.provenance?.conversationExport)!;
  assert.equal((summary.provenance!.conversationExport as any).includesRemoved, true);
  assert.match(summary.text, /Includes earlier copies.*marked removed/);
  const comment = records.find((r) => r.text === 'OWN COMMENT TO KEEP')!;
  assert.ok(comment);
  assert.equal((comment.provenance!.conversation as any).removed, true);
  f.members[0].membership = 'leave';
  assert.ok((await f.store.exportConversation(f.room.roomId)).size);
});

test('incremental archive append rechecks its anchor and refuses mutations of an accepted prefix', async () => {
  const f = fixture();
  for (let i = 0; i < 12; i++) {
    await f.store.appendArchiveBatch([{ ...record, id: `r${i}` }]);
    f.events.push(f.event(f.sent.at(-1)[2]));
  }
  await f.store.appendArchiveBatch([{ ...record, id: 'r11' }]);
  let identities = 0;
  const get = f.c.getOlmMachineOrThrow;
  f.c.getOlmMachineOrThrow = () => {
    const machine = get();
    return {
      ...machine,
      getIdentity: async (...args: any[]) => {
        identities++;
        return machine.getIdentity(...args);
      },
    };
  };
  await f.store.appendArchiveBatch([{ ...record, id: 'r11' }]);
  assert.ok(identities <= 4, `expected only the current anchor, got ${identities} identity reads`);
  f.sent[0][2].payload.id = '0'.repeat(64);
  const uploads = f.uploaded.length;
  await assert.rejects(
    f.store.appendArchiveBatch([{ ...record, id: 'never' }]),
    (error: any) =>
      error.code === 'ARCHIVE_HISTORY_UNAVAILABLE' && /signature/.test(error.cause?.message),
  );
  assert.equal(f.uploaded.length, uploads);
});

test('v3 photos remain encrypted and lazy until hydration, which rechecks trust and exact hashes', async () => {
  const sharp = (await import('sharp')).default;
  const encoded = await sharp({
    create: { width: 2, height: 2, channels: 3, background: { r: 40, g: 100, b: 170 } },
  })
    .jpeg()
    .toBuffer();
  const photo = new Blob([new Uint8Array(encoded)], { type: 'image/jpeg' });
  const globals = globalThis as any,
    previousBitmap = globals.createImageBitmap,
    previousDocument = globals.document,
    previousFetch = globalThis.fetch;
  globals.createImageBitmap = async () => ({ width: 2, height: 2, close() {} });
  globals.document = {
    createElement: () => ({
      width: 2,
      height: 2,
      getContext: () => ({ fillRect() {}, drawImage() {} }),
      toBlob: (callback: (blob: Blob) => void) => callback(photo),
    }),
  };
  try {
    const f = fixture('pair');
    await f.store.share(
      {
        ...record,
        attachments: [{ path: 'private-name.jpg', mimeType: 'image/jpeg', bytes: photo }],
      },
      [friend],
      'photo-operation-123',
    );
    assert.equal(f.uploaded.length, 1);
    assert.equal(f.sent[0][2].payload.version, 3);
    assert.equal(JSON.stringify(f.sent[0][2]).includes('private-name'), false);
    assert.notDeepEqual(
      new Uint8Array(await f.uploaded[0].arrayBuffer()),
      new Uint8Array(await photo.arrayBuffer()),
    );
    f.events.push(f.event(f.sent[0][2]));
    let downloads = 0;
    globalThis.fetch = async () => {
      downloads++;
      return new Response(f.uploaded[0]);
    };
    const page = await f.store.postsPage();
    assert.equal(downloads, 0);
    assert.equal(page.posts[0].mediaLoaded, false);
    assert.equal(page.posts[0].record.attachments.length, 0);
    const loaded = await f.store.hydratePost(page.posts[0]);
    assert.equal(downloads, 1);
    assert.equal(loaded.mediaLoaded, true);
    assert.deepEqual(
      new Uint8Array(await loaded.record.attachments[0].bytes.arrayBuffer()),
      new Uint8Array(await photo.arrayBuffer()),
    );
    const damaged = new Uint8Array(await f.uploaded[0].arrayBuffer());
    damaged[0] ^= 1;
    globalThis.fetch = async () => new Response(damaged);
    await assert.rejects(f.store.hydratePost(page.posts[0]));
    f.setDeviceVerified(false);
    globalThis.fetch = async () => {
      throw new Error('Must refuse changed trust before network');
    };
    await assert.rejects(f.store.hydratePost(page.posts[0]), /Untrusted/);
  } finally {
    globals.createImageBitmap = previousBitmap;
    globals.document = previousDocument;
    globalThis.fetch = previousFetch;
  }
});

test('legacy v2 canonical post archives remain readable', async () => {
  const f = fixture('pair');
  const copy = { ...record, id: 'a'.repeat(64), sourcePath: '', provenance: {} };
  const p = await (f.store as any).upload([copy], 'post');
  await (f.store as any).send(f.room.roomId, p, friend);
  f.events.push(f.event(f.sent[0][2]));
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(f.uploaded[0]);
  try {
    const [post] = await f.store.posts();
    assert.equal(post.record.text, record.text);
    assert.equal(post.mediaLoaded, true);
  } finally {
    globalThis.fetch = fetch;
  }
});

test('installed SDK client room identity is the same object retained by its Rust room encryptor', async () => {
  const { createClient, MemoryStore, Room, MatrixEvent } = await import('matrix-js-sdk');
  const { RustCrypto } = await import('matrix-js-sdk/lib/rust-crypto/rust-crypto.js');
  const { initAsync } = await import('@matrix-org/matrix-sdk-crypto-wasm');
  await initAsync();
  const store = new MemoryStore(),
    client = createClient({ baseUrl: 'https://example.org', userId: me, store });
  const room = new Room('!real-room:example.org', client, me);
  store.storeRoom(room);
  const quiet: any = {
    warn() {},
    error() {},
    debug() {},
    info() {},
    getChild() {
      return quiet;
    },
  };
  const backend: any = {
    logger: quiet,
    roomEncryptors: {},
    olmMachine: { setRoomSettings: async () => {}, updateTrackedUsers: async () => {} },
    keyClaimManager: {},
    outgoingRequestsManager: {},
  };
  const encryption = new MatrixEvent({
    type: 'm.room.encryption',
    room_id: room.roomId,
    state_key: '',
    content: { algorithm: 'm.megolm.v1.aes-sha2' },
  });
  await RustCrypto.prototype.onCryptoEvent.call(backend, client.getRoom(room.roomId)!, encryption);
  assert.equal(client.getRoom(room.roomId), room);
  assert.equal(backend.roomEncryptors[room.roomId].room, client.getRoom(room.roomId));
  await RustCrypto.prototype.onCryptoEvent.call(backend, client.getRoom(room.roomId)!, encryption);
  assert.equal(backend.roomEncryptors[room.roomId].room, client.getRoom(room.roomId));
});

test('archive search skips a corrupt saved part and still searches later authenticated parts', async () => {
  const f = fixture();
  f.client.uploadContent = async (blob: Blob) => {
    f.uploaded.push(blob);
    return { content_uri: `mxc://example.org/part-${f.uploaded.length - 1}` };
  };
  f.client.mxcUrlToHttp = (uri: string) =>
    `https://example.org/_matrix/client/v1/media/download/example.org/${uri.split('/').pop()}`;
  await f.store.appendArchiveBatch([{ ...record, id: 'bad', text: 'bad part' }]);
  f.events.push(f.event(f.sent.at(-1)[2]));
  await f.store.appendArchiveBatch([{ ...record, id: 'good', text: 'searchable later part' }]);
  f.events.push(f.event(f.sent.at(-1)[2]));
  const fetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const index = Number(String(url).split('-').pop());
    const bytes = new Uint8Array(await f.uploaded[index].arrayBuffer());
    if (index < 2) bytes[0] ^= 1;
    return new Response(bytes);
  };
  try {
    const result = await f.store.searchArchive('searchable');
    assert.deepEqual(
      result.matches.map((hit) => hit.recordId),
      ['good'],
    );
    assert.equal(result.partsChecked, 2);
    assert.equal(f.store.unavailableContent().length, 1);
  } finally {
    globalThis.fetch = fetch;
  }
});

test('a different Room object retained by the SDK encryptor fails before any share', async () => {
  const f = fixture('pair');
  f.c.roomEncryptors = { [f.room.roomId]: { room: { ...f.room } } };
  await assert.rejects(f.store.share(record, [friend]), /Friendship|SDK room identity mismatch/);
  assert.equal(f.sent.length, 0);
  assert.equal(f.uploaded.length, 0);
});

test('previously verified historical posts remain unavailable after the signing master changes', async () => {
  const f = fixture('pair');
  await f.store.share(record, [friend]);
  f.events.push(f.event(f.sent[0][2]));
  assert.equal((await f.store.posts()).length, 1);
  const replacement = generateKeyPairSync('ed25519')
    .publicKey.export({ type: 'spki', format: 'der' })
    .subarray(-32)
    .toString('base64')
    .replace(/=+$/u, '');
  f.c.getOlmMachineOrThrow = () => ({
    getIdentity: async () => ({
      free() {},
      isVerified: () => true,
      hasVerificationViolation: () => false,
      identityNeedsUserApproval: () => false,
      masterKey: JSON.stringify({
        user_id: me,
        usage: ['master'],
        keys: { [`ed25519:${replacement}`]: replacement },
      }),
    }),
  });
  assert.deepEqual(await f.store.posts(), []);
  assert.equal(f.store.lockedRooms().length, 1);
  const exported = await importArchives([
    new File([await f.store.exportConversation(f.room.roomId)], 'history.zip'),
  ]);
  assert.equal(
    exported.records.some((r) => r.text === record.text),
    false,
  );
  assert.equal((exported.records[0].provenance!.conversationExport as any).unavailable.length, 1);
});

test('every conversation remains selectable beyond the bounded aggregate feed room window', async () => {
  const fixtures = Array.from({ length: 17 }, () => fixture('pair'));
  for (const [index, f] of fixtures.entries()) {
    f.room.roomId = `!room${String(index).padStart(2, '0')}:example.org`;
    await f.store.share({ ...record, text: `Room ${index}` }, [friend]);
    f.events.push(f.event(f.sent[0][2]));
  }
  const f = fixtures[0];
  f.client.getRooms = () => fixtures.map((f) => f.room);
  f.client.getRoom = (id: string) => fixtures.find((f) => f.room.roomId === id)?.room;
  const aggregate = await f.store.postsPage();
  assert.equal(aggregate.posts.length, 16);
  assert.equal(aggregate.limited, true);
  const selected = await f.store.postsPage(undefined, 20, fixtures[16].room.roomId);
  assert.equal(selected.posts.length, 1);
  assert.equal(selected.posts[0].record.text, 'Room 16');
  assert.equal(selected.limited, undefined);
});

test('an older asynchronous feed refresh cannot replace the newer cursor snapshot', async () => {
  const f = fixture('pair');
  for (let i = 0; i < 2; i++) {
    await f.store.share({ ...record, text: `Post ${i}` }, [friend]);
    f.events.push(f.event(f.sent.at(-1)[2]));
  }
  let release!: () => void,
    started!: () => void,
    calls = 0;
  const wait = new Promise<void>((resolve) => {
      release = resolve;
    }),
    entered = new Promise<void>((resolve) => {
      started = resolve;
    });
  const original = (f.store as any).conversationEvents.bind(f.store);
  (f.store as any).conversationEvents = async (...args: unknown[]) => {
    if (!calls++) {
      started();
      await wait;
    }
    return original(...args);
  };
  const old = f.store.postsPage(undefined, 1),
    refusal = assert.rejects(old, /superseded/);
  await entered;
  const current = await f.store.postsPage(undefined, 1);
  assert.ok(current.nextCursor);
  release();
  await refusal;
  const next = await f.store.postsPage(current.nextCursor, 1);
  assert.equal(next.posts.length, 1);
});

test('social operation identity is room-wide and conflicting cross-post comments quarantine individually', async () => {
  const f = fixture('pair');
  for (let i = 0; i < 2; i++) {
    await f.store.share({ ...record, text: `Post ${i}` }, [friend]);
    f.events.push(f.event(f.sent.at(-1)[2]));
  }
  const posts = await f.store.posts();
  await f.store.addComment(posts[0], 'First comment', 'room-wide-operation');
  const original = f.sent.at(-1)[2];
  f.events.push(f.event(original));
  await assert.rejects(
    f.store.addComment(posts[1], 'Other target', 'room-wide-operation'),
    /Conflicting/,
  );
  const conflicting = structuredClone(original);
  conflicting.payload.postId = posts[1].id;
  await f.c.signObject(conflicting);
  f.events.push(f.event(conflicting));
  const result = await f.store.posts();
  assert.equal(result.length, 2);
  assert.ok(result.every((post) => !post.comments.length));
  assert.ok(f.store.unavailableContent().length >= 1);
});

function indexedFixture() {
  const f = fixture();
  f.client.uploadContent = async (blob: Blob) => {
    f.uploaded.push(blob);
    return { content_uri: `mxc://example.org/index-part-${f.uploaded.length - 1}` };
  };
  f.client.mxcUrlToHttp = (uri: string) =>
    `https://example.org/_matrix/client/v1/media/download/example.org/${uri.split('/').pop()}`;
  return f;
}

test('encrypted search index searches photo-rich originals without fetching original bytes and opens authoritative hit', async () => {
  const f = indexedFixture();
  const rich = {
    ...record,
    attachments: [
      {
        path: 'photo.jpg',
        mimeType: 'image/jpeg',
        bytes: new Blob([new Uint8Array(2 * 1024 * 1024).fill(7)], { type: 'image/jpeg' }),
      },
    ],
  };
  await f.store.appendArchiveBatch([rich]);
  const p = f.sent[0][2].payload;
  assert.equal(p.searchIndex.archiveId, p.id);
  assert.equal(p.searchIndex.count, 1);
  assert.equal(f.uploaded.length, 2);
  assert.equal((await f.uploaded[1].text()).includes(record.text), false);
  f.events.push(f.event(f.sent[0][2]));
  const original = globalThis.fetch;
  const fetched: number[] = [];
  globalThis.fetch = async (url) => {
    const i = Number(String(url).split('-').pop());
    fetched.push(i);
    return new Response(f.uploaded[i]);
  };
  try {
    const result = await f.store.searchArchive('PLANTED');
    assert.deepEqual(
      result.matches.map((hit) => hit.recordId),
      [record.id],
    );
    assert.equal(result.limited, false);
    assert.deepEqual(fetched, [1]);
    assert.deepEqual(await f.store.readArchiveBatch(f.room.roomId, result.matches[0].eventId), [
      rich,
    ]);
    assert.deepEqual(fetched, [1, 0]);
  } finally {
    globalThis.fetch = original;
  }
});

test('corrupt encrypted index safely falls back; corrupt original too reports incomplete search', async () => {
  for (const both of [false, true]) {
    const f = indexedFixture();
    await f.store.appendArchiveBatch([record]);
    f.events.push(f.event(f.sent[0][2]));
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const i = Number(String(url).split('-').pop());
      const bytes = new Uint8Array(await f.uploaded[i].arrayBuffer());
      if (i === 1 || both) bytes[0] ^= 1;
      return new Response(bytes);
    };
    try {
      const result = await f.store.searchArchive('PLANTED');
      assert.equal(result.matches.length, both ? 0 : 1);
      assert.equal(result.limited, both);
    } finally {
      globalThis.fetch = original;
    }
  }
});

test('signed malformed index descriptor is quarantined before any media fetch', async () => {
  for (const mode of ['oversize', 'wrong-id', 'extra', 'forged']) {
    const f = indexedFixture();
    await f.store.appendArchiveBatch([record]);
    const signed = structuredClone(f.sent[0][2]);
    if (mode === 'oversize')
      signed.payload.searchIndex.file.size = CONTENT_LIMITS.searchIndexBytes + 1;
    if (mode === 'wrong-id') signed.payload.searchIndex.archiveId = '0'.repeat(64);
    if (mode === 'extra') signed.payload.searchIndex.extra = true;
    if (mode === 'forged') signed.payload.searchIndex.sha256 = '0'.repeat(64);
    if (mode !== 'forged') await f.c.signObject(signed);
    f.events.push(f.event(signed));
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('Must not download');
    };
    try {
      const result = await f.store.searchArchive('PLANTED');
      assert.equal(result.matches.length, 0);
      assert.equal(result.limited, true);
      assert.equal(f.store.unavailableContent().length, 1);
    } finally {
      globalThis.fetch = original;
    }
  }
});

test('interrupted index upload retries without reuploading original or changing batch identity', async () => {
  const f = indexedFixture();
  const upload = f.client.uploadContent;
  let fail = true;
  f.client.uploadContent = async (blob: Blob) => {
    if (f.uploaded.length === 1 && fail) {
      fail = false;
      throw new Error('Index upload interrupted');
    }
    return upload(blob);
  };
  await assert.rejects(f.store.appendArchiveBatch([record]), /interrupted/);
  assert.equal(f.sent.length, 0);
  assert.equal(f.uploaded.length, 1);
  const accepted = f.uploaded[0];
  const result = await f.store.appendArchiveBatch([record]);
  assert.equal(f.uploaded.length, 2);
  assert.equal(f.uploaded[0], accepted);
  assert.equal(f.sent[0][2].payload.id, result.id);
  f.events.push(f.event(f.sent[0][2]));
  const retry = await new ContentStore(f.client, async () => {}).appendArchiveBatch([record]);
  assert.equal(retry.id, result.id);
  assert.equal(retry.stored, false);
  assert.equal(f.uploaded.length, 2);
});

test('legacy archive without search index falls back to authoritative encrypted bundle', async () => {
  const f = indexedFixture();
  await f.store.appendArchiveBatch([record]);
  const signed = structuredClone(f.sent[0][2]);
  delete signed.payload.searchIndex;
  await f.c.signObject(signed);
  f.events.push(f.event(signed));
  const original = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => {
    fetched++;
    return new Response(f.uploaded[0]);
  };
  try {
    const result = await f.store.searchArchive('PLANTED');
    assert.equal(result.matches.length, 1);
    assert.equal(result.limited, false);
    assert.equal(fetched, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('authenticated but invalid index JSON or hash safely falls back to the original', async () => {
  const { Attachment } = await import('@matrix-org/matrix-sdk-crypto-wasm');
  for (const mode of ['count', 'row', 'hash']) {
    const f = indexedFixture();
    await f.store.appendArchiveBatch([record]);
    const signed = structuredClone(f.sent[0][2]);
    const value = {
      version: 1,
      archiveId: signed.payload.id,
      records: [
        {
          id: record.id,
          title: record.title,
          text: record.text,
          ...(mode === 'row' ? { unexpected: true } : {}),
        },
      ],
    };
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const encrypted = Attachment.encrypt(bytes);
    try {
      f.uploaded[1] = new Blob([new Uint8Array(encrypted.encryptedData)]);
      signed.payload.searchIndex.file.info = encrypted.mediaEncryptionInfo;
      signed.payload.searchIndex.file.size = bytes.length;
      signed.payload.searchIndex.sha256 =
        mode === 'hash'
          ? '0'.repeat(64)
          : Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
      if (mode === 'count') signed.payload.searchIndex.count = 2;
    } finally {
      encrypted.free();
    }
    await f.c.signObject(signed);
    f.events.push(f.event(signed));
    const original = globalThis.fetch;
    const fetched: number[] = [];
    globalThis.fetch = async (url) => {
      const i = Number(String(url).split('-').pop());
      fetched.push(i);
      return new Response(f.uploaded[i]);
    };
    try {
      const result = await f.store.searchArchive('PLANTED');
      assert.equal(result.matches.length, 1);
      assert.equal(result.limited, false);
      assert.deepEqual(fetched, [1, 0]);
    } finally {
      globalThis.fetch = original;
    }
  }
});

test('oversized search text retains original archive with no partial index', async () => {
  const f = indexedFixture();
  const large = {
    ...record,
    text: 'x'.repeat(CONTENT_LIMITS.searchIndexBytes) + ' searchable ending',
  };
  await f.store.appendArchiveBatch([large]);
  assert.equal(f.sent[0][2].payload.searchIndex, undefined);
  f.events.push(f.event(f.sent[0][2]));
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => new Response(f.uploaded[Number(String(url).split('-').pop())]);
  try {
    const result = await f.store.searchArchive('searchable ending');
    assert.equal(result.matches.length, 1);
    assert.equal(result.limited, false);
  } finally {
    globalThis.fetch = original;
  }
});

async function nativePendingClient() {
  const { createClient, MemoryStore, Room, MatrixError } = await import('matrix-js-sdk');
  const store = new MemoryStore();
  const client = createClient({
    baseUrl: 'https://example.org',
    userId: me,
    deviceId: 'DEVICE',
    store,
  });
  const room = new Room('!retry:example.org', client, me);
  store.storeRoom(room);
  const requests: { path: string; body: unknown }[] = [];
  let fail = true;
  (client as any).encryptEventIfNeeded = async (event: any) => {
    if (!event.isEncrypted())
      event.makeEncrypted(
        'm.room.encrypted',
        { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'SYNTHETIC_CIPHERTEXT' },
        'curve',
        'ed',
      );
  };
  (client.http as any).authedRequest = async (
    _method: unknown,
    path: string,
    _query: unknown,
    body: unknown,
  ) => {
    requests.push({ path, body: structuredClone(body) });
    if (fail) {
      fail = false;
      throw new MatrixError({ errcode: 'M_LIMIT_EXCEEDED', error: 'Synthetic 429' }, 429);
    }
    return { event_id: '$accepted' };
  };
  return { client, room, requests };
}

test('installed SDK reproduces duplicate transaction failure after failed encrypted send', async () => {
  const { client, room, requests } = await nativePendingClient();
  await assert.rejects(
    client.sendEvent(
      room.roomId,
      'org.cleanbookface.content.v2' as any,
      { synthetic: true },
      'same-operation',
    ),
  );
  assert.equal(room.getEventForTxnId('same-operation')?.status, 'not_sent');
  await assert.rejects(
    async () =>
      client.sendEvent(
        room.roomId,
        'org.cleanbookface.content.v2' as any,
        { synthetic: true },
        'same-operation',
      ),
    /known txnId/,
  );
  assert.equal(requests.length, 1);
});

test('content retries the actual SDK pending event with identical ciphertext and transaction; acknowledged retry is a no-op', async () => {
  const { client, room, requests } = await nativePendingClient();
  const content = new ContentStore(client, async () => {});
  let guards = 0;
  (content as any).guard = async () => {
    guards++;
  };
  const signed = {
    version: 2,
    domain: 'org.cleanbookface.content.v2',
    room_id: room.roomId,
    sender: me,
    sender_device: 'DEVICE',
    payload: { id: 'synthetic-stable-operation' },
    signatures: { [me]: { fixture: 'signature' } },
  };
  await assert.rejects((content as any).sendSigned(room.roomId, signed, 'same-operation'));
  const pending = room.getEventForTxnId('same-operation');
  assert.ok(pending);
  assert.equal(pending.status, 'not_sent');
  await (content as any).sendSigned(room.roomId, signed, 'same-operation');
  assert.equal(room.getEventForTxnId('same-operation'), pending);
  assert.equal(pending.status, 'sent');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
  assert.ok(requests[0]!.path.endsWith('/same-operation'));
  assert.ok(requests[0]!.path.includes('m.room.encrypted'));
  await (content as any).sendSigned(room.roomId, signed, 'same-operation');
  assert.equal(requests.length, 2);
  assert.equal(guards, 3);
});

test('SDK unknown-outcome retry uses one server transaction and checks fresh trust and exact signed content', async () => {
  const { client, room } = await nativePendingClient();
  const accepted = new Map<string, string>();
  let calls = 0;
  (client.http as any).authedRequest = async (_method: unknown, path: string) => {
    calls++;
    accepted.set(path, '$one-logical-event');
    if (calls === 1) throw new Error('Synthetic response lost after acceptance');
    return { event_id: accepted.get(path) };
  };
  const content = new ContentStore(client, async () => {});
  let allowed = true;
  (content as any).guard = async () => {
    if (!allowed) throw new Error('Identity or audience changed');
  };
  const signed = {
    version: 2,
    domain: 'org.cleanbookface.content.v2',
    room_id: room.roomId,
    sender: me,
    sender_device: 'DEVICE',
    payload: { id: 'stable' },
    signatures: { [me]: { fixture: 'signature' } },
  };
  await assert.rejects((content as any).sendSigned(room.roomId, signed, 'unknown-outcome'));
  allowed = false;
  await assert.rejects(
    (content as any).sendSigned(room.roomId, signed, 'unknown-outcome'),
    /Identity or audience/,
  );
  assert.equal(calls, 1);
  allowed = true;
  await assert.rejects(
    (content as any).sendSigned(
      room.roomId,
      { ...signed, payload: { id: 'different' } },
      'unknown-outcome',
    ),
    /does not match/,
  );
  assert.equal(calls, 1);
  await (content as any).sendSigned(room.roomId, signed, 'unknown-outcome');
  assert.equal(calls, 2);
  assert.equal(accepted.size, 1);
  assert.equal(room.getEventForTxnId('unknown-outcome')?.getId(), '$one-logical-event');
});

test('SDK retry refuses a second send while the original encrypted transaction is in flight', async () => {
  const { client, room } = await nativePendingClient();
  let release!: (value: { event_id: string }) => void;
  let started!: () => void;
  const sending = new Promise<void>((resolve) => {
    started = resolve;
  });
  let requests = 0;
  (client.http as any).authedRequest = async () => {
    requests++;
    started();
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const content = new ContentStore(client, async () => {});
  (content as any).guard = async () => {};
  const signed = {
    version: 2,
    domain: 'org.cleanbookface.content.v2',
    room_id: room.roomId,
    sender: me,
    sender_device: 'DEVICE',
    payload: { id: 'in-flight' },
    signatures: { [me]: { fixture: 'signature' } },
  };
  const first = (content as any).sendSigned(room.roomId, signed, 'in-flight');
  await sending;
  await assert.rejects(
    (content as any).sendSigned(room.roomId, signed, 'in-flight'),
    /still sending/,
  );
  assert.equal(requests, 1);
  release({ event_id: '$one' });
  await first;
  assert.equal(room.getEventForTxnId('in-flight')?.status, 'sent');
});

test('old v2 PNG and JPEG photos are header checked before presentation without applying new derivative size limits', async () => {
  const sharp = (await import('sharp')).default;
  const { crc32 } = await import('node:zlib');
  for (const format of ['png', 'jpeg', 'bomb'] as const) {
    const f = fixture('pair');
    const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const encoded = await sharp({
      create: {
        width: format === 'jpeg' ? 3000 : 8,
        height: 8,
        channels: 3,
        background: '#778899',
      },
    })
      [format === 'jpeg' ? 'jpeg' : 'png']()
      .toBuffer();
    if (format === 'bomb') {
      encoded.writeUInt32BE(30000, 16);
      encoded.writeUInt32BE(30000, 20);
      encoded.writeUInt32BE(crc32(encoded.subarray(12, 29)), 29);
    }
    const copy = {
      ...record,
      sourcePath: '',
      provenance: {},
      attachments: [
        {
          path: format === 'jpeg' ? 'photo-1.jpg' : 'photo-1.png',
          mimeType: mime,
          bytes: new Blob([new Uint8Array(encoded)], { type: mime }),
        },
      ],
    };
    const p = await (f.store as any).upload([copy], 'post');
    await (f.store as any).send(f.room.roomId, p, friend);
    f.events.push(f.event(f.sent[0][2]));
    const prior = globalThis.fetch;
    globalThis.fetch = async () => new Response(f.uploaded[0]);
    try {
      const posts = await f.store.posts();
      assert.equal(posts.length, format === 'bomb' ? 0 : 1);
      if (format === 'bomb') assert.equal(f.store.unavailableContent().length, 1);
      else assert.equal(posts[0].record.attachments.length, 1);
    } finally {
      globalThis.fetch = prior;
    }
  }
});

test('unavailable prior archive history refuses append with recovery guidance before any upload', async () => {
  const f = fixture();
  await f.store.appendArchiveBatch([record]);
  const event = f.event(f.sent[0][2]);
  event.isDecryptionFailure = () => true;
  f.events.push(event);
  const count = f.uploaded.length;
  await assert.rejects(
    f.store.appendArchiveBatch([{ ...record, id: 'next' }]),
    (error: any) =>
      error.code === 'ARCHIVE_HISTORY_UNAVAILABLE' &&
      /recovery kit/.test(error.message) &&
      /Choosing the same files alone/.test(error.message),
  );
  assert.equal(f.uploaded.length, count);
});

test('bounded global feed selects the newest twentieth room ahead of old departed conversations', async () => {
  const fixtures = Array.from({ length: 20 }, () => fixture('pair'));
  for (const [index, f] of fixtures.entries()) {
    f.room.roomId = `!ordered${String(index).padStart(2, '0')}:example.org`;
    await f.store.share({ ...record, text: `Conversation ${index}` }, [friend]);
    const event = f.event(f.sent[0][2]);
    event.getTs = () => index + 100;
    f.events.push(event);
    if (index < 4) f.members[1].membership = 'leave';
  }
  const f = fixtures[0];
  f.client.getRooms = () => fixtures.map((f) => f.room);
  f.client.getRoom = (id: string) => fixtures.find((f) => f.room.roomId === id)?.room;
  const page = await f.store.postsPage();
  assert.equal(page.limited, true);
  assert.equal(page.posts.length, 16);
  assert.equal(page.posts[0].record.text, 'Conversation 19');
  assert.ok(page.posts.every((post) => !post.readOnly));
  const departed = await f.store.postsPage(undefined, 20, fixtures[0].room.roomId);
  assert.equal(departed.posts[0].readOnly, true);
  assert.equal(departed.posts[0].record.text, 'Conversation 0');
});

test('departed initial sync missing backward token recovers older post before orphan comments', async () => {
  const f = fixture('pair');
  await f.store.share(record, [friend]);
  const original = f.event(f.sent[0][2]);
  f.events.push(original);
  const post = (await f.store.posts())[0];
  await f.store.addComment(post, 'historical reply', 'historical-comment-operation');
  const reply = f.event(f.sent.at(-1)[2]);
  f.events.splice(0, 1, reply);
  f.members[0].membership = 'leave';
  let contexts = 0,
    pages = 0;
  f.client.http.authedRequest = async (_method: unknown, path: string, params: unknown) => {
    contexts++;
    assert.match(path, /context/);
    assert.deepEqual(params, { limit: '0' });
    return { event: { event_id: reply.getId() }, start: 'earlier-page' };
  };
  f.client.scrollback = async () => {
    pages++;
    assert.equal(f.room.oldState.paginationToken, 'earlier-page');
    f.events.unshift(original);
    f.room.oldState.paginationToken = null;
  };
  const result = await f.store.exportConversationPage(f.room.roomId);
  const records = (await importArchives([new File([result.blob], 'history.zip')])).records;
  assert.ok(records.some((r) => r.text === record.text));
  assert.ok(records.some((r) => r.text === 'historical reply'));
  assert.equal(f.store.unavailableContent().length, 0);
  await f.store.exportConversationPage(f.room.roomId);
  assert.equal(contexts, 1);
  assert.equal(pages, 1);
});

test('departed pagination context cannot substitute another event or room', async () => {
  for (const wrong of [{ event_id: '$other' }, { room_id: '!other:example.org' }]) {
    const f = fixture('pair');
    await f.store.share(record, [friend]);
    f.events.push(f.event(f.sent[0][2]));
    f.members[0].membership = 'leave';
    f.client.http.authedRequest = async () => ({
      event: { event_id: f.events[0].getId(), ...wrong },
      start: 'untrusted-position',
    });
    await assert.rejects(f.store.exportConversationPage(f.room.roomId), /context does not match/);
    assert.equal(f.room.oldState.paginationToken, null);
  }
});

test('archive append retains transient transport and scan-progress errors without recovery reclassification', async () => {
  const { MatrixError } = await import('matrix-js-sdk');
  for (const failure of [
    new MatrixError({ errcode: 'M_LIMIT_EXCEEDED', error: 'Slow down' }, 429),
    new TypeError('Failed to fetch'),
  ]) {
    const f = fixture();
    f.room.oldState.paginationToken = 'older';
    f.client.scrollback = async () => {
      throw failure;
    };
    await assert.rejects(f.store.appendArchiveBatch([record]), (error) => error === failure);
    assert.equal(f.uploaded.length, 0);
    f.client.scrollback = async () => {
      f.room.oldState.paginationToken = null;
    };
    assert.equal((await f.store.appendArchiveBatch([record])).stored, true);
  }
  const f = fixture();
  f.room.oldState.paginationToken = 'stuck';
  f.client.scrollback = async () => {};
  await assert.rejects(
    f.store.appendArchiveBatch([record]),
    (error) =>
      error instanceof Error &&
      error.message === 'History pagination made no progress' &&
      error.name !== 'ArchiveHistoryUnavailable',
  );
  assert.equal(f.uploaded.length, 0);
});

test('old v2 decoded-photo aggregate is bounded per post and feed page before rendering', async () => {
  const sharp = (await import('sharp')).default;
  const { crc32 } = await import('node:zlib');
  const encoded = await sharp({
    create: { width: 8, height: 8, channels: 3, background: '#778899' },
  })
    .png()
    .toBuffer();
  encoded.writeUInt32BE(8000, 16);
  encoded.writeUInt32BE(4000, 20);
  encoded.writeUInt32BE(crc32(encoded.subarray(12, 29)), 29);
  const attachment = {
    path: 'photo-1.png',
    mimeType: 'image/png',
    bytes: new Blob([new Uint8Array(encoded)], { type: 'image/png' }),
  };
  const f = fixture('pair');
  const upload = f.client.uploadContent;
  f.client.uploadContent = async (...args: any[]) => {
    await upload(...args);
    return { content_uri: `mxc://example.org/blob${f.uploaded.length - 1}` };
  };
  f.client.mxcUrlToHttp = (url: string) =>
    `https://example.org/_matrix/client/v1/media/download/example.org/${url.split('/').at(-1)}`;
  for (const [id, attachments] of [
    ['first', [attachment]],
    ['second', [attachment]],
    ['over-pixels', [attachment, { ...attachment, path: 'photo-2.png' }]],
    [
      'over-count',
      Array.from({ length: 33 }, (_, i) => ({ ...attachment, path: `photo-${i + 1}.png` })),
    ],
  ] as const) {
    const copy = { ...record, id, sourcePath: '', provenance: {}, attachments: [...attachments] };
    const p = await (f.store as any).upload([copy], 'post');
    await (f.store as any).send(f.room.roomId, p, friend);
    f.events.push(f.event(f.sent.at(-1)[2]));
  }
  const prior = globalThis.fetch;
  globalThis.fetch = async (input) =>
    new Response(f.uploaded[Number(String(input).split('blob')[1])]);
  try {
    const first = await f.store.postsPage();
    assert.equal(first.posts.length, 1);
    assert.ok(first.nextCursor);
    const next = await f.store.postsPage(first.nextCursor);
    assert.equal(next.posts.length, 1);
    assert.notEqual(first.posts[0].id, next.posts[0].id);
    assert.equal(next.nextCursor, undefined);
    assert.equal(f.store.unavailableContent().length, 2);
    assert.ok(f.store.unavailableContent().every((part) => part.reason === 'limit'));
    assert.equal(next.limited, true);
  } finally {
    globalThis.fetch = prior;
  }
});

test('archive fingerprint scan budget keeps its limit error and performs no new upload', async () => {
  const f = fixture();
  await f.store.appendArchiveBatch([record]);
  f.events.push(f.event(f.sent[0][2]));
  await f.store.appendArchiveBatch([record]);
  f.events[0].getContent = () => ({ padding: 'x'.repeat(65537) });
  const before = f.uploaded.length;
  await assert.rejects(
    f.store.appendArchiveBatch([{ ...record, id: 'next' }]),
    (error) =>
      error instanceof Error &&
      error.message.includes('history scan limit') &&
      error.name !== 'ArchiveHistoryUnavailable',
  );
  assert.equal(f.uploaded.length, before);
});

test('overlapping departed exports do not reset history from a late context response', async () => {
  const f = fixture('pair');
  await f.store.share(record, [friend]);
  const original = f.event(f.sent[0][2]);
  f.events.push(original);
  const post = (await f.store.posts())[0];
  await f.store.addComment(post, 'concurrent historical reply', 'concurrent-history-operation');
  const reply = f.event(f.sent.at(-1)[2]);
  f.events.splice(0, 1, reply);
  f.members[0].membership = 'leave';
  const pending: Array<(value: unknown) => void> = [];
  let bothRequested!: () => void;
  const ready = new Promise<void>((resolve) => {
    bothRequested = resolve;
  });
  f.client.http.authedRequest = () =>
    new Promise((resolve) => {
      pending.push(resolve);
      if (pending.length === 2) bothRequested();
    });
  let pages = 0;
  f.client.scrollback = async () => {
    pages++;
    assert.equal(pages, 1, 'late context must not restart already completed pagination');
    f.events.unshift(original);
    f.room.oldState.paginationToken = null;
  };
  const first = f.store.exportConversationPage(f.room.roomId);
  const second = f.store.exportConversationPage(f.room.roomId);
  await ready;
  pending[0]({ event: { event_id: reply.getId() }, start: 'older' });
  const firstResult = await first;
  pending[1]({ event: { event_id: reply.getId() }, start: 'older' });
  const secondResult = await second;
  for (const result of [firstResult, secondResult]) {
    const records = (await importArchives([new File([result.blob], 'history.zip')])).records;
    assert.equal(records.filter((r) => r.text === record.text).length, 1);
    assert.equal(records.filter((r) => r.text === 'concurrent historical reply').length, 1);
  }
  assert.equal(pages, 1);
  assert.equal(f.room.oldState.paginationToken, null);
  assert.equal(f.store.unavailableContent().length, 0);
});
