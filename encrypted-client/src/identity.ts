import { forgetDeviceCrypto } from './local-cleanup';
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
  initAsync,
} from '@matrix-org/matrix-sdk-crypto-wasm';
import type {
  KeyBackupInfo,
  Curve25519SessionData,
  KeyBackupSession,
} from 'matrix-js-sdk/lib/crypto-api/keybackup';
import type { IMegolmSessionData } from 'matrix-js-sdk/lib/@types/crypto';
import type { UIAuthCallback } from 'matrix-js-sdk/lib/interactive-auth';

export interface Session {
  baseUrl: string;
  userId: string;
  deviceId: string;
  accessToken: string;
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
    url.searchParams.set(
      'filter',
      JSON.stringify({ ...filter, 'org.cleanbookface.sync_instance': crypto.randomUUID() }),
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
  static async open(
    session: Session,
    onVerification?: (view: VerificationView) => void,
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
    const name = `clean-bookface:${session.baseUrl}:${session.userId}:${session.deviceId}`;
    await new Promise<void>((resolve, reject) => {
      void navigator.locks
        .request(name, { ifAvailable: true }, async (lock) => {
          if (!lock) {
            reject(new Error('This device is already open in another tab.'));
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
    return {
      hasIdentity,
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
    return s.hasIdentity && (!s.ownDeviceTrusted || !s.crossSigningReady);
  }
  /** Generate locally. The caller saves and confirms this kit before setupRecovery. */
  async prepareRecovery(): Promise<string> {
    if (this.pendingRecoveryKey) return this.pendingRecoveryKey;
    if (this.preparation) return this.preparation;
    this.preparation = (async () => {
      const s = await this.status();
      if (await this.client.secretStorage.hasKey())
        throw new Error('Recovery already exists. Use the existing recovery kit.');
      if (s.hasIdentity && !s.crossSigningReady)
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
    if (s.hasIdentity && !s.crossSigningReady) {
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
    await this.crypto.bootstrapCrossSigning({
      authUploadDeviceSigningKeys: this.passwordAuth(password),
    });
    // An interrupted run may already have created a backup. Never rotate that backup on retry.
    const backup = await this.crypto.getKeyBackupInfo();
    await this.crypto.bootstrapSecretStorage({
      createSecretStorageKey: async () => key,
      setupNewKeyBackup: !backup,
    });
    await this.crypto.crossSignDevice(this.session.deviceId);
    if (!(await this.crypto.isSecretStorageReady()))
      throw new Error('Recovery setup is incomplete. Keep the saved kit and retry on this device.');
    return key.encodedPrivateKey!;
  }
  async restoreRecovery(encoded: string, password: string): Promise<void> {
    const tuple = await this.client.secretStorage.getKey();
    if (!tuple) throw new Error('This account has no recovery kit.');
    const [id, info] = tuple;
    const key = decodeRecoveryKey(encoded);
    if (!(await this.client.secretStorage.checkKey(key, info))) {
      key.fill(0);
      throw new Error('Recovery key does not match this account.');
    }
    this.keys.set(id, key);
    try {
      // Never let bootstrap fall through to creating replacement keys.
      for (const name of [
        'm.cross_signing.master',
        'm.cross_signing.self_signing',
        'm.cross_signing.user_signing',
      ]) {
        if (!(await this.client.secretStorage.get(name)))
          throw new Error('Recovery identity is incomplete; refusing to replace it.');
      }
      if (!(await this.crypto.userHasCrossSigningKeys(this.session.userId, true)))
        throw new Error('Published recovery identity is unavailable.');
      await this.crypto.bootstrapCrossSigning({
        authUploadDeviceSigningKeys: this.passwordAuth(password),
      });
      await this.crypto.crossSignDevice(this.session.deviceId);
      await this.crypto.loadSessionBackupPrivateKeyFromSecretStorage();
      await this.crypto.restoreKeyBackup();
    } finally {
      this.keys.delete(id);
      key.fill(0);
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
    if (!own?.crossSigningVerified || !peer.isCrossSigningVerified() || peer.needsUserApproval)
      throw new Error('Verify this identity and your own device before sharing.');
  }
  async requestVerification(userId: string, roomId: string): Promise<void> {
    this.watch(await this.crypto.requestVerificationDM(userId, roomId));
  }
  private watch(request: VerificationRequest): void {
    if (this.watched.has(request)) return;
    this.watched.add(request);
    const id = request.transactionId ?? crypto.randomUUID();
    let sas: ShowSasCallbacks | null = null;
    let failure: string | undefined;
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
        void verifier.verify().then(emit, () => {
          failure = 'The identity comparison did not finish. Start a new check with your friend.';
          emit();
        });
      }
      const active = request.phase === VerificationPhase.Started;
      this.onVerification?.({
        id,
        peer: request.otherUserId,
        phase: VerificationPhase[request.phase].toLowerCase(),
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
              confirm: () => sas!.confirm(),
              mismatch: () => sas!.mismatch(),
            }
          : {}),
        cancel: () => request.cancel(),
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
    this.client.stopClient();
    for (const key of this.keys.values()) key.fill(0);
    this.keys.clear();
    this.preparedRecovery?.privateKey.fill(0);
    this.preparedRecovery = null;
    this.unlock?.();
    this.unlock = undefined;
  }
}
