# Building patched hosting images

These tools are for maintainers testing security updates. The normal installer still uses the reviewed official image pins. These optional builds do not change a running home or make the preview ready for personal archives.

| Component | What the build changes                                                                                            | Instructions                          |
| --------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Caddy     | Updates signed Alpine libraries while preserving the Caddy executable and settings.                               | [Caddy build and tests](CADDY.md)     |
| Synapse   | Updates pinned Python libraries and signed Debian security packages while preserving Synapse and its interpreter. | [Synapse build and tests](SYNAPSE.md) |
| Restic    | Rebuilds the same upstream release with patched Go dependencies and the pinned operating-system updates.          | [Restic build and tests](RESTIC.md)   |

Each guide names its exact inputs, tests and remaining findings. Download packages into private storage outside the checkout. Keep the build receipt with the resulting image. The builders check the bytes copied into their isolated build context and bind their checks to the resulting image's immutable ID, so a reused tag cannot silently change the artifact described by a receipt.

These are **project-owned derivatives**, not new official releases from their upstream projects. A successful build is only one step: scan that exact image, run the relevant disposable-host tests, and keep the failed attempts and remaining findings in the record. Current candidates still fail the unchanged Medium-or-higher advisory check. Do not hide findings or describe a package update as a complete security fix.

Installing a candidate in a home is a separate change. Follow the [host upgrade checklist](../../docs/ENCRYPTED_DEPENDENCY_UPGRADES.md#host-image-upgrade): retain a verified backup, review the exact artifact and source, qualify recovery, and record the deployment and rollback result. Do not replace production pins with a mutable local tag or silently pass a locally imported image off as a registry release.
