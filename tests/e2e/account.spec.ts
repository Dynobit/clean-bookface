import { test, expect } from '@playwright/test';

test('invitation, mutual friendship, recovery and preferences work without JavaScript', async ({
  browser,
  baseURL,
}) => {
  const host = await browser.newContext({ javaScriptEnabled: false, baseURL });
  const guest = await browser.newContext({ javaScriptEnabled: false, baseURL });
  const stranger = await browser.newContext({ javaScriptEnabled: false, baseURL });
  const hostPage = await host.newPage();
  const guestPage = await guest.newPage();
  const username = `visitor_${Date.now().toString(36)}`;
  const password = 'a fictional browser-only passphrase';
  try {
    await hostPage.goto('/login');
    await hostPage.getByLabel('Username', { exact: true }).fill('alice');
    await hostPage.getByLabel('Password', { exact: true }).fill('fictional-demo-password-only');
    await hostPage.getByRole('button', { name: 'Log in', exact: true }).click();
    await hostPage.goto('/friends');
    await hostPage.getByRole('button', { name: 'Create joining invitation', exact: true }).click();
    const joiningLink = await hostPage.locator('#invite-link').inputValue();

    await guestPage.goto(joiningLink);
    await expect(guestPage.getByLabel('Username', { exact: true })).toHaveAttribute(
      'autocapitalize',
      'none',
    );
    await expect(guestPage.getByLabel('Username', { exact: true })).toHaveAccessibleDescription(
      'Use 3–32 lowercase letters, numbers or underscores. Start with a letter or number.',
    );
    await expect(guestPage.getByLabel('Password', { exact: true })).toHaveAccessibleDescription(
      /at least 12 characters/,
    );
    await guestPage.getByLabel('Username', { exact: true }).fill(username);
    await guestPage.getByLabel('Your name', { exact: true }).fill('Taylor Example');
    await guestPage.getByLabel('Password', { exact: true }).fill(password);
    await guestPage.locator('input[name="acceptRules"]').check();
    await guestPage.getByRole('button', { name: 'Join this circle', exact: true }).click();
    await expect(
      guestPage.getByRole('heading', { name: 'Keep a way back in.', exact: true }),
    ).toBeVisible();
    await expect(guestPage.locator('[data-copy-recovery]')).toBeHidden();
    await expect(guestPage.locator('.codes code')).toHaveCount(8);
    const recoveryCode = await guestPage.locator('.codes code').first().textContent();
    expect(recoveryCode).toBeTruthy();
    await guestPage.getByRole('link', { name: 'I’ve saved my codes', exact: true }).click();
    await guestPage.goto('/friends');
    await expect(
      guestPage.getByRole('heading', { name: 'Friends · 0', exact: true }),
    ).toBeVisible();

    // Joining the host and accepting a friendship are separate consent steps.
    await hostPage.goto('/friends');
    await hostPage
      .getByRole('button', { name: 'Create friendship invitation', exact: true })
      .click();
    const friendLink = await hostPage.locator('#invite-link').inputValue();
    await guestPage.goto(friendLink);
    await guestPage.getByRole('button', { name: 'Accept friendship', exact: true }).click();
    await expect(
      guestPage.getByRole('heading', { name: 'Friends · 1', exact: true }),
    ).toBeVisible();
    await guestPage.goto('/');
    await expect(
      guestPage.getByText('A little album of the good stuff.', { exact: false }),
    ).toHaveCount(0);

    const privateText = `A private browser test memory ${username}`;
    await guestPage.getByLabel('Write a post', { exact: true }).fill(privateText);
    await guestPage.getByRole('button', { name: 'Post', exact: true }).click();
    await expect(guestPage.getByText(privateText, { exact: true })).toBeVisible();
    await expect(guestPage.getByText('Only you', { exact: true })).toBeVisible();
    await hostPage.goto('/');
    await expect(hostPage.getByText(privateText, { exact: true })).toHaveCount(0);

    await guestPage.goto('/settings');
    await guestPage.locator('input[name="compactFeed"]').check();
    await guestPage.getByRole('button', { name: 'Save preferences', exact: true }).click();
    // Wait for the POST's redirected page before starting another navigation.
    await expect(guestPage.getByRole('status')).toHaveText('Preferences saved.');
    await guestPage.reload();
    await expect(guestPage.locator('input[name="compactFeed"]')).toBeChecked();
    await guestPage.goto('/');
    await expect(guestPage.locator('body')).toHaveClass(/compact/);

    const strangerPage = await stranger.newPage();
    const privateProfile = await strangerPage.goto(`/users/${username}`);
    expect(privateProfile?.status()).toBe(404);
    await expect(
      strangerPage.getByRole('heading', { name: 'Taylor Example', exact: true }),
    ).toHaveCount(0);

    await guestPage.getByRole('button', { name: 'Log out', exact: true }).click();
    await guestPage.goto('/recover');
    await guestPage.getByLabel('Username', { exact: true }).fill(username);
    await guestPage.getByLabel('Recovery code', { exact: true }).fill(recoveryCode!);
    await guestPage
      .getByLabel('New password', { exact: true })
      .fill('a replacement fictional browser passphrase');
    await guestPage.getByRole('button', { name: 'Recover account', exact: true }).click();
    await expect(guestPage.locator('.codes code')).toHaveCount(8);
    expect(await guestPage.locator('.codes code').first().textContent()).not.toBe(recoveryCode);
    await guestPage.getByRole('link', { name: 'I’ve saved my codes', exact: true }).click();
    await guestPage.goto('/settings');
    await guestPage.getByLabel('Type your username to confirm', { exact: true }).fill(username);
    await guestPage.getByRole('button', { name: 'Delete my account', exact: true }).click();
    await expect(
      guestPage.getByRole('heading', { name: 'Log in to your circle', exact: true }),
    ).toBeVisible();
  } finally {
    await Promise.all([host.close(), guest.close(), stranger.close()]);
  }
});

test('recovery codes copy only on request and failures leave a usable manual path', async ({
  page,
  browser,
  baseURL,
}) => {
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill('alice');
  await page.getByLabel('Password', { exact: true }).fill('fictional-demo-password-only');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.goto('/friends');
  await page.getByRole('button', { name: 'Create joining invitation', exact: true }).click();
  const invitation = await page.locator('#invite-link').inputValue();
  const guest = await browser.newContext({ baseURL });
  try {
    const newcomer = await guest.newPage();
    await newcomer.goto(invitation);
    await newcomer.getByLabel('Username', { exact: true }).fill(`copy_${Date.now().toString(36)}`);
    await newcomer.getByLabel('Your name', { exact: true }).fill('Morgan Example');
    await newcomer
      .getByLabel('Password', { exact: true })
      .fill('fictional recovery copy passphrase');
    await newcomer.locator('input[name="acceptRules"]').check();
    await newcomer.getByRole('button', { name: 'Join this circle', exact: true }).click();
    const codes = await newcomer.locator('.codes code').allTextContents();
    expect(codes).toHaveLength(8);
    const status = newcomer.locator('[data-recovery-copy-status]');
    await expect(status).toBeEmpty();
    await expect(status).toHaveAttribute('aria-live', 'polite');
    await newcomer.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            document.body.dataset.copiedCodes = text;
          },
        },
      });
    });
    const copy = newcomer.getByRole('button', { name: 'Copy all recovery codes', exact: true });
    await copy.click();
    await expect(status).toContainText('Recovery codes copied.');
    expect(await newcomer.locator('body').getAttribute('data-copied-codes')).toBe(codes.join('\n'));
    for (const unavailable of [false, true]) {
      await newcomer.evaluate((missing) => {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: missing
            ? undefined
            : {
                writeText: async () => {
                  throw new Error('Permission denied');
                },
              },
        });
      }, unavailable);
      await copy.click();
      await expect(status).toContainText('Could not copy automatically.');
      await expect(status).not.toContainText('Recovery codes copied.');
      expect(await newcomer.locator('.codes code').allTextContents()).toEqual(codes);
    }
    await newcomer.getByRole('link', { name: 'I’ve saved my codes', exact: true }).click();
    await expect(newcomer).toHaveURL('/');
  } finally {
    await guest.close();
  }
});
