# Private daily contribution reviews

The deterministic dispatcher takes a fresh GitHub snapshot, then reviews only open, non-draft pull requests whose exact repository, PR number, head commit and base commit have no completed receipt. Results stay in a private local dashboard. Nothing posts comments, approves, merges, pushes, changes repository settings or executes contributor code.

A receipt is **advice about the supplied diff**, not release approval, a test result or proof of safety. Diffs are sent to the configured Codex provider. They are not a local-only model workload. Keep this workflow private while the repository is private.

## Daily runner contract

Run a reviewed, pinned copy of the scripts with Node 24. The scripts do not install a scheduler or modify host services. The operator's scheduler should invoke the dispatcher once daily, capture only its safe status output, and keep its dashboard off public hosting.

```sh
private-credential-wrapper | node scripts/contribution-review.mjs
```

The wrapper supplies this JSON on stdin, substituting a short-lived read-only token without printing it or placing it in arguments:

```json
{
  "repository": "Dynobit/clean-bookface",
  "stateDir": "/private/path/contribution-review",
  "token": "provided privately by the credential wrapper",
  "reviewer": { "model": "gpt-6-astra", "reasoningEffort": "max" },
  "endsAt": "2027-01-03T00:00:00Z"
}
```

That model and effort reflect the operator's existing configuration; the dispatcher has no silent model fallback. The deadline is an example for the initial October 2026 window: the selected absolute end must be in the future and no more than 90 days from the first run. The first run saves an immutable policy. Later runs cannot extend its deadline or change its model by restarting. An ended window performs no GitHub fetch or model call.

`GITHUB_TOKEN` can supply the token instead of stdin. `CONTRIBUTION_REVIEW_MODEL` and `CONTRIBUTION_REVIEW_EFFORT` supply reviewer settings when stdin does not specify them. Credentials are never accepted as command-line arguments or included in result JSON. The GitHub token needs metadata, pull-request, commit-status and contents **read** permissions; no write permission is needed. The Codex CLI must already be authenticated through its normal separate mechanism.

The library entry point is:

```js
await runContributionReview({
  repository,
  stateDir,
  token,
  reviewer: { model, reasoningEffort },
  endsAt,
  codexPath,
  // Tests can inject now, fetchImpl and reviewRunner.
});
```

It returns safe status fields, including attempted/reviewed counts, attention count and deadline. `attention-required` counts every current non-draft PR without a valid completed receipt, including manual review, exhausted or delayed retries, and work waiting behind the daily cap; `ok: false` means the run failed. Read `dashboard.html` for the exact current candidate state. The metadata-only watcher and dispatcher acquire the same lock; a concurrent invocation fails before reading GitHub or overwriting the snapshot. Embedded snapshots link to the review dashboard rather than claiming completed reviews are pending.

## Bounds, retries and exact inputs

- The watcher reads at most three pages of 100 open PRs, accepting fewer than 300 in a complete snapshot. It fetches combined commit status with concurrency five. That endpoint is not a full check-run report.
- GitHub requests are GET-only, use the fixed `https://api.github.com` origin, reject redirects, time out after 15 seconds and bound bodies during streaming. Metadata responses are capped at 5 MiB; comparison responses at 2 MiB.
- Each candidate fetches the immutable `baseSHA...headSHA` comparison, including changed-file names and patches. The current PR head/base/open state is checked before fetching, after fetching and after review. A moved or closed PR cannot receive a fresh successful receipt for the stale candidate. The merge base and an input SHA-256 are recorded too.
- At most 50 changed files and 200,000 bytes of input enter one review. Missing/binary patches, inconsistent addition/deletion counts, oversized or otherwise incomplete input require manual review. The runner does not silently mark a partial diff reviewed. It does not fetch unrelated repository files or PR discussion bodies.
- At most three attempts run per UTC day, one at a time. An exact candidate gets at most three attempts, with six-hour then twelve-hour backoff. Counts are written before work starts, so a crash consumes its reserved attempt. Daily limits are invocation/token-use bounds, not a guaranteed dollar cap; model billing and account budgets remain separate.
- A fully written lock identity is published atomically before work starts. Existing locks are never stolen automatically, even when the recorded parent is dead: its detached child may still be running. A live same-host owner returns `review_already_running`; malformed, stale or foreign locks return `lock_recovery_required`. See offline recovery below. Each model process has a ten-minute deadline, shortened to the remaining review window. SIGINT, SIGTERM and SIGHUP cancel the owned child process group, wait for it to close, persist interruption, remove its scratch and release the lock. SIGKILL, host failure and filesystem failure cannot guarantee cleanup.

Only a changed head or base produces a different review key. Title, author, draft flag and CI changes update the snapshot but do not repeat a completed review. Closing and reopening a PR at the same exact commits reuses its immutable candidate and receipt. A previously pending candidate can continue, subject to its retry limits. Old candidates and receipts remain available for audit.

## Codex isolation

The adapter defaults to `/opt/homebrew/bin/codex exec` (Apple Silicon Homebrew). Other installations must supply a reviewed absolute `codexPath` in the trusted wrapper JSON or library options; there is no PATH search or model fallback. Never derive this executable path from PR text. The adapter invokes the chosen binary with an explicit model, no shared daemon, no approval prompts, an ephemeral session and a read-only sandbox. Its working directory is a fresh private temporary directory containing only the trusted output schema. No PR checkout, dependencies, hooks or executable files are materialized. The diff arrives on stdin as explicitly untrusted JSON data.

User configuration and execution rules are excluded. Shell/unified execution, apps, plugins, hooks, subagents, image tools, web search and host skill discovery are disabled; no MCP servers are configured. GitHub tokens and application secrets are removed from the subprocess environment. Only normal Codex authentication and runtime inputs remain. JSON output is limited to 2 MiB; stdout plus stderr are limited to 8 MiB. The schema and runtime validator bound summary/limitations to 4,000 Unicode characters each, and at most 40 findings with 4,000-character messages. Usage retains only nonnegative safe-integer input, cached-input and output token counts; missing usage remains unknown. Unexpected tool events fail the review and terminate that process. This defense does not make model output authoritative: maintainers still evaluate the findings and coverage limits.

Local CLI help and its installed feature list were checked while implementing these arguments. Tests exercise the adapter with an injected subprocess, including forbidden tool events, and do not spend model tokens. A separate authenticated one-shot qualification of the unmodified adapter completed using `gpt-6-astra` at `max` effort against a small synthetic diff, returning valid structured output without tool-use events. This qualifies that invocation, not review quality on real contributions or the daily scheduler. Requalify after relevant CLI, model or isolation-setting changes. See [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode) and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

## Private artifacts and failure presentation

The default state directory is `~/.local/state/clean-bookface/contribution-review`, outside the checkout. Directories use mode `0700`; generated state, input, candidate, receipt and dashboard files use `0600`. Scratch review directories are removed after completion or handled failure. After acquiring a fresh lock, the next dispatcher removes abandoned `work/isolated-*` directories and changes unfinished `running` entries to interrupted retries (or exhausted status), preserving all attempt and daily reservations. Missing candidates regenerate from the fresh GitHub snapshot; malformed candidates require human review without blocking other keys. Keep this directory on private local storage and outside public artifacts.

`dashboard.html` is the current private view. It displays exact commits, plain-language retry/manual-review state, attempt counts, the earliest retry time (still subject to daily capacity), and completed advisory findings. An expired run reports zero new attempts and unknown current attention because it does not fetch a fresh snapshot; it clears obsolete failure markers. All contributor and model text is escaped; no scripts or external resources are loaded. `receipts/<review-key>.json` binds a completed review to its immutable `inputs/<review-key>.json`. `dispatch.json` records attempts and daily caps; `review-policy.json` holds the fixed window and model. No receipt is written for a failed, superseded or malformed review. Before reuse, saved receipts must match the exact repository, PR, commits, reviewer and saved-input hash; an invalid receipt fails closed for operator inspection.

A failed GitHub snapshot preserves `state.json` but labels the previous report and dashboard stale, with a safe failure code and time. It cannot dispatch old candidates as though the latest check succeeded. Raw API errors, subprocess stderr and credentials are not written to the dashboard. The metadata-only `contribution-watch.mjs` remains available separately; its `report.html` clearly says it performed no review.

The GitHub comparison file-list limit and patch behavior are described in the [official commit API](https://docs.github.com/en/rest/commits/commits#compare-two-commits). The local review cap is deliberately lower.

## Recovery and runner diagnostics

For `lock_recovery_required`, stop the schedule and all manual invocations first. Verify that the recorded dispatcher **and its detached model process group** have stopped; a dead parent PID alone is insufficient. Preserve the lock and dispatch ledger privately for diagnosis, then remove the lock only while all writers remain stopped. Restart one dispatcher after that offline recovery. Do not automate an age-based unlink/rename or remove a malformed lock while another writer may be publishing it. Unexpected removal or replacement of a live lock is outside the concurrency contract; a detected replacement returns `lock_release_failed`.

A missing executable or nonzero exit before any JSON events returns `review_runner_unavailable` and stops that batch. The daily reservation remains consumed; the candidate retry count is restored. Check the trusted executable path, installed CLI help and authentication separately before retrying. Runtime errors after events return `review_process_failed`; absent/malformed final JSON returns `invalid_review_output`. Raw stderr, error strings and credentials are neither retained nor displayed. These safe categories intentionally do not diagnose authentication versus flag errors from secret-bearing text.

Configuration stdin must finish within 30 seconds and fit within 16 KiB. The dispatcher accepts only token, repository, stateDir, reviewer, endsAt and codexPath from that JSON; test-only callable options cannot be injected through stdin. Node 24.4 or later is required, including when invoking either script through a symlink. Filesystem containment uses canonical checkout paths before creating private state.

Base changes deliberately create a new exact-commit review key. This may increase the queue during frequent base updates; automatic reuse across different base commits is not implemented. Planning/tool items remain fail-closed unless their installed CLI semantics have been separately qualified. After these review fixes, the unmodified adapter also completed a separate authenticated synthetic review with the revised schema and configured model; regression tests use synthetic child processes and do not make paid model calls.

Cancellation also reaches GitHub headers and body reads, pagination, and the status-request queue. No new GET starts after cancellation; an aborted empty snapshot is a failure. Per-request expiry reports `github_request_timeout`, explicit shutdown reports `review_interrupted`, and expiry of the fixed review window reports `review_deadline_reached`. Request timers and abort listeners are removed when each request settles.
