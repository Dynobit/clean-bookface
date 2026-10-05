/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BlobReader, BlobWriter, ZipWriter } from '@zip.js/zip.js';
import { ARCHIVE_LIMITS, importArchives, exportArchives } from '../src/archive.js';
async function zip(entries: Array<[string, string | Blob]>, name = 'part.zip'): Promise<File> {
  const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
  for (const [path, value] of entries)
    await writer.add(path, new BlobReader(value instanceof Blob ? value : new Blob([value])), {
      level: 0,
    });
  return new File([await writer.close()], name);
}
const post = (text = 'Café שלום 日本語 ☀️') =>
  JSON.stringify([
    {
      id: 'fictional',
      timestamp: 946684800,
      data: [{ post: text }],
      attachments: [{ uri: 'photos/card.png' }],
    },
  ]);
test('multipart, literal Unicode, provenance, stable IDs and portable round trip', async () => {
  const png = new Blob(
    [
      await readFile(
        new URL(
          '../../tests/fixtures/synthetic/facebook/photos/synthetic-postcard.png',
          import.meta.url,
        ),
      ),
    ],
    { type: 'image/png' },
  );
  const inputs = [
    await zip([['posts/your_posts_1.json', post()]]),
    await zip([['photos/card.png', png]], 'part2.zip'),
  ];
  const first = await importArchives(inputs);
  const again = await importArchives(inputs);
  assert.equal(first.records[0].text, 'Café שלום 日本語 ☀️');
  assert.equal(first.records[0].timestamp, 946684800000);
  assert.equal(first.records[0].id, again.records[0].id);
  assert.equal(first.records[0].attachments.length, 1);
  const exported = await exportArchives(first.records);
  const restored = await importArchives([new File([exported], 'export.zip')]);
  assert.deepEqual(
    restored.records.map(({ attachments, ...r }) => r),
    first.records.map(({ attachments, ...r }) => r),
  );
  assert.deepEqual(
    await restored.records[0].attachments[0].bytes.arrayBuffer(),
    await png.arrayBuffer(),
  );
});
test('messages and friends stay private and millisecond times stay exact', async () => {
  const input = await zip([
    [
      'messages/message_1.json',
      JSON.stringify({ messages: [{ timestamp_ms: 1, content: 'secret' }] }),
    ],
    ['friends/friends.json', JSON.stringify({ friends_v2: [{ name: 'Example' }] })],
  ]);
  const { records } = await importArchives([input]);
  assert.equal(records.length, 2);
  assert.ok(records.every((r) => r.privateOnly));
  assert.equal(records[0].timestamp, 1);
});
test('portable conflict versions preserve their original identity without changing their text', async () => {
  const { records } = await importArchives([await zip([['posts_1.json', post()]])]);
  const original = records[0].id;
  const variant = { ...records[0], id: 'conflict-fixture', conflictOf: original };
  const restored = await importArchives([
    new File([await exportArchives([variant])], 'variants.zip'),
  ]);
  assert.equal(restored.records[0].conflictOf, original);
  assert.equal(restored.records[0].text, variant.text);
  await assert.rejects(
    importArchives([
      new File([await exportArchives([{ ...variant, conflictOf: '' }])], 'invalid.zip'),
    ]),
    /Invalid portable record/,
  );
});
test('missing media is explicit; conflicting duplicate filenames rejected', async () => {
  const file = await zip([['posts_1.json', post()]]);
  assert.match((await importArchives([file])).warnings.join(' '), /Missing media: 1/);
  await assert.rejects(
    importArchives([file, await zip([['posts_1.json', post('different')]])]),
    /Conflicting duplicate/,
  );
  assert.equal((await importArchives([file, file])).records.length, 1);
});
test('unsafe paths, HTML, executable attachments and unsupported inputs reject', async () => {
  for (const path of [
    '../posts_1.json',
    '/posts_1.json',
    'x/../posts_1.json',
    'x\\posts_1.json',
    'index.html',
    'run.exe',
  ]) {
    await assert.rejects(importArchives([await zip([[path, '{}']])]), /Unsafe|unsupported/);
  }
  await assert.rejects(importArchives([new File(['{}'], 'posts.json')]), /Only JSON ZIP/);
});
test('file count, expanded metadata limits, and cancellation are enforced', async () => {
  const empty = await zip([]);
  await assert.rejects(
    importArchives(Array.from({ length: ARCHIVE_LIMITS.maxFiles + 1 }, () => empty)),
    /input limit/,
  );
  const large = await zip([
    ['large.json', new Blob([new Uint8Array(ARCHIVE_LIMITS.maxJsonBytes + 1)])],
  ]);
  await assert.rejects(importArchives([large]), /expansion limit/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(importArchives([empty], { signal: controller.signal }), {
    name: 'AbortError',
  });
  const active = new AbortController();
  await assert.rejects(
    importArchives([await zip([['posts_1.json', post()]])], {
      signal: active.signal,
      onProgress: () => active.abort(),
    }),
    { name: 'AbortError' },
  );
});

test('forged expansion metadata cannot bypass the streaming bound', async () => {
  const original = await zip([
    ['large.json', new Blob([new Uint8Array(ARCHIVE_LIMITS.maxJsonBytes + 1)])],
  ]);
  const bytes = new Uint8Array(await original.arrayBuffer());
  const view = new DataView(bytes.buffer);
  for (let i = bytes.length - 46; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x02014b50) {
      view.setUint32(i + 24, 1, true);
      break;
    }
  }
  await assert.rejects(
    importArchives([new File([bytes], 'forged.zip')]),
    /streaming expansion|size|Size/,
  );
});
test('media extension cannot conceal executable content', async () => {
  await assert.rejects(
    importArchives([await zip([['photos/fake.jpg', 'MZ synthetic executable']])]),
    /Executable media/,
  );
});
test('encrypted entries and symlinks reject from ZIP metadata', async () => {
  for (const kind of ['encrypted', 'symlink']) {
    const input = await zip([['posts_1.json', '[]']]);
    const bytes = new Uint8Array(await input.arrayBuffer());
    const view = new DataView(bytes.buffer);
    for (let i = bytes.length - 46; i >= 0; i--)
      if (view.getUint32(i, true) === 0x02014b50) {
        if (kind === 'encrypted') view.setUint16(i + 8, view.getUint16(i + 8, true) | 1, true);
        else {
          view.setUint16(i + 4, 0x0314, true);
          view.setUint32(i + 38, 0xa1ff0000, true);
        }
        break;
      }
    await assert.rejects(
      importArchives([new File([bytes], 'unsafe.zip')]),
      /Encrypted archives and special files/,
    );
  }
});
