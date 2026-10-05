import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageUpload } from '../src/uploads.js';
import { createApplication } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { CHUNK_ENTRY_BYTES, MAX_PATH_ENTRIES } from '../src/chunk-uploads.js';

const origin = 'http://localhost:3000';
const boundary = 'fictional-multipart-resource-boundary';
function multipart(files: { name: string; content: string }[], observe = () => {}) {
  const parts = files.flatMap((file) => [
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    Buffer.from(file.content + '\r\n'),
  ]);
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      observe();
      if (index === parts.length) controller.close();
      else controller.enqueue(parts[index++]!);
    },
  });
}
function request(
  files: { name: string; content: string }[],
  extra: Record<string, string> = {},
  observe = () => {},
) {
  return new Request(origin + '/api/imports', {
    method: 'POST',
    headers: { origin, 'content-type': `multipart/form-data; boundary=${boundary}`, ...extra },
    body: multipart(files, observe),
    duplex: 'half',
  } as RequestInit);
}

test('streaming multipart rejects deep empty trees, total path entries and prefix conflicts, then cleans staging', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'bookface-multipart-bounds-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const attacks = [
    {
      files: Array.from({ length: 1000 }, (_, i) => ({
        name: `tree${i}/` + 'd/'.repeat(18) + 'empty',
        content: '',
      })),
      expected: /64 empty files/,
    },
    {
      files: Array.from({ length: 1100 }, (_, i) => ({
        name: `tree${i}/` + 'd/'.repeat(18) + 'a',
        content: 'x',
      })),
      expected: /too many files and folders/,
    },
    {
      files: [
        { name: 'a', content: 'x' },
        { name: 'a/b', content: 'x' },
      ],
      expected: /same path/,
    },
    {
      files: [
        { name: 'a/b', content: 'x' },
        { name: 'a', content: 'x' },
      ],
      expected: /same path/,
    },
  ];
  for (const attack of attacks) {
    await assert.rejects(stageUpload(request(attack.files), dir, 2 * 1024 ** 2), attack.expected);
    assert.deepEqual(await readdir(join(dir, 'incoming')), []);
  }
  const upload = await stageUpload(
    request([
      { name: 'folder/memory.txt', content: 'A fictional memory.' },
      { name: 'empty.txt', content: '' },
    ]),
    dir,
    2 * 1024 ** 2,
  );
  assert.equal(
    await readFile(join(upload.root, 'folder/memory.txt'), 'utf8'),
    'A fictional memory.',
  );
  assert.equal((await readFile(join(upload.root, 'empty.txt'))).length, 0);
});

test('direct HTTP reserves metadata separately and releases all capacity after rejecting a multipart tree', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'bookface-multipart-http-'));
  const limit = 2 * 1024 ** 2;
  const runtime = createApplication(
    readConfig({ APP_ORIGIN: origin, DATA_DIR: dir, MAX_UPLOAD_BYTES: String(limit) }),
  );
  t.after(async () => {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  });
  const password = 'fictional multipart resource passphrase';
  const alice = (
    await runtime.core.setup({ username: 'alice', displayName: 'Alice Example', password })
  ).user;
  const login = await runtime.app.request(
    new Request(origin + '/actions/login', {
      method: 'POST',
      headers: { origin, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password }),
    }),
  );
  assert.equal(login.status, 200);
  const data = await login.json();
  const headers = {
    cookie: login.headers.get('set-cookie')!.split(';')[0]!,
    'x-csrf-token': data.csrf,
    accept: 'application/json',
  };
  let reserved = 0;
  const response = await runtime.app.request(
    request(
      Array.from({ length: 1000 }, (_, i) => ({
        name: `tree${i}/` + 'd/'.repeat(18) + 'empty',
        content: '',
      })),
      headers,
      () => {
        reserved = Math.max(
          reserved,
          Number(
            runtime.store.db
              .prepare(
                "SELECT COALESCE(SUM(reserved_bytes),0) bytes FROM chunk_uploads WHERE state='active'",
              )
              .get()!.bytes,
          ),
        );
      },
    ),
  );
  assert.equal(response.status, 400, await response.clone().text());
  assert.match(await response.text(), /64 empty files/);
  assert.equal(reserved, limit + (MAX_PATH_ENTRIES + 3) * CHUNK_ENTRY_BYTES);
  assert.equal(runtime.store.db.prepare('SELECT COUNT(*) n FROM chunk_uploads').get()!.n, 0);
  assert.deepEqual(await readdir(join(dir, 'incoming')), []);
  const next = runtime.chunks.begin(alice.id, [{ name: 'new.json', size: limit }]);
  assert.equal(next.state, 'active');
  runtime.chunks.cancel(alice.id, next.id);
  for (const owner of [alice.id, 'fictional-two', 'fictional-three', 'fictional-four'])
    assert.equal(
      runtime.chunks.begin(
        owner,
        [{ name: 'direct-reservation', size: limit }],
        MAX_PATH_ENTRIES + 1,
      ).state,
      'active',
    );
  assert.throws(
    () =>
      runtime.chunks.begin(
        'fictional-five',
        [{ name: 'direct-reservation', size: limit }],
        MAX_PATH_ENTRIES + 1,
      ),
    /busy/,
  );
});
