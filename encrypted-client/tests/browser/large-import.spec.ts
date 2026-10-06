import { test, expect, type Page } from '@playwright/test';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { largeArchiveFixture } from '../large-archive-fixture';
import { importArchives } from '../../src/archive';

const runtime = process.env.CBF_LARGE_BROWSER_RUNTIME;
test.skip(
  !runtime,
  'Large import qualification requires an explicitly selected disposable runtime.',
);

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function ready(page: Page, selector: string) {
  await Promise.race([
    page.locator(selector).waitFor({ state: 'visible', timeout: 65_000 }),
    page
      .locator('#notice.error')
      .waitFor({ state: 'visible', timeout: 65_000 })
      .then(async () => {
        throw new Error(await page.locator('#notice').innerText());
      }),
  ]);
}
test('one GiB Facebook import survives encrypted batch storage and clean-browser recovery with exact exported parts', async ({
  browser,
}) => {
  test.setTimeout(900_000);
  const state = JSON.parse(await readFile(join(runtime!, 'state.json'), 'utf8'));
  if (state.mode !== 'local') throw new Error('Large import qualification refuses nonlocal hosts');
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
  const invitation = JSON.parse(await readFile(join(runtime!, 'invitation.json'), 'utf8'));
  const account = { username: `large_${Date.now().toString(36)}`, password: randomUUID() };
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'cbf-ui-large-'));
  const first = await browser.newContext(),
    restored = await browser.newContext();
  const system = await browser.newBrowserCDPSession();
  let peakBrowserRss = 0,
    sampling = false;
  const sample = async () => {
    if (sampling) return;
    sampling = true;
    try {
      const info = await system.send('SystemInfo.getProcessInfo');
      const pids = info.processInfo
        .map((p: { id: number }) => p.id)
        .filter((id: number) => Number.isSafeInteger(id) && id > 0);
      const rss =
        execFileSync('ps', ['-o', 'rss=', '-p', pids.join(',')], { encoding: 'utf8' })
          .trim()
          .split(/\s+/)
          .reduce((n, v) => n + Number(v), 0) * 1024;
      peakBrowserRss = Math.max(peakBrowserRss, rss);
    } catch {
      /* A process can exit between the browser and OS snapshots. */
    } finally {
      sampling = false;
    }
  };
  const timer = setInterval(() => void sample(), 1000);
  const started = Date.now();
  const searchLeaks: string[] = [];
  for (const context of [first, restored])
    context.on('request', (request) => {
      if (
        request.url().startsWith(state.url) &&
        request.url().includes('SYNTHETIC_LARGE_IMPORT_42')
      )
        searchLeaks.push(request.url());
    });
  try {
    const fixture = await largeArchiveFixture(fixtureRoot, 1024 ** 3);
    const login = async (page: Page, recovery?: string) => {
      await page.goto(
        recovery ? '/' : '/#' + new URLSearchParams({ home: state.url, invite: invitation.token }),
      );
      await page.getByLabel('Your home’s address').fill(state.url);
      await page.getByLabel('Username', { exact: true }).fill(account.username);
      await page.getByLabel('Password', { exact: true }).fill(account.password);
      await page
        .getByRole('button', { name: recovery ? 'Sign in' : 'Create my account', exact: true })
        .click();
      await ready(page, recovery ? '#recovery-key' : 'button:has-text("Make my recovery kit")');
      if (recovery) {
        await page.getByLabel('Recovery key', { exact: true }).fill(recovery);
        await page.getByRole('button', { name: 'Open my memories', exact: true }).click();
      } else {
        await page.getByRole('button', { name: 'Make my recovery kit', exact: true }).click();
        recovery = await page.getByLabel('Your recovery key', { exact: true }).inputValue();
        await page
          .getByLabel('Type the last 6 characters')
          .fill(recovery.replace(/\s/g, '').slice(-6));
        await page.getByRole('button', { name: 'I saved it. Open my book.', exact: true }).click();
      }
      await ready(page, '#section-memories');
      return recovery!;
    };
    const page = await first.newPage(),
      key = await login(page);
    await page.getByRole('button', { name: 'My memories', exact: true }).click();
    const archivePicker = page.getByLabel('Choose archive ZIP files');
    await expect(archivePicker).toBeEnabled();
    await archivePicker.setInputFiles(fixture.path);
    await page.getByRole('button', { name: 'Bring in my memories', exact: true }).click();
    await expect(page.locator('#notice')).toContainText(
      '64 memories imported privately in 13 parts. Recovery checked.',
      { timeout: 600_000 },
    );
    await expect(page.locator('#notice.error')).toHaveCount(0);
    console.log('LARGE_IMPORT_PROOF import-complete');
    const listParts = async (target: Page) => {
      const show = target.getByRole('button', { name: 'Show saved imports', exact: true });
      if (!(await show.isVisible()))
        await target.getByText('Download my saved imports separately', { exact: true }).click();
      await show.click();
      await expect(
        target.getByRole('button', { name: 'View saved import 13', exact: true }),
      ).toBeVisible();
    };
    await listParts(page);
    await page.getByRole('button', { name: 'View saved import 13', exact: true }).click();
    await expect(
      page.locator('.post-body').filter({ hasText: 'SYNTHETIC_LARGE_IMPORT_63' }),
    ).toBeVisible();
    await page.getByLabel('Find a memory').fill('SYNTHETIC_LARGE_IMPORT_42');
    await page.getByRole('button', { name: 'Search every saved import', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Open this saved part', exact: true }),
    ).toBeVisible({ timeout: 120_000 });
    await page.getByRole('button', { name: 'Open this saved part', exact: true }).click();
    await expect(
      page.locator('.post-body').filter({ hasText: 'SYNTHETIC_LARGE_IMPORT_42' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'My account', exact: true }).click();
    await page.getByRole('button', { name: 'Sign out of this browser', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await first.close();
    const recovered = await restored.newPage();
    await login(recovered, key);
    await recovered.getByRole('button', { name: 'My memories', exact: true }).click();
    await listParts(recovered);
    // List while the background preview can still be loading; its final render
    // must retain every listed download instead of collapsing/resetting the list.
    await expect(recovered.getByLabel('Choose archive ZIP files')).toBeEnabled({ timeout: 60_000 });
    await expect(
      recovered.getByRole('button', { name: /^Download saved import \d+$/ }),
    ).toHaveCount(13);
    console.log('LARGE_IMPORT_PROOF clean-recovery-parts-listed');
    let exportedBytes = 0,
      count = 0;
    for (let part = 1; part <= 13; part++) {
      console.log(`LARGE_IMPORT_PROOF download-start part=${part}`);
      const pending = recovered.waitForEvent('download', { timeout: 60_000 });
      await recovered
        .getByRole('button', { name: `Download saved import ${part}`, exact: true })
        .click();
      const download = await pending,
        path = await download.path();
      expect(path).not.toBeNull();
      const result = await importArchives([new File([await readFile(path!)], 'part.zip')]);
      for (const record of result.records) {
        const expected = fixture.expected.get(record.id);
        expect(expected).toBeDefined();
        fixture.expected.delete(record.id);
        expect(record.text).toBe(expected!.text);
        expect(record.attachments).toHaveLength(1);
        const attachment = record.attachments[0];
        expect(attachment.path).toBe(expected!.path);
        expect(attachment.bytes.size).toBe(expected!.size);
        expect(sha(new Uint8Array(await attachment.bytes.arrayBuffer()))).toBe(expected!.sha256);
        count++;
        exportedBytes += attachment.bytes.size;
      }
      await download.delete();
      await expect(
        recovered.getByRole('button', { name: /^Download saved import \d+$/ }),
      ).toHaveCount(13);
      console.log(`LARGE_IMPORT_PROOF download-verified part=${part}`);
    }
    expect(searchLeaks).toEqual([]);
    expect(count).toBe(64);
    expect(exportedBytes).toBe(1024 ** 3);
    expect(fixture.expected.size).toBe(0);
    await sample();
    expect(peakBrowserRss).toBeGreaterThan(0);
    await writeFile(
      join(runtime!, 'large-browser-result.json'),
      JSON.stringify(
        {
          inputZipBytes: fixture.zipBytes,
          mediaBytes: exportedBytes,
          records: count,
          parts: 13,
          peakBrowserRss,
          elapsedMs: Date.now() - started,
          scope:
            'one GiB actual browser import, encrypted storage, original-device deletion, kit recovery and exact exported media hashes',
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  } finally {
    clearInterval(timer);
    await first.close();
    await restored.close();
    await system.detach();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
