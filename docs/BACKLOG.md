# Clean Bookface implementation backlog

Implementation and acceptance ledger, updated 2026-10-05. The v0.1 public-preview application implements the archive, same-host circle and constrained cross-server sharing. The original acceptance criteria remain below; implemented code and automated evidence are distinguished from unfinished release qualification. People control their own feed and interface; the product does not optimize their behavior for engagement.

The separately delivered [encrypted browser successor](ENCRYPTION.md) is development work. The v0.1 milestones below do not establish feature parity or release acceptance for that new architecture. Its [qualification record](../encrypted-client/QUALIFICATION.md) distinguishes tested recovery and sharing from measured migration, moderation, account-closing and import behavior from remaining production-route and human acceptance work.

Implemented stack: Node 24, TypeScript, Hono with server-rendered pages, node:sqlite, private filesystem media and Fedify 2.4.0 HTTP signatures. One application owns persistent import jobs and a transactional delivery ledger. Dependencies are pinned in package-lock.json; no separate queue, search or frontend service is required.

The original `clean-bookface` directory remains a preserved prototype. Reuse its synthetic fixtures, import classification ideas, SQLite transaction patterns, and visual references selectively. Its Electron wrapper, browser extension, ownerless entity model, predictable vault-key fallback, and structural checks are not a hosted social application. Passing its existing tests does not satisfy this backlog.

**Status vocabulary:** implemented means the consuming application path exists; tested names its automated proof. Neither means that every release gate has passed. Dependencies below retain the original build order.

Current evidence is executable in the archive, core, HTTP, federation, portability, operations, upload and pilot tests, with real browser journeys under `tests/e2e`. On 2026-10-05 the latest integrated native suite passed 301 tests with zero skips; all ten browser journeys passed for the rebuilt candidate. Session/media races, transactional account completion, explicit privacy choices, guided hosting, independent-review fixes and private contribution-review remediation are recorded in the release ledger. The new candidate passed local ARM64 HTTPS, restart, encrypted fresh-volume recovery and provider-bootstrap checks. The earlier pilot image passed isolated HTTPS, restart and encrypted fresh-volume recovery on the intended Pi, followed by recovery on a second Pi after removing the synthetic source volumes. Restricted off-host backups and dashboard-only success/failure reporting also passed on the actual hosts. The native 50,000-record workload passed under its documented conditions. Following an authorized host correction and reboot, a separate 25-account, 25,000-record / 10.06 GiB workload passed under enforced one-CPU / 2 GiB limits with concurrent reads and writes. See [release evidence](RELEASE.md) and [performance](PERFORMANCE.md) for measured scope and the separate public-route journey. No result qualifies 1,000 accounts.

**Public source available; qualification still open:** the owner approved source and website publication on 2026-10-05. Anonymous source access and the static project website are verified. The website’s seven assets match the approved hashes, HTTPS and redirects passed, and injected analytics was disabled and verified absent. Fresh mobile checks with JavaScript disabled and normal Chrome desktop checks with JavaScript enabled passed. Initial public CI attempts failed before any steps during a GitHub Actions runner outage. The exact released commit `2b9b110` subsequently passed public run `37371375764` (attempt 2), as recorded in [Release status](RELEASE.md). Pilot invitations remain held. AGY and nine bounded Fable reviews are complete, with confirmed findings remediated; the requested exact Opus model was unavailable. Independent human security/accessibility review and the five-person usability study have not happened. The new candidate still needs the reviewed pilot migration, a new installation-bound backup and an actual off-host restore before replacing the older operator-only installation. Fresh-account managed-provider deployment and recovery remain unqualified. The public hosting offer has been removed; reusable private pilot tools remain. Exact source/history privacy checks are required for each publication. The 50,000-record archive run and the constrained 25,000-record / 10.06 GiB Pi run were separate workloads. The pilot limit remains 25 accounts with 1 GiB archive allowances; 1,000 is a configurable ceiling, not measured capacity.

## Community priorities

This section is the entry point for new contributors. The milestone ledger below records **v0.1** implementation and dated evidence, not completion of the encrypted successor. Use [Contributing](../CONTRIBUTING.md) to choose and coordinate a task. Target the appropriate package and check open pull requests before taking ownership. The encrypted build originated in [PR #4](https://github.com/Dynobit/clean-bookface/pull/4); check its current state before taking overlapping work.

| Priority / scope                          | Small first contribution                                                                                     | Acceptance evidence                                                                                                                                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| v0.1 documentation                        | Follow one member or developer journey and correct a missing or misleading step.                             | Name the version and environment; record the steps actually tried; check affected links and distinguish untested instructions. Use fictional data.                                                                                               |
| v0.1 accessibility                        | Review one screen in the invite, import or sharing journey.                                                  | Keyboard focus/order, accessible names, error feedback and narrow-screen behavior are described with reproducible steps; a fix is checked with the reported browser/assistive tool. Automated browser checks alone do not complete human review. |
| v0.1 archive regression                   | Cover one unsupported or mishandled export variation using a tiny synthetic fixture.                         | Counts reconcile, reimport remains idempotent, and a second account cannot read imported text or media. State unsupported cases rather than silently dropping records.                                                                           |
| v0.1 privacy review                       | Review one content/media/search/export access boundary against the privacy contract.                         | Exercise owner, allowed recipient, stranger and revoked recipient; report any vulnerability through the private security route. A public checklist must not disclose an unpatched exploit.                                                       |
| v0.1 host operations                      | Rehearse the documented install and one fresh-volume restore on a disposable host.                           | Record exact version, prerequisites, commands, restart persistence, restored record/media integrity and failure behavior without secrets or private addresses. Local recovery does not qualify an off-site/provider deployment.                  |
| Encrypted successor tests                 | Coordinate a minimal reproducer for the older fixture with missing keys or the unexplained SDK cancellation. | Record the exact draft commit, command and sanitized failure, then prove the cause and fix with a behavioral regression. Do not remove the failing case or weaken the requirement to obtain a pass.                                              |
| Encrypted successor feature work          | Improve one existing conversation, account-closing or moderation path with a reproducible user need.                     | Specify audience/key behavior and denial cases first; prove the complete client/host path and interruption/retry behavior. Do not carry over v0.1 completion claims.                                                                             |
| Encrypted successor release qualification | Run the human security/accessibility review or usability study, or qualify an additional host architecture/provider.                            | Publish reproducible synthetic evidence and remaining limits for that exact candidate. Green CI and local cross-home/standby checks do not establish production readiness.                                                                       |

The 6 October encrypted candidate passed 99 client tests, 27 host tests, actual migration/social/recovery browser journeys, a 1 GiB browser import and a physical offsite backup/restore. Public-route and release evidence belong in the [client qualification](../encrypted-client/QUALIFICATION.md) and [host qualification](../encrypted-host/QUALIFICATION.md) records. These results do not complete independent human reviews or establish unlimited capacity.

## M0 — Private foundation

### M0-01 — Establish the private source repository

**Status:** private foundation completed; reviewed application source and release evidence are included in the owner-approved public-preview candidate. **Dependencies:** none.

The prototype and private development history remain separate; only reviewed source and documentation belong on the public remote, with exact staged-content checks for each push. **Local acceptance:** tracked files contain no archives, credentials, databases, browser profiles, personal screenshots, or real-user fixtures. **Remote acceptance:** the earlier private visibility and authenticated Git access were read back. Public visibility and anonymous access are now verified for the clean public history at `46838a8`; application and test inputs match the reviewed pre-release baseline, with twelve documentation and website-copy files changed. The former development history remains private. Repository visibility is not a substitute for these exclusions. Continue reviewing staged content and checking visibility before publication.

### M0-02 — Make the smallest runnable application

**Status:** implemented; configuration/schema and HTTP startup checks exist. Local container HTTPS/restart/recovery smoke passed; clean external-provider qualification remains open. **Dependencies:** M0-01.

Create the typed server, templates, migrations, configuration validation, CI, and container build. **Acceptance:** a fresh checkout builds and starts reproducibly; required secrets have no predictable fallback; startup reports actual readiness; persistent application data resides outside the image and source tree.

### M0-03 — Specify privacy and access rules

**Status:** implemented and exercised by core, HTTP and two-host federation access tests. Independent security review remains open. **Dependencies:** M0-01.

Define private archive, shared posts, account ownership, friend acceptance, operator trust, and deletion semantics. **Acceptance:** an executable access matrix covers owner, accepted friend, pending friend, stranger, blocked member, and remote peer for content, media, search, jobs, and exports. No imported record is automatically published.

### M0-04 — Establish safe fixtures and project boundaries

**Status:** implemented fixtures, provenance, MIT license, contribution and security guidance. The explicit CI runtime-artifact guard is implemented; per-release source/history review remains required. **Dependencies:** M0-01.

Add synthetic export examples, a contributor guide, licensing decision, and vulnerability-reporting instructions. **Acceptance:** fixture provenance is documented; CI rejects accidental runtime artifacts; contribution/release instructions support future public maintainers; no personal information or machine paths enter documentation. The README states the human-only account policy without promising perfect detection or guaranteed remote erasure.

## M1 — Reliable personal archive

### M1-01 — Implement ownership and durable data identity

**Status:** implemented and tested for owner-scoped identities, equal text, revisions and reimport. Initial component schemas are versioned and reject unknown future versions; a future schema-to-schema upgrade needs its own proof. **Dependencies:** M0-02, M0-03.

Introduce accounts, imports, source records, archive items, attachments, and separate shareable posts. **Acceptance:** owner-scoped source identity preserves equal-text posts on different dates and equal messages in different threads; reimport is idempotent; occurrence time differs from import time; migrations preserve existing records.

### M1-02 — Implement account sessions and owner isolation

**Status:** implemented and tested in core and HTTP suites, including setup ownership, invitation races, recovery, session invalidation and cross-account denial. **Dependencies:** M0-02, M0-03, M1-01.

Provide initial owner setup, login/logout, secure sessions, recovery codes, and rate limits using reviewed components. **Acceptance:** setup cannot be reclaimed after initialization; CSRF/session tests pass; another account cannot retrieve archive items, media, import status, search matches, or exports by guessing identifiers.

### M1-03 — Build bounded, resumable archive ingestion

**Status:** implemented and tested in the bounded archive worker: ZIP/folder/split inputs, cancellation, restart, cleanup and atomic failure. Browser uploads resume in verified 4 MiB chunks after interruption and reload; direct multipart uploads share filesystem-entry and metadata budgets. No claim of arbitrary export-format support. **Dependencies:** M1-01, M1-02, M0-04.

Accept supported JSON archives through controlled upload, with job progress and an explicit import report. **Acceptance:** traversal, symlinks, oversized expansion, malformed input, and resource exhaustion are contained; interruption resumes or rolls back coherently; unsupported categories and missing files have counts; temporary uploads expire and are removed after successful processing.

### M1-04 — Preserve memories faithfully

**Status:** implemented and tested on documented synthetic JSON fixtures, including exact Unicode, old/millisecond dates, attachment-only content and split conversations. Broad real-export diversity remains unqualified. **Dependencies:** M1-03.

Fix Unicode, timestamps, attachment-only posts, multiline text, and record reconciliation. **Acceptance:** Hebrew, emoji, accented text, long posts, old posts, and split exports survive; historical records have indefinite retention by default; no silent truncation occurs; original, stored, duplicate, rejected, and unsupported counts reconcile. HTML remains unsupported until a faithful parser has its own proof.

### M1-05 — Store and serve actual media

**Status:** implemented and tested for durable owner-only originals, metadata-stripped sharing copies, MIME/pixel limits and missing-media reports. **Dependencies:** M1-02, M1-03.

Copy original media into private durable storage, attach it to records, and generate bounded previews. **Acceptance:** deleting the uploaded temporary archive does not break photos; restart preserves media; MIME and image-dimension validation work; every media request is authorized; filenames reveal no host paths; missing and unsupported media are visible in the import report.

### M1-06 — Deliver the private archive interface

**Status:** implemented: archive timeline/search, private messages, photos/albums and deletion. Automated archive/HTTP checks exist; observed new-user and independent accessibility acceptance remain open. **Dependencies:** M1-04, M1-05.

Build timeline, albums, profile preview, search, import history, and archive deletion with 2012-inspired styling. **Acceptance:** original dates determine chronology; pagination cannot skip or repeat records; keyboard/mobile use works; private search stays owner-scoped. Any supported message history has a separate private view and cannot enter the sharing pipeline.

## M2 — Same-host circles and daily use

### M2-01 — Invite people and establish mutual friendship

**Status:** implemented and tested: hashed single-use invitation consumption, explicit mutual friendship, expiry/revocation and no automatic friendship on registration. **Dependencies:** M1-02, M0-03.

Implement expiring single-use invitations, limited registration, friendship requests, acceptance, rejection, and removal. **Acceptance:** accepting an invitation does not silently create friendships; membership alone grants no archive access; rate limits and invitation revocation work; names imported from Facebook never authenticate a person.

### M2-02 — Publish deliberately selected memories

**Status:** implemented and tested across archive and HTTP routes: private source, explicit preview/audience, separate publication and metadata-free sharing copies. **Dependencies:** M1-06, M2-01.

Create a shared post from an explicitly selected private archive item with an audience preview. **Acceptance:** archive and published copy have distinct lifecycle records; private messages/security records cannot be published; shared image derivatives remove location metadata; media and text use the same audience; private originals stay inaccessible.

### M2-03 — Build the social feed and interactions

**Status:** implemented: chronological feed, profile walls, posts/comments/likes, grouped photo albums and persistent in-app notifications. Core tests cover equal-timestamp pagination and notification audience/revocation behavior; browser qualification is recorded separately. **Dependencies:** M2-01, M2-02.

Add native posts, comments, simple reactions, profile walls, photo albums, and in-app notifications. **Acceptance:** chronological feeds show only authorized content; comment/reaction access follows the parent post; edits and deletion persist; archive dates and publication dates are visibly distinct; no advertising or recommendation tracking requests occur.

### M2-04 — Enforce blocking and audience changes

**Status:** implemented and tested: per-account block/report/suspension/appeal, audience grants/revocation and durable peer-host blocks. No perfect-human-verification or remote-erasure claim. **Dependencies:** M2-03.

Add block, unfriend, content reports, invitation limits, and instance moderation with an appeal route. Prohibit bot accounts and automated posting; enforce registration/posting limits and review suspicious behavior. **Acceptance:** abuse controls have regression tests; human users can appeal mistakes; access is revoked across feed, direct URLs, search, attachments, and notifications; cached responses cannot retain access; blocked users cannot comment or send new requests. Documentation explains that recipients may keep downloaded copies.

### M2-05 — Finish the ordinary user experience

**Status:** implemented browser flows and preferences; Playwright covers login, deliberate photo sharing, export and a narrow viewport. Five observed participants and independent accessibility review remain open. **Dependencies:** M2-03, M2-04.

Complete empty states, privacy labels, confirmation flows, import recovery, settings, and account/session controls. Provide an ordinary person's hosted path: open invite link, create account, choose optional import, review privacy, meet friends. **Acceptance:** a new participant completes that journey without managing a server or understanding federation; narrow screens and keyboard navigation pass review; defaults are safe and explained; people can choose presentation settings; diagnostics stay in operator screens.

## M3 — Early federation spike

Run this milestone alongside M1 once foundations exist. Its outcome must precede substantial federation implementation; milestone numbering is not a request to postpone the experiment.

### M3-01 — Freeze the narrow peer contract

**Status:** implemented and documented in FEDERATION.md: exact actor identities, mutually accepted recipients, signed fetches and the constrained private-v1 profile. **Dependencies:** M0-02, M0-03.

Specify canonical identities, mutual acceptance, targeted delivery, authentication, supported activities, and rejection behavior. **Acceptance:** the contract distinguishes Clean Bookface peer support from general Fediverse interoperability; imported names and contact hashes are not identity proof; no central directory or contact upload is required.

### M3-02 — Prove two isolated peers

**Status:** implemented and tested over two real isolated HTTPS servers with synthetic actors. Discovery, acceptance, private media, offline retry, dedupe and production SSRF policy checks pass. **Dependencies:** M3-01.

Use Fedify in an isolated two-instance spike with synthetic actors and posts. **Acceptance:** authenticated invitation/acceptance, targeted post delivery, authenticated private-media access, offline retry, duplicate rejection, and deletion are demonstrated; network fetches cannot reach prohibited/private destinations; incompatible library assumptions are documented before adoption.

### M3-03 — Review feasibility and update the contract

**Status:** implemented decision recorded in FEDERATION.md: Fedify signatures with application-owned validation, transport and durable ledger. Independent security review remains open; no general fediverse claim. **Dependencies:** M3-02.

Record the implemented protocol subset, trust model, operational requirements, and unresolved gaps. **Acceptance:** there is a reviewed implementation decision with reproducible evidence. A failed spike changes the architecture or scope explicitly; it does not produce a homemade cryptographic protocol or an unsupported interoperability claim.

## M4 — Full cross-host sharing and discovery

### M4-01 — Resolve addresses and connect friends

**Status:** implemented and tested: explicit profile links, opt-in WebFinger and mutual cross-host requests. Source names never trigger automatic discovery or identity acceptance. **Dependencies:** M3-03, M2-01.

Implement explicit profile-address/invitation discovery, local address book, identity confirmation, and cross-host mutual friendship. **Acceptance:** independent hosts connect without a global service; discovery is opt-in; unknown names stay unverified; imported friend lists remain private; actor/domain changes trigger explicit verification.

### M4-02 — Integrate durable outbound and inbound delivery

**Status:** implemented and tested: transactional events, lease/retry ledger, exact dedupe, lost acknowledgement, SQLite reopen and graceful shutdown without discarding jobs. **Dependencies:** M4-01, M2-03.

Persist delivery jobs, retries, receipts, deduplication, and observable failure states. **Acceptance:** restarting either host loses no accepted job; duplicate or replayed activities do not duplicate content; bounded retries recover after outages; invalid senders and unauthorized recipients are rejected; logs omit bodies and bearer secrets.

### M4-03 — Deliver private posts, media, and comments

**Status:** implemented and tested with actual HTTPS actors: recipient-bound posts/media, comments, likes and relayed interactions; unauthorized identities on the same peer host are denied. Core tests cover private notifications. **Dependencies:** M4-02, M1-05.

Connect the protocol to the real audience model, media derivatives, comments, and notifications. **Acceptance:** accepted friends on two hosts see the same intended conversation; a third host cannot fetch it; comments require continuing authorization; no globally readable object or media URL bypasses audience checks.

### M4-04 — Propagate changes and contain hostile peers

**Status:** implemented and tested: edits/deletes/revokes, exact relationship and Like Undo, peer limits/blocks, stale-event tombstones and offline recovery. **Dependencies:** M4-03, M2-04.

Implement edit/delete, unfriend/block, peer limits, delivery suspension, and deletion tombstones. **Acceptance:** compliant peers apply deletions and revocations after offline recovery; stale delivery cannot resurrect deleted content; blocked peers cannot continue delivery; partial failures are visible without promising erasure from uncooperative recipients.

### M4-05 — Test the complete independent-host journey

**Status:** passed a browser-assisted/API import-through-deletion journey on a disposable Pi and independent GitHub-hosted runner through public HTTPS, including outage/retry, access denial and cleanup. Browser-only usability with real participants remains separate. See [release evidence](RELEASE.md#public-cross-host-qualification-5-october-2026). **Dependencies:** M4-04, M2-05.

Run a repeatable two-host browser/API scenario with a third unauthorized participant. **Acceptance:** each owner imports privately, discovers the other by invitation, accepts, shares, comments, loses connectivity, reconnects, revokes, and deletes; access and delivery assertions pass at every stage.

## M5 — Operations, privacy, and release

### M5-01 — Make backups and upgrades recoverable

**Status:** implemented restic backup/restore, encrypted secret bundle, instance locks and current-revocation reconciliation. Real restic tests cover hashes, wrong keys, missing media and stale-state removal. Guided owner setup and managed-host maintenance mode are implemented and tested. The selected Pi passed restricted transfer to a separate host and a fresh-volume restore from that receiver, including revocation, deletion and session checks. The fresh production repository and new recovery secrets also passed a receiver restore; the actual daily systemd service completed a live capture/transfer/resume cycle and its timer is enabled. Managed-provider qualification and future-version upgrade rehearsals remain open. **Dependencies:** M1-06 for the archive/circle phase; M4-02 and M4-04 for the federation extension.

Start consistent database/media backups with restic and documented key recovery immediately after the private archive slice; define safe upgrades. Require a successful fresh-host restore before any real-user pilot. Extend the backup/recovery proof with federation identity, delivery and revocation state as those modules arrive. **Acceptance:** restoration matches record/media hashes; wrong keys fail closed; incomplete backups are rejected; migrations have a tested recovery path; backups have an explicit retention policy; old snapshots cannot resume sharing without reconciling newer revocations.

### M5-02 — Complete export and deletion

**Status:** implemented export/import and deletion. Portable tests start at the actual HTTP export and preserve text/media privately on a fresh host; account deletion has durable cleanup continuation. Final integrated interrupted-deletion/restore evidence must accompany release qualification. **Dependencies:** M4-04, M5-01.

Provide portable account exports and deletion across archive, media, indexes, sessions, queues, and replicas. Document moving to another host, including identity changes and friend re-verification. **Acceptance:** an export imports on a fresh host with media intact; deleted local data cannot be searched or served; interrupted deletion completes; restore does not resurrect deleted accounts through stale jobs; backup aging and remote-copy limitations are explained clearly.

### M5-03 — Validate deployability and publish the release evidence

**Status:** partially qualified. Image/Compose, HTTPS configuration, health checks, operator/cost documentation and CI are implemented; local container/HTTPS/restart/encrypted-restore checks passed, as did the documented native 50,000-record workload. The selected Pi completed the documented constrained 25-account / 10.06 GiB workload; the real Cloudflare upload journey also passed. Fresh production operations and daily backup scheduling are installed and verified. The private operator handoff is prepared; managed-provider deployment and independent reviews remain open. Source and project-website publication are complete; they do not qualify an installation. **Dependencies:** M4-05, M5-01, M5-02.

Complete HTTPS setup, operator documentation, resource limits, health checks, dependency review, accessibility review, and release packaging. Include a low-cost hosting recipe, who pays and administers it, and dated monthly compute/storage/backup/domain/egress estimates linked from the hosting guide. **Acceptance:** a clean-machine install follows the docs; supported workload limits are measured; published cost assumptions match that workload; release evidence records failures as well as passes; making the source public remains a separate deliberate repository action.

## Original first-day vertical slice — retained as regression scope

1. Finish M0 repository boundaries and start the reproducible server/container.
2. Implement the owner/schema/session core before connecting an importer.
3. Import a bounded synthetic JSON archive containing one old post, two equal-text posts on different dates, multilingual text, and one actual image.
4. Display the private chronological timeline and image; restart and confirm persistence.
5. Reimport without duplicates; use a second account to prove every object/media route remains private.
6. Record unfinished cases and the next acceptance blocker. Start the federation spike in parallel only if it does not compromise this slice.

This slice now exists and is covered by archive/core/HTTP tests. Its completion is not full release acceptance. Large real-archive diversity, the proposed workload and provider-hosted recovery still require their own qualification.

## Required tests and release gates

**Every change:** relevant unit/integration checks, typed build, and ownership checks for new endpoints. Tests must verify behavior rather than merely assert implementation strings.

**Archive gate:** lossless supported fixtures; reconciled counts; bounded hostile inputs; indefinite historical retention; idempotent reimport; crash recovery; actual durable media. Real export validation uses explicitly provided local data without committing it or uploading it to external services.

**Sharing gate:** cross-account access matrix, invitation/session/CSRF abuse cases, audience changes, blocked-user behavior, metadata stripping, mobile accessibility, and no third-party tracking requests.

**Federation gate:** authenticated peers; replay and duplicate rejection; SSRF containment; private media; offline convergence; revoked permissions; deletion tombstones; complete two-host journey. No general Fediverse compatibility claim without its own conformance evidence.

**v1 gate:** all accepted v1 tasks integrated; fresh install and backup restoration proven; export/deletion verified; supported scale documented; known privacy limitations stated; reproducible release reviewed. Green tests alone do not replace a working user journey.
