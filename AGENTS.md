# Clean Bookface project instructions

Build and maintain the product described in docs/BUILD_PLAN.md. The README states the product's point of view; docs/PRIVACY.md defines its privacy contract and evidence boundaries. These instructions apply to this repository only.

- This repository contains a working v0.1 public-preview application with automated archive, social, federation, HTTP and recovery tests. Public source and a project website do not constitute an official hosting service or qualify an individual installation. Keep implemented behavior, observed test results, deployment qualification and unfinished acceptance work distinct; consult docs/BACKLOG.md before claiming completion.
- The owner approved public source and project-website release on 5 October 2026. Reviewed public contributions are welcome. Keep private development history, operational records and member data out of the public repository; publish only reviewed source and synthetic fixtures. Verify the intended remote and visibility before pushing.
- Never include personal archives, messages, real contact lists, screenshots of real accounts, credentials, browser state, private machine addresses, or identifying operator information in source, issues, logs, fixtures, commit messages, or documentation. Use fictional examples and reserved example domains.
- Review exact staged files before committing or pushing. Ignoring files and scanning for secrets are useful checks, not proof that arbitrary files contain no personal information.
- Preserve the earlier prototype separately. Copy only reviewed, needed code and synthetic fixtures, with provenance. Do not import its screenshots, deployment scripts, machine configuration, or whole working tree.
- Imports are private. Publishing is a separate, deliberate action. Every content, media, search, export and federation path must enforce the same audience rules.
- Never claim encrypted backups make the running database end-to-end encrypted. Be precise about hosting administrator and recipient access.
- Support people who do not operate servers. Joining a friend's circle must require no terminal, provider account, or payment details.
- The feed and notifications answer to the user. Do not introduce engagement ranking, tracking, ads, manipulative prompts, or automated accounts.
- Enforce the no-bot policy through invitations, permissions, quotas and moderation. Do not invent a perfect-human-verification claim or collect identity documents by default.
- Prefer one application, SQLite, private file storage and a durable job ledger. Add infrastructure only for a measured requirement.
- Verify behavior through meaningful end-to-end and adversarial tests. A source-string assertion is not proof of privacy, federation, restore, or successful deployment.
- Keep prose specific and plain. No invented testimonials, community size, benchmarks or implementation claims.
