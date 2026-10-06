import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { BlobReader, BlobWriter, ZipWriter } from '@zip.js/zip.js';
import { importArchives, exportArchives } from '../src/archive.js';
import { importArchiveBatches, type ImportTemporaryFile } from '../src/streaming-import.js';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function zip(entries: Array<[string, Blob | string]>, level = 0): Promise<File> {
  const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
  for (const [name, value] of entries)
    await writer.add(name, new BlobReader(value instanceof Blob ? value : new Blob([value])), {
      level,
    });
  return new File([await writer.close()], 'legacy.zip');
}
const row = {
  id: 'original-id',
  kind: 'post',
  version: 2,
  sourceKey: 'a'.repeat(64),
  body: 'Original literal Café שלום',
  title: 'Title',
  source: 'posts/your_posts.json',
  occurredAt: 946684800000,
  importedAt: 1000,
  metadata: { original: { text: 'source' } },
  mediaIds: ['image-id'],
};
async function synthetic(
  options: {
    corrupt?: boolean;
    revision?: unknown;
    format?: string;
    extra?: boolean;
    kind?: string;
  } = {},
) {
  const bytes = new Uint8Array(
    await readFile(
      new URL(
        '../../tests/fixtures/synthetic/facebook/photos/synthetic-postcard.png',
        import.meta.url,
      ),
    ),
  );
  return zip([
    [
      'manifest.json',
      JSON.stringify({
        format: options.format ?? 'clean-bookface-archive/1',
        media: [
          {
            id: 'image-id',
            file: 'media/image-id.original',
            purpose: 'original',
            mime: 'image/png',
            size: bytes.length,
            sha256: options.corrupt ? '0'.repeat(64) : sha(bytes),
          },
        ],
      }),
    ],
    ['archive.ndjson', JSON.stringify({ ...row, kind: options.kind ?? row.kind })],
    [
      'revisions.ndjson',
      options.revision === undefined
        ? JSON.stringify({
            item_id: row.id,
            version: 1,
            record: JSON.stringify({ ...row, body: 'Earlier exact text', version: 1 }),
          })
        : JSON.stringify(options.revision),
    ],
    ['media/image-id.original', new Blob([bytes])],
    ...(options.extra ? [['nested.zip', new Blob(['unexpected'])] as [string, Blob]] : []),
  ]);
}
test('legacy archive preserves original IDs, text, media bytes, revision provenance and portable round trip', async () => {
  const input = await synthetic(),
    imported = await importArchives([input]),
    again = await importArchives([input]);
  assert.equal(imported.records.length, 2);
  assert.equal(imported.records[0].id, row.id);
  assert.equal(imported.records[0].text, row.body);
  assert.equal(imported.records[1].text, 'Earlier exact text');
  assert.equal((imported.records[1].provenance!.legacy as any).historyVersion, 1);
  assert.equal((imported.records[0].provenance!.metadata as any).original.text, 'source');
  assert.deepEqual(
    imported.records.map((r) => r.id),
    again.records.map((r) => r.id),
  );
  const exported = await exportArchives(imported.records),
    restored = await importArchives([new File([exported], 'private.zip')]);
  assert.deepEqual(restored.records, imported.records);
});
test('legacy profiles remain explicit private memories', async () => {
  const result = await importArchives([await synthetic({ kind: 'profile' })]);
  assert.equal(result.records[0].kind, 'message');
  assert.equal(result.records[0].privateOnly, true);
  assert.equal((result.records[0].provenance!.legacy as any).originalKind, 'profile');
  assert.match(result.warnings.join(' '), /Profiles are preserved/);
});
test('legacy checksum, revision identity, unknown formats and extra nested files fail closed', async () => {
  for (const options of [
    { corrupt: true },
    { revision: { item_id: 'orphan', version: 1, record: row } },
    {
      revision: {
        item_id: row.id,
        version: 1,
        record: { ...row, version: 1, sourceKey: 'b'.repeat(64) },
      },
    },
    { format: 'unknown/1' },
    { extra: true },
  ])
    await assert.rejects(importArchives([await synthetic(options)]));
  await assert.rejects(
    importArchives([
      await zip([
        ['posts.json', JSON.stringify({ format: 'unknown', posts: [{ post: 'must not parse' }] })],
      ]),
    ]),
    /Unsupported declared/,
  );
  await assert.rejects(
    importArchives([
      await zip([
        ['account.json', JSON.stringify({ format: 'clean-bookface-account/1' })],
        ['private-archive.zip', await zip([['private-archive.zip', await synthetic()]])],
      ]),
    ]),
    /manifest/,
  );
});

function memoryScratch(corrupt = false) {
  let removed = false,
    ciphertext = new Uint8Array();
  return {
    open: async (): Promise<ImportTemporaryFile> => {
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      return {
        writable: new WritableStream({
          write: (chunk) => {
            chunks.push(new Uint8Array(chunk));
          },
        }),
        blob: async () => {
          ciphertext = new Uint8Array(await new Blob(chunks).arrayBuffer());
          if (corrupt) ciphertext[0] ^= 1;
          return new Blob([ciphertext]);
        },
        remove: async () => {
          removed = true;
          chunks.length = 0;
        },
      };
    },
    removed: () => removed,
    ciphertext: () => ciphertext,
  };
}
async function nestedLegacy(input: File, level = 0) {
  return zip(
    [
      [
        'account.json',
        JSON.stringify({
          format: 'clean-bookface-account/1',
          account: { actor: 'https://example.org/fictional' },
          publications: [],
          comments: [],
        }),
      ],
      ['private-archive.zip', input],
    ],
    level,
  );
}
test('streamed legacy migration keeps exact records and validates all revisions before yielding', async () => {
  const input = await synthetic(),
    expected = await importArchives([input]);
  const records = [];
  for await (const batch of importArchiveBatches([input])) records.push(...batch.records);
  assert.deepEqual(records, expected.records);
  await assert.rejects(
    importArchiveBatches([
      await synthetic({ revision: { item_id: 'orphan', version: 1, record: row } }),
    ]).next(),
    /Orphan/,
  );
});
test('nested legacy staging persists only authenticated ciphertext and is removed on completion, cancellation and corruption', async () => {
  const input = await nestedLegacy(await synthetic());
  const scratch = memoryScratch(),
    records = [];
  for await (const batch of importArchiveBatches([input], { openTemporaryFile: scratch.open }))
    records.push(...batch.records);
  assert.equal(records.length, 2);
  assert.equal(scratch.removed(), true);
  assert.equal(Buffer.from(scratch.ciphertext()).includes(Buffer.from(row.body)), false);
  assert.notDeepEqual([...scratch.ciphertext().slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  const cancelled = memoryScratch(),
    controller = new AbortController();
  const generator = importArchiveBatches([input], {
    openTemporaryFile: cancelled.open,
    signal: controller.signal,
  });
  await generator.next();
  controller.abort();
  await assert.rejects(generator.next(), /aborted/i);
  assert.equal(cancelled.removed(), true);
  const damaged = memoryScratch(true);
  await assert.rejects(importArchiveBatches([input], { openTemporaryFile: damaged.open }).next());
  assert.equal(damaged.removed(), true);
});

test('deflated nested v0.1 account ZIP uses the same encrypted scratch path', async () => {
  const scratch = memoryScratch(),
    input = await nestedLegacy(await synthetic(), 6),
    records = [];
  for await (const batch of importArchiveBatches([input], { openTemporaryFile: scratch.open }))
    records.push(...batch.records);
  assert.equal(records.length, 2);
  assert.equal(records[0].id, row.id);
  assert.equal(scratch.removed(), true);
});
