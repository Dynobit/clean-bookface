import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../src/app.js';
import { readConfig } from '../src/config.js';

const origin = 'https://completion.example';
const password = 'synthetic completion password';
async function fixture(t: test.TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'bookface-auth-completion-'));
  const runtime = createApplication(
    readConfig({ NODE_ENV: 'production', APP_ORIGIN: origin, DATA_DIR: dataDir }),
    { startWorkers: false },
  );
  t.after(async () => {
    await runtime.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const post = (path: string, fields: Record<string, unknown>, token = '', form = false) =>
    runtime.app.request(origin + path, {
      method: 'POST',
      headers: {
        origin,
        accept: 'application/json',
        'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json',
        cookie: `__Host-bookface=${token}`,
      },
      body: form
        ? new URLSearchParams(fields as Record<string, string>).toString()
        : JSON.stringify(fields),
    });
  const poison = async (username: string) => {
    // Prospective usernames now use the shared unknown-account bucket. Seed the
    // exact future account bucket to exercise completion during a real lockout.
    for (let i = 0; i < 10; i++) runtime.core.rate(`login:${username}`, 10, 15 * 60_000);
    assert.throws(() => runtime.core.rate(`login:${username}`, 10, 15 * 60_000), { status: 429 });
  };
  const completed = async (response: Response) => {
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    const token = response.headers.get('set-cookie')?.match(/__Host-bookface=([^;]+)/)?.[1];
    assert.ok(token);
    assert.ok(runtime.core.session(token));
    assert.equal(body.token, undefined);
    assert.equal(body.session, undefined);
    assert.equal(JSON.stringify(body).includes(token), false);
    assert.equal(body.recoveryCodes.length, 8);
    const stored = runtime.store.db
      .prepare('SELECT hash FROM sessions WHERE hash=?')
      .get(createHash('sha256').update(token).digest('hex'));
    assert.ok(stored);
    return { ...body, token };
  };
  return { ...runtime, post, poison, completed };
}

test('setup and registration finish with a session and usable codes despite poisoned login buckets', async (t) => {
  const f = await fixture(t);
  await f.poison('owner');
  const owner = await f.completed(
    await f.post('/actions/setup', {
      username: 'owner',
      displayName: 'Owner',
      password,
      acceptRules: true,
      setupToken: (await readFile(f.setupPath, 'utf8')).trim(),
    }),
  );
  await assert.rejects(f.core.login('owner', password), { status: 429 });
  const recovered = await f.core.recover('owner', owner.recoveryCodes[0], password);
  assert.equal(recovered.user.id, owner.user.id);
  const invite = f.core.createInvite(owner.user.id, 'registration');
  await f.poison('member');
  const member = await f.completed(
    await f.post('/actions/register', {
      username: 'member',
      displayName: 'Member',
      password,
      acceptRules: true,
      inviteToken: invite.token,
    }),
  );
  assert.equal(
    (await f.core.recover('member', member.recoveryCodes[0], password)).user.id,
    member.user.id,
  );
  await assert.rejects(f.core.login('member', password), { status: 429 });
});

for (const action of ['recover', 'password'])
  test(`${action} atomically replaces sessions and returns usable recovery codes despite login lockout`, async (t) => {
    const f = await fixture(t);
    const owner = await f.core.setup({ username: 'owner', displayName: 'Owner', password });
    const old = await f.core.login('owner', password);
    // Account for the successful login already consumed by the bucket.
    for (let i = 0; i < 9; i++)
      await assert.rejects(f.core.login('owner', 'wrong'), { status: 401 });
    const nextPassword = password + ' changed';
    const fields =
      action === 'recover'
        ? { username: 'owner', code: owner.recoveryCodes[0], password: nextPassword }
        : { csrf: old.csrf, currentPassword: password, newPassword: nextPassword };
    const result = await f.completed(await f.post('/actions/' + action, fields, old.token));
    assert.equal(f.core.session(old.token), null);
    await assert.rejects(f.core.recover('owner', owner.recoveryCodes[1], password), {
      status: 401,
    });
    await assert.rejects(f.core.login('owner', nextPassword), { status: 429 });
    await f.core.recover('owner', result.recoveryCodes[0], password);
    assert.equal(f.core.session(result.token), null);
  });

test('session insertion failure rolls back password and recovery code rotation', async (t) => {
  const f = await fixture(t);
  const owner = await f.core.setup({ username: 'owner', displayName: 'Owner', password });
  const old = await f.core.login('owner', password);
  f.store.db.exec(
    "CREATE TRIGGER fail_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'synthetic session failure'); END",
  );
  await assert.rejects(
    f.core.changePassword(owner.user.id, password, password + ' changed', undefined, true),
    /synthetic session failure/,
  );
  assert.ok(f.core.session(old.token));
  f.store.db.exec('DROP TRIGGER fail_session');
  assert.ok(await f.core.login('owner', password));
  assert.ok(await f.core.recover('owner', owner.recoveryCodes[0], password));
});

test('resolved appeals cannot undo a later suspension and reinstatement preserves sessions', async (t) => {
  const f = await fixture(t);
  const owner = await f.core.setup({ username: 'owner', displayName: 'Owner', password });
  const invite = f.core.createInvite(owner.user.id, 'registration');
  const member = await f.core.register({
    username: 'member',
    displayName: 'Member',
    password,
    inviteToken: invite.token,
  });
  f.core.suspend(owner.user.id, member.user.id);
  const appeal = f.core.appeal(member.user.id, 'Please review this suspension.');
  const session = await f.core.login('member', password);
  f.core.resolveAppeal(owner.user.id, appeal, true, 'Accepted after review.');
  assert.ok(f.core.session(session.token));
  f.core.suspend(owner.user.id, member.user.id);
  assert.throws(() => f.core.resolveAppeal(owner.user.id, appeal, true, 'Replayed decision.'), {
    status: 409,
  });
  assert.equal(f.core.user(member.user.id).suspended, true);
  const restricted = await f.core.login('member', password);
  f.core.suspend(owner.user.id, member.user.id, false);
  assert.ok(f.core.session(restricted.token));
});

test('JSON and form settings honor explicit false values across all preferences', async (t) => {
  const f = await fixture(t);
  const owner = await f.core.setup({ username: 'owner', displayName: 'Owner', password });
  const session = await f.core.login('owner', password);
  for (const form of [false, true]) {
    for (const [value, expected] of [
      [true, true],
      ['true', true],
      ['on', true],
      ['1', true],
      [false, false],
      ['false', false],
      ['off', false],
      ['0', false],
      [undefined, false],
    ] as const) {
      const fields: Record<string, unknown> = { csrf: session.csrf, displayName: 'Owner', bio: '' };
      if (value !== undefined)
        for (const name of ['discoverable', 'quietNotifications', 'compactFeed'])
          fields[name] = form ? String(value) : value;
      const response = await f.post('/actions/settings', fields, session.token, form);
      assert.equal(response.status, 200);
      const user = f.core.user(owner.user.id);
      assert.equal(user.discoverable, expected);
      assert.equal(user.quietNotifications, expected);
      assert.equal(user.compactFeed, expected);
    }
  }
});

test('setup and registration require affirmative house-rule acceptance without consuming invitations', async (t) => {
  const f = await fixture(t);
  const setupToken = (await readFile(f.setupPath, 'utf8')).trim();
  const account = { username: 'owner', displayName: 'Owner', password, setupToken };
  for (const acceptRules of [false, 'false', 'off', '0', undefined]) {
    assert.equal((await f.post('/actions/setup', { ...account, acceptRules })).status, 400);
    assert.equal(f.core.isSetup(), false);
  }
  const owner = await f.completed(
    await f.post('/actions/setup', { ...account, acceptRules: true }),
  );
  const invite = f.core.createInvite(owner.user.id, 'registration');
  const member = { username: 'member', displayName: 'Member', password, inviteToken: invite.token };
  for (const acceptRules of [false, 'false', 'off', '0', undefined]) {
    assert.equal((await f.post('/actions/register', { ...member, acceptRules })).status, 400);
    assert.equal(
      f.store.db.prepare('SELECT 1 FROM users WHERE username=?').get('member'),
      undefined,
    );
    assert.equal(
      f.store.db.prepare('SELECT consumed_at FROM invitations WHERE id=?').get(invite.id)
        ?.consumed_at,
      null,
    );
  }
  await f.completed(await f.post('/actions/register', { ...member, acceptRules: 'on' }, '', true));
});
