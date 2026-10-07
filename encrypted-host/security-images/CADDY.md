# Owned Caddy security layer

This optional ARM64 candidate retains the official Caddy 2.11.7 executable and Alpine 3.23 base. The existing scan's nine High matches came from OS libraries, not Caddy's Go dependencies. Recompiling Caddy would not remove them. The recipe upgrades `libcrypto3` and `libssl3` to signed Alpine `3.5.9-r0` packages and zlib to `1.3.2-r1`, with exact SHA-256 inputs in `caddy-packages.json`. It does not change production pins or publish/deploy an image.

Download each `<package>-<version>.apk` from the manifest's `packageOrigin` into private storage. Cache the exact base image, then run:

```sh
python3 encrypted-host/build_caddy_security_image.py \
  --packages /private/path/packages \
  --receipt /private/path/caddy-build-receipt.json \
  --tag clean-bookface-caddy-security:2.11.7-openssl3.5.9-zlib1.3.2-r1
python3 encrypted-host/qualify_caddy_security_image.py --image sha256:<actual-built-image-id>
```

The builder checks package hashes, Alpine signatures offline, ARM64, unchanged Caddy binary and runtime configuration. Its receipt identifies the artifact as `project-derived-not-official`. Preserve the receipt and scan the exact exported filesystem with the project's current scanner/database and unchanged medium threshold. Build output digests can vary; read back the actual artifact identity. This is a project-owned derivative, never an official Caddy release.

On 6 October 2026 the candidate passed seven existing disposable proxy modes (155 route, forwarding and TLS checks), unchanged module enumeration, capability/memory/PID/log/loopback readback, trusted TLS, untrusted-CA refusal and certificate/CA persistence across container replacement. The private CA was confined to temporary test files and named disposable volumes; no machine trust store was changed. This does not qualify external ACME issuance/renewal, unattended systemd operation or a production installation.

Grype 0.120.0 with its 6 October database found zero Critical, one High and four Medium package-advisory matches, reduced from zero Critical, nine High and fourteen Medium. That candidate still failed the medium threshold. Its remaining matches were zlib `CVE-2026-85091`, nghttp2 `CVE-2026-58055`, and BusyBox `CVE-2025-60876` across three packages. At that check Alpine 3.23 listed the installed zlib `1.3.2-r0`, nghttp2 `1.69.0-r0` and BusyBox `1.37.0-r30`; its security database provided no fixed version for these findings. No suppression, package removal or speculative source patch is included. Source review, explicit artifact distribution/pin integration and the full deployment acceptance remain separate.

On 7 October 2026 the Alpine 3.23 package index provided signed zlib `1.3.2-r1`. The updated three-package candidate passed offline signature checks and retained the exact Caddy binary and runtime configuration. Grype 0.120.0 with the 7 October database reported zero Critical, zero High and four Medium matches. The remaining nghttp2 and BusyBox findings still have no fixed version in that database, and the official Alpine 3.23 ARM64 package index still supplies their installed versions. The medium threshold continues to fail; no findings were suppressed. All seven proxy modes (155 checks), module comparison, containment readback, trusted/untrusted TLS and persistent certificate/CA checks passed again against this new exact artifact; six builder tests passed. The earlier candidate and its dated evidence remain separate.

References: [Alpine OpenSSL package](https://pkgs.alpinelinux.org/package/v3.23/main/aarch64/openssl), [OpenSSL vulnerabilities](https://openssl-library.org/news/vulnerabilities/index.html), [Alpine security database](https://secdb.alpinelinux.org/v3.23/main.json), [zlib package](https://pkgs.alpinelinux.org/package/v3.23/main/aarch64/zlib), [nghttp2 package](https://pkgs.alpinelinux.org/package/v3.23/main/aarch64/nghttp2-libs), [BusyBox package](https://pkgs.alpinelinux.org/package/v3.23/main/aarch64/busybox).
