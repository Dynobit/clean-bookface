import { verificationUpdate } from './verification-view';
import './style.css';
import { Identity, type Session, type VerificationView } from './identity';
import { ContentStore, type SharedPost } from './content';
import { BrowserOutbox, type PendingPost, type PendingSocial } from './outbox';
import type { SocialAction } from './social';
import {
  setBlocked,
  isBlocked,
  blockedUsers,
  reportSelectedEvidence,
  deactivateAccount,
} from './lifecycle';
import { forgetDeviceCrypto } from './local-cleanup';
import { importArchiveBatches } from './streaming-import';
import { exportArchives, type MemoryRecord } from './archive';

const app = document.querySelector<HTMLElement>('#app')!;
const notice = document.querySelector<HTMLElement>('#notice')!;
const verification = document.querySelector<HTMLElement>('#verification')!;
const SESSION = 'clean-bookface.session.v1';
const CLEANUP = 'clean-bookface.cleanup.v1';
const CLEANUP_PREFIX = 'clean-bookface.cleanup.v2:';
const CLEANUP_TAB = 'clean-bookface.cleanup.tab.v2';
let identity: Identity | undefined;
let content: ContentStore | undefined;
let records: MemoryRecord[] = [];
let feed: SharedPost[] = [];
let section: 'feed' | 'memories' | 'friends' | 'account' = 'feed';
let busy = false;
let objectUrls: string[] = [];
let currentVerification = '';
let loginPassword = '';
let outbox: BrowserOutbox | undefined;
let pendingPost: PendingPost | null = null;
let pendingSocial: PendingSocial | null = null;
let selectedArchivePart: number | null = null;
type CleanupScope = Pick<Session, 'baseUrl' | 'userId' | 'deviceId'> & { message: string };
let pendingCleanup: CleanupScope | undefined;
let pendingCleanupKey: string | undefined;

function cleanupKey(scope: CleanupScope): string {
  return (
    CLEANUP_PREFIX +
    encodeURIComponent(JSON.stringify([scope.baseUrl, scope.userId, scope.deviceId]))
  );
}
function cleanupScope(value: unknown): CleanupScope {
  if (
    !value ||
    typeof value !== 'object' ||
    !['baseUrl', 'userId', 'deviceId', 'message'].every(
      (key) =>
        typeof (value as Record<string, unknown>)[key] === 'string' &&
        (value as Record<string, unknown>)[key],
    )
  )
    throw new Error('Invalid local cleanup record');
  return value as CleanupScope;
}
function storedCleanup(): { key: string; scope: CleanupScope } | undefined {
  // A tab's journal survives reload without being replaced by another tab's
  // different device. Keep its exact scope even if another cleanup already
  // removed the shared record; native deletion is deliberately idempotent.
  const tab = sessionStorage.getItem(CLEANUP_TAB);
  if (tab) {
    const record = JSON.parse(tab);
    const scope = cleanupScope(record.scope);
    if (record.key !== cleanupKey(scope)) throw new Error('Invalid tab cleanup scope');
    return { key: record.key, scope };
  }
  const key =
    Object.keys(localStorage)
      .filter((name) => name.startsWith(CLEANUP_PREFIX))
      .sort()[0] || (localStorage.getItem(CLEANUP) ? CLEANUP : undefined);
  if (!key) return;
  const scope = cleanupScope(JSON.parse(localStorage.getItem(key)!));
  if (key !== CLEANUP && key !== cleanupKey(scope)) throw new Error('Invalid stored cleanup scope');
  return { key, scope };
}
function removeMatchingSession(scope: CleanupScope): void {
  const saved = sessionFromStorage();
  if (
    saved &&
    saved.baseUrl === scope.baseUrl &&
    saved.userId === scope.userId &&
    saved.deviceId === scope.deviceId
  )
    localStorage.removeItem(SESSION);
}

// Only fixed markup is used in this file. All account/content values use textContent.
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = '',
  className = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
}
function button(
  text: string,
  action: () => void | Promise<void>,
  className = '',
): HTMLButtonElement {
  const node = el('button', text, className);
  node.type = 'button';
  node.onclick = () => {
    void run(action);
  };
  return node;
}
function field(
  form: HTMLElement,
  name: string,
  title: string,
  type = 'text',
  value = '',
): HTMLInputElement {
  const label = el('label', title);
  label.htmlFor = name;
  const input = el('input');
  input.id = name;
  input.name = name;
  input.type = type;
  input.value = value;
  if (type === 'password') input.autocomplete = 'current-password';
  form.append(label, input);
  return input;
}
function tell(message: string, error = false): void {
  notice.replaceChildren();
  if (message) {
    const text = el('span', message);
    const dismiss = el('button', '', 'dismiss-notice');
    dismiss.type = 'button';
    dismiss.setAttribute('aria-label', 'Dismiss this notice');
    dismiss.onclick = () => notice.replaceChildren();
    notice.append(text, dismiss);
  }
  notice.className = error ? 'error' : '';
}
async function run(action: () => void | Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  app.setAttribute('aria-busy', 'true');
  app.inert = true;
  try {
    await action();
  } catch (error) {
    // Deliberately omit SDK error objects, request bodies and tokens from the console.
    tell(error instanceof Error ? error.message : 'That did not finish. Please try again.', true);
  } finally {
    busy = false;
    app.setAttribute('aria-busy', 'false');
    app.inert = false;
  }
}
function clear(): void {
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls = [];
  app.replaceChildren();
}
function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = el('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
function card(title: string): HTMLElement {
  const c = el('section', '', 'card');
  c.append(el('h2', title));
  return c;
}
function sessionFromStorage(): Session | null {
  const raw = localStorage.getItem(SESSION);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return ['baseUrl', 'userId', 'deviceId', 'accessToken'].every(
      (k) => typeof v[k] === 'string' && v[k],
    )
      ? v
      : null;
  } catch {
    return null;
  }
}
function login(): void {
  clear();
  const fragment = new URLSearchParams(location.hash.slice(1));
  const home = fragment.get('home') || '';
  const token = fragment.get('invite') || '';
  if (location.hash) history.replaceState(null, '', location.pathname);
  const entry = el('div', '', 'entry');
  const intro = el('section', '', 'welcome');
  intro.append(
    el('p', 'A little more like the old days', 'eyebrow'),
    el('h1', 'A place for your friends.\nAnd nobody’s advertisers.'),
    el('p', 'Bring your memories. Keep the people. Leave the machinery behind.'),
  );
  const list = el('ul');
  for (const text of [
    'Your archive starts private. You choose what to share.',
    'Posts appear in order. There is no algorithm to please.',
    'Your browser encrypts memories before your host stores them.',
  ])
    list.append(el('li', text));
  intro.append(
    list,
    el(
      'p',
      'This is the encrypted development preview. Use fictional data while the new version is being tested.',
      'notice-inline warning',
    ),
  );
  const form = el('form', '', 'card');
  form.append(el('h2', token ? 'You’re invited.' : 'Come on in.'));
  const mode = el('select');
  mode.id = 'mode';
  mode.setAttribute('aria-label', 'Account action');
  for (const [value, text] of [
    ['signin', 'Sign in'],
    ['join', 'Join with an invitation'],
  ]) {
    const o = el('option', text);
    o.value = value;
    mode.append(o);
  }
  mode.value = token ? 'join' : 'signin';
  form.append(mode);
  const host = field(form, 'home', 'Your home’s address', 'url', home);
  host.required = true;
  host.placeholder = 'https://home.example.org';
  host.autocomplete = 'off';
  form.append(
    el(
      'p',
      'Your friend’s invitation fills this in. This home stores encrypted data; it should be separate from this browser app.',
      'help',
    ),
  );
  const invitation = field(form, 'invitation', 'Invitation code', 'text', token);
  invitation.autocomplete = 'off';
  invitation.spellcheck = false;
  const username = field(form, 'username', 'Username');
  username.required = true;
  username.autocapitalize = 'none';
  username.autocomplete = 'username';
  username.spellcheck = false;
  const password = field(form, 'password', 'Password', 'password');
  password.required = true;
  password.maxLength = 1024;
  const hint = el('p', '', 'help');
  form.append(hint);
  const submit = el('button', 'Sign in', 'form-action');
  submit.type = 'submit';
  form.append(submit);
  const update = () => {
    const joining = mode.value === 'join';
    invitation.hidden = !joining;
    form.querySelector<HTMLLabelElement>('label[for=invitation]')!.hidden = !joining;
    invitation.required = joining;
    password.minLength = joining ? 12 : 1;
    password.autocomplete = joining ? 'new-password' : 'current-password';
    submit.textContent = joining ? 'Create my account' : 'Sign in';
    hint.textContent = joining
      ? 'Use at least 12 characters. You will save a separate recovery kit for your memories next.'
      : 'Signing in on a new browser also needs your recovery kit to open your memories.';
  };
  mode.onchange = update;
  update();
  form.onsubmit = (event) => {
    event.preventDefault();
    void run(async () => {
      submit.disabled = true;
      try {
        if (new URL(host.value).origin === location.origin)
          throw new Error(
            'Choose a separate storage host. The host must not also deliver this browser app.',
          );
        loginPassword = password.value;
        tell(mode.value === 'join' ? 'Creating your account…' : 'Signing in…');
        const session = await Identity.authenticate({
          baseUrl: host.value,
          username: username.value.trim(),
          password: password.value,
          ...(mode.value === 'join' ? { invitationToken: invitation.value.trim() } : {}),
        });
        localStorage.setItem(SESSION, JSON.stringify(session));
        password.value = '';
        await openSession(session);
      } finally {
        submit.disabled = false;
      }
    });
  };
  entry.append(intro, form);
  app.append(entry);
  app.setAttribute('aria-busy', 'false');
}
async function openSession(session: Session): Promise<void> {
  tell('Opening the secure browser and connecting to your home…');
  identity = await Identity.open(session, showVerification);
  content = new ContentStore(identity.client, (id) => identity!.requireVerifiedUser(id));
  outbox = await BrowserOutbox.open(session);
  pendingPost = await outbox.load();
  pendingSocial = await outbox.loadSocial();
  const status = await identity.status();
  tell('');
  if (!status.recoveryReady) {
    recovery(status.recoveryConfigured || status.hasIdentity);
    return;
  }
  if (!status.ownDeviceTrusted || !status.crossSigningReady) {
    recovery(true);
    return;
  }
  loginPassword = '';
  await refresh();
}
function recovery(existing: boolean): void {
  clear();
  const c = card(
    existing ? 'Welcome back. Open your memories.' : 'Keep a spare key to your memories.',
  );
  c.classList.add('narrow');
  c.append(
    el(
      'p',
      existing
        ? 'Your account password gets you through the door. Your recovery kit opens the private part of your book.'
        : 'Save this kit somewhere you control, such as your password manager or a printed copy. Your host cannot replace it.',
    ),
  );
  c.append(
    el(
      'p',
      'Anyone with both your account access and this kit can open your memories. Do not send it to your host or a friend.',
      'notice-inline',
    ),
  );
  const form = el('form');
  const pass = field(form, 'recovery-password', 'Account password', 'password', loginPassword);
  pass.required = true;
  if (existing) {
    const key = field(form, 'recovery-key', 'Recovery key');
    key.autocomplete = 'off';
    key.spellcheck = false;
    key.required = true;
    key.classList.add('secret');
    const restore = el('button', 'Open my memories', 'form-action');
    restore.type = 'submit';
    form.append(restore);
    form.onsubmit = (e) => {
      e.preventDefault();
      void run(async () => {
        restore.disabled = true;
        try {
          await identity!.restoreRecovery(key.value, pass.value);
          key.value = '';
          pass.value = '';
          loginPassword = '';
          await refresh();
          tell('Your memories are open on this browser.');
        } finally {
          restore.disabled = false;
        }
      });
    };
  } else {
    const prepare = button(
      'Make my recovery kit',
      async () => {
        if (!pass.reportValidity()) return;
        const key = await identity!.prepareRecovery();
        prepare.hidden = true;
        const area = el('textarea');
        area.readOnly = true;
        area.className = 'secret';
        area.value = key;
        area.setAttribute('aria-label', 'Your recovery key');
        const kit = {
          format: 'clean-bookface-recovery-v1',
          home: identity!.session.baseUrl,
          account: identity!.session.userId,
          recoveryKey: key,
        };
        const save = button('Download recovery kit', () =>
          download(
            new Blob([JSON.stringify(kit, null, 2)], { type: 'application/json' }),
            'clean-bookface-recovery.json',
          ),
        );
        const confirm = field(form, 'confirm-key', 'Type the last 6 characters of your saved key');
        confirm.autocomplete = 'off';
        confirm.spellcheck = false;
        const complete = button('I saved it. Open my book.', async () => {
          if (confirm.value.replace(/\s/g, '') !== key.replace(/\s/g, '').slice(-6))
            throw new Error('Check your saved copy and type its last 6 characters.');
          complete.disabled = true;
          try {
            await identity!.setupRecovery(pass.value);
            identity!.acknowledgeRecoveryKey();
            pass.value = '';
            area.value = '';
            loginPassword = '';
            await refresh();
            tell('Your book is ready. Imports stay private.');
          } finally {
            complete.disabled = false;
          }
        });
        form.append(area, save, confirm.previousElementSibling!, confirm, complete);
      },
      'form-action',
    );
    form.append(prepare);
    form.onsubmit = (e) => e.preventDefault();
  }
  c.append(form, button('Use a different account', signOut, 'secondary form-action'));
  app.append(c);
}
async function refresh(): Promise<void> {
  if (!content) return;
  tell('Opening your encrypted memories…');
  records = await content.privateArchive();
  selectedArchivePart = null;
  feed = await content.posts();
  render();
  tell('');
}
function render(): void {
  clear();
  const shell = el('div', '', 'shell');
  const nav = el('nav', '', 'sidebar');
  nav.setAttribute('aria-label', 'Your book');
  const who = el('div', '', 'identity');
  who.append(el('p', 'Your book', 'home-label'), el('p', identity!.session.userId));
  nav.append(who);
  for (const [value, title] of [
    ['feed', 'News feed'],
    ['memories', 'My memories'],
    ['friends', 'Friends'],
    ['account', 'My account'],
  ] as const)
    nav.append(
      button(
        title,
        () => {
          section = value;
          render();
        },
        value === section ? 'active' : '',
      ),
    );
  const center = el('div');
  center.append(el('p', identity!.session.userId, 'mobile-account'));
  if (section === 'feed') {
    composer(center);
    center.append(el('h2', 'News feed'));
    for (const locked of content!.lockedRooms())
      center.append(
        el(
          'p',
          `A conversation with ${locked.userId} is locked: ${locked.reason}`,
          'notice-inline',
        ),
      );
    if (!feed.length)
      center.append(
        empty(
          'A quiet start.',
          'Add a friend, compare your identity check, and share something worth keeping.',
        ),
      );
    else for (const p of feed) center.append(recordCard(p.record, p.sender, false, p.timestamp, p));
  }
  if (section === 'memories') memories(center);
  if (section === 'friends') friends(center);
  if (section === 'account') account(center);
  const aside = el('aside', '', 'aside');
  const note = card('Your corner of the web');
  note.append(
    el('p', 'No trending tab. No suggested strangers. Just the people you choose.'),
    el('p', 'Imported memories are private until you share a separate copy.', 'help'),
    button('Refresh my book', refresh, 'secondary small'),
  );
  const help = card('Still yours tomorrow');
  help.append(
    el(
      'p',
      'Keep a copy of your archive and your recovery kit. A hosting service can close; your memories should come with you.',
    ),
    el('a', 'Read the source & help build it'),
  );
  const link = help.querySelector('a')!;
  link.href = 'https://github.com/Dynobit/clean-bookface';
  link.target = '_blank';
  link.rel = 'noreferrer';
  aside.append(note, help);
  shell.append(nav, center, aside);
  app.append(shell);
}
function empty(title: string, body: string): HTMLElement {
  const c = el('div', '', 'card empty');
  c.append(el('h3', title), el('p', body));
  return c;
}
function audience(parent: HTMLElement): () => string[] {
  const rooms = content!.friendRooms();
  const chosen = new Set<string>();
  const heading = el('p', 'Share a separate copy with:', 'help');
  parent.append(heading);
  for (const friend of rooms) {
    const label = el('label', '', 'check');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.value = friend.userId;
    cb.onchange = () => {
      if (cb.checked) chosen.add(cb.value);
      else chosen.delete(cb.value);
    };
    label.append(cb, document.createTextNode(friend.userId));
    parent.append(label);
  }
  if (!rooms.length) parent.append(el('p', 'Add and verify a friend first.', 'help'));
  return () => [...chosen];
}
function composer(parent: HTMLElement): void {
  if (pendingSocial) {
    const pending = card('A conversation change is waiting');
    pending.append(
      el(
        'p',
        'Retry sends the same change, even after reopening this browser. Keep this browser until it finishes.',
      ),
      button('Finish this conversation change', finishSocial),
      button(
        'Stop retrying this change',
        async () => {
          await outbox!.clear('social');
          pendingSocial = null;
          render();
          tell('Retries stopped. A change already received by your friend remains.');
        },
        'secondary',
      ),
    );
    parent.append(pending);
  }
  const c = card('What’s on your mind?');
  const text = el('textarea');
  text.setAttribute('aria-label', 'Write a post');
  text.placeholder = 'A small update for your people…';
  text.maxLength = 20_000;
  c.append(text);
  const choose = audience(c);
  if (pendingPost) {
    text.value = pendingPost.record.text;
    text.readOnly = true;
    c.append(
      el(
        'p',
        'A post is waiting to finish sending. Retry keeps the same post and the same recipients, including after refreshing this browser.',
        'notice-inline',
      ),
    );
    c.append(
      button(
        'Stop retrying this post',
        async () => {
          await outbox!.clear();
          pendingPost = null;
          render();
          tell('Retries stopped. Anyone who already received this post keeps their copy.');
        },
        'secondary small',
      ),
      el(
        'p',
        'Stopping retries does not remove copies already delivered. People still waiting will not receive another attempt.',
        'help',
      ),
    );
  }
  c.append(
    button(
      pendingPost ? 'Finish sending this post' : 'Share with selected friends',
      async () => {
        if (!pendingPost) {
          if (!text.value.trim()) throw new Error('Write a little something first.');
          if (!choose().length) throw new Error('Choose at least one friend.');
          const record: MemoryRecord = {
            id: crypto.randomUUID(),
            kind: 'post',
            timestamp: Date.now(),
            text: text.value,
            title: '',
            sourcePath: '',
            attachments: [],
            privateOnly: false,
          };
          const queued = { record, recipients: choose() };
          await outbox!.save(queued);
          pendingPost = queued;
          text.readOnly = true;
        }
        try {
          await content!.share(pendingPost.record, pendingPost.recipients);
          await identity!.waitForKeyBackup();
        } catch (error) {
          render();
          throw error;
        }
        await outbox!.clear();
        pendingPost = null;
        text.value = '';
        await refresh();
        tell('Shared with the people you selected. Recovery backup checked.');
      },
      'form-action',
    ),
  );
  parent.append(c);
}
function memories(parent: HTMLElement): void {
  const c = card('Your memories, brought home');
  const overflow = content!.archiveOverflow();
  if (selectedArchivePart !== null) {
    c.append(
      el(
        'p',
        `${selectedArchivePart ? `Viewing saved import ${selectedArchivePart}` : 'Viewing a saved import'}. Search and the visible-memory download cover this part only. Your other saved parts remain available below.`,
        'notice-inline',
      ),
      button('Back to recent memories', refresh, 'secondary'),
    );
  }
  if (overflow)
    c.append(
      el(
        'p',
        'Your saved archive is larger than this preview can open at once. Search covers only the memories shown here. Every saved import is still available below as a separate download. Keep all parts to keep all your memories.',
        'notice-inline warning',
      ),
    );
  const conflicts = content!.archiveConflicts();
  if (conflicts.length)
    c.append(
      el(
        'p',
        overflow
          ? 'Some memories have different saved versions. Saved-import downloads keep every version; this view may show only part of your archive.'
          : `${conflicts.length} memories have different saved versions. Both versions are kept below and in your download. Nothing was overwritten.`,
        'notice-inline warning',
      ),
    );
  c.append(
    el(
      'p',
      'Choose the JSON ZIP files you downloaded from Facebook, or a Clean Bookface export. Everything stays private.',
    ),
  );
  const input = field(c, 'archive-files', 'Choose archive ZIP files', 'file');
  input.multiple = true;
  input.accept = '.zip,application/zip';
  c.append(
    el(
      'p',
      'Facebook downloads are read in small parts: up to 10 GiB in total, 50,000 memories and 64 MiB per original media file. Portable Clean Bookface exports retain a 256 MiB input limit. Your original files stay on your computer.',
      'help',
    ),
  );
  c.append(
    button(
      'Bring in my memories',
      async () => {
        if (!input.files?.length) throw new Error('Choose an archive ZIP first.');
        const controller = new AbortController();
        const progress = el('aside', '', 'import-progress');
        const stop = el('button', 'Stop after this part', 'secondary');
        stop.type = 'button';
        stop.onclick = () => {
          controller.abort();
          stop.disabled = true;
          stop.textContent = 'Stopping after the current save…';
        };
        progress.append(stop);
        document.body.append(progress);
        let count = 0,
          accepted = 0,
          confirmed = 0;
        const warnings = new Set<string>();
        try {
          for await (const batch of importArchiveBatches([...input.files], {
            signal: controller.signal,
            onProgress: (p) =>
              tell(
                `Reading privately: ${p.records} memories · ${Math.round(p.decodedBytes / 1024 / 1024)} MiB read`,
              ),
          })) {
            for (const warning of batch.warnings) warnings.add(warning);
            if (!batch.records.length) continue;
            tell(`Saving encrypted part ${accepted + 1}…`);
            await content!.appendArchiveBatch(batch.records);
            accepted++;
            count += batch.records.length;
            tell(`Checking recovery for part ${accepted}…`);
            await identity!.waitForKeyBackup();
            confirmed++;
          }
          await refresh();
          tell(
            `${count} memories imported privately in ${accepted} parts. Recovery checked.${warnings.size ? ` ${[...warnings].join(' ')}` : ''}`,
          );
        } catch (error) {
          const reason = controller.signal.aborted
            ? 'Import stopped.'
            : error instanceof Error
              ? error.message
              : 'Import did not finish.';
          throw new Error(
            `${reason} ${accepted} parts saved; recovery confirmed for ${confirmed}. Keep this browser and your original ZIP files. Choose the same files to resume; saved parts are checked before another upload.`,
          );
        } finally {
          progress.remove();
        }
      },
      'form-action',
    ),
  );
  const how = el('details');
  how.append(
    el('summary', 'How do I get my Facebook data?'),
    el(
      'p',
      'In Facebook, open Accounts Center → Your information and permissions → Download your information. Choose your Facebook profile, all time, and JSON. Keep every part of the ZIP download together. Bring the files here when they are ready.',
    ),
  );
  const link = el('a', 'Facebook’s current download instructions');
  link.href = 'https://www.facebook.com/help/212802592074644';
  link.target = '_blank';
  link.rel = 'noreferrer';
  how.append(
    link,
    el(
      'p',
      'You can keep using Facebook, deactivate it, or ask Facebook to delete your account. That is your choice. First confirm your download opens and contains what you want to keep. Deleting Facebook does not delete other people’s copies.',
    ),
  );
  c.append(how);
  c.append(
    button(
      overflow || selectedArchivePart !== null
        ? 'Download visible memories'
        : 'Download my archive',
      async () => {
        try {
          download(await exportArchives(records), 'clean-bookface-memories.zip');
        } catch (error) {
          if (
            error instanceof Error &&
            /^Archive (record|expansion|manifest|output) limit exceeded$/.test(error.message)
          )
            throw new Error(
              'These memories are too large for one download. Use “Download my saved imports separately” below to keep every part.',
            );
          throw error;
        }
        tell(
          'This downloaded ZIP is readable without your recovery kit. Keep it somewhere private.',
        );
      },
      'secondary form-action',
    ),
  );
  archiveDownloads(c, Boolean(overflow));
  parent.append(c);
  const search = field(parent, 'memory-search', 'Find a memory');
  search.type = 'search';
  search.placeholder = 'Search the memories currently shown';
  const results = el('div');
  parent.append(
    el('p', `${records.length} private memories${overflow ? ' in this view' : ''}`, 'help'),
    results,
  );
  const show = () => {
    results.replaceChildren();
    const term = search.value.toLocaleLowerCase();
    const found = records.filter((r) =>
      (r.title + ' ' + r.text).toLocaleLowerCase().includes(term),
    );
    for (const r of found.slice(0, 100)) results.append(recordCard(r, 'Only you', true));
    if (found.length > 100)
      results.append(el('p', 'Showing the first 100. Search to narrow them down.', 'help'));
    if (!found.length)
      results.append(
        empty('Your memories will appear here.', 'Nothing is shared just because you import it.'),
      );
  };
  search.oninput = show;
  show();
  parent.append(
    button(
      'Search every saved import',
      async () => {
        const query = search.value;
        const found = await content!.searchArchive(search.value, 50, (n) =>
          tell(`Searching privately: ${n} saved parts checked…`),
        );
        results.replaceChildren();
        results.append(
          el(
            'p',
            `${found.matches.length} matches${found.limited ? ' (showing the first 50)' : ''}. Repeated imports can contain the same memory.`,
            'help',
          ),
        );
        for (const hit of found.matches) {
          const c = card(hit.title || 'Saved memory');
          c.append(
            el('p', hit.excerpt, 'post-body'),
            button(
              'Open this saved part',
              async () => {
                records = await content!.readArchiveBatch(hit.roomId, hit.eventId);
                selectedArchivePart = 0;
                render();
                const search = app.querySelector<HTMLInputElement>('#memory-search');
                if (search) {
                  search.value = query;
                  search.dispatchEvent(new Event('input'));
                }
                tell('Opened the matching saved part. Its original media is available here.');
              },
              'secondary',
            ),
          );
          results.append(c);
        }
        tell(
          found.limited
            ? 'Search stopped at 50 matches. Narrow your words to find a particular memory.'
            : `Search complete: ${found.partsChecked} saved parts checked.`,
        );
      },
      'secondary form-action',
    ),
  );
}
function archiveDownloads(parent: HTMLElement, expanded: boolean): void {
  const details = el('details');
  details.open = expanded;
  details.append(
    el('summary', 'Download my saved imports separately'),
    el(
      'p',
      'Each ZIP contains one complete saved import. A memory imported more than once may appear in several downloads. These files are readable without your recovery kit; keep them somewhere private.',
      'help',
    ),
  );
  const list = el('div');
  let cursor: string | undefined;
  let count = 0;
  const more = button('Show saved imports', async () => {
    const page = await content!.archiveBatches(cursor);
    for (const batch of page.batches) {
      const number = ++count;
      list.append(
        button(
          `View saved import ${number}`,
          async () => {
            records = await content!.readArchiveBatch(batch.roomId, batch.eventId);
            selectedArchivePart = number;
            section = 'memories';
            render();
            tell(`Opened saved import ${number}. Nothing was shared.`);
          },
          'secondary form-action',
        ),
        button(
          `Download saved import ${number}`,
          async () => {
            download(
              await content!.downloadArchiveBatch(batch.roomId, batch.eventId),
              `clean-bookface-memories-part-${number}.zip`,
            );
            tell('Saved import downloaded. Keep every part somewhere private.');
          },
          'secondary form-action',
        ),
      );
    }
    cursor = page.nextCursor;
    more.textContent = cursor ? 'Show more saved imports' : 'All saved imports are listed';
    more.disabled = !cursor;
    if (!count) list.append(el('p', 'No saved imports yet.', 'help'));
  });
  details.append(list, more);
  parent.append(details);
}
function recordCard(
  record: MemoryRecord,
  sender: string,
  privateRecord: boolean,
  sentAt?: number,
  shared?: SharedPost,
): HTMLElement {
  const c = el('article', '', 'card');
  const head = el('div', '', 'post-head');
  head.append(
    el('strong', sender),
    el(
      'span',
      record.timestamp
        ? new Date(record.timestamp).toLocaleString()
        : sentAt
          ? new Date(sentAt).toLocaleString()
          : 'Date unknown',
    ),
  );
  c.append(head);
  if (record.title) c.append(el('p', record.title, 'post-title'));
  if (record.conflictOf)
    c.append(el('p', 'Another saved version of this memory. Both copies are kept.', 'help'));
  c.append(el('p', record.text, 'post-body'));
  const media = el('div', '', 'post-images');
  for (const a of record.attachments) {
    if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(a.mimeType)) {
      const img = el('img');
      const url = URL.createObjectURL(a.bytes);
      objectUrls.push(url);
      img.src = url;
      img.alt = record.title || 'Imported photo';
      img.loading = 'lazy';
      media.append(img);
    } else media.append(el('p', `${a.mimeType} attachment · included in your download`, 'help'));
  }
  c.append(media);
  if (shared) conversation(c, shared);
  if (privateRecord) {
    c.append(el('span', 'Private · only you', 'pill'));
    if (!record.privateOnly && !['message', 'friend'].includes(record.kind)) {
      const d = el('details');
      d.append(el('summary', 'Share this memory'));
      const choose = audience(d);
      d.append(
        button(
          'Share selected copy',
          async () => {
            if (!choose().length) throw new Error('Choose at least one friend.');
            await content!.share(record, choose());
            await identity!.waitForKeyBackup();
            tell('Shared a separate copy. Your original is still private.');
          },
          'small form-action',
        ),
      );
      c.append(d);
    }
  }
  return c;
}
async function queueSocial(post: SharedPost, action: SocialAction): Promise<void> {
  if (pendingSocial) throw new Error('Finish or stop the waiting conversation change first.');
  const queued: PendingSocial = {
    post: { roomId: post.roomId, id: post.id, sender: post.sender },
    operationId: crypto.randomUUID(),
    action,
  };
  await outbox!.saveSocial(queued);
  pendingSocial = queued;
  await finishSocial();
}
async function finishSocial(): Promise<void> {
  if (!pendingSocial) return;
  const { post, action, operationId } = pendingSocial;
  try {
    if (action.kind === 'comment') await content!.addComment(post, action.text, operationId);
    else if (action.kind === 'remove-comment')
      await content!.removeComment(post, action.commentId, operationId);
    else if (action.kind === 'reaction')
      await content!.setReaction(post, action.reaction, operationId);
    else await content!.removePost(post, operationId);
    await identity!.waitForKeyBackup();
    await outbox!.clear('social');
    pendingSocial = null;
    await refresh();
    tell('Conversation updated. Recovery backup checked.');
  } catch (error) {
    render();
    throw error;
  }
}
function conversation(c: HTMLElement, post: SharedPost): void {
  const friend =
    content!.friendRooms().find((r) => r.roomId === post.roomId)?.userId || post.sender;
  c.append(
    el('p', `A conversation between you and ${friend}. Replies stay in this conversation.`, 'help'),
  );
  const actions = el('div', '', 'post-actions');
  const reaction = el('select');
  reaction.setAttribute('aria-label', 'Your reaction');
  for (const [value, label] of [
    ['', 'No reaction'],
    ['♥', 'Love'],
    ['👍', 'Like'],
    ['😂', 'Laugh'],
    ['😮', 'Wow'],
    ['😢', 'Sad'],
  ]) {
    const option = el('option', label);
    option.value = value;
    reaction.append(option);
  }
  reaction.value =
    post.reactions.find((r) => r.sender === identity!.session.userId)?.reaction || '';
  actions.append(
    reaction,
    button(
      'Save reaction',
      () => queueSocial(post, { kind: 'reaction', reaction: reaction.value || null }),
      'small secondary',
    ),
  );
  if (post.sender === identity!.session.userId)
    actions.append(
      button(
        'Remove this shared copy',
        () => queueSocial(post, { kind: 'remove-post' }),
        'small danger',
      ),
    );
  c.append(actions);
  for (const r of post.reactions) c.append(el('p', `${r.reaction} ${r.sender}`, 'help'));
  const comments = el('div', '', 'comments');
  for (const comment of post.comments) {
    const row = el('div', '', 'comment');
    row.append(el('strong', comment.sender), el('p', comment.text, 'post-body'));
    if (comment.sender === identity!.session.userId)
      row.append(
        button(
          'Remove my comment',
          () => queueSocial(post, { kind: 'remove-comment', commentId: comment.id }),
          'small danger',
        ),
      );
    comments.append(row);
  }
  c.append(comments);
  const reply = el('textarea');
  reply.maxLength = 4000;
  reply.setAttribute('aria-label', 'Write a comment');
  reply.placeholder = 'Say something to your friend…';
  c.append(
    reply,
    button(
      'Send comment',
      () => queueSocial(post, { kind: 'comment', text: reply.value }),
      'small form-action',
    ),
  );
  if (post.sender !== identity!.session.userId) {
    const report = el('details');
    report.append(el('summary', 'Report this post'));
    report.append(
      el(
        'p',
        'Your home’s moderator receives the explanation and text you select below in readable form. No archive, photo or encryption key is included.',
        'help',
      ),
    );
    const reason = field(report, `report-${crypto.randomUUID()}`, 'What happened?');
    reason.maxLength = 1000;
    const evidence = el('textarea');
    evidence.maxLength = 4000;
    evidence.setAttribute('aria-label', 'Text to include in report');
    report.append(
      evidence,
      button(
        'Use this post’s text',
        () => {
          evidence.value = post.record.text.slice(0, 4000);
        },
        'small secondary',
      ),
      button(
        'Send selected evidence to my host',
        async () => {
          await reportSelectedEvidence(identity!.client, post, reason.value, evidence.value);
          reason.value = '';
          evidence.value = '';
          report.open = false;
          tell('Your selected report was sent to your home’s moderator.');
        },
        'small danger',
      ),
    );
    c.append(report);
  }
}
function friends(parent: HTMLElement): void {
  const c = card('Keep it to your people');
  c.append(
    el(
      'p',
      'Ask your friend for their full account name. Before sharing, compare the identity check together over a call or in person.',
    ),
  );
  const input = field(c, 'friend-id', 'Friend’s account name');
  input.placeholder = '@robin:home.example.org';
  input.autocapitalize = 'none';
  input.spellcheck = false;
  c.append(
    button(
      'Add friend',
      async () => {
        await content!.inviteFriend(input.value.trim());
        render();
        tell('Invitation sent. Your friend needs to accept it before you compare.');
      },
      'form-action',
    ),
  );
  const list = el('ul', '', 'friends-list');
  for (const friend of content!.friendRooms()) {
    const li = el('li');
    li.append(el('p', friend.userId));
    const row = el('div', '', 'row');
    row.append(
      button(
        'Check identity',
        async () => {
          await content!.prepareVerification(friend.roomId, friend.userId);
          await identity!.requestVerification(friend.userId, friend.roomId);
        },
        'small secondary',
      ),
      button(
        'Remove friend',
        async () => {
          await content!.revokeFriend(friend.userId);
          render();
          tell('Removed. They keep copies you already shared; new posts will not go to them.');
        },
        'small danger',
      ),
      button(
        'Block this account',
        async () => {
          await content!.revokeFriend(friend.userId);
          await setBlocked(identity!.client, friend.userId, true);
          await refresh();
          tell('Blocked. This account will not receive new posts or invitations from you.');
        },
        'small danger',
      ),
    );
    li.append(row);
    list.append(li);
  }
  c.append(list);
  parent.append(c);
  const invites = identity!.client.getRooms().filter((r) => r.getMyMembership() === 'invite');
  for (const room of invites) {
    const pending = card('Friend invitation');
    const inviter =
      room.getMember(identity!.session.userId)?.events.member?.getSender() || 'Unknown account';
    if (isBlocked(identity!.client, inviter)) continue;
    pending.append(
      el('p', inviter),
      button('Accept friend invitation', async () => {
        await content!.acceptInvite(room.roomId);
        render();
        tell('Accepted. Check their identity before sharing.');
      }),
      button(
        'Decline invitation',
        async () => {
          await identity!.client.leave(room.roomId);
          await refresh();
        },
        'secondary',
      ),
    );
    parent.append(pending);
  }
  parent.append(button('Check for invitations', refresh, 'secondary'));
  const blocked = blockedUsers(identity!.client);
  if (blocked.length) {
    const c = card('Blocked accounts');
    for (const userId of blocked) {
      const row = el('div', '', 'row');
      row.append(
        el('p', userId),
        button(
          'Unblock account',
          async () => {
            await setBlocked(identity!.client, userId, false);
            render();
            tell(
              'Unblocked. Adding them as a friend again needs a new invitation and identity check.',
            );
          },
          'small secondary',
        ),
      );
      c.append(row);
    }
    parent.append(c);
  }
}
function account(parent: HTMLElement): void {
  const c = card('Your account');
  c.append(
    el('p', identity!.session.userId),
    el('p', `Storage home: ${identity!.session.baseUrl}`, 'help'),
    el(
      'p',
      'This browser holds your device keys. A storage host can see account names, connections, timing and file sizes. It cannot read correctly encrypted content without a recipient’s keys. The publisher of this browser app remains trusted.',
    ),
  );
  c.append(
    el(
      'p',
      'Your host’s backup protects against server loss. Your recovery kit protects against losing this browser. Keep both responsibilities separate.',
      'notice-inline',
    ),
  );
  c.append(
    button(
      'Open my archive downloads',
      () => {
        section = 'memories';
        render();
      },
      'secondary',
    ),
  );
  c.append(
    el(
      'p',
      'Downloaded archives are readable files. Keep them private. Before signing out, make sure your recovery kit is saved.',
      'help',
    ),
    button('Sign out of this browser', signOut, 'secondary'),
  );
  parent.append(c);
  const close = el('details', '', 'card');
  close.append(el('summary', 'Close my account'));
  close.append(
    el(
      'p',
      'Download your memories first. Closing removes account access and this browser’s keys, and asks your home to erase your profile. Friends may keep shared copies; encrypted events, media and backups can remain on hosts until their retention policy removes them. Contact your host about retained storage.',
    ),
  );
  const confirmation = field(
    close,
    'close-account-confirmation',
    'Type your complete account name',
  );
  const password = field(close, 'close-account-password', 'Confirm your password', 'password');
  close.append(
    button(
      'Close this account permanently',
      async () => {
        if (pendingPost || pendingSocial)
          throw new Error(
            'Finish or stop waiting changes in News feed before closing your account.',
          );
        await deactivateAccount(identity!.client, confirmation.value, password.value);
        password.value = '';
        await exitLocally('Your account is closed. This browser’s keys have been removed.');
      },
      'danger form-action',
    ),
  );
  parent.append(close);
}
async function signOut(): Promise<void> {
  if (pendingPost || pendingSocial)
    throw new Error(
      'A post is waiting to finish sending. Open News feed and retry before signing out.',
    );
  if (identity) {
    const keys = await identity.client.getCrypto()!.exportRoomKeys();
    const hasKeys = keys.length > 0;
    for (const key of keys) key.session_key = '';
    if (hasKeys) {
      tell('Checking your recovery backup before signing out…');
      await identity.waitForKeyBackup();
    }
    await identity.client.logout(true);
  }
  await exitLocally('Signed out. This browser’s keys have been removed.');
}
async function exitLocally(message: string): Promise<void> {
  const session = identity!.session;
  // The in-memory scope exists before storage is touched. A full localStorage
  // must never prevent stopping a logged-out client or deleting its crypto keys.
  pendingCleanup = {
    baseUrl: session.baseUrl,
    userId: session.userId,
    deviceId: session.deviceId,
    message,
  };
  let durableCleanup = false;
  try {
    // Exact scope only: no access token or recovery secret in the retry journal.
    const journal = JSON.stringify(pendingCleanup);
    pendingCleanupKey = cleanupKey(pendingCleanup);
    localStorage.setItem(pendingCleanupKey, journal);
    const tabJournal = JSON.stringify({ key: pendingCleanupKey, scope: pendingCleanup });
    sessionStorage.setItem(CLEANUP_TAB, tabJournal);
    durableCleanup =
      localStorage.getItem(pendingCleanupKey) === journal &&
      sessionStorage.getItem(CLEANUP_TAB) === tabJournal;
  } catch {
    // Cleanup can still finish now. A failed cleanup explicitly says to keep
    // this tab open, since a storage failure prevents a durable retry journal.
  }
  try {
    identity!.close();
  } finally {
    outbox?.close();
    outbox = undefined;
    identity = undefined;
    content = undefined;
    records = [];
    feed = [];
    pendingPost = null;
    pendingSocial = null;
    loginPassword = '';
    currentVerification = '';
    selectedArchivePart = null;
    verification.replaceChildren();
    clear();
  }
  if (durableCleanup) {
    // Rust crypto can retain an IndexedDB connection while in-flight work
    // drains after stopClient(). Unload that entire crypto context, then let
    // the startup cleanup branch delete the exact stores without reopening
    // the SDK. Never report success until the fresh document confirms deletion.
    // If a journal could not be persisted, stay here with the in-memory scope.
    try {
      removeMatchingSession(pendingCleanup);
    } catch {
      // The durable cleanup branch takes priority over SESSION on startup and
      // retries its removal along with every owned database.
    }
    tell('Removing this browser’s keys…');
    location.reload();
    return;
  }
  await finishCleanup();
}
async function finishCleanup(): Promise<void> {
  try {
    if (!pendingCleanup) {
      const stored = storedCleanup();
      if (!stored) return;
      pendingCleanup = stored.scope;
      pendingCleanupKey = stored.key;
    }
    const scope = pendingCleanup;
    // Try all independent removals, even if session storage has become blocked.
    const results = await Promise.allSettled([
      forgetDeviceCrypto(scope),
      BrowserOutbox.forgetSession(scope),
      Promise.resolve().then(() => removeMatchingSession(scope)),
    ]);
    if (results.some((result) => result.status === 'rejected'))
      throw new Error('Local cleanup remains incomplete');
    if (pendingCleanupKey) localStorage.removeItem(pendingCleanupKey);
    const tabJournal = sessionStorage.getItem(CLEANUP_TAB);
    if (tabJournal && JSON.parse(tabJournal).key === pendingCleanupKey)
      sessionStorage.removeItem(CLEANUP_TAB);
    pendingCleanup = undefined;
    pendingCleanupKey = undefined;
    login();
    tell(scope.message);
  } catch {
    clear();
    const c = card('Finish removing this browser’s keys');
    c.append(
      el(
        'p',
        'Server sign-out or account closure has finished. Local keys or sign-in storage could not all be removed. Keep this tab open, close other tabs for this app, then retry. If browser storage stays blocked, clear this app’s site data in your browser settings.',
      ),
      button('Retry local key removal', finishCleanup),
    );
    app.append(c);
    tell('Local key removal is incomplete.', true);
  }
}
function showVerification(view: VerificationView): void {
  const update = verificationUpdate(currentVerification, view);
  if (update === 'ignore') return;
  if (update === 'busy') {
    tell('Another identity check arrived. Finish or cancel the current one first.');
    return;
  }
  currentVerification = view.id;
  verification.replaceChildren();
  const c = card('Make sure it’s your friend');
  c.append(el('p', view.peer));
  if (view.phase === 'done' || view.phase === 'cancelled') {
    currentVerification = '';
    verification.replaceChildren();
    tell(
      view.phase === 'done'
        ? 'Identity checked. You can now share.'
        : `Identity check cancelled${view.cancellationCode ? ` (${view.cancellationCode})` : ''}. Nothing was shared. Start one new check together.`,
    );
    return;
  }
  c.append(
    el(
      'p',
      'Compare these pictures over a call or in person. Do not compare them through a message on this host.',
      'help',
    ),
  );
  if (view.failure) c.append(el('p', view.failure, 'error-text'));
  if (view.emoji) {
    const sas = el('div', '', 'sas');
    for (const [emoji, name] of view.emoji) {
      const span = el('span', emoji);
      span.append(el('small', name));
      sas.append(span);
    }
    c.append(sas);
  } else if (view.decimal) c.append(el('p', view.decimal.join(' · '), 'secret'));
  else
    c.append(
      el(
        'p',
        view.phase === 'requested' ? 'Waiting for your friend to accept…' : 'Ready to compare.',
        'help',
      ),
    );
  const row = el('div', '', 'row');
  if (view.accept) row.append(button('Accept identity check', view.accept));
  if (view.compare) row.append(button('Show comparison', view.compare));
  if (view.confirm) row.append(button('They match', view.confirm));
  if (view.mismatch) row.append(button('They don’t match', view.mismatch, 'danger'));
  row.append(button('Cancel', view.cancel, 'secondary'));
  c.append(row);
  verification.append(c);
}
window.addEventListener('pagehide', () => {
  identity?.close();
  outbox?.close();
});
void run(async () => {
  let saved: Session | null;
  try {
    // Inspect the cleanup journal before touching any saved login. A blocked
    // SESSION read must not prevent cleanup in this fresh document.
    if (storedCleanup()) {
      await finishCleanup();
      return;
    }
    saved = sessionFromStorage();
  } catch {
    clear();
    const c = card('Browser storage needs attention');
    c.append(
      el(
        'p',
        'This browser would not let us check its sign-in and key-removal records. We have not opened your account or confirmed that its local keys are removed. Allow storage for this app, then try again.',
      ),
      button('Try again', () => location.reload()),
    );
    app.append(c);
    return;
  }
  if (saved) {
    try {
      await openSession(saved);
    } catch (error) {
      identity?.close();
      identity = undefined;
      clear();
      const c = card('Your book could not open');
      c.classList.add('narrow');
      c.append(
        el('p', error instanceof Error ? error.message : 'Try again.', 'error-text'),
        button('Try again', () => location.reload()),
        button(
          'Sign in again',
          () => {
            localStorage.removeItem(SESSION);
            login();
          },
          'secondary',
        ),
      );
      app.append(c);
    }
  } else login();
});
