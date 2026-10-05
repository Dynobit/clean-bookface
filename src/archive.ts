import { randomUUID, createHash } from 'node:crypto';
import { createReadStream, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, lstat, open, opendir, rm } from 'node:fs/promises';
import { resolve, join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import yazl from 'yazl';
import { isDatabaseBusy, type Store } from './storage.js';
import {
  DEFAULT_LIMITS,
  type ArchiveLimits,
  type ArchiveMedia,
  type ArchiveItem,
  type ArchiveKind,
  type ImportReport,
  type ImportJob,
  type NormalizedRecord,
} from './archive/types.js';
import {
  ArchiveAdmissionError,
  beneath,
  boundedRead,
  diskSpace,
  extractZip,
  safeRelative,
  scanDirectory,
} from './archive/input.js';
import { digest, parseFacebook } from './archive/parser.js';
import { openPortableImport } from './archive/portable.js';
export * from './archive/types.js';
const blankReport = (): ImportReport => ({
  added: 0,
  revised: 0,
  unchanged: 0,
  skipped: 0,
  failed: 0,
  files: 0,
  records: 0,
  media: 0,
  warnings: [],
});
type Row = Record<string, any>;

// Kernel process birth identity is shared by all worker_threads, but changes on PID reuse.
// Unknown identity is fail-closed: maintenance must never guess that a writer died.
function processBirth(pid: number): { identity: string; startedAt: number } | null {
  try {
    if (process.platform === 'linux') {
      const fields = readFileSync(`/proc/${pid}/stat`, 'utf8')
        .split(')')
        .slice(1)
        .join(')')
        .trim()
        .split(/\s+/u);
      const ticks = Number(fields[19]);
      const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      const bootSeconds = Number(/^btime (\d+)$/mu.exec(readFileSync('/proc/stat', 'utf8'))?.[1]);
      const hz = Number(
        execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 1000 }).trim(),
      );
      if (!Number.isFinite(ticks) || !bootSeconds || !hz) return null;
      return { identity: `${boot}:${ticks}`, startedAt: (bootSeconds + ticks / hz) * 1000 };
    }
    const birth = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      timeout: 1000,
      env: { ...process.env, LC_ALL: 'C' },
    }).trim();
    const startedAt = Date.parse(birth);
    return Number.isFinite(startedAt) ? { identity: birth, startedAt } : null;
  } catch {
    return null;
  }
}

export class Archive {
  readonly limits: ArchiveLimits;
  readonly mediaDir: string;
  readonly stagingDir: string;
  private activeWorker?: Worker;
  private workerJobId?: string;
  private timer?: ReturnType<typeof setInterval>;
  private workerStarting = false;
  private stoppingWorker = false;
  private maintaining = false;
  private orphanScan?: Awaited<ReturnType<typeof opendir>>;
  private pollTask?: Promise<void>;
  private workerDone?: Promise<void>;
  private recoveryNeeded = false;
  private pendingExits = new Map<string, boolean>();
  private activeExports = new Set<{ cancel: () => void; done: Promise<void> }>();
  private exportsStopped = false;
  private ownerGenerations = new Map<string, number>();
  constructor(
    readonly store: Store,
    options: { limits?: Partial<ArchiveLimits> } = {},
  ) {
    const schema = store.db
      .prepare("SELECT version FROM schema_versions WHERE component='archive'")
      .get() as { version: number } | undefined;
    if (schema && schema.version > 1)
      throw new Error(
        'Archive schema is newer than this application; restore the matching release.',
      );
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.mediaDir = join(store.dataDir, 'media');
    this.stagingDir = join(store.dataDir, 'imports');
    mkdirSync(this.mediaDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.stagingDir, { recursive: true, mode: 0o700 });
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS archive_file_writes (
        filename TEXT PRIMARY KEY, pid INTEGER NOT NULL, job_id TEXT
      );
      CREATE TABLE IF NOT EXISTS archive_jobs (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, input_path TEXT NOT NULL, format TEXT NOT NULL,
        status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        completed_files INTEGER NOT NULL DEFAULT 0, total_files INTEGER NOT NULL DEFAULT 0,
        cancel_requested INTEGER NOT NULL DEFAULT 0, report TEXT, error TEXT
      );
      CREATE INDEX IF NOT EXISTS archive_jobs_owner ON archive_jobs(owner_id, created_at);
      CREATE TABLE IF NOT EXISTS archive_items (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL,
        title TEXT NOT NULL, occurred_at INTEGER, imported_at INTEGER NOT NULL, version INTEGER NOT NULL,
        source TEXT NOT NULL, source_key TEXT NOT NULL, content_hash TEXT NOT NULL,
        media_ids TEXT NOT NULL, metadata TEXT NOT NULL, UNIQUE(owner_id, source_key)
      );
      CREATE INDEX IF NOT EXISTS archive_items_owner_date ON archive_items(owner_id, occurred_at DESC);
      CREATE TABLE IF NOT EXISTS archive_versions (
        item_id TEXT NOT NULL, owner_id TEXT NOT NULL, version INTEGER NOT NULL,
        record TEXT NOT NULL, PRIMARY KEY(item_id, version)
      );
      CREATE TABLE IF NOT EXISTS archive_stage (
        job_id TEXT NOT NULL, source_key TEXT NOT NULL, record TEXT NOT NULL, hash TEXT NOT NULL,
        PRIMARY KEY(job_id, source_key)
      );
      CREATE TABLE IF NOT EXISTS archive_media (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
        sha256 TEXT NOT NULL, filename TEXT NOT NULL, width INTEGER, height INTEGER,
        purpose TEXT NOT NULL, original_id TEXT, pending_job TEXT, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS archive_media_owner_hash ON archive_media(owner_id, sha256, purpose);
    `);
    if (
      !store.db
        .prepare('PRAGMA table_info(archive_file_writes)')
        .all()
        .some((column) => column.name === 'process_birth')
    ) {
      store.db.exec('ALTER TABLE archive_file_writes ADD COLUMN process_birth TEXT');
    }
    store.db
      .prepare(
        "INSERT INTO schema_versions(component,version) VALUES('archive',1) ON CONFLICT(component) DO UPDATE SET version=1",
      )
      .run();
  }
  private item(row: Row): ArchiveItem {
    return {
      id: row.id,
      ownerId: row.owner_id,
      kind: row.kind,
      body: row.body,
      title: row.title,
      occurredAt: row.occurred_at,
      importedAt: row.imported_at,
      version: row.version,
      source: row.source,
      sourceKey: row.source_key,
      mediaIds: JSON.parse(row.media_ids),
      metadata: JSON.parse(row.metadata),
    };
  }
  private mediaRow(row: Row): ArchiveMedia {
    return {
      id: row.id,
      ownerId: row.owner_id,
      mime: row.mime,
      size: row.size,
      sha256: row.sha256,
      path: join(this.mediaDir, row.filename),
      width: row.width,
      height: row.height,
      purpose: row.purpose,
      originalId: row.original_id,
    };
  }
  list(
    ownerId: string,
    options: { kind?: ArchiveKind; query?: string; limit?: number; offset?: number } = {},
  ): ArchiveItem[] {
    const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 50)));
    const offset = Math.max(0, Math.min(1_000_000, Math.trunc(options.offset ?? 0)));
    const query = (options.query ?? '').slice(0, 512).replace(/[\\%_]/gu, '\\$&');
    const rows = this.store.db
      .prepare(
        `SELECT * FROM archive_items WHERE owner_id = ?
      AND (? = '' OR kind = ?) AND (? = '' OR body LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')
      ORDER BY occurred_at IS NULL, occurred_at DESC, id LIMIT ? OFFSET ?`,
      )
      .all(
        ownerId,
        options.kind ?? '',
        options.kind ?? '',
        query,
        `%${query}%`,
        `%${query}%`,
        limit,
        offset,
      );
    return rows.map((row) => this.item(row));
  }
  photoItems(ownerId: string, options: { limit?: number; offset?: number } = {}): ArchiveItem[] {
    const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 50)));
    const offset = Math.max(0, Math.trunc(options.offset ?? 0));
    return this.store.db
      .prepare(
        `SELECT * FROM archive_items WHERE owner_id=? AND kind IN ('post','photo') AND json_array_length(media_ids)>0 ORDER BY occurred_at IS NULL,occurred_at DESC,id LIMIT ? OFFSET ?`,
      )
      .all(ownerId, limit, offset)
      .map((row) => this.item(row));
  }
  albums(
    ownerId: string,
  ): Array<{ id: string; title: string; mediaIds: string[]; itemIds: string[] }> {
    return this.list(ownerId, { kind: 'album', limit: 100 }).map((album) => ({
      id: album.id,
      title: album.title,
      mediaIds: album.mediaIds,
      itemIds: this.store.db
        .prepare(
          `SELECT DISTINCT i.id FROM archive_items i,json_each(i.media_ids) media WHERE i.owner_id=? AND i.source=? AND i.kind='photo' AND media.value IN (SELECT value FROM json_each(?))`,
        )
        .all(ownerId, album.source, JSON.stringify(album.mediaIds))
        .map((row) => String(row.id)),
    }));
  }
  count(ownerId: string): number {
    return Number(
      (
        this.store.db
          .prepare('SELECT COUNT(*) AS n FROM archive_items WHERE owner_id=?')
          .get(ownerId) as Row
      ).n,
    );
  }
  get(ownerId: string, id: string): ArchiveItem | null {
    const row = this.store.db
      .prepare('SELECT * FROM archive_items WHERE id=? AND owner_id=?')
      .get(id, ownerId);
    return row ? this.item(row) : null;
  }
  media(ownerId: string, id: string): ArchiveMedia | null {
    const row = this.store.db
      .prepare('SELECT * FROM archive_media WHERE id=? AND owner_id=? AND pending_job IS NULL')
      .get(id, ownerId);
    return row ? this.mediaRow(row) : null;
  }
  isShareableMedia(ownerId: string, id: string): boolean {
    return this.media(ownerId, id)?.purpose === 'shared';
  }
  mediaUsage(ownerId: string): number {
    return Number(
      (
        this.store.db
          .prepare('SELECT COALESCE(SUM(size),0) AS n FROM archive_media WHERE owner_id=?')
          .get(ownerId) as Row
      ).n,
    );
  }
  usage(ownerId: string): number {
    const items = Number(
      (
        this.store.db
          .prepare(
            'SELECT COALESCE(SUM(length(CAST(body AS BLOB)) + length(CAST(title AS BLOB)) + length(CAST(metadata AS BLOB))),0) AS n FROM archive_items WHERE owner_id=?',
          )
          .get(ownerId) as Row
      ).n,
    );
    const revisions = Number(
      (
        this.store.db
          .prepare(
            'SELECT COALESCE(SUM(length(CAST(record AS BLOB))),0) AS n FROM archive_versions WHERE owner_id=?',
          )
          .get(ownerId) as Row
      ).n,
    );
    return this.mediaUsage(ownerId) + items + revisions;
  }
  private checkQuota(ownerId: string, bytes: number): void {
    if (this.usage(ownerId) + bytes > this.limits.ownerBytes)
      throw new ArchiveAdmissionError('Account storage allowance exceeded');
  }
  /** Capture deletion state before yielding; authorize must synchronously revalidate the caller. */
  private writeGuard(ownerId: string, authorize?: () => void): () => void {
    const generation = this.ownerGenerations.get(ownerId) ?? 0;
    const hasUsers = !!this.store.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'")
      .get();
    return () => {
      authorize?.();
      // Archive-only tools have no users table; deletion still invalidates their in-flight work.
      if ((this.ownerGenerations.get(ownerId) ?? 0) !== generation)
        throw new ArchiveAdmissionError('Account archive was deleted');
      if (hasUsers) {
        const owner = this.store.db
          .prepare('SELECT deleted,suspended FROM users WHERE id=?')
          .get(ownerId);
        if (!owner || owner.deleted || owner.suspended)
          throw new ArchiveAdmissionError('Account is no longer available for media changes');
      }
    };
  }
  private requireOriginal(ownerId: string, original: ArchiveMedia): void {
    if (JSON.stringify(this.media(ownerId, original.id)) !== JSON.stringify(original))
      throw new Error('Photo changed or was deleted. Choose it again.');
  }
  private async ingestMedia(
    ownerId: string,
    input: string,
    pendingJob: string | null = null,
    imagesOnly = false,
    authorize?: () => void,
  ): Promise<ArchiveMedia> {
    const ownerGuard = this.writeGuard(ownerId, authorize);
    const check = () => {
      ownerGuard();
      if (
        pendingJob &&
        !this.store.db
          .prepare(
            "SELECT 1 FROM archive_jobs WHERE id=? AND owner_id=? AND status='running' AND cancel_requested=0",
          )
          .get(pendingJob, ownerId)
      )
        throw new ArchiveAdmissionError('Import cancelled');
    };
    check();
    const s = await lstat(input);
    if (!s.isFile() || s.isSymbolicLink())
      throw new ArchiveAdmissionError('Archive links and special files are not allowed');
    if (s.size > this.limits.maxFileBytes)
      throw new Error('Unsupported media file or size limit exceeded');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(input)) hash.update(chunk);
    const sha = hash.digest('hex');
    check();
    const existing = this.store.db
      .prepare(
        `SELECT * FROM archive_media WHERE owner_id=? AND sha256=? AND purpose='original'
      AND (pending_job IS NULL OR pending_job=?) LIMIT 1`,
      )
      .get(ownerId, sha, pendingJob ?? '');
    if (existing) {
      if (imagesOnly && !String(existing.mime).startsWith('image/'))
        throw new Error('Choose a still photo for sharing');
      return this.mediaRow(existing);
    }
    this.checkQuota(ownerId, s.size);
    await diskSpace(this.mediaDir, s.size);
    let mime: string;
    let width: number | null = null;
    let height: number | null = null;
    const handle = await open(input, 'r');
    const magic = Buffer.alloc(16);
    try {
      await handle.read(magic, 0, 16, 0);
    } finally {
      await handle.close();
    }
    if (
      magic.subarray(4, 8).toString('ascii') === 'ftyp' &&
      !['avif', 'avis', 'heic', 'heix', 'mif1', 'msf1'].includes(
        magic.subarray(8, 12).toString('ascii'),
      )
    ) {
      if (imagesOnly) throw new Error('Choose a still photo for sharing');
      mime = 'video/mp4';
    } else {
      const meta = await sharp(input, {
        limitInputPixels: this.limits.maxPixels,
        failOn: 'warning',
        animated: false,
      })
        .timeout({ seconds: 20 })
        .metadata();
      if (
        !meta.format ||
        !['jpeg', 'png', 'webp', 'gif', 'avif', 'heif'].includes(meta.format) ||
        !meta.width ||
        !meta.height ||
        (meta.pages ?? 1) > 1
      )
        throw new Error('Unsupported or animated image');
      if (meta.width * meta.height > this.limits.maxPixels)
        throw new Error('Image pixel limit exceeded');
      // Decode all pixels before admitting the file; metadata-only validation is insufficient.
      await sharp(input, { limitInputPixels: this.limits.maxPixels, failOn: 'warning' })
        .timeout({ seconds: 20 })
        .resize({ width: 8, height: 8, fit: 'inside' })
        .png()
        .toBuffer();
      mime = `image/${meta.format === 'heif' ? 'heic' : meta.format}`;
      width = meta.width;
      height = meta.height;
    }
    const id = randomUUID();
    const filename = `${id}.original`;
    const target = join(this.mediaDir, filename);
    this.reserveFile(filename, pendingJob);
    try {
      await copyFile(input, target);
      await chmod(target, 0o600);
      this.store.transaction(() => {
        check();
        this.checkQuota(ownerId, s.size);
        this.store.db
          .prepare(
            `INSERT INTO archive_media (id,owner_id,mime,size,sha256,filename,width,height,purpose,original_id,pending_job,created_at) VALUES (?,?,?,?,?,?,?,?,'original',NULL,?,?)`,
          )
          .run(id, ownerId, mime, s.size, sha, filename, width, height, pendingJob, Date.now());
      });
    } catch (error) {
      await rm(target, { force: true });
      throw error;
    } finally {
      this.releaseFile(filename);
    }
    return this.mediaRow(this.store.db.prepare('SELECT * FROM archive_media WHERE id=?').get(id)!);
  }
  async uploadPhoto(
    ownerId: string,
    stagedPath: string,
    authorize?: () => void,
  ): Promise<ArchiveMedia> {
    const check = this.writeGuard(ownerId, authorize);
    check();
    // Only the authenticated HTTP staging layer chooses this path; never bind it to a submitted path.
    const original = await this.ingestMedia(ownerId, stagedPath, null, true, check);
    if (!original.mime.startsWith('image/')) throw new Error('Choose a still photo for sharing');
    const sourceKey = digest(`native-photo:${original.id}`);
    this.store.transaction(() => {
      check();
      this.requireOriginal(ownerId, original);
      if (
        !this.store.db
          .prepare('SELECT 1 FROM archive_items WHERE owner_id=? AND source_key=?')
          .get(ownerId, sourceKey)
      ) {
        if (this.count(ownerId) >= this.limits.maxRecords)
          throw new Error('Account archive record limit exceeded');
        const now = Date.now();
        this.store.db
          .prepare(
            `INSERT INTO archive_items (id,owner_id,kind,body,title,occurred_at,imported_at,version,source,source_key,content_hash,media_ids,metadata) VALUES (?,?,'photo','','Your photo',?,?,1,'native-upload',?,?,?,'{}')`,
          )
          .run(
            randomUUID(),
            ownerId,
            now,
            now,
            sourceKey,
            original.sha256,
            JSON.stringify([original.id]),
          );
      }
    });
    return this.makeSharedMedia(ownerId, original.id, check);
  }
  async makeSharedMedia(
    ownerId: string,
    originalId: string,
    authorize?: () => void,
  ): Promise<ArchiveMedia> {
    const check = this.writeGuard(ownerId, authorize);
    check();
    const original = this.media(ownerId, originalId);
    if (!original) throw new Error('Photo not found');
    if (!original.mime.startsWith('image/'))
      throw new Error('Videos cannot be shared. Choose still photos.');
    if (original.purpose === 'shared') return original;
    const existing = this.store.db
      .prepare(
        `SELECT * FROM archive_media WHERE owner_id=? AND original_id=? AND purpose='shared' AND pending_job IS NULL`,
      )
      .get(ownerId, originalId);
    if (existing) {
      this.store.transaction(() => {
        check();
        this.requireOriginal(ownerId, original);
        this.store.db
          .prepare('UPDATE archive_media SET created_at=? WHERE id=?')
          .run(Date.now(), existing.id);
      });
      return this.mediaRow(existing);
    }
    const id = randomUUID();
    const filename = `${id}.webp`;
    const target = join(this.mediaDir, filename);
    this.reserveFile(filename, null);
    try {
      // Sharp removes EXIF/XMP/IPTC by default; rotate applies orientation before stripping.
      const output = await sharp(original.path, {
        limitInputPixels: this.limits.maxPixels,
        failOn: 'warning',
      })
        .timeout({ seconds: 20 })
        .rotate()
        .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 85 })
        .toFile(target);
      if (output.size > 8 * 1024 * 1024)
        throw new Error('Shared photo exceeds the 8 MiB limit. Choose a smaller photo.');
      await chmod(target, 0o600);
      const content = await boundedRead(target, 8 * 1024 * 1024);
      this.store.transaction(() => {
        check();
        this.requireOriginal(ownerId, original);
        this.checkQuota(ownerId, output.size);
        this.store.db
          .prepare(
            `INSERT INTO archive_media (id,owner_id,mime,size,sha256,filename,width,height,purpose,original_id,pending_job,created_at) VALUES (?,?,'image/webp',?,?,?,?,?,'shared',?,NULL,?)`,
          )
          .run(
            id,
            ownerId,
            output.size,
            digest(content),
            filename,
            output.width,
            output.height,
            originalId,
            Date.now(),
          );
      });
      return this.media(ownerId, id)!;
    } catch (e) {
      await rm(target, { force: true });
      throw e;
    } finally {
      this.releaseFile(filename);
    }
  }
  async shareCopy(
    ownerId: string,
    itemId: string,
    selectedMediaIds?: string[],
    authorize?: () => void,
  ): Promise<{ body: string; media: ArchiveMedia[] }> {
    const ownerGuard = this.writeGuard(ownerId, authorize);
    ownerGuard();
    const item = this.get(ownerId, itemId);
    if (!item || !['post', 'photo'].includes(item.kind))
      throw new Error('Only your posts and photos can be shared from the archive');
    const ids = selectedMediaIds ?? item.mediaIds;
    if (ids.length > 8 || ids.some((id) => !item.mediaIds.includes(id)))
      throw new Error('Choose up to eight photos belonging to this memory');
    const check = () => {
      ownerGuard();
      if (JSON.stringify(this.get(ownerId, itemId)) !== JSON.stringify(item))
        throw new Error('Memory changed or was deleted. Choose it again.');
    };
    const media: ArchiveMedia[] = [];
    for (const id of [...new Set(ids)]) media.push(await this.makeSharedMedia(ownerId, id, check));
    check();
    for (const photo of media) this.requireOriginal(ownerId, photo);
    return { body: item.body, media };
  }
  private jobRow(row: Row): ImportJob {
    return {
      id: row.id,
      ownerId: row.owner_id,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedFiles: row.completed_files,
      totalFiles: row.total_files,
      report: row.report ? JSON.parse(row.report) : null,
      error: row.error,
    };
  }
  jobs(ownerId: string): ImportJob[] {
    return this.store.db
      .prepare('SELECT * FROM archive_jobs WHERE owner_id=? ORDER BY created_at DESC LIMIT 30')
      .all(ownerId)
      .map((r) => this.jobRow(r));
  }
  job(ownerId: string, id: string): ImportJob | null {
    const row = this.store.db
      .prepare('SELECT * FROM archive_jobs WHERE id=? AND owner_id=?')
      .get(id, ownerId);
    return row ? this.jobRow(row) : null;
  }
  enqueueImport(
    ownerId: string,
    stagedPath: string,
    options: { format?: 'directory' | 'zip' } = {},
  ): string {
    const pending = this.store.db
      .prepare(
        `SELECT COUNT(*) AS n FROM archive_jobs WHERE owner_id=? AND status IN ('queued','running')`,
      )
      .get(ownerId) as Row;
    if (Number(pending.n) >= 2) throw new Error('Wait for your current imports to finish');
    const id = randomUUID();
    const now = Date.now();
    this.store.db
      .prepare(
        `INSERT INTO archive_jobs (id,owner_id,input_path,format,status,created_at,updated_at) VALUES (?,?,?,?,'queued',?,?)`,
      )
      .run(id, ownerId, resolve(stagedPath), options.format ?? 'directory', now, now);
    return id;
  }
  cancelJob(ownerId: string, id: string): boolean {
    return (
      Number(
        this.store.db
          .prepare(
            `UPDATE archive_jobs SET cancel_requested=1, updated_at=? WHERE id=? AND owner_id=? AND status IN ('queued','running')`,
          )
          .run(Date.now(), id, ownerId).changes,
      ) > 0
    );
  }
  async importDirectory(ownerId: string, stagedDir: string): Promise<ImportReport> {
    const id = this.enqueueImport(ownerId, stagedDir);
    return this.runJob(id);
  }
  async importZip(ownerId: string, stagedZip: string): Promise<ImportReport> {
    const id = this.enqueueImport(ownerId, stagedZip, { format: 'zip' });
    return this.runJob(id);
  }
  private async clearStage(id: string): Promise<void> {
    const media = this.store.db
      .prepare('SELECT filename FROM archive_media WHERE pending_job=?')
      .all(id);
    this.store.transaction(() => {
      this.store.db.prepare('DELETE FROM archive_media WHERE pending_job=?').run(id);
      this.store.db.prepare('DELETE FROM archive_stage WHERE job_id=?').run(id);
    });
    for (const file of media) await rm(join(this.mediaDir, String(file.filename)), { force: true });
  }
  async runJob(id: string): Promise<ImportReport> {
    const row = this.store.db.prepare('SELECT * FROM archive_jobs WHERE id=?').get(id) as
      Row | undefined;
    if (!row || row.status !== 'queued') throw new Error('Import job is not queued');
    const claimed = this.store.db
      .prepare(
        `UPDATE archive_jobs SET status='running', updated_at=? WHERE id=? AND status='queued'`,
      )
      .run(Date.now(), id);
    if (!Number(claimed.changes)) throw new Error('Import already claimed');
    const started = Date.now();
    const report = blankReport();
    const extraction = join(this.stagingDir, `extract-${id}`);
    const portableDir = join(this.stagingDir, `portable-${id}`);
    const ownerGuard = this.writeGuard(row.owner_id);
    const check = () => {
      ownerGuard();
      const job = this.store.db
        .prepare('SELECT cancel_requested FROM archive_jobs WHERE id=?')
        .get(id) as Row | undefined;
      if (!job || job.cancel_requested) throw new ArchiveAdmissionError('Import cancelled');
      if (Date.now() - started > this.limits.timeoutMs)
        throw new ArchiveAdmissionError('Import time limit exceeded');
    };
    const warn = (message: string) => {
      if (!report.warnings.includes(message) && report.warnings.length < 50)
        report.warnings.push(message);
    };
    try {
      await this.clearStage(id);
      await rm(extraction, { recursive: true, force: true });
      await rm(portableDir, { recursive: true, force: true });
      check();
      let root = row.input_path;
      if (row.format === 'zip') {
        await extractZip(root, extraction, this.limits, check);
        root = extraction;
      }
      let files = await scanDirectory(root, this.limits, check);
      const portable = await openPortableImport(files, portableDir, this.limits, check);
      const zipParts = [...files.entries()].filter(([name]) => name.toLowerCase().endsWith('.zip'));
      if (!portable && row.format === 'directory' && zipParts.length) {
        if ([...files.keys()].some((name) => name.toLowerCase().endsWith('.json')))
          throw new Error('Choose either extracted folders or a set of ZIP parts, not both.');
        let usedBytes = 0;
        let usedFiles = 0;
        for (const [name, zipPath] of zipParts.sort(([a], [b]) => a.localeCompare(b))) {
          check();
          const partRoot = join(extraction, digest(name).slice(0, 16));
          await extractZip(
            zipPath,
            partRoot,
            {
              ...this.limits,
              maxExpandedBytes: this.limits.maxExpandedBytes - usedBytes,
              maxFiles: this.limits.maxFiles - usedFiles,
            },
            check,
          );
          const partFiles = await scanDirectory(partRoot, this.limits, check);
          usedFiles += partFiles.size;
          for (const file of partFiles.values()) usedBytes += (await lstat(file)).size;
        }
        root = extraction;
        files = await scanDirectory(root, this.limits, check);
      }
      if (portable) {
        files = portable.mediaFiles;
        for (const warning of portable.warnings) warn(warning);
      }
      this.store.db
        .prepare('UPDATE archive_jobs SET total_files=?, completed_files=0 WHERE id=?')
        .run(portable?.files ?? files.size, id);
      const jsons = [...files.keys()].filter((n) => n.toLowerCase().endsWith('.json')).sort();
      if (!portable && !jsons.length)
        throw new Error('No Facebook JSON files found. Download an export in JSON format.');
      const resolveMedia = (uri: string): string | null => {
        if (/^https?:\/\//iu.test(uri)) {
          warn('Remote media URLs were not fetched. Include downloaded media in your export.');
          return null;
        }
        let clean: string;
        try {
          clean = safeRelative(uri);
        } catch {
          warn('Some referenced media paths were invalid and were left unlinked.');
          return null;
        }
        const exact = files.get(clean);
        if (exact) return exact;
        const matches = [...files.entries()].filter(([p]) => p.endsWith(`/${clean}`));
        if (matches.length === 1) return matches[0]![1];
        warn(
          matches.length > 1
            ? 'Some media paths were ambiguous and were left unlinked.'
            : 'Some referenced media files were missing.',
        );
        return null;
      };
      let projectedUsage = this.usage(row.owner_id);
      const initialMediaUsage = this.mediaUsage(row.owner_id);
      const seenRecords = new Map<string, string>();
      const processRecord = async (record: NormalizedRecord): Promise<void> => {
        check();
        if (++report.records > this.limits.maxRecords)
          throw new Error('Archive record limit exceeded');
        if (record.ambiguous)
          warn(
            'Records without provider IDs use source positions. Keep export folder names stable; reshuffled exports may produce separate records.',
          );
        const mediaIds: string[] = [];
        for (const uri of record.mediaPaths) {
          check();
          const path = resolveMedia(uri);
          if (!path) continue;
          try {
            const media = await this.ingestMedia(row.owner_id, path, id);
            mediaIds.push(media.id);
          } catch (e) {
            check();
            if (
              portable ||
              e instanceof ArchiveAdmissionError ||
              (e instanceof Error && 'code' in e)
            )
              throw e;
            report.skipped++;
            warn('Some media could not be validated and was not imported.');
          }
        }
        check();
        const normalized = { ...record, mediaIds: [...new Set(mediaIds)] };
        const hash = digest(
          JSON.stringify({
            body: record.body,
            title: record.title,
            occurredAt: record.occurredAt,
            metadata: record.metadata,
            media: mediaIds.map(
              (mid) =>
                (
                  this.store.db
                    .prepare('SELECT sha256 FROM archive_media WHERE id=?')
                    .get(mid) as Row
                ).sha256,
            ),
          }),
        );
        const duplicate = seenRecords.get(record.sourceKey);
        if (duplicate !== undefined) {
          if (duplicate !== hash)
            throw new Error(
              'Conflicting records share a provider identity; split archives must describe the same export.',
            );
          report.skipped++;
          return;
        }
        seenRecords.set(record.sourceKey, hash);
        const existing = this.store.db
          .prepare('SELECT * FROM archive_items WHERE owner_id=? AND source_key=?')
          .get(row.owner_id, record.sourceKey) as Row | undefined;
        if (existing?.content_hash === hash) {
          report.unchanged++;
          return;
        }
        // Charge the exact eventual revision delta before staging. Unchanged full-quota
        // reimports need no stage row; revised rows also retain their previous history.
        const oldBytes = existing
          ? Buffer.byteLength(existing.body) +
            Buffer.byteLength(existing.title) +
            Buffer.byteLength(existing.metadata)
          : 0;
        const newBytes =
          Buffer.byteLength(record.body) +
          Buffer.byteLength(record.title) +
          Buffer.byteLength(JSON.stringify(record.metadata));
        projectedUsage +=
          newBytes -
          oldBytes +
          (existing ? Buffer.byteLength(JSON.stringify(this.item(existing))) : 0);
        if (
          projectedUsage + this.mediaUsage(row.owner_id) - initialMediaUsage >
          this.limits.ownerBytes
        )
          throw new ArchiveAdmissionError('Account storage allowance exceeded');
        this.store.db
          .prepare('INSERT INTO archive_stage (job_id,source_key,record,hash) VALUES (?,?,?,?)')
          .run(id, record.sourceKey, JSON.stringify(normalized), hash);
      };
      if (portable) {
        for await (const record of portable.records) await processRecord(record);
        report.files = portable.files;
      } else
        for (const name of jsons) {
          check();
          let value: unknown;
          try {
            value = JSON.parse(
              new TextDecoder('utf-8', { fatal: true }).decode(
                await boundedRead(files.get(name)!, this.limits.maxJsonBytes),
              ),
            );
          } catch {
            throw new Error(
              'A JSON file is malformed or is not valid UTF-8. Nothing from this import was published or committed.',
            );
          }
          const records = parseFacebook(value, name);
          if (!records.length) {
            report.skipped++;
            warn(
              'Some JSON categories are unsupported or empty; original export files remain with you.',
            );
          }
          for (const record of records) await processRecord(record);
          report.files++;
          this.store.db
            .prepare('UPDATE archive_jobs SET completed_files=?, updated_at=?, report=? WHERE id=?')
            .run(report.files, Date.now(), JSON.stringify(report), id);
        }
      check();
      this.store.transaction(() => {
        check();
        // Hold one writer transaction while enforcing a running exact byte/count budget.
        // Re-scanning every stored body for each staged row makes a large import quadratic.
        let ownerCount = this.count(row.owner_id);
        let ownerUsage = this.usage(row.owner_id);
        for (const staged of this.store.db
          .prepare('SELECT * FROM archive_stage WHERE job_id=?')
          .iterate(id)) {
          const record = JSON.parse(String(staged.record)) as NormalizedRecord & {
            mediaIds: string[];
          };
          const existing = this.store.db
            .prepare('SELECT * FROM archive_items WHERE owner_id=? AND source_key=?')
            .get(row.owner_id, record.sourceKey) as Row | undefined;
          if (existing?.content_hash === staged.hash) {
            report.unchanged++;
            continue;
          }
          const itemId = existing?.id ?? randomUUID();
          const version = existing ? Number(existing.version) + 1 : 1;
          const metadata = JSON.stringify(record.metadata);
          const history = existing ? JSON.stringify(this.item(existing)) : null;
          const oldBytes = existing
            ? Buffer.byteLength(existing.body) +
              Buffer.byteLength(existing.title) +
              Buffer.byteLength(existing.metadata)
            : 0;
          const newBytes =
            Buffer.byteLength(record.body) +
            Buffer.byteLength(record.title) +
            Buffer.byteLength(metadata);
          const nextUsage =
            ownerUsage - oldBytes + newBytes + (history ? Buffer.byteLength(history) : 0);
          if (nextUsage > this.limits.ownerBytes)
            throw new ArchiveAdmissionError('Account storage allowance exceeded');
          if (!existing && ownerCount >= this.limits.maxRecords)
            throw new Error('Account archive record limit exceeded');
          if (existing) {
            this.store.db
              .prepare(
                'INSERT INTO archive_versions (item_id,owner_id,version,record) VALUES (?,?,?,?)',
              )
              .run(itemId, row.owner_id, existing.version, history!);
            report.revised++;
          } else {
            ownerCount++;
            report.added++;
          }
          ownerUsage = nextUsage;
          this.store.db
            .prepare(
              `INSERT INTO archive_items (id,owner_id,kind,body,title,occurred_at,imported_at,version,source,source_key,content_hash,media_ids,metadata)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,source_key) DO UPDATE SET body=excluded.body,title=excluded.title,occurred_at=excluded.occurred_at,version=excluded.version,content_hash=excluded.content_hash,media_ids=excluded.media_ids,metadata=excluded.metadata`,
            )
            .run(
              itemId,
              row.owner_id,
              record.kind,
              record.body,
              record.title,
              record.occurredAt,
              Date.now(),
              version,
              record.source,
              record.sourceKey,
              staged.hash as string,
              JSON.stringify(record.mediaIds),
              metadata,
            );
        }
        report.media = Number(
          (
            this.store.db
              .prepare('SELECT COUNT(*) AS n FROM archive_media WHERE pending_job=?')
              .get(id) as Row
          ).n,
        );
        this.store.db
          .prepare('UPDATE archive_media SET pending_job=NULL WHERE pending_job=?')
          .run(id);
        this.store.db.prepare('DELETE FROM archive_stage WHERE job_id=?').run(id);
        this.store.db
          .prepare(
            `UPDATE archive_jobs SET status='completed', updated_at=?, report=?, completed_files=total_files WHERE id=?`,
          )
          .run(Date.now(), JSON.stringify(report), id);
      });
      return report;
    } catch (e) {
      const cancelled = e instanceof Error && e.message === 'Import cancelled';
      await this.clearStage(id);
      report.added = 0;
      report.revised = 0;
      report.failed++;
      const systemError =
        e instanceof Error &&
        ('code' in e || /(?:^|\s)(?:[A-Z]:\\|\/)(?:Users|home|var|tmp|data)\//u.test(e.message));
      const error =
        e instanceof SyntaxError
          ? 'An archive record file is malformed. Export it again and retry.'
          : e instanceof Error && !systemError
            ? e.message
            : 'The import could not read its staged files. Please upload the export again.';
      this.store.db
        .prepare('UPDATE archive_jobs SET status=?, error=?, report=?, updated_at=? WHERE id=?')
        .run(
          cancelled ? 'cancelled' : 'failed',
          error.slice(0, 300),
          JSON.stringify(report),
          Date.now(),
          id,
        );
      throw e;
    } finally {
      await rm(extraction, { recursive: true, force: true });
      await rm(portableDir, { recursive: true, force: true });
      // HTTP-created upload stages live here. Never delete an operator-selected external folder.
      await this.discardManagedInput(row.input_path);
    }
  }
  private managedInputRoot(inputPath: string): string | null {
    const incoming = join(this.store.dataDir, 'incoming');
    if (beneath(incoming, inputPath)) {
      const first = relative(incoming, resolve(inputPath)).split(sep)[0]!;
      if (/^upload-[a-zA-Z0-9_-]+$/u.test(first)) return join(incoming, first);
    }
    if (beneath(this.stagingDir, inputPath)) return resolve(inputPath);
    return null;
  }
  private async discardManagedInput(inputPath: string): Promise<void> {
    const managed = this.managedInputRoot(inputPath);
    if (managed) await rm(managed, { recursive: true, force: true });
  }
  private reserveFile(filename: string, jobId: string | null): void {
    this.store.db
      .prepare(
        'INSERT INTO archive_file_writes (filename,pid,job_id,process_birth) VALUES (?,?,?,?)',
      )
      .run(filename, process.pid, jobId, processBirth(process.pid)?.identity ?? null);
  }
  private releaseFile(filename: string): void {
    this.store.db.prepare('DELETE FROM archive_file_writes WHERE filename=?').run(filename);
  }
  private async sweepOrphanFiles(cutoff: number, limit: number): Promise<void> {
    // Retain the directory cursor between bounded passes so large healthy directories
    // cannot permanently hide orphan files beyond the first page.
    const dir = (this.orphanScan ??= await opendir(this.mediaDir));
    let inspected = 0;
    let removed = 0;
    const births = new Map<number, ReturnType<typeof processBirth>>();
    while (inspected++ < 1000 && removed < limit) {
      const entry = await dir.read();
      if (!entry) {
        await dir.close();
        this.orphanScan = undefined;
        break;
      }
      if (!/^[0-9a-f]{8}-[0-9a-f-]{27}\.(?:original|webp)$/u.test(entry.name) || !entry.isFile())
        continue;
      const path = join(this.mediaDir, entry.name);
      const info = await lstat(path).catch(() => null);
      if (!info || info.isSymbolicLink() || info.mtimeMs >= cutoff) continue;
      // Reservations precede asynchronous writes; row checks alone cannot protect a copy in flight.
      const lease = this.store.db
        .prepare('SELECT * FROM archive_file_writes WHERE filename=?')
        .get(entry.name);
      if (lease) {
        let alive = true;
        try {
          process.kill(Number(lease.pid), 0);
        } catch (error) {
          alive = (error as NodeJS.ErrnoException).code !== 'ESRCH';
        }
        if (alive) {
          const pid = Number(lease.pid);
          if (!births.has(pid)) births.set(pid, processBirth(pid));
          const current = births.get(pid);
          if (!current) continue;
          if (lease.process_birth) {
            if (lease.process_birth === current.identity) continue;
          } else {
            // Legacy reservations predate incarnation tracking. Only prove them stale
            // when the output itself predates this process birth (allow clock granularity).
            if (info.mtimeMs >= current.startedAt - 2000) continue;
          }
        }
        this.releaseFile(entry.name);
      }
      if (this.store.db.prepare('SELECT 1 FROM archive_media WHERE filename=?').get(entry.name))
        continue;
      // No await between the final ownership check and unlink.
      rmSync(path, { force: true });
      removed++;
    }
  }
  /** Bounded private staging/preview collection; never expires retained originals. */
  async maintenance(
    options: { now?: number; ttlMs?: number; limit?: number } = {},
  ): Promise<{ stages: number; derivatives: number }> {
    if (this.maintaining) return { stages: 0, derivatives: 0 };
    this.maintaining = true;
    const cutoff =
      (options.now ?? Date.now()) - Math.max(60_000, options.ttlMs ?? 24 * 60 * 60 * 1000);
    const limit = Math.max(1, Math.min(100, options.limit ?? 100));
    let stages = 0;
    let derivatives = 0;
    try {
      for (const base of [join(this.store.dataDir, 'incoming'), this.stagingDir]) {
        let dir: Awaited<ReturnType<typeof opendir>>;
        try {
          dir = await opendir(base);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw e;
        }
        let inspected = 0;
        for await (const entry of dir) {
          if (++inspected > 1000 || stages >= limit) break;
          if (
            !/^(?:upload-|extract-|portable-)[a-zA-Z0-9_-]+$/u.test(entry.name) ||
            entry.isSymbolicLink() ||
            !entry.isDirectory()
          )
            continue;
          const path = join(base, entry.name);
          const info = await lstat(path).catch(() => null);
          if (!info || info.mtimeMs >= cutoff) continue;
          // Recheck durable ownership immediately before removal; a queued upload is still live.
          const live = this.store.db
            .prepare("SELECT id,input_path FROM archive_jobs WHERE status IN ('queued','running')")
            .all();
          if (
            live.some(
              (job) =>
                this.managedInputRoot(String(job.input_path)) === path ||
                path === join(this.stagingDir, `extract-${job.id}`) ||
                path === join(this.stagingDir, `portable-${job.id}`),
            )
          )
            continue;
          await rm(path, { recursive: true, force: true });
          stages++;
        }
      }
      const hasPublications = !!this.store.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='publications'")
        .get();
      const publicationGuard = hasPublications
        ? ' AND NOT EXISTS (SELECT 1 FROM publications p,json_each(p.media_ids) m WHERE p.deleted_at IS NULL AND m.value=archive_media.id)'
        : '';
      const expired = this.store.db
        .prepare(
          `SELECT id,owner_id FROM archive_media WHERE purpose='shared' AND pending_job IS NULL AND created_at<?${publicationGuard} ORDER BY created_at LIMIT ?`,
        )
        .all(cutoff, limit);
      for (const row of expired) {
        // No awaits between the final reference check and removal: publishing cannot interleave.
        if (
          hasPublications &&
          this.store.db
            .prepare(
              'SELECT 1 FROM publications p,json_each(p.media_ids) m WHERE p.deleted_at IS NULL AND m.value=? LIMIT 1',
            )
            .get(row.id as string)
        )
          continue;
        if (this.deleteSharedMedia(String(row.owner_id), String(row.id))) derivatives++;
      }
      await this.sweepOrphanFiles(cutoff, limit);
      return { stages, derivatives };
    } finally {
      this.maintaining = false;
    }
  }
  private schedulePoll(): void {
    if (this.pollTask || this.stoppingWorker) return;
    this.pollTask = this.runNextJob()
      .catch((error) => {
        console.error(
          isDatabaseBusy(error)
            ? 'Import queue deferred while the database is busy.'
            : 'Import queue could not advance; it will retry.',
        );
      })
      .finally(() => {
        this.pollTask = undefined;
      });
  }
  private async finishExitedWorkers(): Promise<void> {
    for (const [id, stopped] of this.pendingExits) {
      this.store.db.prepare('DELETE FROM archive_file_writes WHERE job_id=?').run(id);
      if (stopped) {
        this.store.db
          .prepare(
            `UPDATE archive_jobs SET status='queued',updated_at=? WHERE id=? AND status='running'`,
          )
          .run(Date.now(), id);
        const terminal = this.store.db
          .prepare(
            "SELECT input_path FROM archive_jobs WHERE id=? AND status IN ('completed','failed','cancelled')",
          )
          .get(id) as Row | undefined;
        if (terminal) {
          await this.clearStage(id);
          await rm(join(this.stagingDir, `extract-${id}`), { recursive: true, force: true });
          await rm(join(this.stagingDir, `portable-${id}`), { recursive: true, force: true });
          await this.discardManagedInput(terminal.input_path);
        }
      } else {
        this.store.db
          .prepare(
            `UPDATE archive_jobs SET status='failed',error='The import worker stopped. You can retry the upload.',updated_at=? WHERE id=? AND status IN ('running','queued')`,
          )
          .run(Date.now(), id);
        const abandoned = this.store.db
          .prepare("SELECT input_path FROM archive_jobs WHERE id=? AND status='failed'")
          .get(id) as Row | undefined;
        await this.clearStage(id);
        await rm(join(this.stagingDir, `extract-${id}`), { recursive: true, force: true });
        await rm(join(this.stagingDir, `portable-${id}`), { recursive: true, force: true });
        if (abandoned) await this.discardManagedInput(abandoned.input_path);
      }
      this.pendingExits.delete(id);
    }
  }
  startWorker(): void {
    if (this.timer) return;
    this.stoppingWorker = false;
    this.recoveryNeeded = true;
    this.timer = setInterval(() => this.schedulePoll(), 1000);
    this.timer.unref();
    this.schedulePoll();
  }
  async runNextJob(): Promise<void> {
    if (this.stoppingWorker || this.activeWorker || this.workerStarting || this.workerDone) return;
    this.workerStarting = true;
    try {
      await this.finishExitedWorkers();
      if (this.stoppingWorker) return;
      if (this.recoveryNeeded) {
        this.store.db
          .prepare(`UPDATE archive_jobs SET status='queued' WHERE status='running'`)
          .run();
        this.recoveryNeeded = false;
      }
      const next = this.store.db
        .prepare(`SELECT id FROM archive_jobs WHERE status='queued' ORDER BY created_at LIMIT 1`)
        .get() as Row | undefined;
      if (!next || this.stoppingWorker) return;
      const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
      const worker = new Worker(new URL(`./archive/worker.${extension}`, import.meta.url), {
        workerData: {
          dataDir: this.store.dataDir,
          path: this.store.path,
          jobId: next.id,
          limits: this.limits,
        },
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
        ...(extension === 'ts' ? { execArgv: ['--import', 'tsx'] } : {}),
      });
      this.activeWorker = worker;
      this.workerJobId = String(next.id);
      worker.on('error', () => {
        /* Exit handling records bounded diagnostics without parser details. */
      });
      worker.once('exit', () => {
        this.activeWorker = undefined;
        this.pendingExits.set(String(next.id), this.stoppingWorker);
        this.workerDone = this.finishExitedWorkers()
          .catch((error) => {
            console.error(
              isDatabaseBusy(error)
                ? 'Import cleanup deferred while the database is busy.'
                : 'Import cleanup will retry before the next job.',
            );
          })
          .finally(() => {
            this.workerDone = undefined;
            this.workerJobId = undefined;
          });
      });
    } finally {
      this.workerStarting = false;
    }
  }
  async stopWorker(): Promise<void> {
    if (this.orphanScan && !this.maintaining) {
      await this.orphanScan.close();
      this.orphanScan = undefined;
    }
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.stoppingWorker = true;
    if (this.pollTask) await this.pollTask;
    if (this.activeWorker) await this.activeWorker.terminate();
    if (this.workerDone) await this.workerDone;
    // Fail before the caller closes SQLite if cleanup still cannot finish; no detached DB work remains.
    await this.finishExitedWorkers();
    this.activeWorker = undefined;
    this.workerJobId = undefined;
  }
  exportZip(ownerId: string): Readable {
    if (this.exportsStopped)
      throw new Error('This host is shutting down. Download your export again after it restarts.');
    const zip = new yazl.ZipFile();
    const output = zip.outputStream as Readable;
    const sources = new Set<Readable>();
    const sourceClosures: Promise<void>[] = [];
    let stopped = false;
    let snapshot: DatabaseSync | undefined;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const interrupted = () =>
      new Error(
        'Export interrupted. Wait for imports and other changes to finish, then download it again.',
      );
    const record = {
      cancel: () => {
        if (!stopped) zip.emit('error', interrupted());
      },
      done,
    };
    this.activeExports.add(record);
    const stopSources = () => {
      for (const source of sources) {
        source.unpipe();
        source.destroy();
      }
    };
    zip.on('error', (error) => {
      if (stopped) return;
      stopped = true;
      stopSources();
      output.destroy(error);
    });
    // A cancelled web response may have already removed its error listener.
    // Keep a local handler; the web adapter still receives the same stream error.
    output.on('error', () => {});
    output.once('close', () => {
      if (!stopped && !output.readableEnded) zip.emit('error', interrupted());
      stopped = true;
      stopSources();
      void Promise.all(sourceClosures).then(() => {
        snapshot?.close();
        snapshot = undefined;
        this.activeExports.delete(record);
        finish();
      });
    });
    const track = (source: Readable): Readable => {
      if (stopped) {
        source.destroy();
        return source;
      }
      sources.add(source);
      sourceClosures.push(
        new Promise<void>((resolve) =>
          source.once('close', () => {
            sources.delete(source);
            resolve();
          }),
        ),
      );
      source.on('error', (error) => {
        if (!stopped) zip.emit('error', error);
      });
      return source;
    };
    try {
      const database = new DatabaseSync(this.store.path, { readOnly: true });
      snapshot = database;
      database.exec('BEGIN');
      // Pin one coherent export view on a dedicated read connection, never the writer.
      database.prepare('SELECT COUNT(*) FROM archive_items').get();
      const item = (r: Row) => this.item(r);
      zip.addReadStream(
        track(
          Readable.from(
            (function* () {
              let after = '';
              while (true) {
                const rows = database
                  .prepare(
                    'SELECT * FROM archive_items WHERE owner_id=? AND id>? ORDER BY id LIMIT 500',
                  )
                  .all(ownerId, after);
                if (!rows.length) break;
                for (const row of rows) yield `${JSON.stringify(item(row))}\n`;
                after = String(rows.at(-1)!.id);
              }
            })(),
          ),
        ),
        'archive.ndjson',
      );
      zip.addReadStream(
        track(
          Readable.from(
            (function* () {
              let after = '';
              let version = -1;
              while (true) {
                const rows = database
                  .prepare(
                    'SELECT item_id,version,record FROM archive_versions WHERE owner_id=? AND (item_id>? OR (item_id=? AND version>?)) ORDER BY item_id,version LIMIT 500',
                  )
                  .all(ownerId, after, after, version);
                if (!rows.length) break;
                for (const row of rows) yield `${JSON.stringify(row)}\n`;
                after = String(rows.at(-1)!.item_id);
                version = Number(rows.at(-1)!.version);
              }
            })(),
          ),
        ),
        'revisions.ndjson',
      );
      const manifest: Array<{
        id: string;
        file: string;
        mime: string;
        size: number;
        sha256: string;
        purpose: string;
      }> = [];
      for (const row of database
        .prepare('SELECT * FROM archive_media WHERE owner_id=? AND pending_job IS NULL ORDER BY id')
        .iterate(ownerId)) {
        const media = this.mediaRow(row);
        const filename = `media/${media.id}${media.purpose === 'shared' ? '.webp' : '.original'}`;
        zip.addReadStreamLazy(filename, { size: media.size }, (callback) => {
          if (stopped) {
            callback(interrupted(), Readable.from([]));
            return;
          }
          const source = Readable.from(
            (async function* () {
              const hash = createHash('sha256');
              let size = 0;
              try {
                for await (const chunk of createReadStream(media.path)) {
                  size += chunk.length;
                  hash.update(chunk);
                  yield chunk;
                }
                if (size !== media.size || hash.digest('hex') !== media.sha256)
                  throw new Error('mismatch');
              } catch {
                throw new Error(
                  'Export incomplete: an archived media file is missing or damaged. Restore the matching private media backup and try again.',
                );
              }
            })(),
          );
          callback(null, track(source));
        });
        manifest.push({
          id: media.id,
          file: filename,
          mime: media.mime,
          size: media.size,
          sha256: media.sha256,
          purpose: media.purpose,
        });
      }
      zip.addBuffer(
        Buffer.from(
          JSON.stringify(
            {
              format: 'clean-bookface-archive/1',
              exportedAt: new Date().toISOString(),
              media: manifest,
            },
            null,
            2,
          ),
        ),
        'manifest.json',
      );
      zip.end();
      return output;
    } catch (error) {
      zip.emit('error', error);
      throw error;
    }
  }
  /** Cancel unconsumed downloads and release SQLite iterators before Store.close. */
  async stopExports(): Promise<void> {
    this.exportsStopped = true;
    const pending = [...this.activeExports];
    for (const exportJob of pending) exportJob.cancel();
    await Promise.all(pending.map((exportJob) => exportJob.done));
  }
  deleteSharedMedia(ownerId: string, id: string): boolean {
    const media = this.media(ownerId, id);
    if (!media || media.purpose !== 'shared') return false;
    this.store.db.prepare('DELETE FROM archive_media WHERE id=? AND owner_id=?').run(id, ownerId);
    rmSync(media.path, { force: true });
    return true;
  }
  deleteItem(ownerId: string, id: string): boolean {
    const files: string[] = [];
    const removed = this.store.transaction(() => {
      const item = this.get(ownerId, id);
      if (!item) return false;
      const mediaIds = new Set(item.mediaIds);
      for (const row of this.store.db
        .prepare('SELECT record FROM archive_versions WHERE owner_id=? AND item_id=?')
        .all(ownerId, id)) {
        for (const mid of (JSON.parse(String(row.record)) as ArchiveItem).mediaIds)
          mediaIds.add(mid);
      }
      this.store.db
        .prepare('DELETE FROM archive_versions WHERE owner_id=? AND item_id=?')
        .run(ownerId, id);
      this.store.db.prepare('DELETE FROM archive_items WHERE owner_id=? AND id=?').run(ownerId, id);
      for (const mediaId of mediaIds) {
        const linked = this.store.db
          .prepare(
            `SELECT 1 FROM archive_items i,json_each(i.media_ids) m WHERE i.owner_id=? AND m.value=? UNION ALL SELECT 1 FROM archive_versions v,json_each(json_extract(v.record,'$.mediaIds')) m WHERE v.owner_id=? AND m.value=? LIMIT 1`,
          )
          .get(ownerId, mediaId, ownerId, mediaId);
        if (!linked) {
          const media = this.media(ownerId, mediaId);
          if (media?.purpose === 'original') {
            this.store.db
              .prepare('DELETE FROM archive_media WHERE id=? AND owner_id=?')
              .run(mediaId, ownerId);
            files.push(media.path);
          }
        }
      }
      return true;
    });
    for (const file of files) rmSync(file, { force: true });
    return removed;
  }
  async deleteOwner(ownerId: string): Promise<void> {
    this.ownerGenerations.set(ownerId, (this.ownerGenerations.get(ownerId) ?? 0) + 1);
    const jobs = this.store.db
      .prepare('SELECT id,input_path FROM archive_jobs WHERE owner_id=?')
      .all(ownerId);
    const restartWorker = !!this.timer;
    this.store.db
      .prepare(
        `UPDATE archive_jobs SET cancel_requested=1 WHERE owner_id=? AND status IN ('queued','running')`,
      )
      .run(ownerId);
    try {
      if ((this.activeWorker || this.workerDone) && jobs.some((job) => job.id === this.workerJobId))
        await this.stopWorker();
      const files = this.store.db
        .prepare('SELECT filename FROM archive_media WHERE owner_id=?')
        .all(ownerId);
      for (const row of files) await rm(join(this.mediaDir, String(row.filename)), { force: true });
      for (const row of jobs) {
        await this.discardManagedInput(String(row.input_path));
        await rm(join(this.stagingDir, `extract-${row.id}`), { recursive: true, force: true });
        await rm(join(this.stagingDir, `portable-${row.id}`), { recursive: true, force: true });
      }
      // These rows are the durable purge inventory, including supported legacy
      // filenames and managed input roots. Keep them until every unlink succeeds.
      // A crash or filesystem failure can then retry exact owned paths; force=true
      // tolerates files already removed by an earlier partial attempt.
      this.store.transaction(() => {
        for (const row of jobs)
          this.store.db.prepare('DELETE FROM archive_stage WHERE job_id=?').run(row.id as string);
        for (const table of ['archive_versions', 'archive_items', 'archive_media', 'archive_jobs'])
          this.store.db.prepare(`DELETE FROM ${table} WHERE owner_id=?`).run(ownerId);
      });
    } finally {
      if (restartWorker && !this.timer) this.startWorker();
    }
  }
}
