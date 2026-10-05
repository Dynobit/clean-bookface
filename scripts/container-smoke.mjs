#!/usr/bin/env node
// Production-image exercise using fictional data, an isolated Docker network
// and a Caddy test CA trusted only by this process. No host DNS/trust changes.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Supply ${name}`);
  return value;
};
const appImage = option('--image', 'clean-bookface:0.1.0');
const reportFile = option('--report', undefined);
const caddyImage =
  'caddy:2.11.4-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b';
const origin = 'https://circle.example';
const hostname = new URL(origin).hostname;
const prefix = `bookface-smoke-${randomUUID().slice(0, 12)}`;
const names = { app: `${prefix}-app`, proxy: `${prefix}-https`, network: `${prefix}-net` };
const volumes = ['source', 'restored', 'operator', 'caddy'].map((label) => `${prefix}-${label}`);
const [sourceVolume, restoredVolume, operatorVolume, caddyVolume] = volumes;
const checks = [];
const temporaryContainers = [];
const started = Date.now();
let workDir;
let port;
let ca;
let runtime;
let imageInfo;
let cookie = '';
let csrf = '';
let failure;
let cancelled = false;
process.once('SIGINT', () => {
  cancelled = true;
});
process.once('SIGTERM', () => {
  cancelled = true;
});

async function docker(arguments_, timeout = 120_000) {
  if (cancelled) throw new Error('Container smoke cancelled');
  try {
    return (await run('docker', arguments_, { timeout, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
  } catch (error) {
    // Do not dump captured setup credentials, cookies or private response bodies.
    const detail = String(error.stderr ?? '').slice(0, 1000);
    throw new Error(`Docker ${arguments_[0]} failed${detail ? `: ${detail}` : ''}`);
  }
}
async function oneOff(arguments_) {
  const name = `${prefix}-task-${temporaryContainers.length + 1}`;
  temporaryContainers.push(name);
  return docker(['run', '--rm', '--name', name, ...arguments_]);
}
async function step(name, action) {
  const before = Date.now();
  await action();
  checks.push({ name, passed: true, milliseconds: Date.now() - before });
  console.log(`PASS ${name}`);
}
async function until(action, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (cancelled) throw new Error('Container smoke cancelled');
    try {
      const value = await action();
      if (value) return value;
    } catch {
      /* Startup can race a request. */
    }
    if (Date.now() >= deadline)
      throw new Error('Container service did not become ready before its deadline');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
function http(
  path,
  { method = 'GET', json, bytes, contentType, authenticated = false, mutationOrigin = origin } = {},
) {
  const body = json === undefined ? bytes : Buffer.from(JSON.stringify(json));
  const headers = { host: hostname, accept: 'application/json' };
  if (authenticated && cookie) headers.cookie = cookie;
  if (method !== 'GET') headers.origin = mutationOrigin;
  if (body) {
    headers['content-length'] = String(body.length);
    headers['content-type'] = contentType ?? 'application/json';
  }
  return new Promise((resolve, reject) => {
    const call = httpsRequest(
      {
        hostname: '127.0.0.1',
        port,
        servername: hostname,
        ca,
        path,
        method,
        headers,
        timeout: 10_000,
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (part) => {
          size += part.length;
          if (size > 16 * 1024 * 1024)
            response.destroy(new Error('Smoke response exceeded its limit'));
          else chunks.push(part);
        });
        response.on('error', reject);
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            bytes: Buffer.concat(chunks),
            json: () => JSON.parse(Buffer.concat(chunks).toString('utf8')),
          }),
        );
      },
    );
    call.on('timeout', () => call.destroy(new Error('Smoke HTTPS request timed out')));
    call.on('error', reject);
    call.end(body);
  });
}
const env = [
  '-e',
  'NODE_ENV=production',
  '-e',
  `APP_ORIGIN=${origin}`,
  '-e',
  'FEDERATION_ENABLED=false',
];
const hardening = [
  '--read-only',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges:true',
  '--pids-limit',
  '128',
  '--memory',
  '1536m',
  '--tmpfs',
  '/tmp:rw,nosuid,noexec,size=64m,mode=1777',
];
async function startApp(volume) {
  await docker([
    'run',
    '-d',
    '--name',
    names.app,
    '--network',
    names.network,
    '--network-alias',
    'app',
    '--init',
    ...hardening,
    ...env,
    '--mount',
    `type=volume,source=${volume},target=/data`,
    appImage,
  ]);
}
async function stopApp(remove = false) {
  await docker(['stop', '--time', '60', names.app], 75_000);
  if (remove) await docker(['rm', names.app]);
}
async function ready(expected = 200, path = '/healthz') {
  await until(async () => (await http(path)).status === expected);
}
const backupEnv = [
  '-e',
  'RESTIC_REPOSITORY=/operator/repository',
  '-e',
  'RESTIC_PASSWORD_FILE=/operator/secrets/restic-password',
  '-e',
  'RECOVERY_PASSWORD_FILE=/operator/secrets/recovery-password',
  '-e',
  'RESTIC_CACHE_DIR=/tmp/restic-cache',
];
async function cli(volume, command, extraMounts = []) {
  return oneOff([
    '--network',
    names.network,
    ...hardening,
    ...env,
    ...backupEnv,
    '--mount',
    `type=volume,source=${volume},target=/data`,
    '--mount',
    `type=volume,source=${operatorVolume},target=/operator`,
    ...extraMounts,
    appImage,
    'node',
    'dist/cli.js',
    ...command,
  ]);
}
async function login() {
  const response = await http('/actions/login', {
    method: 'POST',
    json: { username: 'alice', password: 'synthetic-container-passphrase' },
  });
  assert.equal(response.status, 200);
  const setCookie = response.headers['set-cookie']?.[0] ?? '';
  assert.match(setCookie, /^__Host-bookface=/);
  assert.match(setCookie, /; Secure/i);
  assert.match(setCookie, /; HttpOnly/i);
  assert.match(setCookie, /; SameSite=Strict/i);
  cookie = setCookie.split(';')[0];
  csrf = response.json().csrf;
  assert.ok(csrf);
}

try {
  // A caller builds the exact candidate first. This script never rebuilds it.
  imageInfo = JSON.parse(await docker(['image', 'inspect', appImage]))[0];
  workDir = await mkdtemp(join(tmpdir(), 'bookface-container-smoke-'));
  const configFile = join(workDir, 'Caddyfile');
  await writeFile(
    configFile,
    `{
  admin off
  auto_https disable_redirects
  skip_install_trust
}
${hostname} {
  tls internal
  reverse_proxy app:3000
  header -Server
}
`,
  );
  await step('isolated loopback-only HTTPS containers', async () => {
    // Some Docker implementations suppress host port publication on internal
    // networks. Use an isolated ordinary bridge and publish only loopback.
    // Both peers and TLS authority remain local to this synthetic test.
    await docker(['network', 'create', names.network]);
    for (const volume of volumes) await docker(['volume', 'create', volume]);
    // Mount at the image's pre-owned /data once, so all operator/restore volumes
    // receive the same non-root ownership as the production application volume.
    for (const volume of [operatorVolume, restoredVolume])
      await oneOff([
        ...hardening,
        '--mount',
        `type=volume,source=${volume},target=/data`,
        appImage,
        'node',
        '-e',
        'if(process.getuid()===0)process.exit(1)',
      ]);
    await startApp(sourceVolume);
    await docker([
      'run',
      '-d',
      '--name',
      names.proxy,
      '--network',
      names.network,
      '--publish',
      '127.0.0.1::443',
      '--cap-drop',
      'ALL',
      '--cap-add',
      'NET_BIND_SERVICE',
      '--security-opt',
      'no-new-privileges:true',
      '--memory',
      '256m',
      '--mount',
      `type=bind,source=${configFile},target=/etc/caddy/Caddyfile,readonly`,
      '--mount',
      `type=volume,source=${caddyVolume},target=/data`,
      caddyImage,
    ]);
    const published = await until(async () => {
      const proxy = JSON.parse(await docker(['inspect', names.proxy]))[0];
      return proxy.State.Running && proxy.NetworkSettings.Ports['443/tcp'];
    });
    assert.equal(published.length, 1);
    assert.equal(published[0].HostIp, '127.0.0.1');
    port = Number(published[0].HostPort);
    assert.ok(port > 1024);
    ca = await until(async () => {
      const certificate = await docker([
        'exec',
        names.proxy,
        'cat',
        '/data/caddy/pki/authorities/local/root.crt',
      ]);
      return certificate.includes('BEGIN CERTIFICATE') ? certificate : null;
    });
    await ready();
  });
  await step('non-root, read-only runtime and private persistence volume', async () => {
    const inspected = JSON.parse(await docker(['inspect', names.app]))[0];
    assert.equal(inspected.Config.User, 'node');
    assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
    assert.ok(inspected.HostConfig.CapDrop.includes('ALL'));
    assert.equal(Object.keys(inspected.HostConfig.PortBindings ?? {}).length, 0);
    runtime = JSON.parse(
      await docker([
        'exec',
        names.app,
        'node',
        '-e',
        "const fs=require('fs');let denied=false;try{fs.writeFileSync('/app/smoke-write','synthetic')}catch(e){denied=e.code==='EROFS'};console.log(JSON.stringify({uid:process.getuid(),rootWriteDenied:denied,dataMode:fs.statSync('/data').mode&511}))",
      ]),
    );
    assert.notEqual(runtime.uid, 0);
    assert.equal(runtime.rootWriteDenied, true);
    assert.equal(runtime.dataMode, 0o700);
  });
  await step('production HTTPS setup, secure session and CSRF enforcement', async () => {
    const token = await docker(['exec', names.app, 'node', 'dist/cli.js', 'setup-token']);
    const setup = await http('/actions/setup', {
      method: 'POST',
      json: {
        setupToken: token,
        username: 'alice',
        displayName: 'Alice Example',
        password: 'synthetic-container-passphrase',
        acceptRules: true,
      },
    });
    assert.equal(setup.status, 200);
    assert.equal(setup.json().user.username, 'alice');
    await login();
    assert.equal((await http('/api/me', { authenticated: true })).status, 200);
    assert.equal(
      (
        await http('/actions/posts', {
          method: 'POST',
          authenticated: true,
          json: { body: 'Rejected synthetic post', audience: 'private' },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await http('/actions/posts', {
          method: 'POST',
          authenticated: true,
          mutationOrigin: 'https://stranger.example',
          json: { body: 'Rejected synthetic post', audience: 'private', csrf },
        })
      ).status,
      403,
    );
  });
  let postId;
  let mediaId;
  let mediaHash;
  await step('private photo post through production HTTPS routes', async () => {
    const fixture = await readFile(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../tests/fixtures/synthetic/facebook/photos/synthetic-postcard.png',
      ),
    );
    const boundary = `bookface-${randomUUID()}`;
    const multipart = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="csrf"\r\n\r\n${csrf}\r\n--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="synthetic.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      fixture,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const upload = await http('/actions/photo', {
      method: 'POST',
      authenticated: true,
      bytes: multipart,
      contentType: `multipart/form-data; boundary=${boundary}`,
    });
    assert.equal(upload.status, 200);
    [mediaId] = upload.json().mediaIds;
    assert.ok(mediaId);
    const post = await http('/actions/posts', {
      method: 'POST',
      authenticated: true,
      json: {
        csrf,
        body: 'A fictional photo, deliberately private.',
        audience: 'private',
        mediaIds: [mediaId],
      },
    });
    assert.equal(post.status, 200);
    postId = post.json().post.id;
    const media = await http(`/posts/${postId}/media/${mediaId}`, { authenticated: true });
    assert.equal(media.status, 200);
    assert.match(media.headers['content-type'], /image\/webp/);
    mediaHash = createHash('sha256').update(media.bytes).digest('hex');
    for (const path of [
      `/api/posts/${postId}`,
      `/posts/${postId}/media/${mediaId}`,
      `/media/${mediaId}`,
      '/api/archive',
    ])
      assert.equal((await http(path)).status, 401);
  });
  await step('container restart preserves private post and exact media', async () => {
    await docker(['restart', '--time', '60', names.app], 75_000);
    await ready();
    const post = await http(`/api/posts/${postId}`, { authenticated: true });
    assert.equal(post.status, 200);
    assert.equal(post.json().post.audience, 'private');
    const media = await http(`/posts/${postId}/media/${mediaId}`, { authenticated: true });
    assert.equal(media.status, 200);
    assert.equal(createHash('sha256').update(media.bytes).digest('hex'), mediaHash);
  });
  await step('image-contained restic encrypts and restores into a fresh volume', async () => {
    await stopApp(true);
    await cli(sourceVolume, ['init-backup-secrets', '--directory', '/operator/secrets']);
    await cli(sourceVolume, ['backup-init']);
    const backup = JSON.parse(await cli(sourceVolume, ['backup']));
    assert.match(backup.snapshotId, /^[a-f0-9]+$/);
    await cli(sourceVolume, ['reconciliation-export', '--output', '/operator/current.enc']);
    await cli(
      sourceVolume,
      ['restore', '--snapshot', backup.snapshotId, '--target', '/restored'],
      ['--mount', `type=volume,source=${restoredVolume},target=/restored`],
    );
    await startApp(restoredVolume);
    await ready();
    await ready(503, '/login');
    assert.equal((await http(`/api/posts/${postId}`, { authenticated: true })).status, 503);
    await stopApp(true);
    await cli(restoredVolume, ['reconcile', '--ledger', '/operator/current.enc']);
    await startApp(restoredVolume);
    await ready();
    await ready(200, '/login');
    assert.equal((await http('/api/me', { authenticated: true })).status, 401);
    await login();
    const post = await http(`/api/posts/${postId}`, { authenticated: true });
    assert.equal(post.status, 200);
    assert.equal(post.json().post.audience, 'private');
    const media = await http(`/posts/${postId}/media/${mediaId}`, { authenticated: true });
    assert.equal(media.status, 200);
    assert.equal(createHash('sha256').update(media.bytes).digest('hex'), mediaHash);
    assert.equal((await http(`/posts/${postId}/media/${mediaId}`)).status, 401);
  });
} catch (error) {
  failure = error instanceof Error ? error.message : 'Container smoke failed';
  console.error(failure);
} finally {
  // Delete only resources created with this invocation's random names. Never
  // prune Docker, stop existing services or modify machine trust/network state.
  for (const name of [names.proxy, names.app, ...temporaryContainers])
    await run('docker', ['rm', '-f', '-v', name], { timeout: 30_000 }).catch(() => {});
  if (workDir) {
    await run('docker', ['network', 'rm', names.network], { timeout: 30_000 }).catch(() => {});
    for (const volume of volumes)
      await run('docker', ['volume', 'rm', volume], { timeout: 30_000 }).catch(() => {});
    await rm(workDir, { recursive: true, force: true });
  }
  const remaining = [];
  for (const [kind, resources] of [
    ['container', [names.proxy, names.app, ...temporaryContainers]],
    ['network', [names.network]],
    ['volume', volumes],
  ]) {
    for (const name of resources) {
      const exists = await run('docker', [kind, 'inspect', name], { timeout: 15_000 }).then(
        () => true,
        () => false,
      );
      if (exists) remaining.push(`${kind}:${name}`);
    }
  }
  if (remaining.length)
    failure = `${failure ? `${failure}; ` : ''}Isolated smoke resources remain after cleanup: ${remaining.join(', ')}`;
  else checks.push({ name: 'isolated containers, network and volumes removed', passed: true });
  const report = {
    passed: !failure,
    image: appImage,
    imageId: imageInfo?.Id,
    platform: imageInfo ? `${imageInfo.Os}/${imageInfo.Architecture}` : undefined,
    runtime,
    milliseconds: Date.now() - started,
    checks,
    ...(failure ? { failure } : {}),
  };
  if (reportFile)
    await writeFile(resolve(reportFile), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(report));
  if (failure) process.exitCode = 1;
}
