# Project-owned Restic security build

This Linux ARM64 candidate rebuilds upstream Restic 0.19.1 with Go 1.26.8 and
published dependency fixes, then installs seven signed Alpine 3.24 security
packages. It does not change the official runtime pin or deploy an image.
The output is explicitly project-derived; it must never be published under an
upstream Restic tag or represented as an official upstream digest.

## Locked inputs and provenance

- [restic-source.json](restic-source.json) locks upstream source commit
  `6aa3a516ce654808a1f28f9fa21e9b7c8e6e90bf`, the source archive, Go archive,
  module lock hashes and the authenticated vendor-tree hash. The upstream
  annotated tag object is recorded; its GitHub verification was valid when
  selected. The builder verifies archive bytes, not a fresh tag signature.
- [restic-source.go.mod](restic-source.go.mod) and
  [restic-source.go.sum](restic-source.go.sum) contain the full resolved graph.
  No application source is patched. Changes include gRPC 1.83.2, x/text 0.41.0
  and OpenTelemetry SDK 1.45.0. Go's minimum-version selection also updates
  their dependencies; inspect the complete lock rather than assuming only
  three modules change.
- [restic-packages.json](restic-packages.json) supplies exact official Alpine
  URLs and SHA-256 values for jq, libcrypto3, libssl3, three OpenSSH packages
  and zlib 1.3.2-r1. Both recipes run `apk --no-network verify` against the
  pinned base's trusted Alpine keys before installation. No unsigned-package
  override is permitted.
- [restic-source.Dockerfile](restic-source.Dockerfile) compiles with networking
  disabled, local Go, the verified vendor tree, CGO disabled and deterministic
  path/VCS flags. Runtime entrypoint, command, user and working directory are
  checked against the exact official base. CLI version remains `0.19.1`;
  ownership is carried by the image label and receipt.

Published fix references: [Go releases](https://go.dev/doc/devel/release),
[gRPC branch fixes](https://github.com/grpc/grpc-go/security/advisories/GHSA-2v4p-qf9q-27wj),
[x/text normalization](https://pkg.go.dev/vuln/GO-2026-5970), and
[OpenTelemetry SDK](https://github.com/open-telemetry/opentelemetry-go/security/advisories/GHSA-8wmf-6v46-5gfg).

## Build

Requires Python 3.12+ and Docker with BuildKit `--iidfile` and `--metadata-file`
support. Input preparation requires native Linux ARM64. Keep all downloads,
module caches, vendor trees and receipts outside the checkout. Download each
source/toolchain URL in the source lock and each `packageOrigin` plus
`package-version.apk` in the package lock into `$RESTIC_INPUTS`; the builder
checks every byte against the lock. Cache the exact base image first.

On Linux ARM64, authenticate and prepare the locked modules once:

```sh
python3 encrypted-host/build_restic_source_image.py \
  --inputs "$RESTIC_INPUTS" --vendor "$RESTIC_VENDOR" --prepare-vendor
```

This uses the pinned Go toolchain, `proxy.golang.org`, `sum.golang.org`,
`go mod download`, `go mod verify` and `go mod vendor`. It refuses changed lock
files or a vendor tree whose digest differs from the committed manifest.
Transfer that tree without modifying it to the build machine, then:

```sh
python3 encrypted-host/build_restic_source_image.py \
  --inputs "$RESTIC_INPUTS" --vendor "$RESTIC_VENDOR" \
  --receipt "$RESTIC_RECEIPT" \
  --tag clean-bookface-restic-source-security:reviewed-candidate
python3 -m unittest discover -s encrypted-host -p 'test_*.py'
```

Compilation and APK installation use `--network=none --pull=false`. Copies
are hashed inside the private build context, including the vendor tree.
Docker's metadata config digest must equal its iidfile. Inspection and runtime
checks use only the produced immutable manifest/config references, never the
reusable output tag. Containerd manifest identity and classic Docker config
identity are supported; mismatched metadata fails closed. Receipts bind source,
recipe, packages, vendor, compiler version, image and Restic binary hashes.

The existing `build_security_image.py` remains a package-only alternative and
proves its Restic binary unchanged. It does not repair compiled Go findings;
use the source recipe for the qualification below.

## Qualification on 7 October 2026

The tested candidate image is
`sha256:d6dcbb4a09d44b6a28c842d8113916c5f8b448b4520ae74347961683e200372a`;
Restic binary SHA-256 is
`8d739497855f0ae069ec8ea59047873bb02d176f4ee49a5d1fb7133ab93ece04`.
The recorded offline build binds the source, toolchain and module inputs and
reproduced the earlier binary exactly. Keep your own build receipt with your image.

- The host Python suite passes 52 tests, including staged-input replacement,
  vendor replacement, output-tag replacement, metadata mismatch, both Docker
  image-store identities, and strict SSH host-key rejection diagnostics.
- Upstream `go test -json -p 4 -short -count=1 ./internal/... ./cmd/restic`
  under an unprivileged UID produced 1,666 passed, 38 upstream skips and four
  failures. Two failures required a missing Python fixture executable; both
  passed a targeted rerun in a cached Python-containing test image with the
  same source, vendor and compiler. Two FUSE mount tests remain unqualified:
  the disposable environment has no `/dev/fuse`. No host kernel/service change
  was made, and the upstream suite is not claimed fully passing.
- Grype 0.120.0, verified against official release checksums, used the official
  database built `2026-10-07T06:31:48Z`. The exact-image scan reports **0 Critical,
  0 High, 3 Medium, 1 Unknown**. `--fail-on medium` exits **2**, as required;
  no ignores or severity-threshold changes were used.
- Strict SFTP qualification uses a new disposable SSH server and isolated
  Synapse/Postgres data. It checks wrong-host-key rejection, real encrypted
  backup/full-data check, resumed primary, fenced restore, exact signing key,
  authenticated ciphertext bytes and fixture-key decryption. The final run
  passed all seven checks; routine
  backup 7.15 s, restore 12.54 s. This is same-machine recovery,
  not physical offsite or browser key-recovery qualification.

Remaining scan findings are three package matches for
[CVE-2025-60876](https://security.alpinelinux.org/vuln/CVE-2025-60876)
(`busybox`, `busybox-binsh`, `ssl_client` 1.37.0-r31), and
[GO-2026-5932](https://pkg.go.dev/vuln/GO-2026-5932)
(`golang.org/x/crypto` 0.55.0, Unknown severity). This database supplies no fixed
version for those matches. This is a qualified candidate with an unresolved
security gate, not a production security pass. Next acceptance requires
supported upstream fixes, fresh exact-image scanning and relevant regression
checks, plus reviewed artifact distribution/runtime identity admission before
any production promotion. FUSE mount support needs a separate capable fixture
if that optional CLI feature is required.

## Failed attempts and limits retained

Earlier 6 October temporary receipts disappeared across the day change; their
observed results are historical, not substituted for durable acceptance.
That work included a failed version-linker override, a cancelled alternative,
and an initial upstream run under root whose permission tests failed. The
selected recipe leaves upstream version semantics intact.

The 7 October regeneration retained a failed config-only Docker inspection
before the metadata-bound manifest/config correction. The first full upstream
run had the four environment failures above. SFTP dependency preparation had
two rejected shell-quoting attempts and one container DNS failure before the
ordinary signed-package download succeeded. The first zlib-candidate SFTP run
correctly rejected the bad host key but failed an overly specific log-line
assertion: Restic closed the stderr pipe after SSH's explicit changed-host-key
warning, before its final diagnostic. The harness now requires a nonzero exit
and either exact SSH key-refusal diagnostic; generic EOF is still rejected.
Its direct regression and a fresh full fixture run are retained.

The earlier six-package candidate's durable SFTP run passed all seven checks
(9.13 s routine backup, 12.02 s restore). Adding the newly published zlib fix
changed the runtime image, so the final seven-package image was scanned and
qualified again. This repeated work is counted, not presented as a first-pass
success. No candidate was deployed and no live backup repository was changed.
