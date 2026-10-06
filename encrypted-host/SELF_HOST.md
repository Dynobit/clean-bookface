# Install a private encrypted home

This recipe is for one Linux ARM64 server with Docker Engine, Compose, Python 3 and systemd. The exact Synapse/PostgreSQL ARM64 images are pinned in `images.json`; x86/AMD64 is not qualified by these pins; see [architecture support](ARCHITECTURE.md) before choosing a server. Caddy uses the existing project release digest. Allow space for the live database/media plus local backup staging and retained snapshots. Backups briefly pause this home's Synapse while capturing consistent data.

Use a dedicated server or verify ports 80 and 443 are free. Point a DNS hostname such as `matrix.circle.example` to it and permit inbound TCP 80/443 on that server. Do not expose 8008 or PostgreSQL. This guide does not modify machine routing, existing proxies or unrelated services. Obtain the reviewed source release on the server at a stable path, for example `/opt/clean-bookface`, before proceeding.

Publish the encrypted browser build independently, following [its guide](../encrypted-client/README.md), at a separate trusted origin such as `https://client.example`. The storage server must not control that client publisher or its delivery credentials. A different hostname alone does not establish independence. The storage host never serves the browser application in this recipe.

## Start the home

Run the following on the **new target server**, from the source checkout, with an operator account authorized to use Docker and create the private `/srv` runtime. Use your actual hostnames. Choose the permanent `server-name` before creating members; it becomes part of their account identifiers. Keep the generated runtime directory private. Root-run bootstrap assigns Synapse the explicit unprivileged identity `991:991` and owns only its data tree accordingly; restore reapplies that identity. Nonroot installations use the installing account’s numeric UID/GID.

```sh
python3 encrypted-host/host.py bootstrap --mode production \
  --runtime /srv/clean-bookface-encrypted \
  --server-name circle.example --public-url https://matrix.circle.example
python3 encrypted-host/operations.py prepare-https \
  --runtime /srv/clean-bookface-encrypted --client-url https://client.example
```

Preparation writes a Caddyfile, private hosting configuration and a Compose HTTPS service; it starts no proxy. Validate and then start this home's proxy:

```sh
python3 encrypted-host/operations.py validate-https --runtime /srv/clean-bookface-encrypted
```

Then run:

```sh
python3 encrypted-host/host.py start --runtime /srv/clean-bookface-encrypted
python3 encrypted-host/host.py check --runtime /srv/clean-bookface-encrypted
curl --fail https://matrix.circle.example/_matrix/client/versions
curl -i https://matrix.circle.example/_synapse/admin/v1/server_version
```

The first public request must return versions; the admin request must return **404**. Caddy obtains and renews its public certificate automatically once DNS and reachability are correct. Certificate state persists in dedicated volumes. Only Matrix client and media paths are forwarded; other paths return 404, including administration, federation and signing-key routes. Forwarded client-IP headers are replaced. Request bodies are bounded at 26 MB (Synapse's upload bound remains 25 MB). The default remains closed. For cross-home friendships, bootstrap with explicit reciprocal `--federation-peer` identities as shown in [the federation guide](FEDERATION.md). The same preparation command then exposes only the additional federation/key paths and generates HTTPS discovery on the permanent identity hostname. It refuses disagreement between runtime, client and Synapse peer policies or listener configuration. Both names must route to this proxy when the identity and storage hostname differ; neither may be the independent client origin.

The admin API remains available only through loopback for the host CLI. Do not forward that port through another public proxy. Caddy does not log access requests by default; protect Docker logs and the host as sensitive metadata. No runtime files belong in the source repository.

## Optional existing TLS tunnel

If an existing independently operated tunnel already terminates publicly trusted HTTPS, explicitly generate a restricted **loopback HTTP origin** instead of opening Caddy ports 80/443:

```sh
python3 encrypted-host/operations.py prepare-https \
  --runtime /srv/clean-bookface-encrypted --client-url https://client.example \
  --tunnel-proxy-port 18281
python3 encrypted-host/operations.py validate-https --runtime /srv/clean-bookface-encrypted
python3 encrypted-host/host.py start --runtime /srv/clean-bookface-encrypted
```

Route the exact public homeserver hostname to `http://127.0.0.1:18281` and preserve its Host header. The proxy is published only on loopback and applies the same route restrictions; never point the tunnel directly at Synapse's admin-capable loopback port. In a containerized tunnel, `127.0.0.1` must refer to the server's host network namespace; a bridge-network container needs an explicitly qualified host connection instead. The public URL stays HTTPS. The tunnel must preserve raw paths, query strings, request methods/bodies and Authorization headers, avoid API/media caching, and allow the upload limit. The origin replaces forwarded-IP headers with its actual connecting peer, so it records the local tunnel peer rather than trusting a visitor-supplied address. Multiple visitors can therefore share address-based limits.

For Cloudflare Tunnel on a dedicated Linux host, add `--cloudflare-visitor-ip` to `prepare-https`. This explicit mode uses host networking, binds Caddy only to `127.0.0.1` at the chosen proxy port, and proxies to the existing loopback Synapse port. Cloudflared must use the host network and that exact origin. It preserves Cloudflare's validated visitor address for per-address limits using only `CF-Connecting-IP` from a loopback socket peer. Caddy parses valid IPv4/IPv6 addresses; missing, malformed or list-valued headers fall back to the socket peer. `X-Forwarded-For` is never used as input. Direct HTTPS and generic tunnel modes keep overwriting untrusted forwarded headers.

This deliberately trusts Cloudflare and local processes able to connect to the loopback origin. It does not isolate hostile local users; use a dedicated host and protect local access. Never broaden trusted proxy ranges or expose this origin on a public interface. Cloudflare must overwrite its connecting-IP header and preserve the actual client address (do not enable a transform that removes it). Caddy's [trusted proxy and client-IP parsing documentation](https://caddyserver.com/docs/caddyfile/options#trusted-proxies) describes the underlying mechanism. Re-run preparation with the same flag when updating this installation; omitting it returns to generic tunnel behavior.

For federation with a separate identity hostname, route that identity hostname to the same proxy as well, preserving the appropriate Host on each request. Its exact `/.well-known/matrix/server` response delegates to the storage hostname on port 443. A single hostname self-delegates. DNS/tunnel configuration and externally trusted TLS are deployment prerequisites; the local HTTP-origin test does not prove public TLS. Configure those routes with their own rollback, then verify public versions, invitation-required registration and forbidden administration paths before admitting members.

## Invite someone

```sh
python3 encrypted-host/operations.py invite --runtime /srv/clean-bookface-encrypted
```

Privately send the contents of `/srv/clean-bookface-encrypted/invitation-link.txt` to the intended person. The link opens the independent browser, prefills the home and one-use invitation, and expires after one hour. Its token is in the URL fragment, which browsers do not send in HTTP requests. The browser removes that fragment after reading it. It remains a secret in any messaging application or clipboard used to deliver it. Members need only their browser, an account password and a saved recovery kit; no server account or terminal is needed.

## Set up verified daily backups

Create a strong recovery password in a mode-0600 file outside the runtime and repository, for example `/secure/circle-restic-password`. Keep a separate recoverable copy away from both hosts. Configure either a local repository:

```sh
python3 encrypted-host/operations.py backup-configure \
  --runtime /srv/clean-bookface-encrypted --repository /srv/circle-backups \
  --password-file /secure/circle-restic-password
```

Or use the optional second host. First prepare its dedicated SFTP account, host key and SSH directory and initialize the repository as described in [Operations](OPERATIONS.md#optional-second-host-over-sftp), then persist exactly those settings:

```sh
python3 encrypted-host/operations.py backup-configure \
  --runtime /srv/clean-bookface-encrypted \
  --sftp-host backup.example --sftp-user circle-backup --sftp-path /backups/circle \
  --ssh-directory /secure/circle-backup-ssh --password-file /secure/circle-restic-password
```

Run the same job the scheduler will execute, and check its result:

```sh
python3 encrypted-host/operations.py backup-run --runtime /srv/clean-bookface-encrypted
python3 encrypted-host/operations.py backup-health --runtime /srv/clean-bookface-encrypted
python3 encrypted-host/operations.py schedule --runtime /srv/clean-bookface-encrypted
```

`backup-health` emits machine-readable JSON and exits nonzero when no verified backup exists, the last attempt failed/is incomplete, or the snapshot is older than 25 hours. Override the age threshold with `--maximum-age SECONDS`. Health is bound to the exact canonical backup configuration: changing its destination or credential paths makes it unhealthy until a new backup succeeds. A configuration change during an upload also fails this comparison. `lastSuccess` advances only after the existing recovery command resumes the prior primary state, uploads and fully checks restic data. `snapshotStarted` conservatively measures data age from the start of that successful attempt. A fresh successful backup is not proof of restoration; perform the recovery drill too. Private diagnostics are in `backup-last.log`. Direct `recovery.py` runs do not update this scheduler health record.

The schedule command prints a unique unit name such as `cbf-e2ee-0123456789-backup` and writes its service/timer into the runtime. On the target Linux server, replace the example name below with that exact printed name:

```sh
sudo install -m 0644 /srv/clean-bookface-encrypted/cbf-e2ee-0123456789-backup.service /etc/systemd/system/
sudo install -m 0644 /srv/clean-bookface-encrypted/cbf-e2ee-0123456789-backup.timer /etc/systemd/system/
sudo systemd-analyze verify /etc/systemd/system/cbf-e2ee-0123456789-backup.service /etc/systemd/system/cbf-e2ee-0123456789-backup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now cbf-e2ee-0123456789-backup.timer
sudo systemctl list-timers cbf-e2ee-0123456789-backup.timer
```

The timer runs daily at 03:00 local time with up to 15 minutes of jitter; `Persistent=true` catches a missed run after shutdown. Reinstalling the generated units is repeatable. The service runs as root to use the system Docker daemon; its configuration contains only paths, never password contents. Secure the stable source path and runtime against untrusted writes. For rootless Docker, this system service recipe needs a separately qualified user service/daemon context.

To change destination, rerun `backup-configure`, perform `backup-run`, and check health. To remove scheduling, disable this exact timer and remove its two unit files; do not delete snapshots or change unrelated services. All dated snapshots are retained: monitor repository capacity and adopt/test an explicit retention policy before any pruning. A writable second-host account cannot protect snapshots against deletion by someone holding that account's credentials.

## Restore and acceptance

Follow the [fenced recovery procedure](OPERATIONS.md#encrypted-backups-and-standby-drill). The automatic restore command is a disposable local drill, not an automatic production takeover. Keep the former primary stopped before switching the permanent public identity to a restored host. Confirm signing identity, login, encrypted media and clean-browser recovery before allowing normal use. Public routing takeover, real offsite failure domains, storage quotas and restoration time require checks on the selected servers.

The local proxy test validates real TLS and denied routes using a test certificate, not public ACME issuance. A separate physical ARM64 Linux pair has passed actual SFTP backup/restoration, systemd service dispatch and persistent-timer catch-up after a missed event. This did not reboot either machine or test a geographic disaster. Repeat installation/readback checks on your selected hosts. See [qualification](QUALIFICATION.md) for measured scope.

References: [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https), [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy), [systemd timer semantics](https://github.com/systemd/systemd/blob/main/man/systemd.timer.xml).

## Reports, no-bot policy and appeals

Publish a human contact address through the independent client publisher/invitation channel before inviting members. Explain that automated accounts and abusive behavior are prohibited, that reports are manually reviewed, how to appeal and how long selected evidence is retained. Invitations and rate limits restrict admission and volume; they do not prove humanity. Do not request identity documents by default or promise perfect bot detection.

The client's reporting action deliberately discloses only the member-selected evidence and reason. Treat it as sensitive and untrusted: read it as plain text, do not execute markup or open attachments automatically, corroborate account/event identity, and record a proportionate decision. Reports do not grant the administrator archive-decryption keys.

```sh
python3 encrypted-host/moderation.py reports --runtime /srv/clean-bookface-encrypted
```

Review private `moderation-reports.json`. It contains up to 100 reports; if it has `next_token`, pass that value as `--offset` to retrieve the next page. Create a private mode-0600 decision file outside source, then explicitly name the local account:

```sh
python3 encrypted-host/moderation.py suspend --runtime /srv/clean-bookface-encrypted \
  --user-id '@member:circle.example' --reason-file /secure/review-decision.txt
```

Suspension blocks messages, invites, joins and profile changes while preserving the account. It does not delete copies or prevent reading previously accessible content. The CLI refuses nonexistent accounts, remote users and administrators, verifies the changed state, and saves a private receipt. Review an appeal through the published human contact and use `unsuspend` with a fresh reason file to reverse the decision. Administrator sessions are logged out after each operation. Neither reports nor decision text is printed into ordinary command output. Choose an explicit retention period for the private reports and receipts; the encrypted database backup also retains report data until its snapshots expire.

API reference: [Synapse reversible account suspension](https://element-hq.github.io/synapse/latest/admin_api/user_admin_api.html#suspendunsuspend-account), [reported events](https://element-hq.github.io/synapse/latest/admin_api/event_reports.html).
