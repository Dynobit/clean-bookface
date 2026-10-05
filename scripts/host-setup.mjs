#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { lstat, mkdir, open, rmdir, statfs } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function settings(domain, name) {
  domain = domain.trim().toLowerCase();
  name = name.trim();
  if (
    domain.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(domain) ||
    /\.(?:example|invalid|localhost|local|test)$/.test(domain)
  ) {
    throw new Error(
      'Use your real domain name only, such as friends.your-domain.org. Leave out https://, paths and ports.',
    );
  }
  if (!/^[\p{L}\p{N} .,'’!?()-]{1,80}$/u.test(name)) {
    throw new Error('Use 1–80 letters, numbers, spaces or simple punctuation for the circle name.');
  }
  return `COMPOSE_PROJECT_NAME=clean-bookface\nAPP_DOMAIN=${domain}\nINSTANCE_NAME="${name}"\nFEDERATION_ENABLED=false\nMAX_UPLOAD_BYTES=1073741824\n`;
}

export async function command(args, cwd, sensitive = false) {
  return new Promise((resolveResult, reject) => {
    // No shell, no Compose discovery, and no output capture of setup codes.
    const child = spawn('docker', args, {
      cwd,
      stdio: sensitive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      env: cleanEnvironment(),
    });
    let output = '';
    if (!sensitive) {
      const collect = (chunk) => {
        output = (output + chunk).slice(-8192);
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
    }
    child.once('error', () =>
      reject(
        new Error(
          'Docker could not start. Install Docker Engine and its Compose plugin, then try again.',
        ),
      ),
    );
    child.once('exit', (code) => resolveResult({ code, output }));
  });
}
function cleanEnvironment() {
  const env = { ...process.env };
  if (env.DOCKER_HOST && !env.DOCKER_HOST.startsWith('unix://')) {
    throw new Error(
      'Run setup on the server itself using its local Docker socket, without a remote DOCKER_HOST.',
    );
  }
  for (const key of Object.keys(env))
    if (
      key.startsWith('COMPOSE_') ||
      ['APP_DOMAIN', 'INSTANCE_NAME', 'FEDERATION_ENABLED', 'MAX_UPLOAD_BYTES'].includes(key)
    )
      delete env[key];
  return env;
}
async function existing(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
export async function runSetup({
  root = project,
  mode = 'start',
  ask,
  say = console.log,
  run = command,
  memory = totalmem(),
  freeBytes,
  storageProbe = statfs,
  lockPath = '/tmp/clean-bookface-setup.lock',
} = {}) {
  if (!['start', 'status', 'code'].includes(mode))
    throw new Error('Use ./setup, ./setup status, or ./setup code.');
  const envPath = join(root, '.env');
  const envFile = await existing(envPath);
  if (
    envFile &&
    (!envFile.isFile() ||
      envFile.isSymbolicLink() ||
      envFile.mode & 0o077 ||
      (process.getuid && envFile.uid !== process.getuid()))
  )
    throw new Error(
      '.env must be a regular file readable only by its owner. Review it and run chmod 600 .env.',
    );
  if (mode === 'start' && envFile)
    throw new Error(
      'This copy already has .env. Nothing was changed. Use ./setup status or ./setup code. For changes and updates, follow docs/INSTALL.md.',
    );
  if (mode !== 'start' && !envFile)
    throw new Error('No installation settings here yet. Run ./setup first.');
  const checked = async (args, message, sensitive = false) => {
    const result = await run(args, root, sensitive);
    if (result.code !== 0) throw new Error(message);
    return result.output;
  };
  await checked(
    ['compose', 'version'],
    'Docker Compose is missing. Install the Compose plugin and try again.',
  );
  const endpoint = await checked(
    ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
    'Cannot inspect Docker context. Use the local Docker context on this server.',
  );
  if (!endpoint.trim().startsWith('unix://'))
    throw new Error(
      'Use the local Docker context on this server; remote Docker hosts are not supported by this guide.',
    );
  const server = await checked(
    ['info', '--format', '{{.OSType}} {{.MemTotal}}'],
    'Docker is not responding. Start Docker on this server and try again.',
  );
  const [os, bytes] = server.trim().split(/\s+/);
  if (os !== 'linux') throw new Error('This recipe needs Docker running Linux containers.');
  const compose = [
    'compose',
    '--project-directory',
    root,
    '--env-file',
    envPath,
    '-f',
    join(root, 'compose.yaml'),
    '-p',
    'clean-bookface',
  ];
  if (mode === 'status') {
    say(
      await checked(
        [...compose, 'ps'],
        'Cannot read this circle’s containers. Check Docker and docs/INSTALL.md.',
      ),
    );
    say(
      'A running container is only one check. Open your HTTPS address, sign in, and verify a backup restore before inviting friends.',
    );
    return;
  }
  if (mode === 'code') {
    await checked(
      [...compose, 'exec', '-T', 'app', 'node', 'dist/cli.js', 'setup-token'],
      'Setup code unavailable. Check ./setup status. If your first account already exists, sign in instead.',
      true,
    );
    return;
  }
  if (!Number.isFinite(Number(bytes)) || Math.min(memory, Number(bytes)) < 3.5 * 1024 ** 3)
    throw new Error('Use a server with at least 4 GB RAM, with that memory available to Docker.');
  const dockerRoot = (
    await checked(
      ['info', '--format', '{{.DockerRootDir}}'],
      'Cannot locate Docker data storage. Use the manual installation reference.',
    )
  ).trim();
  if (!dockerRoot.startsWith('/'))
    throw new Error(
      'Docker did not report a local data directory. Use the manual installation reference.',
    );
  let dockerFree;
  try {
    const disk = await storageProbe(dockerRoot);
    dockerFree = disk.bavail * disk.bsize;
  } catch {
    throw new Error(
      'Cannot verify free space on Docker’s data filesystem from this terminal. No installation started. Ask the server administrator to check Docker storage, then use docs/INSTALL.md for manual setup.',
    );
  }
  if (freeBytes === undefined) {
    const disk = await storageProbe(root);
    freeBytes = disk.bavail * disk.bsize;
  }
  if (!Number.isFinite(dockerFree) || dockerFree < 20 * 1024 ** 3)
    throw new Error(
      'Keep at least 20 GiB free on Docker’s data filesystem for this starter installation.',
    );
  if (!Number.isFinite(freeBytes) || freeBytes < 20 * 1024 ** 3)
    throw new Error(
      'Keep at least 20 GiB free on the checkout filesystem for build working space.',
    );
  say(
    'Checked free space separately on the checkout and Docker data filesystems. Member archives and backups need additional capacity.',
  );
  // The fixed Compose project owns fixed volume names. Never adopt an older installation.
  const assertNoInstallation = async () => {
    const containers = await checked(
      ['ps', '-aq', '--filter', 'label=com.docker.compose.project=clean-bookface'],
      'Cannot check for an existing installation.',
    );
    const volumes = await checked(
      ['volume', 'ls', '-q', '--filter', 'name=clean-bookface_'],
      'Cannot check existing data volumes.',
    );
    if (containers.trim() || volumes.trim())
      throw new Error(
        'A Clean Bookface installation or data volume already exists on this Docker server. Nothing was changed. Use its original checkout and recovery instructions.',
      );
  };
  await assertNoInstallation();
  say(
    'Host your circle: your domain → your first account → your private memories.\nYou handle this server, its bill, updates and backups. No hosting or DNS is purchased or configured here.',
  );
  const domain = await ask('Your domain (without https://): ');
  const name = await ask('Name of your circle: ');
  const content = settings(domain, name);
  say(
    'Before starting: point that domain at this server, allow inbound ports 80 and 443, and keep those ports free. This helper does not change DNS or firewall rules.',
  );
  if (
    (await ask('Type START to build and start this circle on this Docker server: ')).trim() !==
    'START'
  ) {
    say('Cancelled. Nothing changed.');
    return;
  }
  // mkdir is atomic across checkouts and Unix users. Never steal a stale lock:
  // a killed helper may still have a Docker child building the installation.
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error(
        'Another setup owns the host-wide setup lock. Nothing changed. See the setup guide before removing a stale lock.',
      );
    throw error;
  }
  try {
    await assertNoInstallation();
    const handle = await open(envPath, 'wx', 0o600);
    try {
      await handle.writeFile(content);
    } finally {
      await handle.close();
    }
    await checked(
      [...compose, 'config', '--quiet'],
      'Settings saved privately, but Compose validation failed. Review .env and compose.yaml. No containers were started.',
    );
    say('Building and starting. The first build can take several minutes.');
    await checked(
      [...compose, 'up', '-d', '--build', '--wait', '--wait-timeout', '180'],
      'Startup did not finish. Your settings and data were kept. Run ./setup status; see the troubleshooting steps in docs/HOST_YOUR_CIRCLE.md.',
    );
    say(
      `Open https://${domain.trim().toLowerCase()}/ to create your first account. HTTPS may need a few minutes after DNS becomes ready.\nRun ./setup code privately to display the one-time setup code. Save your account recovery codes somewhere safe.\nNext: Host tools → Set up backups. Prove a restore before inviting friends.\nConnecting other hosts stays off until you deliberately enable it.`,
    );
  } finally {
    await rmdir(lockPath);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] || 'start';
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      'Run this guide in a private interactive terminal. Setup codes must not enter logs.',
    );
    process.exitCode = 1;
  } else {
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
      await runSetup({ mode, ask: (question) => terminal.question(question) });
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    } finally {
      terminal.close();
    }
  }
}
