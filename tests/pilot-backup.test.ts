import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  linkSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  backup,
  capturePilot,
  lockedCapture,
  configuration,
  checkFailureUnit,
  schedule,
  readLedger,
  atomicReceipt,
} from '../deploy/pilot-backup.mjs';
import {
  TUNNEL_IMAGE,
  protectedDirectory,
  lockPath,
  parsePrivateJson,
} from '../deploy/pilot-control.mjs';
function fixture(t: any, failure = '', running = 'app\ntunnel\n') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pilot-backup-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const c = {
    projectDir: join(root, 'repo'),
    pilotEnvFile: join(root, 'pilot.env'),
    backupRoot: join(root, 'clean-bookface-pilot-backup'),
    secretsDir: join(root, 'secrets'),
    sshKeyFile: join(root, 'key'),
    knownHostsFile: join(root, 'known_hosts'),
    remoteUser: 'bookface',
    remoteHost: 'backup.example',
    failureUnit: 'operator-alert.service',
  };
  mkdirSync(c.backupRoot, { mode: 0o700 });
  writeFileSync(
    c.pilotEnvFile,
    Object.entries({
      APP_IMAGE: 'sha256:' + 'a'.repeat(64),
      TUNNEL_IMAGE,
      APP_ORIGIN: 'https://circle.example',
      TUNNEL_TOKEN_FILE: '/secure/token',
      PILOT_STARTS_AT: '2027-01-01T00:00:00Z',
      PILOT_READ_ONLY_AT: '2027-03-18T00:00:00Z',
      PILOT_ENDS_AT: '2027-04-01T00:00:00Z',
    })
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
  );
  const calls: { file: string; args: string[] }[] = [];
  let receipt = '',
    clock = Date.parse('2027-02-01T00:00:00Z');
  const options = {
    readOutput: (filename: string) => readLedger(filename, process.getuid!()),
    now: () => clock,
    stopIntent: () => '',
    stopAcknowledgement: () => '',
    checkHost: () => {},
    checkPilot: () => {},
    prepare: (base: string, id: string) => {
      const dir = join(base, 'runs', id);
      mkdirSync(join(dir, 'output'), { recursive: true });
      return dir;
    },
    execute: (file: string, args: string[]) => {
      calls.push({ file, args });
      if (file.endsWith('/node')) {
        if (args.includes('start') && failure === 'restart') throw new Error('restart failed');
        return '';
      }
      if (file.endsWith('/docker')) {
        if (args.includes('inspect'))
          return JSON.stringify([
            {
              Name: 'clean-bookface-pilot_app_data',
              Labels: { 'com.docker.compose.project': 'clean-bookface-pilot' },
            },
          ]);
        if (args.includes('ps')) return running;
        if (args.includes('backup')) {
          if (failure === 'capture') throw new Error('private diagnostic');
          return JSON.stringify({ snapshotId: 'b'.repeat(64), backupId: 'synthetic-backup' });
        }
        if (args.includes('reconciliation-export')) {
          const output = args[args.indexOf('--output') + 1];
          const mount = args.find((arg: string) => arg.endsWith(',target=/output'))!;
          writeFileSync(
            join(
              mount.slice('type=bind,source='.length, -',target=/output'.length),
              'current-state.enc',
            ),
            'encrypted-ledger',
            { mode: 0o600 },
          );
          if (failure === 'deadline') clock = Date.parse('2027-04-01T00:00:00Z');
        }
        return '';
      }
      if (file.endsWith('/rsync')) {
        if (failure === 'transfer') throw new Error('transfer failed');
        if (args.includes('--dry-run')) return failure === 'checksum' ? '>f.bad checksum\n' : '';
        const [source, dest] = args.slice(-2);
        if (source.endsWith('/complete.json') && !source.includes('@'))
          receipt = readFileSync(source, 'utf8');
        if (source.includes('@') && source.endsWith('current/complete.json'))
          writeFileSync(dest, failure === 'readback' ? 'wrong' : receipt);
        return '';
      }
      throw new Error('unexpected executor');
    },
  };
  const integratedOptions = {
    ...options,
    captureRun: () => capturePilot(c, { ...options, lifecycleLocked: true }),
  };
  return {
    c,
    options: integratedOptions,
    calls,
    setClock: (value: number) => {
      clock = value;
    },
  };
}
test('offline capture resumes through controller before verified off-host publication', (t) => {
  const f = fixture(t);
  const result = backup(f.c, f.options);
  assert.equal(result.checksumReadback, true);
  assert.equal(
    JSON.parse(readFileSync(join(f.c.backupRoot, 'last-offhost-success.json'), 'utf8')).generation,
    result.generation,
  );
  const start = f.calls.findIndex((x) => x.args.includes('start'));
  assert.ok(start > f.calls.findIndex((x) => x.args.includes('reconciliation-export')));
  assert.ok(start < f.calls.findIndex((x) => x.file.endsWith('/rsync')));
  const containers = f.calls.filter((x) => x.args.includes('run'));
  assert.ok(
    containers.every(
      (x) =>
        x.args.includes('sha256:' + 'a'.repeat(64)) &&
        x.args.includes('type=volume,source=clean-bookface-pilot_app_data,target=/data') &&
        x.args.includes('none') &&
        x.args[x.args.indexOf('--user') + 1] === '1000:1000' &&
        !x.args.includes('type=bind,source=' + f.c.backupRoot + ',target=/backup') &&
        x.args.includes(
          'type=bind,source=' +
            f.c.secretsDir +
            '/restic-password,target=/secrets/restic-password,readonly',
        ) &&
        x.args.includes(
          'type=bind,source=' +
            f.c.secretsDir +
            '/recovery-password,target=/secrets/recovery-password,readonly',
        ),
    ),
  );
  assert.ok(f.calls.some((x) => x.args.includes('--link-dest=/current/repository')));
  assert.ok(
    f.calls.filter((x) => x.args.includes('--delete')).every((x) => x.args.includes('--dry-run')),
  );
  assert.ok(!JSON.stringify(f.calls).includes('encrypted-ledger'));
});
for (const failure of ['capture', 'restart', 'transfer', 'checksum', 'readback'])
  test(`${failure} failure preserves prior success receipt and returns failure`, (t) => {
    const f = fixture(t, failure);
    const previous = join(f.c.backupRoot, 'last-offhost-success.json');
    writeFileSync(previous, 'previous-success');
    assert.throws(() => backup(f.c, f.options));
    assert.equal(readFileSync(previous, 'utf8'), 'previous-success');
    assert.ok(f.calls.some((x) => x.args.includes('start')));
    if (['capture', 'restart'].includes(failure))
      assert.ok(!f.calls.some((x) => x.file.endsWith('/rsync')));
    if (['transfer', 'checksum'].includes(failure))
      assert.ok(!f.calls.some((x) => x.args.at(-1) === 'bookface@backup.example:./'));
  });
test('deadline crossing during capture never restarts the pilot', (t) => {
  const f = fixture(t, 'deadline');
  backup(f.c, f.options);
  assert.ok(!f.calls.some((x) => x.args.includes('start')));
});
test('expired pilot skips without subprocesses; stopped pilot stays stopped; partial state refuses capture', (t) => {
  const expired = fixture(t);
  expired.setClock(Date.parse('2027-04-01T00:00:00Z'));
  assert.equal(backup(expired.c, expired.options).skipped, 'pilot closed');
  assert.equal(expired.calls.length, 0);
  const stopped = fixture(t, '', '');
  backup(stopped.c, stopped.options);
  assert.ok(!stopped.calls.some((x) => x.args.includes('start')));
  const partial = fixture(t, '', 'app\n');
  assert.throws(() => backup(partial.c, partial.options), /partly running/);
  assert.ok(!partial.calls.some((x) => x.file.endsWith('/node')));
});
test('private configuration bounds destinations and schedule retains failure hook and overlap lock entrypoint', (t) => {
  const f = fixture(t);
  for (const patch of [
    { remoteHost: 'host;touch /tmp/x' },
    { remoteUser: '-root' },
    { backupRoot: '/' },
    { secretsDir: join(f.c.backupRoot, 'secrets') },
    { sshKeyFile: join(f.c.projectDir, 'key') },
    { sshKeyFile: join(f.c.secretsDir, 'key') },
    { knownHostsFile: join(f.c.secretsDir, 'known_hosts') },
    { failureUnit: 'clean-bookface-pilot.service' },
    { retentionPath: '/' },
  ])
    assert.throws(() => configuration({ ...f.c, ...patch }));
  const units = schedule(f.c, join(f.c.secretsDir, 'backup.json'));
  assert.match(units['clean-bookface-pilot-backup.timer'], /Persistent=true/);
  assert.match(units['clean-bookface-pilot-backup.service'], /OnFailure=operator-alert.service/);
  assert.match(units['clean-bookface-pilot-backup.service'], /run --config .* --apply/);
  const source = readFileSync(new URL('../deploy/pilot-backup.mjs', import.meta.url), 'utf8');
  assert.match(source, /--nonblock/);
  assert.ok(!source.includes('force-unlock'));
  assert.ok(!source.includes('rmSync'));
});

test('capture uses the controller lifecycle flock and releases it before transfer', (t) => {
  const f = fixture(t);
  let held = false;
  const execute = (file: string, args: string[], options: any = {}) => {
    if (file === '/usr/bin/flock') {
      assert.deepEqual(args.slice(0, 3), ['--exclusive', '--close', '/synthetic/lifecycle.lock']);
      assert.ok(args.includes('--internal-capture'));
      assert.equal(JSON.parse(options.input).backupRoot, f.c.backupRoot);
      assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
      held = true;
      try {
        return JSON.stringify(capturePilot(f.c, { ...f.options, execute, lifecycleLocked: true }));
      } finally {
        held = false;
      }
    }
    if (file.endsWith('/rsync'))
      assert.equal(held, false, 'network copy must not block lifecycle operations');
    else assert.equal(held, true, 'state read and every maintenance action share one lock');
    if (file.endsWith('/node'))
      assert.ok(
        args.includes('--internal-lock-held'),
        'avoid recursively acquiring controller lock',
      );
    return f.options.execute(file, args);
  };
  backup(f.c, {
    checkHost: () => {},
    execute,
    captureRun: (input: any, runner: any, node: any) =>
      lockedCapture(input, runner, node, () => '/synthetic/lifecycle.lock'),
    now: f.options.now,
  });
  assert.equal(held, false);
  assert.throws(() => capturePilot(f.c), /requires the pilot lifecycle lock/);
});

for (const arrival of ['before-admission', 'during-capture', 'during-restart', 'read-error'])
  test(`external stop ${arrival} cancels automatic resume even when stop waiter times out`, (t) => {
    const f = fixture(t);
    let intent = arrival === 'before-admission' ? 'pending-stop' : '';
    let running = true;
    let reads = 0;
    const options = {
      ...f.options,
      lifecycleLocked: true,
      stopAcknowledgement: () => '',
      stopIntent: () => {
        reads++;
        if (arrival === 'read-error' && reads > 1) throw new Error('unreadable marker');
        return intent;
      },
      execute: (file: string, args: string[]) => {
        if (args.includes('reconciliation-export') && arrival === 'during-capture') {
          intent = 'timed-out-stop'; // Its lock waiter already failed; intent must still apply.
        }
        if (file.endsWith('/node') && args.includes('stop')) running = false;
        if (file.endsWith('/node') && args.includes('start')) {
          assert.ok(args.includes('--internal-maintenance-start'));
          running = true;
          if (arrival === 'during-restart') intent = 'stop-during-start';
        }
        return f.options.execute(file, args);
      },
    };
    if (arrival === 'read-error') assert.throws(() => capturePilot(f.c, options), /restart failed/);
    else capturePilot(f.c, options);
    assert.equal(running, false);
    if (arrival === 'before-admission' || arrival === 'during-capture')
      assert.ok(!f.calls.some((x) => x.args.includes('start')));
  });

test('acknowledged older stop does not prevent later authorized operation', (t) => {
  const f = fixture(t);
  capturePilot(f.c, {
    ...f.options,
    lifecycleLocked: true,
    stopIntent: () => 'old-stop',
    stopAcknowledgement: () => 'old-stop',
  });
  assert.ok(f.calls.some((x) => x.args.includes('start')));
});

test('nonstandard reviewed Node path is reused by schedule, locked capture, and controller', (t) => {
  const f = fixture(t);
  const nodePath = '/opt/reviewed-runtime/node';
  assert.match(
    schedule(f.c, '/secure/backup.json', nodePath)['clean-bookface-pilot-backup.service'],
    /ExecStart=\/opt\/reviewed-runtime\/node -- /,
  );
  lockedCapture(
    f.c,
    (_file: string, args: string[]) => {
      assert.equal(args[3], nodePath);
      return JSON.stringify({ skipped: 'fixture' });
    },
    nodePath,
    () => '/synthetic/lifecycle.lock',
  );
  capturePilot(f.c, { ...f.options, lifecycleLocked: true, nodePath });
  const controllers = f.calls.filter((x) => x.file.endsWith('/node'));
  assert.ok(controllers.length >= 2);
  for (const call of controllers) {
    assert.equal(call.file, nodePath);
    assert.equal(call.args[call.args.indexOf('--node') + 1], nodePath);
  }
  for (const invalid of ['node', '/opt/node runtime/node', '/opt/$(node)/node']) {
    assert.throws(() => schedule(f.c, '/secure/backup.json', invalid));
    assert.throws(() => lockedCapture(f.c, () => '{}', invalid));
  }
});

test('dashboard-only must be explicit and never requires or schedules an external hook', (t) => {
  const f = fixture(t);
  const { failureUnit, ...base } = f.c;
  assert.throws(() => configuration(base), /notification service/);
  const c = configuration({ ...base, alertMode: 'dashboard-only' });
  assert.equal(c.alertMode, 'dashboard-only');
  assert.ok(
    !schedule(c, '/secure/backup.json')['clean-bookface-pilot-backup.service'].includes(
      'OnFailure=',
    ),
  );
  checkFailureUnit(c, () => {
    throw new Error('dashboard mode must not probe external hook');
  });
  assert.throws(() => checkFailureUnit(configuration(f.c), () => 'not-found'), /notification unit/);
  assert.throws(() => configuration({ ...f.c, alertMode: 'dashboard-only' }), /omit failureUnit/);
  assert.throws(() => configuration({ ...base, alertMode: 'none' }));
});

test('durable attempts expose running, success, failure and skipped without secrets or replacing last success', (t) => {
  const f = fixture(t);
  const attemptPath = join(f.c.backupRoot, 'last-offhost-attempt.json');
  let observedRunning = false;
  const result = backup(f.c, {
    ...f.options,
    captureRun: () => {
      const current = JSON.parse(readFileSync(attemptPath, 'utf8'));
      assert.equal(current.status, 'running');
      assert.equal(current.finishedAt, undefined);
      observedRunning = true;
      return f.options.captureRun();
    },
  });
  assert.equal(observedRunning, true);
  let attempt = JSON.parse(readFileSync(attemptPath, 'utf8'));
  assert.equal(attempt.format, 'clean-bookface-offhost-attempt/1');
  assert.equal(attempt.status, 'succeeded');
  assert.equal(attempt.generation, result.generation);
  const successPath = join(f.c.backupRoot, 'last-offhost-success.json');
  const success = readFileSync(successPath, 'utf8');
  assert.throws(() =>
    backup(f.c, {
      ...f.options,
      captureRun: () => {
        throw new Error('secret-password-do-not-record');
      },
    }),
  );
  attempt = JSON.parse(readFileSync(attemptPath, 'utf8'));
  assert.equal(attempt.status, 'failed');
  assert.ok(attempt.finishedAt);
  assert.ok(!JSON.stringify(attempt).includes('secret-password'));
  assert.equal(readFileSync(successPath, 'utf8'), success);
  backup(f.c, { ...f.options, captureRun: () => ({ skipped: 'pilot closed' }) });
  assert.equal(JSON.parse(readFileSync(attemptPath, 'utf8')).status, 'skipped');
  assert.equal(readFileSync(successPath, 'utf8'), success);
});

test('trusted directories reject linked or writable ancestors before using paths', (t) => {
  const f = fixture(t),
    uid = process.getuid!();
  const safe = join(f.c.backupRoot, 'safe');
  mkdirSync(safe, { mode: 0o700 });
  assert.equal(protectedDirectory(safe, uid, f.c.backupRoot), safe);
  const alias = join(f.c.backupRoot, 'alias');
  symlinkSync(safe, alias);
  assert.throws(() => protectedDirectory(alias, uid, f.c.backupRoot), /trusted ownership/);
  chmodSync(safe, 0o770);
  assert.throws(() => protectedDirectory(safe, uid, f.c.backupRoot), /trusted ownership/);
  assert.throws(() => protectedDirectory(safe, uid + 1, f.c.backupRoot), /trusted ownership/);
});

test('runtime locks create private files and refuse preplanted symlinks and hardlinks', (t) => {
  const f = fixture(t),
    uid = process.getuid!();
  const directory = join(f.c.backupRoot, 'runtime');
  const filename = lockPath('lifecycle', directory, uid, f.c.backupRoot);
  assert.equal(lockPath('lifecycle', directory, uid, f.c.backupRoot), filename);
  const victim = join(f.c.backupRoot, 'victim');
  writeFileSync(victim, 'unchanged', { mode: 0o600 });
  const backupLock = join(directory, 'backup.lock');
  symlinkSync(victim, backupLock);
  assert.throws(() => lockPath('backup', directory, uid, f.c.backupRoot), /unlinked regular/);
  assert.equal(readFileSync(victim, 'utf8'), 'unchanged');
  rmSync(backupLock);
  linkSync(victim, backupLock);
  assert.throws(() => lockPath('backup', directory, uid, f.c.backupRoot), /unlinked regular/);
});

test('host receipts replace leaf links without overwriting their targets; ledger reads refuse links', (t) => {
  const f = fixture(t),
    uid = process.getuid!();
  const victim = join(f.c.backupRoot, 'victim');
  const receipt = join(f.c.backupRoot, 'capture.json');
  writeFileSync(victim, 'private-victim', { mode: 0o600 });
  symlinkSync(victim, receipt);
  atomicReceipt(receipt, 'new-receipt');
  assert.equal(readFileSync(victim, 'utf8'), 'private-victim');
  assert.equal(readFileSync(receipt, 'utf8'), 'new-receipt');
  const linked = join(f.c.backupRoot, 'current-state.enc');
  symlinkSync(victim, linked);
  assert.throws(() => readLedger(linked, uid));
  rmSync(linked);
  linkSync(victim, linked);
  assert.throws(() => readLedger(linked, uid), /bounded private/);
  rmSync(linked);
  assert.equal(readLedger(victim, uid).toString(), 'private-victim');
  chmodSync(victim, 0o644);
  assert.throws(() => readLedger(victim, uid), /bounded private/);
});

test('invalid command JSON never exposes the original text', () => {
  const secret = 'sensitive-synthetic-output';
  assert.throws(
    () => parsePrivateJson(secret),
    (error: Error) => {
      assert.equal(error.message, 'Private command or configuration returned invalid JSON.');
      assert.ok(!error.message.includes(secret));
      return true;
    },
  );
});
