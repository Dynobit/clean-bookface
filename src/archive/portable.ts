import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { ArchiveLimits, NormalizedRecord, ArchiveKind } from './types.js';
import { boundedRead, extractZip, safeRelative, scanDirectory } from './input.js';
import { digest, timestamp, validateStructure } from './parser.js';

type Row = Record<string, unknown>;
export interface PortableImport {
  records: AsyncIterable<NormalizedRecord>;
  mediaFiles: Map<string, string>;
  files: number;
  warnings: string[];
}
const obj = (value: unknown): Row => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid portable record');
  return value as Row;
};
function text(value: unknown, limit = 2048, empty = false): string {
  if (typeof value !== 'string' || value.length > limit || (!empty && !value))
    throw new Error('Invalid portable text field');
  return value;
}
function identity(value: unknown): string {
  const id = text(value, 200);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid portable identity');
  return id;
}
function ms(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const result = timestamp(value, true);
  if (result === null) throw new Error('Invalid portable date');
  return result;
}
function parsePortable(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('Portable record file is malformed. Export it again and retry.');
  }
}
async function json(path: string, limit: number): Promise<unknown> {
  const value = parsePortable(
    new TextDecoder('utf-8', { fatal: true }).decode(await boundedRead(path, limit)),
  ) as unknown;
  validateStructure(value);
  return value;
}
async function* ndjson(
  path: string,
  limits: ArchiveLimits,
  check: () => void,
): AsyncGenerator<unknown> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let bytes = 0;
  for await (const part of createReadStream(path)) {
    check();
    bytes += (part as Buffer).length;
    if (bytes > limits.maxFileBytes) throw new Error('Portable record file size limit exceeded');
    buffer += decoder.decode(part as Buffer, { stream: true });
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > limits.maxJsonBytes)
        throw new Error('Portable record size limit exceeded');
      const value: unknown = parsePortable(line);
      validateStructure(value);
      yield value;
    }
    if (Buffer.byteLength(buffer) > limits.maxJsonBytes)
      throw new Error('Portable record size limit exceeded');
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    const value: unknown = parsePortable(buffer);
    validateStructure(value);
    yield value;
  }
}
async function checksum(path: string, check: () => void) {
  const h = createHash('sha256');
  for await (const part of createReadStream(path)) {
    check();
    h.update(part);
  }
  return h.digest('hex');
}
// Auth material is never replayed into the new installation or retained as
// structured archive metadata. Ordinary prose is preserved literally.
function privateMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(privateMetadata);
  if (!value || typeof value !== 'object') return value;
  const result: Row = Object.create(null);
  for (const [key, v] of Object.entries(value)) {
    if (
      /^(?:password(?:_hash)?|private[_-]?key|private[_-]?jwk|public[_-]?jwk|signing[_-]?key|session(?:s)?|session[_-]?token|csrf|recovery[_-]?(?:codes?|keys?)|access[_-]?token|refresh[_-]?token|authorization|cookie|credentials)$/i.test(
        key,
      )
    )
      continue;
    result[key] = privateMetadata(v);
  }
  return result;
}
async function totalBytes(files: Map<string, string>): Promise<number> {
  let total = 0;
  for (const path of files.values()) total += (await lstat(path)).size;
  return total;
}
function withPrefix(files: Map<string, string>, marker: string): Map<string, string> {
  const prefix = marker.slice(0, marker.lastIndexOf('/') + 1);
  const relative = new Map<string, string>();
  for (const [name, path] of files) {
    if (!name.startsWith(prefix))
      throw new Error('Portable export contains files outside its root');
    relative.set(name.slice(prefix.length), path);
  }
  return relative;
}

/** Recognizes only our two declared formats. One explicitly named nested ZIP is
 * permitted; its expanded bytes and files share the outer archive's budget. */
export async function openPortableImport(
  inputFiles: Map<string, string>,
  workDir: string,
  limits: ArchiveLimits,
  check: () => void,
): Promise<PortableImport | null> {
  check();
  let files = inputFiles;
  let account: Row | undefined;
  let outerBytes = 0;
  let outerFiles = 0;
  const accounts = [...inputFiles.keys()].filter(
    (name) => name === 'account.json' || name.endsWith('/account.json'),
  );
  if (accounts.length === 1) {
    const candidate = await json(inputFiles.get(accounts[0]!)!, limits.maxJsonBytes);
    if (
      candidate &&
      typeof candidate === 'object' &&
      !Array.isArray(candidate) &&
      (candidate as Row).format === 'clean-bookface-account/1'
    ) {
      account = candidate as Row;
      const outer = withPrefix(inputFiles, accounts[0]!);
      if (outer.size !== 2 || !outer.has('private-archive.zip'))
        throw new Error('Portable account export requires account.json and private-archive.zip');
      outerBytes = await totalBytes(outer);
      outerFiles = outer.size;
      if (outerBytes >= limits.maxExpandedBytes || outerFiles >= limits.maxFiles)
        throw new Error('Portable expansion budget exceeded');
      await extractZip(
        outer.get('private-archive.zip')!,
        workDir,
        {
          ...limits,
          maxExpandedBytes: limits.maxExpandedBytes - outerBytes,
          maxFiles: limits.maxFiles - outerFiles,
        },
        check,
      );
      files = await scanDirectory(
        workDir,
        {
          ...limits,
          maxExpandedBytes: limits.maxExpandedBytes - outerBytes,
          maxFiles: limits.maxFiles - outerFiles,
        },
        check,
      );
    }
  }
  const markers = [...files.keys()].filter(
    (name) => name === 'manifest.json' || name.endsWith('/manifest.json'),
  );
  if (markers.length !== 1) {
    if (account) throw new Error('Portable archive manifest is missing or ambiguous');
    return null;
  }
  const candidateManifest = await json(files.get(markers[0]!)!, limits.maxJsonBytes);
  if (
    !candidateManifest ||
    typeof candidateManifest !== 'object' ||
    Array.isArray(candidateManifest) ||
    (candidateManifest as Row).format !== 'clean-bookface-archive/1'
  ) {
    if (account) throw new Error('Unsupported portable archive format');
    return null;
  }
  const manifest = candidateManifest as Row;
  files = withPrefix(files, markers[0]!);
  if (!files.has('archive.ndjson') || !files.has('revisions.ndjson'))
    throw new Error('Portable archive record files are missing');
  if (
    outerBytes + (await totalBytes(files)) > limits.maxExpandedBytes ||
    outerFiles + files.size > limits.maxFiles
  )
    throw new Error('Portable expansion budget exceeded');
  if (!Array.isArray(manifest.media) || manifest.media.length > limits.maxFiles)
    throw new Error('Invalid portable media manifest');
  const mediaFiles = new Map<string, string>();
  const mediaIds = new Set<string>();
  const allowed = new Set(['manifest.json', 'archive.ndjson', 'revisions.ndjson']);
  for (const value of manifest.media) {
    check();
    const medium = obj(value),
      id = identity(medium.id),
      path = safeRelative(text(medium.file));
    const expectedPath = `media/${id}.${medium.purpose === 'shared' ? 'webp' : 'original'}`;
    if (mediaIds.has(id) || allowed.has(path) || path !== expectedPath)
      throw new Error('Duplicate or unsafe portable media path');
    mediaIds.add(id);
    allowed.add(path);
    if (
      !Number.isSafeInteger(medium.size) ||
      Number(medium.size) < 0 ||
      Number(medium.size) > limits.maxFileBytes ||
      !/^[a-f0-9]{64}$/.test(text(medium.sha256, 64)) ||
      !['original', 'shared'].includes(String(medium.purpose))
    )
      throw new Error('Invalid portable media manifest');
    const local = files.get(path);
    if (!local) throw new Error('A portable media file is missing');
    const info = await lstat(local);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size !== medium.size ||
      (await checksum(local, check)) !== medium.sha256
    )
      throw new Error('Portable media integrity check failed');
    mediaFiles.set(`portable-media/${id}`, local);
  }
  if ([...files.keys()].some((path) => !allowed.has(path)))
    throw new Error('Unexpected file or nested ZIP in portable archive');
  const kindSet = new Set(['post', 'photo', 'album', 'message', 'friend', 'profile']);
  const originals = new Map<string, string>();
  let count = 0;
  const checked = (r: NormalizedRecord) => {
    if (++count > limits.maxRecords) throw new Error('Portable record limit exceeded');
    return r;
  };
  function mediaRefs(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > limits.maxFiles)
      throw new Error('Invalid portable media references');
    return [
      ...new Set(
        value.map((v) => {
          const id = identity(v);
          if (!mediaIds.has(id)) throw new Error('A portable record refers to missing media');
          return `portable-media/${id}`;
        }),
      ),
    ];
  }
  function archiveRecord(value: unknown, historyVersion?: number): NormalizedRecord {
    const row = obj(value);
    const id = identity(row.id),
      sourceKey = text(row.sourceKey, 64);
    if (
      !/^[a-f0-9]{64}$/.test(sourceKey) ||
      !kindSet.has(String(row.kind)) ||
      !Number.isSafeInteger(row.version) ||
      Number(row.version) < 1
    )
      throw new Error('Invalid portable archive record');
    const metadata = obj(privateMetadata(row.metadata ?? {}));
    const prior =
      metadata.portable &&
      typeof metadata.portable === 'object' &&
      !Array.isArray(metadata.portable)
        ? (metadata.portable as Row)
        : {};
    metadata.portable = {
      ...prior,
      format: prior.format ?? 'clean-bookface-archive/1',
      originalItemId: prior.originalItemId ?? id,
      sourceVersion: prior.sourceVersion ?? row.version,
      importedAt: prior.importedAt ?? ms(row.importedAt),
      ...(historyVersion
        ? { historyVersion }
        : prior.historyVersion
          ? { historyVersion: prior.historyVersion }
          : {}),
    };
    return {
      kind: row.kind as ArchiveKind,
      sourceKey: historyVersion
        ? digest(`portable-revision\0${sourceKey}\0${historyVersion}`)
        : sourceKey,
      source: text(row.source, 2048),
      body: text(row.body, limits.maxJsonBytes, true),
      title: historyVersion
        ? `Earlier version ${historyVersion}: ${text(row.title, 4096, true)}`
        : text(row.title, 4096, true),
      occurredAt: ms(row.occurredAt),
      metadata,
      mediaPaths: mediaRefs(row.mediaIds),
      ambiguous: false,
    };
  }
  async function* records(): AsyncGenerator<NormalizedRecord> {
    for await (const value of ndjson(files.get('archive.ndjson')!, limits, check)) {
      check();
      const row = obj(value),
        id = identity(row.id);
      if (originals.has(id)) throw new Error('Duplicate portable item identity');
      const r = archiveRecord(row);
      originals.set(id, r.sourceKey);
      yield checked(r);
    }
    const revisions = new Set<string>();
    for await (const value of ndjson(files.get('revisions.ndjson')!, limits, check)) {
      check();
      const history = obj(value),
        itemId = identity(history.item_id);
      const version = Number(history.version);
      if (!originals.has(itemId) || !Number.isSafeInteger(version) || version < 1)
        throw new Error('Orphan or invalid portable revision');
      const tag = `${itemId}:${version}`;
      if (revisions.has(tag)) throw new Error('Duplicate portable revision');
      revisions.add(tag);
      const row = obj(
        typeof history.record === 'string' ? parsePortable(history.record) : history.record,
      );
      validateStructure(row);
      if (row.id !== itemId || row.version !== version || row.sourceKey !== originals.get(itemId))
        throw new Error('Portable revision identity mismatch');
      yield checked(archiveRecord(row, version));
    }
    if (!account) return;
    const profile = obj(account.account);
    const actor = text(profile.actor);
    let actorURL: URL;
    try {
      actorURL = new URL(actor);
    } catch {
      throw new Error('Invalid portable source account');
    }
    if (!['http:', 'https:'].includes(actorURL.protocol) || actorURL.username || actorURL.password)
      throw new Error('Invalid portable source account');
    const postIds = new Set<string>();
    if (!Array.isArray(account.publications) || !Array.isArray(account.comments))
      throw new Error('Invalid portable account collections');
    for (const value of account.publications) {
      check();
      const post = obj(value),
        id = identity(post.id);
      if (postIds.has(id)) throw new Error('Duplicate portable publication');
      postIds.add(id);
      yield checked({
        kind: 'post',
        sourceKey: digest(`portable-publication\0${actor}\0${id}`),
        source: 'portable-account/publications',
        body: text(post.body, limits.maxJsonBytes, true),
        title: 'Your post — private portable copy',
        occurredAt: ms(post.createdAt),
        mediaPaths: mediaRefs(post.mediaIds),
        metadata: {
          portable: {
            format: 'clean-bookface-account/1',
            category: 'authored-publication',
            sourceActor: actor,
            originalId: id,
            updatedAt: ms(post.updatedAt),
          },
        },
        ambiguous: false,
      });
    }
    const commentIds = new Set<string>();
    for (const value of account.comments) {
      check();
      const comment = obj(value),
        id = text(comment.id);
      if (commentIds.has(id)) throw new Error('Duplicate portable comment');
      commentIds.add(id);
      yield checked({
        kind: 'message',
        sourceKey: digest(`portable-comment\0${actor}\0${id}`),
        source: 'portable-account/comments',
        body: text(comment.body, limits.maxJsonBytes, true),
        title: 'Your comment — private portable copy',
        occurredAt: ms(comment.createdAt),
        mediaPaths: [],
        metadata: {
          portable: {
            format: 'clean-bookface-account/1',
            category: 'authored-comment',
            sourceActor: actor,
            originalId: id,
            parentReference: text(comment.postId),
          },
        },
        ambiguous: false,
      });
    }
    // Profile, access settings, grants, invitations, sessions, credentials,
    // friendship states, role flags and signing keys are deliberately not applied.
  }
  return {
    records: records(),
    mediaFiles,
    files: files.size + outerFiles,
    warnings: [
      'Portable copies were imported privately. Accounts, credentials, friendships and sharing permissions were not restored.',
      'Earlier saved revisions appear as separate private memories with their original version in the title.',
    ],
  };
}
