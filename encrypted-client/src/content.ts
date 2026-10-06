import { prepareSharedPhoto, SHARED_PHOTO_LIMITS, validatePhotoHeader } from './shared-photo.js';
import { isBlocked } from './lifecycle';
import {
  type MatrixClient,
  type MatrixEvent,
  type Room,
  Preset,
  ClientEvent,
  EventStatus,
  EventTimeline,
  Method,
} from 'matrix-js-sdk';
import { AllDevicesIsolationMode } from 'matrix-js-sdk/lib/crypto-api/index.js';
import { Attachment, EncryptedAttachment, initAsync } from '@matrix-org/matrix-sdk-crypto-wasm';
import { enforceRecipientBoundary } from './recipient-boundary.js';
import { signContent, verifyContent, type SignedContent } from './signed-content.js';
import {
  parseSocial,
  socialState,
  type SocialPayload,
  type SocialAction,
  type SocialEvent,
  type SocialState,
} from './social.js';
import { ARCHIVE_LIMITS, exportArchives, importArchives, type MemoryRecord } from './archive.js';

export interface ArchiveConflict {
  originalId: string;
  versionIds: string[];
  partial?: true;
}
export interface ArchiveOverflow {
  limit: number;
  visibleRecords: number;
  byteLimit: number;
  visibleBytes: number;
  hasMore: true;
  reason: 'records' | 'bytes' | 'history';
}
export interface UnavailableContent {
  roomId: string;
  eventId?: string;
  reason: 'missing-key' | 'integrity' | 'room' | 'limit';
}
export interface ArchiveBatch {
  roomId: string;
  eventId: string;
  id: string;
  bytes: number;
}
export interface ArchiveBatchPage {
  batches: ArchiveBatch[];
  nextCursor?: string;
}
export interface ArchiveSearchHit {
  roomId: string;
  eventId: string;
  recordId: string;
  title: string;
  excerpt: string;
}
export interface ShareOutcome {
  userId: string;
  status: 'sent' | 'failed';
  error?: string;
}
export interface ShareResult {
  operationId: string;
  outcomes: ShareOutcome[];
}
export interface SharedPost {
  media?: Array<{ path: string; mimeType: string; size: number }>;
  mediaLoaded: boolean;
  readOnly: boolean;
  sharedAt: number;
  originalTimestamp: number | null;
  eventId: string;
  comments: SocialState['comments'];
  reactions: SocialState['reactions'];
  id: string;
  roomId: string;
  sender: string;
  timestamp: number;
  record: MemoryRecord;
}
declare module 'matrix-js-sdk/lib/@types/event.js' {
  interface TimelineEvents {
    'org.cleanbookface.content.v1': SignedContent;
  }
}
export class ArchiveHistoryUnavailable extends Error {
  readonly code = 'ARCHIVE_HISTORY_UNAVAILABLE';
  constructor(cause: unknown) {
    super(
      'Earlier saved archive history could not be verified. Synchronize or use your recovery kit, and download available saved parts before trying another import. Choosing the same files alone will not resolve this.',
      { cause },
    );
    this.name = 'ArchiveHistoryUnavailable';
  }
}
// Only locally recognized integrity/decryption failures need recovery guidance.
// Transport errors and scan budgets keep their original retry/limit semantics.
const historicalIntegrityErrors = new Set([
  'Encrypted history is unavailable',
  'Content could not be decrypted',
  'Plaintext content refused',
  'Missing or mismatched content context',
  'Untrusted encrypted sender',
  'Content signature is invalid',
  'Content requires a verified master signature',
  'Signed content context mismatch',
  'Invalid signed content',
  'Invalid signature encoding',
  'Invalid signature length',
  'Signing identity must be verified and unchanged',
  'Unknown signing identity',
  'Signing identity changed during verification',
  'Invalid verified master identity',
  'Invalid verified master key',
  'Unexpected private archive content.',
  'Invalid content object',
  'Unexpected content fields',
  'Invalid encrypted content',
  'Invalid encrypted chunk manifest',
  'Encrypted chunk order mismatch',
  'Duplicate encrypted chunk or key',
  'Encrypted chunk aggregate size mismatch',
  'Invalid encrypted attachment',
  'Invalid attachment encryption information',
  'Social content in private archive',
  'Unexpected content sender',
]);
class PhotoPresentationLimit extends Error {
  constructor() {
    super('Older shared photos exceed the presentation photo/pixel budget');
  }
}
class HistoryScanLimit extends Error {
  constructor() {
    super('Archive history scan limit exceeded; retry after synchronization');
  }
}
const EVENT = 'org.cleanbookface.content.v1';
const ROOM = 'org.cleanbookface.room.v1';
const ALGORITHM = 'm.megolm.v1.aes-sha2';
const MAX = ARCHIVE_LIMITS.maxCompressedBytes;
export const CONTENT_LIMITS = Object.freeze({
  maxBytes: MAX,
  maxChunks: 32,
  chunkBytes: 8 * 1024 * 1024,
  visibleBytes: MAX,
  archiveRoomsPerPage: 16,
  feedPageSize: 20,
  feedPageBytes: 32 * 1024 * 1024,
  sharedPhotos: 4,
  legacySharedPhotos: 32,
  legacyDecodedPixels: 40_000_000,
  searchIndexBytes: 8 * 1024 * 1024,
});
type FileDescriptor = { url: string; info: string; size: number };
type ChunkDescriptor = FileDescriptor & { index: number };
type SearchRow = Pick<MemoryRecord, 'id' | 'title' | 'text'>;
type SearchIndex = {
  version: 1;
  archiveId: string;
  count: number;
  sha256: string;
  file: FileDescriptor;
};
type PayloadBase = {
  version: 2;
  purpose: 'archive' | 'post';
  id: string;
  searchIndex?: SearchIndex;
};
type StoredPayload = PayloadBase &
  ({ file: FileDescriptor } | { chunks: ChunkDescriptor[]; size: number });
type SharedFields = Pick<
  MemoryRecord,
  'id' | 'kind' | 'text' | 'title' | 'timestamp' | 'sourcePath' | 'privateOnly'
>;
type SharedPhoto = { path: string; mimeType: 'image/jpeg'; sha256: string; file: FileDescriptor };
type LazyPostPayload = {
  version: 3;
  purpose: 'post';
  id: string;
  record: SharedFields;
  photos: SharedPhoto[];
};
type Payload = StoredPayload | LazyPostPayload;
type PendingUpload = {
  archive: Blob;
  search?: { blob: Blob; hash: string; count: number; file?: FileDescriptor };
  chunkSize: number;
  files: FileDescriptor[];
  running?: Promise<StoredPayload>;
};
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Invalid content object');
  return v as Record<string, unknown>;
};
const exact = (v: Record<string, unknown>, keys: string[]) => {
  if (Object.keys(v).sort().join(',') !== keys.sort().join(','))
    throw new Error('Unexpected content fields');
};
function descriptor(
  value: unknown,
  cap: number,
  index?: number,
): { file: FileDescriptor; key: string } {
  const f = object(value);
  exact(f, index === undefined ? ['url', 'info', 'size'] : ['index', 'url', 'info', 'size']);
  if (index !== undefined && f.index !== index) throw new Error('Encrypted chunk order mismatch');
  if (
    typeof f.url !== 'string' ||
    f.url.length > 512 ||
    !/^mxc:\/\/[A-Za-z0-9.:[\]-]+\/[A-Za-z0-9_-]+$/u.test(f.url) ||
    typeof f.info !== 'string' ||
    f.info.length > 4096 ||
    !Number.isSafeInteger(f.size) ||
    (f.size as number) < 1 ||
    (f.size as number) > cap
  )
    throw new Error('Invalid encrypted attachment');
  const info = object(JSON.parse(f.info));
  exact(info, ['v', 'key', 'iv', 'hashes']);
  const key = object(info.key),
    hashes = object(info.hashes);
  if (
    info.v !== 'v2' ||
    key.kty !== 'oct' ||
    key.alg !== 'A256CTR' ||
    typeof key.k !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/u.test(key.k) ||
    typeof info.iv !== 'string' ||
    !/^[A-Za-z0-9+/]{22}={0,2}$/u.test(info.iv) ||
    typeof hashes.sha256 !== 'string' ||
    !/^[A-Za-z0-9+/]{43}=?$/u.test(hashes.sha256)
  )
    throw new Error('Invalid attachment encryption information');
  return { file: f as unknown as FileDescriptor, key: key.k };
}
function payload(value: unknown): Payload {
  const p = object(value);
  if (p.version === 3) {
    exact(p, ['version', 'purpose', 'id', 'record', 'photos']);
    const r = object(p.record);
    exact(r, ['id', 'kind', 'text', 'title', 'timestamp', 'sourcePath', 'privateOnly']);
    if (
      p.purpose !== 'post' ||
      typeof p.id !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(p.id) ||
      typeof r.id !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(r.id) ||
      !['post', 'photo', 'album'].includes(String(r.kind)) ||
      typeof r.text !== 'string' ||
      r.text.length > 16000 ||
      typeof r.title !== 'string' ||
      r.title.length > 1024 ||
      r.sourcePath !== '' ||
      r.privateOnly !== false ||
      (r.timestamp !== null &&
        (!Number.isSafeInteger(r.timestamp) ||
          Number(r.timestamp) < -62135596800000 ||
          Number(r.timestamp) > 253402300799999)) ||
      !Array.isArray(p.photos) ||
      p.photos.length > CONTENT_LIMITS.sharedPhotos
    )
      throw new Error('Invalid lazy shared copy');
    const urls = new Set<string>(),
      keys = new Set<string>();
    p.photos.forEach((value, index) => {
      const photo = object(value);
      exact(photo, ['path', 'mimeType', 'sha256', 'file']);
      if (
        photo.path !== `photo-${index + 1}.jpg` ||
        photo.mimeType !== 'image/jpeg' ||
        typeof photo.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(photo.sha256)
      )
        throw new Error('Invalid shared photo descriptor');
      const parsed = descriptor(photo.file, SHARED_PHOTO_LIMITS.outputBytes);
      if (urls.has(parsed.file.url) || keys.has(parsed.key))
        throw new Error('Duplicate shared photo or key');
      urls.add(parsed.file.url);
      keys.add(parsed.key);
    });
    if (JSON.stringify(p).length > 24000)
      throw new Error('Shared post exceeds signed-envelope budget');
    return p as unknown as LazyPostPayload;
  }
  if (
    p.version !== 2 ||
    !['archive', 'post'].includes(String(p.purpose)) ||
    typeof p.id !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(p.id)
  )
    throw new Error('Invalid encrypted content');
  const optional = Object.hasOwn(p, 'searchIndex') ? ['searchIndex'] : [];
  if (optional.length) {
    const index = object(p.searchIndex);
    exact(index, ['version', 'archiveId', 'count', 'sha256', 'file']);
    if (
      p.purpose !== 'archive' ||
      index.version !== 1 ||
      index.archiveId !== p.id ||
      !Number.isSafeInteger(index.count) ||
      (index.count as number) < 1 ||
      (index.count as number) > 100000 ||
      typeof index.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(index.sha256)
    )
      throw new Error('Invalid archive search index');
    descriptor(index.file, CONTENT_LIMITS.searchIndexBytes);
  }
  if (Object.hasOwn(p, 'file')) {
    exact(p, ['version', 'purpose', 'id', 'file', ...optional]);
    descriptor(p.file, MAX);
  } else {
    exact(p, ['version', 'purpose', 'id', 'chunks', 'size', ...optional]);
    if (
      !Array.isArray(p.chunks) ||
      p.chunks.length < 2 ||
      p.chunks.length > CONTENT_LIMITS.maxChunks ||
      !Number.isSafeInteger(p.size) ||
      (p.size as number) < 1 ||
      (p.size as number) > MAX
    )
      throw new Error('Invalid encrypted chunk manifest');
    let total = 0;
    const urls = new Set<string>(),
      keys = new Set<string>();
    p.chunks.forEach((chunk, index) => {
      const { file, key } = descriptor(chunk, CONTENT_LIMITS.chunkBytes, index);
      if (urls.has(file.url) || keys.has(key)) throw new Error('Duplicate encrypted chunk or key');
      urls.add(file.url);
      keys.add(key);
      total += file.size;
    });
    if (total !== p.size) throw new Error('Encrypted chunk aggregate size mismatch');
  }
  if (JSON.stringify(p).length > 24000)
    throw new Error('Encrypted manifest exceeds signed-envelope budget');
  return p as unknown as Payload;
}
async function sha(data: string | Blob): Promise<string> {
  const bytes =
    typeof data === 'string' ? new TextEncoder().encode(data) : await data.arrayBuffer();
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
async function identity(records: MemoryRecord[]): Promise<string> {
  return sha(
    canonical(
      await Promise.all(
        records.map(async (r) => ({
          ...r,
          provenance: r.provenance ?? {},
          attachments: await Promise.all(
            r.attachments.map(async (a) => ({
              path: a.path,
              mimeType: a.mimeType,
              sha256: await sha(a.bytes),
            })),
          ),
        })),
      ),
    ),
  );
}
/** Decode and re-encode pixels; filenames and image metadata never enter shared copies. */
async function sharedCopy(record: MemoryRecord): Promise<MemoryRecord> {
  if (record.privateOnly || record.kind === 'message' || record.kind === 'friend')
    throw new Error('Private conversations and friend records cannot be shared');
  if (
    !['post', 'photo', 'album'].includes(record.kind) ||
    typeof record.text !== 'string' ||
    typeof record.title !== 'string'
  )
    throw new Error('Invalid shared record');
  if (record.attachments.length > CONTENT_LIMITS.sharedPhotos)
    throw new Error('Share at most four photos');
  if (record.text.length > 16000 || record.title.length > 1024)
    throw new Error('Shared text exceeds limit');
  const attachments: MemoryRecord['attachments'] = [];
  for (const attachment of record.attachments) {
    const prepared = await prepareSharedPhoto(attachment);
    attachments.push({ path: `photo-${attachments.length + 1}.jpg`, ...prepared });
  }
  const copy: MemoryRecord = {
    id: 'shared',
    kind: record.kind,
    text: record.text,
    title: record.title,
    timestamp: record.timestamp,
    sourcePath: '',
    privateOnly: false,
    attachments,
  };
  copy.id = await identity([copy]);
  return copy;
}

export class ContentStore {
  private verifiedSocial = new WeakMap<MatrixEvent, SocialPayload>();
  private verifiedPayloads = new WeakMap<MatrixEvent, Payload>();
  private revoked = new Set<string>();
  private conflicts: ArchiveConflict[] = [];
  private unavailable = new Map<string, UnavailableContent>();
  unavailableContent(): UnavailableContent[] {
    return [...this.unavailable.values()].map((part) => ({ ...part }));
  }
  private quarantine(
    roomId: string,
    event: MatrixEvent | undefined,
    reason: UnavailableContent['reason'],
  ): void {
    const eventId = event?.getId();
    this.unavailable.set(`${roomId}\0${eventId ?? 'room'}`, {
      roomId,
      ...(eventId ? { eventId } : {}),
      reason,
    });
  }
  private overflow: ArchiveOverflow | null = null;
  archiveOverflow(): ArchiveOverflow | null {
    return this.overflow ? { ...this.overflow } : null;
  }
  archiveConflicts(): ArchiveConflict[] {
    return this.conflicts.map((conflict) => ({
      ...conflict,
      versionIds: [...conflict.versionIds],
    }));
  }
  private appendIndexes = new Map<
    string,
    { length: number; fingerprint: string; ids: Set<string>; anchor?: MatrixEvent }
  >();
  private preparedSessions = new WeakSet<Room>();
  private recoveredHistoryTokens = new WeakSet<Room>();
  private legacyPostPixels = new WeakMap<SharedPost, number>();
  private locked: { roomId: string; userId: string; reason: string }[] = [];
  private downloads = new Map<string, { records: MemoryRecord[]; bytes: number }>();
  private cachedBytes = 0;
  lockedRooms(): { roomId: string; userId: string; reason: string }[] {
    return this.locked.map((r) => ({ ...r }));
  }
  private creatingArchive?: Promise<string>;
  private uploads = new Map<string, StoredPayload>();
  private sharedUploads = new Map<string, LazyPostPayload>();
  private feedGeneration = 0;
  private feedSnapshot?: {
    roomId?: string;
    id: string;
    created: number;
    limited: boolean;
    entries: Array<{
      event: MatrixEvent;
      events: MatrixEvent[];
      peer: string;
      readOnly: boolean;
      id: string;
    }>;
  };
  private conversationExports = new Map<
    string,
    {
      id: string;
      created: number;
      units: Array<{
        event: MatrixEvent;
        state: SocialState;
        comment?: SocialState['comments'][number];
      }>;
      peer: string;
    }
  >();
  private lazyPosts = new Map<
    string,
    { payload: LazyPostPayload; event: MatrixEvent; peer: string }
  >();
  private pendingUploads = new Map<string, PendingUpload>();
  constructor(
    private client: MatrixClient,
    private requireVerifiedUser: (id: string) => Promise<void>,
  ) {}
  private own(): string {
    const id = this.client.getUserId();
    if (!id) throw new Error('Sign in first');
    return id;
  }
  private crypto() {
    const c = this.client.getCrypto();
    if (!c || !c.getVersion().startsWith('Rust SDK'))
      throw new Error('Rust encryption must be enabled');
    c.globalBlacklistUnverifiedDevices = true;
    c.setDeviceIsolationMode(new AllDevicesIsolationMode(true));
    return c;
  }
  private room(id: string): Room {
    const r = this.client.getRoom(id);
    if (!r) throw new Error('Room not synced yet; retry after sync');
    return r;
  }
  private async waitForJoinedRoom(id: string, peer?: string): Promise<void> {
    // Room creation/join reaches the JS room store before the Rust worker has
    // consumed encryption state. Wait only on this fresh-room path; normal
    // guards must still reject encryption loss immediately.
    await new Promise<void>((resolve, reject) => {
      let done = false,
        checking = false;
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(deadline);
        clearInterval(recheck);
        this.client.off(ClientEvent.Sync, check);
        this.client.off(ClientEvent.Room, check);
        error ? reject(error) : resolve();
      };
      const check = () => {
        if (done || checking) return;
        checking = true;
        void (async () => {
          const room = this.client.getRoom(id);
          if (room?.getMyMembership() !== 'join') return;
          const algorithm = room.currentState
            .getStateEvents('m.room.encryption', '')
            ?.getContent().algorithm;
          if (algorithm === undefined) return;
          if (algorithm !== ALGORITHM) throw new Error('Room encryption missing or downgraded');
          if (!(await this.crypto().isEncryptionEnabledInRoom(id))) return;
          await room.loadMembersIfNeeded();
          const purpose = this.purpose(room);
          const history = room.currentState
            .getStateEvents('m.room.history_visibility', '')
            ?.getContent().history_visibility;
          if (purpose === undefined || history === undefined) return;
          if (purpose !== (peer ? 'pair' : 'archive') || history !== 'joined')
            throw new Error('Unexpected fresh room state');
          const members = room
            .getMembers()
            .filter((m) => m.membership === 'join' || m.membership === 'invite');
          const expected = peer ? [this.own(), peer] : [this.own()];
          if (members.some((m) => !expected.includes(m.userId)))
            throw new Error('Unexpected room membership');
          if (expected.some((user) => !members.some((m) => m.userId === user))) return;
          // A deliberate new invitation may replace a revoked friendship, but
          // only an explicit invitation or acceptance clears revocation after
          // the complete state has passed these checks.
          this.check(room, peer, true);
          finish();
        })()
          .catch((error) =>
            finish(
              error instanceof Error ? error : new Error('Encrypted room synchronization failed'),
            ),
          )
          .finally(() => {
            checking = false;
          });
      };
      const deadline = setTimeout(
        () => finish(new Error('Encrypted room sync timed out; retry after sync')),
        30000,
      );
      // Rust state processing can finish after the final SDK Sync emission.
      const recheck = setInterval(check, 100);
      this.client.on(ClientEvent.Sync, check);
      this.client.on(ClientEvent.Room, check);
      check();
    });
  }
  private purpose(r: Room): unknown {
    return r.currentState.getStateEvents(ROOM, '')?.getContent().purpose;
  }
  private check(r: Room, peer?: string, allowRevoked = false): void {
    const crypto = this.crypto() as ReturnType<ContentStore['crypto']> & {
      roomEncryptors?: Record<string, { room?: Room }>;
    };
    const encryptorRoom = crypto.roomEncryptors?.[r.roomId]?.room;
    if (encryptorRoom && encryptorRoom !== r) throw new Error('SDK room identity mismatch');
    if (peer && isBlocked(this.client, peer)) throw new Error('Friend is blocked');
    if (
      r.currentState.getStateEvents('m.room.encryption', '')?.getContent().algorithm !== ALGORITHM
    )
      throw new Error('Room encryption missing or downgraded');
    if (
      r.currentState.getStateEvents('m.room.history_visibility', '')?.getContent()
        .history_visibility !== 'joined'
    )
      throw new Error('Room history must be restricted to joined members');
    if (this.purpose(r) !== (peer ? 'pair' : 'archive')) throw new Error('Wrong content room');
    const members = r
      .getMembers()
      .filter((m) => m.membership === 'join' || m.membership === 'invite');
    const expected = peer ? [this.own(), peer] : [this.own()];
    if (
      members.length !== expected.length ||
      members.some((m) => !expected.includes(m.userId)) ||
      !members.some((m) => m.userId === this.own() && m.membership === 'join')
    )
      throw new Error('Unexpected room membership');
    if (peer && this.revoked.has(peer) && !allowRevoked) throw new Error('Friend is revoked');
    enforceRecipientBoundary(
      r,
      expected,
      () => this.check(r, peer),
      async () => {
        await this.crypto().forceDiscardSession(r.roomId);
      },
    );
  }
  private async guard(id: string, peer?: string): Promise<Room> {
    const r = this.room(id);
    await r.loadMembersIfNeeded();
    await this.requireVerifiedUser(this.own());
    if (peer) await this.requireVerifiedUser(peer);
    if (!(await this.crypto().isEncryptionEnabledInRoom(id)))
      throw new Error('Crypto does not recognize encrypted room');
    r.setBlacklistUnverifiedDevices(true);
    this.check(r, peer);
    await this.prepareSession(r);
    this.check(r, peer);
    return r;
  }
  /** Historical reads do not authorize a send, rotate a session or un-revoke a peer. */
  private async readGuard(id: string, peer: string): Promise<Room> {
    const room = this.room(id);
    await room.loadMembersIfNeeded();
    await this.requireVerifiedUser(this.own());
    if (
      this.purpose(room) !== 'pair' ||
      room.currentState.getStateEvents('m.room.encryption', '')?.getContent().algorithm !==
        ALGORITHM ||
      room.currentState.getStateEvents('m.room.history_visibility', '')?.getContent()
        .history_visibility !== 'joined' ||
      !['join', 'leave', 'ban'].includes(room.getMyMembership()) ||
      !(await this.crypto().isEncryptionEnabledInRoom(id))
    )
      throw new Error('Historical room policy could not be verified');
    const members = room.getMembers();
    if (
      members.length !== 2 ||
      !members.some((m) => m.userId === this.own()) ||
      !members.some((m) => m.userId === peer) ||
      members.some((m) => ![this.own(), peer].includes(m.userId))
    )
      throw new Error('Unexpected historical room membership');
    return room;
  }
  conversationRooms(): Array<{ roomId: string; userId: string; readOnly: boolean }> {
    const active = new Set(this.friendRooms().map((r) => r.roomId));
    return this.client
      .getRooms()
      .filter(
        (room) =>
          this.purpose(room) === 'pair' &&
          ['join', 'leave', 'ban'].includes(room.getMyMembership()),
      )
      .flatMap((room) => {
        const members = room.getMembers(),
          peers = members.filter((m) => m.userId !== this.own());
        if (peers.length !== 1 || !members.some((m) => m.userId === this.own())) return [];
        return [
          { roomId: room.roomId, userId: peers[0].userId, readOnly: !active.has(room.roomId) },
        ];
      })
      .sort((a, b) => a.roomId.localeCompare(b.roomId));
  }
  private async prepareSession(room: Room): Promise<void> {
    if (this.preparedSessions.has(room)) return;
    await this.crypto().forceDiscardSession(room.roomId);
    this.preparedSessions.add(room);
  }
  async prepareVerification(roomId: string, userId: string): Promise<void> {
    const room = this.room(roomId);
    await room.loadMembersIfNeeded();
    if (!(await this.crypto().isEncryptionEnabledInRoom(roomId)))
      throw new Error('Crypto does not recognize encrypted room');
    room.setBlacklistUnverifiedDevices(true);
    this.check(room, userId);
    await this.prepareSession(room);
    this.check(room, userId);
  }
  friendRooms(): { roomId: string; userId: string }[] {
    const out: { roomId: string; userId: string }[] = [];
    for (const r of this.client.getRooms()) {
      if (this.purpose(r) !== 'pair' || r.getMyMembership() !== 'join') continue;
      const other = r
        .getMembers()
        .filter((m) => m.userId !== this.own() && ['join', 'invite'].includes(m.membership ?? ''));
      if (
        other.length !== 1 ||
        this.revoked.has(other[0].userId) ||
        isBlocked(this.client, other[0].userId)
      )
        continue;
      try {
        this.check(r, other[0].userId);
        out.push({ roomId: r.roomId, userId: other[0].userId });
      } catch {
        /* Invalid rooms are not usable friendships. */
      }
    }
    return out.sort((a, b) => a.roomId.localeCompare(b.roomId));
  }
  private async create(peer?: string): Promise<string> {
    this.crypto();
    const response = await this.client.createRoom({
      preset: Preset.PrivateChat,
      invite: peer ? [peer] : [],
      initial_state: [
        { type: 'm.room.encryption', state_key: '', content: { algorithm: ALGORITHM } },
        {
          type: 'm.room.history_visibility',
          state_key: '',
          content: { history_visibility: 'joined' },
        },
        { type: ROOM, state_key: '', content: { purpose: peer ? 'pair' : 'archive' } },
      ],
      power_level_content_override: {
        events_default: 0,
        state_default: 100,
        invite: 100,
        // Room v12 gives the creator implicit powers; an explicit users entry is invalid.
      },
    });
    await this.waitForJoinedRoom(response.room_id, peer);
    return response.room_id;
  }
  async inviteFriend(userId: string): Promise<string> {
    if (isBlocked(this.client, userId)) throw new Error('Friend is blocked');
    if (!/^@[^\s:]+:[^\s]+$/u.test(userId) || userId === this.own())
      throw new Error('Enter another Matrix user ID');
    const old = this.friendRooms().find((r) => r.userId === userId);
    if (old) return old.roomId;
    const id = await this.create(userId);
    this.revoked.delete(userId);
    return id;
  }
  async acceptInvite(roomId: string): Promise<void> {
    const r = this.room(roomId);
    const peers = r
      .getMembers()
      .filter((m) => m.userId !== this.own() && ['join', 'invite'].includes(m.membership ?? ''));
    if (peers.length !== 1) throw new Error('Invitation must have exactly one peer');
    if (isBlocked(this.client, peers[0].userId)) throw new Error('Friend is blocked');
    this.crypto();
    if (r.getMyMembership() !== 'invite' || peers[0].membership !== 'join')
      throw new Error('Expected an invitation from one joined peer');
    const algorithm = r.currentState
      .getStateEvents('m.room.encryption', '')
      ?.getContent().algorithm;
    if (algorithm !== undefined && algorithm !== ALGORITHM)
      throw new Error('Invitation encryption is unsupported');
    // Invites contain stripped state and may omit our marker/history policy. Joining
    // grants no content publication authority: inspect the full state before use.
    await this.client.joinRoom(roomId);
    try {
      await this.waitForJoinedRoom(roomId, peers[0].userId);
      const joined = this.room(roomId);
      await joined.loadMembersIfNeeded();
      this.check(joined, peers[0].userId, true);
      // Accepting a fresh invitation deliberately restores this friendship.
      // Keep revocation in place until the full membership and encryption
      // policy have passed; check() still rejects persistent blocks.
      this.revoked.delete(peers[0].userId);
    } catch (e) {
      await this.client.leave(roomId);
      throw e;
    }
  }
  async revokeFriend(userId: string): Promise<void> {
    const rooms = this.client
      .getRooms()
      .filter(
        (r) =>
          this.purpose(r) === 'pair' &&
          r.getMyMembership() === 'join' &&
          r.getMembers().some((m) => m.userId === userId),
      );
    this.revoked.add(userId);
    for (const r of rooms) await this.client.leave(r.roomId);
  }
  private archiveRooms(): Room[] {
    return this.client
      .getRooms()
      .filter((r) => this.purpose(r) === 'archive' && r.getMyMembership() === 'join')
      .sort((a, b) => (a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0));
  }
  private async archiveRoom(create: boolean): Promise<string | undefined> {
    const rooms = this.archiveRooms();
    if (rooms[0]) {
      await this.guard(rooms[0].roomId);
      return rooms[0].roomId;
    }
    if (!create) return undefined;
    this.creatingArchive ??= this.create().catch((e) => {
      this.creatingArchive = undefined;
      throw e;
    });
    return this.creatingArchive;
  }
  private recordBytes(record: MemoryRecord): number {
    const { attachments, ...fields } = record;
    return (
      new TextEncoder().encode(
        JSON.stringify({
          ...fields,
          attachments: attachments.map(({ bytes, ...metadata }) => metadata),
        }),
      ).length + attachments.reduce((sum, a) => sum + a.bytes.size, 0)
    );
  }
  /** Paged authenticated manifests only; downloading a batch separately validates every byte. */
  async archiveBatches(
    cursor?: string,
    limit = 50,
    allowPartial = false,
  ): Promise<ArchiveBatchPage> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Archive batch page size must be 1–100');
    const rooms = this.archiveRooms();
    let start = 0,
      after: string | undefined;
    if (cursor) {
      if (cursor.length > 4096) throw new Error('Invalid archive batch cursor');
      const parsed = object(JSON.parse(decodeURIComponent(cursor)));
      if (
        typeof parsed.roomId !== 'string' ||
        (parsed.after !== undefined && typeof parsed.after !== 'string') ||
        Object.keys(parsed).some((key) => !['roomId', 'after'].includes(key))
      )
        throw new Error('Invalid archive batch cursor');
      start = rooms.findIndex((room) => room.roomId === parsed.roomId);
      after = parsed.after as string | undefined;
      if (start < 0) throw new Error('Archive batch cursor is stale; start again');
    }
    const batches: ArchiveBatch[] = [];
    let last: { roomId: string; after: string } | undefined;
    const deadline = Date.now() + 30000;
    for (let index = start; index < rooms.length; index++) {
      if (index - start >= CONTENT_LIMITS.archiveRoomsPerPage || Date.now() > deadline)
        return {
          batches,
          nextCursor: encodeURIComponent(JSON.stringify({ roomId: rooms[index].roomId })),
        };
      const roomId = rooms[index].roomId;
      try {
        for await (const event of this.scanEvents(
          roomId,
          undefined,
          index === start ? after : undefined,
          allowPartial,
        )) {
          const eventId = event.getId();
          if (!eventId) throw new Error('Archive batch has no event identity');
          const p = this.verifiedPayloads.get(event)!;
          if (p.purpose !== 'archive') {
            if (!allowPartial) throw new Error('Unexpected archive payload');
            this.quarantine(roomId, event, 'integrity');
            continue;
          }
          if (batches.length >= limit)
            return { batches, nextCursor: encodeURIComponent(JSON.stringify(last)) };
          batches.push({ roomId, eventId, id: p.id, bytes: 'file' in p ? p.file.size : p.size });
          last = { roomId, after: eventId };
        }
      } catch (error) {
        if (!(error instanceof HistoryScanLimit)) throw error;
        const resume =
          last?.roomId === roomId
            ? last
            : { roomId, ...(index === start && after ? { after } : {}) };
        return { batches, nextCursor: encodeURIComponent(JSON.stringify(resume)) };
      }
    }
    return { batches };
  }
  async downloadArchiveBatch(roomId: string, eventId: string): Promise<Blob> {
    return exportArchives(await this.readArchiveBatch(roomId, eventId));
  }
  async readArchiveBatch(roomId: string, eventId: string): Promise<MemoryRecord[]> {
    return this.download(await this.archivePayload(roomId, eventId));
  }
  private async archivePayload(roomId: string, eventId: string): Promise<StoredPayload> {
    if (!this.archiveRooms().some((room) => room.roomId === roomId))
      throw new Error('Archive room is not available');
    await this.guard(roomId);
    let event: MatrixEvent | undefined;
    for await (const candidate of this.scanEvents(roomId, undefined, undefined, true)) {
      if (candidate.getId() === eventId) {
        event = candidate;
        break;
      }
    }
    if (!event) throw new Error('Archive batch is not available');
    const p = this.verifiedPayloads.get(event)!;
    if (p.purpose !== 'archive') throw new Error('Unexpected archive payload');
    return p;
  }
  private async searchRows(p: StoredPayload): Promise<SearchRow[]> {
    if (!p.searchIndex) return this.download(p);
    try {
      const bytes = await this.downloadPart(p.searchIndex.file);
      try {
        if ((await sha(new Blob([bytes]))) !== p.searchIndex.sha256)
          throw new Error('Search index hash mismatch');
        const index = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
        exact(index, ['version', 'archiveId', 'records']);
        if (
          index.version !== 1 ||
          index.archiveId !== p.id ||
          !Array.isArray(index.records) ||
          index.records.length !== p.searchIndex.count
        )
          throw new Error('Search index binding mismatch');
        const ids = new Set<string>();
        return index.records.map((value: unknown) => {
          const row = object(value);
          exact(row, ['id', 'title', 'text']);
          if (
            typeof row.id !== 'string' ||
            !row.id ||
            row.id.length > 200 ||
            ids.has(row.id) ||
            typeof row.title !== 'string' ||
            typeof row.text !== 'string'
          )
            throw new Error('Invalid search index record');
          ids.add(row.id);
          return row as SearchRow;
        });
      } finally {
        bytes.fill(0);
      }
    } catch {
      // An unavailable optional accelerator never hides authoritative archive records.
      return this.download(p);
    }
  }
  /** Search one authenticated saved part at a time; retain small excerpts, never all media. */
  async searchArchive(
    query: string,
    limit = 50,
    onProgress?: (parts: number) => void,
    signal?: AbortSignal,
  ): Promise<{ matches: ArchiveSearchHit[]; partsChecked: number; limited: boolean }> {
    const term = query.trim().toLocaleLowerCase();
    if (
      term.length < 2 ||
      term.length > 200 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Error('Search for 2–200 characters, with at most 100 results.');
    const matches: ArchiveSearchHit[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined,
      partsChecked = 0,
      incomplete = false;
    do {
      signal?.throwIfAborted();
      const page = await this.archiveBatches(cursor, 50, true);
      for (const batch of page.batches) {
        if (seen.has(batch.id)) continue;
        seen.add(batch.id);
        signal?.throwIfAborted();
        let rows: SearchRow[];
        try {
          rows = await this.searchRows(await this.archivePayload(batch.roomId, batch.eventId));
        } catch {
          signal?.throwIfAborted();
          incomplete = true;
          this.unavailable.set(`${batch.roomId}\0${batch.eventId}`, {
            roomId: batch.roomId,
            eventId: batch.eventId,
            reason: 'integrity',
          });
          partsChecked++;
          onProgress?.(partsChecked);
          continue;
        }
        for (const row of rows) {
          const value = `${row.title}\n${row.text}`,
            at = value.toLocaleLowerCase().indexOf(term);
          if (at < 0) continue;
          if (matches.length === limit) return { matches, partsChecked, limited: true };
          matches.push({
            roomId: batch.roomId,
            eventId: batch.eventId,
            recordId: row.id,
            title: row.title.slice(0, 160),
            excerpt: value.slice(Math.max(0, at - 40), at + 200),
          });
        }
        partsChecked++;
        onProgress?.(partsChecked);
      }
      if (page.nextCursor && page.nextCursor === cursor)
        throw new Error('Archive search made no progress. Refresh and retry.');
      cursor = page.nextCursor;
    } while (cursor);
    return {
      matches,
      partsChecked,
      limited:
        incomplete ||
        [...this.unavailable.values()].some((item) =>
          this.archiveRooms().some((room) => room.roomId === item.roomId),
        ),
    };
  }
  private async upload(
    records: MemoryRecord[],
    purpose: StoredPayload['purpose'],
  ): Promise<StoredPayload> {
    const id = await identity(records),
      cacheKey = `${purpose}:${id}`;
    const cached = this.uploads.get(cacheKey);
    if (cached) return cached;
    let pending = this.pendingUploads.get(cacheKey);
    if (!pending) {
      const config = await this.client.getMediaConfig(true),
        configured = config['m.upload.size'];
      if (
        configured !== undefined &&
        (typeof configured !== 'number' || !Number.isSafeInteger(configured) || configured < 1)
      )
        throw new Error('Invalid homeserver upload limit');
      const chunkSize = Math.min(
        CONTENT_LIMITS.chunkBytes,
        configured ?? CONTENT_LIMITS.chunkBytes,
      );
      const minimum = records.reduce(
        (n, r) =>
          n +
          new TextEncoder().encode(r.text + r.title).length +
          r.attachments.reduce((sum, a) => sum + a.bytes.size, 0),
        0,
      );
      if (minimum > MAX || Math.ceil(minimum / chunkSize) > CONTENT_LIMITS.maxChunks)
        throw new Error(
          'Archive exceeds bounded homeserver upload limit (32 encrypted chunks maximum)',
        );
      const archive = await exportArchives(records);
      if (archive.size > MAX || Math.ceil(archive.size / chunkSize) > CONTENT_LIMITS.maxChunks)
        throw new Error(
          'Archive exceeds bounded homeserver upload limit (32 encrypted chunks maximum)',
        );
      const checked = await importArchives([new File([archive], 'archive.zip')]);
      if (checked.warnings.length || (await identity(checked.records)) !== id)
        throw new Error('Invalid archive records');
      pending = this.pendingUploads.get(cacheKey);
      if (!pending) {
        // Bound retained plaintext retry material to one aggregate archive budget.
        while (
          [...this.pendingUploads.values()].reduce(
            (n, p) => n + p.archive.size + (p.search?.blob.size ?? 0),
            0,
          ) +
            archive.size >
          MAX
        ) {
          const evict = [...this.pendingUploads].find(([, p]) => !p.running);
          if (!evict)
            throw new Error('Finish the current encrypted upload before starting another');
          this.pendingUploads.delete(evict[0]);
        }
        let search: PendingUpload['search'];
        if (
          purpose === 'archive' &&
          records.length &&
          records.length <= 100000 &&
          records.reduce((n, r) => n + r.id.length + r.title.length + r.text.length + 64, 0) <=
            CONTENT_LIMITS.searchIndexBytes
        ) {
          const blob = new Blob([
            JSON.stringify({
              version: 1,
              archiveId: id,
              records: records.map(({ id, title, text }) => ({ id, title, text })),
            }),
          ]);
          const retained = [...this.pendingUploads.values()].reduce(
            (n, p) => n + p.archive.size + (p.search?.blob.size ?? 0),
            0,
          );
          if (
            blob.size <=
              Math.min(
                CONTENT_LIMITS.searchIndexBytes,
                configured ?? CONTENT_LIMITS.searchIndexBytes,
              ) &&
            retained + archive.size + blob.size <= MAX
          )
            search = { blob, hash: await sha(blob), count: records.length };
        }
        pending = { archive, chunkSize, files: [], search };
        this.pendingUploads.set(cacheKey, pending);
      }
    }
    if (pending.running) return pending.running;
    const current = pending;
    current.running = (async () => {
      await initAsync();
      const count = Math.ceil(current.archive.size / current.chunkSize);
      for (let index = current.files.length; index < count; index++) {
        const plain = new Uint8Array(
          await current.archive
            .slice(index * current.chunkSize, (index + 1) * current.chunkSize)
            .arrayBuffer(),
        );
        const encrypted = Attachment.encrypt(plain);
        plain.fill(0);
        try {
          const bytes = new Uint8Array(encrypted.encryptedData),
            info = encrypted.mediaEncryptionInfo!;
          const result = await this.client.uploadContent(
            new Blob([bytes], { type: 'application/octet-stream' }),
            { type: 'application/octet-stream', includeFilename: false },
          );
          const file = { url: result.content_uri, info, size: bytes.length };
          descriptor(file, CONTENT_LIMITS.chunkBytes);
          current.files.push(file);
        } finally {
          encrypted.free();
        }
      }
      if (current.search && !current.search.file) {
        const plain = new Uint8Array(await current.search.blob.arrayBuffer());
        const encrypted = Attachment.encrypt(plain);
        plain.fill(0);
        try {
          const bytes = new Uint8Array(encrypted.encryptedData);
          const result = await this.client.uploadContent(
            new Blob([bytes], { type: 'application/octet-stream' }),
            { type: 'application/octet-stream', includeFilename: false },
          );
          const file = {
            url: result.content_uri,
            info: encrypted.mediaEncryptionInfo!,
            size: bytes.length,
          };
          descriptor(file, CONTENT_LIMITS.searchIndexBytes);
          current.search.file = file;
        } finally {
          encrypted.free();
        }
      }
      const optional = current.search
        ? {
            searchIndex: {
              version: 1,
              archiveId: id,
              count: current.search.count,
              sha256: current.search.hash,
              file: current.search.file,
            },
          }
        : {};
      const p = payload(
        count === 1
          ? { version: 2, purpose, id, file: current.files[0], ...optional }
          : {
              version: 2,
              purpose,
              id,
              ...optional,
              size: current.archive.size,
              chunks: current.files.map((file, index) => ({ ...file, index })),
            },
      );
      if (p.version !== 2) throw new Error('Unexpected upload format');
      this.uploads.set(cacheKey, p);
      this.pendingUploads.delete(cacheKey);
      return p;
    })();
    try {
      return await current.running;
    } finally {
      current.running = undefined;
    }
  }
  private async send(id: string, p: Payload, peer?: string): Promise<void> {
    const txn = await sha(`${this.own()}\0${id}\0${p.purpose}\0${p.id}`);
    const signed = await signContent(
      this.client,
      this.requireVerifiedUser,
      id,
      p as unknown as Record<string, unknown>,
    );
    await this.sendSigned(id, signed, txn, peer);
  }
  /** A failed SDK local echo owns its transaction until the remote echo arrives.
   * Reuse that exact encrypted event; creating another echo with the same transaction
   * fails locally, and assigning a new transaction could duplicate an unknown outcome. */
  private async sendSigned(
    id: string,
    signed: SignedContent,
    txn: string,
    peer?: string,
  ): Promise<void> {
    await this.guard(id, peer); // Last await before either SDK send path; rechecks identity/audience.
    const room = this.client.getRoom(id);
    if (!room) throw new Error('Encrypted room is unavailable');
    const pending = room.getEventForTxnId?.(txn);
    if (!pending) {
      await this.client.sendEvent(id, EVENT, signed, txn);
      return;
    }
    if (
      pending.getRoomId() !== id ||
      pending.getSender() !== this.own() ||
      pending.getType() !== EVENT ||
      canonical(pending.getContent()) !== canonical(signed)
    )
      throw new Error('Pending transaction does not match this signed operation');
    if (pending.status === EventStatus.SENT) return; // Server acknowledgement already received.
    if (pending.status !== EventStatus.NOT_SENT)
      throw new Error('This encrypted operation is still sending. Retry after it finishes.');
    await this.client.resendEvent(pending, room);
  }
  async saveArchive(records: MemoryRecord[]): Promise<void> {
    const id = (await this.archiveRoom(true))!;
    await this.guard(id);
    const existing = await this.privateArchive();
    if (this.overflow)
      throw new Error(
        'Archive preview limit reached; export the original batches before importing more',
      );
    let projected = existing.length,
      projectedBytes = existing.reduce((sum, r) => sum + this.recordBytes(r), 0);
    const known = new Map<string, Set<string>>();
    const rawIds = new Map<string, string>();
    for (const record of existing) {
      const version = await this.archiveVariant(record);
      const set = known.get(version.originalId) ?? new Set<string>();
      set.add(version.fingerprint);
      known.set(version.originalId, set);
      rawIds.set(record.id, version.originalId);
    }
    for (const record of records) {
      const version = await this.archiveVariant(record),
        previous = known.get(version.originalId);
      if (rawIds.has(record.id) && rawIds.get(record.id) !== version.originalId)
        throw new Error('Imported record identity collides with a preserved version');
      if (record.conflictOf && record.id !== version.derivedId)
        throw new Error('Invalid preserved archive version identity');
      if (!record.conflictOf && previous && !previous.has(version.fingerprint))
        throw new Error('Conflicting imported record identity; the existing archive is unchanged');
      const set = previous ?? new Set<string>();
      if (!set.has(version.fingerprint)) {
        projected++;
        projectedBytes += this.recordBytes(record);
        if (projected > ARCHIVE_LIMITS.maxRecords || projectedBytes > CONTENT_LIMITS.visibleBytes)
          throw new Error('Combined archive preview limit exceeded; no batch was uploaded');
      }
      set.add(version.fingerprint);
      known.set(version.originalId, set);
      rawIds.set(record.id, version.originalId);
    }
    const p = await this.upload(records, 'archive');
    await this.send(id, p);
  }
  /**
   * Add one bounded part of a large archive. Existing parts are authenticated without
   * downloading their media. The UI must expose partial progress and saved-part browsing.
   */
  async appendArchiveBatch(records: MemoryRecord[]): Promise<{ id: string; stored: boolean }> {
    if (!records.length || records.length > ARCHIVE_LIMITS.maxRecords)
      throw new Error('Choose a nonempty, bounded archive part.');
    const batchId = await identity(records);
    const roomId = (await this.archiveRoom(true))!;
    for (const candidate of this.archiveRooms()) {
      const room = await this.guard(candidate.roomId),
        timeline = room.getLiveTimeline().getEvents();
      try {
        const fingerprint = async (length: number) => {
          if (length > 50000) throw new HistoryScanLimit();
          const hashes: string[] = [];
          let bytes = 0;
          for (const event of timeline.slice(0, length)) {
            const value = canonical({
              id: event.getId(),
              sender: event.getSender(),
              encrypted: event.isEncrypted(),
              failed: event.isDecryptionFailure(),
              content: event.getContent(),
            });
            bytes += value.length * 2;
            if (value.length > 65536 || bytes > 64 * 1024 * 1024) throw new HistoryScanLimit();
            hashes.push(await sha(value));
          }
          return sha(hashes.join(''));
        };
        let index = this.appendIndexes.get(room.roomId);
        if (
          index &&
          (room.oldState.paginationToken ||
            timeline.length < index.length ||
            (await fingerprint(index.length)) !== index.fingerprint)
        )
          index = undefined;
        if (index?.anchor) await this.trusted(index.anchor, room.roomId); // Recheck current signing identity, device trust and unchanged anchor.
        const ids = new Set(index?.ids),
          after = index?.anchor?.getId();
        let anchor = index?.anchor;
        for await (const event of this.scanEvents(room.roomId, undefined, after)) {
          const existing = this.verifiedPayloads.get(event);
          if (!existing || existing.purpose !== 'archive')
            throw new Error('Unexpected private archive content.');
          ids.add(existing.id);
          anchor = event;
        }
        const length = timeline.length;
        this.appendIndexes.set(room.roomId, {
          length,
          fingerprint: await fingerprint(length),
          ids,
          anchor,
        });
        if (ids.has(batchId)) return { id: batchId, stored: false };
      } catch (error) {
        if (error instanceof Error && historicalIntegrityErrors.has(error.message))
          throw new ArchiveHistoryUnavailable(error);
        throw error;
      }
    }
    const p = await this.upload(records, 'archive');
    await this.send(roomId, p);
    return { id: p.id, stored: true };
  }
  private async sharedIdentity(p: Pick<LazyPostPayload, 'record' | 'photos'>): Promise<string> {
    return sha(
      canonical({
        record: p.record,
        photos: p.photos.map((photo) => ({
          path: photo.path,
          mimeType: photo.mimeType,
          sha256: photo.sha256,
          size: photo.file.size,
        })),
      }),
    );
  }
  private async uploadShared(copy: MemoryRecord): Promise<LazyPostPayload> {
    const { attachments, provenance: _provenance, conflictOf: _conflict, ...record } = copy;
    const hashes = await Promise.all(attachments.map((a) => sha(a.bytes)));
    const id = await this.sharedIdentity({
      record,
      photos: attachments.map((a, i) => ({
        path: a.path,
        mimeType: 'image/jpeg',
        sha256: hashes[i],
        file: { size: a.bytes.size, url: '', info: '' },
      })),
    });
    const previous = this.sharedUploads.get(id);
    if (previous) return previous;
    const config = await this.client.getMediaConfig(true),
      cap = config['m.upload.size'];
    if (cap !== undefined && (!Number.isSafeInteger(cap) || Number(cap) < 1))
      throw new Error('Invalid homeserver upload limit');
    const photos: SharedPhoto[] = [];
    await initAsync();
    for (let i = 0; i < attachments.length; i++) {
      const photo = attachments[i];
      if (cap !== undefined && photo.bytes.size > Number(cap))
        throw new Error('Prepared photo exceeds homeserver upload limit');
      const plain = new Uint8Array(await photo.bytes.arrayBuffer()),
        encrypted = Attachment.encrypt(plain);
      plain.fill(0);
      try {
        const bytes = new Uint8Array(encrypted.encryptedData),
          info = encrypted.mediaEncryptionInfo!;
        const result = await this.client.uploadContent(
          new Blob([bytes], { type: 'application/octet-stream' }),
          { type: 'application/octet-stream', includeFilename: false },
        );
        photos.push({
          path: photo.path,
          mimeType: 'image/jpeg',
          sha256: hashes[i],
          file: { url: result.content_uri, info, size: bytes.length },
        });
      } finally {
        encrypted.free();
      }
    }
    const p = payload({ version: 3, purpose: 'post', id, record, photos });
    if (p.version !== 3) throw new Error('Unexpected shared upload');
    if (this.sharedUploads.size >= 256)
      this.sharedUploads.delete(this.sharedUploads.keys().next().value!);
    this.sharedUploads.set(id, p);
    return p;
  }
  async share(
    record: MemoryRecord,
    recipientIds: string[],
    operationId: string = crypto.randomUUID(),
  ): Promise<ShareResult> {
    const recipients = [...new Set(recipientIds)];
    if (!recipients.length || recipients.length > 100) throw new Error('Choose 1–100 friends');
    if (!/^[a-zA-Z0-9_-]{16,128}$/u.test(operationId))
      throw new Error('Invalid share operation identity');
    const outcomes: ShareOutcome[] = [],
      rooms: Array<{ roomId: string; userId: string }> = [];
    let firstError: unknown;
    for (const userId of recipients) {
      try {
        const room = this.friendRooms().find((r) => r.userId === userId);
        if (!room) throw new Error('Friendship required before sharing');
        await this.guard(room.roomId, userId);
        rooms.push(room);
      } catch (error) {
        firstError ??= error;
        outcomes.push({
          userId,
          status: 'failed',
          error: error instanceof Error ? error.message : 'Sharing failed',
        });
      }
    }
    if (rooms.length) {
      const copy = await sharedCopy(record);
      copy.id = await sha(`${copy.id}\0${operationId}`);
      const p = await this.uploadShared(copy);
      for (const room of rooms) {
        try {
          await this.send(room.roomId, p, room.userId);
          outcomes.push({ userId: room.userId, status: 'sent' });
        } catch (error) {
          firstError ??= error;
          outcomes.push({
            userId: room.userId,
            status: 'failed',
            error: error instanceof Error ? error.message : 'Sharing failed',
          });
        }
      }
    }
    if (!outcomes.some((outcome) => outcome.status === 'sent'))
      throw Object.assign(
        firstError instanceof Error ? firstError : new Error('No recipients received this share'),
        { outcomes },
      );
    return {
      operationId,
      outcomes: recipients.map((id) => outcomes.find((outcome) => outcome.userId === id)!),
    };
  }
  /** Retain operationId for retries. Each room is a separate conversation. */
  private async social(
    post: Pick<SharedPost, 'roomId' | 'id' | 'sender'>,
    action: SocialAction,
    operationId: string,
  ): Promise<void> {
    const peer = this.friendRooms().find((r) => r.roomId === post.roomId)?.userId;
    if (!peer) throw new Error('Verified friendship required');
    const events = await this.events(post.roomId, peer);
    if (
      !events.some(
        (e) =>
          this.verifiedPayloads.get(e)?.purpose === 'post' &&
          this.verifiedPayloads.get(e)?.id === post.id &&
          e.getSender() === post.sender,
      )
    )
      throw new Error('Post is not available in this conversation');
    const p = parseSocial({
      version: 1,
      purpose: 'social',
      id: operationId,
      postId: post.id,
      postSender: post.sender,
      ...action,
    });
    if (
      events.some((event) => {
        const previous = this.verifiedSocial.get(event);
        return (
          event.getSender() === this.own() &&
          previous?.id === operationId &&
          canonical(previous) !== canonical(p)
        );
      })
    )
      throw new Error('Conflicting social operation identity');
    const history = events
      .filter((e) => this.verifiedSocial.has(e))
      .map((e) => ({
        payload: this.verifiedSocial.get(e)!,
        sender: e.getSender()!,
        timestamp: e.getTs(),
      }))
      .filter((e) => e.payload.postId === post.id && e.payload.postSender === post.sender);
    const before = socialState(post, history);
    const retry = history.some((e) => e.sender === this.own() && e.payload.id === operationId);
    if (before.removed && !retry) throw new Error('Post has been removed');
    socialState(post, [...history, { payload: p, sender: this.own(), timestamp: Date.now() }]);
    const signed = await signContent(
      this.client,
      this.requireVerifiedUser,
      post.roomId,
      p as unknown as Record<string, unknown>,
    );
    const txn = await sha(`${this.own()}\0${post.roomId}\0social\0${operationId}`);
    await this.sendSigned(post.roomId, signed, txn, peer);
  }
  async addComment(
    post: Pick<SharedPost, 'roomId' | 'id' | 'sender'>,
    text: string,
    operationId: string,
  ): Promise<void> {
    await this.social(post, { kind: 'comment', text }, operationId);
  }
  async removeComment(
    post: Pick<SharedPost, 'roomId' | 'id' | 'sender'>,
    commentId: string,
    operationId: string,
  ): Promise<void> {
    await this.social(post, { kind: 'remove-comment', commentId }, operationId);
  }
  async setReaction(
    post: Pick<SharedPost, 'roomId' | 'id' | 'sender'>,
    reaction: string | null,
    operationId: string,
  ): Promise<void> {
    await this.social(post, { kind: 'reaction', reaction }, operationId);
  }
  async removePost(
    post: Pick<SharedPost, 'roomId' | 'id' | 'sender'>,
    operationId: string,
  ): Promise<void> {
    await this.social(post, { kind: 'remove-post' }, operationId);
  }
  private async trusted(event: MatrixEvent, roomId: string): Promise<void> {
    if (!event.isEncrypted()) throw new Error('Plaintext content refused');
    await this.client.decryptEventIfNeeded(event);
    if (event.isDecryptionFailure()) throw new Error('Content could not be decrypted');
    const sender = event.getSender();
    if (!sender || event.getRoomId() !== roomId)
      throw new Error('Missing or mismatched content context');
    const info = await this.crypto().getEncryptionInfoForEvent(event);
    // Missing historical devices and securely re-authenticated backup content
    // require the same master-signed payload as every other accepted event.
    // Identity changes, mismatched senders and unsigned live devices never pass.
    if (
      !info ||
      !(
        (info.shieldColour === 0 && info.shieldReason === null) ||
        info.shieldReason === 3 ||
        info.shieldReason === 4
      )
    )
      throw new Error('Untrusted encrypted sender');
    const content = await verifyContent(
      this.client,
      this.requireVerifiedUser,
      roomId,
      sender,
      event.getContent(),
    );
    if (content.purpose === 'social') this.verifiedSocial.set(event, parseSocial(content));
    else {
      const p = payload(content);
      if (p.version === 3 && (await this.sharedIdentity(p)) !== p.id)
        throw new Error('Shared post identity mismatch');
      this.verifiedPayloads.set(event, p);
    }
  }
  private async downloadPart(file: FileDescriptor): Promise<Uint8Array<ArrayBuffer>> {
    const url = this.client.mxcUrlToHttp(
      file.url,
      undefined,
      undefined,
      undefined,
      false,
      false,
      true,
    );
    const base = new URL(this.client.getHomeserverUrl());
    if (
      !url ||
      new URL(url).origin !== base.origin ||
      !new URL(url).pathname.startsWith('/_matrix/client/v1/media/download/')
    )
      throw new Error('Unsafe media destination');
    const token = this.client.getAccessToken();
    if (!token) throw new Error('Authenticated media required');
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok || !res.body) throw new Error('Encrypted media download failed');
    const length = res.headers.get('content-length');
    if (length && Number(length) !== file.size) {
      await res.body.cancel();
      throw new Error('Encrypted media size mismatch');
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let count = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        count += value.length;
        if (count > file.size || count > MAX) throw new Error('Encrypted media exceeds limit');
        chunks.push(new Uint8Array(value));
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    if (count !== file.size) throw new Error('Encrypted media truncated');
    await initAsync();
    const encrypted = new EncryptedAttachment(
      new Uint8Array(await new Blob(chunks).arrayBuffer()),
      file.info,
    );
    let plain: Uint8Array<ArrayBuffer>;
    try {
      plain = new Uint8Array(Attachment.decrypt(encrypted));
    } finally {
      encrypted.free();
    }
    return plain;
  }
  private async download(p: StoredPayload): Promise<MemoryRecord[]> {
    const cacheKey = JSON.stringify(p),
      cached = this.downloads.get(cacheKey);
    if (cached) return structuredClone(cached.records);
    const parts: Blob[] = [];
    let total = 0;
    const files = 'file' in p ? [p.file] : p.chunks;
    for (const file of files) {
      const plain = await this.downloadPart(file);
      total += plain.length;
      if (total > MAX) {
        plain.fill(0);
        throw new Error('Encrypted archive exceeds aggregate limit');
      }
      parts.push(new Blob([plain]));
      plain.fill(0);
    }
    if ('chunks' in p && total !== p.size)
      throw new Error('Encrypted chunk aggregate size mismatch');
    // No record leaves this method until all chunks authenticate and the complete
    // portable archive and semantic record identity have been checked.
    const { records, warnings } = await importArchives([new File(parts, 'archive.zip')]);
    if (warnings.length || (await identity(records)) !== p.id)
      throw new Error('Content identity mismatch');
    const size = records.reduce(
      (n, r) =>
        n +
        r.text.length * 2 +
        r.title.length * 2 +
        JSON.stringify(r.provenance ?? {}).length * 2 +
        r.attachments.reduce((sum, a) => sum + a.bytes.size, 0),
      0,
    );
    const cacheLimit = 64 * 1024 * 1024;
    if (size <= cacheLimit) {
      while (this.cachedBytes + size > cacheLimit && this.downloads.size) {
        const key = this.downloads.keys().next().value!;
        this.cachedBytes -= this.downloads.get(key)!.bytes;
        this.downloads.delete(key);
      }
      this.downloads.set(cacheKey, { records: structuredClone(records), bytes: size });
      this.cachedBytes += size;
    }
    return records;
  }
  private async *scanEvents(
    id: string,
    peer?: string,
    after?: string,
    allowPartial = false,
    historical = false,
  ): AsyncGenerator<MatrixEvent> {
    let room: Room;
    try {
      room = historical && peer ? await this.readGuard(id, peer) : await this.guard(id, peer);
    } catch (error) {
      if (!allowPartial) throw error;
      this.quarantine(id, undefined, 'room');
      return;
    }
    // SDK 43's ordinary /sync leave-room branch omits timeline.prev_batch.
    // Recover pagination only, never content or trust, using an existing event.
    if (
      historical &&
      room.getMyMembership() !== 'join' &&
      !room.oldState.paginationToken &&
      !this.recoveredHistoryTokens.has(room)
    ) {
      const anchor = room.getLiveTimeline().getEvents()[0]?.getId();
      if (!anchor)
        throw new Error('Historical room has no pagination anchor; synchronize and try again');
      const context = object(
        await this.client.http.authedRequest(
          Method.Get,
          `/rooms/${encodeURIComponent(id)}/context/${encodeURIComponent(anchor)}`,
          { limit: '0' },
        ),
      );
      const event = object(context.event);
      if (
        event.event_id !== anchor ||
        (event.room_id !== undefined && event.room_id !== id) ||
        (context.start !== undefined &&
          context.start !== null &&
          (typeof context.start !== 'string' || !context.start || context.start.length > 4096))
      )
        throw new Error('Historical pagination context does not match this conversation');
      // Another scan or sync may have advanced history while /context was pending.
      // Never replace that newer pagination position with this stale response.
      if (
        !room.oldState.paginationToken &&
        room.getLiveTimeline().getEvents()[0]?.getId() === anchor &&
        !this.recoveredHistoryTokens.has(room)
      ) {
        room
          .getLiveTimeline()
          .setPaginationToken(
            typeof context.start === 'string' ? context.start : null,
            EventTimeline.BACKWARDS,
          );
        this.recoveredHistoryTokens.add(room);
      }
    }
    let pages = 0;
    let deadline = Date.now() + 30000;
    while (room.oldState.paginationToken) {
      if (++pages > 500 || Date.now() > deadline) throw new HistoryScanLimit();
      const token = room.oldState.paginationToken;
      await this.client.scrollback(room, 100);
      if (room.oldState.paginationToken === token)
        throw new Error('History pagination made no progress');
    }
    let skipping = after !== undefined,
      inspected = 0;
    for (const event of room.getLiveTimeline().getEvents()) {
      if (++inspected > 50000 || Date.now() > deadline) throw new HistoryScanLimit();
      if (skipping) {
        if (event.getId() === after) skipping = false;
        continue;
      }
      try {
        if (event.isEncrypted()) await this.client.decryptEventIfNeeded(event);
        if (event.isDecryptionFailure()) throw new Error('Encrypted history is unavailable');
        if (event.getType() !== EVENT) continue;
        if (![this.own(), peer].includes(event.getSender()))
          throw new Error('Unexpected content sender');
        await this.trusted(event, id);
        if (!peer && this.verifiedSocial.has(event))
          throw new Error('Social content in private archive');
      } catch (error) {
        if (!allowPartial) throw error;
        // Never display untrusted payload fields or reinterpret failed integrity as data.
        this.verifiedPayloads.delete(event);
        this.verifiedSocial.delete(event);
        this.quarantine(id, event, event.isDecryptionFailure() ? 'missing-key' : 'integrity');
        continue;
      }
      const suspendedAt = Date.now();
      yield event;
      deadline += Date.now() - suspendedAt;
    }
    if (skipping) throw new Error('Archive batch cursor is stale; start again');
  }
  private async events(id: string, peer?: string): Promise<MatrixEvent[]> {
    const result: MatrixEvent[] = [];
    for await (const event of this.scanEvents(id, peer)) result.push(event);
    return result;
  }
  private async archiveVariant(
    record: MemoryRecord,
  ): Promise<{ originalId: string; fingerprint: string; derivedId: string }> {
    const { conflictOf, ...original } = record;
    const originalId = conflictOf ?? record.id;
    original.id = originalId;
    const fingerprint = await identity([original]);
    return {
      originalId,
      fingerprint,
      derivedId: `conflict-${await sha(`${originalId}\0${fingerprint}`)}`,
    };
  }
  /** Bounded union. Original authenticated batches always remain independently exportable. */
  async privateArchive(): Promise<MemoryRecord[]> {
    return this.collectPrivateArchive(false);
  }
  /** Independently verified parts remain usable; failed parts are explicitly quarantined. */
  async privateArchiveView(): Promise<MemoryRecord[]> {
    this.unavailable.clear();
    return this.collectPrivateArchive(true);
  }
  private async collectPrivateArchive(allowPartial: boolean): Promise<MemoryRecord[]> {
    this.conflicts = [];
    this.overflow = null;
    const rooms = this.archiveRooms(),
      batches = new Set<string>();
    type Variant = { record: MemoryRecord; derivedId: string; bytes: number };
    const groups = new Map<string, Map<string, Variant>>();
    const accepted: { originalId: string; fingerprint: string; bytes: number }[] = [];
    const partial = new Set<string>();
    let count = 0,
      bytes = 0;
    const mark = (reason: ArchiveOverflow['reason']) => {
      this.overflow = {
        limit: ARCHIVE_LIMITS.maxRecords,
        visibleRecords: count,
        byteLimit: CONTENT_LIMITS.visibleBytes,
        visibleBytes: bytes,
        hasMore: true,
        reason,
      };
    };
    const deadline = Date.now() + 30000;
    try {
      scan: for (let roomIndex = 0; roomIndex < rooms.length; roomIndex++) {
        if (roomIndex >= CONTENT_LIMITS.archiveRoomsPerPage || Date.now() > deadline) {
          mark('history');
          break;
        }
        for await (const event of this.scanEvents(
          rooms[roomIndex].roomId,
          undefined,
          undefined,
          allowPartial,
        )) {
          if (Date.now() > deadline) {
            mark('history');
            break scan;
          }
          const p = this.verifiedPayloads.get(event)!;
          let part: MemoryRecord[];
          try {
            if (p.purpose !== 'archive') throw new Error('Unexpected archive payload');
            if (batches.has(p.id)) continue;
            part = await this.download(p);
            // Validate every preserved revision before making any record from this part visible.
            for (const record of part) {
              const version = await this.archiveVariant(record);
              if (record.conflictOf && record.id !== version.derivedId)
                throw new Error('Invalid preserved archive version identity');
            }
          } catch (error) {
            if (!allowPartial) throw error;
            this.quarantine(rooms[roomIndex].roomId, event, 'integrity');
            continue;
          }
          batches.add(p.id);
          for (const record of part) {
            const version = await this.archiveVariant(record);
            if (record.conflictOf && record.id !== version.derivedId)
              throw new Error('Invalid preserved archive version identity');
            const group = groups.get(version.originalId) ?? new Map<string, Variant>();
            if (group.has(version.fingerprint)) continue;
            const size = this.recordBytes(record);
            const fits = () =>
              count < ARCHIVE_LIMITS.maxRecords && bytes + size <= CONTENT_LIMITS.visibleBytes;
            if (!fits()) {
              const reason = count >= ARCHIVE_LIMITS.maxRecords ? 'records' : 'bytes';
              // Preserve a conflicting pair at the boundary when it fits by
              // removing later unrelated entries from this explicitly partial view.
              if (group.size) {
                partial.add(version.originalId);
                for (let i = accepted.length - 1; i >= 0 && !fits(); i--) {
                  const candidate = accepted[i];
                  if (candidate.originalId === version.originalId) continue;
                  const other = groups.get(candidate.originalId)!;
                  other.delete(candidate.fingerprint);
                  if (other.size) partial.add(candidate.originalId);
                  else groups.delete(candidate.originalId);
                  accepted.splice(i, 1);
                  count--;
                  bytes -= candidate.bytes;
                }
                if (fits()) {
                  group.set(version.fingerprint, {
                    record,
                    derivedId: version.derivedId,
                    bytes: size,
                  });
                  groups.set(version.originalId, group);
                  count++;
                  bytes += size;
                }
              }
              mark(reason);
              break scan;
            }
            group.set(version.fingerprint, { record, derivedId: version.derivedId, bytes: size });
            groups.set(version.originalId, group);
            accepted.push({
              originalId: version.originalId,
              fingerprint: version.fingerprint,
              bytes: size,
            });
            count++;
            bytes += size;
          }
        }
      }
    } catch (error) {
      if (!(error instanceof HistoryScanLimit)) throw error;
      mark('history');
    }
    const result: MemoryRecord[] = [];
    for (const [originalId, group] of groups) {
      const conflict =
        group.size > 1 ||
        partial.has(originalId) ||
        [...group.values()].some((v) => v.record.conflictOf);
      const versions = [...group.values()].map((v) =>
        conflict ? { ...v.record, id: v.derivedId, conflictOf: originalId } : v.record,
      );
      result.push(...versions);
      if (conflict)
        this.conflicts.push({
          originalId,
          versionIds: versions.map((r) => r.id).sort(),
          ...(this.overflow ? { partial: true as const } : {}),
        });
    }
    this.conflicts.sort((a, b) =>
      a.originalId < b.originalId ? -1 : a.originalId > b.originalId ? 1 : 0,
    );
    return result.sort(
      (a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0) || a.id.localeCompare(b.id),
    );
  }
  private async conversationEvents(roomId: string, peer: string): Promise<MatrixEvent[]> {
    await this.readGuard(roomId, peer);
    for (const [key, value] of this.unavailable)
      if (value.roomId === roomId) this.unavailable.delete(key);
    const events: MatrixEvent[] = [];
    for await (const event of this.scanEvents(roomId, peer, undefined, true, true))
      events.push(event);
    const posts = new Set(
      events.flatMap((event) => {
        const p = this.verifiedPayloads.get(event);
        return p?.purpose === 'post' ? [`${event.getSender()}:${p.id}`] : [];
      }),
    );
    const operations = new Map<string, string>(),
      conflicting = new Set<string>();
    for (const event of events) {
      const action = this.verifiedSocial.get(event);
      if (!action) continue;
      const key = `${event.getSender()}\0${action.id}`,
        fingerprint = canonical(action);
      if (operations.has(key) && operations.get(key) !== fingerprint) conflicting.add(key);
      operations.set(key, fingerprint);
    }
    return events.filter((event) => {
      const action = this.verifiedSocial.get(event);
      if (action && conflicting.has(`${event.getSender()}\0${action.id}`)) {
        this.quarantine(roomId, event, 'integrity');
        return false;
      }
      const content = this.verifiedPayloads.get(event);
      if (content && content.purpose !== 'post') {
        this.quarantine(roomId, event, 'integrity');
        return false;
      }
      const p = this.verifiedSocial.get(event);
      if (p && !posts.has(`${p.postSender}:${p.postId}`)) {
        this.quarantine(roomId, event, 'integrity');
        return false;
      }
      return true;
    });
  }
  private conversationState(
    event: MatrixEvent,
    events: MatrixEvent[],
    includeRemovedComments = false,
  ): SocialState {
    const p = this.verifiedPayloads.get(event)!;
    const mapping = new Map<SocialEvent, MatrixEvent>();
    const social = events.flatMap((candidate) => {
      const payload = this.verifiedSocial.get(candidate);
      if (!payload || payload.postId !== p.id || payload.postSender !== event.getSender())
        return [];
      const value = { payload, sender: candidate.getSender()!, timestamp: candidate.getTs() };
      mapping.set(value, candidate);
      return [value];
    });
    return socialState({ id: p.id, sender: event.getSender()! }, social, {
      includeRemovedComments,
      onInvalid: (invalid) =>
        this.quarantine(event.getRoomId()!, mapping.get(invalid), 'integrity'),
    });
  }
  private async postView(
    event: MatrixEvent,
    peer: string,
    readOnly: boolean,
    state: SocialState,
  ): Promise<SharedPost> {
    const p = this.verifiedPayloads.get(event)!;
    if (p.purpose !== 'post' || !event.getId()) throw new Error('Invalid shared post');
    let record: MemoryRecord;
    let decodedPixels = 0;
    if (p.version === 3) {
      record = { ...p.record, attachments: [] };
      const key = `${event.getRoomId()}\0${event.getId()}`;
      if (this.lazyPosts.size >= 500) this.lazyPosts.delete(this.lazyPosts.keys().next().value!);
      this.lazyPosts.set(key, { payload: p, event, peer });
    } else {
      const records = await this.download(p);
      record = records[0];
      if (
        records.length !== 1 ||
        !record ||
        record.privateOnly ||
        !['post', 'photo', 'album'].includes(record.kind) ||
        record.sourcePath ||
        Object.keys(record.provenance ?? {}).length ||
        record.attachments.some(
          (a, i) =>
            !(
              (a.mimeType === 'image/png' && a.path === `photo-${i + 1}.png`) ||
              (a.mimeType === 'image/jpeg' && a.path === `photo-${i + 1}.jpg`)
            ),
        )
      )
        throw new Error('Invalid shared copy');
      if (record.attachments.length > CONTENT_LIMITS.legacySharedPhotos)
        throw new PhotoPresentationLimit();
      // Older producers emitted full-size PNGs. Preserve their 40M-pixel input
      // compatibility rather than applying the new v3 JPEG derivative limits.
      for (const attachment of record.attachments) {
        const dimensions = validatePhotoHeader(
          new Uint8Array(
            await attachment.bytes.slice(0, SHARED_PHOTO_LIMITS.headerBytes).arrayBuffer(),
          ),
          attachment.mimeType,
          attachment.bytes.size,
        );
        decodedPixels += dimensions.width * dimensions.height;
        if (decodedPixels > CONTENT_LIMITS.legacyDecodedPixels) throw new PhotoPresentationLimit();
      }
    }
    const post: SharedPost = {
      eventId: event.getId()!,
      id: p.id,
      roomId: event.getRoomId()!,
      sender: event.getSender()!,
      timestamp: event.getTs(),
      sharedAt: event.getTs(),
      originalTimestamp: record.timestamp,
      record,
      comments: state.comments,
      reactions: state.reactions,
      readOnly,
      mediaLoaded: p.version === 2 || p.photos.length === 0,
      ...(p.version === 3
        ? {
            media: p.photos.map((photo) => ({
              path: photo.path,
              mimeType: photo.mimeType,
              size: photo.file.size,
            })),
          }
        : {}),
    };
    this.legacyPostPixels.set(post, decodedPixels);
    return post;
  }
  /** New v3 post text is signed metadata; fetching photos is a separate deliberate read. */
  async hydratePost(post: SharedPost): Promise<SharedPost> {
    const cached = this.lazyPosts.get(`${post.roomId}\0${post.eventId}`);
    if (!cached) {
      if (!post.mediaLoaded) throw new Error('Post page expired; reload before opening photos');
      const room = this.conversationRooms().find((room) => room.roomId === post.roomId);
      if (!room) throw new Error('Conversation unavailable');
      await this.readGuard(post.roomId, room.userId);
      const event = this.room(post.roomId)
        .getLiveTimeline()
        .getEvents()
        .find((event) => event.getId() === post.eventId);
      if (!event) throw new Error('Post event unavailable');
      await this.trusted(event, post.roomId);
      if (this.verifiedPayloads.get(event)?.id !== post.id)
        throw new Error('Post identity mismatch');
      return this.postView(event, room.userId, room.readOnly, {
        removed: false,
        comments: post.comments,
        reactions: post.reactions,
      });
    }
    await this.readGuard(post.roomId, cached.peer);
    await this.trusted(cached.event, post.roomId);
    const p = this.verifiedPayloads.get(cached.event);
    if (!p || p.version !== 3 || p.id !== post.id || canonical(p) !== canonical(cached.payload))
      throw new Error('Shared post changed');
    const attachments: MemoryRecord['attachments'] = [];
    for (const [index, photo] of p.photos.entries()) {
      let bytes: Blob;
      if (post.mediaLoaded) {
        const attachment = post.record.attachments[index];
        if (
          post.record.attachments.length !== p.photos.length ||
          !attachment ||
          attachment.path !== photo.path ||
          attachment.mimeType !== photo.mimeType ||
          attachment.bytes.size !== photo.file.size
        )
          throw new Error('Loaded shared photo binding mismatch');
        bytes = attachment.bytes;
      } else {
        const plain = await this.downloadPart(photo.file);
        bytes = new Blob([plain], { type: photo.mimeType });
        plain.fill(0);
      }
      if ((await sha(bytes)) !== photo.sha256) throw new Error('Shared photo identity mismatch');
      const dimensions = validatePhotoHeader(
        new Uint8Array(await bytes.slice(0, SHARED_PHOTO_LIMITS.headerBytes).arrayBuffer()),
        photo.mimeType,
        bytes.size,
      );
      if (
        dimensions.width > SHARED_PHOTO_LIMITS.outputEdge ||
        dimensions.height > SHARED_PHOTO_LIMITS.outputEdge
      )
        throw new Error('Shared photo exceeds prepared dimensions');
      attachments.push({ path: photo.path, mimeType: photo.mimeType, bytes });
    }
    return { ...post, record: { ...p.record, attachments }, mediaLoaded: true };
  }
  async postsPage(
    cursor?: string,
    limit: number = CONTENT_LIMITS.feedPageSize,
    roomId?: string,
  ): Promise<{ posts: SharedPost[]; nextCursor?: string; limited?: boolean }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new Error('Feed page size must be 1–50');
    const generation = cursor ? this.feedGeneration : ++this.feedGeneration;
    let offset = 0;
    if (cursor) {
      if (cursor.length > 4096) throw new Error('Invalid feed cursor');
      const value = object(JSON.parse(decodeURIComponent(cursor)));
      exact(value, ['snapshot', 'offset']);
      if (
        typeof value.snapshot !== 'string' ||
        !Number.isSafeInteger(value.offset) ||
        Number(value.offset) < 0 ||
        !this.feedSnapshot ||
        value.snapshot !== this.feedSnapshot.id ||
        this.feedSnapshot.roomId !== roomId ||
        Date.now() - this.feedSnapshot.created > 300000
      )
        throw new Error('Feed cursor expired; refresh the feed');
      offset = Number(value.offset);
      if (offset > this.feedSnapshot.entries.length) throw new Error('Invalid feed cursor');
    } else {
      const rooms = this.conversationRooms().filter((room) =>
        roomId ? room.roomId === roomId : !isBlocked(this.client, room.userId),
      );
      if (!roomId) {
        // Choose a bounded metadata window before downloading any media. Active
        // conversations precede departed history; recency is an untrusted hint,
        // never a substitute for the signature/audience checks below.
        const now = Date.now();
        const activity = new Map(
          rooms.map((entry) => {
            const events = this.client.getRoom(entry.roomId)?.getLiveTimeline().getEvents() ?? [];
            const last = events.at(-1)?.getTs() ?? 0;
            return [entry.roomId, Number.isFinite(last) ? Math.min(now, Math.max(0, last)) : 0];
          }),
        );
        rooms.sort(
          (a, b) =>
            Number(a.readOnly) - Number(b.readOnly) ||
            activity.get(b.roomId)! - activity.get(a.roomId)! ||
            a.roomId.localeCompare(b.roomId),
        );
      }
      if (roomId && !rooms.length) throw new Error('Conversation unavailable');
      const snapshot: NonNullable<ContentStore['feedSnapshot']> = {
        ...(roomId ? { roomId } : {}),
        id: crypto.randomUUID(),
        created: Date.now(),
        limited: false,
        entries: [],
      };
      this.locked = [];
      let metadataBytes = 0,
        inspected = 0;
      scan: for (let i = 0; i < rooms.length; i++) {
        const room = { ...rooms[i] };
        if (i >= CONTENT_LIMITS.archiveRoomsPerPage || Date.now() - snapshot.created > 30000) {
          snapshot.limited = true;
          break;
        }
        try {
          try {
            await this.requireVerifiedUser(room.userId);
          } catch {
            room.readOnly = true;
            this.locked.push({
              ...room,
              reason:
                'Check this friend’s identity. Only independently authenticated historical content can be read.',
            });
          }
          const events = await this.conversationEvents(room.roomId, room.userId),
            seen = new Set<string>();
          for (const event of events) {
            if (++inspected > 50000 || Date.now() - snapshot.created > 30000) {
              snapshot.limited = true;
              break scan;
            }
            const p = this.verifiedPayloads.get(event);
            if (!p || p.purpose !== 'post') continue;
            const key = `${event.getSender()}:${p.id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            metadataBytes += new TextEncoder().encode(JSON.stringify(p)).length;
            if (metadataBytes > 64 * 1024 * 1024) {
              snapshot.limited = true;
              break scan;
            }
            snapshot.entries.push({
              event,
              events,
              peer: room.userId,
              readOnly: room.readOnly,
              id: p.id,
            });
          }
          if (this.unavailableContent().some((part) => part.roomId === room.roomId))
            this.locked.push({
              ...room,
              reason:
                'Some events are unavailable or failed verification; valid posts remain readable.',
            });
        } catch (error) {
          this.locked.push({
            ...room,
            reason:
              error instanceof HistoryScanLimit
                ? 'History exceeds this read budget; retry after synchronization.'
                : 'This conversation could not be verified.',
          });
          snapshot.limited ||= error instanceof HistoryScanLimit;
        }
      }
      snapshot.entries.sort(
        (a, b) =>
          b.event.getTs() - a.event.getTs() ||
          String(a.event.getRoomId()).localeCompare(String(b.event.getRoomId())) ||
          String(a.event.getId()).localeCompare(String(b.event.getId())),
      );
      if (generation !== this.feedGeneration) throw new Error('Feed refresh superseded');
      this.feedSnapshot = snapshot;
    }
    const snapshot = this.feedSnapshot!,
      posts: SharedPost[] = [];
    let bytes = 0,
      decodedPixels = 0;
    for (; offset < snapshot.entries.length; offset++) {
      const entry = snapshot.entries[offset],
        { event, events, peer } = entry;
      const p = this.verifiedPayloads.get(event)!;
      const size =
        p.version === 3
          ? new TextEncoder().encode(JSON.stringify(p)).length
          : 'file' in p
            ? p.file.size
            : p.size;
      if (posts.length >= limit || (posts.length && bytes + size > CONTENT_LIMITS.feedPageBytes))
        break;
      if (size > CONTENT_LIMITS.feedPageBytes) {
        this.quarantine(event.getRoomId()!, event, 'limit');
        snapshot.limited = true;
        continue;
      }
      try {
        await this.readGuard(event.getRoomId()!, peer);
        await this.trusted(event, event.getRoomId()!);
        if (this.verifiedPayloads.get(event)?.id !== entry.id)
          throw new Error('Post changed during pagination');
        for (const social of events) {
          const action = this.verifiedSocial.get(social);
          if (action?.postId === entry.id && action.postSender === event.getSender()) {
            try {
              await this.trusted(social, event.getRoomId()!);
            } catch {
              this.verifiedSocial.delete(social);
              this.quarantine(event.getRoomId()!, social, 'integrity');
            }
          }
        }
        const state = this.conversationState(event, events);
        if (state.removed) continue;
        const post = await this.postView(event, peer, entry.readOnly, state);
        const pixels = this.legacyPostPixels.get(post) ?? 0;
        if (posts.length && decodedPixels + pixels > CONTENT_LIMITS.legacyDecodedPixels) break;
        decodedPixels += pixels;
        posts.push(post);
        bytes += size;
      } catch (error) {
        this.quarantine(
          event.getRoomId()!,
          event,
          error instanceof PhotoPresentationLimit ? 'limit' : 'integrity',
        );
        snapshot.limited ||= error instanceof PhotoPresentationLimit;
      }
    }
    if (generation !== this.feedGeneration) throw new Error('Feed refresh superseded');
    return {
      posts,
      ...(offset < snapshot.entries.length
        ? { nextCursor: encodeURIComponent(JSON.stringify({ snapshot: snapshot.id, offset })) }
        : {}),
      ...(snapshot.limited ? { limited: true } : {}),
    };
  }
  async posts(): Promise<SharedPost[]> {
    return (await this.postsPage()).posts;
  }
  /** Independent portable parts; a cursor explicitly identifies remaining export content. */
  async exportConversationPage(
    roomId: string,
    cursor?: string,
    limit = 20,
  ): Promise<{ blob: Blob; nextCursor?: string }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Conversation export page size must be 1–100');
    const room = this.conversationRooms().find((room) => room.roomId === roomId);
    if (!room) throw new Error('Conversation unavailable');
    await this.readGuard(roomId, room.userId);
    let offset = 0,
      snapshot = this.conversationExports.get(roomId);
    if (cursor) {
      const value = object(JSON.parse(decodeURIComponent(cursor)));
      exact(value, ['snapshot', 'offset']);
      if (
        cursor.length > 4096 ||
        !snapshot ||
        value.snapshot !== snapshot.id ||
        !Number.isSafeInteger(value.offset) ||
        Number(value.offset) < 0 ||
        Number(value.offset) > snapshot.units.length ||
        Date.now() - snapshot.created > 300000
      )
        throw new Error('Conversation export cursor expired; restart export');
      offset = Number(value.offset);
    } else {
      const events = await this.conversationEvents(roomId, room.userId),
        seen = new Set<string>();
      snapshot = { id: crypto.randomUUID(), created: Date.now(), units: [], peer: room.userId };
      for (const event of events) {
        const p = this.verifiedPayloads.get(event);
        if (!p || p.purpose !== 'post') continue;
        const key = `${event.getSender()}:${p.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const state = this.conversationState(event, events, true);
        snapshot.units.push({ event, state });
        for (const comment of state.comments) snapshot.units.push({ event, state, comment });
        if (snapshot.units.length > 50000)
          throw new Error('Conversation history exceeds export scan limit');
      }
      if (this.conversationExports.size >= 16)
        this.conversationExports.delete(this.conversationExports.keys().next().value!);
      this.conversationExports.set(roomId, snapshot);
    }
    const records: MemoryRecord[] = [];
    let bytes = 0;
    for (; offset < snapshot!.units.length; offset++) {
      if (records.length >= limit) break;
      const unit = snapshot!.units[offset],
        p = this.verifiedPayloads.get(unit.event)!;
      const expectedBytes = unit.comment
        ? unit.comment.text.length * 4 + 4096
        : p.version === 3
          ? p.photos.reduce((n, photo) => n + photo.file.size, JSON.stringify(p).length)
          : 'file' in p
            ? p.file.size
            : p.size;
      if (records.length && bytes + expectedBytes > 96 * 1024 * 1024) break;
      try {
        await this.trusted(unit.event, roomId);
        if (this.verifiedPayloads.get(unit.event)?.id !== p.id)
          throw new Error('Post changed during export');
        let record: MemoryRecord;
        if (unit.comment) {
          const c = unit.comment;
          // Reverify the source event rather than trusting a mutable caller-owned comment object.
          const source = this.room(roomId)
            .getLiveTimeline()
            .getEvents()
            .find(
              (event) =>
                this.verifiedSocial.get(event)?.id === c.id && event.getSender() === c.sender,
            );
          if (!source) throw new Error('Comment source unavailable');
          await this.trusted(source, roomId);
          const action = this.verifiedSocial.get(source);
          if (
            !action ||
            action.kind !== 'comment' ||
            action.postId !== p.id ||
            action.postSender !== unit.event.getSender() ||
            action.text !== c.text
          )
            throw new Error('Comment changed during export');
          record = {
            id: `comment-${await sha(`${roomId}\0${p.id}\0${c.sender}\0${c.id}`)}`,
            kind: 'message',
            title: 'Conversation comment',
            text: c.text,
            timestamp: c.timestamp,
            sourcePath: '',
            attachments: [],
            privateOnly: true,
            provenance: {
              conversation: {
                roomId,
                postId: p.id,
                postSender: unit.event.getSender(),
                sender: c.sender,
                commentId: c.id,
                removed: c.removed === true,
              },
            },
          };
        } else {
          const post = await this.hydratePost(
            await this.postView(unit.event, snapshot!.peer, true, unit.state),
          );
          record = {
            ...post.record,
            id: `conversation-${await sha(`${roomId}\0${post.sender}\0${post.id}`)}`,
            privateOnly: true,
            provenance: {
              conversation: {
                roomId,
                eventId: post.eventId,
                sender: post.sender,
                postId: post.id,
                sharedAt: post.sharedAt,
                removed: unit.state.removed,
              },
            },
          };
        }
        const size = this.recordBytes(record);
        if (bytes + size > CONTENT_LIMITS.visibleBytes)
          throw new Error('Conversation record exceeds export byte limit');
        bytes += size;
        records.push(record);
      } catch (error) {
        if (error instanceof Error && error.message.includes('export byte limit')) throw error;
        this.quarantine(
          roomId,
          unit.event,
          error instanceof PhotoPresentationLimit ? 'limit' : 'integrity',
        );
      }
    }
    const unavailable = this.unavailableContent().filter((part) => part.roomId === roomId);
    records.push({
      id: `conversation-export-${await sha(`${roomId}\0${cursor ?? 'first'}`)}`,
      kind: 'message',
      title: 'Private conversation export',
      text: `${unavailable.length} unavailable content part(s). Includes earlier copies of posts and replies marked removed, with their removal status in provenance. Permissions and friendships were not restored.`,
      timestamp: null,
      sourcePath: '',
      attachments: [],
      privateOnly: true,
      provenance: {
        conversationExport: {
          roomId,
          peer: room.userId,
          includesRemoved: true,
          unavailable,
          hasMore: offset < snapshot!.units.length,
        },
      },
    });
    const blob = await exportArchives(records);
    snapshot!.created = Date.now(); // Active multi-part exports renew their in-memory cursor lease.
    return {
      blob,
      ...(offset < snapshot!.units.length
        ? { nextCursor: encodeURIComponent(JSON.stringify({ snapshot: snapshot!.id, offset })) }
        : {}),
    };
  }
  async exportConversation(roomId: string): Promise<Blob> {
    const page = await this.exportConversationPage(roomId, undefined, 100);
    if (page.nextCursor)
      throw new Error('Conversation requires paged export; download each conversation part');
    return page.blob;
  }
}
