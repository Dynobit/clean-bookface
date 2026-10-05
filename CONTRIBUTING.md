# Help make a place worth coming back to

Start with a small issue or a focused pull request. Explain the behavior a person should see, and how you verified it. Keep the application understandable to the next person who has to run it.

Read [the member guide](docs/GETTING_STARTED.md) to understand the experience we are trying to make easy, and [community stewardship](GOVERNANCE.md) for the path to shared maintenance. The v0.1 public preview welcomes issues and focused pull requests; a public maintainer community has not yet been established.

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
