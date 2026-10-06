import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ClientEvent, SyncState, createClient } from 'matrix-js-sdk';
import { VerificationPhase } from 'matrix-js-sdk/lib/crypto-api/index.js';
import type { Session } from '../../src/identity';
import { exportArchives, importArchives, type MemoryRecord } from '../../src/archive';

const runtime = process.env.CBF_TEST_HOST_RUNTIME;
if (!runtime) throw new Error('Requires the disposable local browser qualification host.');
const state = JSON.parse(readFileSync(join(runtime, 'state.json'), 'utf8'));
if (state.mode !== 'local' || new URL(state.url).hostname !== '127.0.0.1')
  throw new Error('This suite only admits the disposable loopback Synapse host.');
const hostScript = fileURLToPath(new URL('../../../encrypted-host/host.py', import.meta.url));
const SESSION = 'clean-bookface.session.v1';
test.use({ actionTimeout: 20_000 });

type Member = { username: string; password: string; kit: string };
async function joinMember(page: Page): Promise<Member> {
  execFileSync('python3', [hostScript, 'invite', '--runtime', runtime!], {
    stdio: 'pipe',
    timeout: 30_000,
  });
  const invitation = JSON.parse(readFileSync(join(runtime!, 'invitation.json'), 'utf8'));
  const member = {
    username: `fixture_${randomUUID().replaceAll('-', '')}`,
    password: `fictional-${randomUUID()}`,
    kit: '',
  };
  await page.goto('/');
  await page.getByLabel('Account action').selectOption('join');
  await page.getByLabel('Your home’s address').fill(state.url);
  await page.getByLabel('Invitation code', { exact: true }).fill(invitation.token);
  await page.getByLabel('Username', { exact: true }).fill(member.username);
  await page.getByLabel('Password', { exact: true }).fill(member.password);
  await page.getByRole('button', { name: 'Create my account', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Make my recovery kit' })).toBeVisible({
    timeout: 65_000,
  });
  await page.getByRole('button', { name: 'Make my recovery kit' }).click();
  member.kit = await page.getByLabel('Your recovery key', { exact: true }).inputValue();
  await page.getByLabel('Type the last 6 characters').fill(member.kit.replace(/\s/g, '').slice(-6));
  return member;
}
async function ready(page: Page) {
  await expect(page.getByRole('button', { name: 'My account', exact: true })).toBeVisible({
    timeout: 65_000,
  });
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false', { timeout: 65_000 });
}
async function finishSetup(page: Page) {
  await page.getByRole('button', { name: 'I saved it. Open my book.', exact: true }).click();
  await ready(page);
}
async function recover(page: Page, member: Member) {
  await expect(page.getByLabel('Recovery key', { exact: true })).toBeVisible({ timeout: 65_000 });
  await page.getByLabel('Recovery key', { exact: true }).fill(member.kit);
  await page.getByLabel('Account password', { exact: true }).fill(member.password);
  await page.getByRole('button', { name: /Open my memories|Finish.*setup/ }).click();
  await ready(page);
}
async function session(page: Page): Promise<Session> {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), SESSION);
}
async function api(s: Session, method: string, path: string, body?: unknown) {
  const response = await fetch(`${s.baseUrl}/_matrix/client/v3${path}`, {
    method,
    headers: { Authorization: `Bearer ${s.accessToken}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`Disposable Matrix request failed: HTTP ${response.status}`);
  return response.json();
}
async function master(s: Session) {
  const result = await api(s, 'POST', '/keys/query', { device_keys: { [s.userId]: [] } });
  return result.master_keys[s.userId].keys;
}
async function saveMemory(page: Page, marker: string, waitForCompletedImport = true) {
  const record: MemoryRecord = {
    id: marker,
    kind: 'post',
    text: marker,
    title: 'Fictional recovery memory',
    timestamp: 1234567890000,
    sourcePath: 'fixture.json',
    privateOnly: false,
    attachments: [],
    provenance: { fictional: true },
  };
  const zip = await exportArchives([record]);
  await page.getByRole('button', { name: 'My memories', exact: true }).click();
  await expect(page.getByLabel('Choose archive ZIP files')).toBeEnabled();
  await page.getByLabel('Choose archive ZIP files').setInputFiles({
    name: 'fictional-recovery.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(await zip.arrayBuffer()),
  });
  await page.getByRole('button', { name: 'Bring in my memories', exact: true }).click();
  if (waitForCompletedImport)
    await expect(page.locator('.post-body').filter({ hasText: marker })).toBeVisible({
      timeout: 65_000,
    });
}

for (const checkpoint of ['signing publication', 'secret storage', 'backup creation']) {
  test(`setup resumes after ${checkpoint} interruption and a real IndexedDB reload`, async ({
    page,
  }) => {
    const member = await joinMember(page);
    const pattern =
      checkpoint === 'signing publication'
        ? '**/keys/device_signing/upload'
        : checkpoint === 'secret storage'
          ? '**/account_data/m.cross_signing.self_signing'
          : '**/room_keys/version';
    let interrupted = 0;
    let attemptedMaster: Record<string, string> | undefined;
    await page.route(pattern, async (route) => {
      if (['POST', 'PUT'].includes(route.request().method())) {
        interrupted++;
        if (checkpoint === 'signing publication')
          attemptedMaster = route.request().postDataJSON().master_key.keys;
        await route.fulfill({
          status: 400,
          json: { errcode: 'M_BAD_JSON', error: 'Synthetic setup interruption' },
        });
      } else await route.continue();
    });
    await page.getByRole('button', { name: 'I saved it. Open my book.', exact: true }).click();
    await expect(page.locator('#notice.error')).toBeVisible({ timeout: 30_000 });
    expect(interrupted).toBeGreaterThan(0);
    const s = await session(page);
    const originalMaster = attemptedMaster ?? (await master(s));
    await page.unroute(pattern);
    await page.reload();
    await recover(page, member);
    expect(await master(s)).toEqual(originalMaster);
    await saveMemory(page, `SYNTHETIC_AFTER_SETUP_${checkpoint.replaceAll(' ', '_')}`);
  });
}

for (const checkpoint of ['signing', 'backup key cached'] as const)
  test(`[delta] restore interrupted after ${checkpoint} returns to recovery after real IndexedDB reload`, async ({
    browser,
  }) => {
    const first = await browser.newContext();
    const second = await browser.newContext();
    try {
      const a = await first.newPage();
      const member = await joinMember(a);
      await finishSetup(a);
      const marker = 'SYNTHETIC_RESTORE_AFTER_SIGNING';
      await saveMemory(a, marker);
      await a.getByRole('button', { name: 'My account', exact: true }).click();
      await a.getByRole('button', { name: 'Sign out of this browser', exact: true }).click();
      await expect(a.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible({
        timeout: 65_000,
      });
      const b = await second.newPage();
      await b.goto('/');
      await b.getByLabel('Your home’s address').fill(state.url);
      await b.getByLabel('Username', { exact: true }).fill(member.username);
      await b.getByLabel('Password', { exact: true }).fill(member.password);
      await b.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(b.getByLabel('Recovery key', { exact: true })).toBeVisible({ timeout: 65_000 });
      let signed = false,
        blocked = 0;
      b.on('response', (response) => {
        if (response.url().includes('/keys/signatures/upload') && response.ok()) signed = true;
      });
      const routePattern =
        checkpoint === 'signing' ? '**/room_keys/version' : '**/room_keys/keys?*';
      await b.route(routePattern, async (route) => {
        if (signed && route.request().method() === 'GET') {
          blocked++;
          await route.fulfill({
            status: 400,
            json: { errcode: 'M_BAD_JSON', error: 'Synthetic interruption after signing' },
          });
        } else await route.continue();
      });
      await b.getByLabel('Recovery key', { exact: true }).fill(member.kit);
      await b.getByRole('button', { name: 'Open my memories', exact: true }).click();
      await expect(b.locator('#notice.error')).toBeVisible({ timeout: 30_000 });
      expect(signed).toBe(true);
      expect(blocked, await b.locator('#notice').innerText()).toBeGreaterThan(0);
      const s = await session(b);
      const keys = await api(s, 'POST', '/keys/query', { device_keys: { [s.userId]: [] } });
      expect(
        Object.keys(keys.device_keys[s.userId][s.deviceId].signatures[s.userId]).length,
      ).toBeGreaterThan(1);
      const progressKey =
        'clean-bookface.restore-pending.v1:' +
        [s.baseUrl, s.userId, s.deviceId].map(encodeURIComponent).join(':');
      expect(await b.evaluate((key) => localStorage.getItem(key), progressKey)).toBe('pending');
      await b.unroute(routePattern);
      await b.reload();
      await recover(b, member);
      expect(await b.evaluate((key) => localStorage.getItem(key), progressKey)).toBeNull();
      await b.getByRole('button', { name: 'My memories', exact: true }).click();
      await expect(b.locator('.post-body').filter({ hasText: marker })).toBeVisible({
        timeout: 65_000,
      });
    } finally {
      await first.close();
      await second.close();
    }
  });

test('another tab cannot discard the shared session and failed-open logout removes only its device', async ({
  context,
  page,
}) => {
  await joinMember(page);
  await finishSetup(page);
  const s = await session(page);
  const original = await page.evaluate((key) => localStorage.getItem(key), SESSION);
  const terminalKey =
    'clean-bookface.verification-terminal.v1:' +
    [s.baseUrl, s.userId, s.deviceId].map(encodeURIComponent).join(':');
  const otherTerminalKey = terminalKey + '-OTHER-DEVICE';
  const terminalValue = JSON.stringify([
    JSON.stringify(['@fictional:encrypted.test', 'completed-fictional-request']),
  ]);
  await page.evaluate(
    ({ terminalKey, otherTerminalKey, terminalValue }) => {
      localStorage.setItem(terminalKey, terminalValue);
      localStorage.setItem(otherTerminalKey, terminalValue);
    },
    { terminalKey, otherTerminalKey, terminalValue },
  );
  const other = await context.newPage();
  await other.goto('/');
  await expect(
    other.getByText('This device is already open in another tab.', { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    other.getByRole('button', { name: /Sign in again|End this browser session/ }),
  ).toHaveCount(0);
  await expect(
    other.getByText('Remove this browser’s keys without contacting the home', { exact: true }),
  ).toHaveCount(0);
  expect(await other.evaluate((key) => localStorage.getItem(key), SESSION)).toBe(original);
  expect(await other.evaluate((key) => localStorage.getItem(key), terminalKey)).toBe(terminalValue);
  await page.close();
  await other.getByRole('button', { name: 'Try again', exact: true }).click();
  await ready(other);
  const progressKey =
    'clean-bookface.restore-pending.v1:' +
    [s.baseUrl, s.userId, s.deviceId].map(encodeURIComponent).join(':');
  const otherProgressKey = progressKey + '-OTHER-DEVICE';
  await other.evaluate(
    ({ progressKey, otherProgressKey }) => {
      localStorage.setItem(progressKey, 'pending');
      localStorage.setItem(otherProgressKey, 'pending');
    },
    { progressKey, otherProgressKey },
  );
  await other.route('**/keys/query', (route) =>
    route.fulfill({
      status: 400,
      json: { errcode: 'M_BAD_JSON', error: 'Synthetic startup failure' },
    }),
  );
  await other.reload();
  const end = other.getByRole('button', { name: 'End this browser session', exact: true });
  await expect(end).toBeVisible({ timeout: 65_000 });
  await other.route('**/logout', (route) =>
    route.fulfill({
      status: 400,
      json: { errcode: 'M_BAD_JSON', error: 'Synthetic logout failure' },
    }),
  );
  await end.click();
  await expect(other.locator('#notice.error')).toBeVisible();
  expect(await other.evaluate((key) => localStorage.getItem(key), SESSION)).toBe(original);
  expect(await other.evaluate((key) => localStorage.getItem(key), terminalKey)).toBe(terminalValue);
  expect(await other.evaluate((key) => localStorage.getItem(key), progressKey)).toBe('pending');
  const ownPrefix = `clean-bookface:${s.baseUrl}:${s.userId}:${s.deviceId}`;
  expect(
    await other.evaluate(
      async (prefix) =>
        (await indexedDB.databases()).filter((db) => db.name?.startsWith(prefix)).length,
      ownPrefix,
    ),
  ).toBeGreaterThan(0);
  await other.unroute('**/logout');
  await end.click();
  await expect(other.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  expect(await other.evaluate((key) => localStorage.getItem(key), SESSION)).toBeNull();
  expect(await other.evaluate((key) => localStorage.getItem(key), terminalKey)).toBeNull();
  expect(await other.evaluate((key) => localStorage.getItem(key), progressKey)).toBeNull();
  expect(await other.evaluate((key) => localStorage.getItem(key), otherProgressKey)).toBe(
    'pending',
  );
  expect(await other.evaluate((key) => localStorage.getItem(key), otherTerminalKey)).toBe(
    terminalValue,
  );
  expect(
    await other.evaluate(
      async (prefix) =>
        (await indexedDB.databases()).filter((db) => db.name?.startsWith(prefix)).length,
      ownPrefix,
    ),
  ).toBe(0);
  const denied = await fetch(`${s.baseUrl}/_matrix/client/v3/account/whoami`, {
    headers: { Authorization: `Bearer ${s.accessToken}` },
  });
  expect(denied.status).toBe(401);
});

test('an undecryptable archive event leaves valid memories, downloads and account exit available', async ({
  page,
}) => {
  await joinMember(page);
  await finishSetup(page);
  const marker = 'SYNTHETIC_VALID_BESIDE_UNDECRYPTABLE';
  await saveMemory(page, marker);
  const s = await session(page);
  const rooms = await api(s, 'GET', '/joined_rooms');
  expect(rooms.joined_rooms.length).toBe(1);
  await api(
    s,
    'PUT',
    `/rooms/${encodeURIComponent(rooms.joined_rooms[0])}/send/m.room.encrypted/${randomUUID()}`,
    {
      algorithm: 'm.megolm.v1.aes-sha2',
      sender_key: 'synthetic-missing-key',
      session_id: 'synthetic-missing-session',
      device_id: s.deviceId,
      ciphertext: 'synthetic-invalid-ciphertext',
    },
  );
  await page.reload();
  await ready(page);
  await page.getByRole('button', { name: 'My memories', exact: true }).click();
  await expect(page.locator('.post-body').filter({ hasText: marker })).toBeVisible({
    timeout: 65_000,
  });
  await expect(page.getByRole('heading', { name: 'Some memories need attention' })).toBeVisible();
  await page.getByText('Download my saved imports separately', { exact: true }).click();
  await page.getByRole('button', { name: 'Show saved imports', exact: true }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download saved import 1', exact: true }).click();
  const downloaded = await downloading;
  const path = await downloaded.path();
  if (!path) throw new Error('Expected fictional archive download');
  const exported = await importArchives([
    new File([new Uint8Array(readFileSync(path))], 'fictional-download.zip'),
  ]);
  expect(exported.records.map((record) => record.text)).toEqual([marker]);
  await page.getByRole('button', { name: 'My account', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Sign out of this browser', exact: true }),
  ).toBeVisible();
  await page.getByText('Close my account', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Close this account permanently' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out of this browser', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible({
    timeout: 65_000,
  });
});

test('a real same-account SAS request cannot become a friend comparison or receive secrets', async ({
  page,
}) => {
  const member = await joinMember(page);
  await finishSetup(page);
  const login = await createClient({ baseUrl: state.url, disableVoip: true }).login(
    'm.login.password',
    { identifier: { type: 'm.id.user', user: member.username }, password: member.password },
  );
  const s: Session = {
    baseUrl: state.url,
    userId: login.user_id,
    deviceId: login.device_id,
    accessToken: login.access_token,
  };
  const client = createClient({ ...s, disableVoip: true, verificationMethods: ['m.sas.v1'] });
  const sent: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/sendToDevice/')) sent.push(request.url());
  });
  try {
    await client.initRustCrypto({ useIndexedDB: false });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Fictional SAS browser sync timed out')),
        60_000,
      );
      client.on(ClientEvent.Sync, (sync) => {
        if (sync === SyncState.Prepared) {
          clearTimeout(timer);
          resolve();
        }
      });
      void client.startClient({ initialSyncLimit: 1 }).catch(reject);
    });
    await client.getCrypto()!.userHasCrossSigningKeys(s.userId, true);
    const request = await client.getCrypto()!.requestOwnUserVerification();
    await expect.poll(() => request.phase, { timeout: 30_000 }).toBe(VerificationPhase.Cancelled);
    await expect(page.getByRole('button', { name: 'Accept identity check' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'They match' })).toHaveCount(0);
    const keys = await api(s, 'POST', '/keys/query', { device_keys: { [s.userId]: [] } });
    expect(Object.keys(keys.device_keys[s.userId][s.deviceId].signatures[s.userId])).toEqual([
      `ed25519:${s.deviceId}`,
    ]);
    expect(await client.getCrypto()!.getSessionBackupPrivateKey()).toBeNull();
    expect(
      sent.some((url) => url.includes('/m.room.encrypted/') || url.includes('/m.secret.send/')),
    ).toBe(false);
  } finally {
    await client.logout(true);
    client.stopClient();
  }
});

test('an already invalidated saved token can end its exact browser session', async ({ page }) => {
  await joinMember(page);
  await finishSetup(page);
  const saved = await session(page);
  const prefix = `clean-bookface:${saved.baseUrl}:${saved.userId}:${saved.deviceId}`;
  await api(saved, 'POST', '/logout', {});
  await page.reload();
  await page
    .getByRole('button', { name: 'End this browser session', exact: true })
    .click({ timeout: 65_000 });
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  expect(await page.evaluate((key) => localStorage.getItem(key), SESSION)).toBeNull();
  expect(
    await page.evaluate(
      async (prefix) =>
        (await indexedDB.databases()).filter((db) => db.name?.startsWith(prefix)).length,
      prefix,
    ),
  ).toBe(0);
});

test('unreachable home preserves keys until explicit local recovery warning confirmation', async ({
  page,
}) => {
  await joinMember(page);
  await finishSetup(page);
  const saved = await session(page);
  const prefix = `clean-bookface:${saved.baseUrl}:${saved.userId}:${saved.deviceId}`;
  await page.route('**/keys/query', (route) => route.abort('connectionrefused'));
  await page.reload();
  const end = page.getByRole('button', { name: 'End this browser session', exact: true });
  await expect(end).toBeVisible({ timeout: 65_000 });
  await page.route('**/logout', (route) => route.abort('connectionrefused'));
  await end.click();
  await expect(page.locator('#notice.error')).toBeVisible();
  expect(await session(page)).toEqual(saved);
  await page
    .getByText('Remove this browser’s keys without contacting the home', { exact: true })
    .click();
  await expect(
    page.getByText('This removes this browser’s keys, saved sign-in and unsent changes.', {
      exact: false,
    }),
  ).toBeVisible();
  const remove = page.getByRole('button', { name: 'Remove local keys and sign-in', exact: true });
  await remove.click();
  await expect(page.locator('#notice.error')).toContainText('Confirm the recovery warning');
  expect(await session(page)).toEqual(saved);
  expect(
    await page.evaluate(
      async (prefix) =>
        (await indexedDB.databases()).filter((db) => db.name?.startsWith(prefix)).length,
      prefix,
    ),
  ).toBeGreaterThan(0);
  await page
    .getByLabel(
      'I understand that unsent changes and keys not backed up will be lost. My recovery kit cannot restore them.',
    )
    .check();
  await remove.click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  expect(await page.evaluate((key) => localStorage.getItem(key), SESSION)).toBeNull();
  expect(
    await page.evaluate(
      async (prefix) =>
        (await indexedDB.databases()).filter((db) => db.name?.startsWith(prefix)).length,
      prefix,
    ),
  ).toBe(0);
  const stillActive = await api(saved, 'GET', '/account/whoami');
  expect(stillActive.user_id).toBe(saved.userId);
  await api(saved, 'POST', '/logout', {});
});

test('incoming friend check cannot obstruct recovery and a fresh check works after restoring', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const ca = await browser.newContext(),
    cb = await browser.newContext(),
    restored = await browser.newContext();
  try {
    const a = await ca.newPage(),
      b = await cb.newPage();
    const member = await joinMember(a);
    await finishSetup(a);
    await joinMember(b);
    await finishSetup(b);
    const alice = await session(a),
      bob = await session(b);
    await a.getByRole('button', { name: 'Friends', exact: true }).click();
    await a.getByLabel('Friend’s account name').fill(bob.userId);
    await a.getByRole('button', { name: 'Add friend', exact: true }).click();
    await expect(a.locator('main')).toHaveAttribute('aria-busy', 'false');
    await b.getByRole('button', { name: 'Friends', exact: true }).click();
    await b.getByRole('button', { name: 'Check for invitations', exact: true }).click();
    await b.getByRole('button', { name: 'Accept friend invitation', exact: true }).click();
    await expect(b.locator('main')).toHaveAttribute('aria-busy', 'false');
    await ca.close();
    const next = await restored.newPage();
    await next.goto('/');
    await next.getByLabel('Your home’s address').fill(state.url);
    await next.getByLabel('Username', { exact: true }).fill(member.username);
    await next.getByLabel('Password', { exact: true }).fill(member.password);
    await next.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(next.getByLabel('Recovery key', { exact: true })).toBeVisible({ timeout: 65_000 });
    const check = () =>
      b
        .locator('.friends-list li')
        .filter({ has: b.getByText(alice.userId, { exact: true }) })
        .getByRole('button', { name: 'Check identity', exact: true })
        .click();
    await check();
    await expect(next.locator('#notice')).toContainText('Open your memories first', {
      timeout: 30_000,
    });
    await expect(next.locator('#verification')).not.toBeVisible();
    await expect(b.locator('#verification')).not.toBeVisible({ timeout: 30_000 });
    await recover(next, member);
    await b.getByRole('button', { name: 'Friends', exact: true }).click();
    await check();
    await next
      .getByRole('button', { name: 'Accept identity check', exact: true })
      .click({ timeout: 30_000 });
    await b.getByRole('button', { name: 'Show comparison', exact: true }).click();
    await expect(next.getByRole('button', { name: 'They match', exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(b.getByRole('button', { name: 'They match', exact: true })).toBeVisible({
      timeout: 30_000,
    });
    expect(await next.locator('.sas').innerText()).toBe(await b.locator('.sas').innerText());
    await next.getByRole('button', { name: 'They match', exact: true }).click();
    await b.getByRole('button', { name: 'They match', exact: true }).click();
    await expect(next.locator('#verification')).not.toBeVisible({ timeout: 65_000 });
    await expect(b.locator('#verification')).not.toBeVisible({ timeout: 65_000 });
    await next.getByRole('button', { name: 'News feed', exact: true }).click();
    await next.locator('#refresh-book').click();
    await expect(
      next.getByRole('checkbox', { name: `${bob.userId} · identity checked`, exact: true }),
    ).toBeEnabled();
  } finally {
    await ca.close();
    await cb.close();
    await restored.close();
  }
});

test('[delta] wrong recovery kit leaves a healthy saved browser open after reload', async ({
  page,
}) => {
  const member = await joinMember(page);
  await finishSetup(page);
  await saveMemory(page, 'SYNTHETIC_HEALTHY_WRONG_KIT');
  const saved = await session(page),
    signing = await master(saved);
  const progressKey =
    'clean-bookface.restore-pending.v1:' +
    [saved.baseUrl, saved.userId, saved.deviceId].map(encodeURIComponent).join(':');
  const { encodeRecoveryKey } = await import('matrix-js-sdk/lib/crypto-api/recovery-key.js');
  for (const bad of ['mistyped kit', encodeRecoveryKey(new Uint8Array(32).fill(17))!]) {
    await page.getByRole('button', { name: 'My account', exact: true }).click();
    await page.getByRole('button', { name: 'Use my recovery kit again', exact: true }).click();
    await page.getByLabel('Recovery key', { exact: true }).fill(bad);
    await page.getByLabel('Account password', { exact: true }).fill(member.password);
    await page.getByRole('button', { name: 'Open my memories', exact: true }).click();
    await expect(page.locator('#notice.error')).toBeVisible();
    expect(await page.evaluate((key) => localStorage.getItem(key), progressKey)).toBeNull();
    await page.reload();
    await ready(page);
    await page.getByRole('button', { name: 'My memories', exact: true }).click();
    await expect(
      page.locator('.post-body').filter({ hasText: 'SYNTHETIC_HEALTHY_WRONG_KIT' }),
    ).toBeVisible();
    expect(await master(saved)).toEqual(signing);
  }
});

test('[delta] in-app signout observes an invalid token without silently losing unbacked keys', async ({
  page,
}) => {
  await joinMember(page);
  await finishSetup(page);
  await page.route('**/room_keys/keys?*', (route) =>
    route.request().method() === 'PUT'
      ? route.fulfill({
          status: 400,
          json: { errcode: 'M_BAD_JSON', error: 'Synthetic unavailable backup upload' },
        })
      : route.continue(),
  );
  const encryptedSent = page.waitForResponse(
    (response) => response.url().includes('/send/m.room.encrypted/') && response.ok(),
  );
  await saveMemory(page, 'SYNTHETIC_UNBACKED_ENDED_SESSION', false);
  await encryptedSent;
  const saved = await session(page);
  let invalidBackupResponses = 0;
  page.on('response', (response) => {
    if (response.url().includes('/room_keys/version') && response.status() === 401)
      invalidBackupResponses++;
  });
  await api(saved, 'POST', '/logout', {});
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false', { timeout: 65_000 });
  await page.getByRole('button', { name: 'My account', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out of this browser', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Your home has ended this browser session', exact: true }),
  ).toBeVisible();
  expect(invalidBackupResponses).toBeGreaterThan(0);
  expect(await session(page)).toEqual(saved);
  const prefix = `clean-bookface:${saved.baseUrl}:${saved.userId}:${saved.deviceId}`;
  expect(
    await page.evaluate(
      async (prefix) =>
        (await indexedDB.databases()).filter((db) => db.name?.startsWith(prefix)).length,
      prefix,
    ),
  ).toBeGreaterThan(0);
  const end = page.getByRole('button', { name: 'End this browser session', exact: true });
  await end.click();
  await expect(page.locator('#notice.error')).toBeVisible();
  expect(await session(page)).toEqual(saved);
  await page.locator('#confirm-ended-session-removal').check();
  await end.click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  expect(await page.evaluate((key) => localStorage.getItem(key), SESSION)).toBeNull();
  expect(
    await page.evaluate(
      async (prefix) =>
        (await indexedDB.databases()).filter((db) => db.name?.startsWith(prefix)).length,
      prefix,
    ),
  ).toBe(0);
});

test('[delta] network backup failure keeps a valid in-app session and its keys', async ({
  page,
}) => {
  await joinMember(page);
  await finishSetup(page);
  await saveMemory(page, 'SYNTHETIC_VALID_NETWORK_FAILURE');
  const saved = await session(page);
  await page.route('**/room_keys/version', (route) => route.abort('connectionrefused'));
  await page.route('**/account/whoami', (route) => route.abort('connectionrefused'));
  await page.getByRole('button', { name: 'My account', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out of this browser', exact: true }).click();
  await expect(page.locator('#notice.error')).toBeVisible();
  expect(await session(page)).toEqual(saved);
  await expect(page.getByRole('heading', { name: 'Your account', exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'End this browser session', exact: true }),
  ).toHaveCount(0);
  expect((await api(saved, 'GET', '/account/whoami')).user_id).toBe(saved.userId);
  const prefix = `clean-bookface:${saved.baseUrl}:${saved.userId}:${saved.deviceId}`;
  expect(
    await page.evaluate(
      async (prefix) =>
        (await indexedDB.databases()).filter((db) => db.name?.startsWith(prefix)).length,
      prefix,
    ),
  ).toBeGreaterThan(0);
});
