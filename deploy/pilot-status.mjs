#!/usr/bin/env node
// Local, read-only observation. Never starts services or publishes telemetry.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  readFileSync,
  statfsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  lstatSync,
  unlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv, validate, PROJECT } from './pilot-control.mjs';
const HOUR = 3600000;
const iso = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
const time = (value, now) => (iso(value) && Date.parse(value) <= now ? Date.parse(value) : null);
const safeRead = (fn) => {
  try {
    return fn();
  } catch {
    return null;
  }
};
export function receiverCapacity(snapshot, now = Date.now()) {
  const unknown = {
    state: 'unknown',
    observedAt: null,
    freeGiB: null,
    usedGiB: null,
    freePercent: null,
    repositoryGiB: null,
    budgetPercent: null,
    planningBudgetGiB: 100,
  };
  if (
    !snapshot ||
    snapshot.format !== 'clean-bookface-receiver-capacity/1' ||
    time(snapshot.observedAt, now) === null ||
    now - Date.parse(snapshot.observedAt) > 300000 ||
    snapshot.planningBudgetBytes !== 100 * 1024 ** 3
  )
    return unknown;
  const { totalBytes, freeBytes, usedBytes, repositoryBytes } = snapshot;
  if (
    ![totalBytes, freeBytes, usedBytes, repositoryBytes].every(Number.isSafeInteger) ||
    totalBytes <= 0 ||
    freeBytes < 0 ||
    usedBytes < 0 ||
    repositoryBytes < 0 ||
    freeBytes + usedBytes > totalBytes
  )
    return unknown;
  const ratio = repositoryBytes / snapshot.planningBudgetBytes;
  return {
    state:
      freeBytes < 10 * 1024 ** 3 || freeBytes / totalBytes < 0.1 || ratio >= 0.9
        ? 'action needed'
        : ratio >= 0.8
          ? 'budget warning'
          : 'available',
    observedAt: snapshot.observedAt,
    freeGiB: Math.floor(freeBytes / 1024 ** 3),
    usedGiB: Math.ceil(usedBytes / 1024 ** 3),
    freePercent: Math.floor((100 * freeBytes) / totalBytes),
    repositoryGiB: Math.ceil(repositoryBytes / 1024 ** 3),
    budgetPercent: Math.ceil(ratio * 100),
    planningBudgetGiB: 100,
  };
}
export function summarize(input, now = Date.now()) {
  const receipt = input.success;
  const verified =
    receipt?.format === 'clean-bookface-offhost/1' &&
    receipt.checksumReadback === true &&
    time(receipt.verifiedAt, now) !== null &&
    time(receipt.capturedAt, now) !== null &&
    Date.parse(receipt.capturedAt) <= Date.parse(receipt.verifiedAt) &&
    /^[a-f0-9]{64}$/.test(receipt.ledgerSha256 ?? '') &&
    /^[a-f0-9]{64}$/.test(receipt.captureSha256 ?? '');
  const backup = {
    state: verified
      ? now - Date.parse(receipt.capturedAt) > 26 * HOUR
        ? 'overdue'
        : 'verified'
      : 'unknown',
    verifiedAt: verified ? receipt.verifiedAt : null,
    capturedAt: verified ? receipt.capturedAt : null,
  };
  const raw = input.attempt;
  const validAttempt =
    raw?.format === 'clean-bookface-offhost-attempt/1' &&
    time(raw.startedAt, now) !== null &&
    ['running', 'succeeded', 'failed', 'skipped'].includes(raw.status) &&
    (raw.status === 'running' ||
      (time(raw.finishedAt, now) !== null &&
        Date.parse(raw.finishedAt) >= Date.parse(raw.startedAt)));
  let attempt = {
    state: validAttempt ? raw.status : 'unknown',
    startedAt: validAttempt ? raw.startedAt : null,
    finishedAt: validAttempt && raw.status !== 'running' ? raw.finishedAt : null,
  };
  const service = input.service;
  const serviceStart = time(service?.startedAt, now);
  const serviceEnd = time(service?.finishedAt, now);
  const validInterval = serviceStart !== null && serviceEnd !== null && serviceEnd >= serviceStart;
  // A receipt is written after service startup/preflight. Match its actual execution
  // interval rather than guessing a fixed startup delay. Older finished invocations
  // cannot override a later manual receipt.
  const attemptStart = attempt.startedAt ? Date.parse(attempt.startedAt) : null;
  if (
    service?.failed === true &&
    serviceStart !== null &&
    (attemptStart === null ||
      serviceStart >= attemptStart ||
      (validInterval && attemptStart <= serviceEnd))
  )
    attempt = {
      state: 'failed',
      startedAt: service.startedAt,
      finishedAt: validInterval ? service.finishedAt : null,
    };
  if (attempt.state === 'running' && now - Date.parse(attempt.startedAt) > 4 * HOUR)
    attempt.state = 'stalled';
  if (
    attempt.state === 'succeeded' &&
    (!verified || Date.parse(receipt.verifiedAt) < Date.parse(attempt.startedAt))
  )
    attempt.state = 'unverified';
  const dates = input.dates;
  const validDates =
    dates &&
    [dates.starts, dates.readOnly, dates.ends].every(Number.isFinite) &&
    dates.starts < dates.readOnly &&
    dates.readOnly < dates.ends;
  const phase = !validDates
    ? 'unknown'
    : now >= dates.ends
      ? 'closed'
      : now < dates.starts
        ? 'not started'
        : now >= dates.readOnly
          ? 'export only'
          : 'open';
  const containers = input.containers;
  let state = 'unknown';
  if (
    Array.isArray(containers) &&
    containers.every(
      (c) => ['app', 'tunnel'].includes(c.service) && typeof c.running === 'boolean',
    ) &&
    new Set(containers.map((c) => c.service)).size === containers.length
  ) {
    if (!containers.some((c) => c.running)) state = 'stopped';
    else if (
      containers.length === 2 &&
      containers.every((c) => c.running) &&
      containers.find((c) => c.service === 'app')?.health === 'healthy'
    )
      state = 'running';
    else state = 'attention';
  }
  if (phase === 'closed' && state !== 'stopped') state = 'attention';
  const disk = input.disk;
  const validDisk =
    disk &&
    Number.isSafeInteger(disk.totalBytes) &&
    Number.isSafeInteger(disk.freeBytes) &&
    disk.totalBytes > 0 &&
    disk.freeBytes >= 0 &&
    disk.freeBytes <= disk.totalBytes;
  const capacity = validDisk
    ? {
        state:
          disk.freeBytes < 10 * 1024 ** 3 || disk.freeBytes / disk.totalBytes < 0.1
            ? 'low'
            : 'available',
        freeGiB: Math.floor(disk.freeBytes / 1024 ** 3),
        freePercent: Math.floor((100 * disk.freeBytes) / disk.totalBytes),
      }
    : { state: 'unknown', freeGiB: null, freePercent: null };
  return {
    format: 'clean-bookface-pilot-status/1',
    observedAt: new Date(now).toISOString(),
    backup,
    attempt,
    pilot: { state, phase },
    capacity,
    receiverCapacity: receiverCapacity(input.receiver, now),
  };
}
export function collect(
  { backupRoot, pilotEnvFile, receiverCapacityFile },
  execute = execFileSync,
) {
  const run = (file, args) =>
    execute(file, args, {
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 65536,
      env: { PATH: '/usr/bin:/bin', LANG: 'C', TZ: 'UTC' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const success = safeRead(() =>
    JSON.parse(readFileSync(join(backupRoot, 'last-offhost-success.json'), 'utf8')),
  );
  const attempt = safeRead(() =>
    JSON.parse(readFileSync(join(backupRoot, 'last-offhost-attempt.json'), 'utf8')),
  );
  const dates = safeRead(() => validate(parseEnv(readFileSync(pilotEnvFile, 'utf8'))));
  const disk = safeRead(() => {
    const s = statfsSync(backupRoot);
    return { totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize };
  });
  const containers = safeRead(() => {
    const ids = run('/usr/bin/docker', [
      '--host',
      'unix:///var/run/docker.sock',
      'ps',
      '--all',
      '--no-trunc',
      '--filter',
      `label=com.docker.compose.project=${PROJECT}`,
      '--format',
      '{{.ID}}',
    ])
      .trim()
      .split('\n')
      .filter(Boolean);
    if (!ids.every((id) => /^[a-f0-9]{64}$/.test(id)) || ids.length > 8) throw new Error();
    return ids.map((id) => {
      const [row] = JSON.parse(
        run('/usr/bin/docker', [
          '--host',
          'unix:///var/run/docker.sock',
          'inspect',
          '--format',
          '[{"Config":{"Labels":{{json .Config.Labels}}},"State":{{json .State}}}]',
          id,
        ]),
      );
      if (row.Config?.Labels?.['com.docker.compose.project'] !== PROJECT) throw new Error();
      return {
        service: row.Config.Labels['com.docker.compose.service'],
        running: row.State?.Running,
        health: row.State?.Health?.Status,
      };
    });
  });
  const service = safeRead(() => {
    const props = Object.fromEntries(
      run('/usr/bin/systemctl', [
        '--timestamp=us',
        'show',
        'clean-bookface-pilot-backup.service',
        '--property=LoadState,Result,ExecMainStatus,ExecMainStartTimestamp,ExecMainExitTimestamp,ActiveState',
      ])
        .trim()
        .split('\n')
        .map((line) => {
          const i = line.indexOf('=');
          return [line.slice(0, i), line.slice(i + 1)];
        }),
    );
    if (props.LoadState !== 'loaded' || !props.ExecMainStartTimestamp) return null;
    return {
      startedAt: new Date(props.ExecMainStartTimestamp).toISOString(),
      finishedAt: props.ExecMainExitTimestamp
        ? safeRead(() => new Date(props.ExecMainExitTimestamp).toISOString())
        : null,
      failed:
        props.Result !== 'success' ||
        props.ExecMainStatus !== '0' ||
        props.ActiveState === 'failed',
    };
  });
  const receiver = receiverCapacityFile
    ? safeRead(() => JSON.parse(readFileSync(receiverCapacityFile, 'utf8')))
    : null;
  return summarize({ success, attempt, dates, disk, containers, service, receiver });
}
const escape = (value) =>
  String(value ?? 'Not available').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
export function render(status) {
  const card = (title, state, body, id = '') =>
    `<section><h2>${title}</h2><strong${id ? ` id="${id}"` : ''}>${escape(state)}</strong><p>${body}</p></section>`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><title>Clean Bookface · Operator status</title><style>body{font:17px/1.6 system-ui,sans-serif;background:#f5f2ea;color:#263c38;margin:auto;padding:28px;max-width:950px}h1{font-size:2rem;line-height:1.15}h2{font-size:1rem;margin:0}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:16px}section{padding:24px;border:1px solid #bdc9bf;border-radius:12px;background:#fff}strong{display:block;font-size:1.6rem;text-transform:capitalize}p{overflow-wrap:anywhere}#freshness{padding:12px;background:#fff0c1;border-radius:8px}footer{font-size:.9rem;margin-top:24px}</style><header><p>Clean Bookface / Private operations</p><h1>Keep the circle cared for.</h1><p>A local snapshot. No tracking, messages, or automatic GitHub updates.</p><p id="freshness">Snapshot freshness is unverified until the page checks its clock.</p><p>Observed: <time>${escape(status.observedAt)}</time></p></header><main>${card('Off-host backup', status.backup.state, `Captured: ${escape(status.backup.capturedAt)}<br>Checksum readback: ${escape(status.backup.verifiedAt)}`)}${card('Latest backup attempt', status.attempt.state, `Started: ${escape(status.attempt.startedAt)}<br>Finished: ${escape(status.attempt.finishedAt)}`)}${card('Pilot processes', status.pilot.state, `Scheduled phase: ${escape(status.pilot.phase)}. Container observation does not prove public reachability.`)}${card('Local backup storage', status.capacity.state, `Free: ${escape(status.capacity.freeGiB)} GiB / ${escape(status.capacity.freePercent)}%.`)}${card('Receiver backup storage', status.receiverCapacity.state, `Filesystem free: ${escape(status.receiverCapacity.freeGiB)} GiB / ${escape(status.receiverCapacity.freePercent)}%. Used: ${escape(status.receiverCapacity.usedGiB)} GiB.<br>Backup allocation: ${escape(status.receiverCapacity.repositoryGiB)} GiB / 100 GiB planning budget (${escape(status.receiverCapacity.budgetPercent)}%). This is not a quota.<br>Measured: ${escape(status.receiverCapacity.observedAt)}`, 'receiver-state')}</main><footer>Open a newly generated snapshot before acting. A backup is overdue after 26 hours from capture. Low space means less than 10 GiB or 10% free. Dashboard-only monitoring depends on a person checking it; it will not notify you if this machine is offline. A verified copy is not a restore drill.</footer><script>const observed=Date.parse(${JSON.stringify(status.observedAt).replace(/</g, '\\u003c')});const receiverObserved=Date.parse(${JSON.stringify(status.receiverCapacity.observedAt).replace(/</g, '\\u003c')});function check(){if(!Number.isFinite(receiverObserved)||Date.now()-receiverObserved>300000||Date.now()<receiverObserved)document.getElementById('receiver-state').textContent='unknown — refresh required';const age=Date.now()-observed;document.getElementById('freshness').textContent=age<0||age>300000?'STALE SNAPSHOT — generate and open a new report.':'Snapshot is less than five minutes old. These observations are not a live connection.'}check();setInterval(check,10000);</script></html>`;
}
export function writeSnapshot(output, status) {
  for (const [name, content] of [
    ['status.json', JSON.stringify(status, null, 2)],
    ['index.html', render(status)],
  ]) {
    const temp = join(output, name + '.' + randomUUID() + '.tmp');
    try {
      writeFileSync(temp, content, { mode: 0o600, flag: 'wx' });
      renameSync(temp, join(output, name));
    } finally {
      try {
        unlinkSync(temp);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
}
export function main(argv = process.argv.slice(2)) {
  if (
    ![6, 8].includes(argv.length) ||
    (argv.length === 8 && argv[6] !== '--receiver-capacity') ||
    argv[0] !== '--backup-root' ||
    argv[2] !== '--env-file' ||
    argv[4] !== '--output'
  )
    throw new Error();
  const output = resolve(argv[5]);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const stat = lstatSync(output);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error();
  const status = collect({
    backupRoot: resolve(argv[1]),
    pilotEnvFile: resolve(argv[3]),
    receiverCapacityFile: argv[7] ? resolve(argv[7]) : undefined,
  });
  writeSnapshot(output, status);
  console.log('Private status snapshot written. Open index.html locally.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch {
    console.error(
      'Status generation failed. No current snapshot is verified. Check private input and output permissions.',
    );
    process.exitCode = 1;
  }
}
