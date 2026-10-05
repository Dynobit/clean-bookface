import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  randomBytes,
  generateKeyPairSync,
  createPrivateKey,
  sign,
  verify,
  createHash,
} from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/storage.js';
import { Core } from '../src/core.js';
import { Archive } from '../src/archive.js';
import { ChunkUploads, CHUNK_BYTES } from '../src/chunk-uploads.js';
import {
  acquireInstanceLock,
  initializeBackup,
  createBackup,
  restoreBackup,
  exportReconciliation,
  reconcileRestore,
  type BackupOptions,
  unlockStoppedInstance,
} from '../src/operations.js';
const origin = 'https://circle.example';
const resticBinary = process.env.RESTIC_TEST_BINARY ?? 'restic';
let available = false;
try {
  execFileSync(resticBinary, ['version'], { stdio: 'ignore' });
  available = true;
} catch {
  /* Explicit skip on developers without restic; CI installs it. */
}
if (process.env.CI && !available)
  throw new Error(
    'CI requires real restic backup tests; install restic or set RESTIC_TEST_BINARY.',
  );
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'bookface-backup-test-'));
  const data = join(root, 'data');
  const store = new Store(data);
  store.setSetting('origin', origin);
  const archive = new Archive(store);
  const core = new Core(store, {
    origin,
    validateMedia: (owner, ids) => {
      for (const id of ids) assert.equal(archive.isShareableMedia(owner, id), true);
    },
  });
  const alice = (
    await core.setup({
      username: 'alice',
      displayName: 'Alice Example',
      password: 'Fictional passphrase one',
    })
  ).user;
  const bob = (
    await core.register({
      username: 'bob',
      displayName: 'Bob Example',
      password: 'Fictional passphrase two',
      inviteToken: core.createInvite(alice.id, 'registration').token,
    })
  ).user;
  const request = core.requestFriend(alice.id, bob.actor);
  core.acceptFriend(bob.id, request);
  await archive.importDirectory(
    alice.id,
    new URL('./fixtures/synthetic/facebook/', import.meta.url).pathname,
  );
  const memory = archive.list(alice.id).find((item) => item.mediaIds.length)!;
  const share = await archive.shareCopy(alice.id, memory.id);
  const post = core.publish(alice.id, {
    body: 'Private backup test post',
    audience: 'friends',
    mediaIds: share.media.map((m) => m.id),
  });
  store.db.exec(
    `CREATE TABLE federation_keys(actor TEXT PRIMARY KEY,private_jwk TEXT NOT NULL,public_jwk TEXT NOT NULL); CREATE TABLE federation_blocked_hosts(host TEXT PRIMARY KEY,blocked_at INTEGER NOT NULL); CREATE TABLE federation_deliveries(event_id TEXT PRIMARY KEY,state TEXT,lease_until INTEGER); CREATE TABLE federation_scan(id INTEGER PRIMARY KEY,cursor TEXT); INSERT INTO federation_scan VALUES(1,'oldcursor'); CREATE TABLE federation_received(activity_id TEXT,recipient TEXT,actor TEXT,body_hash TEXT,received_at INTEGER,PRIMARY KEY(activity_id,recipient));`,
  );
  const keypair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateJwk = JSON.stringify(keypair.privateKey.export({ format: 'jwk' }));
  store.db
    .prepare('INSERT INTO federation_keys VALUES(?,?,?)')
    .run(alice.actor, privateJwk, JSON.stringify(keypair.publicKey.export({ format: 'jwk' })));
  const options: BackupOptions = {
    repository: join(root, 'restic-repository'),
    passwordFile: join(root, 'restic-password'),
    recoveryPasswordFile: join(root, 'recovery-password'),
    resticBinary,
  };
  await writeFile(options.passwordFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  await writeFile(options.recoveryPasswordFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    data,
    store,
    core,
    archive,
    alice,
    bob,
    post,
    memory,
    options,
    keypair,
    privateJwk,
  };
}

test('instance lock excludes simultaneous server and backup work without stealing live locks', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'bookface-lock-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = acquireInstanceLock(root, 'server');
  assert.throws(() => acquireInstanceLock(root, 'backup'), /in use/);
  release();
  const backupRelease = acquireInstanceLock(root, 'backup');
  backupRelease();
});

test(
  'real encrypted restic backup/restore preserves media and private ACLs; current ledger removes newer revocations',
  { skip: !available },
  async (t) => {
    const {
      root,
      data,
      store,
      core,
      archive,
      alice,
      bob,
      post,
      memory,
      options,
      keypair,
      privateJwk,
    } = await fixture(t);
    await initializeBackup(options, root);
    const release = acquireInstanceLock(data, 'server');
    await assert.rejects(createBackup(data, origin, options), /in use/);
    release();
    const first = await createBackup(data, origin, options);
    assert.match(first.snapshotId, /^[a-f0-9]+$/);
    assert.ok(store.setting('last_backup_at'));
    const raw = join(root, 'raw-payload');
    await mkdir(raw);
    execFileSync(resticBinary, ['restore', first.snapshotId, '--target', raw], {
      env: {
        ...process.env,
        RESTIC_REPOSITORY: options.repository,
        RESTIC_PASSWORD_FILE: options.passwordFile,
      },
      stdio: 'ignore',
    });
    const rawDatabase = new DatabaseSync(join(raw, 'payload', 'bookface.sqlite'));
    assert.equal(rawDatabase.prepare('SELECT COUNT(*) n FROM federation_keys').get()!.n, 0);
    assert.equal(
      rawDatabase.prepare('SELECT password_hash FROM users WHERE id=?').get(alice.id)!
        .password_hash,
      'restored-credentials-required',
    );
    rawDatabase.close();
    assert.equal(
      (await readFile(join(raw, 'payload', 'bookface.sqlite'))).includes(Buffer.from(privateJwk)),
      false,
    );
    const target = join(root, 'restored');
    const manifest = await restoreBackup(target, origin, first.snapshotId, options);
    assert.equal(manifest.origin, origin);
    const restoredStore = new Store(target);
    const restoredArchive = new Archive(restoredStore);
    const restoredCore = new Core(restoredStore, {
      origin,
      sharingAllowed: () => restoredStore.setting('restore_reconciliation_required') !== 'true',
    });
    assert.equal(restoredStore.setting('restore_reconciliation_required'), 'true');
    assert.equal(restoredArchive.count(alice.id), 7);
    assert.equal(restoredCore.canRead(post.id, bob.id), false);
    assert.equal(restoredCore.canRead(post.id, alice.id), true);
    assert.equal(restoredArchive.get(bob.id, memory.id), null);
    const original = archive.media(alice.id, memory.mediaIds[0]!)!;
    const restored = restoredArchive.media(alice.id, memory.mediaIds[0]!)!;
    assert.deepEqual(await readFile(restored.path), await readFile(original.path));
    const restoredJwk = String(
      restoredStore.db.prepare('SELECT private_jwk FROM federation_keys').get()!.private_jwk,
    );
    assert.equal(restoredJwk, privateJwk);
    const challenge = Buffer.from('A fictional restore signing challenge');
    const signature = sign(
      'sha256',
      challenge,
      createPrivateKey({ key: JSON.parse(restoredJwk), format: 'jwk' }),
    );
    assert.equal(verify('sha256', challenge, keypair.publicKey, signature), true);
    await restoredCore.login('alice', 'Fictional passphrase one');
    assert.equal(restoredStore.db.prepare('SELECT COUNT(*) n FROM recovery_codes').get()!.n, 0);
    restoredStore.close();
    // These deletions occurred after the backed-up state and must not be resurrected.
    core.revokeRecipients(alice.id, post.id, [bob.actor]);
    for (const item of archive.list(alice.id))
      if (item.mediaIds.includes(memory.mediaIds[0]!)) archive.deleteItem(alice.id, item.id);
    store.db
      .prepare('INSERT INTO federation_blocked_hosts VALUES(?,?)')
      .run('abusive.example', Date.now());
    core.transferAdministration(alice.id, bob.id);
    await core.changePassword(
      alice.id,
      'Fictional passphrase one',
      'A revised fictional passphrase',
    );
    core.updateSettings(alice.id, { compactFeed: true });
    const removalId = 'https://circle.example/federation/activities/synthetic-removal';
    store.db
      .prepare(
        `INSERT INTO domain_events(id,kind,actor,recipient_actor,object_id,revision,payload,created_at) VALUES(?,'post.delete',?,?,?,?,?,?)`,
      )
      .run(
        removalId,
        alice.actor,
        'https://peer.example/users/friend',
        post.id,
        99,
        JSON.stringify({ postId: post.id }),
        Date.now(),
      );
    const ledger = join(root, 'current-state.enc');
    await exportReconciliation(data, options.recoveryPasswordFile, ledger);
    assert.ok(!(await readFile(ledger, 'utf8')).includes(privateJwk));
    await reconcileRestore(target, origin, ledger, options.recoveryPasswordFile);
    const current = new Store(target);
    const afterArchive = new Archive(current);
    const afterCore = new Core(current, { origin });
    assert.equal(current.setting('restore_reconciliation_required'), 'false');
    assert.equal(afterCore.canRead(post.id, bob.id), false);
    assert.equal(afterArchive.get(alice.id, memory.id), null);
    assert.equal(afterArchive.media(alice.id, memory.mediaIds[0]!), null);
    assert.equal(current.db.prepare('SELECT COUNT(*) n FROM sessions').get()!.n, 0);
    assert.equal(afterCore.user(alice.id).admin, false);
    assert.equal(afterCore.user(alice.id).compactFeed, true);
    await assert.rejects(afterCore.login('alice', 'Fictional passphrase one'));
    await afterCore.login('alice', 'A revised fictional passphrase');
    assert.equal(afterCore.user(bob.id).admin, true);
    assert.equal(
      current.db.prepare('SELECT host FROM federation_blocked_hosts').get()!.host,
      'abusive.example',
    );
    const removal = current.db.prepare('SELECT * FROM domain_events WHERE id=?').get(removalId)!;
    assert.equal(removal.cancelled_at, null);
    assert.equal(removal.acknowledged_at, null);
    assert.equal(removal.payload, JSON.stringify({ postId: post.id }));
    assert.equal(current.db.prepare('SELECT cursor FROM federation_scan').get()!.cursor, '');
    current.close();
    await assert.rejects(restoreBackup(target, origin, first.snapshotId, options), /empty target/);
    const second = await createBackup(data, origin, options);
    assert.notEqual(second.snapshotId, first.snapshotId);
    const snapshots = JSON.parse(
      execFileSync(resticBinary, ['--json', 'snapshots'], {
        env: {
          ...process.env,
          RESTIC_REPOSITORY: options.repository,
          RESTIC_PASSWORD_FILE: options.passwordFile,
        },
        encoding: 'utf8',
      }),
    );
    assert.equal(snapshots.length, 2);
  },
);

test(
  'wrong encryption keys and wrong canonical domain fail without leaving a partial restored installation',
  { skip: !available },
  async (t) => {
    const { root, data, options } = await fixture(t);
    await initializeBackup(options, root);
    const snapshot = await createBackup(data, origin, options);
    const wrong = join(root, 'wrong-password');
    await writeFile(wrong, randomBytes(32).toString('hex'), { mode: 0o600 });
    const a = join(root, 'wrong-restic');
    await assert.rejects(
      restoreBackup(a, origin, snapshot.snapshotId, { ...options, passwordFile: wrong }),
      /Restic/,
    );
    assert.deepEqual(await readdir(a), []);
    const b = join(root, 'wrong-recovery');
    await assert.rejects(
      restoreBackup(b, origin, snapshot.snapshotId, { ...options, recoveryPasswordFile: wrong }),
      /authenticated/,
    );
    assert.deepEqual(await readdir(b), []);
    const c = join(root, 'wrong-origin');
    await assert.rejects(
      restoreBackup(c, 'https://different.example', snapshot.snapshotId, options),
      /origin/,
    );
    assert.deepEqual(await readdir(c), []);
  },
);

test(
  'backup refuses missing/tampered media and never records a successful backup timestamp',
  { skip: !available },
  async (t) => {
    const { root, data, store, archive, alice, memory, options } = await fixture(t);
    await initializeBackup(options, root);
    const path = archive.media(alice.id, memory.mediaIds[0]!)!.path;
    await writeFile(path, 'Corrupted synthetic media');
    await assert.rejects(createBackup(data, origin, options), /integrity/);
    assert.equal(store.setting('last_backup_at'), null);
  },
);

test('stale-lock removal refuses a different PID namespace even when the recorded PID is absent', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'bookface-namespace-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.instance-lock'));
  await writeFile(
    join(root, '.instance-lock', 'owner.json'),
    JSON.stringify({
      pid: 999999999,
      token: 'synthetic',
      hostname: 'different-container',
      pidNamespace: 'pid:[different]',
    }),
  );
  assert.throws(() => unlockStoppedInstance(root), /different host or PID namespace/);
});

test(
  'real restore stages inside a writable target beneath a read-only parent and releases the lock on failure',
  { skip: !available },
  async (t) => {
    const { root, data, options } = await fixture(t);
    await initializeBackup(options, root);
    const snapshot = await createBackup(data, origin, options);
    const parent = join(root, 'readonly-parent');
    const target = join(parent, 'mounted-volume');
    const failed = join(parent, 'failed-volume');
    await mkdir(target, { recursive: true, mode: 0o700 });
    await mkdir(failed, { mode: 0o700 });
    await chmod(parent, 0o555);
    try {
      if (process.getuid?.() !== 0)
        await assert.rejects(writeFile(join(parent, 'must-not-write'), 'no'), (error) =>
          ['EACCES', 'EPERM', 'EROFS'].includes((error as NodeJS.ErrnoException).code ?? ''),
        );
      const manifest = await restoreBackup(target, origin, snapshot.snapshotId, options);
      assert.equal(manifest.origin, origin);
      const restored = new Store(target);
      assert.equal(restored.setting('restore_reconciliation_required'), 'true');
      restored.close();
      assert.equal(
        (await readdir(target)).some(
          (name) => name.startsWith('.bookface-restore-') || name === '.instance-lock',
        ),
        false,
      );
      assert.deepEqual((await readdir(parent)).sort(), ['failed-volume', 'mounted-volume']);
      await assert.rejects(
        restoreBackup(failed, origin, snapshot.snapshotId, {
          ...options,
          resticBinary: join(root, 'missing-restic-binary'),
        }),
        /Could not run restic/,
      );
      assert.deepEqual(await readdir(failed), []);
      const release = acquireInstanceLock(failed, 'verify failed restore released lock');
      release();
      await assert.rejects(
        restoreBackup(target, origin, snapshot.snapshotId, options),
        /empty target/,
      );
    } finally {
      await chmod(parent, 0o700);
    }
  },
);

test(
  'real encrypted backup excludes unfinished uploads and legacy restore/reconcile release every reservation',
  { skip: !available },
  async (t) => {
    const { root, data, store, alice, bob, options } = await fixture(t);
    const uploads = new ChunkUploads(store, { maxBytes: CHUNK_BYTES * 2, minFreeBytes: 0 });
    const pending = uploads.begin(alice.id, [{ name: 'partial.json', size: CHUNK_BYTES + 1 }]);
    const bytes = Buffer.alloc(CHUNK_BYTES, 120);
    await uploads.writeChunk(
      alice.id,
      pending.id,
      0,
      0,
      bytes,
      createHash('sha256').update(bytes).digest('hex'),
    );
    uploads.begin(bob.id, [{ name: 'other.json', size: 1 }]);
    await initializeBackup(options, root);
    const receipt = await createBackup(data, origin, options);
    const raw = join(root, 'raw-chunks');
    await mkdir(raw);
    const resticEnv = {
      ...process.env,
      RESTIC_REPOSITORY: options.repository,
      RESTIC_PASSWORD_FILE: options.passwordFile,
    };
    execFileSync(resticBinary, ['restore', receipt.snapshotId, '--target', raw], {
      env: resticEnv,
      stdio: 'ignore',
    });
    const payload = join(raw, 'payload');
    const db = new DatabaseSync(join(payload, 'bookface.sqlite'));
    for (const table of ['chunk_uploads', 'chunk_upload_parts', 'chunk_upload_files'])
      assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n, 0);
    // Construct an authenticated, internally consistent older-style backup with
    // reservations but no incoming payload. This exercises restore's own defense.
    db.prepare(
      'INSERT INTO chunk_uploads(id,owner_id,files,total,expires_at,reserved_bytes) VALUES(?,?,?,?,?,?)',
    ).run(
      'legacy-upload',
      alice.id,
      JSON.stringify([{ name: 'missing.json', size: 2, offset: 1 }]),
      2,
      Date.now() + 86400000,
      16386,
    );
    db.prepare('INSERT INTO chunk_upload_parts VALUES(?,?,?,?,?)').run(
      'legacy-upload',
      0,
      0,
      1,
      'f'.repeat(64),
    );
    db.prepare('INSERT INTO chunk_upload_files VALUES(?,?,?,?,?)').run(
      'legacy-upload',
      0,
      'missing.json',
      2,
      1,
    );
    db.close();
    const manifestPath = join(payload, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const database = await readFile(join(payload, 'bookface.sqlite'));
    const item = manifest.files.find((file: { path: string }) => file.path === 'bookface.sqlite');
    item.size = database.length;
    item.sha256 = createHash('sha256').update(database).digest('hex');
    await writeFile(manifestPath, JSON.stringify(manifest));
    const output = execFileSync(
      resticBinary,
      ['backup', '--json', '--host', 'clean-bookface', '--tag', 'clean-bookface-v1', 'payload'],
      { cwd: raw, env: resticEnv, encoding: 'utf8' },
    );
    const snapshot = output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((event) => event.message_type === 'summary').snapshot_id;
    const target = join(root, 'restored-chunks');
    await restoreBackup(target, origin, snapshot, options);
    let restored = new Store(target);
    let receiving = new ChunkUploads(restored, { maxBytes: CHUNK_BYTES * 2, minFreeBytes: 0 });
    assert.equal(receiving.active(alice.id), null);
    assert.equal(receiving.active(bob.id), null);
    assert.throws(() => receiving.status(alice.id, pending.id), /unavailable/);
    assert.equal(restored.db.prepare('SELECT COUNT(*) n FROM chunk_upload_parts').get()!.n, 0);
    // Reconciliation independently removes stale session state too.
    receiving.begin(alice.id, [{ name: 'reconcile-stale.json', size: 1 }]);
    restored.close();
    const ledger = join(root, 'chunk-state.enc');
    await exportReconciliation(data, options.recoveryPasswordFile, ledger);
    await reconcileRestore(target, origin, ledger, options.recoveryPasswordFile);
    restored = new Store(target);
    try {
      receiving = new ChunkUploads(restored, { maxBytes: CHUNK_BYTES * 2, minFreeBytes: 0 });
      assert.equal(receiving.active(alice.id), null);
      for (const owner of [alice.id, bob.id, 'fictional-third', 'fictional-fourth'])
        assert.equal(receiving.begin(owner, [{ name: 'fresh.json', size: 1 }]).state, 'active');
    } finally {
      restored.close();
    }
    // Source uploads and durable partial bytes were never scrubbed by backup.
    assert.equal(uploads.status(alice.id, pending.id).files[0]!.offset, CHUNK_BYTES);
  },
);
