# Running a circle without losing its memories

The app runs as one process with one SQLite database and a private `media` directory. Keep `DATA_DIR` on local durable storage. The server and host commands use the same exclusive installation lock. Do not run two application processes against one data directory, put SQLite on a network share, or bypass the lock to make a backup finish.

The running database and media are plaintext to the host administrator. Encrypt the host's disk for protection when it is powered off. Backups below are encrypted separately. Neither measure is end-to-end encryption.

## First account

Start the application once, then run its setup command on the server:

```sh
npm run setup
# Production image: node dist/cli.js setup-token
```

The command prints the installation's one-time setup code. Paste it into the setup page and choose your account password there. Account passwords never belong in command-line arguments, shell history, a repository, or a support ticket. The setup code is removed after the first account is created. The server logs do not print it.

The account's recovery codes are shown once in the browser. Save them privately. There is no identity-document recovery service and no default administrator password.

## Prepare encrypted backups

Install restic **0.19.1 or a later reviewed compatible release** from [the official project](https://restic.net/). Container images include restic. The tests exercise an actual encrypted local repository, not a substitute encryption mock.

Generate two independent secrets in a private location outside the backup destination:

```sh
node dist/cli.js init-backup-secrets --directory /secure/bookface
export RESTIC_REPOSITORY=/backup/bookface
export RESTIC_PASSWORD_FILE=/secure/bookface/restic-password
export RECOVERY_PASSWORD_FILE=/secure/bookface/recovery-password
node dist/cli.js backup-init
```

Both files must be regular files readable only by their owner, mode `600`. Mount them read-only in a container. Restic supports remote repositories; configure the chosen provider through its documented environment variables. No provider credentials are written into this project's source. `RESTIC_BINARY` can point at a reviewed binary outside `PATH`.

Keep offline copies of both secrets, separately from the backup repository. The restic password decrypts the incremental archive. The second password decrypts the independently encrypted operator recovery bundle inside it, containing account password hashes and federation signing keys. Main backup database files have those fields removed; sessions, old invitations and account recovery-code hashes are not restored. Member downloads contain none of these operator secrets. Losing either backup password prevents complete restoration.

## Daily capture

Stop this application's process cleanly using your normal service/container controls. Do not stop unrelated services. Then run:

```sh
node dist/cli.js backup
```

Restart the application after the command completes. The CLI refuses a live installation. This first release deliberately uses an offline backup window: it holds the installation lock while SQLite, private media and restic are verified. The duration depends on the archive size and destination; no zero-downtime claim is made.

The backup copies SQLite through its online-backup API, snapshots immutable media, checks stored hashes, writes an integrity manifest, encrypts the separate recovery bundle, and submits the prepared directory to restic. Restic reuses unchanged content, so the remote transfer is incremental even though local capture checks every referenced file. A local staging directory needs room for a database copy and metadata; media uses hard links when supported and copies otherwise. Allow additional disk headroom for that fallback. Import staging and unfinished jobs are excluded; their restored reports tell members to upload again. Failure never records a successful backup time.

A successful command prints the restic snapshot ID and the application's backup ID. Settings shows the latest successful backup time. Monitor the command's exit status and that timestamp; an existing schedule is not evidence that backups are working.

Schedule this offline sequence daily using your host's normal scheduler, with failure reporting. The project does not install a scheduler on your machine. Review the output and perform a fresh-host restore drill before accepting real memories, then repeat it after upgrades or storage changes.

Use a **30-day retention policy plus the last successful snapshot**, with pruning after successful new captures:

```sh
restic forget --tag clean-bookface-v1 --group-by host,tags --keep-within 30d --keep-last 1 --prune
restic check --read-data
```

The last snapshot is intentionally retained if backups stop. Therefore deletion from the app is immediate, while removal from backup storage depends on successful retention/pruning; a stopped backup schedule does not guarantee a 30-day deletion deadline. Provider snapshots and offline copies have their own retention. The commands above require the same restic environment variables and are explicit operator actions.

## Restore or move to another machine

Keep the **same canonical `APP_ORIGIN`** and domain when moving an installation. The backup binds account actor identifiers and signing keys to that origin; restoration to an unrelated domain is refused. Pointing a domain at a new host, obtaining HTTPS, stopping the old host and starting the replacement are operator deployment steps. This application does not change DNS or machine networking.

After taking the snapshot you intend to restore, keep the original source stopped at the final cutover and export a strictly newer current-state ledger:

```sh
node dist/cli.js reconciliation-export --output /secure/bookface/current-state.enc
```

Keep this separately encrypted file private. It contains current IDs, revisions, permission and deletion state, likes, preferences, moderation reports and appeals, password hashes and signing keys. It does not copy archive or post tables, but moderation records can contain private text. Store it outside the host being replaced. The export uses a distinct authenticated `clean-bookface-ledger/2` envelope and includes the original installation identity. The backup's `recovery.enc` contains backup-time credentials; it is not a current ledger and cannot unlock a restore. A paused restored instance cannot export a current ledger.

On the replacement host, configure the original `APP_ORIGIN`, repository and both password files. Restore into a completely empty directory:

```sh
node dist/cli.js restore --target /data/bookface-restored --snapshot SNAPSHOT_ID
```

The command refuses to overwrite existing data. It verifies every manifest hash, database integrity, origin and recovery-bundle authentication before installing data. Failed restores remove partial output. The original data directory is untouched. Federation keys and account password hashes are recovered; existing sessions, invitation links, old recovery codes and in-flight uploads are invalidated.

**A restored instance blocks all account, archive, media and sharing routes until current deletion and revocation state is reconciled.** Stop the restored process if you started it for inspection, and apply the freshest independently retained state ledger:

```sh
DATA_DIR=/data/bookface-restored node dist/cli.js reconcile --ledger /secure/bookface/current-state.enc
```

Reconciliation compares the restored snapshot with the current ledger. It removes since-deleted accounts, archive records, posts, comments, retracted likes and media; reapplies suspensions, account and peer-host blocks, tombstones and revoked recipients; restores current administrator permissions, preferences, password hashes and signing keys; and cancels stale outbound content jobs. Pending removal events are retained and queued again, so an offline peer can still receive deletion/revocation requests. It retains only grants and friendships consistent with the newer state. If a record changed after the selected backup, its old version is removed rather than exposing text that the owner later edited away. The new content must come from a newer data backup. This is a deliberate privacy consequence of choosing an older snapshot.

The ledger timestamp must be strictly later than the selected backup, and its canonical origin and persisted installation identity must match. Equal timestamps, invalid dates, legacy ledgers, backup recovery bundles and a fresh installation at the same domain are rejected before reconciliation. Current backup/export commands create the random installation identity on the original source before capture; it survives in the database snapshot. The CLI cannot prove that a file is the final state of a destroyed machine. Do not use an old ledger to assert that newer deletions never happened. If newer deletion state is unavailable, leave the restored instance closed while the operator reconstructs and reviews it; there is no unconditional enable-sharing command. Recovery after a disaster can lose changes since the last surviving capture. Remote recipients may already have copies that a restored server cannot erase.

Older backups without an installation identity can still restore into a closed instance, but cannot safely reconcile with this version. Their existing bytes are preserved; this is an explicit compatibility limit, not evidence that the old backup is corrupt. Before accepting an upgrade, use the reviewed backup command on the stopped original source to create a new identity-bound backup, export a newer ledger, and complete a real restore/reconciliation drill. If only an unbound legacy backup survives, keep the restore closed; there is no command that invents its missing identity or bypasses this check.

Inspect recorded backup and pause status without starting the application:

```sh
DATA_DIR=/data/bookface-restored node dist/cli.js status
```

When restoring `latest`, the status deliberately leaves the exact snapshot ID blank rather than retaining an unrelated older ID. Prefer a recorded exact snapshot ID for a drill.

After reconciliation, start the new instance and verify owner-only archive access, a previously revoked recipient's denial, a private photo, and a fresh invitation/friend interaction. Sign in with current credentials and replace account recovery codes through the password-change flow. Keep the old host stopped to avoid two installations using the same identity.

## Crashes and upgrades

The instance lock is removed only after requests and background writers have drained and the database has closed. Compose gives the application 60 seconds to stop. The server allows 50 seconds overall; on a timeout or shutdown failure it exits with the lock retained. A crash or forced kill can therefore leave `.instance-lock`. Never remove a lock merely because it is old or a backup was delayed.

On the original host and PID namespace, verify the application stopped, then run:

```sh
node dist/cli.js unlock --stopped
```

This refuses a recorded process that still exists. A PID check from a replacement container cannot establish whether the original container stopped, so foreign-host or foreign-namespace locks require explicit operator evidence bound to the exact container identity recorded when the lock was acquired. The application records a full Docker container ID only when Linux exposes it in `/proc/self/cgroup` or in `/proc/self/mountinfo` paths for Docker's `/etc/hostname`, `/etc/hosts` or `/etc/resolv.conf` mounts. All discovered IDs must agree; it never derives identity from a configurable hostname or environment variable. Older locks and runtimes that expose no unique ID through either kernel source cannot use this recovery command and fail closed; recover from the original host and PID namespace instead. Keep the exact application service stopped and disable its automatic restart, deployment replacement and any external supervisor that could start another writer throughout recovery. Do not remove the old container before collecting its inspection.

On the Docker host, inspect the exact old container that held this data volume. Confirm its identity, volume mount and stopped state yourself; capture its inspection in an owner-only file, using its full container ID rather than a reused name:

```sh
umask 077
docker inspect EXACT_OLD_CONTAINER_ID > /secure/bookface/stopped-container.json
chmod 600 /secure/bookface/stopped-container.json
```

Read the `token` from that volume's `.instance-lock/owner.json` without modifying the lock. In a recovery command container using the same data volume, mount the inspection file read-only and run:

```sh
node dist/cli.js unlock --stopped \
  --container-inspect /secure/bookface/stopped-container.json \
  --lock-token EXACT_TOKEN_FROM_OWNER_JSON
```

The command requires one inspection record whose full container ID exactly matches the kernel-recorded ID in the lock, with the recorded hostname, `exited` or `dead` status, no running/restarting/paused state, PID zero and a finite finish time no earlier than the lock's creation. It checks the supplied token against the current lock and checks ownership again before removal. This is operator-supplied stopped-container evidence, not an automatic age-based unlock or a cryptographic proof that a supervisor cannot restart the service. Do not reuse stale inspection output. If the exact container cannot be verified, the evidence is rejected, or another writer might exist, keep the installation stopped and investigate. Restore normal restart controls only when recovery has finished and exactly one application can start.

For an upgrade: record the current image digest, stop the app, take and verify a backup, then test the reviewed replacement image against a copy in a restore drill. The drill must use a new identity-bound backup and a strictly newer ledger from the original source; an old unbound snapshot does not satisfy upgrade acceptance. Components record schema versions and reject versions newer than the application understands. This release begins at schema version 1; it does not claim a tested arbitrary downgrade path. If verification fails, stop the new version and restore the prior snapshot into a fresh directory with the matching old image, then apply current deletion/revocation state before resuming sharing. Do not run an old binary against a database it cannot understand.

The backup and restore commands never restart services, purchase hosting, change repository visibility, or alter host networking. They operate only on the explicitly selected installation and backup repository.

## Temporary uploads and photo previews

Import completion and failure remove their private uploaded source stage after the imported copies have either committed or rolled back. Queued and running imports retain their sources for restart. Background maintenance removes abandoned staging directories older than 24 hours, in bounded batches, and removes unused shared-photo previews after the same interval. It keeps derivatives referenced by active posts and keeps all owner-visible original photos. This housekeeping does not implement retention for personal memories. A draft composer left open for more than a day can require preparing its photo again.

## A maintenance window on managed platforms

The host’s **Set up backups** page gives a five-step walkthrough with commands and recorded backup receipts. It never receives recovery passwords, stops services or marks an unobserved restore as successful.

If your provider immediately restarts an exited web process, set `MAINTENANCE_MODE=true` and redeploy the same reviewed image. Wait until the old application process has stopped. In this mode the server opens no database or installation lock: `/healthz` returns HTTP 200 with `status: maintenance` and `ready: false`, while all account and content routes return 503. This keeps the provider’s process health check satisfied while leaving the persistent volume available for offline CLI work. A health response is not backup success.

Use the shell inside that maintenance deployment, with its existing data volume and private secret files, to run the documented backup or recovery commands. A provider’s separate one-off job may not have access to the disk; consult the exact [provider recipe](INSTALL.md). The normal exclusive lock still rejects a second live application. Never clear a lock to bypass a process that might still be running.

After routine backup, set `MAINTENANCE_MODE=false` and redeploy to resume the existing version; investigate any failed capture. For an upgrade, a failed required backup stops the upgrade, not the ability to resume the old version. A restored instance additionally requires current-state reconciliation, even after maintenance mode is turned off.
