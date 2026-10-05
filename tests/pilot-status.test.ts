import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  summarize,
  render,
  collect,
  writeSnapshot,
  receiverCapacity,
} from '../deploy/pilot-status.mjs';
const now = Date.parse('2026-10-05T12:00:00.000Z');
const at = (hours: number) => new Date(now - hours * 3600000).toISOString();
function fixture() {
  return {
    success: {
      format: 'clean-bookface-offhost/1',
      checksumReadback: true,
      capturedAt: at(1),
      verifiedAt: at(0.5),
      ledgerSha256: 'a'.repeat(64),
      captureSha256: 'b'.repeat(64),
      remoteHost: 'secret.example',
      token: 'NEVER_RENDER_ME',
    },
    attempt: {
      format: 'clean-bookface-offhost-attempt/1',
      startedAt: at(1),
      finishedAt: at(0.5),
      status: 'succeeded',
    },
    dates: { starts: now - 3600000, readOnly: now + 86400000, ends: now + 172800000 },
    containers: [
      { service: 'app', running: true, health: 'healthy' },
      { service: 'tunnel', running: true },
    ],
    disk: { totalBytes: 100 * 1024 ** 3, freeBytes: 30 * 1024 ** 3 },
  };
}
test('status shows measured success and strips private input fields', () => {
  const status = summarize(fixture(), now);
  assert.equal(status.backup.state, 'verified');
  assert.equal(status.attempt.state, 'succeeded');
  assert.equal(status.pilot.state, 'running');
  const output = JSON.stringify(status) + render(status);
  assert.doesNotMatch(output, /secret.example|NEVER_RENDER_ME/);
  assert.equal(status.receiverCapacity.state, 'unknown');
});
test('fresh verification of an old capture is overdue', () => {
  const input = fixture();
  input.success.capturedAt = at(27);
  assert.equal(summarize(input, now).backup.state, 'overdue');
});
test('missing, malformed and future success never look verified', () => {
  for (const success of [
    null,
    {},
    { ...fixture().success, checksumReadback: false },
    { ...fixture().success, verifiedAt: at(-1) },
    { ...fixture().success, capturedAt: 'bad' },
    { ...fixture().success, ledgerSha256: 'bad' },
  ])
    assert.equal(summarize({ ...fixture(), success }, now).backup.state, 'unknown');
});
test('failed attempt remains visible alongside preceding success', () => {
  const input = fixture();
  input.attempt = { ...input.attempt, status: 'failed', startedAt: at(0.2), finishedAt: at(0.1) };
  const result = summarize(input, now);
  assert.equal(result.backup.state, 'verified');
  assert.equal(result.attempt.state, 'failed');
});
test('newer systemd failure overrides a successful receipt; old failure does not', () => {
  assert.equal(
    summarize({ ...fixture(), service: { startedAt: at(0.1), failed: true } }, now).attempt.state,
    'failed',
  );
  assert.equal(
    summarize({ ...fixture(), service: { startedAt: at(2), failed: true } }, now).attempt.state,
    'succeeded',
  );
});
test('killed or incomplete attempts cannot silently remain healthy', () => {
  const input = fixture();
  input.attempt = { ...input.attempt, status: 'running', startedAt: at(5) };
  assert.equal(summarize(input, now).attempt.state, 'stalled');
  input.attempt = {
    ...input.attempt,
    status: 'succeeded',
    startedAt: at(0.2),
    finishedAt: at(0.1),
  };
  assert.equal(summarize(input, now).attempt.state, 'unverified');
  assert.equal(summarize({ ...input, attempt: null }, now).attempt.state, 'unknown');
});
test('missing or ambiguous containers and closed-but-running pilot need attention', () => {
  assert.equal(summarize({ ...fixture(), containers: null }, now).pilot.state, 'unknown');
  assert.equal(summarize({ ...fixture(), containers: [] }, now).pilot.state, 'stopped');
  assert.equal(
    summarize(
      { ...fixture(), containers: [{ service: 'app', running: true, health: 'healthy' }] },
      now,
    ).pilot.state,
    'attention',
  );
  assert.equal(
    summarize({ ...fixture(), dates: { starts: now - 3, readOnly: now - 2, ends: now - 1 } }, now)
      .pilot.state,
    'attention',
  );
  assert.equal(summarize({ ...fixture(), dates: null }, now).pilot.phase, 'unknown');
});
test('capacity reflects real numbers with conservative thresholds', () => {
  assert.equal(
    summarize(
      { ...fixture(), disk: { totalBytes: 100 * 1024 ** 3, freeBytes: 9 * 1024 ** 3 } },
      now,
    ).capacity.state,
    'low',
  );
  assert.equal(
    summarize(
      { ...fixture(), disk: { totalBytes: 1000 * 1024 ** 3, freeBytes: 50 * 1024 ** 3 } },
      now,
    ).capacity.state,
    'low',
  );
  assert.equal(
    summarize({ ...fixture(), disk: { totalBytes: 2, freeBytes: 3 } }, now).capacity.state,
    'unknown',
  );
});
test('unreadable files and command failures produce unknown without raw errors', () => {
  const status = collect(
    {
      backupRoot: '/nonexistent-clean-bookface-status',
      pilotEnvFile: '/nonexistent-clean-bookface.env',
    },
    () => {
      throw new Error('SECRET STDERR /private/operator');
    },
  );
  assert.equal(status.backup.state, 'unknown');
  assert.equal(status.pilot.state, 'unknown');
  assert.equal(status.capacity.state, 'unknown');
  assert.doesNotMatch(JSON.stringify(status), /SECRET|private/);
});
test('HTML starts unverified and explicitly expires snapshots', () => {
  const html = render(summarize(fixture(), now));
  assert.match(html, /freshness is unverified/);
  assert.match(html, /STALE SNAPSHOT/);
  assert.match(html, /300000/);
  assert.match(html, /default-src 'none'/);
});

test('collector narrows Docker identity and incorporates systemd failure without exposing details', () => {
  const calls: string[][] = [];
  const status = collect(
    {
      backupRoot: '/nonexistent-clean-bookface-status',
      pilotEnvFile: '/nonexistent-clean-bookface.env',
    },
    (file: string, args: string[]) => {
      calls.push(args);
      if (file.endsWith('systemctl'))
        return 'LoadState=loaded\nResult=exit-code\nExecMainStatus=1\nExecMainStartTimestamp=Mon 2026-01-05 12:00:00 UTC\nActiveState=failed\n';
      if (args.includes('ps')) return 'a'.repeat(64) + '\n';
      return JSON.stringify([
        {
          Config: {
            Labels: {
              'com.docker.compose.project': 'clean-bookface-pilot',
              'com.docker.compose.service': 'app',
            },
          },
          State: { Running: true, Health: { Status: 'healthy', Log: [{ Output: 'PRIVATE' }] } },
        },
      ]);
    },
  );
  assert.equal(status.pilot.state, 'attention');
  assert.equal(status.attempt.state, 'failed');
  assert.ok(calls.some((args) => args.includes('--timestamp=us')));
  assert.doesNotMatch(JSON.stringify(status), /PRIVATE/);
  assert.ok(
    calls.some((args) => args.includes('label=com.docker.compose.project=clean-bookface-pilot')),
  );
});

test('failed service interval matches a delayed running receipt, never a later manual attempt', () => {
  const service = {
    startedAt: '2026-10-05T11:00:00.000Z',
    finishedAt: '2026-10-05T11:10:00.000Z',
    failed: true,
  };
  const running = {
    ...fixture().attempt,
    status: 'running',
    startedAt: '2026-10-05T11:00:02.000Z',
  };
  assert.equal(summarize({ ...fixture(), attempt: running, service }, now).attempt.state, 'failed');
  const manual = { ...running, startedAt: '2026-10-05T11:10:01.000Z' };
  assert.equal(summarize({ ...fixture(), attempt: manual, service }, now).attempt.state, 'running');
  const recovered = { ...manual, status: 'succeeded', finishedAt: '2026-10-05T11:20:00.000Z' };
  assert.equal(
    summarize({ ...fixture(), attempt: recovered, service }, now).attempt.state,
    'succeeded',
  );
  assert.equal(
    summarize(
      { ...fixture(), attempt: running, service: { ...service, finishedAt: 'malformed' } },
      now,
    ).attempt.state,
    'running',
  );
});
test('orphan temporary files cannot block regeneration; failed publication cleans its own temporary', (t) => {
  const output = mkdtempSync(join(tmpdir(), 'bookface-status-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  for (const name of ['status.json.tmp', 'index.html.tmp'])
    writeFileSync(join(output, name), 'orphan');
  const status = summarize(fixture(), now);
  writeSnapshot(output, status);
  assert.equal(
    JSON.parse(readFileSync(join(output, 'status.json'), 'utf8')).observedAt,
    status.observedAt,
  );
  assert.match(readFileSync(join(output, 'index.html'), 'utf8'), /Keep the circle cared for/);
  assert.deepEqual(readdirSync(output).sort(), [
    'index.html',
    'index.html.tmp',
    'status.json',
    'status.json.tmp',
  ]);
  rmSync(join(output, 'index.html'));
  mkdirSync(join(output, 'index.html'));
  assert.throws(() => writeSnapshot(output, status));
  assert.deepEqual(readdirSync(output).sort(), [
    'index.html',
    'index.html.tmp',
    'status.json',
    'status.json.tmp',
  ]);
});

test('receiver capacity requires fresh valid measurements and flags allocation thresholds', () => {
  const input = {
    format: 'clean-bookface-receiver-capacity/1',
    observedAt: new Date(now - 1000).toISOString(),
    totalBytes: 1000 * 1024 ** 3,
    freeBytes: 500 * 1024 ** 3,
    usedBytes: 500 * 1024 ** 3,
    repositoryBytes: 20 * 1024 ** 3,
    planningBudgetBytes: 100 * 1024 ** 3,
  };
  assert.equal(receiverCapacity(input, now).state, 'available');
  for (const patch of [
    { observedAt: at(1) },
    { observedAt: at(-1) },
    { freeBytes: -1 },
    { repositoryBytes: 'secret' },
    { usedBytes: 1001 * 1024 ** 3 },
    { planningBudgetBytes: 1 },
  ])
    assert.equal(receiverCapacity({ ...input, ...patch }, now).state, 'unknown');
  assert.equal(receiverCapacity(null, now).state, 'unknown');
  assert.equal(
    receiverCapacity({ ...input, repositoryBytes: 80 * 1024 ** 3 }, now).state,
    'budget warning',
  );
  assert.equal(
    receiverCapacity({ ...input, repositoryBytes: 90 * 1024 ** 3 }, now).state,
    'action needed',
  );
  assert.equal(
    receiverCapacity({ ...input, freeBytes: 9 * 1024 ** 3 }, now).state,
    'action needed',
  );
  assert.equal(
    receiverCapacity({ ...input, freeBytes: 99 * 1024 ** 3 }, now).state,
    'action needed',
  );
});
test('receiver card escapes arbitrary values and never renders private extra input fields', () => {
  const status = summarize({ ...fixture(), receiver: { host: 'SECRET_HOST' } }, now);
  status.receiverCapacity.state = '<img src=x onerror=alert(1)>';
  const html = render(status);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img|SECRET_HOST/);
  assert.match(html, /This is not a quota/);
});

test('an open dashboard expires receiver evidence before its newer page snapshot', async () => {
  const { runInNewContext } = await import('node:vm');
  const status = summarize(
    {
      ...fixture(),
      receiver: {
        format: 'clean-bookface-receiver-capacity/1',
        observedAt: new Date(now - 299000).toISOString(),
        totalBytes: 1000 * 1024 ** 3,
        freeBytes: 500 * 1024 ** 3,
        usedBytes: 500 * 1024 ** 3,
        repositoryBytes: 10 * 1024 ** 3,
        planningBudgetBytes: 100 * 1024 ** 3,
      },
    },
    now,
  );
  const html = render(status);
  assert.match(html, /id="receiver-state"/);
  const script = html.match(/<script>([\s\S]*)<\/script>/)![1];
  const elements: Record<string, { textContent: string }> = {
    'receiver-state': { textContent: 'available' },
    freshness: { textContent: '' },
  };
  let clock = now;
  let tick = () => {};
  class Clock extends Date {
    static now() {
      return clock;
    }
  }
  runInNewContext(script, {
    Date: Clock,
    document: { getElementById: (id: string) => elements[id] },
    setInterval: (fn: () => void) => {
      tick = fn;
    },
  });
  assert.equal(elements['receiver-state'].textContent, 'available');
  clock += 2000;
  tick();
  assert.equal(elements['receiver-state'].textContent, 'unknown — refresh required');
  assert.match(elements.freshness.textContent, /less than five minutes/);
});
