# The encrypted browser client

This is development work for the next release. The public v0.1 app still has the host-access limits described in the main README. Do not move a real archive into this version yet.

The browser app and the storage home have separate jobs. A trusted publisher serves this app; your chosen home stores encrypted events and files. Do not put both under the storage operator’s control and then claim that operator cannot read your memories. Someone who can replace this app can steal secrets before encryption.

## Try it with fictional accounts

Use Node 24.4 or later within the supported range in `package.json` and a current browser with WebCrypto Ed25519, WebAssembly, IndexedDB and Web Locks.

1. Follow [the host instructions](../encrypted-host/OPERATIONS.md) to start a disposable local home. Keep its runtime directory outside the repository.
2. In this directory, run `npm ci --ignore-scripts` and `npm run dev`.
3. Open the local URL printed by Vite. Enter the home’s address and one of its fictional accounts, or use a single-use invitation.
4. Save the recovery kit before opening your book. Import only synthetic ZIP files, then invite another fictional account and compare the identity check between the two browsers.

An invitation link uses `#home=https%3A%2F%2Fhome.example.org&invite=ONE_TIME_CODE` on the trusted client URL. The browser removes the fragment before contacting the home. Never put invitation or recovery secrets in query strings, screenshots or GitHub.

## What is here

- Browser-only Facebook JSON and portable-ZIP import, private archive storage, local search and download.
- Deliberate sharing through encrypted two-person rooms. Original messages and friend-list records cannot be shared.
- Photo copies prepared in the browser without original filenames or embedded metadata. Unsupported shared media is refused clearly.
- Identity comparison, recovery kits and encrypted key-backup readback before a successful import/publication is reported or a device signs out.
- Immutable archive batches so two browsers cannot silently overwrite each other’s imports. Conflicting versions are kept and labeled instead of silently choosing a winner.
- An encrypted browser outbox keeps a text post’s identity and chosen recipients through retries and reloads. It belongs to that browser; it is not yet a portable, account-wide outbox. Keep that browser until a pending post finishes.

This is not feature parity with v0.1. Comments, reactions, account deletion, moderation workflows and a complete migration journey still require integration. Cross-home invitation, identity comparison and selected text/photo sharing have passed a local two-home browser journey; public federation routes remain unqualified. Large files use encrypted pieces of at most 8 MiB, so the supplied home’s 25 MiB upload limit does not cap the whole archive at 25 MiB. Each batch remains limited to 256 MiB and 32 pieces; larger Facebook downloads need further streaming-import work. Conflicting imports preserve both versions and remain downloadable. Concurrent first imports on different devices are combined. If the archive exceeds the preview’s record or memory window, the interface says which memories are visible and offers every saved import as a separate download; it does not silently discard the remainder.

## Build and check

From this directory, run `npm ci --ignore-scripts`, then `npm run check`, `npm test`, and `npm run build`. This package declares its own development dependencies; installing the parent repository is not required. The build contains the Rust crypto WebAssembly file locally; there is no third-party script CDN.

For browser qualification, install the Playwright browser with `npx playwright install chromium` after the package install above. Set `CBF_TEST_HOST_RUNTIME` to a disposable local host runtime, then run `npm run test:e2e`. The optional host `--test-rate-profile` allows repeated correct logins for this test; production refuses that option. Browser tests refuse production runtimes and use generated fictional credentials. Recovery kits, browser output and test artifacts stay outside Git.

The browser suite serves a built snapshot on port 5175 with the supplied security headers. It does not test a development server that can reload while another person edits a file.

## Hosting the client

Publish only `dist/` to a separate static HTTPS origin after release acceptance. `public/_headers` supplies the policy for hosts that support that format. On another web server, apply equivalent HTTP headers; the file alone does not configure every provider. Keep the HTML revalidated and the hashed assets immutable. Keep credentials, runtime directories and homeserver configuration off that origin.

See [measured qualification](QUALIFICATION.md) for the browser, hostile-device and restored-standby evidence.

Read [the encryption contract and remaining acceptance](../docs/ENCRYPTION.md) before describing this build as secure or production-ready.

## The SDK adapter

Encryption and key backup use Matrix SDK 43.0.0 and Rust crypto. Content also carries a signature over its exact purpose, sender, room and attachment descriptor. That is needed to authenticate recovered content after its original device has been deleted; decrypting a backup alone is insufficient evidence of authorship.

`signed-content.ts` isolates two internal SDK operations: its existing canonical-JSON signer and a single native identity handle that supplies both verification status and the master public key. It requires the exact reviewed SDK version and fails closed if these operations disappear. Private keys are never exported by this adapter. An SDK update requires rerunning the historical-recovery, forged-backup and hostile-device tests and reviewing this boundary. This application signature integration has not received an independent human cryptographic audit.

`recipient-boundary.ts` also pins the SDK’s actual recipient-selection boundary. It checks the complete authorized set after asynchronous member loading, before key sharing, and discards any older outbound session when first installed. A verified identity is not automatically an authorized recipient. The application must not call the SDK’s room-history-sharing API, which bypasses that path.
