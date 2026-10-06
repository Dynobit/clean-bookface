# Report a security problem

Use GitHub's private **[Report a vulnerability](https://github.com/Dynobit/clean-bookface/security/advisories/new)** form. Private reporting is enabled for this repository. If the form is unavailable, open a minimal issue asking a maintainer to arrange a private channel. Do not include exploit details, private archives, invitation links, credentials, logs from real accounts, or screenshots containing personal information in a public issue.

Use synthetic records to reproduce problems. Include the affected version, deployment type, expected access boundary and a minimal reproduction. We do not promise a response deadline or a security audit that has not happened.

Hosts should keep dependencies and operating systems patched, use HTTPS, restrict private runtime storage and rehearse restore. The encrypted client and storage home require independent control: a storage administrator who can also replace the app can steal keys before encryption. The older v0.1 server exposes plaintext to its host and is not upgraded automatically.

The encrypted preview has automated adversarial and recovery checks but no independent human cryptographic audit. Include its exact commit and affected component when reporting a problem; use fictional memories. Read the [encryption contract](docs/ENCRYPTION.md), [client qualification](encrypted-client/QUALIFICATION.md) and [host protocol boundary](encrypted-host/FEDERATION.md). For v0.1 reports, its [privacy contract](docs/PRIVACY.md) and [federation guide](docs/FEDERATION.md) remain relevant.

Please distinguish the affected release or draft from an independently operated circle. Repository maintainers cannot access or administer every installation. Share only the minimum synthetic reproduction needed, and keep exploit details and member data out of public issues and pull requests while a private report is being handled. No bug bounty or response-time guarantee is offered.
