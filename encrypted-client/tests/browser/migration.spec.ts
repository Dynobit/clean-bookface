import { test, expect, type Page } from '@playwright/test';
import { readFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { legacyFixture } from '../legacy-fixture';
import { importArchives, type MemoryRecord } from '../../src/archive';

const runtime = process.env.CBF_TEST_HOST_RUNTIME;
if (!runtime) throw new Error('Disposable local CBF_TEST_HOST_RUNTIME required');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function exactRecords(records: MemoryRecord[]) {
  return Promise.all(
    records
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(async ({ attachments, ...r }) => ({
        ...r,
        attachments: await Promise.all(
          attachments.map(async ({ bytes, ...a }) => ({
            ...a,
            sha256: sha(new Uint8Array(await bytes.arrayBuffer())),
          })),
        ),
      })),
  );
}
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
test('actual legacy HTTP export survives encrypted browser migration, device deletion and recovery with exact original records', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const state = JSON.parse(await readFile(join(runtime!, 'state.json'), 'utf8'));
  if (state.mode !== 'local') throw new Error('Migration test refuses nonlocal hosts');
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
  const account = { username: `migration_${Date.now().toString(36)}`, password: randomUUID() };
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'cbf-ui-legacy-'));
  const first = await browser.newContext(),
    restored = await browser.newContext();
  try {
    const { file, items, media } = await legacyFixture(fixtureRoot);
    const expected = await importArchives([file]);
    expect(expected.records).toHaveLength(items.length + 3);
    expect(expected.records.find((r) => r.id === items[0].id)?.text).toBe(items[0].body);
    expect(new Set(expected.records.map((r) => r.text))).toEqual(
      new Set([
        'Earlier memory Café שלום',
        'Revised memory Café שלום',
        'Native publication',
        'Native comment',
      ]),
    );
    const leaked: string[] = [];
    for (const context of [first, restored])
      context.on('request', (request) => {
        if (!request.url().startsWith(state.url)) return;
        const bytes = request.postDataBuffer();
        if (bytes && expected.records.some((r) => bytes.includes(Buffer.from(r.text))))
          leaked.push(new URL(request.url()).pathname);
        if (bytes && bytes.includes(media)) leaked.push('original-image-bytes');
      });
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
      await Promise.race([
        page
          .getByRole('button', { name: 'My memories', exact: true })
          .waitFor({ state: 'visible', timeout: 65000 }),
        page
          .locator('#notice.error')
          .waitFor({ state: 'visible', timeout: 65000 })
          .then(async () => {
            throw new Error(await page.locator('#notice').innerText());
          }),
      ]);
      return recovery!;
    };
    const page = await first.newPage(),
      key = await login(page);
    await page.getByRole('button', { name: 'My memories', exact: true }).click();
    await page.getByLabel('Choose archive ZIP files').setInputFiles({
      name: 'legacy-account.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(await file.arrayBuffer()),
    });
    await page.getByRole('button', { name: 'Bring in my memories', exact: true }).click();
    await expect(page.locator('#notice')).toContainText('4 memories imported privately', {
      timeout: 60_000,
    });
    for (const r of expected.records)
      await expect(page.locator('.post-body').filter({ hasText: r.text })).toBeVisible();
    await page.getByRole('button', { name: 'My account', exact: true }).click();
    await page.getByRole('button', { name: 'Sign out of this browser', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await first.close();
    const recovered = await restored.newPage();
    await login(recovered, key);
    await recovered.getByRole('button', { name: 'My memories', exact: true }).click();
    for (const r of expected.records)
      await expect(recovered.locator('.post-body').filter({ hasText: r.text })).toBeVisible({
        timeout: 30_000,
      });
    const pending = recovered.waitForEvent('download');
    await recovered.getByRole('button', { name: 'Download my archive', exact: true }).click();
    const download = await pending,
      path = await download.path();
    expect(path).not.toBeNull();
    const result = await importArchives([new File([await readFile(path!)], 'recovered.zip')]);
    expect(await exactRecords(result.records)).toEqual(await exactRecords(expected.records));
    const current = result.records.find((r) => r.id === items[0].id)!;
    expect(sha(new Uint8Array(await current.attachments[0].bytes.arrayBuffer()))).toBe(sha(media));
    expect(leaked).toEqual([]);
    const compose = ['compose', '-p', state.project, '-f', join(runtime!, 'compose.json')];
    if (!/^cbf-e2ee-[a-f0-9]{10}$/.test(state.project))
      throw new Error('Invalid disposable project');
    const dump = execFileSync(
      'docker',
      [...compose, 'exec', '-T', 'postgres', 'pg_dump', '-U', 'synapse', '-d', 'synapse'],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    const logs = execFileSync('docker', [...compose, 'logs', '--no-color'], {
      maxBuffer: 16 * 1024 * 1024,
    });
    const assertCiphertext = (bytes: Buffer) => {
      for (const marker of [
        'Earlier memory',
        'Revised memory',
        'Native publication',
        'Native comment',
      ])
        expect(bytes.includes(Buffer.from(marker))).toBe(false);
      expect(bytes.includes(media)).toBe(false);
    };
    assertCiphertext(dump);
    assertCiphertext(logs);
    const mediaRoot = join(runtime!, 'synapse', 'media_store');
    for (const entry of await readdir(mediaRoot, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) assertCiphertext(await readFile(join(entry.parentPath, entry.name)));
    }
  } finally {
    await first.close();
    await restored.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
