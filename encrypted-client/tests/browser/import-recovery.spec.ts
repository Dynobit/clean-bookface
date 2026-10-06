import { test, expect, type Page } from '@playwright/test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { legacyFixture } from '../legacy-fixture';
import { importArchives, type MemoryRecord } from '../../src/archive';
const runtime = process.env.CBF_TEST_HOST_RUNTIME;
if (!runtime) throw new Error('Disposable local CBF_TEST_HOST_RUNTIME required');
async function ready(page: Page, selector: string) {
  await Promise.race([
    page.locator(selector).waitFor({ state: 'visible', timeout: 65000 }),
    page
      .locator('#notice.error')
      .waitFor({ state: 'visible', timeout: 65000 })
      .then(async () => {
        throw new Error(await page.locator('#notice').innerText());
      }),
  ]);
}
async function exact(records: MemoryRecord[]) {
  return Promise.all(
    records
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(async ({ attachments, ...record }) => ({
        ...record,
        attachments: await Promise.all(
          attachments.map(async ({ bytes, ...attachment }) => ({
            ...attachment,
            sha256: createHash('sha256')
              .update(new Uint8Array(await bytes.arrayBuffer()))
              .digest('hex'),
          })),
        ),
      })),
  );
}
test('default OPFS nested migration cleans cancelled ciphertext and resumes through clean-browser recovery', async ({
  browser,
}) => {
  test.setTimeout(240000);
  const state = JSON.parse(await readFile(join(runtime!, 'state.json'), 'utf8'));
  if (state.mode !== 'local') throw new Error('Import recovery refuses nonlocal homes');
  execFileSync(
    'python3',
    [
      fileURLToPath(new URL('../../../encrypted-host/host.py', import.meta.url)),
      'invite',
      '--runtime',
      runtime!,
    ],
    { stdio: 'pipe', timeout: 30000 },
  );
  const invitation = JSON.parse(await readFile(join(runtime!, 'invitation.json'), 'utf8'));
  const account = {
    username: `import_recovery_${Date.now().toString(36)}`,
    password: randomUUID(),
  };
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'cbf-opfs-import-'));
  const first = await browser.newContext(),
    restored = await browser.newContext();
  try {
    console.log('IMPORT_PROOF fixture-start');
    const { file } = await legacyFixture(fixtureRoot),
      expected = await importArchives([file]);
    console.log('IMPORT_PROOF fixture-ready');
    // Observe real browser filesystem writes; do not replace openTemporaryFile or OPFS.
    // Pause only after the committed scratch file can be inspected on disk.
    await first.addInitScript(() => {
      const probe = {
        hold: true,
        staged: 0,
        removed: 0,
        bytes: 0,
        plaintext: false,
        release: undefined as undefined | (() => void),
      };
      (window as any).__opfsImportProbe = probe;
      const originalCreate = FileSystemFileHandle.prototype.createWritable;
      FileSystemFileHandle.prototype.createWritable = async function (...args) {
        const handle = this,
          stream = await originalCreate.apply(this, args);
        if (!/^import-[a-f0-9-]+$/.test(handle.name)) return stream;
        const originalGetWriter = stream.getWriter.bind(stream);
        stream.getWriter = () => {
          const writer = originalGetWriter(),
            originalClose = writer.close.bind(writer);
          writer.close = async () => {
            await originalClose();
            const blob = await handle.getFile(),
              bytes = new Uint8Array(await blob.arrayBuffer());
            const text = new TextDecoder().decode(bytes);
            probe.staged++;
            probe.bytes += bytes.length;
            probe.plaintext ||=
              text.includes('Earlier memory') ||
              text.includes('Revised memory') ||
              text.includes('Native publication') ||
              text.includes('manifest.json') ||
              (bytes[0] === 80 && bytes[1] === 75 && bytes[2] === 3 && bytes[3] === 4);
            if (probe.hold)
              await new Promise<void>((resolve) => {
                probe.release = resolve;
              });
          };
          return writer;
        };
        return stream;
      };
      const originalRemove = FileSystemDirectoryHandle.prototype.removeEntry;
      FileSystemDirectoryHandle.prototype.removeEntry = async function (name, options) {
        const result = await originalRemove.call(this, name, options);
        if (/^import-[a-f0-9-]+$/.test(name)) probe.removed++;
        return result;
      };
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
    console.log('IMPORT_PROOF account-ready');
    const stagingFiles = () =>
      page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const directory = await root.getDirectoryHandle('clean-bookface-import-staging', {
          create: true,
        });
        const names = [];
        for await (const name of (directory as any).keys()) names.push(name);
        return names.filter((name: string) => name.startsWith('import-'));
      });
    await page.getByRole('button', { name: 'My memories', exact: true }).click();
    // Use the actual old application's HTTP export, including its private-archive.zip.
    const upload = {
      name: 'nested-legacy-account.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(await file.arrayBuffer()),
    };
    await page.getByLabel('Choose archive ZIP files').setInputFiles(upload);
    await page.getByRole('button', { name: 'Bring in my memories', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__opfsImportProbe.staged)).toBe(1);
    console.log('IMPORT_PROOF scratch-paused');
    expect(await stagingFiles()).toHaveLength(1);
    const probe = await page.evaluate(() => {
      const p = (window as any).__opfsImportProbe;
      return { bytes: p.bytes, plaintext: p.plaintext };
    });
    expect(probe.bytes).toBeGreaterThan(16);
    expect(probe.plaintext).toBe(false);
    await page.getByRole('button', { name: 'Stop after this part', exact: true }).click();
    await page.evaluate(() => {
      const p = (window as any).__opfsImportProbe;
      p.hold = false;
      p.release();
    });
    await expect(page.locator('#notice')).toContainText('Import stopped.', { timeout: 30000 });
    await expect.poll(stagingFiles).toEqual([]);
    console.log('IMPORT_PROOF scratch-clean');
    expect(await page.evaluate(() => (window as any).__opfsImportProbe.removed)).toBe(1);
    await page.getByLabel('Choose archive ZIP files').setInputFiles(upload);
    await page.getByRole('button', { name: 'Bring in my memories', exact: true }).click();
    await expect(page.locator('#notice')).toContainText('4 memories imported privately', {
      timeout: 60000,
    });
    await expect.poll(stagingFiles).toEqual([]);
    console.log('IMPORT_PROOF scratch-clean');
    expect(await page.evaluate(() => (window as any).__opfsImportProbe.staged)).toBe(2);
    expect(await page.evaluate(() => (window as any).__opfsImportProbe.removed)).toBe(2);
    for (const record of expected.records)
      await expect(page.locator('.post-body').filter({ hasText: record.text })).toBeVisible();
    await page.getByRole('button', { name: 'My account', exact: true }).click();
    await page.getByRole('button', { name: 'Sign out of this browser', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible({
      timeout: 30000,
    });
    await first.close();
    const recovered = await restored.newPage();
    await login(recovered, key);
    console.log('IMPORT_PROOF recovered');
    await recovered.getByRole('button', { name: 'My memories', exact: true }).click();
    console.log('IMPORT_PROOF memories-open');
    for (const record of expected.records)
      await expect(recovered.locator('.post-body').filter({ hasText: record.text })).toBeVisible({
        timeout: 30000,
      });
    console.log('IMPORT_PROOF restored-records-visible');
    const pending = recovered.waitForEvent('download', { timeout: 30000 });
    await recovered.getByRole('button', { name: 'Download my archive', exact: true }).click();
    console.log('IMPORT_PROOF export-clicked');
    const download = await pending,
      path = await download.path();
    expect(path).not.toBeNull();
    console.log('IMPORT_PROOF download-received');
    const actual = await importArchives([new File([await readFile(path!)], 'recovered.zip')]);
    console.log('IMPORT_PROOF export-parsed');
    expect(await exact(actual.records)).toEqual(await exact(expected.records));
    console.log('IMPORT_PROOF records-equal');
  } finally {
    await first.close();
    await restored.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
