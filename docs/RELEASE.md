# Release qualification

## Published review hardening, 6 October 2026

The requested exact Opus 5.5 source reviews are complete. The follow-up implements interrupted recovery, isolated archive failures, realistic imports, photo sharing, durable retry, conversation exports, browser-encrypted search indexes and host maintenance improvements. [Review scope and changes](REVIEW_2026_10.md). The fictional-data preview [v0.2.0-preview.2](https://github.com/Dynobit/clean-bookface/releases/tag/v0.2.0-preview.2) is published from `270243361ede2fbf3c1f0220bfd101e73a8f0d30`; [PR #6](https://github.com/Dynobit/clean-bookface/pull/6) is merged. All eleven required jobs passed both before merge and in [main CI run 37463068912](https://github.com/Dynobit/clean-bookface/actions/runs/37463068912): the application verification, encrypted client and nine browser suites. Public client and website assets match the release build; the host upgrade passed production readback. The final two-person public functionality checks completed across an initial run and a successful fresh-browser recovery continuation; this was not an uninterrupted passing run. They covered invitations and kits, real identity comparison, private import, shared-photo decryption, comments, blocking and reconnection, exact recovered export and browser account closure. [Public-route evidence and failed attempts](../encrypted-client/QUALIFICATION.md#published-opus-55-follow-up--6-october-2026).

Final host checks confirmed both fictional journey accounts were deactivated through the UI, their access and refresh tokens were absent, and invitations were removed. The post-journey encrypted backup passed a full-data check of nine snapshots and 18 packs; the primary and scheduled backup-health checks were healthy afterward. [Host acceptance and measured service interruptions](../encrypted-host/QUALIFICATION.md#current-deployed-preview--6-october-2026).

**Personal-data production remains unqualified:** current host-image scans have unresolved advisories, and independent human security/accessibility review and the usability study remain open. The preview uses fictional data. [Dependency findings](ENCRYPTED_DEPENDENCY_UPGRADES.md).

## Encrypted preview, 6 October 2026

The v0.2 browser client and storage home are separate from the earlier v0.1 application. The encrypted preview includes invited accounts, recovery kits, private Facebook imports, verified pairwise sharing, photos, comments, reactions, blocking, selected-evidence reports and account closure. Saved imports can be searched and exported in the browser. Existing v0.1 accounts can export and import a separate encrypted copy; no installation becomes encrypted automatically.

The source also includes installation, restricted HTTPS delivery, optional cross-home connections, encrypted backups, a daily scheduler with backup-health reporting and fenced recovery on a second machine. One home is active at a time. Two machines in one location do not establish geographic disaster recovery, and a server backup does not replace a member's recovery kit.

This is a **preview for fictional data**, not an independently audited security release. Independent human security and accessibility reviews and the five-person usability study are still open. The browser publisher remains trusted; a storage operator who can replace the browser code can steal keys. Homes retain connection and membership metadata. Recipients and older backups can retain copies.

The earlier preview baseline `5a14233444577d9e7f2317966e6ad386de6bae3e` passed an uninterrupted public journey covering encrypted sharing, recovery, export and account closure, plus all eight jobs in [GitHub run 37432224091](https://github.com/Dynobit/clean-bookface/actions/runs/37432224091). Its [historical qualification](../encrypted-client/QUALIFICATION.md#final-encrypted-preview-qualification-6-october) records the request and host scans, exact asset readbacks and refreshed backup. Later documentation-only commits do not change those application inputs.

Current reproducible client and host evidence, including failed attempts and measured limits, is recorded in [client qualification](../encrypted-client/QUALIFICATION.md) and [host qualification](../encrypted-host/QUALIFICATION.md). The [beginner guide](ENCRYPTED_GETTING_STARTED.md), [hosting choices](ENCRYPTED_HOSTING.md) and [installation procedure](../encrypted-host/SELF_HOST.md) describe this version. The earlier release record below applies only to v0.1.

## Historical v0.1 qualification

The owner approved the v0.1 public preview of the source and project website on 5 October 2026. Public source availability and the project website are verified. This release offers no official hosting or public sign-up service and does not upgrade the operator-only pilot. Independent human security and accessibility review and the five-person usability study remain open; the requested exact Opus review was unavailable at that historical checkpoint. The 6 October Opus 5.5 reviews are recorded above. The dated evidence below records its original scope, including earlier private checkpoints.

## Historical public status, 5 October 2026

- The released application is [v0.1.0-preview.1](https://github.com/Dynobit/clean-bookface/releases/tag/v0.1.0-preview.1), at `2b9b110`. Its host can read stored data; it is not end-to-end encrypted.
- The runner outage is resolved. [GitHub run 37371375764, attempt 2](https://github.com/Dynobit/clean-bookface/actions/runs/37371375764), passed for that exact released commit, including browser, container and provider checks. The original failed attempts remain in the historical record below.
- The project website provides information, screenshots and links to the source. It has no member accounts or official hosting offer. Current website publishing uses Cloudflare Pages Direct Upload; see [publishing instructions](PROJECT_SITE.md).
- The encrypted successor is separate [draft PR #4](https://github.com/Dynobit/clean-bookface/pull/4). At `a65eb75`, both GitHub jobs passed, alongside 65 client tests and focused local browser/recovery checks. Its known failures and unfinished product, migration, off-site recovery and human-review work prevent a production-ready claim. Consult that PR for current evidence; v0.1 qualification does not transfer to the successor.
- Community work starts with [scoped priorities](BACKLOG.md#community-priorities) and [Contributing](../CONTRIBUTING.md). Publication is complete; community maintainer appointments and the independent human reviews are not.

## Initial publication readback, 5 October 2026

The public repository at `46838a8` has a clean two-commit history. Anonymous
access returned HTTP 200; the preserved private development repository returned 404. Private development history and operational records remain outside the
public repository. Private vulnerability reporting, secret scanning, push
protection and protection of `main` are enabled.

Public CI run `37365701451` failed before any step ran: the job was not acquired
by a hosted runner during the confirmed GitHub Actions outage. This is an
infrastructure failure, not a passing public CI run. Private pre-release run
`37361931833` passed at `3f5a6b4`; application and test inputs are byte-identical
to the public candidate, whose initial changes covered twelve documentation and
website-copy files. This publication update changes only the release, backlog
and website-publishing documentation. That earlier evidence does not claim a successful run on
the public repository. A successful public CI run was pending at this checkpoint; the later passing run is linked above.

The project website is published through Cloudflare Pages Free from source
`46838a8`. All seven assets at `https://cleanbookface.org` returned HTTP 200
and matched the approved SHA-256 hashes. `https://www.cleanbookface.org` served
the same index; both HTTP addresses redirected to HTTPS. Both custom domains
are active. All four `.com` entrypoints returned 301 redirects preserving paths
and queries. Obsolete parking wildcard DNS was removed; pilot and TXT records
were preserved.

Initial delivery exposed automatically injected Cloudflare analytics. Explicitly
disabling zone RUM corrected it: the delivered HTML now contains no scripts.
Fresh browser checks at 320 and 390 pixels with JavaScript disabled, and
1321 pixels in normal Chrome with JavaScript enabled, passed all eight images,
three navigation links and five repository links. There was no horizontal
overflow, injected script or external resource request. The restrictive
Content Security Policy remained present. Earlier 1280-pixel layout checks
also passed; fresh headless desktop navigation hit a local transport timeout,
so the final desktop check used normal Chrome. These checks do not replace
independent human accessibility or usability evaluation. The GitHub Pages
workflow is disabled and its unused Pages site removed; Cloudflare Direct
Upload is the active publisher. This publishes project information, not member
hosting or an upgrade of the operator-only pilot.

## Candidate scope

The source contains server-rendered desktop/mobile screens; invited accounts and recovery; private archive ingestion and search; photos and albums; deliberate audience selection; posts, comments, likes and quiet notifications; friendship, blocking, reporting and appeals; private cross-host delivery; member export/reimport; and operator backup, restore and deletion reconciliation. Docker Compose provides persistent storage and HTTPS. Generated artwork is included with its prompt and provenance. The README includes screenshots of the running application using fictional accounts.

## Evidence captured on 2 October 2026

| Check                     | Evidence and boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native archive workload   | 50,000 synthetic records and 100 JPEGs, 20 accounts, five HTTP readers: 17.39 seconds, zero request failures, 545.20 MiB peak RSS. [Full conditions](PERFORMANCE.md). Unconstrained ARM64 development host; only 10.68 MiB of media.                                                                                                                                                                                                                                                                                                                                                                       |
| Core and archive behavior | Executable tests cover identity, timestamps, Unicode, isolation, audience snapshots, reimport, quota rollback, malformed input and private media. The integrated Node 24.15.0 suite passed **87/87 tests, zero skips**, including actual restic 0.19.1 encryption and restore.                                                                                                                                                                                                                                                                                                                             |
| Federation                | Two application instances exchange signed requests over actual HTTPS through an isolated test transport. Tests exercise accepted friends, restricted reads, interactions, delete/revoke/block, replay protection and restart delivery. Production DNS pinning and destination rejection are tested separately; this does not establish interoperability with arbitrary ActivityPub implementations.                                                                                                                                                                                                        |
| Browser journeys          | **7/7 browser journeys passed** in installed Chrome on macOS. Actual Chrome exercises invited signup, friendship, password recovery, settings, posting, selected photos, private ZIP import, export and mobile navigation. Account and ZIP flows also run with JavaScript disabled.                                                                                                                                                                                                                                                                                                                        |
| Recovery                  | Real restic tests exercise encrypted incremental snapshots, independent recovery encryption, media hashes, key identity, wrong-key/domain refusal, deletion/revocation reconciliation and restored session invalidation. Restores deny all account/content access until reconciliation.                                                                                                                                                                                                                                                                                                                    |
| Production image          | Local Linux ARM64 image passed Caddy HTTPS, first-account setup, secure sessions/CSRF, private photo access, restart persistence, and encrypted restore into a fresh volume followed by reconciliation. Non-root uid 1000, read-only application root, private data mode 0700 and complete cleanup were checked. This is an isolated local deployment, not an external provider.                                                                                                                                                                                                                           |
| Dependency audit          | Runtime dependency audit returned zero reported vulnerabilities after reviewed transitive updates. An audit database cannot prove absence of vulnerabilities.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Source privacy            | Exact staged source and existing Git history passed gitleaks. The initial artifact guard covered 80 tracked files; the managed-host follow-up has 87. Its separate regression test passed 17 isolated Git-index fixtures covering personal paths, credentials and narrow container-path exceptions. Only synthetic fixtures and explicitly reviewed artwork/screenshots belong in the repository. CI checks tracked artifacts and obvious secret/private-path patterns; release review also scans the exact staged source and history. This is not a claim about arbitrary files on a developer's machine. |

The initial application-complete container smoke passed all seven checks in 18.178 seconds on Linux ARM64 image `sha256:1120d380a68fc5108b17e0954a62ce07023a0365cf23afbaf0eb72254bd9e5f2`. Its database and media survived restart and encrypted recovery. Commit `4c022da` also passed the full GitHub verification workflow (private pre-release run `37074293831`). The subsequent managed-host additions have their own checks and retain the provider qualification boundary below. The extended real-HTTPS two-host application journey also passed after the integrated run.

The managed-host image `sha256:89af4abc84ce6aac2f45d15c6b90cd9ec7cd8526c79f57a0dbc6696e14340bb4` subsequently passed the same seven HTTPS, persistence and encrypted-recovery checks in 20.2 seconds. The Railway definition passed type checking and actual resource-graph evaluation against SDK 3.12.0. The Render Blueprint passed local structural assertions; its fields were reviewed against the official reference, without claiming an external provider deployment or a complete provider-schema validator run.

The same image passed the managed bootstrap harness in 11.144 seconds: root-owned volume preparation, UID/GID 1000 with no supplementary groups or effective capabilities, unchanged child ownership, CLI forwarding, encrypted backup while maintenance holds no database lock, resumption, symlink refusal and complete test-resource cleanup. No paid provider was created by these checks.

The installable source and automated checks are checkpoints. They do not make unsupported hosting, capacity or usability claims true.

## Member guidance and identity, 4 October 2026

The public Getting started page and [member guide](GETTING_STARTED.md) now distinguish downloading from Facebook, private import, deliberate sharing and optional Facebook deactivation/deletion. Split-export guidance keeps all parts together, and Meta's changing account-menu names are explained. The [stewardship document](../GOVERNANCE.md) records a transition plan without claiming that maintainers or a sponsor have already been appointed. The album-and-faces mark replaces the letter tile in the header and favicon; README screenshots were recaptured from fictional accounts.

The integrated Node 24 suite passed **88/88 tests with zero skips**, including real restic recovery. All **8/8 browser journeys** passed, including the new guide with JavaScript disabled, keyboard-operated disclosure, mobile layout and authenticated import access. Type checking, build and formatting passed. A separate source review found and resolved the sequential split-ZIP guidance defect. The new logo was visually checked at 16–128 pixels and layouts at 320, 390 and 1280 pixels. These checks do not replace independent usability evaluation or the external deployment gates below.

## Temporary pilot and project website, 5 October 2026

The source now includes resumable archive uploads in 4 MiB verified pieces,
owner-bound temporary reservations, and the same resource bounds for direct
multipart uploads. Browser tests include a 104 MiB archive interrupted and
resumed after a reload, rejection of changed reselected bytes, and a native
photo upload throttled beyond one minute. Backups discard unfinished-upload
metadata; real recovery tests cover older snapshots carrying stale reservations.

A separate Pi recipe starts at 25 invited accounts with 1 GiB archive allowances.
It uses fixed UTC dates, an export-only period of at least 14 days, then closes
private access. A systemd deadline stops only the dedicated app and tunnel.
The controller validates rendered configuration, exact images and loaded timer
state, and contains failed startup. A 1,000-account setting is an upper limit,
not measured capacity. The running server and Cloudflare trust boundaries are
visible before import. [Pilot terms](PILOT.md), [host procedure](PI_HOSTING.md).

The separate static project website includes the album favicon and desktop and
phone screenshots. Its build copies only nine named outputs, and its publishing
workflow is manual and refuses to publish while the original repository is
private. The `.org` project site is intended to continue separately from the
90-day member pilot. [Website procedure](PROJECT_SITE.md).

The integrated Node 24 suite passed **122/122 tests with zero skips**, including
real restic 0.19.1 recovery. All **10/10 browser journeys** passed. Type checking,
formatting and the artifact guard passed for the 112 staged files. Exact staged
source and all 12 existing Git commits passed gitleaks; repository account
attribution remains visible on GitHub.

The final Linux ARM64 configuration image
`sha256:1d4bad6043eb0aa3b8757d44c250ba4dd3a949c8cd538e69157bbbad29b83e36`
passed all seven isolated HTTPS, private-media, restart and encrypted-recovery
checks on the intended Pi in 14.976 seconds. The OCI image index is
`sha256:40719a43ad2984cdbc8a93fb3599541e659b6b6d37a1904356648467c483e3e8`.
This used a private test CA and a loopback listener; it does not prove the public
Cloudflare route. One earlier Pi harness attempt lacked the synthetic image
fixture; it cleaned up, then passed after that fixture was supplied.

An off-host drill copied the real encrypted repository away from the source Pi,
removed that Pi's synthetic source volumes, and restored from the independent
copy into a fresh volume on a second Pi. Full encrypted-data integrity, wrong-key
refusal, private photo hashes, HTTP reconciliation gating, revoked-recipient
denial, preserved deletion, session invalidation and restored credentials all
passed. Its first harness attempt failed on an import path before seeding data;
the corrected run passed. Both runs used fictional data. All drill containers
and volumes were removed; ciphertext and separately protected recovery keys are
retained privately, outside the repository. This proves the observed recovery
procedure, not an installed daily backup schedule.

The actual Pi systemd deadline fired and stopped the test application with its
launch configuration missing; the data volume remained intact. Guarded startup
then refused the expired dates. A separate missed-deadline exercise stopped the
timer before its scheduled time and restarted it afterward: its persistent
catch-up action ran successfully. The first deadline attempt exposed an older
Docker CLI that rejects `stop --timeout`; the controller now uses the compatible
`-t` option, preserves safe failure context, and passed all 11 controller tests.
The successful host exercises followed that correction. The temporary test
units were removed and the synthetic containers remain stopped. These checks
did not reboot the shared host or open a public route.

The private checkpoint `6e62e8f` passed the complete
GitHub verification workflow (private pre-release run `37293636376`).
That result covers the committed application and deployment checks at that
checkpoint, not subsequent operator-tool changes.

### Restricted backup transport and shutdown coordination

The pilot backup runner has now completed two captures while both the app and
the dedicated tunnel were healthy. Each encrypted generation reached a separate
machine through an SSH key restricted to its backup directory. Checksum
readback and the completion receipt passed; unchanged repository files were
hardlinked between generations. Attempts to run a shell or traverse outside
that directory were refused. An unavailable receiver produced a failure,
preserved the previous verified success, and safely resumed the application.

A fresh-volume restore from that receiver passed private-media hashes,
reconciliation gating, revoked access, preserved deletion, invalidated sessions
and restored credentials. One restore-harness attempt omitted volume ownership
initialization; its disposable resources were removed and the corrected
procedure passed. The first sender attempt found an obsolete synthetic tunnel
container still mounting its old test token. The runner refused the partly
running deployment; replacing that stopped test container with the reviewed
secret mount resolved it. These failures remain part of the qualification
record. No personal archives were involved.

Backup and lifecycle operations now share the lifecycle lock. A shutdown records
its intent before waiting, so a concurrent backup cannot silently undo it by
restarting the application. An independent code review found no remaining
actionable defect in that bounded correction. On the actual Pi, the revised
controller's deadline again stopped the synthetic application with its launch
configuration missing; expired startup was refused, and lock contention proved
that stop intent was recorded first. One short-deadline harness attempt was
correctly rejected by the startup safety margin before the longer exercise
passed.

All temporary qualification units and restore resources were removed. The pilot
is stopped, its test data is synthetic, other running workloads were unchanged,
and no daily backup schedule is enabled yet. The restricted receiver and
encrypted evidence remain privately prepared. Dashboard-only monitoring was
chosen by the owner; the test failure hook recorded a local receipt and did not
deliver an external alert.

The final dashboard-only wrapper subsequently passed an actual stopped-instance
success → unavailable receiver → success exercise. Its durable attempt receipt
and rendered dashboard showed the failed transfer while preserving the previous
verified off-host copy. The private dashboard works independently of the app,
shows backup age from capture time, and marks old snapshots. Desktop and mobile
rendering passed without horizontal overflow. Independent review caught and
resolved interrupted-service correlation and temporary-file recovery defects.
The final integrated native suite passed **156/156 tests, zero skips**, including
real encrypted recovery; type checking and formatting passed. No application
code changed after the ten passing browser journeys and reviewed ARM64 image.

### Host resource enforcement and domain setup

The proposed 10 GiB constrained workload stopped at its initial environment
check: the selected Pi reported Docker memory-limit support disabled, and its
cgroup v2 memory controller was absent. CPU quotas were present. No large
fixture was created, no workload ran, and the isolated test container and volume
were removed. Earlier functional backup and recovery results still describe
their observed behavior; they do not establish enforced memory isolation or
supported capacity on that host.

The controller now refuses startup without host resource support and verifies
the actual memory, CPU and process limits after startup. The owner-authorized
boot correction and one reboot have now completed. Existing services returned,
Docker reports memory-limit support, and an isolated container confirmed actual
RAM, CPU and process caps. Private before/after evidence and the exact boot-file
rollback are retained outside the repository. No shared Mac network settings
were changed.

All **158 native tests passed with zero skips** after this correction. An actual
read-only call to the selected Pi confirmed the new controller refuses its
missing memory support before starting services. The resource-guard checkpoint
`be8fff1` passed the complete
GitHub verification workflow (private pre-release run `37303451558`).

The corrected host then completed a separate constrained workload: **25 accounts,
25,000 records and 10.06 GiB of original JPEGs**, with one CPU and 2 GiB enforced
memory. All 25 queued imports completed in 317.41 seconds alongside 7,700 HTTP
reads and 157 accepted writes, with zero request errors or OOM events. Every
original hash and cross-account denial was checked. A 412.46 MiB member export
completed in 52.99 seconds and its records and media hashes matched. Test
resources were removed. This exercised the compiled application on loopback,
not the normal image entrypoint, public upload path or 1,000-account capacity.
See [conditions, queue delay and limitations](PERFORMANCE.md).

The registrar and the `.org` registry now report the assigned Cloudflare
nameservers for `cleanbookface.org`, and the pilot DNS record points to its
dedicated tunnel. The Pi resolver reaches Cloudflare; a separate workstation
resolver still returns cached parking records. Only the pilot hostname is routed
to the isolated application for synthetic qualification, with all other tunnel
hostnames rejected. The `.com` forwarding
record points permanently to `https://cleanbookface.org`, preserving paths;
an HTTPS request to `www.cleanbookface.com` confirmed the path and query string
in its 301 response. These settings do not mean the website or pilot is live.

The fresh public-origin synthetic installation then passed guarded startup:
application health, registered tunnel, actual RAM/CPU/process limits, no host
ports and exact deadline timer. The older synthetic installation was archived
with a matching file inventory before the new volume was created. The first two
setup attempts stopped safely on an obsolete harness hash pin and a read-only
SQLite WAL inspection limitation; the corrected private harness passed without
altering unexpected data.

A browser journey through **https://pilot.cleanbookface.org** passed with normal
TLS certificate validation and Cloudflare response evidence. It uploaded a
109,052,679-byte synthetic ZIP in pieces no larger than 4 MiB, interrupted and
resumed it after a reload, and rejected changed reselected bytes. Two isolated
accounts proved private upload, memory and media access; original photo hashes,
member export and private reimport matched. Both test memories were removed.
The browser used a temporary loopback SSH SOCKS connection through the Pi,
including remote DNS, because the workstation resolver retained old records.
This was the real public Cloudflare path, not an independent-ISP measurement.
The first transport attempt encountered an existing SSH multiplexed connection;
its exact temporary forward was removed, then an isolated connection passed.
No machine DNS, routes, VPN, trust store or existing browser session changed.

The synthetic app and tunnel were stopped, temporary units and browser transport
removed, and the tunnel returned to catch-all rejection after the test. A fresh
production installation now contains only its operator account: no memories,
media, posts, friendships or invitations. The synthetic installations remain in
separately named private archive volumes. Fresh independent encryption secrets
and a separately restricted backup namespace were prepared without mixing them
with qualification data.

The first stopped production capture reached that receiver and passed full
restic integrity checking. A disposable fresh-volume restore used the receiver
copy and separately held recovery secrets; owner identity and credential hash
matched. HTTP access was blocked before reconciliation, and anonymous access
was denied afterwards. No sessions or content were introduced. The earlier
photo/revocation/deletion evidence applies to the same unchanged image; this
empty production restore does not repeat those populated-data checks. One
read-only SQLite/WAL inspection attempt was corrected by inspecting a private
scratch copy, leaving the production volume untouched.

Production startup is now enabled through the reviewed systemd service, with the
persistent deadline timer installed first. Both containers are healthy/running,
with their kernel limits read back and no published host ports. The fixed pilot
runs from **2026-10-05 13:08:18 UTC** to **2027-01-03 13:08:18 UTC**, with exports
only from **2026-12-20 13:08:18 UTC**. Shutdown is automatic; the planned final
removal on **2027-02-02 13:08:18 UTC** still requires explicit operator work and
proof. Nothing claims automatic disk erasure.

The daily backup timer is enabled at 06:15 UTC with up to five minutes of jitter
and missed-run catch-up. Its actual service completed a live stop/capture/transfer/
resume cycle, verified the new receiver generation and left the app healthy and
tunnel running. The loaded service has no external failure-notification hook.
The private dashboard now reads production backup and receiver storage evidence
and displays the real fixed dates. No invitations have been issued. Independent
reviews, human testing and the member contact/retention notice remain necessary
before opening a broader trial.

The production operator subsequently signed in through real HTTPS, saw the
fixed dates and Cloudflare trust notice, opened the empty private archive, and
signed out every test session. The session cookie carried the production
`__Host-` prefix, Secure and HttpOnly flags. The first private smoke attempt
looked for the development cookie name; it was corrected to check the actual
production cookie and passed. The temporary browser transport was removed.
A private owner handoff supplies sign-in/recovery locations, daily dashboard
instructions, fixed deadlines and the remaining human-review responsibilities.
No owner credentials or recovery material are present in source.

The receiver-capacity dashboard now accepts a fresh, separately measured storage
snapshot without widening the restricted backup transport key. It distinguishes
filesystem space from a 100 GiB planning budget, marks stale or failed reads
unknown, and expires the receiver observation even when the page itself is newer.
Independent review found no actionable defect; the installed readback displayed
the measured receiver allocation. All **161 native tests passed, zero skips**,
including real restic recovery. Type checking, build and formatting passed. This
adds no quota, external notification or automatic deletion.

## Review fixes and private contribution checking, 5 October 2026

The next private candidate rechecks live sessions after request-body, discovery,
password-hash and image-processing waits. Delayed requests cannot complete an
authorized mutation after their session or administration role is revoked.
Archive writes also recheck account deletion, source media and cancelled imports
before committing; rejected image work removes its files. Controlled delayed
requests and Sharp interleavings exercise these boundaries.

Account creation, recovery and password changes now create their replacement
session in the same transaction as the credentials and recovery codes. A full
login-rate bucket can no longer strand a completed change without its codes.
Session-creation failures roll back the change. Resolved moderation appeals
cannot be replayed to undo a later suspension; explicit false values no longer
enable profile discovery or accept the house rules. Independent reproduction
and controlled failure tests cover these fixes.

That earlier integrated suite passed **231 tests, zero skips**, including real restic
recovery; all **ten browser journeys** and type checking pass. The rebuilt local
ARM64 candidate passed all seven isolated HTTPS, private-media, restart and
encrypted fresh-volume recovery checks, plus four provider-bootstrap checks.
Its OCI image index is
`sha256:4f0cac4a48f0951ed010d78435385753847ed4b20efc72797cb6385c666828cc`.
These fixes are not yet deployed to the operator-only pilot. A redundant stop condition in the
pilot controller was removed; its stop and deadline behavior remains covered.

The optional [private contribution reviewer](CONTRIBUTION_REVIEW.md) is installed
on the initial operator's machine for the fixed 90-day window. Its first real run
reviewed two dependency PRs and left one failed attempt queued for retry; it made
no comments, approvals or merges. Independent review led to atomic lock
publication, explicit offline recovery after unclean termination, cancellation
through model processes and GitHub requests, bounded output, and clearer retry
status. An independent recheck found no remaining actionable issue within that
scope. The revised adapter completed a separate authenticated synthetic review
with its configured model and schema; an unchanged snapshot then made zero new
model calls. The schedule depends on the operator's machine being available.

AGY completed application and supplemental source reviews. Fable completed the
supplement and a bounded authentication review independently. Its two whole-
application attempts ended without a final report; those were followed by the
bounded reviews recorded below. Findings are checked against source
and behavior rather than accepted automatically: new tests prove rejection of
unauthorized multipart bodies, the existing host-wide login limit, and denial of
identical signed object/media GETs replayed after revocation. The requested exact
Opus model was unavailable through the authenticated route. None of these model
reports replaces independent human security, accessibility or usability work.

The prepared project page still includes the real fictional-data screenshots,
album logo and favicon. Its revised copy and image links pass checks at 320, 390
and 1280 pixels, with no horizontal overflow, missing images or external requests.
The page remains unpublished. The [five-person session plan](USABILITY_CHECK.md)
is ready; no participant results are claimed.

## Guided hosting and bounded-review remediation, 5 October 2026

The [five-step hosting guide](HOST_YOUR_CIRCLE.md) and `./setup` helper now walk
an owner through the existing Compose installation. Settings are private and
never overwritten; an atomic setup lock and a final resource check reject
concurrent installations. Docker data storage and checkout space are checked
separately. The owner-only **Host tools → Your host checklist** connects address
verification, recorded backups, private import and the first invitation. It does
not claim to configure DNS, schedule backups or verify a restore automatically.
Joining a friend's circle still needs only a browser and an invitation.

The public website and README no longer offer donated pilot hosting. The
private pilot tools remain available. Screenshots, the album mark and favicon
are retained; local website checks at 390 and 1280 pixels found no overflow or
missing images. Public deployment is still held for the owner's decision.

Nine bounded Fable source reviews completed independently of the AGY reports.
Seven passed the automated completion check; two completed across visible
continuations and received a separate AI structural assessment. The original
failed completion checks remain preserved. This is bounded static-review
coverage, not a claim that the requested unavailable Opus review or a human
review occurred. Portable-import conversion fidelity was outside the import
safety review's stated scope and retains its automated round-trip evidence.

Remediation includes canonical actor checks, comment withdrawal after access
revocation, signed-delivery and media retry checks, import resource and
cancellation bounds, snapshot exports, retryable file cleanup, and strictly
newer installation-bound restore ledgers. Container startup now refuses missing
persistent storage. Foreign-container lock recovery requires the exact recorded
kernel-derived container identity; unsupported identity evidence fails closed.
The pilot scripts separate root-controlled receipts and locks from container
writable data and mount only the needed password files. Existing pilot storage
must be migrated through its reviewed rollback procedure before those scripts
are installed; no live migration is claimed here.

The latest integrated candidate passed **301 native tests with zero skips**,
including real restic, and **all ten browser journeys**. Type checking, build
and formatting passed. Its ARM64 OCI image index is
`sha256:c67b421271ff9b28fc79959974afeebd8b4996199d29ee4ff67d6b6d0a603a8e`.
It passed seven isolated HTTPS/persistence/encrypted-recovery checks in 19.011
seconds and seven provider-bootstrap checks in 16.164 seconds, including test
resource cleanup. The first integrated attempt found an obsolete form-budget
assertion and an outdated archive browser interaction; those were corrected
without weakening the size limit or deletion confirmation, then the suites
passed. No managed-provider account or paid resource was created.

The same immutable image passed actual Linux identity checks: the recorded lock
container ID matched Docker's full ID under a private cgroup, and live photo
writes recorded boot identity plus process start ticks. A separate synthetic
cleanup hang exercised the unchanged 50-second shutdown deadline: exit status
1 at 50.27 seconds retained the lock, and an unmodified restart refused it. All
isolated test containers and volumes were removed. These checks used no pilot
data or live service changes.

The website was subsequently redesigned as a compact, early-social-network
front door, with direct GitHub actions, an on-page beginner walkthrough, clear
joining/hosting choices, real app screenshots and a new fictional photographic
cover. Its no-JavaScript layout, images and anchor targets passed at 320, 390
and 1280 pixels. The README now gives the same three entry paths and keeps the
technical reference expandable. Satirical copy is separate from the actual
privacy and independence explanations; no claim of legal immunity is made.

The first Ubuntu CI run of this candidate passed application, browser and
container checks, then exposed a test-cleanup ownership mismatch: the provider
bootstrap correctly protected its synthetic data as uid 1000, while the runner
used a different uid. The harness now restores the original owner before
removing that temporary directory. A separate Linux uid-mismatch reproduction
and the full seven-check provider harness passed after the correction. This
changed the test harness, not the application or image. Website quick links now
separate invited visitors, memory import and hosting; all three work without
JavaScript at 320, 390 and 1280 pixels.

These changes have not replaced the operator-only pilot. Legacy backups without
installation binding remain closed after restore; the upgraded installation
needs a new bound backup, a newer ledger and an actual off-host restore drill.

## Public cross-host qualification, 5 October 2026

A disposable Pi and an independent GitHub-hosted runner completed the full
synthetic journey through two public HTTPS addresses. A fresh browser logged
in both owners, imported their ZIP files without JavaScript, and checked private
photos and shared/revoked/deleted pages. HTTP actions drove friendship, selected
sharing and comments. Nine checks passed: both private imports, mutual
friendship, selected photo delivery, outsider denial, delivery after an outage
and restart, revocation and deletion. The owner's original imported memory
remained private after its shared copy was deleted.

The first run passed every behavior check but failed browser-process cleanup:
the browser had closed while its Node worker still held an open input pipe.
Sending EOF and requiring a zero exit status fixed that defect. Actual browser
process tests covered empty and populated contexts, plus nonzero and hanging
workers. The repeated public journey passed in full, including browser shutdown,
runner resource removal and closure of its temporary public address.
The Pi's exact temporary containers, volume, network and transferred image were
also removed and verified absent. Its existing private pilot remained unchanged.

The tested source is `bbb4a4a8c6472fe3712b7398a38eb69c01c0ed7b` from the
private development history. Exact Docker inputs, image layers and runtime
settings bound the Pi image to that source; the independent runner built it
from the same commit. This is observed browser-assisted/API coverage with
fictional data, not an all-UI human usability study, a capacity benchmark,
general Fediverse compatibility or a permanent hosting offer.

## Remaining qualification and publication checks

- Complete the member contact/retention notice before invitations. The selected Pi has fresh production storage, fixed deadlines, scheduled encrypted off-host backups and a verified restore. Host correction/reboot, normal guarded startup, a constrained 25-account / 10.06 GiB workload and the public-route browser journey passed under the recorded conditions. A boot with the final pilot units and a future-version upgrade still need their own observation; initial startup and same-image recovery are not those proofs.
- Keep the account limit at 25 unless a larger workload and moderation capacity are separately qualified. No result here establishes 1,000-account capacity, measured ISP reliability or permanent managed-provider hosting.
- Independent security review and accessibility review; five-person usability evaluation including people who do not operate servers.
- Fresh-account qualification of managed-provider deployment and recovery. An owner-facing backup walkthrough, same-volume maintenance mode and deployment templates are now included; their existence does not prove a provider deployment.
- Owner approval of the public source and website is recorded above. Public source visibility and private security reporting are verified. The static website, HTTPS and redirects are verified under the conditions above. The released commit subsequently passed public CI after the runner outage; see the current status above. Public issue intake is enabled. Maintain the documented contribution and stewardship arrangements; public release does not establish an independent review or a staffed maintenance team.

Do not import real personal histories into a live circle simply because a local test suite is green. Complete the relevant installation and restore checks, and make the administrator trust model clear to every member.

## Reproduce the release checks

Use a patched Node 24 runtime, reviewed restic, Docker and the browser dependency described in the [development guide](DEVELOPMENT.md). Run the repository check against the exact files staged for publication. The repository does not upload test archives, browser traces, database files or operational reports as CI artifacts.

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run build
npm audit --omit=dev --audit-level=moderate
npm run format:check
npm run check:repository
npm run test:e2e
docker build -t clean-bookface:0.1.0 .
npm run test:container
npm run test:provider
```

`test:container` creates uniquely named Docker containers, volumes and a network. Its only published socket binds to loopback; its local test CA is trusted only by the script. It does not change host networking or trust settings. It removes its own resources afterward. The script exercises the same non-root image and read-only application filesystem used by Compose, including a fresh-volume encrypted restore. It is not a deployment to a hosting provider.

`test:provider` uses isolated Docker volumes and no network or published port. It checks root-owned volume startup, privilege dropping, CLI forwarding, maintenance-mode backup, symlink refusal and cleanup. These local checks cover the supplied bootstrap, not a provider's full runtime or billing behavior.
