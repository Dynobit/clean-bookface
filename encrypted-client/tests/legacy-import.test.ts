import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { BlobReader, BlobWriter, ZipWriter } from '@zip.js/zip.js';
import { importArchives, exportArchives } from '../src/archive.js';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function zip(entries: Array<[string, Blob | string]>): Promise<File> {
  const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
  for (const [name, value] of entries)
    await writer.add(name, new BlobReader(value instanceof Blob ? value : new Blob([value])), {
      level: 0,
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
