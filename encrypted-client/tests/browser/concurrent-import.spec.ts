import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { exportArchives, importArchives, type MemoryRecord } from '../../src/archive';

const runtime = process.env.CBF_TEST_HOST_RUNTIME;
test.skip(!runtime, 'Requires a disposable local encrypted host.');

test('two verified devices retain both simultaneous first imports and complete exports', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const state = JSON.parse(readFileSync(join(runtime!, 'state.json'), 'utf8'));
  if (state.mode !== 'local' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(state.url))
    throw new Error('Only disposable local loopback hosts are permitted.');
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
  const username = 'race_' + Date.now().toString(36),
    password = randomUUID();
  const contexts = [await browser.newContext(), await browser.newContext()];
  try {
    const pages = await Promise.all(contexts.map((c) => c.newPage()));
    const [a, b] = pages;
    await a.goto('/#' + new URLSearchParams({ home: state.url, invite: invitation.token }));
    await a.getByLabel('Username', { exact: true }).fill(username);
    await a.getByLabel('Password', { exact: true }).fill(password);
    await a.getByRole('button', { name: 'Create my account', exact: true }).click();
    await a.getByRole('button', { name: 'Make my recovery kit', exact: true }).click();
    const key = await a.getByLabel('Your recovery key', { exact: true }).inputValue();
    writeFileSync(
      join(runtime!, `concurrent-import-${username}.json`),
      JSON.stringify({ username, password, key }),
      { mode: 0o600 },
    );
    await a.getByLabel('Type the last 6 characters').fill(key.replace(/\s/g, '').slice(-6));
    await a.getByRole('button', { name: 'I saved it. Open my book.', exact: true }).click();
    await expect(a.getByRole('heading', { name: 'What’s on your mind?' })).toBeVisible({
      timeout: 60_000,
    });
    await b.goto('/');
    await b.getByLabel('Your home’s address').fill(state.url);
    await b.getByLabel('Username', { exact: true }).fill(username);
    await b.getByLabel('Password', { exact: true }).fill(password);
    await b.getByRole('button', { name: 'Sign in', exact: true }).click();
    await b.getByLabel('Recovery key', { exact: true }).fill(key);
    await b.getByRole('button', { name: 'Open my memories', exact: true }).click();
    await expect(b.getByRole('heading', { name: 'What’s on your mind?' })).toBeVisible({
      timeout: 60_000,
    });

    // Neither createRoom request may reach the server until BOTH devices have
    // independently decided to create their first private archive room.
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const arrived = new Set<number>();
    const roomIds = new Set<string>();
    await Promise.all(
      pages.map(async (page, index) => {
        page.on('response', async (response) => {
          if (
            response.url().endsWith('/_matrix/client/v3/createRoom') &&
            response.request().method() === 'POST' &&
            response.ok()
          ) {
            const body = await response.json();
            roomIds.add(body.room_id);
          }
        });
        await page.route('**/_matrix/client/v3/createRoom', async (route) => {
          if (route.request().method() !== 'POST') return route.continue();
          arrived.add(index);
          if (arrived.size === 2) release();
          await barrier;
          await route.continue();
        });
      }),
    );
    const records: MemoryRecord[] = [0, 1].map((index) => ({
      id: `${username}-${index}`,
      kind: 'post',
      timestamp: 1000 + index,
      text: `SYNTHETIC_CONCURRENT_IMPORT_${username}_${index}`,
      title: 'A fictional memory',
      sourcePath: '',
      attachments: [],
      privateOnly: false,
    }));
    await Promise.all(
      pages.map(async (page, index) => {
        const zip = await exportArchives([records[index]]);
        await page.getByRole('button', { name: 'My memories', exact: true }).click();
        await page.getByLabel('Choose archive ZIP files').setInputFiles({
          name: 'fictional.zip',
          mimeType: 'application/zip',
          buffer: Buffer.from(await zip.arrayBuffer()),
        });
        await page.getByRole('button', { name: 'Bring in my memories', exact: true }).click();
      }),
    );
    await expect.poll(() => arrived.size, { timeout: 30_000 }).toBe(2);
    await expect.poll(() => roomIds.size, { timeout: 30_000 }).toBe(2);
    for (const [index, page] of pages.entries()) {
      await expect(page.locator('.post-body').filter({ hasText: records[index].text })).toBeVisible(
        { timeout: 60_000 },
      );
    }
    for (const page of pages) {
      await expect(async () => {
        await page.getByRole('button', { name: 'Refresh my book', exact: true }).click();
        for (const record of records)
          await expect(page.locator('.post-body').filter({ hasText: record.text })).toBeVisible({
            timeout: 2000,
          });
      }).toPass({ timeout: 30_000, intervals: [500, 1000, 2000] });
      await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false', { timeout: 30000 });
      const pendingDownload = page.waitForEvent('download', { timeout: 30000 });
      await page.getByRole('button', { name: 'Download my archive', exact: true }).first().click();
      const download = await pendingDownload;
      const path = await download.path();
      if (!path) throw new Error('Archive download did not complete.');
      const restored = await importArchives([
        new File([new Uint8Array(readFileSync(path))], 'complete.zip'),
      ]);
      expect(restored.records.map((record) => record.id).sort()).toEqual(
        records.map((record) => record.id).sort(),
      );
      expect(restored.records.map((record) => record.text).sort()).toEqual(
        records.map((record) => record.text).sort(),
      );
    }
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
