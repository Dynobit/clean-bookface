#!/usr/bin/env node
// Exercise managed-provider startup with synthetic data and isolated Docker
// resources. This never creates a provider account, paid service or host port.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Supply ${name}`);
  return args[index + 1];
}
const image = option('--image', 'clean-bookface:0.1.0');
const reportFile = option('--report', undefined);
const nodeImage =
  'node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6';
const prefix = `bookface-provider-${randomUUID().slice(0, 12)}`;
const app = `${prefix}-app`;
const data = `${prefix}-data`;
const operator = `${prefix}-operator`;
const containers = [app];
const checks = [];
const started = Date.now();
let workDir;
let bindDirectory;
let bindOwner;
let imageInfo;
let failure;
let cancelled = false;
process.once('SIGINT', () => {
  cancelled = true;
});
process.once('SIGTERM', () => {
  cancelled = true;
});

async function docker(argv, timeout = 60_000) {
  if (cancelled) throw new Error('Provider smoke cancelled');
  try {
    return (await run('docker', argv, { timeout, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
  } catch (error) {
    // Captured CLI output can contain the fictional setup credential. Never
    // print it, even when a later assertion fails.
    throw new Error(`Docker ${argv[0]} failed: ${String(error.stderr ?? '').slice(0, 1000)}`);
  }
}
async function oneOff(argv) {
  const name = `${prefix}-task-${containers.length}`;
  containers.push(name);
  return docker(['run', '--rm', '--name', name, '--network', 'none', ...argv]);
}
async function step(name, action) {
  const before = Date.now();
  await action();
  checks.push({ name, passed: true, milliseconds: Date.now() - before });
  console.log(`PASS ${name}`);
}
const environment = [
  '-e',
  'NODE_ENV=production',
  '-e',
  'PORT=3001',
  '-e',
  'APP_ORIGIN=https://circle.example',
  '-e',
  'FEDERATION_ENABLED=false',
  '-e',
  'RESTIC_REPOSITORY=/operator/repository',
  '-e',
  'RESTIC_PASSWORD_FILE=/operator/secrets/restic-password',
  '-e',
  'RECOVERY_PASSWORD_FILE=/operator/secrets/recovery-password',
  '-e',
  'RESTIC_CACHE_DIR=/tmp/restic-cache',
];
async function start(maintenance = false) {
  await docker([
    'run',
    '-d',
    '--name',
    app,
    '--network',
    'none',
    '--user',
    '0:0',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--cap-add',
    'CHOWN',
    '--cap-add',
    'FOWNER',
    '--cap-add',
    'DAC_OVERRIDE',
    '--cap-add',
    'SETUID',
    '--cap-add',
    'SETGID',
    '--security-opt',
    'no-new-privileges:true',
    '--pids-limit',
    '128',
    '--memory',
    '1536m',
    '--tmpfs',
    '/tmp:rw,nosuid,noexec,size=64m,mode=1777',
    ...environment,
    '-e',
    `MAINTENANCE_MODE=${maintenance}`,
    '--mount',
    `type=volume,source=${data},target=/data`,
    '--mount',
    `type=volume,source=${operator},target=/operator`,
    image,
    'node',
    'provider-start.mjs',
    'server',
  ]);
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const status = await inspectHttp('/healthz');
      if (status.status === 200 && status.body.status === (maintenance ? 'maintenance' : 'ok'))
        return;
    } catch {
      /* Startup can race a request. */
    }
    if (Date.now() >= deadline) {
      const logs = await docker(['logs', '--tail', '10', app]).catch(() => 'unavailable');
      throw new Error(`Provider process did not become healthy: ${logs.slice(0, 1000)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
async function stop() {
  await docker(['stop', '--time', '30', app], 40_000);
  await docker(['rm', app]);
}
async function evaluate(source, user = '1000:1000') {
  return docker(['exec', '--user', user, app, 'node', '-e', source]);
}
async function inspectHttp(path) {
  return JSON.parse(
    await evaluate(
      `require('http').get({hostname:'127.0.0.1',port:3001,path:${JSON.stringify(path)},headers:{host:'circle.example'}},r=>{let text='';r.on('data',b=>text+=b);r.on('end',()=>{let body;try{body=JSON.parse(text)}catch{body=text};console.log(JSON.stringify({status:r.statusCode,body}))})})`,
    ),
  );
}
async function cli(...command) {
  return docker(['exec', '--user', '0:0', app, 'node', 'provider-start.mjs', 'cli', ...command]);
}

try {
  imageInfo = JSON.parse(await docker(['image', 'inspect', image]))[0];
  assert.equal(imageInfo.Config.User, 'node');
  workDir = await mkdtemp(join(tmpdir(), 'bookface-provider-smoke-'));
  await writeFile(
    join(workDir, 'provider-start.mjs'),
    await readFile(new URL('../provider-start.mjs', import.meta.url)),
  );
  for (const volume of [data, operator]) await docker(['volume', 'create', volume]);
  await step(
    'ephemeral, tmpfs and read-only data are rejected before application import',
    async () => {
      for (const mount of [
        [],
        ['--tmpfs', '/data'],
        ['--mount', `type=volume,source=${data},target=/data,readonly`],
      ]) {
        const result = await oneOff([
          '--user',
          '0:0',
          ...mount,
          '--mount',
          `type=bind,source=${join(workDir, 'provider-start.mjs')},target=/app/provider-start.mjs,readonly`,
          nodeImage,
          'node',
          '-e',
          "const {spawnSync}=require('child_process'),assert=require('assert/strict');const p=spawnSync(process.execPath,['/app/provider-start.mjs'],{encoding:'utf8'});assert.equal(p.status,1);assert.match(p.stderr,/Storage setup: Attach a writable persistent/);assert.doesNotMatch(p.stderr,/ERR_MODULE_NOT_FOUND/);console.log('refused')",
        ]);
        assert.equal(result, 'refused');
      }
    },
  );
  await step('host bind storage accepts writes and survives container replacement', async () => {
    // Docker Desktop shares this temporary host directory; bind mount detection
    // must work even when the filesystem device number matches another mount.
    const directory = join(workDir, 'bind-data');
    await (await import('node:fs/promises')).mkdir(directory);
    bindDirectory = directory;
    bindOwner = await stat(directory);
    const runBind = async (write) =>
      oneOff([
        '--user',
        '0:0',
        '--mount',
        `type=bind,source=${directory},target=/data`,
        '--mount',
        `type=bind,source=${join(workDir, 'provider-start.mjs')},target=/app/provider-start.mjs,readonly`,
        nodeImage,
        'node',
        '-e',
        `const fs=require('fs'),assert=require('assert/strict'),{spawnSync}=require('child_process');fs.mkdirSync('/app/dist',{recursive:true});fs.writeFileSync('/app/dist/server.js',${JSON.stringify("const fs=require('fs');" + (write ? "fs.writeFileSync('/data/sentinel','fictional');" : "if(fs.readFileSync('/data/sentinel','utf8')!=='fictional')process.exit(2);") + "console.log('persistent bind')")});const p=spawnSync(process.execPath,['/app/provider-start.mjs'],{encoding:'utf8'});assert.equal(p.status,0,p.stderr);process.stdout.write(p.stdout);`,
      ]);
    assert.equal(await runBind(true), 'persistent bind');
    assert.equal(await runBind(false), 'persistent bind');
  });
  await step('foreign-owned database refuses startup without exposing file contents', async () => {
    const result = await oneOff([
      '--user',
      '0:0',
      '--mount',
      `type=volume,source=${data},target=/data`,
      '--mount',
      `type=bind,source=${join(workDir, 'provider-start.mjs')},target=/app/provider-start.mjs,readonly`,
      nodeImage,
      'node',
      '-e',
      "const fs=require('fs'),assert=require('assert/strict'),{spawnSync}=require('child_process');fs.writeFileSync('/data/bookface.sqlite','private sentinel',{mode:0o600});const p=spawnSync(process.execPath,['/app/provider-start.mjs'],{encoding:'utf8'});assert.equal(p.status,1);assert.match(p.stderr,/Data is not writable by uid 1000/);assert.doesNotMatch(p.stderr,/private sentinel/);assert.equal(fs.statSync('/data/bookface.sqlite').uid,0);fs.unlinkSync('/data/bookface.sqlite');console.log('ownership refused')",
    ]);
    assert.equal(result, 'ownership refused');
  });
  await step(
    'root-owned provider volume drops server privileges without changing child ownership',
    async () => {
      await oneOff([
        '--user',
        '0:0',
        '--mount',
        `type=volume,source=${data},target=/data`,
        '--mount',
        `type=volume,source=${operator},target=/operator`,
        image,
        'node',
        '-e',
        "const fs=require('fs');fs.chownSync('/data',0,0);fs.chmodSync('/data',0o755);fs.mkdirSync('/data/root-owned-child',{mode:0o700});fs.writeFileSync('/data/root-owned-child/sentinel','fictional',{mode:0o600});fs.chownSync('/operator',1000,1000);fs.chmodSync('/operator',0o700)",
      ]);
      await start();
      const state = JSON.parse(
        await evaluate(
          "const fs=require('fs');const stat=p=>{const s=fs.statSync(p);return {uid:s.uid,gid:s.gid,mode:s.mode&511}};console.log(JSON.stringify({process:fs.readFileSync('/proc/1/status','utf8'),data:stat('/data'),child:stat('/data/root-owned-child'),ssh:stat('/home/node/.ssh'),db:stat('/data/bookface.sqlite'),lock:fs.existsSync('/data/.instance-lock')}))",
          '0:0',
        ),
      );
      assert.match(state.process, /^Uid:\s+1000\s+1000\s+1000\s+1000$/m);
      assert.match(state.process, /^Gid:\s+1000\s+1000\s+1000\s+1000$/m);
      assert.match(state.process, /^Groups:\s*$/m);
      assert.match(state.process, /^CapEff:\s+0+$/m);
      assert.deepEqual(state.data, { uid: 1000, gid: 1000, mode: 0o700 });
      assert.deepEqual(state.child, { uid: 0, gid: 0, mode: 0o700 });
      assert.deepEqual(state.ssh, { uid: 1000, gid: 1000, mode: 0o700 });
      assert.equal(state.db.uid, 1000);
      assert.equal(state.db.mode, 0o600);
      assert.equal(state.lock, true);
      const health = imageInfo.Config.Healthcheck?.Test;
      assert.equal(health?.[0], 'CMD-SHELL');
      await docker(['exec', app, 'sh', '-c', health[1]]);
      const token = await cli('setup-token');
      assert.ok(/^[a-zA-Z0-9_-]{32,128}$/.test(token));
      const result = await evaluate(
        `const body=JSON.stringify({setupToken:${JSON.stringify(token)},username:'alice',displayName:'Alice Example',password:'synthetic-provider-passphrase',acceptRules:true});const request=require('http').request({hostname:'127.0.0.1',port:3001,path:'/actions/setup',method:'POST',headers:{host:'circle.example',origin:'https://circle.example','content-type':'application/json','content-length':Buffer.byteLength(body)}},r=>{r.resume();r.on('end',()=>console.log(r.statusCode))});request.end(body)`,
      );
      assert.equal(result, '200');
      await writeFile(
        join(workDir, 'provider-start.mjs'),
        await docker(['exec', app, 'cat', '/app/provider-start.mjs']),
      );
    },
  );
  await step(
    'maintenance leaves database closed and permits same-volume encrypted backup',
    async () => {
      await stop();
      const before = await oneOff([
        '--mount',
        `type=volume,source=${data},target=/data`,
        image,
        'node',
        '-e',
        "const fs=require('fs'),crypto=require('crypto');if(fs.existsSync('/data/.instance-lock'))process.exit(1);console.log(crypto.createHash('sha256').update(fs.readFileSync('/data/bookface.sqlite')).digest('hex'))",
      ]);
      await start(true);
      assert.equal((await inspectHttp('/login')).status, 503);
      assert.equal((await inspectHttp('/api/archive')).status, 503);
      const during = await evaluate(
        "const fs=require('fs'),crypto=require('crypto');if(fs.existsSync('/data/.instance-lock'))process.exit(1);console.log(crypto.createHash('sha256').update(fs.readFileSync('/data/bookface.sqlite')).digest('hex'))",
      );
      assert.equal(during, before);
      await cli('init-backup-secrets', '--directory', '/operator/secrets');
      await cli('backup-init');
      const backup = JSON.parse(await cli('backup'));
      assert.match(backup.snapshotId, /^[a-f0-9]+$/);
      const owners = JSON.parse(
        await evaluate(
          "const fs=require('fs');console.log(JSON.stringify(['/operator/secrets/restic-password','/operator/secrets/recovery-password','/operator/repository'].map(p=>fs.statSync(p).uid)))",
        ),
      );
      assert.deepEqual(owners, [1000, 1000, 1000]);
      await stop();
      await start();
      assert.equal((await inspectHttp('/login')).status, 200);
      await stop();
    },
  );
  await step(
    'symlink data directory is refused before ownership change or application import',
    async () => {
      // The application image declares VOLUME /data, so use its identical pinned
      // Node base to create a real symlink at that path. Execute the bootstrap
      // copied from the candidate image, not a modified copy or mocked fs API.
      const result = await oneOff([
        '--user',
        '0:0',
        '--mount',
        `type=bind,source=${join(workDir, 'provider-start.mjs')},target=/app/provider-start.mjs,readonly`,
        nodeImage,
        'node',
        '-e',
        "const fs=require('fs'),assert=require('assert/strict'),{spawnSync}=require('child_process');fs.mkdirSync('/untouched',{mode:0o750});fs.symlinkSync('/untouched','/data');const child=spawnSync(process.execPath,['/app/provider-start.mjs','server'],{encoding:'utf8'});assert.notEqual(child.status,0);assert.match(child.stderr,/Storage setup:/);const s=fs.statSync('/untouched');assert.equal(s.uid,0);assert.equal(s.gid,0);assert.equal(s.mode&511,0o750);console.log('symlink refused')",
      ]);
      assert.equal(result, 'symlink refused');
    },
  );
} catch (error) {
  failure = error instanceof Error ? error.message : 'Provider smoke failed';
  console.error(failure);
} finally {
  if (bindDirectory && bindOwner) {
    // Linux bind mounts retain the bootstrap's uid 1000 / mode 0700 on the
    // host. Restore only this synthetic directory to its original owner so a
    // runner with a different uid can remove it. Cleanup also runs on cancel.
    const name = `${prefix}-cleanup`;
    containers.push(name);
    try {
      await run(
        'docker',
        [
          'run',
          '--rm',
          '--name',
          name,
          '--network',
          'none',
          '--user',
          '0:0',
          '--cap-drop',
          'ALL',
          '--cap-add',
          'CHOWN',
          '--mount',
          `type=bind,source=${bindDirectory},target=/cleanup`,
          nodeImage,
          'node',
          '-e',
          `require('fs').chownSync('/cleanup',${bindOwner.uid},${bindOwner.gid})`,
        ],
        { timeout: 60_000, maxBuffer: 1024 * 1024 },
      );
    } catch {
      failure = `${failure ? `${failure}; ` : ''}Synthetic bind directory ownership cleanup failed`;
    }
  }
  for (const name of containers)
    await run('docker', ['rm', '-f', '-v', name], { timeout: 30_000 }).catch(() => {});
  for (const name of [data, operator])
    await run('docker', ['volume', 'rm', name], { timeout: 30_000 }).catch(() => {});
  if (workDir) {
    try {
      await rm(workDir, { recursive: true, force: true });
    } catch {
      failure = `${failure ? `${failure}; ` : ''}Synthetic temporary directory cleanup failed`;
    }
  }
  const remaining = [];
  for (const [kind, names] of [
    ['container', containers],
    ['volume', [data, operator]],
  ])
    for (const name of names) {
      const exists = await run('docker', [kind, 'inspect', name], { timeout: 15_000 }).then(
        () => true,
        () => false,
      );
      if (exists) remaining.push(`${kind}:${name}`);
    }
  if (remaining.length)
    failure = `${failure ? `${failure}; ` : ''}Resources remain: ${remaining.join(', ')}`;
  else checks.push({ name: 'isolated containers and volumes removed', passed: true });
  const report = {
    passed: !failure,
    image,
    imageId: imageInfo?.Id,
    platform: imageInfo ? `${imageInfo.Os}/${imageInfo.Architecture}` : undefined,
    milliseconds: Date.now() - started,
    checks,
    ...(failure ? { failure } : {}),
  };
  if (reportFile)
    await writeFile(resolve(reportFile), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(report));
  if (failure) process.exitCode = 1;
}
