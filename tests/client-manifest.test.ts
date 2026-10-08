import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error The release helper is intentionally a standalone Node module.
import { clientManifest } from '../scripts/client-manifest.mjs';
test('browser artifact manifest detects changed files and rejects unexpected files or links', () => {
  const root = mkdtempSync(join(tmpdir(), 'cbf-client-manifest-'));
  try {
    mkdirSync(join(root, 'assets'));
    writeFileSync(join(root, 'index.html'), '<title>Fictional client</title>');
    writeFileSync(join(root, 'book.html'), '<title>Fictional local book</title>');
    writeFileSync(join(root, 'assets/crypto-test.wasm'), Buffer.from([0, 97, 115, 109]));
    const before = clientManifest(root);
    assert.equal(before.files.length, 3);
    rmSync(join(root, 'book.html'));
    assert.throws(() => clientManifest(root), /Incomplete/);
    writeFileSync(join(root, 'book.html'), '<title>Fictional local book</title>');
    writeFileSync(join(root, 'index.html'), '<title>Changed</title>');
    assert.notDeepEqual(clientManifest(root), before);
    writeFileSync(join(root, 'runtime.json'), '{}');
    assert.throws(() => clientManifest(root), /Unexpected/);
    rmSync(join(root, 'runtime.json'));
    symlinkSync(join(root, 'index.html'), join(root, 'favicon.svg'));
    assert.throws(() => clientManifest(root), /Unexpected/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
