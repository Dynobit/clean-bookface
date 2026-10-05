# Earlier prototype review

Reviewed on 2026-10-02. The earlier Clean Bookface prototype was a local Electron browser wrapper with a Chromium extension, request filtering, a classic renderer, an export importer, and local storage experiments. Its own `npm run check` passed during review. That result establishes its existing checks passed; it does not establish a working hosted social network.

The new product is an independent archive and social app. The old browser wrapper remains separate. This repository contains planning documents only; no prototype source or private working files have been copied into it.

| Component in the prototype | Useful material | Required change |
| --- | --- | --- |
| `src/main/facebook-export-importer.js` | Export classification, timestamp helpers, synthetic examples | Correct identity and encoding; preserve complete content; link/copy media; bound resource use; report unsupported input |
| `src/main/archive-sqlite-store.js` | Transactions, search and snapshot patterns | Owner-scoped tables, migrations, authorized queries, import jobs, files and publications |
| `src/shared/old-ux-model.js` | Concept of normalized local objects | Separate original record identity, owner identity, occurrence time, import time and publication time |
| `src/renderer/` | Familiar visual proportions and navigation | Web views independent of Electron, accessible mobile layout, ordinary social controls |
| Container scaffold | Non-root process, read-only application files, dropped capabilities | Actual authenticated web application, persistent storage, deploy/restore lifecycle |
| Existing tests | Synthetic samples and selected unit assertions | Behavioral import, privacy, sharing, federation, failure and recovery tests |

Confirmed blockers to carrying the old implementation forward unchanged:

1. The vault's default twelve-month post/message retention rejects older imports. The new archive must keep imported history unless its owner explicitly deletes it.
2. The entity ID omits relevant source identity: equal-text posts on different dates collide; some messages in different conversations collide. Re-import stability and preservation of distinct records both need tests.
3. Blanket Latin-1 to UTF-8 conversion corrupts already-correct Unicode, including accented text, Hebrew and emoji. Encoding repair must be narrowly justified by input evidence.
4. Media files become text descriptions. They are not durable, authenticated photo/video attachments. Posts with attachments but no text can disappear entirely.
5. Original post dates are placed in a display field while storage uses import/capture time. Chronological history needs a real occurrence timestamp.
6. Text limits and the basic HTML parser silently truncate or collapse content. JSON is the first supported format; unsupported formats must produce a clear explanation instead of a success claim.
7. The default vault secret is derived from predictable username/platform material. It must not become the new app's encryption key.
8. The SQLite schema has no user ownership/access model. Working SQLite files are plaintext even though an encrypted backup feature exists.
9. The hosted scaffold serves health/status responses only. There are no implemented hosted accounts, friend relationships or content-sharing endpoints.

The migration task is selective reuse with regression fixtures. Browser login machinery, request filters, signed filter packs, extension installers, screenshots and machine-specific deployment scripts are outside the new application's runtime.

Existing fixture assertions that expect lossy behavior must change. Old green tests cannot serve as the release acceptance contract for the new product.
