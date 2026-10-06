# The project website

`site/` is the informational website published at **cleanbookface.org**. It is
separate from any member circle or temporary pilot. It has no application
server, accounts, archive upload, analytics scripts or external fonts. The page
uses a compact social-network layout, the album logo, a fictional lakeside
cover photograph and real application screenshots made with fictional demo data.
The beginner walkthrough is available directly on the page, with prominent
GitHub links and separate joining and hosting instructions. Hosting providers can still receive connection information.

The owner approved public source and website publication on 5 October 2026.
The page uses v0.1 public-preview copy. Building it locally does not publish it,
configure DNS or change repository visibility. Public source access is verified.
The initial Cloudflare Pages Free publication served seven reviewed assets from
`46838a8`; all returned HTTP 200 and matched their approved hashes. Both `.org` custom domains
are active over HTTPS, and all four `.com` entrypoints preserve paths and queries
in 301 redirects. Delivered HTML contains no scripts after explicitly disabling
zone RUM. See [Release status](RELEASE.md) for browser-check scope. Publication
does not open pilot invitations or promise an official member-hosting service.

The current page keeps the v0.1 screenshots and includes a community starting
point, a link to the separate encrypted draft and share-preview metadata using
the existing fictional cover image. Keep its release distinction and the
README's distinction in sync: the encrypted draft is not a released upgrade.

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

## Publish with Cloudflare Pages

The production publishing route is a manual Direct Upload to the existing
`clean-bookface` Pages project (`clean-bookface.pages.dev`), on the Free plan.
No paid upgrade or repository integration credential is needed. The attempted
GitHub Pages publisher, run `37366344620`, failed before any steps ran because
a hosted runner was unavailable during the GitHub Actions incident. It did not
publish the website.

1. Review the exact source revision and page wording, then run
   `node scripts/build-site.mjs`. Prepare an upload directory containing only
   these seven files, preserving their paths:
   - `index.html`
   - `styles.css`
   - `favicon.svg`
   - `assets/album-mark.svg`
   - `assets/cover-weekend.png`
   - `assets/feed-desktop.png`
   - `assets/feed-mobile.png`
2. Exclude `CNAME` and `.nojekyll`: the builder writes them for GitHub Pages
   compatibility. Never upload the repository, archives, credentials, private
   configuration or application data. Record the source revision and SHA-256
   hashes of the seven approved files.
3. Use Cloudflare Pages Direct Upload to deploy that directory to the existing
   project's production environment. Review the target account and project
   before publishing. Keep deployment credentials outside source and logs.
4. Configure the canonical `cleanbookface.org` address through the project's
   custom-domain settings, verifying ownership and the required DNS destination.
   Check any `www` forwarding and the separate `.com` redirect. None should send
   visitors to an unqualified pilot; member circles are separate services.
5. Read back all seven deployed assets and compare their content hashes with
   the approved files. Verify HTTPS on the provider and canonical addresses,
   redirects, favicon, screenshots, links, keyboard navigation and mobile layout.
   Explicitly disable zone RUM (Real User Monitoring), even if an initial
   dashboard view shows disabled/default, and confirm the delivered page has no
   injected analytics or tracking scripts.
   A successful upload or local preview alone is not this proof.

## Optional GitHub Pages alternative

The retained **Publish project website after approval** workflow is an opt-in
alternative, not the production publisher. The workflow is disabled and the
unused GitHub Pages site has been removed. Keep it disabled while Cloudflare
serves the project. Before enabling it, review its repository guard and exact
source, configure GitHub Pages and domain ownership, and coordinate the DNS
migration with HTTPS and redirect readbacks. Do not enable competing publishers
for the same canonical domain. Its manual deployment uses GitHub's Pages
permissions; Cloudflare credentials do not belong in that workflow.

## Community upkeep

Small copy and design changes can be reviewed like other contributions. A
maintainer deliberately builds, reviews and uploads each website update, then
checks the served files. If stewardship moves, transfer the Pages project and
domain responsibilities through the providers' supported processes and update
page links and publishing configuration. Domain renewal and account recovery
remain real responsibilities; see [Governance](../GOVERNANCE.md). A website does
not automatically create a team.
