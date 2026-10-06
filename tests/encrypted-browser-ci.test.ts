import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('../scripts/encrypted-browser-ci.mjs', import.meta.url));
const root = fileURLToPath(new URL('..', import.meta.url));
function invoke(args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 5000 });
}
test('browser qualification refuses checkout output and unsupported suites before host creation', () => {
  const inside = invoke(['--suite', 'migration', '--work', join(root, 'private-ci-output')]);
  assert.equal(inside.status, 1);
  assert.match(inside.stderr, /outside the checkout/);
  const unknown = invoke([
    '--suite',
    'federation',
    '--work',
    join(tmpdir(), 'uncreated-ci-output'),
  ]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /supported browser suite/);
});
test('cleanup refuses unowned directories and is harmless for an absent work directory', async () => {
  const work = await mkdtemp(join(tmpdir(), 'cbf-ci-cleanup-'));
  try {
    await writeFile(join(work, 'owner.json'), JSON.stringify({ schema: 'unrelated-project' }));
    const unowned = invoke(['--cleanup', '--work', work]);
    assert.equal(unowned.status, 1);
    assert.match(unowned.stderr, /ownership marker/);
    const absent = invoke(['--cleanup', '--work', join(work, 'absent')]);
    assert.equal(absent.status, 0);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
