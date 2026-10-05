#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_REPOSITORY = 'Dynobit/clean-bookface';
export const MAX_PULL_PAGES = 3;
export const PER_PAGE = 100;
export const MAX_PULL_REQUESTS = MAX_PULL_PAGES * PER_PAGE - 1;
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 15_000;
const API_ROOT = 'https://api.github.com';
const STATE_VERSION = 1;
export const DEFAULT_STATE_DIR = join(
  homedir(),
  '.local',
  'state',
  'clean-bookface',
  'contribution-review',
);
const CHECKOUT_ROOT = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const heldLocks = new WeakMap();

export class ContributionWatchError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'ContributionWatchError';
    this.code = code;
  }
}

export function fail(code) {
  throw new ContributionWatchError(code);
}

export function parseRepository(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    fail('invalid_repository');
  }
  if (value.split('/').some((part) => part === '.' || part === '..')) fail('invalid_repository');
  return value;
}

export function normalizeSha(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40,64}$/i.test(value)) fail('invalid_commit_sha');
  return value.toLowerCase();
}

function normalizeTimestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    fail('invalid_pull_request_timestamp');
  return new Date(value).toISOString();
}

function boundedText(value, max = 500) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function normalizeCheckState(value) {
  if (value === 'success' || value === 'failure' || value === 'error' || value === 'pending')
    return value;
  return 'unknown';
}

function normalizePullRequest(raw, repository) {
  if (!raw || !Number.isSafeInteger(raw.number) || raw.number < 1) fail('invalid_pull_request');
  const [owner, repo] = repository.split('/');
  const author = raw.user && typeof raw.user.login === 'string' ? raw.user.login : '';
  return {
    number: raw.number,
    title: boundedText(raw.title),
    author: boundedText(author, 100),
    url: `https://github.com/${owner}/${repo}/pull/${raw.number}`,
    headSha: normalizeSha(raw.head?.sha),
    baseSha: normalizeSha(raw.base?.sha),
    draft: raw.draft === true,
    updatedAt: normalizeTimestamp(raw.updated_at),
  };
}

export function reviewKey(repository, pull) {
  const material = `${repository}\n${pull.number}\n${pull.headSha}\n${pull.baseSha}`;
  return createHash('sha256').update(material).digest('hex');
}

export async function ensurePrivateDirectory(path, { outsideCheckout = false } = {}) {
  if (outsideCheckout) {
    let ancestor = resolve(path);
    for (;;) {
      try {
        const canonicalAncestor = await realpath(ancestor);
        if (isInside(CHECKOUT_ROOT, resolve(canonicalAncestor, relative(ancestor, resolve(path)))))
          fail('state_directory_inside_checkout');
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const parent = dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  const canonicalPath = await realpath(path);
  if (outsideCheckout && isInside(CHECKOUT_ROOT, canonicalPath))
    fail('state_directory_inside_checkout');
  if ((await lstat(path)).isSymbolicLink()) fail('symlink_state_directory');
  await chmod(path, 0o700);
  const details = await stat(path);
  if (!details.isDirectory()) fail('invalid_state_directory');
  return canonicalPath;
}

function isInside(parent, child) {
  const pathFromParent = relative(parent, child);
  return (
    pathFromParent === '' ||
    (!pathFromParent.startsWith(`..${sep}`) &&
      pathFromParent !== '..' &&
      !isAbsolute(pathFromParent))
  );
}

export async function atomicWrite(path, content) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(content, 'utf8');
    await file.sync();
    await file.close();
    file = null;
    await rename(temporary, path);
  } finally {
    await file?.close();
    await unlink(temporary).catch(() => {});
  }
}

export async function writeImmutable(path, content) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(content, 'utf8');
    await file.sync();
    await file.close();
    file = null;
    await link(temporary, path);
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  } finally {
    await file?.close();
    await unlink(temporary).catch(() => {});
  }
}

// Publish complete identity with link(2). Never steal an existing lock: even a
// dead parent may have an orphaned model child. Recovery requires quiescence.
export async function acquireContributionLock(stateDir) {
  const path = join(stateDir, 'dispatch.lock');
  const identity = { pid: process.pid, host: hostname(), nonce: randomUUID() };
  if (!(await writeImmutable(path, JSON.stringify(identity) + '\n'))) {
    let old;
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error();
      old = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      fail('lock_recovery_required');
    }
    if (old?.host === hostname() && Number.isSafeInteger(old.pid) && old.pid > 0) {
      try {
        process.kill(old.pid, 0);
      } catch {
        fail('lock_recovery_required');
      }
      fail('review_already_running');
    }
    fail('lock_recovery_required');
  }
  const release = async () => {
    heldLocks.delete(release);
    try {
      const current = JSON.parse(await readFile(path, 'utf8'));
      if (current.nonce !== identity.nonce) fail('lock_release_failed');
      await unlink(path);
    } catch (error) {
      if (error.code !== 'ENOENT') fail('lock_release_failed');
    }
  };
  heldLocks.set(release, stateDir);
  return release;
}

async function readState(path, repository) {
  try {
    const state = JSON.parse(await readFile(path, 'utf8'));
    if (
      state?.version !== STATE_VERSION ||
      state.repository !== repository ||
      !state.prs ||
      typeof state.prs !== 'object'
    ) {
      fail('invalid_state');
    }
    return state;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof ContributionWatchError) throw error;
    fail('invalid_state');
  }
}

export function checkCancellation(signal) {
  if (signal?.aborted)
    fail(
      signal.reason === 'review_deadline_reached'
        ? 'review_deadline_reached'
        : 'review_interrupted',
    );
}

export async function githubGet(
  path,
  { token, fetchImpl, maxBytes = MAX_RESPONSE_BYTES, signal, timeoutMs = REQUEST_TIMEOUT_MS },
) {
  checkCancellation(signal);
  const url = new URL(path, API_ROOT);
  if (url.origin !== API_ROOT) fail('invalid_api_url');
  const request = new AbortController();
  let abortCode;
  let rejectAbort;
  const aborted = new Promise((_, reject) => {
    rejectAbort = reject;
  });
  // A race below observes rejection even for injected transports that ignore signal.
  const abort = (code) => {
    if (abortCode) return;
    abortCode = code;
    request.abort();
    rejectAbort(new ContributionWatchError(code));
  };
  const onAbort = () =>
    abort(
      signal?.reason === 'review_deadline_reached'
        ? 'review_deadline_reached'
        : 'review_interrupted',
    );
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => abort('github_request_timeout'), timeoutMs);
  let reader;
  const cancelBody = () => {
    if (reader) void reader.cancel().catch(() => {});
  };
  request.signal.addEventListener('abort', cancelBody, { once: true });
  try {
    if (signal?.aborted) onAbort();
    checkCancellation(signal);
    let response;
    try {
      response = await Promise.race([
        fetchImpl(url, {
          method: 'GET',
          redirect: 'error',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'clean-bookface-contribution-watch',
          },
          signal: request.signal,
        }),
        aborted,
      ]);
    } catch {
      fail(abortCode ?? 'github_network_error');
    }
    checkCancellation(signal);
    if (!response?.ok) {
      const status = Number.isInteger(response?.status) ? response.status : 0;
      fail(
        status === 401 || status === 403
          ? 'github_auth_or_permission_error'
          : `github_http_${status || 'error'}`,
      );
    }
    try {
      if (Number(response.headers.get('content-length') ?? 0) > maxBytes)
        fail('github_response_too_large');
      reader = response.body?.getReader();
      if (!reader) fail('github_invalid_json');
      const chunks = [];
      let size = 0;
      for (;;) {
        checkCancellation(signal);
        const part = await Promise.race([reader.read(), aborted]);
        if (abortCode) fail(abortCode);
        if (part.done) break;
        size += part.value.byteLength;
        if (size > maxBytes) {
          cancelBody();
          fail('github_response_too_large');
        }
        chunks.push(part.value);
      }
      checkCancellation(signal);
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      if (abortCode) fail(abortCode);
      if (error instanceof ContributionWatchError) throw error;
      if (['AbortError', 'TimeoutError'].includes(error?.name)) fail('github_network_error');
      fail('github_invalid_json');
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    request.signal.removeEventListener('abort', cancelBody);
    reader?.releaseLock();
  }
}

async function fetchOpenPullRequests({ repository, token, fetchImpl, signal }) {
  const [owner, repo] = repository.split('/');
  const all = [];
  for (let page = 1; page <= MAX_PULL_PAGES; page += 1) {
    const query = new URLSearchParams({
      state: 'open',
      per_page: String(PER_PAGE),
      page: String(page),
    });
    const response = await githubGet(`/repos/${owner}/${repo}/pulls?${query}`, {
      token,
      fetchImpl,
      signal,
    });
    if (!Array.isArray(response)) fail('invalid_pull_request_response');
    for (const raw of response) {
      all.push(normalizePullRequest(raw, repository));
      if (all.length > MAX_PULL_REQUESTS) fail('open_pull_request_limit_exceeded');
    }
    if (response.length < PER_PAGE) return all;
  }
  fail('pull_request_pagination_limit_exceeded');
}

async function fetchCheckSummary({ repository, pull, token, fetchImpl, signal }) {
  const [owner, repo] = repository.split('/');
  const raw = await githubGet(`/repos/${owner}/${repo}/commits/${pull.headSha}/status`, {
    token,
    fetchImpl,
    signal,
  });
  if (!raw || !Number.isSafeInteger(raw.total_count) || raw.total_count < 0)
    fail('invalid_check_summary');
  return { state: normalizeCheckState(raw.state), totalCount: raw.total_count };
}

async function mapWithLimit(items, limit, mapper, signal) {
  const results = new Array(items.length);
  let nextIndex = 0,
    stopped = false;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    try {
      for (;;) {
        checkCancellation(signal);
        if (stopped || nextIndex >= items.length) return;
        const index = nextIndex++;
        results[index] = await mapper(items[index]);
      }
    } catch (error) {
      stopped = true;
      throw error;
    }
  });
  const settled = await Promise.allSettled(workers);
  checkCancellation(signal);
  const failed = settled.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
  return results;
}

export function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character],
  );
}

function renderReport({
  repository,
  fetchedAt,
  pulls,
  queued,
  unchanged,
  failure,
  embedded = false,
}) {
  const rows = pulls
    .map(
      (pull) => `
    <tr>
      <td><a href="${escapeHtml(pull.url)}">#${pull.number}</a></td>
      <td>${escapeHtml(pull.title)}</td>
      <td>${escapeHtml(pull.author)}</td>
      <td><code>${pull.headSha}</code></td>
      <td><code>${pull.baseSha}</code></td>
      <td>${pull.draft ? 'draft' : 'ready'}</td>
      <td>${escapeHtml(pull.checks.state)} (${pull.checks.totalCount})</td>
      <td>${embedded ? 'See review dashboard' : 'review pending'}</td>
    </tr>`,
    )
    .join('');
  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="robots" content="noindex,nofollow">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'">
<title>Private contribution review queue</title>
<h1>Private contribution review queue</h1>
${failure ? `<p role="alert"><strong>Latest check failed at ${escapeHtml(failure.failedAt)} (${escapeHtml(failure.errorCode)}). The snapshot below is stale; no new review was authorized by this check.</strong></p>` : ''}
<p>Repository: ${escapeHtml(repository)}. Snapshot: ${escapeHtml(fetchedAt)}.</p>
<p>${pulls.length} open pull requests; ${queued} new review candidates; ${unchanged} unchanged review keys.</p>
<p>${embedded ? 'This snapshot gathers metadata. Review results are in <a href="dashboard.html">the private dashboard</a>.' : 'This check gathers GitHub metadata only. It does not inspect diffs or perform reviews. Every row is still pending review.'}</p>
<table><caption>Open contribution snapshot</caption><thead><tr><th>PR</th><th>Title</th><th>Author</th><th>Head</th><th>Base</th><th>State</th><th>Commit status</th><th>Review</th></tr></thead>
<tbody>${rows}</tbody></table></html>
`;
}

async function recordFailure({ stateDir, repository, now, error, embedded }) {
  const code = error instanceof ContributionWatchError ? error.code : 'internal_error';
  const failure = { version: 1, repository, failedAt: now().toISOString(), errorCode: code };
  await atomicWrite(join(stateDir, 'failure.json'), `${JSON.stringify(failure, null, 2)}\n`);
  const previous = await readState(join(stateDir, 'state.json'), repository).catch(() => null);
  await atomicWrite(
    join(stateDir, 'report.html'),
    renderReport({
      repository,
      fetchedAt: previous?.fetchedAt ?? 'No successful snapshot',
      pulls: Object.values(previous?.prs ?? {}),
      queued: 0,
      unchanged: 0,
      failure,
      embedded,
    }),
  );
  return { ok: false, repository, errorCode: code };
}

export async function runContributionWatch(options = {}) {
  let repository;
  try {
    repository = parseRepository(options.repository ?? DEFAULT_REPOSITORY);
  } catch (error) {
    return {
      ok: false,
      repository: options.repository ?? DEFAULT_REPOSITORY,
      errorCode: error instanceof ContributionWatchError ? error.code : 'invalid_repository',
    };
  }
  const token = options.token;
  if (
    typeof token !== 'string' ||
    token.length < 1 ||
    token.length > 4096 ||
    /[\r\n]/.test(token)
  ) {
    return { ok: false, repository, errorCode: 'missing_or_invalid_token' };
  }
  const requestedStateDir = resolve(options.stateDir ?? DEFAULT_STATE_DIR);
  let stateDir = requestedStateDir;
  let safeStateDir = false;
  let release;
  const embedded = heldLocks.get(options.lockCapability) === requestedStateDir;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const signal = options.signal;
  const now = options.now ?? (() => new Date());
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') {
    return { ok: false, repository, errorCode: 'invalid_runner_configuration' };
  }
  try {
    checkCancellation(signal);
    if (isInside(CHECKOUT_ROOT, requestedStateDir)) fail('state_directory_inside_checkout');
    stateDir = await ensurePrivateDirectory(requestedStateDir, { outsideCheckout: true });
    if (!embedded) release = await acquireContributionLock(stateDir);
    safeStateDir = true;
    const statePath = join(stateDir, 'state.json');
    await readState(statePath, repository);
    const fetchedAt = now().toISOString();

    // Fetch and validate the complete bounded snapshot before touching successful state.
    const openPullRequests = await fetchOpenPullRequests({ repository, token, fetchImpl, signal });
    const pulls = await mapWithLimit(
      openPullRequests,
      5,
      async (pull) => ({
        ...pull,
        checks: await fetchCheckSummary({ repository, pull, token, fetchImpl, signal }),
      }),
      signal,
    );
    checkCancellation(signal);
    const nextPrs = Object.fromEntries(pulls.map((pull) => [String(pull.number), pull]));

    await ensurePrivateDirectory(join(stateDir, 'candidates'));
    let queued = 0;
    let unchanged = 0;
    for (const pull of pulls) {
      checkCancellation(signal);
      const key = reviewKey(repository, pull);
      nextPrs[String(pull.number)].reviewKey = key;
      const candidate = {
        version: 1,
        reviewKey: key,
        repository,
        pullRequest: {
          number: pull.number,
          title: pull.title,
          author: pull.author,
          url: pull.url,
          headSha: pull.headSha,
          baseSha: pull.baseSha,
          draft: pull.draft,
          updatedAt: pull.updatedAt,
          checks: pull.checks,
        },
        reviewStatus: 'pending-review',
        queuedAt: fetchedAt,
      };
      const created = await writeImmutable(
        join(stateDir, 'candidates', `${key}.json`),
        `${JSON.stringify(candidate, null, 2)}\n`,
      );
      if (created) queued += 1;
      else unchanged += 1;
      nextPrs[String(pull.number)].reviewKey = key;
    }

    checkCancellation(signal);
    const html = renderReport({ repository, fetchedAt, pulls, queued, unchanged, embedded });
    await atomicWrite(join(stateDir, 'report.html'), html);
    checkCancellation(signal);
    const nextState = { version: STATE_VERSION, repository, fetchedAt, prs: nextPrs };
    await atomicWrite(statePath, `${JSON.stringify(nextState, null, 2)}\n`);
    await unlink(join(stateDir, 'failure.json')).catch(() => {});
    checkCancellation(signal);
    return { ok: true, repository, fetchedAt, openPRs: pulls.length, queued, unchanged };
  } catch (error) {
    if (safeStateDir) {
      try {
        return await recordFailure({ stateDir, repository, now, error, embedded });
      } catch {
        return { ok: false, repository, errorCode: 'state_write_error' };
      }
    }
    return {
      ok: false,
      repository,
      errorCode: error instanceof ContributionWatchError ? error.code : 'invalid_state_directory',
    };
  } finally {
    if (release) {
      try {
        await release();
      } catch {
        return { ok: false, repository, errorCode: 'lock_release_failed' };
      }
    }
  }
}

export async function readPipedConfiguration({
  inputStream = process.stdin,
  timeoutMs = 30_000,
} = {}) {
  if (inputStream.isTTY) return {};
  let input = '';
  const timer = setTimeout(
    () => inputStream.destroy(new ContributionWatchError('stdin_configuration_timeout')),
    timeoutMs,
  );
  try {
    for await (const chunk of inputStream) {
      input += chunk;
      if (Buffer.byteLength(input) > 16 * 1024) fail('stdin_configuration_too_large');
    }
  } finally {
    clearTimeout(timer);
  }
  if (!input.trim()) return {};
  try {
    const config = JSON.parse(input);
    if (!config || typeof config !== 'object' || Array.isArray(config))
      fail('invalid_stdin_configuration');
    return config;
  } catch {
    fail('invalid_stdin_configuration');
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(
      'Usage: node scripts/contribution-watch.mjs [--repo OWNER/REPO] [--state-dir PATH]\nReads optional JSON configuration from piped stdin; GITHUB_TOKEN may supply the token.\n',
    );
    return;
  }
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    if ((args[i] === '--repo' || args[i] === '--state-dir') && args[i + 1]) {
      options[args[i] === '--repo' ? 'repository' : 'stateDir'] = args[++i];
    } else {
      process.stderr.write('Invalid arguments. Use --help.\n');
      process.exitCode = 2;
      return;
    }
  }
  let config = {};
  try {
    config = await readPipedConfiguration();
  } catch {
    process.stderr.write('Invalid configuration input.\n');
    process.exitCode = 2;
    return;
  }
  const repository =
    options.repository ??
    process.env.CONTRIBUTION_WATCH_REPOSITORY ??
    config.repository ??
    DEFAULT_REPOSITORY;
  const stateDir =
    options.stateDir ??
    process.env.CONTRIBUTION_WATCH_STATE_DIR ??
    config.stateDir ??
    DEFAULT_STATE_DIR;
  const token = process.env.GITHUB_TOKEN ?? config.token;
  const result = await runContributionWatch({ repository, stateDir, token });
  if (!result.ok) {
    process.stderr.write(`Contribution snapshot failed: ${result.errorCode}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `Contribution snapshot complete: ${result.openPRs} open PRs, ${result.queued} pending review candidates.\n`,
  );
}

if (import.meta.main) {
  main().catch(() => {
    process.stderr.write('Contribution snapshot failed: internal_error\n');
    process.exitCode = 1;
  });
}
