import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
test('join a familiar feed, publish deliberately, search private history and leave with an export', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Log in to your circle' })).toBeVisible();
  await page.getByLabel('Username', { exact: true }).fill('alice');
  await page.getByLabel('Password', { exact: true }).fill('fictional-demo-password-only');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'News feed', exact: true })).toBeVisible();
  await expect(
    page.getByText('This feels like the internet I missed. See you Saturday!'),
  ).toBeVisible();
  const text = `A deliberately private note ${Date.now()}`;
  await page.getByLabel('Write a post').fill(text);
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(page.getByText(text, { exact: true })).toBeVisible();
  await expect(page.getByText('Only you', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Edit & audience' }).click();
  await expect(page.getByText('Only you can see this post.')).toBeVisible();
  await page.getByRole('link', { name: 'Bring your history', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Start with a Facebook export' })).toBeVisible();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Display name', { exact: true }).fill('Alice Morgan');
  await page.getByRole('button', { name: 'Save preferences' }).click();
  await expect(page.getByRole('status')).toContainText('Preferences saved.');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download my data' }).click();
  expect((await download).suggestedFilename()).toBe('clean-bookface-export.zip');
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Log in to your circle' })).toBeVisible();
});
test('photo preview strips metadata and waits for a deliberate audience choice', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill('alice');
  await page.getByLabel('Password', { exact: true }).fill('fictional-demo-password-only');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.goto('/compose');
  await page
    .getByLabel('Choose photos', { exact: true })
    .setInputFiles(resolve('public/assets/our-memories.png'));
  await page.getByRole('button', { name: 'Preview photos' }).click();
  await expect(page.getByAltText('Photo selected for sharing')).toBeVisible();
  await expect(page.getByLabel('Who should see this?')).toHaveValue('private');
  await page.getByLabel('Your words', { exact: true }).fill('A photo kept between friends.');
  await page.getByLabel('Who should see this?').selectOption('selected');
  await page.getByText('Choose particular friends', { exact: true }).click();
  await page.getByLabel('Ben Rivers', { exact: true }).check();
  await page.getByRole('button', { name: 'Publish this copy' }).click();
  await expect(page.getByText('A photo kept between friends.', { exact: true })).toBeVisible();
  await expect(page.getByAltText('Photo 1 shared by Alice Morgan')).toBeVisible();
});
test('small-screen navigation and keyboard login remain usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill('ben');
  await page.getByLabel('Password', { exact: true }).fill('fictional-demo-password-only');
  await page.getByLabel('Password', { exact: true }).press('Enter');
  await expect(page.getByRole('heading', { name: 'News feed', exact: true })).toBeVisible();
  const widths = await page.evaluate(() => ({ body: document.body.scrollWidth, view: innerWidth }));
  expect(widths.body).toBeLessThanOrEqual(widths.view);
  await page.getByRole('link', { name: 'Friends', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your people', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create joining invitation' })).toBeVisible();
});
test('synthetic desktop and phone screenshots document the real running interface', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill('alice');
  await page.getByLabel('Password', { exact: true }).fill('fictional-demo-password-only');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'News feed', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/feed-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/feed-mobile.png', fullPage: true });
});

test('host backup walkthrough keeps commands optional and fits a phone', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill('alice');
  await page.getByLabel('Password', { exact: true }).fill('fictional-demo-password-only');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.getByRole('link', { name: 'Host tools', exact: true }).click();
  await page.getByRole('link', { name: 'Set up backups, step by step →', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Back up your circle', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('main').getByRole('heading', { level: 2 })).toHaveCount(5);
  await expect(
    page.getByText('No successful backup has been recorded.', { exact: false }),
  ).toBeVisible();
  await page.getByText('Using the supplied Docker Compose installation', { exact: true }).click();
  await expect(page.getByText('backup.override.yaml', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'test-results/backup-guide-mobile.png', fullPage: true });
});
