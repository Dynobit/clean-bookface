import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { largeArchiveFixture, diskBackedFixtureFile } from './large-archive-fixture.js';
import { importArchiveBatches, STREAM_IMPORT_LIMITS } from '../src/streaming-import.js';
const bytes = Number(process.env.CBF_LARGE_IMPORT_BYTES ?? 10_000_000_000);
const directory = await mkdtemp(join(tmpdir(), 'cbf-streaming-qualification-'));
const started = Date.now();
let batches = 0,
  count = 0,
  total = 0,
  peakRss = 0,
  peakBuffered = 0;
const sample = () => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
};
const timer = setInterval(sample, 25);
try {
  const fixture = await largeArchiveFixture(directory, bytes);
  const source = await diskBackedFixtureFile(fixture.path);
  for await (const batch of importArchiveBatches([source], {
    onProgress: (p) => {
      sample();
      peakBuffered = Math.max(peakBuffered, p.peakResidentMediaBytes);
    },
  })) {
    assert.deepEqual(batch.warnings, []);
    batches++;
    for (const record of batch.records) {
      const expected = fixture.expected.get(record.id);
      assert.ok(expected);
      fixture.expected.delete(record.id);
      assert.equal(record.text, expected.text);
      assert.equal(record.attachments.length, 1);
      const attachment = record.attachments[0];
      assert.equal(attachment.path, expected.path);
      assert.equal(attachment.bytes.size, expected.size);
      assert.equal(
        createHash('sha256')
          .update(new Uint8Array(await attachment.bytes.arrayBuffer()))
          .digest('hex'),
        expected.sha256,
      );
      total += attachment.bytes.size;
      count++;
    }
    sample();
  }
  assert.equal(fixture.expected.size, 0);
  assert.equal(total, bytes);
  assert.ok(peakBuffered <= STREAM_IMPORT_LIMITS.batchBytes);
  // This checks the real process RSS, including ZIP generation, parsing and consumer hashing.
  assert.ok(peakRss < 1536 * 1024 ** 2, `Measured RSS exceeds 1.5 GiB: ${peakRss}`);
  const report = {
    payloadBytes: bytes,
    zipBytes: fixture.zipBytes,
    records: count,
    batches,
    peakRss,
    peakBuffered,
    elapsedMs: Date.now() - started,
    scope:
      'actual disk-backed range adapter + Node importer and exact hashes; not browser encryption/server recovery',
  };
  const reportPath =
    process.env.CBF_LARGE_IMPORT_REPORT ??
    join(tmpdir(), 'cbf-streaming-qualification-result.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report));
} finally {
  clearInterval(timer);
  await rm(directory, { recursive: true, force: true });
}
