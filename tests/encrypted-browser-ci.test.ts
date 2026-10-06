import { safeFailureSummary } from '../scripts/encrypted-browser-ci.mjs';
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

test('public failure summaries retain source-owned locations while omitting all fixture content', () => {
  const secret = 'RECOVERY_KEY_AND_TOKEN_DO_NOT_PUBLISH';
  const title = 'private import survives recovery and verified friends can share';
  const report = {
    stats: { expected: 1, unexpected: 1, flaky: 0, skipped: 3 },
    suites: [
      {
        specs: [
          {
            title,
            line: 84,
            tests: [
              {
                results: [
                  {
                    status: 'failed',
                    error: {
                      message: `expect(locator).toBeVisible() Timeout: 5000ms ${secret}`,
                      stack: `Error ${secret} at /private/member/journey.spec.ts:170:73`,
                    },
                    stdout: [{ text: secret }],
                    attachments: [{ path: secret }],
                  },
                ],
              },
            ],
          },
          {
            title: secret,
            line: -1,
            tests: [
              {
                results: [
                  {
                    status: 'failed',
                    error: { message: secret, location: { file: secret, line: -4 } },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    errors: [{ message: `Timed out waiting 30000ms from config.webServer ${secret}` }],
  };
  const safe = safeFailureSummary(report, 'journey');
  assert.equal(safe.failures[0].title, title);
  assert.equal(safe.failures[0].file, 'encrypted-client/tests/browser/journey.spec.ts');
  assert.equal(safe.failures[0].line, 170);
  assert.equal(safe.failures[0].classification, 'timeout');
  assert.equal(safe.failures[1].title, 'Unrecognized test title omitted');
  assert.equal(safe.failures[1].line, null);
  assert.deepEqual(safe.runnerErrors, ['preview-startup-timeout']);
  assert.deepEqual(safe.counts, report.stats);
  assert.ok(!JSON.stringify(safe).includes(secret));
  assert.ok(!JSON.stringify(safe).includes('/private/member'));
});
test('malformed browser reports cannot smuggle output through counts or suite names', () => {
  const secret = 'PRIVATE_FIXTURE_TEXT';
  assert.deepEqual(safeFailureSummary({}, secret), { classification: 'unrecognized-suite' });
  const safe = safeFailureSummary(
    { stats: { expected: secret, unexpected: -1 }, suites: secret, errors: secret },
    'journey',
  );
  assert.deepEqual(safe.counts, { expected: 0, unexpected: 0, flaky: 0, skipped: 0 });
  assert.deepEqual(safe.failures, []);
  assert.ok(!JSON.stringify(safe).includes(secret));
});
