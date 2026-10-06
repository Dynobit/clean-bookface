import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

// Execute the production helper itself against real browser IndexedDB. No host,
// real credentials, browser profiles or implementation-shaped IDB mock is used.
const source = stripTypeScriptTypes(
  readFileSync(new URL('../../src/local-cleanup.ts', import.meta.url), 'utf8'),
).replace(/^export /gm, '');
const setup = `
${source}
const own = { baseUrl: 'https://home.example', userId: '@fiction:example', deviceId: 'ONE' };
const other = { ...own, deviceId: 'TWO' };
const open = (name) => new Promise((resolve, reject) => {
  const r = indexedDB.open(name, 1);
  r.onupgradeneeded = () => r.result.createObjectStore('secret');
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
`;

test('explicit device cleanup removes only its actual crypto stores and is idempotent', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(`(async () => {
    ${setup}
    const mine = deviceCryptoDatabaseNames(own), theirs = deviceCryptoDatabaseNames(other);
    for (const name of [...mine, ...theirs, 'unrelated-app']) (await open(name)).close();
    await forgetDeviceCrypto(own);
    await forgetDeviceCrypto(own);
    const remaining = (await indexedDB.databases()).map(db => db.name);
    return { mineAbsent: mine.every(name => !remaining.includes(name)), othersPresent: [...theirs, 'unrelated-app'].every(name => remaining.includes(name)) };
  })()`);
  expect(result).toEqual({ mineAbsent: true, othersPresent: true });
});

test('an open connection bounds failure and cleanup can be retried after it closes', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(`(async () => {
    ${setup}
    const names = deviceCryptoDatabaseNames(own);
    const held = await open(names[0]);
    const start = performance.now();
    let message = '';
    try { await forgetDeviceCrypto(own, 100); } catch (error) { message = error.message; }
    const elapsed = performance.now() - start;
    held.close();
    await forgetDeviceCrypto(own);
    return { message, bounded: elapsed < 3000, remains: (await indexedDB.databases()).some(db => names.includes(db.name)) };
  })()`);
  expect(result).toEqual({
    message: 'Local key removal is blocked by another open tab. Close it and retry.',
    bounded: true,
    remains: false,
  });
});

test('native IndexedDB security errors reject instead of reporting successful removal', async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    // An opaque data origin actually denies persistent IndexedDB access.
    await page.goto('data:text/html,<title>opaque cleanup fixture</title>');
    const message = await page.evaluate(`(async () => { ${setup}
      try { await forgetDeviceCrypto(own, 100); return 'unexpected success'; }
      catch (error) { return error.message; }
    })()`);
    expect(message).toBe('Local key removal failed. Retry before leaving this browser.');
  } finally {
    await context.close();
  }
});
