import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createHash, createCipheriv, createDecipheriv, scryptSync, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/storage.js';
import { Core } from '../src/core.js';
import { Archive } from '../src/archive.js';
import {
  createBackup,
  restoreBackup,
  initializeBackup,
  exportReconciliation,
  reconcileRestore,
  acquireInstanceLock,
  dockerContainerIdFromCgroup,
  dockerContainerIdFromKernel,
  unlockStoppedInstance,
} from '../src/operations.js';
const origin = 'https://circle.example';
const binary = process.env.RESTIC_TEST_BINARY ?? 'restic';
let available = false;
try {
  execFileSync(binary, ['version'], { stdio: 'ignore' });
  available = true;
} catch {}
if (process.env.CI && !available) throw new Error('CI requires real restic review regressions.');
function rewrite(bytes: Buffer, password: string, change: (state: any) => void): Buffer {
  const envelope = JSON.parse(bytes.toString());
  const key = scryptSync(password, Buffer.from(envelope.salt, 'base64'), 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64'));
  decipher.setAAD(Buffer.from(envelope.format));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const state = JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString(),
  );
  change(state);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(envelope.format));
  envelope.ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(state)),
    cipher.final(),
  ]).toString('base64');
  envelope.nonce = nonce.toString('base64');
  envelope.tag = cipher.getAuthTag().toString('base64');
  return Buffer.from(JSON.stringify(envelope));
}
test(
  'real restic: exact-purpose, strictly newer installation-bound ledgers preserve removals and settings',
  { skip: !available },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'bookface-review-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const data = join(root, 'source');
    const store = new Store(data);
    t.after(() => store.close());
    store.setSetting('origin', origin);
    const core = new Core(store, { origin });
    new Archive(store);
    const user = (
      await core.setup({
        username: 'alice',
        displayName: 'Alice Example',
        password: 'Fictional password for tests',
      })
    ).user;
    const post = core.publish(user.id, { body: 'Example', audience: 'private' });
    store.db
      .prepare('INSERT INTO likes VALUES(?,?,?,?)')
      .run(post.id, user.actor, 'example-like', Date.now());
    const mediaBytes = Buffer.from('fictional media bytes');
    const mediaName = 'synthetic_base64url-name.bin';
    await mkdir(join(data, 'media'), { recursive: true });
    await writeFile(join(data, 'media', mediaName), mediaBytes);
    store.db
      .prepare(
        'INSERT INTO archive_media(id,owner_id,mime,size,sha256,filename,purpose,created_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        'synthetic-media',
        user.id,
        'application/octet-stream',
        mediaBytes.length,
        createHash('sha256').update(mediaBytes).digest('hex'),
        mediaName,
        'original',
        Date.now(),
      );
    const options = {
      repository: relative(process.cwd(), join(root, 'repo')),
      passwordFile: join(root, 'password'),
      recoveryPasswordFile: join(root, 'recovery'),
      resticBinary: binary,
    };
    const password = randomBytes(32).toString('hex');
    await writeFile(options.passwordFile, randomBytes(32).toString('hex'), { mode: 0o600 });
    await writeFile(options.recoveryPasswordFile, password, { mode: 0o600 });
    await initializeBackup(options, join(root, 'previously-absent'));
    const receipt = await createBackup(data, origin, options);
    const target = join(root, 'target');
    const manifest = await restoreBackup(target, origin, receipt.snapshotId, options);
    assert.deepEqual(await readFile(join(target, 'media', mediaName)), mediaBytes);
    const restored = new Store(target);
    t.after(() => restored.close());
    assert.equal(restored.setting('last_backup_snapshot'), receipt.snapshotId);
    const raw = join(root, 'raw');
    execFileSync(binary!, ['restore', receipt.snapshotId, '--target', raw], {
      env: {
        ...process.env,
        RESTIC_REPOSITORY: options.repository,
        RESTIC_PASSWORD_FILE: options.passwordFile,
      },
      stdio: 'ignore',
    });
    await assert.rejects(
      reconcileRestore(
        target,
        origin,
        join(raw, 'payload', 'recovery.enc'),
        options.recoveryPasswordFile,
      ),
      /Incompatible ledger/,
    );
    await assert.rejects(
      exportReconciliation(target, options.recoveryPasswordFile, join(root, 'paused-ledger')),
      /paused restore/,
    );
    store.db.exec('DELETE FROM likes');
    store.db
      .prepare('INSERT INTO friend_preferences VALUES(?,?,1,0)')
      .run(user.id, 'https://peer.example/users/bob');
    const otherDir = join(root, 'fresh-same-origin');
    const other = new Store(otherDir);
    other.setSetting('origin', origin);
    other.close();
    const otherLedger = join(root, 'other-ledger');
    await exportReconciliation(otherDir, options.recoveryPasswordFile, otherLedger);
    await assert.rejects(
      reconcileRestore(target, origin, otherLedger, options.recoveryPasswordFile),
      /installation/,
    );
    assert.equal(restored.db.prepare('SELECT COUNT(*) n FROM users').get()!.n, 1);
    const ledger = join(root, 'ledger');
    await exportReconciliation(data, options.recoveryPasswordFile, ledger);
    const valid = await readFile(ledger);
    for (const date of [manifest.createdAt, 'not-a-date']) {
      await writeFile(
        ledger,
        rewrite(valid, password, (state) => {
          state.capturedAt = date;
        }),
      );
      await assert.rejects(
        reconcileRestore(target, origin, ledger, options.recoveryPasswordFile),
        /stale/,
      );
      assert.equal(restored.setting('restore_reconciliation_required'), 'true');
    }
    await writeFile(
      ledger,
      rewrite(valid, password, (state) => {
        state.installationId = 'another-installation';
      }),
    );
    await assert.rejects(
      reconcileRestore(target, origin, ledger, options.recoveryPasswordFile),
      /installation/,
    );
    assert.equal(restored.db.prepare('SELECT COUNT(*) n FROM users').get()!.n, 1);
    await writeFile(ledger, valid);
    restored.setSetting('restored_backup_at', 'broken');
    await assert.rejects(
      reconcileRestore(target, origin, ledger, options.recoveryPasswordFile),
      /stale/,
    );
    restored.setSetting('restored_backup_at', manifest.createdAt);
    await reconcileRestore(target, origin, ledger, options.recoveryPasswordFile);
    assert.equal(restored.setting('restore_reconciliation_required'), 'false');
    assert.equal(restored.db.prepare('SELECT COUNT(*) n FROM likes').get()!.n, 0);
    assert.equal(restored.db.prepare('SELECT muted FROM friend_preferences').get()!.muted, 1);
  },
);
test('foreign lock recovery requires exact stopped-container inspection and token, never age alone', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'bookface-lock-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = acquireInstanceLock(root, 'test');
  const path = join(root, '.instance-lock', 'owner.json');
  const owner = JSON.parse(await readFile(path, 'utf8'));
  owner.containerId = 'a'.repeat(64);
  owner.hostname = 'fictional-stopped-container';
  owner.pidNamespace = 'pid:[other]';
  owner.createdAt = '2025-01-01T00:00:00Z';
  await writeFile(path, JSON.stringify(owner));
  assert.throws(() => unlockStoppedInstance(root), /different host/);
  const inspectFile = join(root, 'inspection');
  const record = {
    Id: 'a'.repeat(64),
    Config: { Hostname: owner.hostname },
    State: {
      Running: true,
      Restarting: false,
      Paused: false,
      Status: 'exited',
      Pid: 0,
      FinishedAt: '2025-01-02T00:00:00Z',
    },
  };
  await writeFile(inspectFile, JSON.stringify([record]), { mode: 0o600 });
  assert.throws(
    () => unlockStoppedInstance(root, { inspectFile, lockToken: owner.token }),
    /does not match/,
  );
  record.State.Running = false;
  await writeFile(inspectFile, JSON.stringify([record]));
  assert.throws(
    () => unlockStoppedInstance(root, { inspectFile, lockToken: 'wrong' }),
    /does not match/,
  );
  // A different stopped container can deliberately share the same --hostname.
  record.Id = 'b'.repeat(64);
  await writeFile(inspectFile, JSON.stringify([record]));
  assert.throws(
    () => unlockStoppedInstance(root, { inspectFile, lockToken: owner.token }),
    /does not match/,
  );
  assert.equal(JSON.parse(await readFile(path, 'utf8')).token, owner.token);
  record.Id = owner.containerId;
  await writeFile(inspectFile, JSON.stringify([record]));
  const boundId = owner.containerId;
  delete owner.containerId;
  await writeFile(path, JSON.stringify(owner));
  assert.throws(
    () => unlockStoppedInstance(root, { inspectFile, lockToken: owner.token }),
    /no kernel-recorded Docker identity/,
  );
  owner.containerId = boundId;
  await writeFile(path, JSON.stringify(owner));
  unlockStoppedInstance(root, { inspectFile, lockToken: owner.token });
  const next = acquireInstanceLock(root, 'next');
  release();
  assert.throws(() => acquireInstanceLock(root, 'must remain locked'), /in use/);
  next();
});

test('Docker identity parsing accepts exact kernel cgroup IDs and fails closed on ambiguous or hidden identity', () => {
  const id = 'a'.repeat(64);
  assert.equal(dockerContainerIdFromCgroup(`12:memory:/docker/${id}\n11:cpu:/docker/${id}`), id);
  assert.equal(dockerContainerIdFromCgroup(`0::/system.slice/docker-${id}.scope`), id);
  for (const text of [
    '0::/',
    `0::/docker/${id.slice(0, 12)}`,
    `0::/custom/${id}`,
    `0::/docker/${id}extra`,
    `0::/docker/${id}\n1:cpu:/docker/${'b'.repeat(64)}`,
  ])
    assert.equal(dockerContainerIdFromCgroup(text), null);
});

test('private-cgroup Docker identity comes from exact kernel file mounts and all IDs must agree', () => {
  const id = 'a'.repeat(64),
    other = 'b'.repeat(64);
  const mount = (container: string, file = 'hostname', target = `/etc/${file}`) =>
    `83 62 8:1 /var/lib/docker/containers/${container}/${file} ${target} rw,relatime - ext4 /dev/sda1 rw`;
  const files = ['hostname', 'hosts', 'resolv.conf'].map((file) => mount(id, file)).join('\n');
  assert.equal(dockerContainerIdFromKernel('0::/\n', files), id);
  assert.equal(dockerContainerIdFromKernel(`0::/docker/${id}`, files), id);
  assert.equal(dockerContainerIdFromKernel(`0::/docker/${other}`, files), null);
  assert.equal(dockerContainerIdFromKernel('0::/', `${files}\n${mount(other, 'hosts')}`), null);
  assert.equal(
    dockerContainerIdFromKernel(`0::/docker/${id}\n1:cpu:/docker/${other}`, files),
    null,
  );
  for (const invalid of [
    mount(id, 'hostname', '/tmp/hostname'),
    mount(id, 'hostname', '/etc/hosts'),
    mount(id.slice(0, 12)),
    mount(id).replace('/var/lib/docker/containers/', '/operator/files/'),
    '',
  ])
    assert.equal(dockerContainerIdFromKernel('0::/', invalid), null);
});
