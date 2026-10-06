import test from 'node:test';
import assert from 'node:assert/strict';
import { BlobReader, BlobWriter, ZipWriter } from '@zip.js/zip.js';
import {
  importArchiveBatches,
  STREAM_IMPORT_LIMITS,
  type ImportProgress,
} from '../src/streaming-import.js';
import { importArchives, exportArchives } from '../src/archive.js';
async function zip(entries: Array<[string, string | Blob]>, name = 'part.zip') {
  const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
  for (const [path, value] of entries)
    await writer.add(path, new BlobReader(typeof value === 'string' ? new Blob([value]) : value), {
      level: 0,
    });
  return new File([await writer.close()], name);
}
async function fixture(count = 12) {
  const data = new Blob([new Uint8Array(8192).fill(65)], { type: 'image/jpeg' });
  const posts = Array.from({ length: count }, (_, i) => ({
    id: `photo-${i}`,
    timestamp: 1000 + i,
    data: [{ post: `Literal Café שלום ${i}` }],
    attachments: [{ uri: `photos/${i}.jpg` }],
  }));
  return {
    data,
    meta: await zip([['posts/your_posts_1.json', JSON.stringify(posts)]], 'metadata.zip'),
    media: await zip(
      posts.map((_, i) => [`photos/${i}.jpg`, data]),
      'media.zip',
    ),
  };
}
test('cross-part media is read on demand; batch retention stays bounded and retry identities stay stable', async () => {
  const f = await fixture(30),
    progress: ImportProgress[] = [];
  const options = { batchBytes: 24 * 1024, onProgress: (p: ImportProgress) => progress.push(p) };
  const generator = importArchiveBatches([f.media, f.meta], options);
  const first = await generator.next();
  assert.equal(first.done, false);
  assert.equal(first.value!.records.length, 2);
  assert.ok(
    first.value!.progress.decodedBytes < 30 * f.data.size,
    'first yield must not decode all media',
  );
  await generator.return(undefined);
  const records = [];
  let batches = 0;
  for await (const batch of importArchiveBatches([f.meta, f.media], options)) {
    records.push(...batch.records);
    batches++;
  }
  assert.equal(records.length, 30);
  assert.equal(batches, 15);
  assert.deepEqual(records.slice(0, 2), first.value!.records);
  assert.ok(Math.max(...progress.map((p) => p.peakResidentMediaBytes)) <= 24 * 1024);
  assert.deepEqual(
    records.map(({ attachments, ...r }) => r),
    (await importArchives([f.meta, f.media])).records.map(({ attachments, ...r }) => r),
  );
});
test('conflicting duplicate paths are refused before any yield, while identical parts deduplicate', async () => {
  const f = await fixture(1);
  const conflict = await zip([['photos/0.jpg', new Blob([new Uint8Array(8192).fill(66)])]]);
  await assert.rejects(
    importArchiveBatches([f.meta, f.media, conflict]).next(),
    /Conflicting duplicate/,
  );
  let count = 0;
  for await (const batch of importArchiveBatches([f.meta, f.media, f.media]))
    count += batch.records.length;
  assert.equal(count, 1);
});
test('corrupt media CRC, malicious directory allocation, invalid structure and unknown formats fail closed', async () => {
  const f = await fixture(1),
    bytes = new Uint8Array(await f.media.arrayBuffer());
  const buffer = Buffer.from(bytes),
    at = buffer.indexOf(Buffer.alloc(200, 65));
  assert.ok(at > 0);
  bytes[at] ^= 1;
  await assert.rejects(
    importArchiveBatches([f.meta, new File([bytes], 'corrupt.zip')]).next(),
    /signature|checksum|CRC32/i,
  );
  const central = new Uint8Array(await f.meta.arrayBuffer());
  new DataView(central.buffer).setUint32(central.length - 22 + 12, 0x7fffffff, true);
  await assert.rejects(
    importArchiveBatches([new File([central], 'huge-directory.zip')]).next(),
    /central directory limit/,
  );
  let deep: unknown = {};
  for (let i = 0; i < 70; i++) deep = { nested: deep };
  await assert.rejects(
    importArchiveBatches([await zip([['posts.json', JSON.stringify(deep)]])]).next(),
    /structure limit/,
  );
  await assert.rejects(
    importArchiveBatches([
      await zip([
        ['posts.json', JSON.stringify({ format: 'unknown/1', posts: [{ post: 'do not parse' }] })],
      ]),
    ]).next(),
    /unknown formats/,
  );
});
test('missing media and oversized record skips stay explicit; cancellation aborts', async () => {
  const f = await fixture(1);
  const missing = [];
  for await (const batch of importArchiveBatches([f.meta])) missing.push(...batch.warnings);
  assert.match(missing.join(' '), /Missing media: photos\/0.jpg/);
  const skipped = await importArchiveBatches([f.meta, f.media], { batchBytes: 1024 }).next();
  assert.equal(skipped.value?.records.length, 0);
  assert.equal(skipped.value?.progress.counts?.records.skipped, 1);
  assert.match(skipped.value?.warnings.join(' ') ?? '', /exceeds the import batch limit/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    importArchiveBatches([f.meta, f.media], { signal: controller.signal }).next(),
    /aborted/i,
  );
});
test('canonical portable imports preserve their existing validation and records', async () => {
  const f = await fixture(1),
    original = await importArchives([f.meta, f.media]);
  const file = new File([await exportArchives(original.records)], 'private.zip');
  const records = [];
  for await (const batch of importArchiveBatches([file])) records.push(...batch.records);
  assert.deepEqual(records, original.records);
  assert.equal(STREAM_IMPORT_LIMITS.maxInputBytes, 10 * 1024 ** 3);
});

test('oversized entries and forged ZIP64 directory metadata are rejected before decompression', async () => {
  const f = await fixture(1);
  const bytes = new Uint8Array(await f.media.arrayBuffer());
  const central = Buffer.from(bytes).indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(central > 0);
  new DataView(bytes.buffer).setUint32(central + 24, 65 * 1024 * 1024, true);
  await assert.rejects(
    importArchiveBatches([f.meta, new File([bytes], 'oversized.zip')]).next(),
    /expansion limit/,
  );
  const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false, zip64: true });
  await writer.add('posts.json', new BlobReader(new Blob(['[]'])), { level: 0 });
  const valid = new Uint8Array(await (await writer.close()).arrayBuffer());
  const zip64 = Buffer.from(valid).indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06]));
  assert.ok(zip64 > 0);
  new DataView(valid.buffer).setBigUint64(zip64 + 40, 65n * 1024n * 1024n, true);
  await assert.rejects(
    importArchiveBatches([new File([valid], 'zip64.zip')]).next(),
    /central directory limit/,
  );
});

test('abort after an accepted batch stops reading and re-selection resumes with identical first-batch IDs', async () => {
  const f = await fixture(12),
    controller = new AbortController();
  const generator = importArchiveBatches([f.meta, f.media], {
    batchBytes: 24 * 1024,
    signal: controller.signal,
  });
  const first = await generator.next();
  controller.abort();
  await assert.rejects(generator.next(), /aborted/i);
  const retry = importArchiveBatches([f.media, f.meta], { batchBytes: 24 * 1024 });
  const again = await retry.next();
  assert.deepEqual(
    first.value?.records.map((r: { id: string }) => r.id),
    again.value?.records.map((r: { id: string }) => r.id),
  );
  await retry.return(undefined);
});
