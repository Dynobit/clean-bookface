import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import yazl from 'yazl';
import { Store, isDatabaseBusy } from './storage.js';
import { Core, CoreError, type Session, type User } from './core.js';
import { Archive } from './archive.js';
import { Federation } from './federation.js';
import type { FederationNetwork } from './federation/network.js';
import { federationAdapter } from './core/adapter.js';
import type { Config } from './config.js';
import { pilotAllowsRequest, pilotNotice, pilotPhase } from './pilot.js';
import { stageUpload } from './uploads.js';
import { ChunkUploads, CHUNK_BYTES, MAX_PATH_ENTRIES, type ChunkFile } from './chunk-uploads.js';
import {
  page,
  welcome,
  esc as e,
  csrf,
  hidden,
  field,
  avatar,
  date,
  empty,
  heading,
} from './views.js';
import * as screens from './screens.js';

type Env = { Variables: { session: Session | null } };
type Ctx = Context<Env>;
type Fields = Record<string, string | string[]>;
const value = (body: Fields, key: string): string =>
  typeof body[key] === 'string' ? (body[key] as string) : '';
const values = (body: Fields, key: string): string[] =>
  Array.isArray(body[key])
    ? (body[key] as string[])
    : typeof body[key] === 'string'
      ? [body[key] as string]
      : [];
const equal = (a: string, b: string) => {
  const aa = Buffer.from(a),
    bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
};
const wantsJSON = (c: Ctx) =>
  Boolean(c.req.header('accept')?.includes('application/json')) ||
  (c.req.path.startsWith('/api/') && !c.req.header('accept')?.includes('text/html'));
const wantsActivity = (c: Ctx) =>
  (c.req.header('accept') ?? '').split(',').some((part) => {
    const [type, ...parameters] = part.trim().toLowerCase().split(';');
    if (!['application/activity+json', 'application/ld+json'].includes(type?.trim() ?? ''))
      return false;
    const quality = parameters.find((parameter) => parameter.trim().startsWith('q='));
    return quality === undefined || Number(quality.trim().slice(2)) > 0;
  });
// A 20,000-character post can need 180,000 bytes in a URL-encoded form.
// Leave room for its audience and CSRF fields without widening other forms.
const postFormBytes = 256 * 1024;
const publicReadPaths = new Set([
  '/healthz',
  '/style.css',
  '/app.js',
  '/favicon.svg',
  '/assets/our-memories.png',
  '/about',
  '/privacy',
  '/rules',
  '/getting-started',
]);
const notices: Record<string, string> = {
  saved: 'Preferences saved.',
  reported: 'Your report was sent to the host.',
  'cleanup-pending': 'Your account is closed. Data cleanup is queued for retry.',
};
const invitationDestination = (next: string) =>
  /^\/invite\/[a-zA-Z0-9_-]{32,128}$/.test(next) ? next : '/';

async function readFields(c: Ctx, maxBytes = 65536): Promise<Fields> {
  const stream = c.req.raw.body;
  if (!stream) return {};
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.length;
      if (size > maxBytes) {
        await reader.cancel();
        throw new CoreError(413, 'This form is too large.');
      }
      chunks.push(r.value);
    }
  } finally {
    reader.releaseLock();
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (c.req.header('content-type')?.includes('application/json')) {
    let result: unknown;
    try {
      result = JSON.parse(text);
    } catch {
      throw new CoreError(400, 'Invalid JSON request.');
    }
    if (!result || typeof result !== 'object' || Array.isArray(result))
      throw new CoreError(400, 'Invalid form.');
    const fields: Fields = {};
    for (const [k, v] of Object.entries(result)) {
      if (typeof v === 'string') fields[k] = v;
      else if (typeof v === 'boolean') fields[k] = v ? 'true' : 'false';
      else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) fields[k] = v;
      else if (v != null) throw new CoreError(400, 'Invalid form value.');
    }
    return fields;
  }
  if (!c.req.header('content-type')?.startsWith('application/x-www-form-urlencoded'))
    throw new CoreError(415, 'Use a form or JSON request.');
  const params = new URLSearchParams(text),
    out: Fields = {};
  for (const key of params.keys()) {
    const v = params.getAll(key);
    out[key] = v.length === 1 ? v[0] : v;
  }
  return out;
}

function flag(fields: Fields, name: string): boolean {
  return ['true', 'on', '1'].includes(value(fields, name));
}

export function createApplication(
  config: Config,
  options: {
    store?: Store;
    startWorkers?: boolean;
    federationNetwork?: FederationNetwork;
    now?: () => number;
  } = {},
) {
  const store = options.store ?? new Store(config.dataDir);
  const storedOrigin = store.setting('origin');
  if (storedOrigin && storedOrigin !== config.origin)
    throw new Error(
      'APP_ORIGIN differs from this installation’s identity. Restore with its original domain.',
    );
  store.setSetting('origin', config.origin);
  const now = options.now ?? Date.now;
  const archive = new Archive(store, {
    limits: { ownerBytes: config.archiveAccountBytes ?? 5 * 1024 ** 3 },
  });
  const chunks = new ChunkUploads(store, {
    maxBytes: config.maxUploadBytes,
    maxFileBytes: archive.limits.maxFileBytes,
    maxJsonBytes: archive.limits.maxJsonBytes,
    maxCompressedBytes: archive.limits.maxCompressedBytes,
    maxDepth: archive.limits.maxDepth,
  });
  const directLimit = Math.min(
    config.maxUploadBytes,
    config.maxDirectUploadBytes ?? config.maxUploadBytes,
  );
  const photoLimit = Math.min(directLimit, 128 * 1024 * 1024);
  const sharingAllowed = () => store.setting('restore_reconciliation_required') !== 'true';
  const core = new Core(store, {
    origin: config.origin,
    maxAccounts: config.maxAccounts ?? 200,
    sharingAllowed,
    validateMedia: (owner, ids) => {
      for (const id of ids)
        if (!archive.isShareableMedia(owner, id))
          throw new CoreError(400, 'Only your prepared sharing photos can be attached.');
    },
  });
  const adapter = federationAdapter(core, archive, sharingAllowed);
  const federation = new Federation(store, adapter, {
    origin: config.origin,
    enabled: config.federation,
    network: options.federationNetwork,
  });
  const setupPath = join(store.dataDir, '.setup-token');
  if (!core.isSetup() && !existsSync(setupPath))
    writeFileSync(setupPath, randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' });
  const app = new Hono<Env>();
  // Apply headers after handlers return, including raw media/export Responses.
  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'same-origin');
    c.header('X-Frame-Options', 'DENY');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    c.header('Cache-Control', 'private, no-store');
    c.header(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'",
    );
    if (config.production) c.header('Strict-Transport-Security', 'max-age=31536000');
  });
  let activeRequests = 0;
  const idleWaiters: Array<() => void> = [];
  app.use('*', async (_c, next) => {
    activeRequests++;
    try {
      await next();
    } finally {
      activeRequests--;
      if (activeRequests === 0) for (const done of idleWaiters.splice(0)) done();
    }
  });
  const drainRequests = () =>
    activeRequests === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => idleWaiters.push(resolve));
  const cookieName = config.production ? '__Host-bookface' : 'bookface';
  const getSession = (c: Ctx) => c.get('session');
  const requireSession = (c: Ctx): Session => {
    // A request may wait on its body or remote work after middleware ran.
    // The original cookie must still name a live session at each authorization point.
    const s = core.session(getCookie(c, cookieName));
    c.set('session', s);
    if (!s) throw new CoreError(401, 'Please log in.');
    return s;
  };
  const show = (c: Ctx, title: string, content: string, active = '', notice = '') => {
    const s = getSession(c);
    return c.html(
      page({
        title,
        content: `${pilotNotice(config, now()) ? `<aside class="card card-pad" aria-label="Pilot dates"><p>${e(pilotNotice(config, now()))}</p></aside>` : ''}${config.cloudflareProxy ? '<aside class="card card-pad" aria-label="Connection privacy"><p>This host uses Cloudflare for HTTPS. Cloudflare can access traffic passing through it, and the host administrator can read stored data. This is not end-to-end encryption. <a href="/privacy">Who can see what</a></p></aside>' : ''}${content}`,
        user: s?.user,
        csrf: s?.csrf,
        active,
        notice:
          notice ||
          (Object.hasOwn(notices, c.req.query('notice') ?? '')
            ? notices[c.req.query('notice')!]
            : undefined),
        instanceName: config.instanceName,
      }),
    );
  };
  const finish = (c: Ctx, result: Record<string, unknown>, redirect = '/') =>
    wantsJSON(c) ? c.json({ ...result, redirect }) : c.redirect(redirect, 303);
  const signIn = (c: Ctx, result: { token: string; expiresAt: number }) =>
    setCookie(c, cookieName, result.token, {
      httpOnly: true,
      secure: config.production,
      sameSite: 'Strict',
      path: '/',
      expires: new Date(result.expiresAt),
    });
  // Keep authorization synchronous with the caller's mutation: awaiting another
  // helper after checking a session would leave a revocation gap before dispatch.
  const authorizeForm = (c: Ctx, data: Fields) => {
    const s = requireSession(c);
    if (!core.validCsrf(s, c.req.header('x-csrf-token') ?? value(data, 'csrf')))
      throw new CoreError(403, 'This form expired. Reload the page and try again.');
    return { data, s, user: s.user, token: s.csrf };
  };
  const requireSharing = () => {
    if (!sharingAllowed())
      throw new CoreError(
        409,
        'Sharing is paused after a restore. Your host needs to reconcile newer deletions and revocations first.',
      );
  };
  let deletionTask: Promise<void> | undefined;
  const finishDeletions = (): Promise<void> => {
    // A concurrent account closure may arrive after the active sweep took its
    // snapshot. Its caller must also await a fresh sweep of the durable queue.
    if (deletionTask) return deletionTask.then(() => finishDeletions());
    deletionTask = (async () => {
      for (const userId of core.pendingAccountDeletions()) {
        try {
          await chunks.deleteOwner(userId);
          await archive.deleteOwner(userId);
          core.completeAccountDeletion(userId);
        } catch (error) {
          const code = (error as { code?: unknown })?.code;
          const safeCode =
            typeof code === 'string' &&
            ['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'EACCES', 'EPERM', 'ENOSPC', 'EIO'].includes(
              code,
            )
              ? code
              : 'CLEANUP_FAILED';
          console.error(`Account data cleanup remains queued for retry (${safeCode})`);
        }
      }
    })().finally(() => {
      deletionTask = undefined;
    });
    return deletionTask;
  };
  const removePublication = (userId: string, id: string) => {
    const post = core.post(id, userId);
    if (post.authorId !== userId) throw new CoreError(404, 'Post not found.');
    core.deletePost(userId, id);
    for (const mediaId of post.mediaIds) {
      const linked = store.db
        .prepare(
          'SELECT 1 FROM publications p,json_each(p.media_ids) m WHERE p.deleted_at IS NULL AND m.value=? LIMIT 1',
        )
        .get(mediaId);
      if (!linked) archive.deleteSharedMedia(userId, mediaId);
    }
  };
  const sendFile = (path: string, mime: string) =>
    new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
      headers: {
        'Content-Type': mime,
        'Cache-Control': 'private, no-store',
        'Content-Disposition': mime.startsWith('image/') ? 'inline' : 'attachment',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  app.use('*', async (c, next) => {
    if (c.req.path != '/healthz' && new URL(c.req.url).host !== new URL(config.origin).host)
      return c.text('Unrecognized host', 400);
    const phase = pilotPhase(config, now());
    const publicPilotRead =
      ['GET', 'HEAD'].includes(c.req.method) && publicReadPaths.has(c.req.path);
    if (!publicPilotRead && !pilotAllowsRequest(config, c.req.method, c.req.path, now())) {
      const status = phase === 'ended' ? 410 : 403;
      const message = pilotNotice(config, now()) ?? 'This pilot is closed.';
      if (wantsJSON(c)) return c.json({ error: message }, status);
      return c.html(
        page({
          title: 'Pilot closing',
          content: `<div class="card card-pad"><h1>${phase === 'ended' ? 'This pilot has ended' : 'Time to take your memories with you'}</h1><p>${e(message)}</p><a href="/privacy">Privacy information</a></div>`,
        }),
        status,
      );
    }
    if (
      !sharingAllowed() &&
      !(['GET', 'HEAD'].includes(c.req.method) && publicReadPaths.has(c.req.path))
    )
      return c.text(
        'This circle is being restored. The host must reconcile current account and sharing permissions before it can reopen.',
        503,
      );
    c.set('session', phase === 'ended' ? null : core.session(getCookie(c, cookieName)));
    if (
      c.req.path.startsWith('/federation/') ||
      c.req.path === '/.well-known/webfinger' ||
      /^\/users\/[^/]+\/inbox$/.test(c.req.path) ||
      (/^\/users\/[^/]+$/.test(c.req.path) && wantsActivity(c))
    ) {
      const response = await federation.handle(
        new Request(
          config.origin + new URL(c.req.url).pathname + new URL(c.req.url).search,
          c.req.raw,
        ),
      );
      if (response) return response;
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      if (c.req.header('origin') !== config.origin)
        return c.text('Request origin does not match this host.', 403);
      if (c.req.header('sec-fetch-site') === 'cross-site')
        return c.text('Cross-site requests are not allowed.', 403);
      core.rate('http:global:mutation', 1000, 60_000);
    }
    await next();
  });
  app.onError((error, c) => {
    const status =
      error instanceof CoreError
        ? error.status
        : /not found|not belong|unavailable/i.test(error.message)
          ? 404
          : 500;
    const message =
      error instanceof CoreError
        ? error.message
        : status === 404
          ? 'This item is unavailable.'
          : 'Something went wrong. Please try again.';
    if (status === 500) console.error('Request failed:', error.name);
    if (wantsJSON(c)) return c.json({ error: message }, status as 400);
    return c.html(
      page({
        title: 'Let’s try that again',
        user: getSession(c)?.user,
        csrf: getSession(c)?.csrf,
        error: message,
        content: `<div class="card card-pad"><h1>${status === 401 ? 'Please log in' : 'That didn’t work'}</h1><p>${e(message)}</p><a class="button secondary" href="${status === 401 ? '/login' : '/'}">${status === 401 ? 'Log in' : 'Return home'}</a></div>`,
      }),
      status as 400,
    );
  });
  app.notFound((c) =>
    wantsJSON(c)
      ? c.json({ error: 'Not found' }, 404)
      : c.html(
          page({
            title: 'Not found',
            user: getSession(c)?.user,
            csrf: getSession(c)?.csrf,
            content: empty(
              'This page isn’t available.',
              'It may have been removed, or you may not have permission to see it.',
              '<a href="/">Return home</a>',
            ),
          }),
          404,
        ),
  );
  app.get('/healthz', (c) => {
    store.db.prepare('SELECT 1').get();
    return c.json({ status: 'ok', version: '0.1.0' });
  });
  for (const [url, file, mime] of [
    ['/style.css', 'style.css', 'text/css'],
    ['/app.js', 'app.js', 'text/javascript'],
    ['/favicon.svg', 'favicon.svg', 'image/svg+xml'],
    ['/assets/our-memories.png', 'assets/our-memories.png', 'image/png'],
  ])
    app.get(url, () => sendFile(resolve('public', file), mime));
  app.get('/login', (c) => {
    if (getSession(c)) return c.redirect(invitationDestination(c.req.query('next') ?? ''));
    return show(
      c,
      'Log in',
      welcome(
        `<div class="card"><div class="card-head">A familiar place to come back to</div><div class="card-pad"><h2>Log in to your circle</h2><form method="post" action="/actions/login">${hidden('next', c.req.query('next') ?? '')}${field('Username', 'username', 'text', 'required autocomplete="username" autocapitalize="none"')}${field('Password', 'password', 'password', 'required autocomplete="current-password"')}<button type="submit">Log in</button></form><p><a href="/recover">Forgot your password?</a></p><hr><p>New here? Ask a friend for an invitation.</p>${!core.isSetup() ? '<a href="/setup">Set up this new circle →</a>' : ''}</div></div>`,
      ),
    );
  });
  app.post('/actions/login', async (c) => {
    const d = await readFields(c);
    core.rate('http:login', 60, 60_000);
    const s = await core.login(value(d, 'username'), value(d, 'password'));
    signIn(c, s);
    const next = value(d, 'next');
    return finish(c, { user: s.user, csrf: s.csrf }, invitationDestination(next));
  });
  app.get('/setup', (c) => {
    if (core.isSetup()) return c.redirect('/login');
    return show(
      c,
      'Set up your circle',
      welcome(
        `<div class="card card-pad"><h2>Make yourself at home</h2><p>This creates the first account for the host. Run the setup command on your server to obtain its private setup code.</p><form method="post" action="/actions/setup">${field('Setup code', 'setupToken', 'password', 'required autocomplete="off"')}${field('Username', 'username', 'text', 'required pattern="[a-z0-9][a-z0-9_]{2,31}" autocomplete="username"')}${field('Your name', 'displayName', 'text', 'required maxlength="80" autocomplete="name"')}${field('Password', 'password', 'password', 'required minlength="12" autocomplete="new-password"')}<label class="check"><input name="acceptRules" type="checkbox" required>I’m a person, and I agree to the <a href="/rules">house rules</a>.</label><button>Create my circle</button></form></div>`,
      ),
    );
  });
  app.post('/actions/setup', async (c) => {
    core.rate('http:setup', 10, 60_000);
    const d = await readFields(c);
    if (
      core.isSetup() ||
      !existsSync(setupPath) ||
      !equal(readFileSync(setupPath, 'utf8').trim(), value(d, 'setupToken'))
    )
      throw new CoreError(403, 'Invalid setup code.');
    if (!flag(d, 'acceptRules')) throw new CoreError(400, 'Please accept the house rules.');
    const { session: s, ...result } = await core.setup(
      {
        username: value(d, 'username'),
        displayName: value(d, 'displayName'),
        password: value(d, 'password'),
      },
      true,
    );
    rmSync(setupPath, { force: true });
    signIn(c, s);
    c.set('session', s);
    return wantsJSON(c)
      ? c.json({ ...result, csrf: s.csrf })
      : show(c, 'Save your recovery codes', screens.recoveryScreen(result.recoveryCodes));
  });
  app.get('/invite/:token', (c) => {
    const invite = core.inspectInvite(c.req.param('token'));
    if (invite.kind === 'friendship') {
      if (!getSession(c))
        return c.redirect('/login?next=' + encodeURIComponent('/invite/' + c.req.param('token')));
      const s = requireSession(c);
      return show(
        c,
        'A friendship invitation',
        `<div class="card card-pad"><h1>Connect with ${e(invite.inviter)}?</h1><p>This connects your existing accounts. It does not share your imported archive or old posts.</p><form method="post" action="/actions/invites/accept">${csrf(s.csrf)}${hidden('inviteToken', c.req.param('token'))}<button>Accept friendship</button></form></div>`,
        'friends',
      );
    }
    return show(
      c,
      'Join your friend',
      welcome(
        `<div class="card card-pad"><h2>${e(invite.inviter)} invited you.</h2><p>Create an account here. Joining does not automatically grant anyone access to your memories.</p><form method="post" action="/actions/register">${hidden('inviteToken', c.req.param('token'))}${field('Username', 'username', 'text', 'required pattern="[a-z0-9][a-z0-9_]{2,31}" autocomplete="username"')}${field('Your name', 'displayName', 'text', 'required maxlength="80"')}${field('Password', 'password', 'password', 'required minlength="12" autocomplete="new-password"')}<label class="check"><input type="checkbox" name="acceptRules" required>I’m a person and agree to the <a href="/rules">house rules</a>.</label><button>Join this circle</button></form></div>`,
      ),
    );
  });
  app.post('/actions/register', async (c) => {
    const d = await readFields(c);
    core.rate('http:register', 20, 60_000);
    if (!flag(d, 'acceptRules')) throw new CoreError(400, 'Please accept the house rules.');
    const { session: s, ...r } = await core.register(
      {
        username: value(d, 'username'),
        displayName: value(d, 'displayName'),
        password: value(d, 'password'),
        inviteToken: value(d, 'inviteToken'),
      },
      true,
    );
    signIn(c, s);
    c.set('session', s);
    return wantsJSON(c)
      ? c.json({ ...r, csrf: s.csrf })
      : show(c, 'Save your recovery codes', screens.recoveryScreen(r.recoveryCodes));
  });
  app.get('/recover', (c) =>
    show(
      c,
      'Recover your account',
      welcome(
        `<div class="card card-pad"><h2>Find your way back</h2><p>Use one of the recovery codes you saved when you joined.</p><form method="post" action="/actions/recover">${field('Username', 'username', 'text', 'required autocomplete="username"')}${field('Recovery code', 'code', 'password', 'required autocomplete="off"')}${field('New password', 'password', 'password', 'required minlength="12" autocomplete="new-password"')}<button>Recover account</button></form></div>`,
      ),
    ),
  );
  app.post('/actions/recover', async (c) => {
    const d = await readFields(c);
    core.rate('http:recover', 20, 60_000);
    const { session: s, ...r } = await core.recover(
      value(d, 'username'),
      value(d, 'code'),
      value(d, 'password'),
      true,
    );
    signIn(c, s);
    c.set('session', s);
    return wantsJSON(c)
      ? c.json({ ...r, csrf: s.csrf })
      : show(c, 'Save new recovery codes', screens.recoveryScreen(r.recoveryCodes));
  });
  app.post('/actions/logout', async (c) => {
    authorizeForm(c, await readFields(c));
    core.logout(getCookie(c, cookieName) ?? '');
    deleteCookie(c, cookieName, {
      path: '/',
      secure: config.production,
      httpOnly: true,
      sameSite: 'Strict',
    });
    return finish(c, {}, '/login');
  });
  app.get('/', (c) => {
    const s = getSession(c);
    if (!s) return c.redirect(core.isSetup() ? '/login' : '/setup');
    return show(
      c,
      'News feed',
      (s.user.admin && !store.setting('last_backup_at')
        ? '<div class="card card-pad"><h2>Welcome to your circle</h2><p>Get settled before inviting friends.</p><a href="/admin/setup">Follow the short host checklist →</a></div>'
        : '') +
        screens.feedScreen(
          core,
          s.user,
          s.csrf,
          c.req.query('q') ?? '',
          c.req.query('filter') === 'favorites',
          Number(c.req.query('before')) || undefined,
          c.req.query('beforeId'),
        ),
      'feed',
    );
  });
  app.get('/api/me', (c) => {
    const s = requireSession(c);
    return c.json({ user: s.user, csrf: s.csrf });
  });
  app.get('/api/feed', (c) => {
    const s = requireSession(c);
    return c.json({ posts: core.feed(s.user.id) });
  });
  app.get('/compose', (c) => {
    const s = requireSession(c),
      source = c.req.query('source'),
      ids = c.req.queries('media') ?? [];
    for (const id of ids)
      if (!archive.isShareableMedia(s.user.id, id)) throw new CoreError(404, 'Photo not found.');
    const item = source ? archive.get(s.user.id, source) : null;
    if (source && (!item || !['post', 'photo'].includes(item.kind)))
      throw new CoreError(404, 'Shareable memory not found.');
    return show(
      c,
      'Share something',
      screens.composeScreen(core, s.user, s.csrf, {
        body: item?.body,
        archiveId: source,
        mediaIds: ids,
        maxPhotoBytes: photoLimit,
      }),
      'feed',
    );
  });
  app.post('/actions/posts', async (c) => {
    const { data, user } = authorizeForm(c, await readFields(c, postFormBytes));
    requireSharing();
    const source = value(data, 'archiveSourceId');
    if (source) {
      const item = archive.get(user.id, source);
      if (!item || !['post', 'photo'].includes(item.kind))
        throw new CoreError(400, 'This archive item cannot be published.');
    }
    const post = core.publish(user.id, {
      body: value(data, 'body'),
      audience: value(data, 'audience') as 'private',
      recipientActors: values(data, 'recipientActors'),
      mediaIds: values(data, 'mediaIds'),
      archiveSourceId: source || undefined,
    });
    return finish(c, { post }, `/posts/${post.id}`);
  });
  app.get('/posts/:id', (c) => {
    const s = requireSession(c);
    const post = core.post(c.req.param('id'), s.user.id);
    return show(c, 'A shared moment', screens.renderPost(post, s.user, s.csrf, true), 'feed');
  });
  app.get('/api/posts/:id', (c) =>
    c.json({ post: core.post(c.req.param('id'), requireSession(c).user.id) }),
  );
  app.get('/posts/:id/media/:mediaId', async (c) => {
    const s = requireSession(c),
      post = core.post(c.req.param('id'), s.user.id),
      id = c.req.param('mediaId');
    if (!sharingAllowed() && post.authorId !== s.user.id)
      throw new CoreError(404, 'Photo not available.');
    if (!post.mediaIds.includes(id)) throw new CoreError(404, 'Photo not found.');
    if (post.authorId) {
      const m = archive.media(post.authorId, id);
      if (!m || m.purpose !== 'shared') throw new CoreError(404, 'Photo not found.');
      return sendFile(m.path, m.mime);
    }
    if (!config.federation || new URL(id).origin !== new URL(post.authorActor).origin)
      throw new CoreError(404, 'Photo not found.');
    let remote;
    try {
      remote = await federation.signedFetch(s.user.username, id, 8 * 1024 * 1024);
    } catch {
      const current = requireSession(c);
      if (!core.canRead(post.id, current.user.id) || !sharingAllowed())
        throw new CoreError(404, 'Photo no longer available.');
      c.header('Retry-After', '60');
      throw new CoreError(503, 'Your friend’s host is temporarily unavailable. Try again shortly.');
    }
    const afterFetch = requireSession(c);
    if (!core.canRead(post.id, afterFetch.user.id) || !sharingAllowed())
      throw new CoreError(404, 'Photo no longer available.');
    if (remote.status === 429 || remote.status >= 500) {
      c.header('Retry-After', '60');
      throw new CoreError(503, 'Your friend’s host is temporarily unavailable. Try again shortly.');
    }
    if (remote.status !== 200 || !remote.headers.get('content-type')?.startsWith('image/'))
      throw new CoreError(404, 'Photo not available.');
    const safe = await sharp(Buffer.from(remote.body), { limitInputPixels: 40_000_000 })
      .rotate()
      .webp({ quality: 85 })
      .toBuffer();
    const current = requireSession(c);
    if (!core.canRead(post.id, current.user.id) || !sharingAllowed())
      throw new CoreError(404, 'Photo no longer available.');
    return new Response(safe, {
      headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'private, no-store' },
    });
  });
  app.get('/posts/:id/edit', (c) => {
    const s = requireSession(c),
      p = core.post(c.req.param('id'), s.user.id);
    if (p.authorId !== s.user.id) throw new CoreError(404, 'Post not found.');
    return show(
      c,
      'Edit your post',
      heading('Your post, your audience', 'Manage this shared copy') +
        `<div class="card card-pad"><form method="post" action="/actions/posts/${p.id}/edit">${csrf(s.csrf)}<label for="body">Your words</label><textarea id="body" name="body" maxlength="20000">${e(p.body)}</textarea><button>Save changes</button></form><hr><h2>Current audience</h2>${(p.recipientActors ?? []).map((actor) => `<form class="row spread" method="post" action="/actions/posts/${p.id}/revoke">${csrf(s.csrf)}${hidden('actor', actor)}<span>${e(actor)}</span><button class="danger small">Revoke access</button></form>`).join('') || '<p>Only you can see this post.</p>'}<p class="info">Revoking access stops new reads here and requests removal at connected hosts. It cannot erase a copy somebody already saved.</p><details><summary>Share this post with another accepted friend</summary><form method="post" action="/actions/posts/${p.id}/grant">${csrf(s.csrf)}${core
          .friends(s.user.id)
          .filter((f) => !p.recipientActors?.includes(f.actor))
          .map(
            (f) =>
              `<label class="check"><input type="checkbox" name="recipientActors" value="${e(f.actor)}">${e(f.name)}</label>`,
          )
          .join(
            '',
          )}<button class="secondary">Grant access</button></form></details><hr><form method="post" action="/actions/posts/${p.id}/delete" data-confirm="Delete this post and request removal of shared copies?">${csrf(s.csrf)}<button class="danger">Delete post</button></form></div>`,
      'feed',
    );
  });
  for (const action of ['edit', 'delete', 'like', 'comment', 'grant', 'revoke'])
    app.post(`/actions/posts/:id/${action}`, async (c) => {
      const { data, user } = authorizeForm(
          c,
          await readFields(c, action === 'edit' ? postFormBytes : undefined),
        ),
        id = c.req.param('id');
      if (action !== 'delete' && action !== 'revoke') requireSharing();
      if (action === 'edit') core.editPost(user.id, id, { body: value(data, 'body') });
      if (action === 'delete') removePublication(user.id, id);
      if (action === 'like') core.like(user.id, id, value(data, 'enabled') !== 'false');
      if (action === 'comment') core.comment(user.id, id, value(data, 'body'));
      if (action === 'grant') core.grantRecipients(user.id, id, values(data, 'recipientActors'));
      if (action === 'revoke') core.revokeRecipients(user.id, id, [value(data, 'actor')]);
      return finish(c, {}, action === 'delete' ? '/' : `/posts/${encodeURIComponent(id)}`);
    });
  app.post('/actions/comments/:id/delete', async (c) => {
    const { data, user } = authorizeForm(c, await readFields(c));
    core.deleteComment(user.id, c.req.param('id'));
    return finish(
      c,
      {},
      value(data, 'returnTo') === 'comments'
        ? '/settings/comments'
        : `/posts/${encodeURIComponent(value(data, 'postId'))}`,
    );
  });
  app.get('/archive', (c) => {
    const s = requireSession(c);
    return show(
      c,
      'Your private memories',
      screens.archiveScreen(
        archive,
        s.user,
        c.req.query('q') ?? '',
        c.req.query('kind') ?? '',
        Math.max(0, Number(c.req.query('offset')) || 0),
      ),
      'archive',
    );
  });
  app.get('/api/archive', (c) => {
    const s = requireSession(c);
    return c.json({ items: archive.list(s.user.id, { query: c.req.query('q'), limit: 50 }) });
  });
  app.get('/archive/:id', (c) => {
    const s = requireSession(c),
      item = archive.get(s.user.id, c.req.param('id'));
    if (!item) throw new CoreError(404, 'Memory not found.');
    return show(
      c,
      'Your private memory',
      screens.archiveDetail(
        item,
        s.csrf,
        Number(
          (
            store.db
              .prepare(
                'SELECT count(*) AS n FROM publications WHERE author_id=? AND archive_source_id=? AND deleted_at IS NULL',
              )
              .get(s.user.id, item.id) as { n: number }
          ).n,
        ),
        item.mediaIds.map((id) => archive.media(s.user.id, id)).filter((m) => m !== null),
      ),
      'archive',
    );
  });
  app.get('/media/:id', (c) => {
    const s = requireSession(c),
      m = archive.media(s.user.id, c.req.param('id'));
    if (!m) throw new CoreError(404, 'Media not found.');
    return sendFile(m.path, m.mime);
  });
  app.post('/actions/archive/:id/prepare', async (c) => {
    const { user, data } = authorizeForm(c, await readFields(c));
    if (user.suspended) throw new CoreError(403, 'This account is suspended.');
    const selected = flag(data, 'selectionPresent') ? values(data, 'mediaIds') : undefined;
    if (selected && selected.length > 8)
      throw new CoreError(400, 'Choose up to 8 photos for one shared copy.');
    const copy = await archive.shareCopy(user.id, c.req.param('id'), selected, () => {
      uploadSession(c);
    });
    uploadSession(c);
    return finish(
      c,
      { mediaIds: copy.media.map((m) => m.id) },
      `/compose?source=${encodeURIComponent(c.req.param('id'))}${copy.media.map((m) => `&media=${encodeURIComponent(m.id)}`).join('')}`,
    );
  });
  app.post('/actions/archive/:id/delete', async (c) => {
    const { user, data } = authorizeForm(c, await readFields(c));
    const id = c.req.param('id');
    if (!archive.get(user.id, id)) throw new CoreError(404, 'Memory not found.');
    if (!flag(data, 'confirmed'))
      throw new CoreError(400, 'Confirm which memories and shared copies you want to delete.');
    if (value(data, 'archiveOnly') !== 'true') {
      const shares = store.db
        .prepare(
          'SELECT id FROM publications WHERE author_id=? AND archive_source_id=? AND deleted_at IS NULL',
        )
        .all(user.id, id) as { id: string }[];
      for (const share of shares) removePublication(user.id, share.id);
    }
    archive.deleteItem(user.id, id);
    return finish(c, {}, '/archive');
  });
  app.get('/photos', (c) => {
    const s = requireSession(c),
      offset = Math.min(1_000_000, Math.max(0, Math.trunc(Number(c.req.query('offset')) || 0))),
      items = archive.photoItems(s.user.id, { limit: 30, offset });
    return show(
      c,
      'Your photos',
      heading(
        'Your photos',
        'Private originals. Deliberate sharing.',
        '<a class="button secondary small" href="/albums">Albums</a>',
      ) +
        `<div class="card card-pad"><div class="photo-grid">${items.map((item) => `<figure><a href="/archive/${encodeURIComponent(item.id)}"><img loading="lazy" src="/media/${encodeURIComponent(item.mediaIds[0])}" alt="${e(item.title || 'A private memory')}"></a><figcaption>${e(date(item.occurredAt))}</figcaption></figure>`).join('')}</div>${items.length ? '' : '<p>Your imported photos will appear here.</p>'}</div>${items.length === 30 ? `<a class="button secondary" href="/photos?offset=${offset + 30}">More photos</a>` : ''}<a class="button secondary" href="/compose">Make a photo album</a>`,
      'photos',
    );
  });
  app.get('/albums', (c) => {
    const s = requireSession(c),
      privateAlbums = archive.albums(s.user.id),
      ids = store.db
        .prepare(
          'SELECT id FROM publications WHERE author_id=? AND deleted_at IS NULL AND json_array_length(media_ids)>1 ORDER BY created_at DESC LIMIT 100',
        )
        .all(s.user.id) as { id: string }[];
    return show(
      c,
      'Your albums',
      heading(
        'Your albums',
        'A few moments, kept together',
        '<a class="button secondary small" href="/compose">Create an album</a>',
      ) +
        '<h2>Private imported albums</h2>' +
        privateAlbums
          .map(
            (a) =>
              `<div class="card card-pad"><h3><a href="/archive/${encodeURIComponent(a.id)}">${e(a.title || 'Untitled album')}</a></h3><span class="badge private">Only you</span><div class="photo-grid">${a.mediaIds
                .slice(0, 12)
                .map(
                  (id) =>
                    `<a href="/media/${encodeURIComponent(id)}"><img src="/media/${encodeURIComponent(id)}" alt="Photo from ${e(a.title || 'your album')}" loading="lazy"></a>`,
                )
                .join('')}</div></div>`,
          )
          .join('') +
        (privateAlbums.length
          ? ''
          : '<p class="muted">Imported photo albums will appear here.</p>') +
        '<h2>Albums you created</h2>' +
        ids.map(({ id }) => screens.renderPost(core.post(id, s.user.id), s.user, s.csrf)).join('') +
        (ids.length
          ? ''
          : empty(
              'Start a small collection.',
              'Choose up to twelve photos, give them a caption or title, and choose who can see the album.',
              '<a href="/compose" class="button secondary">Create an album</a>',
            )),
      'photos',
    );
  });
  const uploadSession = (c: Ctx, headerCsrf = false) => {
    const s = requireSession(c);
    if (s.user.suspended) throw new CoreError(403, 'This account is suspended.');
    if (headerCsrf && !core.validCsrf(s, c.req.header('x-csrf-token') ?? ''))
      throw new CoreError(403, 'Reload this form and try again.');
    return s;
  };
  const requireNoImport = (owner: string) => {
    if (archive.jobs(owner).some((j) => ['queued', 'running'].includes(j.status)))
      throw new CoreError(409, 'Wait for your current import to finish.');
  };
  const directUpload = async <T>(
    c: Ctx,
    limit: number,
    maxFiles: number,
    consume: (
      upload: Awaited<ReturnType<typeof stageUpload>>,
      s: Session,
      authorize: () => void,
    ) => Promise<T>,
  ): Promise<T> => {
    const s = uploadSession(c);
    if (c.req.header('x-csrf-token') && !core.validCsrf(s, c.req.header('x-csrf-token')!))
      throw new CoreError(403, 'Reload this form and try again.');
    const reservation = chunks.begin(
      s.user.id,
      [{ name: 'direct-upload-reservation', size: limit }],
      Math.min(MAX_PATH_ENTRIES, maxFiles * 20) + 1,
    );
    try {
      return await chunks.withReservation(s.user.id, reservation.id, async (signal) => {
        const upload = await stageUpload(c.req.raw, store.dataDir, limit, maxFiles, {
          limits: archive.limits,
          signal,
        });
        try {
          const authorize = () => {
            const current = uploadSession(c);
            if (!core.validCsrf(current, c.req.header('x-csrf-token') ?? upload.fields.csrf ?? ''))
              throw new CoreError(403, 'Reload this form and try again.');
          };
          authorize();
          return await consume(upload, requireSession(c), authorize);
        } catch (error) {
          await rm(upload.root, { recursive: true, force: true });
          throw error;
        }
      });
    } finally {
      try {
        chunks.cancel(s.user.id, reservation.id);
      } catch (error) {
        if (!(error instanceof CoreError && error.status === 404)) throw error;
      }
    }
  };
  app.post('/actions/photo', async (c) => {
    const s = uploadSession(c);
    core.rate(`upload:${s.user.id}`, 30, 60 * 60_000);
    return directUpload(c, photoLimit, 12, async (upload, s, authorize) => {
      try {
        const media = [];
        for (const file of upload.files)
          media.push(await archive.uploadPhoto(s.user.id, file.path, authorize));
        authorize();
        return finish(
          c,
          { mediaIds: media.map((m) => m.id) },
          `/compose?${media.map((m) => 'media=' + m.id).join('&')}`,
        );
      } finally {
        await rm(upload.root, { recursive: true, force: true });
      }
    });
  });
  app.get('/imports', (c) => {
    const s = requireSession(c);
    return show(
      c,
      'Bring your history',
      screens.importsScreen(archive, s.user, s.csrf, config.maxUploadBytes, directLimit),
      'imports',
    );
  });
  app.get('/api/imports', (c) => c.json({ jobs: archive.jobs(requireSession(c).user.id) }));
  app.post('/api/imports', async (c) => {
    const s = uploadSession(c);
    core.rate(`import:${s.user.id}`, 10, 60 * 60_000);
    requireNoImport(s.user.id);
    return directUpload(c, directLimit, 20000, async (upload, s) => {
      requireNoImport(s.user.id);
      const isZip =
        upload.files.length === 1 && upload.files[0].name.toLowerCase().endsWith('.zip');
      const id = archive.enqueueImport(s.user.id, isZip ? upload.files[0].path : upload.root, {
        format: isZip ? 'zip' : 'directory',
      });
      return c.req.header('accept')?.includes('application/json')
        ? c.json({ jobId: id, redirect: '/imports' }, 202)
        : c.redirect('/imports', 303);
    });
  });
  app.get('/api/uploads', (c) => c.json({ upload: chunks.active(uploadSession(c).user.id) }));
  app.post('/api/uploads', async (c) => {
    const s = uploadSession(c, true);
    core.rate(`import:${s.user.id}`, 10, 60 * 60_000);
    requireNoImport(s.user.id);
    const data = await readFields(c, 16 * 1024 * 1024);
    let manifest: ChunkFile[];
    try {
      manifest = JSON.parse(value(data, 'manifest'));
    } catch {
      throw new CoreError(400, 'Invalid file list.');
    }
    requireNoImport(s.user.id);
    uploadSession(c, true);
    return c.json(chunks.begin(s.user.id, manifest), 201);
  });
  app.get('/api/uploads/:id', (c) =>
    c.json(chunks.status(uploadSession(c).user.id, c.req.param('id'))),
  );
  app.put('/api/uploads/:id/files/:index', async (c) => {
    const s = uploadSession(c, true);
    const rawIndex = c.req.param('index'),
      rawOffset = c.req.query('offset') ?? '';
    if (!/^\d+$/.test(rawIndex) || !/^\d+$/.test(rawOffset) || !c.req.raw.body)
      throw new CoreError(400, 'Invalid upload chunk.');
    const length = c.req.header('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > CHUNK_BYTES))
      throw new CoreError(413, 'This chunk is too large.');
    return c.json(
      await chunks.writeChunk(
        s.user.id,
        c.req.param('id'),
        Number(rawIndex),
        Number(rawOffset),
        c.req.raw.body,
        c.req.header('x-chunk-sha256') ?? '',
        () => {
          uploadSession(c, true);
        },
      ),
    );
  });
  app.post('/api/uploads/:id/commit', (c) => {
    const s = uploadSession(c, true),
      id = c.req.param('id');
    if (chunks.status(s.user.id, id).state !== 'committed') requireNoImport(s.user.id);
    const jobId = chunks.commit(s.user.id, id, (path, options) =>
      archive.enqueueImport(s.user.id, path, options),
    );
    return c.json({ jobId, redirect: '/imports' }, 202);
  });
  app.post('/api/uploads/:id/cancel', (c) => {
    const s = uploadSession(c, true);
    chunks.cancel(s.user.id, c.req.param('id'));
    return c.json({ cancelled: true });
  });
  app.post('/actions/imports/:id/cancel', async (c) => {
    const { user } = authorizeForm(c, await readFields(c));
    archive.cancelJob(user.id, c.req.param('id'));
    return finish(c, {}, '/imports');
  });
  app.get('/friends', (c) => {
    const s = requireSession(c);
    return show(
      c,
      'Your people',
      screens.friendsScreen(core, s.user, s.csrf, config.federation),
      'friends',
    );
  });
  app.post('/actions/invites', async (c) => {
    const { data, user, token } = authorizeForm(c, await readFields(c));
    const invite = core.createInvite(user.id, value(data, 'kind') as 'registration');
    const link = `${config.origin}/invite/${invite.token}`;
    return wantsJSON(c)
      ? c.json({ ...invite, url: link })
      : show(
          c,
          'An invitation for a friend',
          `<div class="card card-pad"><h1>Send this to someone you know.</h1><p>This invitation can be used once, and expires ${e(date(invite.expiresAt))}. We won’t show the secret link again.</p><label for="invite-link">Private invitation</label><input id="invite-link" readonly value="${e(link)}"><button type="button" class="secondary" data-copy-target="invite-link">Copy invitation</button><hr><a href="/friends">Back to friends</a></div>`,
          'friends',
        );
  });
  app.post('/actions/invites/:id/revoke', async (c) => {
    const { user } = authorizeForm(c, await readFields(c));
    core.revokeInvite(user.id, c.req.param('id'));
    return finish(c, {}, '/friends');
  });
  app.post('/actions/invites/accept', async (c) => {
    const { user, data } = authorizeForm(c, await readFields(c));
    requireSharing();
    core.acceptFriendInvite(user.id, value(data, 'inviteToken'));
    return finish(c, {}, '/friends');
  });
  app.post('/actions/friends/request', async (c) => {
    const { data, user } = authorizeForm(c, await readFields(c));
    requireSharing();
    let actor = value(data, 'actor').trim();
    if (!actor.startsWith(config.origin + '/users/')) {
      if (!config.federation) throw new CoreError(400, 'Connections to other hosts are disabled.');
      const found = await federation.discover(actor, user.username);
      actor = found.id;
    }
    const current = requireSession(c);
    requireSharing();
    const id = core.requestFriend(current.user.id, actor);
    return finish(c, { requestId: id }, '/friends');
  });
  for (const action of ['accept', 'reject', 'cancel'])
    app.post(`/actions/friends/:id/${action}`, async (c) => {
      const { user } = authorizeForm(c, await readFields(c));
      if (action === 'accept') {
        requireSharing();
        core.acceptFriend(user.id, c.req.param('id'));
      }
      if (action === 'reject') core.rejectFriend(user.id, c.req.param('id'));
      if (action === 'cancel') core.cancelFriend(user.id, c.req.param('id'));
      return finish(c, {}, '/friends');
    });
  for (const action of ['remove', 'block', 'unblock', 'preferences'])
    app.post(`/actions/friends/${action}`, async (c) => {
      const { user, data } = authorizeForm(c, await readFields(c)),
        actor = value(data, 'actor');
      if (['remove', 'block'].includes(action) && !flag(data, 'confirmed'))
        throw new CoreError(400, 'Confirm that you want to revoke this person’s access.');
      if (action === 'remove') core.unfriend(user.id, actor);
      if (action === 'block') core.block(user.id, actor);
      if (action === 'unblock') core.unblock(user.id, actor);
      if (action === 'preferences')
        core.setFriendPreference(user.id, actor, {
          muted: flag(data, 'muted'),
          favorite: flag(data, 'favorite'),
        });
      return finish(c, {}, '/friends');
    });
  app.get('/profile', (c) => {
    const s = requireSession(c);
    return c.redirect(`/users/${s.user.username}`);
  });
  app.get('/users/:username', (c) => {
    const s = getSession(c),
      u = core.profile(s?.user.id, c.req.param('username'));
    return show(
      c,
      u.displayName,
      `<div class="card"><div class="profile-cover"></div><div class="profile-info">${avatar(u.displayName, true)}<h1>${e(u.displayName)}</h1><p>${e(u.bio)}</p><small>${e(u.actor)}</small>${s && s.user.id !== u.id ? `<form method="post" action="/actions/friends/request">${csrf(s.csrf)}${hidden('actor', u.actor)}<button>Request friendship</button></form>` : ''}</div></div>${
        s
          ? core
              .feed(s.user.id, { limit: 50 })
              .filter((p) => p.authorId === u.id)
              .map((p) => screens.renderPost(p, s.user, s.csrf))
              .join('')
          : empty(
              'A little privacy is a good thing.',
              'Posts are visible only to their chosen audience.',
            )
      }`,
      'friends',
    );
  });
  app.get('/sharing', (c) => {
    const s = requireSession(c),
      deliveries = store.db
        .prepare(
          'SELECT e.kind,e.recipient_actor,d.state,d.attempts,d.last_status,e.created_at FROM domain_events e LEFT JOIN federation_deliveries d ON d.event_id=e.id WHERE e.actor=? ORDER BY e.created_at DESC LIMIT 100',
        )
        .all(s.user.actor) as {
        kind: string;
        recipient_actor: string;
        state: string | null;
        attempts: number | null;
        last_status: number | null;
        created_at: number;
      }[];
    return show(
      c,
      'Sharing activity',
      heading('Sharing activity', 'What has reached your friends') +
        `<div class="card card-pad"><p>These are delivery receipts from connected hosts. “Received” means the compatible server acknowledged the event. It does not prove that somebody erased a saved copy.</p><div class="table-wrap"><table><thead><tr><th>Action</th><th>Recipient</th><th>Status</th></tr></thead><tbody>${deliveries.map((d) => `<tr><td>${e(d.kind)}<br><small>${e(date(d.created_at))}</small></td><td>${e(d.recipient_actor)}</td><td>${d.state === 'delivered' ? 'Received' : d.state === 'cancelled' ? 'Cancelled' : d.attempts ? 'Waiting to retry' : 'Queued'}</td></tr>`).join('')}</tbody></table></div>${deliveries.length ? '' : '<p class="muted">No deliveries to another host yet. Local sharing is immediate.</p>'}</div>`,
      'friends',
    );
  });
  app.get('/notifications', (c) => {
    const s = requireSession(c),
      items = core.notifications(s.user.id, {
        limit: 50,
        before: Number(c.req.query('before')) || undefined,
        beforeId: c.req.query('beforeId'),
      });
    const labels = {
      post: 'shared a post',
      comment: 'left a comment',
      like: 'liked a post',
      'friend.request': 'sent a friend request',
      'friend.accept': 'accepted your friendship',
    };
    return show(
      c,
      'Notifications',
      heading('Notifications', 'A quiet place to catch up') +
        `<div class="card card-pad"><form method="post" action="/actions/notifications/read">${csrf(s.csrf)}<button class="secondary small">Mark these as read</button></form><p><small>${s.user.quietNotifications ? 'Showing replies and friendship requests.' : 'Showing posts, replies, likes and friendship updates.'} <a href="/settings">Choose what appears</a></small></p>${items.map((n) => `<div class="row" style="padding:14px 0;border-top:1px solid var(--line)">${avatar(n.actorName)}<div><a href="${n.postId ? '/posts/' + encodeURIComponent(n.postId) : '/friends'}"><strong>${e(n.actorName)}</strong> ${e(labels[n.kind])}</a><br><small>${e(date(n.createdAt))}${n.read ? '' : ' · New'}</small></div></div>`).join('') || '<p class="muted">Nothing needs your attention. Enjoy your day.</p>'}</div>${items.length === 50 ? `<a class="button secondary" href="/notifications?before=${items.at(-1)!.createdAt}&beforeId=${encodeURIComponent(items.at(-1)!.id)}">Older notifications</a>` : ''}`,
      'notifications',
    );
  });
  app.post('/actions/notifications/read', async (c) => {
    const { user } = authorizeForm(c, await readFields(c));
    core.markNotificationsRead(user.id);
    return finish(c, {}, '/notifications');
  });
  app.get('/settings', (c) => {
    const s = requireSession(c);
    return show(
      c,
      'Your settings',
      screens.settingsScreen(
        core,
        s.user,
        s.csrf,
        store.setting('last_backup_at'),
        !sharingAllowed(),
      ) +
        '<div class="card card-pad"><h2>Your replies</h2><p>Find and remove your comments, including replies to conversations you can no longer open.</p><a href="/settings/comments">Manage your replies</a></div>' +
        `<div class="card card-pad"><h2>Storage use</h2><p>${(archive.usage(s.user.id) / 1024 ** 2).toFixed(1)} MiB of ${(archive.limits.ownerBytes / 1024 ** 3).toFixed(1)} GiB used by your private records and media.</p><p><small>Limits protect your circle. Memories are never deleted automatically to make room.</small></p></div>`,
      'settings',
    );
  });
  app.get('/settings/comments', (c) => {
    const s = requireSession(c);
    const rawBefore = c.req.query('before');
    const before = rawBefore === undefined ? undefined : Number(rawBefore);
    const beforeId = c.req.query('beforeId');
    if (
      (before !== undefined && (!Number.isSafeInteger(before) || before < 0)) ||
      (beforeId !== undefined && beforeId.length > 2048)
    )
      throw new CoreError(400, 'Invalid page.');
    const comments = core.ownComments(s.user.id, { before, beforeId, limit: 20 });
    return show(
      c,
      'Your replies',
      heading('Your replies', 'Your words stay yours') +
        '<p>You can remove a reply without reopening its conversation. Connected hosts receive a removal request; saved copies and screenshots may remain.</p>' +
        comments
          .map(
            (comment) =>
              `<article class="card card-pad"><small>${e(date(comment.createdAt))}</small>${comment.body ? `<p class="post-body">${e(comment.body)}</p>` : '<p class="muted">The original conversation is no longer available. You can still request removal of your reply.</p>'}${comment.postAvailable ? `<p><a href="/posts/${encodeURIComponent(comment.postId)}">Open conversation</a></p>` : '<p><small>You no longer have access to this conversation.</small></p>'}<form method="post" action="/actions/comments/${encodeURIComponent(comment.id)}/delete">${csrf(s.csrf)}${hidden('returnTo', 'comments')}<button class="danger small">Remove my reply</button></form></article>`,
          )
          .join('') +
        (comments.length ? '' : '<div class="card card-pad"><p>No replies to manage.</p></div>') +
        (comments.length === 20
          ? `<a class="button secondary" href="/settings/comments?before=${comments.at(-1)!.createdAt}&beforeId=${encodeURIComponent(comments.at(-1)!.id)}">Older replies</a>`
          : '') +
        '<p><a href="/settings">Back to settings</a></p>',
      'settings',
    );
  });
  app.post('/actions/settings', async (c) => {
    const { user, data } = authorizeForm(c, await readFields(c));
    core.updateSettings(user.id, {
      displayName: value(data, 'displayName'),
      bio: value(data, 'bio'),
      discoverable: flag(data, 'discoverable'),
      quietNotifications: flag(data, 'quietNotifications'),
      compactFeed: flag(data, 'compactFeed'),
    });
    return finish(c, {}, '/settings?notice=saved');
  });
  app.post('/actions/password', async (c) => {
    const { user, data } = authorizeForm(c, await readFields(c));
    const { recoveryCodes: codes, session: s } = await core.changePassword(
      user.id,
      value(data, 'currentPassword'),
      value(data, 'newPassword'),
      () => {
        requireSession(c);
      },
      true,
    );
    signIn(c, s);
    c.set('session', s);
    return wantsJSON(c)
      ? c.json({ recoveryCodes: codes, csrf: s.csrf })
      : show(c, 'Save new recovery codes', screens.recoveryScreen(codes));
  });
  app.post('/actions/logout-all', async (c) => {
    const { user } = authorizeForm(c, await readFields(c));
    core.logoutAll(user.id);
    deleteCookie(c, cookieName, {
      path: '/',
      secure: config.production,
      httpOnly: true,
      sameSite: 'Strict',
    });
    return finish(c, {}, '/login');
  });
  app.post('/actions/export', async (c) => {
    const { user } = authorizeForm(c, await readFields(c));
    core.rate(`export:${user.id}`, 3, 60 * 60_000);
    const zip = new yazl.ZipFile();
    zip.addBuffer(
      Buffer.from(JSON.stringify(core.exportAccount(user.id), null, 2)),
      'account.json',
    );
    const privateExport = archive.exportZip(user.id),
      output = zip.outputStream as Readable;
    privateExport.on('error', (error) => output.destroy(error));
    zip.on('error', (error) => output.destroy(error));
    output.on('error', () => {});
    output.once('close', () => {
      if (!output.readableEnded) zip.emit('error', new Error('Export cancelled'));
      privateExport.destroy();
    });
    zip.addReadStream(privateExport, 'private-archive.zip');
    zip.end();
    return new Response(Readable.toWeb(output) as ReadableStream, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="clean-bookface-export.zip"',
        'Cache-Control': 'private, no-store',
      },
    });
  });
  app.post('/actions/delete-account', async (c) => {
    const { user, data } = authorizeForm(c, await readFields(c));
    if (value(data, 'confirmation') !== user.username)
      throw new CoreError(400, 'Type your username to confirm.');
    if (core.user(user.id).admin)
      throw new CoreError(
        400,
        'The circle administrator must transfer administration or remove the installation.',
      );
    chunks.deleteOwner(user.id);
    core.deleteAccount(user.id);
    await finishDeletions();
    const cleanupPending = core.pendingAccountDeletions().includes(user.id);
    deleteCookie(c, cookieName, {
      path: '/',
      secure: config.production,
      httpOnly: true,
      sameSite: 'Strict',
    });
    return finish(
      c,
      { closed: true, cleanupPending },
      cleanupPending ? '/login?notice=cleanup-pending' : '/login',
    );
  });
  app.get('/report', (c) => {
    const s = requireSession(c);
    return show(
      c,
      'Report a concern',
      `<div class="card card-pad"><h1>Tell the host what happened.</h1><p>Reports are reviewed by this host. A report includes only the selected post and the explanation you provide.</p><form method="post" action="/actions/report">${csrf(s.csrf)}${field('Account profile URL', 'actor', 'url', 'required', c.req.query('actor') ?? '')}${hidden('postId', c.req.query('post') ?? '')}<label for="reason">What should the host know?</label><textarea id="reason" name="reason" maxlength="2000" required></textarea><button>Send report</button></form></div>`,
      'friends',
    );
  });
  app.post('/actions/report', async (c) => {
    const { data, user } = authorizeForm(c, await readFields(c));
    core.report(
      user.id,
      value(data, 'actor'),
      value(data, 'reason'),
      value(data, 'postId') || undefined,
    );
    return finish(c, {}, '/friends?notice=reported');
  });
  app.post('/actions/appeal', async (c) => {
    const { data, user } = authorizeForm(c, await readFields(c));
    core.appeal(user.id, value(data, 'body'));
    return finish(c, {}, '/settings');
  });
  app.get('/admin/setup', (c) => {
    const s = requireSession(c);
    core.adminReports(s.user.id);
    return show(
      c,
      'Make this circle yours',
      screens.hostSetupScreen({
        origin: config.origin,
        backupAt: store.setting('last_backup_at'),
        imported: archive.list(s.user.id, { limit: 1 }).length > 0,
        friends: core.friends(s.user.id).length,
        federation: config.federation,
      }),
      'admin',
    );
  });
  app.get('/admin/backups', (c) => {
    const s = requireSession(c);
    core.adminReports(s.user.id);
    return show(
      c,
      'Back up your circle',
      screens.backupGuideScreen({
        origin: config.origin,
        lastBackupAt: store.setting('last_backup_at'),
        lastBackupSnapshot: store.setting('last_backup_snapshot'),
        restorePending: !sharingAllowed(),
      }),
      'admin',
    );
  });
  app.get('/admin', (c) => {
    const s = requireSession(c),
      reports = core.adminReports(s.user.id),
      appeals = core.adminAppeals(s.user.id);
    const totalMembers = core.adminMemberCount(s.user.id);
    const requestedPage = Number(c.req.query('page') ?? '1');
    if (!Number.isSafeInteger(requestedPage) || requestedPage < 1)
      throw new CoreError(400, 'Choose a valid member page.');
    const lastPage = Math.max(1, Math.ceil(totalMembers / 100));
    const memberPage = Math.min(requestedPage, lastPage);
    const members = core.adminMembers(s.user.id, { offset: (memberPage - 1) * 100, limit: 100 });
    const appealCards = appeals
      .map((a) => {
        let label = 'Deleted account';
        try {
          const person = core.user(a.userId);
          label = `${person.displayName} (@${person.username})`;
        } catch {}
        return `<div><h3>${e(label)}</h3><p>${e(a.body)}</p><small>${e(a.state)}</small>${a.state === 'open' ? `<form method="post" action="/actions/admin/appeals/${encodeURIComponent(a.id)}">${csrf(s.csrf)}<label>Response<textarea name="response" maxlength="2000" required></textarea></label><select name="accepted"><option value="true">Restore account</option><option value="false">Keep suspension</option></select><button class="secondary">Send decision</button></form>` : `<p>${e(a.response)}</p>`}<hr></div>`;
      })
      .join('');
    const memberNavigation = `<nav aria-label="Member pages"><p>Member page ${memberPage} of ${lastPage} · ${totalMembers} accounts</p>${memberPage > 1 ? `<a href="/admin?page=${memberPage - 1}">Previous members</a> ` : ''}${memberPage < lastPage ? `<a href="/admin?page=${memberPage + 1}">Next members</a>` : ''}</nav>`;
    return show(
      c,
      'Host tools',
      heading('Look after your circle', 'People before growth') +
        `<div class="card card-pad"><h2>Host status</h2><p><a href="/admin/setup">Your host checklist →</a></p><p><a href="/admin/backups">Set up backups, step by step →</a></p><p><a href="/sharing">View your delivery receipts</a></p><p>Connections to other hosts: <strong>${config.federation ? 'enabled' : 'disabled'}</strong>.</p><p>Latest backup: ${e(store.setting('last_backup_at') ?? 'None recorded')}</p><p>${sharingAllowed() ? 'Sharing is enabled.' : 'Sharing is paused pending restore reconciliation.'}</p><p>Manage encrypted backups and restore from the server command line. Keep the recovery secret separate from the backup destination.</p></div><div class="card card-pad"><h2>Blocked servers</h2><p>Block an abusive host from connecting or receiving deliveries. Existing cached posts remain governed by member blocks and audience rules.</p><form method="post" action="/actions/admin/hosts">${csrf(s.csrf)}${field('Server hostname', 'host', 'text', 'required placeholder="abuse.example"')}${hidden('blocked', 'true')}<button class="danger small">Block server</button></form>${federation
          .listBlockedHosts()
          .map(
            (h) =>
              `<form class="row spread" method="post" action="/actions/admin/hosts">${csrf(s.csrf)}${hidden('host', h.host)}${hidden('blocked', 'false')}<span>${e(h.host)}</span><button class="secondary small">Unblock</button></form>`,
          )
          .join(
            '',
          )}</div><div class="card card-pad"><h2>Reports</h2>${reports.map((r) => `<div><strong>${e(r.targetActor)}</strong><p>${e(r.reason)}</p>${r.evidence ? `<blockquote>${e(r.evidence)}</blockquote>` : ''}<small>${e(r.state)}</small><form method="post" action="/actions/admin/reports/${encodeURIComponent(r.id)}/resolve">${csrf(s.csrf)}<button class="secondary small">Mark reviewed</button></form><hr></div>`).join('') || '<p>No reports. Keep it kind.</p>'}</div><div class="card card-pad"><h2>Members</h2>${memberNavigation}${members.map((m) => `<div class="row spread"><span>${e(m.displayName)} <small>@${e(m.username)}${m.admin ? ' · Host' : ''}</small></span>${!m.admin ? `<form method="post" action="/actions/admin/members/${encodeURIComponent(m.id)}/suspend">${csrf(s.csrf)}${hidden('suspended', m.suspended ? 'false' : 'true')}<button class="${m.suspended ? 'secondary' : 'danger'} small">${m.suspended ? 'Restore account' : 'Suspend'}</button></form>` : ''}</div>`).join('')}</div><div class="card card-pad"><h2>Appeals</h2>${appealCards || '<p>No appeals.</p>'}</div><div class="card card-pad"><h2>Hand over hosting</h2><p>The list below shows accounts on this member page. Use the member page links above to find another account.</p><form method="post" action="/actions/admin/transfer" data-confirm="Transfer your administrator role to this member?">${csrf(s.csrf)}<label for="recipient">New host account</label><select id="recipient" name="recipientId" required><option value="" selected disabled>Choose a member…</option>${members
          .filter((m) => m.id !== s.user.id && !m.suspended && !m.admin)
          .map((m) => `<option value="${e(m.id)}">${e(m.displayName)} (@${e(m.username)})</option>`)
          .join(
            '',
          )}</select><button class="danger">Transfer my administrator role</button></form></div>`,
      'admin',
    );
  });
  app.post('/actions/admin/hosts', async (c) => {
    const { user, data } = authorizeForm(c, await readFields(c));
    core.adminReports(user.id);
    federation.setBlockedHost(value(data, 'host'), value(data, 'blocked') === 'true');
    return finish(c, {}, '/admin');
  });
  app.post('/actions/admin/reports/:id/resolve', async (c) => {
    const { user } = authorizeForm(c, await readFields(c));
    core.resolveReport(user.id, c.req.param('id'));
    return finish(c, {}, '/admin');
  });
  app.post('/actions/admin/members/:id/suspend', async (c) => {
    const { user, data } = authorizeForm(c, await readFields(c));
    core.suspend(user.id, c.req.param('id'), value(data, 'suspended') === 'true');
    return finish(c, {}, '/admin');
  });
  app.post('/actions/admin/appeals/:id', async (c) => {
    const { user, data } = authorizeForm(c, await readFields(c));
    core.resolveAppeal(
      user.id,
      c.req.param('id'),
      value(data, 'accepted') === 'true',
      value(data, 'response'),
    );
    return finish(c, {}, '/admin');
  });
  app.post('/actions/admin/transfer', async (c) => {
    const { user, data } = authorizeForm(c, await readFields(c));
    core.transferAdministration(user.id, value(data, 'recipientId'));
    return finish(c, {}, '/settings');
  });
  const prose = (title: string, html: string) =>
    `<section class="card card-pad prose" style="max-width:760px;margin:28px auto"><h1>${title}</h1>${html}</section>`;
  app.get('/getting-started', (c) =>
    show(
      c,
      'Getting started',
      `<div style="max-width:760px;margin:28px auto;padding:0 16px">${screens.gettingStartedScreen()}</div>`,
    ),
  );
  app.get('/about', (c) =>
    show(
      c,
      'What we believe',
      prose(
        'A social network should know when to get out of the way.',
        `<img class="hero-art" src="/assets/our-memories.png" alt="Illustrated blue album of everyday memories"><p>You came for your friends. Somewhere along the way, the feed became a machine for selling your attention. We think you deserve your corner of the internet back.</p><p>Clean Bookface lets you keep your history and choose what to share. No ads. No engagement ranking. No bot accounts pretending to be people. A chronological feed with an end.</p><p>Host it yourself, or join someone you trust. Your host can read the data stored here. Friends can save what you share. We’d rather say that clearly than sell you a comforting fiction.</p><p>This is an independent project, unaffiliated with Meta or Facebook.</p>`,
      ),
    ),
  );
  app.get('/privacy', (c) =>
    show(
      c,
      'Who can see what',
      prose(
        'Private imports. Deliberate sharing.',
        `<h2>Your archive</h2><p>Your imported posts, messages, photos and friend records are visible only through your account. Importing does not publish anything. Search and media follow the same rules.</p><h2>Your shared posts</h2><p>You select an audience. New friends do not gain access to old posts automatically. Shared photos use a separate copy with embedded metadata stripped. Recipients can save plaintext; their host can access its stored copy.</p><h2>Your host</h2><p>The administrator of this installation can access its database and files. This is not end-to-end encrypted. Choose your host carefully. There are no trackers, advertising identifiers, remote fonts or third-party analytics.</p><h2>Leaving and deletion</h2><p>You can download your data and delete your account. Deletion removes active copies here and requests removal from connected hosts. Older encrypted backups retain snapshots until the host expires them. We cannot guarantee deletion of copies someone saved elsewhere.</p><h2>Discovery</h2><p>Handle lookup is off until you enable it. Your old friend list is never uploaded to a matching service. Sharing across hosts reveals your chosen name, server address, selected content and relationship to that recipient.</p><h2>Security and recovery</h2><p>Passwords are hashed; recovery codes are single-use. Your host manages encrypted backups and holds the recovery key. Save your recovery codes somewhere private.</p>`,
      ),
    ),
  );
  app.get('/rules', (c) =>
    show(
      c,
      'House rules',
      prose(
        'Real people. A little consideration.',
        `<ol><li><strong>No bot accounts.</strong> Accounts represent people participating personally. No automated personas, bulk posting, scraping, fake engagement or impersonation.</li><li><strong>Accessibility tools are welcome.</strong> Screen readers, assistive input, normal delivery software and backups are not bot accounts.</li><li><strong>Ask before sharing somebody else’s life.</strong> Having a copy of a conversation is not permission to publish it.</li><li><strong>Respect boundaries.</strong> No harassment, doxxing, threats or evading a block. Report concerns to your host.</li><li><strong>Hosts must review fairly.</strong> Suspensions allow an appeal, data export and account deletion. Invitations and limits reduce abuse; they do not prove that every account is human.</li></ol><p>The aim is a place worth visiting, not one you can’t leave.</p>`,
      ),
    ),
  );
  let federationTimer: ReturnType<typeof setInterval> | undefined,
    maintenanceTimer: ReturnType<typeof setInterval> | undefined;
  let federationTask: Promise<unknown> | undefined;
  let closing = false,
    started = false;
  let startupTask: Promise<void> | undefined;
  let maintenanceTask: Promise<boolean> | undefined;
  const maintenance = (): Promise<boolean> => {
    if (maintenanceTask) return maintenanceTask;
    maintenanceTask = (async () => {
      try {
        core.maintenance();
        await finishDeletions();
        if (started && !closing && ['normal', 'active'].includes(pilotPhase(config, now())))
          archive.startWorker();
        else if (!['normal', 'active'].includes(pilotPhase(config, now())))
          await archive.stopWorker();
        chunks.cleanup();
        await archive.maintenance();
        return true;
      } catch (error) {
        if (!isDatabaseBusy(error)) throw error;
        console.error('Maintenance deferred while an import commits; it will retry.');
        return false;
      }
    })().finally(() => {
      maintenanceTask = undefined;
    });
    return maintenanceTask;
  };
  const start = () => {
    if (started) return;
    started = true;
    startupTask = finishDeletions()
      .then(() => {
        if (!closing && ['normal', 'active'].includes(pilotPhase(config, now())))
          archive.startWorker();
      })
      .catch((error) => {
        console.error(
          'Background startup deferred for maintenance retry:',
          error instanceof Error ? error.name : 'unknown error',
        );
      });
    if (!federationTimer)
      federationTimer = setInterval(() => {
        if (!federationTask && pilotPhase(config, now()) !== 'ended')
          federationTask = federation
            .flush()
            .catch(() => console.error('Federation delivery retry deferred'))
            .finally(() => {
              federationTask = undefined;
            });
      }, 5000);
    federationTimer.unref();
    if (!maintenanceTimer)
      maintenanceTimer = setInterval(() => {
        void maintenance().catch((error) => {
          console.error(
            'Background maintenance failed:',
            error instanceof Error ? error.name : 'unknown error',
          );
        });
      }, 60_000);
    maintenanceTimer.unref();
  };
  const close = async () => {
    closing = true;
    await drainRequests();
    federation.stop();
    if (federationTimer) clearInterval(federationTimer);
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    if (startupTask) await startupTask;
    if (federationTask) await federationTask;
    if (maintenanceTask) await maintenanceTask;
    while (deletionTask) await deletionTask;
    await archive.stopWorker();
    await archive.stopExports();
    store.close();
  };
  if (options.startWorkers) start();
  return {
    app,
    store,
    core,
    archive,
    chunks,
    federation,
    start,
    maintenance,
    close,
    setupPath,
    config,
  };
}
