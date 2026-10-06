# What would hosting cost?

The easiest way to use Clean Bookface is to join a friend who already runs a home. You need a browser and an invitation. You do not need to rent anything yourself. There is no official free hosting service, and nobody is promising to keep your memories online forever.

If nobody can host, a few friends can share one small server and its bill. One person still needs to look after updates, invitations, disk space and backups. A hosting dashboard does not do that job for them.

These are **planning budgets for the encrypted version**, checked on 6 October 2026. The tested image pins currently target Linux ARM64. The v0.1 Render/Railway templates and x86 server recipes do not install this stack. No provider below has been purchased or qualified as a production installation by this project.

## Three practical choices

| Choice | Who looks after it? | What you pay |
| --- | --- | --- |
| Join a friend's home | Your friend or their named host | Whatever contribution you agree; no separate server bill |
| Use a suitable Pi and SSD you already own | You, or a friend who understands Linux | Electricity, internet and a separate backup destination; hardware replacement is still a cost |
| Share an ARM64 virtual server | A nominated host | Compute, storage, a backup destination and possibly a domain |

For a Pi, measure its actual power consumption. As an example, **10 watts continuously at $0.20/kWh is about $1.46/month**: `0.010 × 24 × 30.4 × 0.20`. That is an assumption, not a measurement of your Pi, SSD or router. Home power and broadband outages affect availability. Keep the backup on another machine, preferably somewhere else.

## A small shared-server budget

For a small test circle with **five accounts and about 5 GB of original memories in total**, a Hetzner CAX11 is an ARM64 candidate. Its published compute price in Germany/Finland is **€5.99 / $6.99 monthly before tax and IPv4**. CAX21 is **€10.49 / $12.49** if the smaller plan does not have enough headroom. Availability and current specifications must be checked before ordering. [Current price list](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/), [ARM64 architecture](https://www.hetzner.com/pressroom/arm64-cloud/).

| Monthly item, before tax | Small-circle example |
| --- | ---: |
| CAX11 compute | $6.99 |
| Public IPv4 | $0.60 |
| Offsite SFTP backup budget | $5.00 assumed allowance |
| Domain renewal budget | $1.00 assumed allowance |
| **Planning total** | **$13.59** |
| **Split five ways** | **About $2.72 each** |

IPv4 is separately listed at €0.50 / $0.60 per month. [Provider IP prices](https://docs.hetzner.com/general/infrastructure-and-availability/ipv4-pricing/).

The backup and domain lines are **budget allowances, not quoted products**. Obtain an actual SFTP destination price and the domain's renewal price before paying. An existing domain or spare backup machine may reduce incremental spending; that does not make it permanently free. Taxes, currency changes, paid help, excess traffic and additional disk are excluded. Administration is unpaid in this example.

Reserve room for the operating system, containers, encrypted media, database, backup staging and growth. A backup can temporarily need another copy of the live data. Do not fill the included disk with people's original archives or assume every account can use the group's entire allowance. Check free space and test your chosen workload before inviting people.

## What “two hosts” means here

One home accepts writes. The optional second machine keeps encrypted backup snapshots. If the first machine fails, restore into a separate target and verify it before moving service; keep the former primary from accepting writes. This is not instant failover or two active copies.

The included tools have passed an actual scheduled SFTP backup and isolated restore between two physical machines. They use strict SSH host-key checking and check the backup data. That qualifies the tested path, not every commercial SFTP service or a whole-region disaster. [Measured host results](../encrypted-host/QUALIFICATION.md).

Keep the backup password away from both hosts. Members must also keep their own recovery kits and original downloads. A server backup cannot supply a lost member key.

## Before spending money

Use [the installation guide](../encrypted-host/SELF_HOST.md) to check the supported architecture and requirements. Pick the person who will maintain the home, an address you can keep, and a backup destination. Run a fictional invitation/import/recovery journey and a restore drill first.

The independent browser app is a separate static site. It must be controlled by someone the members trust independently of their storage operator. Serving it under a second name with the same storage administrator controlling its deployment does not create that separation.

For someone who wants no server duties, joining a trusted existing home is the practical choice today. We do not label a managed provider “one click” until the complete install, update and restore have been tested there.
