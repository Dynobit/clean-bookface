import assert from 'node:assert/strict';
import { mkdtemp, open, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { largeLegacyArchiveFixture, diskBackedFixtureFile } from './large-archive-fixture.js';
import { importArchiveBatches, type ImportTemporaryFile } from '../src/streaming-import.js';
import { importArchives } from '../src/archive.js';
const directory = await mkdtemp(join(tmpdir(), 'cbf-synthetic-legacy-'));
const started = performance.now();
let peakRss = process.memoryUsage().rss,
  stage = 0;
const timer = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 100);
try {
  const fixture = await largeLegacyArchiveFixture(
    directory,
    Number(process.env.LEGACY_PROOF_BYTES ?? 2 * 1024 ** 3),
  );
  const file = await diskBackedFixtureFile(fixture.path);
  // The original eager API's documented cap remains intact; streaming is a separate path.
  if (file.size > 256 * 1024 ** 2) await assert.rejects(importArchives([file]), /input limit/);
  const openTemporaryFile = async (): Promise<ImportTemporaryFile> => {
    const path = join(directory, `ciphertext-${stage++}`),
      handle = await open(path, 'wx', 0o600);
    let closed = false;
    const close = async () => {
      if (!closed) {
        closed = true;
        await handle.close();
      }
    };
    return {
      writable: new WritableStream({
        write: async (chunk) => {
          await handle.writeFile(chunk);
        },
        close,
        abort: close,
      }),
      blob: () => diskBackedFixtureFile(path),
      remove: async () => {
        await close();
        await rm(path);
      },
    };
  };
  const interrupted = importArchiveBatches([file], { openTemporaryFile });
  const first = await interrupted.next();
  const acceptedIds: string[] | undefined = first.done
    ? undefined
    : first.value.records.map((r) => r.id);
  assert.ok(acceptedIds?.length);
  await interrupted.return(undefined);
  assert.equal(
    (await readdir(directory)).some((n) => n.startsWith('ciphertext-')),
    false,
  );
  const seen = new Set<string>();
  let bytes = 0,
    batches = 0,
    decoded = 0,
    peakResident = 0;
  for await (const batch of importArchiveBatches([file], { openTemporaryFile })) {
    if (!batches)
      assert.deepEqual(
        batch.records.map((r) => r.id),
        acceptedIds,
      );
    batches++;
    for (const record of batch.records) {
      assert.equal(seen.has(record.id), false);
      seen.add(record.id);
      const expected = fixture.expected.get(record.id);
      assert.ok(expected);
      assert.equal(record.attachments.length, 1);
      const media = record.attachments[0].bytes;
      assert.equal(media.size, expected.size);
      assert.equal(
        createHash('sha256')
          .update(new Uint8Array(await media.arrayBuffer()))
          .digest('hex'),
        expected.sha256,
      );
      bytes += media.size;
    }
    decoded = batch.progress.decodedBytes;
    peakResident = Math.max(peakResident, batch.progress.peakResidentMediaBytes);
  }
  assert.equal(bytes, fixture.payloadBytes);
  assert.equal(seen.size, fixture.expected.size);
  assert.ok(peakResident <= 96 * 1024 ** 2);
  assert.equal(
    (await readdir(directory)).some((n) => n.startsWith('ciphertext-')),
    false,
  );
  console.log(
    JSON.stringify({
      outcome: 'passed',
      records: seen.size,
      bytes,
      zipBytes: fixture.zipBytes,
      batches,
      decodedBytes: decoded,
      peakResidentMediaBytes: peakResident,
      peakRssBytes: peakRss,
      elapsedSeconds: (performance.now() - started) / 1000,
      interruptedReselection: 'same first IDs, no duplicates',
      scratchCleanup: 'passed',
      eager256MiBLimit: file.size > 256 * 1024 ** 2 ? 'preserved' : 'not exercised',
    }),
  );
} finally {
  clearInterval(timer);
  await rm(directory, { recursive: true, force: true });
}
