import { type MatrixClient, type MatrixEvent, type Room, Preset, ClientEvent } from 'matrix-js-sdk';
import { AllDevicesIsolationMode } from 'matrix-js-sdk/lib/crypto-api/index.js';
import { Attachment, EncryptedAttachment, initAsync } from '@matrix-org/matrix-sdk-crypto-wasm';
import { enforceRecipientBoundary } from './recipient-boundary.js';
import { signContent, verifyContent, type SignedContent } from './signed-content.js';
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
export interface SharedPost {
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
});
type FileDescriptor = { url: string; info: string; size: number };
type ChunkDescriptor = FileDescriptor & { index: number };
type PayloadBase = { version: 2; purpose: 'archive' | 'post'; id: string };
type Payload = PayloadBase &
  ({ file: FileDescriptor } | { chunks: ChunkDescriptor[]; size: number });
type PendingUpload = {
  archive: Blob;
  chunkSize: number;
  files: FileDescriptor[];
  running?: Promise<Payload>;
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
  if (
    p.version !== 2 ||
    !['archive', 'post'].includes(String(p.purpose)) ||
    typeof p.id !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(p.id)
  )
    throw new Error('Invalid encrypted content');
  if (Object.hasOwn(p, 'file')) {
    exact(p, ['version', 'purpose', 'id', 'file']);
    descriptor(p.file, MAX);
  } else {
    exact(p, ['version', 'purpose', 'id', 'chunks', 'size']);
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
  const attachments: MemoryRecord['attachments'] = [];
  for (const a of record.attachments) {
    if (
      !['image/jpeg', 'image/png', 'image/webp'].includes(a.mimeType) ||
      a.bytes.size > ARCHIVE_LIMITS.maxEntryBytes
    )
      throw new Error('Sharing supports JPEG, PNG and WebP photos only');
    if (typeof createImageBitmap !== 'function' || typeof document === 'undefined')
      throw new Error('Photo sharing requires browser image preparation');
    const header = new Uint8Array(await a.bytes.slice(0, 32).arrayBuffer());
    const png =
      header.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => header[i] === v);
    const jpeg = header[0] === 255 && header[1] === 216 && header[2] === 255;
    const webp =
      new TextDecoder().decode(header.slice(0, 4)) === 'RIFF' &&
      new TextDecoder().decode(header.slice(8, 12)) === 'WEBP';
    if (!(
      (a.mimeType === 'image/png' && png) ||
      (a.mimeType === 'image/jpeg' && jpeg) ||
      (a.mimeType === 'image/webp' && webp)
    ))
      throw new Error('Photo bytes do not match a supported image');
    if (png) {
      const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
      if (view.getUint32(16) * view.getUint32(20) > 40_000_000)
        throw new Error('Photo dimensions exceed sharing limit');
    }
    const image = await createImageBitmap(a.bytes);
    try {
      if (!image.width || !image.height || image.width * image.height > 40_000_000)
        throw new Error('Photo dimensions exceed sharing limit');
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Photo preparation unavailable');
      context.drawImage(image, 0, 0);
      const bytes = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('Photo preparation failed'))),
          'image/png',
        ),
      );
      if (bytes.size > ARCHIVE_LIMITS.maxEntryBytes)
        throw new Error('Prepared photo exceeds sharing limit');
      attachments.push({
        path: `photo-${attachments.length + 1}.png`,
        mimeType: 'image/png',
        bytes,
      });
    } finally {
      image.close();
    }
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
  private verifiedPayloads = new WeakMap<MatrixEvent, Payload>();
  private revoked = new Set<string>();
  private conflicts: ArchiveConflict[] = [];
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
  private preparedSessions = new WeakSet<Room>();
  private locked: { roomId: string; userId: string; reason: string }[] = [];
  private downloads = new Map<string, { records: MemoryRecord[]; bytes: number }>();
  private cachedBytes = 0;
  lockedRooms(): { roomId: string; userId: string; reason: string }[] {
    return this.locked.map((r) => ({ ...r }));
  }
  private creatingArchive?: Promise<string>;
  private uploads = new Map<string, Payload>();
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
          // only inviteFriend clears the revocation after this full-state proof.
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
    this.crypto();
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
      if (other.length !== 1 || this.revoked.has(other[0].userId)) continue;
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
      this.check(joined, peers[0].userId);
    } catch (e) {
      await this.client.leave(roomId);
      throw e;
    }
  }
  async revokeFriend(userId: string): Promise<void> {
    const rooms = this.friendRooms().filter((r) => r.userId === userId);
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
  async archiveBatches(cursor?: string, limit = 50): Promise<ArchiveBatchPage> {
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
        )) {
          const eventId = event.getId();
          if (!eventId) throw new Error('Archive batch has no event identity');
          const p = this.verifiedPayloads.get(event)!;
          if (p.purpose !== 'archive') throw new Error('Unexpected archive payload');
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
    if (!this.archiveRooms().some((room) => room.roomId === roomId))
      throw new Error('Archive room is not available');
    let event: MatrixEvent | undefined;
    for await (const candidate of this.scanEvents(roomId)) {
      if (candidate.getId() === eventId) {
        event = candidate;
        break;
      }
    }
    if (!event) throw new Error('Archive batch is not available');
    const p = this.verifiedPayloads.get(event)!;
    if (p.purpose !== 'archive') throw new Error('Unexpected archive payload');
    return exportArchives(await this.download(p));
  }
  private async upload(records: MemoryRecord[], purpose: Payload['purpose']): Promise<Payload> {
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
          [...this.pendingUploads.values()].reduce((n, p) => n + p.archive.size, 0) + archive.size >
          MAX
        ) {
          const evict = [...this.pendingUploads].find(([, p]) => !p.running);
          if (!evict)
            throw new Error('Finish the current encrypted upload before starting another');
          this.pendingUploads.delete(evict[0]);
        }
        pending = { archive, chunkSize, files: [] };
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
      const p = payload(
        count === 1
          ? { version: 2, purpose, id, file: current.files[0] }
          : {
              version: 2,
              purpose,
              id,
              size: current.archive.size,
              chunks: current.files.map((file, index) => ({ ...file, index })),
            },
      );
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
    await this.guard(id, peer); // Final awaited operation before SDK send; no plaintext fallback.
    await this.client.sendEvent(id, EVENT, signed, txn);
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
  async share(record: MemoryRecord, recipientIds: string[]): Promise<void> {
    const recipients = [...new Set(recipientIds)];
    if (!recipients.length || recipients.length > 100) throw new Error('Choose 1–100 friends');
    const rooms = recipients.map((peer) => {
      const room = this.friendRooms().find((r) => r.userId === peer);
      if (!room) throw new Error('Friendship required before sharing');
      return room;
    });
    for (const r of rooms) await this.guard(r.roomId, r.userId);
    const p = await this.upload([await sharedCopy(record)], 'post');
    for (const r of rooms) await this.send(r.roomId, p, r.userId);
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
    this.verifiedPayloads.set(event, payload(content));
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
  private async download(p: Payload): Promise<MemoryRecord[]> {
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
  ): AsyncGenerator<MatrixEvent> {
    const room = await this.guard(id, peer);
    let pages = 0;
    let deadline = Date.now() + 30000;
    while (room.oldState.paginationToken) {
      if (++pages > 500 || Date.now() > deadline) throw new HistoryScanLimit();
      const token = room.oldState.paginationToken;
      await this.client.scrollback(room, 100);
      if (room.oldState.paginationToken === token)
        throw new Error('History pagination made no progress');
    }
    let skipping = after !== undefined;
    for (const event of room.getLiveTimeline().getEvents()) {
      if (Date.now() > deadline) throw new HistoryScanLimit();
      if (skipping) {
        if (event.getId() === after) skipping = false;
        continue;
      }
      if (event.isEncrypted()) await this.client.decryptEventIfNeeded(event);
      if (event.isDecryptionFailure()) throw new Error('Encrypted history is unavailable');
      if (event.getType() !== EVENT) continue;
      if (![this.own(), peer].includes(event.getSender()))
        throw new Error('Unexpected content sender');
      await this.trusted(event, id);
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
        for await (const event of this.scanEvents(rooms[roomIndex].roomId)) {
          if (Date.now() > deadline) {
            mark('history');
            break scan;
          }
          const p = this.verifiedPayloads.get(event)!;
          if (p.purpose !== 'archive') throw new Error('Unexpected archive payload');
          if (batches.has(p.id)) continue;
          batches.add(p.id);
          for (const record of await this.download(p)) {
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
  async posts(): Promise<SharedPost[]> {
    const result: SharedPost[] = [];
    const seen = new Set<string>();
    this.locked = [];
    const rooms = this.client
      .getRooms()
      .filter((r) => this.purpose(r) === 'pair' && r.getMyMembership() === 'join')
      .flatMap((r) => {
        const peer = r
          .getMembers()
          .find((m) => m.userId !== this.own() && ['join', 'invite'].includes(m.membership ?? ''));
        return peer && !this.revoked.has(peer.userId)
          ? [{ roomId: r.roomId, userId: peer.userId }]
          : [];
      });
    for (const room of rooms) {
      try {
        const roomPosts: SharedPost[] = [];
        const roomSeen = new Set<string>();
        for (const event of await this.events(room.roomId, room.userId)) {
          const p = this.verifiedPayloads.get(event)!;
          if (p.purpose !== 'post') throw new Error('Unexpected shared payload');
          const key = `${event.getSender()}:${p.id}`;
          if (seen.has(key) || roomSeen.has(key)) continue;
          const records = await this.download(p);
          const r = records[0];
          if (
            records.length !== 1 ||
            !r ||
            r.privateOnly ||
            !['post', 'photo', 'album'].includes(r.kind) ||
            r.sourcePath ||
            Object.keys(r.provenance ?? {}).length ||
            r.attachments.some(
              (a, i) => a.mimeType !== 'image/png' || a.path !== `photo-${i + 1}.png`,
            )
          )
            throw new Error('Invalid shared copy');
          roomSeen.add(key);
          roomPosts.push({
            id: p.id,
            roomId: room.roomId,
            sender: event.getSender()!,
            timestamp: event.getTs(),
            record: r,
          });
        }
        result.push(...roomPosts);
        for (const key of roomSeen) seen.add(key);
      } catch {
        this.locked.push({
          ...room,
          reason:
            'Check this friend’s identity to open this room. If already checked, its encrypted content or room permissions could not be verified.',
        });
      }
    }
    return result.sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id));
  }
}
