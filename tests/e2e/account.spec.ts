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
    await guestPage.getByLabel('Username', { exact: true }).fill(username);
    await guestPage.getByLabel('Your name', { exact: true }).fill('Taylor Example');
    await guestPage.getByLabel('Password', { exact: true }).fill(password);
    await guestPage.locator('input[name="acceptRules"]').check();
    await guestPage.getByRole('button', { name: 'Join this circle', exact: true }).click();
    await expect(
      guestPage.getByRole('heading', { name: 'Keep a way back in.', exact: true }),
    ).toBeVisible();
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
