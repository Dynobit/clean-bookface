# Help make a place worth coming back to

Start with a small issue or a focused pull request. Explain the behavior a person should see, and how you verified it. Keep the application understandable to the next person who has to run it.

Read [the member guide](docs/GETTING_STARTED.md) to understand the experience we are trying to make easy, and [community stewardship](GOVERNANCE.md) for the path to shared maintenance. The v0.1 public preview welcomes issues and focused pull requests; a public maintainer community has not yet been established.

## Choose a starting point

You do not need to run a server or write code to contribute. Check the [small, scoped priorities](docs/BACKLOG.md#community-priorities) and existing issues before starting; comment with the task you want to take so people can avoid duplicate work. A small documentation correction can go straight to a pull request. Discuss a larger change first, with the user need and a proposed acceptance check.

| Interest             | Start here                                                                              | Useful first result                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Documentation        | [Getting started](docs/GETTING_STARTED.md) and [development setup](docs/DEVELOPMENT.md) | Follow one journey from a clean start and fix a confusing step, stating what you actually tried.                            |
| Accessibility        | [Usability check](docs/USABILITY_CHECK.md) and the fictional demo                       | Reproduce one keyboard, screen-reader or narrow-screen problem; include browser/assistive-tool versions and verify the fix. |
| Testing and imports  | [Development](docs/DEVELOPMENT.md) and `tests/`                                         | Add a small synthetic fixture for a missing case and a behavioral regression test.                                          |
| Security and privacy | [Privacy contract](docs/PRIVACY.md) and [Security](SECURITY.md)                         | Review one access boundary. Report vulnerabilities privately; use public issues for non-sensitive review scope only.        |
| Hosting and recovery | [Installation](docs/INSTALL.md) and [Operations](docs/OPERATIONS.md)                    | Rehearse one documented install or restore on a disposable host and report sanitized results, including failures.           |

## Pick the right branch

`main` is the **v0.1 public preview**. Target v0.1 fixes and its documentation there. Its host administrator can read the running database and media; it is not end-to-end encrypted.

The encrypted successor is separate work in [draft PR #4](https://github.com/Dynobit/clean-bookface/pull/4), on `privacy-next`. Coordinate encrypted-client and protocol work on that PR before branching, and use its current setup and checks. Do not apply v0.1 setup or test counts to that branch. The successor is not production-ready: comments, deletion, moderation, migration, off-site operations and independent human reviews remain unfinished. Passing draft tests is not release approval.

## Send a reviewable change

Keep each pull request focused. Describe the problem, resulting behavior, target branch, checks actually run and anything still unverified. For a visual change, include a fictional-data screenshot and keyboard/mobile observations. For code, run the [development checks](docs/DEVELOPMENT.md#check-a-change); security, import and access changes need behavioral regression coverage. Documentation-only changes should verify commands, links and claims affected by the edit, and state when a procedure has not been exercised.

Review the whole diff, including deleted lines, for personal information before submitting. Do not upload production logs or archives as evidence. A maintainer reviews and merges contributions; submitting work does not grant repository, deployment or member-data access. There is no promised review turnaround. Be kind to other contributors, explain disagreements in terms of the proposed behavior, and leave space for people to decline a task.

## Keep these boundaries

- Use synthetic data only. Never submit your own Facebook download, real conversations, real contact lists, private hostnames, screenshots of member accounts, credentials or local configuration.
- Keep private archive reads and shared publication reads separate. Every media, search, export and federation route must enforce its audience.
- Use Node 24 and follow the [development guide](docs/DEVELOPMENT.md) for local setup and checks. See the operations guide for container and restore checks.
- Add behavioral tests for changed security and import semantics. A test that only searches source text is not evidence of privacy.
- Keep the UI accessible with a keyboard and comfortable on a phone. Do not add remote fonts, tracking, infinite scroll, engagement ranking or bot-posting APIs.
- If an export layout is unsupported, describe its structure using a tiny fictional example. Do not paste a real export into an issue.
- Keep dependencies and generated assets attributable. The banner's generation prompt and origin are recorded in [ARTWORK.md](docs/ARTWORK.md).

Independent maintainers can build and host this source under the MIT license. Review dependency licenses before redistributing a bundled image. The project is unaffiliated with Meta or Facebook.

Maintainers can use the [private daily review workflow](docs/CONTRIBUTION_REVIEW.md) to keep up with new pull requests. It reviews changed commits and keeps its advice in a private dashboard. People still make the decisions; it cannot approve or merge a contribution.

Pull-request diffs may be sent to a third-party model provider for that advisory review. Keep personal data and secrets out of contributions, including deleted lines in a diff. Report vulnerabilities through [the private security route](SECURITY.md).
