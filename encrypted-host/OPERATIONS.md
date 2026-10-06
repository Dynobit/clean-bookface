# Operator guide

Requires Python 3, Docker Compose, and an ARM64 Docker host. This first recipe pins official Synapse 1.162.0 and PostgreSQL 17.11 ARM64 manifests in `images.json`. Do not use these ARM64 digests as an x86 qualification. Restic 0.19.1 is independently pinned in `recovery.py`. Before updates, review upstream security releases, back up, test restore and qualify the exact replacement images.

## Isolated local qualification

Use an absolute, new runtime directory outside the checkout:

```sh
python3 encrypted-host/host.py bootstrap --runtime /tmp/my-encrypted-home
python3 encrypted-host/host.py check --runtime /tmp/my-encrypted-home
python3 encrypted-host/qualify.py /tmp/my-encrypted-home
python3 encrypted-host/host.py status --runtime /tmp/my-encrypted-home
```

For disposable browser automation with many independent contexts, explicitly add `--test-rate-profile` to bootstrap. This local-only option records `testRateProfile: true` in runtime state and raises successful-account/address login capacity to a 200-request burst replenished at 10/second. Failed-login protection and all invitation/admission rules remain unchanged. Production rejects this option before creating runtime files; ordinary local and production configurations retain their original login limits. Do not treat this automation profile as rate-limit qualification.

Only `127.0.0.1:18008` is published. PostgreSQL is on an internal network with no published port. Synapse has its own Compose client network for Docker's loopback port publication; it is not an outbound firewall. Federation is disabled by an empty domain allowlist and absence of federation listener resources. No DNS, public reverse proxy, existing service, system network setting or live application is changed.

Bootstrap writes `client-config.json` with `homeserverUrl`, `serverName`, and `federationPolicy`. Point the browser SDK directly at the homeserver URL. Never route encrypted data through a decrypting application bridge.

`fictional-credentials.json` contains generated passwords for Alice, Bob and Mallory in local mode only. Do not print it, add it to source, or use it for real members. The runtime is mode 0700 and generated secrets are mode 0600. The local-only `--imported-images` option uses the verified official ARM64 imported manifest digests in `imported-images.json` when save/load converted registry manifest representation. It does not accept arbitrary image tags.

The admin account is bootstrapped through Synapse's documented shared-secret API. The secret is removed and only this new Synapse container is restarted before invitations are issued. The generated admin password remains in `admin.json`. Invitation commands log in briefly and revoke the resulting access token. Keep admin credentials away from the browser application.

```sh
python3 encrypted-host/host.py invite --runtime /tmp/my-encrypted-home
```

The command writes a one-use, one-hour invitation to private `invitation.json`; it does not print the token. Deliver it privately to the intended person. Invitations reduce uncontrolled registration; they do not prove that a person is not a bot. Rate limits remain enabled.

```sh
python3 encrypted-host/host.py stop --runtime /tmp/my-encrypted-home
python3 encrypted-host/host.py start --runtime /tmp/my-encrypted-home
python3 encrypted-host/host.py destroy-local --runtime /tmp/my-encrypted-home
```

Cleanup targets only the generated project and its volume. It deliberately retains runtime files for explicit operator deletion. `destroy-local` refuses production state.

## Production preparation

For the complete closed-home automatic HTTPS and daily-backup installation, use [SELF_HOST.md](SELF_HOST.md). The low-level preparation below remains useful for separately managed proxies.

```sh
python3 encrypted-host/host.py bootstrap \
  --mode production --runtime /srv/clean-bookface-encrypted \
  --server-name circle.example --public-url https://matrix.circle.example
```

This starts a loopback-only stack and creates no public route. Choose the permanent server name before creating real accounts: it is part of every Matrix identity. Production mode generates no fictional member accounts. Production services use Docker `restart: unless-stopped`; disposable local services use `restart: no`. This does not provide failover, backups, or permission to restart an existing installation.

A separately reviewed HTTPS proxy must forward `/_matrix/client/` and required Matrix media paths to loopback 8008's published port. Do not expose `/_synapse/admin/`, `/_matrix/federation/`, `/_matrix/key/`, or the runtime directory. Synapse `x_forwarded` is enabled only in production; the proxy must replace incoming forwarded-IP headers. The explicit Cloudflare loopback transport may use validated CF-Connecting-IP from its trusted local tunnel; see SELF_HOST.md for that narrow trust boundary. TLS, hostname verification, request limits, storage quotas, admission UX, recovery, monitoring and independent security review remain deployment gates. No existing project proxy configuration should be silently extended.

For optional cross-home friendships, follow [the explicit peer federation recipe](FEDERATION.md). It adds only the selected peer identities and federation listener. Production HTTPS routing, discovery, abuse controls and browser encrypted delivery still require qualification on the selected installations. Do not remove the allowlist or repurpose existing v0.1 routes to make a test pass.

## Encrypted backups and standby drill

Supply a strong restic password in a private mode-0600 file outside source and outside the backup repository. The tool never generates a production recovery password or prints it. Choose a local repository directory or an explicitly configured SFTP destination on a second host. Neither option creates a provider account or provisions another host.

```sh
python3 encrypted-host/recovery.py backup --runtime /tmp/my-encrypted-home \
  --repository /path/to/backup-repository --password-file /path/to/restic-password
```

Recovery commands hold a nonblocking exclusive `.recovery-operation.lock` in the private runtime directory (mode 0600) before any service change. A concurrent command against the same runtime fails immediately; the file stays in place so contenders always lock the same inode. Restore also locks its new destination before copying state or starting its services. This serializes these recovery commands, not arbitrary Docker commands or a separate host operator's manual service actions.

The command handles SIGTERM by unwinding normal cleanup and resuming a previously running primary unless `--leave-stopped` was selected. A termination arriving during resume is deferred until the resume/readiness attempt finishes. SIGKILL, power loss, Docker failure and host failure cannot guarantee cleanup; check service health after interruption. Runtime locks are released when the process exits, but the presence of the lock file alone does not mean a lock is held.

Backup records whether this Synapse instance was running, stops only that instance, captures PostgreSQL with `pg_dump -Fc`, and copies media, signing key and configuration consistently. A `finally` block restores the prior running state after capture, including copy/dump failures. The primary resumes before the potentially slow restic upload and full-data verification. An already stopped primary stays stopped. An explicit `--leave-stopped` keeps a running primary stopped for a restore drill, including failures; it is not the routine-backup default. Failure to restart/readiness-check is reported as failure. Process termination, power loss or Docker failure can prevent cleanup, so check service health after an interrupted run. Account credentials and metadata are sensitive and are inside the encrypted snapshot; they are not plaintext sidecar exports. Temporary plaintext staging is mode 0700 and removed when the command exits normally, including exceptions. Host disk encryption is still recommended because process termination or filesystem remnants cannot be securely erased by this tool.

For a disposable local primary, first run the backup command with `--leave-stopped`; then, while it remains stopped:

```sh
python3 encrypted-host/recovery.py restore-local --runtime /tmp/my-encrypted-home \
  --repository /path/to/backup-repository --password-file /path/to/restic-password \
  --destination /tmp/my-encrypted-standby --port 18009
python3 encrypted-host/host.py check --runtime /tmp/my-encrypted-standby
```

The restore creates a new Compose project and empty PostgreSQL volume, preserves the server identity, restores the custom dump, and clears `e2e_one_time_keys_json` before Synapse starts. Backups also exclude that table's data: restoring already-used one-time keys can cause decryption failures. A real standby takeover requires fencing the old primary, restoring the canonical HTTPS identity, checking member login and encrypted event/media delivery with trusted clients, and an explicit routing switch. This script deliberately automates only the same-machine local drill. Never run two writers under the same server identity. Stop the standby before resuming the primary. Data since the snapshot can be lost; recovery time and backup age determine the outage and loss window.

## Optional second host over SFTP

Use an existing dedicated backup account with storage allowance and SFTP access. Obtain and verify its SSH host key independently. Prepare a mode-0700 directory outside the checkout containing **only** `id_ed25519` (mode 0600) and `known_hosts`. Never point at your normal `~/.ssh` directory. The private key must work noninteractively; no SSH agent, password prompt or interactive key unlock is available. For a nonstandard port, the known-host entry must use `[backup.example]:PORT`.

The tool mounts this dedicated directory read-only, ignores all SSH config files, requires `StrictHostKeyChecking=yes`, uses only the explicit key, disables agent forwarding and other forwarding, and refuses extra files or symlinks. It does not accept a caller-provided `ProxyCommand`. The SFTP restic container uses Docker's normal bridge network; local repository operations use `--network none`. This does not mutate the host's network settings.

Initialize the chosen repository once, explicitly; this command does not stop Synapse:

```sh
python3 encrypted-host/recovery.py init-repository --runtime /srv/clean-bookface-encrypted \
  --sftp-host backup.example --sftp-user circle-backup --sftp-path /backups/circle \
  --ssh-directory /secure/circle-backup-ssh --password-file /secure/restic-password
```

Then run routine backup with the same destination:

```sh
python3 encrypted-host/recovery.py backup --runtime /srv/clean-bookface-encrypted \
  --sftp-host backup.example --sftp-user circle-backup --sftp-path /backups/circle \
  --ssh-directory /secure/circle-backup-ssh --password-file /secure/restic-password
```

`--sftp-port` defaults to 22. Automatic local restore drills accept these same SFTP options in place of `--repository`. The second host receives the restic-encrypted archive, not plaintext accounts or signing keys. Keep the recovery password separate from the repository and SSH directory. A writable SFTP account is not an immutable backup: credential compromise can delete snapshots, so independently protected retention is a separate host/provider requirement.

There is no automatic deletion, `forget`, pruning or retention schedule: every successful snapshot is retained until the operator deliberately removes it. Monitor free space, last-success age and restore results; full-data checks read every stored pack and can consume remote bandwidth and time. Choose a documented retention policy after measuring change volume and recoverability, and test its dry run before enabling deletion. No offsite provider, storage quota, price or account is selected here. [The self-host guide](SELF_HOST.md) supplies a repeatable daily systemd schedule and backup-health CLI. An SFTP command passing local validation is not proof of offsite recovery; actual second-host admission, transfer and restore still need qualification with the chosen account.

## Disposable SFTP qualification

`qualify_sftp.py` exercises the real SFTP adapter against a dedicated disposable container, then removes that container and its own primary/standby projects. It never starts the Mac's SSH service or uses personal SSH keys. It requires a prepared container named `cbf-sftp-qual-...`, based on cached Debian image `sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818`, with no mounts or published ports, running only `sh -c 'sleep 3600'`, and official `openssh-server` installed. Prepare packages only inside that fixture; verify downloaded packages against authenticated Debian metadata. The harness does not download packages or weaken host-key verification to repair an unavailable fixture.

```sh
python3 encrypted-host/qualify_sftp.py --runtime /tmp/sftp-recovery-proof \
  --prepared-container cbf-sftp-qual-example --port 18100
```

The new runtime must be outside source. The fixture generates its own server/client keys, restricts the backup account to internal SFTP in a chroot, tests an incorrect host key, then runs repository initialization, routine backup/full-data verification and fenced restore. It checks the signing identity and authenticated encrypted-media bytes, then decrypts that fixture media with a key never sent to the homeserver. Evidence and generated secrets remain private in the runtime after cleanup. This tests a same-machine SFTP transport and restore; physical offsite durability, provider quotas, scheduling and browser recovery remain separate checks.

## Official references

- [Synapse installation and official images](https://element-hq.github.io/synapse/latest/setup/installation.html)
- [Synapse 1.162.0 release](https://github.com/element-hq/synapse/releases/tag/v1.162.0)
- [PostgreSQL configuration and database locale](https://element-hq.github.io/synapse/latest/postgres.html)
- [Synapse configuration reference](https://element-hq.github.io/synapse/latest/usage/configuration/config_documentation.html)
- [Shared-secret admin bootstrap](https://element-hq.github.io/synapse/latest/admin_api/register_api.html)
- [Restic SFTP repository setup](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html)
- [Official backup requirements and one-time keys](https://element-hq.github.io/synapse/latest/usage/administration/backups.html)

Moderation decision receipts (`moderation-decision-<16 hex digits>.json`) are included in encrypted host backups and restored with the suspended-account database state. Keep decision reasons in those private receipts; arbitrary external reason-file paths are not collected. Symlinked receipt files make backup fail closed.
