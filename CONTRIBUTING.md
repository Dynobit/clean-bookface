# Help make a place worth coming back to

Start with a small issue or a focused pull request. Explain the behavior a person should see, and how you verified it. Keep the application understandable to the next person who has to run it.

Start with [the community guide](docs/COMMUNITY.md) and [five starter tasks](docs/CONTRIBUTOR_TASKS.md) for no-code and testing contributions. Read [the member guide](docs/ENCRYPTED_GETTING_STARTED.md) to understand the experience we are trying to make easy, and [community stewardship](GOVERNANCE.md) for the path to shared maintenance. The public preview welcomes issues and focused pull requests; a public maintainer community has not yet been established.

## Choose a starting point

You do not need to run a server or write code to contribute. Check the [small, scoped priorities](docs/BACKLOG.md#community-priorities) and existing issues before starting; comment with the task you want to take so people can avoid duplicate work. A small documentation correction can go straight to a pull request. Use [Discussions](https://github.com/Dynobit/clean-bookface/discussions) for questions or ideas still taking shape, issues for reproducible bugs and scoped improvements, and [private security reporting](SECURITY.md) for vulnerabilities. Discuss a larger change first, with the user need and a proposed acceptance check.

| Interest             | Start here                                                                                             | Useful first result                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Documentation        | [Member guide](docs/ENCRYPTED_GETTING_STARTED.md) and [client development](encrypted-client/README.md) | Follow one journey from a clean start and fix a confusing step, stating what you actually tried.                            |
| Accessibility        | [Usability check](docs/USABILITY_CHECK.md) and the fictional demo                                      | Reproduce one keyboard, screen-reader or narrow-screen problem; include browser/assistive-tool versions and verify the fix. |
| Testing and imports  | [Client development](encrypted-client/README.md) and `encrypted-client/tests/`                         | Add a small synthetic fixture for a missing case and a behavioral regression test.                                          |
| Security and privacy | [Encryption contract](docs/ENCRYPTION.md) and [Security](SECURITY.md)                                  | Review one access boundary. Report vulnerabilities privately; use public issues for non-sensitive review scope only.        |
| Hosting and recovery | [Installation](encrypted-host/SELF_HOST.md) and [Operations](encrypted-host/OPERATIONS.md)             | Rehearse one documented install or restore on a disposable host and report sanitized results, including failures.           |

## Pick the right branch

The repository contains two applications with different privacy boundaries. The encrypted preview lives in `encrypted-client/` and `encrypted-host/`. The older v0.1 Node server remains at the repository root, with its original tests and migration exporter. Its host can read stored content; it is not upgraded by changes to the browser app.

Target reviewed changes at `main` after checking open pull requests and ownership. Use the exact package's setup and checks. Comments, reactions, account closure, moderation, migration, streaming imports and offsite recovery now have integrated paths and automated evidence. Independent human security, accessibility and usability reviews remain open. [Qualification and limits](encrypted-client/QUALIFICATION.md).

## Send a reviewable change

Keep each pull request focused. Describe the problem, resulting behavior, target branch, checks actually run and anything still unverified. For a visual change, include a fictional-data screenshot and keyboard/mobile observations. For code, run the [client checks](encrypted-client/README.md#build-test-and-publish) or the [v0.1 checks](docs/DEVELOPMENT.md#check-a-change), as appropriate; security, import and access changes need behavioral regression coverage. Documentation-only changes should verify commands, links and claims affected by the edit, and state when a procedure has not been exercised.

Review the whole diff, including deleted lines, for personal information before submitting. Do not upload production logs or archives as evidence. A maintainer reviews and merges contributions; submitting work does not grant repository, deployment or member-data access. There is no promised review turnaround. Be kind to other contributors, explain disagreements in terms of the proposed behavior, and leave space for people to decline a task.

## Keep these boundaries

- Use synthetic data only. Never submit your own Facebook download, real conversations, real contact lists, private hostnames, screenshots of member accounts, credentials or local configuration.
- Keep private archive reads and shared publication reads separate. Every media, search, export and federation route must enforce its audience.
- Use Node 24 and follow the [encrypted client guide](encrypted-client/README.md) or [v0.1 development guide](docs/DEVELOPMENT.md) for the application you are changing. See [host operations](encrypted-host/OPERATIONS.md) for container and restore checks.
- Add behavioral tests for changed security and import semantics. A test that only searches source text is not evidence of privacy.
- Keep the UI accessible with a keyboard and comfortable on a phone. Do not add remote fonts, tracking, infinite scroll, engagement ranking or bot-posting APIs.
- If an export layout is unsupported, describe its structure using a tiny fictional example. Do not paste a real export into an issue.
- Keep dependencies and generated assets attributable. The banner's generation prompt and origin are recorded in [ARTWORK.md](docs/ARTWORK.md).

Independent maintainers can build and host this source under the MIT license. Review dependency licenses before redistributing a bundled image. The project is unaffiliated with Meta or Facebook.

The [GitHub maintenance workflow](docs/GITHUB_AUTOMATION.md) sorts incoming requests and reports checks automatically. It preserves contributors' issues and maintainers' labels; it does not close work because it has been quiet. Maintainers can use GitHub auto-merge to finish an approved change when the required checks pass.

The separate [private daily review workflow](docs/CONTRIBUTION_REVIEW.md) reviews changed commits and keeps its advice in a private dashboard. Its findings do not count as an approving GitHub review. People still make the decisions; the reviewer cannot approve or merge a contribution.

Pull-request diffs may be sent to a third-party model provider for that advisory review. Keep personal data and secrets out of contributions, including deleted lines in a diff. Report vulnerabilities through [the private security route](SECURITY.md).
