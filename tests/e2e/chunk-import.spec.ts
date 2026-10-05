import { test, expect } from '@playwright/test';
import { createWriteStream } from 'node:fs';
import { mkdir, open, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';

test('a 104 MiB ZIP resumes after interruption, verifies reselected bytes and stays private', async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const zipPath = info.outputPath('fictional-large-export.zip');
  await mkdir(dirname(zipPath), { recursive: true });
  const marker = `Fictional resumable browser memory ${Date.now()}`;
  const zip = new yazl.ZipFile();
  zip.addBuffer(
    Buffer.from(JSON.stringify([{ id: marker, timestamp: 946684800, data: [{ post: marker }] }])),
    'posts/your_posts_1.json',
  );
  async function* padding() {
    const bytes = Buffer.alloc(4 * 1024 * 1024, 57);
    for (let i = 0; i < 26; i++) yield bytes;
  }
  zip.addReadStream(Readable.from(padding()), 'unsupported/synthetic-padding.bin', {
    compress: false,
    size: 104 * 1024 * 1024,
  });
  const written = pipeline(zip.outputStream, createWriteStream(zipPath));
  zip.end();
  await written;
  expect((await stat(zipPath)).size).toBeGreaterThan(100 * 1024 * 1024);
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill('alice');
  await page.getByLabel('Password', { exact: true }).fill('fictional-demo-password-only');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.goto('/imports');
  const requests: number[] = [];
  await page.route('**/api/uploads/*/files/*', async (route) => {
    const request = route.request();
    requests.push(request.postDataBuffer()?.length ?? 0);
    if (new URL(request.url()).searchParams.get('offset') === '4194304')
      await route.abort('failed');
    else await route.continue();
  });
  await page.getByLabel('Upload a ZIP export', { exact: true }).setInputFiles(zipPath);
  await page.getByRole('button', { name: 'Import privately', exact: true }).click();
  await expect(
    page
      .locator('form')
      .filter({ has: page.locator('#zip-files') })
      .getByRole('status'),
  ).toContainText('received parts are saved', { timeout: 20_000 });
  const stored = await page.evaluate(() => sessionStorage.getItem('bookface-upload:zip-files'));
  expect(stored).toMatch(/^[a-f0-9-]{36}$/);
  await page.unroute('**/api/uploads/*/files/*');
  await page.reload();
  // Same filename and size are insufficient: a changed accepted prefix must not be skipped.
  const file = await open(zipPath, 'r+');
  await file.write(Buffer.from([0]), 0, 1, 0);
  await file.close();
  await page.getByLabel('Upload a ZIP export', { exact: true }).setInputFiles(zipPath);
  await page.getByRole('button', { name: 'Import privately', exact: true }).click();
  await expect(
    page
      .locator('form')
      .filter({ has: page.locator('#zip-files') })
      .getByRole('status'),
  ).toContainText('files differ');
  const original = await open(zipPath, 'r+');
  await original.write(Buffer.from([0x50]), 0, 1, 0);
  await original.close();
  await page.getByLabel('Upload a ZIP export', { exact: true }).setInputFiles(zipPath);
  page.on('request', (request) => {
    if (request.method() === 'PUT') requests.push(request.postDataBuffer()?.length ?? 0);
  });
  const redirected = page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame());
  const committed = page.waitForResponse((r) => r.url().endsWith('/commit') && r.status() === 202);
  await page.getByRole('button', { name: 'Import privately', exact: true }).click();
  await committed;
  await redirected;
  await page.waitForLoadState('domcontentloaded');
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem('bookface-upload:zip-files')))
    .toBeNull();
  expect(Math.max(...requests)).toBeLessThanOrEqual(4 * 1024 * 1024);
  await expect(async () => {
    await page.goto(`/archive?q=${encodeURIComponent(marker)}`);
    await expect(page.getByText(marker, { exact: true })).toBeVisible();
  }).toPass({ timeout: 30_000, intervals: [500, 1000] });
  await page.goto(`/?q=${encodeURIComponent(marker)}`);
  await expect(page.getByText(marker, { exact: true })).toHaveCount(0);
});
