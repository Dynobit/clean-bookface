// Capture the actual app using a fresh fictional demo, never a member account.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
const probe = createServer();
await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const data = await mkdtemp(join(tmpdir(), 'bookface-fictional-preview-'));
const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/demo.ts'], {
  env: { ...process.env, NODE_ENV: 'test', DEMO_DATA_DIR: data, PORT: String(port) },
  stdio: 'ignore',
});
let browser;
try {
  const origin = `http://localhost:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${origin}/healthz`)).ok) break;
    } catch {}
    if (Date.now() > deadline || child.exitCode !== null)
      throw new Error('Fictional preview failed to start');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  browser = await chromium.launch(process.platform === 'darwin' ? { channel: 'chrome' } : {});
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await page.goto(`${origin}/login`);
  await page.getByLabel('Username', { exact: true }).fill('alice');
  await page.getByLabel('Password', { exact: true }).fill('fictional-demo-password-only');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.getByRole('heading', { name: 'News feed', exact: true }).waitFor();
  await page.locator('article img').first().waitFor();
  await page.evaluate(async () => {
    await Promise.all([...document.images].map((image) => image.decode().catch(() => {})));
  });
  await mkdir('docs/images', { recursive: true });
  await page.screenshot({ path: 'docs/images/feed-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'docs/images/feed-mobile.png', fullPage: true });
  console.log(
    'Saved fictional interface screenshots in docs/images. Visually review before committing.',
  );
} finally {
  if (browser) await browser.close();
  if (child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
  }
  await rm(data, { recursive: true, force: true });
}
