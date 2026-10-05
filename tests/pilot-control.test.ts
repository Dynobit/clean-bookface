import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  parseEnv,
  validate,
  mayStart,
  plan,
  validateToken,
  verifyDeadline,
  childEnvironment,
  verifyCompose,
  startPilot,
  verifyHostResources,
  verifyRunningResources,
  stopPilot,
  TUNNEL_IMAGE,
  readStopIntent,
  recordStopIntent,
  requestStop,
  acknowledgeStopIntent,
} from '../deploy/pilot-control.mjs';
const appImage = `sha256:${'a'.repeat(64)}`;
const env = {
  APP_IMAGE: appImage,
  TUNNEL_IMAGE,
  APP_ORIGIN: 'https://circle.example',
  TUNNEL_TOKEN_FILE: '/secure/pilot-token',
  PILOT_STARTS_AT: '2027-01-01T00:00:00Z',
  PILOT_READ_ONLY_AT: '2027-03-18T00:00:00Z',
  PILOT_ENDS_AT: '2027-04-01T00:00:00Z',
};
const paths = { envFile: '/secure/pilot.env', projectDir: '/opt/clean-bookface' };
test('pilot plan requires exact pins and HTTPS, fixed UTC dates, <=90 days and >=14 days of exports', () => {
  assert.equal(validate(env).maxAccounts, 25);
  assert.equal(validate({ ...env, MAX_ACCOUNTS: '1000' }).maxAccounts, 1000);
  for (const change of [
    { APP_IMAGE: 'clean-bookface:latest' },
    { APP_IMAGE: `repo@sha256:${'x'.repeat(64)}` },
    { TUNNEL_IMAGE: 'cloudflare/cloudflared:latest' },
    { APP_ORIGIN: 'http://circle.example' },
    { APP_ORIGIN: 'https://circle.example/path' },
    { APP_ORIGIN: 'https://password@circle.example' },
    { MAX_ACCOUNTS: '1001' },
    { MAX_ACCOUNTS: '0' },
    { MAX_ACCOUNTS: '1.5' },
    { PILOT_STARTS_AT: undefined },
    { PILOT_READ_ONLY_AT: undefined },
    { PILOT_ENDS_AT: undefined },
    { PILOT_READ_ONLY_AT: '2027-03-19T00:00:00Z' },
    { PILOT_ENDS_AT: '2027-04-02T00:00:00Z' },
    { PILOT_STARTS_AT: '2027-02-30T00:00:00Z' },
    { PILOT_STARTS_AT: '2027-01-01T00:00:00+00:00' },
    { TUNNEL_TOKEN_FILE: 'relative-token' },
  ])
    assert.throws(() => validate({ ...env, ...change }));
  assert.equal(
    validate({ ...env, APP_IMAGE: `ghcr.io/example/project@sha256:${'b'.repeat(64)}` }).appImage,
    `ghcr.io/example/project@sha256:${'b'.repeat(64)}`,
  );
});
test('startup closes at the exact immutable deadline across repeated invocations', () => {
  const config = validate(env);
  assert.throws(() => mayStart(config, config.starts - 1), /not arrived/);
  mayStart(config, config.starts);
  mayStart(config, config.readOnly);
  mayStart(config, config.ends - 1);
  assert.throws(() => mayStart(config, config.ends), /deadline has passed/);
  assert.throws(
    () => mayStart(validate({ ...env }), config.ends + 90 * 86400000),
    /deadline has passed/,
  );
});
test('generated systemd deadline is persistent and stops only dedicated services without deleting volumes', () => {
  const result = plan(env, paths);
  assert.equal(result.commands.stop[3], 'stop');
  assert.ok(!result.commands.stop.includes('--env-file'));
  assert.equal(result.project, 'clean-bookface-pilot');
  assert.match(
    result.units['clean-bookface-pilot-deadline.timer'],
    /OnCalendar=2027-04-01 00:00:00 UTC\nPersistent=true/,
  );
  assert.match(
    result.units['clean-bookface-pilot.service'],
    /Requires=docker.service clean-bookface-pilot-deadline.timer/,
  );
  assert.match(result.units['clean-bookface-pilot.service'], /pilot-control.mjs" "start"/);
  assert.ok(
    !result.commands.stop.some((x) => ['down', 'rm', '--volumes', '--remove-orphans'].includes(x)),
  );
  assert.throws(
    () => plan(env, { ...paths, projectDir: '/opt/a space%name$literal' }),
    /absolute single-line/,
  );
  assert.throws(() => plan(env, { ...paths, projectDir: '/opt/a\nInjected=yes' }), /single-line/);
  const compose = readFileSync(resolve('deploy/compose.pilot.yaml'), 'utf8');
  assert.equal(
    (compose.match(/restart: ['"]no['"]/g) ?? []).length,
    2,
    'Docker reboot must not bypass the deadline startup guard',
  );
});
test('deadline shutdown retries transient failures without changing its fixed schedule', () => {
  const result = plan(env, paths);
  const units = result.units;
  assert.match(units['clean-bookface-pilot-deadline.service'], /Restart=on-failure/);
  assert.match(units['clean-bookface-pilot-deadline.service'], /RestartSec=30s/);
  assert.match(units['clean-bookface-pilot-deadline.service'], /TimeoutStartSec=660/);
  assert.match(units['clean-bookface-pilot-deadline.timer'], /2027-04-01 00:00:00 UTC/);
});

test('live token permissions must be private and readable by the configured tunnel uid/gid', () => {
  const stat = {
    isFile: () => true,
    isSymbolicLink: () => false,
    size: 120,
    uid: 0,
    gid: 65532,
    mode: 0o440,
  };
  validateToken(stat);
  validateToken({ ...stat, uid: 65532, gid: 65532, mode: 0o400 });
  for (const change of [
    { mode: 0o444 },
    { mode: 0o460 },
    { uid: 1000 },
    { gid: 0 },
    { size: 0 },
    { size: 16385 },
    { isSymbolicLink: () => true },
    { isFile: () => false },
  ])
    assert.throws(() => validateToken({ ...stat, ...change }));
});
function systemdReply(result: any, overrides: Record<string, string> = {}) {
  return (_file: string, args: string[]) => {
    if (args[0] === 'cat') return '# /etc/systemd/system/' + args[1] + '\n' + result.units[args[1]];
    if (args[1].endsWith('.service'))
      return (
        `NeedDaemonReload=no\nLoadState=loaded\nExecStart={ path=${result.stopControl[0]} ; argv[]=${result.stopControl.join(' ')} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }\n` +
        (overrides.service ?? '')
      );
    return (
      'NeedDaemonReload=no\nLoadState=loaded\nActiveState=active\nUnitFileState=enabled\nPersistent=yes\nUnit=clean-bookface-pilot-deadline.service\nTimersCalendar={ OnCalendar=2027-04-01 00:00:00 UTC ; next_elapse=Thu 2027-04-01 00:00:00 UTC }\nNextElapseUSecRealtime=Thu 2027-04-01 00:00:00 UTC\n' +
      (overrides.timer ?? '')
    );
  };
}
test('startup checks manager-loaded deadline state, not just unit files on disk', () => {
  const result = plan(env, paths);
  verifyDeadline(result, systemdReply(result));
  for (const timer of [
    'NeedDaemonReload=yes',
    'ActiveState=inactive',
    'Persistent=no',
    'UnitFileState=enabled-runtime',
    'NextElapseUSecRealtime=Thu 2099-01-01 00:00:00 UTC',
    'TimersCalendar={ OnCalendar=2099-01-01 00:00:00 UTC ; next_elapse=n/a }',
  ])
    assert.throws(() => verifyDeadline(result, systemdReply(result, { timer })));
  for (const service of [
    'NeedDaemonReload=yes',
    'ExecStart={ path=/bin/true ; argv[]=/bin/true ; ignore_errors=no ; }',
  ])
    assert.throws(() => verifyDeadline(result, systemdReply(result, { service })));
  assert.throws(
    () => verifyDeadline(result, () => '[Timer]\nOnCalendar=2099-01-01'),
    /do not match/,
  );
});
test('CLI defaults to a read-only plan, rejects ambiguous flags and refuses expired startup without calling Docker', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bookface-pilot-control-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const envFile = join(root, 'pilot.env');
  writeFileSync(
    envFile,
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
    { mode: 0o600 },
  );
  const script = resolve('deploy/pilot-control.mjs');
  const output = execFileSync(
    process.execPath,
    [
      '--',
      script,
      '--env-file',
      envFile,
      '--project-dir',
      resolve('.'),
      '--docker',
      '/does-not-exist',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(JSON.parse(output).dryRun, true);
  const ambiguous = spawnSync(
    process.execPath,
    ['--', script, 'start', '--env-file', envFile, '--apply', '--dry-run'],
    { encoding: 'utf8' },
  );
  assert.equal(ambiguous.status, 1);
  assert.match(ambiguous.stderr, /not both/);
  const expired = {
    ...env,
    PILOT_STARTS_AT: '2001-01-01T00:00:00Z',
    PILOT_READ_ONLY_AT: '2001-03-18T00:00:00Z',
    PILOT_ENDS_AT: '2001-04-01T00:00:00Z',
  };
  writeFileSync(
    envFile,
    Object.entries(expired)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
  );
  const closed = spawnSync(
    process.execPath,
    ['--', script, 'start', '--env-file', envFile, '--docker', '/does-not-exist', '--apply'],
    { encoding: 'utf8' },
  );
  assert.equal(closed.status, 78);
  assert.match(closed.stderr, /deadline has passed/);
  assert.doesNotMatch(closed.stderr, /ENOENT/);
  assert.throws(() => parseEnv('APP_IMAGE=a\nAPP_IMAGE=b'), /duplicate/);
  assert.throws(() => parseEnv('APP_IMAGE=$(command)'), /literal/);
});

test('Docker child environment contains only fixed controls and validated literal settings', () => {
  const child = childEnvironment(env);
  assert.equal(child.DOCKER_HOST, 'unix:///var/run/docker.sock');
  assert.equal(child.APP_IMAGE, appImage);
  assert.equal(child.MAX_ACCOUNTS, '25');
  assert.equal(child.MAINTENANCE_MODE, 'false');
  assert.equal(child.PATH, '/usr/sbin:/usr/bin:/sbin:/bin');
  for (const key of [
    'DOCKER_CONTEXT',
    'DOCKER_TLS_VERIFY',
    'DOCKER_CERT_PATH',
    'COMPOSE_FILE',
    'COMPOSE_PROFILES',
    'NODE_OPTIONS',
    'LD_PRELOAD',
  ])
    assert.equal(child[key], undefined);
  assert.throws(
    () => childEnvironment({ ...env, DOCKER_HOST: 'tcp://other.example:2375' }),
    /Unexpected setting/,
  );
});
test('failed, timed-out, late, or partially successful startup always stops and reads back only pilot services', () => {
  const result = plan(env, paths),
    starts = Date.parse(env.PILOT_STARTS_AT),
    ends = Date.parse(env.PILOT_ENDS_AT);
  for (const mode of ['failure', 'timeout', 'late']) {
    const calls: any[] = [];
    let now = starts;
    const run = (_file: string, args: string[], options: any) => {
      calls.push({ args, options });
      if (args.includes('info'))
        return JSON.stringify({
          MemoryLimit: true,
          CpuCfsQuota: true,
          CpuCfsPeriod: true,
          PidsLimit: true,
          CgroupVersion: '2',
        });
      if (args.includes('up')) {
        if (mode === 'late') {
          now = ends;
          return '';
        }
        throw new Error(mode === 'timeout' ? 'ETIMEDOUT' : 'partial up failure');
      }
      if (args.includes('ps') && args.includes('--all'))
        return `${'a'.repeat(64)}\tclean-bookface-pilot\tapp\n`;
      return '';
    };
    assert.throws(() => startPilot(result, env, { run, now: () => now }));
    assert.ok(calls.some((call) => call.args.includes('stop')));
    assert.ok(calls.at(-1).args.includes('ps'));
    for (const call of calls) {
      assert.equal(call.options.env.APP_IMAGE, call.args.includes('up') ? appImage : undefined);
      assert.equal(call.options.env.DOCKER_HOST, 'unix:///var/run/docker.sock');
      assert.deepEqual(call.args.slice(0, 2), ['--host', 'unix:///var/run/docker.sock']);
    }
  }
  const calls: string[][] = [];
  assert.throws(
    () =>
      startPilot(result, env, {
        now: () => ends - 1000,
        run: (_f: string, args: string[]) => {
          calls.push(args);
          return '';
        },
      }),
    /Too close/,
  );
  assert.ok(!calls.some((args) => args.includes('up')));
  assert.throws(
    () =>
      stopPilot('/usr/bin/docker', (_f: string, args: string[]) =>
        args.includes('ps') ? `${'a'.repeat(64)}\tclean-bookface-pilot\tapp\n` : '',
      ),
    /still running/,
  );
});

function renderedFixture() {
  const common = {
    cap_drop: ['ALL'],
    init: true,
    logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } },
    read_only: true,
    restart: 'no',
    security_opt: ['no-new-privileges:true'],
    entrypoint: null,
  };
  return {
    name: 'clean-bookface-pilot',
    volumes: { app_data: { name: 'clean-bookface-pilot_app_data' } },
    secrets: {
      tunnel_token: { name: 'clean-bookface-pilot_tunnel_token', file: '/secure/pilot-token' },
    },
    networks: {
      application: { name: 'clean-bookface-pilot_application', internal: true, ipam: {} },
      outbound: { name: 'clean-bookface-pilot_outbound', ipam: {} },
    },
    services: {
      app: {
        ...common,
        image: appImage,
        command: null,
        user: '1000:1000',
        cpus: 1,
        mem_limit: '2147483648',
        pids_limit: 128,
        tmpfs: ['/tmp:size=64m,mode=1777'],
        networks: { application: null },
        stop_grace_period: '1m0s',
        volumes: [{ type: 'volume', source: 'app_data', target: '/data', volume: {} }],
        environment: {
          NODE_ENV: 'production',
          BIND_ADDRESS: '0.0.0.0',
          PORT: '3000',
          DATA_DIR: '/data',
          APP_ORIGIN: 'https://circle.example',
          INSTANCE_NAME: 'Clean Bookface pilot',
          FEDERATION_ENABLED: 'false',
          CLOUDFLARE_PROXY: 'true',
          MAX_ACCOUNTS: '25',
          ARCHIVE_ACCOUNT_BYTES: '1073741824',
          MAX_UPLOAD_BYTES: '1073741824',
          MAX_DIRECT_UPLOAD_BYTES: '83886080',
          PILOT_STARTS_AT: '2027-01-01T00:00:00Z',
          PILOT_READ_ONLY_AT: '2027-03-18T00:00:00Z',
          PILOT_ENDS_AT: '2027-04-01T00:00:00Z',
          MAINTENANCE_MODE: 'false',
        },
      },
      tunnel: {
        ...common,
        image: TUNNEL_IMAGE,
        command: ['tunnel', '--no-autoupdate', 'run', '--token-file', '/run/secrets/tunnel_token'],
        user: '65532:65532',
        cpus: 0.5,
        mem_limit: '268435456',
        pids_limit: 64,
        tmpfs: ['/tmp:size=16m,mode=1777'],
        networks: { application: null, outbound: null },
        secrets: [{ source: 'tunnel_token', target: '/run/secrets/tunnel_token' }],
        depends_on: { app: { condition: 'service_healthy', required: true } },
      },
    },
  };
}
test('rendered Compose rejects drift in actual images, deadlines, mounts, networking and resource caps', () => {
  verifyCompose(renderedFixture(), env);
  for (const mutate of [
    (c: any) => {
      c.name = 'other-project';
    },
    (c: any) => {
      c.services.app.image = 'unreviewed:latest';
    },
    (c: any) => {
      c.services.app.environment.PILOT_ENDS_AT = '2099-01-01T00:00:00Z';
    },
    (c: any) => {
      c.services.app.environment.MAX_ACCOUNTS = '9999';
    },
    (c: any) => {
      c.secrets.tunnel_token.file = '/different/token';
    },
    (c: any) => {
      c.services.app.volumes = [{ type: 'bind', source: '/', target: '/host' }];
    },
    (c: any) => {
      c.services.app.ports = ['3000:3000'];
    },
    (c: any) => {
      c.networks.application.internal = false;
    },
    (c: any) => {
      c.services.app.networks.outbound = null;
    },
    (c: any) => {
      c.services.app.mem_limit = '8589934592';
    },
    (c: any) => {
      c.services.tunnel.cpus = 8;
    },
    (c: any) => {
      c.services.app.pids_limit = -1;
    },
    (c: any) => {
      c.services.app.privileged = true;
    },
    (c: any) => {
      c.services.app.restart = 'unless-stopped';
    },
    (c: any) => {
      c.services.tunnel.command = ['tunnel', '--token', 'inline-secret'];
    },
  ]) {
    const actual = renderedFixture();
    mutate(actual);
    assert.throws(() => verifyCompose(actual, env), /differs/);
  }
});

test('shutdown ignores absent, corrupt or obsolete settings and stops only exact fixed-project app/tunnel IDs', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pilot-stop-proof-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = resolve('deploy/pilot-control.mjs'),
    fakeDocker = join(root, 'docker'),
    log = join(root, 'calls.json');
  const app = 'a'.repeat(64),
    tunnel = 'b'.repeat(64),
    other = 'c'.repeat(64);
  writeFileSync(
    fakeDocker,
    '#!' +
      process.execPath +
      '\n' +
      `
    const fs=require('node:fs');
    const log=${JSON.stringify(log)};
    const calls=fs.existsSync(log)?JSON.parse(fs.readFileSync(log,'utf8')):[];
    const args=process.argv.slice(2);
    if(args.includes('stop') && args.includes('--timeout')) {process.stderr.write('unknown flag: --timeout');process.exit(125);}
    calls.push({args,env:process.env});fs.writeFileSync(log,JSON.stringify(calls));
    if(args.includes('ps')) {
      console.log(${JSON.stringify(other + '\tother-project\tapp')});
      console.log(${JSON.stringify(other + '\tclean-bookface-pilot\tunrelated-service')});
      if(!calls.some(c=>c.args.includes('stop'))) {
        console.log(${JSON.stringify(app + '\tclean-bookface-pilot\tapp')});
        console.log(${JSON.stringify(tunnel + '\tclean-bookface-pilot\ttunnel')});
      }
    }
  `,
    { mode: 0o755 },
  );
  for (const contents of [
    undefined,
    'not valid dotenv at all',
    Object.entries({ ...env, TUNNEL_IMAGE: 'obsolete-controller-pin' })
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
  ]) {
    const envFile = join(root, 'pilot.env');
    rmSync(envFile, { force: true });
    rmSync(log, { force: true });
    if (contents !== undefined) writeFileSync(envFile, contents);
    // Exercise the child command after flock; the fake Docker binary performs no host operation.
    const response = spawnSync(
      process.execPath,
      [
        '--',
        script,
        'stop',
        '--env-file',
        envFile,
        '--project-dir',
        '/missing/checkout',
        '--docker',
        fakeDocker,
        '--apply',
        '--internal-lock-held',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          APP_IMAGE: 'ambient-unreviewed-image',
          DOCKER_HOST: 'tcp://other.example:2375',
          DOCKER_CONTEXT: 'other-host',
          COMPOSE_FILE: '/wrong/compose.yaml',
        },
      },
    );
    assert.equal(response.status, 0, response.stderr);
    const calls = JSON.parse(readFileSync(log, 'utf8'));
    const stopped = calls.find((c: any) => c.args.includes('stop'));
    assert.deepEqual(stopped.args, [
      '--host',
      'unix:///var/run/docker.sock',
      'stop',
      '-t',
      '60',
      app,
      tunnel,
    ]);
    assert.ok(!stopped.args.includes(other));
    assert.ok(calls.at(-1).args.includes('ps'));
    for (const call of calls) {
      assert.equal(call.env.DOCKER_HOST, 'unix:///var/run/docker.sock');
      for (const key of ['APP_IMAGE', 'DOCKER_CONTEXT', 'COMPOSE_FILE'])
        assert.equal(call.env[key], undefined);
    }
  }
  const dry = spawnSync(process.execPath, ['--', script, 'stop', '--docker', '/missing/docker'], {
    encoding: 'utf8',
  });
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).dryRun, true);
});

test('stop preserves safe CLI failure context alongside failed shutdown readback', () => {
  const line = `${'a'.repeat(64)}\tclean-bookface-pilot\tapp\n`;
  const calls: string[][] = [];
  const run = (_file: string, args: string[]) => {
    calls.push(args);
    if (args.includes('ps')) return line;
    assert.deepEqual(args.slice(2, 5), ['stop', '-t', '60']);
    throw Object.assign(new Error('SECRET should not be copied'), {
      status: 125,
      stderr: 'unknown flag: --timeout\nSECRET environment contents',
    });
  };
  assert.throws(
    () => stopPilot('/usr/bin/docker', run),
    (error: Error) => {
      assert.match(error.message, /exit 125/);
      assert.match(error.message, /unsupported flag --timeout/);
      assert.match(error.message, /still running/);
      assert.doesNotMatch(error.message, /SECRET|environment contents/);
      return true;
    },
  );
  assert.ok(calls.at(-1)!.includes('ps'), 'readback must still run after a rejected stop command');
});

test('external stop records durable intent before a timed-out waiter; explicit start acknowledges only observed generation', (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pilot-stop-intent-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'stop-intent');
  const uid = process.getuid!();
  assert.equal(readStopIntent(filename, uid), '');
  assert.throws(
    () =>
      requestStop(
        () => {
          throw new Error('lock timeout');
        },
        () => recordStopIntent(filename, uid),
      ),
    /lock timeout/,
  );
  const first = readStopIntent(filename, uid);
  assert.match(first, /^[a-f0-9-]{36}$/);
  let acknowledged = '';
  acknowledgeStopIntent(
    () => first,
    (nonce) => {
      recordStopIntent(filename, uid); // A newer external stop races with acknowledgement.
      acknowledged = nonce;
    },
  );
  assert.equal(acknowledged, first);
  assert.notEqual(readStopIntent(filename, uid), acknowledged);
  // A later explicit start can acknowledge the latest request, without clearing or losing it.
  acknowledgeStopIntent(
    () => readStopIntent(filename, uid),
    (nonce) => {
      acknowledged = nonce;
    },
  );
  assert.equal(readStopIntent(filename, uid), acknowledged);
  writeFileSync(filename, 'corrupt');
  assert.throws(() => readStopIntent(filename, uid), /invalid/);
  recordStopIntent(filename, uid); // Corrupt contents cannot prevent a new external stop.
  assert.match(readStopIntent(filename, uid), /^[a-f0-9-]{36}$/);
});

test('failed stop-intent recording still attempts scoped shutdown and reports both outcomes', () => {
  let attempted = 0;
  const record = () => {
    throw new Error('ENOSPC');
  };
  assert.throws(
    () =>
      requestStop(() => {
        attempted++;
      }, record),
    /recording failed; scoped shutdown completed/,
  );
  assert.equal(attempted, 1);
  assert.throws(
    () =>
      requestStop(() => {
        attempted++;
        throw new Error('timeout');
      }, record),
    /recording failed, and scoped shutdown also failed/,
  );
  assert.equal(attempted, 2);
});

test('startup refuses missing Docker resource enforcement before creating any container', () => {
  const supported = {
    MemoryLimit: true,
    CpuCfsQuota: true,
    CpuCfsPeriod: true,
    PidsLimit: true,
    CgroupVersion: '2',
  };
  verifyHostResources('/usr/bin/docker', () => JSON.stringify(supported));
  for (const change of [
    { MemoryLimit: false },
    { MemoryLimit: undefined },
    { CpuCfsQuota: false },
    { CpuCfsPeriod: false },
    { PidsLimit: false },
    { CgroupVersion: '1' },
  ]) {
    const calls: string[][] = [];
    const run = (_file: string, args: string[]) => {
      calls.push(args);
      if (args.includes('info')) return JSON.stringify({ ...supported, ...change });
      return '';
    };
    assert.throws(
      () => startPilot(plan(env, paths), env, { run, now: () => Date.parse(env.PILOT_STARTS_AT) }),
      /memory|CPU|process|cgroup v2/,
    );
    assert.ok(!calls.some((args) => args.includes('up')));
  }
  assert.throws(
    () =>
      verifyHostResources('/usr/bin/docker', () => {
        throw new Error('private stderr secret');
      }),
    (error) =>
      error instanceof Error &&
      error.message === 'Cannot verify Docker host resource controls. Pilot startup refused.',
  );
});

test('effective running cgroups must match both service limits even when Docker claims support', () => {
  const result = plan(env, paths),
    ids = { app: 'a'.repeat(64), tunnel: 'b'.repeat(64) };
  const supported = {
    MemoryLimit: true,
    CpuCfsQuota: true,
    CpuCfsPeriod: true,
    PidsLimit: true,
    CgroupVersion: '2',
  };
  const fixtures: Record<string, string> = {
    '/proc/101/cgroup': '0::/pilot-app\n',
    '/proc/102/cgroup': '0::/pilot-tunnel\n',
    '/sys/fs/cgroup/pilot-app/memory.max': '2147483648\n',
    '/sys/fs/cgroup/pilot-app/cpu.max': '100000 100000\n',
    '/sys/fs/cgroup/pilot-app/pids.max': '128\n',
    '/sys/fs/cgroup/pilot-tunnel/memory.max': '268435456\n',
    '/sys/fs/cgroup/pilot-tunnel/cpu.max': '50000 100000\n',
    '/sys/fs/cgroup/pilot-tunnel/pids.max': '64\n',
  };
  const calls: string[][] = [];
  let stopped = false;
  const run = (_file: string, args: string[]) => {
    calls.push(args);
    if (args.includes('info')) return JSON.stringify(supported);
    if (args.includes('ps') && args.includes('--quiet'))
      return ids[args.at(-1) as keyof typeof ids];
    if (args.includes('inspect')) {
      const service = args.at(-1) === ids.app ? 'app' : 'tunnel';
      return JSON.stringify([
        {
          State: { Running: true, Pid: service === 'app' ? 101 : 102 },
          Config: {
            Labels: {
              'com.docker.compose.project': 'clean-bookface-pilot',
              'com.docker.compose.service': service,
            },
          },
          HostConfig: { Memory: 2147483648 },
        },
      ]);
    }
    if (args.includes('stop')) stopped = true;
    if (args.includes('ps') && !args.includes('--quiet'))
      return stopped ? '' : `${ids.app}\tclean-bookface-pilot\tapp\n`;
    return '';
  };
  const read = (path: string) => {
    if (!(path in fixtures)) throw new Error('missing kernel control');
    return fixtures[path]!;
  };
  verifyRunningResources(result, env, run, read);
  startPilot(result, env, { run, read, now: () => Date.parse(env.PILOT_STARTS_AT) });
  for (const [path, bad] of [
    ['/sys/fs/cgroup/pilot-app/memory.max', 'max'],
    ['/sys/fs/cgroup/pilot-tunnel/memory.max', 'max'],
    ['/sys/fs/cgroup/pilot-app/cpu.max', 'max 100000'],
    ['/sys/fs/cgroup/pilot-tunnel/pids.max', 'max'],
    ['/proc/101/cgroup', '0::/../../elsewhere'],
  ]) {
    stopped = false;
    const previous = fixtures[path!]!;
    fixtures[path!] = bad!;
    assert.throws(
      () => startPilot(result, env, { run, read, now: () => Date.parse(env.PILOT_STARTS_AT) }),
      /Running pilot resource limits/,
    );
    assert.equal(stopped, true);
    fixtures[path!] = previous;
  }
  assert.ok(calls.some((args) => args.includes('up')));
});
