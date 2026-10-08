# Five starter tasks

These are task briefs, not claims of completed testing or assigned volunteers. Check [open issues](https://github.com/Dynobit/clean-bookface/issues) for an existing copy before starting. Comment there to coordinate. Each heading and its text can be used as an issue title and body.

Use fictional data only. Never post personal archives, real-account screenshots, credentials, invitations, private hostnames or raw production logs. A report may record a failure; passing evidence must come from work actually performed. Sample-book tasks depend on the entry point in the [README](../README.md) being available; record the build or commit, not just the URL.

## Review the sample book with keyboard and a screen reader

**Task:** Follow the README's sample-book entry point using only a keyboard, then one screen reader you already use. Open the fictional sample, move among its available views, and reach local-import controls without selecting personal files. No server setup is required for the published sample.

**Acceptance:** Report browser, OS and assistive-tool versions; the tested build; steps attempted; visible focus, control names and reading order; and any trapped or unreachable control. Distinguish keyboard-only results from screen-reader results. A keyboard-only contribution is welcome, but leave the screen-reader portion explicitly unverified. File one reproducible issue per finding, or record the exact journey that passed. Use only fictional screenshots and sanitized notes. This is a bounded review, not an accessibility certification.

## Check local import in one browser using a fictional archive

**Task:** In one installed browser, open the fictional sample linked from the README. Choose **Export book**, then **Clear book**, then **Open my archive** and select the downloaded `clean-bookface-book.zip`. This gives you a made-up archive without needing a terminal or a personal Facebook download. The reader accepts ZIP files only; do not select a folder or loose JSON files.

**Acceptance:** Record build, browser/OS versions, selection method, import summary and whether the fictional post, photo and conversation appear as described by the UI. Try the same input again and report duplicate handling. Reload and record whether the book is retained or cleared, comparing with the stated local-book behavior. Report unsupported controls or layouts honestly; do not infer compatibility with other browsers. No member account or host is needed for the local-book path.

## Report one confusing step in the sample-book first visit

**Task:** As a first-time reader, follow the README into the fictional sample without extra explanation. Find one memory, find the local-import option without choosing private files, and explain in your own words what is local and what would require a circle. No coding or server setup is needed.

**Acceptance:** Provide the tested build, steps completed unaided, any help needed, and one confusing label or instruction with a proposed wording change (or state no confusion in the tested steps). Use only your own voluntary observations and fictional content; do not recruit or name other people for this task. Do not claim a participant study or universal usability from this one check.

## Add a synthetic unsupported archive-layout regression fixture

**Task:** Read `encrypted-client/tests/import-shapes.test.ts` and the import report behavior. Construct one tiny, previously uncovered unsupported JSON layout with made-up records. Add a behavioral test showing how the importer reports that case; keep unsupported input visible rather than silently dropping it. Discuss intended behavior in the issue before expanding parser support.

**Acceptance:** The fixture is written from scratch, contains no copied personal export data, and documents the unsupported shape and expected report outcome. The test exercises the importer and checks its observable report, not source strings. Record the exact command and result for the focused test plus the client checks required by [Contributing](../CONTRIBUTING.md). Preserve existing privacy and record-reconciliation requirements. This task does not require broad new format support.

## Verify the disposable local host recovery guide

**Task:** On an isolated disposable host you control, follow [host operations](../encrypted-host/OPERATIONS.md#encrypted-backups-and-standby-drill) for one backup and local restore using fictional accounts and content. Read the documented prerequisites first; the pinned ARM64 recipe is not an x86 qualification. Never use an existing circle, production runtime or real backup.

**Acceptance:** Record exact commit, host architecture, tool versions, commands with generic placeholder paths, and observed backup/restore outcomes. Verify the documented old-primary fencing and standby shutdown order, then check fictional member login and encrypted text/media with a trusted test client. Record missing or confusing steps and submit a focused documentation fix if warranted. Keep keys, recovery kits, credentials and raw runtime logs private. Clean up only the disposable resources you created. If hardware or prerequisites are unavailable, report that limit rather than claim a restore; this task requires real drill evidence to close.
