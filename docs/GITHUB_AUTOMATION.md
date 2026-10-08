# Public contribution automation

`Contribution intake` performs metadata-only GitHub triage for
`Dynobit/clean-bookface`. It runs when issues open or reopen; when pull requests
open, reopen, change revision or change draft status; after `Verify the circle`
completes; hourly at minute 23; and on manual dispatch. Scheduled execution is
best effort and may be delayed by GitHub. The workflow and helper must reach
trusted `main` before this automation is active.

The helper creates only its documented `automation:` labels. New issues receive
`automation:intake` and `automation:needs-review`. Once the intake marker exists,
subsequent runs preserve maintainer triage, including removal of needs-review.
Existing open issues without the marker are eligible for initial intake. Keep the
marker when an issue has been triaged to prevent another initial intake.

Open pull requests targeting main receive needs-review, a separate draft label
when applicable, changed-file area labels, and advisory CI pending/failing labels.
Renames count both old and new paths. Human labels are preserved. The reserved
labels in `scripts/github-maintenance.mjs` belong to automation and may be
reconciled on pull requests; maintainers should use other names for human decisions.
A partial file inventory never removes existing area labels.

CI observations require the active `Verify the circle` workflow at
`.github/workflows/ci.yml`, its workflow ID, a `pull_request` run in this repository,
and matching pull request number, head SHA and base SHA. The latest matching run
is inspected. Missing or incomplete evidence stays pending. Pending is removed
only after the run and all eleven expected verification jobs complete successfully;
skipped jobs do not count as success. Completed failing jobs produce the failing
label. A changed head, base or draft status stops remaining stale writes after
readback. GitHub's label API has no compare-and-set operation, so a revision can
still change between a read and its write; subsequent reconciliation corrects it.
**Labels never constitute approval, branch protection or permission to merge.**

The privileged job checks out only the helper from trusted main, using pinned
checkout/setup-node actions and Node 24. It never checks out contributor revisions,
installs dependencies, builds code, downloads artifacts, invokes a model or shell
with contributor input, or executes contribution contents. Changed filenames are
classified as strings; patches, issue bodies and titles are not copied to outputs.
Job summaries contain counts and fixed-host numbered links only. There are no
public comments, automated closures, stale bots or outreach.

The token has contents read, issues write, pull requests write and actions read.
GitHub requires pull requests write to label PRs; issues write permits creating
repository labels and labeling issues. This matches the first-party
[actions/labeler recommended permissions](https://github.com/actions/labeler#recommended-permissions).
Pull requests write is broader than labeling at the credential level. The trusted
helper enforces the narrower API boundary: its only mutations create owned labels,
add them to issues/PRs and delete individually owned labels. It has no routes for
reviews, PR edits, approval, merge, deployment or code changes. The repository's
`can_approve_pull_request_reviews=false` setting separately disallows Actions review
approval; contents read does not grant the contents write permission needed to
merge. These controls have different roles: the token permits PR metadata writes,
while reviewed helper code limits this workflow to label operations.

Human labels are never replaced wholesale. Redirects are rejected. Failures expose
only fixed diagnostic codes, fixed API operation categories and request/write
attempt counts; HTTP failures include only the numeric status. Fetch, headers,
response reader, body reads and JSON decoding have distinct codes. Unknown
exceptions remain generic. Errors do not echo exception messages, response bodies,
contribution text or tokens.

Each run allows at most 240 API requests and 80 write attempts, two pages of 100
items per inventory, 2 MB per response, ten seconds per request and three minutes
overall; the workflow has a five-minute timeout. There are no automatic HTTP
retries. Cancellation and errors stop the run, leaving completed idempotent writes
for the next reconciliation.

Hourly and manual reconciliation read the newest 200 updated open contributions,
deduplicate and sort that inventory by issue number, then process a rotating batch
of at most five. The UTC epoch-hour modulo the number of batches selects the batch;
the clock comes from the runner, never contribution/event text. An unchanged
50-item inventory is fully visited over ten consecutive hourly runs; 200 items
require forty. Membership changes or missed scheduled runs can delay coverage;
this is bounded rotation, not a guarantee of a maximum response time. More than
200 items remains explicitly truncated and needs maintainer attention. Five items
leave room for initial label creation and worst-case per-item reconciliation;
before each item, the helper reserves 32 request attempts and 11 write attempts.
If insufficient budget remains, it stops before that item and reports remaining
items as deferred, rather than failing halfway through a planned batch.

Issue and PR events still target their contribution directly. Completed workflow
events target up to twenty associated PR numbers directly, so an old PR does not
wait for its hourly batch for CI refresh. A completed run without associated PRs
changes no contribution labels. Multi-PR events can reach the planned budget stop;
deferred contributions remain eligible for hourly rotation. The newest 100
matching-head workflow runs are considered. Full pages at a pagination cap are
conservatively reported as truncated. Summaries expose inventory size, inspected
and deferred counts, rotation batch, inventory truncation, metadata truncation and
budget deferral. Partial coverage is never presented as a complete sweep. Failed
jobs are visible in Actions and can be rerun; errors do not silently fall back to
broader permissions.

This is separate from the private daily advisory model review. That review does
not publish its output or grant merge authority. GitHub's native auto-merge, when
enabled and selected by a maintainer, is a separate repository feature that waits
for required checks and maintainer approval under branch protection. This intake
workflow neither enables auto-merge on PRs nor approves them. Cloudflare project
website publishing remains separate and manual. None of these mechanisms makes
project maintenance fully autonomous or appoints community members.

Local acceptance: `npx --no-install tsx --test tests/github-maintenance.test.ts`.
The mocked API tests cover inert contributor metadata, idempotency, human label
preservation, incomplete/failing CI, revision movement, pagination, response and
write bounds, fair rotation across fifty PRs, visible inventory truncation,
cancellation and repository restriction. Fourteen mocked tests pass, including
safe classification of hostile API failures; mocks alone do not qualify GitHub
token permissions.

On 8 October 2026, the initial live run failed with a generic error. After adding
safe diagnostics, an issue-only batch succeeded in
[run 37762841492](https://github.com/Dynobit/clean-bookface/actions/runs/37762841492),
but that batch did not exercise PR labels. A controlled direct PR check then
reported `github_status_403 (issue_labels_add; requests=9; writes=1)` in
[run 37763023256](https://github.com/Dynobit/clean-bookface/actions/runs/37763023256).
With the same pinned helper and only pull requests permission changed from read
to write, [run 37763219173](https://github.com/Dynobit/clean-bookface/actions/runs/37763219173)
successfully inspected and labeled PRs #21 and #22, one write each. An unchanged
repeat in [run 37763476243](https://github.com/Dynobit/clean-bookface/actions/runs/37763476243)
inspected each PR again with zero writes, demonstrating live idempotency for those
inputs. This qualifies
the permission correction for PR labeling; it does not claim approval, merging,
deployment or complete future queue coverage.
