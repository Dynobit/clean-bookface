export function esc(value: unknown): string {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
export const hidden = (name: string, value: unknown) =>
  `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;
export const csrf = (value: string) => hidden('csrf', value);
export function field(label: string, name: string, type = 'text', extra = '', value = ''): string {
  return `<div class="field"><label for="${esc(name)}">${esc(label)}</label><input id="${esc(name)}" name="${esc(name)}" type="${esc(type)}" value="${esc(value)}" ${extra}></div>`;
}
export function avatar(name: string, large = false): string {
  return `<span class="avatar${large ? ' large' : ''}" aria-hidden="true">${esc(
    name
      .split(/\s+/)
      .map((n) => Array.from(n)[0] ?? '')
      .slice(0, 2)
      .join('')
      .toUpperCase(),
  )}</span>`;
}
export function date(value: string | number | null | undefined): string {
  if (value == null) return 'Date not supplied';
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? 'Date not supplied'
    : d.toLocaleDateString('en', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      });
}
export interface PageUser {
  id: string;
  username: string;
  displayName: string;
  isAdmin?: boolean;
  admin?: boolean;
  role?: string;
  compactFeed?: boolean;
}
export interface PageOptions {
  title: string;
  content: string;
  user?: PageUser | null;
  csrf?: string;
  active?: string;
  notice?: string;
  error?: string;
  aside?: string;
  instanceName?: string;
  origin?: string;
}
export function page(o: PageOptions): string {
  const user = o.user,
    token = o.csrf ?? '',
    name = o.instanceName ?? 'Clean Bookface';
  const navigation = [
    ['feed', '/', '⌂', 'News feed'],
    ['archive', '/archive', '▤', 'Your memories'],
    ['photos', '/photos', '▧', 'Photos'],
    ['friends', '/friends', '♧', 'Friends'],
    ['notifications', '/notifications', '○', 'Notifications'],
    ['imports', '/imports', '⇧', 'Bring your history'],
    ['settings', '/settings', '⚙', 'Settings'],
  ];
  if (user?.admin || user?.isAdmin || user?.role === 'admin')
    navigation.push(['admin', '/admin', '◇', 'Host tools']);
  const flash =
    (o.notice ? `<div class="notice" role="status">${esc(o.notice)}</div>` : '') +
    (o.error ? `<div class="notice error" role="alert">${esc(o.error)}</div>` : '');
  const nav = user
    ? `<aside class="sidebar"><a class="side-profile" href="/profile">${avatar(user.displayName)}<span><strong>${esc(user.displayName)}</strong><br><small>Your profile</small></span></a><nav aria-label="Main">${navigation.map(([key, url, icon, label]) => `<a href="${url}" ${o.active === key ? 'class="active" aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">${icon}</span>${label}</a>`).join('')}</nav><p class="note">A little less noise.<br>A little more friendship.<br><a href="/about">What we believe</a></p></aside>`
    : '';
  const rail =
    o.aside ??
    `<div class="card card-pad"><div class="eyebrow">Your corner of the internet</div><h2>People, not products.</h2><p>Your feed is chronological. Your memories are private until you choose to share. There's nothing here competing for your attention.</p><a class="icon-link" href="/privacy">Who can see what →</a></div><div class="card card-pad"><h2>Bring a friend along.</h2><p>A small circle is a good thing. Invite someone you know and let them settle in.</p><a class="button secondary small" href="/friends">Invite a friend</a></div><p class="muted" style="font-size:.74rem;padding:0 8px">No ads. No bot accounts.<br>No algorithm to keep happy.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="same-origin"><meta name="color-scheme" content="light"><title>${esc(o.title)} · ${esc(name)}</title><link rel="stylesheet" href="/style.css"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><script src="/app.js" defer></script></head><body${user?.compactFeed ? ' class="compact"' : ''}><a href="#main" class="skip">Skip to content</a><header class="topbar"><div class="top-inner"><a class="brand" href="/"><svg class="brand-mark" viewBox="0 0 64 64" fill="currentColor" aria-hidden="true" focusable="false"><path d="M11 8c11 1 19 5 19 13 0 3-2 5-4 7l3 5c1 2-1 3-3 3l1 3-2 4c4 3 6 7 6 12-6-7-13-10-20-10a3 3 0 0 1-3-3V11a3 3 0 0 1 3-3Z"/><path d="M11 8c11 1 19 5 19 13 0 3-2 5-4 7l3 5c1 2-1 3-3 3l1 3-2 4c4 3 6 7 6 12-6-7-13-10-20-10a3 3 0 0 1-3-3V11a3 3 0 0 1 3-3Z" transform="translate(64 0) scale(-1 1)"/><path d="M3 15v32a4 4 0 0 0 4 4c8-1 15 1 21 5-6-6-13-8-19-8a4 4 0 0 1-4-4V15a1 1 0 0 0-2 0Zm58 0v32a4 4 0 0 1-4 4c-8-1-15 1-21 5 6-6 13-8 19-8a4 4 0 0 0 4-4V15a1 1 0 0 1 2 0Z"/></svg>clean bookface</a><span class="header-note">Your memories. Your friends. Your rules.</span>${user ? `<a class="user-link" href="/profile">${esc(user.displayName)}</a><form class="logout" method="post" action="/actions/logout">${csrf(token)}<button type="submit">Log out</button></form>` : '<a class="user-link" href="/login">Log in</a>'}</div></header>${user ? `<div class="layout">${nav}<main class="main" id="main">${flash}${o.content}</main><aside class="right-rail" aria-label="About your circle">${rail}</aside></div>` : `<main id="main">${flash ? `<div style="max-width:1050px;margin:20px auto;padding:0 25px">${flash}</div>` : ''}${o.content}</main>`}<footer class="site-footer">${esc(name)} · Made for a smaller, kinder internet.<a href="/getting-started">Getting started</a><a href="/about">About</a><a href="/privacy">Privacy</a><a href="/rules">House rules</a></footer></body></html>`;
}
export function welcome(form: string): string {
  return `<div class="auth-shell"><section class="auth-intro"><div class="eyebrow">Welcome back to the good part.</div><h1>A place for your people.<br>And your memories.</h1><p class="lead">Bring your photos and stories home. Catch up with friends, on your terms. Then go live a little.</p><img class="hero-art" src="/assets/our-memories.png" alt="A blue photo album filled with illustrated memories of friends and family" width="1774" height="887"><p><a href="/getting-started">Getting started</a></p><div class="privacy-points"><span>✓ No ads</span><span>✓ No bot accounts</span><span>✓ You choose what to share</span></div></section><section class="auth-form">${form}<p class="auth-footer">Your host can access data stored here. Choose someone you trust.<br><a href="/privacy">Read the privacy promise</a></p></section></div>`;
}
export function empty(title: string, body: string, action = ''): string {
  return `<div class="card empty"><div class="empty-mark" aria-hidden="true">❧</div><h2>${esc(title)}</h2><p>${esc(body)}</p>${action}</div>`;
}
export function heading(title: string, eyebrow: string, action = ''): string {
  return `<div class="page-head"><div><div class="eyebrow">${esc(eyebrow)}</div><h1>${esc(title)}</h1></div>${action}</div>`;
}
