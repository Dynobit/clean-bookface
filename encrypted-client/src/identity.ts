import { forgetDeviceCrypto } from './local-cleanup';
import sdkPackage from 'matrix-js-sdk/package.json' with { type: 'json' };
import {
  createClient,
  ClientEvent,
  SyncState,
  MatrixError,
  type MatrixClient,
} from 'matrix-js-sdk';
import {
  CryptoEvent,
  AllDevicesIsolationMode,
  VerificationPhase,
  VerificationRequestEvent,
  VerifierEvent,
  type VerificationRequest,
  type Verifier,
  type ShowSasCallbacks,
  type GeneratedSecretStorageKey,
} from 'matrix-js-sdk/lib/crypto-api';
import { decodeRecoveryKey } from 'matrix-js-sdk/lib/crypto-api/recovery-key';
import { logger as sdkLogger, type Logger } from 'matrix-js-sdk/lib/logger';
import { Method, ClientPrefix } from 'matrix-js-sdk/lib/http-api';
import {
  BackupDecryptionKey,
  OlmMachine,
  UserId,
  DeviceId,
  RoomMessageRequest,
  initAsync,
} from '@matrix-org/matrix-sdk-crypto-wasm';
import type {
  KeyBackupInfo,
  Curve25519SessionData,
  KeyBackupSession,
} from 'matrix-js-sdk/lib/crypto-api/keybackup';
import type { IMegolmSessionData } from 'matrix-js-sdk/lib/@types/crypto';
import type { UIAuthCallback } from 'matrix-js-sdk/lib/interactive-auth';

export class SessionInUseError extends Error {
  readonly code = 'SESSION_IN_USE';
  constructor() {
    super('This device is already open in another tab.');
  }
}
export interface Session {
  baseUrl: string;
  userId: string;
  deviceId: string;
  accessToken: string;
}
export function verificationTerminalStorageKey(
  session: Pick<Session, 'baseUrl' | 'userId' | 'deviceId'>,
): string {
  return (
    'clean-bookface.verification-terminal.v1:' +
    [session.baseUrl, session.userId, session.deviceId].map(encodeURIComponent).join(':')
  );
}
export function recoveryProgressStorageKey(
  session: Pick<Session, 'baseUrl' | 'userId' | 'deviceId'>,
): string {
  return (
    'clean-bookface.restore-pending.v1:' +
    [session.baseUrl, session.userId, session.deviceId].map(encodeURIComponent).join(':')
  );
}
export interface VerificationView {
  id: string;
  peer: string;
  phase: string;
  emoji?: [string, string][];
  decimal?: number[];
  accept?: () => Promise<void>;
  compare?: () => Promise<void>;
  confirm?: () => Promise<void>;
  mismatch?: () => void;
  cancellationCode?: string;
  cancelledBy?: string;
  failure?: string;
  cancel: () => Promise<void>;
}
const quiet: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  getChild() {
    return quiet;
  },
};
// Legacy SDK call sites use the global logger rather than the client logger.
// Rust's StoreHandle and OlmMachine receive the client's quiet logger explicitly.
Object.assign(sdkLogger, quiet, { log() {} });
/**
 * Synapse 1.162 caches initial sync by the raw inline filter, ignoring the SDK's
 * _cacheBuster. Give each initial request a namespaced filter extension so a
 * reopened device cannot replay a pre-recovery account-data snapshot. The
 * extension is ignored by filtering; no persistent server filter is created.
 */
export function freshInitialSyncFetch(
  baseUrl: string,
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
): typeof fetch {
  const origin = new URL(baseUrl).origin;
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (
      url.origin !== origin ||
      !/^\/_matrix\/client\/(v3|r0)\/sync$/.test(url.pathname) ||
      url.searchParams.has('since')
    )
      return fetcher(input, init);
    const raw = url.searchParams.get('filter');
    let filter: unknown;
    try {
      filter = raw === null ? null : JSON.parse(raw);
    } catch {
      throw new Error('Initial encrypted sync requires a valid inline filter.');
    }
    if (!filter || typeof filter !== 'object' || Array.isArray(filter))
      throw new Error('Initial encrypted sync requires a valid inline filter.');
    const room = (filter as { room?: unknown }).room;
    if (room !== undefined && (!room || typeof room !== 'object' || Array.isArray(room)))
      throw new Error('Initial encrypted sync requires a valid room filter.');
    url.searchParams.set(
      'filter',
      JSON.stringify({
        ...filter,
        room: { ...(room as Record<string, unknown> | undefined), include_leave: true },
        'org.cleanbookface.sync_instance': crypto.randomUUID(),
      }),
    );
    return fetcher(input instanceof Request ? new Request(url, input) : url, init);
  };
}
/** This archive app has no calling feature or peer-to-peer media transport. */
export function createArchiveClient(options: Parameters<typeof createClient>[0]): MatrixClient {
  return createClient({
    ...options,
    fetchFn: freshInitialSyncFetch(options.baseUrl, options.fetchFn),
    logger: quiet,
    disableVoip: true,
  });
}
/** Prove ratchet coverage in an isolated, memory-only Rust store; never alter live keys. */
export async function backupKeyCoversLocal(
  local: IMegolmSessionData,
  backup: Partial<IMegolmSessionData>,
): Promise<boolean> {
  if (
    typeof backup.session_key !== 'string' ||
    backup.sender_key !== local.sender_key ||
    (backup.algorithm ?? 'm.megolm.v1.aes-sha2') !== (local.algorithm ?? 'm.megolm.v1.aes-sha2') ||
    backup.sender_claimed_keys?.ed25519 !== local.sender_claimed_keys?.ed25519 ||
    (backup.room_id !== undefined && backup.room_id !== local.room_id) ||
    (backup.session_id !== undefined && backup.session_id !== local.session_id)
  )
    return false;
  const candidate: IMegolmSessionData = {
    algorithm: local.algorithm ?? 'm.megolm.v1.aes-sha2',
    room_id: local.room_id,
    session_id: local.session_id,
    session_key: backup.session_key,
    sender_key: local.sender_key,
    sender_claimed_keys: { ...local.sender_claimed_keys },
    forwarding_curve25519_key_chain: [],
  };
  const baseline = { ...candidate, session_key: local.session_key };
  await initAsync();
  const user = new UserId('@backup-proof:example.invalid');
  const device = new DeviceId('MEMORY_ONLY_PROOF');
  let machine: OlmMachine | undefined;
  let exported: IMegolmSessionData[] = [];
  try {
    machine = await OlmMachine.initialize(user, device, undefined, undefined, quiet);
    const initial = await machine.importExportedRoomKeys(JSON.stringify([baseline]), () => {});
    try {
      if (initial.importedCount !== 1) return false;
    } finally {
      initial.free();
    }
    // Rust rejects unconnected ratchets, even if their public session IDs match.
    // Importing local FIRST is essential: failed imports must not count as coverage.
    const result = await machine.importExportedRoomKeys(JSON.stringify([candidate]), () => {});
    result.free();
    exported = JSON.parse(await machine.exportRoomKeys(() => true));
    return (
      exported.length === 1 &&
      exported[0].room_id === local.room_id &&
      exported[0].session_id === local.session_id &&
      exported[0].session_key === candidate.session_key
    );
  } catch {
    return false;
  } finally {
    for (const key of exported) key.session_key = '';
    candidate.session_key = '';
    baseline.session_key = '';
    machine?.close();
    user.free();
    device.free();
  }
}
export function validateOrigin(input: string): string {
  const u = new URL(input);
  if (u.search || u.hash || u.pathname !== '/') throw new Error('Use the server origin only.');
  if (
    u.protocol !== 'https:' &&
    !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
  )
    throw new Error('The server must use HTTPS.');
  u.username = '';
  u.password = '';
  return u.origin;
}
export class Identity {
  public onVerification?: (view: VerificationView) => void;
  public onVerificationRejected?: (message: string) => void;
  private keys = new Map<string, Uint8Array<ArrayBuffer>>();
  private unlock?: () => void;
  private preparedRecovery: GeneratedSecretStorageKey | null = null;
  private preparation?: Promise<string>;
  private recoverySetup?: Promise<string>;
  get pendingRecoveryKey(): string | null {
    return this.preparedRecovery?.encodedPrivateKey ?? null;
  }
  private watched = new WeakSet<VerificationRequest>();
  private verifiers = new WeakSet<Verifier>();
  private terminalVerifications = new Set<string>();
  private restorePendingMemory = false;
  static forgetRecoveryProgress(session: Pick<Session, 'baseUrl' | 'userId' | 'deviceId'>): void {
    localStorage.removeItem(recoveryProgressStorageKey(session));
  }
  private restorePending(): boolean {
    if (typeof localStorage === 'undefined') return this.restorePendingMemory;
    const value = localStorage.getItem(recoveryProgressStorageKey(this.session));
    if (value !== null && value !== 'pending')
      throw new Error('Saved recovery progress could not be read.');
    return value === 'pending';
  }
  private setRestorePending(pending: boolean): void {
    if (typeof localStorage !== 'undefined') {
      const key = recoveryProgressStorageKey(this.session);
      if (pending) localStorage.setItem(key, 'pending');
      else localStorage.removeItem(key);
    }
    this.restorePendingMemory = pending;
  }

  private verificationOrderingInstalled = false;
  private verificationMacs = new Map<
    string,
    {
      promise: Promise<void>;
      resolve(): void;
      reject(reason: unknown): void;
      state: 'pending' | 'sent' | 'failed';
    }
  >();
  private verificationMac(roomId: string, id: string) {
    const key = JSON.stringify([roomId, id]);
    let gate = this.verificationMacs.get(key);
    if (!gate) {
      if (this.verificationMacs.size >= 512) {
        const completed = [...this.verificationMacs].find(([, value]) => value.state !== 'pending');
        if (!completed) throw new Error('Too many unfinished identity checks.');
        this.verificationMacs.delete(completed[0]);
      }
      let resolve!: () => void, reject!: (reason: unknown) => void;
      const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      void promise.catch(() => {});
      gate = { promise, resolve, reject, state: 'pending' };
      this.verificationMacs.set(key, gate);
    }
    return gate;
  }
  /** SDK43 can concurrently dispatch Done while its MAC is retrying a 429.
   * Rust then terminalizes the peer request before accepting that MAC. Keep
   * the exact room/request's Done behind successful MAC transport completion.
   * This gate never changes a verification result or computes trust itself. */
  private installVerificationOrdering(): void {
    if (this.verificationOrderingInstalled) return;
    const backend = this.crypto as unknown as {
      outgoingRequestProcessor: {
        makeOutgoingRequest(request: unknown, ...args: unknown[]): Promise<void>;
      };
    };
    const processor = backend.outgoingRequestProcessor;
    if (sdkPackage.version !== '43.0.0' || typeof processor?.makeOutgoingRequest !== 'function')
      throw new Error('Identity checks require reviewed Matrix SDK 43.0.0.');
    const original = processor.makeOutgoingRequest.bind(processor);
    processor.makeOutgoingRequest = async (request, ...args) => {
      if (
        !(request instanceof RoomMessageRequest) ||
        !['m.key.verification.mac', 'm.key.verification.done'].includes(request.event_type)
      )
        return original(request, ...args);
      const relation = JSON.parse(request.body)['m.relates_to'];
      if (
        relation?.rel_type !== 'm.reference' ||
        typeof relation.event_id !== 'string' ||
        !relation.event_id
      )
        throw new Error('Invalid identity-check relation.');
      const key = JSON.stringify([request.room_id, relation.event_id]);
      if (request.event_type === 'm.key.verification.done') {
        const gate = this.verificationMacs.get(key);
        if (!gate) throw new Error('This identity check has not been confirmed here.');
        await gate.promise;
        return original(request, ...args);
      }
      const gate = this.verificationMac(request.room_id, relation.event_id);
      try {
        await original(request, ...args);
        gate.state = 'sent';
        gate.resolve();
      } catch (error) {
        gate.state = 'failed';
        gate.reject(error);
        throw error;
      }
    };
    this.verificationOrderingInstalled = true;
  }
  private beginVerificationConfirmation(
    request: Pick<VerificationRequest, 'roomId' | 'transactionId'>,
  ): void {
    if (request.roomId && request.transactionId)
      this.verificationMac(request.roomId, request.transactionId);
  }
  private cancelVerificationOrdering(
    request: Pick<VerificationRequest, 'roomId' | 'transactionId'>,
  ): void {
    const gate = this.verificationMacs.get(JSON.stringify([request.roomId, request.transactionId]));
    if (gate?.state === 'pending') {
      gate.state = 'failed';
      gate.reject(new Error('Identity check cancelled.'));
    }
  }

  static forgetVerificationHistory(
    session: Pick<Session, 'baseUrl' | 'userId' | 'deviceId'>,
  ): void {
    localStorage.removeItem(verificationTerminalStorageKey(session));
  }
  private terminalVerification(peer: string, id: string, remember = false): boolean {
    const key = verificationTerminalStorageKey(this.session);
    const entry = JSON.stringify([peer, id]);
    if (!peer || !id || entry.length > 4096) throw new Error('Invalid identity-check identifier.');
    // Exact local terminal decisions only: host timestamps and existing peer
    // trust cannot authorize or suppress a new identity comparison.
    if (typeof localStorage !== 'undefined') {
      const stored: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
      if (
        !Array.isArray(stored) ||
        stored.length > 512 ||
        stored.some((value) => {
          if (typeof value !== 'string' || value.length > 4096) return true;
          const pair: unknown = JSON.parse(value);
          return (
            !Array.isArray(pair) ||
            pair.length !== 2 ||
            pair.some((part) => typeof part !== 'string' || !part) ||
            JSON.stringify(pair) !== value
          );
        })
      )
        throw new Error('Saved identity-check state is unreadable.');
      for (const value of stored) this.terminalVerifications.add(value);
    }
    if (remember) {
      const entries = [...this.terminalVerifications].filter((value) => value !== entry);
      entries.push(entry);
      const retained = entries.slice(-512);
      if (typeof localStorage !== 'undefined') localStorage.setItem(key, JSON.stringify(retained));
      this.terminalVerifications = new Set(retained);
    }
    return this.terminalVerifications.has(entry);
  }
  private constructor(
    public readonly session: Session,
    public readonly client: MatrixClient,
  ) {}
  static async authenticate(args: {
    baseUrl: string;
    username: string;
    password: string;
    invitationToken?: string;
  }): Promise<Session> {
    const baseUrl = validateOrigin(args.baseUrl);
    const c = createArchiveClient({ baseUrl });
    if (!args.invitationToken) {
      const r = await c.login('m.login.password', {
        identifier: { type: 'm.id.user', user: args.username },
        password: args.password,
        initial_device_display_name: 'Clean Bookface browser',
      });
      return { baseUrl, userId: r.user_id, deviceId: r.device_id, accessToken: r.access_token };
    }
    const data = {
      username: args.username,
      password: args.password,
      initial_device_display_name: 'Clean Bookface browser',
    };
    let auth: Record<string, string> = {};
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const r = await c.registerRequest({ ...data, auth });
        if (!r.access_token || !r.device_id)
          throw new Error('Registration did not establish a browser session.');
        return { baseUrl, userId: r.user_id, deviceId: r.device_id, accessToken: r.access_token };
      } catch (error) {
        if (!(error instanceof MatrixError) || error.httpStatus !== 401) throw error;
        const d = error.data as {
          session?: string;
          flows?: { stages: string[] }[];
          completed?: string[];
        };
        const flow = d.flows?.find((f) =>
          f.stages.every((s) => ['m.login.registration_token', 'm.login.dummy'].includes(s)),
        );
        const stage = flow?.stages.find((s) => !d.completed?.includes(s));
        if (!stage || !d.session)
          throw new Error('This invitation requires an unsupported registration step.');
        auth = {
          session: d.session,
          type: stage,
          ...(stage === 'm.login.registration_token' ? { token: args.invitationToken } : {}),
        };
      }
    }
    throw new Error('Registration did not complete.');
  }
  static sessionIsInvalid(error: unknown): error is MatrixError {
    return (
      error instanceof MatrixError &&
      error.httpStatus === 401 &&
      error.data.errcode === 'M_UNKNOWN_TOKEN'
    );
  }
  static async logoutSession(session: Session): Promise<void> {
    const client = createArchiveClient({ ...session, baseUrl: validateOrigin(session.baseUrl) });
    try {
      await client.logout(true);
    } catch (error) {
      if (!Identity.sessionIsInvalid(error)) throw error;
    } finally {
      client.stopClient();
    }
  }
  static async open(
    session: Session,
    onVerification?: (view: VerificationView) => void,
    onVerificationRejected?: (message: string) => void,
  ): Promise<Identity> {
    if (!navigator.locks)
      throw new Error('This browser cannot protect the encryption database from concurrent tabs.');
    session = { ...session, baseUrl: validateOrigin(session.baseUrl) };
    let instance: Identity;
    const client = createArchiveClient({
      ...session,
      logger: quiet,
      verificationMethods: ['m.sas.v1'],
      cryptoCallbacks: {
        getSecretStorageKey: async ({ keys }) => {
          for (const id of Object.keys(keys)) {
            const key = instance.keys.get(id);
            if (key) return [id, key];
          }
          return null;
        },
        cacheSecretStorageKey: (id, _info, key) => {
          instance.keys.set(id, key);
        },
      },
    });
    instance = new Identity(session, client);
    instance.onVerification = onVerification;
    instance.onVerificationRejected = onVerificationRejected;
    const name = `clean-bookface:${session.baseUrl}:${session.userId}:${session.deviceId}`;
    await new Promise<void>((resolve, reject) => {
      void navigator.locks
        .request(name, { ifAvailable: true }, async (lock) => {
          if (!lock) {
            reject(new SessionInUseError());
            return;
          }
          await new Promise<void>((release) => {
            instance.unlock = release;
            resolve();
          });
        })
        .catch(reject);
    });
    try {
      await client.initRustCrypto({ useIndexedDB: true, cryptoDatabasePrefix: name });
      instance.installVerificationOrdering();
      instance.crypto.globalBlacklistUnverifiedDevices = true;
      instance.crypto.setDeviceIsolationMode(new AllDevicesIsolationMode(true));
      client.on(CryptoEvent.VerificationRequestReceived, (request) => instance.watch(request));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error('Encrypted server sync timed out.'));
        }, 60_000);
        const listener = (state: SyncState) => {
          if (state === SyncState.Prepared) {
            cleanup();
            resolve();
          }
        };
        const cleanup = () => {
          clearTimeout(timer);
          client.removeListener(ClientEvent.Sync, listener);
        };
        client.on(ClientEvent.Sync, listener);
        void client.startClient({ initialSyncLimit: 20 }).catch((error) => {
          cleanup();
          reject(error);
        });
      });
      return instance;
    } catch (error) {
      instance.close();
      throw error;
    }
  }
  private get crypto() {
    const c = this.client.getCrypto();
    if (!c) throw new Error('Encryption is unavailable.');
    return c;
  }
  private passwordAuth(password: string): UIAuthCallback<void> {
    return async (makeRequest) => {
      try {
        await makeRequest(null);
      } catch (error) {
        if (!(error instanceof MatrixError) || error.httpStatus !== 401) throw error;
        const session = error.data.session;
        await makeRequest({
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: this.session.userId },
          password,
          ...(typeof session === 'string' ? { session } : {}),
        });
      }
    };
  }
  async status() {
    await this.crypto.getUserDeviceInfo([this.session.userId], true);
    const hasIdentity = await this.crypto.userHasCrossSigningKeys(this.session.userId, true);
    const own = await this.crypto.getDeviceVerificationStatus(
      this.session.userId,
      this.session.deviceId,
    );
    const recoveryStatus = await this.crypto.getSecretStorageStatus();
    const signing = await this.crypto.getCrossSigningStatus();
    const recoverySetupResumable = Object.values(signing.privateKeysCachedLocally).every(Boolean);
    const backupKey = await this.crypto.getSessionBackupPrivateKey();
    const backupKeyCached = !!backupKey;
    const recoveryRestorePending = this.restorePending();
    backupKey?.fill(0);
    return {
      hasIdentity,
      recoverySetupResumable,
      backupKeyCached,
      recoveryRestorePending,
      historyRecoveryNeeded:
        hasIdentity && (recoveryRestorePending || (recoveryStatus.ready && !backupKeyCached)),
      recoveryConfigured: await this.client.secretStorage.hasKey(),
      recoveryMissingSecrets: Object.entries(recoveryStatus.secretStorageKeyValidityMap)
        .filter(([, valid]) => !valid)
        .map(([name]) => name),
      recoveryReady: recoveryStatus.ready,
      ownDeviceTrusted: own?.crossSigningVerified ?? false,
      crossSigningReady: await this.crypto.isCrossSigningReady(),
    };
  }
  async needsRecovery(): Promise<boolean> {
    const s = await this.status();
    return (
      s.hasIdentity &&
      (!s.ownDeviceTrusted ||
        !s.crossSigningReady ||
        !s.recoveryReady ||
        !s.backupKeyCached ||
        s.recoveryRestorePending)
    );
  }
  /** Generate locally. The caller saves and confirms this kit before setupRecovery. */
  async prepareRecovery(): Promise<string> {
    if (this.pendingRecoveryKey) return this.pendingRecoveryKey;
    if (this.preparation) return this.preparation;
    this.preparation = (async () => {
      const s = await this.status();
      if (await this.client.secretStorage.hasKey())
        throw new Error('Recovery already exists. Use the existing recovery kit.');
      if (s.hasIdentity && !s.recoverySetupResumable)
        throw new Error('An identity already exists. Recover it instead of replacing it.');
      const key = await this.crypto.createRecoveryKeyFromPassphrase();
      if (!key.encodedPrivateKey) throw new Error('Recovery key generation failed.');
      this.preparedRecovery = key;
      return key.encodedPrivateKey;
    })();
    try {
      return await this.preparation;
    } finally {
      this.preparation = undefined;
    }
  }
  /** Forget the displayed kit only after the caller has saved it and setup succeeded. */
  acknowledgeRecoveryKey(): void {
    if (this.recoverySetup) throw new Error('Recovery setup is still running.');
    this.preparedRecovery?.privateKey.fill(0);
    this.preparedRecovery = null;
    for (const key of this.keys.values()) key.fill(0);
    this.keys.clear();
  }
  async setupRecovery(password: string): Promise<string> {
    if (this.recoverySetup) return this.recoverySetup;
    if (!this.preparedRecovery)
      throw new Error('Prepare and save the recovery kit before enabling recovery.');
    this.recoverySetup = this.finishRecoverySetup(password);
    try {
      return await this.recoverySetup;
    } finally {
      this.recoverySetup = undefined;
    }
  }
  private async finishRecoverySetup(password: string): Promise<string> {
    const key = this.preparedRecovery!;
    const existing = await this.client.secretStorage.getKey();
    if (existing) {
      if (!(await this.client.secretStorage.checkKey(key.privateKey, existing[1])))
        throw new Error('Recovery changed. Use its existing kit; refusing to replace it.');
      this.keys.set(existing[0], key.privateKey);
    }
    const s = await this.status();
    if ((s.hasIdentity || existing) && !s.recoverySetupResumable) {
      if (!s.hasIdentity) throw new Error('Published recovery identity is unavailable.');
      // Only an intact copy of the existing identity can authorize this import.
      for (const name of [
        'm.cross_signing.master',
        'm.cross_signing.self_signing',
        'm.cross_signing.user_signing',
      ]) {
        if (!existing || !(await this.client.secretStorage.get(name)))
          throw new Error('The existing identity is unavailable; refusing to replace it.');
      }
    }
    // Validate cached keys against the server before SDK exports them to storage.
    if (s.recoverySetupResumable) await this.publishCachedIdentity(password);
    await this.crypto.bootstrapCrossSigning({
      authUploadDeviceSigningKeys: this.passwordAuth(password),
    });
    // SDK43 leaves cached keys after an interrupted public-key upload and its
    // bootstrap retry does not upload them (CrossSigningIdentity's TODO).
    if (!s.recoverySetupResumable) await this.publishCachedIdentity(password);
    await this.crypto.bootstrapSecretStorage({
      createSecretStorageKey: async () => key,
      setupNewKeyBackup: false,
    });
    await this.ensureRecoveryBackup();
    await this.crypto.crossSignDevice(this.session.deviceId);
    if (!(await this.crypto.isSecretStorageReady()))
      throw new Error('Recovery setup is incomplete. Keep the saved kit and retry on this device.');
    return key.encodedPrivateKey!;
  }
  /** Resume the saved kit on this device; no existing signing or backup key is rotated. */
  async resumeRecoverySetup(encoded: string, password: string): Promise<string> {
    if (this.recoverySetup) return this.recoverySetup;
    const key = await this.validateRecoveryKit(encoded);
    return this.resumeWithValidatedKey(encoded, password, key);
  }
  private async resumeWithValidatedKey(
    encoded: string,
    password: string,
    key: Uint8Array<ArrayBuffer>,
  ): Promise<string> {
    if (this.recoverySetup) {
      key.fill(0);
      return this.recoverySetup;
    }
    try {
      this.preparedRecovery?.privateKey.fill(0);
      this.preparedRecovery = { privateKey: key, encodedPrivateKey: encoded, keyInfo: {} };
      return await this.setupRecovery(password);
    } catch (error) {
      if (this.preparedRecovery?.privateKey !== key) key.fill(0);
      throw error;
    }
  }
  /** Read-only validation: a mistyped kit must not change recovery routing. */
  private async validateRecoveryKit(encoded: string) {
    const key = decodeRecoveryKey(encoded);
    try {
      const existing = await this.client.secretStorage.getKey();
      if (existing && !(await this.client.secretStorage.checkKey(key, existing[1])))
        throw new Error('Recovery key does not match this account.');
      if (!existing && !(await this.status()).recoverySetupResumable)
        throw new Error('Setup can only resume on the original browser with its signing keys.');
      return key;
    } catch (error) {
      key.fill(0);
      throw error;
    }
  }
  /** Pinned SDK43 adapter: retry publication of the SAME Rust signing identity. */
  private async publishCachedIdentity(password: string): Promise<void> {
    const backend = this.crypto as unknown as {
      getOlmMachineOrThrow(): OlmMachine;
      outgoingRequestProcessor: {
        makeOutgoingRequest(request: unknown, auth: UIAuthCallback<void>): Promise<void>;
      };
    };
    if (
      sdkPackage.version !== '43.0.0' ||
      typeof backend.getOlmMachineOrThrow !== 'function' ||
      typeof backend.outgoingRequestProcessor?.makeOutgoingRequest !== 'function'
    )
      throw new Error('Recovery resumption requires reviewed Matrix SDK 43.0.0.');
    const state = await this.crypto.getCrossSigningStatus();
    if (!Object.values(state.privateKeysCachedLocally).every(Boolean))
      throw new Error('The existing signing identity is unavailable; refusing to replace it.');
    const requests = await backend.getOlmMachineOrThrow().bootstrapCrossSigning(false);
    try {
      const candidate = JSON.parse(requests.uploadSigningKeysRequest.body);
      const published = await this.client.http.authedRequest<
        Record<string, Record<string, { keys: Record<string, string> }>>
      >(Method.Post, '/keys/query', undefined, { device_keys: { [this.session.userId]: [] } });
      let complete = true;
      for (const [collection, field] of [
        ['master_keys', 'master_key'],
        ['self_signing_keys', 'self_signing_key'],
        ['user_signing_keys', 'user_signing_key'],
      ]) {
        const current = published[collection]?.[this.session.userId];
        if (!current) complete = false;
        if (current && JSON.stringify(current.keys) !== JSON.stringify(candidate[field]?.keys))
          throw new Error('The published identity changed; refusing to replace it.');
      }
      // A recovered Rust identity may not retain upload signatures on its
      // public subkeys. Do not re-upload an already complete matching identity.
      if (complete) return;
      for (const request of [
        requests.uploadKeysRequest,
        requests.uploadSigningKeysRequest,
        requests.uploadSignaturesRequest,
      ])
        if (request)
          await backend.outgoingRequestProcessor.makeOutgoingRequest(
            request,
            this.passwordAuth(password),
          );
    } finally {
      requests.free();
    }
  }
  /** Persist the encrypted backup secret BEFORE creating its server version. */
  private async ensureRecoveryBackup(): Promise<void> {
    // Refresh the SDK cache: a previous POST may have succeeded before its reply
    // was lost. Never use a cached absence to create or delete another version.
    await this.crypto.checkKeyBackupAndEnable();
    let backup: KeyBackupInfo | null;
    try {
      backup = await this.client.http.authedRequest<KeyBackupInfo>(
        Method.Get,
        '/room_keys/version',
        undefined,
        undefined,
        { prefix: ClientPrefix.V3 },
      );
    } catch (error) {
      if (
        !(error instanceof MatrixError) ||
        error.httpStatus !== 404 ||
        error.data.errcode !== 'M_NOT_FOUND'
      )
        throw error;
      backup = null;
    }
    let secret = await this.client.secretStorage.get('m.megolm_backup.v1');
    if (!secret && backup) {
      // bootstrapSecretStorage already tried to save a matching local key.
      throw new Error(
        'The existing backup key is unavailable. Keep this browser and use its recovery kit.',
      );
    }
    const key = secret
      ? BackupDecryptionKey.fromBase64(secret)
      : BackupDecryptionKey.createRandomKey();
    const publicKey = key.megolmV1PublicKey;
    try {
      if (!secret) {
        secret = key.toBase64();
        await this.client.secretStorage.store('m.megolm_backup.v1', secret);
      }
      if (!backup) {
        const authData = { public_key: publicKey.publicKeyBase64 };
        const backend = this.crypto as unknown as { signObject(value: object): Promise<void> };
        if (sdkPackage.version !== '43.0.0' || typeof backend.signObject !== 'function')
          throw new Error('Recovery requires reviewed Matrix SDK 43.0.0.');
        await backend.signObject(authData);
        await this.client.http.authedRequest(
          Method.Post,
          '/room_keys/version',
          undefined,
          {
            algorithm: publicKey.algorithm,
            auth_data: authData,
          },
          { prefix: ClientPrefix.V3 },
        );
        await this.crypto.checkKeyBackupAndEnable();
        backup = await this.crypto.getKeyBackupInfo();
      }
      if (
        !backup ||
        backup.algorithm !== publicKey.algorithm ||
        !('public_key' in backup.auth_data) ||
        backup.auth_data.public_key !== publicKey.publicKeyBase64
      )
        throw new Error('Recovery key does not match the existing backup; refusing to replace it.');
      await this.crypto.loadSessionBackupPrivateKeyFromSecretStorage();
    } finally {
      publicKey.free();
      key.free();
    }
  }
  async restoreRecovery(encoded: string, password: string): Promise<void> {
    // Read-only checks precede the journal: a wrong kit cannot strand a healthy
    // browser. Persist intent before any step caches keys or changes trust.
    const checkedKey = await this.validateRecoveryKit(encoded);
    try {
      this.setRestorePending(true);
    } catch (error) {
      checkedKey.fill(0);
      throw error;
    }
    try {
      await this.resumeWithValidatedKey(encoded, password, checkedKey);
      await this.crypto.loadSessionBackupPrivateKeyFromSecretStorage();
      await this.crypto.restoreKeyBackup();
      await this.waitForKeyBackup();
      this.setRestorePending(false);
    } finally {
      checkedKey.fill(0);
      this.acknowledgeRecoveryKey();
    }
  }
  /**
   * Prove a stable snapshot of local room keys is present and decryptable in the
   * current trusted backup. Callers must serialize writes and await this before
   * clearing their session. This never logs out or discards local state on failure.
   * SDK progress counts are wakeups, not proof: SDK43 can emit stale zero counts.
   */
  async waitForKeyBackup(timeoutMs = 60_000): Promise<void> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new Error('A positive backup deadline is required.');
    const controller = new AbortController();
    let wake: (() => void) | undefined;
    let revision = 0;
    const progress = () => {
      revision++;
      wake?.();
      wake = undefined;
    };
    const events = [
      CryptoEvent.KeyBackupSessionsRemaining,
      CryptoEvent.KeyBackupStatus,
      CryptoEvent.KeyBackupFailed,
    ] as const;
    for (const event of events) this.client.on(event, progress);
    let timer: ReturnType<typeof setTimeout>;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new Error(
            'Encrypted key backup is not yet confirmed. Keep this device signed in and retry.',
          ),
        );
      }, timeoutMs);
    });
    const bounded = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, expired]);
    const requestOptions = {
      prefix: ClientPrefix.V3,
      abortSignal: controller.signal,
      localTimeoutMs: timeoutMs,
    };
    const fingerprint = async (key: Partial<IMegolmSessionData>): Promise<string> => {
      if (typeof key.session_key !== 'string' || typeof key.sender_key !== 'string')
        throw new Error('Encrypted backup contains an invalid room key.');
      const value = JSON.stringify([
        key.session_key,
        key.sender_key,
        key.algorithm ?? 'm.megolm.v1.aes-sha2',
        key.sender_claimed_keys?.ed25519 ?? '',
      ]);
      const hash = await globalThis.crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(value),
      );
      return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join(
        '',
      );
    };
    const snapshot = async (): Promise<Map<string, string>> => {
      const keys = await this.crypto.exportRoomKeys();
      try {
        const result = new Map<string, string>();
        for (const key of keys)
          result.set(JSON.stringify([key.room_id, key.session_id]), await fingerprint(key));
        return result;
      } finally {
        for (const key of keys) key.session_key = '';
      }
    };
    let decryptor: BackupDecryptionKey | undefined;
    try {
      const check = await bounded(this.crypto.checkKeyBackupAndEnable());
      if (!check) {
        // SDK43 swallows discovery errors, including M_UNKNOWN_TOKEN. Confirm
        // this exact session independently; only a real typed 401 may reach the
        // caller's ended-session warning. A missing backup or network error
        // never authorizes cleanup.
        await bounded(
          this.client.http.authedRequest(
            Method.Get,
            '/account/whoami',
            undefined,
            undefined,
            requestOptions,
          ),
        );
      }
      if (
        !check?.trustInfo.trusted ||
        !check.trustInfo.matchesDecryptionKey ||
        !(await bounded(this.crypto.isSecretStorageReady()))
      )
        throw new Error('A trusted, recoverable key backup is required.');
      const version = check.backupInfo.version;
      if (
        check.backupInfo.algorithm !== 'm.megolm_backup.v1.curve25519-aes-sha2' ||
        (await bounded(this.crypto.getActiveSessionBackupVersion())) !== version
      )
        throw new Error('Encrypted key backup is not active.');
      const privateKey = await bounded(this.crypto.getSessionBackupPrivateKey());
      if (!privateKey) throw new Error('The backup recovery key is unavailable on this device.');
      try {
        decryptor = BackupDecryptionKey.fromBase64(btoa(String.fromCharCode(...privateKey)));
      } finally {
        privateKey.fill(0);
      }
      const publicKey = decryptor.megolmV1PublicKey;
      try {
        if (
          !('public_key' in check.backupInfo.auth_data) ||
          publicKey.publicKeyBase64 !== check.backupInfo.auth_data.public_key
        )
          throw new Error('The backup key does not match the trusted backup.');
      } finally {
        publicKey.free();
      }
      while (true) {
        const observed = revision;
        const local = await bounded(snapshot());
        const remote = await bounded(
          this.client.http.authedRequest<{
            rooms: Record<
              string,
              { sessions: Record<string, KeyBackupSession<Curve25519SessionData>> }
            >;
          }>(Method.Get, '/room_keys/keys', { version }, undefined, requestOptions),
        );
        let complete = true;
        for (const [id, expected] of local) {
          const [roomId, sessionId] = JSON.parse(id) as [string, string];
          const data = remote.rooms?.[roomId]?.sessions?.[sessionId]?.session_data;
          if (!data) {
            complete = false;
            break;
          }
          let recovered: Partial<IMegolmSessionData>;
          try {
            recovered = JSON.parse(decryptor.decryptV1(data.ephemeral, data.mac, data.ciphertext));
          } catch {
            throw new Error(
              'Encrypted backup readback failed authentication. Keep this device signed in.',
            );
          }
          try {
            if ((await bounded(fingerprint(recovered))) !== expected) {
              // The remote key can legitimately start earlier than our local export.
              // Ask Rust to prove coverage; never trust first_message_index metadata.
              const candidates = await bounded(this.crypto.exportRoomKeys());
              let covered = false;
              try {
                const current = candidates.find(
                  (key) => key.room_id === roomId && key.session_id === sessionId,
                );
                covered =
                  !!current &&
                  (await bounded(fingerprint(current))) === expected &&
                  (await bounded(backupKeyCoversLocal(current, recovered)));
              } finally {
                for (const key of candidates) key.session_key = '';
              }
              if (!covered) {
                complete = false;
                break;
              }
            }
          } finally {
            recovered.session_key = '';
          }
        }
        if (complete) {
          // Detect backup replacement/deletion and newly-created or improved room keys
          // during readback, rather than crediting an old zero-progress notification.
          const current = await bounded(
            this.client.http.authedRequest<KeyBackupInfo>(
              Method.Get,
              '/room_keys/version',
              undefined,
              undefined,
              requestOptions,
            ),
          );
          const trust = await bounded(this.crypto.isKeyBackupTrusted(current));
          if (
            current.version !== version ||
            !trust.trusted ||
            !trust.matchesDecryptionKey ||
            (await bounded(this.crypto.getActiveSessionBackupVersion())) !== version
          )
            throw new Error(
              'The trusted backup changed during verification. Keep this device signed in.',
            );
          const latest = await bounded(snapshot());
          if (latest.size === local.size && [...latest].every(([id, key]) => local.get(id) === key))
            return;
          continue;
        }
        if (revision !== observed) continue;
        await bounded(
          new Promise<void>((resolve) => {
            wake = resolve;
            if (revision !== observed) progress();
          }),
        );
      }
    } finally {
      clearTimeout(timer!);
      controller.abort();
      for (const event of events) this.client.removeListener(event, progress);
      wake = undefined;
      decryptor?.free();
    }
  }
  async requireVerifiedUser(userId: string): Promise<void> {
    await this.crypto.getUserDeviceInfo([this.session.userId, userId], true);
    const own = await this.crypto.getDeviceVerificationStatus(
      this.session.userId,
      this.session.deviceId,
    );
    const peer = await this.crypto.getUserVerificationStatus(userId);
    if (!own?.crossSigningVerified) throw new Error('Your own browser is not verified.');
    if (!peer.isCrossSigningVerified()) throw new Error('This friend’s identity is not verified.');
    if (peer.needsUserApproval)
      throw new Error('This friend’s changed identity still needs approval.');
  }
  private async waitForVerifiedUser(userId: string, timeoutMs = 15_000): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let checking = false,
        changed = false,
        finished = false;
      let lastError: unknown = new Error('Identity trust did not become ready.');
      const cleanup = () => {
        finished = true;
        clearTimeout(timer);
        this.client.removeListener(CryptoEvent.UserTrustStatusChanged, progress);
        this.client.removeListener(CryptoEvent.KeysChanged, check);
        this.client.removeListener(ClientEvent.Sync, check);
      };
      const check = async () => {
        if (finished) return;
        if (checking) {
          changed = true;
          return;
        }
        checking = true;
        try {
          await this.requireVerifiedUser(userId);
          cleanup();
          resolve();
        } catch (error) {
          lastError = error;
        } finally {
          checking = false;
          if (changed && !finished) {
            changed = false;
            void check();
          }
        }
      };
      const progress = (changedUserId: string) => {
        if (changedUserId === userId || changedUserId === this.session.userId) void check();
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(lastError);
      }, timeoutMs);
      this.client.on(CryptoEvent.UserTrustStatusChanged, progress);
      this.client.on(CryptoEvent.KeysChanged, check);
      this.client.on(ClientEvent.Sync, check);
      void check();
    });
  }
  async requestVerification(userId: string, roomId: string): Promise<void> {
    if (userId === this.session.userId) throw new Error('Use your recovery kit to add a browser.');
    this.watch(await this.crypto.requestVerificationDM(userId, roomId));
  }
  private watch(request: VerificationRequest): void {
    if (this.watched.has(request)) return;
    this.watched.add(request);
    // No add-browser flow: reject before attaching verifier or accept callbacks.
    if (request.otherUserId === this.session.userId) {
      void request.cancel().catch(() => {
        /* Still rejected locally if delivery fails. */
      });
      this.onVerificationRejected?.(
        'Another browser requested access to your account. The request was rejected. Use your saved recovery kit to add a browser.',
      );
      return;
    }
    const id = request.transactionId ?? crypto.randomUUID();
    try {
      if (this.terminalVerification(request.otherUserId, id)) {
        void request.cancel().catch(() => {});
        return;
      }
    } catch {
      this.onVerificationRejected?.(
        'Saved identity-check state could not be read. Reload before starting another check.',
      );
      return;
    }
    let sas: ShowSasCallbacks | null = null;
    let failure: string | undefined;
    let authenticated = false;
    let cancelledLocally = false;
    let confirmation: Promise<void> | undefined;
    const remember = () => this.terminalVerification(request.otherUserId, id, true);
    const emit = () => {
      const verifier = request.verifier;
      if (verifier && !this.verifiers.has(verifier)) {
        this.verifiers.add(verifier);
        verifier.on(VerifierEvent.ShowSas, (value) => {
          sas = value;
          emit();
        });
        verifier.on(VerifierEvent.Cancel, () => emit());
        sas = verifier.getShowSasCallbacks();
        void verifier
          .verify()
          .then(async () => {
            // The request phase can reach Done before asynchronous local trust
            // and signature processing finish. It alone is not sharing readiness.
            await confirmation;
            await this.waitForVerifiedUser(request.otherUserId);
            remember();
            authenticated = true;
            emit();
          })
          .catch((error: unknown) => {
            failure =
              'The identity comparison could not be authenticated. Cancel and start a new check with your friend.';
            if (
              error instanceof Error &&
              [
                'Your own browser is not verified.',
                'This friend’s identity is not verified.',
                'This friend’s changed identity still needs approval.',
              ].includes(error.message)
            )
              failure += ' ' + error.message;
            emit();
          });
      }
      if (request.phase === VerificationPhase.Cancelled) {
        this.cancelVerificationOrdering(request);
        try {
          remember();
        } catch {
          failure = 'The cancelled check could not be saved. Reload before starting another check.';
        }
      }
      const active = request.phase === VerificationPhase.Started && !failure;
      this.onVerification?.({
        id,
        peer: request.otherUserId,
        phase: cancelledLocally
          ? 'cancelled'
          : (request.phase === VerificationPhase.Done && !authenticated) ||
              (request.phase === VerificationPhase.Cancelled && failure)
            ? 'confirming'
            : VerificationPhase[request.phase].toLowerCase(),
        ...(request.cancellationCode ? { cancellationCode: request.cancellationCode } : {}),
        ...(request.cancellingUserId ? { cancelledBy: request.cancellingUserId } : {}),
        ...(failure ? { failure } : {}),
        ...(request.phase === VerificationPhase.Requested && !request.initiatedByMe
          ? { accept: () => request.accept() }
          : {}),
        ...(request.phase === VerificationPhase.Ready
          ? {
              compare: async () => {
                await request.startVerification('m.sas.v1');
                emit();
              },
            }
          : {}),
        ...(active && sas
          ? {
              emoji: sas.sas.emoji,
              decimal: sas.sas.decimal,
              confirm: () => {
                this.beginVerificationConfirmation(request);
                return (confirmation ??= sas!.confirm());
              },
              mismatch: () => sas!.mismatch(),
            }
          : {}),
        cancel: async () => {
          const errors: unknown[] = [];
          try {
            remember();
          } catch (error) {
            errors.push(error);
            failure =
              'The cancelled check could not be saved. Reload before starting another check.';
          }
          // Close locally and block queued Done before cancel() can emit a
          // synchronous SDK change. A failed journal must not prevent delivery
          // or recursively trigger cancellation while recovery is open.
          cancelledLocally = true;
          this.cancelVerificationOrdering(request);
          try {
            await request.cancel();
          } catch (error) {
            errors.push(error);
            failure =
              errors.length > 1
                ? 'The check was closed here, but cancellation could not be sent or saved. Reload before starting another check.'
                : 'The check was closed here, but cancellation could not be sent. Start a new check with your friend.';
          } finally {
            emit();
          }
          if (errors.length) {
            const message =
              errors.length > 1
                ? 'The check was closed here, but cancellation could not be sent or saved. Reload before starting another check.'
                : failure!;
            this.onVerificationRejected?.(message);
            throw new AggregateError(errors, message);
          }
        },
      });
    };
    request.on(VerificationRequestEvent.Change, emit);
    emit();
  }
  /** Call only after confirmed backup and successful logout or deactivation. */
  async forgetDevice(): Promise<void> {
    this.close();
    await forgetDeviceCrypto(this.session);
  }
  close(): void {
    for (const gate of this.verificationMacs.values())
      gate.reject(new Error('This browser session closed.'));
    this.verificationMacs.clear();
    this.client.stopClient();
    for (const key of this.keys.values()) key.fill(0);
    this.keys.clear();
    this.preparedRecovery?.privateKey.fill(0);
    this.preparedRecovery = null;
    this.unlock?.();
    this.unlock = undefined;
  }
}
