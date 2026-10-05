import test from 'node:test';
import { getEventListeners } from 'node:events';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireContributionLock,
  githubGet,
  atomicWrite,
  ensurePrivateDirectory,
  readPipedConfiguration,
  runContributionWatch,
} from '../scripts/contribution-watch.mjs';

const token = 'test-token-never-log';
const sha = (digit: string) => digit.repeat(40);

function pull(number: number, overrides: Record<string, unknown> = {}) {
  return {
    number,
    title: `PR ${number}`,
    updated_at: '2026-10-05T12:00:00Z',
    draft: false,
    user: { login: `contributor-${number}` },
    head: { sha: sha('a') },
    base: { sha: sha('b') },
    body: 'body content must not be stored',
    ...overrides,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function api(fetcher: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  return (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(init.method, 'GET');
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${token}`);
    return Promise.resolve(fetcher(url, init));
  };
}

async function temporaryState(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'contribution-watch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('empty open-PR snapshot succeeds and creates only private state/report files', async (t) => {
  const stateDir = await temporaryState(t);
  const result = await runContributionWatch({
    token,
    stateDir,
    now: () => new Date('2026-10-05T12:30:00Z'),
    fetchImpl: api((url) => {
      assert.match(url.pathname, /\/pulls$/);
      assert.equal(url.searchParams.get('state'), 'open');
      assert.equal(url.searchParams.get('per_page'), '100');
      return jsonResponse([]);
    }),
  });

  assert.deepEqual(result, {
    ok: true,
    repository: 'Dynobit/clean-bookface',
    fetchedAt: '2026-10-05T12:30:00.000Z',
    openPRs: 0,
    queued: 0,
    unchanged: 0,
  });
  const directory = await stat(stateDir);
  assert.equal(directory.mode & 0o777, 0o700);
  const state = JSON.parse(await readFile(join(stateDir, 'state.json'), 'utf8'));
  assert.deepEqual(state.prs, {});
  assert.match(
    await readFile(join(stateDir, 'report.html'), 'utf8'),
    /Every row is still pending review/,
  );
  assert.deepEqual((await readdir(stateDir)).sort(), ['candidates', 'report.html', 'state.json']);
  assert.equal((await stat(join(stateDir, 'state.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(stateDir, 'report.html'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(stateDir, 'candidates'))).mode & 0o777, 0o700);
});

test('paginates bounded open PRs, summarizes commit status, and queues only changed head/base keys', async (t) => {
  const stateDir = await temporaryState(t);
  let currentPull = pull(7);
  const requests: string[] = [];
  const fetchImpl = api((url) => {
    requests.push(url.pathname);
    if (url.pathname.endsWith('/pulls')) {
      const page = Number(url.searchParams.get('page'));
      return jsonResponse(page === 1 ? [currentPull] : []);
    }
    return jsonResponse({ state: 'success', total_count: 4, statuses: [] });
  });
  const now = () => new Date('2026-10-05T12:30:00Z');

  const first = await runContributionWatch({ token, stateDir, fetchImpl, now });
  assert.equal(first.ok, true);
  assert.equal(first.queued, 1);
  assert.equal(requests.filter((path) => path.endsWith('/pulls')).length, 1);
  assert.equal(requests.filter((path) => path.endsWith('/status')).length, 1);
  const candidateFiles = await readdir(join(stateDir, 'candidates'));
  assert.equal(candidateFiles.length, 1);
  const firstCandidatePath = join(stateDir, 'candidates', candidateFiles[0]);
  const firstCandidate = JSON.parse(await readFile(firstCandidatePath, 'utf8'));
  assert.equal(firstCandidate.reviewStatus, 'pending-review');
  assert.deepEqual(firstCandidate.pullRequest.checks, { state: 'success', totalCount: 4 });
  assert.equal(JSON.stringify(firstCandidate).includes('body content'), false);

  const unchanged = await runContributionWatch({ token, stateDir, fetchImpl, now });
  assert.equal(unchanged.queued, 0);
  assert.equal(unchanged.unchanged, 1);
  assert.equal((await readdir(join(stateDir, 'candidates'))).length, 1);

  currentPull = pull(7, { head: { sha: sha('c') }, updated_at: '2026-10-05T13:00:00Z' });
  const changedHead = await runContributionWatch({ token, stateDir, fetchImpl, now });
  assert.equal(changedHead.queued, 1);
  assert.equal((await readdir(join(stateDir, 'candidates'))).length, 2);
  assert.equal(
    await readFile(firstCandidatePath, 'utf8'),
    `${JSON.stringify(firstCandidate, null, 2)}\n`,
  );

  currentPull = pull(7, { head: { sha: sha('c') }, base: { sha: sha('d') } });
  const changedBase = await runContributionWatch({ token, stateDir, fetchImpl, now });
  assert.equal(changedBase.queued, 1);
  assert.equal((await readdir(join(stateDir, 'candidates'))).length, 3);
});

test('fetch failure preserves the last successful state and labels its report stale', async (t) => {
  const stateDir = await temporaryState(t);
  const successfulFetch = api((url) =>
    url.pathname.endsWith('/pulls')
      ? jsonResponse([pull(9)])
      : jsonResponse({ state: 'pending', total_count: 1 }),
  );
  await runContributionWatch({ token, stateDir, fetchImpl: successfulFetch });
  const previousState = await readFile(join(stateDir, 'state.json'), 'utf8');

  const failedFetch = api((url) =>
    url.pathname.endsWith('/pulls')
      ? jsonResponse([pull(9)])
      : jsonResponse({ message: 'private response details' }, 503),
  );
  const result = await runContributionWatch({
    token,
    stateDir,
    fetchImpl: failedFetch,
    now: () => new Date('2026-10-05T14:00:00Z'),
  });

  assert.deepEqual(result, {
    ok: false,
    repository: 'Dynobit/clean-bookface',
    errorCode: 'github_http_503',
  });
  assert.equal(await readFile(join(stateDir, 'state.json'), 'utf8'), previousState);
  const staleReport = await readFile(join(stateDir, 'report.html'), 'utf8');
  assert.match(staleReport, /Latest check failed/);
  assert.match(staleReport, /snapshot below is stale/);
  assert.match(staleReport, /PR 9/);
  const failure = await readFile(join(stateDir, 'failure.json'), 'utf8');
  assert.match(failure, /github_http_503/);
  assert.doesNotMatch(failure, /private response details|test-token-never-log/);
});

test('unchanged and reopened exact commits preserve the candidate key without another candidate', async (t) => {
  const stateDir = await temporaryState(t);
  let pulls = [pull(1)];
  const fetchImpl = api((url) =>
    jsonResponse(url.pathname.endsWith('/pulls') ? pulls : { state: 'success', total_count: 0 }),
  );
  await runContributionWatch({ token, stateDir, fetchImpl });
  const key = JSON.parse(await readFile(join(stateDir, 'state.json'), 'utf8')).prs['1'].reviewKey;
  await runContributionWatch({ token, stateDir, fetchImpl });
  assert.equal(
    JSON.parse(await readFile(join(stateDir, 'state.json'), 'utf8')).prs['1'].reviewKey,
    key,
  );
  pulls = [];
  await runContributionWatch({ token, stateDir, fetchImpl });
  pulls = [pull(1)];
  assert.equal((await runContributionWatch({ token, stateDir, fetchImpl })).queued, 0);
  assert.equal((await readdir(join(stateDir, 'candidates'))).length, 1);
});

test('GitHub redirects are prohibited and oversized streamed responses are cancelled', async (t) => {
  const stateDir = await temporaryState(t);
  let cancelled = false;
  const result = await runContributionWatch({
    token,
    stateDir,
    fetchImpl: api((_url, init) => {
      assert.equal(init.redirect, 'error');
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(5 * 1024 * 1024 + 1));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    }),
  });
  assert.equal(result.errorCode, 'github_response_too_large');
  assert.equal(cancelled, true);
});

test('fetches a second pull-request page after a full first page', async (t) => {
  const stateDir = await temporaryState(t);
  const pullPages: string[] = [];
  let activeStatuses = 0;
  let maxActiveStatuses = 0;
  const result = await runContributionWatch({
    token,
    stateDir,
    fetchImpl: api(async (url) => {
      if (url.pathname.endsWith('/pulls')) {
        const page = url.searchParams.get('page') ?? '';
        pullPages.push(page);
        return jsonResponse(
          page === '1' ? Array.from({ length: 100 }, (_, index) => pull(index + 1)) : [pull(101)],
        );
      }
      activeStatuses += 1;
      maxActiveStatuses = Math.max(maxActiveStatuses, activeStatuses);
      await new Promise((resolve) => setTimeout(resolve, 1));
      activeStatuses -= 1;
      return jsonResponse({ state: 'success', total_count: 0 });
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.openPRs, 101);
  assert.equal(result.queued, 101);
  assert.deepEqual(pullPages, ['1', '2']);
  assert.ok(maxActiveStatuses <= 5);
});

test('HTML report escapes untrusted titles and authors and uses a GitHub-owned PR URL', async (t) => {
  const stateDir = await temporaryState(t);
  await runContributionWatch({
    token,
    stateDir,
    fetchImpl: api((url) =>
      url.pathname.endsWith('/pulls')
        ? jsonResponse([
            pull(11, {
              title: '<script>alert("x")</script> & "review"',
              user: { login: '<img src=x onerror=alert(1)>' },
              html_url: 'https://attacker.invalid/steal',
            }),
          ])
        : jsonResponse({ state: 'failure', total_count: 2 }),
    ),
  });
  const html = await readFile(join(stateDir, 'report.html'), 'utf8');
  assert.match(
    html,
    /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; &quot;review&quot;/,
  );
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /href="https:\/\/github\.com\/Dynobit\/clean-bookface\/pull\/11"/);
  assert.doesNotMatch(html, /attacker\.invalid|<script>|<img src=x/);
});

test('incomplete pagination and invalid repositories fail closed without advancing successful state', async (t) => {
  const stateDir = await temporaryState(t);
  const first = await runContributionWatch({
    token,
    stateDir,
    fetchImpl: api((url) => jsonResponse(url.pathname.endsWith('/pulls') ? [] : {})),
  });
  assert.equal(first.ok, true);
  const previous = await readFile(join(stateDir, 'state.json'), 'utf8');

  const result = await runContributionWatch({
    token,
    stateDir,
    fetchImpl: api((url) =>
      jsonResponse(
        url.pathname.endsWith('/pulls') ? Array.from({ length: 100 }, (_, i) => pull(i + 1)) : {},
      ),
    ),
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'open_pull_request_limit_exceeded');
  assert.equal(await readFile(join(stateDir, 'state.json'), 'utf8'), previous);

  const invalid = await runContributionWatch({
    token,
    repository: 'evil/path?token=leak',
    stateDir,
    fetchImpl: api(() => jsonResponse([])),
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.errorCode, 'invalid_repository');
});

test('refuses a state directory inside the checkout before creating it', async () => {
  const stateDir = join(
    fileURLToPath(new URL('../', import.meta.url)),
    'tests',
    `.contribution-watch-private-${randomUUID()}`,
  );
  const result = await runContributionWatch({
    token,
    stateDir,
    fetchImpl: api(() => jsonResponse([])),
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'state_directory_inside_checkout');
  await assert.rejects(stat(stateDir), { code: 'ENOENT' });
});

test('fully initialized lock publication admits exactly one contender; stale and corrupt locks fail closed', async (t) => {
  const stateDir = await temporaryState(t);
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, () => acquireContributionLock(stateDir)),
  );
  const winners = results.filter((r) => r.status === 'fulfilled');
  assert.equal(winners.length, 1);
  for (const result of results)
    if (result.status === 'rejected') assert.equal(result.reason.code, 'review_already_running');
  const lock = JSON.parse(await readFile(join(stateDir, 'dispatch.lock'), 'utf8'));
  assert.equal(lock.pid, process.pid);
  assert.ok(lock.nonce);
  await (winners[0] as PromiseFulfilledResult<() => Promise<void>>).value();
  for (const content of [
    '',
    '{bad',
    JSON.stringify({ pid: 999999999, host: hostname(), nonce: 'old' }),
  ]) {
    await writeFile(join(stateDir, 'dispatch.lock'), content);
    const attempts = await Promise.allSettled([
      acquireContributionLock(stateDir),
      acquireContributionLock(stateDir),
    ]);
    for (const result of attempts) {
      assert.equal(result.status, 'rejected');
      assert.equal((result as PromiseRejectedResult).reason.code, 'lock_recovery_required');
    }
    assert.equal(await readFile(join(stateDir, 'dispatch.lock'), 'utf8'), content);
    await rm(join(stateDir, 'dispatch.lock'));
  }
  assert.deepEqual(await readdir(stateDir), []);
});

test('standalone watcher cannot replace the active dispatcher snapshot', async (t) => {
  const stateDir = await temporaryState(t);
  const release = await acquireContributionLock(stateDir);
  let fetched = false;
  const result = await runContributionWatch({
    token,
    stateDir,
    fetchImpl: async () => {
      fetched = true;
      return jsonResponse([]);
    },
  });
  assert.equal(result.errorCode, 'review_already_running');
  assert.equal(fetched, false);
  assert.deepEqual(await readdir(stateDir), ['dispatch.lock']);
  await release();
});

test('failed atomic publications clean scratch; release tolerates an already removed lock', async (t) => {
  const stateDir = await temporaryState(t);
  const target = join(stateDir, 'existing-directory');
  await mkdir(target);
  await assert.rejects(atomicWrite(target, 'private data'));
  assert.deepEqual(await readdir(stateDir), ['existing-directory']);
  const release = await acquireContributionLock(stateDir);
  await rm(join(stateDir, 'dispatch.lock'));
  await release();
});

test('a lost candidate is recreated without requiring head or base movement', async (t) => {
  const stateDir = await temporaryState(t);
  const options = {
    token,
    stateDir,
    fetchImpl: api((url) =>
      jsonResponse(
        url.pathname.endsWith('/pulls') ? [pull(1)] : { state: 'success', total_count: 0 },
      ),
    ),
  };
  await runContributionWatch(options);
  const name = (await readdir(join(stateDir, 'candidates')))[0];
  await rm(join(stateDir, 'candidates', name));
  assert.equal((await runContributionWatch(options)).queued, 1);
  assert.equal(
    JSON.parse(await readFile(join(stateDir, 'candidates', name), 'utf8')).pullRequest.number,
    1,
  );
});

test('canonical checkout boundary rejects an external symlink before writing private state', async (t) => {
  const stateDir = await temporaryState(t);
  const alias = join(stateDir, 'checkout');
  const checkout = fileURLToPath(new URL('../', import.meta.url));
  await symlink(checkout, alias);
  const destination = join(alias, 'tests', `.private-${randomUUID()}`);
  await assert.rejects(ensurePrivateDirectory(destination, { outsideCheckout: true }), {
    code: 'state_directory_inside_checkout',
  });
  await assert.rejects(stat(destination), { code: 'ENOENT' });
});

test('both CLI entry points execute through a symlink and ignore injected library options on stdin', async (t) => {
  const stateDir = await temporaryState(t);
  for (const script of ['contribution-watch.mjs', 'contribution-review.mjs']) {
    const alias = join(stateDir, script);
    await symlink(fileURLToPath(new URL(`../scripts/${script}`, import.meta.url)), alias);
    const help = spawnSync(process.execPath, [alias, '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Usage:/);
  }
  const result = spawnSync(process.execPath, [join(stateDir, 'contribution-review.mjs')], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
    input: JSON.stringify({
      stateDir: join(stateDir, 'state'),
      reviewer: { model: 'gpt-6-astra', reasoningEffort: 'max' },
      now: 'not callable',
      fetchImpl: 'not callable',
      reviewRunner: 'not callable',
    }),
  });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).errorCode, 'missing_or_invalid_token');
});

test('configuration stdin has a bounded wait and size without leaking supplied content', async () => {
  const hanging = new PassThrough();
  await assert.rejects(readPipedConfiguration({ inputStream: hanging, timeoutMs: 5 }), {
    code: 'stdin_configuration_timeout',
  });
  const oversized = new PassThrough();
  oversized.end('private'.repeat(3000));
  await assert.rejects(readPipedConfiguration({ inputStream: oversized }), {
    code: 'stdin_configuration_too_large',
  });
});

test('body-stream network abort is classified without retaining the exception message', async (t) => {
  const stateDir = await temporaryState(t);
  const result = await runContributionWatch({
    token,
    stateDir,
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new DOMException('private details', 'AbortError'));
          },
        }),
      ),
  });
  assert.equal(result.errorCode, 'github_network_error');
  assert.doesNotMatch(await readFile(join(stateDir, 'failure.json'), 'utf8'), /private details/);
});

test('GitHub cancellation aborts pending headers/body reads, cleans listeners and distinguishes timeout', async () => {
  for (const phase of ['headers', 'body', 'success', 'timeout']) {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined,
      cancelled = false;
    const pending = githubGet('/synthetic', {
      token,
      signal: controller.signal,
      timeoutMs: phase === 'timeout' ? 5 : 1000,
      fetchImpl: async (_url: URL, init: RequestInit) => {
        requestSignal = init.signal as AbortSignal;
        if (phase === 'headers' || phase === 'timeout') return new Promise<Response>(() => {});
        if (phase === 'success') return jsonResponse({ ok: true });
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('{'));
            },
            cancel() {
              cancelled = true;
            },
          }),
        );
      },
    });
    if (phase === 'headers' || phase === 'body') {
      await new Promise((resolve) => setImmediate(resolve));
      controller.abort();
      await assert.rejects(pending, { code: 'review_interrupted' });
      assert.equal(requestSignal?.aborted, true);
      if (phase === 'body') assert.equal(cancelled, true);
    } else if (phase === 'timeout') {
      await assert.rejects(pending, { code: 'github_request_timeout' });
      assert.equal(requestSignal?.aborted, true);
    } else assert.deepEqual(await pending, { ok: true });
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(getEventListeners(requestSignal!, 'abort').length, 0);
  }
});
