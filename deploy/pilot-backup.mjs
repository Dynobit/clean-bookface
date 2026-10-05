#!/usr/bin/env node
// One offline capture plus a verified ciphertext copy. No automatic deletion or lock override.
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  lstatSync,
  realpathSync,
  chownSync,
  existsSync,
  symlinkSync,
  renameSync,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  constants,
  fsyncSync,
  unlinkSync,
} from 'node:fs';
import { resolve, join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  parseEnv,
  validate,
  preflight,
  childEnvironment,
  PROJECT,
  protectedDirectory,
  lockPath,
  parsePrivateJson,
  readStopIntent,
  readStopAcknowledgement,
} from './pilot-control.mjs';
const VOLUME = PROJECT + '_app_data';
const baseEnv = () => ({
  PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
  LANG: 'C',
  LC_ALL: 'C',
  TZ: 'UTC',
});
const fail = (message) => {
  throw new Error(message);
};
const run = (file, args, options = {}) =>
  execFileSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180000,
    env: baseEnv(),
    ...options,
  });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const path = (value, name) => {
  if (typeof value !== 'string' || !isAbsolute(value) || !/^\/[a-zA-Z0-9_@./-]+$/u.test(value))
    fail(`${name} must be an absolute path without spaces or shell syntax.`);
  return resolve(value);
};
const inside = (parent, child) => child === parent || child.startsWith(parent + '/');
export function configuration(input) {
  const allowed = [
    'pilotEnvFile',
    'projectDir',
    'backupRoot',
    'secretsDir',
    'sshKeyFile',
    'knownHostsFile',
    'remoteUser',
    'remoteHost',
    'failureUnit',
    'alertMode',
  ];
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((k) => !allowed.includes(k))
  )
    fail('Invalid backup configuration field.');
  const c = {};
  for (const key of [
    'pilotEnvFile',
    'projectDir',
    'backupRoot',
    'secretsDir',
    'sshKeyFile',
    'knownHostsFile',
  ])
    c[key] = path(input[key], key);
  if (!c.backupRoot.endsWith('/clean-bookface-pilot-backup'))
    fail('Use a dedicated directory named clean-bookface-pilot-backup.');
  for (const key of ['pilotEnvFile', 'backupRoot', 'secretsDir', 'sshKeyFile', 'knownHostsFile'])
    if (inside(c.projectDir, c[key])) fail('Private backup paths must be outside the checkout.');
  if (
    inside(c.backupRoot, c.secretsDir) ||
    inside(c.secretsDir, c.backupRoot) ||
    inside(c.backupRoot, c.sshKeyFile) ||
    inside(c.backupRoot, c.knownHostsFile) ||
    inside(c.secretsDir, c.sshKeyFile) ||
    inside(c.secretsDir, c.knownHostsFile)
  )
    fail('Keep recovery and transport secrets separate from the backup repository.');
  if (
    !/^[a-z_][a-z0-9_-]{0,31}$/u.test(input.remoteUser ?? '') ||
    !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/u.test(input.remoteHost ?? '')
  )
    fail('Set the dedicated receiver SSH user and hostname or IPv4 address.');
  const alertMode = input.alertMode ?? 'external-unit';
  if (!['external-unit', 'dashboard-only'].includes(alertMode))
    fail('Choose external-unit or dashboard-only alertMode.');
  if (alertMode === 'dashboard-only') {
    if (input.failureUnit !== undefined) fail('Dashboard-only mode must omit failureUnit.');
  } else if (
    !/^[a-zA-Z0-9_.@-]+\.service$/u.test(input.failureUnit ?? '') ||
    input.failureUnit.startsWith('clean-bookface-pilot')
  )
    fail('Set a separate operator notification service for OnFailure.');
  return {
    ...c,
    remoteUser: input.remoteUser,
    remoteHost: input.remoteHost,
    alertMode,
    ...(alertMode === 'external-unit' ? { failureUnit: input.failureUnit } : {}),
  };
}
function privateFile(filename, readableUid = 0) {
  protectedDirectory(dirname(filename));
  const stat = lstatSync(filename);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o077) !== 0 ||
    !stat.size
  )
    fail('A required private file is missing, empty, linked, or accessible to others.');
  if (readableUid !== undefined && stat.uid !== readableUid)
    fail('A required private file has the wrong owner.');
}
export function hostChecks(c, execute = run) {
  if (process.getuid?.() !== 0)
    fail('Run the host backup service as root; do not grant the application Docker access.');
  for (const field of ['pilotEnvFile', 'sshKeyFile', 'knownHostsFile']) privateFile(c[field]);
  protectedDirectory(c.secretsDir);
  if (lstatSync(c.secretsDir).mode & 0o077) fail('Secrets directory must be root-private.');
  for (const name of ['restic-password', 'recovery-password'])
    privateFile(join(c.secretsDir, name), 1000);
  const root = lstatSync(c.backupRoot);
  if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== 0 || (root.mode & 0o077) !== 0)
    fail('Prepare the dedicated backup control directory as root mode 0700.');
  protectedDirectory(c.backupRoot);
  const repository = lstatSync(join(c.backupRoot, 'repository'));
  if (
    !repository.isDirectory() ||
    repository.isSymbolicLink() ||
    repository.uid !== 1000 ||
    repository.mode & 0o077
  )
    fail('Prepare only the repository subdirectory as uid 1000 mode 0700.');
  for (const field of ['backupRoot', 'secretsDir', 'sshKeyFile', 'knownHostsFile'])
    if (realpathSync(c[field]) !== c[field])
      fail('Private backup paths must not traverse symlinks.');
  const version = execute('/usr/bin/rsync', ['--version']);
  const parts = /version\s+(\d+)\.(\d+)\.(\d+)/u.exec(version);
  if (
    !parts ||
    Number(parts[1]) < 3 ||
    (Number(parts[1]) === 3 &&
      (Number(parts[2]) < 2 || (Number(parts[2]) === 2 && Number(parts[3]) < 3)))
  )
    fail('Use reviewed rsync 3.2.3 or later on sender and receiver.');
  checkFailureUnit(c, execute);
}
export function checkFailureUnit(c, execute = run) {
  if (
    c.alertMode !== 'dashboard-only' &&
    execute('/usr/bin/systemctl', [
      'show',
      c.failureUnit,
      '--property=LoadState',
      '--value',
    ]).trim() !== 'loaded'
  )
    fail('Install and test the configured failure notification unit first.');
}
export function schedule(c, configFile, nodePath = process.execPath) {
  nodePath = path(nodePath, 'Node executable');
  c = configuration(c);
  configFile = path(configFile, 'configFile');
  if (inside(c.projectDir, configFile)) fail('Keep the backup configuration outside Git.');
  const script = join(c.projectDir, 'deploy', 'pilot-backup.mjs');
  return {
    'clean-bookface-pilot-backup.service': `[Unit]\nDescription=Daily verified off-host Clean Bookface pilot backup\nAfter=docker.service network-online.target\nRequires=docker.service\nWants=network-online.target\n${c.alertMode === 'external-unit' ? `OnFailure=${c.failureUnit}\n` : ''}\n[Service]\nType=oneshot\nUMask=0077\nNice=10\nIOSchedulingClass=idle\nExecStart=${nodePath} -- ${script} run --config ${configFile} --apply\nTimeoutStartSec=4h\n`,
    'clean-bookface-pilot-backup.timer': `[Unit]\nDescription=Daily Clean Bookface off-host backup\n\n[Timer]\nOnCalendar=*-*-* 06:15:00 UTC\nPersistent=true\nRandomizedDelaySec=300\nUnit=clean-bookface-pilot-backup.service\n\n[Install]\nWantedBy=timers.target\n`,
  };
}
export function rsyncArgs(c, source, destination, extra = []) {
  const ssh = [
    '/usr/bin/ssh',
    '-F',
    '/dev/null',
    '-i',
    c.sshKeyFile,
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'UserKnownHostsFile=' + c.knownHostsFile,
    '-o',
    'ConnectTimeout=10',
  ].join(' ');
  return [
    '-rltp',
    '--safe-links',
    '--timeout=120',
    '--bwlimit=10240',
    '--rsh',
    ssh,
    ...extra,
    '--',
    source,
    destination,
  ];
}
function prepareRun(root, id) {
  const runs = join(root, 'runs');
  mkdirSync(runs, { recursive: true, mode: 0o700 });
  protectedDirectory(runs);
  const target = join(runs, id);
  mkdirSync(target, { mode: 0o700 });
  const output = join(target, 'output');
  mkdirSync(output, { mode: 0o700 });
  chownSync(output, 1000, 1000);
  return target;
}
/** Receipts, not schedules, establish successful off-host capture. */
export function capturePilot(
  input,
  {
    execute = run,
    now = Date.now,
    checkHost = hostChecks,
    checkPilot = preflight,
    prepare = prepareRun,
    readOutput = readLedger,
    lifecycleLocked = false,
    stopIntent = readStopIntent,
    stopAcknowledgement = readStopAcknowledgement,
    nodePath = process.execPath,
  } = {},
) {
  if (!lifecycleLocked) fail('Offline capture requires the pilot lifecycle lock.');
  nodePath = path(nodePath, 'Node executable');
  const c = configuration(input);
  checkHost(c, execute);
  const pilotEnv = parseEnv(readFileSync(c.pilotEnvFile, 'utf8')),
    pilot = validate(pilotEnv);
  if (now() >= pilot.ends) return { skipped: 'pilot closed', endsAt: pilotEnv.PILOT_ENDS_AT };
  if (now() < pilot.starts)
    return { skipped: 'pilot not started', startsAt: pilotEnv.PILOT_STARTS_AT };
  checkPilot(pilotEnv, { envFile: c.pilotEnvFile, projectDir: c.projectDir }, execute, now());
  const dockerEnv = childEnvironment(pilotEnv),
    docker = (args, timeout = 180000) =>
      execute('/usr/bin/docker', ['--host', 'unix:///var/run/docker.sock', ...args], {
        env: dockerEnv,
        timeout,
      });
  const volume = parsePrivateJson(docker(['volume', 'inspect', VOLUME]))[0];
  if (volume?.Name !== VOLUME || volume?.Labels?.['com.docker.compose.project'] !== PROJECT)
    fail('The exact pilot application volume was not verified.');
  const active = docker([
    'ps',
    '--filter',
    'label=com.docker.compose.project=' + PROJECT,
    '--format',
    '{{.Label "com.docker.compose.service"}}',
  ])
    .trim()
    .split('\n')
    .filter((x) => ['app', 'tunnel'].includes(x));
  if (active.length && !(active.includes('app') && active.includes('tunnel')))
    fail('The pilot is partly running; investigate before an automatic maintenance window.');
  const wasRunning = active.length > 0;
  const initialStopIntent = stopIntent();
  const pendingStop = initialStopIntent !== stopAcknowledgement();
  const id =
    new Date(now()).toISOString().replaceAll(/[-:.]/gu, '') + '-' + randomUUID().slice(0, 8);
  if (!/^\d{8}T\d{9}Z-[a-f0-9]{8}$/u.test(id)) fail('Invalid backup generation.');
  const directory = prepare(c.backupRoot, id);
  const controller = join(c.projectDir, 'deploy', 'pilot-control.mjs');
  const control = (action) =>
    execute(
      nodePath,
      [
        '--',
        controller,
        action,
        '--node',
        nodePath,
        ...(action === 'start'
          ? ['--env-file', c.pilotEnvFile, '--project-dir', c.projectDir]
          : []),
        '--apply',
        '--internal-lock-held',
        ...(action === 'start' ? ['--internal-maintenance-start'] : []),
      ],
      { env: baseEnv(), timeout: 900000 },
    );
  const cli = (args) =>
    docker(
      [
        'run',
        '--rm',
        '--user',
        '1000:1000',
        '--name',
        'bookface-pilot-backup-' + id,
        '--network',
        'none',
        '--cpus',
        '1',
        '--memory',
        '2g',
        '--pids-limit',
        '128',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges:true',
        '--tmpfs',
        '/tmp:rw,nosuid,noexec,size=128m,mode=1777',
        '--mount',
        'type=volume,source=' + VOLUME + ',target=/data',
        '--mount',
        'type=bind,source=' + join(c.backupRoot, 'repository') + ',target=/backup/repository',
        '--mount',
        'type=bind,source=' + join(directory, 'output') + ',target=/output',
        '--mount',
        'type=bind,source=' +
          join(c.secretsDir, 'restic-password') +
          ',target=/secrets/restic-password,readonly',
        '--mount',
        'type=bind,source=' +
          join(c.secretsDir, 'recovery-password') +
          ',target=/secrets/recovery-password,readonly',
        '-e',
        'NODE_ENV=production',
        '-e',
        'APP_ORIGIN=' + pilot.origin,
        '-e',
        'DATA_DIR=/data',
        '-e',
        'RESTIC_REPOSITORY=/backup/repository',
        '-e',
        'RESTIC_PASSWORD_FILE=/secrets/restic-password',
        '-e',
        'RECOVERY_PASSWORD_FILE=/secrets/recovery-password',
        '-e',
        'RESTIC_CACHE_DIR=/tmp/restic-cache',
        pilot.appImage,
        'node',
        'dist/cli.js',
        ...args,
      ],
      1800000,
    );
  let capture,
    capturedAt,
    stopped = false,
    captureFailure;
  try {
    control('stop');
    stopped = true;
    if (!existsSync(join(c.backupRoot, 'repository', 'config'))) cli(['backup-init']);
    capture = parsePrivateJson(cli(['backup']));
    capturedAt = new Date(now()).toISOString();
    if (!/^[a-f0-9]+$/u.test(capture.snapshotId ?? '') || typeof capture.backupId !== 'string')
      fail('The backup command did not return a valid receipt.');
    cli(['reconciliation-export', '--output', '/output/current-state.enc']);
    atomicReceipt(join(directory, 'capture.json'), JSON.stringify(capture));
    // Read by descriptor: the untrusted container can replace only this leaf.
    atomicReceipt(
      join(directory, 'current-state.enc'),
      readOutput(join(directory, 'output', 'current-state.enc')),
    );
  } catch (error) {
    captureFailure = error;
  }
  // Resume the same installation, even after a capture failure. Never extend its dates.
  let resumeFailure;
  if (stopped && wasRunning && !pendingStop && now() < pilot.ends) {
    try {
      if (stopIntent() === initialStopIntent) {
        control('start');
        // An external stop may have arrived while guarded startup was running.
        try {
          if (stopIntent() !== initialStopIntent) control('stop');
        } catch (error) {
          control('stop');
          throw error;
        }
      }
    } catch (error) {
      resumeFailure = error;
    }
  }
  if (captureFailure || resumeFailure)
    fail(
      captureFailure
        ? 'Offline capture failed; off-host success was not recorded. Check the backup service and pilot state.'
        : 'The backup was captured, but guarded pilot restart failed. Check the pilot state.',
    );
  return { c, pilot, id, directory, capture, capturedAt };
}
export function lockedCapture(input, execute = run, nodePath = process.execPath, locks = lockPath) {
  nodePath = path(nodePath, 'Node executable');
  return parsePrivateJson(
    execute(
      '/usr/bin/flock',
      [
        '--exclusive',
        '--close',
        locks('lifecycle'),
        nodePath,
        '--',
        fileURLToPath(import.meta.url),
        '--internal-capture',
      ],
      {
        env: baseEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        input: JSON.stringify(configuration(input)),
        timeout: 0,
      },
    ),
  );
}
function performBackup(
  input,
  { execute = run, now = Date.now, captureRun = lockedCapture, nodePath = process.execPath } = {},
) {
  nodePath = path(nodePath, 'Node executable');
  const result = captureRun(input, execute, nodePath);
  if (result.skipped) return result;
  const { c, pilot, id, directory, capture, capturedAt } = result;
  const remote = c.remoteUser + '@' + c.remoteHost + ':',
    generation = 'generations/' + id;
  const sync = (source, dest, extra = []) =>
    execute('/usr/bin/rsync', rsyncArgs(c, source, dest, extra), {
      env: baseEnv(),
      timeout: 7200000,
    });
  const repository = join(c.backupRoot, 'repository') + '/';
  sync(repository, remote + generation + '/repository/', [
    '--mkpath',
    '--link-dest=/current/repository',
  ]);
  sync(directory + '/', remote + generation + '/', ['--mkpath', '--exclude=/output/']);
  for (const [source, dest] of [
    [repository, remote + generation + '/repository/'],
    [directory + '/', remote + generation + '/'],
  ]) {
    const changes = sync(source, dest, [
      '--checksum',
      '--dry-run',
      '--delete',
      '--itemize-changes',
      '--out-format=%i%n',
      ...(source === directory + '/' ? ['--exclude=/repository/', '--exclude=/output/'] : []),
    ]);
    if (changes.trim())
      fail(
        'Off-host ciphertext verification found differences. The previous current generation is unchanged.',
      );
  }
  const receipt = {
    format: 'clean-bookface-offhost/1',
    generation: id,
    snapshotId: capture.snapshotId,
    backupId: capture.backupId,
    image: pilot.appImage,
    capturedAt,
    verifiedAt: new Date(now()).toISOString(),
    ledgerSha256: sha(readFileSync(join(directory, 'current-state.enc'))),
    captureSha256: sha(readFileSync(join(directory, 'capture.json'))),
    checksumReadback: true,
  };
  atomicReceipt(join(directory, 'complete.json'), JSON.stringify(receipt));
  sync(join(directory, 'complete.json'), remote + generation + '/complete.json');
  const links = join(directory, 'publish');
  mkdirSync(links, { mode: 0o700 });
  symlinkSync(generation, join(links, 'current'));
  // rsync installs the relative symlink by rename; older completed generations remain intact.
  sync(join(links, 'current'), remote + './');
  const readback = join(directory, 'readback.json');
  sync(remote + 'current/complete.json', readback);
  if (readFileSync(readback, 'utf8') !== JSON.stringify(receipt))
    fail('Completed-generation readback did not match. Off-host success was not recorded.');
  atomicReceipt(join(c.backupRoot, 'last-offhost-success.json'), JSON.stringify(receipt, null, 2));
  return receipt;
}
export function readLedger(filename, uid = 1000) {
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== uid ||
      stat.nlink !== 1 ||
      stat.mode & 0o077 ||
      stat.size < 1 ||
      stat.size > 64 * 1024 * 1024
    )
      fail('Ledger output must be a bounded private regular file.');
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    if (offset !== stat.size || fstatSync(fd).size !== stat.size)
      fail('Ledger output changed while being captured.');
    return bytes.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}
export function atomicReceipt(target, bytes) {
  const temporary = target + '.' + randomUUID();
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, target);
    const directory = openSync(dirname(target), 'r');
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
}
function writeAttempt(c, receipt) {
  const root = lstatSync(c.backupRoot);
  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    root.uid !== process.getuid() ||
    root.mode & 0o077 ||
    realpathSync(c.backupRoot) !== c.backupRoot
  )
    fail('Attempt receipt requires an owner-private, unlinked backup control directory.');
  atomicReceipt(join(c.backupRoot, 'last-offhost-attempt.json'), JSON.stringify(receipt, null, 2));
}
export function backup(input, options = {}) {
  const c = configuration(input),
    now = options.now ?? Date.now;
  (options.checkHost ?? hostChecks)(c, options.execute ?? run);
  const attempt = {
    format: 'clean-bookface-offhost-attempt/1',
    startedAt: new Date(now()).toISOString(),
    status: 'running',
  };
  // Invalid configuration/storage still surfaces through systemd; never write outside a checked root.
  writeAttempt(c, attempt);
  try {
    const result = performBackup(c, options);
    writeAttempt(c, {
      ...attempt,
      finishedAt: new Date(now()).toISOString(),
      status: result.skipped ? 'skipped' : 'succeeded',
      ...(result.generation ? { generation: result.generation } : {}),
    });
    return result;
  } catch (error) {
    writeAttempt(c, { ...attempt, finishedAt: new Date(now()).toISOString(), status: 'failed' });
    throw error;
  }
}
export function main(argv = process.argv.slice(2)) {
  const nodePath = path(process.execPath, 'Node executable');
  if (argv.length === 1 && argv[0] === '--internal-capture') {
    console.log(
      JSON.stringify(
        capturePilot(parsePrivateJson(readFileSync(0, 'utf8')), { lifecycleLocked: true }),
      ),
    );
    return;
  }
  const original = [...argv],
    command = argv[0]?.startsWith('--') || !argv.length ? 'plan' : argv.shift();
  if (!['plan', 'run'].includes(command)) fail('Use plan or run.');
  let configFile,
    apply = false,
    locked = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') configFile = path(argv[++i], 'configuration');
    else if (argv[i] === '--apply') apply = true;
    else if (argv[i] === '--internal-lock-held') locked = true;
    else fail('Use --config FILE and optional --apply.');
  }
  if (!configFile) fail('Supply an operator-private --config file outside Git.');
  privateFile(configFile);
  const c = configuration(parsePrivateJson(readFileSync(configFile, 'utf8')));
  if (inside(c.projectDir, configFile)) fail('Keep configuration outside Git.');
  if (command === 'plan' || !apply) {
    console.log(JSON.stringify({ dryRun: true, units: schedule(c, configFile) }, null, 2));
    return;
  }
  if (!locked) {
    execFileSync(
      '/usr/bin/flock',
      [
        '--exclusive',
        '--nonblock',
        '--close',
        lockPath('backup'),
        nodePath,
        '--',
        fileURLToPath(import.meta.url),
        ...original,
        '--internal-lock-held',
      ],
      { stdio: 'inherit', env: baseEnv(), timeout: 0 },
    );
    return;
  }
  const receipt = backup(c);
  console.log(JSON.stringify(receipt));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    // Captured child output may contain private paths. Report a safe failure; leave the unit failed.
    console.error(
      error?.status !== undefined
        ? 'Pilot backup subprocess failed; inspect the private service state.'
        : 'Pilot backup failed; inspect the private service state.',
    );
    process.exitCode = 1;
  }
}
