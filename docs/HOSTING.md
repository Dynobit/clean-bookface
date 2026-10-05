# Clean Bookface hosting choices and costs

You should not have to become a server administrator to see your friends' photos. Clean Bookface should offer three clear choices: join someone you trust, share the cost of a small server, or pay a little more for a hosting dashboard that handles the operating system.

**This is a cost guide for an unreleased application.** A working Docker Compose recipe, Render Blueprint, Railway IaC definition and first-account setup screen are included; start with [Host your circle](HOST_YOUR_CIRCLE.md), or use the [installation reference](INSTALL.md). Managed templates have local structural checks, not fresh-provider deployment qualification. The native synthetic import benchmark in [Performance](PERFORMANCE.md) does not qualify any provider below. There is no official hosted service or existing public network. Backups still require operator configuration, secret custody and a tested schedule. Prices were checked against provider sources on **2 October 2026**; checkout prices, availability, taxes, and measured application requirements decide the final bill. No hosting has been purchased, and these links contain no referral codes.

## Start with the least work

| Your situation | Proposed route | Who looks after it? |
| --- | --- | --- |
| A friend already runs a circle you trust | Accept their invitation | Your friend; agree any contribution with them |
| Several friends want the lowest cash cost | Share one small VPS | One named administrator, with a recovery plan |
| Nobody wants to maintain Linux | Render, after deployment qualification | The provider maintains the platform; a circle owner still handles updates, backups, and accounts |
| You already use Railway | Consider Railway Pro after measuring usage | The same responsibilities, with a usage-based bill |

Joining a friend's circle can cost you nothing if they cover it, but somebody still pays the bill and does the work. Among the paid configurations evaluated here, a pooled Hetzner VPS has the lowest estimated cash cost. That is a comparison of these options, not a claim to have found the cheapest host on earth.

For the easier deployment guide, start by validating Render. Its fixed compute price is easier to explain. Railway remains a reasonable alternative for people comfortable monitoring variable usage. Neither provider operates the social community for you.

## A small, honest budget

The reference circle has **5–10 people sharing 10 GB of original media in total**, not 10 GB each. Budget 20 GB for live application data and working headroom, 30 GB of encrypted backups, and 20 GB of monthly outbound transfer including ordinary browsing, federation, backups, and exports. These are planning assumptions, not measured consumption. General installations default to 5 GiB of archive records/media per account. The supplied 20 GB managed-platform templates start more conservatively: five accounts with 1 GiB each, leaving space for staging, the database and recovery. Each import is limited to 1 GiB uploaded and 2 GiB expanded; this group budget does not make a single 10 GB archive importable. Review batch sizes, derivative storage and the limits together.

The backup plan uses encrypted incremental snapshots through restic. The traffic estimate assumes modest changes after the first upload; nightly full uploads or frequent archive exports would exceed it. Retention and media churn must be measured against the 30 GB backup allowance. [Restic backup capabilities](https://restic.net/)

Photos, thumbnails, database records, imports, and exports all take space. A full archive import or export may temporarily need another archive-sized allocation. The installer must check this before starting; 20 GB is not a promise that every 10 GB archive can be processed in place. Large video collections need a new estimate.

| Monthly item, before tax | Shared VPS | Render | Railway Pro example |
| --- | ---: | ---: | ---: |
| Compute | $6.49 | $25.00 | $22.00 assumed usage |
| Public IPv4 | $0.60 | Included in platform access | Included in platform access |
| 20 GB live storage allowance | Within included server disk | $5.00 | $3.00 at 20 GB used |
| 20 GB outbound transfer | Within included allowance | $2.25 | $1.00 |
| 30 GB encrypted backup storage | About $0.14 | About $0.14 | About $0.14 |
| Optional domain budget | $1.00 | $1.00 | $1.00 |
| **Illustrative total** | **$8.23** | **$33.39** | **$27.14** |
| **Split five ways** | **$1.65 each** | **$6.68 each** | **$5.43 each** |

The domain line is an assumed **$12 annual budget**, not a registrar quote; domains are usually billed annually and renewal prices vary. Remove that line if an existing domain or suitable provider address is used. A domain controlled by the circle makes changing hosts easier; choose a stable address before establishing federated friendships.

These totals exclude tax, currency conversion, paid support, optional email delivery, unusual restores, and extra traffic. Administration is unpaid in this example. We do not yet know how much time reliable maintenance takes. Invite links and recovery codes should work without a paid email provider.

### Where the numbers come from

**Shared VPS:** Hetzner lists a new CX23 in Germany or Finland at **€5.49 / $6.49 monthly**, excluding VAT and IPv4. Use the June 2026 price adjustment, not older promotional prices. [Current server prices](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/) Its listed configuration is 2 vCPU, 4 GB RAM, 40 GB disk, and 20 TB included traffic. The operating system and application image also use that disk. [CX23 specifications](https://www.hetzner.com/de/news/new-cloud-plans/) Primary IPv4 adds **€0.50 / $0.60**, giving **€5.99 / $7.09** for server and address before extras. [IP prices](https://docs.hetzner.com/general/infrastructure-and-availability/ipv4-pricing/) Capacity and regional availability must be confirmed before ordering.

**Render:** Budget the 1 CPU / 2 GB plan, **$25 monthly**, formerly called Standard and now `1c-2g`. The $7, 512 MB plan exists, but we cannot recommend it for archive processing without a memory test. [Compute plan names](https://render.com/docs/compute-plans), [provider's compute price comparison](https://render.com/articles/render-vs-railway) Persistent disk costs **$0.25/GB/month**, so 20 GB adds $5. [Disk pricing](https://render.com/pricing) A current Hobby workspace includes **5 GB outbound**, with additional bandwidth at **$0.15/GB**: `(20 − 5) × $0.15 = $2.25`. Older articles mentioning 100 GB are not the basis for this budget. [Bandwidth allowance](https://render.com/docs/outbound-bandwidth), [overage pricing](https://render.com/articles/how-much-does-cloud-application-hosting-cost-for-small-businesses)

**Railway:** Hobby has a **$5 minimum**, including $5 of usage, but its pricing page advertises only **up to 5 GB storage**. Volume documentation also describes resizing, so confirm any larger Hobby allocation directly; this guide does not assume it. The reference archive uses **Pro, with a $20 minimum including usage**, not $20 added on top. [Plans](https://railway.com/pricing), [volume limits](https://docs.railway.com/volumes/reference) The example assumes an average 2 GB RAM and 0.1 vCPU throughout the month: `(2 × $10) + (0.1 × $20) + (20 × $0.15 storage) + (20 × $0.05 egress) = $26`, above the $20 minimum. Add backup and domain for $27.14. Actual resource usage may be lower or higher. [Resource rates](https://docs.railway.com/pricing)

**Independent backups:** Backblaze B2 currently starts at **$6.95/TB/month**, with the first 10 GB free. Assuming that allowance is unused, 30 GB costs approximately `(30 − 10) × $0.00695 = $0.139/month` for storage. Retained versions count toward usage. Egress beyond its included allowance can cost extra; app-host egress is a separate charge. [B2 pricing and allowances](https://www.backblaze.com/cloud-storage/pricing) Encrypt before uploading and retain the recovery key separately. A price estimate does not prove that a backup can be restored.

## What an owner still has to do

The first release uses one application, SQLite, and private media files. Its database, uploads, and durable jobs must all survive restarts. On Render, only files under the attached disk persist; that disk belongs to one instance and prevents zero-downtime deployments. Plan for a short maintenance interruption. Free services without persistent storage are unsuitable for these memories. [Render disk behavior](https://render.com/docs/disks)

The circle owner controls the provider account, domain, billing, and recovery material. A helper should receive limited access instead of owning the accounts on the circle's behalf. Each member must have their own export and deletion controls, so leaving does not depend on the administrator's goodwill.

Hosting administrators can read active data in v1. Encrypted backups and HTTPS do not make the running application end-to-end encrypted. Members must see who runs their circle before importing anything. See the [privacy contract](PRIVACY.md).

## Setup status

1. **Choose a home.** Invitations and first-owner setup work. These cost estimates are in documentation; provider selection is not an in-app purchase flow.
2. **Review the bill.** Show region, plan, disk, backup destination, renewal costs, and optional domain before opening the provider's checkout. The user creates and owns that account.
3. **Install a reviewed commit.** Compose, the Render Blueprint and Railway IaC describe a single persistent installation; a one-time code protects first-owner setup. Managed providers terminate HTTPS. A signed, tagged public release and fresh-provider qualification remain open. Do not follow an unreviewed development branch automatically.
4. **Save recovery material.** Explain the recovery key, run an encrypted backup, and restore synthetic content into a separate instance before displaying “ready.”
5. **Import privately.** Show archive size, remaining space, progress, and a useful retry path. Then invite one friend and explicitly share one selected item.

Keep hosting controls in an owner area. Friends should see their photos and conversations, not server settings.

The managed installation guide includes a maintenance-mode backup procedure for
the actual mounted disk. This matters because a provider's one-off task may not
see that disk. Backups, testing and maintenance downtime remain the circle
owner's responsibility. The new templates do not change any price assumptions
or prove that a paid plan handles the reference workload.

## Keep the bill and the exit under your control

Settings shows account archive usage and the latest successful backup time. Import checks enforce configured limits; host-wide capacity alerting still belongs to the operator. Set provider billing alerts where supported and explain that an alert is not a hard cap. Any provider hard limit may interrupt service; document that behavior before enabling it.

Set upload quotas and bounded import jobs. Near capacity, pause new imports and explain the options. **Never delete someone's memories or upgrade a paid plan automatically to resolve a limit.** Price changes require the owner's choice. Keep backups outside the primary host and test restoration after meaningful storage changes.

A hosting route becomes recommended only after a fresh-account deployment, representative import, memory measurement, reboot, upgrade/rollback, cross-server sharing, encrypted restore, and complete export/migration have passed. Record actual resource use and replace these assumptions with those results. Until then, these are candidates and budgets for the build, not a supported-installation promise.
