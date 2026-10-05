# Check on your circle

The private operator dashboard is a local HTML file. It works even when the app is stopped, needs no new server, and sends nothing to GitHub or anyone else. Dashboard-only monitoring means a person must check it. If the host goes offline, nobody receives an alert.

On the pilot host, use its installed Node executable and private paths:

```sh
sudo /usr/bin/node -- /opt/clean-bookface/deploy/pilot-status.mjs \
  --backup-root /srv/clean-bookface-pilot-backup \
  --env-file /etc/clean-bookface/pilot.env \
  --output /var/lib/clean-bookface-status
```

Use the actual Node path if it is installed elsewhere. The command only reads Docker, systemd, the pilot configuration, backup receipts and local filesystem capacity. It writes `index.html` and `status.json` into an owner-private output directory. Copy those two files through your existing private connection and open the HTML locally. Do not expose the directory through the public app. No passwords, hostnames, raw paths, container IDs or subprocess error text enter the output.

Check daily and after any failed backup, restart or deployment. Generate a new snapshot for each check. The page warns when its snapshot is more than five minutes old; it cannot refresh the host itself. With JavaScript disabled it stays explicitly unverified. The snapshot clock depends on correct host and browser clocks.

- **Off-host backup:** the most recent checksum readback recorded by the backup wrapper. It becomes overdue 26 hours after capture, even if the copy was verified more recently. This does not prove the receiver is still reachable or replace a restore drill.
- **Latest attempt:** the separate attempt receipt retains failures without destroying earlier success evidence. A newer systemd failure takes precedence, including interrupted jobs. A receipt written during a failed service invocation is associated using that invocation’s start and exit timestamps; a later manual attempt keeps its own result. Running for more than four hours needs investigation. Missing or malformed evidence stays unknown.
- **Pilot processes:** exact project containers and application health, alongside the fixed scheduled phase. A running tunnel process does not establish public reachability. Closure with any running process needs attention.
- **Storage:** actual local backup-filesystem space. Below 10 GiB **or** 10% free means low space. Receiver capacity stays unknown unless a fresh, separately measured snapshot is supplied. These thresholds are an early warning, not proof that the next archive or backup fits. Nothing is deleted automatically.

Use the explicit dashboard-only option in [backup setup](PILOT_BACKUPS.md). Retention, receiver capacity and periodic restore checks remain operator responsibilities. Agree who checks the dashboard before inviting people. Community moderators can help with the circle without receiving host credentials or backup keys; a future public status summary should be reviewed separately before publication.

## Optional receiver measurement

Append `--receiver-capacity /private/receiver-capacity.json` to the command. An operator-side helper can measure the exact restricted backup directory using an existing trusted administration connection; do not loosen the backup transport key’s forced command. Read filesystem totals with `statvfs` and allocated bytes with `du -s -B1` on that directory, counting hard-linked generations once and not following symlinks. This is an observation, not a reservation or quota.

The input format is `clean-bookface-receiver-capacity/1`, with UTC millisecond `observedAt`, integer `totalBytes`, `freeBytes` (available to ordinary users), `usedBytes` (filesystem blocks used), `repositoryBytes` (allocated bytes across the dedicated backup directory), and `planningBudgetBytes: 107374182400`. Never include hostnames, paths or subprocess output. Failed measurement must replace the input with `null`, not keep an earlier success. Missing, malformed, future or older-than-five-minute measurements show unknown; the open page also expires the receiver observation.

The receiver card separates filesystem free/used space from backup allocation. The initial **100 GiB planning budget is not an enforced quota**: 80% means budget warning, 90% means action needed. Less than 10 GiB or 10% filesystem free also needs action. Nothing deletes data or sends alerts. This does not measure sender staging headroom; check it separately before large captures. Keep the daily human check and agreed retention policy.
