# Encrypted version: what has actually been tested

Development evidence, 5 October 2026. This is a separate successor to the public v0.1 preview. It has not replaced the website or an existing installation, and is not ready for personal archives.

## Browser and recovery

The built client ran in isolated Chrome contexts on macOS, using its supplied security headers. The storage fixtures were real Synapse 1.162.0 and PostgreSQL 17.11 ARM64 containers. All accounts, pictures and memories were fictional. Browser recovery kits stayed outside the repository and outside server backups.

The complete ordinary browser run passed five journeys:

- Save a recovery kit and reopen the same account in a clean browser.
- Import privately, compare a friend's identity in two browsers, share selected text, and recover the original archive after signing out and deleting the original device.
- Create an account through a single-use invitation, save its first memory, and recover it in a clean browser.
- Import a valid photo larger than 35 MiB through encrypted pieces of at most 8 MiB under the real home's 25 MiB upload limit. Download the archive and compare the original photo's SHA-256 exactly.
- Refuse key delivery to an unsigned device; preserve a failed publication through reload; explicitly cancel it and sign out. Leaving an unopened recovery screen also works without possessing its kit.

A separate two-home browser journey passed: invitation, acceptance, real matching identity comparison, selected text and photo delivery, and absence of private memories at the recipient. The decoded shared photo had the expected dimensions and pixel values. These were separate homes with separate database and signing identities, on one Docker machine. Container-only test certificates and discovery do not qualify public DNS, HTTPS delegation or an offsite installation.

The final combined browser run passed **seven journeys**: the five ordinary flows, separate-home sharing and concurrent first imports. The standby journey is intentionally conditional in that suite. It was run separately against the restored installation and passed; a skipped standby test in the ordinary run is not evidence of recovery.

A forced first-import race also passed: two verified browsers waited at a request barrier, then created two separate archive rooms. Both browsers recovered both memories, and both complete exports retained their exact IDs and text. An initial test clicked download while refresh was still busy and timed out; it now waits for completion. The application also makes its controls inactive during an operation instead of silently accepting a click it cannot handle yet.

## Second-host recovery

The source fixture held approximately 106 MiB of encrypted content. A stopped-primary capture, encrypted restic backup and full-data check took **6.81 seconds**. A new Compose project with an empty database restored in **19.91 seconds**. The standby and primary never served the same identity simultaneously.

All 20 encrypted media files matched byte for byte by SHA-256, and the server signing identity matched. A fresh browser, supplied with the member's separately retained recovery kit, opened signed memories and the large photos and exported a valid archive. Server backup alone does not recover a lost member key.

These are measurements of one local synthetic fixture. They do not promise an outage duration, continuous availability, offsite protection or a recoverable backup age. Actual strict-host-key SFTP backup and restore also passed a separate local transport fixture. A second machine in another failure domain, a backup schedule and a tested production takeover are still needed for those claims. See [host qualification](../encrypted-host/QUALIFICATION.md).

## Privacy and adversarial checks

The final unit and integration suite passed **61 tests with zero skips**, alongside TypeScript, the built client and formatting checks. It exercises bounded archive parsing, encrypted chunk validation, signed content, hostile membership changes, conflict preservation, recovery and key-backup coverage. Tests use the installed Matrix SDK and Rust crypto where the property depends on those implementations.

- A paused SDK recipient-selection operation rejects an injected third member before any room key is sent. This uses the real SDK queue with a transport spy; it is not a complete malicious-homeserver exercise with three verified browsers.
- A fabricated backup encrypted with the public backup key still cannot forge the account's signed content envelope. This uses real crypto, but does not inject the forged session through a live Synapse recovery.
- An isolated Rust machine proves that an earlier backed-up ratchet covers a later local key. Later, unrelated, malformed and mismatched keys are rejected. The live device's key store is not modified by this comparison.
- Independent automated review found recipient-selection races, recovered-sender authentication gaps, conflict handling and recovery-availability defects. Fixes and regression tests are included; this is not an independent human cryptographic audit.
- A 49,000-record archive plus 2,000 new records is refused before upload when the combined limit is known. Concurrent overflow instead produces a clearly partial, bounded view with every authenticated saved batch available separately. Byte limits and slow downloads receive the same availability treatment. Authentication failures still reject; they are never treated as harmless time limits. This is functional regression evidence, not a browser capacity benchmark.

Planted plaintext content markers were absent from the fixture's entire PostgreSQL dump, captured Synapse logs and server files. The scan covered approximately 110 MB of server files. It did not establish that every possible HTTP capture, notification path, crash dump or deployment log is safe. Hosts still see account identifiers, membership, traffic timing and sizes.

The production dependency entries were checked against npm's official bulk-advisory service: 17 packages, zero returned advisory packages. The local `npm audit` request failed at its network endpoint; a separate existing route performed the lock-derived lookup. That is an advisory check, not proof of dependency security. A later correction declared the browser test tools in this package; all 17 production entries stayed identical. Current lock SHA-256: `e5e9de9cf2900e56c948e84ec0cb1e5ea97e387baa9520271ca8a089166e6e57`.

GitHub's clean runner exposed those missing test dependencies, which had been available through the parent checkout locally. After declaring exact Playwright and sharp development dependencies, an isolated checkout without parent `node_modules` passed a fresh install, TypeScript, all 61 tests and the build. Its ten built files matched the browser-tested files byte for byte. The first isolated fixture omitted the repository's synthetic archive fixture; correcting that snapshot resolved its one failed test. No application behavior or production dependency changed in this packaging correction.

## Limits and failures

The client publisher and its delivery service remain trusted. An operator who can replace the browser app can steal secrets before encryption. Recipients can keep copies. Encryption does not hide the social graph from the homeserver or guarantee erasure.

The preview has bounded, memory-backed imports, not an unlimited streaming importer. Comments, reactions, account deletion, moderation, complete migration and a portable account-wide outbox still need integration. Human security and accessibility reviews, the five-person usability study, production routes and capacity qualification are unfinished. See [release acceptance](../docs/ENCRYPTION.md).

Failed attempts were counted and corrected: development-server reloads disrupted early tests, so qualification now serves an immutable built snapshot; repeated test logins reached production rate limits, so only disposable fixtures use an explicit test profile; room-version-12 creator permissions and fresh-room crypto timing required integration fixes. A browser test attempted a blob fetch forbidden by the actual CSP; it now verifies the real archive download instead. Neither the CSP nor production admission limits was weakened to make a test pass.
