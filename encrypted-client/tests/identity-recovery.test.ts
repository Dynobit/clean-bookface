import test from 'node:test';
import assert from 'node:assert/strict';
import { Identity, createArchiveClient } from '../src/identity';
import { MatrixError } from 'matrix-js-sdk';
import { CryptoEvent, VerificationPhase } from 'matrix-js-sdk/lib/crypto-api';
import { RequestType } from '@matrix-org/matrix-sdk-crypto-wasm';

const user = '@alice:example.org';
// Synthetic homeserver transport only. All crypto, secret storage, signing,
// recovery-key checks and bootstrap branching are the installed SDK / Rust.
async function fixture(server?: ReturnType<typeof home>, deviceId = 'ALICE') {
  const state = server ?? home();
  let identity: any;
  const client = createArchiveClient({
    baseUrl: 'https://home.example',
    userId: user,
    deviceId,
    accessToken: 'fictional',
    cryptoCallbacks: {
      getSecretStorageKey: async ({ keys }) => {
        for (const id of Object.keys(keys))
          if (identity.keys.has(id)) return [id, identity.keys.get(id)];
        return null;
      },
      cacheSecretStorageKey: (id, _info, key) => identity.keys.set(id, key),
    },
    fetchFn: async (input, init) => {
      const url = new URL(String(input));
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      try {
        return Response.json(await state.request(init?.method ?? 'GET', url.pathname, body));
      } catch (e) {
        if (e instanceof MatrixError) return Response.json(e.data, { status: e.httpStatus });
        throw e;
      }
    },
  });
  identity = Reflect.construct(Identity, [
    { baseUrl: 'https://home.example', userId: user, deviceId, accessToken: 'fictional' },
    client,
  ]);
  await client.initRustCrypto({ useIndexedDB: false });
  const backend: any = client.getCrypto();
  // Requests run normally through installed OutgoingRequestProcessor, with
  // deterministic transport failures instead of SDK's retry/backoff machinery.
  backend.outgoingRequestProcessor.requestWithRetry = async (
    method: string,
    path: string,
    _query: unknown,
    body: string,
  ) => JSON.stringify(await state.request(method, path, JSON.parse(body)));
  backend.outgoingRequestProcessor.makeRequestWithUIA = async (
    method: string,
    path: string,
    _query: unknown,
    body: string,
  ) => {
    await state.request(method, path, JSON.parse(body));
  };
  const machine = backend.getOlmMachineOrThrow();
  for (const request of await machine.outgoingRequests())
    await backend.outgoingRequestProcessor.makeOutgoingRequest(request);
  async function syncKeys() {
    await machine.updateTrackedUsers([machine.userId]);
    const requests = await machine.queryKeysForUsers([machine.userId]);
    if (requests)
      await machine.markRequestAsSent(
        requests.id,
        RequestType.KeysQuery,
        JSON.stringify(state.query()),
      );
  }
  // No sync loop in this isolated fixture: force the actual Rust key query here.
  backend.getUserDeviceInfo = async () => {
    await syncKeys();
    return new Map();
  };
  return { identity: identity as Identity, raw: identity, client, backend, state, syncKeys };
}
function home() {
  const account = new Map<string, any>();
  const devices: Record<string, any> = {};
  const oneTimeKeys: Record<string, Record<string, any>> = {};
  let signing: any = {},
    backup: any = null,
    uploads = 0;
  let failure: ((method: string, path: string, body: any) => boolean) | undefined;
  const calls: string[] = [];
  const messages: { device: string; event: { type: string; sender: string; content: any } }[] = [];
  const query = () => ({
    device_keys: { [user]: devices },
    master_keys: signing.master_key ? { [user]: signing.master_key } : {},
    self_signing_keys: signing.self_signing_key ? { [user]: signing.self_signing_key } : {},
    user_signing_keys: signing.user_signing_key ? { [user]: signing.user_signing_key } : {},
    failures: {},
  });
  return {
    account,
    calls,
    query,
    messages,
    get signing() {
      return signing;
    },
    get backup() {
      return backup;
    },
    get uploads() {
      return uploads;
    },
    fail(fn?: typeof failure) {
      failure = fn;
    },
    async request(method: string, path: string, body?: any): Promise<any> {
      path = decodeURIComponent(path).replace(/^\/_matrix\/client\/v3/, '');
      calls.push(`${method} ${path}`);
      if (failure?.(method, path, body))
        throw new MatrixError(
          { errcode: 'M_BAD_JSON', error: `Injected failure: ${method} ${path}` },
          400,
        );
      if (path.includes('/account_data/')) {
        const name = path.split('/account_data/')[1];
        if (method === 'PUT') {
          account.set(name, body);
          return {};
        }
        if (account.has(name)) return account.get(name);
        throw new MatrixError({ errcode: 'M_NOT_FOUND', error: 'Not found' }, 404);
      }
      if (path === '/keys/query') return query();
      if (path === '/keys/upload') {
        if (body.device_keys) {
          devices[body.device_keys.device_id] = body.device_keys;
          oneTimeKeys[body.device_keys.device_id] = body.one_time_keys ?? {};
        }
        return { one_time_key_counts: {} };
      }
      if (path === '/keys/claim') {
        const found: Record<string, any> = {};
        for (const device of Object.keys(body.one_time_keys[user] ?? {})) {
          const key = Object.entries(oneTimeKeys[device] ?? {})[0];
          if (key) {
            found[device] = { [key[0]]: key[1] };
            delete oneTimeKeys[device][key[0]];
          }
        }
        return { one_time_keys: { [user]: found }, failures: {} };
      }
      if (path === '/keys/device_signing/upload') {
        signing = body;
        uploads++;
        return {};
      }
      if (path === '/keys/signatures/upload') {
        for (const [id, value] of Object.entries(body[user] ?? {})) {
          if (devices[id])
            devices[id].signatures[user] = {
              ...devices[id].signatures[user],
              ...(value as any).signatures[user],
            };
        }
        return { failures: {} };
      }
      if (path === '/room_keys/version') {
        if (method === 'POST') {
          assert.equal(backup, null, 'never rotate backup');
          backup = { ...body, version: '1', count: 0, etag: '0' };
          return { version: '1' };
        }
        if (backup) return backup;
        throw new MatrixError({ errcode: 'M_NOT_FOUND', error: 'No backup' }, 404);
      }
      if (path === '/room_keys/version/1') return backup;
      if (path === '/room_keys/keys') return { rooms: {} };
      if (path.startsWith('/sendToDevice/')) {
        const type = path.split('/')[2];
        for (const [device, content] of Object.entries(body.messages[user] ?? {}))
          for (const target of device === '*'
            ? Object.keys(devices).filter((d) => d !== (content as any).requesting_device_id)
            : [device])
            messages.push({ device: target, event: { type, sender: user, content } });
        return {};
      }
      throw new Error(`Unimplemented fixture route ${method} ${path}`);
    },
  };
}

test(
  'installed SDK/Rust completes initial setup and resumes the same identity and backup',
  { timeout: 15000 },
  async () => {
    const f = await fixture();
    try {
      const kit = await f.identity.prepareRecovery();
      await f.identity.setupRecovery('fictional');
      const master = f.state.signing.master_key.keys;
      assert.equal((await f.identity.status()).recoveryReady, true);
      await f.identity.restoreRecovery(kit, 'fictional');
      assert.deepEqual(f.state.signing.master_key.keys, master);
      assert.equal(f.state.backup.version, '1');
    } finally {
      f.identity.close();
    }
  },
);

function reopen(f: Awaited<ReturnType<typeof fixture>>) {
  // Model reload's lost application memory while retaining the Rust device store.
  f.raw.acknowledgeRecoveryKey();
  const identity: any = Reflect.construct(Identity, [f.identity.session, f.client]);
  // The SDK callbacks close over the old wrapper's key map, just as reopened
  // Identity.open wires them to the new wrapper. Share that empty callback map.
  identity.keys = f.raw.keys;
  f.raw = identity;
  f.identity = identity;
}

for (const suffix of [
  '/keys/device_signing/upload',
  '/keys/signatures/upload',
  '/m.secret_storage.key.',
  '/m.secret_storage.default_key',
  '/m.cross_signing.master',
  '/m.cross_signing.user_signing',
  '/m.cross_signing.self_signing',
  '/m.megolm_backup.v1',
  '/room_keys/version',
])
  test(`setup resumes after interrupted write ${suffix}`, { timeout: 15000 }, async () => {
    const f = await fixture();
    try {
      const kit = await f.identity.prepareRecovery();
      f.state.fail((method, path) => ['PUT', 'POST'].includes(method) && path.includes(suffix));
      await assert.rejects(f.identity.setupRecovery('fictional'), /Injected failure/);
      const native = await f.backend.getOlmMachineOrThrow().exportCrossSigningKeys();
      const originalMaster = native.masterKey;
      native.free();
      f.state.fail();
      reopen(f);
      await f.identity.resumeRecoverySetup(kit, 'fictional');
      const after = await f.backend.getOlmMachineOrThrow().exportCrossSigningKeys();
      assert.equal(after.masterKey, originalMaster, 'no identity reset on retry');
      after.free();
      assert.equal((await f.identity.status()).recoveryReady, true);
      assert.equal(f.state.backup.version, '1');
    } finally {
      f.identity.close();
    }
  });

for (const stage of [
  'bootstrapCrossSigning',
  'crossSignDevice',
  'loadSessionBackupPrivateKeyFromSecretStorage',
  'restoreKeyBackup',
  'waitForKeyBackup',
] as const)
  test(`restore retries after awaited ${stage}`, { timeout: 15000 }, async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const saved = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => saved.get(key) ?? null,
        setItem: (key: string, value: string) => saved.set(key, value),
        removeItem: (key: string) => saved.delete(key),
      },
    });
    const original = await fixture();
    let fresh: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      const kit = await original.identity.prepareRecovery();
      await original.identity.setupRecovery('fictional');
      const master = original.state.signing.master_key.keys;
      fresh = await fixture(original.state, 'RESTORED');
      await fresh.syncKeys();
      const owner = stage === 'waitForKeyBackup' ? fresh.raw : fresh.backend;
      const run = owner[stage].bind(owner);
      owner[stage] = async (...args: any[]) => {
        await run(...args);
        throw new Error('Interrupted restore');
      };
      await assert.rejects(fresh.identity.restoreRecovery(kit, 'fictional'), /Interrupted restore/);
      owner[stage] = run;
      reopen(fresh);
      const status = await fresh.identity.status();
      assert.equal(status.recoveryRestorePending, true);
      assert.equal(status.historyRecoveryNeeded, true);
      assert.equal(await fresh.identity.needsRecovery(), true);
      if (stage === 'bootstrapCrossSigning') {
        await assert.rejects(fresh.identity.restoreRecovery('mistyped retry', 'fictional'));
        assert.equal(
          (await fresh.identity.status()).recoveryRestorePending,
          true,
          'wrong retry cannot erase a real interruption',
        );
        assert.equal(
          status.ownDeviceTrusted,
          true,
          'SDK import signs the device before history recovery',
        );
        assert.equal(status.backupKeyCached, false);
        assert.equal(status.historyRecoveryNeeded, true);
        assert.equal(await fresh.identity.needsRecovery(), true);
      }
      await fresh.identity.restoreRecovery(kit, 'fictional');
      assert.equal((await fresh.identity.status()).backupKeyCached, true);
      assert.equal((await fresh.identity.status()).recoveryRestorePending, false);
      assert.equal(saved.size, 0);
      assert.deepEqual(original.state.signing.master_key.keys, master);
      assert.equal(original.state.backup.version, '1');
    } finally {
      fresh?.identity.close();
      original.identity.close();
      if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
      else Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });

test(
  'wrong kit and incomplete remote secrets cannot reset an established identity',
  { timeout: 15000 },
  async () => {
    const f = await fixture();
    let fresh: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      const kit = await f.identity.prepareRecovery();
      await f.identity.setupRecovery('fictional');
      const wrong = await f.backend.createRecoveryKeyFromPassphrase();
      const writes = f.state.uploads;
      await assert.rejects(
        f.identity.restoreRecovery(wrong.encodedPrivateKey, 'fictional'),
        /does not match/,
      );
      assert.equal((await f.identity.status()).recoveryRestorePending, false);
      assert.equal(await f.identity.needsRecovery(), false);
      await assert.rejects(f.identity.restoreRecovery('mistyped kit', 'fictional'));
      assert.equal((await f.identity.status()).recoveryRestorePending, false);
      f.state.account.delete('m.cross_signing.self_signing');
      fresh = await fixture(f.state, 'NO_CACHE');
      await assert.rejects(fresh.identity.restoreRecovery(kit, 'fictional'), /refusing to replace/);
      assert.equal(f.state.uploads, writes);
    } finally {
      fresh?.identity.close();
      f.identity.close();
    }
  },
);

test(
  'actual SDK own-user request is cancelled before acceptance, trust or secrets',
  { timeout: 15000 },
  async () => {
    const a = await fixture();
    let x: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      await a.identity.prepareRecovery();
      await a.identity.setupRecovery('fictional');
      x = await fixture(a.state, 'UNTRUSTED');
      await a.syncKeys();
      await x.syncKeys();
      let views = 0,
        accepted = 0;
      a.identity.onVerification = () => {
        views++;
      };
      let cancelled!: Promise<void>;
      let incoming: any;
      a.backend.on(CryptoEvent.VerificationRequestReceived, (request: any) => {
        incoming = request;
        const accept = request.accept.bind(request);
        request.accept = async () => {
          accepted++;
          await accept();
        };
        const cancel = request.cancel.bind(request);
        request.cancel = () => (cancelled = cancel());
        a.raw.watch(request);
      });
      const outgoing = await x.backend.requestOwnUserVerification();
      const messages = a.state.messages
        .splice(0)
        .filter((m) => m.device === 'ALICE')
        .map((m) => m.event);
      assert.equal(
        messages.some((m) => m.type === 'm.key.verification.request'),
        true,
      );
      await a.backend.processSyncChanges({ toDeviceEvents: messages });
      assert.ok(incoming, 'actual SDK incoming verification event fired');
      await cancelled;
      assert.equal(views, 0);
      assert.equal(accepted, 0);
      assert.equal(incoming.phase, VerificationPhase.Cancelled);
      await x.backend.processSyncChanges({
        toDeviceEvents: a.state.messages
          .splice(0)
          .filter((m) => m.device === 'UNTRUSTED')
          .map((m) => m.event),
      });
      assert.equal(outgoing.phase, VerificationPhase.Cancelled);
      const device = await a.backend.getDeviceVerificationStatus(user, 'UNTRUSTED');
      assert.equal(device.crossSigningVerified, false);
      assert.equal(
        a.state.calls.some((c) => c.includes('/m.secret.send/')),
        false,
      );
      assert.equal(
        a.state.calls.some((c) => c.includes('/m.room.encrypted/')),
        false,
      );
      await assert.rejects(
        a.identity.requestVerification(user, '!self:example.org'),
        /recovery kit/,
      );
    } finally {
      x?.identity.close();
      a.identity.close();
    }
  },
);

test(
  'lost backup creation reply resumes existing version using the previously stored encrypted secret',
  { timeout: 15000 },
  async () => {
    const f = await fixture();
    try {
      const kit = await f.identity.prepareRecovery();
      const http = f.client.http.authedRequest.bind(f.client.http);
      let lost = false;
      f.client.http.authedRequest = (async (...args: any[]) => {
        const result = await (http as any)(...args);
        if (!lost && args[0] === 'POST' && args[1] === '/room_keys/version') {
          lost = true;
          throw new Error('Lost creation reply');
        }
        return result;
      }) as any;
      await assert.rejects(f.identity.setupRecovery('fictional'), /Lost creation reply/);
      assert.ok(f.state.account.get('m.megolm_backup.v1')?.encrypted);
      assert.equal(f.state.backup.version, '1');
      const publicKey = f.state.backup.auth_data.public_key;
      reopen(f);
      await f.identity.resumeRecoverySetup(kit, 'fictional');
      assert.equal(f.state.backup.auth_data.public_key, publicKey);
      assert.equal(f.state.calls.filter((c) => c === 'POST /room_keys/version').length, 1);
      assert.equal((await f.identity.status()).backupKeyCached, true);
    } finally {
      f.identity.close();
    }
  },
);

test(
  'upstream SAS confirmation really signs another own device and requests secrets',
  { timeout: 15000 },
  async () => {
    const a = await fixture();
    let x: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      await a.identity.prepareRecovery();
      await a.identity.setupRecovery('fictional');
      x = await fixture(a.state, 'SAS_BROWSER');
      await a.syncKeys();
      await x.syncKeys();
      let incoming: any;
      // Deliberately exercise the unsafe historical behavior at the SDK level.
      // Production Identity.watch now rejects this exact incoming request.
      a.backend.on(CryptoEvent.VerificationRequestReceived, (request: any) => {
        incoming = request;
      });
      const request = await x.backend.requestOwnUserVerification();
      async function pump() {
        for (const f of [a, x!]) {
          const selected = a.state.messages.filter((m) => m.device === f.identity.session.deviceId);
          for (const message of selected)
            a.state.messages.splice(a.state.messages.indexOf(message), 1);
          if (selected.length)
            await f.backend.processSyncChanges({ toDeviceEvents: selected.map((m) => m.event) });
          for (const outgoing of await f.backend.getOlmMachineOrThrow().outgoingRequests())
            await f.backend.outgoingRequestProcessor.makeOutgoingRequest(outgoing);
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      await pump();
      assert.ok(incoming);
      await incoming.accept();
      await pump();
      const xv = await request.startVerification('m.sas.v1');
      await pump();
      const av = incoming.verifier;
      assert.ok(av);
      const verifying = Promise.all([av.verify(), xv.verify()]);
      for (let i = 0; i < 30 && (!av.getShowSasCallbacks() || !xv.getShowSasCallbacks()); i++)
        await pump();
      assert.deepEqual(av.getShowSasCallbacks().sas, xv.getShowSasCallbacks().sas);
      await av.getShowSasCallbacks().confirm();
      await xv.getShowSasCallbacks().confirm();
      for (
        let i = 0;
        i < 30 &&
        (request.phase !== VerificationPhase.Done || incoming.phase !== VerificationPhase.Done);
        i++
      )
        await pump();
      await verifying;
      await a.syncKeys();
      assert.equal(
        (await a.backend.getDeviceVerificationStatus(user, 'SAS_BROWSER')).crossSigningVerified,
        true,
      );
      // Rust may queue automatic cross-signing / backup secret requests after SAS.
      const am = a.backend.getOlmMachineOrThrow();
      const claim = await am.getMissingSessions([am.userId]);
      if (claim) await a.backend.outgoingRequestProcessor.makeOutgoingRequest(claim);
      await x.backend.getOlmMachineOrThrow().requestMissingSecretsIfNeeded();
      for (let i = 0; i < 5; i++) await pump();
      assert.ok(a.state.calls.some((c) => c.includes('/m.secret.request/')));
      assert.ok(
        a.state.calls.some((c) => c.includes('/m.room.encrypted/')),
        'trusted peer receives encrypted secrets',
      );
      assert.ok(
        await x.backend.getSessionBackupPrivateKey(),
        'new browser received the backup secret',
      );
      assert.equal(
        (await x.backend.getCrossSigningStatus()).privateKeysCachedLocally.masterKey,
        true,
      );
    } finally {
      x?.identity.close();
      a.identity.close();
    }
  },
);

test(
  'backup discovery errors cannot be mistaken for absence and create a replacement',
  { timeout: 15000 },
  async () => {
    const f = await fixture();
    try {
      await f.identity.prepareRecovery();
      f.state.fail((method, path) => method === 'GET' && path === '/room_keys/version');
      await assert.rejects(f.identity.setupRecovery('fictional'), /Injected failure/);
      assert.equal(
        f.state.calls.some((c) => c === 'POST /room_keys/version'),
        false,
      );
    } finally {
      f.identity.close();
    }
  },
);

test(
  'SDK43 bootstrap retry alone does not retry an interrupted signing-key upload',
  { timeout: 15000 },
  async () => {
    const f = await fixture();
    try {
      f.state.fail((method, path) => method === 'POST' && path === '/keys/device_signing/upload');
      await assert.rejects(f.backend.bootstrapCrossSigning({}), /Injected failure/);
      f.state.fail();
      const before = f.state.calls.filter((c) => c === 'POST /keys/device_signing/upload').length;
      await f.backend.bootstrapCrossSigning({});
      assert.equal(
        f.state.calls.filter((c) => c === 'POST /keys/device_signing/upload').length,
        before,
      );
      assert.equal(f.state.signing.master_key, undefined);
      assert.equal(
        (await f.backend.getCrossSigningStatus()).privateKeysCachedLocally.masterKey,
        true,
      );
    } finally {
      f.identity.close();
    }
  },
);

test(
  'cached signing keys cannot overwrite a different published identity',
  { timeout: 15000 },
  async () => {
    const f = await fixture();
    try {
      const kit = await f.identity.prepareRecovery();
      await f.identity.setupRecovery('fictional');
      const before = f.state.uploads;
      const encrypted = JSON.stringify(f.state.account.get('m.cross_signing.master'));
      f.state.signing.master_key.keys = { 'ed25519:other': 'other' };
      await assert.rejects(f.identity.resumeRecoverySetup(kit, 'fictional'), /identity changed/);
      assert.equal(f.state.uploads, before);
      assert.equal(JSON.stringify(f.state.account.get('m.cross_signing.master')), encrypted);
    } finally {
      f.identity.close();
    }
  },
);

test('recovery progress persistence fails closed and cleanup is device scoped', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const saved = new Map<string, string>();
  let failWrite = false;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (failWrite) throw new Error('Synthetic quota');
        saved.set(key, value);
      },
      removeItem: (key: string) => saved.delete(key),
    },
  });
  const f = await fixture();
  try {
    const scope = { baseUrl: 'https://home.example', userId: user, deviceId: 'ALICE' };
    const { recoveryProgressStorageKey } = await import('../src/identity');
    const key = recoveryProgressStorageKey(scope);
    const other = recoveryProgressStorageKey({ ...scope, deviceId: 'OTHER' });
    saved.set(other, 'pending');
    const kit = await f.identity.prepareRecovery();
    await f.identity.setupRecovery('fictional');
    failWrite = true;
    const writes = f.state.uploads;
    await assert.rejects(f.identity.restoreRecovery(kit, 'fictional'), /Synthetic quota/);
    assert.equal(f.state.uploads, writes, 'no SDK recovery mutation before durable marker');
    saved.set(key, 'malformed');
    await assert.rejects(f.identity.status(), /progress could not be read/);
    Identity.forgetRecoveryProgress(scope);
    assert.equal(saved.has(key), false);
    assert.equal(saved.get(other), 'pending');
  } finally {
    f.identity.close();
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('SDK-swallowed backup errors require an independent exact-token 401 before ended-session classification', async () => {
  const f = await fixture();
  try {
    await f.identity.prepareRecovery();
    await f.identity.setupRecovery('fictional');
    const original = f.state.request.bind(f.state);
    for (const whoami of ['ended', 'network', 'valid'] as const) {
      f.state.request = async (method, path, body) => {
        if (path.endsWith('/room_keys/version'))
          throw new MatrixError(
            { errcode: 'M_UNKNOWN_TOKEN', error: 'Synthetic ended token' },
            401,
          );
        if (path.endsWith('/account/whoami')) {
          if (whoami === 'ended')
            throw new MatrixError(
              { errcode: 'M_UNKNOWN_TOKEN', error: 'Confirmed ended token' },
              401,
            );
          if (whoami === 'network') throw new Error('Synthetic network failure');
          return { user_id: user, device_id: 'ALICE' };
        }
        return original(method, path, body);
      };
      assert.equal(
        await f.backend.checkKeyBackupAndEnable(),
        null,
        'installed SDK swallows the typed 401',
      );
      await assert.rejects(f.identity.waitForKeyBackup(2_000), (error) => {
        assert.equal(Identity.sessionIsInvalid(error), whoami === 'ended');
        if (whoami === 'valid') assert.match(String(error), /trusted, recoverable key backup/);
        return true;
      });
    }
  } finally {
    f.identity.close();
  }
});
