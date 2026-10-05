import { Core, type User, type Post, type Session } from './core.js';
import { Archive, type ArchiveItem } from './archive.js';
import { esc as e, csrf, hidden, field, avatar, date, empty, heading } from './views.js';

export function hostSetupScreen(status: {
  origin: string;
  backupAt: string | null;
  imported: boolean;
  friends: number;
  federation: boolean;
}): string {
  return (
    heading('Make this circle yours', 'One step at a time') +
    `<div class="card card-pad"><p>Your first account is ready. This is your checklist for bringing the circle into use.</p><ol><li><h2>Check your address</h2><p>Configured address: <strong>${e(status.origin)}</strong>. Open it from another device and confirm the secure connection works. This page cannot verify public DNS or certificate renewal.</p></li><li><h2>Keep a way back</h2><p>${status.backupAt ? `A successful backup was recorded ${e(date(status.backupAt))}.` : 'No successful backup has been recorded yet.'} A backup receipt does not prove a restore. Follow the walkthrough and check the restored copy before inviting friends.</p><p><a class="button secondary" href="/admin/backups">Set up backups</a></p></li><li><h2>Try one private memory</h2><p>${status.imported ? 'Your account has imported memories. Review their import report and check a photo.' : 'Start with a small, disposable example, then bring your Facebook download when you are comfortable.'} Importing does not publish anything.</p><p><a href="/getting-started">How to download your Facebook information</a> · <a href="/imports">Bring your history</a> · <a href="/settings">Download your data</a></p></li><li><h2>Invite one friend</h2><p>${status.friends ? 'You have an accepted friendship.' : 'Your account has no accepted friendships yet.'} After testing your backup, invite someone you know. Share a fictional post, then remove it and check that access is gone.</p><p><a class="button secondary" href="/friends">Friends and invitations</a></p></li></ol><hr><p>Connections to other hosts are ${status.federation ? 'enabled' : 'off'}. People on this circle can use it without connecting another server.</p><details><summary>Looking after the server</summary><p>You are responsible for updates, storage, backups and the hosting bill. The website does not schedule backups or verify your restore exercise. Keep the <a href="https://github.com/Dynobit/clean-bookface/blob/main/docs/HOST_YOUR_CIRCLE.md" rel="noreferrer">hosting guide</a> nearby. If a command stops, run <code>./setup status</code> from your server’s project folder; keep setup codes and private logs out of support requests.</p></details></div>`
  );
}

export function backupGuideScreen(status: {
  origin: string;
  lastBackupAt: string | null;
  lastBackupSnapshot: string | null;
  restorePending: boolean;
}): string {
  const code = (text: string) =>
    `<pre style="overflow:auto;white-space:pre;font-size:.8rem"><code>${e(text)}</code></pre>`;
  const shell = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  const recorded = status.lastBackupAt
    ? `<p><strong>Latest successful backup:</strong> <time datetime="${e(status.lastBackupAt)}">${e(status.lastBackupAt)}</time></p>${status.lastBackupSnapshot ? `<p>Snapshot: <code>${e(status.lastBackupSnapshot)}</code></p>` : ''}<p>This records a completed backup command and repository check. It does not prove that a replacement host has been restored successfully.</p>`
    : '<p class="notice">No successful backup has been recorded. Complete the first backup and a restore practice run before trusting this circle with real memories.</p>';
  return (
    heading('Back up your circle', 'A way back, before you need it') +
    `<div class="card card-pad"><p>Follow these five steps on the server you operate. The website shows recorded backup status; it does not run host commands or receive backup passwords.</p>${recorded}${status.restorePending ? '<p class="notice error">This copy is awaiting current-state reconciliation. Account and sharing access remain closed.</p>' : ''}<p><a href="#backup-step-1">Start with storage</a> · <a href="#backup-step-2">Keep your recovery secrets</a> · <a href="#backup-step-3">Make a backup</a> · <a href="#backup-step-4">Practise restoring</a> · <a href="#backup-step-5">Keep it working</a></p></div>` +
    `<section class="card card-pad" id="backup-step-1"><h2>1. Give your memories a durable home</h2><p>Your circle’s permanent address is <strong>${e(status.origin)}</strong>. Keep that exact address when restoring or moving the whole installation. Keep its data on a private, local disk or persistent volume, with enough spare space for a database copy and media if hard links are unavailable.</p><p>Put the backup repository on a separate disk or remote backup destination. A second folder on the same disk is useful for a practice run, but it will not survive that disk failing. The running host can read its database; encrypted backups do not change that.</p><details><summary>Commands for an installation running directly on the host</summary><p>Run commands from the built application directory. Replace the example data and storage paths with yours, and keep these environment values for the following steps. Install the documented restic version first.</p>${code(`export APP_ORIGIN=${shell(status.origin)}
export DATA_DIR=/data/bookface
export RESTIC_REPOSITORY=/backup/bookface
export RESTIC_PASSWORD_FILE=/secure/bookface/restic-password
export RECOVERY_PASSWORD_FILE=/secure/bookface/recovery-password`)}</details><details><summary>Using the supplied Docker Compose installation</summary><p>The supplied Compose file keeps application data in its named <code>app_data</code> volume at <code>/data</code>. Keep that volume. Do not use <code>docker compose down --volumes</code> to stop the app. The container already includes restic.</p><p>Create private host directories outside the repository. These examples use the image’s user ID 1000; choose your backup disk’s mounted path before running them.</p>${code(`sudo install -d -o 1000 -g 1000 -m 700 /srv/bookface-recovery /mnt/bookface-backups
docker compose run --rm --no-deps \\
  --volume /srv/bookface-recovery:/secure app \\
  node dist/cli.js init-backup-secrets --directory /secure`)}<p>For backup commands, save this nonsecret configuration as <code>backup.override.yaml</code> beside your Compose file. It reuses the existing application volume and mounts the recovery files read-only.</p>${code(`services:
  app:
    environment:
      RESTIC_REPOSITORY: /backup/bookface
      RESTIC_PASSWORD_FILE: /secure/restic-password
      RECOVERY_PASSWORD_FILE: /secure/recovery-password
    volumes:
      - /srv/bookface-recovery:/secure:ro
      - /mnt/bookface-backups:/backup`)}<p>Use the following prefix in place of <code>node dist/cli.js</code> in the steps below. Keep <code>APP_DOMAIN</code> in your existing private Compose environment. For a restore practice run, also mount a separate empty host directory at the restore target; never replace the live <code>app_data</code> volume.</p>${code(`docker compose -f compose.yaml -f backup.override.yaml \\
  run --rm --no-deps app node dist/cli.js`)}</details></section>` +
    `<section class="card card-pad" id="backup-step-2"><h2>2. Save two independent recovery secrets</h2><p>One secret unlocks the backup repository. The other unlocks the protected account credentials and signing keys inside the backup. Keep offline copies of both, separately from the repository. Losing either prevents a complete recovery.</p><details><summary>Create the files and initialize the encrypted repository</summary><p>For a direct host installation, run the first command once. Compose users already created these files in step 1 and should skip it. Both files must be owned by the application’s operating-system user, with permission mode <code>600</code>.</p>${code(`node dist/cli.js init-backup-secrets --directory /secure/bookface
node dist/cli.js backup-init`)}<p>The creation command refuses to overwrite existing secrets. Never paste their contents into this page, a command-line argument, a support request or the source repository. Remote repositories use the provider’s documented environment variables on the host.</p></details></section>` +
    `<section class="card card-pad" id="backup-step-3"><h2>3. Make your first backup during a quiet window</h2><p>Tell members the circle will be briefly unavailable. Stop only this application cleanly, run the backup, then start it again. This release takes backups while the application is stopped; duration depends on archive size and storage. The command refuses to run against a live installation.</p><details><summary>Backup commands and the result to look for</summary>${code(`# Stop the application with your normal service controls first.
node dist/cli.js backup
# Restart the application after the command finishes.`)}<p>For Compose, stop with <code>docker compose stop app</code>, run <code>backup</code> with the step 1 Compose prefix, and restart with <code>docker compose start app</code>. Restart after a failure too, and investigate the failed backup before relying on it.</p><p>On a managed provider that immediately restarts stopped processes, set <code>MAINTENANCE_MODE=true</code> and redeploy. This serves a maintenance page without opening the database or its lock. Wait for the previous application process to stop, then open the running service’s shell with its existing persistent volume to run the backup CLI. A separate one-off job may not have that disk. Finally set <code>MAINTENANCE_MODE=false</code> and redeploy, even if the backup failed. A maintenance health response is not a backup receipt.</p><p>A successful command returns a snapshot ID and backup ID. Reload this page after the app restarts: the recorded time and snapshot should have changed. A failed command never records a successful backup time. Keep enough space for staging; never remove the installation lock just to bypass an error.</p></details></section>` +
    `<section class="card card-pad" id="backup-step-4"><h2>4. Practise coming back on a fresh host</h2><p>A saved backup is only half the job. Restore a chosen snapshot into an empty directory, apply the latest account and deletion state, and check a private photo and a revoked friend’s denied access. This page does not record a restore practice run as verified.</p><details><summary>Restore and reconciliation commands</summary><p>Take the snapshot first, then export a strictly newer ledger from the stopped original source. It must match that installation’s permanent address and identity; a fresh installation at the same address cannot replace it. Choose a new output filename for each capture and retain it independently from the host. On the replacement, configure the same origin, repository and both secrets from steps 1–2.</p>${code(`# On the stopped source; keep this encrypted file separately.
node dist/cli.js reconciliation-export \\
  --output /secure/bookface/current-state.enc

# On the replacement, using an empty destination.
node dist/cli.js restore \\
  --target /data/bookface-restored --snapshot SNAPSHOT_ID
DATA_DIR=/data/bookface-restored node dist/cli.js reconcile \\
  --ledger /secure/bookface/current-state.enc`)}<p>Replace <code>SNAPSHOT_ID</code> with the completed snapshot you recorded. With Compose, use these commands instead; only the ledger capture mounts the secret directory writable. The restore target is a separate host directory, not the live application volume.</p>${code(`docker compose stop app
docker compose -f compose.yaml -f backup.override.yaml \\
  run --rm --no-deps --volume /srv/bookface-recovery:/secure app \\
  node dist/cli.js reconciliation-export --output /secure/current-state.enc

sudo install -d -o 1000 -g 1000 -m 700 /srv/bookface-restore
docker compose -f compose.yaml -f backup.override.yaml \\
  run --rm --no-deps --volume /srv/bookface-restore:/restore app \\
  node dist/cli.js restore --target /restore/practice --snapshot SNAPSHOT_ID
docker compose -f compose.yaml -f backup.override.yaml \\
  run --rm --no-deps --volume /srv/bookface-restore:/restore \\
  --env DATA_DIR=/restore/practice app node dist/cli.js reconcile \\
  --ledger /secure/current-state.enc`)}<p>A restored copy blocks account and content access until reconciliation succeeds. A backup recovery bundle is not a current-state ledger. Legacy unbound backups remain paused. Reconciliation invalidates old sessions, invitations, recovery codes and unfinished uploads; create a new bound backup and prove a restore after upgrading. If the freshest deletion state is unavailable, keep it closed. Start only one installation with this identity, on an isolated practice host or during a planned cutover; do not connect two live copies to friends. Sign in with current credentials, check owner-only history and a revoked recipient, then replace account recovery codes in settings.</p></details></section>` +
    `<section class="card card-pad" id="backup-step-5"><h2>5. Make backups routine, and notice failures</h2><p>Schedule the stop–backup–restart sequence daily with your host’s scheduler and failure reporting. Always restart the app after the attempt. Monitor both the command’s exit status and this page’s recorded time. No scheduler is installed or verified by this guide.</p><details><summary>Retention and repository checks</summary><p>After a successful new backup, keep the last successful snapshot and the previous 30 days, then check the repository. Run these with the same restic environment and mounted repository; in Compose, replace <code>node dist/cli.js</code> in the prefix with <code>restic</code>.</p>${code(`restic forget --tag clean-bookface-v1 --group-by host,tags \\
  --keep-within 30d --keep-last 1 --prune
restic check --read-data`)}<p>The last snapshot remains if backups stop. Older copies disappear only after successful pruning, and other provider snapshots have their own retention. Repeat the restore practice after upgrades or storage changes. A green timestamp is a backup receipt, not a promise that recovery has been tested.</p></details><p><a href="/admin">Back to host tools</a></p></section>`
  );
}

export function recoveryScreen(codes: string[]): string {
  return `<div class="card card-pad"><h1>Keep a way back in.</h1><p>Save these recovery codes somewhere private. Each code works once. You’ll need one if you forget your password.</p><div class="codes">${codes.map((c) => `<code>${e(c)}</code>`).join('')}</div><p class="info">This is the only time we show these codes. Your host cannot retrieve them for you.</p><a class="button" href="/">I’ve saved my codes</a></div>`;
}
export function audiencePicker(
  core: Core,
  user: User,
  token: string,
  defaults: string[] = [],
): string {
  return `<div class="field"><label for="audience">Who should see this?</label><select name="audience" id="audience"><option value="private">Only me</option><option value="friends">My current friends</option><option value="selected">Friends I select below</option></select></div><details><summary>Choose particular friends</summary><p class="muted">Used when you choose “Friends I select below.” New friends won’t gain access to older posts.</p>${
    core
      .friends(user.id)
      .map(
        (f) =>
          `<label class="check"><input type="checkbox" name="recipientActors" value="${e(f.actor)}" ${defaults.includes(f.actor) ? 'checked' : ''}>${e(f.name)}</label>`,
      )
      .join('') || '<p>No accepted friends yet. Your post can stay private.</p>'
  }</details><p class="muted"><small>People you share with can save a copy. Their host can access that copy too.</small></p>`;
}
export function renderPost(p: Post, user: User, token: string, detail = false): string {
  const owned = p.authorId === user.id;
  return `<article class="card" aria-label="Post by ${e(p.authorName)}"><header class="post-header">${avatar(p.authorName)}<div><strong>${e(p.authorName)}</strong><small><a href="/posts/${encodeURIComponent(p.id)}">${e(date(p.createdAt))}</a> · <span class="badge ${p.audience === 'private' ? 'private' : ''}">${p.audience === 'private' ? 'Only you' : 'Shared with chosen friends'}</span></small></div></header><div class="post-body">${e(p.body)}</div>${p.mediaIds.length ? `<div class="post-photos ${p.mediaIds.length === 1 ? 'single' : ''}">${p.mediaIds.map((id, i) => `<a href="/posts/${encodeURIComponent(p.id)}/media/${encodeURIComponent(id)}"><img loading="lazy" src="/posts/${encodeURIComponent(p.id)}/media/${encodeURIComponent(id)}" alt="Photo ${i + 1} shared by ${e(p.authorName)}"></a>`).join('')}</div>` : ''}<div class="post-tools"><form method="post" action="/actions/posts/${encodeURIComponent(p.id)}/like">${csrf(token)}${hidden('enabled', p.liked ? 'false' : 'true')}<button class="text-button">${p.liked ? 'Unlike' : 'Like'}${p.likes ? ` · ${p.likes}` : ''}</button></form><a href="/posts/${encodeURIComponent(p.id)}#comment">Comment${p.comments.length ? ` · ${p.comments.length}` : ''}</a>${owned ? `<a href="/posts/${encodeURIComponent(p.id)}/edit">Edit & audience</a>` : `<a href="/report?actor=${encodeURIComponent(p.authorActor)}&post=${encodeURIComponent(p.id)}">Report</a>`}</div>${(detail ? p.comments : p.comments.slice(-2)).map((c) => `<div class="comment"><strong>${e(c.authorName)}</strong> <small>${e(date(c.createdAt))}</small><p>${e(c.body)}</p>${c.actor === user.actor || owned ? `<form method="post" action="/actions/comments/${encodeURIComponent(c.id)}/delete">${csrf(token)}${hidden('postId', p.id)}<button class="text-button">Remove comment</button></form>` : ''}</div>`).join('')}${detail ? `<form class="card-pad" method="post" action="/actions/posts/${encodeURIComponent(p.id)}/comment" id="comment">${csrf(token)}<label for="comment-body">Leave a comment</label><textarea id="comment-body" name="body" maxlength="5000" required></textarea><button type="submit">Comment</button><small> Visible to the post’s audience.</small></form>` : ''}</article>`;
}
export function feedScreen(
  core: Core,
  user: User,
  token: string,
  query: string,
  favorites: boolean,
  before?: number,
  beforeId?: string,
): string {
  const posts = core.feed(user.id, {
    query,
    favoritesOnly: favorites,
    before,
    beforeId,
    limit: 20,
  });
  return (
    heading('News feed', 'A little catch-up') +
    `<form class="card composer" method="post" action="/actions/posts">${csrf(token)}<div class="card-head">Share a little of your day</div><label class="sr-only" for="compose">Write a post</label><textarea id="compose" name="body" placeholder="What would you like your friends to know?" maxlength="20000" required></textarea><div class="composer-bottom"><a href="/compose">▧ Add photos & choose friends</a><label class="sr-only" for="quick-audience">Audience</label><select id="quick-audience" name="audience"><option value="private">Only me</option><option value="friends">Current friends</option></select><button type="submit">Post</button></div></form><form class="search-row" method="get" action="/"><label class="sr-only" for="q">Search posts you can see</label><input id="q" name="q" placeholder="Search your feed" value="${e(query)}"><label class="sr-only" for="filter">Feed filter</label><select name="filter" id="filter"><option value="all">All friends</option><option value="favorites" ${favorites ? 'selected' : ''}>Favorites</option></select><button class="secondary">Filter</button></form>` +
    (posts.map((p) => renderPost(p, user, token)).join('') ||
      empty(
        'A quieter kind of feed.',
        'Invite a friend or write a first post. Your archive stays private until you choose a memory to share.',
        '<a class="button secondary" href="/friends">Find your people</a>',
      )) +
    `<div class="caught-up">${posts.length === 20 ? `<a class="button secondary" href="/?before=${posts.at(-1)!.createdAt}&beforeId=${encodeURIComponent(posts.at(-1)!.id)}&q=${encodeURIComponent(query)}&filter=${favorites ? 'favorites' : 'all'}">Older posts</a>` : '<strong>You’re all caught up.</strong>There’s a whole world outside this feed.'}</div>`
  );
}
export function composeScreen(
  core: Core,
  user: User,
  token: string,
  options: { body?: string; mediaIds?: string[]; archiveId?: string; maxPhotoBytes?: number } = {},
): string {
  return (
    heading('Share something', 'On your terms') +
    `<div class="card card-pad"><form method="post" action="/actions/posts">${csrf(token)}${options.archiveId ? hidden('archiveSourceId', options.archiveId) : ''}<div class="field"><label for="body">Your words</label><textarea id="body" name="body" maxlength="20000" rows="5">${e(options.body ?? '')}</textarea></div>${(options.mediaIds ?? []).map((id) => hidden('mediaIds', id)).join('')}${options.mediaIds?.length ? `<div class="photo-grid">${options.mediaIds.map((id) => `<img src="/media/${encodeURIComponent(id)}" alt="Photo selected for sharing">`).join('')}</div><p class="info">These sharing copies have their embedded metadata removed. Original files remain private.</p>` : ''}${audiencePicker(core, user, token)}<button type="submit">Publish this copy</button> <a href="/">Cancel</a></form></div><div class="card card-pad"><h2>Start with a photo</h2><p>Choose up to twelve photos (up to ${Math.floor((options.maxPhotoBytes ?? 128 * 1024 ** 2) / 1024 ** 2)} MiB together). Keep them together as an album, add a title in your words, and choose the audience before posting.</p><form method="post" action="/actions/photo" enctype="multipart/form-data" data-upload>${csrf(token)}<label class="sr-only" for="native-photo">Choose photos</label><input class="file-input" id="native-photo" type="file" name="files" accept="image/jpeg,image/png,image/webp" multiple required><p role="status" aria-live="polite"></p><button type="submit" class="secondary">Preview photos</button></form></div>`
  );
}
export function archiveCard(item: ArchiveItem): string {
  return `<article class="card"><div class="card-head row spread"><span>${e(item.title || { post: 'A memory', photo: 'A photo', album: 'An album', message: 'Private conversation', friend: 'Friend record', profile: 'Profile record' }[item.kind])}</span><span class="badge private">Only you</span></div><div class="card-pad"><small>${e(date(item.occurredAt))} · ${e(item.kind)}</small><p style="white-space:pre-wrap;overflow-wrap:anywhere">${e(item.body.slice(0, 900))}${item.body.length > 900 ? '…' : ''}</p>${
    item.mediaIds.length
      ? `<div class="photo-grid">${item.mediaIds
          .slice(0, 3)
          .map(
            (id) =>
              `<img src="/media/${encodeURIComponent(id)}" loading="lazy" alt="Private archive photo">`,
          )
          .join('')}</div>`
      : ''
  }<a href="/archive/${encodeURIComponent(item.id)}">Open memory →</a></div></article>`;
}
export function archiveScreen(
  archive: Archive,
  user: User,
  query: string,
  kind: string,
  offset: number,
): string {
  const items = archive.list(user.id, {
    query,
    kind: (kind as never) || undefined,
    offset,
    limit: 25,
  });
  return (
    heading(
      'Your memories',
      'Private. Always, until you say otherwise.',
      '<a class="button secondary small" href="/imports">Import history</a>',
    ) +
    `<form class="search-row"><label class="sr-only" for="archive-q">Search private archive</label><input id="archive-q" name="q" value="${e(query)}" placeholder="Find a memory…"><label class="sr-only" for="kind">Category</label><select id="kind" name="kind"><option value="">All memories</option>${['post', 'photo', 'album', 'message', 'friend', 'profile'].map((k) => `<option value="${k}" ${kind === k ? 'selected' : ''}>${e(k[0].toUpperCase() + k.slice(1))}</option>`).join('')}</select><button class="secondary">Search</button></form>` +
    (items.map(archiveCard).join('') ||
      empty(
        'Your memories belong here.',
        'Bring your Facebook JSON export, including its photos. Importing won’t publish anything.',
        '<a class="button" href="/imports">Bring your history</a>',
      )) +
    (items.length === 25
      ? `<a class="button secondary" href="/archive?offset=${offset + 25}&q=${encodeURIComponent(query)}&kind=${encodeURIComponent(kind)}">More memories</a>`
      : '')
  );
}
export function archiveDetail(
  item: ArchiveItem,
  token: string,
  linkedCount = 0,
  media: Array<{ id: string; mime: string }> = [],
): string {
  const images = media.filter((m) => m.mime.startsWith('image/'));
  const canShare = ['post', 'photo'].includes(item.kind);
  const confirmation = (label: string) =>
    `<label class="check"><input type="checkbox" name="confirmed" required>${e(label)}</label>`;
  return (
    heading(item.title || 'Your private memory', `${item.kind} · ${date(item.occurredAt)}`) +
    `<div class="card card-pad"><span class="badge private">Only you</span><p style="white-space:pre-wrap;overflow-wrap:anywhere">${e(item.body)}</p><div class="photo-grid">${item.mediaIds.map((id, i) => (media.find((m) => m.id === id)?.mime.startsWith('image/') ? `<figure style="margin:0"><a href="/media/${encodeURIComponent(id)}"><img src="/media/${encodeURIComponent(id)}" alt="Private photo ${images.findIndex((m) => m.id === id) + 1}"></a><figcaption>Photo ${images.findIndex((m) => m.id === id) + 1}</figcaption></figure>` : `<p><a href="/media/${encodeURIComponent(id)}">Download private attachment ${i + 1}</a></p>`)).join('')}</div>${canShare ? `<hr><form method="post" action="/actions/archive/${encodeURIComponent(item.id)}/prepare">${csrf(token)}${hidden('selectionPresent', 'true')}<p>You’ll review a separate copy and choose its audience. Your original stays private.</p>${images.length ? `<fieldset><legend>Photos for your copy — choose up to 8</legend><p>Leave every box clear to share only the text.</p>${images.map((m, i) => `<label class="check"><input type="checkbox" name="mediaIds" value="${e(m.id)}" ${images.length <= 8 ? 'checked' : ''}>Photo ${i + 1}</label>`).join('')}</fieldset>` : ''}${media.some((m) => !m.mime.startsWith('image/')) ? '<p class="info">Videos and other attachments stay in your private archive. This version shares photos and text.</p>' : ''}<button>Prepare a copy to share</button></form>` : '<p class="info">This record stays in your private archive. Conversations, friend lists and other people’s metadata cannot be published through this screen.</p>'}<details><summary>Import details</summary><p>Version ${item.version} · Imported ${e(date(item.importedAt))}</p><p>Source: ${e(item.source)}</p><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${e(JSON.stringify(item.metadata, null, 2))}</pre></details><hr><p>${linkedCount} linked shared ${linkedCount === 1 ? 'copy' : 'copies'}.</p><form method="post" action="/actions/archive/${encodeURIComponent(item.id)}/delete">${csrf(token)}${confirmation('Delete this memory and its linked shared copies. Removal from remote hosts will be requested.')}<button class="danger small">Delete memory & linked shares</button></form>${linkedCount ? `<form method="post" action="/actions/archive/${encodeURIComponent(item.id)}/delete">${csrf(token)}${hidden('archiveOnly', 'true')}${confirmation('Delete only the private original and keep its shared copies.')}<button class="text-button">Remove only the private original</button></form>` : ''}</div>`
  );
}

export function gettingStartedScreen(): string {
  return (
    heading('Getting started', 'Bring your memories at your own pace') +
    `<section class="card card-pad prose"><h2>1. Save your own Facebook export</h2><p>If you have a Facebook account, you can request your own export through Facebook. You need access to that account and may need to log in again. An export is not guaranteed to include everything. Never enter your Facebook password here.</p><ol><li>In Facebook or Meta Accounts Center (or Meta Account if updated), look for <strong>Your information and permissions → Export your information</strong> (sometimes called <strong>Download your information</strong>). Menu labels may vary.</li><li>Choose your Facebook profile and export to your device.</li><li>Choose <strong>JSON, not HTML</strong>. Choose <strong>All time</strong> if you want the full available date range, and select your preferred media quality.</li><li>Wait for Facebook to prepare the export, then download <strong>all parts</strong>.</li><li>Keep a private original backup somewhere independent of this circle before uploading. Check that the files open and include the memories you want to keep.</li></ol><p><a href="https://www.facebook.com/help/212802592074644">Facebook’s download help</a> · <a href="https://about.fb.com/news/2026/04/meta-account/">Meta’s account menu update</a></p></section>` +
    `<section class="card card-pad prose"><h2>2. Join a circle you trust</h2><p>Ask a friend for a joining invitation, open it, and create your account. You only need a browser: no terminal, provider account or payment details. Save your recovery codes privately.</p><p>Your host can read the database and files stored here. Choose someone you trust with your archive, including private messages.</p></section>` +
    `<section class="card card-pad prose"><h2>3. Import privately and check the result</h2><p>Open <a href="/imports">Bring your history</a> after joining. For a split export, select one folder containing all ZIP parts, or one containing all extracted parts. Keep ZIPs and extracted files separate. This helps preserve references between records and photos. Folder upload needs JavaScript; a single ZIP works without it. If the whole export exceeds the displayed upload limit, ask your host or request a smaller date range from Facebook. Keep your original downloads: an import is not a complete replacement for them.</p><p>Importing does not publish anything. Review each import report for skipped or unsupported records and missing media. Check a few posts, photos and conversations against your originals before relying on the imported archive.</p></section>` +
    `<section class="card card-pad prose"><h2>4. Choose what to share</h2><p>Choose an audience when you publish a copy: private, current friends or selected friends. Friends can save what you share.</p><p>Invite friends manually using a link through a channel you already use. There is no automatic Facebook friend matching or contact upload to find people. Imported friend records do not create friendships.</p></section>` +
    `<section class="card card-pad prose" id="facebook-options"><h2>5. Decide about Facebook — only if you want to</h2><p>You can keep Facebook, temporarily deactivate it, or request account deletion there. None of these is required to use this circle. Clean Bookface cannot deactivate or delete your Facebook account. Deleting your account here does not delete Facebook.</p><details><summary>Before deactivating or deleting Facebook</summary><p>First save and verify your original exports independently of this import. Set up alternative logins for services where you use Login with Facebook, and review any Messenger or Page administrator dependencies.</p><p>In Meta Accounts Center (or Meta Account if updated), look for <strong>Personal details → Account ownership and control → Deactivation or deletion</strong>. Menu labels may vary. Select your Facebook profile, not your whole Meta Account, and read Facebook’s current confirmation carefully. You make the request at Facebook, never here.</p><p>Deactivation is a temporary option; deletion is a separate request. Availability, cancellation windows and deletion timing may vary: use Meta’s current confirmation, not a fixed deadline from this guide. Neither option promises instant or complete erasure. Messages held by recipients, backups and records retained by Meta may persist.</p><p><a href="https://www.facebook.com/help/214376678584711">Facebook’s deactivation help</a> · <a href="https://www.facebook.com/help/224562897555674">Facebook’s account deletion help</a></p></details><p><a href="/login">Log in to your circle</a></p></section>`
  );
}

export function importsScreen(
  archive: Archive,
  user: User,
  token: string,
  maxBytes: number,
  maxDirectBytes = maxBytes,
): string {
  const jobs = archive.jobs(user.id);
  return (
    heading('Bring your history', 'Your memories, back in your hands') +
    `<div class="card card-pad prose"><h2>Start with a Facebook export</h2><p><a href="/getting-started">Getting started: save, import and share at your own pace</a></p><p>Moving from another Clean Bookface host? Upload your exported ZIP here too. It comes back as a private archive; friends and sharing permissions are not imported.</p><ol><li>Request your own export in Facebook’s Accounts Center (or Meta Account if updated) under <strong>Your information and permissions → Export or download your information</strong>. Menu labels may vary; account access and login are required. Never enter your Facebook password here.</li><li>Choose Facebook, export to your device, and select <strong>JSON, not HTML</strong>. Choose <strong>All time</strong> if desired and your preferred media quality.</li><li>Wait until it is ready, download <strong>all parts</strong>, and keep a private original backup first. An export may not include everything.</li></ol><p>After importing, review the report for skips, unsupported records and missing media. Your host can read stored data. Sharing and inviting friends are separate choices.</p><p class="info">Posts, photos, albums, profile and friend records are imported privately. Message history stays private too. Unsupported records appear in the import report.</p><form method="post" action="/api/imports" enctype="multipart/form-data" data-upload>${csrf(token)}<div class="field"><label for="zip-files">Upload a ZIP export</label><input class="file-input" type="file" name="files" id="zip-files" accept=".zip,application/zip" required></div><p><small>Up to ${Math.floor(maxBytes / 1024 ** 2)} MiB per upload with JavaScript. Uploads can resume for 24 hours if you return to this page and choose the same files. Without JavaScript, a single ZIP must be under ${Math.floor(maxDirectBytes / 1024 ** 2)} MiB, including the upload form. For split exports, use the folder option below with all parts together.</small></p><p role="status" aria-live="polite"></p><button type="submit">Import privately</button> <button type="button" class="secondary" data-cancel-upload hidden style="display:none">Cancel unfinished upload</button></form><details><summary>Have several ZIPs or an extracted folder?</summary><form method="post" action="/api/imports" enctype="multipart/form-data" data-upload>${csrf(token)}<label for="folder-files">Select the whole export folder</label><input class="file-input" type="file" name="files" id="folder-files" webkitdirectory multiple required><p role="status" aria-live="polite"></p><button type="submit" class="secondary">Import folder privately</button> <button type="button" class="secondary" data-cancel-upload hidden style="display:none">Cancel unfinished upload</button></form><p><small>Choose a folder containing all ZIP parts, or all extracted parts; do not mix the two. Folder upload uses JavaScript to preserve paths. A single ZIP also works without JavaScript.</small></p></details></div><h2>Import history</h2>${jobs.some((j) => ['running', 'queued'].includes(j.status)) ? '<p class="notice" data-running-import role="status">Your import is queued or running. You can leave this page.</p>' : ''}${jobs.map((j) => `<div class="card card-pad"><div class="row spread"><strong>${e(j.status[0].toUpperCase() + j.status.slice(1))}</strong><small>${e(date(j.createdAt))}</small></div><p>${j.completedFiles} of ${j.totalFiles} files processed</p>${j.report ? `<p>${j.report.added} new · ${j.report.revised} revised · ${j.report.unchanged} unchanged · ${j.report.skipped} skipped · ${j.report.failed} failed</p><details><summary>Import report</summary><ul>${j.report.warnings.map((w) => `<li>${e(w)}</li>`).join('') || '<li>No warnings.</li>'}</ul></details>` : ''}${j.error ? `<p class="notice error">${e(j.error)}</p>` : ''}${['queued', 'running'].includes(j.status) ? `<form method="post" action="/actions/imports/${encodeURIComponent(j.id)}/cancel">${csrf(token)}<button class="secondary small">Cancel import</button></form>` : ''}</div>`).join('') || '<p class="muted">No imports yet. Nothing has been uploaded.</p>'}`
  );
}
export function friendsScreen(core: Core, user: User, token: string, federation: boolean): string {
  const friends = core.friends(user.id),
    pending = core.pendingFriends(user.id);
  return (
    heading(
      'Your people',
      'Real friends. Mutual choice.',
      '<a class="button secondary small" href="/sharing">Sharing activity</a>',
    ) +
    `<div class="card card-pad"><h2>Invite someone you know</h2><p>A joining invitation creates an account here. A friendship invitation connects two existing accounts here. Neither uploads a contact list.</p><div class="row wrap"><form method="post" action="/actions/invites">${csrf(token)}${hidden('kind', 'registration')}<button>Create joining invitation</button></form><form method="post" action="/actions/invites">${csrf(token)}${hidden('kind', 'friendship')}<button class="secondary">Create friendship invitation</button></form></div></div><div class="card card-pad"><h2>Already have their profile link?</h2><form method="post" action="/actions/friends/request">${csrf(token)}${field('Profile URL' + (federation ? ' or @name@host' : ''), 'actor', 'text', 'required placeholder="https://friends.example/users/alex"')}<button class="secondary">Send a friend request</button></form><p><small>${federation ? 'Independent hosts are supported when both use Clean Bookface and enable connections.' : 'Your host has not enabled connections to other servers. Local profile links work here.'} Both people must accept before sharing.</small></p></div>${pending.length ? `<h2>Requests</h2>${pending.map((f) => `<div class="card card-pad"><strong>${e(f.name)}</strong><p class="muted">${f.direction === 'incoming' ? 'Would like to be friends.' : 'Waiting for their answer.'}</p><div class="row">${f.direction === 'incoming' ? `<form method="post" action="/actions/friends/${encodeURIComponent(f.id)}/accept">${csrf(token)}<button>Accept</button></form><form method="post" action="/actions/friends/${encodeURIComponent(f.id)}/reject">${csrf(token)}<button class="secondary">Decline</button></form>` : `<form method="post" action="/actions/friends/${encodeURIComponent(f.id)}/cancel">${csrf(token)}<button class="secondary">Cancel request</button></form>`}</div></div>`).join('')}` : ''}<h2>Friends · ${friends.length}</h2>${friends.map((f) => `<div class="card card-pad"><div class="row">${avatar(f.name)}<div><strong>${e(f.name)}</strong><br><small>${e(f.actor)}</small></div></div><form method="post" action="/actions/friends/preferences">${csrf(token)}${hidden('actor', f.actor)}<div class="row wrap"><label class="check"><input type="checkbox" name="favorite" ${f.favorite ? 'checked' : ''}>Favorite</label><label class="check"><input type="checkbox" name="muted" ${f.muted ? 'checked' : ''}>Mute in feed</label><button class="secondary small">Save</button></div></form><details><summary>Manage friendship</summary><p><small>Removing or blocking a friend revokes access here to earlier shared posts. Copies they saved cannot be recalled.</small></p><div class="row"><form method="post" action="/actions/friends/remove">${csrf(token)}${hidden('actor', f.actor)}<label class="check"><input type="checkbox" name="confirmed" required>Remove this friendship and revoke access to shared posts.</label><button class="danger small">Remove friend</button></form><form method="post" action="/actions/friends/block">${csrf(token)}${hidden('actor', f.actor)}<label class="check"><input type="checkbox" name="confirmed" required>Block this person and revoke access to shared posts.</label><button class="danger small">Block</button></form><a href="/report?actor=${encodeURIComponent(f.actor)}">Report</a></div></details></div>`).join('') || empty('A small circle starts with one person.', 'Send an invitation, or ask a friend for their profile link. There’s no public member directory.')}<details><summary>Your invitations</summary>${
      core
        .invites(user.id)
        .map(
          (i) =>
            `<div class="row spread"><span>${e(i.kind)} · expires ${e(date(i.expiresAt))} · ${i.revokedAt ? 'Revoked' : i.consumedAt ? 'Used' : i.expiresAt <= Date.now() ? 'Expired' : 'Available'}</span>${!i.revokedAt && !i.consumedAt && i.expiresAt > Date.now() ? `<form method="post" action="/actions/invites/${encodeURIComponent(i.id)}/revoke">${csrf(token)}<button class="text-button">Revoke</button></form>` : ''}</div>`,
        )
        .join('') || '<p>No invitations yet.</p>'
    }</details>`
  );
}
export function settingsScreen(
  core: Core,
  user: User,
  token: string,
  backup: string | null,
  restored: boolean,
): string {
  return (
    heading('Your settings', 'You are in control') +
    `${user.suspended ? `<div class="notice error">This account is suspended. You can still export your data, delete your account, or appeal below.</div>` : ''}<div class="card card-pad"><h2>Your profile & preferences</h2><form method="post" action="/actions/settings">${csrf(token)}${field('Display name', 'displayName', 'text', 'required maxlength="80"', user.displayName)}<div class="field"><label for="bio">A little about you</label><textarea name="bio" id="bio" maxlength="500">${e(user.bio)}</textarea></div><label class="check"><input type="checkbox" name="discoverable" ${user.discoverable ? 'checked' : ''}>Let people who already know my handle look it up. This makes my chosen name and handle discoverable.</label><label class="check"><input type="checkbox" name="quietNotifications" ${user.quietNotifications ? 'checked' : ''}>Keep notifications to replies and friendship requests. No sound, email, or push either way.</label><label class="check"><input type="checkbox" name="compactFeed" ${user.compactFeed ? 'checked' : ''}>Use a compact feed with smaller photos and less spacing.</label><button>Save preferences</button></form><hr><label for="profile-link">Your profile link</label><input id="profile-link" readonly value="${e(user.actor)}"><button type="button" class="secondary small" data-copy-target="profile-link">Copy link</button></div><div class="card card-pad"><h2>Account security</h2><form method="post" action="/actions/password">${csrf(token)}${field('Current password', 'currentPassword', 'password', 'required autocomplete="current-password"')}${field('New password', 'newPassword', 'password', 'required minlength="12" autocomplete="new-password"')}<p><small>Changing your password signs out every session and replaces your recovery codes.</small></p><button class="secondary">Change password</button></form><hr><form method="post" action="/actions/logout-all">${csrf(token)}<button class="secondary">Sign out everywhere</button></form></div><div class="card card-pad"><h2>Your data leaves with you</h2><p>Download your private archive and media, plus your own posts and comments. Credentials, signing keys, and other people’s private archives are excluded.</p><form method="post" action="/actions/export">${csrf(token)}<button class="secondary">Download my data</button></form><p><small>Keep this download private: conversations can contain other people’s messages.</small></p><hr><h3>Host backups</h3><p>Latest successful backup: <strong>${backup ? e(date(backup)) : 'None recorded'}</strong>.</p><p><small>Your host manages encrypted backups. Backups do not encrypt the running service from its administrator.</small></p>${restored ? '<p class="notice">Sharing is disabled after a restore until the host reconciles newer deletions and revocations.</p>' : ''}</div><div class="card card-pad"><h2>Blocked accounts</h2>${
      core
        .blockedActors(user.id)
        .map(
          (actor) =>
            `<div class="row spread"><span>${e(actor)}</span><form method="post" action="/actions/friends/unblock">${csrf(token)}${hidden('actor', actor)}<button class="secondary small">Unblock</button></form></div>`,
        )
        .join('') || '<p class="muted">No blocked accounts.</p>'
    }</div>${
      user.suspended
        ? `<div class="card card-pad"><h2>Ask for a review</h2><form method="post" action="/actions/appeal">${csrf(token)}<label for="appeal">Tell the host what happened</label><textarea id="appeal" name="body" maxlength="4000" required></textarea><button>Send appeal</button></form>${core
            .appeals(user.id)
            .map(
              (a) =>
                `<p><strong>${e(a.state)}</strong> — ${e(a.response || 'Awaiting review')}</p>`,
            )
            .join('')}</div>`
        : ''
    }<div class="card card-pad"><h2>Leave this circle</h2><p>Deleting here does not delete your Facebook account. Keeping Facebook, temporarily deactivating it or requesting deletion there is entirely optional. <a href="/getting-started#facebook-options">Read the Facebook options and checks first</a>; any Facebook request happens at Facebook, never here.</p><p>Deletion removes your active account, archive and authored posts here. The host’s older backups may retain data until they expire. Removal requests go to connected hosts; saved copies cannot be guaranteed erased.</p><form method="post" action="/actions/delete-account" data-confirm="Permanently delete your account and data here? Download your export first.">${csrf(token)}${field('Type your username to confirm', 'confirmation', 'text', 'required')}<button class="danger">Delete my account</button></form></div>`
  );
}
