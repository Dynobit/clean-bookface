#!/usr/bin/env node
// Privileged metadata-only intake. Never imports or executes contribution content.
import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const REPOSITORY = 'Dynobit/clean-bookface';
export const LIMITS = Object.freeze({
  requests: 240,
  writes: 80,
  pages: 2,
  pageSize: 100,
  responseBytes: 2_000_000,
  timeoutMs: 180_000,
  requestMs: 10_000,
  batchSize: 5,
});
export const LABELS = Object.freeze({
  'automation:intake': 'Recorded by metadata intake; not a review or approval.',
  'automation:needs-review': 'Maintainer review required; automation never approves.',
  'automation:draft': 'Draft pull request.',
  'automation:ci-pending':
    'Verification missing, incomplete, or not attributable to this revision.',
  'automation:ci-failing': 'Verification reports a failed job for this revision.',
  'automation:area-server': 'Changes under src/ or public/.',
  'automation:area-encrypted-client': 'Changes under encrypted-client/.',
  'automation:area-encrypted-host': 'Changes under encrypted-host/.',
  'automation:area-docs': 'Documentation changes.',
  'automation:area-tooling': 'Workflow, test, script or other repository changes.',
});
const fail = (code) => {
  throw new Error(code);
};
const number = (n) => (Number.isSafeInteger(n) && n > 0 ? n : fail('invalid_number'));
const sha = (s) =>
  typeof s === 'string' && /^[a-f0-9]{40}$/.test(s) ? s : fail('invalid_revision');
const owned = (labels) =>
  new Set(
    (labels ?? [])
      .map((l) => (typeof l === 'string' ? l : l.name))
      .filter((l) => Object.hasOwn(LABELS, l)),
  );
function area(path) {
  if (typeof path !== 'string') fail('invalid_filename');
  if (/^(src|public)\//.test(path)) return 'automation:area-server';
  if (path.startsWith('encrypted-client/')) return 'automation:area-encrypted-client';
  if (path.startsWith('encrypted-host/')) return 'automation:area-encrypted-host';
  if (path.startsWith('docs/') || /\.md$/i.test(path)) return 'automation:area-docs';
  return 'automation:area-tooling';
}

export async function runMaintenance({
  repository,
  token,
  event = {},
  eventName = 'schedule',
  fetchImpl = fetch,
  signal,
  now = Date.now,
}) {
  if (repository !== REPOSITORY) fail('unauthorized_repository');
  if (!token) fail('missing_token');
  if (
    !['issues', 'pull_request_target', 'schedule', 'workflow_dispatch', 'workflow_run'].includes(
      eventName,
    )
  )
    fail('unsupported_event');
  const combined = AbortSignal.any([
    AbortSignal.timeout(LIMITS.timeoutMs),
    ...(signal ? [signal] : []),
  ]);
  const result = {
    inspected: 0,
    changed: [],
    moved: [],
    requests: 0,
    writes: 0,
    truncated: false,
    inventory: 0,
    deferred: 0,
    inventoryTruncated: false,
    rotationBatch: 1,
    rotationBatches: 1,
    budgetDeferred: false,
  };
  async function api(route, method = 'GET', body) {
    combined.throwIfAborted();
    const getRoute =
      /^(?:labels|issues(?:\/[1-9]\d*)?|pulls\/[1-9]\d*(?:\/files)?|actions\/workflows\/ci\.yml(?:\/runs)?|actions\/runs\/[1-9]\d*\/jobs)(?:\?[a-zA-Z0-9_=&.-]+)?$/;
    const writeRoute =
      method === 'POST' && (route === 'labels' || /^issues\/[1-9]\d*\/labels$/.test(route));
    const deleteRoute =
      method === 'DELETE' && /^issues\/[1-9]\d*\/labels\/automation%3A[a-z-]+$/.test(route);
    if (!(method === 'GET' ? getRoute.test(route) : writeRoute || deleteRoute))
      fail('forbidden_route');
    if (++result.requests > LIMITS.requests) fail('request_limit');
    if (method !== 'GET' && ++result.writes > LIMITS.writes) fail('write_limit');
    const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/${route}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.any([combined, AbortSignal.timeout(LIMITS.requestMs)]),
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'content-type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) fail(`github_status_${response.status}`);
    if (Number(response.headers.get('content-length')) > LIMITS.responseBytes)
      fail('response_limit');
    const reader = response.body?.getReader();
    let size = 0;
    const chunks = [];
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > LIMITS.responseBytes) fail('response_limit');
          chunks.push(Buffer.from(value));
        }
      } finally {
        await reader.cancel();
      }
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : null;
  }
  async function pages(route, key) {
    const items = [];
    for (let page = 1; page <= LIMITS.pages; page++) {
      const data = await api(`${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const batch = key ? data[key] : data;
      if (!Array.isArray(batch) || batch.length > 100) fail('invalid_page');
      items.push(...batch);
      if (batch.length < 100) return { items, complete: true };
    }
    result.truncated = true;
    return { items, complete: false };
  }
  const existing = await pages('labels');
  if (!existing.complete) fail('label_inventory_incomplete');
  const names = new Set(existing.items.map((l) => l.name));
  for (const [name, description] of Object.entries(LABELS)) {
    if (!names.has(name)) await api('labels', 'POST', { name, description, color: 'ededed' });
  }
  let items;
  if (['issues', 'pull_request_target'].includes(eventName)) {
    const n = number(event.issue?.number ?? event.pull_request?.number);
    items = [await api(`issues/${n}`)];
  } else if (eventName === 'workflow_run') {
    // An old PR's completed run must not wait behind the scheduled inventory.
    // Event metadata selects numbers only; CI attribution is independently read below.
    const prs = event.workflow_run?.pull_requests;
    if (!Array.isArray(prs) || prs.length > 20) fail('invalid_run_targets');
    items = [];
    for (const n of new Set(prs.map((pr) => number(pr.number)))) {
      items.push(await api(`issues/${n}`));
    }
  } else if (['schedule', 'workflow_dispatch'].includes(eventName)) {
    const inventory = await pages('issues?state=open&sort=updated&direction=desc');
    items = inventory.items;
    result.inventoryTruncated = !inventory.complete;
  } else fail('unsupported_event');
  // Deduplicate a paginated inventory that may move during its own read.
  items = [...new Map(items.map((item) => [number(item.number), item])).values()];
  result.inventory = items.length;
  if (['schedule', 'workflow_dispatch'].includes(eventName) && items.length) {
    const instant = now();
    if (!Number.isSafeInteger(instant) || instant < 0) fail('invalid_clock');
    items.sort((a, b) => a.number - b.number);
    result.rotationBatches = Math.ceil(items.length / LIMITS.batchSize);
    const batch = Math.floor(instant / 3_600_000) % result.rotationBatches;
    result.rotationBatch = batch + 1;
    items = items.slice(batch * LIMITS.batchSize, (batch + 1) * LIMITS.batchSize);
    result.deferred = result.inventory - items.length;
  }
  let workflow;
  for (const [index, item] of items.entries()) {
    // Reserve the worst per-item cost before starting. Five scheduled items fit
    // even if every owned label needs deleting and both metadata pages are full.
    if (result.requests + 32 > LIMITS.requests || result.writes + 11 > LIMITS.writes) {
      result.deferred += items.length - index;
      result.budgetDeferred = true;
      break;
    }
    combined.throwIfAborted();
    const n = number(item.number);
    if (item.state !== 'open') continue;
    result.inspected++;
    if (!item.pull_request) {
      if (owned(item.labels).has('automation:intake')) continue;
      // Re-read labels so a human triage performed during intake is respected.
      const fresh = await api(`issues/${n}`);
      if (fresh.state !== 'open' || owned(fresh.labels).has('automation:intake')) continue;
      await api(`issues/${n}/labels`, 'POST', {
        labels: ['automation:intake', 'automation:needs-review'],
      });
      result.changed.push(n);
      continue;
    }
    const pr = await api(`pulls/${n}`);
    if (pr.state !== 'open') continue;
    const head = sha(pr.head?.sha),
      base = sha(pr.base?.sha);
    if (pr.base?.repo?.full_name !== REPOSITORY || pr.base?.ref !== 'main') continue;
    const desired = new Set(['automation:intake', 'automation:needs-review']);
    if (pr.draft) desired.add('automation:draft');
    const files = await pages(`pulls/${n}/files`);
    for (const file of files.items) {
      desired.add(area(file.filename));
      if (file.previous_filename) desired.add(area(file.previous_filename));
    }
    workflow ??= await api('actions/workflows/ci.yml');
    let ci = 'automation:ci-pending';
    if (
      workflow.path === '.github/workflows/ci.yml' &&
      workflow.name === 'Verify the circle' &&
      workflow.state === 'active'
    ) {
      const runs = await api(
        `actions/workflows/ci.yml/runs?event=pull_request&head_sha=${head}&per_page=100&page=1`,
      );
      if (!Array.isArray(runs.workflow_runs) || runs.workflow_runs.length > 100)
        fail('invalid_runs');
      const eligible = runs.workflow_runs.filter(
        (r) =>
          r.workflow_id === workflow.id &&
          r.path === '.github/workflows/ci.yml' &&
          r.event === 'pull_request' &&
          r.head_sha === head &&
          r.repository?.full_name === REPOSITORY &&
          r.pull_requests?.some(
            (p) => p.number === n && p.head?.sha === head && p.base?.sha === base,
          ),
      );
      eligible.sort((a, b) => b.id - a.id);
      const run = eligible[0];
      if (run) {
        const jobs = await pages(`actions/runs/${number(run.id)}/jobs?filter=latest`, 'jobs');
        const required = [
          'verify',
          'encrypted-client',
          ...[
            'journey',
            'concurrent-import',
            'migration',
            'social-lifecycle',
            'local-cleanup',
            'large-import',
            'identity-recovery',
            'import-recovery',
            'sharing-hardening',
          ].map((s) => `encrypted-browser (${s})`),
        ];
        const failed = jobs.items.some(
          (j) =>
            j.head_sha === head &&
            j.status === 'completed' &&
            ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'].includes(
              j.conclusion,
            ),
        );
        const success =
          run.status === 'completed' &&
          run.conclusion === 'success' &&
          jobs.complete &&
          required.every((name) =>
            jobs.items.some(
              (j) =>
                j.name === name &&
                j.head_sha === head &&
                j.status === 'completed' &&
                j.conclusion === 'success',
            ),
          );
        if (failed) ci = 'automation:ci-failing';
        else if (success && files.complete) ci = null;
      }
    }
    if (ci) desired.add(ci);
    let mutated = false;
    // Each write gets an exact revision readback. GitHub labels have no CAS; labels are advisory.
    const fresh = async () => {
      const current = await api(`pulls/${n}`);
      if (
        current.state !== 'open' ||
        current.head?.sha !== head ||
        current.base?.sha !== base ||
        current.draft !== pr.draft
      ) {
        result.moved.push(n);
        return null;
      }
      return current;
    };
    let current = await fresh();
    if (!current) continue;
    const missing = [...desired].filter((l) => !owned(current.labels).has(l));
    if (missing.length) {
      await api(`issues/${n}/labels`, 'POST', { labels: missing });
      mutated = true;
    }
    for (const label of owned(current.labels)) {
      // Partial file inventory must not remove potentially valid area labels.
      if (desired.has(label) || (!files.complete && label.startsWith('automation:area-'))) continue;
      current = await fresh();
      if (!current) break;
      if (owned(current.labels).has(label)) {
        await api(`issues/${n}/labels/${encodeURIComponent(label)}`, 'DELETE');
        mutated = true;
      }
    }
    if (mutated) result.changed.push(n);
  }
  return result;
}

export function summary(result) {
  const links = (ns) =>
    [...new Set(ns)]
      .map((n) => `[#${number(n)}](https://github.com/${REPOSITORY}/issues/${n})`)
      .join(', ') || 'none';
  return `## Contribution intake\n\nMetadata only; labels are advisory and never approval.\n\nInventory: ${result.inventory}. Inspected: ${result.inspected}. Deferred: ${result.deferred}. Rotation batch: ${result.rotationBatch}/${result.rotationBatches}. Inventory truncated: ${result.inventoryTruncated}. Budget deferred: ${result.budgetDeferred}. Complete bounded coverage this run: ${!result.inventoryTruncated && result.deferred === 0}. API requests: ${result.requests}. Writes: ${result.writes}.\n\nChanged: ${links(result.changed)}. Revision moved: ${links(result.moved)}. Bounded inventory truncated: ${result.truncated}.\n`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => controller.abort());
  try {
    const eventText = await readFile(process.env.GITHUB_EVENT_PATH, 'utf8');
    if (Buffer.byteLength(eventText) > LIMITS.responseBytes) fail('event_limit');
    const result = await runMaintenance({
      repository: process.env.GITHUB_REPOSITORY,
      token: process.env.GITHUB_TOKEN,
      eventName: process.env.GITHUB_EVENT_NAME,
      event: JSON.parse(eventText),
      signal: controller.signal,
    });
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(process.env.GITHUB_STEP_SUMMARY, summary(result));
  } catch {
    // Never echo API bodies, contributor text or tokens, including exception messages.
    console.error('Contribution intake stopped; bounded metadata reconciliation did not complete.');
    process.exitCode = 1;
  }
}
