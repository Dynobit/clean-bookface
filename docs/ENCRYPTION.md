# The encrypted browser version

Status: development on `privacy-next`. The live v0.1 preview does not provide end-to-end encryption. Its existing host-access disclosure still applies.

## What people should experience

Open a friend’s invitation, choose an account, and save a recovery kit. The browser takes care of encryption. Bringing an archive remains private; sharing a post is a separate choice. A friend’s server stores encrypted copies and never receives the content keys.

This depends on using a trusted copy of the browser application delivered independently of the storage host. The client publisher and its delivery service remain trusted. A host that can replace the client code can steal secrets before encryption; moving the same JavaScript into a same-host PWA would not fix that.

## Decisions

- Use the maintained Matrix JavaScript SDK and its Rust crypto implementation for device identities, verified sharing and encrypted key backup. Do not invent an encrypted ActivityPub protocol. A library audit does not establish that our integration is safe.
- Deliver the browser client separately from the homeserver. The client renders typed data as text; it never executes HTML or configuration supplied by the storage host.
- Parse imports, prepare photos, search, decrypt and export in the client. Encrypt filenames, thumbnails, text and archive provenance before upload. No plaintext fallback to v0.1 endpoints.
- Keep archives in a private encrypted channel. Share separate copies through verified pairwise channels so recipients do not receive an audience roster. A new friendship receives no archive or earlier keys.
- Verify friends’ identities through a trusted existing channel. New or changed identities must stop sharing until checked. A server-supplied public key alone is not proof of a friend’s identity.
- Sign the complete, room-bound content envelope with the verified account identity. A deleted device must not make old memories unreadable, and a copied device certificate must not authenticate a forged backup. The narrowly pinned SDK adapter and standard Matrix signed-JSON verification require explicit review and adversarial acceptance.
- Keep login recovery separate from content recovery. A server password reset cannot unlock an archive. A verified existing device or the user’s recovery kit is needed. Explain this once, plainly, before a large import.
- Support one active homeserver first. An optional second host keeps an encrypted backup for recovery. It is not a second simultaneous writer and does not imply zero downtime.

The extra hosting components are a deliberate choice approved for the full encrypted browser experience. The existing small v0.1 installation remains available while the successor is built and tested.

## Two hosts and reliability

A recoverable installation needs its database, media, server configuration and signing identity, with backup secrets kept separately. A second machine should be in a different failure domain; two containers on the same machine do not protect against losing that machine. Restore into an isolated target, verify content and identity, and ensure the former primary cannot also accept writes before transferring service. Measure the age of the latest recoverable copy and the actual restoration time.

Replication alone is not a backup: it can reproduce a deletion or corruption. Keep dated encrypted snapshots with a documented retention period and exercise recovery. Member content keys remain with clients; server disaster recovery and a member’s recovery kit solve different problems.

There is no torrent, public peer-discovery or IPFS dependency. Public BitTorrent discovery exposes participating peer addresses and requires peers to remain available. It does not supply private account recovery, moderation or reliable deletion. Adding it would not close the current privacy or recovery gap.

## Migration

Do not rewrite or remove an existing archive in place. Download through the existing authenticated export path, encrypt a copy in the trusted client, compare record counts, exact text and original-media hashes, and prove recovery from a clean client before changing the account’s normal destination. Interrupted migrations must resume without duplicate sharing.

Data already uploaded in plaintext was already accessible to the old host. Encryption cannot change that history. Old databases, write-ahead logs, exports, staging files, backups and recipients’ copies need separate retention and removal handling.

Imports are immutable encrypted batches, reconciled by stable record identity. Two browsers must retain both sets of additions; conflicting versions remain available rather than silently choosing a winner. A text-publication retry currently persists in an encrypted outbox on its originating browser. Moving an unfinished outbox to another device remains an integration task.

## Acceptance before release

1. A fresh browser can accept an invitation, create an account, save and verify recovery, import a synthetic archive and share one item with a verified friend.
2. A third account cannot decrypt that item. Server databases, files, backups, jobs, logs, HTTP requests and notifications contain none of the planted plaintext content markers.
3. Hostile device additions, identity substitution, encryption downgrade, injected markup and replay do not cause key disclosure or plaintext delivery.
4. A clean browser restores using the legitimate recovery kit and encrypted server data. Resetting the server password alone cannot restore content.
5. Interrupted imports, uploads, delivery and migration resume without missing records, duplicate publication or plaintext fallback.
6. A revoked friend gets no keys for later content. Already received copies remain outside the sender’s control; a hostile server can also withhold updates.
7. An isolated second installation recovers the same server identity and encrypted media from the backup, with measured data-loss window and restoration time.
8. Five people unfamiliar with the project complete the ordinary flow without a terminal or an explanation of cryptographic terms. This is an outstanding human study, not an automated-test claim.

Hosts can still observe account identifiers, traffic timing, object sizes and delivery relationships. They can withhold data or return older state; this client does not prove that the host supplied the latest complete history. A server restore also restores relationships as of its snapshot, so newer removals need reconciliation before normal sharing resumes. Recipients can copy shared content. An abuse report deliberately reveals only the evidence selected by the reporting person. No claim of complete anonymity or guaranteed erasure follows from content encryption.

## Measured progress

The [browser qualification record](../encrypted-client/QUALIFICATION.md) covers invitations, recovery after device deletion, selected sharing between separate homes, large encrypted media and a restored standby. The [host qualification record](../encrypted-host/QUALIFICATION.md) separates local protocol and backup proofs from untested production routes. These are development results; the public preview keeps its existing host-access disclosure.

## Technical references

- [Matrix SDK encryption integration](https://github.com/matrix-org/matrix-js-sdk#end-to-end-encryption-support)
- [Matrix client-server specification and encrypted key backups](https://spec.matrix.org/latest/client-server-api/#server-side-key-backups)
- [Published Vodozemac audit](https://matrix.org/blog/2022/05/16/independent-public-audit-of-vodozemac-a-native-rust-reference-implementation-of-matrix-end-to-end-encryption/)
- [Synapse backup and restore](https://element-hq.github.io/synapse/latest/usage/administration/backups.html)
- [BitTorrent peer discovery](https://www.bittorrent.org/beps/bep_0005.html)
