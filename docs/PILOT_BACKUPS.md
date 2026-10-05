# Daily off-host backups for the donated pilot

This is an operator setup, not a member task. `deploy/pilot-backup.mjs` uses the existing offline backup CLI and guarded pilot controller. It stops only the dedicated pilot, captures an encrypted restic snapshot and encrypted reconciliation ledger, and restarts through the existing deadline checks if the pilot was previously running. It then copies ciphertext to a second host. Expect a short maintenance window; capture time depends on stored media.

The wrapper has failure-path tests and observed synthetic sender/receiver qualification, including restricted transfer and fresh-volume recovery; see [release evidence](RELEASE.md). **Qualify your installation before enabling its timer.** Existing evidence does not establish that a different host, SSH restriction, schedule or final dashboard-only revision has been tested.

## Prepare the two hosts

Use the existing `clean-bookface-pilot` project and its exact `clean-bookface-pilot_app_data` volume. The private pilot environment must be a root-owned mode-0600 file under protected root-owned directories and retain its reviewed image digest and original launch, export-only and end timestamps. The controller, compose file and Node executable must already be installed and qualified. This wrapper does not install or change them.

On the sender, prepare a dedicated directory ending in `clean-bookface-pilot-backup`, owned by root, mode 0700, outside the checkout. Its parent directories must also be root-owned, without group/other write access or symlinks. Create only its `repository/` child with uid/gid 1000 and mode 0700. The container never mounts the control root or host receipt directories. Reserve enough space for the pilot's 25 GiB archive allowance, historical changes, and backup staging. Keep it separate from other workloads' storage allocation. Do not enable unattended capture without a quota or monitored capacity limit on both hosts.

Follow [OPERATIONS.md](OPERATIONS.md#prepare-encrypted-backups) to generate two independent recovery passwords. Put `restic-password` and `recovery-password` in a separate **root-owned directory, mode 0700**, with root-owned, non-writable ancestors. The two files are uid-1000-owned, mode 0600; the private parent prevents host uid 1000 from traversing to them. The wrapper mounts only those two files read-only into a container explicitly running as `1000:1000`. It does not mount the secret directory. The SSH key and known-hosts file must be root-owned, mode 0600, outside both the recovery-secret directory and backup root. It initializes its dedicated restic repository on first capture. Keep an offline copy of both passwords separately from all ciphertext copies. Neither passwords nor transport keys belong in Git.

On the receiver, provision a dedicated SSH user with no general shell access and an empty restricted directory on the large data filesystem (for example `/srv/backups/clean-bookface-pilot-backup`, not the system disk). Restrict the backup public key with a forced `rrsync` command to that exact directory, with forwarding and PTY disabled:

```text
restrict,command="/usr/bin/rrsync /srv/backups/clean-bookface-pilot-backup" ssh-ed25519 PUBLIC_KEY
```

Use the actual path of the distribution's reviewed `rrsync` helper. It must allow both reading and writing inside that directory: verification reads a completion receipt back. The key grants access to that subtree; it is not protection against a compromised sender deleting copies. Keep an independent offline copy if that threat matters.

Use patched distribution packages for rsync and its matching rrsync helper on both hosts, with rsync at least 3.2.3 (`--mkpath` support). Do not combine an arbitrary upstream helper with an older binary. The [official rrsync implementation](https://raw.githubusercontent.com/RsyncProject/rsync/master/support/rrsync) treats a leading slash in `--link-dest` as the restricted root; this wrapper uses `/current/repository`. Verify that behavior, readback, and symlink publication with the installed versions during the drill.

Pin the receiver's SSH host key in a dedicated `known_hosts` file through a trusted channel. Store it and the sender's transport private key outside Git, root-owned mode 0600, under protected root-owned directories. The wrapper uses batch mode, strict host-key checking, and no ambient SSH configuration. No Mac networking changes are needed.

## Private configuration and schedule

Create a root-owned mode-0600 JSON file outside the checkout. These are example paths and a reserved hostname:

```json
{
  "projectDir": "/opt/clean-bookface",
  "pilotEnvFile": "/etc/clean-bookface/pilot.env",
  "backupRoot": "/srv/backups/clean-bookface-pilot-backup",
  "secretsDir": "/etc/clean-bookface/recovery",
  "sshKeyFile": "/etc/clean-bookface/backup-key",
  "knownHostsFile": "/etc/clean-bookface/backup-known-hosts",
  "remoteUser": "bookfacebackup",
  "remoteHost": "backup.example",
  "alertMode": "dashboard-only"
}
```

This pilot explicitly uses `dashboard-only`: no external notification unit is required and no `OnFailure` hook is generated. The private operator dashboard must show recent attempts, failures and backup age. This choice does not deliver email, push messages or off-host alerts. Without an explicit `alertMode`, the existing default remains `external-unit` and requires a tested `failureUnit`; the two modes cannot be combined.

Use your reviewed Node 24 executable (shown here at `/opt/clean-bookface/tools/node`). The generated service and child processes reuse that exact executable, and controller calls pass it through `--node`; no global Node installation is needed. Print the exact proposed service and timer on the target host without changing it:

```sh
sudo /opt/clean-bookface/tools/node -- /opt/clean-bookface/deploy/pilot-backup.mjs plan \
  --config /etc/clean-bookface/backup.json
```

Review and install those two unit texts as `clean-bookface-pilot-backup.service` and `.timer` under `/etc/systemd/system/`. After the guarded host change and successful manual qualification, reload systemd and enable that timer. It runs daily at 06:15 UTC plus up to five minutes of jitter, with `Persistent=true` for missed runs. Only `external-unit` mode adds an `OnFailure` hook. The root-owned oneshot uses a nonblocking `flock` lock, sanitized subprocess environments, and a four-hour time limit. Application backup containers are capped at one CPU and 2 GiB; transfer is capped at 10 MiB/s. No general Docker access is granted to the application.

Run the first qualification explicitly:

```sh
sudo /opt/clean-bookface/tools/node -- /opt/clean-bookface/deploy/pilot-backup.mjs run \
  --config /etc/clean-bookface/backup.json --apply
```

Only `run --apply` changes state. An expired pilot skips; the timer cannot change its dates or extend hosting. A partly running pilot fails for investigation. An installation already stopped stays stopped. Capture failures attempt guarded restart of a previously running installation, while transfer failures occur after restart. If capture crosses the fixed deadline, it never starts the app afterward. An interrupted process or stale installation lock needs operator investigation; there is no automatic unlock or assumption that a process died.

The offline transition also takes the controller's exact `/run/clean-bookface-pilot/lifecycle.lock` before reading whether the pilot is running. Concurrent controller starts and stops wait until capture and guarded resume finish; the transfer then releases this lifecycle lock while retaining the separate `/run/clean-bookface-pilot/backup.lock`. The controller creates and validates that root-owned mode-0700 runtime directory and private regular lock files; it does not use the conventionally shared `/run/lock` directory. A successful concurrent stop therefore cannot be undone by an old remembered running state.

An external stop first atomically records a UUID in the fixed root-private `/run/clean-bookface-pilot-stop-intent`, before waiting for the lifecycle lock. Only a later explicit start acknowledges the observed UUID in `/run/clean-bookface-pilot-stop-ack`. Backup's internal maintenance start never acknowledges a stop. A pending stop at admission or a new request during capture suppresses automatic restart; if one arrives during restart, backup stops internally before releasing its lock. Unreadable intent state also disables automatic resume. These files contain no credentials and are not configurable through environment variables. If intent recording fails (for example, runtime storage becomes read-only), the controller still attempts scoped shutdown and reports both outcomes as a failure; investigate rather than assuming a queued stop was recorded.

The controller can still report a five-minute lock-wait timeout during a long capture, but its recorded stop request remains effective: backup leaves the application stopped. The deadline service retries failed stops after 30 seconds, with the same bounded wait and fixed target. An explicit later start is allowed through the usual preflight and deadline checks. The systemd four-hour limit terminates the service's entire control group; command-line flock wrappers have no separate kill timer that could release a lock while leaving their child running.

## Upgrade and interruption recovery

The hardened layout is a migration, not an in-place permission tweak while a
backup runs. An older installation may still have a uid-1000-owned control root
and directory-wide secret mount. Do not install this revision or enable its
timer against that layout. Under the host's guarded maintenance procedure:
pause the backup timer, verify no backup service or backup container is active,
record a rollback snapshot and stop intent, then prepare a new root-private
control root with its dedicated uid-1000 repository child. Inspect every old
entry without following links before copying reviewed repository data. Preserve
old encrypted generations unchanged. Move transport credentials outside the
recovery-secret directory, install the reviewed scripts and generated units,
and run the synthetic transfer and fresh-volume restore drill before resuming
the timer. Re-read owner, mode and ancestor checks on the actual host. These
local code tests do not prove that an existing installation has been migrated.

A hard kill, host crash or service timeout during capture may leave the pilot
offline and a Docker backup container alive. There is deliberately no blind
`ExecStopPost` restart. Inspect the exact `bookface-pilot-backup-*` container's
image, volume mounts and running state against the private attempt receipt;
do not remove containers merely because their names share a prefix. Confirm
that no capture process or container is using the application volume before
recovering an instance lock through the documented [operations procedure](OPERATIONS.md).
Never force-unlock an active volume. Preserve the recorded stop intent: an
operator shutdown or expired deadline must remain stopped. Only an explicit
operator restart, through the controller's preflight and unchanged dates, may
resume a previously interrupted pilot. Verify health and the next completed
off-host receipt; dashboard-only operation requires someone to do this.

The daily wrapper skips captures at or after `PILOT_ENDS_AT`. Its last scheduled
backup therefore cannot attest to deletions made later in the final day.
After verified closure, keep the app stopped and use the ordinary offline
backup and reconciliation-export commands from [Operations](OPERATIONS.md) to
capture the final surviving state. Transfer and verify that final encrypted
snapshot and current ledger through the qualified receiver procedure before
retention or erasure work. Do not reopen hosting or change dates to obtain this
capture, and do not claim a final capture until its readback and restore checks
succeed. If the final local volume is lost first, the last scheduled recovery
point is the actual limit.

## What counts as success

Every attempt uses a new `generations/TIMESTAMP-ID` directory on the receiver. Unchanged restic files can share hard links with the previous generation. After copying, checksum dry runs compare both the repository and encrypted ledger against their sources. `--delete` appears only in those dry runs to detect unexpected extra files; it never performs deletion.

The wrapper publishes `complete.json`, switches the relative `current` symlink, then reads `current/complete.json` back and compares it exactly. Only then does it atomically write sender-side `last-offhost-success.json`. Failed transfers and verification leave earlier generations intact; failed readback does not record success. The sender also atomically writes and fsyncs `last-offhost-attempt.json`: format `clean-bookface-offhost-attempt/1`, `startedAt`, status (`running`, `succeeded`, `failed`, or `skipped`), optional `finishedAt`, and a generation only after success. It contains no subprocess output, secrets or filenames. A skipped run is not a successful backup. An interrupted process may leave `running`; the dashboard must combine this with systemd state and flag a stale attempt beyond the four-hour service bound. Errors before configuration or receipt storage is usable remain visible through systemd. Inspect the service exit status and that receipt's `verifiedAt`, not merely the timer's presence. The application's Settings backup timestamp records local capture, not confirmed off-host transfer.

In dashboard-only mode, show a freshness warning if `capturedAt` is older than 26 hours, plus the last attempt and systemd outcome. Use capture time for recovery freshness: a delayed transfer can make `verifiedAt` much newer than the captured data. There is no external alert if the operator does not open the dashboard or the host is offline. Daily scheduling aims for a 24-hour recovery point, not zero loss. A surviving reconciliation ledger cannot establish deletions made after it was captured.

No retention or pruning is automatic in this wrapper. The conservative pilot policy retains completed generations through the fixed `PILOT_ENDS_AT` plus a **30-day recovery grace period**. Hosting still stops at `PILOT_ENDS_AT`; the grace period is only for encrypted storage and recovery. At the grace deadline, the operator reviews final exports, surviving recovery copies and deletion obligations, then performs an explicit deletion of the dedicated pilot copies. No job performs an irreversible purge, and storage policy never extends hosting. Tell members this retention policy before they join; deletion from the app does not immediately remove prior encrypted copies. The generic app retention command does not remove these independent generations.

For the initial 25-account, 1-GiB-per-account pilot, allow at least 25 GiB for active archives, additional working space for capture, and a separate history budget on both backup hosts. A conservative initial planning allowance is **100 GiB per backup location**, with at least **25 GiB additional sender staging headroom**; this is a planning budget, not a configured quota or a guarantee that changing data will fit. Verify actual storage allocation before enabling the schedule. Review usage daily in the private dashboard, warn at 80% of the agreed allocation and treat 90% or insufficient staging headroom as requiring operator action. Pause new admissions/imports or add capacity before exhaustion; do not automatically delete the last good backup. Historical churn can exceed this allowance even when current account data stays below 25 GiB. Quota enforcement and capacity thresholds must be configured for the actual filesystem; this wrapper does not install them.

For acceptance, run the installed service against synthetic content, verify the remote receipt, then restore from the receiver into a fresh isolated volume using the separately held secrets and [reconciliation procedure](OPERATIONS.md). Check a private media hash, revoked-recipient denial, deleted content, invalidated old sessions, and the pre-reconciliation sharing gate. Also prove an unreachable receiver fails visibly while the original pilot resumes, and confirm the dashboard shows failure without replacing the previous success. If using external-unit mode, separately confirm notification delivery. Preserve receipts outside Git and remove only the synthetic resources created for the drill.
