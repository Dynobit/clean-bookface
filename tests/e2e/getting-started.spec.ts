import { test, expect } from '@playwright/test';

test('members can discover the guide, review optional Facebook choices and return to private imports without JavaScript', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    baseURL,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  try {
    await page.goto('/login');
    await page.getByRole('link', { name: 'Getting started', exact: true }).first().click();
    await expect(page).toHaveURL(/\/getting-started$/);
    await expect(page.getByRole('heading', { name: 'Getting started', exact: true })).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Facebook’s download help', exact: true }),
    ).toHaveAttribute('href', 'https://www.facebook.com/help/212802592074644');
    const details = page.locator('details');
    const summary = details.locator('summary');
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(details).toHaveAttribute('open', '');
    await expect(page.getByText(/First save and verify your original exports/)).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Facebook’s account deletion help', exact: true }),
    ).toHaveAttribute('href', 'https://www.facebook.com/help/224562897555674');
    await expect(page.locator('form')).toHaveCount(0);
    const widths = await page.evaluate(() => ({
      body: document.body.scrollWidth,
      view: innerWidth,
    }));
    expect(widths.body).toBeLessThanOrEqual(widths.view);
    await page.keyboard.press('Enter');
    await expect(details).not.toHaveAttribute('open', '');
    await page.getByRole('link', { name: 'Bring your history', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Please log in', exact: true })).toBeVisible();
    await page.goto('/login');
    await page.getByLabel('Username', { exact: true }).fill('alice');
    await page.getByLabel('Password', { exact: true }).fill('fictional-demo-password-only');
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    await page.goto('/imports');
    await expect(page.getByRole('button', { name: 'Import privately', exact: true })).toBeVisible();
    await page
      .getByRole('link', {
        name: 'Getting started: save, import and share at your own pace',
        exact: true,
      })
      .click();
    await expect(page).toHaveURL(/\/getting-started$/);
    await page.goto('/settings');
    await expect(
      page.getByText(/Deleting here does not delete your Facebook account/),
    ).toBeVisible();
    await page
      .getByRole('link', { name: 'Read the Facebook options and checks first', exact: true })
      .click();
    await expect(page).toHaveURL(/\/getting-started#facebook-options$/);
    await expect(page.locator('#facebook-options')).toContainText('None of these is required');
  } finally {
    await context.close();
  }
});
