import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { acquireInstanceLock } from '../src/operations.js';

test('managed maintenance serves only health and leaves the volume unlocked for offline CLI work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bookface-maintenance-'));
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      APP_ORIGIN: `https://127.0.0.1:${port}`,
      PORT: String(port),
      BIND_ADDRESS: '127.0.0.1',
      DATA_DIR: root,
      MAINTENANCE_MODE: 'true',
    },
    stdio: 'ignore',
  });
  try {
    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 10000;
    for (;;) {
      try {
        if ((await fetch(url + '/healthz')).ok) break;
      } catch {}
      if (Date.now() > deadline || child.exitCode !== null)
        throw new Error('Maintenance server failed to start');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(await (await fetch(url + '/healthz')).json(), {
      status: 'maintenance',
      ready: false,
      version: '0.1.0',
    });
    for (const path of [
      '/',
      '/setup',
      '/login',
      '/api/archive',
      '/actions/posts',
      '/users/alice/inbox',
    ]) {
      const response = await fetch(url + path, {
        method: path.startsWith('/actions') ? 'POST' : 'GET',
      });
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('retry-after'), '300');
      assert.equal(response.headers.has('set-cookie'), false);
      await response.text();
    }
    assert.deepEqual(
      await readdir(root),
      [],
      'maintenance must not create SQLite, setup credentials or a lock',
    );
    const release = acquireInstanceLock(root, 'synthetic-offline-backup');
    release();
    assert.deepEqual(await readdir(root), []);
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});
