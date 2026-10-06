import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The scanner inventory is the exact source consumed by the scheduled matrix.
// @ts-expect-error Source-owned JavaScript CLI has no declaration file.
import { pinnedHostImages } from '../scripts/pinned-host-images.mjs';
test('advisory inventory reads all four exact production pins without importing host code', () => {
  const actual = pinnedHostImages();
  assert.deepEqual(
    actual.map((item: { component: string }) => item.component),
    ['caddy', 'postgres', 'restic', 'synapse'],
  );
  assert.ok(actual.every((item: { image: string }) => item.image.includes('@sha256:')));
});
test('missing, mutable, ambiguous and injected image pins fail closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'cbf-advisory-inventory-'));
  try {
    const host = join(root, 'encrypted-host');
    mkdirSync(host);
    const image = `example/image:1@sha256:${'a'.repeat(64)}`;
    const configure = () => {
      writeFileSync(join(host, 'images.json'), JSON.stringify({ synapse: image, postgres: image }));
      writeFileSync(join(host, 'operations.py'), `CADDY = '${image}'\n`);
      writeFileSync(join(host, 'recovery.py'), `RESTIC='${image}'\n`);
    };
    configure();
    assert.equal(pinnedHostImages(root).length, 4);
    for (const invalid of [
      'example/image:latest',
      `${image}\nINJECTED=yes`,
      `$(echo bad):1@sha256:${'a'.repeat(64)}`,
    ]) {
      writeFileSync(
        join(host, 'images.json'),
        JSON.stringify({ synapse: invalid, postgres: image }),
      );
      assert.throws(() => pinnedHostImages(root), /Invalid/);
    }
    configure();
    writeFileSync(join(host, 'operations.py'), `CADDY = '${image}'\nCADDY = '${image}'\n`);
    assert.throws(() => pinnedHostImages(root), /ambiguous/);
    configure();
    writeFileSync(join(host, 'images.json'), JSON.stringify({ synapse: image }));
    assert.throws(() => pinnedHostImages(root), /inventory/);
    configure();
    writeFileSync(join(host, 'recovery.py'), 'raise RuntimeError("never execute discovery")\n');
    assert.throws(() => pinnedHostImages(root), /Missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
