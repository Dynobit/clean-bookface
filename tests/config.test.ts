import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from '../src/config.js';
import { Store } from '../src/storage.js';
import { Core } from '../src/core.js';

test('production requires a stable HTTPS origin without embedded credentials or paths', () => {
  for (const APP_ORIGIN of [
    'http://circle.example',
    'https://user:password@circle.example',
    'https://circle.example/prefix',
    'https://circle.example/?token=secret',
    'https://circle.example/#fragment',
  ])
    assert.throws(() => readConfig({ NODE_ENV: 'production', APP_ORIGIN }));
  const config = readConfig({
    NODE_ENV: 'production',
    APP_ORIGIN: 'https://circle.example',
    DATA_DIR: './data',
    FEDERATION_ENABLED: 'true',
  });
  assert.equal(config.origin, 'https://circle.example');
  assert.equal(config.production, true);
  assert.equal(config.federation, true);
});

test('development is loopback by default and numeric resource limits fail closed', () => {
  const config = readConfig({});
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.origin, 'http://localhost:3000');
  assert.equal(config.federation, false);
  for (const PORT of ['0', '-1', '65536', '3.14', 'invalid'])
    assert.throws(() => readConfig({ PORT }));
  for (const MAX_UPLOAD_BYTES of ['0', '-1', 'Infinity', String(21 * 1024 ** 3)])
    assert.throws(() => readConfig({ MAX_UPLOAD_BYTES }));
});

test('core records its schema and refuses unknown future versions without mutation', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bookface-schema-'));
  const store = new Store(dir);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  new Core(store, { origin: 'https://circle.example' });
  assert.equal(
    store.db.prepare("SELECT version FROM schema_versions WHERE component='core'").get()!.version,
    1,
  );
  store.db.prepare("UPDATE schema_versions SET version=99 WHERE component='core'").run();
  assert.throws(
    () => new Core(store, { origin: 'https://circle.example' }),
    /Unsupported core database schema/,
  );
  assert.equal(
    store.db.prepare("SELECT version FROM schema_versions WHERE component='core'").get()!.version,
    99,
  );
});

test('pilot quotas have bounded defaults and reject invalid limits', () => {
  const defaults = readConfig({});
  assert.equal(defaults.maxAccounts, 200);
  assert.equal(defaults.maxDirectUploadBytes, defaults.maxUploadBytes);
  assert.equal(defaults.archiveAccountBytes, 5 * 1024 ** 3);
  assert.equal(defaults.cloudflareProxy, false);
  for (const [key, invalid] of Object.entries({
    MAX_ACCOUNTS: ['0', '1001', '1.5', 'NaN'],
    MAX_DIRECT_UPLOAD_BYTES: ['1023', String(20 * 1024 ** 3 + 1), 'Infinity'],
    ARCHIVE_ACCOUNT_BYTES: [String(1024 ** 2 - 1), String(100 * 1024 ** 3 + 1), '-1'],
  }))
    for (const value of invalid) assert.throws(() => readConfig({ [key]: value }), new RegExp(key));
  const custom = readConfig({
    MAX_ACCOUNTS: '1000',
    MAX_DIRECT_UPLOAD_BYTES: String(80 * 1024 ** 2),
    ARCHIVE_ACCOUNT_BYTES: String(1024 ** 3),
    CLOUDFLARE_PROXY: 'true',
  });
  assert.equal(custom.maxAccounts, 1000);
  assert.equal(custom.maxDirectUploadBytes, 80 * 1024 ** 2);
  assert.equal(custom.archiveAccountBytes, 1024 ** 3);
  assert.equal(custom.cloudflareProxy, true);
});

test('pilot requires a strictly ordered pair of real absolute UTC timestamps', () => {
  const valid = {
    PILOT_READ_ONLY_AT: '2027-01-01T00:00:00Z',
    PILOT_ENDS_AT: '2027-01-15T00:00:00.123Z',
  };
  assert.equal(readConfig(valid).pilotEndsAt, valid.PILOT_ENDS_AT);
  assert.equal(readConfig({}).pilotEndsAt, undefined);
  assert.throws(() => readConfig({ PILOT_ENDS_AT: valid.PILOT_ENDS_AT }));
  assert.throws(() => readConfig({ PILOT_READ_ONLY_AT: valid.PILOT_READ_ONLY_AT }));
  for (const value of [
    '',
    '2027-01-01',
    '2027-01-01T00:00:00',
    '2027-01-01T00:00:00+00:00',
    '2027-02-30T00:00:00Z',
    '2027-01-01T24:00:00Z',
    'invalid',
  ])
    assert.throws(() => readConfig({ ...valid, PILOT_READ_ONLY_AT: value }));
  assert.throws(() => readConfig({ ...valid, PILOT_READ_ONLY_AT: valid.PILOT_ENDS_AT }));
  assert.throws(() => readConfig({ ...valid, PILOT_READ_ONLY_AT: '2028-01-01T00:00:00Z' }));
});
