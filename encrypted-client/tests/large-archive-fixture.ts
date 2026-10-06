import { open, readFile, stat, statfs } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { BlobReader, ZipWriter } from '@zip.js/zip.js';
/** Actual stored ZIP bytes on disk, not forged declared sizes or a compressed zero bomb. */
export async function largeArchiveFixture(directory: string, payloadBytes: number) {
  if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 1 || payloadBytes > 10_000_000_000)
    throw new Error('Invalid qualification size');
  const space = await statfs(directory);
  if (space.bavail * space.bsize < payloadBytes + 5 * 1024 ** 3)
    throw new Error('Insufficient free space for bounded large-import fixture');
  const photo = await readFile(
    new URL(
      '../../tests/fixtures/synthetic/facebook/photos/synthetic-postcard.png',
      import.meta.url,
    ),
  );
  const chunkBytes = 16 * 1024 ** 2;
  const sample = Buffer.alloc(chunkBytes, 71);
  photo.copy(sample);
  const path = join(directory, 'large-facebook.zip');
  const file = await open(path, 'wx', 0o600);
  const writer = new ZipWriter(
    new WritableStream<Uint8Array>({
      write: async (chunk) => {
        await file.writeFile(chunk);
      },
    }),
    { useWebWorkers: false, zip64: true },
  );
  const expected = new Map<string, { text: string; sha256: string; size: number; path: string }>();
  const posts = [];
  const hashes = new Map<number, string>();
  try {
    for (let offset = 0, i = 0; offset < payloadBytes; i++) {
      const size = Math.min(chunkBytes, payloadBytes - offset),
        bytes = sample.subarray(0, size),
        mediaPath = `photos/${String(i).padStart(5, '0')}.png`;
      const text = `SYNTHETIC_LARGE_IMPORT_${i}`;
      await writer.add(mediaPath, new BlobReader(new Blob([bytes])), { level: 0 });
      const sha256 = hashes.get(size) ?? createHash('sha256').update(bytes).digest('hex');
      hashes.set(size, sha256);
      const id = createHash('sha256').update(`post\0posts\0id:large-${i}`).digest('hex');
      expected.set(id, { text, sha256, size, path: mediaPath });
      posts.push({
        id: `large-${i}`,
        timestamp: 946684800 + i,
        data: [{ post: text }],
        attachments: [{ uri: mediaPath }],
      });
      offset += size;
    }
    await writer.add('posts/your_posts_1.json', new BlobReader(new Blob([JSON.stringify(posts)])), {
      level: 0,
    });
    await writer.close();
  } finally {
    await file.close();
  }
  return { path, expected, payloadBytes, zipBytes: (await stat(path)).size };
}

/** Node 26 openAsBlob truncates files >4 GiB; this qualification-only adapter reads actual disk ranges. */
export async function diskBackedFixtureFile(path: string): Promise<File> {
  const metadata = await stat(path);
  class DiskRange extends Blob {
    constructor(
      private start: number,
      private length: number,
    ) {
      super([]);
      Object.defineProperty(this, 'size', { value: length });
    }
    override slice(start = 0, end = this.length, type = ''): Blob {
      const clamp = (n: number) => Math.min(this.length, Math.max(0, n < 0 ? this.length + n : n));
      const begin = clamp(start),
        finish = clamp(end);
      const blob = new DiskRange(this.start + begin, Math.max(0, finish - begin));
      Object.defineProperty(blob, 'type', { value: type });
      return blob;
    }
    override async arrayBuffer(): Promise<ArrayBuffer> {
      if (this.length > 64 * 1024 ** 2)
        throw new Error('Qualification adapter refuses unbounded whole-file reads');
      const file = await open(path, 'r');
      const bytes = new Uint8Array(this.length);
      try {
        let done = 0;
        while (done < bytes.length) {
          const { bytesRead } = await file.read(
            bytes,
            done,
            bytes.length - done,
            this.start + done,
          );
          if (!bytesRead) throw new Error('Truncated qualification file');
          done += bytesRead;
        }
        return bytes.buffer;
      } finally {
        await file.close();
      }
    }
    override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
      const start = this.start,
        length = this.length;
      let offset = 0;
      let file: Awaited<ReturnType<typeof open>> | undefined;
      return new ReadableStream({
        async pull(controller) {
          file ??= await open(path, 'r');
          if (offset >= length) {
            await file.close();
            file = undefined;
            controller.close();
            return;
          }
          const bytes = new Uint8Array(Math.min(256 * 1024, length - offset));
          const { bytesRead } = await file.read(bytes, 0, bytes.length, start + offset);
          if (!bytesRead) throw new Error('Truncated qualification file');
          offset += bytesRead;
          controller.enqueue(bytes.subarray(0, bytesRead));
        },
        async cancel() {
          await file?.close();
          file = undefined;
        },
      });
    }
  }
  const file = new DiskRange(0, metadata.size);
  Object.defineProperties(file, {
    name: { value: 'large.zip' },
    lastModified: { value: metadata.mtimeMs },
    webkitRelativePath: { value: '' },
  });
  return file as unknown as File;
}

/** v0.1 archive/account formats, with actual disk-backed bytes and deterministic original IDs. */
export async function largeLegacyArchiveFixture(directory: string, payloadBytes: number) {
  if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 1 || payloadBytes > 4 * 1024 ** 3)
    throw new Error('Invalid legacy qualification size');
  const space = await statfs(directory);
  if (space.bavail * space.bsize < payloadBytes * 3 + 5 * 1024 ** 3)
    throw new Error('Insufficient disk space for encrypted nested-archive qualification');
  const path = join(directory, 'legacy-archive.zip'),
    accountPath = join(directory, 'legacy-account.zip');
  const archive = await open(path, 'wx', 0o600);
  const writer = new ZipWriter(
    new WritableStream<Uint8Array>({
      write: async (chunk) => {
        await archive.writeFile(chunk);
      },
    }),
    { useWebWorkers: false, zip64: true },
  );
  const media = [],
    rows = [],
    expected = new Map<string, { sha256: string; size: number }>();
  const sample = Buffer.alloc(16 * 1024 ** 2, 71);
  // Level zero makes these actual 2 GiB bytes, never a compression-ratio bypass.
  try {
    for (let offset = 0, i = 0; offset < payloadBytes; i++) {
      const size = Math.min(sample.length, payloadBytes - offset),
        id = `legacy-${i}`,
        mediaId = `media-${i}`;
      sample.writeUInt32BE(i, 8);
      const bytes = sample.subarray(0, size),
        sha256 = createHash('sha256').update(bytes).digest('hex');
      const file = `media/${mediaId}.original`;
      await writer.add(file, new BlobReader(new Blob([bytes])), { level: 0 });
      media.push({ id: mediaId, file, purpose: 'original', mime: 'image/jpeg', size, sha256 });
      rows.push({
        id,
        sourceKey: createHash('sha256').update(id).digest('hex'),
        kind: 'photo',
        version: 1,
        body: `SYNTHETIC_LEGACY_${i}`,
        title: '',
        source: 'synthetic/photos.json',
        occurredAt: 946684800000 + i,
        importedAt: 1000,
        mediaIds: [mediaId],
        metadata: {},
      });
      expected.set(id, { sha256, size });
      offset += size;
    }
    await writer.add(
      'manifest.json',
      new BlobReader(new Blob([JSON.stringify({ format: 'clean-bookface-archive/1', media })])),
      { level: 0 },
    );
    await writer.add(
      'archive.ndjson',
      new BlobReader(new Blob([rows.map((row) => JSON.stringify(row)).join('\n')])),
      { level: 0 },
    );
    await writer.add('revisions.ndjson', new BlobReader(new Blob([])), { level: 0 });
    await writer.close();
  } finally {
    await archive.close();
  }
  const outer = await open(accountPath, 'wx', 0o600);
  const accountWriter = new ZipWriter(
    new WritableStream<Uint8Array>({
      write: async (chunk) => {
        await outer.writeFile(chunk);
      },
    }),
    { useWebWorkers: false, zip64: true },
  );
  try {
    await accountWriter.add(
      'account.json',
      new BlobReader(
        new Blob([
          JSON.stringify({
            format: 'clean-bookface-account/1',
            account: { actor: 'https://example.org/synthetic' },
            publications: [],
            comments: [],
          }),
        ]),
      ),
      { level: 0 },
    );
    await accountWriter.add(
      'private-archive.zip',
      new BlobReader(await diskBackedFixtureFile(path)),
      { level: 0 },
    );
    await accountWriter.close();
  } finally {
    await outer.close();
  }
  return { path: accountPath, expected, payloadBytes, zipBytes: (await stat(accountPath)).size };
}
