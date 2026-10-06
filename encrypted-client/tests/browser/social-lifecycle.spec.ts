import { test, expect, type Page, type Locator } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { exportArchives, type MemoryRecord } from '../../src/archive';

test.use({ actionTimeout: 20000 });
const runtime = process.env.CBF_TEST_SOCIAL_RUNTIME;
test.skip(!runtime, 'Requires disposable social-lifecycle host.');
const state = runtime
  ? JSON.parse(readFileSync(join(runtime, 'state.json'), 'utf8'))
  : { mode: 'local' };
if (state.mode !== 'local')
  throw new Error('Browser qualification requires a disposable local host.');
const accounts = JSON.parse(
  runtime ? readFileSync(join(runtime, 'fictional-credentials.json'), 'utf8') : '[]',
) as {
  username: string;
  password: string;
  userId: string;
}[];
const kitFile =
  process.env.CBF_TEST_RECOVERY_KITS ||
  join(runtime || '/tmp', 'social-browser-recovery-keys.json');
let kits: Record<string, string> = {};
try {
  kits = JSON.parse(readFileSync(kitFile, 'utf8'));
} catch {
  /* First disposable test run. */
}
async function visibleOrError(page: Page, target: Locator, timeout = 65_000): Promise<void> {
  await Promise.race([
    target.waitFor({ state: 'visible', timeout }),
    page
      .locator('#notice.error')
      .waitFor({ state: 'visible', timeout })
      .then(async () => {
        throw new Error((await page.locator('#notice').textContent()) || 'Browser action failed');
      }),
  ]);
}
async function enter(page: Page, username: string): Promise<void> {
  const account = accounts.find((a) => a.username === username)!;
  const callingRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/voip/turnServer')) callingRequests.push(request.url());
  });
  await page.goto('/');
  await page.getByLabel('Your home’s address').fill(state.url);
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await visibleOrError(page, page.getByRole('heading', { name: /Keep a spare key|Welcome back/ }));
  if (await page.getByRole('button', { name: 'Make my recovery kit' }).isVisible()) {
    await page.getByRole('button', { name: 'Make my recovery kit' }).click();
    const key = await page.getByLabel('Your recovery key', { exact: true }).inputValue();
    kits[username] = key;
    writeFileSync(kitFile, JSON.stringify(kits), { mode: 0o600 });
    await page.getByLabel('Type the last 6 characters').fill(key.replace(/\s/g, '').slice(-6));
    await page.getByRole('button', { name: 'I saved it. Open my book.' }).click();
  } else {
    if (!kits[username])
      throw new Error(
        'Fictional account already has recovery configured but its test kit is missing. Use a fresh disposable host.',
      );
    await page.getByLabel('Recovery key', { exact: true }).fill(kits[username]);
    await page.getByRole('button', { name: 'Open my memories', exact: true }).click();
  }
  await visibleOrError(page, page.getByRole('heading', { name: 'What’s on your mind?' }));
  expect(callingRequests).toEqual([]);
}

async function idle(page: Page) {
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false', { timeout: 65000 });
}
test('encrypted conversations, durable retries, selected reports, blocking and account closure', async ({
  browser,
}) => {
  test.setTimeout(240000);
  const ca = await browser.newContext(),
    cb = await browser.newContext(),
    cm = await browser.newContext();
  const a = await ca.newPage(),
    b = await cb.newPage(),
    m = await cm.newPage();
  const reloadAccountTypes: string[][] = [];
  b.on('response', async (response) => {
    if (
      response.url().startsWith(state.url) &&
      response.url().includes('/sync?') &&
      response.ok()
    ) {
      const json = await response.json().catch(() => ({}));
      reloadAccountTypes.push(
        (json.account_data?.events || []).map((e: { type: string }) => e.type),
      );
    }
  });
  try {
    await enter(a, 'alice');
    await enter(b, 'bob');
    await enter(m, 'mallory');
    await a.getByRole('button', { name: 'Friends', exact: true }).click();
    await a
      .getByLabel('Friend’s account name')
      .fill(accounts.find((u) => u.username === 'bob')!.userId);
    await a.getByRole('button', { name: 'Add friend', exact: true }).click();
    await expect(
      a.getByRole('button', { name: 'Check identity', exact: true }).first(),
    ).toBeVisible({
      timeout: 30_000,
    });
    await b.getByRole('button', { name: 'Friends', exact: true }).click();
    await b.getByRole('button', { name: 'Check for invitations', exact: true }).click();
    const accept = b.getByRole('button', { name: 'Accept friend invitation', exact: true });
    if (await accept.isVisible()) await accept.click();
    await expect(
      b.getByRole('button', { name: 'Check identity', exact: true }).first(),
    ).toBeVisible({
      timeout: 30_000,
    });
    await a.getByRole('button', { name: 'Check identity', exact: true }).first().click();
    await expect(b.getByRole('button', { name: 'Accept identity check', exact: true })).toBeVisible(
      {
        timeout: 30_000,
      },
    );
    await b.getByRole('button', { name: 'Accept identity check', exact: true }).click();
    await expect(a.getByRole('button', { name: 'Show comparison', exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await a.getByRole('button', { name: 'Show comparison', exact: true }).click();
    await expect(a.getByRole('button', { name: 'They match', exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(b.getByRole('button', { name: 'They match', exact: true })).toBeVisible({
      timeout: 20_000,
    });
    expect(await a.locator('.sas').innerText()).toBe(await b.locator('.sas').innerText());
    await a.getByRole('button', { name: 'They match', exact: true }).click();
    await b.getByRole('button', { name: 'They match', exact: true }).click();
    await expect(a.locator('#verification')).toBeEmpty({ timeout: 20_000 });
    await expect(b.locator('#verification')).toBeEmpty({ timeout: 20_000 });

    const photoMarker = `SOCIAL_PHOTO_${Date.now()}`;
    const photoBytes = await sharp({
      create: { width: 12, height: 8, channels: 3, background: '#3b5998' },
    })
      .png()
      .toBuffer();
    const photo: MemoryRecord = {
      id: photoMarker,
      kind: 'photo',
      timestamp: 1000,
      text: photoMarker,
      title: 'A fictional photograph',
      sourcePath: '',
      privateOnly: false,
      attachments: [
        {
          path: 'fictional.png',
          mimeType: 'image/png',
          bytes: new Blob([new Uint8Array(photoBytes)]),
        },
      ],
    };
    const zip = await exportArchives([photo]);
    await a.getByRole('button', { name: 'My memories', exact: true }).click();
    await a.getByLabel('Choose archive ZIP files').setInputFiles({
      name: 'fictional.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(await zip.arrayBuffer()),
    });
    await a.getByRole('button', { name: 'Bring in my memories', exact: true }).click();
    await idle(a);
    const photoCard = a
      .locator('article')
      .filter({ has: a.locator('.post-body').filter({ hasText: photoMarker }) });
    await photoCard.getByText('Share this memory', { exact: true }).click();
    await photoCard
      .getByRole('checkbox', {
        name: accounts.find((x) => x.username === 'bob')!.userId,
        exact: true,
      })
      .check();
    await photoCard.getByRole('button', { name: 'Share selected copy', exact: true }).click();
    await idle(a);
    await b.getByRole('button', { name: 'News feed', exact: true }).click();
    await b.getByRole('button', { name: 'Refresh my book', exact: true }).click();
    await idle(b);
    await expect
      .poll(() =>
        b
          .locator('article')
          .filter({ has: b.locator('.post-body').filter({ hasText: photoMarker }) })
          .locator('img')
          .evaluate((img: HTMLImageElement) => img.naturalWidth),
      )
      .toBe(12);
    const shared = `SOCIAL_TEXT_${Date.now()}`,
      comment = `SOCIAL_COMMENT_${Date.now()}`;
    const bodies: string[] = [];
    let sharedRoomId = '';
    for (const page of [a, b])
      page.on('request', (request) => {
        if (request.url().startsWith(state.url) && /\/(send|upload)\//.test(request.url())) {
          bodies.push(request.postData() || '');
          const match = new URL(request.url()).pathname.match(/\/rooms\/([^/]+)\/send\//);
          if (match) sharedRoomId = decodeURIComponent(match[1]);
        }
      });
    await a.getByRole('button', { name: 'News feed', exact: true }).click();
    await a.getByLabel('Write a post').fill(shared);
    await a
      .getByRole('checkbox', {
        name: accounts.find((x) => x.username === 'bob')!.userId,
        exact: true,
      })
      .check();
    await a.getByRole('button', { name: 'Share with selected friends', exact: true }).click();
    await idle(a);
    await b.getByRole('button', { name: 'News feed', exact: true }).click();
    await b.getByRole('button', { name: 'Refresh my book', exact: true }).click();
    await idle(b);
    const post = (page: Page) =>
      page
        .locator('article')
        .filter({ has: page.locator('.post-body').filter({ hasText: shared }) });
    await expect(post(b)).toBeVisible();
    // Deny one encrypted send at the transport boundary, then reload the durable outbox.
    await b.route('**/send/m.room.encrypted/**', (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ errcode: 'M_FORBIDDEN', error: 'Synthetic denied send' }),
      }),
    );
    await post(b).getByLabel('Write a comment').fill(comment);
    await post(b).getByRole('button', { name: 'Send comment', exact: true }).click();
    await idle(b);
    await expect(b.locator('#notice.error')).toBeVisible();
    await b.unroute('**/send/m.room.encrypted/**');
    await b.reload();
    await expect(b.getByRole('heading', { name: 'What’s on your mind?' })).toBeVisible({
      timeout: 65000,
    });
    await idle(b);
    await b.getByRole('button', { name: 'Finish this conversation change', exact: true }).click();
    await idle(b);
    await expect(post(b).locator('.comment').filter({ hasText: comment })).toHaveCount(1);
    await a.getByRole('button', { name: 'Refresh my book', exact: true }).click();
    await idle(a);
    await expect(post(a).locator('.comment').filter({ hasText: comment })).toHaveCount(1);
    await post(b).getByLabel('Your reaction').selectOption('♥');
    await post(b).getByRole('button', { name: 'Save reaction', exact: true }).click();
    await idle(b);
    await expect(
      post(b).getByText('♥ ' + accounts.find((x) => x.username === 'bob')!.userId, { exact: true }),
    ).toBeVisible();
    await post(b).getByRole('button', { name: 'Remove my comment', exact: true }).click();
    await idle(b);
    await expect(post(b).locator('.comment')).toHaveCount(0);
    const selected = 'SELECTED_REPORT_ONLY';
    const reportBodies: string[] = [];
    b.on('request', (request) => {
      if (request.url().includes('/report/')) reportBodies.push(request.postData() || '');
    });
    await post(b).getByText('Report this post', { exact: true }).click();
    await post(b).getByLabel('What happened?').fill('A synthetic report');
    await post(b).getByLabel('Text to include in report').fill(selected);
    await post(b)
      .getByRole('button', { name: 'Send selected evidence to my host', exact: true })
      .click();
    await idle(b);
    expect(reportBodies).toHaveLength(1);
    expect(reportBodies[0]).toContain(selected);
    expect(reportBodies[0]).not.toContain(shared);
    expect(reportBodies[0]).not.toContain(comment);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).not.toContain(shared);
      expect(body).not.toContain(comment);
    }
    await m.getByRole('button', { name: 'Refresh my book', exact: true }).click();
    await idle(m);
    await expect(m.locator('.post-body').filter({ hasText: shared })).toHaveCount(0);
    expect(sharedRoomId).not.toBe('');
    const denied = await m.evaluate(
      async ({ home, room }) => {
        const session = JSON.parse(localStorage.getItem('clean-bookface.session.v1')!);
        const response = await fetch(
          home + '/_matrix/client/v3/rooms/' + encodeURIComponent(room) + '/messages?dir=b&limit=1',
          { headers: { Authorization: 'Bearer ' + session.accessToken } },
        );
        return { status: response.status, code: (await response.json()).errcode };
      },
      { home: state.url, room: sharedRoomId },
    );
    expect(denied).toEqual({ status: 403, code: 'M_FORBIDDEN' });

    await post(a).getByRole('button', { name: 'Remove this shared copy', exact: true }).click();
    await idle(a);
    await expect(post(a)).toHaveCount(0);
    await b.getByRole('button', { name: 'Refresh my book', exact: true }).click();
    await idle(b);
    await expect(post(b)).toHaveCount(0);
    await b.getByRole('button', { name: 'Friends', exact: true }).click();
    await b.getByRole('button', { name: 'Block this account', exact: true }).click();
    await idle(b);
    // Keep this exact client alive: a reload would hide an uncleared in-memory
    // revocation. A blocked account cannot be selected or invited by this user.
    const aliceId = accounts.find((x) => x.username === 'alice')!.userId;
    const bobId = accounts.find((x) => x.username === 'bob')!.userId;
    await b.getByLabel('Friend’s account name').fill(aliceId);
    await b.getByRole('button', { name: 'Add friend', exact: true }).click();
    await idle(b);
    await expect(b.locator('#notice.error')).toContainText('blocked');
    await b.getByRole('button', { name: 'News feed', exact: true }).click();
    await expect(b.getByRole('checkbox', { name: aliceId, exact: true })).toHaveCount(0);
    await b.getByRole('button', { name: 'Friends', exact: true }).click();
    await b.getByRole('button', { name: 'Unblock account', exact: true }).click();
    await idle(b);
    await a.getByRole('button', { name: 'Friends', exact: true }).click();
    await a.getByRole('button', { name: 'Check for invitations', exact: true }).click();
    await idle(a);
    await a.getByLabel('Friend’s account name').fill(bobId);
    const freshRoomResponse = a.waitForResponse(
      (response) =>
        response.url().endsWith('/createRoom') && response.request().method() === 'POST',
    );
    await a.getByRole('button', { name: 'Add friend', exact: true }).click();
    const freshRoom = await (await freshRoomResponse).json();
    expect(freshRoom.room_id).toBeTruthy();
    expect(freshRoom.room_id).not.toBe(sharedRoomId);
    await idle(a);
    await b.getByRole('button', { name: 'Check for invitations', exact: true }).click();
    await idle(b);
    await b.getByRole('button', { name: 'Accept friend invitation', exact: true }).click();
    await idle(b);
    await expect(b.locator('#notice')).toContainText('Accepted.');
    // Both device identities were actually compared above and remain verified.
    // Successful sharing proves the newly accepted room clears only revocation.
    const reconnected = `SOCIAL_RECONNECTED_${Date.now()}`;
    await b.getByRole('button', { name: 'News feed', exact: true }).click();
    await b.getByLabel('Write a post').fill(reconnected);
    await b.getByRole('checkbox', { name: aliceId, exact: true }).check();
    await b.getByRole('button', { name: 'Share with selected friends', exact: true }).click();
    await idle(b);
    await a.getByRole('button', { name: 'News feed', exact: true }).click();
    await a.getByRole('button', { name: 'Refresh my book', exact: true }).click();
    await idle(a);
    await expect(a.locator('.post-body').filter({ hasText: reconnected })).toBeVisible();
    // Preserve the existing independent persisted-block/reload acceptance.
    await b.getByRole('button', { name: 'Friends', exact: true }).click();
    await b.getByRole('button', { name: 'Block this account', exact: true }).click();
    await idle(b);
    await b.reload();
    await expect(b.getByRole('heading', { name: 'What’s on your mind?' })).toBeVisible({
      timeout: 65000,
    });
    await idle(b);
    await b.getByRole('button', { name: 'Friends', exact: true }).click();
    await expect(b.getByRole('button', { name: 'Unblock account', exact: true })).toBeVisible();
    // An otherwise unused synthetic account exercises real password UIA and deletion.
    await m.getByRole('button', { name: 'My account', exact: true }).click();
    await m.getByText('Close my account', { exact: true }).click();
    await m
      .getByLabel('Type your complete account name')
      .fill(accounts.find((x) => x.username === 'mallory')!.userId);
    await m.getByLabel('Confirm your password').fill('Wrong synthetic password');
    await m.getByRole('button', { name: 'Close this account permanently', exact: true }).click();
    await idle(m);
    await expect(m.locator('#notice.error')).toBeVisible();
    await m
      .getByLabel('Confirm your password')
      .fill(accounts.find((x) => x.username === 'mallory')!.password);
    await m.getByRole('button', { name: 'Close this account permanently', exact: true }).click();
    await expect(m.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible({
      timeout: 30000,
    });
    expect(
      await m.evaluate(
        async () =>
          (await indexedDB.databases()).filter((db) => db.name?.includes('@mallory:')).length,
      ),
    ).toBe(0);
    await m.getByLabel('Your home’s address').fill(state.url);
    await m.getByLabel('Username', { exact: true }).fill('mallory');
    await m
      .getByLabel('Password', { exact: true })
      .fill(accounts.find((x) => x.username === 'mallory')!.password);
    await m.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(m.locator('#notice.error')).toBeVisible();
    for (const page of [a, b]) {
      await page.getByRole('button', { name: 'My account', exact: true }).click();
      await page.getByRole('button', { name: 'Sign out of this browser', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible({
        timeout: 65000,
      });
    }
    const restoredContext = await browser.newContext();
    try {
      const restored = await restoredContext.newPage();
      await enter(restored, 'alice');
      await restored.getByRole('button', { name: 'My memories', exact: true }).click();
      await expect(restored.locator('.post-body').filter({ hasText: photoMarker })).toBeVisible();
      await restored.getByRole('button', { name: 'My account', exact: true }).click();
      await restored.getByRole('button', { name: 'Sign out of this browser', exact: true }).click();
      await expect(restored.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible({
        timeout: 65000,
      });
    } finally {
      await restoredContext.close();
    }
  } catch (error) {
    writeFileSync(
      join(runtime!, 'social-diagnostic.json'),
      JSON.stringify({ reloadAccountTypes, headings: await b.locator('h2').allTextContents() }),
      { mode: 0o600 },
    );
    throw error;
  } finally {
    await Promise.all([ca.close(), cb.close(), cm.close()]);
  }
});

test('an established device reload retains its existing recovery identity', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await enter(page, 'bob');
    await idle(page);
    const accountTypes: string[][] = [];
    page.on('response', async (response) => {
      if (
        response.url().startsWith(state.url) &&
        response.url().includes('/sync?') &&
        response.ok()
      ) {
        const json = await response.json().catch(() => ({}));
        accountTypes.push(
          (json.account_data?.events || []).map((event: { type: string }) => event.type),
        );
      }
    });
    await page.reload();
    await expect(
      page.getByRole('button', { name: 'Make my recovery kit', exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'What’s on your mind?' })).toBeVisible({
      timeout: 15000,
    });
    await idle(page);
    expect(accountTypes.some((types) => types.includes('m.secret_storage.default_key'))).toBe(true);
  } catch (error) {
    throw error;
  } finally {
    await context.close();
  }
});

test('a fresh invited account can close permanently and cannot sign in afterward', async ({
  page,
}) => {
  execFileSync(
    'python3',
    [
      fileURLToPath(new URL('../../../encrypted-host/host.py', import.meta.url)),
      'invite',
      '--runtime',
      runtime!,
    ],
    { stdio: 'pipe', timeout: 30000 },
  );
  const invitation = JSON.parse(readFileSync(join(runtime!, 'invitation.json'), 'utf8'));
  const username = 'closure_' + Date.now().toString(36),
    password = randomUUID();
  await page.goto('/#' + new URLSearchParams({ home: state.url, invite: invitation.token }));
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create my account', exact: true }).click();
  await page.getByRole('button', { name: 'Make my recovery kit', exact: true }).click();
  const key = await page.getByLabel('Your recovery key', { exact: true }).inputValue();
  writeFileSync(
    join(runtime!, `closure-${username}.json`),
    JSON.stringify({ username, password, key }),
    { mode: 0o600 },
  );
  await page.getByLabel('Type the last 6 characters').fill(key.replace(/\s/g, '').slice(-6));
  await page.getByRole('button', { name: 'I saved it. Open my book.', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'What’s on your mind?' })).toBeVisible({
    timeout: 65000,
  });
  await idle(page);
  const userId = await page.evaluate(
    () => JSON.parse(localStorage.getItem('clean-bookface.session.v1')!).userId,
  );
  await page.getByRole('button', { name: 'My account', exact: true }).click();
  await page.getByText('Close my account', { exact: true }).click();
  await page.getByLabel('Type your complete account name').fill(userId);
  await page.getByLabel('Confirm your password').fill(password);
  await page.getByRole('button', { name: 'Close this account permanently', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible({
    timeout: 30000,
  });
  expect(
    await page.evaluate(
      async (userId) =>
        (await indexedDB.databases()).filter((db) => db.name?.includes(userId)).length,
      userId,
    ),
  ).toBe(0);
  await page.getByLabel('Your home’s address').fill(state.url);
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('#notice.error')).toBeVisible();
});

test('account closure still clears secrets when cleanup journal persistence throws', async ({
  page,
}) => {
  execFileSync(
    'python3',
    [
      fileURLToPath(new URL('../../../encrypted-host/host.py', import.meta.url)),
      'invite',
      '--runtime',
      runtime!,
    ],
    { stdio: 'pipe', timeout: 30000 },
  );
  const invitation = JSON.parse(readFileSync(join(runtime!, 'invitation.json'), 'utf8'));
  const username = 'closure_' + Date.now().toString(36),
    password = randomUUID();
  await page.goto('/#' + new URLSearchParams({ home: state.url, invite: invitation.token }));
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create my account', exact: true }).click();
  await page.getByRole('button', { name: 'Make my recovery kit', exact: true }).click();
  const key = await page.getByLabel('Your recovery key', { exact: true }).inputValue();
  writeFileSync(
    join(runtime!, `closure-${username}.json`),
    JSON.stringify({ username, password, key }),
    { mode: 0o600 },
  );
  await page.getByLabel('Type the last 6 characters').fill(key.replace(/\s/g, '').slice(-6));
  await page.getByRole('button', { name: 'I saved it. Open my book.', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'What’s on your mind?' })).toBeVisible({
    timeout: 65000,
  });
  await idle(page);
  const userId = await page.evaluate(
    () => JSON.parse(localStorage.getItem('clean-bookface.session.v1')!).userId,
  );
  await page.getByRole('button', { name: 'My account', exact: true }).click();
  await page.getByText('Close my account', { exact: true }).click();
  await page.getByLabel('Type your complete account name').fill(userId);
  await page.getByLabel('Confirm your password').fill(password);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    (window as unknown as { restoreStorage: () => void }).restoreStorage = () => {
      Storage.prototype.setItem = original;
    };
    Storage.prototype.setItem = function (key, value) {
      if (key === 'clean-bookface.cleanup.v1')
        throw new DOMException('Synthetic full storage', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  await page.getByRole('button', { name: 'Close this account permanently', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible({
    timeout: 30000,
  });
  expect(await page.evaluate(() => localStorage.getItem('clean-bookface.session.v1'))).toBeNull();
  expect(await page.locator('.post-body').count()).toBe(0);
  expect(
    await page.evaluate(
      async () =>
        (await indexedDB.databases()).filter((db) => db.name?.startsWith('clean-bookface')).length,
    ),
  ).toBe(0);
  await page.evaluate(() => (window as unknown as { restoreStorage: () => void }).restoreStorage());
  expect(
    await page.evaluate(
      async (userId) =>
        (await indexedDB.databases()).filter((db) => db.name?.includes(userId)).length,
      userId,
    ),
  ).toBe(0);
  await page.getByLabel('Your home’s address').fill(state.url);
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('#notice.error')).toBeVisible();
});

test('capture the real encrypted feed with fictional memories', async ({ browser }) => {
  test.skip(
    !process.env.CBF_SCREENSHOT_DIRECTORY,
    'Private screenshot output must be selected explicitly.',
  );
  test.setTimeout(150000);
  const ca = await browser.newContext({ viewport: { width: 1440, height: 1050 } }),
    cb = await browser.newContext();
  try {
    const a = await ca.newPage(),
      b = await cb.newPage();
    await enter(a, 'alice');
    await enter(b, 'bob');
    await b.getByRole('button', { name: 'Friends', exact: true }).click();
    const unblock = b.getByRole('button', { name: 'Unblock account', exact: true });
    if (await unblock.isVisible()) {
      await unblock.click();
      await idle(b);
    }
    await a.getByRole('button', { name: 'Friends', exact: true }).click();
    await a
      .getByLabel('Friend’s account name')
      .fill(accounts.find((u) => u.username === 'bob')!.userId);
    await a.getByRole('button', { name: 'Add friend', exact: true }).click();
    await expect(
      a.getByRole('button', { name: 'Check identity', exact: true }).first(),
    ).toBeVisible({
      timeout: 30_000,
    });
    await b.getByRole('button', { name: 'Friends', exact: true }).click();
    await b.getByRole('button', { name: 'Check for invitations', exact: true }).click();
    const accept = b.getByRole('button', { name: 'Accept friend invitation', exact: true });
    if (await accept.isVisible()) await accept.click();
    await expect(
      b.getByRole('button', { name: 'Check identity', exact: true }).first(),
    ).toBeVisible({
      timeout: 30_000,
    });
    await a.getByRole('button', { name: 'Check identity', exact: true }).first().click();
    await expect(b.getByRole('button', { name: 'Accept identity check', exact: true })).toBeVisible(
      {
        timeout: 30_000,
      },
    );
    await b.getByRole('button', { name: 'Accept identity check', exact: true }).click();
    await expect(a.getByRole('button', { name: 'Show comparison', exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await a.getByRole('button', { name: 'Show comparison', exact: true }).click();
    await expect(a.getByRole('button', { name: 'They match', exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(b.getByRole('button', { name: 'They match', exact: true })).toBeVisible({
      timeout: 20_000,
    });
    expect(await a.locator('.sas').innerText()).toBe(await b.locator('.sas').innerText());
    await a.getByRole('button', { name: 'They match', exact: true }).click();
    await b.getByRole('button', { name: 'They match', exact: true }).click();
    await expect(a.locator('#verification')).toBeEmpty({ timeout: 20_000 });
    await expect(b.locator('#verification')).toBeEmpty({ timeout: 20_000 });

    await b.getByRole('button', { name: 'News feed', exact: true }).click();
    const priorLunch = b.locator('article').filter({
      has: b.getByText(
        'Sunday lunch at ours? Nothing fancy. Bring yourself, and a story from the week.',
        { exact: true },
      ),
    });
    while (await priorLunch.count()) {
      await priorLunch
        .first()
        .getByRole('button', { name: 'Remove this shared copy', exact: true })
        .click();
      await idle(b);
    }
    const record: MemoryRecord = {
      id: 'fictional-summer-picture',
      kind: 'photo',
      timestamp: 1374955200000,
      title: 'Saturday by the lake',
      text: 'Found our old summer album. Same friends, slightly different haircuts. Shall we do this again?',
      sourcePath: '',
      privateOnly: false,
      attachments: [
        {
          path: 'summer.png',
          mimeType: 'image/png',
          bytes: new Blob([
            new Uint8Array(
              readFileSync(new URL('../../../public/assets/our-memories.png', import.meta.url)),
            ),
          ]),
        },
      ],
    };
    const zip = await exportArchives([record]);
    await a.getByRole('button', { name: 'My memories', exact: true }).click();
    await a.getByLabel('Choose archive ZIP files').setInputFiles({
      name: 'fictional-summer.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(await zip.arrayBuffer()),
    });
    await a.getByRole('button', { name: 'Bring in my memories', exact: true }).click();
    await idle(a);
    const photo = a.locator('article').filter({ has: a.getByText(record.text, { exact: true }) });
    await photo.getByText('Share this memory', { exact: true }).click();
    await photo
      .getByRole('checkbox', {
        name: accounts.find((x) => x.username === 'bob')!.userId,
        exact: true,
      })
      .check();
    await photo.getByRole('button', { name: 'Share selected copy', exact: true }).click();
    await idle(a);
    await b.getByRole('button', { name: 'News feed', exact: true }).click();
    const message =
      'Sunday lunch at ours? Nothing fancy. Bring yourself, and a story from the week.';
    await b.getByLabel('Write a post').fill(message);
    await b
      .getByRole('checkbox', {
        name: accounts.find((x) => x.username === 'alice')!.userId,
        exact: true,
      })
      .check();
    await b.getByRole('button', { name: 'Share with selected friends', exact: true }).click();
    await idle(b);
    await a.getByRole('button', { name: 'News feed', exact: true }).click();
    await a.getByRole('button', { name: 'Refresh my book', exact: true }).click();
    await idle(a);
    const lunch = a.locator('article').filter({ has: a.getByText(message, { exact: true }) });
    await lunch.getByLabel('Write a comment').fill('I’ll bring dessert. Looking forward to it!');
    await lunch.getByRole('button', { name: 'Send comment', exact: true }).click();
    await idle(a);
    await lunch.getByLabel('Your reaction').selectOption('♥');
    await lunch.getByRole('button', { name: 'Save reaction', exact: true }).click();
    await idle(a);
    await expect(a.locator('#verification')).toBeEmpty();
    const directory = process.env.CBF_SCREENSHOT_DIRECTORY!;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    await a.getByRole('button', { name: 'Dismiss this notice', exact: true }).click();
    await a.screenshot({ path: join(directory, 'encrypted-feed-desktop.png'), fullPage: true });
    await a.setViewportSize({ width: 390, height: 844 });
    for (const name of ['News feed', 'My memories', 'Friends', 'My account']) {
      const box = await a
        .getByRole('navigation', { name: 'Your book' })
        .getByRole('button', { name, exact: true })
        .boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    }
    const visibleComment = a.getByText('I’ll bring dessert. Looking forward to it!', {
      exact: true,
    });
    await visibleComment.scrollIntoViewIfNeeded();
    expect(
      await visibleComment.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + 10, box.y + box.height / 2);
        return !!hit && (el === hit || el.contains(hit));
      }),
    ).toBe(true);
    await a.evaluate(() => window.scrollTo(0, 0));

    await a.screenshot({ path: join(directory, 'encrypted-feed-mobile.png'), fullPage: true });
    for (const page of [a, b]) {
      await page.getByRole('button', { name: 'My account', exact: true }).click();
      await page.getByRole('button', { name: 'Sign out of this browser', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible({
        timeout: 65000,
      });
    }
  } finally {
    await ca.close();
    await cb.close();
  }
});
