import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { Archive } from '../src/archive.js';
import { Core } from '../src/core.js';
import { Store } from '../src/storage.js';

const password = 'a fictional archive race test password';
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'bookface-archive-race-'));
  const store = new Store(join(root, 'data'));
  const core = new Core(store, { origin: 'https://circle.example' });
  const archive = new Archive(store);
  t.after(async () => {
    await archive.stopWorker();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const admin = await core.setup({ username: 'alice', displayName: 'Alice Example', password });
  const { user } = await core.register({
    username: 'bob',
    displayName: 'Bob Example',
    password,
    inviteToken: core.createInvite(admin.user.id, 'registration').token,
  });
  const input = join(root, 'input');
  await mkdir(input);
  const photo = join(input, 'photo.jpg');
  await sharp({ create: { width: 24, height: 16, channels: 3, background: '#406590' } })
    .jpeg()
    .toFile(photo);
  const record = (body = 'An ordinary afternoon') => [
    {
      id: 'memory',
      data: [{ post: body }],
      attachments: [{ data: [{ media: { uri: 'photo.jpg' } }] }],
    },
  ];
  await writeFile(join(input, 'posts.json'), JSON.stringify(record()));
  const importMemory = async () => {
    await archive.importDirectory(user.id, input);
    return archive.list(user.id)[0]!;
  };
  return {
    root,
    store,
    core,
    archive,
    admin: admin.user,
    user,
    input,
    photo,
    record,
    importMemory,
  };
}

// Pause a real Sharp operation after native processing, before its awaited result is delivered.
// This deterministically exposes the commit gap without replacing image validation or using sleeps.
function pauseSharp(t: test.TestContext, method: 'toFile' | 'toBuffer') {
  const reached = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const original = sharp.prototype[method];
  let held = false;
  t.mock.method(sharp.prototype, method, async function (this: sharp.Sharp, ...args: unknown[]) {
    const result = await Reflect.apply(original, this, args);
    if (!held) {
      held = true;
      reached.resolve();
      await resume.promise;
    }
    return result;
  });
  t.after(() => resume.resolve());
  return { reached: reached.promise, resume: () => resume.resolve() };
}
function mediaCount(store: Store, owner: string, purpose?: string): number {
  return Number(
    store.db
      .prepare(
        `SELECT count(*) AS n FROM archive_media WHERE owner_id=?${purpose ? ' AND purpose=?' : ''}`,
      )
      .get(...(purpose ? [owner, purpose] : [owner]))!.n,
  );
}

test(
  'account deletion completed during shared image processing cannot restore a media row or file',
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t);
    const item = await f.importMemory();
    const gate = pauseSharp(t, 'toFile');
    const preparing = f.archive.shareCopy(f.user.id, item.id);
    const rejected = assert.rejects(preparing, /Account.*deleted|Account.*no longer/);
    await gate.reached;
    f.core.deleteAccount(f.user.id);
    // A separate Archive instance proves durable owner state, not just a local cancellation flag.
    await new Archive(f.store).deleteOwner(f.user.id);
    f.core.completeAccountDeletion(f.user.id);
    assert.deepEqual(f.core.pendingAccountDeletions(), []);
    gate.resume();
    await rejected;
    assert.equal(mediaCount(f.store, f.user.id), 0);
    assert.equal(f.archive.count(f.user.id), 0);
    assert.deepEqual(await readdir(f.archive.mediaDir), []);
  },
);

test(
  'native photo ingestion rejects account deletion during pixel decoding and removes its output',
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t);
    const gate = pauseSharp(t, 'toBuffer');
    const uploading = f.archive.uploadPhoto(f.user.id, f.photo);
    const rejected = assert.rejects(uploading, /Account.*deleted|Account.*no longer/);
    await gate.reached;
    f.core.deleteAccount(f.user.id);
    await f.archive.deleteOwner(f.user.id);
    f.core.completeAccountDeletion(f.user.id);
    gate.resume();
    await rejected;
    assert.equal(mediaCount(f.store, f.user.id), 0);
    assert.equal(f.archive.count(f.user.id), 0);
    assert.deepEqual(await readdir(f.archive.mediaDir), []);
  },
);

test(
  'deleting the original during derivative processing rejects the derivative and cleans its file',
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t);
    const item = await f.importMemory();
    const gate = pauseSharp(t, 'toFile');
    const preparing = f.archive.makeSharedMedia(f.user.id, item.mediaIds[0]!);
    const rejected = assert.rejects(preparing, /Photo changed or was deleted/);
    await gate.reached;
    assert.equal(f.archive.deleteItem(f.user.id, item.id), true);
    gate.resume();
    await rejected;
    assert.equal(mediaCount(f.store, f.user.id), 0);
    assert.deepEqual(await readdir(f.archive.mediaDir), []);
  },
);

test(
  'reimporting a revised memory while its derivative runs rejects the stale share copy',
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t);
    const item = await f.importMemory();
    const gate = pauseSharp(t, 'toFile');
    const preparing = f.archive.shareCopy(f.user.id, item.id);
    const rejected = assert.rejects(preparing, /Memory changed or was deleted/);
    await gate.reached;
    await writeFile(join(f.input, 'posts.json'), JSON.stringify(f.record('A revised memory')));
    const report = await f.archive.importDirectory(f.user.id, f.input);
    assert.equal(report.revised, 1);
    gate.resume();
    await rejected;
    assert.equal(f.archive.get(f.user.id, item.id)?.body, 'A revised memory');
    assert.equal(mediaCount(f.store, f.user.id, 'shared'), 0);
    assert.equal((await readdir(f.archive.mediaDir)).length, 1);
  },
);

for (const operation of ['native', 'share'] as const) {
  test(
    `${operation} commit revalidates the current session after asynchronous image work`,
    { timeout: 15_000 },
    async (t) => {
      const f = await fixture(t);
      const item = operation === 'share' ? await f.importMemory() : undefined;
      const session = await f.core.login('bob', password);
      const authorize = () => {
        if (!f.core.session(session.token)) throw new Error('Session revoked');
      };
      const gate = pauseSharp(t, operation === 'share' ? 'toFile' : 'toBuffer');
      const preparing = item
        ? f.archive.shareCopy(f.user.id, item.id, undefined, authorize)
        : f.archive.uploadPhoto(f.user.id, f.photo, authorize);
      const rejected = assert.rejects(preparing, /Session revoked/);
      await gate.reached;
      f.core.logout(session.token);
      assert.equal(f.core.user(f.user.id).id, f.user.id);
      gate.resume();
      await rejected;
      assert.equal(mediaCount(f.store, f.user.id, 'shared'), 0);
      assert.equal(mediaCount(f.store, f.user.id), operation === 'share' ? 1 : 0);
      assert.equal((await readdir(f.archive.mediaDir)).length, operation === 'share' ? 1 : 0);
    },
  );
}

test(
  'suspension during image processing rejects the derivative without needing a caller callback',
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t);
    const item = await f.importMemory();
    const gate = pauseSharp(t, 'toFile');
    const preparing = f.archive.shareCopy(f.user.id, item.id);
    const rejected = assert.rejects(preparing, /Account.*no longer/);
    await gate.reached;
    f.core.suspend(f.admin.id, f.user.id);
    gate.resume();
    await rejected;
    assert.equal(mediaCount(f.store, f.user.id, 'shared'), 0);
    assert.equal((await readdir(f.archive.mediaDir)).length, 1);
  },
);

test('cached derivatives still require current authorization and cannot extend their lifetime on rejection', async (t) => {
  const f = await fixture(t);
  const item = await f.importMemory();
  const first = await f.archive.shareCopy(f.user.id, item.id);
  const shared = first.media[0]!;
  f.store.db.prepare('UPDATE archive_media SET created_at=1 WHERE id=?').run(shared.id);
  await assert.rejects(
    f.archive.makeSharedMedia(f.user.id, item.mediaIds[0]!, () => {
      throw new Error('Session revoked');
    }),
    /Session revoked/,
  );
  assert.equal(
    f.store.db.prepare('SELECT created_at FROM archive_media WHERE id=?').get(shared.id)!
      .created_at,
    1,
  );
  const next = await f.archive.shareCopy(f.user.id, item.id);
  assert.equal(next.media[0]!.id, shared.id);
  assert.equal(mediaCount(f.store, f.user.id), 2);
});
