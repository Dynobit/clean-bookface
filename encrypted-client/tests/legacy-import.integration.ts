import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { legacyFixture } from './legacy-fixture.js';
import { importArchives } from '../src/archive.js';
import { importArchiveBatches } from '../src/streaming-import.js';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
test('actual v0.1 authenticated account HTTP export imports locally with exact text, original media hashes and revisions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cbf-legacy-browser-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { file, items, media } = await legacyFixture(root);
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('Migration must not make a network request');
  };
  try {
    const result = await importArchives([file]);
    const streamed = [];
    let scratchRemoved = false;
    for await (const batch of importArchiveBatches([file], {
      openTemporaryFile: async () => {
        const ciphertext: Uint8Array<ArrayBuffer>[] = [];
        return {
          writable: new WritableStream({
            write: (chunk) => {
              ciphertext.push(new Uint8Array(chunk));
            },
          }),
          blob: async () => new Blob(ciphertext),
          remove: async () => {
            ciphertext.length = 0;
            scratchRemoved = true;
          },
        };
      },
    }))
      streamed.push(...batch.records);
    assert.deepEqual(streamed, result.records);
    assert.equal(scratchRemoved, true);
    assert.equal(result.records.length, items.length + 3); // one prior revision, publication, comment
    const current = result.records.find((r) => r.id === items[0].id)!;
    assert.equal(current.text, items[0].body);
    assert.equal(sha(new Uint8Array(await current.attachments[0].bytes.arrayBuffer())), sha(media));
    assert.deepEqual(
      new Set(result.records.map((r) => r.text)),
      new Set([
        'Earlier memory Café שלום',
        'Revised memory Café שלום',
        'Native publication',
        'Native comment',
      ]),
    );
    assert.equal(result.records.find((r) => r.text === 'Native comment')!.privateOnly, true);
    assert.match(result.warnings.join(' '), /not restored/);
  } finally {
    globalThis.fetch = savedFetch;
  }
});
