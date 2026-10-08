import { test, expect } from '@playwright/test';
import { BlobReader, BlobWriter, ZipWriter } from '@zip.js/zip.js';
import { readFile } from 'node:fs/promises';
import { importArchives } from '../../src/archive.js';
async function zip(entries: Array<[string, string | Blob]>) {
  const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
  for (const [name, value] of entries)
    await writer.add(name, new BlobReader(typeof value === 'string' ? new Blob([value]) : value), {
      level: 0,
    });
  return Buffer.from(await (await writer.close()).arrayBuffer());
}
test('sample search, photo, filters, keyboard, mobile and lifecycle clearing', async ({ page }) => {
  await page.goto('/book.html');
  await expect(page.locator('#count')).toHaveText('6 of 6 memories');
  // Reach the native file input through keyboard navigation, not a scripted focus.
  for (let step = 0; step < 15; step++) {
    await page.keyboard.press('Tab');
    if (await page.locator('#files').evaluate((input) => input === document.activeElement)) break;
  }
  await expect(page.locator('#files')).toBeFocused();
  expect(await page.locator('#files').evaluate((input) => input.matches(':focus-visible'))).toBe(
    true,
  );
  await expect(page.locator('label[for="files"]')).toHaveCSS('outline-style', 'solid');
  await expect(page.locator('label[for="files"]')).toHaveCSS('outline-width', '3px');
  await expect(page.locator('label[for="files"]')).toHaveCSS('outline-color', 'rgb(213, 135, 40)');
  const chooserOpened = page.waitForEvent('filechooser');
  await page.keyboard.press('Enter');
  const chooser = await chooserOpened;
  expect(chooser.isMultiple()).toBe(true);
  await chooser.setFiles([]);
  await expect(page.locator('#files')).toHaveValue('');
  await expect(page.locator('#mode')).toContainText('THE SAMPLE BOOK');
  await expect(page.locator('#count')).toHaveText('6 of 6 memories');
  await expect(page.locator('#status')).toBeEmpty();

  await expect(
    page.getByRole('button', { name: 'Cancel opening', includeHidden: true }),
  ).toBeHidden();
  await expect(page.locator('.memory-photo')).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator('.memory-photo')
        .evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0),
    )
    .toBe(true);
  await page.getByRole('button', { name: 'Open photo: A little room to breathe' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('#photo-large')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Open photo: A little room to breathe' }),
  ).toBeFocused();
  await page.getByLabel('Search memories').fill('tomatoes');
  await expect(page.locator('.memory')).toHaveCount(1);
  await page.getByLabel('Search memories').fill('');
  await page.getByRole('button', { name: /^Messages/ }).click();
  await expect(page.locator('.memory')).toHaveCount(1);
  await expect(page.locator('.memory')).toContainText('Private conversation');
  await page.getByRole('button', { name: 'Clear book', exact: true }).click();
  await expect(page.locator('#count')).toHaveText('0 of 0 memories');
  await page.getByRole('button', { name: 'Return to sample' }).click();
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByLabel('Search memories').focus();
  await page.keyboard.type('pasta');
  await expect(page.locator('.memory')).toHaveCount(1);
  await page.getByLabel('Search memories').fill('');
  await page.getByRole('button', { name: 'Open photo: A little room to breathe' }).click();
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })),
  );
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.locator('#photo-large')).not.toHaveAttribute('src');
  await expect(page.locator('.memory-photo')).toHaveCount(0);
  await expect(page.locator('#count')).toHaveText('0 of 0 memories');
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
  );
  await expect(page.locator('#count')).toHaveText('0 of 0 memories');
});
test('multipart malicious text stays inert, warnings, no network/storage, portable exact roundtrip', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const deny = () => {
      throw new Error('Persistent storage forbidden');
    };
    Storage.prototype.setItem = deny;
    IDBFactory.prototype.open = deny;
    if (navigator.storage) navigator.storage.getDirectory = deny;
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/book.html');
  await expect(page.locator('#count')).toHaveText('6 of 6 memories');
  await expect(
    page.getByRole('button', { name: 'Cancel opening', includeHidden: true }),
  ).toBeHidden();
  const requests: string[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith('blob:') && !r.url().startsWith('data:')) requests.push(r.url());
  });
  const hostile = '<img src="https://example.invalid/leak" onerror="alert(1)"> private-needle';
  const png = new Blob([await readFile(new URL('../../src/sample-weekend.png', import.meta.url))], {
    type: 'image/png',
  });
  const first = await zip([
    [
      'posts/your_posts_1.json',
      JSON.stringify([
        {
          timestamp: 1700000000,
          data: [{ post: hostile }],
          attachments: [
            { uri: 'photos/memory.png' },
            { uri: 'https://example.invalid/private-needle' },
          ],
        },
      ]),
    ],
    ['unknown.json', '{"unsupported":true}'],
  ]);
  const second = await zip([['photos/memory.png', png]]);
  const expected = await importArchives([
    new File([first], 'part1.zip'),
    new File([second], 'part2.zip'),
  ]);
  await page.locator('#files').setInputFiles([
    { name: 'part1.zip', mimeType: 'application/zip', buffer: first },
    { name: 'part2.zip', mimeType: 'application/zip', buffer: second },
  ]);
  await expect(page.locator('#mode')).toHaveText('YOUR TEMPORARY ARCHIVE');
  await expect(page.locator('.memory-text')).toHaveText(hostile);
  await expect(page.locator('.memory-text img')).toHaveCount(0);
  await expect(page.locator('.memory-photo')).toBeVisible();
  await expect(page.locator('#warnings')).toContainText('import warnings');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export book', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('clean-bookface-book.zip');
  const exported = await readFile((await download.path())!);
  const restored = await importArchives([new File([exported], 'book.zip')]);
  expect(restored.records.map(({ attachments, ...r }) => r)).toEqual(
    expected.records.map(({ attachments, ...r }) => r),
  );
  expect(Buffer.from(await restored.records[0].attachments[0].bytes.arrayBuffer())).toEqual(
    Buffer.from(await png.arrayBuffer()),
  );
  await page.getByRole('button', { name: 'Clear book', exact: true }).click();
  await page
    .locator('#files')
    .setInputFiles({ name: 'book.zip', mimeType: 'application/zip', buffer: exported });
  await expect(page.locator('.memory-text')).toHaveText(hostile);
  const traversal = await zip([
    [
      'posts/your_posts_1.json',
      JSON.stringify([
        { data: [{ post: 'Rejected traversal' }], attachments: [{ uri: '../private-needle.png' }] },
      ]),
    ],
  ]);
  await page
    .locator('#files')
    .setInputFiles({ name: 'traversal.zip', mimeType: 'application/zip', buffer: traversal });
  await expect(page.locator('#status')).toContainText('Unsafe archive path');
  await expect(page.locator('.memory-text')).toHaveText(hostile);
  await page
    .locator('#files')
    .setInputFiles({ name: 'broken.zip', mimeType: 'application/zip', buffer: Buffer.from('{') });
  await expect(page.locator('#status')).toContainText('Your previous book is unchanged');
  await expect(page.locator('.memory-text')).toHaveText(hostile);
  expect(await page.locator('#files').inputValue()).toBe('');
  expect(requests).toEqual([]);
  expect(errors).toEqual([]);
});

test('legacy ZIP imports privately; real navigation/back and reload discard collection', async ({
  page,
}) => {
  const legacy = await zip([
    ['manifest.json', JSON.stringify({ format: 'clean-bookface-archive/1', media: [] })],
    [
      'archive.ndjson',
      JSON.stringify({
        id: 'fictional-legacy',
        kind: 'message',
        version: 1,
        sourceKey: 'a'.repeat(64),
        body: 'Legacy private conversation needle',
        title: 'Fictional legacy chat',
        source: 'messages/chat.json',
        occurredAt: 946684800000,
        importedAt: 1000,
        metadata: {},
        mediaIds: [],
      }),
    ],
    ['revisions.ndjson', ''],
  ]);
  await page.goto('/book.html');
  const open = async () => {
    await page
      .locator('#files')
      .setInputFiles({ name: 'legacy.zip', mimeType: 'application/zip', buffer: legacy });
    await expect(page.locator('#mode')).toHaveText('YOUR TEMPORARY ARCHIVE');
    await expect(page.locator('.memory-text')).toHaveText('Legacy private conversation needle');
    await expect(page.locator('.memory')).toContainText('Private conversation');
  };
  await open();
  await page.goto('/THIRD_PARTY_NOTICES.txt');
  await page.goBack();
  await expect(page.locator('.memory-text')).not.toContainText([
    'Legacy private conversation needle',
  ]);
  await expect(page.locator('#mode')).not.toHaveText('YOUR TEMPORARY ARCHIVE');
  await open();
  await page.reload();
  await expect(page.locator('#mode')).toContainText('THE SAMPLE BOOK');
  await expect(page.locator('#count')).toHaveText('6 of 6 memories');
  await expect(
    page.getByRole('button', { name: 'Cancel opening', includeHidden: true }),
  ).toBeHidden();
});
