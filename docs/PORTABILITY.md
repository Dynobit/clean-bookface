# Take your memories with you

The **Export my account** button downloads a ZIP you can keep or import on another
Clean Bookface host. Treat this download as private: it contains your archive,
including imported messages, and is not encrypted. Store it somewhere you trust.

Wait for imports to finish before exporting, and avoid editing or deleting data
while the download runs. A member export streams live records and files; it is
not a consistent backup snapshot. Concurrent changes can produce a mixed view or
interrupt the download, in which case download a fresh copy. Cancelling a
download or stopping the host closes its export streams and database iterators.

Create an account on the new host, open **Archive**, and upload the ZIP through the
same import form used for a Facebook export. An extracted export folder also
works. The import runs as a background job and reports completion or an error.

Everything arrives in your private archive. Your posts, photos, albums, messages
and original source dates stay private. Posts and comments you wrote on Clean
Bookface become clearly labelled private copies; comments are treated as private
messages and cannot be shared through the archive's share action. Historical
archive revisions become separate private memories labelled with their version.
Current records retain their source identity, so importing the same export again
does not duplicate them. Original media bytes are preserved. A previously shared
photo becomes private again and needs a fresh sharing action before anyone else
can see it.

The import does not recreate an account, password, recovery code, session,
administrator role, signing key, invitation, friendship, or audience grant.
Your identity on the new host has a new address. Tell your friends that address,
verify one another, accept new requests, and deliberately choose what to share.
Imported friend records from a Facebook archive are private memories, never
automatic friend requests. Existing copies on the old host do not move or
disappear automatically; delete that account separately when you are ready.

This is a member's portable export. Restoring an entire host, including its
identity and encrypted operator backups, is a separate procedure documented in
[Operations](OPERATIONS.md).

## The portable format

The outer ZIP contains exactly two files:

- `account.json`, with format `clean-bookface-account/1`: your profile, authored
  publications and comments, and account export information. Import reads only
  authored content and its provenance; permissions and account settings are not
  applied.
- `private-archive.zip`, with format `clean-bookface-archive/1`: `manifest.json`,
  `archive.ndjson`, `revisions.ndjson`, and media referenced by the manifest.

A standalone `private-archive.zip` can also be imported. Its records preserve
literal Unicode and full text; the importer does not fetch links found in them.
Known structured credential fields are discarded from record metadata. Ordinary
prose is preserved as written, so check your own content before sharing it.

Media must match the manifest's exact filename, byte count and SHA-256 checksum.
The normal media validator still applies. A missing, changed, invalid or unsafe
referenced file fails the portable import without committing partial records.
Traversal paths, symlinks, unexpected files and further nested ZIPs are rejected.
Only the explicitly named inner archive may be expanded. Its files and expanded
bytes share the outer archive's limits, alongside the regular record, per-file,
time and account storage limits. Export does not bypass a smaller destination
host's import allowance; ask that host's operator to review the limits if a
large export cannot fit.

The roundtrip, media integrity, repeated import, owner isolation, malformed
manifest and combined archive limits are exercised in
[`tests/portable.test.ts`](../tests/portable.test.ts), starting with the actual
HTTP account export handler.
