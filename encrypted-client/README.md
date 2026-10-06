# The encrypted browser client

Your home stores encrypted memories. Your browser opens them. A separate, trusted publisher supplies the browser app, so the storage operator does not also control the code handling your keys.

This is the next-release preview, on `privacy-next`. Independent human security, accessibility and usability reviews remain open. Use fictional accounts while release qualification finishes. The existing v0.1 app is not end-to-end encrypted and is not upgraded automatically.

**[Start here: a guide for people](../docs/ENCRYPTED_GETTING_STARTED.md)** · **[Host a home](../encrypted-host/SELF_HOST.md)** · **[What has been tested](QUALIFICATION.md)**

## What you can do

- Join through a single-use invitation, save a recovery kit and recover in a clean browser.
- Import Facebook JSON ZIPs or a v0.1 account export privately. Larger Facebook downloads are saved in resumable encrypted parts.
- Browse and search saved imports in the browser, then download your own copies.
- Verify a friend, share selected text and photos, comment and react. Each friend has a separate conversation.
- Retry a failed post or comment after reloading the same browser, without duplicating the accepted action.
- Remove shared copies, block an account, report only evidence you choose, sign out and close an account.
- Recover the storage home from an encrypted backup on a second host. This is recovery, not two simultaneous writable servers.

Imports do not publish anything. Original messages and friend-list records cannot be shared. Shared photos lose original filenames and embedded metadata. Unsupported shared media is refused.

## Keep these limits clear

Someone who can replace this app can steal secrets before encryption. The app publisher and delivery service remain trusted. Serving this app from the storage operator's own server does not keep that operator out of your memories.

Homes still see account names, memberships, timing and file sizes. They can withhold data or return old history. Recipients can keep copies. Reports reveal the text deliberately selected by the reporting person. Account closure ends access and requests profile erasure; it does not guarantee removal of every event, media file or backup.

Waiting changes belong to the browser that created them. Keep that browser until they finish or you explicitly stop retrying. They are not a portable account-wide outbox. Keep the recovery kit separately from server backups: either one alone is insufficient to recover everything.

The streaming importer bounds input, decompression and retained batches. Current guard limits are 10 GiB input/expanded ZIP bytes, 64 selected files and 64 MiB per original attachment. Portable and legacy formats retain their own smaller bounds. A guard limit is not a browser capacity claim; see the measured qualification before choosing a workload.

## Try a fictional circle locally

1. Use a current browser with WebCrypto Ed25519, WebAssembly, IndexedDB and Web Locks, and Node within `package.json`'s supported range.
2. Follow [the host instructions](../encrypted-host/OPERATIONS.md) to start a disposable home outside the repository.
3. In this directory, run `npm ci --ignore-scripts` and `npm run dev`.
4. Open the printed address, enter the home and a fictional account, or use a one-time invitation. Save the kit before importing synthetic memories.

Invitation links carry `#home=https%3A%2F%2Fhome.example.org&invite=ONE_TIME_CODE` on the trusted client URL. The browser removes the fragment before contacting the home. Never put invitation or recovery secrets in query strings, screenshots or GitHub.

## Build, test and publish

Run `npm run check`, `npm test` and `npm run build`. The build includes the Rust crypto WebAssembly locally; no third-party script CDN is needed. Dependencies and test tools are declared in this package.

For browser checks, install Chromium with `npx playwright install chromium`. The root `scripts/encrypted-browser-ci.mjs` creates isolated, fictional host fixtures, builds the client and runs a named suite. It refuses repository-local runtime directories and cleans only its own resources. See `.github/workflows/ci.yml` for the suites used in CI. Standby and federation qualification remain explicit separate procedures.

Publish only `dist/` to a separate HTTPS origin. Apply `public/_headers` as real response headers; copying that file to an arbitrary web server does not configure it. Revalidate HTML and keep hashed assets immutable. Do not put runtime configuration, private records or credentials on that origin.

## The SDK boundary

Matrix SDK 43.0.0 and Rust crypto handle encryption and key backup. `signed-content.ts` also authenticates the complete purpose, sender, room and attachment descriptor with the account identity. This preserves authenticated reading after an original device is deleted; decryption alone is insufficient evidence of authorship.

The adapter pins the SDK's canonical-JSON signer and one native identity handle. It does not export private keys and fails closed if the reviewed interfaces disappear. `recipient-boundary.ts` checks the complete permitted recipient set after asynchronous member loading, before keys are shared, and discards older outbound sessions when installed. Never call the SDK's room-history-sharing API, which bypasses that boundary.

`identity.ts` gives each initial sync a fresh namespaced inline-filter field. Synapse otherwise reuses an older initial-sync response for the same filter and device, even when the SDK adds its HTTP cache buster. Incremental sync filters and authentication are preserved. This integration has a real reload/recovery regression test.

SDK upgrades need renewed recipient, forged-backup, historical-recovery and reload tests. Automated review and upstream library audits do not substitute for an independent human review of this integration. [Encryption contract](../docs/ENCRYPTION.md).
