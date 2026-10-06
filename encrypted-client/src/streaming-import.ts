import { BlobReader, ZipReader, type FileEntry } from '@zip.js/zip.js';
import {
  ARCHIVE_LIMITS,
  importArchives,
  parseFacebook,
  validateStructure,
  safePath,
  mediaMime,
  hash,
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
export interface ImportProgress {
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
export interface ArchiveImportOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ImportProgress) => void;
  batchBytes?: number;
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
    options.onProgress?.({ ...progress });
  };
  const readers: ZipReader<Blob>[] = [];
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
    const value = { records: batch, warnings, progress: { ...progress } };
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
  try {
    for (const file of files) {
      check();
      if (!/\.zip$/iu.test(file.name)) throw new Error('Only JSON ZIP archives are supported');
      centralBytes += await checkDirectory(file);
      if (centralBytes > limits.maxCentralDirectoryBytes)
        throw new Error('Combined ZIP central directory limit exceeded');
      const reader = new ZipReader(new BlobReader(file), { useWebWorkers: false });
      readers.push(reader);
      for await (const entry of reader.getEntriesGenerator()) {
        check();
        if (++progress.indexedEntries > limits.maxEntries)
          throw new Error('Archive entry limit exceeded');
        const path = safePath(
          entry.directory ? entry.filename.replace(/\/$/u, '') : entry.filename,
        );
        pathBytes += new TextEncoder().encode(path).length;
        if (pathBytes > limits.maxPathBytes)
          throw new Error('Archive path metadata limit exceeded');
        const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
        if (entry.encrypted || mode === 0xa000 || (mode && mode !== 0x8000 && mode !== 0x4000))
          throw new Error('Encrypted archives and special files are unsupported');
        if (entry.directory) continue;
        if (/\.(?:html?|xhtml|svg|js|mjs|exe|dll|sh|bat|cmd|com|wasm)$/iu.test(path))
          throw new Error('HTML and executable media are unsupported');
        const cap = /\.json$/iu.test(path)
          ? ARCHIVE_LIMITS.maxJsonBytes
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
        const list = index.get(path) ?? [];
        list.push(entry);
        index.set(path, list);
      }
      notify('index');
    }
    const paths = [...index.keys()].sort();
    // All native exports retain their existing bounded, complete-validation path.
    if (paths.some((p) => /(?:^|\/)(?:account|manifest|clean-bookface)\.json$/u.test(p))) {
      const result = await importArchives(files, { signal: options.signal });
      for (const r of result.records) {
        const size = recordSize(r);
        if (size > target) throw new Error('One memory exceeds the import batch limit');
        if (batch.length && batchBytes + size > target) yield snapshot();
        batch.push(r);
        batchBytes += size;
        progress.records++;
      }
      warnings = result.warnings;
      if (batch.length || warnings.length) yield snapshot();
      return;
    }
    if (paths.some((p) => /\.zip$/iu.test(p)))
      throw new Error('Nested Facebook ZIP files are unsupported');
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
    const ids = new Set<string>();
    for (const path of paths.filter((p) => /\.json$/iu.test(p))) {
      check();
      const value: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          await (await readPath(path)).arrayBuffer(),
        ),
      );
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
      const parsed = parseFacebook(value, path);
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
          provenance: item.metadata,
        };
        let predicted = recordSize(record);
        const media: string[] = [];
        for (const raw of item.mediaPaths) {
          const medium = safePath(raw);
          if (!mediaMime(medium)) throw new Error('Unsupported media type');
          const entry = index.get(medium)?.[0];
          if (!entry) {
            warning(`Missing media: ${medium}`);
            continue;
          }
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
        if (predicted > target)
          throw new Error(
            'One memory exceeds the import batch limit; keep the original ZIP and import a smaller export',
          );
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
    for (const reader of readers) await reader.close();
  }
}
