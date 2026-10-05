# Install a circle

**First time hosting? Start with [Host your own circle](HOST_YOUR_CIRCLE.md).** It walks through choosing a server, running `./setup`, creating your account and checking backups. This page is the detailed reference for manual installation and maintenance.

A member needs only a browser and an invitation. The instructions here are for the person responsible for the host, its bill, updates and backups. Start with synthetic data; finish a restore drill before asking friends to import their memories.

## Choose the address and disk first

Use a stable domain you control. Cross-host identities include that address. Moving the same installation to another machine can preserve it; changing domains creates different identities. Configure DNS through your provider, and make ports 80 and 443 reachable on the server you chose. This repository never changes your machine's networking.

The initial recipe budgets 1.5 GiB for the application and 256 MiB for Caddy. Start with a 4 GB RAM VPS to leave room for the operating system, image builds and backup commands. This is a conservative starting configuration, not a completed provider capacity qualification. [Performance](PERFORMANCE.md) records the measured workload and its limitations; [hosting](HOSTING.md) explains costs.

Keep the data volume on a local filesystem. Budget originals, sharing derivatives, database, temporary uploads, expanded archives, exports and restore headroom. The default account archive allowance is 5 GiB; it is not a reservation of disk space. The application checks import bounds and disk headroom but cannot reserve a shared host's remaining storage against unrelated processes. Monitor free disk and provider bills.

### Import and photo limits

The default bounds are:

| Resource | Default limit |
| --- | --- |
| HTTP import upload | 1 GiB |
| Compressed archive input | 1 GiB |
| Expanded archive input | 2 GiB |
| Files in an import | 20,000 |
| Records per import / stored records per account | 100,000 |
| Individual archive file | 256 MiB |
| Individual JSON file | 32 MiB |
| Image dimensions | 40 megapixels |
| Stored archive data per account | 5 GiB |
| New-post photo upload | 12 images, 128 MiB total |

`MAX_UPLOAD_BYTES` changes the HTTP upload limit only. Archive expansion,
record, pixel and account limits live in [the archive configuration](../src/archive/types.ts).
Review the whole capacity budget before raising an allowance; changing one
limit does not remove the others. [Performance](PERFORMANCE.md) records measured
workloads and remaining capacity qualification.

Only supported JSON export layouts can be imported; HTML-only exports are not
supported. Keep every part of a split download together and review skipped
records and missing-media warnings. The [member guide](GETTING_STARTED.md)
explains this without requiring members to understand the configuration.

## Docker Compose

Use Docker Engine with the Compose plugin on the chosen host. Clone the public source; GitHub credentials are not required to download it. Check out a reviewed commit; record its ID before building.

```sh
git clone https://github.com/Dynobit/clean-bookface.git
cd clean-bookface
cp .env.example .env
```

Edit `.env` locally:

```dotenv
APP_DOMAIN=friends.example
INSTANCE_NAME=Our circle
FEDERATION_ENABLED=false
MAX_UPLOAD_BYTES=1073741824
```

Replace the reserved example domain with yours. Do not commit this file. Start the installation:

```sh
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose exec app node dist/cli.js setup-token
```

Caddy obtains HTTPS certificates for the configured address. Open that address, paste the one-time setup code, create the first account, and save its recovery codes. The code is intentionally not printed in server logs. It disappears after successful setup. Do not paste setup codes, recovery material or member data into support requests.

`app_data` stores the installation. `caddy_data` and `caddy_config` store proxy state. A normal container replacement keeps these named volumes. Removing volumes destroys their contents: do not use `down -v` for ordinary maintenance.

Container startup requires an explicit persistent mount at `/data`; an ephemeral image directory, a read-only mount or temporary memory storage is refused. Use the configured named volume or a private bind-mounted directory. Run managed-provider CLI commands through `node provider-start.mjs cli` so privilege and storage checks apply. Keep backup and SSH paths explicit; the bootstrap does not change the process home directory.

The application is reachable only through the proxy in this recipe. The image drops privileges to the `node` user, and Compose drops capabilities and makes the application filesystem read-only. `/data` is writable; `/tmp` is a bounded scratch mount. `/healthz` checks that the database can answer, not that every peer or backup destination is healthy.

## First-friend walkthrough

1. Read **Who can see what** together. The host administrator can access active stored data.
2. In **Friends**, create a joining invitation. Send it to a person you know through your usual trusted channel. Invitations are limited, expiring credentials.
3. They create an account and save their recovery codes. Joining a host does not automatically create friendships or unlock archives.
4. Exchange a friendship invitation or request and accept it. Publish one fictional post to that friend, then revoke it and confirm it disappears from their account.
5. Import a tiny synthetic archive, view a private photo, download an account export and import it into a separate test account. Verify that it arrives privately.
6. Run an encrypted backup and restore drill using [Operations](OPERATIONS.md). Keep recovery material outside the host and backup repository.

Once those checks pass, invite people gradually. Hosting is a responsibility to those people, even when the software is free.

## Connect another host

Both hosts need stable public HTTPS origins on port 443 and `FEDERATION_ENABLED=true`. Each hostname must resolve only to public addresses; private LAN, loopback and nonstandard-port peers are refused by the production transport. Recreate only the app service after editing that setting. Exchange exact profile URLs and verify each other using an existing channel. A matching display name proves nothing. Handle lookup also requires that member to enable discovery in Settings; an exact profile URL does not.

The implementation signs requests, validates actor ownership and audiences, rejects private-network destinations, and queues delivery for retry. Development localhost peers are deliberately refused by the production transport. The two-host test harness injects an isolated transport; that is not a production configuration switch.

Do not expect general Fediverse interoperability. Read [the private protocol](FEDERATION.md). The author's **Sharing** page shows delivery and removal acknowledgments. An offline recipient may delay acknowledgment, and no status can prove deletion of an external saved copy.

The implementation's automated two-host HTTPS tests are local qualification,
not evidence that your domain, firewall, certificate renewal or provider will
work. Complete the friend-and-revocation walkthrough between the actual hosts
before relying on those connections.

## Updates and recovery

Read the change and record the old image ID. Stop this application's container cleanly, capture an encrypted backup, and verify it. Before replacing the live service, use the reviewed backup command on the stopped original source to make a new installation-bound backup, export a strictly newer current-state ledger, and test an actual restore and reconciliation with the new image against a separate copy. The ledger must match both the original installation identity and canonical origin; a new installation at the same domain cannot stand in for the source. Backup recovery bundles and legacy ledgers cannot unlock a restore. Older backups without an installation identity remain closed after restoration; preserve them, but do not count them as passing this upgrade drill. Components reject unsupported future schema versions; the initial release does not promise arbitrary database downgrades.

Backups in this release are operator CLI work during a short offline window. **Host tools → Set up backups** provides a step-by-step walkthrough and shows recorded backup receipts; it does not run the commands or schedule backups. No automatic backup scheduler or recovery service is installed. Use your host's scheduler and monitor failures. [Operations](OPERATIONS.md) gives exact initialization, capture, retention, restore and deletion-reconciliation commands. A stopped backup schedule is not a deletion-retention guarantee.

For an operator command against the existing data volume, stop the app first and use a one-off container with the same Compose service configuration:

```sh
docker compose stop app
# Add your private read-only secret mounts, repository mount or remote settings,
# and RESTIC_REPOSITORY / RESTIC_PASSWORD_FILE / RECOVERY_PASSWORD_FILE variables.
# Then: docker compose run --rm --no-deps app node dist/cli.js backup
docker compose start app
```

If a routine backup fails, resume the unchanged application and investigate the
failed capture. If a pre-upgrade backup fails, postpone the upgrade and resume
the old version; do not leave a working circle offline just because the backup
destination is unavailable. A failed restore remains closed until its recovery
checks pass. Never remove an instance lock while a process may still be using
that volume. Clean shutdown drains writers before releasing the lock; a 50-second
shutdown timeout retains it within Compose's 60-second stop grace period.
Same-host recovery uses `unlock --stopped`. A foreign container requires
`unlock --stopped --container-inspect FILE --lock-token TOKEN` with an owner-only
inspection of the exact stopped old container and the current lock token. Its
full container ID must match the kernel-recorded ID captured when acquiring the
lock; matching hostnames are insufficient. Older locks or runtimes that hide
this identity reject foreign recovery; use the original host/PID namespace. Keep
the service stopped and its restart/supervisor controls disabled throughout.
Follow the exact evidence and volume checks in [Operations](OPERATIONS.md#crashes-and-upgrades);
never infer that a foreign container stopped from PID or lock age alone.

## Render: a reviewed Blueprint

[`render.yaml`](../render.yaml) describes one Dockerfile service on `1c-2g`, one
20 GB disk mounted at `/data`, five accounts with 1 GiB archive allowances, a health check and disabled automatic code
deployments. It prompts for `APP_ORIGIN`; federation starts disabled. Applying
the Blueprint creates paid resources. The existing budget is $25 compute plus
$5 disk before bandwidth, backups, domain and tax. This template was reviewed
against the current [Blueprint reference](https://render.com/docs/blueprint-spec)
on 2026-10-02; provider deployment remains unqualified.

1. Use your own Render account. If you connect GitHub, grant access only to the
   repository you intend to deploy. Select **New Blueprint**, that
   repository and a reviewed branch. Check the region, plan and disk before
   accepting the provider's bill.
2. Supply a stable `APP_ORIGIN`, such as `https://friends.example` with your own
   domain substituted. Add and verify that domain in the service's settings.
   Use only that canonical address for setup. Changing it after accounts exist
   is not a supported account migration.
3. Turn the Blueprint's **Auto Sync** off as well as leaving service auto-deploy
   off. These are separate controls. Apply future source/configuration changes
   only after reviewing them. [Blueprint sync controls](https://render.com/docs/infrastructure-as-code)
4. After the initial deployment, open the running service's dashboard **Shell**
   and run `node dist/cli.js setup-token`. Keep the code private, open your
   canonical HTTPS address, and create the first account. The image supplies the
   node user's private `.ssh` directory for Render's shell requirements.
   [Shell access](https://render.com/docs/ssh)
5. Use synthetic data for the first-friend, persistence and recovery walkthrough.
   Confirm `/data` is writable by UID 1000 and survives a redeploy. A passing
   `/healthz` response alone does not qualify storage or backups.

## Railway: current Infrastructure as Code

Railway no longer accepts `railway.json` for new services, and its documentation
sets 2026-12-01 as the end of legacy support. This repository therefore supplies
[`.railway/railway.ts`](../.railway/railway.ts), using the current IaC SDK, rather
than a deprecated JSON deployment file. [Railway's migration notice](https://docs.railway.com/infrastructure-as-code)

The definition describes one Dockerfile service, one 20,000 MB volume, five accounts with 1 GiB archive allowances, one
explicit domain, disabled federation and disabled tracing. It does not choose
your subscription. Review a **Pro** account and its usage budget before creating
this reference 20 GB installation; do not assume the Hobby storage allowance
fits it. Pricing assumptions remain in [Hosting](HOSTING.md).

1. In your private deployment copy, edit the example domain, repository and
   region at the top of the IaC file. Choose the stable domain before setup.
   Use your own Railway/GitHub accounts and grant only the needed repository
   access. Start with an empty, dedicated project/environment.
2. Install the provider's CLI version **5.42.1 or newer**. Install the reviewed
   SDK only for this deployment definition; it is not an application dependency:

   ```sh
   npm install --prefix .railway --no-save --package-lock=false --ignore-scripts --no-audit --no-fund railway@3.12.0
   railway login
   railway link
   railway config plan
   ```

3. Inspect the plan. It should add exactly one application and one volume, not
   remove resources or provision a database. `railway config apply` is the
   separate, billable provider action; review its confirmation before applying.
   Before creating accounts or importing real data, set GitHub autodeploys off
   in the service settings and deploy reviewed commits manually. The current
   SDK does not expose that GitHub setting. Keep one replica and keep the volume
   in the service's region.
4. Verify the configured domain and HTTPS, then use the running service's shell
   or `railway ssh`. Run `node provider-start.mjs cli setup-token` and complete
   setup at the canonical domain. Use that CLI wrapper for other operator
   commands on Railway too.

Railway documents that new volume mounts belong to root. The template sets
`RAILWAY_RUN_UID=0` only to enter a narrow bootstrap: it opens `/data` without
following a symlink, changes that directory's ownership/mode, clears supplementary
groups, and drops to UID/GID 1000 before loading the server or CLI. It never
recursively changes existing files. A preexisting volume with incompatible file
ownership requires operator review, not a recursive permission repair.
[Railway volume permissions](https://docs.railway.com/volumes)

The SDK definition has been evaluated locally against Railway 3.12.0. This checks
its resource structure, not provider authorization, billing, disk behavior,
certificate renewal or recovery. Both managed routes still need a fresh-account
deployment and full recovery drill before real-user qualification.

## Managed-platform backups use the same mounted disk

Neither provider's build nor pre-deploy phase has the running data volume.
Render one-off jobs also lack it. A backup there would inspect an empty or
unrelated directory. Use the actual service's shell while that service runs in
maintenance mode. [Render disk limits](https://render.com/docs/disks),
[Render one-off jobs](https://render.com/docs/one-off-jobs),
[Railway volume availability](https://docs.railway.com/volumes)

1. Keep the app at one replica. Set `MAINTENANCE_MODE=true` and redeploy that
   service. Wait for the old process to exit cleanly. Health checks remain
   available, but account/content routes return 503 and this process opens no
   application database or instance lock.
2. Open the **running service's** shell. Supply the private backup repository
   configuration and two independent owner-only password files as described in
   [Operations](OPERATIONS.md). Keep offline copies elsewhere. On Render run
   `node dist/cli.js backup`; on Railway run
   `node provider-start.mjs cli backup`. Initialize the repository separately
   for the first capture. Do not put secrets in the Blueprint, IaC file, source,
   shell history, build arguments or screenshots.
3. Record the command outcome and snapshot ID. Set `MAINTENANCE_MODE=false` and
   redeploy the unchanged application. Check sign-in and a private photo. If a
   routine capture failed, restore availability and fix the backup before the
   next upgrade; do not mistake a failed backup for a failed data restore.
4. Prove restoration into a separate empty destination, with current deletion
   reconciliation, before calling the host ready. Provider snapshots alone do
   not implement that reconciliation or replace an independently encrypted,
   recoverable backup.

These instructions do not install a schedule, buy storage or create a provider
service. Maintenance, redeployment and encrypted backup transfer consume time
and may incur the provider's ordinary usage charges. The supplied Compose
hardening is not automatically applied by managed platforms; verify their
runtime user, storage, process shutdown and request/cache behavior separately.

## Node without Docker

Use the supported Node 24 release line. From a clean checkout, run `npm ci --ignore-scripts` and `npm run build`. Put `DATA_DIR` on private persistent storage. Set `NODE_ENV=production`, a stable HTTPS `APP_ORIGIN`, `BIND_ADDRESS=127.0.0.1` and the internal `PORT`; place a trusted HTTPS reverse proxy in front. It must preserve the canonical Host header. Keep the process under your own service manager and install reviewed restic separately.

There is no automatic email provider, root cron modification, system service installer or DNS change. The Compose recipe has local container qualification. Render's Blueprint and Railway's IaC definition provide managed setup paths, while fresh-provider installation and recovery qualification remain outstanding.

## Optional donated Pi pilot

Use [Pi hosting](PI_HOSTING.md) for the separate, capped Cloudflare Tunnel
recipe. It has fixed end dates and does not publish a host port. Ordinary
self-hosted circles have no expiry unless their operator configures one.

Browser archive uploads use 4 MiB pieces and can resume after a page reload
when the same files are reselected. The direct multipart route remains for
JavaScript-free imports and shared photos. `MAX_DIRECT_UPLOAD_BYTES` can cap
that route below `MAX_UPLOAD_BYTES`; the pilot uses 80 MiB direct and 1 GiB
archive upload limits. `ARCHIVE_ACCOUNT_BYTES` sets each account's stored
archive allowance (5 GiB normally, 1 GiB in the pilot), and `MAX_ACCOUNTS`
sets the total account ceiling (200 normally, 25 in the pilot; at most 1,000).
Raising a ceiling does not qualify that capacity.
