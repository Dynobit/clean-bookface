import { verificationUpdate } from './verification-view';
import './style.css';
import { Identity, SessionInUseError, type Session, type VerificationView } from './identity';
import { ArchiveHistoryUnavailable, ContentStore, type SharedPost } from './content';
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
import {
  importArchiveBatches,
  cleanupImportTemporaryFiles,
  type ImportCounts,
} from './streaming-import';
import { exportArchives, type MemoryRecord } from './archive';
import { prepareSharedPhoto } from './shared-photo';
import { RoomEvent } from 'matrix-js-sdk';

const app = document.querySelector<HTMLElement>('#app')!;
const notice = document.querySelector<HTMLElement>('#notice')!;
const verification = document.querySelector<HTMLDialogElement>('#verification')!;
const invitation = new URLSearchParams(location.hash.slice(1));
let invitedHome = invitation.get('home') || '';
let invitedToken = invitation.get('invite') || '';
invitation.delete('invite');
// Remove invitation secrets before either saved-session or login routing runs.
if (location.hash) history.replaceState(null, '', location.pathname + location.search);
const SESSION = 'clean-bookface.session.v1';
const CLEANUP = 'clean-bookface.cleanup.v1';
const CLEANUP_PREFIX = 'clean-bookface.cleanup.v2:';
const CLEANUP_TAB = 'clean-bookface.cleanup.tab.v2';
let identity: Identity | undefined;
let content: ContentStore | undefined;
let records: MemoryRecord[] = [];
let feed: SharedPost[] = [];
let feedCursor: string | undefined;
let selectedConversation: string | undefined;
let feedLimited = false;
let mediaObserver: IntersectionObserver | undefined;
let updateVersion = 0;
let updatesAvailable = false;
let section: 'feed' | 'memories' | 'friends' | 'account' = 'feed';
let busy = false;
let objectUrls: string[] = [];
let currentVerification = '';
let friendChecksReady = false;
let cancelCurrentVerification: (() => Promise<void>) | undefined;
let loginPassword = '';
let outbox: BrowserOutbox | undefined;
let pendingPost: PendingPost | null = null;
let pendingSocial: PendingSocial | null = null;
let selectedArchivePart: number | null = null;
let archiveLoaded = false;
let archiveLoading = false;
let archiveError = '';
let archiveDownloadView:
  | {
      store: ContentStore;
      batches: Awaited<ReturnType<ContentStore['archiveBatches']>>['batches'];
      cursor?: string;
      listed: boolean;
      loading: boolean;
      open: boolean;
    }
  | undefined;
let feedError = '';
const conversationDownloads = new WeakMap<
  ContentStore,
  Map<string, { cursor?: string; part: number; complete: boolean; loading: boolean }>
>();
let refreshGeneration = 0;
const verifiedFriends = new Set<string>();
let draftText = '';
let draftPhotos: File[] = [];
let importFiles: File[] = [];
const draftRecipients = new Set<string>();
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
  notice.setAttribute('role', error ? 'alert' : 'status');
  notice.setAttribute('aria-live', error ? 'assertive' : 'polite');
}
async function run(action: () => void | Promise<void>): Promise<void> {
  if (busy) return;
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const bookmark = focused
    ? {
        id: focused.id,
        label: focused.getAttribute('aria-label'),
        text: focused.textContent,
        tag: focused.tagName,
        scope: focused.closest<HTMLElement>('[data-focus-scope]')?.dataset.focusScope,
      }
    : null;
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
    if (!verification.open && bookmark && focused && !focused.isConnected) {
      const target = bookmark.id
        ? document.getElementById(bookmark.id)
        : [...app.querySelectorAll<HTMLElement>('button,input,textarea,select,a,summary')].find(
            (node) =>
              node.tagName === bookmark.tag &&
              node.getAttribute('aria-label') === bookmark.label &&
              node.textContent === bookmark.text &&
              node.closest<HTMLElement>('[data-focus-scope]')?.dataset.focusScope ===
                bookmark.scope,
          );
      const fallback =
        app.querySelector<HTMLElement>('[aria-current="page"]') ||
        app.querySelector<HTMLElement>('h1,h2');
      if (target) target.focus();
      else if (fallback) {
        fallback.tabIndex = -1;
        fallback.focus();
      }
    } else if (
      !verification.open &&
      focused?.isConnected &&
      document.activeElement === document.body
    )
      focused.focus();
  }
}
function clear(): void {
  mediaObserver?.disconnect();
  mediaObserver = undefined;
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
  const home = invitedHome;
  const token = invitedToken;
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
        try {
          await openSession(session);
        } catch (error) {
          showOpenFailure(session, error);
        }
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
  friendChecksReady = false;
  // A consumed invitation must not reappear after in-place local cleanup.
  invitedHome = '';
  invitedToken = '';
  tell('Opening the secure browser and connecting to your home…');
  identity = await Identity.open(session, showVerification, (message) => tell(message, true));
  const controller = identity;
  controller.client.on(RoomEvent.Timeline, (event, room, older) => {
    if (identity !== controller) return;
    if (
      older ||
      !room ||
      !['m.room.encrypted', 'org.cleanbookface.content.v1'].includes(event.getType())
    )
      return;
    updateVersion++;
    updatesAvailable = true;
    const refresh = document.getElementById('refresh-book');
    if (refresh) refresh.textContent = 'New updates — refresh';
  });
  content = new ContentStore(controller.client, (id) => controller.requireVerifiedUser(id));
  outbox = await BrowserOutbox.open(session);
  pendingPost = await outbox.load();
  pendingSocial = await outbox.loadSocial();
  const status = await controller.status();
  if (identity !== controller) return;
  tell('');
  if (!status.recoveryReady) {
    recovery(
      status.recoveryConfigured || status.hasIdentity || status.recoverySetupResumable,
      status.recoverySetupResumable && !status.recoveryReady,
    );
    return;
  }
  if (!status.ownDeviceTrusted || !status.crossSigningReady || status.historyRecoveryNeeded) {
    recovery(true);
    return;
  }
  loginPassword = '';
  friendChecksReady = true;
  // Account controls must remain reachable even when history cannot be loaded.
  render();
  void refresh();
}
function recovery(existing: boolean, resuming = false): void {
  const controller = identity;
  if (!controller) return;
  friendChecksReady = false;
  // Recovery confers no friend trust. A new check can start after it finishes.
  const cancel = cancelCurrentVerification;
  cancelCurrentVerification = undefined;
  currentVerification = '';
  verification.close();
  verification.replaceChildren();
  if (cancel) void cancel().catch(() => {});
  clear();
  const c = card(
    resuming
      ? 'Finish setting up your recovery kit.'
      : existing
        ? 'Welcome back. Open your memories.'
        : 'Keep a spare key to your memories.',
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
  if (resuming)
    c.append(
      el(
        'p',
        'Setup stopped before it finished. Use the kit you already saved. This keeps the same identity and keys.',
        'notice-inline',
      ),
    );
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
        if (identity !== controller) return;
        restore.disabled = true;
        try {
          if (resuming) await controller.resumeRecoverySetup(key.value, pass.value);
          else await controller.restoreRecovery(key.value, pass.value);
          if (identity !== controller) return;
          key.value = '';
          pass.value = '';
          loginPassword = '';
          friendChecksReady = true;
          await refresh({ archives: archiveLoaded });
          if (identity !== controller) return;
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
        if (identity !== controller) return;
        if (!pass.reportValidity()) return;
        const key = await controller.prepareRecovery();
        if (identity !== controller) return;
        prepare.hidden = true;
        const area = el('textarea');
        area.readOnly = true;
        area.className = 'secret';
        area.value = key;
        area.setAttribute('aria-label', 'Your recovery key');
        const kit = {
          format: 'clean-bookface-recovery-v1',
          home: controller.session.baseUrl,
          account: controller.session.userId,
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
          if (identity !== controller) return;
          if (confirm.value.replace(/\s/g, '') !== key.replace(/\s/g, '').slice(-6))
            throw new Error('Check your saved copy and type its last 6 characters.');
          complete.disabled = true;
          try {
            await controller.setupRecovery(pass.value);
            if (identity !== controller) return;
            controller.acknowledgeRecoveryKey();
            pass.value = '';
            area.value = '';
            loginPassword = '';
            friendChecksReady = true;
            await refresh();
            if (identity !== controller) return;
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
async function refresh(options: { archives?: boolean } = {}): Promise<void> {
  const store = content;
  const controller = identity;
  if (!store || !controller) return;
  const generation = ++refreshGeneration;
  const revision = updateVersion;
  const loadArchive = options.archives === true || (section === 'memories' && !archiveLoaded);
  if (options.archives === true && archiveLoaded) archiveDownloadView = undefined;
  archiveLoading = loadArchive;
  if (loadArchive && section === 'memories') render();
  tell(loadArchive ? 'Opening your encrypted memories…' : 'Checking your friends’ posts…');
  const results = await Promise.allSettled([
    loadArchive ? store.privateArchiveView() : Promise.resolve(records),
    store.postsPage(undefined, 20, selectedConversation),
  ]);
  if (generation !== refreshGeneration || content !== store || identity !== controller) return;
  const verified = new Set<string>();
  await Promise.all(
    store.friendRooms().map(async (friend) => {
      try {
        await controller.requireVerifiedUser(friend.userId);
        verified.add(friend.userId);
      } catch {
        /* Unverified friends remain visible, but cannot be selected for sharing. */
      }
    }),
  );
  if (generation !== refreshGeneration || content !== store || identity !== controller) return;
  verifiedFriends.clear();
  for (const id of verified) verifiedFriends.add(id);
  if (updateVersion === revision) updatesAvailable = false;
  if (loadArchive) {
    archiveLoading = false;
    archiveLoaded = true;
    selectedArchivePart = null;
    if (results[0].status === 'fulfilled') {
      records = results[0].value as MemoryRecord[];
      archiveError = '';
    } else
      archiveError =
        'Your saved imports could not all be opened. Retry, use your recovery kit again, or download the parts that are available.';
  }
  if (results[1].status === 'fulfilled') {
    const page = results[1].value as {
      posts: SharedPost[];
      nextCursor?: string;
      limited?: boolean;
    };
    feed = page.posts;
    feedCursor = page.nextCursor;
    feedLimited = !!page.limited;
    feedError = '';
  } else
    feedError =
      'Your conversations could not be refreshed. Account controls and available memories remain open.';
  render();
  tell('');
}
function render(): void {
  const downloads = app.querySelector<HTMLDetailsElement>('#saved-import-downloads');
  if (downloads && archiveDownloadView && archiveDownloadView.store === content)
    archiveDownloadView.open = downloads.open;
  const active =
    document.activeElement instanceof HTMLElement && app.contains(document.activeElement)
      ? document.activeElement
      : null;
  const focus = active
    ? {
        id: active.id,
        label: active.getAttribute('aria-label'),
        tag: active.tagName,
        scope: active.closest<HTMLElement>('[data-focus-scope]')?.dataset.focusScope,
        start: active instanceof HTMLTextAreaElement ? active.selectionStart : null,
        end: active instanceof HTMLTextAreaElement ? active.selectionEnd : null,
      }
    : null;
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
  ] as const) {
    const tab = button(
      title,
      () => {
        section = value;
        render();
        if (value === 'memories' && !archiveLoaded) void refresh({ archives: true });
      },
      value === section ? 'active' : '',
    );
    tab.id = `section-${value}`;
    if (value === section) tab.setAttribute('aria-current', 'page');
    nav.append(tab);
  }
  const refreshButton = button(
    updatesAvailable ? 'New updates — refresh' : 'Refresh my book',
    () => refresh({ archives: section === 'memories' }),
    'secondary small',
  );
  refreshButton.id = 'refresh-book';
  nav.append(refreshButton);
  const center = el('div');
  center.append(el('p', identity!.session.userId, 'mobile-account'));
  const unavailable = content!.unavailableContent();
  if (archiveError || feedError || unavailable.length) {
    const warning = card('Some memories need attention');
    warning.append(
      el(
        'p',
        archiveError ||
          feedError ||
          `${unavailable.length} saved parts or rooms could not be verified or decrypted. Available parts stay private and can still be opened or downloaded.`,
      ),
    );
    warning.append(
      button('Use my recovery kit again', () => recovery(true), 'secondary'),
      button('Retry opening memories', () => refresh({ archives: true }), 'secondary'),
    );
    center.append(warning);
  }
  if (section === 'feed') {
    composer(center);
    center.append(el('h2', 'News feed'));
    const conversationLabel = el('label', 'Show conversations');
    conversationLabel.htmlFor = 'feed-conversation';
    const picker = el('select');
    picker.id = 'feed-conversation';
    const all = el('option', 'Recent conversations');
    all.value = '';
    picker.append(all);
    for (const room of content!.conversationRooms()) {
      const option = el('option', `${room.userId}${room.readOnly ? ' · saved history' : ''}`);
      option.value = room.roomId;
      picker.append(option);
    }
    picker.value = selectedConversation || '';
    picker.onchange = () => {
      void run(async () => {
        selectedConversation = picker.value || undefined;
        await refresh();
      });
    };
    center.append(conversationLabel, picker);
    if (feedLimited)
      center.append(
        el(
          'p',
          'This view has more history than can be opened at once. Choose one conversation above to see its posts, or download its saved parts in My account.',
          'notice-inline',
        ),
      );
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
    if (feedCursor)
      center.append(
        button(
          'Show older posts',
          async () => {
            const store = content!,
              controller = identity!,
              generation = refreshGeneration,
              roomId = selectedConversation;
            const page = await store.postsPage(feedCursor, 20, roomId);
            if (
              content !== store ||
              identity !== controller ||
              generation !== refreshGeneration ||
              selectedConversation !== roomId
            )
              return;
            feed = page.posts;
            feedCursor = page.nextCursor;
            feedLimited = !!page.limited;
            render();
          },
          'secondary form-action',
        ),
      );
  }
  if (section === 'memories') memories(center);
  if (section === 'friends') friends(center);
  if (section === 'account') account(center);
  const aside = el('aside', '', 'aside');
  const note = card('Your corner of the web');
  note.append(
    el('p', 'No trending tab. No suggested strangers. Just the people you choose.'),
    el('p', 'Imported memories are private until you share a separate copy.', 'help'),
    button('Refresh conversations', () => refresh(), 'secondary small'),
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
  if (focus && !verification.open) {
    const next = focus.id
      ? document.getElementById(focus.id)
      : focus.label
        ? [...app.querySelectorAll<HTMLElement>('[aria-label]')].find(
            (node) =>
              node.tagName === focus.tag &&
              node.getAttribute('aria-label') === focus.label &&
              node.closest<HTMLElement>('[data-focus-scope]')?.dataset.focusScope === focus.scope,
          )
        : undefined;
    next?.focus();
    if (next instanceof HTMLTextAreaElement && focus.start !== null)
      next.setSelectionRange(focus.start, focus.end);
  }
}
function empty(title: string, body: string): HTMLElement {
  const c = el('div', '', 'card empty');
  c.append(el('h3', title), el('p', body));
  return c;
}
function audience(parent: HTMLElement, chosen = new Set<string>()): () => string[] {
  const rooms = content!.friendRooms();
  for (const id of chosen)
    if (!verifiedFriends.has(id) || !rooms.some((room) => room.userId === id)) chosen.delete(id);
  const heading = el('p', 'Share a separate copy with:', 'help');
  parent.append(heading);
  for (const friend of rooms) {
    const label = el('label', '', 'check');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.value = friend.userId;
    cb.disabled = !verifiedFriends.has(friend.userId);
    cb.checked = chosen.has(friend.userId);
    cb.onchange = () => {
      if (cb.checked) chosen.add(cb.value);
      else chosen.delete(cb.value);
    };
    label.append(
      cb,
      document.createTextNode(
        `${friend.userId}${cb.disabled ? ' · check identity first' : ' · identity checked'}`,
      ),
    );
    parent.append(label);
  }
  if (!rooms.length) parent.append(el('p', 'Add and verify a friend first.', 'help'));
  return () => [...chosen];
}
async function prepareQueuedRecord(record: MemoryRecord): Promise<MemoryRecord> {
  if (record.privateOnly || !['post', 'photo', 'album'].includes(record.kind))
    throw new Error('This memory cannot be shared.');
  if (record.attachments.length > 4)
    throw new Error(
      'Share up to four photos at a time. Individual imported photos are listed in My memories.',
    );
  if (record.text.length > 16_000 || record.title.length > 1024)
    throw new Error(
      'This memory is too long for a shared post. Write a shorter update in News feed; your full original stays private.',
    );
  const attachments = [];
  for (const photo of record.attachments) {
    const prepared = await prepareSharedPhoto(photo);
    attachments.push({ ...prepared, path: `photo-${attachments.length + 1}.jpg` });
  }
  return {
    id: record.id,
    kind: record.kind,
    timestamp: record.timestamp,
    title: record.title,
    text: record.text,
    sourcePath: '',
    privateOnly: false,
    attachments,
  };
}
async function queuePost(record: MemoryRecord, recipients: string[]): Promise<void> {
  const controller = identity!,
    store = content!,
    box = outbox!;
  if (pendingPost) throw new Error('Finish or stop the waiting post first.');
  if (!recipients.length) throw new Error('Choose at least one friend.');
  const queued: PendingPost = {
    record: await prepareQueuedRecord(record),
    recipients,
    operationId: crypto.randomUUID(),
    delivered: [],
  };
  assertCurrent(controller, store, box);
  await box.save(queued);
  assertCurrent(controller, store, box);
  pendingPost = queued;
  draftText = '';
  draftPhotos = [];
  draftRecipients.clear();
  await finishPost();
}
async function finishPost(): Promise<void> {
  if (!pendingPost) return;
  const queued = pendingPost;
  const controller = identity!,
    store = content!,
    box = outbox!;
  const current = () => {
    assertCurrent(controller, store, box);
    if (pendingPost !== queued) throw new Error('This waiting post has changed.');
  };
  try {
    const waiting = queued.recipients.filter((id) => !queued.delivered?.includes(id));
    let failures: string[] = [];
    if (waiting.length) {
      const result = await store.share(queued.record, waiting, queued.operationId);
      current();
      queued.delivered = [
        ...new Set([
          ...(queued.delivered || []),
          ...result.outcomes.filter((r) => r.status === 'sent').map((r) => r.userId),
        ]),
      ];
      failures = result.outcomes.filter((r) => r.status === 'failed').map((r) => r.userId);
      await box.save(queued);
      current();
    }
    await controller.waitForKeyBackup();
    current();
    if (failures.length) {
      render();
      tell(
        `Delivered to ${queued.delivered?.length || 0} friends. Still waiting: ${failures.join(', ')}. Check their identity or connection, then retry.`,
        true,
      );
      return;
    }
    await box.clear();
    current();
    pendingPost = null;
    await refresh();
    assertCurrent(controller, store, box);
    tell('Shared with the people you selected. Recovery backup checked.');
  } catch (error) {
    if (identity === controller && content === store) render();
    throw error;
  }
}
function assertCurrent(controller: Identity, store: ContentStore, box: BrowserOutbox): void {
  if (identity !== controller || content !== store || outbox !== box)
    throw new Error('This account session changed. Reopen its waiting changes before retrying.');
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
  const c = card(pendingPost ? 'A post is waiting to finish' : 'What’s on your mind?');
  c.dataset.focusScope = 'composer';
  if (pendingPost) {
    c.append(
      el('p', pendingPost.record.text, 'post-body'),
      el(
        'p',
        `${pendingPost.record.attachments.length} photos · ${pendingPost.delivered?.length || 0} of ${pendingPost.recipients.length} recipients delivered.`,
        'help',
      ),
    );
    for (const userId of pendingPost.recipients)
      c.append(
        el(
          'p',
          `${userId} · ${pendingPost.delivered?.includes(userId) ? 'delivered' : 'waiting'}`,
          'help',
        ),
      );
    c.append(
      el(
        'p',
        'Retry keeps the same post and recipients, including after refreshing this browser. Keep this browser until it finishes.',
        'notice-inline',
      ),
      button('Finish sending this post', finishPost, 'form-action'),
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
    );
  } else {
    const text = el('textarea');
    text.setAttribute('aria-label', 'Write a post');
    text.placeholder = 'A small update for your people…';
    text.maxLength = 16_000;
    text.value = draftText;
    text.oninput = () => {
      draftText = text.value;
    };
    c.append(text);
    const photos = field(c, 'post-photos', 'Add photos (optional)', 'file');
    photos.multiple = true;
    photos.accept = 'image/jpeg,image/png,image/webp';
    if (draftPhotos.length) {
      const transfer = new DataTransfer();
      for (const photo of draftPhotos) transfer.items.add(photo);
      photos.files = transfer.files;
    }
    photos.onchange = () => {
      draftPhotos = [...(photos.files || [])];
    };
    c.append(
      el(
        'p',
        'Up to four photos. Shared copies are smaller and have location and camera details removed. Your original files stay on your computer.',
        'help',
      ),
    );
    const choose = audience(c, draftRecipients);
    c.append(
      button(
        'Share with selected friends',
        async () => {
          if (!text.value.trim() && !photos.files?.length)
            throw new Error('Write a little something or choose a photo first.');
          if ((photos.files?.length || 0) > 4)
            throw new Error('Choose up to four photos for one post.');
          await queuePost(
            {
              id: crypto.randomUUID(),
              kind: 'post',
              timestamp: Date.now(),
              text: text.value,
              title: '',
              sourcePath: '',
              privateOnly: false,
              attachments: [...(photos.files || [])].map((file) => ({
                path: file.name,
                mimeType: file.type,
                bytes: file,
              })),
            },
            choose(),
          );
        },
        'form-action',
      ),
    );
  }
  parent.append(c);
}
function memories(parent: HTMLElement): void {
  const c = card('Your memories, brought home');
  if (archiveLoading)
    c.append(
      el(
        'p',
        'Opening available memories… Your account controls remain available.',
        'notice-inline',
      ),
    );
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
  input.disabled = archiveLoading;
  input.accept = '.zip,application/zip';
  if (importFiles.length) {
    const transfer = new DataTransfer();
    for (const file of importFiles) transfer.items.add(file);
    input.files = transfer.files;
  }
  input.onchange = () => {
    importFiles = [...(input.files || [])];
  };
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
        if (archiveLoading)
          throw new Error('Wait for the current memories to finish opening, then import.');
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
        let counts: ImportCounts | undefined;
        const warnings = new Set<string>();
        try {
          for await (const batch of importArchiveBatches([...input.files], {
            signal: controller.signal,
            onProgress: (p) => {
              counts = p.counts;
              tell(
                `Reading privately: ${p.records} memories · ${p.counts?.messages.imported || 0} messages · ${Math.round(p.decodedBytes / 1024 / 1024)} MiB read`,
              );
            },
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
          importFiles = [];
          archiveDownloadView = undefined;
          await refresh({ archives: true });
          tell(
            `${count} memories imported privately in ${accepted} parts. Recovery checked.${counts ? ` ${counts.messages.imported} messages; ${counts.attachments.imported} attachments. Skipped: ${counts.records.skipped} records, ${counts.messages.skipped} messages, ${counts.attachments.skipped} attachments; ${counts.attachments.missing} attachment references missing from the download.` : ''}${warnings.size ? ` ${[...warnings].join(' ')}` : ''}`,
          );
        } catch (error) {
          archiveDownloadView = undefined;
          render();
          const reason = controller.signal.aborted
            ? 'Import stopped.'
            : error instanceof Error
              ? error.message
              : 'Import did not finish.';
          throw new Error(
            `${reason} ${accepted} parts saved; recovery confirmed for ${confirmed}. Keep this browser and your original ZIP files.${error instanceof ArchiveHistoryUnavailable ? '' : ' Choose the same files to resume; saved parts are checked before another upload.'}`,
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
        if (archiveLoading || !archiveLoaded)
          throw new Error(
            'Wait for these memories to finish opening, or download a saved import separately below.',
          );
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
        const controller = identity!,
          store = content!,
          box = outbox!;
        const query = search.value;
        const found = await store.searchArchive(query, 50, (n) => {
          if (identity === controller && content === store)
            tell(`Searching privately: ${n} saved parts checked…`);
        });
        assertCurrent(controller, store, box);
        if (!results.isConnected) return;
        results.replaceChildren();
        results.append(
          el(
            'p',
            `${found.matches.length} matches${found.limited ? ' (search incomplete)' : ''}. Repeated imports can contain the same memory.`,
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
                await openSavedPart(store, controller, box, hit.roomId, hit.eventId, 0);
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
            ? 'Search is incomplete. Try more specific words and check any unavailable saved parts using your recovery kit or the separate downloads.'
            : `Search complete: ${found.partsChecked} saved parts checked.`,
        );
      },
      'secondary form-action',
    ),
  );
}
async function openSavedPart(
  store: ContentStore,
  controller: Identity,
  box: BrowserOutbox,
  roomId: string,
  eventId: string,
  number: number,
): Promise<void> {
  assertCurrent(controller, store, box);
  const part = await store.readArchiveBatch(roomId, eventId);
  assertCurrent(controller, store, box);
  // An earlier refresh must not replace the part explicitly opened by the reader.
  refreshGeneration++;
  records = part;
  selectedArchivePart = number;
  archiveLoaded = true;
  archiveLoading = false;
  archiveError = '';
  section = 'memories';
  render();
}
function archiveDownloads(parent: HTMLElement, expanded: boolean): void {
  const controller = identity!,
    store = content!,
    box = outbox!;
  if (archiveDownloadView?.store !== store)
    archiveDownloadView = { store, batches: [], listed: false, loading: false, open: expanded };
  const view = archiveDownloadView;
  const details = el('details');
  details.id = 'saved-import-downloads';
  details.open = view.open;
  details.ontoggle = () => {
    if (details.isConnected && archiveDownloadView === view) view.open = details.open;
  };
  details.append(
    el('summary', 'Download my saved imports separately'),
    el(
      'p',
      'Each ZIP contains one complete saved import. A memory imported more than once may appear in several downloads. These files are readable without your recovery kit; keep them somewhere private.',
      'help',
    ),
  );
  const list = el('div');
  const more = button('Show saved imports', async () => {
    assertCurrent(controller, store, box);
    if (view.loading) return;
    view.loading = true;
    draw();
    try {
      const page = await store.archiveBatches(view.cursor, 50, true);
      assertCurrent(controller, store, box);
      const seen = new Set(view.batches.map((batch) => `${batch.roomId}\0${batch.eventId}`));
      view.batches.push(
        ...page.batches.filter((batch) => !seen.has(`${batch.roomId}\0${batch.eventId}`)),
      );
      view.cursor = page.nextCursor;
      view.listed = true;
    } finally {
      view.loading = false;
      if (identity === controller && content === store && archiveDownloadView === view) {
        if (list.isConnected) draw();
        else render();
      }
    }
  });
  function draw(): void {
    list.replaceChildren();
    for (const [index, batch] of view.batches.entries()) {
      const number = index + 1;
      list.append(
        button(
          `View saved import ${number}`,
          async () => {
            await openSavedPart(store, controller, box, batch.roomId, batch.eventId, number);
            tell(`Opened saved import ${number}. Nothing was shared.`);
          },
          'secondary form-action',
        ),
        button(
          `Download saved import ${number}`,
          async () => {
            assertCurrent(controller, store, box);
            const data = await store.downloadArchiveBatch(batch.roomId, batch.eventId);
            assertCurrent(controller, store, box);
            download(data, `clean-bookface-memories-part-${number}.zip`);
            tell('Saved import downloaded. Keep every part somewhere private.');
          },
          'secondary form-action',
        ),
      );
    }
    more.textContent = view.loading
      ? 'Opening saved imports…'
      : !view.listed
        ? 'Show saved imports'
        : view.cursor
          ? 'Show more saved imports'
          : 'All saved imports are listed';
    more.disabled = view.loading || (view.listed && !view.cursor);
    if (view.listed && !view.batches.length) list.append(el('p', 'No saved imports yet.', 'help'));
  }
  draw();
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
  c.dataset.focusScope = shared ? `post:${shared.roomId}:${shared.id}` : `memory:${record.id}`;
  const head = el('div', '', 'post-head');
  head.append(
    el('strong', sender),
    el(
      'span',
      shared
        ? `Shared ${new Date(shared.sharedAt).toLocaleString()}`
        : record.timestamp
          ? new Date(record.timestamp).toLocaleString()
          : sentAt
            ? new Date(sentAt).toLocaleString()
            : 'Date unknown',
    ),
  );
  c.append(head);
  if (
    shared &&
    shared.originalTimestamp &&
    Math.abs(shared.sharedAt - shared.originalTimestamp) > 60_000
  )
    c.append(
      el('p', `Original memory: ${new Date(shared.originalTimestamp).toLocaleString()}`, 'help'),
    );
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
  if (shared && !shared.mediaLoaded && shared.media?.length) {
    const store = content!;
    let loading = false;
    const loadMedia = async () => {
      if (!c.isConnected || content !== store) return;
      if (loading) return;
      loading = true;
      load.disabled = true;
      try {
        const hydrated = await store.hydratePost(shared);
        if (!c.isConnected || content !== store) return;
        const index = feed.findIndex(
          (post) => post.roomId === shared.roomId && post.id === shared.id,
        );
        if (index >= 0) feed[index] = hydrated;
        for (const photo of hydrated.record.attachments) {
          const img = el('img');
          const url = URL.createObjectURL(photo.bytes);
          objectUrls.push(url);
          img.src = url;
          img.alt = hydrated.record.title || 'Shared photo';
          img.loading = 'lazy';
          media.append(img);
        }
        load.remove();
      } catch {
        loading = false;
        load.disabled = false;
        load.textContent = 'Retry opening photos';
        media.append(
          el(
            'p',
            'These photos could not be verified or downloaded. The text remains available.',
            'help',
          ),
        );
      }
    };
    const load = button(`Show ${shared.media.length} photos`, loadMedia, 'small secondary');
    c.append(load);
    // Each visible card fetches only its own authenticated media. Other pages remain unopened.
    mediaObserver ??= new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) {
            mediaObserver?.unobserve(entry.target);
            const target = entry.target as HTMLButtonElement & { loadMedia?: () => Promise<void> };
            void target.loadMedia?.();
          }
      },
      { rootMargin: '100px' },
    );
    (load as HTMLButtonElement & { loadMedia?: () => Promise<void> }).loadMedia = loadMedia;
    mediaObserver.observe(load);
  }
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
            await queuePost(record, choose());
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
  const controller = identity!,
    store = content!,
    box = outbox!;
  if (pendingSocial) throw new Error('Finish or stop the waiting conversation change first.');
  const queued: PendingSocial = {
    post: { roomId: post.roomId, id: post.id, sender: post.sender },
    operationId: crypto.randomUUID(),
    action,
  };
  await box.saveSocial(queued);
  assertCurrent(controller, store, box);
  pendingSocial = queued;
  await finishSocial();
}
async function finishSocial(): Promise<void> {
  if (!pendingSocial) return;
  const queued = pendingSocial;
  const { post, action, operationId } = queued;
  const controller = identity!,
    store = content!,
    box = outbox!;
  const current = () => {
    assertCurrent(controller, store, box);
    if (pendingSocial !== queued) throw new Error('This waiting change has changed.');
  };
  try {
    if (action.kind === 'comment') await store.addComment(post, action.text, operationId);
    else if (action.kind === 'remove-comment')
      await store.removeComment(post, action.commentId, operationId);
    else if (action.kind === 'reaction')
      await store.setReaction(post, action.reaction, operationId);
    else await store.removePost(post, operationId);
    current();
    await controller.waitForKeyBackup();
    current();
    await box.clear('social');
    current();
    pendingSocial = null;
    await refresh();
    assertCurrent(controller, store, box);
    tell('Conversation updated. Recovery backup checked.');
  } catch (error) {
    if (identity === controller && content === store) render();
    throw error;
  }
}
function conversation(c: HTMLElement, post: SharedPost): void {
  const friend =
    content!.conversationRooms().find((r) => r.roomId === post.roomId)?.userId || post.sender;
  c.append(
    el('p', `A conversation between you and ${friend}. Replies stay in this conversation.`, 'help'),
  );
  if (post.readOnly)
    c.append(
      el(
        'p',
        'Saved conversation · this friendship has ended. You can read and download available history; new replies and sharing are closed.',
        'notice-inline',
      ),
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
  if (!post.readOnly) c.append(actions);
  for (const r of post.reactions) c.append(el('p', `${r.reaction} ${r.sender}`, 'help'));
  const comments = el('div', '', 'comments');
  for (const comment of post.comments) {
    const row = el('div', '', 'comment');
    row.append(el('strong', comment.sender), el('p', comment.text, 'post-body'));
    if (!post.readOnly && comment.sender === identity!.session.userId)
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
  if (!post.readOnly)
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
    li.append(
      el('p', friend.userId),
      el(
        'p',
        verifiedFriends.has(friend.userId)
          ? 'Identity checked'
          : 'Identity not checked yet — compare together before sharing.',
        'help',
      ),
    );
    li.dataset.focusScope = `friend:${friend.userId}`;
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
          await refresh();
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
        const controller = identity!,
          store = content!,
          box = outbox!;
        await store.acceptInvite(room.roomId);
        assertCurrent(controller, store, box);
        await refresh();
        assertCurrent(controller, store, box);
        tell(
          verifiedFriends.has(inviter)
            ? 'Accepted. Your earlier identity check still matches.'
            : 'Accepted. Check their identity before sharing.',
        );
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
        if (!archiveLoaded) void refresh({ archives: true });
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
    button('Use my recovery kit again', () => recovery(true), 'secondary'),
    button('Sign out of this browser', signOut, 'secondary'),
  );
  parent.append(c);
  const conversations = card('Take your conversations with you');
  conversations.append(
    el(
      'p',
      'Download posts, photos and replies from each conversation, including your own posts and earlier copies marked removed. Removing a post or reply from the feed does not erase it from this history. Ended friendships remain available when this browser can still verify and decrypt their history. These ZIP files are readable without a recovery kit; keep them private.',
    ),
  );
  const rooms = content!.conversationRooms();
  if (!rooms.length) conversations.append(el('p', 'No saved conversations yet.', 'help'));
  let downloads = conversationDownloads.get(content!);
  if (!downloads) {
    downloads = new Map();
    conversationDownloads.set(content!, downloads);
  }
  for (const room of rooms) {
    const controller = identity!,
      store = content!,
      box = outbox!;
    const row = el('div', '', 'conversation-download');
    row.dataset.focusScope = `export:${room.roomId}`;
    row.append(
      el('h3', room.userId),
      el('p', room.readOnly ? 'Saved history · friendship ended' : 'Current conversation', 'help'),
    );
    let state = downloads.get(room.roomId);
    if (!state) {
      state = { part: 1, complete: false, loading: false };
      downloads.set(room.roomId, state);
    }
    const progress = state;
    const label = () =>
      progress.loading
        ? 'Preparing conversation download…'
        : progress.complete
          ? 'All available parts downloaded'
          : `Download conversation · part ${progress.part}`;
    const save = button(
      label(),
      async () => {
        assertCurrent(controller, store, box);
        if (progress.loading || progress.complete) return;
        progress.loading = true;
        save.disabled = true;
        save.textContent = label();
        try {
          const result = await store.exportConversationPage(room.roomId, progress.cursor);
          assertCurrent(controller, store, box);
          download(result.blob, `clean-bookface-conversation-part-${progress.part}.zip`);
          progress.cursor = result.nextCursor;
          progress.part++;
          progress.complete = !progress.cursor;
          const unavailable = store
            .unavailableContent()
            .filter((item) => item.roomId === room.roomId).length;
          tell(
            `${progress.cursor ? 'Download saved. Continue with the next part to keep the rest.' : 'Every available part of this conversation has been offered for download.'}${unavailable ? ` ${unavailable} events could not be opened; the download includes an explanation. Keep your recovery kit and original backups.` : ''}`,
          );
        } finally {
          progress.loading = false;
          if (content === store && identity === controller && outbox === box) {
            if (save.isConnected) {
              save.disabled = progress.complete;
              save.textContent = label();
            } else if (section === 'account') render();
          }
        }
      },
      'secondary form-action',
    );
    save.disabled = progress.loading || progress.complete;
    row.append(
      save,
      button(
        'Start this conversation download again',
        () => {
          assertCurrent(controller, store, box);
          if (progress.loading) return;
          progress.cursor = undefined;
          progress.part = 1;
          progress.complete = false;
          save.disabled = false;
          save.textContent = 'Download conversation · part 1';
          tell(
            'Ready to download from the beginning. Keep each part until the complete conversation is saved.',
          );
        },
        'small secondary',
      ),
    );
    conversations.append(row);
  }
  parent.append(conversations);
  const close = el('details', '', 'card');
  close.append(el('summary', 'Close my account'));
  close.append(
    el(
      'p',
      'Download your memories and every conversation part first. Closing removes account access and this browser’s keys, and asks your home to erase your profile. Friends may keep shared copies; encrypted events, media and backups can remain on hosts until their retention policy removes them. Contact your host about retained storage.',
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
    try {
      const keys = await identity.client.getCrypto()!.exportRoomKeys();
      const hasKeys = keys.length > 0;
      for (const key of keys) key.session_key = '';
      if (hasKeys) {
        tell('Checking your recovery backup before signing out…');
        await identity.waitForKeyBackup();
      }
    } catch (error) {
      // An already-ended server session cannot upload keys. Other failures
      // retain this browser's keys and sign-in so recovery can be retried.
      if (!Identity.sessionIsInvalid(error)) throw error;
      showOpenFailure(identity.session, error);
      return;
    }
    await Identity.logoutSession(identity.session);
  }
  await exitLocally('Signed out. This browser’s keys have been removed.');
}
async function exitLocally(message: string, session: Session = identity!.session): Promise<void> {
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
    identity?.close();
  } finally {
    outbox?.close();
    outbox = undefined;
    identity = undefined;
    content = undefined;
    records = [];
    feed = [];
    feedCursor = undefined;
    selectedConversation = undefined;
    feedLimited = false;
    updateVersion = 0;
    updatesAvailable = false;
    pendingPost = null;
    pendingSocial = null;
    loginPassword = '';
    currentVerification = '';
    friendChecksReady = false;
    cancelCurrentVerification = undefined;
    selectedArchivePart = null;
    archiveLoaded = false;
    archiveLoading = false;
    archiveError = '';
    archiveDownloadView = undefined;
    feedError = '';
    refreshGeneration++;
    verifiedFriends.clear();
    draftText = '';
    draftPhotos = [];
    importFiles = [];
    draftRecipients.clear();
    verification.close();
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
      Promise.resolve().then(() => Identity.forgetVerificationHistory(scope)),
      Promise.resolve().then(() => Identity.forgetRecoveryProgress(scope)),
      cleanupImportTemporaryFiles(),
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
        'Local keys or sign-in storage could not all be removed. Keep this tab open, close other tabs for this app, then retry. If browser storage stays blocked, clear this app’s site data in your browser settings.',
      ),
      button('Retry local key removal', finishCleanup),
    );
    app.append(c);
    tell('Local key removal is incomplete.', true);
  }
}
function showVerification(view: VerificationView): void {
  if (!friendChecksReady) {
    if (view.phase !== 'done' && view.phase !== 'cancelled') {
      // Never let an incoming (including inherited) request obscure recovery.
      // A transport failure cannot grant trust or make a modal block the kit.
      void view.cancel().catch(() => {});
      tell('Open your memories first, then start a new identity check together.');
    }
    return;
  }
  const update = verificationUpdate(currentVerification, view);
  if (update === 'ignore') return;
  if (update === 'busy') {
    tell('Another identity check arrived. Finish or cancel the current one first.');
    return;
  }
  currentVerification = view.id;
  cancelCurrentVerification = view.cancel;
  verification.replaceChildren();
  const c = card('Make sure it’s your friend');
  c.append(el('p', view.peer));
  if (view.phase === 'done' || view.phase === 'cancelled') {
    currentVerification = '';
    cancelCurrentVerification = undefined;
    verification.close();
    verification.replaceChildren();
    tell(
      view.phase === 'done'
        ? 'Identity checked. You can now share.'
        : `Identity check cancelled${view.cancellationCode ? ` (${view.cancellationCode})` : ''}. Nothing was shared. Start one new check together.`,
    );
    if (view.phase === 'done') void refresh();
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
        view.phase === 'confirming'
          ? 'Finishing the identity check…'
          : view.phase === 'requested'
            ? 'Waiting for your friend to accept…'
            : 'Ready to compare.',
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
  const title = c.querySelector('h2')!;
  title.id = 'verification-title';
  title.tabIndex = -1;
  verification.setAttribute('aria-labelledby', title.id);
  verification.oncancel = (event) => {
    event.preventDefault();
    void view
      .cancel()
      .catch(() => tell('The identity check could not be cancelled yet. Try again.', true));
  };
  verification.onkeydown = (event) => {
    if (event.key !== 'Tab') return;
    const controls = [
      ...verification.querySelectorAll<HTMLElement>(
        'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
      ),
    ].filter((node) => !node.hidden && node.getClientRects().length);
    if (!controls.length) {
      event.preventDefault();
      title.focus();
      return;
    }
    const first = controls[0],
      last = controls[controls.length - 1];
    if (
      event.shiftKey &&
      (document.activeElement === first ||
        !controls.includes(document.activeElement as HTMLElement))
    ) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  verification.append(c);
  if (!verification.open) verification.showModal();
  title.focus();
}
function showOpenFailure(saved: Session, error: unknown): void {
  friendChecksReady = false;
  cancelCurrentVerification = undefined;
  currentVerification = '';
  verification.close();
  verification.replaceChildren();
  outbox?.close();
  outbox = undefined;
  identity?.close();
  identity = undefined;
  content = undefined;
  archiveDownloadView = undefined;
  clear();
  const ended = Identity.sessionIsInvalid(error);
  const c = card(ended ? 'Your home has ended this browser session' : 'Your book could not open');
  c.classList.add('narrow');
  const endConfirmation = el('input');
  endConfirmation.type = 'checkbox';
  endConfirmation.id = 'confirm-ended-session-removal';
  const endLabel = el('label', '', 'check');
  endLabel.append(
    endConfirmation,
    document.createTextNode(
      'I understand that keys not backed up will be lost when I remove this ended session.',
    ),
  );
  c.append(
    el('p', error instanceof Error ? error.message : 'Try again.', 'error-text'),
    button('Try again', () => location.reload()),
    ...(error instanceof SessionInUseError
      ? [
          el(
            'p',
            'Close the other tab for this account, then try again. Its sign-in and keys have been kept intact.',
          ),
        ]
      : [
          el(
            'p',
            'Ending this browser session removes its local keys and unsent changes. Keys that were not backed up will be lost; your recovery kit cannot restore memories that need those keys. Keep your original downloads.',
          ),
          ...(ended ? [endLabel] : []),
          button(
            'End this browser session',
            async () => {
              if (ended && !endConfirmation.checked)
                throw new Error('Confirm the key-loss warning before removing this ended session.');
              await Identity.logoutSession(saved);
              await exitLocally('Signed out. This browser’s keys have been removed.', saved);
            },
            'secondary',
          ),
        ]),
  );
  if (!(error instanceof SessionInUseError)) {
    const local = el('details');
    local.append(
      el('summary', 'Remove this browser’s keys without contacting the home'),
      el(
        'p',
        'This removes this browser’s keys, saved sign-in and unsent changes. Keys not already backed up will be lost; your recovery kit cannot recover memories that need those keys. It does not end the session on your home: that device may remain active there. You will need your recovery kit to recover available saved content when you sign in again. Keep your original downloads.',
      ),
    );
    const confirm = el('input');
    confirm.type = 'checkbox';
    confirm.id = 'confirm-local-key-removal';
    const label = el('label', '', 'check');
    label.append(
      confirm,
      document.createTextNode(
        'I understand that unsent changes and keys not backed up will be lost. My recovery kit cannot restore them.',
      ),
    );
    local.append(
      label,
      button(
        'Remove local keys and sign-in',
        async () => {
          if (!confirm.checked)
            throw new Error('Confirm the recovery warning before removing this browser’s keys.');
          await exitLocally(
            'This browser’s keys and sign-in have been removed. The session may still be active on your home.',
            saved,
          );
        },
        'danger',
      ),
    );
    c.append(local);
  }
  app.append(c);
}
window.addEventListener('pageshow', (event) => {
  if (event.persisted) location.reload();
});
window.addEventListener('pagehide', () => {
  identity?.close();
  outbox?.close();
});
void run(async () => {
  void cleanupImportTemporaryFiles();
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
      showOpenFailure(saved, error);
    }
  } else login();
});
