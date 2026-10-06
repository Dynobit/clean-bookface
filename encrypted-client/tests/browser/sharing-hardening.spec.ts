import { test, expect, type Page, type Browser, type BrowserContext } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import sharp from 'sharp';
import { exportArchives, importArchives, type MemoryRecord } from '../../src/archive';

const runtime = process.env.CBF_TEST_HOST_RUNTIME;
if (!runtime) throw new Error('Use the disposable local sharing qualification host.');
const state = JSON.parse(readFileSync(join(runtime, 'state.json'), 'utf8'));
if (state.mode !== 'local' || new URL(state.url).hostname !== '127.0.0.1')
  throw new Error('Local synthetic host only.');
const hostScript = fileURLToPath(new URL('../../../encrypted-host/host.py', import.meta.url));
test.use({ actionTimeout: 20_000 });
type Member = { page: Page; context: BrowserContext; userId: string };
const retryAt = new WeakMap<Page, number>();
const transportErrors = new WeakMap<Page, { status: number; kind: string; retryMs?: number }[]>();
async function finishRateLimited(page: Page, buttonName: string) {
  for (
    let attempt = 0;
    attempt < 5 && /429|Too Many Requests/.test(await page.locator('#notice').innerText());
    attempt++
  ) {
    await expect.poll(() => retryAt.get(page) ?? 0).toBeGreaterThan(0);
    // Honor this real Synapse response's retry deadline, then retry the same
    // durable transaction through the UI, just as a member can.
    await page.waitForTimeout(Math.max(0, retryAt.get(page)! - Date.now()) + 150);
    await page.getByRole('button', { name: buttonName, exact: true }).click();
    await idle(page);
  }
}
async function idle(page: Page) {
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false', { timeout: 65_000 });
}
async function ready(page: Page) {
  await expect(page.getByRole('button', { name: 'My account', exact: true })).toBeVisible({
    timeout: 65_000,
  });
  await idle(page);
}
async function member(browser: Browser): Promise<Member> {
  execFileSync('python3', [hostScript, 'invite', '--runtime', runtime!], {
    stdio: 'pipe',
    timeout: 30_000,
  });
  const invitation = JSON.parse(readFileSync(join(runtime!, 'invitation.json'), 'utf8'));
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const blobs = new Map<string, Blob>();
    Object.defineProperty(window, '__renderedBlobs', { value: blobs });
    const create = URL.createObjectURL;
    URL.createObjectURL = (value: Blob | MediaSource) => {
      const url = create.call(URL, value);
      if (value instanceof Blob) blobs.set(url, value);
      return url;
    };
  });
  const page = await context.newPage();
  page.on('response', async (response) => {
    if (response.status() < 400 || !response.url().startsWith(state.url)) return;
    const errors = transportErrors.get(page) ?? [];
    transportErrors.set(page, errors);
    const kind = response.url().includes('/send/')
      ? 'room-send:' + new URL(response.url()).pathname.split('/send/')[1].split('/')[0]
      : response.url().includes('/keys/')
        ? 'keys'
        : 'other';
    const body = await response.json().catch(() => ({}));
    errors.push({
      status: response.status(),
      kind,
      ...(Number.isFinite(body.retry_after_ms) ? { retryMs: body.retry_after_ms } : {}),
    });
    if (response.status() === 429 && Number.isFinite(body.retry_after_ms))
      retryAt.set(page, Date.now() + body.retry_after_ms);
  });
  await page.goto('/');
  await page.getByLabel('Account action').selectOption('join');
  await page.getByLabel('Your home’s address').fill(state.url);
  await page.getByLabel('Invitation code', { exact: true }).fill(invitation.token);
  await page
    .getByLabel('Username', { exact: true })
    .fill(`sharing_${randomUUID().replaceAll('-', '')}`);
  await page.getByLabel('Password', { exact: true }).fill(`fictional-${randomUUID()}`);
  await page.getByRole('button', { name: 'Create my account', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Make my recovery kit', exact: true })).toBeVisible(
    { timeout: 65_000 },
  );
  await page.getByRole('button', { name: 'Make my recovery kit', exact: true }).click();
  const kit = await page.getByLabel('Your recovery key', { exact: true }).inputValue();
  await page.getByLabel('Type the last 6 characters').fill(kit.replace(/\s/g, '').slice(-6));
  await page.getByRole('button', { name: 'I saved it. Open my book.', exact: true }).click();
  await ready(page);
  const userId = await page.evaluate(
    () => JSON.parse(localStorage.getItem('clean-bookface.session.v1')!).userId,
  );
  return { page, context, userId };
}
async function section(page: Page, name: string) {
  const tab = page.getByRole('button', { name, exact: true });
  await tab.click();
  await idle(page);
  await expect(tab).toHaveAttribute('aria-current', 'page');
}
async function refresh(page: Page) {
  await page.locator('#refresh-book').click();
  await idle(page);
}
const recipient = (page: Page, user: string) =>
  page.getByRole('checkbox', { name: `${user} · identity checked`, exact: true });
function post(page: Page, text: string) {
  return page
    .locator('article')
    .filter({ has: page.locator('.post-body').filter({ hasText: text }) });
}
async function pair(a: Member, b: Member, keyboard = false): Promise<string> {
  await section(a.page, 'Friends');
  await a.page.getByLabel('Friend’s account name').fill(b.userId);
  const created = a.page.waitForResponse(
    (r) => r.url().endsWith('/createRoom') && r.request().method() === 'POST',
  );
  await a.page.getByRole('button', { name: 'Add friend', exact: true }).click();
  const roomId = (await (await created).json()).room_id;
  await idle(a.page);
  await section(b.page, 'Friends');
  await b.page.getByRole('button', { name: 'Check for invitations', exact: true }).click();
  await idle(b.page);
  await b.page.getByRole('button', { name: 'Accept friend invitation', exact: true }).click();
  await idle(b.page);
  await a.page
    .locator('.friends-list li')
    .filter({ has: a.page.getByText(b.userId, { exact: true }) })
    .getByRole('button', { name: 'Check identity', exact: true })
    .click();
  await expect(
    b.page.getByRole('button', { name: 'Accept identity check', exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  if (keyboard) {
    const dialog = b.page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    for (const key of ['Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Tab', 'Tab', 'Tab', 'Tab']) {
      await b.page.keyboard.press(key);
      expect(
        await b.page.evaluate(() =>
          document.querySelector('dialog[open]')!.contains(document.activeElement),
        ),
      ).toBe(true);
    }
  }
  await b.page.getByRole('button', { name: 'Accept identity check', exact: true }).click();
  await a.page.getByRole('button', { name: 'Show comparison', exact: true }).click();
  await expect(a.page.getByRole('button', { name: 'They match', exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect(b.page.getByRole('button', { name: 'They match', exact: true })).toBeVisible({
    timeout: 20_000,
  });
  expect(await a.page.locator('.sas').innerText()).toBe(await b.page.locator('.sas').innerText());
  await a.page.getByRole('button', { name: 'They match', exact: true }).click();
  await b.page.getByRole('button', { name: 'They match', exact: true }).click();
  await expect(a.page.locator('#verification')).not.toBeVisible({ timeout: 65_000 });
  await expect(b.page.locator('#verification')).not.toBeVisible({ timeout: 65_000 });
  await section(a.page, 'News feed');
  await refresh(a.page);
  await expect(recipient(a.page, b.userId)).toBeEnabled();
  return roomId;
}
async function conversationDownload(page: Page, peer: string): Promise<MemoryRecord[]> {
  await section(page, 'My account');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  const row = page
    .locator('.conversation-download')
    .filter({ has: page.getByRole('heading', { name: peer, exact: true }) });
  // Each helper invocation requests a new complete export; navigation now
  // correctly preserves a previous completed download instead of resetting it.
  await row
    .getByRole('button', { name: 'Start this conversation download again', exact: true })
    .click();
  await idle(page);
  const records: MemoryRecord[] = [];
  for (let part = 1; part <= 20; part++) {
    const button = row.getByRole('button', {
      name: `Download conversation · part ${part}`,
      exact: true,
    });
    if (!(await button.count())) break;
    const downloading = page.waitForEvent('download');
    await button.click();
    const file = await downloading;
    const path = await file.path();
    if (!path) throw new Error('Expected conversation download');
    const imported = await importArchives([
      new File([new Uint8Array(readFileSync(path))], 'fictional-conversation.zip'),
    ]);
    records.push(...imported.records);
    await idle(page);
    // Deliberate view rebuild must retain this exact conversation's export cursor.
    await refresh(page);
    await section(page, 'News feed');
    await section(page, 'My account');
  }
  await expect(
    row.getByRole('button', { name: 'All available parts downloaded', exact: true }),
  ).toBeDisabled();
  return records;
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('removing and resharing the same imported memory creates a visible new copy', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const members: Member[] = [];
  try {
    members.push(await member(browser), await member(browser));
    const [a, b] = members;
    await pair(a, b);
    const text = 'SYNTHETIC_REMOVED_THEN_RESHARED';
    const record: MemoryRecord = {
      id: 'stable-fictional-memory',
      kind: 'post',
      text,
      title: '',
      timestamp: 1234567890000,
      sourcePath: 'fixture.json',
      attachments: [],
      privateOnly: false,
    };
    const zip = await exportArchives([record]);
    await section(a.page, 'My memories');
    await expect(a.page.getByLabel('Choose archive ZIP files')).toBeEnabled();
    await a.page.getByLabel('Choose archive ZIP files').setInputFiles({
      name: 'fictional.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(await zip.arrayBuffer()),
    });
    await a.page.getByRole('button', { name: 'Bring in my memories', exact: true }).click();
    await idle(a.page);
    const share = async () => {
      await post(a.page, text).getByText('Share this memory', { exact: true }).click();
      await post(a.page, text)
        .getByRole('checkbox', { name: `${b.userId} · identity checked`, exact: true })
        .check();
      await post(a.page, text)
        .getByRole('button', { name: 'Share selected copy', exact: true })
        .click();
      await idle(a.page);
    };
    await share();
    await section(a.page, 'News feed');
    await post(a.page, text)
      .getByRole('button', { name: 'Remove this shared copy', exact: true })
      .click();
    await idle(a.page);
    await section(b.page, 'News feed');
    await refresh(b.page);
    await expect(post(b.page, text)).toHaveCount(0);
    await section(a.page, 'My memories');
    await share();
    await refresh(b.page);
    await expect(post(b.page, text)).toHaveCount(1);
    const exported = await conversationDownload(b.page, a.userId);
    const copies = exported.filter((item) => item.text === text);
    expect(copies).toHaveLength(2);
    expect(new Set(copies.map((item) => item.id)).size).toBe(2);
    expect(copies.map((item) => (item.provenance as any).conversation.removed).sort()).toEqual([
      false,
      true,
    ]);
  } finally {
    await test.info().attach('transport-statuses', {
      body: JSON.stringify(members.map((item) => transportErrors.get(item.page) ?? [])),
      contentType: 'application/json',
    });
    for (const item of members) await item.context.close();
  }
});

test('four-photo composer protects metadata and recipients, resumes partial delivery and exports departed conversations', async ({
  browser,
}) => {
  test.setTimeout(360_000);
  const members: Member[] = [];
  try {
    for (let i = 0; i < 4; i++) members.push(await member(browser));
    const [a, b, c, outsider] = members;
    const roomB = await pair(a, b, true);
    const roomC = await pair(a, c);
    await a.page.setViewportSize({ width: 390, height: 844 });
    await section(a.page, 'News feed');
    await expect(a.page.getByRole('button', { name: 'News feed', exact: true })).toBeFocused();
    expect(await a.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const originals = await Promise.all(
      [0, 1, 2, 3].map(async (n) =>
        sharp({
          create: {
            width: 3000,
            height: 2000,
            channels: 3,
            background: { r: 40 + n * 30, g: 80, b: 150 },
          },
        })
          .withExif({ IFD0: { Make: `FICTIONAL_CAMERA_${n}`, Artist: 'FICTIONAL_PRIVATE_AUTHOR' } })
          .jpeg({ quality: 92 })
          .toBuffer(),
      ),
    );
    for (const original of originals) expect((await sharp(original).metadata()).exif).toBeTruthy();
    const caption = 'SYNTHETIC_FOUR_PHOTO_COMPOSER',
      reply = 'SYNTHETIC_EXPORTED_COMMENT',
      draft = 'SYNTHETIC_DRAFT_SURVIVES_REFRESH';
    const bodies: Buffer[] = [],
      sentRooms: string[] = [];
    a.page.on('request', (request) => {
      if (!request.url().startsWith(state.url)) return;
      const body = request.postDataBuffer();
      if (body) bodies.push(body);
      const path = decodeURIComponent(new URL(request.url()).pathname);
      const match = path.match(/\/rooms\/([^/]+)\/send\/m.room.encrypted\//);
      if (match) sentRooms.push(match[1]);
    });
    await a.page.getByLabel('Write a post').fill(caption);
    await a.page.getByLabel('Add photos (optional)').setInputFiles(
      originals.map((buffer, n) => ({
        name: `private-camera-${n}.jpg`,
        mimeType: 'image/jpeg',
        buffer,
      })),
    );
    await recipient(a.page, b.userId).check();
    await recipient(a.page, c.userId).check();
    // Real rendering after an incoming sync and manual refresh must preserve draft data.
    await a.page.getByLabel('Write a post').focus();
    await refresh(a.page);
    await expect(a.page.getByLabel('Write a post')).toHaveValue(caption);
    expect(
      await a.page
        .getByLabel('Add photos (optional)')
        .evaluate((input: HTMLInputElement) => input.files!.length),
    ).toBe(4);
    await expect(recipient(a.page, b.userId)).toBeChecked();
    await expect(recipient(a.page, c.userId)).toBeChecked();
    await a.page.route('**/send/m.room.encrypted/**', async (route) => {
      if (decodeURIComponent(new URL(route.request().url()).pathname).includes(`/rooms/${roomC}/`))
        await route.fulfill({
          status: 403,
          json: { errcode: 'M_FORBIDDEN', error: 'Synthetic one-recipient delivery failure' },
        });
      else await route.continue();
    });
    await a.page.getByRole('button', { name: 'Share with selected friends', exact: true }).click();
    await idle(a.page);
    await finishRateLimited(a.page, 'Finish sending this post');
    await expect(
      a.page.getByRole('heading', { name: 'A post is waiting to finish', exact: true }),
    ).toBeVisible();
    await expect(
      a.page.getByText('4 photos · 1 of 2 recipients delivered.', { exact: true }),
    ).toBeVisible();
    await section(b.page, 'News feed');
    await refresh(b.page);
    await expect(post(b.page, caption)).toHaveCount(1);
    await post(b.page, caption).scrollIntoViewIfNeeded();
    await expect(post(b.page, caption).locator('img')).toHaveCount(4);
    await expect
      .poll(() =>
        post(b.page, caption)
          .locator('img')
          .evaluateAll((images) =>
            images.every((img) => (img as HTMLImageElement).naturalWidth > 0),
          ),
      )
      .toBe(true);
    const received = await post(b.page, caption)
      .locator('img')
      .evaluateAll(async (images) =>
        Promise.all(
          images.map(async (img) =>
            Array.from(
              new Uint8Array(
                await (window as unknown as { __renderedBlobs: Map<string, Blob> }).__renderedBlobs
                  .get((img as HTMLImageElement).src)!
                  .arrayBuffer(),
              ),
            ),
          ),
        ),
      );
    for (const bytes of received) {
      const metadata = await sharp(Buffer.from(bytes)).metadata();
      expect(metadata.width).toBeLessThanOrEqual(2048);
      expect(metadata.height).toBeLessThanOrEqual(2048);
      expect(metadata.exif).toBeUndefined();
      expect(metadata.xmp).toBeUndefined();
      expect(metadata.iptc).toBeUndefined();
    }
    await section(c.page, 'Friends');
    await c.page
      .locator('.friends-list li')
      .filter({ has: c.page.getByText(a.userId, { exact: true }) })
      .getByRole('button', { name: 'Block this account', exact: true })
      .click();
    await idle(c.page);
    await a.page.unroute('**/send/m.room.encrypted/**');
    await a.page.reload();
    await ready(a.page);
    await expect(a.page.locator('#verification')).not.toBeVisible();
    await expect(
      a.page.getByText('4 photos · 1 of 2 recipients delivered.', { exact: true }),
    ).toBeVisible();
    const sentB = sentRooms.filter((room) => room === roomB).length;
    await a.page.getByRole('button', { name: 'Finish sending this post', exact: true }).click();
    await idle(a.page);
    expect(sentRooms.filter((room) => room === roomB).length).toBe(sentB);
    await refresh(b.page);
    await expect(post(b.page, caption)).toHaveCount(1);
    await section(c.page, 'News feed');
    await refresh(c.page);
    await expect(post(c.page, caption)).toHaveCount(0);
    await a.page.getByRole('button', { name: 'Stop retrying this post', exact: true }).click();
    await idle(a.page);
    await section(outsider.page, 'News feed');
    await refresh(outsider.page);
    await expect(post(outsider.page, caption)).toHaveCount(0);
    const denied = await outsider.page.evaluate(
      async ({ home, room }) => {
        const s = JSON.parse(localStorage.getItem('clean-bookface.session.v1')!);
        return (
          await fetch(
            `${home}/_matrix/client/v3/rooms/${encodeURIComponent(room)}/messages?dir=b&limit=1`,
            { headers: { Authorization: `Bearer ${s.accessToken}` } },
          )
        ).status;
      },
      { home: state.url, room: roomB },
    );
    expect(denied).toBe(403);
    await refresh(a.page);
    await expect(a.page.locator('#refresh-book')).toHaveText('Refresh my book');
    await a.page.getByLabel('Write a post').fill(draft);
    await a.page.getByLabel('Write a post').focus();
    await post(b.page, caption).getByLabel('Write a comment').fill(reply);
    await post(b.page, caption).getByRole('button', { name: 'Send comment', exact: true }).click();
    await idle(b.page);
    await finishRateLimited(b.page, 'Finish this conversation change');
    await post(b.page, caption).getByLabel('Your reaction').selectOption('♥');
    await post(b.page, caption).getByRole('button', { name: 'Save reaction', exact: true }).click();
    await idle(b.page);
    await finishRateLimited(b.page, 'Finish this conversation change');
    await expect(post(b.page, caption).getByText(`♥ ${b.userId}`, { exact: true })).toBeVisible();
    await expect(a.page.locator('#refresh-book')).toHaveText('New updates — refresh', {
      timeout: 30_000,
    });
    await expect(a.page.getByLabel('Write a post')).toBeFocused();
    // A received SDK sync cannot replace an unsent draft.
    await expect.poll(() => a.page.getByLabel('Write a post').inputValue()).toBe(draft);
    await refresh(a.page);
    await expect(a.page.getByLabel('Write a post')).toHaveValue(draft);
    const exported = await conversationDownload(b.page, a.userId);
    const exportedPost = exported.find((record) => record.text === caption)!;
    expect(exportedPost.attachments).toHaveLength(4);
    expect(exported.find((record) => record.text === reply)?.kind).toBe('message');
    expect(
      await Promise.all(
        exportedPost.attachments.map(async (attachment) =>
          hash(new Uint8Array(await attachment.bytes.arrayBuffer())),
        ),
      ),
    ).toEqual(received.map((bytes) => hash(Uint8Array.from(bytes))));
    await section(b.page, 'News feed');
    await b.page.setViewportSize({ width: 1440, height: 1000 });
    await post(b.page, caption).scrollIntoViewIfNeeded();
    await expect(post(b.page, caption).locator('img')).toHaveCount(4);
    await expect
      .poll(() =>
        post(b.page, caption)
          .locator('img')
          .evaluateAll((images) =>
            images.every((image) => (image as HTMLImageElement).naturalWidth > 0),
          ),
      )
      .toBe(true);
    await b.page.screenshot({ path: join(runtime!, '..', 'sharing-desktop.png'), fullPage: true });
    await b.page.setViewportSize({ width: 390, height: 844 });
    const mobileLayout = await b.page.evaluate(() => ({
      viewport: innerWidth,
      width: document.documentElement.scrollWidth,
      overflowing: [...document.body.querySelectorAll<HTMLElement>('*')]
        .map((node) => {
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return {
            tag: node.tagName,
            id: node.id,
            className: node.className,
            right: rect.right,
            left: rect.left,
            width: rect.width,
            scrollWidth: node.scrollWidth,
            clientWidth: node.clientWidth,
            minWidth: style.minWidth,
          };
        })
        .filter(
          (node) =>
            node.right > innerWidth + 1 ||
            node.left < -1 ||
            node.scrollWidth > node.clientWidth + 1,
        )
        .slice(0, 30),
    }));
    await test.info().attach('mobile-layout', {
      body: JSON.stringify(mobileLayout),
      contentType: 'application/json',
    });
    await b.page.screenshot({ path: join(runtime!, '..', 'sharing-mobile.png'), fullPage: true });
    const replies = [reply, ...Array.from({ length: 20 }, (_, i) => `${reply}_PART_${i + 1}`)];
    for (const text of replies.slice(1)) {
      await post(b.page, caption).getByLabel('Write a comment').fill(text);
      await post(b.page, caption)
        .getByRole('button', { name: 'Send comment', exact: true })
        .click();
      await idle(b.page);
      await finishRateLimited(b.page, 'Finish this conversation change');
    }
    const multipleParts = await conversationDownload(b.page, a.userId);
    expect(
      multipleParts.filter((record) => record.title === 'Private conversation export'),
    ).toHaveLength(2);
    expect(
      multipleParts
        .filter((record) => record.text.startsWith(reply))
        .map((record) => record.text)
        .sort(),
    ).toEqual([...replies].sort());

    await section(b.page, 'Friends');
    await b.page
      .locator('.friends-list li')
      .filter({ has: b.page.getByText(a.userId, { exact: true }) })
      .getByRole('button', { name: 'Remove friend', exact: true })
      .click();
    await idle(b.page);
    await finishRateLimited(b.page, 'Remove friend');
    await expect(b.page.locator('#notice')).toContainText('Removed. They keep copies');
    const initialFilters: any[] = [];
    b.page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname.endsWith('/sync') && !url.searchParams.has('since'))
        initialFilters.push(JSON.parse(url.searchParams.get('filter')!));
    });
    await b.page.reload();
    await ready(b.page);
    expect(initialFilters.some((filter) => filter.room?.include_leave === true)).toBe(true);
    const historical = await conversationDownload(b.page, a.userId);
    await test.info().attach('departed-export-records', {
      body: JSON.stringify(
        historical.map((record) => ({
          id: record.id,
          kind: record.kind,
          title: record.title,
          text: record.text,
          attachments: record.attachments.length,
          provenance: record.provenance,
        })),
      ),
      contentType: 'application/json',
    });
    await test.info().attach('departed-account-state', {
      body: await b.page.locator('main').innerText(),
      contentType: 'text/plain',
    });
    expect(
      historical.some((record) => record.text === caption && record.attachments.length === 4),
    ).toBe(true);
    expect(
      historical
        .filter((record) => record.text.startsWith(reply))
        .map((record) => record.text)
        .sort(),
    ).toEqual([...replies].sort());
    await section(b.page, 'News feed');
    await refresh(b.page);
    await expect(post(b.page, caption)).toBeVisible();
    await expect(
      post(b.page, caption).getByRole('button', { name: 'Send comment', exact: true }),
    ).toHaveCount(0);
    await expect(
      post(b.page, caption).getByRole('button', { name: 'Save reaction', exact: true }),
    ).toHaveCount(0);
    expect(mobileLayout.width, JSON.stringify(mobileLayout)).toBeLessThanOrEqual(
      mobileLayout.viewport,
    );
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body.includes(Buffer.from(caption))).toBe(false);
      expect(body.includes(Buffer.from('FICTIONAL_PRIVATE_AUTHOR'))).toBe(false);
      for (const original of originals) expect(body.includes(original)).toBe(false);
    }
  } finally {
    await test.info().attach('transport-statuses', {
      body: JSON.stringify(members.map((item) => transportErrors.get(item.page) ?? [])),
      contentType: 'application/json',
    });
    for (const item of members) await item.context.close();
  }
});
