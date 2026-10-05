# The project website

`site/` is the informational website prepared for **cleanbookface.org**. It is
separate from any member circle or temporary pilot. It has no application
server, accounts, archive upload, analytics scripts or external fonts. The page
uses a compact social-network layout, the album logo, a fictional lakeside
cover photograph and real application screenshots made with fictional demo data.
The beginner walkthrough is available directly on the page, with prominent
GitHub links and separate joining and hosting instructions. Hosting providers can still receive connection information.

The owner approved public source and website publication on 5 October 2026.
The page uses v0.1 public-preview copy. Building it locally does not publish it,
configure DNS or change repository visibility. Public repository and website
readbacks remain pending; verify them using the procedure below. This approval
does not open pilot invitations or promise an official hosting service.

## Preview locally

From the repository root:

```sh
node scripts/build-site.mjs
python3 -m http.server 3200 --bind 127.0.0.1 --directory dist-site
```

Open `http://127.0.0.1:3200`. The build needs only Node; it does not install npm
packages. `dist-site/` is ignored build output. The builder copies a fixed list
of seven reviewed HTML, CSS and image files, then writes `.nojekyll` and the
canonical `CNAME`. It never copies the app, repository history, private config,
member data or arbitrary documentation directories. Symlink inputs are refused.

Keep both desktop and phone screenshots visible. Link to the full versions so
people can inspect the actual interface. Update those images only with reviewed
fictional fixtures; never capture an operator's account or an actual member's
archive for this page.

## Approved publication procedure

1. The owner's public release approval is recorded in [Release status](RELEASE.md).
   Review the exact publication contents. The website workflow does not change
   repository visibility.
2. Update the page's release-status wording to reflect what has actually been
   approved. Repository availability and pilot availability are separate: opening
   the source does not mean the pilot is accepting members.
3. In the approved repository, configure GitHub Pages to use **GitHub Actions**.
   Verify the domain's ownership with GitHub and set the custom domain to
   `cleanbookface.org` before pointing DNS at the Pages destination. Configure
   the `github-pages` environment to permit deployment from the reviewed `main`
   branch; add a human reviewer when available and appropriate to stewardship.
4. Use GitHub's current custom-domain instructions for the required DNS records
   and HTTPS checks. Keep the `.com` redirect at the registrar as a separate
   operation. Do not redirect visitors to an unqualified pilot host. The app's
   future `pilot.cleanbookface.org` address is a different service.
5. Manually run **Publish project website after approval** on `main`. It runs
   only for the original repository after it is public. There are no push,
   pull-request or scheduled deployment triggers.
6. Verify HTTPS, the canonical address, the logo favicon, both screenshots,
   keyboard navigation, mobile layout and links at the actual public address.
   Confirm the `.com` redirect separately. A local preview is not this proof.

The workflow gives the build read access to repository contents. Only the
publication job receives Pages write access and the identity token needed for
GitHub's deployment. It uses commit-pinned official
[upload-pages-artifact](https://github.com/actions/upload-pages-artifact) and
[deploy-pages](https://github.com/actions/deploy-pages) actions. See GitHub's
[custom-domain documentation](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site).
No personal access token is needed in the source or workflow.

## Community upkeep

Small copy and design changes can be reviewed like other contributions. A
maintainer must deliberately run the publishing workflow after reviewing the
change. If stewardship moves to another repository or domain, update the
workflow's repository guard, page links and generated `CNAME` together. Domain
renewal and account recovery remain real responsibilities; see
[Governance](../GOVERNANCE.md). A website does not automatically create a team.
