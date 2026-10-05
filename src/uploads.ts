import Busboy from 'busboy';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { mkdir, mkdtemp, rm, open } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { CoreError } from './core.js';
import { MAX_PATH_ENTRIES, MAX_EMPTY_FILES } from './chunk-uploads.js';
import { DEFAULT_LIMITS, type ArchiveLimits } from './archive/types.js';
import { archiveFileLimit, portablePathKey, safeRelative } from './archive/input.js';

export interface Upload {
  root: string;
  files: { path: string; name: string; mime: string }[];
  fields: Record<string, string>;
}
/** Stream into a private staging directory; client filenames never choose a host path. */
export async function stageUpload(
  request: Request,
  dataDir: string,
  maxBytes: number,
  maxFiles = 20000,
  options: { limits?: Partial<ArchiveLimits>; signal?: AbortSignal } = {},
): Promise<Upload> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  options.signal?.throwIfAborted();
  if (!request.body) throw new CoreError(400, 'Choose files to upload.');
  const parent = join(dataDir, 'incoming');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(parent, 'upload-'));
  const files: Upload['files'] = [],
    fields: Upload['fields'] = {},
    pending: Promise<void>[] = [];
  let failed: Error | undefined,
    total = 0,
    emptyFiles = 0;
  const names = new Set<string>(),
    directories = new Set<string>(),
    entries = new Set<string>();
  let workQueue = Promise.resolve();
  const abort = (message: string) => {
    failed ??= new CoreError(400, message);
  };
  try {
    const parser = Busboy({
      headers: Object.fromEntries(request.headers),
      preservePath: true,
      defParamCharset: 'utf8',
      limits: {
        files: maxFiles,
        fileSize: maxBytes,
        fields: 30,
        fieldSize: 16384,
        parts: maxFiles + 30,
      },
    });
    parser.on('field', (name, value, info) => {
      if (info.valueTruncated || info.nameTruncated) abort('An upload field is too long.');
      else fields[name] = value;
    });
    parser.on('filesLimit', () => abort('Too many files in this upload.'));
    parser.on('fieldsLimit', () => abort('Too many form fields.'));
    parser.on('partsLimit', () => abort('Too many upload parts.'));
    parser.on('file', (_name, file, info) => {
      file.on('error', (error) => {
        failed ??= error;
      });
      if (failed) {
        file.resume();
        return;
      }
      let name: string;
      try {
        if (info.filename.endsWith('/')) throw new Error('file path');
        name = safeRelative(info.filename);
        if (name.split('/').length > limits.maxDepth) throw new Error('depth');
      } catch {
        abort('A file has an unsafe path or a name longer than 255 bytes.');
        file.resume();
        return;
      }
      const key = portablePathKey(name);
      const path = resolve(root, name);
      if (!path.startsWith(root + sep) || names.has(key)) {
        abort('Duplicate or unsafe file path.');
        file.resume();
        return;
      }
      const pieces = key.split('/');
      if (
        directories.has(key) ||
        pieces.some((_piece, i) => i > 0 && names.has(pieces.slice(0, i).join('/')))
      ) {
        abort('A file and folder have the same path.');
        file.resume();
        return;
      }
      names.add(key);
      for (let i = 1; i <= pieces.length; i++) {
        const entry = pieces.slice(0, i).join('/');
        entries.add(entry);
        if (i < pieces.length) directories.add(entry);
        if (entries.size > MAX_PATH_ENTRIES) {
          abort('This upload has too many files and folders.');
          file.resume();
          return;
        }
      }
      files.push({ path, name, mime: info.mimeType });
      file.on('limit', () => abort('A file exceeds the upload limit.'));
      // Serialize filesystem work; tiny multipart parts must not open thousands
      // of files concurrently. Do not create paths until a file has actual data.
      file.pause();
      const work = workQueue.then(async () => {
        if (failed) {
          file.resume();
          return;
        }
        let handle: Awaited<ReturnType<typeof open>> | undefined;
        let bytes = 0;
        try {
          for await (const chunk of file) {
            if (failed) continue;
            bytes += chunk.length;
            if (bytes > archiveFileLimit(name, limits)) {
              const error = new CoreError(
                413,
                'A file exceeds the archive limit for its type. Choose a smaller export part or media file.',
              );
              failed ??= error;
              file.destroy(error);
              parser.destroy(error);
              throw error;
            }
            if (!handle) {
              await mkdir(dirname(path), { recursive: true, mode: 0o700 });
              handle = await open(path, 'wx', 0o600);
            }
            let offset = 0;
            while (offset < chunk.length)
              offset += (await handle.write(chunk, offset, chunk.length - offset)).bytesWritten;
          }
          if (!bytes && !failed) {
            if (++emptyFiles > MAX_EMPTY_FILES) {
              abort('Choose at most 64 empty files in one upload.');
              return;
            }
            await mkdir(dirname(path), { recursive: true, mode: 0o700 });
            handle = await open(path, 'wx', 0o600);
          }
        } finally {
          await handle?.close();
        }
      });
      workQueue = work.catch(() => {});
      work.catch((error) => {
        failed ??= error;
      });
      pending.push(work);
    });
    const bound = new Transform({
      transform(chunk, _enc, callback) {
        total += chunk.length;
        if (total > maxBytes)
          callback(new CoreError(413, 'This upload exceeds the host’s upload allowance.'));
        else callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(request.body as never), bound, parser, {
      signal: options.signal,
    });
    await Promise.all(pending);
    if (failed) throw failed;
    if (!files.length) throw new CoreError(400, 'Choose at least one file.');
    return { root, files, fields };
  } catch (error) {
    await Promise.allSettled(pending);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
