# Report a security problem

Please use GitHub's **Report a vulnerability** option if it is enabled for this repository. If it is unavailable, open a minimal issue asking a maintainer to arrange a private channel. Do not include exploit details, private archives, invitation links, credentials, logs from real accounts, or screenshots containing personal information in a public issue.

Use synthetic records to reproduce problems. Include the affected version, deployment type, expected access boundary and a minimal reproduction. We do not promise a response deadline or a security audit that has not happened.

Hosts should keep supported Node dependencies and their operating system patched, use HTTPS, restrict access to the data volume, and rehearse encrypted restore. A shared host's operator can read its running database and media. This release does not provide end-to-end encryption.

The detailed threat model and limits are in [the privacy contract](docs/PRIVACY.md), and the narrow cross-host protocol is in [the federation guide](docs/FEDERATION.md).
