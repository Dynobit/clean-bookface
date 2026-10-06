# Report a security problem

Use GitHub's private **[Report a vulnerability](https://github.com/Dynobit/clean-bookface/security/advisories/new)** form. Private reporting is enabled for this repository. If the form is unavailable, open a minimal issue asking a maintainer to arrange a private channel. Do not include exploit details, private archives, invitation links, credentials, logs from real accounts, or screenshots containing personal information in a public issue.

Use synthetic records to reproduce problems. Include the affected version, deployment type, expected access boundary and a minimal reproduction. We do not promise a response deadline or a security audit that has not happened.

Hosts should keep supported Node dependencies and their operating system patched, use HTTPS, restrict access to the data volume, and rehearse encrypted restore. A shared host's operator can read its running database and media. The v0.1 public preview on `main` does not provide end-to-end encryption. The encrypted successor in [draft PR #4](https://github.com/Dynobit/clean-bookface/pull/4) is experimental and not production-ready; include its exact commit when reporting a problem. Do not use real personal archives to test it.

The detailed threat model and limits are in [the privacy contract](docs/PRIVACY.md), and the narrow cross-host protocol is in [the federation guide](docs/FEDERATION.md).

Please distinguish the affected release or draft from an independently operated circle. Repository maintainers cannot access or administer every installation. Share only the minimum synthetic reproduction needed, and keep exploit details and member data out of public issues and pull requests while a private report is being handled. No bug bounty or response-time guarantee is offered.
