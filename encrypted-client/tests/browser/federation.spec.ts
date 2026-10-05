import { test, expect, type Page, type Locator } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { exportArchives, type MemoryRecord } from '../../src/archive';
const federationRuntime = process.env.CBF_TEST_FEDERATION_RUNTIME;
test.skip(!federationRuntime, 'Requires two disposable, allowlisted local federation hosts.');
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
async function enter(page: Page, home: string, username: string): Promise<string> {
  const runtime = join(federationRuntime!, home);
  const state = JSON.parse(readFileSync(join(runtime, 'state.json'), 'utf8'));
  if (state.mode !== 'local') throw new Error('Only disposable local hosts are permitted.');
  const accounts = JSON.parse(
    readFileSync(join(runtime, 'fictional-credentials.json'), 'utf8'),
  ) as { username: string; password: string; userId: string }[];
  const kitFile = join(runtime, 'federation-browser-recovery-keys.json');
  let kits: Record<string, string> = {};
  try {
    kits = JSON.parse(readFileSync(kitFile, 'utf8'));
  } catch {}
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
  return account.userId;
}
test('independent homes share only selected memories after a real identity comparison', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const ca = await browser.newContext(),
    cb = await browser.newContext();
  const a = await ca.newPage(),
    b = await cb.newPage();
  await enter(a, 'a', 'alice');
  const bobId = await enter(b, 'b', 'bob');
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
  const photoMarker = `CROSS_HOME_PHOTO_${Date.now()}`;
  const png = await sharp({ create: { width: 24, height: 16, channels: 3, background: '#3b5998' } })
    .png()
    .toBuffer();
  const photo: MemoryRecord = {
    ...record,
    id: photoMarker,
    text: photoMarker,
    kind: 'photo',
    attachments: [{ path: 'fictional.png', mimeType: 'image/png', bytes: new Blob([png]) }],
  };
  const privateOnly: MemoryRecord = {
    ...record,
    id: `${marker}_PRIVATE_ONLY`,
    text: `${marker}_PRIVATE_ONLY`,
    privateOnly: true,
  };
  const zip = await exportArchives([record, photo, privateOnly]);
  await a.getByRole('button', { name: 'My memories', exact: true }).click();
  await a.getByLabel('Choose archive ZIP files').setInputFiles({
    name: 'synthetic-memory.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(await zip.arrayBuffer()),
  });
  await a.getByRole('button', { name: 'Bring in my memories', exact: true }).click();
  await visibleOrError(a, a.locator('.post-body').filter({ hasText: marker }).first());
  await a.getByRole('button', { name: 'Friends', exact: true }).click();
  await a.getByLabel('Friend’s account name').fill(bobId);
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
      name: bobId,
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
  await a.getByRole('button', { name: 'My memories', exact: true }).click();
  const photoCard = a
    .locator('article')
    .filter({ has: a.locator('.post-body').filter({ hasText: photoMarker }) });
  await photoCard.getByText('Share this memory', { exact: true }).click();
  await photoCard.getByRole('checkbox', { name: bobId, exact: true }).check();
  await photoCard.getByRole('button', { name: 'Share selected copy', exact: true }).click();
  await expect(a.locator('#notice')).toHaveText(
    'Shared a separate copy. Your original is still private.',
    { timeout: 30000 },
  );
  const privateCard = a
    .locator('article')
    .filter({ has: a.locator('.post-body').filter({ hasText: privateOnly.text }) });
  await expect(privateCard.getByText('Share this memory', { exact: true })).toHaveCount(0);
  await b.getByRole('button', { name: 'Refresh my book', exact: true }).click();
  const received = b
    .locator('article')
    .filter({ has: b.locator('.post-body').filter({ hasText: photoMarker }) });
  await expect(received).toBeVisible({ timeout: 30000 });
  await expect
    .poll(() => received.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(24);
  // Decode through the displayed image, without weakening the client's blob-fetch CSP.
  const pixels = await received.locator('img').evaluate((img: HTMLImageElement) => {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    return {
      width: canvas.width,
      height: canvas.height,
      pixel: Array.from(ctx.getImageData(0, 0, 1, 1).data),
    };
  });
  expect(pixels).toEqual({ width: 24, height: 16, pixel: [59, 89, 152, 255] });
  await expect(b.locator('.post-body').filter({ hasText: marker })).toHaveCount(0);
  // Flush each device's key backup before discarding its browser storage. This
  // lets a later run recover the retained pair's encrypted conversation history.
  for (const page of [a, b]) {
    await page.getByRole('button', { name: 'My account', exact: true }).click();
    await page.getByRole('button', { name: 'Sign out of this browser', exact: true }).click();
    await expect(page.locator('#notice')).toHaveText('Signed out.', { timeout: 65_000 });
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  }
  await ca.close();
  await cb.close();
});
