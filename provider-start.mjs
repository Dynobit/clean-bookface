// Prepare the explicitly mounted data directory, then drop privileges before
// loading application code. Native development uses npm run dev instead.
import fs from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

function fail(message) {
  console.error(`Storage setup: ${message}`);
  process.exit(1);
}
const [mode = 'server', ...args] = process.argv.slice(2);
if (!['server', 'cli'].includes(mode)) fail('Choose server or cli.');
const configuredData = resolve(process.env.DATA_DIR ?? '/data');
if (configuredData !== '/data' && !configuredData.startsWith('/data/'))
  fail('DATA_DIR must be inside the mounted /data directory.');
const uid = 1000;
try {
  // Device IDs do not identify bind mounts. Read the kernel mount table, whose
  // path fields escape whitespace and backslashes using octal sequences.
  const decode = (value) =>
    value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
  const mounts = fs
    .readFileSync('/proc/self/mountinfo', 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const [left, right] = line.split(' - ');
      const fields = left.split(' ');
      return { path: decode(fields[4]), options: fields[5].split(','), type: right?.split(' ')[0] };
    });
  const mount = mounts.findLast((entry) => entry.path === '/data');
  if (!mount || ['tmpfs', 'ramfs', 'overlay'].includes(mount.type) || !mount.options.includes('rw'))
    fail('Attach a writable persistent named volume or host directory at /data before starting.');
  // Reject nested ephemeral mounts and symlink escapes from the selected tree.
  const real = fs.realpathSync(configuredData);
  if (real !== configuredData) fail('DATA_DIR and its parents must not be symbolic links.');
  for (const entry of mounts)
    if (
      entry.path.startsWith('/data/') &&
      (configuredData === entry.path || configuredData.startsWith(`${entry.path}/`))
    )
      fail('Use /data directly; nested data mounts are not supported.');
  const descriptor = fs.openSync(
    '/data',
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  try {
    if (!fs.fstatSync(descriptor).isDirectory()) fail('Attach a directory at /data.');
    if (process.getuid?.() === 0) {
      fs.fchownSync(descriptor, uid, uid);
      fs.fchmodSync(descriptor, 0o700);
    }
  } finally {
    fs.closeSync(descriptor);
  }
} catch {
  fail('Cannot verify /data. Attach an existing persistent directory without symbolic links.');
}
if (process.getuid?.() === 0) {
  process.setgroups([]);
  process.setgid(uid);
  process.setuid(uid);
}
if (process.getuid?.() !== uid || process.getgid?.() !== uid)
  fail('Run the application as uid/gid 1000, or use the root bootstrap to prepare the volume.');
try {
  fs.accessSync(configuredData, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  // Check application-owned entries only: unrelated administrator directories
  // are neither rewritten nor a reason to reject otherwise usable storage.
  const owned = [
    'bookface.sqlite',
    'bookface.sqlite-wal',
    'bookface.sqlite-shm',
    '.instance-lock',
    '.setup-token',
    'media',
    'imports',
    'incoming',
    '.backup-staging',
    '.restored-reconciliation.enc',
  ];
  for (const name of owned) {
    const path = join(configuredData, name);
    let stat;
    try {
      stat = fs.lstatSync(path);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isSymbolicLink() || stat.uid !== uid) throw new Error('ownership');
    fs.accessSync(
      path,
      fs.constants.R_OK | fs.constants.W_OK | (stat.isDirectory() ? fs.constants.X_OK : 0),
    );
  }
  const probe = join(configuredData, `.write-check-${randomUUID()}`);
  const descriptor = fs.openSync(probe, 'wx', 0o600);
  try {
    fs.writeSync(descriptor, 'storage check');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
    fs.unlinkSync(probe);
  }
} catch {
  fail(
    'Data is not writable by uid 1000. Stop the service and repair ownership and permissions of its data files; do not delete the volume.',
  );
}
// Do not rewrite HOME: SSH identities and restic locations must be configured
// explicitly by the operator, rather than inferred from a privilege change.
const entry = new URL(mode === 'cli' ? './dist/cli.js' : './dist/server.js', import.meta.url);
process.argv = [process.execPath, entry.pathname, ...args];
await import(entry.href);
