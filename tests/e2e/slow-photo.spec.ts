import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';

test('a photo batch on a slow connection can finish beyond the chunk deadline', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill('alice');
  await page.getByLabel('Password', { exact: true }).fill('fictional-demo-password-only');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.goto('/compose');
  const photo = resolve('public/assets/our-memories.png');
  await page.getByLabel('Choose photos', { exact: true }).setInputFiles(photo);
  const session = await page.context().newCDPSession(page);
  await session.send('Network.enable');
  await session.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: Math.floor((await stat(photo)).size / 66),
  });
  const started = Date.now();
  try {
    await page.getByRole('button', { name: 'Preview photos' }).click();
    await expect(page.getByAltText('Photo selected for sharing')).toBeVisible({ timeout: 110_000 });
    expect(Date.now() - started).toBeGreaterThan(60_000);
    await expect(page.getByLabel('Who should see this?')).toHaveValue('private');
  } finally {
    await session.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await session.detach();
  }
});
