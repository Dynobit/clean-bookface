import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir, statfs } from 'node:fs/promises';
import { resolve, relative, dirname, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import yauzl from 'yauzl';
import type { ArchiveLimits } from './types.js';

export class ArchiveAdmissionError extends Error {}
export function archiveFileLimit(
  name: string,
  limits: Pick<ArchiveLimits, 'maxFileBytes' | 'maxJsonBytes' | 'maxCompressedBytes'>,
): number {
  const lower = name.toLowerCase();
  return lower.endsWith('.zip')
    ? limits.maxCompressedBytes
    : lower.endsWith('.json')
      ? Math.min(limits.maxFileBytes, limits.maxJsonBytes)
      : limits.maxFileBytes;
}
export const portablePathKey = (name: string): string => name.normalize('NFC').toLowerCase();

export function safeRelative(value: string): string {
  if (!value || value.length > 2048 || /[\x00-\x1f\x7f\\:]/u.test(value) || value.startsWith('/'))
    throw new Error('Unsafe archive path');
  const parts = value.replace(/\/$/u, '').split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || Buffer.byteLength(p) > 255))
    throw new Error('Unsafe archive path');
  return parts.join('/');
}
export function beneath(root: string, path: string): boolean {
  const r = relative(resolve(root), resolve(path));
  return r !== '' && r !== '..' && !r.startsWith(`..${sep}`) && !r.startsWith(sep);
}
export async function diskSpace(root: string, needed: number): Promise<void> {
  const fs = await statfs(root);
  if (fs.bavail * fs.bsize < needed + 64 * 1024 ** 2)
    throw new ArchiveAdmissionError('Not enough free storage for this import');
}
export async function scanDirectory(
  root: string,
  limits: ArchiveLimits,
  check: () => void,
): Promise<Map<string, string>> {
  if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink())
    throw new Error('Import must be a private staged directory');
  const files = new Map<string, string>();
  let total = 0;
  let entries = 0;
  const names = new Set<string>();
  async function walk(dir: string, depth: number): Promise<void> {
    check();
    if (depth > limits.maxDepth) throw new Error('Archive nesting limit exceeded');
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      check();
      if (++entries > limits.maxFiles) throw new Error('Archive file count limit exceeded');
      const path = resolve(dir, entry.name);
      const name = safeRelative(relative(root, path).split(sep).join('/'));
      const key = portablePathKey(name);
      if (names.has(key)) throw new Error('Archive contains case or Unicode equivalent paths');
      names.add(key);
      const s = await lstat(path);
      if (s.isSymbolicLink() || (!s.isDirectory() && !s.isFile()))
        throw new Error('Archive links and special files are not allowed');
      if (s.isDirectory()) await walk(path, depth + 1);
      else {
        if (s.size > archiveFileLimit(name, limits))
          throw new Error('Archive file size limit exceeded');
        total += s.size;
        if (total > limits.maxExpandedBytes)
          throw new Error('Archive expanded size limit exceeded');
        files.set(name, path);
      }
    }
  }
  await walk(resolve(root), 0);
  await diskSpace(root, total);
  return files;
}
export async function extractZip(
  input: string,
  destination: string,
  limits: ArchiveLimits,
  check: () => void,
): Promise<void> {
  const info = await lstat(input);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limits.maxCompressedBytes)
    throw new Error('Invalid ZIP or compressed size limit exceeded');
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await diskSpace(destination, info.size * 2);
  return new Promise((accept, reject) => {
    yauzl.open(
      input,
      { lazyEntries: true, autoClose: true, validateEntrySizes: true, strictFileNames: true },
      (error, zip) => {
        if (error || !zip) {
          reject(new Error('The ZIP could not be read'));
          return;
        }
        let count = 0;
        let expanded = 0;
        const names = new Set<string>();
        let failed = false;
        const fail = (e: unknown) => {
          if (!failed) {
            failed = true;
            zip.close();
            reject(e);
          }
        };
        zip.on('error', fail);
        zip.on('end', () => {
          if (!failed) accept();
        });
        zip.on('entry', (entry) => {
          void (async () => {
            check();
            const name = safeRelative(entry.fileName);
            const parts = name.split('/');
            if (++count > limits.maxFiles || parts.length > limits.maxDepth)
              throw new Error('Archive file count or nesting limit exceeded');
            if (names.has(portablePathKey(name)))
              throw new Error('ZIP contains a duplicate or equivalent path');
            names.add(portablePathKey(name));
            const unixType = (entry.externalFileAttributes >>> 16) & 0xf000;
            if (unixType && unixType !== 0x8000 && unixType !== 0x4000)
              throw new Error('Archive links and special files are not allowed');
            if (entry.generalPurposeBitFlag & 1)
              throw new Error('Encrypted ZIP archives are unsupported');
            if (entry.uncompressedSize > archiveFileLimit(name, limits))
              throw new Error('Archive file size limit exceeded');
            expanded += entry.uncompressedSize;
            if (
              expanded > limits.maxExpandedBytes ||
              entry.uncompressedSize >
                Math.max(1024 * 1024, entry.compressedSize * limits.maxCompressionRatio)
            )
              throw new Error('Archive expansion limit exceeded');
            const path = resolve(destination, name);
            if (!beneath(destination, path)) throw new Error('Unsafe archive path');
            if (entry.fileName.endsWith('/')) {
              await mkdir(path, { recursive: true, mode: 0o700 });
              zip.readEntry();
              return;
            }
            await diskSpace(destination, entry.uncompressedSize);
            await mkdir(dirname(path), { recursive: true, mode: 0o700 });
            const stream = await new Promise<import('node:stream').Readable>((yes, no) =>
              zip.openReadStream(entry, (e, s) => (e || !s ? no(e) : yes(s))),
            );
            let bytes = 0;
            const budget = new Transform({
              transform(chunk: Buffer, _encoding, cb) {
                try {
                  check();
                  bytes += chunk.length;
                  if (bytes > entry.uncompressedSize || bytes > archiveFileLimit(name, limits))
                    throw new Error('Archive expansion limit exceeded');
                  cb(null, chunk);
                } catch (e) {
                  cb(e as Error);
                }
              },
            });
            await pipeline(stream, budget, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
            zip.readEntry();
          })().catch(fail);
        });
        zip.readEntry();
      },
    );
  });
}
export function boundedRead(path: string, bytes: number): Promise<Buffer> {
  return new Promise((yes, no) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const stream = createReadStream(path);
    stream.on('data', (chunk) => {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += b.length;
      if (size > bytes) stream.destroy(new Error('File size limit exceeded'));
      else chunks.push(b);
    });
    stream.on('error', no);
    stream.on('end', () => yes(Buffer.concat(chunks)));
  });
}
