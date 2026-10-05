# Private sharing between circles

Clean Bookface connects people who deliberately exchange a profile link or enable handle lookup. There is no global feed, public follower list, relay, contact upload, or shared inbox. A person on your friend's server gets no access just by being on that server.

Federation is optional. Set `FEDERATION_ENABLED=true` only with a stable HTTPS origin on port 443 and after reading the [privacy contract](PRIVACY.md). A restored installation keeps sharing off until deletion and revocation state has been reconciled. Turning federation on does not publish an imported archive.

This is **Clean Bookface private-sharing profile v1**, not a promise of compatibility with Mastodon, Threads, or arbitrary ActivityPub software. Peers must implement this profile exactly. An incompatible or unreachable peer leaves a delivery pending; it never causes public delivery.

## The wire contract

The profile identifier is `https://github.com/Dynobit/clean-bookface#private-v1`. JSON activities use the ActivityStreams context and an inline `cb` namespace, with `cb:profile` set to that identifier and a positive integer `cb:revision`. Dynamic JSON-LD contexts and additional document loads are prohibited. Fedify 2.4 supplies RSA HTTP message signing and verification; the application supplies authorization, bounded networking, protocol validation and the durable ledger.

Each person has their own RSA-2048 signing key. Keys are generated from the system cryptographic random source, stored in the private database, and included only in operator disaster recovery. They are never part of a member export. SQLite is plaintext while the service runs; this is not end-to-end encryption.

| Endpoint | Access |
| --- | --- |
| `GET /users/{username}` | Minimal public key bootstrap: stable actor URL, username, inbox URL and key. No real name, biography, archive, roster, avatar or counts. |
| `GET /.well-known/webfinger?resource=acct:name@host` | Resolves exactly one handle only after that account opts in. No directory or enumeration endpoint. |
| `POST /users/{username}/inbox` | Actor-signed, recipient-specific activity. No shared inbox. |
| `GET /federation/objects/{id}` | Signature from the exact authorized account and a current saved grant. |
| `GET /federation/media/{id}` | Same current grant; shared WebP derivative only, never an archive original. |

Bootstrap keys are the deliberate public exception. Making keys available avoids recursive authentication deadlocks and does not give a server-level identity permission to read a person's posts. Account deletion and suspension retain minimal signing identity while removal deliveries need it.

Requests use Fedify's RFC 9421 RSA signature form. This profile requires the exact default covered components: method, complete target URI, authority, host, date, and body content digest for POST. It accepts one `sig1` signature, requires creation within five minutes, and checks expiry. It does not fall back to an unsigned or legacy signature. An actor's document ID, key ID, key owner and inbox must all match the requested actor exactly. A valid signature alone does not establish friendship or object authority.

The only allowed inbox audience is `to: [thisRecipientActor]`. `cc`, `bcc`, `bto` and separate audience fields are rejected. A Note repeats only that same singleton recipient. The sender creates one envelope per recipient, so delivery never exposes the other recipient identities.

## Consent and content

`Follow` is a friendship request, not an automatic subscription. `Accept` refers to the exact original Follow URL and is valid only while that request remains pending and unexpired. Rejection, cancellation and blocking confer no access. Accepting a new friend does not send older posts.

Posts are plain-text Notes with explicit authorship, original publication time, edit time, revision and at most twelve shared image attachments. Imports, message conversations, source archive IDs, source paths and imported names never enter these Notes. Remote photo URLs must belong to the author's host. Browsers receive images through the local authorized route; they do not contact a friend's host directly. The local route verifies permission, makes a bounded signed fetch, validates the image, and serves a safe representation.

`Create` establishes a publication grant for one recipient. `Update` changes an existing grant's representation without expanding its audience. When a post is edited while the recipient has never acknowledged its initial delivery, the transport can send the latest snapshot as its initial `Create`. That choice is persisted with the delivery, so a lost acknowledgement cannot change the same activity's body on retry. The original application audience snapshot still decides who is eligible. A revoked grant's tombstone rejects all late creates and updates.

Comments are Notes with `inReplyTo`. A remote participant sends an interaction to the post's home server. That server checks the parent grant and author, then distributes it only to the parent audience. On redistribution, the home server signs the envelope while the comment retains its author's identity. Like redistribution similarly carries `cb:interactionActor` and an exact `cb:interactionId`. This authority is valid only for the post's home actor, never an arbitrary intermediary. A third person on the recipient's host remains excluded by the local account grant.

`Delete` removes an authored post or comment. Recipient revocation uses `Remove` with the exact object and recipient target. Relationship removal uses `Remove` with `cb:relationship: true` and the exact original Follow in `cb:relationshipId`; a delayed removal cannot tear down a newer friendship. Blocking does not send a special human-facing block announcement. `Undo` refers to the exact Follow or Like being undone. Liking again creates a fresh interaction identity. Old activities cannot reverse a removal.

## Delivery, retries and deletion

Core records publication changes and domain events in the same SQLite transaction. The federation worker reconciles those events into its own delivery ledger, using a persistent cursor so an offline peer cannot monopolize discovery of new work. It leases each attempt, signs it, rechecks the current grant immediately before sending, and records acknowledgement transactionally. A process that dies after leasing recovers when the lease expires. A peer that received a request before its acknowledgement was lost receives the same activity again.

The federation component records schema version 1 and refuses to run against a newer schema. Restore the matching application release rather than running an older binary on a newer database.

The receiver stores activity ID, intended recipient, actor and body hash in the same transaction as application changes. Exact duplicates are harmless. Reusing an activity ID with a different body or actor is rejected. Per-object revisions and deletion/grant/interaction tombstones prevent older events from resurrecting removed content.

Retries start at five seconds and back off to six hours. Failed deliveries are retained, with minimal status and attempts, rather than discarded after a fixed count. The server worker keeps draining them; an operator can inspect pending versus delivered state. `2xx` means the compatible recipient accepted the operation. It is not proof that a hostile host erased every copy.

Revocation denies origin reads immediately, cancels pending content and requests remote removal. A recipient may have already saved a copy or may operate an incompatible or malicious server. The product cannot guarantee remote erasure. Encrypted backups also retain older snapshots until the operator's retention policy expires.

## Host moderation

An administrator can block an exact peer hostname in Host tools. The policy persists across restarts and applies to incoming signature verification, discovery, outgoing activity delivery, and signed object/media fetches. Subdomains are separate hosts; there is no hidden wildcard rule. Blocking never makes a private post public.

A host block stops network contact, including pending removal requests. Those requests remain in the ledger and retry after the administrator unblocks the host. Existing locally cached posts are not silently erased by this network policy; account-level blocking and publication revocation remain separate controls. The UI describes that boundary. No remote block list, reputation provider or identity-document service is consulted.

## Network and resource limits

Production federation uses a dedicated HTTPS transport. It rejects credentials in URLs, nonstandard ports, redirects, compressed responses, loopback/private/link-local/metadata addresses, multicast, reserved ranges, IPv4-mapped private IPv6 and mixed public/private DNS answers. It resolves the host once, checks every answer, and pins the socket to a checked address while TLS still authenticates the original hostname. That closes the gap between a DNS check and a later socket lookup.

DNS lookup has a five-second deadline. Network requests and inbox body reads have ten-second deadlines. Documents are limited to 256 KiB, fetched media to 8 MiB, and text posts to 20,000 characters. The transport admits at most eight concurrent federation handlers and enforces bounded per-minute request rates; the application also limits interaction bursts and invitations. No environment setting disables these protections. Tests inject their own transport mapping reserved example hosts to temporary local TLS servers.

No tracing exporter, analytics client or remote telemetry endpoint is configured. Avoid adding logging that serializes activities, signatures, key material, private media URLs or request bodies.

## Verification and operational scope

`npm test` includes two independent HTTPS servers with fresh temporary test certificates and synthetic accounts Alice, Bob and Charlie. Tests exercise real HTTP signature generation, TLS requests, inbox routing and SQLite state, including:

- Explicit mutual acceptance and selective text/photo sharing; Bob is allowed while Charlie on the same host is denied.
- Newly accepted friends denied old posts; exact audience envelopes; anonymous object denial and recipient-specific media fetch.
- Edits, comments, likes, exact Undo and deletion through the transport.
- Offline publication followed by an edit, lost acknowledgements, transport restart, complete SQLite reopen, leased-job recovery and stale replay after revocation.
- Old relationship removal and Undo after a new friendship; account deletion retains only the signing identity needed to finish removal.
- Administrator peer blocking, pending-removal resumption, persistence and future schema rejection.
- Forged and expired signatures, actor/key-owner substitution, changed content under one activity ID, extra recipients, excessive body size, hostile URL forms and the restore sharing gate.
- Mixed public/private DNS rejection and a socket lookup pinned to the sole checked DNS resolution.
- Two actual application servers behind simulated TLS termination: a correctly signed inbox request succeeds without browser CSRF or Accept headers, while ordinary browser mutations still require origin/CSRF controls.

These are automated synthetic proofs. They do not constitute an independent security audit, a real-user usability study, a measured production capacity result, or a guarantee that every third-party peer behaves correctly. Keep a first deployment invitation-only, back it up, prove restoration, and preserve the documented plaintext-hosting trust boundary.

Protocol references: [ActivityPub](https://www.w3.org/TR/activitypub/), [HTTP message signatures](https://www.rfc-editor.org/rfc/rfc9421), [Fedify signature API](https://jsr.io/@fedify/fedify/doc/sig), [Fedify authorized fetch](https://fedify.dev/manual/access-control).
