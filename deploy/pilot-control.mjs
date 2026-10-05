#!/usr/bin/env node
// Reviewable control for this one Compose project. Never deletes volumes; Compose may recreate containers.
import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PROJECT = 'clean-bookface-pilot';
export const TUNNEL_IMAGE =
  'cloudflare/cloudflared:2026.9.3@sha256:072c067d25ccbe61d46e18f0d0723255f2bb5304f7317caa95b27031520ff92c';
const DAY = 86400000;
const fail = (message) => {
  const error = new Error(message);
  error.safePilotMessage = true;
  throw error;
};

// Each ancestor is owned by the trusted host identity and cannot be renamed by
// another uid. This makes later pathname opens stable without an lstat/open race.
export function protectedDirectory(directory, uid = 0, boundary = '/') {
  directory = resolve(directory);
  boundary = resolve(boundary);
  if (directory !== boundary && !directory.startsWith(boundary === '/' ? '/' : boundary + '/'))
    fail('Protected directory lies outside its trusted boundary.');
  for (let current = directory; ; current = dirname(current)) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || stat.mode & 0o022)
      fail('Protected directory must have trusted ownership and unmodifiable ancestors.');
    if (current === boundary) break;
  }
  return directory;
}
export function lockPath(name, directory = '/run/clean-bookface-pilot', uid = 0, boundary = '/') {
  if (!['lifecycle', 'backup'].includes(name)) fail('Invalid pilot lock.');
  protectedDirectory(dirname(directory), uid, boundary);
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  protectedDirectory(directory, uid, boundary);
  if (lstatSync(directory).mode & 0o077) fail('Pilot runtime directory must be private.');
  const filename = join(directory, name + '.lock');
  try {
    closeSync(openSync(filename, 'wx', 0o600));
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  try {
    const stat = lstatSync(filename);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== uid ||
      stat.nlink !== 1 ||
      stat.mode & 0o077
    )
      fail('Pilot lock must be a private unlinked regular file.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return filename;
}
export function parsePrivateJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    fail('Private command or configuration returned invalid JSON.');
  }
}

export const STOP_INTENT = '/run/clean-bookface-pilot-stop-intent';
// The production path is fixed; alternate paths/uid are only test seams, never CLI input.
export function readStopIntent(filename = STOP_INTENT, uid = 0, validateContents = true) {
  const parent = dirname(filename),
    dir = lstatSync(parent);
  if (!dir.isDirectory() || dir.uid !== uid || dir.mode & 0o022 || realpathSync(parent) !== parent)
    fail('Stop intent directory is not private to its owner.');
  let stat;
  try {
    stat = lstatSync(filename);
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || stat.mode & 0o077)
    fail('Stop intent file must be an owner-private regular file.');
  const nonce = readFileSync(filename, 'utf8');
  if (
    validateContents &&
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(nonce)
  )
    fail('Stop intent file is invalid; automatic resume is disabled.');
  return nonce;
}
export const STOP_ACK = '/run/clean-bookface-pilot-stop-ack';
function writeIntentNonce(filename, nonce, uid) {
  // Validate the protected parent even when this is the first stop request.
  readStopIntent(filename, uid, false);
  const temporary = filename + '.' + randomUUID();
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, nonce);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, filename);
    const directory = openSync(dirname(filename), 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return nonce;
}
export function recordStopIntent(filename = STOP_INTENT, uid = 0) {
  return writeIntentNonce(filename, randomUUID(), uid);
}
export function acknowledgeStopIntent(
  read = readStopIntent,
  write = (nonce) => writeIntentNonce(STOP_ACK, nonce, 0),
) {
  const observed = read();
  if (observed) write(observed);
  return observed;
}
export const readStopAcknowledgement = () => readStopIntent(STOP_ACK);
export function requestStop(waitForLock, record = recordStopIntent) {
  let recordingFailed = false;
  try {
    record();
  } catch {
    recordingFailed = true;
  }
  // A full/read-only runtime filesystem must never prevent an attempted scoped shutdown.
  let result;
  try {
    result = waitForLock();
  } catch (error) {
    if (recordingFailed)
      fail('Stop intent recording failed, and scoped shutdown also failed. Inspect pilot state.');
    throw error;
  }
  if (recordingFailed)
    fail(
      'Stop intent recording failed; scoped shutdown completed. Inspect runtime storage before resuming.',
    );
  return result;
}

export function parseEnv(text) {
  const env = {};
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(trimmed);
    if (!match || Object.hasOwn(env, match[1]))
      fail('The environment file contains an invalid or duplicate assignment.');
    let value = match[2].trim();
    if (value.startsWith('"')) {
      try {
        value = parsePrivateJson(value);
      } catch {
        fail('Invalid quoted environment value.');
      }
    } else if (value.startsWith("'")) {
      if (!value.endsWith("'")) fail('Invalid quoted environment value.');
      value = value.slice(1, -1);
    }
    if (typeof value !== 'string' || /[\r\n\0$`]/u.test(value))
      fail('Environment values must be literal single-line values without shell expansion.');
    env[match[1]] = value;
  }
  return env;
}
function date(value, name) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value ?? ''))
    fail(`${name} must be an explicit UTC timestamp (YYYY-MM-DDTHH:MM:SSZ).`);
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value.replace('Z', '.000Z'))
    fail(`${name} is not a real UTC date.`);
  return millis;
}
const SETTINGS = [
  'APP_IMAGE',
  'TUNNEL_IMAGE',
  'APP_ORIGIN',
  'TUNNEL_TOKEN_FILE',
  'PILOT_STARTS_AT',
  'PILOT_READ_ONLY_AT',
  'PILOT_ENDS_AT',
  'MAX_ACCOUNTS',
  'ARCHIVE_ACCOUNT_BYTES',
  'INSTANCE_NAME',
  'MAINTENANCE_MODE',
];
export function validate(env) {
  if (Object.keys(env).some((key) => !SETTINGS.includes(key)))
    fail(
      'Unexpected setting in the pilot environment file. Docker/Compose overrides are not allowed.',
    );
  if (
    Object.values(env).some(
      (value) => value !== undefined && (typeof value !== 'string' || /[\r\n\0$`]/u.test(value)),
    )
  )
    fail('Pilot settings must be literal single-line values.');
  const archiveBytes = Number(env.ARCHIVE_ACCOUNT_BYTES ?? 1073741824);
  if (!Number.isSafeInteger(archiveBytes) || archiveBytes < 1048576 || archiveBytes > 1073741824)
    fail('Pilot archive allowance must be between 1 MiB and 1 GiB.');
  if (!['true', 'false'].includes(env.MAINTENANCE_MODE ?? 'false'))
    fail('MAINTENANCE_MODE must be true or false.');
  if ((env.INSTANCE_NAME ?? '').length > 80) fail('INSTANCE_NAME is too long.');
  if (!/^(?:[a-z0-9][a-z0-9._:/-]*@)?sha256:[a-f0-9]{64}$/u.test(env.APP_IMAGE ?? ''))
    fail(
      'APP_IMAGE must be an exact sha256 image ID or repository@sha256 digest. Tags alone are not accepted.',
    );
  if (env.TUNNEL_IMAGE !== TUNNEL_IMAGE)
    fail('TUNNEL_IMAGE must match the reviewed official cloudflared version and digest.');
  let origin;
  try {
    origin = new URL(env.APP_ORIGIN);
  } catch {
    fail('APP_ORIGIN must be an HTTPS origin.');
  }
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== '/' ||
    !origin.hostname
  )
    fail('APP_ORIGIN must be an HTTPS origin without credentials, path, query or fragment.');
  const starts = date(env.PILOT_STARTS_AT, 'PILOT_STARTS_AT');
  const readOnly = date(env.PILOT_READ_ONLY_AT, 'PILOT_READ_ONLY_AT');
  const ends = date(env.PILOT_ENDS_AT, 'PILOT_ENDS_AT');
  if (starts >= readOnly || readOnly >= ends)
    fail('Pilot dates must order launch, export-only period, then closure.');
  if (ends - starts > 90 * DAY)
    fail('The pilot cannot exceed 90 days from its fixed launch timestamp.');
  if (ends - readOnly < 14 * DAY) fail('Allow at least 14 days to export before closure.');
  const maxAccounts = env.MAX_ACCOUNTS === undefined ? 25 : Number(env.MAX_ACCOUNTS);
  if (!Number.isInteger(maxAccounts) || maxAccounts < 1 || maxAccounts > 1000)
    fail('MAX_ACCOUNTS must be between 1 and 1000; the default is 25.');
  if (!env.TUNNEL_TOKEN_FILE || !isAbsolute(env.TUNNEL_TOKEN_FILE))
    fail('TUNNEL_TOKEN_FILE must be an absolute path outside the checkout.');
  return {
    origin: origin.origin,
    starts,
    readOnly,
    ends,
    maxAccounts,
    archiveBytes,
    appImage: env.APP_IMAGE,
    tunnelImage: env.TUNNEL_IMAGE,
    tokenFile: env.TUNNEL_TOKEN_FILE,
  };
}
export function mayStart(config, now = Date.now()) {
  if (now >= config.ends)
    fail(
      'The fixed pilot deadline has passed. Startup is refused; keep its data for the agreed retention process.',
    );
  if (now < config.starts) fail('The fixed pilot launch timestamp has not arrived.');
}
export function validateToken(stat) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 16384)
    fail('Tunnel token must be a nonempty regular file, not a symlink (at most 16 KiB).');
  const mode = stat.mode & 0o777;
  if (![0, 65532].includes(stat.uid) || (mode & 0o027) !== 0)
    fail(
      'Tunnel token must be owned by root or uid 65532, without group write or any permissions for others.',
    );
  if (!((stat.uid === 65532 && mode & 0o400) || (stat.gid === 65532 && mode & 0o040)))
    fail(
      'Tunnel token must be readable by container uid/gid 65532. Use root:65532 mode 0440, or uid 65532 mode 0400.',
    );
}
function absolute(value, name) {
  if (!isAbsolute(value) || !/^\/[a-zA-Z0-9_./-]+$/u.test(value))
    fail(
      `${name} must be an absolute single-line path using letters, digits, dots, underscores, slashes or hyphens.`,
    );
  return resolve(value);
}
const unitArg = (value) => JSON.stringify(value.replaceAll('%', '%%').replaceAll('$', () => '$$'));
export function plan(
  env,
  { envFile, projectDir, nodePath = '/usr/bin/node', dockerPath = '/usr/bin/docker' } = {},
) {
  const config = validate(env);
  envFile = absolute(envFile ?? '', 'Environment file');
  projectDir = absolute(projectDir ?? '', 'Project directory');
  nodePath = absolute(nodePath, 'Node executable');
  dockerPath = absolute(dockerPath, 'Docker executable');
  const compose = join(projectDir, 'deploy', 'compose.pilot.yaml');
  const control = join(projectDir, 'deploy', 'pilot-control.mjs');
  const composeArgs = [
    '--host',
    'unix:///var/run/docker.sock',
    'compose',
    '--project-directory',
    projectDir,
    '--env-file',
    envFile,
    '--file',
    compose,
    '--project-name',
    PROJECT,
  ];
  const start = [
    nodePath,
    '--',
    control,
    'start',
    '--env-file',
    envFile,
    '--project-dir',
    projectDir,
    '--docker',
    dockerPath,
    '--node',
    nodePath,
    '--apply',
  ];
  const stopControl = [
    nodePath,
    '--',
    control,
    'stop',
    '--docker',
    dockerPath,
    '--node',
    nodePath,
    '--apply',
  ];
  const units = {
    'clean-bookface-pilot.service': `[Unit]\nDescription=Clean Bookface fixed-date invited pilot\nRequires=docker.service clean-bookface-pilot-deadline.timer\nAfter=docker.service network-online.target\nWants=network-online.target\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=${start.map(unitArg).join(' ')}\nExecStop=${stopControl.map(unitArg).join(' ')}\nExecStopPost=${stopControl.map(unitArg).join(' ')}\nTimeoutStartSec=960\nTimeoutStopSec=660\n\n[Install]\nWantedBy=multi-user.target\n`,
    'clean-bookface-pilot-deadline.service': `[Unit]\nDescription=Stop only the Clean Bookface pilot at its fixed deadline\nRequires=docker.service\nAfter=docker.service\n\n[Service]\nType=oneshot\nExecStart=${stopControl.map(unitArg).join(' ')}\nTimeoutStartSec=660\nRestart=on-failure\nRestartSec=30s\n`,
    'clean-bookface-pilot-deadline.timer': `[Unit]\nDescription=Fixed Clean Bookface pilot closure; catch up after downtime\n\n[Timer]\nOnCalendar=${env.PILOT_ENDS_AT.replace('T', ' ').replace('Z', ' UTC')}\nPersistent=true\nAccuracySec=1s\nRandomizedDelaySec=0\nUnit=clean-bookface-pilot-deadline.service\n\n[Install]\nWantedBy=timers.target\n`,
  };
  return {
    project: PROJECT,
    origin: config.origin,
    startsAt: env.PILOT_STARTS_AT,
    readOnlyAt: env.PILOT_READ_ONLY_AT,
    endsAt: env.PILOT_ENDS_AT,
    maxAccounts: config.maxAccounts,
    images: { app: config.appImage, tunnel: config.tunnelImage },
    composeArgs,
    commands: {
      start: [
        dockerPath,
        ...composeArgs,
        'up',
        '--detach',
        '--no-build',
        '--pull',
        'never',
        'app',
        'tunnel',
      ],
      stop: stopControl,
    },
    units,
    stopControl,
    installInstructions: [
      'Save the three exact unit texts under /etc/systemd/system using root ownership and mode 0644.',
      'Review the fixed timestamps and keep the environment file at its exact path. Never regenerate dates on reboot.',
      'After live preflight passes, run: systemctl daemon-reload',
      'Enable the timer before startup: systemctl enable --now clean-bookface-pilot-deadline.timer',
      'Verify the next trigger: systemctl list-timers clean-bookface-pilot-deadline.timer',
      'Only for the approved launch: systemctl enable --now clean-bookface-pilot.service',
      'The shutdown command stops only this dedicated project’s app and tunnel. It never removes data volumes.',
    ],
  };
}
const baseEnvironment = () => ({
  PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
  LANG: 'C',
  LC_ALL: 'C',
  TZ: 'UTC',
});
export function childEnvironment(env) {
  const config = validate(env);
  return {
    ...baseEnvironment(),
    DOCKER_HOST: 'unix:///var/run/docker.sock',
    COMPOSE_DISABLE_ENV_FILE: '1',
    COMPOSE_PROJECT_NAME: PROJECT,
    APP_IMAGE: config.appImage,
    TUNNEL_IMAGE: config.tunnelImage,
    APP_ORIGIN: config.origin,
    TUNNEL_TOKEN_FILE: config.tokenFile,
    PILOT_STARTS_AT: env.PILOT_STARTS_AT,
    PILOT_READ_ONLY_AT: env.PILOT_READ_ONLY_AT,
    PILOT_ENDS_AT: env.PILOT_ENDS_AT,
    MAX_ACCOUNTS: String(config.maxAccounts),
    ARCHIVE_ACCOUNT_BYTES: String(config.archiveBytes),
    INSTANCE_NAME: env.INSTANCE_NAME ?? 'Clean Bookface pilot',
    MAINTENANCE_MODE: env.MAINTENANCE_MODE ?? 'false',
  };
}
const execute = (file, args, options = {}) =>
  execFileSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000,
    env: baseEnvironment(),
    ...options,
  });
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
const same = (actual, expected, label) => {
  if (canonical(actual) !== canonical(expected))
    fail(`Rendered Compose ${label} differs from the reviewed pilot plan.`);
};
export function verifyCompose(actual, env) {
  const settings = childEnvironment(env);
  same(actual.name, PROJECT, 'project');
  same(Object.keys(actual.services ?? {}).sort(), ['app', 'tunnel'], 'services');
  same(Object.keys(actual.volumes ?? {}), ['app_data'], 'volumes');
  same(actual.volumes.app_data, { name: PROJECT + '_app_data' }, 'data volume');
  same(Object.keys(actual.secrets ?? {}), ['tunnel_token'], 'secrets');
  same(
    actual.secrets.tunnel_token,
    { name: PROJECT + '_tunnel_token', file: settings.TUNNEL_TOKEN_FILE },
    'token source',
  );
  same(Object.keys(actual.networks ?? {}).sort(), ['application', 'outbound'], 'networks');
  for (const name of ['application', 'outbound']) {
    const network = actual.networks[name];
    same(
      Object.keys(network).filter((k) => !['name', 'ipam', 'internal'].includes(k)),
      [],
      'network options',
    );
    same(network.name, PROJECT + '_' + name, 'network name');
    same(network.ipam ?? {}, {}, 'network address policy');
    same(Boolean(network.internal), name === 'application', 'network isolation');
  }
  const appEnv = {
    NODE_ENV: 'production',
    BIND_ADDRESS: '0.0.0.0',
    PORT: '3000',
    DATA_DIR: '/data',
    APP_ORIGIN: settings.APP_ORIGIN,
    INSTANCE_NAME: settings.INSTANCE_NAME,
    FEDERATION_ENABLED: 'false',
    CLOUDFLARE_PROXY: 'true',
    MAX_ACCOUNTS: settings.MAX_ACCOUNTS,
    ARCHIVE_ACCOUNT_BYTES: settings.ARCHIVE_ACCOUNT_BYTES,
    MAX_UPLOAD_BYTES: '1073741824',
    MAX_DIRECT_UPLOAD_BYTES: '83886080',
    PILOT_STARTS_AT: settings.PILOT_STARTS_AT,
    PILOT_READ_ONLY_AT: settings.PILOT_READ_ONLY_AT,
    PILOT_ENDS_AT: settings.PILOT_ENDS_AT,
    MAINTENANCE_MODE: settings.MAINTENANCE_MODE,
  };
  for (const name of ['app', 'tunnel']) {
    const service = actual.services[name],
      app = name === 'app';
    const allowed = [
      'cap_drop',
      'cpus',
      'command',
      'entrypoint',
      'environment',
      'image',
      'init',
      'logging',
      'mem_limit',
      'networks',
      'pids_limit',
      'read_only',
      'restart',
      'security_opt',
      'stop_grace_period',
      'tmpfs',
      'user',
      'volumes',
      'depends_on',
      'secrets',
    ];
    same(
      Object.keys(service).filter((k) => !allowed.includes(k)),
      [],
      `${name} options`,
    );
    same(service.image, app ? settings.APP_IMAGE : settings.TUNNEL_IMAGE, `${name} image`);
    same(service.environment ?? {}, app ? appEnv : {}, `${name} environment`);
    same(service.user, app ? '1000:1000' : '65532:65532', `${name} user`);
    same(service.entrypoint ?? null, null, `${name} entrypoint`);
    same(
      service.command ?? null,
      app
        ? null
        : ['tunnel', '--no-autoupdate', 'run', '--token-file', '/run/secrets/tunnel_token'],
      `${name} command`,
    );
    same(service.restart, 'no', `${name} restart`);
    same(service.read_only, true, `${name} filesystem`);
    same(service.init, true, `${name} init`);
    same(service.cap_drop, ['ALL'], `${name} capabilities`);
    same(service.security_opt, ['no-new-privileges:true'], `${name} privilege policy`);
    same(Number(service.cpus), app ? 1 : 0.5, `${name} CPU limit`);
    same(Number(service.mem_limit), app ? 2147483648 : 268435456, `${name} memory limit`);
    same(Number(service.pids_limit), app ? 128 : 64, `${name} process limit`);
    same(
      service.tmpfs,
      [app ? '/tmp:size=64m,mode=1777' : '/tmp:size=16m,mode=1777'],
      `${name} temporary disk limit`,
    );
    same(
      service.logging,
      { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } },
      `${name} log limits`,
    );
    same(
      service.networks,
      app ? { application: null } : { application: null, outbound: null },
      `${name} network attachments`,
    );
    same(
      service.volumes ?? [],
      app ? [{ type: 'volume', source: 'app_data', target: '/data', volume: {} }] : [],
      `${name} mounts`,
    );
    same(
      service.secrets ?? [],
      app ? [] : [{ source: 'tunnel_token', target: '/run/secrets/tunnel_token' }],
      `${name} secrets`,
    );
    same(
      service.depends_on ?? {},
      app ? {} : { app: { condition: 'service_healthy', required: true } },
      `${name} dependencies`,
    );
    if (app && !['1m0s', '60s'].includes(service.stop_grace_period))
      fail('Rendered Compose app shutdown grace differs from the reviewed pilot plan.');
  }
}
/** Requested Docker limits are not proof that the host can enforce them. */
export function verifyHostResources(docker, run = execute) {
  let info;
  try {
    info = parsePrivateJson(
      run(docker, ['--host', 'unix:///var/run/docker.sock', 'info', '--format', '{{json .}}'], {
        env: { ...baseEnvironment(), DOCKER_HOST: 'unix:///var/run/docker.sock' },
        timeout: 5000,
      }),
    );
  } catch {
    fail('Cannot verify Docker host resource controls. Pilot startup refused.');
  }
  if (info?.MemoryLimit !== true)
    fail('Docker cannot enforce memory limits on this host. Pilot startup refused.');
  if (info.CpuCfsQuota !== true || info.CpuCfsPeriod !== true)
    fail('Docker cannot enforce CPU quotas on this host. Pilot startup refused.');
  if (info.PidsLimit !== true)
    fail('Docker cannot enforce process limits on this host. Pilot startup refused.');
  if (info.CgroupVersion !== '2') fail('Pilot resource verification requires a cgroup v2 host.');
}

/** Read the running processes' effective kernel limits, not Docker HostConfig. */
export function verifyRunningResources(result, env, run = execute, read = readFileSync) {
  try {
    for (const [service, memory, cpus, pids] of [
      ['app', 2147483648, 1, 128],
      ['tunnel', 268435456, 0.5, 64],
    ]) {
      const id = run(result.commands.start[0], [...result.composeArgs, 'ps', '--quiet', service], {
        env: childEnvironment(env),
        timeout: 5000,
      }).trim();
      if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error('Missing container');
      const [container] = parsePrivateJson(
        run(result.commands.start[0], ['--host', 'unix:///var/run/docker.sock', 'inspect', id], {
          env: baseEnvironment(),
          timeout: 5000,
        }),
      );
      const pid = container?.State?.Pid;
      if (
        !container?.State?.Running ||
        !Number.isSafeInteger(pid) ||
        pid < 1 ||
        container.Config?.Labels?.['com.docker.compose.project'] !== PROJECT ||
        container.Config?.Labels?.['com.docker.compose.service'] !== service
      )
        throw new Error('Unexpected container');
      const membership = read(`/proc/${pid}/cgroup`, 'utf8')
        .trim()
        .split('\n')
        .find((line) => line.startsWith('0::'))
        ?.slice(3);
      if (
        !membership?.startsWith('/') ||
        membership.split('/').some((part) => part === '..' || part === '.')
      )
        throw new Error('Missing cgroup');
      const directory = join('/sys/fs/cgroup', membership);
      const actualMemory = read(join(directory, 'memory.max'), 'utf8').trim();
      const actualPids = read(join(directory, 'pids.max'), 'utf8').trim();
      const cpu = read(join(directory, 'cpu.max'), 'utf8').trim().split(/\s+/).map(Number);
      if (
        actualMemory !== String(memory) ||
        actualPids !== String(pids) ||
        cpu.length !== 2 ||
        !cpu.every((value) => Number.isSafeInteger(value) && value > 0) ||
        cpu[0] / cpu[1] !== cpus
      )
        throw new Error('Limits differ');
    }
  } catch {
    fail('Running pilot resource limits could not be verified. Pilot startup refused.');
  }
}

export function preflight(env, paths, run = execute, now = Date.now()) {
  const result = plan(env, paths),
    config = validate(env),
    options = { env: childEnvironment(env) };
  mayStart(config, now);
  const envStat = lstatSync(paths.envFile);
  if (
    !envStat.isFile() ||
    envStat.isSymbolicLink() ||
    (envStat.mode & 0o022) !== 0 ||
    ![0, process.getuid?.()].includes(envStat.uid)
  )
    fail(
      'Environment file must be a regular operator-owned file without group or other write permission.',
    );
  const checkout = realpathSync(paths.projectDir),
    token = realpathSync(config.tokenFile);
  if (token === checkout || token.startsWith(checkout + '/'))
    fail('Keep the tunnel token outside the checkout.');
  validateToken(lstatSync(config.tokenFile));
  const docker = paths.dockerPath ?? '/usr/bin/docker';
  verifyHostResources(docker, run);
  run(docker, ['--host', 'unix:///var/run/docker.sock', 'compose', 'version', '--short'], options);
  verifyCompose(
    parsePrivateJson(run(docker, [...result.composeArgs, 'config', '--format', 'json'], options)),
    env,
  );
  for (const reference of [config.appImage, config.tunnelImage]) {
    const image = parsePrivateJson(
      run(
        docker,
        ['--host', 'unix:///var/run/docker.sock', 'image', 'inspect', reference],
        options,
      ),
    )[0];
    if (!image || image.Architecture !== 'arm64' || image.Os !== 'linux')
      fail('Preflight requires both reviewed Linux ARM64 images already present on the Pi.');
    if (reference.startsWith('sha256:') && image.Id !== reference)
      fail('The local application image ID does not match the pin.');
    if (
      reference.includes('@sha256:') &&
      !(image.RepoDigests ?? []).some((d) => d.endsWith('@' + reference.split('@')[1]))
    )
      fail('A local image does not match its pinned registry digest.');
  }
  return {
    ok: true,
    project: PROJECT,
    origin: config.origin,
    endsAt: env.PILOT_ENDS_AT,
    checks: [
      'fixed dates',
      'Docker cgroup v2 memory/CPU/process enforcement support',
      'pinned ARM64 images',
      'rendered Compose images/environment/storage/networks/resource caps',
      'private readable tunnel token',
    ],
    plan: result,
  };
}
function properties(text) {
  return Object.fromEntries(
    text
      .trim()
      .split('\n')
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
}
export function verifyDeadline(result, run = execute) {
  const normalize = (text) =>
    text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .join('\n');
  const names = ['clean-bookface-pilot-deadline.service', 'clean-bookface-pilot-deadline.timer'];
  for (const name of names) {
    if (
      normalize(run('/usr/bin/systemctl', ['cat', name], { env: baseEnvironment() })) !==
      normalize(result.units[name])
    )
      fail('Installed deadline units do not match this fixed pilot plan.');
  }
  const service = properties(
    run(
      '/usr/bin/systemctl',
      ['show', names[0], '--property=NeedDaemonReload,LoadState,ExecStart'],
      { env: baseEnvironment() },
    ),
  );
  const timer = properties(
    run(
      '/usr/bin/systemctl',
      [
        'show',
        names[1],
        '--property=NeedDaemonReload,LoadState,ActiveState,UnitFileState,Persistent,TimersCalendar,NextElapseUSecRealtime,Unit',
      ],
      { env: baseEnvironment() },
    ),
  );
  if (
    service.NeedDaemonReload !== 'no' ||
    timer.NeedDaemonReload !== 'no' ||
    service.LoadState !== 'loaded' ||
    timer.LoadState !== 'loaded'
  )
    fail('Loaded deadline units require daemon-reload or are not loaded.');
  const expected = result.stopControl.join(' ');
  if (
    !service.ExecStart?.includes(`path=${result.stopControl[0]} ; argv[]=${expected} ;`) ||
    (service.ExecStart.match(/argv\[\]=/gu) ?? []).length !== 1 ||
    !service.ExecStart.includes('ignore_errors=no')
  )
    fail('Loaded shutdown command differs from the reviewed plan.');
  if (
    timer.ActiveState !== 'active' ||
    timer.UnitFileState !== 'enabled' ||
    timer.Persistent !== 'yes' ||
    timer.Unit !== names[0]
  )
    fail(
      'The loaded deadline timer must be active, persistently enabled and target this shutdown service.',
    );
  const calendars = [...(timer.TimersCalendar?.matchAll(/OnCalendar=([^;]+);/gu) ?? [])];
  if (
    calendars.length !== 1 ||
    Date.parse(calendars[0][1].trim()) !== Date.parse(result.endsAt) ||
    Date.parse(timer.NextElapseUSecRealtime) !== Date.parse(result.endsAt)
  )
    fail('The loaded deadline calendar or next trigger differs from the fixed closing timestamp.');
}
export const stopEnvironment = () => ({
  ...baseEnvironment(),
  DOCKER_HOST: 'unix:///var/run/docker.sock',
});
/** Shutdown needs no checkout, Compose file, token, dates or image pin. */
function commandFailureSummary(error) {
  const parts = [];
  if (Number.isInteger(error?.status)) parts.push(`exit ${error.status}`);
  if (typeof error?.code === 'string' && /^[A-Z0-9_]{1,32}$/u.test(error.code))
    parts.push(error.code);
  if (typeof error?.signal === 'string' && /^SIG[A-Z0-9]{1,12}$/u.test(error.signal))
    parts.push(error.signal);
  const unsupported = /unknown flag: (--?[a-zA-Z0-9-]{1,40})(?:\s|$)/u.exec(
    String(error?.stderr ?? ''),
  );
  if (unsupported) parts.push(`unsupported flag ${unsupported[1]}`);
  // Do not print arbitrary command output, environment values or error messages.
  return parts.join('; ') || 'command error';
}
export function stopPilot(dockerPath = '/usr/bin/docker', run = execute) {
  dockerPath = absolute(dockerPath, 'Docker executable');
  const options = { env: stopEnvironment(), timeout: 150000 };
  const list = (all) => {
    const output = run(
      dockerPath,
      [
        '--host',
        'unix:///var/run/docker.sock',
        'ps',
        ...(all ? ['--all'] : []),
        '--no-trunc',
        '--filter',
        `label=com.docker.compose.project=${PROJECT}`,
        '--format',
        '{{.ID}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}',
      ],
      options,
    );
    const ids = [];
    for (const line of output.trim().split('\n').filter(Boolean)) {
      const [id, project, service, ...extra] = line.split('\t');
      if (project !== PROJECT || !['app', 'tunnel'].includes(service)) continue;
      if (extra.length || !/^[a-f0-9]{64}$/u.test(id))
        fail(
          'Docker returned an invalid pilot container identity. Shutdown refused that identity.',
        );
      ids.push(id);
    }
    return [...new Set(ids)];
  };
  const ids = list(true);
  let failure;
  if (ids.length) {
    try {
      run(
        dockerPath,
        ['--host', 'unix:///var/run/docker.sock', 'stop', '-t', '60', ...ids],
        options,
      );
    } catch (error) {
      failure = error;
    }
  }
  let remaining;
  try {
    remaining = list(false);
  } catch (error) {
    fail(
      `Pilot shutdown readback failed (${commandFailureSummary(error)}).${failure ? ` Docker stop also failed (${commandFailureSummary(failure)}).` : ''} Shutdown is not verified.`,
    );
  }
  if (failure)
    fail(
      `Docker stop failed (${commandFailureSummary(failure)}). ${remaining.length ? 'A dedicated app or tunnel container is still running.' : 'Readback found no active pilot containers.'}`,
    );
  if (remaining.length)
    fail('Pilot stop did not complete: a dedicated app or tunnel container is still running.');
}
function lockedInvocation(originalArgs, nodePath, environment) {
  execFileSync(
    '/usr/bin/flock',
    [
      '--exclusive',
      '--timeout',
      '300',
      '--close',
      lockPath('lifecycle'),
      nodePath,
      '--',
      fileURLToPath(import.meta.url),
      ...originalArgs,
      '--internal-lock-held',
    ],
    { stdio: 'inherit', env: environment, timeout: 900000 },
  );
}
/** Stop partial startup on failure; the outer OS flock serializes timer and startup. */
export function startPilot(
  result,
  env,
  { run = execute, now = Date.now, read = readFileSync } = {},
) {
  const config = validate(env);
  try {
    mayStart(config, now());
    // Leave more time than the bounded Compose startup call; do not race the closing timer.
    if (config.ends - now() <= 150000)
      fail('Too close to the fixed pilot deadline to start safely.');
    const [file, ...args] = result.commands.start;
    verifyHostResources(file, run);
    run(file, args, { env: childEnvironment(env), timeout: 120000 });
    mayStart(config, now());
    verifyRunningResources(result, env, run, read);
    mayStart(config, now());
  } catch (error) {
    stopPilot(result.commands.start[0], run);
    throw error;
  }
}
export function main(argv = process.argv.slice(2)) {
  const originalArgs = [...argv];
  const command = argv[0]?.startsWith('--') || !argv.length ? 'plan' : argv.shift();
  if (!['plan', 'preflight', 'start', 'stop'].includes(command))
    fail('Use plan (default), preflight, start or stop.');
  const args = {};
  let apply = false,
    dryRun = false,
    lockHeld = false,
    maintenanceStart = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--internal-maintenance-start') {
      maintenanceStart = true;
      continue;
    }
    if (argv[i] === '--internal-lock-held') {
      lockHeld = true;
      continue;
    }
    if (argv[i] === '--apply') {
      apply = true;
      continue;
    }
    if (argv[i] === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (!['--env-file', '--project-dir', '--node', '--docker'].includes(argv[i]) || !argv[i + 1])
      fail('Expected --env-file, --project-dir, --node or --docker with a value.');
    args[argv[i]] = argv[++i];
  }
  if (maintenanceStart && (!lockHeld || command !== 'start' || !apply))
    fail('Maintenance start requires the held lifecycle lock.');
  if (apply && dryRun) fail('Choose --apply or --dry-run, not both.');
  if (apply && !['start', 'stop'].includes(command))
    fail('--apply is only valid for start or stop.');
  if (command === 'stop') {
    const dockerPath = absolute(args['--docker'] ?? '/usr/bin/docker', 'Docker executable');
    const nodePath = absolute(args['--node'] ?? '/usr/bin/node', 'Node executable');
    if (!apply) {
      console.log(
        JSON.stringify(
          {
            dryRun: true,
            project: PROJECT,
            services: ['app', 'tunnel'],
            dockerHost: 'unix:///var/run/docker.sock',
            action: 'Stop only matching container IDs; preserve all volumes.',
          },
          null,
          2,
        ),
      );
      return;
    }
    if (!lockHeld) {
      requestStop(() => lockedInvocation(originalArgs, nodePath, stopEnvironment()));
      return;
    }
    stopPilot(dockerPath);
    console.log(JSON.stringify({ applied: 'stop', project: PROJECT }));
    return;
  }
  const paths = {
    envFile: absolute(args['--env-file'] ?? '', 'Environment file'),
    projectDir: absolute(
      args['--project-dir'] ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'),
      'Project directory',
    ),
    nodePath: args['--node'] ?? '/usr/bin/node',
    dockerPath: args['--docker'] ?? '/usr/bin/docker',
  };
  const env = parseEnv(readFileSync(paths.envFile, 'utf8'));
  const result = plan(env, paths);
  if (command === 'start') mayStart(validate(env));
  if (command === 'preflight') {
    console.log(JSON.stringify(preflight(env, paths), null, 2));
    return;
  }
  if (command === 'start' && apply) {
    if (!lockHeld) {
      lockedInvocation(originalArgs, paths.nodePath, childEnvironment(env));
      return;
    }
    if (!maintenanceStart) acknowledgeStopIntent();
    preflight(env, paths);
    verifyDeadline(result);
    startPilot(result, env);

    console.log(JSON.stringify({ applied: command, project: PROJECT }));
    return;
  }
  console.log(JSON.stringify({ dryRun: true, ...result }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(
      `Pilot control: ${error?.safePilotMessage ? error.message : 'Private operation failed; inspect the private service state.'}`,
    );
    process.exitCode = /deadline has passed|not arrived/.test(error.message) ? 78 : 1;
  }
}
