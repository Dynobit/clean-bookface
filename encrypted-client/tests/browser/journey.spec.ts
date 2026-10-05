import { test, expect, type Page, type Locator } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { importArchives, exportArchives, type MemoryRecord } from '../../src/archive';

const runtime = process.env.CBF_TEST_HOST_RUNTIME;
if (!runtime)
  throw new Error(
    'Set CBF_TEST_HOST_RUNTIME to the disposable encrypted-host runtime. Never use a real member installation.',
  );
const state = JSON.parse(readFileSync(join(runtime, 'state.json'), 'utf8'));
if (state.mode !== 'local')
  throw new Error('Browser qualification requires a disposable local host.');
const accounts = JSON.parse(readFileSync(join(runtime, 'fictional-credentials.json'), 'utf8')) as {
  username: string;
  password: string;
  userId: string;
}[];
const kitFile = process.env.CBF_TEST_RECOVERY_KITS || join(runtime, 'browser-recovery-keys.json');
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
}
test('recovery setup and a clean browser reopen the same account', async ({ browser }) => {
  const first = await browser.newContext();
  const a = await first.newPage();
  await enter(a, 'alice');
  await expect(a.getByRole('button', { name: 'My memories', exact: true })).toBeVisible();
  await first.close();
  const recovered = await browser.newContext();
  const b = await recovered.newPage();
  await enter(b, 'alice');
  await expect(b.getByRole('heading', { name: 'News feed', exact: true })).toBeVisible();
  await recovered.close();
});

test('private import survives recovery and verified friends can share', async ({ browser }) => {
  test.setTimeout(180_000);
  const ca = await browser.newContext(),
    cb = await browser.newContext();
  const a = await ca.newPage(),
    b = await cb.newPage();
  await enter(a, 'alice');
  await enter(b, 'bob');
  const marker = `SYNTHETIC_PRIVATE_MEMORY_${Date.now()}`;
  const record: MemoryRecord = {
    id: marker,
    kind: 'post',
    timestamp: 1234567890000,
    text: marker,
    title: 'A fictional afternoon',
    sourcePath: 'your_posts_1.json',
    privateOnly: false,
    attachments: [],
    provenance: { fictional: true },
  };
  const zip = await exportArchives([record]);
  await a.getByRole('button', { name: 'My memories', exact: true }).click();
  await a.getByLabel('Choose archive ZIP files').setInputFiles({
    name: 'synthetic-memory.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(await zip.arrayBuffer()),
  });
  await a.getByRole('button', { name: 'Bring in my memories', exact: true }).click();
  await visibleOrError(a, a.locator('.post-body').filter({ hasText: marker }));
  await a.getByRole('button', { name: 'Friends', exact: true }).click();
  await a
    .getByLabel('Friend’s account name')
    .fill(accounts.find((u) => u.username === 'bob')!.userId);
  await a.getByRole('button', { name: 'Add friend', exact: true }).click();
  await expect(a.getByRole('button', { name: 'Check identity', exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  await b.getByRole('button', { name: 'Friends', exact: true }).click();
  await b.getByRole('button', { name: 'Check for invitations', exact: true }).click();
  const accept = b.getByRole('button', { name: 'Accept friend invitation', exact: true });
  if (await accept.isVisible()) await accept.click();
  await expect(b.getByRole('button', { name: 'Check identity', exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  await a.getByRole('button', { name: 'Check identity', exact: true }).first().click();
  await expect(b.getByRole('button', { name: 'Accept identity check', exact: true })).toBeVisible({
    timeout: 30_000,
  });
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
  const shared = `SYNTHETIC_SHARED_POST_${Date.now()}`;
  await a.getByRole('button', { name: 'News feed', exact: true }).click();
  await a.getByLabel('Write a post').fill(shared);
  await a
    .getByRole('checkbox', {
      name: accounts.find((u) => u.username === 'bob')!.userId,
      exact: true,
    })
    .check();
  await a.getByRole('button', { name: 'Share with selected friends', exact: true }).click();
  await expect(a.locator('.post-body').filter({ hasText: shared })).toBeVisible({
    timeout: 30_000,
  });
  await b.getByRole('button', { name: 'News feed', exact: true }).click();
  await b.getByRole('button', { name: 'Refresh my book', exact: true }).click();
  await expect(b.locator('.post-body').filter({ hasText: shared })).toBeVisible({
    timeout: 30_000,
  });
  await expect(b.locator('.post-body').filter({ hasText: marker })).toHaveCount(0);
  await a.getByRole('button', { name: 'My account', exact: true }).click();
  // This revokes the original device, unlike just closing a tab.
  await a.getByRole('button', { name: 'Sign out of this browser', exact: true }).click();
  await expect(a.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await ca.close();
  const restored = await browser.newContext();
  const r = await restored.newPage();
  await enter(r, 'alice');
  await r.getByRole('button', { name: 'My memories', exact: true }).click();
  await expect(r.locator('.post-body').filter({ hasText: marker })).toBeVisible({
    timeout: 30_000,
  });
  await restored.close();
  await cb.close();
});

test('an invitation creates a fresh account and its first encrypted archive', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  execFileSync(
    'python3',
    [
      fileURLToPath(new URL('../../../encrypted-host/host.py', import.meta.url)),
      'invite',
      '--runtime',
      runtime!,
    ],
    { stdio: 'pipe', timeout: 30_000 },
  );
  const invitation = JSON.parse(readFileSync(join(runtime!, 'invitation.json'), 'utf8'));
  const username = 'invited_' + Date.now().toString(36);
  const password = randomUUID();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(
    '/#' + new URLSearchParams({ home: state.url, invite: invitation.token }).toString(),
  );
  await expect(page.getByLabel('Your home’s address')).toHaveValue(state.url);
  expect(new URL(page.url()).hash).toBe('');
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create my account', exact: true }).click();
  await visibleOrError(
    page,
    page.getByRole('button', { name: 'Make my recovery kit', exact: true }),
  );
  await page.getByRole('button', { name: 'Make my recovery kit', exact: true }).click();
  const key = await page.getByLabel('Your recovery key', { exact: true }).inputValue();
  await page.getByLabel('Type the last 6 characters').fill(key.replace(/\s/g, '').slice(-6));
  await page.getByRole('button', { name: 'I saved it. Open my book.', exact: true }).click();
  await visibleOrError(page, page.getByRole('heading', { name: 'What’s on your mind?' }));
  const record: MemoryRecord = {
    id: 'newcomer-memory',
    kind: 'post',
    timestamp: 1000,
    text: 'SYNTHETIC_FIRST_MEMORY',
    title: 'A first memory',
    sourcePath: '',
    privateOnly: false,
    attachments: [],
  };
  const zip = await exportArchives([record]);
  await page.getByRole('button', { name: 'My memories', exact: true }).click();
  await page.getByLabel('Choose archive ZIP files').setInputFiles({
    name: 'fictional.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(await zip.arrayBuffer()),
  });
  await page.getByRole('button', { name: 'Bring in my memories', exact: true }).click();
  await visibleOrError(page, page.locator('.post-body').filter({ hasText: record.text }));
  await page.getByRole('button', { name: 'My account', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out of this browser', exact: true }).click();
  await visibleOrError(page, page.getByRole('button', { name: 'Sign in', exact: true }));
  await ctx.close();
  const fresh = await browser.newContext();
  const recovered = await fresh.newPage();
  await recovered.goto('/');
  await recovered.getByLabel('Your home’s address').fill(state.url);
  await recovered.getByLabel('Username', { exact: true }).fill(username);
  await recovered.getByLabel('Password', { exact: true }).fill(password);
  await recovered.getByRole('button', { name: 'Sign in', exact: true }).click();
  await visibleOrError(recovered, recovered.getByLabel('Recovery key', { exact: true }));
  await recovered.getByLabel('Recovery key', { exact: true }).fill(key);
  await recovered.getByRole('button', { name: 'Open my memories', exact: true }).click();
  await visibleOrError(recovered, recovered.getByRole('heading', { name: 'What’s on your mind?' }));
  await recovered.getByRole('button', { name: 'My memories', exact: true }).click();
  await expect(recovered.locator('.post-body').filter({ hasText: record.text })).toBeVisible();
  await recovered.getByText('Download my saved imports separately', { exact: true }).click();
  await recovered.getByRole('button', { name: 'Show saved imports', exact: true }).click();
  const downloadPromise = recovered.waitForEvent('download');
  await recovered.getByRole('button', { name: 'Download saved import 1', exact: true }).click();
  const part = await downloadPromise;
  const path = await part.path();
  if (!path) throw new Error('Saved import download missing');
  const exported = await importArchives([
    new File([new Uint8Array(readFileSync(path))], 'saved-import.zip'),
  ]);
  expect(exported.records.map((r) => ({ id: r.id, text: r.text }))).toEqual([
    { id: record.id, text: record.text },
  ]);
  await fresh.close();
});

test('a large private photo crosses the host upload limit only as encrypted chunks', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await enter(page, 'alice');
  const marker = 'SYNTHETIC_LARGE_PHOTO_' + Date.now();
  const png = await sharp(randomBytes(3500 * 3500 * 3), {
    raw: { width: 3500, height: 3500, channels: 3 },
  })
    .png({ compressionLevel: 0 })
    .toBuffer();
  expect(png.byteLength).toBeGreaterThan(35 * 1024 * 1024);
  const record: MemoryRecord = {
    id: marker,
    kind: 'photo',
    timestamp: 1000,
    text: marker,
    title: 'A fictional large photo',
    sourcePath: 'photos/fictional.png',
    privateOnly: false,
    attachments: [
      {
        path: 'fictional.png',
        mimeType: 'image/png',
        bytes: new Blob([new Uint8Array(png)], { type: 'image/png' }),
      },
    ],
  };
  const zip = await exportArchives([record]);
  const uploads: { bytes: number; type: string; leaked: boolean; bodyObserved: boolean }[] = [];
  const uploadChecks: Promise<void>[] = [];
  page.on('request', (request) => {
    if (
      request.url().startsWith(state.url) &&
      request.method() === 'POST' &&
      request.url().includes('/media/') &&
      request.url().includes('/upload')
    ) {
      uploadChecks.push(
        (async () => {
          const bytes = request.postDataBuffer();
          const headers = await request.allHeaders();
          uploads.push({
            bytes: bytes?.length ?? Number(headers['content-length'] ?? 0),
            type: headers['content-type'] ?? '',
            leaked: bytes?.includes(marker) ?? false,
            bodyObserved: bytes !== null,
          });
        })(),
      );
    }
  });
  await page.getByRole('button', { name: 'My memories', exact: true }).click();
  await page.getByLabel('Choose archive ZIP files').setInputFiles({
    name: 'large-fictional.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(await zip.arrayBuffer()),
  });
  await page.getByRole('button', { name: 'Bring in my memories', exact: true }).click();
  await visibleOrError(page, page.locator('.post-body').filter({ hasText: marker }), 100_000);
  await Promise.all(uploadChecks);
  expect(uploads.length).toBeGreaterThanOrEqual(5);
  expect(
    uploads.every(
      (p) =>
        p.bytes > 0 &&
        p.bytes <= 8 * 1024 * 1024 &&
        p.type === 'application/octet-stream' &&
        !p.leaked,
    ),
    JSON.stringify(uploads),
  ).toBe(true);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download my archive', exact: true }).click();
  const downloaded = await downloadPromise;
  const file = await downloaded.path();
  if (!file) throw new Error('Browser archive download missing');
  const restored = await importArchives([
    new File([new Uint8Array(readFileSync(file))], 'download.zip'),
  ]);
  const recovered = restored.records.find((r) => r.id === marker)!;
  const recoveredHash = createHash('sha256')
    .update(new Uint8Array(await recovered.attachments[0].bytes.arrayBuffer()))
    .digest('hex');
  expect(recoveredHash).toBe(createHash('sha256').update(png).digest('hex'));
  writeFileSync(
    join(runtime!, 'browser-photo-receipt.json'),
    JSON.stringify({ id: marker, sha256: recoveredHash }),
    { mode: 0o600 },
  );
  await ctx.close();
});

test('an unsigned device receives no keys and a failed publication can be abandoned', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const ca = await browser.newContext(),
    attacker = await browser.newContext();
  const a = await ca.newPage(),
    x = await attacker.newPage();
  await enter(a, 'alice');
  await x.goto('/');
  await x.getByLabel('Your home’s address').fill(state.url);
  await x.getByLabel('Username', { exact: true }).fill('bob');
  await x
    .getByLabel('Password', { exact: true })
    .fill(accounts.find((u) => u.username === 'bob')!.password);
  await x.getByRole('button', { name: 'Sign in', exact: true }).click();
  await visibleOrError(x, x.getByLabel('Recovery key', { exact: true }));
  const attackerDevice = await x.evaluate(
    () => JSON.parse(localStorage.getItem('clean-bookface.session.v1')!).deviceId as string,
  );
  const delivered: string[] = [];
  a.on('request', (request) => {
    if (
      request.url().startsWith(state.url) &&
      request.url().includes('/sendToDevice/m.room.encrypted/')
    ) {
      const body = request.postDataJSON();
      for (const recipients of Object.values(body?.messages ?? {}))
        delivered.push(...Object.keys(recipients as object));
    }
  });
  const marker = 'SYNTHETIC_UNVERIFIED_DEVICE_' + Date.now();
  await a.getByLabel('Write a post').fill(marker);
  await a
    .getByRole('checkbox', {
      name: accounts.find((u) => u.username === 'bob')!.userId,
      exact: true,
    })
    .check();
  // Deny publication after encryption as well: this guarantees a durable queued
  // retry even if the SDK safely excludes the unsigned device instead of failing.
  await a.route('**/_matrix/client/v3/rooms/**/send/**', (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ errcode: 'M_FORBIDDEN', error: 'Synthetic publication interruption' }),
    }),
  );
  await a.getByRole('button', { name: 'Share with selected friends', exact: true }).click();
  await expect(a.locator('#notice.error')).toBeVisible({ timeout: 30_000 });
  expect(delivered).not.toContain(attackerDevice);
  await expect(x.getByLabel('Recovery key', { exact: true })).toBeVisible();
  await a.reload();
  await visibleOrError(a, a.getByRole('button', { name: 'Finish sending this post', exact: true }));
  await expect(a.getByLabel('Write a post')).toHaveValue(marker);
  await a.getByRole('button', { name: 'Stop retrying this post', exact: true }).click();
  await expect(
    a.getByRole('button', { name: 'Share with selected friends', exact: true }),
  ).toBeVisible();
  await a.getByRole('button', { name: 'My account', exact: true }).click();
  await a.getByRole('button', { name: 'Sign out of this browser', exact: true }).click();
  await visibleOrError(a, a.getByRole('button', { name: 'Sign in', exact: true }));
  // Leaving an unopened recovery screen must not require possessing its kit.
  await x.getByRole('button', { name: 'Use a different account', exact: true }).click();
  await visibleOrError(x, x.getByRole('button', { name: 'Sign in', exact: true }));
  await ca.close();
  await attacker.close();
});

test('a restored standby opens signed memories and exports large photos', async ({ browser }) => {
  test.skip(
    process.env.CBF_TEST_STANDBY !== '1',
    'Run only against the separately restored local standby.',
  );
  test.setTimeout(120_000);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await enter(page, 'alice');
  await page.getByRole('button', { name: 'My memories', exact: true }).click();
  await expect(
    page.locator('.post-body').filter({ hasText: 'SYNTHETIC_PRIVATE_MEMORY_' }).first(),
  ).toBeVisible();
  const photos = page.locator('article').filter({ hasText: 'SYNTHETIC_LARGE_PHOTO_' });
  await expect(photos.first()).toBeVisible();
  await expect
    .poll(
      () =>
        photos
          .first()
          .locator('img')
          .evaluate((img) => (img as HTMLImageElement).naturalWidth),
      { timeout: 20_000 },
    )
    .toBe(3500);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download my archive', exact: true }).click();
  const downloaded = await downloadPromise;
  const file = await downloaded.path();
  if (!file) throw new Error('Archive download missing');
  const restored = await importArchives([
    new File([new Uint8Array(readFileSync(file))], 'restored.zip'),
  ]);
  const photo = restored.records.find((r) => r.text.startsWith('SYNTHETIC_LARGE_PHOTO_'))!;
  expect(photo.attachments[0].bytes.size).toBeGreaterThan(35 * 1024 * 1024);
  expect(restored.warnings).toEqual([]);
  await ctx.close();
});
