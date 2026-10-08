import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LABELS,
  LIMITS,
  REPOSITORY,
  runMaintenance,
  summary,
} from '../scripts/github-maintenance.mjs';
const head = 'a'.repeat(40),
  base = 'b'.repeat(40);
const json = (data: unknown) => new Response(JSON.stringify(data));
function fixture() {
  const labels = new Set(['human:reviewed']);
  const writes: { route: string; method: string; body: any }[] = [];
  let reads = 0;
  const state = {
    moved: false,
    movedBase: false,
    wrongEvent: false,
    issue: false,
    complete: true,
    failed: false,
    pending: false,
    incompleteFiles: false,
    oversized: false,
    emptyLabels: false,
    lots: false,
    cancelled: false,
  };
  const pull = () => ({
    number: 1,
    state: 'open',
    draft: false,
    head: { sha: state.moved && reads >= 2 ? 'c'.repeat(40) : head },
    base: {
      sha: state.movedBase && reads >= 2 ? 'd'.repeat(40) : base,
      ref: 'main',
      repo: { full_name: REPOSITORY },
    },
    labels: [...labels].map((name) => ({ name })),
    title: '$(touch /tmp/should-never-exist)<script>bad()</script>',
  });
  const fetchImpl = async (input: string, init: RequestInit) => {
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal);
    const url = new URL(input);
    assert.equal(url.origin, 'https://api.github.com');
    assert.ok(url.pathname.startsWith(`/repos/${REPOSITORY}/`));
    const route = url.pathname.slice(`/repos/${REPOSITORY}/`.length);
    if (state.oversized) return new Response('x'.repeat(LIMITS.responseBytes + 1));
    if (init.method !== 'GET') {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      writes.push({ route, method: init.method!, body });
      if (route === 'labels') return json(body);
      assert.ok(/^issues\/\d+\/labels(?:\/automation%3A[a-z-]+)?$/.test(route));
      assert.ok(['POST', 'DELETE'].includes(init.method!));
      if (body)
        for (const label of body.labels) {
          assert.ok(Object.hasOwn(LABELS, label));
          labels.add(label);
        }
      else labels.delete(decodeURIComponent(route.split('/').at(-1)!));
      return json({});
    }
    if (route === 'labels')
      return json(state.emptyLabels ? [] : Object.keys(LABELS).map((name) => ({ name })));
    if (route === 'issues' || route === 'issues/1') {
      const item = { ...pull(), ...(state.issue ? {} : { pull_request: {} }) };
      return json(
        route === 'issues'
          ? state.lots
            ? Array.from({ length: 100 }, (_, i) => ({ ...item, number: i + 1 }))
            : [item]
          : item,
      );
    }
    if (/^issues\/\d+$/.test(route))
      return json({ ...pull(), labels: [], number: Number(route.split('/')[1]) });
    if (route === 'pulls/1') {
      reads++;
      return json(pull());
    }
    if (route === 'pulls/1/files')
      return json(
        state.incompleteFiles
          ? Array.from({ length: 100 }, () => ({ filename: 'src/example.ts' }))
          : [
              {
                filename: 'src/$(echo dangerous).ts',
                patch: 'process.exit(1)',
                previous_filename: 'docs/old.md',
              },
            ],
      );
    if (route === 'actions/workflows/ci.yml')
      return json({
        id: 2,
        path: '.github/workflows/ci.yml',
        name: 'Verify the circle',
        state: 'active',
      });
    if (route.endsWith('/runs'))
      return json({
        workflow_runs: [
          {
            id: 3,
            workflow_id: 2,
            path: '.github/workflows/ci.yml',
            event: state.wrongEvent ? 'push' : 'pull_request',
            repository: { full_name: REPOSITORY },
            head_sha: head,
            pull_requests: [{ number: 1, head: { sha: head }, base: { sha: base } }],
            status: state.pending ? 'in_progress' : 'completed',
            conclusion: 'success',
          },
        ],
      });
    if (route === 'actions/runs/3/jobs') {
      const names = [
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
      return json({
        jobs: (state.complete ? names : ['verify']).map((name) => ({
          name,
          head_sha: head,
          status: 'completed',
          conclusion: state.failed ? 'failure' : 'success',
        })),
      });
    }
    throw new Error(`unexpected route ${route}`);
  };
  const run = (extra = {}) =>
    runMaintenance({ repository: REPOSITORY, token: 'synthetic', fetchImpl, ...extra });
  return { state, run, writes, labels, fetchImpl };
}
test('metadata is inert; narrow label writes preserve human labels and repeated intake is idempotent', async () => {
  const f = fixture();
  const first = await f.run();
  assert.ok(f.labels.has('human:reviewed'));
  assert.ok(f.labels.has('automation:area-server'));
  assert.ok(f.labels.has('automation:area-docs'));
  assert.ok(f.labels.has('automation:needs-review'));
  assert.ok(!f.labels.has('automation:ci-pending'));
  assert.ok(!summary(first).includes('<script>'));
  const second = await f.run();
  assert.equal(second.writes, 0);
  assert.equal(f.writes.length, 1);
});
test('incomplete or running CI remains pending and needs review; failed completed jobs are failing', async () => {
  for (const mode of ['complete', 'pending', 'failed'] as const) {
    const f = fixture();
    f.state[mode] = mode !== 'complete';
    await f.run();
    assert.ok(f.labels.has(mode === 'failed' ? 'automation:ci-failing' : 'automation:ci-pending'));
    assert.ok(f.labels.has('automation:needs-review'));
  }
});
test('moved head blocks stale mutations', async () => {
  const f = fixture();
  f.state.moved = true;
  const result = await f.run();
  assert.deepEqual(result.moved, [1]);
  assert.equal(f.writes.length, 0);
});
test('only owned obsolete labels are removed', async () => {
  const f = fixture();
  f.labels.add('automation:ci-failing');
  f.labels.add('automation:draft');
  await f.run();
  assert.ok(!f.labels.has('automation:ci-failing'));
  assert.ok(!f.labels.has('automation:draft'));
  assert.ok(f.labels.has('human:reviewed'));
});
test('partial file pages preserve old area labels and remain pending', async () => {
  const f = fixture();
  f.state.incompleteFiles = true;
  f.labels.add('automation:area-encrypted-host');
  const result = await f.run();
  assert.equal(result.truncated, true);
  assert.ok(f.labels.has('automation:area-encrypted-host'));
  assert.ok(f.labels.has('automation:ci-pending'));
});
test('already triaged issues are not relabeled after maintainer removal', async () => {
  const f = fixture();
  f.state.issue = true;
  await f.run();
  f.labels.delete('automation:needs-review');
  const second = await f.run();
  assert.equal(second.writes, 0);
  assert.ok(!f.labels.has('automation:needs-review'));
});
test('unauthorized repository and cancellation fail before requests', async () => {
  const f = fixture();
  await assert.rejects(f.run({ repository: 'someone/else' }), /unauthorized_repository/);
  await assert.rejects(f.run({ signal: AbortSignal.abort() }), /abort/i);
  assert.equal(f.writes.length, 0);
});
test('response size fails closed and bootstrap rotation stays within write budget', async () => {
  const f = fixture();
  f.state.oversized = true;
  await assert.rejects(f.run(), /response_limit/);
  const many = fixture();
  many.state.lots = true;
  many.state.issue = true;
  many.state.emptyLabels = true;
  // Distinct issues need independent label inventories to exercise the total write cap.
  const result = await many.run({ now: () => 0 });
  assert.ok(result.writes <= LIMITS.writes);
  assert.equal(result.inspected, LIMITS.batchSize);
  assert.equal(result.deferred, 100 - LIMITS.batchSize);
});

test('workflow completion targets its PR directly and rechecks CI metadata', async () => {
  const f = fixture();
  f.state.failed = true;
  const result = await f.run({
    eventName: 'workflow_run',
    event: { workflow_run: { pull_requests: [{ number: 1 }] } },
  });
  assert.equal(result.inspected, 1);
  assert.ok(f.labels.has('automation:ci-failing'));
  const noPr = await f.run({
    eventName: 'workflow_run',
    event: { workflow_run: { pull_requests: [] } },
  });
  assert.equal(noPr.inspected, 0);
});

test('changed base blocks writes and a push run cannot clear pending', async () => {
  const moved = fixture();
  moved.state.movedBase = true;
  const result = await moved.run();
  assert.deepEqual(result.moved, [1]);
  assert.equal(moved.writes.length, 0);
  const wrong = fixture();
  wrong.state.wrongEvent = true;
  await wrong.run();
  assert.ok(wrong.labels.has('automation:ci-pending'));
});

function rotatingFixture(count: number) {
  const f = fixture();
  for (const label of [
    'automation:intake',
    'automation:needs-review',
    'automation:area-server',
    'automation:area-docs',
  ])
    f.labels.add(label);
  const visited = new Set<number>();
  let current = 1;
  const fetchImpl = async (input: string, init: RequestInit) => {
    const url = new URL(input);
    const route = url.pathname.slice(`/repos/${REPOSITORY}/`.length);
    if (route === 'issues') {
      const page = Number(url.searchParams.get('page'));
      const list = Array.from({ length: count }, (_, i) => ({
        number: count - i,
        state: 'open',
        pull_request: {},
      }));
      return json(list.slice((page - 1) * 100, page * 100));
    }
    const match = /^pulls\/(\d+)(\/files)?$/.exec(route);
    if (match) {
      current = Number(match[1]);
      if (!match[2]) visited.add(current);
      url.pathname = `/repos/${REPOSITORY}/pulls/1${match[2] ?? ''}`;
    }
    const response = await f.fetchImpl(url.href, init);
    if (route.endsWith('/runs')) {
      const body = await response.json();
      for (const run of body.workflow_runs) run.pull_requests[0].number = current;
      return json(body);
    }
    return response;
  };
  return {
    ...f,
    visited,
    runHour: (hour: number) => f.run({ fetchImpl, now: () => hour * 3_600_000 }),
  };
}

test('hourly rotation visits all 50 already-correct PRs without exhausting requests', async () => {
  const f = rotatingFixture(50);
  for (let hour = 0; hour < 50 / LIMITS.batchSize; hour++) {
    const result = await f.runHour(hour);
    assert.equal(result.inventory, 50);
    assert.equal(result.inspected, LIMITS.batchSize);
    assert.equal(result.deferred, 50 - LIMITS.batchSize);
    assert.equal(result.writes, 0);
    assert.equal(result.budgetDeferred, false);
    assert.ok(result.requests < LIMITS.requests);
    assert.equal(f.visited.size, (hour + 1) * LIMITS.batchSize);
  }
  assert.deepEqual(
    [...f.visited].sort((a, b) => a - b),
    Array.from({ length: 50 }, (_, i) => i + 1),
  );
});

test('more than 200 open contributions remains visibly truncated and deferred', async () => {
  const f = rotatingFixture(250);
  const result = await f.runHour(0);
  assert.equal(result.inventory, 200);
  assert.equal(result.inventoryTruncated, true);
  assert.equal(result.inspected, LIMITS.batchSize);
  assert.equal(result.deferred, 200 - LIMITS.batchSize);
  assert.match(summary(result), /Inventory truncated: true/);
  assert.match(summary(result), /Complete bounded coverage this run: false/);
});

test('large direct-event reconciliation stops before budget exhaustion with visible deferred work', async () => {
  const f = fixture();
  const fetchImpl = async (input: string, init: RequestInit) => {
    const url = new URL(input);
    if (init.method === 'GET') {
      // Every PR starts with all obsolete automation labels, forcing bounded removals.
      if (/\/pulls\/\d+$/.test(url.pathname))
        for (const label of Object.keys(LABELS)) f.labels.add(label);
      url.pathname = url.pathname.replace(/\/(issues|pulls)\/\d+/, '/$1/1');
    }
    const response = await f.fetchImpl(url.href, init);
    const target = /\/issues\/(\d+)$/.exec(new URL(input).pathname);
    if (init.method === 'GET' && target) {
      const item = await response.json();
      return json({ ...item, number: Number(target[1]) });
    }
    return response;
  };
  const result = await f.run({
    fetchImpl,
    eventName: 'workflow_run',
    event: {
      workflow_run: { pull_requests: Array.from({ length: 20 }, (_, i) => ({ number: i + 1 })) },
    },
  });
  assert.equal(result.budgetDeferred, true);
  assert.ok(result.deferred > 0);
  assert.ok(result.requests <= LIMITS.requests);
  assert.ok(result.writes <= LIMITS.writes);
  assert.equal(result.inspected + result.deferred, result.inventory);
  assert.match(summary(result), /Budget deferred: true/);
});
