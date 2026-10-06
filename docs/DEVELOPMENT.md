# Work on Clean Bookface

> This guide runs the older v0.1 server application. For the encrypted browser and its checks, use [encrypted client development](../encrypted-client/README.md).

This guide is for running the app locally and contributing code. To join a circle or import your history, use [Getting started](GETTING_STARTED.md). For a server with real members, follow [Installation](INSTALL.md) and [Operations](OPERATIONS.md).

## Try the fictional demo

Use a patched Node 24 LTS release and npm; 24.4 is the application's minimum API version. The public source can be cloned without GitHub credentials.

```sh
git clone https://github.com/Dynobit/clean-bookface.git
cd clean-bookface
npm ci --ignore-scripts
npm run demo
```

Open **http://localhost:3100**. Sign in as `alice`, `ben`, or `casey` with `fictional-demo-password-only`.

The demo binds to your own machine and contains fictional accounts and generated artwork. It saves changes in `data/demo`, which Git ignores. Use only synthetic data here; the published demo credentials are not suitable for a real archive.

## Start an empty local installation

From the same checkout, after installing dependencies:

```sh
npm run build
npm start
# In another terminal, from the same directory:
npm run setup
```

Open **http://localhost:3000**, enter the one-time setup code, create your account, and save the recovery codes. There is no default administrator password. Local HTTP is for your own machine; an internet-facing installation requires HTTPS.

## How it fits together

The application uses one Node process, Hono, SQLite, private local file storage and a durable job ledger. The supplied Docker Compose deployment adds Caddy for HTTPS. No Redis, external database, object-storage account, email service, analytics or Facebook API credentials are required.

Imports stay owner-only. Publishing creates a separate sharing copy with a chosen audience; photo sharing copies have embedded metadata removed. New friendships do not grant access to old posts. Keep those boundaries intact in changes to search, media, exports and delivery.

Cross-host connections use a small private ActivityPub profile between Clean Bookface installations. This is not general Mastodon compatibility. There is no live chat, video transcoding or public trending page. Read [Federation](FEDERATION.md), [Privacy](PRIVACY.md) and [Portability](PORTABILITY.md) before changing those paths.

## Check a change

Run the checks required for your change and the contribution workflow:

```sh
npm run check
npm test
npm run build
npm audit --omit=dev --audit-level=moderate
npx playwright install chromium
npm run test:e2e
npm run format:check
npm run check:repository
```

Install restic for the real encrypted backup tests, or set `RESTIC_TEST_BINARY` to its reviewed executable. CI installs the pinned binary explicitly. On macOS, browser tests use installed Google Chrome; on Linux they use Playwright Chromium.

`check:repository` inspects the Git index. Stage only reviewed source and synthetic fixtures before using it to check new files. Never stage private archives, host configuration, recovery codes, browser state or screenshots of real accounts. See [Contributing](../CONTRIBUTING.md) for the full workflow and [Security](../SECURITY.md) for private reporting.

[Release evidence](RELEASE.md) records completed checks and unfinished qualification. [Performance](PERFORMANCE.md) records the measured import workload; it is not a guarantee for every archive or hosting provider.

## More technical references

- [Installation and capacity limits](INSTALL.md)
- [Hosting plans and cost assumptions](HOSTING.md)
- [Backups, restore and deletion reconciliation](OPERATIONS.md)
- [Implementation backlog](BACKLOG.md)
- [Build plan](BUILD_PLAN.md)
- [A five-person usability session](USABILITY_CHECK.md)
- [Maintainer responsibilities](../GOVERNANCE.md)
