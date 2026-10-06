import { test, expect } from '@playwright/test';
import { build } from 'vite';
let source: string;
test.beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: { entry: new URL('../../src/outbox.ts', import.meta.url).pathname, formats: ['es'] },
    },
  });
  source = (Array.isArray(result) ? result[0] : (result as any)).output.find(
    (v: any) => v.type === 'chunk',
  ).code;
});
async function open(page: import('@playwright/test').Page) {
  await page.route('https://client.example/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>Fictional retry fixture</title>' }),
  );
  await page.goto('https://client.example/');
  await page.evaluate(async (source) => {
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    (window as any).Outbox = (await import(url)).BrowserOutbox;
    URL.revokeObjectURL(url);
    (window as any).session = {
      baseUrl: 'https://home.example',
      userId: '@fiction:home.example',
      deviceId: 'ONE',
      accessToken: 'synthetic-token',
    };
  }, source);
}
test('photo retry survives IndexedDB reopen with its exact operation and delivered audience', async ({
  page,
}) => {
  await open(page);
  const before = await page.evaluate(async () => {
    const { Outbox, session } = window as any;
    const box = await Outbox.open(session),
      data = new Uint8Array(2 * 1024 * 1024);
    for (let n = 0; n < data.length; n++) data[n] = n % 251;
    const post = {
      operationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      recipients: ['@first:home.example', '@second:home.example'],
      delivered: ['@first:home.example'],
      record: {
        id: 'synthetic-memory',
        kind: 'post',
        text: 'PRIVATE_SYNTHETIC_POST_MARKER',
        title: '',
        timestamp: 12345,
        privateOnly: false,
        sourcePath: '',
        attachments: Array.from({ length: 4 }, (_, n) => ({
          path: `photo-${n + 1}.jpg`,
          mimeType: 'image/jpeg',
          bytes: new Blob([data]),
        })),
      },
    };
    await box.save(post);
    box.close();
    return { operationId: post.operationId, bytes: data.length * 4 };
  });
  await page.reload();
  await page.evaluate(async (source) => {
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    (window as any).Outbox = (await import(url)).BrowserOutbox;
    URL.revokeObjectURL(url);
  }, source);
  const after = await page.evaluate(async () => {
    const { Outbox } = window as any;
    const session = {
      baseUrl: 'https://home.example',
      userId: '@fiction:home.example',
      deviceId: 'ONE',
      accessToken: 'synthetic-token',
    };
    const box = await Outbox.open(session),
      value = await box.load();
    const matching = await Promise.all(
      value.record.attachments.map(async (a: any) =>
        [...new Uint8Array(await a.bytes.arrayBuffer())].every((byte, n) => byte === n % 251),
      ),
    );
    const isolated = await Outbox.open({ ...session, deviceId: 'TWO' });
    const otherEmpty = (await isolated.load()) === null;
    isolated.close();
    await box.clear();
    const cleared = (await box.load()) === null;
    box.close();
    return {
      operationId: value.operationId,
      recipients: value.recipients,
      delivered: value.delivered,
      bytes: value.record.attachments.reduce((n: number, a: any) => n + a.bytes.size, 0),
      matching: matching.every(Boolean),
      otherEmpty,
      cleared,
    };
  });
  expect(after).toEqual({
    ...before,
    recipients: ['@first:home.example', '@second:home.example'],
    delivered: ['@first:home.example'],
    matching: true,
    otherEmpty: true,
    cleared: true,
  });
});
test('oversized photos and widened delivered audience are refused before replacing retry state', async ({
  page,
}) => {
  await open(page);
  const result = await page.evaluate(async () => {
    const { Outbox, session } = window as any;
    const box = await Outbox.open(session);
    const post = {
      operationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      recipients: ['@first:home.example'],
      delivered: [],
      record: {
        id: 'synthetic-memory',
        kind: 'post',
        text: 'kept',
        title: '',
        timestamp: 12345,
        privateOnly: false,
        sourcePath: '',
        attachments: [],
      },
    };
    await box.save(post);
    let refusals = 0;
    for (const bad of [
      { ...post, delivered: ['@third:home.example'] },
      {
        ...post,
        record: {
          ...post.record,
          attachments: [
            {
              path: 'photo-1.jpg',
              mimeType: 'image/jpeg',
              bytes: new Blob([new Uint8Array(2 * 1024 * 1024 + 1)]),
            },
          ],
        },
      },
    ]) {
      try {
        await box.save(bad);
      } catch {
        refusals++;
      }
    }
    const kept = (await box.load()).record.text;
    box.close();
    return { refusals, kept };
  });
  expect(result).toEqual({ refusals: 2, kept: 'kept' });
});

test('an imported photo with no original date can be queued and restored without inventing a date', async ({
  page,
}) => {
  await open(page);
  const result = await page.evaluate(async () => {
    const { Outbox, session } = window as any;
    let box = await Outbox.open(session);
    await box.save({
      operationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      recipients: ['@first:home.example'],
      delivered: [],
      record: {
        id: 'undated-photo',
        kind: 'photo',
        text: '',
        title: 'An undated photo',
        timestamp: null,
        privateOnly: false,
        sourcePath: '',
        attachments: [
          {
            path: 'photo-1.jpg',
            mimeType: 'image/jpeg',
            bytes: new Blob([new Uint8Array([1, 2, 3])]),
          },
        ],
      },
    });
    box.close();
    box = await Outbox.open(session);
    const post = await box.load();
    box.close();
    return {
      timestamp: post.record.timestamp,
      kind: post.record.kind,
      bytes: post.record.attachments[0].bytes.size,
    };
  });
  expect(result).toEqual({ timestamp: null, kind: 'photo', bytes: 3 });
});
