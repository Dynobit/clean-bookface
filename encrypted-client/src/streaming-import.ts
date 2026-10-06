import { BlobReader, ZipReader, type FileEntry } from '@zip.js/zip.js';
import { importLegacyRecords, type LegacyFile } from './legacy-import.js';
import {
  ARCHIVE_LIMITS,
  importArchives,
  parseFacebook,
  facebookProvenance,
  attachmentPath,
  validateStructure,
  safePath,
  mediaMime,
  hash,
  timestamp,
  rejectExecutable,
  type MemoryRecord,
} from './archive.js';

const GiB = 1024 ** 3,
  MiB = 1024 ** 2;
export const STREAM_IMPORT_LIMITS = Object.freeze({
  maxFiles: 64,
  maxEntries: 100_000,
  maxInputBytes: 10 * GiB,
  maxExpandedBytes: 10 * GiB,
  maxDecodedBytes: 20 * GiB,
  maxCentralDirectoryBytes: 64 * MiB,
  maxPathBytes: 32 * MiB,
  batchBytes: 96 * MiB,
  maxRecords: ARCHIVE_LIMITS.maxRecords,
});
export interface ImportCounts {
  records: { imported: number; skipped: number };
  messages: { imported: number; skipped: number };
  attachments: { imported: number; skipped: number; missing: number };
  byKind: Record<MemoryRecord['kind'], { imported: number; skipped: number }>;
}
export interface ImportProgress {
  /** Cumulative source outcomes. Messages count individual messages, records count stored chunks. */
  counts?: ImportCounts;
  phase: 'index' | 'read' | 'batch';
  indexedEntries: number;
  declaredBytes: number;
  decodedBytes: number;
  residentMediaBytes: number;
  peakResidentMediaBytes: number;
  records: number;
  batches: number;
}
export interface ArchiveImportBatch {
  records: MemoryRecord[];
  warnings: string[];
  progress: ImportProgress;
}
/** Receives encrypted chunks only; implementations must release resources in remove(). */
export interface ImportTemporaryFile {
  writable: WritableStream<Uint8Array<ArrayBuffer>>;
  blob(): Promise<Blob>;
  remove(): Promise<void>;
}
export interface ArchiveImportOptions {
  openTemporaryFile?: () => Promise<ImportTemporaryFile>;
  signal?: AbortSignal;
  onProgress?: (progress: ImportProgress) => void;
  batchBytes?: number;
}
const TEMP_DIRECTORY = 'clean-bookface-import-staging';
const TEMP_LOCK = 'clean-bookface-import-staging:';
/** Best effort: crash orphans contain ciphertext only; never remove another tab's active file. */
export async function cleanupImportTemporaryFiles(): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory || !navigator.locks)
    return;
  try {
    const directory = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle(TEMP_DIRECTORY, { create: true });
    const entries = directory as FileSystemDirectoryHandle & {
      keys(): AsyncIterableIterator<string>;
    };
    for await (const name of entries.keys()) {
      if (!/^import-[a-f0-9-]+$/u.test(name)) continue;
      await navigator.locks.request(TEMP_LOCK + name, { ifAvailable: true }, async (lock) => {
        if (lock) await directory.removeEntry(name).catch(() => {});
      });
    }
  } catch {
    /* Cleanup is retried at the next import. Keys were never persisted. */
  }
}
async function browserTemporaryFile(): Promise<ImportTemporaryFile> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory || !navigator.locks)
    throw new Error('Large legacy account migration requires private browser file storage');
  await cleanupImportTemporaryFiles();
  const directory = await (
    await navigator.storage.getDirectory()
  ).getDirectoryHandle(TEMP_DIRECTORY, { create: true });
  const name = `import-${crypto.randomUUID()}`;
  let unlock!: () => void, ready!: () => void, failed!: (reason: unknown) => void;
  const held = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const acquired = new Promise<void>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  const lock = navigator.locks.request(TEMP_LOCK + name, async () => {
    ready();
    await held;
  });
  void lock.catch(failed);
  await acquired;
  try {
    const file = await directory.getFileHandle(name, { create: true });
    const writable = await file.createWritable();
    return {
      writable,
      blob: () => file.getFile(),
      remove: async () => {
        try {
          await writable.abort().catch(() => {});
          await directory.removeEntry(name);
        } finally {
          unlock();
          await lock;
        }
      },
    };
  } catch (error) {
    unlock();
    await lock;
    await directory.removeEntry(name).catch(() => {});
    throw error;
  }
}
/** Fixed-size authenticated scratch chunks support bounded random-access nested ZIP reads.
 * The key and nonce prefix exist only in memory and never enter IndexedDB/OPFS. */
async function encryptedScratch(
  temp: ImportTemporaryFile,
): Promise<{ writable: WritableStream<Uint8Array>; blob(): Promise<Blob> }> {
  const chunkSize = MiB,
    key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
  const prefix = crypto.getRandomValues(new Uint8Array(8));
  const iv = (index: number) => {
    const value = new Uint8Array(12);
    value.set(prefix);
    new DataView(value.buffer).setUint32(8, index);
    return value;
  };
  const writer = temp.writable.getWriter();
  let buffer = new Uint8Array(chunkSize),
    filled = 0,
    length = 0,
    chunks = 0;
  const flush = async () => {
    if (!filled) return;
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv(chunks++) },
        key,
        buffer.subarray(0, filled),
      ),
    );
    await writer.write(encrypted);
    filled = 0;
  };
  const writable = new WritableStream<Uint8Array>({
    async write(bytes) {
      for (let at = 0; at < bytes.length;) {
        const take = Math.min(chunkSize - filled, bytes.length - at);
        buffer.set(bytes.subarray(at, at + take), filled);
        filled += take;
        at += take;
        length += take;
        if (filled === chunkSize) await flush();
      }
    },
    async close() {
      try {
        await flush();
        await writer.close();
      } finally {
        buffer = new Uint8Array(0);
        writer.releaseLock();
      }
    },
    async abort(reason) {
      try {
        await writer.abort(reason);
      } finally {
        buffer = new Uint8Array(0);
        writer.releaseLock();
      }
    },
  });
  return {
    writable,
    blob: async () => {
      const ciphertext = await temp.blob();
      if (ciphertext.size !== length + chunks * 16)
        throw new Error('Temporary import file size mismatch');
      let cachedIndex = -1,
        cachedPlain: Uint8Array<ArrayBuffer> | undefined;
      class Range extends Blob {
        constructor(
          private start: number,
          private count: number,
        ) {
          super([]);
        }
        override get size() {
          return this.count;
        }
        override slice(start = 0, end = this.count): Blob {
          const clamp = (n: number) =>
            Math.min(this.count, Math.max(0, n < 0 ? this.count + n : n));
          const begin = clamp(start),
            finish = clamp(end);
          return new Range(this.start + begin, Math.max(0, finish - begin));
        }
        override async arrayBuffer(): Promise<ArrayBuffer> {
          if (this.count > ARCHIVE_LIMITS.maxEntryBytes)
            throw new Error('Temporary import read limit exceeded');
          const output = new Uint8Array(this.count);
          const end = this.start + this.count;
          for (let i = Math.floor(this.start / chunkSize); i * chunkSize < end; i++) {
            if (cachedIndex !== i || !cachedPlain) {
              const encrypted = await ciphertext
                .slice(i * (chunkSize + 16), Math.min(ciphertext.size, (i + 1) * (chunkSize + 16)))
                .arrayBuffer();
              cachedPlain = new Uint8Array(
                await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv(i) }, key, encrypted),
              );
              cachedIndex = i;
            }
            const plain = cachedPlain;
            const begin = Math.max(this.start, i * chunkSize),
              finish = Math.min(end, i * chunkSize + plain.length);
            output.set(
              plain.subarray(begin - i * chunkSize, finish - i * chunkSize),
              begin - this.start,
            );
          }
          return output.buffer;
        }
        override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
          let offset = 0;
          return new ReadableStream({
            pull: async (controller) => {
              if (offset >= this.count) {
                controller.close();
                return;
              }
              const next = Math.min(this.count, offset + chunkSize);
              controller.enqueue(new Uint8Array(await this.slice(offset, next).arrayBuffer()));
              offset = next;
            },
          });
        }
      }
      return new Range(0, length);
    },
  };
}
/** Bound the central-directory allocation before zip.js reads it, including ZIP64. */
async function checkDirectory(file: Blob): Promise<number> {
  const tailStart = Math.max(0, file.size - 65_557);
  const tail = new DataView(await file.slice(tailStart).arrayBuffer());
  let at = tail.byteLength - 22;
  for (; at >= 0; at--)
    if (
      tail.getUint32(at, true) === 0x06054b50 &&
      at + 22 + tail.getUint16(at + 20, true) === tail.byteLength
    )
      break;
  if (at < 0) throw new Error('ZIP directory is missing or has trailing data');
  const disk = tail.getUint16(at + 4, true),
    directoryDisk = tail.getUint16(at + 6, true);
  if (![0, 0xffff].includes(disk) || ![0, 0xffff].includes(directoryDisk))
    throw new Error('Spanned ZIP files are unsupported; choose independent ZIP parts');
  let entries = tail.getUint16(at + 10, true),
    bytes = tail.getUint32(at + 12, true),
    offset = tail.getUint32(at + 16, true);
  if (
    disk === 0xffff ||
    directoryDisk === 0xffff ||
    entries === 0xffff ||
    bytes === 0xffffffff ||
    offset === 0xffffffff
  ) {
    if (
      at < 20 ||
      tail.getUint32(at - 20, true) !== 0x07064b50 ||
      tail.getUint32(at - 16, true) !== 0 ||
      tail.getUint32(at - 4, true) !== 1
    )
      throw new Error('Invalid ZIP64 directory locator');
    const position = Number(tail.getBigUint64(at - 12, true));
    if (!Number.isSafeInteger(position) || position < 0 || position + 56 > tailStart + at - 20)
      throw new Error('Invalid ZIP64 directory position');
    const zip64 = new DataView(await file.slice(position, position + 56).arrayBuffer());
    if (
      zip64.byteLength !== 56 ||
      zip64.getUint32(0, true) !== 0x06064b50 ||
      zip64.getUint32(16, true) ||
      zip64.getUint32(20, true) ||
      zip64.getBigUint64(24, true) !== zip64.getBigUint64(32, true)
    )
      throw new Error('Invalid ZIP64 directory');
    entries = Number(zip64.getBigUint64(32, true));
    bytes = Number(zip64.getBigUint64(40, true));
    offset = Number(zip64.getBigUint64(48, true));
  }
  if (
    ![entries, bytes, offset].every(Number.isSafeInteger) ||
    entries > STREAM_IMPORT_LIMITS.maxEntries ||
    bytes > STREAM_IMPORT_LIMITS.maxCentralDirectoryBytes ||
    offset + bytes > tailStart + at
  )
    throw new Error('ZIP central directory limit exceeded');
  return bytes;
}
function recordSize(record: MemoryRecord): number {
  return (
    new TextEncoder().encode(
      JSON.stringify({
        ...record,
        attachments: record.attachments.map(({ bytes, ...a }) => ({ ...a, size: bytes.size })),
      }),
    ).length + record.attachments.reduce((n, a) => n + a.bytes.size, 0)
  );
}
/**
 * Metadata is indexed across independent ZIP parts. Only one bounded batch's media
 * is retained by this generator. Await saving each yield and release it before advancing.
 * Re-selecting the same parts produces the same record and batch identities.
 */
export async function* importArchiveBatches(
  files: File[],
  options: ArchiveImportOptions = {},
): AsyncGenerator<ArchiveImportBatch> {
  const limits = STREAM_IMPORT_LIMITS;
  const target = options.batchBytes ?? limits.batchBytes;
  if (!Number.isSafeInteger(target) || target < 1024 || target > limits.batchBytes)
    throw new Error('Invalid import batch size');
  if (
    !files.length ||
    files.length > limits.maxFiles ||
    files.reduce((n, f) => n + f.size, 0) > limits.maxInputBytes
  )
    throw new Error('Choose at most 64 ZIP parts totaling at most 10 GiB');
  const check = () => options.signal?.throwIfAborted();
  const counts: ImportCounts = {
    records: { imported: 0, skipped: 0 },
    messages: { imported: 0, skipped: 0 },
    attachments: { imported: 0, skipped: 0, missing: 0 },
    byKind: Object.fromEntries(
      ['post', 'photo', 'album', 'message', 'friend'].map((kind) => [
        kind,
        { imported: 0, skipped: 0 },
      ]),
    ) as ImportCounts['byKind'],
  };
  const progress: ImportProgress = {
    phase: 'index',
    indexedEntries: 0,
    declaredBytes: 0,
    decodedBytes: 0,
    residentMediaBytes: 0,
    peakResidentMediaBytes: 0,
    records: 0,
    batches: 0,
  };
  const notify = (phase: ImportProgress['phase']) => {
    progress.phase = phase;
    options.onProgress?.({ ...progress, counts: structuredClone(counts) });
  };
  const readers: ZipReader<Blob>[] = [];
  const temporary: ImportTemporaryFile[] = [];
  const nestedFiles = new WeakMap<Blob, Map<string, LegacyFile>>();
  const index = new Map<string, FileEntry[]>();
  const knownHashes = new WeakMap<FileEntry, string>();
  const used = new Set<string>();
  let pathBytes = 0,
    centralBytes = 0;
  let batch: MemoryRecord[] = [],
    batchBytes = 0;
  let warnings: string[] = [];
  const warning = (message: string) => {
    if (warnings.length < 100) warnings.push(message);
    else if (warnings.length === 100)
      warnings.push('Further import warnings were omitted; keep the original ZIP files.');
  };
  const snapshot = (): ArchiveImportBatch => {
    progress.batches++;
    notify('batch');
    const value = {
      records: batch,
      warnings,
      progress: { ...progress, counts: structuredClone(counts) },
    };
    batch = [];
    batchBytes = 0;
    warnings = [];
    progress.residentMediaBytes = 0;
    return value;
  };
  const read = async (entry: FileEntry, path: string): Promise<Blob> => {
    check();
    const cap = /\.json$/iu.test(path) ? ARCHIVE_LIMITS.maxJsonBytes : ARCHIVE_LIMITS.maxEntryBytes;
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    await entry.getData(
      new WritableStream<Uint8Array>({
        write(chunk) {
          check();
          size += chunk.byteLength;
          progress.decodedBytes += chunk.byteLength;
          if (size > cap || progress.decodedBytes > limits.maxDecodedBytes)
            throw new Error('Streaming decompression budget exceeded');
          chunks.push(new Uint8Array(chunk));
        },
      }),
      { signal: options.signal, checkSignature: true },
    );
    if (size !== entry.uncompressedSize) throw new Error('ZIP entry size mismatch');
    const blob = new Blob(chunks, { type: mediaMime(path) || 'application/json' });
    const fingerprint = await hash(blob),
      prior = knownHashes.get(entry);
    if (prior && prior !== fingerprint)
      throw new Error('Archive changed during import; retry unchanged ZIP files');
    knownHashes.set(entry, fingerprint);
    notify('read');
    return blob;
  };
  const readPath = async (path: string): Promise<Blob> => {
    const candidates = index.get(path)!;
    const blob = await read(candidates[0], path);
    used.add(path);
    return blob;
  };
  const indexZip = async (file: Blob, destination: Map<string, FileEntry[]>) => {
    check();
    centralBytes += await checkDirectory(file);
    if (centralBytes > limits.maxCentralDirectoryBytes)
      throw new Error('Combined ZIP central directory limit exceeded');
    const reader = new ZipReader(new BlobReader(file), { useWebWorkers: false });
    readers.push(reader);
    for await (const entry of reader.getEntriesGenerator()) {
      check();
      if (++progress.indexedEntries > limits.maxEntries)
        throw new Error('Archive entry limit exceeded');
      const path = safePath(entry.directory ? entry.filename.replace(/\/$/u, '') : entry.filename);
      pathBytes += new TextEncoder().encode(path).length;
      if (pathBytes > limits.maxPathBytes) throw new Error('Archive path metadata limit exceeded');
      const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
      if (entry.encrypted || mode === 0xa000 || (mode && mode !== 0x8000 && mode !== 0x4000))
        throw new Error('Encrypted archives and special files are unsupported');
      if (entry.directory) continue;
      if (/\.(?:html?|xhtml|svg|js|mjs|exe|dll|sh|bat|cmd|com|wasm)$/iu.test(path))
        throw new Error('HTML and executable media are unsupported');
      const cap = /\.json$/iu.test(path)
        ? ARCHIVE_LIMITS.maxJsonBytes
        : /(?:^|\/)private-archive\.zip$/u.test(path)
          ? limits.maxExpandedBytes
          : ARCHIVE_LIMITS.maxEntryBytes;
      progress.declaredBytes += entry.uncompressedSize;
      if (
        !Number.isSafeInteger(entry.uncompressedSize) ||
        entry.uncompressedSize < 0 ||
        !Number.isSafeInteger(entry.compressedSize) ||
        entry.compressedSize < 0 ||
        entry.uncompressedSize > cap ||
        progress.declaredBytes > limits.maxExpandedBytes ||
        entry.uncompressedSize > Math.max(entry.compressedSize, 1) * ARCHIVE_LIMITS.maxRatio
      )
        throw new Error('Archive expansion limit exceeded');
      const list = destination.get(path) ?? [];
      list.push(entry);
      destination.set(path, list);
    }
    notify('index');
  };
  try {
    for (const file of files) {
      if (!/\.zip$/iu.test(file.name)) throw new Error('Only JSON ZIP archives are supported');
      await indexZip(file, index);
    }
    const paths = [...index.keys()].sort();
    // All native exports retain their existing bounded, complete-validation path.
    if (paths.some((p) => /(?:^|\/)clean-bookface\.json$/u.test(p))) {
      const result = await importArchives(files, { signal: options.signal });
      for (const r of result.records) {
        const size = recordSize(r);
        if (size > target) throw new Error('One memory exceeds the import batch limit');
        if (batch.length && batchBytes + size > target) yield snapshot();
        batch.push(r);
        batchBytes += size;
        progress.records++;
        counts.records.imported++;
        counts.byKind[r.kind].imported++;
        counts.attachments.imported += r.attachments.length;
      }
      warnings = result.warnings;
      if (batch.length || warnings.length) yield snapshot();
      return;
    }

    // Authenticate duplicate paths before emitting ANY batch, even if unreferenced.
    for (const path of paths) {
      const duplicates = index.get(path)!;
      if (duplicates.length < 2) continue;
      let expected: string | undefined;
      for (const entry of duplicates) {
        await read(entry, path);
        const fingerprint = knownHashes.get(entry)!;
        if (expected !== undefined && expected !== fingerprint)
          throw new Error('Conflicting duplicate archive path');
        expected = fingerprint;
      }
    }
    if (paths.some((p) => /(?:^|\/)(?:account|manifest)\.json$/u.test(p))) {
      const lazy = (entries: Map<string, FileEntry[]>): Map<string, LegacyFile> =>
        new Map(
          [...entries].map(([path, candidates]) => {
            let staged: Blob | undefined;
            return [
              path,
              async () => {
                if (!/(?:^|\/)private-archive\.zip$/u.test(path)) return read(candidates[0], path);
                if (staged) return staged;
                if (candidates.length !== 1) throw new Error('Ambiguous nested legacy archive');
                const temp = await (options.openTemporaryFile ?? browserTemporaryFile)();
                temporary.push(temp);
                const scratch = await encryptedScratch(temp),
                  sink = scratch.writable.getWriter();
                let size = 0;
                try {
                  await candidates[0].getData(
                    new WritableStream<Uint8Array>({
                      write: async (chunk) => {
                        check();
                        size += chunk.length;
                        progress.decodedBytes += chunk.length;
                        if (
                          size > limits.maxExpandedBytes ||
                          progress.decodedBytes > limits.maxDecodedBytes
                        )
                          throw new Error('Streaming decompression budget exceeded');
                        await sink.write(chunk);
                      },
                    }),
                    { signal: options.signal, checkSignature: true },
                  );
                  if (size !== candidates[0].uncompressedSize)
                    throw new Error('ZIP entry size mismatch');
                  await sink.close();
                  staged = await scratch.blob();
                  return staged;
                } catch (error) {
                  await sink.abort(error).catch(() => {});
                  throw error;
                } finally {
                  sink.releaseLock();
                }
              },
            ];
          }),
        );
      const source = lazy(index);
      const dependencies = {
        limits: ARCHIVE_LIMITS,
        check,
        hash,
        safePath,
        timestamp,
        validateStructure,
        rejectExecutable,
        maxRecordMediaBytes: target,
        extract: async (blob: Blob) => {
          const previous = nestedFiles.get(blob);
          if (previous) return previous;
          const nested = new Map<string, FileEntry[]>();
          await indexZip(blob, nested);
          if ([...nested.values()].some((entries) => entries.length !== 1))
            throw new Error('Duplicate nested legacy path');
          if ([...nested.keys()].some((path) => /\.zip$/iu.test(path)))
            throw new Error('Unexpected legacy file or nested ZIP');
          const files = lazy(nested);
          nestedFiles.set(blob, files);
          return files;
        },
      };
      // Validate the complete source, including later revisions and unused media, before acceptance.
      for await (const _ of importLegacyRecords(source, { ...dependencies, validationOnly: true }))
        check();
      for await (const part of importLegacyRecords(source, {
        ...dependencies,
        mediaPrevalidated: true,
      })) {
        for (const record of part.records) {
          const size = recordSize(record);
          if (size > target) throw new Error('One legacy memory exceeds the import batch limit');
          if (batch.length && batchBytes + size > target) yield snapshot();
          batch.push(record);
          batchBytes += size;
          progress.records++;
          counts.records.imported++;
          counts.byKind[record.kind].imported++;
          counts.attachments.imported += record.attachments.length;
          progress.residentMediaBytes += record.attachments.reduce((n, a) => n + a.bytes.size, 0);
          progress.peakResidentMediaBytes = Math.max(
            progress.peakResidentMediaBytes,
            progress.residentMediaBytes,
          );
          // Release each legacy record before materializing the next lazy media set.
          yield snapshot();
        }
        for (const message of part.warnings) warning(message);
      }
      if (batch.length || warnings.length) yield snapshot();
      return;
    }
    if (paths.some((p) => /\.zip$/iu.test(p)))
      throw new Error('Nested Facebook ZIP files are unsupported');
    const ids = new Set<string>();
    for (const path of paths.filter((p) => /\.json$/iu.test(p))) {
      check();
      const rawJson = new TextDecoder('utf-8', { fatal: true }).decode(
        await (await readPath(path)).arrayBuffer(),
      );
      const value: unknown = JSON.parse(rawJson);
      validateStructure(value);
      if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.hasOwn(value, 'format')
      )
        throw new Error(
          'Declared portable formats require their standard manifest filename; unknown formats cannot be parsed as Facebook',
        );
      const parsed = parseFacebook(value, path, rawJson);
      if (!parsed.length) warning(`Unsupported or empty JSON: ${path}`);
      for (const item of parsed) {
        check();
        const id = await hash(item.sourceKey);
        if (ids.has(id)) throw new Error('Duplicate record identity');
        ids.add(id);
        if (ids.size > limits.maxRecords) throw new Error('Archive exceeds 50,000 logical records');
        const attachments: MemoryRecord['attachments'] = [];
        const record: MemoryRecord = {
          id,
          kind: item.kind,
          timestamp: item.occurredAt,
          text: item.body,
          title: item.title,
          sourcePath: path,
          attachments,
          privateOnly: item.kind === 'message' || item.kind === 'friend',
          provenance: await facebookProvenance(item.metadata),
        };
        let predicted = recordSize(record);
        const media: string[] = [];
        for (const raw of item.mediaPaths) {
          const medium = attachmentPath(raw, warning);
          if (!medium) {
            counts.attachments.skipped++;
            continue;
          }
          const entry = index.get(medium)?.[0];
          if (!entry) {
            counts.attachments.missing++;
            warning(`Missing media: ${medium}`);
            continue;
          }
          used.add(medium);
          predicted +=
            entry.uncompressedSize +
            new TextEncoder().encode(
              JSON.stringify({
                path: medium,
                mimeType: mediaMime(medium),
                size: entry.uncompressedSize,
              }),
            ).length +
            1;
          media.push(medium);
        }
        const messageCount = item.kind === 'message' ? Number(item.metadata.messageCount ?? 1) : 0;
        if (predicted > target) {
          counts.records.skipped++;
          counts.byKind[item.kind].skipped++;
          counts.messages.skipped += messageCount;
          counts.attachments.skipped += media.length;
          warning(
            `Skipped ${item.kind}: one memory exceeds the import batch limit in ${path}; retained in original ZIP.`,
          );
          continue;
        }
        if (batch.length && batchBytes + predicted > target) yield snapshot();
        for (const medium of media) {
          const bytes = await readPath(medium);
          await rejectExecutable(bytes);
          attachments.push({ path: medium, mimeType: mediaMime(medium), bytes });
          progress.residentMediaBytes += bytes.size;
          progress.peakResidentMediaBytes = Math.max(
            progress.peakResidentMediaBytes,
            progress.residentMediaBytes,
          );
        }
        const actual = recordSize(record);
        if (actual > predicted || batchBytes + actual > target)
          throw new Error('Import batch accounting mismatch');
        batch.push(record);
        batchBytes += actual;
        progress.records++;
        counts.records.imported++;
        counts.byKind[item.kind].imported++;
        counts.messages.imported += messageCount;
        counts.attachments.imported += attachments.length;
        notify('read');
      }
    }
    const unused = paths.filter((p) => mediaMime(p) && !used.has(p)).length;
    if (unused)
      warning(
        `${unused} unreferenced media file(s) remain in your original ZIP files and were not imported.`,
      );
    if (batch.length || warnings.length) yield snapshot();
  } finally {
    batch = [];
    index.clear();
    try {
      for (const reader of readers) await reader.close();
    } finally {
      for (const temp of temporary) await temp.remove();
    }
  }
}
