#!/usr/bin/env node
/** Isolated, bounded encrypted-browser qualification; all generated data stays outside Git. */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  realpathSync,
  openSync,
  closeSync,
} from 'node:fs';
import { dirname, join, resolve, isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const client = join(root, 'encrypted-client');
const require = createRequire(join(client, 'package.json'));
const suites = new Set([
  'journey',
  'concurrent-import',
  'migration',
  'social-lifecycle',
  'local-cleanup',
  'large-import',
]);
// Reports can contain access tokens, recovery keys and decrypted page text. Only
// emit source-owned static titles, bounded line numbers, counts and fixed enums.
export function safeFailureSummary(report, suite) {
  if (!suites.has(suite)) return { classification: 'unrecognized-suite' };
  const file = `encrypted-client/tests/browser/${suite}.spec.ts`;
  const source = readFileSync(join(root, file), 'utf8');
  const lineCount = source.split('\n').length;
  const titles = new Set([...source.matchAll(/\btest\(\s*'([^'\n]+)'/g)].map((m) => m[1]));
  const count = (value) =>
    Number.isSafeInteger(value) && value >= 0 && value <= 100000 ? value : 0;
  const classify = (error) => {
    const message = typeof error?.message === 'string' ? error.message : '';
    if (/webServer/i.test(message) && /timed? ?out|timeout/i.test(message))
      return 'preview-startup-timeout';
    if (/executable.*doesn.t exist|browserType\.launch/i.test(message)) return 'browser-launch';
    if (/timed? ?out|timeout/i.test(message)) return 'timeout';
    if (/expect\(|assertion/i.test(message)) return 'assertion';
    return 'test-or-runner-error';
  };
  const failures = [];
  function visit(node) {
    if (!node || typeof node !== 'object' || failures.length >= 20) return;
    for (const spec of Array.isArray(node.specs) ? node.specs : []) {
      for (const test of Array.isArray(spec.tests) ? spec.tests : []) {
        for (const result of Array.isArray(test.results) ? test.results : []) {
          if (!['failed', 'timedOut', 'interrupted'].includes(result.status)) continue;
          const error = result.error || result.errors?.[0];
          const frame =
            typeof error?.stack === 'string'
              ? error.stack.match(new RegExp(`${suite}\\.spec\\.ts:(\\d+):(\\d+)`))
              : null;
          const rawLine = Number(frame?.[1] || error?.location?.line || spec.line);
          failures.push({
            title: titles.has(spec.title) ? spec.title : 'Unrecognized test title omitted',
            file,
            line: Number.isInteger(rawLine) && rawLine > 0 && rawLine <= lineCount ? rawLine : null,
            classification: classify(error),
          });
          if (failures.length >= 20) return;
        }
      }
    }
    for (const child of Array.isArray(node.suites) ? node.suites : []) visit(child);
  }
  visit(report);
  return {
    suite,
    counts: Object.fromEntries(
      ['expected', 'unexpected', 'flaky', 'skipped'].map((key) => [
        key,
        count(report?.stats?.[key]),
      ]),
    ),
    failures,
    runnerErrors: (Array.isArray(report?.errors) ? report.errors : []).slice(0, 10).map(classify),
  };
}
function printSafeFailure(work, suite) {
  try {
    console.error(
      'Browser failure summary: ' +
        JSON.stringify(
          safeFailureSummary(
            JSON.parse(readFileSync(join(work, 'browser-results.json'), 'utf8')),
            suite,
          ),
        ),
    );
  } catch {
    console.error('Browser failure summary: report unavailable; private diagnostics retained');
  }
}
function parse(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (['--cleanup', '--imported-images'].includes(key)) options[key.slice(2)] = true;
    else if (['--suite', '--work', '--host-port', '--client-port'].includes(key) && argv[i + 1])
      options[key.slice(2)] = argv[++i];
    else
      throw new Error(
        'Use --suite NAME --work ABSOLUTE_NEW_DIRECTORY [--host-port N --client-port N --imported-images], or --cleanup --work DIRECTORY',
      );
  }
  if (typeof options.work !== 'string' || !isAbsolute(options.work))
    throw new Error('An absolute work directory outside the checkout is required');
  options.work = resolve(options.work);
  const parent = realpathSync(dirname(options.work));
  options.work = join(parent, options.work.split(sep).at(-1));
  if (options.work === root || !relative(root, options.work).startsWith(`..${sep}`))
    throw new Error('Generated data must stay outside the checkout');
  if (!options.cleanup && !suites.has(options.suite))
    throw new Error('Select one supported browser suite');
  for (const [key, fallback] of [
    ['host-port', '18152'],
    ['client-port', '5177'],
  ]) {
    options[key] = Number(options[key] ?? fallback);
    if (!Number.isInteger(options[key]) || options[key] < 1024 || options[key] > 65535)
      throw new Error('Invalid local port');
  }
  return options;
}
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
function run(
  command,
  args,
  work,
  label,
  { cwd = root, env = process.env, timeout = 300_000 } = {},
) {
  const log = openSync(join(work, `${label}.log`), 'a', 0o600);
  try {
    const result = spawnSync(command, args, { cwd, env, timeout, stdio: ['ignore', log, log] });
    if (result.error || result.status !== 0)
      throw new Error(
        `${label} failed (${result.error?.code ?? result.status ?? result.signal}); private diagnostics: ${join(work, `${label}.log`)}`,
      );
  } finally {
    closeSync(log);
  }
}
function cleanup(work) {
  if (!existsSync(work)) return;
  const marker = JSON.parse(readFileSync(join(work, 'owner.json'), 'utf8'));
  if (
    marker.schema !== 'clean-bookface-browser-ci/1' ||
    marker.work !== realpathSync(work) ||
    marker.root !== root
  )
    throw new Error('Refusing cleanup without this harness’s exact ownership marker');
  const runtime = join(work, 'host');
  if (!existsSync(join(runtime, 'state.json'))) return;
  const state = JSON.parse(readFileSync(join(runtime, 'state.json'), 'utf8'));
  if (
    state.mode !== 'local' ||
    resolve(state.runtime) !== runtime ||
    !/^cbf-e2ee-[a-f0-9]{10}$/.test(state.project)
  )
    throw new Error('Refusing cleanup of an unexpected host');
  run(
    'python3',
    [join(root, 'encrypted-host', 'host.py'), 'destroy-local', '--runtime', runtime],
    work,
    'cleanup',
    { timeout: 120_000 },
  );
  writeFileSync(
    join(work, 'cleanup.json'),
    JSON.stringify({ project: state.project, removed: true }),
    { mode: 0o600 },
  );
}
function qualify(options) {
  const work = options.work;
  if (process.arch !== 'arm64') throw new Error('Pinned host images require an ARM64 runner');
  if (existsSync(work)) throw new Error('Qualification requires a new work directory');
  mkdirSync(work, { mode: 0o700 });
  writeFileSync(
    join(work, 'owner.json'),
    JSON.stringify({ schema: 'clean-bookface-browser-ci/1', work, root, id: randomUUID() }),
    { mode: 0o600 },
  );
  let failed;
  try {
    const runtime = join(work, 'host');
    const hostArgs = [
      join(root, 'encrypted-host', 'host.py'),
      'bootstrap',
      '--runtime',
      runtime,
      '--port',
      String(options['host-port']),
      '--test-rate-profile',
    ];
    if (options['imported-images']) hostArgs.push('--imported-images');
    console.log(`Preparing isolated ${options.suite} host`);
    run('python3', hostArgs, work, 'bootstrap');
    run(
      'python3',
      [join(root, 'encrypted-host', 'host.py'), 'check', '--runtime', runtime],
      work,
      'host-check',
    );
    const dist = join(work, 'client-dist');
    const vite = join(dirname(require.resolve('vite/package.json')), 'bin', 'vite.js');
    run(process.execPath, [vite, 'build', '--outDir', dist], work, 'build', { cwd: client });
    const baseURL = `http://127.0.0.1:${options['client-port']}`;
    const config = {
      testDir: join(client, 'tests', 'browser'),
      testMatch: `${options.suite}.spec.ts`,
      timeout: 120_000,
      globalTimeout: 900_000,
      workers: 1,
      retries: 0,
      maxFailures: 1,
      forbidOnly: true,
      outputDir: join(work, 'browser-output'),
      reporter: [['json', { outputFile: join(work, 'browser-results.json') }]],
      use: {
        baseURL,
        browserName: 'chromium',
        viewport: { width: 1280, height: 720 },
        trace: 'off',
        screenshot: 'off',
        video: 'off',
        ...(process.platform === 'darwin' ? { channel: 'chrome' } : {}),
      },
      webServer: {
        command: [
          process.execPath,
          vite,
          'preview',
          '--outDir',
          dist,
          '--port',
          String(options['client-port']),
        ]
          .map(shellQuote)
          .join(' '),
        cwd: client,
        url: baseURL,
        reuseExistingServer: false,
        timeout: 30_000,
      },
    };
    const configPath = join(work, 'playwright.config.mjs');
    // Standby recovery and opt-in private screenshots remain separate qualification.
    // Exclude only those named manual cases; every admitted test must run without skips.
    const exclude =
      options.suite === 'journey'
        ? ', grepInvert: /a restored standby opens signed memories/'
        : options.suite === 'social-lifecycle'
          ? ', grepInvert: /(?:^| )capture the real encrypted feed with fictional memories$/'
          : '';
    writeFileSync(configPath, `export default { ...${JSON.stringify(config)}${exclude} };\n`, {
      mode: 0o600,
    });
    const env = {
      ...process.env,
      CBF_TEST_HOST_RUNTIME: runtime,
      CBF_TEST_SOCIAL_RUNTIME: runtime,
      CBF_LARGE_BROWSER_RUNTIME: runtime,
      CBF_TEST_RECOVERY_KITS: join(work, 'recovery-kits.json'),
    };
    delete env.CBF_TEST_STANDBY;
    console.log(
      `Running ${options.suite}; diagnostics and recovery kits remain in the private work directory`,
    );
    run(
      process.execPath,
      [
        join(dirname(require.resolve('playwright/package.json')), 'cli.js'),
        'test',
        '--config',
        configPath,
      ],
      work,
      'browser',
      { cwd: client, env, timeout: 930_000 },
    );
    const report = JSON.parse(readFileSync(join(work, 'browser-results.json'), 'utf8'));
    if (
      !report.stats ||
      report.stats.expected < 1 ||
      report.stats.unexpected ||
      report.stats.flaky ||
      report.stats.skipped
    )
      throw new Error(
        'Browser acceptance requires at least one passed test, zero failures, zero flakes and zero unexpected skips',
      );
    console.log(
      `PASS ${options.suite}: ${report.stats.expected} tests; no failures or skips. Federation and restored-standby qualification are separate.`,
    );
  } catch (error) {
    printSafeFailure(work, options.suite);
    failed = error;
  }
  try {
    cleanup(work);
  } catch (error) {
    failed = failed
      ? new AggregateError(
          [failed, error],
          'Qualification and cleanup failed; inspect private logs',
        )
      : error;
  }
  if (failed) throw failed;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parse(process.argv.slice(2));
    if (options.cleanup) cleanup(options.work);
    else qualify(options);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'Encrypted browser qualification failed',
    );
    process.exitCode = 1;
  }
}
