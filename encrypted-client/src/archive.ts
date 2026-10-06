import { importLegacy } from './legacy-import.js';
import { BlobReader, BlobWriter, ZipReader, ZipWriter } from '@zip.js/zip.js';
export type ArchiveKind = 'post' | 'message' | 'photo' | 'album' | 'friend';
export interface MemoryRecord {
  id: string;
  kind: ArchiveKind;
  timestamp: number | null;
  text: string;
  title: string;
  sourcePath: string;
  attachments: Array<{ path: string; mimeType: string; bytes: Blob }>;
  privateOnly: boolean;
  provenance?: Record<string, unknown>;
  /** Original record identity when two preserved versions conflict. */
  conflictOf?: string;
}
interface NormalizedRecord {
  kind: ArchiveKind;
  body: string;
  title: string;
  occurredAt: number | null;
  sourceKey: string;
  source: string;
  metadata: Record<string, unknown>;
  mediaPaths: string[];
  ambiguous: boolean;
}
export const ARCHIVE_LIMITS = Object.freeze({
  maxFiles: 8,
  maxEntries: 10000,
  maxCompressedBytes: 256 * 1024 * 1024,
  maxExpandedBytes: 512 * 1024 * 1024,
  maxEntryBytes: 64 * 1024 * 1024,
  maxJsonBytes: 16 * 1024 * 1024,
  maxRecords: 50000,
  maxRatio: 200,
});
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const digest = (v: string): string => v;
export function timestamp(v: unknown, alreadyMilliseconds = false): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const milliseconds = !alreadyMilliseconds && Math.abs(v) < 100_000_000_000 ? v * 1000 : v;
  return Number.isSafeInteger(milliseconds) &&
    milliseconds >= -62135596800000 &&
    milliseconds <= 253402300799999
    ? milliseconds
    : null;
}
export function validateStructure(value: unknown): void {
  const stack: Array<[unknown, number]> = [[value, 0]];
  let nodes = 0;
  while (stack.length) {
    const [node, depth] = stack.pop()!;
    if (++nodes > 2_000_000 || depth > 64) throw new Error('JSON structure limit exceeded');
    if (node && typeof node === 'object')
      for (const child of Object.values(node)) stack.push([child, depth + 1]);
  }
}
function mediaPaths(value: unknown): string[] {
  const result = new Set<string>();
  const stack = [value];
  while (stack.length) {
    const next = stack.pop();
    if (!next || typeof next !== 'object') continue;
    if (Array.isArray(next)) {
      for (const child of next) stack.push(child);
      continue;
    }
    for (const [key, v] of Object.entries(next)) {
      if ((key === 'uri' || key === 'media_uri') && typeof v === 'string') result.add(v);
      else if (v && typeof v === 'object' && !['comments', 'reactions', 'tags'].includes(key))
        stack.push(v);
    }
  }
  return [...result];
}
/** Index source evidence once. Each candidate UTF8 sequence has at most four
 * bytes, so lookup never rescans the complete JSON for each distinct character. */
function facebookTextRepair(source: string): (value: string) => string {
  const literal = new Set<number>(),
    escaped = new Set<number>(),
    cache = new Map<string, string>();
  const length = (lead: number) => (lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4);
  const key = (bytes: number[]) => bytes.reduce((n, b) => n * 256 + b, 0);
  for (const match of source.matchAll(/[\u00c2-\u00f4][\u0080-\u00bf]+/gu)) {
    const run = match[0],
      size = length(run.charCodeAt(0));
    if (run.length >= size)
      literal.add(key(Array.from(run.slice(0, size), (c) => c.charCodeAt(0))));
  }
  for (const match of source.matchAll(
    /\\u00(?:c[2-9a-f]|[de][0-9a-f]|f[0-4])(?:\\u00[89ab][0-9a-f]){1,3}/gi,
  )) {
    let preceding = 0;
    for (let i = match.index - 1; i >= 0 && source[i] === '\\'; i--) preceding++;
    if (preceding % 2) continue; // A quoted literal backslash is not a JSON Unicode escape.
    const bytes: number[] = [];
    for (let i = 0; i < match[0].length; i += 6)
      bytes.push(parseInt(match[0].slice(i + 4, i + 6), 16));
    const size = length(bytes[0]);
    if (bytes.length >= size) escaped.add(key(bytes.slice(0, size)));
  }
  return (value) =>
    value.replace(/[\u00c2-\u00f4][\u0080-\u00bf]+/gu, (run) => {
      if (run.length !== length(run.charCodeAt(0))) return run;
      const cached = cache.get(run);
      if (cached !== undefined) return cached;
      const bytes = Array.from(run, (c) => c.charCodeAt(0)),
        code = key(bytes);
      let repaired = run;
      if (!literal.has(code) && escaped.has(code)) {
        try {
          repaired = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
        } catch {
          /* Invalid UTF8 remains exact. */
        }
      }
      cache.set(run, repaired);
      return repaired;
    });
}
export function parseFacebook(value: unknown, filename: string, rawJson = ''): NormalizedRecord[] {
  validateStructure(value);
  const root = obj(value);
  const display = facebookTextRepair(rawJson);
  const lower = filename.toLowerCase();
  const result: NormalizedRecord[] = [];
  const counters = new Map<string, number>();
  function add(
    kind: ArchiveKind,
    input: unknown,
    index: number,
    context: string,
    title = '',
  ): void {
    const r = obj(input);
    if (!Object.keys(r).length) return;
    const occurredAt = timestamp(
      r.timestamp_ms ?? r.timestamp ?? r.creation_timestamp ?? r.created_timestamp,
      typeof r.timestamp_ms === 'number',
    );
    const textParts = arr(r.data)
      .map((d) => str(obj(d).post))
      .filter(Boolean);
    const body = textParts.length
      ? textParts.join('\n\n')
      : str(r.post) ||
        str(r.content) ||
        str(r.description) ||
        str(r.text) ||
        (kind === 'photo' ? str(r.title) : kind === 'friend' ? str(r.name) : '');
    const providerId = r.id ?? r.post_id ?? r.message_id ?? r.photo_id;
    const hasId =
      (typeof providerId === 'string' && providerId.length > 0 && providerId.length <= 512) ||
      typeof providerId === 'number';
    // Without a provider ID, source path + source position preserves equal-text records.
    // File reshuffling cannot be reliably identified as an edit; report this limitation.
    let fallback = `${filename}\0${index}`;
    if (kind === 'message' && occurredAt !== null) {
      const base = `${context}\0${occurredAt}\0${str(r.sender_name)}`;
      const occurrence = counters.get(base) ?? 0;
      counters.set(base, occurrence + 1);
      fallback = `${base}\0${filename.match(/message_(\d+)\.json$/u)?.[1] ?? '1'}\0${occurrence}`;
    }
    const sourceKey = digest(
      `${kind}\0${context}\0${hasId ? `id:${String(providerId)}` : `position:${fallback}`}`,
    );
    result.push({
      kind,
      body: display(body),
      title: display(title || str(r.title) || str(r.name)),
      occurredAt,
      sourceKey,
      source: filename,
      metadata: { original: input, ...(context ? { context } : {}) },
      mediaPaths: kind === 'friend' || kind === 'album' ? [] : mediaPaths(input),
      ambiguous: !hasId,
    });
  }
  if (Array.isArray(root.messages)) {
    const context =
      str(root.thread_path) || str(root.thread_id) || filename.replace(/\/message_\d+\.json$/u, '');
    root.messages.forEach((r, i) => add('message', r, i, context, str(root.title)));
    // Chunk independently inside each source file: bounded metadata and stable reselection.
    // Original messages and source identities are preserved, including attachment-only messages.
    const messages = result.splice(0);
    let chunk: NormalizedRecord[] = [],
      size = 0;
    const flush = () => {
      if (!chunk.length) return;
      const first = chunk[0];
      result.push({
        ...first,
        sourceKey:
          chunk.length === 1 ? first.sourceKey : `message-chunk\0${filename}\0${first.sourceKey}`,
        body:
          chunk.length === 1
            ? first.body
            : chunk
                .map((m) => `${display(str(obj(m.metadata.original).sender_name))}: ${m.body}`)
                .join('\n\n'),
        mediaPaths: [...new Set(chunk.flatMap((m) => m.mediaPaths))],
        metadata: {
          context,
          original: chunk.map((m) => m.metadata.original),
          messageCount: chunk.length,
          messageSourceKeys: chunk.map((m) => m.sourceKey),
        },
      });
      chunk = [];
      size = 0;
    };
    for (const message of messages) {
      const bytes = new TextEncoder().encode(JSON.stringify(message)).length;
      // Media-bearing messages stand alone so unrelated attachments cannot overfill a chunk.
      if (
        chunk.length &&
        (chunk.length >= 100 ||
          size + bytes > 256 * 1024 ||
          message.mediaPaths.length ||
          chunk[0].mediaPaths.length)
      )
        flush();
      chunk.push(message);
      size += bytes;
    }
    flush();
  } else if (root.friends_v2 || root.friends || /(?:^|\/)friends(?:_\d+)?\.json$/u.test(lower)) {
    arr(root.friends_v2 ?? root.friends ?? value).forEach((r, i) => add('friend', r, i, 'friends'));
  } else if (
    root.photos ||
    root.photos_v2 ||
    root.your_photos ||
    root.other_photos_v2 ||
    root.videos_v2 ||
    /(?:^|\/)(?:your_)?(?:uncategorized_)?photos(?:_\d+)?\.json$/u.test(lower)
  ) {
    const photos = arr(
      root.photos ??
        root.photos_v2 ??
        root.your_photos ??
        root.other_photos_v2 ??
        root.videos_v2 ??
        value,
    );
    const album = str(root.name) || str(root.title);
    if (album)
      add(
        'album',
        {
          name: album,
          description: root.description,
          timestamp: root.last_modified_timestamp,
          photos,
        },
        0,
        filename,
        album,
      );
    const albumRecord = album ? result[result.length - 1] : undefined;
    const start = result.length;
    photos.forEach((r, i) => add('photo', r, i, album));
    if (albumRecord)
      albumRecord.metadata.photoSourceKeys = result.slice(start).map((r) => r.sourceKey);
  } else if (root.albums || root.albums_v2) {
    arr(root.albums ?? root.albums_v2).forEach((a, n) => {
      const album = obj(a);
      const name = str(album.name) || str(album.title);
      add('album', a, n, filename, name);
      const albumRecord = result[result.length - 1],
        start = result.length;
      arr(album.photos).forEach((p, i) => add('photo', p, i, `${filename}:${n}`, name));
      albumRecord.metadata.photoSourceKeys = result.slice(start).map((r) => r.sourceKey);
    });
  } else if (
    root.posts ||
    root.posts_v2 ||
    root.your_posts ||
    /(?:^|\/)(?:posts|your_posts(?:__check_ins__photos_and_videos)?)(?:_\d+)?\.json$/u.test(lower)
  ) {
    arr(root.posts ?? root.posts_v2 ?? root.your_posts ?? value).forEach((r, i) =>
      add('post', r, i, 'posts'),
    );
  }
  return result;
}

export async function facebookProvenance(
  metadata: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!Array.isArray(metadata.photoSourceKeys)) return metadata;
  const { photoSourceKeys, ...rest } = metadata;
  return {
    ...rest,
    photoRecordIds: await Promise.all(photoSourceKeys.map((key) => hash(String(key)))),
  };
}
/** Remote references are evidence only, never network requests. Traversal still fails closed. */
export function attachmentPath(raw: string, warning: (message: string) => void): string | null {
  if (/^[a-z][a-z0-9+.-]*:/iu.test(raw)) {
    warning(`External attachment omitted: ${raw}`);
    return null;
  }
  const path = safePath(raw);
  if (!mediaMime(path)) {
    warning(`Unsupported attachment omitted: ${path}`);
    return null;
  }
  return path;
}

export function safePath(path: string): string {
  if (
    !path ||
    path.length > 2048 ||
    /[\\\x00-\x1f\x7f:]/u.test(path) ||
    path.startsWith('/') ||
    path.split('/').some((p) => !p || p === '.' || p === '..') ||
    path.split('/').length > 24
  )
    throw new Error('Unsafe archive path');
  return path;
}
const mimeTypes: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  heic: 'image/heic',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
};
export function mediaMime(path: string): string {
  return mimeTypes[path.split('.').pop()!.toLowerCase()] ?? '';
}
export async function hash(value: string | Blob): Promise<string> {
  const data =
    typeof value === 'string' ? new TextEncoder().encode(value) : await value.arrayBuffer();
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
export async function rejectExecutable(blob: Blob): Promise<void> {
  const bytes = new Uint8Array(await blob.slice(0, 512).arrayBuffer());
  const text = new TextDecoder().decode(bytes).trimStart().toLowerCase();
  if (
    (bytes[0] === 0x4d && bytes[1] === 0x5a) ||
    (bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) ||
    text.startsWith('#!') ||
    /^(?:<!doctype html|<html|<script|<svg)/u.test(text)
  )
    throw new Error('Executable media is unsupported');
}
function parseJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  validateStructure(value);
  return value;
}

/** Entirely local. The caller must encrypt records, attachment bytes and warnings before persistence. */
export async function importArchives(
  files: File[],
  options: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<{ records: MemoryRecord[]; warnings: string[] }> {
  const limits = ARCHIVE_LIMITS;
  const check = () => {
    options.signal?.throwIfAborted();
  };
  check();
  if (
    !files.length ||
    files.length > limits.maxFiles ||
    files.reduce((n, f) => n + f.size, 0) > limits.maxCompressedBytes
  )
    throw new Error('Archive input limit exceeded');
  const blobs = new Map<string, Blob>();
  let entries = 0,
    expanded = 0,
    declared = 0;
  async function extract(file: Blob, target: Map<string, Blob>): Promise<void> {
    check();
    const reader = new ZipReader(new BlobReader(file), { useWebWorkers: false });
    try {
      for await (const entry of reader.getEntriesGenerator()) {
        check();
        if (++entries > limits.maxEntries) throw new Error('Archive entry limit exceeded');
        const path = safePath(
          entry.directory ? entry.filename.replace(/\/$/u, '') : entry.filename,
        );
        const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
        if (entry.encrypted || mode === 0xa000 || (mode && mode !== 0x8000 && mode !== 0x4000))
          throw new Error('Encrypted archives and special files are unsupported');
        if (entry.directory) continue;
        if (/\.(?:html?|xhtml|svg|js|mjs|exe|dll|sh|bat|cmd|com|wasm)$/iu.test(path))
          throw new Error('HTML and executable media are unsupported');
        const json = /\.json$/iu.test(path);
        const cap = json ? limits.maxJsonBytes : limits.maxEntryBytes;
        declared += entry.uncompressedSize;
        if (
          !Number.isSafeInteger(entry.uncompressedSize) ||
          entry.uncompressedSize < 0 ||
          entry.uncompressedSize > cap ||
          declared > limits.maxExpandedBytes ||
          entry.uncompressedSize > Math.max(entry.compressedSize, 1) * limits.maxRatio
        )
          throw new Error('Archive expansion limit exceeded');
        // The sink independently counts decompressed output; forged ZIP metadata cannot bypass it.
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        let size = 0;
        const sink = new WritableStream<Uint8Array>({
          write(chunk) {
            check();
            size += chunk.byteLength;
            expanded += chunk.byteLength;
            if (size > cap || expanded > limits.maxExpandedBytes)
              throw new Error('Archive streaming expansion limit exceeded');
            chunks.push(new Uint8Array(chunk));
          },
        });
        await entry.getData!(sink, { signal: options.signal, checkSignature: true });
        check();
        if (size !== entry.uncompressedSize) throw new Error('Archive size mismatch');
        const blob = new Blob(chunks, {
          type: json ? 'application/json' : mediaMime(path) || 'application/octet-stream',
        });
        if (mediaMime(path)) await rejectExecutable(blob);
        const previous = target.get(path);
        if (previous && (await hash(previous)) !== (await hash(blob)))
          throw new Error('Conflicting duplicate archive path');
        if (!previous) target.set(path, blob);
      }
    } finally {
      await reader.close();
    }
  }
  for (const file of files) {
    if (!/\.zip$/iu.test(file.name)) throw new Error('Only JSON ZIP archives are supported');
    await extract(file, blobs);
  }
  const legacy = await importLegacy(blobs, {
    limits,
    check,
    hash,
    safePath,
    timestamp,
    validateStructure,
    rejectExecutable,
    extract: async (blob) => {
      const nested = new Map<string, Blob>();
      await extract(blob, nested);
      return nested;
    },
  });
  if (legacy) return legacy;
  const records: MemoryRecord[] = [],
    warnings: string[] = [];
  const missing = new Set<string>();
  const ids = new Set<string>();
  let done = 0;
  for (const [path, blob] of blobs) {
    check();
    options.onProgress?.(++done, blobs.size);
    if (!/\.json$/iu.test(path)) continue;
    const rawJson = new TextDecoder('utf-8', { fatal: true }).decode(await blob.arrayBuffer());
    const value = parseJson(rawJson);
    const root = obj(value);
    if (root.format === 'clean-bookface-private-archive/1') {
      if (!Array.isArray(root.records)) throw new Error('Invalid portable archive');
      for (const raw of root.records) {
        check();
        const row = obj(raw);
        if (
          !['post', 'message', 'photo', 'album', 'friend'].includes(str(row.kind)) ||
          typeof row.id !== 'string' ||
          !row.id ||
          row.id.length > 200 ||
          typeof row.text !== 'string' ||
          typeof row.title !== 'string' ||
          typeof row.sourcePath !== 'string' ||
          typeof row.privateOnly !== 'boolean' ||
          (row.timestamp !== null && timestamp(row.timestamp, true) !== row.timestamp) ||
          (row.conflictOf !== undefined &&
            (typeof row.conflictOf !== 'string' ||
              !row.conflictOf ||
              row.conflictOf.length > 200)) ||
          !Array.isArray(row.attachments)
        )
          throw new Error('Invalid portable record');
        const attachments: MemoryRecord['attachments'] = [];
        for (const rawAttachment of row.attachments) {
          const a = obj(rawAttachment);
          const storagePath = safePath(str(a.storagePath));
          const originalPath = safePath(str(a.path));
          const bytes = blobs.get(storagePath);
          if (
            !bytes ||
            !mediaMime(originalPath) ||
            a.mimeType !== mediaMime(originalPath) ||
            typeof a.sha256 !== 'string' ||
            (await hash(bytes)) !== a.sha256
          )
            throw new Error('Portable media missing or corrupt');
          attachments.push({
            path: originalPath,
            mimeType: a.mimeType,
            bytes: new Blob([bytes], { type: a.mimeType }),
          });
        }
        const record: MemoryRecord = {
          id: row.id,
          kind: row.kind as ArchiveKind,
          timestamp: row.timestamp as number | null,
          text: row.text,
          title: row.title,
          sourcePath: row.sourcePath,
          privateOnly: row.privateOnly || row.kind === 'message' || row.kind === 'friend',
          attachments,
          provenance: obj(row.provenance),
          ...(typeof row.conflictOf === 'string' ? { conflictOf: row.conflictOf } : {}),
        };
        if (ids.has(record.id)) throw new Error('Duplicate portable record identity');
        ids.add(record.id);
        records.push(record);
        if (records.length > limits.maxRecords) throw new Error('Archive record limit exceeded');
      }
    } else {
      if (Object.hasOwn(root, 'format')) throw new Error('Unsupported declared archive format');
      const parsed = parseFacebook(value, path, rawJson);
      if (!parsed.length) warnings.push(`Unsupported or empty JSON: ${path}`);
      for (const item of parsed) {
        check();
        const attachments: MemoryRecord['attachments'] = [];
        for (const rawPath of item.mediaPaths) {
          const mediaPath = attachmentPath(rawPath, (message) => warnings.push(message));
          if (!mediaPath) continue;
          const bytes = blobs.get(mediaPath);
          if (!bytes) {
            missing.add(mediaPath);
            continue;
          }
          attachments.push({ path: mediaPath, mimeType: mediaMime(mediaPath), bytes });
        }
        const id = await hash(item.sourceKey);
        if (ids.has(id)) throw new Error('Duplicate record identity');
        ids.add(id);
        records.push({
          id,
          kind: item.kind,
          timestamp: item.occurredAt,
          text: item.body,
          title: item.title,
          sourcePath: path,
          attachments,
          privateOnly: item.kind === 'message' || item.kind === 'friend',
          provenance: await facebookProvenance(item.metadata),
        });
        if (records.length > limits.maxRecords) throw new Error('Archive record limit exceeded');
      }
    }
  }
  if (missing.size)
    warnings.push(`Missing media: ${missing.size} referenced file(s): ${[...missing].join(', ')}`);
  check();
  return { records, warnings };
}

/** Plaintext portable ZIP: download locally; never send this blob to storage without encryption. */
export async function exportArchives(records: MemoryRecord[]): Promise<Blob> {
  if (records.length > ARCHIVE_LIMITS.maxRecords) throw new Error('Archive record limit exceeded');
  const writer = new ZipWriter(new BlobWriter('application/zip'), { useWebWorkers: false });
  const rows = [];
  const storedMedia = new Map<string, string>();
  let expanded = 0;
  let count = 1;
  try {
    for (const record of records) {
      const attachments = [];
      for (const attachment of record.attachments) {
        safePath(attachment.path);
        if (!mediaMime(attachment.path) || attachment.mimeType !== mediaMime(attachment.path))
          throw new Error('Unsupported media type');
        await rejectExecutable(attachment.bytes);
        const sha256 = await hash(attachment.bytes);
        const previousPath = storedMedia.get(sha256);
        if (!previousPath) expanded += attachment.bytes.size;
        if (
          (!previousPath && ++count > ARCHIVE_LIMITS.maxEntries) ||
          attachment.bytes.size > ARCHIVE_LIMITS.maxEntryBytes ||
          expanded > ARCHIVE_LIMITS.maxExpandedBytes
        )
          throw new Error('Archive expansion limit exceeded');
        const storagePath = previousPath ?? `media/${count}.${attachment.path.split('.').pop()}`;
        if (!previousPath) {
          await writer.add(storagePath, new BlobReader(attachment.bytes), { level: 0 });
          storedMedia.set(sha256, storagePath);
        }
        attachments.push({
          path: attachment.path,
          mimeType: attachment.mimeType,
          storagePath,
          sha256,
        });
      }
      rows.push({ ...record, attachments });
    }
    const manifest = new Blob([
      JSON.stringify({ format: 'clean-bookface-private-archive/1', records: rows }),
    ]);
    if (
      manifest.size > ARCHIVE_LIMITS.maxJsonBytes ||
      expanded + manifest.size > ARCHIVE_LIMITS.maxExpandedBytes
    )
      throw new Error('Archive manifest limit exceeded');
    await writer.add('clean-bookface.json', new BlobReader(manifest), { level: 0 });
    const result = await writer.close();
    if (result.size > ARCHIVE_LIMITS.maxCompressedBytes)
      throw new Error('Archive output limit exceeded');
    return result;
  } catch (error) {
    try {
      await writer.close();
    } catch {}
    throw error;
  }
}
