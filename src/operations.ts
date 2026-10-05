import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto';
import {
  createReadStream,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  lstatSync,
  readlinkSync,
} from 'node:fs';
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { Store } from './storage.js';
import { Archive } from './archive.js';

type Row = Record<string, any>;
export interface BackupOptions {
  repository: string;
  passwordFile: string;
  recoveryPasswordFile: string;
  resticBinary?: string;
}
export interface BackupManifest {
  format: 'clean-bookface-backup/1';
  backupId: string;
  origin: string;
  createdAt: string;
  files: Array<{ path: string; size: number; sha256: string }>;
}
export interface ReconciliationState {
  format: 'clean-bookface-state/2';
  installationId: string;
  likes: Row[];
  friendPreferences: Row[];
  reports: Row[];
  appeals: Row[];
  origin: string;
  capturedAt: string;
  users: Row[];
  archiveIds: string[];
  archiveVersions: Row[];
  mediaIds: string[];
  publications: Row[];
  comments: Row[];
  recipients: Row[];
  friendships: Row[];
  blocks: Row[];
  tombstones: Row[];
  keys: Row[];
  peerBlocks: Row[];
  removals: Row[];
  received: Row[];
  federationReceived: Row[];
}
const hasTable = (db: DatabaseSync, table: string): boolean =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
const rows = (db: DatabaseSync, table: string, columns = '*'): Row[] =>
  hasTable(db, table) ? db.prepare(`SELECT ${columns} FROM ${table}`).all() : [];
const pidNamespace = (): string | null => {
  try {
    return readlinkSync('/proc/self/ns/pid');
  } catch {
    return null;
  }
};
/** Accept only full Docker IDs exposed by the kernel, never a configurable hostname. */
function dockerCgroupIds(cgroup: string): Set<string> {
  const ids = new Set<string>();
  for (const line of cgroup.split('\n')) {
    const path = /^\d+:[^:]*:(\/.*)$/u.exec(line)?.[1];
    if (!path) continue;
    for (const match of path.matchAll(
      /(?:^|\/)(?:docker\/([a-f0-9]{64})|docker-([a-f0-9]{64})\.scope)(?=\/|$)/gu,
    ))
      ids.add(match[1] ?? match[2]!);
  }
  return ids;
}
export function dockerContainerIdFromCgroup(cgroup: string): string | null {
  const ids = dockerCgroupIds(cgroup);
  return ids.size === 1 ? [...ids][0]! : null;
}
/** Docker's kernel-recorded per-container file mounts survive private cgroup namespaces. */
export function dockerContainerIdFromKernel(cgroup: string, mountinfo: string): string | null {
  const ids = dockerCgroupIds(cgroup);
  for (const line of mountinfo.split('\n')) {
    const fields = line.split(' ');
    const separator = fields.indexOf('-');
    if (
      separator < 6 ||
      fields.length < separator + 4 ||
      !/^\d+$/u.test(fields[0] ?? '') ||
      !/^\d+$/u.test(fields[1] ?? '') ||
      !/^\d+:\d+$/u.test(fields[2] ?? '')
    )
      continue;
    const target = /^\/etc\/(hostname|hosts|resolv\.conf)$/u.exec(fields[4] ?? '');
    if (!target) continue;
    const root =
      /^(?:\/[^/]+)*\/docker\/containers\/([a-f0-9]{64})\/(hostname|hosts|resolv\.conf)$/u.exec(
        fields[3] ?? '',
      );
    if (root && root[2] === target[1]) ids.add(root[1]!);
  }
  return ids.size === 1 ? [...ids][0]! : null;
}
function runtimeContainerId(): string | null {
  const readKernel = (path: string): string => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return '';
    }
  };
  return dockerContainerIdFromKernel(
    readKernel('/proc/self/cgroup'),
    readKernel('/proc/self/mountinfo'),
  );
}
async function hashFile(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const part of createReadStream(path)) h.update(part);
  return h.digest('hex');
}

/** Shared by server startup and offline operations. Never steal a stale lock automatically. */
export function acquireInstanceLock(dataDir: string, purpose: string): () => void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, '.instance-lock');
  const token = randomUUID();
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
      throw new Error(
        `Cannot create instance lock (${(error as NodeJS.ErrnoException).code ?? 'filesystem error'}). Check storage permissions and available space.`,
      );
    throw new Error(
      'This data directory is in use. Stop its application before backup/restore. After a crash, use the documented unlock command.',
    );
  }
  try {
    writeFileSync(
      join(path, 'owner.json'),
      JSON.stringify({
        pid: process.pid,
        pidNamespace: pidNamespace(),
        containerId: runtimeContainerId(),
        hostname: hostname(),
        token,
        purpose,
        createdAt: new Date().toISOString(),
      }),
      { mode: 0o600, flag: 'wx' },
    );
  } catch (e) {
    rmSync(path, { recursive: true, force: true });
    throw e;
  }
  return () => {
    try {
      const current = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'));
      if (current.token === token) rmSync(path, { recursive: true });
    } catch {
      /* Another process must never be unlocked. */
    }
  };
}
export function unlockStoppedInstance(
  dataDir: string,
  proof?: { inspectFile: string; lockToken: string },
): void {
  const path = join(dataDir, '.instance-lock');
  const owner = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'));
  const foreign = owner.pidNamespace !== pidNamespace() || owner.hostname !== hostname();
  if (foreign) {
    if (!proof)
      throw new Error(
        'Cannot prove lock ownership from a different host or PID namespace. Keep the service stopped; supply its exact stopped-container inspection and lock token.',
      );
    if (!/^[a-f0-9]{64}$/u.test(owner.containerId ?? ''))
      throw new Error(
        'This lock has no kernel-recorded Docker identity; foreign-container unlock is unsupported. Recover from the original host and PID namespace.',
      );
    const info = lstatSync(proof.inspectFile);
    if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077 || info.size > 1024 * 1024)
      throw new Error('Container inspection must be an owner-only regular file under 1 MiB');
    const records = JSON.parse(readFileSync(proof.inspectFile, 'utf8'));
    const container = Array.isArray(records) && records.length === 1 ? records[0] : null;
    const finished = Date.parse(container?.State?.FinishedAt ?? '');
    const created = Date.parse(owner.createdAt ?? '');
    if (
      !proof.lockToken ||
      proof.lockToken !== owner.token ||
      container?.Id !== owner.containerId ||
      container?.Config?.Hostname !== owner.hostname ||
      !['exited', 'dead'].includes(container?.State?.Status) ||
      container?.State?.Running !== false ||
      container?.State?.Restarting !== false ||
      container?.State?.Paused !== false ||
      container?.State?.Pid !== 0 ||
      !Number.isFinite(finished) ||
      !Number.isFinite(created) ||
      finished < created ||
      finished > Date.now()
    )
      throw new Error(
        'Stopped-container proof does not match this exact lock; keep the service stopped',
      );
  } else {
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1)
      throw new Error('Invalid lock; inspect the stopped installation manually');
    try {
      process.kill(owner.pid, 0);
      throw new Error('The lock owner is still running; stop it first');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
    }
  }
  const latest = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'));
  if (latest.token !== owner.token)
    throw new Error('Lock ownership changed; retry after checking the service');
  rmSync(path, { recursive: true });
}
function secret(path: string): Buffer {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077 || info.size > 4096)
    throw new Error('Secret files must be regular owner-only files (mode 600), under 4 KiB');
  const value = readFileSync(path).toString('utf8').trim();
  if (value.length < 20)
    throw new Error('Use an independently generated recovery secret of at least 20 characters');
  return Buffer.from(value);
}
function encrypt(value: unknown, password: Buffer, format = 'clean-bookface-recovery/1'): Buffer {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(format));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  key.fill(0);
  return Buffer.from(
    JSON.stringify({
      format,
      salt: salt.toString('base64'),
      nonce: nonce.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    }),
  );
}
function decrypt(bytes: Buffer, password: Buffer, format = 'clean-bookface-recovery/1'): any {
  try {
    if (bytes.length > 128 * 1024 * 1024) throw new Error();
    const env = JSON.parse(bytes.toString('utf8'));
    if (env.format !== format) throw new Error();
    const salt = Buffer.from(env.salt, 'base64');
    const nonce = Buffer.from(env.nonce, 'base64');
    const tag = Buffer.from(env.tag, 'base64');
    if (salt.length !== 16 || nonce.length !== 12 || tag.length !== 16) throw new Error();
    const key = scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(Buffer.from(format));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(env.ciphertext, 'base64')),
      decipher.final(),
    ]);
    key.fill(0);
    return JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new Error(
      'Recovery bundle could not be authenticated. Check its separate recovery password.',
    );
  }
}
function validateOrigin(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value)
    throw new Error('A canonical APP_ORIGIN is required');
  return value;
}
function captureState(store: Store, origin: string): ReconciliationState {
  return store.transaction(() => {
    if (!store.setting('installation_id')) store.setSetting('installation_id', randomUUID());
    return {
      installationId: store.setting('installation_id')!,
      likes: rows(store.db, 'likes'),
      friendPreferences: rows(store.db, 'friend_preferences'),
      reports: rows(store.db, 'reports'),
      appeals: rows(store.db, 'appeals'),
      format: 'clean-bookface-state/2',
      origin,
      capturedAt: new Date().toISOString(),
      users: rows(
        store.db,
        'users',
        'id,password_hash,deleted,suspended,admin,display_name,bio,discoverable,quiet_notifications,compact_feed',
      ),
      archiveIds: rows(store.db, 'archive_items', 'id').map((r) => r.id),
      archiveVersions: rows(store.db, 'archive_items', 'id,version'),
      mediaIds: rows(store.db, 'archive_media', 'id').map((r) => r.id),
      publications: rows(store.db, 'publications', 'id,author_actor,deleted_at,revision'),
      comments: rows(store.db, 'comments', 'id,actor,post_id'),
      recipients: rows(store.db, 'recipients'),
      friendships: rows(store.db, 'friendships'),
      blocks: rows(store.db, 'blocks'),
      tombstones: rows(store.db, 'tombstones'),
      keys: rows(store.db, 'federation_keys'),
      peerBlocks: rows(store.db, 'federation_blocked_hosts'),
      received: rows(store.db, 'received_events'),
      federationReceived: rows(store.db, 'federation_received'),
      removals: rows(store.db, 'domain_events').filter(
        (e) =>
          !e.acknowledged_at &&
          !e.cancelled_at &&
          [
            'post.delete',
            'post.revoke',
            'friend.remove',
            'friend.close',
            'comment.delete',
            'like.remove',
          ].includes(e.kind),
      ),
    };
  });
}
export async function exportReconciliation(
  dataDir: string,
  recoveryPasswordFile: string,
  output: string,
): Promise<void> {
  const release = acquireInstanceLock(dataDir, 'reconciliation export');
  const store = new Store(dataDir);
  try {
    const origin = store.setting('origin');
    if (!origin) throw new Error('This installation has no canonical origin');
    if (store.setting('restore_reconciliation_required') === 'true')
      throw new Error('A paused restore cannot export a current-state ledger');
    await writeFile(
      output,
      encrypt(captureState(store, origin), secret(recoveryPasswordFile), 'clean-bookface-ledger/2'),
      {
        mode: 0o600,
        flag: 'wx',
      },
    );
  } finally {
    store.close();
    release();
  }
}
async function restic(args: string[], options: BackupOptions, cwd: string): Promise<string> {
  return new Promise((accept, reject) => {
    const child = spawn(options.resticBinary ?? 'restic', ['--json', ...args], {
      cwd,
      env: {
        ...process.env,
        RESTIC_REPOSITORY: /^(?:[a-z][a-z0-9+.-]*:)/iu.test(options.repository)
          ? options.repository.startsWith('local:')
            ? `local:${resolve(options.repository.slice(6))}`
            : options.repository
          : resolve(options.repository),
        RESTIC_PASSWORD_FILE: resolve(options.passwordFile),
        RESTIC_PASSWORD: undefined,
        RESTIC_PASSWORD_COMMAND: undefined,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let length = 0;
    let failed = false;
    child.stdout.on('data', (b: Buffer) => {
      length += b.length;
      if (length > 8 * 1024 ** 2) {
        failed = true;
        child.kill();
      } else output += b.toString('utf8');
    });
    child.stderr.on('data', () => {
      /* Do not print repository credentials or private filenames. */
    });
    const timeout = setTimeout(
      () => {
        failed = true;
        child.kill();
      },
      12 * 60 * 60 * 1000,
    );
    timeout.unref();
    child.on('error', () => {
      clearTimeout(timeout);
      reject(
        new Error('Could not run restic. Install the documented version or set RESTIC_BINARY.'),
      );
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      code === 0 && !failed
        ? accept(output)
        : reject(
            new Error(
              `Restic ${args[0]} failed (${code ?? 'terminated'}). ${code === 10 ? 'Repository does not exist; verify RESTIC_REPOSITORY and initialize it.' : code === 11 ? 'Repository is locked; verify no backup or restore is running before using restic unlock.' : code === 12 ? 'Repository password is incorrect; verify the owner-only password file.' : 'Check repository access, storage and the configured restic executable.'} No backup success was recorded.`,
            ),
          );
    });
  });
}
export async function initializeBackup(options: BackupOptions, cwd: string): Promise<void> {
  if (secret(options.passwordFile).equals(secret(options.recoveryPasswordFile)))
    throw new Error('Restic and recovery passwords must be independent');
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  await restic(['init'], options, cwd);
}
export async function createBackup(
  dataDir: string,
  origin: string,
  options: BackupOptions,
): Promise<{ snapshotId: string; backupId: string }> {
  validateOrigin(origin);
  if (secret(options.passwordFile).equals(secret(options.recoveryPasswordFile)))
    throw new Error('Use independent backup and recovery secrets');
  const release = acquireInstanceLock(dataDir, 'backup');
  const store = new Store(dataDir);
  const stage = join(dataDir, '.backup-staging');
  const payload = join(stage, 'payload');
  try {
    if (store.setting('origin') !== origin)
      throw new Error('Backup origin must match the existing installation');
    await rm(stage, { recursive: true, force: true });
    await mkdir(join(payload, 'media'), { recursive: true, mode: 0o700 });
    const backupId = randomUUID();
    const state = captureState(store, origin);
    await sqliteBackup(store.db, join(payload, 'bookface.sqlite'));
    await chmod(join(payload, 'bookface.sqlite'), 0o600);
    const snapshot = new DatabaseSync(join(payload, 'bookface.sqlite'));
    const committedMedia = hasTable(snapshot, 'archive_media')
      ? snapshot
          .prepare('SELECT filename,sha256,size FROM archive_media WHERE pending_job IS NULL')
          .all()
      : [];
    try {
      snapshot.exec('PRAGMA secure_delete=ON;');
      if (hasTable(snapshot, 'federation_keys')) snapshot.exec('DELETE FROM federation_keys');
      if (hasTable(snapshot, 'users'))
        snapshot.exec("UPDATE users SET password_hash='restored-credentials-required'");
      for (const table of [
        'chunk_upload_parts',
        'chunk_upload_files',
        'chunk_uploads',
        'sessions',
        'recovery_codes',
        'invitations',
        'archive_stage',
        'notification_records',
      ])
        if (hasTable(snapshot, table)) snapshot.exec(`DELETE FROM ${table}`);
      if (hasTable(snapshot, 'archive_media'))
        snapshot.exec('DELETE FROM archive_media WHERE pending_job IS NOT NULL');
      if (hasTable(snapshot, 'archive_jobs'))
        snapshot.exec(
          "UPDATE archive_jobs SET status='failed',input_path='',error='Upload again after restoring this backup' WHERE status IN ('queued','running')",
        );
      snapshot.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
    } finally {
      snapshot.close();
    }
    for (const row of committedMedia) {
      const name = String(row.filename);
      if (!safeMediaName(name)) throw new Error('Invalid stored media filename');
      const source = join(dataDir, 'media', name);
      const target = join(payload, 'media', name);
      const info = await lstat(source);
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error('A referenced media file is missing or unsafe');
      try {
        await link(source, target);
      } catch {
        await copyFile(source, target);
      }
      if (info.size !== row.size || (await hashFile(target)) !== row.sha256)
        throw new Error('Media integrity check failed; backup refused');
    }
    await writeFile(
      join(payload, 'recovery.enc'),
      encrypt({ backupId, ...state }, secret(options.recoveryPasswordFile)),
      { mode: 0o600 },
    );
    const paths = [
      'bookface.sqlite',
      'recovery.enc',
      ...committedMedia.map((r) => `media/${r.filename}`),
    ];
    const files: BackupManifest['files'] = [];
    for (const path of paths)
      files.push({
        path,
        size: (await lstat(join(payload, path))).size,
        sha256: await hashFile(join(payload, path)),
      });
    const manifest: BackupManifest = {
      format: 'clean-bookface-backup/1',
      backupId,
      origin,
      createdAt: state.capturedAt,
      files,
    };
    await writeFile(join(payload, 'manifest.json'), JSON.stringify(manifest, null, 2), {
      mode: 0o600,
    });
    const response = await restic(
      ['backup', '--host', 'clean-bookface', '--tag', 'clean-bookface-v1', 'payload'],
      options,
      stage,
    );
    const summary = response
      .trim()
      .split('\n')
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return {};
        }
      })
      .find((row) => row.message_type === 'summary');
    if (!summary?.snapshot_id) throw new Error('Restic did not return a completed snapshot');
    await restic(['check'], options, stage);
    store.setSetting('last_backup_at', new Date().toISOString());
    store.setSetting('last_backup_snapshot', summary.snapshot_id);
    return { snapshotId: summary.snapshot_id, backupId };
  } finally {
    store.close();
    await rm(stage, { recursive: true, force: true });
    release();
  }
}
function safeMediaName(name: string): boolean {
  return /^[a-zA-Z0-9_.-]+$/u.test(name) && basename(name) === name && !name.includes('..');
}
async function verifyPayload(payload: string, origin: string): Promise<BackupManifest> {
  for (const dir of [payload, join(payload, 'media')]) {
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe backup directory');
  }
  const top = await readdir(payload);
  if (
    top.some(
      (name) => !['manifest.json', 'bookface.sqlite', 'recovery.enc', 'media'].includes(name),
    )
  )
    throw new Error('Unexpected backup files');
  const manifest = JSON.parse(
    await readFile(join(payload, 'manifest.json'), 'utf8'),
  ) as BackupManifest;
  if (
    manifest.format !== 'clean-bookface-backup/1' ||
    manifest.origin !== origin ||
    !Number.isFinite(Date.parse(manifest.createdAt)) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length > 200000
  )
    throw new Error('Backup format or canonical origin does not match');
  const seen = new Set<string>();
  for (const item of manifest.files) {
    if (
      !(
        item.path === 'bookface.sqlite' ||
        item.path === 'recovery.enc' ||
        (item.path.startsWith('media/') && safeMediaName(item.path.slice(6)))
      ) ||
      item.path.includes('..') ||
      seen.has(item.path)
    )
      throw new Error('Unsafe backup manifest');
    seen.add(item.path);
    const info = await lstat(join(payload, item.path));
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size !== item.size ||
      (await hashFile(join(payload, item.path))) !== item.sha256
    )
      throw new Error('Backup integrity check failed');
  }
  for (const name of await readdir(join(payload, 'media')))
    if (!seen.has(`media/${name}`)) throw new Error('Unmanifested backup media');
  if (!seen.has('bookface.sqlite') || !seen.has('recovery.enc'))
    throw new Error('Backup is incomplete');
  return manifest;
}
export async function restoreBackup(
  targetDir: string,
  origin: string,
  snapshotId: string,
  options: BackupOptions,
): Promise<BackupManifest> {
  validateOrigin(origin);
  secret(options.passwordFile);
  if (!/^(?:latest|[a-f0-9]{8,64})$/u.test(snapshotId))
    throw new Error('Choose an exact restic snapshot ID or latest');
  const target = resolve(targetDir);
  await mkdir(target, { recursive: true, mode: 0o700 });
  const targetInfo = await lstat(target);
  if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink())
    throw new Error('Restore target must be an empty real directory');
  if ((await readdir(target)).length)
    throw new Error(
      'Restore requires an empty target directory; existing data is never overwritten',
    );
  const release = acquireInstanceLock(target, 'restore');
  let scratch: string | undefined;
  let installed = false;
  try {
    // A fresh named volume can be writable while its parent/container root is read-only.
    // Stage inside that volume, under the installation lock, so moves stay on one filesystem.
    scratch = await mkdtemp(join(target, '.bookface-restore-'));
    await restic(
      ['restore', snapshotId, '--tag', 'clean-bookface-v1', '--target', scratch],
      options,
      scratch,
    );
    const payload = join(scratch, 'payload');
    const manifest = await verifyPayload(payload, origin);
    const recovery = decrypt(
      await readFile(join(payload, 'recovery.enc')),
      secret(options.recoveryPasswordFile),
    );
    if (
      recovery.backupId !== manifest.backupId ||
      recovery.origin !== origin ||
      !['clean-bookface-state/1', 'clean-bookface-state/2'].includes(recovery.format)
    )
      throw new Error('Recovery bundle does not belong to this backup');
    const db = new DatabaseSync(join(payload, 'bookface.sqlite'));
    try {
      if (
        db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' ||
        db.prepare('PRAGMA foreign_key_check').all().length
      )
        throw new Error('Database integrity check failed');
      if (
        db.prepare("SELECT value FROM instance_settings WHERE key='origin'").get()?.value !== origin
      )
        throw new Error('Database canonical origin does not match');
      if (
        recovery.format === 'clean-bookface-state/2' &&
        (!recovery.installationId ||
          db.prepare("SELECT value FROM instance_settings WHERE key='installation_id'").get()
            ?.value !== recovery.installationId)
      )
        throw new Error('Backup installation identity does not match');
      db.exec('BEGIN IMMEDIATE');
      // Upload payloads are intentionally absent from backups, including older ones.
      for (const table of ['chunk_upload_parts', 'chunk_upload_files', 'chunk_uploads'])
        if (hasTable(db, table)) db.exec(`DELETE FROM ${table}`);
      for (const user of recovery.users)
        db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(user.password_hash, user.id);
      if (hasTable(db, 'federation_keys'))
        for (const key of recovery.keys)
          db.prepare(
            'INSERT OR REPLACE INTO federation_keys(actor,private_jwk,public_jwk) VALUES(?,?,?)',
          ).run(key.actor, key.private_jwk, key.public_jwk);
      db.prepare(
        "INSERT INTO instance_settings(key,value) VALUES('restore_reconciliation_required','true') ON CONFLICT(key) DO UPDATE SET value='true'",
      ).run();
      db.prepare(
        "INSERT INTO instance_settings(key,value) VALUES('restored_backup_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run(manifest.createdAt);
      db.prepare(
        "INSERT INTO instance_settings(key,value) VALUES('last_backup_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run(manifest.createdAt);
      db.prepare(
        "INSERT INTO instance_settings(key,value) VALUES('last_backup_snapshot',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run(snapshotId === 'latest' ? '' : snapshotId);
      db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE);');
    } finally {
      db.close();
    }
    await copyFile(join(payload, 'bookface.sqlite'), join(target, 'bookface.sqlite'));
    await chmod(join(target, 'bookface.sqlite'), 0o600);
    await rename(join(payload, 'media'), join(target, 'media'));
    await writeFile(join(target, '.restored-manifest.json'), JSON.stringify(manifest, null, 2), {
      mode: 0o600,
    });
    installed = true;
    return manifest;
  } finally {
    try {
      if (!installed)
        for (const name of await readdir(target))
          if (name !== '.instance-lock')
            await rm(join(target, name), { recursive: true, force: true });
      if (scratch) await rm(scratch, { recursive: true, force: true });
    } finally {
      release();
    }
  }
}
/** Ledger must come from current source state; there is deliberately no unconditional unlock. */
export async function reconcileRestore(
  dataDir: string,
  origin: string,
  ledgerFile: string,
  recoveryPasswordFile: string,
): Promise<void> {
  const release = acquireInstanceLock(dataDir, 'restore reconciliation');
  const store = new Store(dataDir);
  try {
    if (store.setting('restore_reconciliation_required') !== 'true')
      throw new Error('This installation is not awaiting reconciliation');
    const ledgerBytes = await readFile(ledgerFile);
    if (JSON.parse(ledgerBytes.toString('utf8')).format !== 'clean-bookface-ledger/2')
      throw new Error(
        'Incompatible ledger: export a current ledger/2 from the original installation; backup recovery bundles and legacy ledgers cannot unlock a restore',
      );
    const state = decrypt(
      ledgerBytes,
      secret(recoveryPasswordFile),
      'clean-bookface-ledger/2',
    ) as ReconciliationState;
    const captured = Date.parse(state.capturedAt);
    const backupAt = Date.parse(store.setting('restored_backup_at') ?? '');
    if (
      state.format !== 'clean-bookface-state/2' ||
      'backupId' in state ||
      !state.installationId ||
      state.installationId !== store.setting('installation_id') ||
      !Number.isFinite(backupAt) ||
      state.origin !== origin ||
      store.setting('origin') !== origin ||
      !Number.isFinite(captured) ||
      captured <= backupAt ||
      captured > Date.now() + 300000
    )
      throw new Error(
        'Reconciliation state is stale or belongs to another origin or installation; legacy backups without identity remain paused',
      );
    const archive = new Archive(store);
    const activeUsers = new Map(state.users.filter((u) => !u.deleted).map((u) => [u.id, u]));
    const keepArchive = new Set(state.archiveIds);
    const currentArchive = new Map(state.archiveVersions.map((a) => [a.id, a.version]));
    const keepMedia = new Set(state.mediaIds);
    const currentPosts = new Map(state.publications.map((p) => [p.id, p]));
    const now = Date.now();
    for (const user of rows(store.db, 'users'))
      if (!activeUsers.has(user.id)) {
        await archive.deleteOwner(user.id);
        store.db
          .prepare(
            "UPDATE users SET deleted=1,suspended=1,admin=0,password_hash='',display_name='Deleted account',bio='',discoverable=0 WHERE id=?",
          )
          .run(user.id);
        for (const table of ['appeals', 'friend_preferences'])
          if (hasTable(store.db, table))
            store.db
              .prepare(
                `DELETE FROM ${table} WHERE ${table === 'appeals' ? 'user_id' : 'owner_id'}=?`,
              )
              .run(user.id);
        if (hasTable(store.db, 'account_deletions'))
          store.db
            .prepare(
              'INSERT INTO account_deletions(user_id,created_at,archive_completed_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET archive_completed_at=excluded.archive_completed_at',
            )
            .run(user.id, Date.now(), Date.now());
        if (hasTable(store.db, 'reports'))
          store.db
            .prepare(
              "UPDATE reports SET reason='',evidence='',state='deleted' WHERE reporter_id=? OR target_actor=?",
            )
            .run(user.id, `${origin}/users/${user.username}`);
      }
    for (const item of rows(store.db, 'archive_items', 'id,owner_id,version'))
      if (!keepArchive.has(item.id) || currentArchive.get(item.id) !== item.version)
        archive.deleteItem(item.owner_id, item.id);
    for (const medium of rows(store.db, 'archive_media'))
      if (!keepMedia.has(medium.id)) {
        if (!safeMediaName(medium.filename)) throw new Error('Invalid stored media filename');
        await rm(join(dataDir, 'media', medium.filename), { force: true });
        store.db.prepare('DELETE FROM archive_media WHERE id=?').run(medium.id);
      }
    store.transaction(() => {
      for (const user of activeUsers.values())
        store.db
          .prepare(
            'UPDATE users SET password_hash=?,suspended=?,admin=?,display_name=?,bio=?,discoverable=?,quiet_notifications=?,compact_feed=? WHERE id=?',
          )
          .run(
            user.password_hash,
            user.suspended,
            user.admin,
            user.display_name,
            user.bio,
            user.discoverable,
            user.quiet_notifications,
            user.compact_feed,
            user.id,
          );
      for (const p of rows(store.db, 'publications')) {
        const current = currentPosts.get(p.id);
        if (
          !current ||
          current.deleted_at ||
          current.revision !== p.revision ||
          (p.author_id && !activeUsers.has(p.author_id))
        ) {
          store.db
            .prepare(
              "UPDATE publications SET body='',media_ids='[]',archive_source_id=NULL,deleted_at=?,revision=revision+1 WHERE id=?",
            )
            .run(now, p.id);
          store.db.prepare('DELETE FROM comments WHERE post_id=?').run(p.id);
          store.db.prepare('DELETE FROM likes WHERE post_id=?').run(p.id);
          store.db
            .prepare(
              "INSERT OR IGNORE INTO tombstones(object_id,actor,kind,created_at) VALUES(?,?,'post',?)",
            )
            .run(p.id, p.author_actor, now);
        }
      }
      const likes = new Set(
        state.likes.map((like) => JSON.stringify([like.post_id, like.actor, like.activity_id])),
      );
      for (const like of rows(store.db, 'likes'))
        if (!likes.has(JSON.stringify([like.post_id, like.actor, like.activity_id])))
          store.db
            .prepare('DELETE FROM likes WHERE post_id=? AND actor=?')
            .run(like.post_id, like.actor);
      for (const [table, values, owner] of [
        ['friend_preferences', state.friendPreferences, 'owner_id'],
        ['reports', state.reports, 'reporter_id'],
        ['appeals', state.appeals, 'user_id'],
      ] as const) {
        if (!hasTable(store.db, table)) continue;
        store.db.exec(`DELETE FROM ${table}`);
        const columns = store.db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((c) => String(c.name));
        const insert = store.db.prepare(
          `INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
        );
        for (const row of values)
          if (
            activeUsers.has(row[owner]) &&
            store.db.prepare('SELECT 1 FROM users WHERE id=?').get(row[owner])
          )
            insert.run(...columns.map((column) => row[column]));
      }
      const comments = new Set(state.comments.map((c) => c.id));
      for (const comment of rows(store.db, 'comments'))
        if (!comments.has(comment.id))
          store.db.prepare('DELETE FROM comments WHERE id=?').run(comment.id);
      const friends = new Map(state.friendships.map((f) => [f.id, f]));
      for (const friend of rows(store.db, 'friendships'))
        store.db
          .prepare('UPDATE friendships SET state=?,updated_at=? WHERE id=?')
          .run(friends.get(friend.id)?.state ?? 'cancelled', now, friend.id);
      const recipients = new Map(state.recipients.map((r) => [`${r.post_id}\0${r.actor}`, r]));
      for (const r of rows(store.db, 'recipients')) {
        const current = recipients.get(`${r.post_id}\0${r.actor}`);
        if (!current || current.revoked_at)
          store.db
            .prepare('UPDATE recipients SET revoked_at=? WHERE post_id=? AND actor=?')
            .run(now, r.post_id, r.actor);
      }
      for (const b of state.blocks)
        store.db
          .prepare(
            'INSERT OR IGNORE INTO blocks(owner_actor,target_actor,created_at) VALUES(?,?,?)',
          )
          .run(b.owner_actor, b.target_actor, b.created_at);
      for (const t of state.tombstones)
        store.db
          .prepare(
            'INSERT OR IGNORE INTO tombstones(object_id,actor,kind,created_at) VALUES(?,?,?,?)',
          )
          .run(t.object_id, t.actor, t.kind, t.created_at);
      for (const table of [
        'chunk_upload_parts',
        'chunk_upload_files',
        'chunk_uploads',
        'sessions',
        'invitations',
        'recovery_codes',
        'notification_records',
      ])
        if (hasTable(store.db, table)) store.db.exec(`DELETE FROM ${table}`);
      if (hasTable(store.db, 'federation_keys')) {
        store.db.exec('DELETE FROM federation_keys');
        for (const key of state.keys)
          store.db
            .prepare('INSERT INTO federation_keys(actor,private_jwk,public_jwk) VALUES(?,?,?)')
            .run(key.actor, key.private_jwk, key.public_jwk);
      }
      if (hasTable(store.db, 'domain_events'))
        store.db
          .prepare(
            "UPDATE domain_events SET payload='{}',cancelled_at=? WHERE acknowledged_at IS NULL",
          )
          .run(now);
      if (hasTable(store.db, 'federation_deliveries'))
        store.db.exec("UPDATE federation_deliveries SET state='cancelled',lease_until=0");
      if (hasTable(store.db, 'federation_blocked_hosts'))
        for (const block of state.peerBlocks)
          store.db
            .prepare('INSERT OR IGNORE INTO federation_blocked_hosts(host,blocked_at) VALUES(?,?)')
            .run(block.host, block.blocked_at);
      for (const event of state.received)
        store.db
          .prepare('INSERT OR IGNORE INTO received_events(id,actor,created_at) VALUES(?,?,?)')
          .run(event.id, event.actor, event.created_at);
      if (hasTable(store.db, 'federation_received'))
        for (const event of state.federationReceived)
          store.db
            .prepare(
              'INSERT OR IGNORE INTO federation_received(activity_id,recipient,actor,body_hash,received_at) VALUES(?,?,?,?,?)',
            )
            .run(
              event.activity_id,
              event.recipient,
              event.actor,
              event.body_hash,
              event.received_at,
            );
      for (const event of state.removals) {
        if (
          ![
            'post.delete',
            'post.revoke',
            'friend.remove',
            'friend.close',
            'comment.delete',
            'like.remove',
          ].includes(event.kind)
        )
          throw new Error('Unexpected removal event');
        store.db
          .prepare(
            `INSERT INTO domain_events(id,kind,actor,recipient_actor,object_id,revision,payload,created_at,acknowledged_at,cancelled_at) VALUES(?,?,?,?,?,?,?,?,NULL,NULL) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,acknowledged_at=NULL,cancelled_at=NULL`,
          )
          .run(
            event.id,
            event.kind,
            event.actor,
            event.recipient_actor,
            event.object_id,
            event.revision,
            event.payload,
            event.created_at,
          );
        if (hasTable(store.db, 'federation_deliveries'))
          store.db.prepare('DELETE FROM federation_deliveries WHERE event_id=?').run(event.id);
      }
      if (hasTable(store.db, 'federation_scan'))
        store.db.exec("UPDATE federation_scan SET cursor=''");
      store.setSetting('restore_reconciled_at', new Date().toISOString());
      store.setSetting('restore_reconciliation_required', 'false');
    });
    await rm(join(dataDir, '.restored-reconciliation.enc'), { force: true });
  } finally {
    store.close();
    release();
  }
}
