import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  rmSync,
  statfsSync,
  utimesSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { CoreError } from './core.js';
import { Store } from './storage.js';
import { DEFAULT_LIMITS } from './archive/types.js';
import { archiveFileLimit, portablePathKey, safeRelative } from './archive/input.js';

export const CHUNK_BYTES = 4 * 1024 * 1024;
export const CHUNK_ENTRY_BYTES = 8192;
export const MAX_PATH_ENTRIES = 20000;
export const MAX_EMPTY_FILES = 64;
export interface ChunkFile {
  name: string;
  size: number;
}
export interface ChunkStatus {
  id: string;
  files: (ChunkFile & { offset: number })[];
  chunkBytes: number;
  expiresAt: number;
  state: 'active' | 'committed';
  jobId?: string;
  /** Present on begin/status; omitted from chunk acknowledgments. */
  chunks?: { fileIndex: number; offset: number; size: number; sha256: string }[];
}
export interface ChunkAck {
  id: string;
  fileIndex: number;
  offset: number;
  state: 'active';
}
export interface ChunkOptions {
  maxBytes: number;
  maxFiles?: number;
  maxFileBytes?: number;
  maxJsonBytes?: number;
  maxCompressedBytes?: number;
  maxDepth?: number;
  maxActiveUploads?: number;
  maxReservedBytes?: number;
  minFreeBytes?: number;
  ttlMs?: number;
  chunkTimeoutMs?: number;
  now?: () => number;
}
type Row = {
  id: string;
  owner_id: string;
  files: string;
  total: number;
  reserved_bytes: number;
  received: number;
  expires_at: number;
  state: 'active' | 'committed';
  job_id: string | null;
};
// Shared across instances in this process. The application owns the data-directory process lock.
const writers = new Map<string, Set<string>>();
const cancellations = new Map<string, Map<string, AbortController>>();
const completions = new Map<string, Map<string, Promise<void>>>();

/** Private, bounded upload state. Enqueue callbacks must synchronously use this Store's database. */
export class ChunkUploads {
  private readonly locks: Set<string>;
  private readonly cancellations: Map<string, AbortController>;
  private readonly completions: Map<string, Promise<void>>;
  private readonly now: () => number;
  private readonly parent: string;
  private readonly options: Required<Omit<ChunkOptions, 'now'>>;
  constructor(
    private readonly store: Store,
    options: ChunkOptions,
  ) {
    this.options = {
      maxFiles: 20000,
      maxFileBytes: DEFAULT_LIMITS.maxFileBytes,
      maxJsonBytes: DEFAULT_LIMITS.maxJsonBytes,
      maxCompressedBytes: DEFAULT_LIMITS.maxCompressedBytes,
      maxDepth: 20,
      maxActiveUploads: 4,
      maxReservedBytes:
        (options.maxBytes + (MAX_PATH_ENTRIES + 3) * CHUNK_ENTRY_BYTES) *
        (options.maxActiveUploads ?? 4),
      minFreeBytes: 1024 ** 3,
      ttlMs: 24 * 60 * 60 * 1000,
      chunkTimeoutMs: 60000,
      ...options,
    };
    for (const [key, value] of Object.entries(this.options)) {
      if (
        key !== 'now' &&
        (!Number.isSafeInteger(value) || Number(value) < (key === 'minFreeBytes' ? 0 : 1))
      )
        throw new Error(`Invalid chunk upload option: ${key}`);
    }
    this.options.maxFiles = Math.min(20000, this.options.maxFiles);
    this.now = options.now ?? Date.now;
    this.parent = join(store.dataDir, 'incoming');
    mkdirSync(this.parent, { recursive: true, mode: 0o700 });
    this.locks = writers.get(store.path) ?? new Set();
    writers.set(store.path, this.locks);
    this.cancellations = cancellations.get(store.path) ?? new Map();
    cancellations.set(store.path, this.cancellations);
    this.completions = completions.get(store.path) ?? new Map();
    completions.set(store.path, this.completions);
    store.db.exec(`CREATE TABLE IF NOT EXISTS chunk_uploads (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, files TEXT NOT NULL,
      total INTEGER NOT NULL, received INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'active', job_id TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS chunk_upload_owner_active ON chunk_uploads(owner_id) WHERE state='active';
    CREATE INDEX IF NOT EXISTS chunk_upload_expiry ON chunk_uploads(expires_at);
    CREATE TABLE IF NOT EXISTS chunk_upload_parts (
      upload_id TEXT NOT NULL REFERENCES chunk_uploads(id) ON DELETE CASCADE,
      file_index INTEGER NOT NULL, offset INTEGER NOT NULL, length INTEGER NOT NULL, hash TEXT NOT NULL,
      PRIMARY KEY(upload_id,file_index,offset)
    );
    CREATE TABLE IF NOT EXISTS chunk_upload_files (
      upload_id TEXT NOT NULL REFERENCES chunk_uploads(id) ON DELETE CASCADE,
      file_index INTEGER NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, offset INTEGER NOT NULL,
      PRIMARY KEY(upload_id,file_index)
    );`);
    // Migrate existing resumable uploads once, preserving their acknowledged offsets.
    const oldRows = store.db
      .prepare(
        'SELECT id,files FROM chunk_uploads WHERE NOT EXISTS (SELECT 1 FROM chunk_upload_files WHERE upload_id=chunk_uploads.id)',
      )
      .all() as { id: string; files: string }[];
    if (oldRows.length)
      store.transaction(() => {
        const insert = store.db.prepare('INSERT INTO chunk_upload_files VALUES(?,?,?,?,?)');
        for (const row of oldRows)
          (JSON.parse(row.files) as ChunkStatus['files']).forEach((file, index) =>
            insert.run(row.id, index, file.name, file.size, file.offset),
          );
      });
    if (
      !(store.db.prepare('PRAGMA table_info(chunk_uploads)').all() as { name: string }[]).some(
        (row) => row.name === 'reserved_bytes',
      )
    ) {
      store.db.exec(
        'ALTER TABLE chunk_uploads ADD COLUMN reserved_bytes INTEGER NOT NULL DEFAULT 0',
      );
      // Existing reservations receive a conservative metadata allowance too.
      store.db.exec(
        `UPDATE chunk_uploads SET reserved_bytes=total+${(MAX_PATH_ENTRIES + 1) * CHUNK_ENTRY_BYTES}`,
      );
    }
  }
  private root(id: string) {
    return join(this.parent, `upload-${id}`);
  }
  private get(owner: string, id: string): Row {
    const row = this.store.db
      .prepare(
        'SELECT id,owner_id,total,reserved_bytes,received,expires_at,state,job_id FROM chunk_uploads WHERE id=? AND owner_id=?',
      )
      .get(id, owner) as Row | undefined;
    if (!row || row.expires_at <= this.now())
      throw new CoreError(404, 'This upload is unavailable or has expired. Start again.');
    return row;
  }
  private files(id: string): ChunkStatus['files'] {
    return this.store.db
      .prepare(
        'SELECT name,size,offset FROM chunk_upload_files WHERE upload_id=? ORDER BY file_index',
      )
      .all(id) as unknown as ChunkStatus['files'];
  }
  private view(row: Row, includeChunks = true): ChunkStatus {
    return {
      id: row.id,
      files: this.files(row.id),
      ...(includeChunks
        ? {
            chunks: this.store.db
              .prepare(
                'SELECT file_index AS fileIndex, offset, length AS size, hash AS sha256 FROM chunk_upload_parts WHERE upload_id=? ORDER BY file_index, offset',
              )
              .all(row.id) as NonNullable<ChunkStatus['chunks']>,
          }
        : {}),
      chunkBytes: CHUNK_BYTES,
      expiresAt: row.expires_at,
      state: row.state,
      ...(row.job_id ? { jobId: row.job_id } : {}),
    };
  }
  private unlocked(id: string) {
    if (this.locks.has(id))
      throw new CoreError(409, 'Another upload request is still in progress. Retry shortly.');
  }
  /** Additional metadata entries are reserved only by the server's multipart path. */
  begin(owner: string, manifest: ChunkFile[], additionalMetadataEntries = 0): ChunkStatus {
    if (
      !Number.isSafeInteger(additionalMetadataEntries) ||
      additionalMetadataEntries < 0 ||
      additionalMetadataEntries > MAX_PATH_ENTRIES + 1
    )
      throw new Error('Invalid multipart metadata reservation');
    if (
      !owner ||
      !Array.isArray(manifest) ||
      !manifest.length ||
      manifest.length > this.options.maxFiles
    )
      throw new CoreError(400, 'Choose between one and 20,000 files.');
    const names = new Set<string>();
    const entries = new Set<string>();
    let emptyFiles = 0;
    let total = 0;
    const files = manifest.map((file) => {
      if (!file || typeof file.name !== 'string')
        throw new CoreError(400, 'A file has an unsafe path.');
      let name: string;
      try {
        if (file.name.endsWith('/')) throw new Error('file path');
        name = safeRelative(file.name);
      } catch {
        throw new CoreError(400, 'A file has an unsafe path or a name longer than 255 bytes.');
      }
      const key = portablePathKey(name);
      if (name.split('/').length > this.options.maxDepth || names.has(key))
        throw new CoreError(400, 'Duplicate, equivalent, or unsafe file path.');
      names.add(key);
      const pieces = name.split('/');
      for (let i = 1; i <= pieces.length; i++) {
        entries.add(portablePathKey(pieces.slice(0, i).join('/')));
        if (entries.size > MAX_PATH_ENTRIES)
          throw new CoreError(413, 'This upload has too many files and folders.');
      }
      if (!Number.isSafeInteger(file.size) || file.size < 0)
        throw new CoreError(400, 'A file has an invalid size.');
      const directReservation =
        additionalMetadataEntries > 0 &&
        manifest.length === 1 &&
        name === 'direct-upload-reservation';
      if (!directReservation && file.size > archiveFileLimit(name, this.options))
        throw new CoreError(
          413,
          'A file exceeds the archive limit for its type. Choose a smaller export part or media file.',
        );
      if (file.size === 0 && ++emptyFiles > MAX_EMPTY_FILES)
        throw new CoreError(413, 'Choose at most 64 empty files in one upload.');
      total += file.size;
      if (!Number.isSafeInteger(total) || total > this.options.maxBytes)
        throw new CoreError(413, 'This upload exceeds the host’s upload allowance.');
      return { name, size: file.size, offset: 0 };
    });
    for (const name of names) {
      const pieces = name.split('/');
      for (let i = 1; i < pieces.length; i++)
        if (names.has(pieces.slice(0, i).join('/')))
          throw new CoreError(400, 'A file and folder have the same path.');
    }
    const reservation = total + (entries.size + 1 + additionalMetadataEntries) * CHUNK_ENTRY_BYTES;
    this.cleanup();
    const id = randomUUID();
    try {
      this.store.transaction(() => {
        if (
          this.store.db
            .prepare("SELECT id FROM chunk_uploads WHERE owner_id=? AND state='active'")
            .get(owner)
        )
          throw new CoreError(409, 'Resume or cancel your existing upload first.');
        const reserved = this.store.db
          .prepare(
            "SELECT COUNT(*) AS n, COALESCE(SUM(reserved_bytes),0) AS bytes, COALESCE(SUM(reserved_bytes-received),0) AS remaining FROM chunk_uploads WHERE state='active'",
          )
          .get() as { n: number; bytes: number; remaining: number };
        const disk = statfsSync(this.parent);
        if (
          reserved.n >= this.options.maxActiveUploads ||
          reserved.bytes + reservation > this.options.maxReservedBytes
        )
          throw new CoreError(503, 'The host is busy receiving other uploads. Try again later.');
        if (disk.bavail * disk.bsize - reserved.remaining - reservation < this.options.minFreeBytes)
          throw new CoreError(
            507,
            'The host needs more free storage before receiving this upload.',
          );
        this.store.db
          .prepare(
            'INSERT INTO chunk_uploads(id,owner_id,files,total,expires_at,reserved_bytes) VALUES (?,?,?,?,?,?)',
          )
          .run(
            id,
            owner,
            JSON.stringify(files),
            total,
            this.now() + this.options.ttlMs,
            reservation,
          );
        const insertFile = this.store.db.prepare(
          'INSERT INTO chunk_upload_files VALUES(?,?,?,?,?)',
        );
        files.forEach((file, index) => insertFile.run(id, index, file.name, file.size, 0));
      });
      // A constant amount of filesystem work, after the reservation commits.
      mkdirSync(this.root(id), { mode: 0o700 });
      return this.status(owner, id);
    } catch (error) {
      this.store.db.prepare('DELETE FROM chunk_uploads WHERE id=?').run(id);
      rmSync(this.root(id), { recursive: true, force: true });
      throw error;
    }
  }
  active(owner: string): ChunkStatus | null {
    const row = this.store.db
      .prepare("SELECT * FROM chunk_uploads WHERE owner_id=? AND state='active' AND expires_at>?")
      .get(owner, this.now()) as Row | undefined;
    return row ? this.view(row) : null;
  }
  status(owner: string, id: string): ChunkStatus {
    return this.view(this.get(owner, id));
  }
  async writeChunk(
    owner: string,
    id: string,
    fileIndex: number,
    offset: number,
    body: ReadableStream<Uint8Array> | Uint8Array,
    hash: string,
    authorize?: () => void,
  ): Promise<ChunkAck> {
    const row = this.get(owner, id);
    this.unlocked(id);
    if (row.state !== 'active') throw new CoreError(409, 'This upload has already been submitted.');
    const file = this.store.db
      .prepare('SELECT name,size,offset FROM chunk_upload_files WHERE upload_id=? AND file_index=?')
      .get(id, fileIndex) as ChunkStatus['files'][number] | undefined;
    if (
      !Number.isSafeInteger(fileIndex) ||
      fileIndex < 0 ||
      !file ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset % CHUNK_BYTES !== 0 ||
      offset >= file.size ||
      offset > file.offset ||
      !/^[a-f0-9]{64}$/i.test(hash)
    )
      throw new CoreError(400, 'Invalid upload chunk.');
    const length = Math.min(CHUNK_BYTES, file.size - offset);
    const previous = this.store.db
      .prepare(
        'SELECT length,hash FROM chunk_upload_parts WHERE upload_id=? AND file_index=? AND offset=?',
      )
      .get(id, fileIndex, offset) as { length: number; hash: string } | undefined;
    if (
      offset < file.offset &&
      (!previous || previous.hash !== hash.toLowerCase() || previous.length !== length)
    )
      throw new CoreError(409, 'This chunk conflicts with bytes already received.');
    this.locks.add(id);
    const controller = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.cancellations.set(id, controller);
    this.completions.set(id, done);
    let fd: number | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let written = 0;
    let acknowledged = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (
        !existsSync(this.root(id)) ||
        (!existsSync(join(this.root(id), file.name)) && file.offset > 0)
      )
        throw new CoreError(409, 'The upload files are unavailable. Start again.');
      if (!previous) {
        const disk = statfsSync(this.parent);
        if (disk.bavail * disk.bsize - length < this.options.minFreeBytes)
          throw new CoreError(507, 'The host needs more free storage.');
        const path = join(this.root(id), file.name);
        if (!existsSync(path) && file.offset === 0) {
          mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
          fd = openSync(path, 'wx+', 0o600);
        } else fd = openSync(path, 'r+');
        // A process crash may leave unacknowledged bytes beyond the durable offset.
        ftruncateSync(fd, file.offset);
      }
      const digest = createHash('sha256');
      const consume = (bytes: Uint8Array) => {
        if (!(bytes instanceof Uint8Array) || written + bytes.byteLength > length)
          throw new CoreError(413, 'This chunk exceeds its expected size.');
        digest.update(bytes);
        if (fd !== undefined) {
          let n = 0;
          while (n < bytes.length)
            n += writeSync(fd, bytes, n, bytes.length - n, offset + written + n);
        }
        written += bytes.byteLength;
      };
      if (body instanceof Uint8Array) consume(body);
      else {
        reader = body.getReader();
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new CoreError(408, 'This upload chunk timed out. Retry it.')),
            this.options.chunkTimeoutMs,
          );
        });
        const cancelled = new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
            once: true,
          });
        });
        while (true) {
          const part = await Promise.race([reader.read(), deadline, cancelled]);
          if (part.done) break;
          consume(part.value);
        }
      }
      if (written !== length || digest.digest('hex') !== hash.toLowerCase())
        throw new CoreError(
          400,
          'The chunk is incomplete or its checksum does not match. Retry it.',
        );
      if (fd !== undefined) fsyncSync(fd);
      this.store.transaction(() => {
        authorize?.();
        const current = this.get(owner, id);
        if (current.state !== 'active')
          throw new CoreError(409, 'This upload is no longer active.');
        if (!previous) {
          file.offset += written;
          this.store.db
            .prepare('INSERT INTO chunk_upload_parts VALUES(?,?,?,?,?)')
            .run(id, fileIndex, offset, written, hash.toLowerCase());
          this.store.db
            .prepare('UPDATE chunk_uploads SET received=received+? WHERE id=?')
            .run(written, id);
          this.store.db
            .prepare('UPDATE chunk_upload_files SET offset=? WHERE upload_id=? AND file_index=?')
            .run(file.offset, id, fileIndex);
        }
      });
      acknowledged = true;
      // Archive staging cleanup also checks this directory's modification time.
      utimesSync(this.root(id), new Date(this.now()), new Date(this.now()));
      return { id, fileIndex, offset: file.offset, state: 'active' };
    } catch (error) {
      if (fd !== undefined && !acknowledged) {
        ftruncateSync(fd, offset);
        fsyncSync(fd);
      }
      if (reader) await reader.cancel().catch(() => {});
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new CoreError(409, 'The upload files are unavailable. Start again.');
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      if (fd !== undefined) closeSync(fd);
      reader?.releaseLock();
      this.locks.delete(id);
      this.cancellations.delete(id);
      this.completions.delete(id);
      try {
        this.discardExpired(id);
      } finally {
        finish();
      }
    }
  }
  commit(
    owner: string,
    id: string,
    enqueue: (path: string, options: { format: 'zip' | 'directory' }) => string,
  ): string {
    const pending = this.get(owner, id);
    this.unlocked(id);
    if (pending.state === 'committed') return pending.job_id!;
    const pendingFiles = this.files(id);
    if (pendingFiles.some((f) => f.offset !== f.size))
      throw new CoreError(409, 'Wait for all files to finish uploading.');
    if (!existsSync(this.root(id)))
      throw new CoreError(409, 'The upload files are unavailable. Start again.');
    const empty = pendingFiles.filter((f) => f.size === 0);
    if (empty.length > MAX_EMPTY_FILES)
      throw new CoreError(413, 'Choose at most 64 empty files in one upload.');
    // Empty files have no chunk request. Materialize this small bounded set
    // outside the transaction; retrying a rolled-back enqueue is harmless.
    for (const file of empty) {
      const path = join(this.root(id), file.name);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      if (!existsSync(path)) closeSync(openSync(path, 'wx', 0o600));
    }
    return this.store.transaction(() => {
      const row = this.get(owner, id);
      this.unlocked(id);
      if (row.state === 'committed') return row.job_id!;
      const files = this.files(id);
      if (files.some((f) => f.offset !== f.size))
        throw new CoreError(409, 'Wait for all files to finish uploading.');
      if (!existsSync(this.root(id)))
        throw new CoreError(409, 'The upload files are unavailable. Start again.');
      const zip = files.length === 1 && files[0]!.name.toLowerCase().endsWith('.zip');
      const jobId = enqueue(zip ? join(this.root(id), files[0]!.name) : this.root(id), {
        format: zip ? 'zip' : 'directory',
      });
      if (typeof jobId !== 'string' || !jobId)
        throw new Error('The enqueue callback must synchronously return an import job ID.');
      this.store.db
        .prepare("UPDATE chunk_uploads SET state='committed',job_id=? WHERE id=?")
        .run(jobId, id);
      return jobId;
    });
  }
  /** Keep a direct multipart reservation locked while its request owns staged files. */
  async withReservation<T>(
    owner: string,
    id: string,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.get(owner, id);
    this.unlocked(id);
    this.locks.add(id);
    const controller = new AbortController();
    this.cancellations.set(id, controller);
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.completions.set(id, done);
    try {
      const result = await work(controller.signal);
      this.get(owner, id);
      return result;
    } finally {
      this.cancellations.delete(id);
      this.completions.delete(id);
      this.locks.delete(id);
      try {
        this.discardExpired(id);
      } finally {
        finish();
      }
    }
  }
  private discardExpired(id: string): void {
    const row = this.store.db
      .prepare('SELECT * FROM chunk_uploads WHERE id=? AND expires_at<=?')
      .get(id, this.now()) as Row | undefined;
    if (row) this.discard(row);
  }
  cancel(owner: string, id: string): void {
    const row = this.get(owner, id);
    this.unlocked(id);
    if (row.state === 'committed')
      throw new CoreError(409, 'This upload is already an import. Cancel it from the import page.');
    this.discard(row);
  }
  private discard(row: Row) {
    if (row.state === 'active') rmSync(this.root(row.id), { recursive: true, force: true });
    this.store.db.prepare('DELETE FROM chunk_uploads WHERE id=?').run(row.id);
  }
  /** Committed inputs belong to Archive; its owner-deletion path disposes of them. */
  deleteOwner(owner: string): Promise<void> {
    const rows = this.store.db
      .prepare('SELECT * FROM chunk_uploads WHERE owner_id=?')
      .all(owner) as Row[];
    const pending: Promise<void>[] = [];
    for (const row of rows) {
      if (this.locks.has(row.id)) {
        this.store.db.prepare('UPDATE chunk_uploads SET expires_at=0 WHERE id=?').run(row.id);
        const done = this.completions.get(row.id);
        if (done) pending.push(done.then(() => this.discardExpired(row.id)));
        this.cancellations
          .get(row.id)
          ?.abort(new CoreError(410, 'This upload was cancelled because the account was deleted.'));
      } else this.discard(row);
    }
    const cleanup = pending.length ? Promise.all(pending).then(() => {}) : Promise.resolve();
    // The request handler can initiate cancellation synchronously; the deletion
    // coordinator awaits the same cleanup. Keep an early caller from creating
    // an unhandled rejection without converting a failed purge into success.
    void cleanup.catch(() => {});
    return cleanup;
  }
  cleanup(): number {
    const rows = this.store.db
      .prepare('SELECT * FROM chunk_uploads WHERE expires_at<=? LIMIT 100')
      .all(this.now()) as Row[];
    let removed = 0;
    for (const row of rows)
      if (!this.locks.has(row.id)) {
        this.discard(row);
        removed++;
      }
    return removed;
  }
}
