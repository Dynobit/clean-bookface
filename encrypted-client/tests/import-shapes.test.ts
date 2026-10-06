import test from 'node:test';
import assert from 'node:assert/strict';
import { BlobReader, BlobWriter, ZipWriter } from '@zip.js/zip.js';
import { importArchiveBatches } from '../src/streaming-import.js';
import { importArchives } from '../src/archive.js';
async function zip(entries: Array<[string, string | Blob]>) {
  const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
  for (const [path, value] of entries)
    await writer.add(path, new BlobReader(typeof value === 'string' ? new Blob([value]) : value), {
      level: 0,
    });
  return new File([await writer.close()], 'synthetic.zip');
}
async function collect(file: File, batchBytes?: number) {
  const records = [],
    warnings = [];
  let progress;
  for await (const batch of importArchiveBatches([file], { batchBytes })) {
    records.push(...batch.records);
    warnings.push(...batch.warnings);
    progress = batch.progress;
  }
  return { records, warnings, progress };
}
test('500-photo album retains references without duplicating the album media and retries identically', async () => {
  const photos = Array.from({ length: 500 }, (_, i) => ({ id: `p${i}`, uri: `photos/${i}.jpg` }));
  const input = await zip([
    ['albums.json', JSON.stringify({ albums: [{ name: 'Synthetic album', photos }] })],
    ...photos.map((p): [string, Blob] => [p.uri, new Blob([new Uint8Array(1024).fill(65)])]),
  ]);
  const first = await collect(input, 64 * 1024),
    again = await collect(input, 64 * 1024);
  assert.equal(first.records.length, 501);
  assert.equal(first.records[0].attachments.length, 0);
  assert.equal(
    first.records.reduce((n, r) => n + r.attachments.reduce((n, a) => n + a.bytes.size, 0), 0),
    500 * 1024,
  );
  assert.deepEqual(
    first.records[0].provenance?.photoRecordIds,
    first.records.slice(1).map((r) => r.id),
  );
  assert.deepEqual(
    first.records.map((r) => r.id),
    again.records.map((r) => r.id),
  );
});
test('mixed missing, unsupported and absolute references preserve the valid record and local media', async () => {
  const input = await zip([
    [
      'posts.json',
      JSON.stringify([
        {
          id: 'mixed',
          post: 'Keep this',
          attachments: [
            { uri: 'photo.jpg' },
            { uri: 'document.pdf' },
            { uri: 'missing.jpg' },
            { uri: 'https://example.invalid/photo.jpg' },
          ],
        },
      ]),
    ],
    ['photo.jpg', new Blob(['photo bytes'])],
    ['document.pdf', new Blob(['%PDF synthetic'])],
  ]);
  const result = await collect(input);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].attachments.length, 1);
  assert.match(result.warnings.join(' '), /Unsupported.*document.pdf/);
  assert.match(result.warnings.join(' '), /External.*https:/);
  assert.match(result.warnings.join(' '), /Missing media/);
  assert.deepEqual(result.progress?.counts?.attachments, { imported: 1, skipped: 2, missing: 1 });
  assert.deepEqual(result.progress?.counts?.byKind.post, { imported: 1, skipped: 0 });
});
test('200k messages across 30 threads become bounded private chunks with every original preserved', async () => {
  const entries: Array<[string, string]> = [];
  let total = 0;
  for (let thread = 0; thread < 30; thread++) {
    const count = thread === 29 ? 200000 - total : 6666;
    entries.push([
      `messages/thread_${thread}/message_1.json`,
      JSON.stringify({
        title: `Thread ${thread}`,
        messages: Array.from({ length: count }, (_, i) => ({
          message_id: `m${thread}-${i}`,
          timestamp_ms: i + 1,
          sender_name: 'Synthetic person',
          content: `Message ${i}`,
        })),
      }),
    ]);
    total += count;
  }
  const result = await collect(await zip(entries));
  assert.ok(result.records.length < 5000);
  assert.deepEqual(result.progress?.counts?.messages, { imported: 200000, skipped: 0 });
  assert.ok(result.records.every((r) => r.privateOnly && r.kind === 'message'));
  assert.equal(
    result.records.reduce((n, r) => n + (r.provenance?.messageCount as number), 0),
    200000,
  );
  assert.equal(
    new Set(
      result.records.flatMap((r) => (r.provenance!.original as any[]).map((m) => m.message_id)),
    ).size,
    200000,
  );
});
test('Latin1 escaped UTF8 is repaired for display while exact raw provenance and legitimate Unicode survive', async () => {
  const good = 'Café שלום 😀';
  const escaped = [...new TextEncoder().encode(good)]
    .map((b) => (b < 128 ? String.fromCharCode(b) : `\\u00${b.toString(16).padStart(2, '0')}`))
    .join('');
  const input = await zip([
    [
      'posts.json',
      `[{"id":"escaped","post":"${escaped}"},{"id":"literal","post":${JSON.stringify(good)}},{"id":"latin1","post":"Ã and é"}]`,
    ],
  ]);
  for (const records of [(await collect(input)).records, (await importArchives([input])).records]) {
    assert.equal(records[0].text, good);
    assert.notEqual((records[0].provenance!.original as any).post, good);
    assert.equal(records[1].text, good);
    assert.equal(records[2].text, 'Ã and é');
  }
});

test('oversized source records are counted once and later valid records still import', async () => {
  const input = await zip([
    [
      'posts.json',
      JSON.stringify([
        { id: 'big', post: 'x'.repeat(3000) },
        { id: 'small', post: 'Keep me' },
      ]),
    ],
  ]);
  const result = await collect(input, 1024);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].text, 'Keep me');
  assert.deepEqual(result.progress?.counts?.records, { imported: 1, skipped: 1 });
  assert.deepEqual(result.progress?.counts?.byKind.post, { imported: 1, skipped: 1 });
  const traversal = await zip([
    ['posts.json', JSON.stringify([{ post: 'unsafe', attachments: [{ uri: '../secret.jpg' }] }])],
  ]);
  await assert.rejects(collect(traversal), /Unsafe archive path/);
});

test('16 MiB escaped source with 3000 distinct Unicode characters is indexed once and preserves raw messages', async (t) => {
  const { parseFacebook, ARCHIVE_LIMITS } = await import('../src/archive.js');
  const chars = Array.from({ length: 3000 }, (_, i) => String.fromCodePoint(0x4e00 + i));
  const messages = chars
    .map(
      (char, i) =>
        `{"message_id":"m${i}","content":"${[...new TextEncoder().encode(char)].map((b) => `\\u00${b.toString(16)}`).join('')}"}`,
    )
    .join(',');
  const prefix = `{"messages":[${messages}],"padding":"`,
    suffix = '"}';
  const raw =
    prefix + 'x'.repeat(ARCHIVE_LIMITS.maxJsonBytes - prefix.length - suffix.length) + suffix;
  const value = JSON.parse(raw),
    before = performance.now();
  const records = parseFacebook(value, 'messages/inbox/synthetic/message_1.json', raw);
  const elapsed = performance.now() - before;
  assert.ok(elapsed < 5000, `bounded source index took ${elapsed.toFixed(1)}ms`);
  const original = records.flatMap((r) => (r.metadata.original ?? []) as any[]);
  assert.equal(original.length, 3000);
  assert.deepEqual(original, value.messages);
  for (const char of chars) assert.ok(records.some((r) => r.body.includes(char)));
  t.diagnostic(`sourceBytes=${raw.length} distinctCharacters=3000 elapsedMs=${elapsed.toFixed(1)}`);
});
