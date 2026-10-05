# A bounded pilot on a donated Pi

This recipe starts with 25 invited accounts for 90 days, with the last 14 days
reserved for exports and closing down. The selected installation has completed
its recorded startup, public-route, workload and recovery checks; see the
[release evidence and remaining gates](RELEASE.md). Those results do not qualify
a different host. The current installation is operator-only, with no invitations
issued. Public repository release remains an explicit owner decision.

Use a 64-bit ARM Linux host with Docker Engine and the Compose plugin, durable
local storage, and enough spare memory for the operating system as well as the
containers. Build on that architecture or supply a reviewed ARM64 application
image. Do not displace another workload to make this fit. No router forwarding,
public host ports or host networking are required by this recipe.

The host must use cgroup v2 with working memory, CPU-quota and process limits.
Some Pi installations accept Docker's requested memory cap but cannot enforce
it. The controller checks host support before startup, then reads both running
containers' actual kernel limits. A missing or mismatched limit stops the pilot.
Resolve host boot configuration through the host's maintenance procedure; the
application never edits boot settings or reboots a shared machine.

## Address and private configuration

Keep the project website at `project.example.org`, redirect the corresponding
`.com` to it, and use `pilot.project.example.org` for the temporary application.
These are reserved examples, not live project addresses. A stable pilot origin
matters: a complete installation restore requires the original origin.

1. Copy [pilot.env.example](../deploy/pilot.env.example) to a private location
   outside the checkout, such as `/secure/clean-bookface/pilot.env`. Restrict it
   to the operator. Keep real infrastructure details and secrets out of Git.
2. Set `APP_IMAGE` to the image built from the exact reviewed commit. For a
   registry image, record its digest. Set `TUNNEL_IMAGE` to an explicitly
   reviewed `cloudflare/cloudflared:VERSION@sha256:DIGEST` reference. The
   configuration deliberately supplies no moving default.
3. Set `APP_ORIGIN` to the approved HTTPS pilot address. Set `PILOT_STARTS_AT` and both closing dates
   once: closing is 90 days after the approved launch; export-only begins
   14 days before closing. Use absolute UTC timestamps. Never calculate new
   deadlines at process startup.
4. Create a dedicated remotely managed Cloudflare Tunnel and route only the
   pilot hostname to **HTTP `app:3000`**. Docker resolves `app` on the private
   application network. Keep the default catch-all as a rejection. Do not
   add routes to other services or private networks.
5. Store the tunnel token in the file named by `TUNNEL_TOKEN_FILE`, outside the
   checkout. It is mounted as a Docker secret and passed using `--token-file`;
   do not place the token in environment variables, command arguments or logs.
   On Linux, make the source file readable by UID 65532 only (owner 65532,
   mode 0400); keep its parent directory operator-only. Local Compose secrets
   are file mounts, not an encrypted secret vault, and file ownership matters.

Cloudflare documents [remotely managed setup](https://developers.cloudflare.com/tunnel/get-started/)
and [tunnel run parameters](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/).
Review the selected release's `--token-file` support and ARM64 image before
launch. The tunnel needs outbound connectivity; do not change shared host
networking as an installation shortcut. Account and domain administration stay
with their authorized owners.

## Validate, then launch the reviewed configuration

Run from the repository root. Substitute the private environment-file path;
never copy its contents into a support request.

```sh
docker compose -f deploy/compose.pilot.yaml --env-file /secure/clean-bookface/pilot.env config --quiet
node -- deploy/pilot-control.mjs plan --env-file /secure/clean-bookface/pilot.env
node -- deploy/pilot-control.mjs preflight --env-file /secure/clean-bookface/pilot.env
```

The plan prints three systemd unit files and their installation steps. Review
and save those exact files under `/etc/systemd/system` with root ownership and
mode 0644. Enable the deadline timer first, inspect its scheduled UTC trigger,
then enable the startup service for launch:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now clean-bookface-pilot-deadline.timer
sudo systemctl list-timers clean-bookface-pilot-deadline.timer
sudo systemctl enable --now clean-bookface-pilot.service
```

Use the Node and Docker paths installed on the host (`--node` and `--docker`
options). The plan does not install packages or edit services for you. Startup
checks the fixed deadline, pinned ARM64 images, token permissions and exact
installed deadline units. Docker's automatic container restart is disabled;
the guarded startup service owns boot. Do not replace it with a raw Compose
command on reboot. A container crash needs operator investigation and guarded
restart; this recipe does not claim unattended crash recovery.

The dedicated Compose project is `clean-bookface-pilot`; its named volume is
separate from the ordinary installation. Do not reuse another installation's
volume. Both containers run without root or Linux capabilities and with
read-only root filesystems. The application has a 1 CPU, 2 GiB RAM and 128 PID
limit. Scratch mounts and Docker logs are bounded. There are no published host
ports. Only the tunnel joins the outbound network; federation is disabled.

After the guarded launch, retrieve the one-time setup code:

```sh
docker compose -f deploy/compose.pilot.yaml --env-file /secure/clean-bookface/pilot.env exec app node dist/cli.js setup-token
```

Enter it at the pilot address, create the first account,
and save recovery codes privately. Verify the site's actual dates, privacy
notice and account limit before creating invitations. Check the public HTTPS
route, login, logout and owner-only access from a separate browser session.
Never configure a cache rule that stores authenticated application responses.

## Storage and upload budget

Plan at least **64 GiB of dedicated free local storage** for the trial, plus
independent encrypted backups. This is planning headroom, **not an enforced
64 GiB volume quota**. Twenty-five 1 GiB archive allowances can consume 25 GiB
before derivatives, database, staged imports, exports and restore headroom.
Shared posts and other data also consume disk. Monitor actual free space and
stop invitations/imports before exhausting it; an allowance does not reserve
space against other processes.

The recipe sets archive upload input to 1 GiB and direct HTTP uploads to 80 MiB.
Large browser archive uploads require the application's chunked upload path;
a single large request will not fit the direct limit. Cloudflare and the chosen
plan can impose additional limits. Without JavaScript, use a small supported
export within the direct limit or another host. New shared-photo uploads are
also subject to that direct request ceiling. Test representative imports through
the real public route before promising support for a member's archive.

The selected Pi completed a [25-account / 10.06 GiB synthetic workload](PERFORMANCE.md)
with these CPU and memory limits, concurrent reads and writes, private-access
checks and verified export. That internal measurement excludes Internet upload
speed and does not qualify a different host.

Start with synthetic data and a few invited testers. Raise `MAX_ACCOUNTS` only
after measuring queue delay, storage growth, peak RAM, export time, backup time
and moderation load on this exact host. The configurable ceiling of 1,000 is
not capacity qualification. Keep other workloads healthy throughout testing.

## Backups, recovery and the fixed end

Use the [pilot backup procedure](PILOT_BACKUPS.md) for the daily encrypted
capture and restricted transfer to a separate machine. The runner briefly
stops this project's app and tunnel, captures this exact volume, then resumes
only if no shutdown was requested and the fixed deadline still permits it.
It verifies the remote copy before recording success. Backup credentials stay
outside the application and the checkout. The hardened runner requires a
root-owned control directory and separate uid-1000 repository, mounts only the
two recovery password files, and uses root-private lifecycle locks. Existing
installations need the [guarded layout migration](PILOT_BACKUPS.md#upgrade-and-interruption-recovery)
and a fresh transfer/restore drill before installing this revision; local tests
do not establish that migration has happened.

Follow [Operations](OPERATIONS.md) for independent recovery secrets, retention,
current-state reconciliation and fresh-host recovery. Never run two application
processes against the volume. The pilot uses a [private operator dashboard](PILOT_STATUS.md) for
backup failures and freshness; it sends no external alerts. Someone must check
that dashboard daily, including when the application is unavailable. Community
moderation and server operation are separate responsibilities.

Before accepting real memories, perform the entire encrypted backup and
fresh-host restore drill on the chosen Pi deployment. Check a private photo,
revoked access, deletion reconciliation, member export and private reimport.
A successful Compose validation or health response does not prove recovery.
Record real receipts privately; never mark an unperformed drill complete.

The app's absolute dates close new writes and then member access. They do not
turn off the host or erase disks. Before launch, install and test a deterministic
host scheduler action at the fixed closing date that stops this project's
containers, survives host restarts, and catches a missed deadline after downtime.
Keep the same dates during upgrades and recovery. Do not launch with only a
calendar reminder. The supplied control script generates the scheduler units; installation and an actual stop/restart drill are part of launch qualification.

At closing, stop this project without deleting its volume automatically:

```sh
sudo node -- deploy/pilot-control.mjs stop --apply
```

The controller selects only this project’s app and tunnel containers by their
Docker labels, so shutdown still works if the launch environment file is missing
or damaged. It reads back their stopped state and preserves the volume. The deadline unit
retries a failed stop after 30 seconds; each attempt retains its bounded lock
wait. A hard-interrupted backup still needs operator inspection before any
restart, and recorded shutdown intent must remain effective.

The daily wrapper stops capturing at the closing date. Before retention or
erasure, make and verify a final offline snapshot and current reconciliation
ledger while the application remains stopped, as described in the backup
runbook. The last scheduled snapshot alone does not cover final-day deletions.

Then remove its public tunnel route, revoke its token, and follow the announced
retention/deletion plan for the volume, encrypted repositories and offline
copies. Verify these actions; stopping containers alone is not deletion. Keep
project documentation available at the main website. Do not promise a volunteer
successor unless a real maintainer has accepted the role and the data handoff is
authorized by members. Source-code stewardship does not grant access to their
private archives.
