import { test, expect } from '@playwright/test';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';

test('a ZIP import without JavaScript stays private and preserves its original photo and date', async ({
  browser,
  baseURL,
}, info) => {
  const zipPath = info.outputPath('fictional-facebook-export.zip');
  await mkdir(dirname(zipPath), { recursive: true });
  const marker = `A fictional browser ZIP memory ${Date.now()}`;
  const zip = new yazl.ZipFile();
  zip.addBuffer(
    Buffer.from(
      JSON.stringify([
        {
          id: marker,
          timestamp: 946684800,
          data: [{ post: marker }],
          attachments: [{ data: [{ media: { uri: 'photos/synthetic.png' } }] }],
        },
      ]),
    ),
    'your_facebook_activity/posts/your_posts__check_ins__photos_and_videos_1.json',
  );
  zip.addBuffer(
    await readFile(resolve('tests/fixtures/synthetic/facebook/photos/synthetic-postcard.png')),
    'photos/synthetic.png',
  );
  const written = pipeline(zip.outputStream, createWriteStream(zipPath));
  zip.end();
  await written;
  const owner = await browser.newContext({ javaScriptEnabled: false, baseURL });
  const friend = await browser.newContext({ javaScriptEnabled: false, baseURL });
  const ownerPage = await owner.newPage();
  const friendPage = await friend.newPage();
  try {
    for (const [page, username] of [
      [ownerPage, 'alice'],
      [friendPage, 'ben'],
    ] as const) {
      await page.goto('/login');
      await page.getByLabel('Username', { exact: true }).fill(username);
      await page.getByLabel('Password', { exact: true }).fill('fictional-demo-password-only');
      await page.getByRole('button', { name: 'Log in', exact: true }).click();
    }
    await ownerPage.goto('/imports');
    await ownerPage.getByLabel('Upload a ZIP export', { exact: true }).setInputFiles(zipPath);
    await ownerPage.getByRole('button', { name: 'Import privately', exact: true }).click();
    await expect(ownerPage).toHaveURL(/\/imports$/);
    await expect(async () => {
      await ownerPage.goto(`/archive?q=${encodeURIComponent(marker)}`);
      await expect(ownerPage.getByText(marker, { exact: true })).toBeVisible();
    }).toPass({ timeout: 20_000, intervals: [300, 500, 1000] });
    const card = ownerPage.locator('article').filter({ hasText: marker });
    const memoryLink = await card
      .getByRole('link', { name: 'Open memory →', exact: true })
      .getAttribute('href');
    await card.getByRole('link', { name: 'Open memory →', exact: true }).click();
    await expect(ownerPage.getByText(marker, { exact: true })).toBeVisible();
    await expect(ownerPage.getByText('post · Jan 1, 2000', { exact: true })).toBeVisible();
    const image = ownerPage.getByAltText('Private photo 1', { exact: true });
    await expect(image).toBeVisible();
    await expect
      .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
      .toBeGreaterThan(0);
    const denied = await friendPage.goto(memoryLink!);
    expect(denied?.status()).toBe(404);
    await expect(friendPage.getByText(marker, { exact: true })).toHaveCount(0);
    await ownerPage.goto(`/?q=${encodeURIComponent(marker)}`);
    await expect(ownerPage.getByText(marker, { exact: true })).toHaveCount(0);
    await ownerPage.goto(memoryLink!);
    await ownerPage
      .getByRole('checkbox', {
        name: 'Delete this memory and its linked shared copies. Removal from remote hosts will be requested.',
      })
      .check();
    await ownerPage
      .getByRole('button', { name: 'Delete memory & linked shares', exact: true })
      .click();
    await ownerPage.goto(`/archive?q=${encodeURIComponent(marker)}`);
    await expect(ownerPage.getByText(marker, { exact: true })).toHaveCount(0);
  } finally {
    await Promise.all([owner.close(), friend.close()]);
  }
});
