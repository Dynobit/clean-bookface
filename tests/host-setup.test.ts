import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
// @ts-expect-error Standalone dependency-free operator helper is JavaScript.
import { runSetup, settings } from '../scripts/host-setup.mjs';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'host-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls: string[][] = [];
  const messages: string[] = [];
  const answers = ['circle.example.org', 'Our circle', 'START'];
  return {
    root,
    calls,
    messages,
    answers,
    options: {
      root,
      lockPath: join(root, 'setup.lock'),
      storageProbe: async () => ({ bavail: 30 * 1024 ** 3, bsize: 1 }),
      memory: 4 * 1024 ** 3,
      freeBytes: 30 * 1024 ** 3,
      ask: async () => answers.shift(),
      say: (value: string) => messages.push(value),
      run: async (args: string[]) => {
        calls.push(args);
        return {
          code: 0,
          output:
            args[0] === 'info'
              ? args.includes('{{.DockerRootDir}}')
                ? '/docker-data'
                : `linux ${4 * 1024 ** 3}`
              : args[0] === 'context'
                ? 'unix:///var/run/docker.sock'
                : '',
        };
      },
    },
  };
}
test('guided setup writes private settings and starts only the exact Compose project', async (t) => {
  const f = await fixture(t);
  await runSetup(f.options);
  assert.equal((await stat(join(f.root, '.env'))).mode & 0o777, 0o600);
  assert.match(await readFile(join(f.root, '.env'), 'utf8'), /FEDERATION_ENABLED=false/);
  assert.match(
    await readFile(join(f.root, '.env'), 'utf8'),
    /^COMPOSE_PROJECT_NAME=clean-bookface$/m,
  );
  const start = f.calls.find((args) => args.includes('up'))!;
  assert.deepEqual(start.slice(0, 9), [
    'compose',
    '--project-directory',
    f.root,
    '--env-file',
    join(f.root, '.env'),
    '-f',
    join(f.root, 'compose.yaml'),
    '-p',
    'clean-bookface',
  ]);
  assert.ok(start.includes('--wait'));
  assert.ok(!f.calls.some((args) => args.includes('setup-token')));
  await assert.rejects(runSetup(f.options), /already has .env/);
});
test('injection, malformed domains and multiline settings are refused', () => {
  for (const domain of [
    'https://circle.example.org',
    'foo.org/evil',
    '$(id).org',
    '127.0.0.1',
    'friends.example',
    'circle.org\nBAD=x',
  ])
    assert.throws(() => settings(domain, 'Circle'));
  for (const name of ['${TOKEN}', '"\nSECRET=x', '`id`', 'a\\b'])
    assert.throws(() => settings('circle.example.org', name));
  assert.match(
    settings('CIRCLE.EXAMPLE.ORG', 'The García circle'),
    /APP_DOMAIN=circle.example.org/,
  );
});
test('cancellation and old volumes never write settings or start anything', async (t) => {
  const f = await fixture(t);
  f.answers[2] = 'no';
  await runSetup(f.options);
  await assert.rejects(stat(join(f.root, '.env')), { code: 'ENOENT' });
  assert.ok(!f.calls.some((args) => args.includes('up')));
  const original = f.options.run;
  f.options.run = async (args) =>
    args[0] === 'volume' ? { code: 0, output: 'clean-bookface_app_data' } : original(args);
  await assert.rejects(runSetup(f.options), /already exists/);
  await assert.rejects(stat(join(f.root, '.env')), { code: 'ENOENT' });
});
test('startup failure preserves settings and never removes data', async (t) => {
  const f = await fixture(t);
  const original = f.options.run;
  f.options.run = async (args) =>
    args.includes('up') ? { code: 1, output: 'private daemon detail' } : original(args);
  await assert.rejects(runSetup(f.options), /settings and data were kept/);
  assert.match(await readFile(join(f.root, '.env'), 'utf8'), /circle.example.org/);
  assert.ok(!f.calls.some((args) => args.includes('down') || args.includes('rm')));
  assert.ok(!f.messages.join('').includes('private daemon detail'));
});
test('existing insecure settings and low disk fail before mutation', async (t) => {
  const f = await fixture(t);
  await assert.rejects(runSetup({ ...f.options, freeBytes: 1024 }), /20 GiB/);
  await writeFile(join(f.root, '.env'), 'do not change', { mode: 0o644 });
  await assert.rejects(runSetup({ ...f.options, mode: 'status' }), /readable only by its owner/);
  assert.equal(await readFile(join(f.root, '.env'), 'utf8'), 'do not change');
});
test('status only inspects; code is requested explicitly and uses inherited terminal output', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, '.env'), settings('circle.example.org', 'Circle'), { mode: 0o600 });
  await runSetup({ ...f.options, mode: 'status' });
  assert.ok(f.calls.some((args) => args.includes('ps')));
  assert.ok(!f.calls.some((args) => args.includes('up') || args.includes('setup-token')));
  let privateOutput = false;
  await runSetup({
    ...f.options,
    mode: 'code',
    run: async (args: string[], root: string, sensitive: boolean) => {
      if (args.includes('setup-token')) privateOutput = sensitive;
      return f.options.run(args);
    },
  });
  assert.equal(privateOutput, true);
});

test('remote Docker context is refused before settings or container changes', async (t) => {
  const f = await fixture(t);
  const original = f.options.run;
  f.options.run = async (args) =>
    args[0] === 'context' ? { code: 0, output: 'ssh://remote.example.org' } : original(args);
  await assert.rejects(runSetup(f.options), /remote Docker hosts are not supported/);
  await assert.rejects(stat(join(f.root, '.env')), { code: 'ENOENT' });
});
test('a concurrent settings file is never overwritten after the prompts', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    runSetup({
      ...f.options,
      ask: async (question: string) => {
        if (question.startsWith('Type START'))
          await writeFile(join(f.root, '.env'), 'other installation', { mode: 0o600 });
        return f.answers.shift();
      },
    }),
    { code: 'EEXIST' },
  );
  assert.equal(await readFile(join(f.root, '.env'), 'utf8'), 'other installation');
  assert.ok(!f.calls.some((args) => args.includes('up')));
});

test('installation appearing during the START prompt is refused before writing settings', async (t) => {
  const f = await fixture(t);
  let appeared = false;
  const original = f.options.run;
  await assert.rejects(
    runSetup({
      ...f.options,
      ask: async (question: string) => {
        if (question.startsWith('Type START')) appeared = true;
        return f.answers.shift();
      },
      run: async (args: string[]) =>
        appeared && args[0] === 'ps' ? { code: 0, output: 'other-container' } : original(args),
    }),
    /already exists/,
  );
  await assert.rejects(stat(join(f.root, '.env')), { code: 'ENOENT' });
  assert.ok(!f.calls.some((args) => args.includes('up')));
  await assert.rejects(stat(f.options.lockPath), { code: 'ENOENT' });
});

test('two checkouts serialize the entire startup through one host lock', async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  let reached!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = first.options.run;
  const running = runSetup({
    ...first.options,
    run: async (args: string[]) => {
      if (args.includes('up')) {
        reached();
        await held;
      }
      return original(args);
    },
  });
  await entered;
  try {
    await assert.rejects(
      runSetup({ ...second.options, lockPath: first.options.lockPath }),
      /host-wide setup lock/,
    );
    await assert.rejects(stat(join(second.root, '.env')), { code: 'ENOENT' });
    assert.ok(!second.calls.some((args) => args.includes('up')));
    assert.equal((await stat(first.options.lockPath)).mode & 0o777, 0o700);
  } finally {
    release();
    await running;
  }
  await assert.rejects(stat(first.options.lockPath), { code: 'ENOENT' });
});

test('Docker storage shortage or inaccessible data directory is not hidden by free checkout space', async (t) => {
  const f = await fixture(t);
  const paths: string[] = [];
  await assert.rejects(
    runSetup({
      ...f.options,
      storageProbe: async (path: string) => {
        paths.push(path);
        return { bavail: 1024, bsize: 1 };
      },
    }),
    /20 GiB free on Docker/,
  );
  assert.deepEqual(paths, ['/docker-data']);
  await assert.rejects(
    runSetup({
      ...f.options,
      storageProbe: async () => {
        throw new Error('EACCES');
      },
    }),
    /Cannot verify free space on Docker/,
  );
  await assert.rejects(stat(join(f.root, '.env')), { code: 'ENOENT' });
  assert.ok(!f.calls.some((args) => args.includes('up')));
});
