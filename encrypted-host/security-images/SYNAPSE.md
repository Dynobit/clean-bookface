# Owned Synapse Python security layer

This optional ARM64 layer retains Synapse 1.162.0, its source tree and startup script, the Python executable, and runtime configuration. It upgrades only five Python packages: cryptography 50.0.2, Twisted 26.4.0, Tornado 6.5.10, urllib3 2.8.0 and pyOpenSSL 26.4.0. The pyOpenSSL update is required for compatibility with the selected cryptography version. No Synapse or cryptography compatibility patch is included.

`Synapse` remains licensed as identified by the upstream image. This derivative is project-owned, not an official Element image. Production image pins are unchanged; building does not publish or deploy it.

Download the exact wheel URLs listed in `synapse-wheels.json` to private storage, then run:

```sh
python3 encrypted-host/build_synapse_security_image.py \
  --wheels /private/path/wheels \
  --receipt /private/path/synapse-build-receipt.json \
  --tag clean-bookface-synapse-security:1.162.0-python20261006
```

The default requires the canonical image reference in the lock. `--local-imported-base` explicitly permits the separately qualified imported image representation for disposable local qualification. Its receipt retains both identities and marks the import; it does not equate the imported digest with a registry digest. A local imported-base result is not a distributed production artifact.

The builder verifies wheel size and SHA-256, checks the copied build inputs again, and installs offline with `--no-index --no-deps --require-hashes` and Docker networking disabled. `pip check` must pass. Docker's private `--iidfile` must match BuildKit's configuration digest; the associated immutable manifest digest binds subsequent checks to the built image rather than a reusable tag. The receipt records input/recipe hashes, source/Python/entrypoint hashes and the built identity. Output digests can vary; preserve the actual receipt.

Qualification on 6 October 2026 passed a disposable install/import compatibility probe, dependency consistency, unchanged Synapse/Python/entrypoint/runtime checks, and five real browser journey tests: clean-browser recovery, private import and verified sharing, invitation onboarding, large encrypted photos, and unsigned-device key refusal. Existing disposable host tests passed consumed/expired invitation refusals, closed discovery, resource containment, failed-backup recovery, staged restore, signing identity, restored login, media hash verification and synthetic retention. Native Synapse TLS federation tests also passed; they exercise the updated Twisted/OpenSSL stack without a replacement TLS implementation. Browser and host tests used only fictional data and an exact candidate identity in a private copy's local image map, with independent dependency directories. These results do not qualify every browser suite, reciprocal browser federation, restored-standby browser exports, systemd, remote SFTP or a production target.

The exact exported candidate filesystem was scanned with Grype 0.120.0 and its valid 6 October database, without suppressions. It contained 25 Critical, 134 High, 114 Medium, 38 Low and 91 Negligible package-advisory matches; the prior exact image had 25 Critical, 143 High and 117 Medium. No Python-package matches remained. The medium threshold still fails because Debian, interpreter/binary and other embedded dependencies remain outside this layer. The Docker image archive scan failed on imported layer tar headers; scanning the exported container filesystem succeeded and identified Debian 13.7. A failed archive scan was not treated as a clean result.

Repeat the existing host, browser, federation and recovery acceptance against any changed inputs before admission. Keep unresolved OS/interpreter findings visible; do not suppress them, remove packages to hide matches, switch distributions, or treat this source candidate as deployment authorization.

References: [cryptography 50.0.2](https://pypi.org/project/cryptography/50.0.2/), [Twisted 26.4.0](https://pypi.org/project/Twisted/26.4.0/), [Tornado 6.5.10](https://pypi.org/project/tornado/6.5.10/), [urllib3 2.8.0](https://pypi.org/project/urllib3/2.8.0/), [pyOpenSSL 26.4.0](https://pypi.org/project/pyOpenSSL/26.4.0/), [Synapse 1.162.0](https://github.com/element-hq/synapse/releases/tag/v1.162.0).

## Supported Debian security layer

The optional `build_synapse_debian_security_image.py` adds only four signed Trixie security updates over the reviewed Python-layer receipt: `libpcre2-8-0` `10.46-1~deb13u3`, and `libssl3t64`, `openssl`, `openssl-provider-legacy` `3.5.7-1~deb13u3`. It preserves the existing Debian distribution, Python executable, Synapse source, startup script and runtime configuration. This is a separate project-owned derivative; neither builder changes production pins.

Fetch the two metadata files and four packages named in `synapse-debian.json` from their exact repository paths into a private directory using their listed filenames. The lock binds their SHA-256 bytes. The build presents them as a local repository and uses the existing image's Debian archive keyring. APT verifies the signed InRelease, its package-index checksums and package hashes; signature/date/expiry checks remain enabled. Docker networking is disabled and this small layer always builds with `--no-cache`, so every invocation repeats APT signature and expiry checks even when an older successful layer exists. APT may upgrade only the four exact versions; post-build package readback rejects unexpected additions, removals or version changes. Expired metadata must be refreshed through a newly reviewed lock, never by disabling expiry checks.

```sh
python3 encrypted-host/build_synapse_debian_security_image.py \
  --packages /private/path/debian-inputs \
  --parent-receipt /private/path/synapse-build-receipt.json \
  --receipt /private/path/synapse-debian-build-receipt.json \
  --tag clean-bookface-synapse-debian-security:1.162.0-trixie20261007
```

The parent receipt must bind the reviewed Python wheel lock and immutable owned image. The actual five installed Python package versions are read back before and after the Debian layer and must match that lock. The builder snapshots source/receipt bytes, checks copied inputs, binds BuildKit's configuration and manifest digests, and records exact package changes. It does not turn a local imported parent into a registry-published artifact.

On 7 October 2026 the actual offline build and dependency/source/runtime identity checks passed. The original signed repository metadata verified using the base image's keyring, and tampered metadata was rejected. Grype 0.120.0 with its 7 October database reported 25 Critical, 113 High, 89 Medium, 18 Low and 91 Negligible matches in the exact new filesystem; none matched the four updated packages. The medium threshold still fails. Unresolved Debian/interpreter/embedded dependencies remain outside this bounded layer; no distribution migration, interpreter replacement or speculative curl/glibc patch is included.

The Debian-layer artifact `sha256:725f101652100351e3adec4fbe86675706bd52ce250fe420f12b423520263c01` passed all five browser journey tests with zero skips/failures/flakes, eleven native Synapse TLS federation checks, closed-admission checks, and the disposable host backup/restore/containment/retention suite. These checks verified signing identity, restored login, media hashes, failure/resume behavior and retention from eleven snapshots to seven. Five builder tests passed, including a warm-cache/expired-metadata refusal and a matching-identity parent with stale Python packages. An actual uncached build passed; a separate real APT check rejected signed metadata under a stricter one-second maximum age without changing the host clock. Initial tooling attempts failed because the signature verifier required an explicit output argument and Docker interpreted a bare image ID as a repository name; both were corrected and their subsequent actual checks passed. The existing broader production and browser qualification limits above remain.

The final uncached builder produced `sha256:5912da046244fed8f8b85256de3f4c94bc71b1a0ea91a68f42579887d6e00386`. Its actual build, installed-package checks and expiry-refusal proof passed. Independent comparison of all 15,720 filesystem entries found identical application, library, configuration and package-database contents; only three installer logs and the auxiliary `ldconfig` cache differed, with timestamps excluded from the comparison. Browser, federation, restore and scan evidence remains attached to `725f101…` and is reused on that equivalence basis. Those suites were not rerun on `5912da…`; neither artifact passed the advisory gate.

Official source: [Debian Trixie security repository](https://security.debian.org/debian-security/dists/trixie-security/).
