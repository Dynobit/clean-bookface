# Privacy contract for Clean Bookface v1

> This page describes the older **v0.1 application**. For the encrypted version, use the [member guide](ENCRYPTED_GETTING_STARTED.md), [hosting guide](../encrypted-host/SELF_HOST.md) and [encryption contract](ENCRYPTION.md). The two versions have different privacy and hosting requirements.

**Status, 2026-10-02: implemented privacy contract with automated evidence; public production qualification and independent review remain open.**

Clean Bookface is a self-hosted private archive and invitation-based social app. Its default is to keep imported material private. Publishing creates an intentional, separate copy for a defined audience. The implementation is one TypeScript/Node 24 service using Hono, SQLite, private local media storage, and Fedify HTTP signatures; no Redis or central account service is required. The requirements below remain release acceptance checks, including cases not established by the current test suite.

The executable evidence is in `tests/archive.test.ts`, `tests/core.test.ts`,
`tests/http_security.test.ts`, `tests/federation.test.ts`,
`tests/federation_http.test.ts`, `tests/portable.test.ts` and
`tests/operations.test.ts`. These cover owner isolation, deliberate sharing,
actual isolated HTTPS peers, malformed inputs, retries/restart, revocations and
encrypted recovery. Restic tests require the real restic binary; a skipped test
is not a restore proof. The exact unfinished release checks are in
[BACKLOG.md](BACKLOG.md). There has been no independent security audit or
five-person usability study, and no external production host is qualified by
these local tests.

## Trust model and honest limits

Protect against anonymous visitors, unauthorized accounts, accidental oversharing, malicious archives, forged federation events, hostile URLs, tracking resources, and accidental disclosure through logs, search, caches, or backups. Also contain resource abuse by invited users and remote servers.

The owner trusts the machine and administrator hosting their account. Remote sharing additionally trusts the recipient and their hosting administrator. **In v1, administrators of the sender's and recipient's servers can read active plaintext.** Authentication and access checks protect one account from another through the application; they do not make a hostile administrator trustworthy. Recipients can save or photograph anything they can see.

People joining a friend's hosted circle must see who operates it and this trust boundary during setup, in plain language. They retain account export and deletion controls. Hosting a circle does not authorize its administrator to publish members' archives or widen their audiences.

TLS protects transport. SQLite databases and container volumes are **not automatically encrypted**. Deployment instructions must distinguish disk encryption from application access control, require encrypted backup procedures, and explain that a running host can access decrypted data. No v1 screen or documentation may claim end-to-end encryption, zero knowledge, guaranteed remote erasure, or absolute bot prevention.

## Data boundaries

| Data | Permitted access and movement |
| --- | --- |
| Original archive and imported records | Account owner through authenticated routes; never federation input by default. |
| Original photos and videos | Owner-only storage; sharing uses separately generated derivatives. |
| Publications and derivatives | Author and explicitly authorized recipients; recipient hosts receive only the shared representation. |
| Friendship and audience records | Owner and narrowly necessary application processing; no public roster. |
| Credentials, sessions, signing keys, recovery material | Dedicated protected storage; excluded from member exports, logs, screenshots, and support bundles. Operator disaster recovery uses a separate encrypted secret bundle. |
| Operational events | Minimal identifiers, outcomes, and timing; no archive bodies, message text, credentials, or invitation tokens. |

The Git repository, CI, issue tracker, screenshots, and examples must contain synthetic fixtures only. A private GitHub repository is not a suitable home for personal archives or production secrets. Telemetry and external analytics are absent by default; static assets and fonts are served locally.

## The connection to a donated pilot

The optional Pi pilot uses Cloudflare Tunnel for public HTTPS. Cloudflare
terminates HTTPS and can process the traffic passing through it; the private
connection to the application does not make this end-to-end encrypted.
The application discloses this before joining and importing when
`CLOUDFLARE_PROXY=true`. Do not cache authenticated responses at the proxy.
The host can read stored archives, and people can save what you share with them.
Choose a circle whose host and connection providers you trust.

Pilot upload staging is temporary and owner-scoped. Browser archive uploads
arrive in small, verified pieces; a disconnected browser can resume after the
owner reselects the same files. Unfinished uploads expire after 24 hours, and
are excluded from backups. An import still creates no public posts.
The [pilot invitation terms](PILOT.md) describe fixed closing dates, export time
and the host's obligation to announce a separate data-removal plan.

## Import is not publication

An import produces owner-scoped archive records with provenance and import identifiers. It creates no posts in friends' feeds, follower events, invitations, public profiles, or remote lookup requests. Browsing an imported item must not fetch an external image or tracking URL.

The share flow previews exactly what will leave the archive. It copies selected text and media into a new publication with a new identifier, explicit recipients, and a visible audience summary. The original remains private. Source Facebook identifiers, archive paths, historical audience settings, and import metadata stay out of the shared object.

Original DMs, friend rosters, third-party comments, reactions, tags, and account-security information are never automatically shared. Imported names neither create accounts nor establish identity. V1 does not provide a one-click publication of an imported conversation. Private message browsing, if available, stays inside the archive; new encrypted messaging is outside this contract.

Shared photo derivatives remove embedded location and other unnecessary metadata. Preserve orientation visually, not by retaining the original metadata block. Originals remain available privately to their owner. Metadata removal cannot hide information visible in the picture, so the preview must let the owner exclude or replace it. A shared media endpoint must never silently return the original file.

## Audience and friendship semantics

The audience choices are private, current friends, and selected friends. Private content has no remote delivery. Publishing to current friends saves a **recipient snapshot** of mutually accepted relationships at that moment. Selected friends saves the chosen subset. New friends receive future posts, with **no automatic historical backfill**. Sharing old items or albums with a new friend requires a deliberate new grant.

Changing text or media preserves the audience. Adding recipients is a separate action with a preview. Removing recipients revokes origin access, cancels their pending content deliveries, and asks compatible remote servers to purge cached copies. Neither changing an album audience nor accepting a friendship may implicitly widen an existing publication's audience.

Friendship states include pending, accepted, rejected, expired, cancelled, and blocked. Only accepted mutual consent permits sharing. A request expresses the sender's consent; the recipient must affirmatively accept. An invitation link is not itself an authenticated identity or permission to read content. Reject, cancel, and expiry confer no access.

Comments and reactions inherit the parent publication's audience and require current authorization. They cannot add recipients or expose the parent to the commenter's friends. The post's home server controls thread distribution and verifies each remote author's authority. A new friend must not learn an old private post through notifications, comments, counts, or search.

## Finding friends without a contact database

The first discovery mechanism is an invitation or profile link shared through an existing channel outside the app. Tokens are random, single-use, expiring, revocable, and stored hashed. A registration invitation is consumed atomically with account creation; a friendship invitation requires login and explicit account confirmation. Registration alone does not create friendships. Tokens must not appear in logs, analytics, referrers, or third-party requests. A link may be forwarded, so the acceptance screen identifies the account actually requesting friendship.

Remote discovery is opt-in. Users who enable handle lookup can publish a minimal `@name@host` mapping through WebFinger. WebFinger resolves a supplied identifier; it is not proof of the person's real-world identity. [WebFinger specification](https://www.rfc-editor.org/rfc/rfc7033.html)

There is no mandatory central directory, uploaded contact book, harvested Facebook-ID index, or matching service built from hashed names or email addresses. Private imported friend names can help an owner remember whom to contact, but cannot trigger remote queries or automatic acceptance. An optional directory in a later release requires a separate privacy design.

Enabling federation reveals a server address and stable actor/key identifiers to peers. Opting into handle lookup makes that handle discoverable. Real names, avatars, biographies, and other profile fields have their own disclosure preview. Public bootstrap/key responses must not expose archives, friend lists, counts, or private biography fields. We do not promise that a federated account's existence is secret.

## Federation and authorization

V1 supports a documented, tested Clean Bookface private-sharing profile using ActivityPub and Fedify. It does not promise compatibility with every fediverse application. Public relays, boosts, global feeds, and automatic conversation backfill are disabled. Incompatible peers fail closed for private content.

The application uses Fedify's maintained RFC 9421 signing and verification APIs,
with its own Hono routes, constrained HTTPS fetcher and audience checks. It
validates authenticated actor/key ownership, object ownership, intended
recipient, current friendship and the publication's saved audience. A valid
signature proves control of a bound actor key; it does not prove a human identity
or authorize arbitrary actions. The exact profile is in
[FEDERATION.md](FEDERATION.md).

Apply the same access policy to HTML, JSON, ActivityPub objects, media originals and thumbnails, range requests, search, counts, notifications, exports, and cached responses. Random URLs are not authorization. Private responses must not enter shared public caches. Credentials or object URLs alone must not bypass an audience check.

Remote object/media fetches require a validated actor signature and explicit
permission checked by the application. This mechanism narrows interoperability.
A server-level bootstrap identity is not a blanket grant to read private posts;
minimal public actor/key documents exist only to verify signatures.

Recipient servers store authorization per account, not merely per host. If Alice shares with Bob, Charlie must not gain access because Bob and Charlie use the same server. Outgoing envelopes must not reveal the entire recipient roster. Incoming events cannot expand recipients or modify another author's objects. Unsupported or ambiguous audience information is rejected rather than interpreted as public.

## Deletion, blocking, and delayed delivery

Unfriending or blocking immediately removes origin access, cancels pending publication delivery, and initiates compatible-peer cache removal. Blocking also suppresses new requests and interactions until unblocked. It does not send a special notification announcing the block. Unblocking or becoming friends again does not restore old grants automatically.

Deleting shared content removes its active local representation and derivatives, revokes access, and records authenticated deletion deliveries for previously contacted recipients. Deleting an archive item must show whether linked publications exist; the default destructive action removes those copies too, with a clearly separate option to remove only the private archive record. Account deletion revokes sessions and invitations and schedules deletion of owned publications, archive records, and unreferenced media.

Retain minimal tombstones and delivery/revocation records, without deleted content, to reject late creates, updates, retries, and replayed acceptance events. An `Undo` must reference the exact activity being undone and match its actor; it cannot restore deleted content or a revoked grant. Recreating content creates a new object and requires a new audience decision.

Remote removal is a request, not a guarantee. The UI must distinguish deletion here, removal pending remotely, and an acknowledged compatible-peer operation. ActivityPub cannot force a remote server to erase an already delivered copy. [ActivityPub deletion semantics](https://www.w3.org/TR/activitypub/#delete-activity-inbox)

Encrypted backups have a documented retention period and can contain older data until expiry. Before a restored instance serves users or federates, it must reconcile current deletion and revocation records. If these records cannot be recovered after restoring an older backup, keep sharing disabled until reconciliation; never silently resurrect deleted content.

## Durable delivery and hostile inputs

Commit a publication change, audience change, and pending delivery record in one SQLite transaction. Persist activity identifiers, revisions, intended recipients, attempts, and final outcomes. Retry with bounded backoff; deduplicate incoming activities; recheck access before each content delivery. A failed or offline peer never causes a fallback to public delivery.

The implementation uses transactional domain events, a SQLite delivery ledger,
reconciliation, expiring delivery leases and recipient-specific deduplication.
It does not rely on a wake-up queue as the durable source of truth. Tests cover
offline retry, a lost acknowledgement, complete database reopen, delayed events,
and shutdown without losing unsent work. This is evidence for those boundaries,
not a claim that every possible crash interleaving has been exhaustively proven.

Enforce compressed and expanded archive limits, entry counts, file-size limits, nesting limits, import timeouts, and per-account storage quotas. Reject path traversal, symlinks, executable content, and unsupported file types. Parse untrusted HTML as data; sanitize rendered content and never execute imported scripts. Thumbnail generation has resource limits and cannot access unrelated host files.

Validate every remote actor, key and attachment destination. The production
fetcher rejects redirects, checks every DNS answer against its public-address
policy, pins an approved address for the connection, and bounds time and bytes.
Private, loopback, link-local and metadata-service targets are denied. No remote
avatar or browser image embeds are fetched implicitly. HTTPS tests inject an
explicit test transport; no production environment flag enables private targets.

## Release acceptance

Use synthetic data on two isolated HTTPS instances, with Alice on A and Bob plus Charlie on B. Release requires proof that:

1. Import produces no remote disclosure; anonymous visitors and other accounts cannot access archives or media.
2. Friendship requires acceptance; Bob receives selected content while Charlie and a newly accepted friend cannot see it.
3. Every content, media, search, and federation route respects the same ACL and does not reveal the recipient roster.
4. Forged actors, unauthorized mutations, replay, SSRF, archive traversal, and quota abuse fail closed.
5. Restart/crash tests at commit, dequeue, send, and acknowledgement boundaries recover without silent loss, duplication, or resurrection.
6. Unfriend, block, audience removal, and deletion deny origin access immediately and converge on compatible peers after recovery.
7. Backup restoration preserves revocations; plaintext-storage and remote-copy limitations are visible in setup and sharing documentation.

## People control the experience; bot accounts are prohibited

Authentication has both host-wide and per-account request limits. These bound
work, but a determined sender can still temporarily prevent sign-in by consuming
those shared budgets. The application does not treat forwarded IP headers as
trusted identity and does not implement a per-IP limiter. Internet-facing hosts
may need upstream filtering during abuse; the limits are not a denial-of-service
guarantee.

V1 prohibits bot personas, automated engagement, and impersonation. It provides no open automation tokens or public automated-posting API. Invitation-only membership, mutual acceptance, request/posting rate limits, storage quotas, and bounded behavioral checks enforce this policy. Signed server-to-server delivery is necessary transport automation, not permission to operate a bot persona. Legitimate accessibility tools must not be treated as bots merely because they assist a person.

People can report accounts and content. Circle administrators review reports, suspend abusive accounts, and provide a simple appeal route. Reports disclose only the selected evidence needed for review. Enforcement cannot depend on invasive identity-document collections, device fingerprinting, or a centralized identity database. A prohibited bot may still evade detection; the policy must be firm without claiming perfect bot-proof technology.

The feed is chronological by default. People choose friends, audiences, mute/block settings, and notification preferences. There are no advertising profiles, covert engagement experiments, or algorithmic recommendations designed to override those choices. Privacy settings explain consequences in ordinary language, show a sharing preview, and use safe defaults without making routine use feel like an administration console.
