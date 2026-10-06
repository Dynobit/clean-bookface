import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { hash, verify, Algorithm } from '@node-rs/argon2';
import type { Store } from './storage.js';

export class CoreError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'CoreError';
  }
}
export type User = {
  id: string;
  username: string;
  displayName: string;
  bio: string;
  discoverable: boolean;
  quietNotifications: boolean;
  compactFeed: boolean;
  admin: boolean;
  suspended: boolean;
  createdAt: number;
  actor: string;
};
export type Session = { user: User; csrf: string; expiresAt: number };
export type AuthResult = { user: User; recoveryCodes: string[] };
type SignedInAuthResult = AuthResult & { session: Session & { token: string } };
type AccountInput = { username: string; displayName: string; password: string };
type RegistrationInput = AccountInput & { inviteToken: string };
export type Post = {
  id: string;
  authorId: string | null;
  authorActor: string;
  authorName: string;
  body: string;
  mediaIds: string[];
  createdAt: number;
  updatedAt: number;
  revision: number;
  audience: string;
  recipientActors?: string[];
  comments: Comment[];
  likes: number;
  liked: boolean;
};
export type Comment = {
  id: string;
  postId: string;
  actor: string;
  authorName: string;
  body: string;
  createdAt: number;
};
export type Friendship = {
  id: string;
  actor: string;
  name: string;
  state: string;
  direction: 'incoming' | 'outgoing';
  muted: boolean;
  favorite: boolean;
  expiresAt: number;
};
export type DomainEvent = {
  id: string;
  kind: string;
  actor: string;
  recipientActor: string;
  objectId: string;
  revision: number;
  payload: Record<string, unknown>;
  createdAt: number;
};
export type Notification = {
  id: string;
  kind: 'post' | 'comment' | 'like' | 'friend.request' | 'friend.accept' | 'friend.failed';
  actor: string;
  actorName: string;
  postId?: string;
  requestId?: string;
  createdAt: number;
  read: boolean;
};
export type CoreOptions = {
  origin: string;
  sessionTtlMs?: number;
  now?: () => number;
  maxAccounts?: number;
  validateMedia?: (userId: string, mediaIds: string[]) => void;
  sharingAllowed?: () => boolean;
};
type Row = Record<string, any>;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const DAY = 86_400_000;
const ARGON = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
};

/** All private social reads pass through canRead; raw database access is internal. */
export class Core {
  readonly origin: string;
  private readonly now: () => number;
  constructor(
    public readonly store: Store,
    private readonly options: CoreOptions,
  ) {
    this.origin = new URL(options.origin).origin;
    this.now = options.now ?? Date.now;
    const schema = store.db
      .prepare("SELECT version FROM schema_versions WHERE component='core'")
      .get() as { version: number } | undefined;
    if (schema && schema.version !== 1)
      throw new Error(
        'Unsupported core database schema. Use a matching application version or the documented backup restore procedure.',
      );
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '', discoverable INTEGER NOT NULL DEFAULT 0,
        quiet_notifications INTEGER NOT NULL DEFAULT 1, compact_feed INTEGER NOT NULL DEFAULT 0, admin INTEGER NOT NULL DEFAULT 0,
        suspended INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recovery_codes (user_id TEXT NOT NULL REFERENCES users(id), hash TEXT NOT NULL UNIQUE, PRIMARY KEY(user_id,hash));
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
      CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), hash TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER, revoked_at INTEGER, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS friendships (id TEXT PRIMARY KEY, from_actor TEXT NOT NULL, to_actor TEXT NOT NULL, state TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS friendship_pair ON friendships(from_actor,to_actor,state);
      CREATE TABLE IF NOT EXISTS blocks (owner_actor TEXT NOT NULL, target_actor TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(owner_actor,target_actor));
      CREATE TABLE IF NOT EXISTS friend_preferences (owner_id TEXT NOT NULL REFERENCES users(id), target_actor TEXT NOT NULL, muted INTEGER NOT NULL DEFAULT 0, favorite INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(owner_id,target_actor));
      CREATE TABLE IF NOT EXISTS publications (id TEXT PRIMARY KEY, author_id TEXT REFERENCES users(id), author_actor TEXT NOT NULL, body TEXT NOT NULL, media_ids TEXT NOT NULL DEFAULT '[]', archive_source_id TEXT, audience TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
      CREATE INDEX IF NOT EXISTS publication_timeline ON publications(created_at DESC,id);
      CREATE TABLE IF NOT EXISTS recipients (post_id TEXT NOT NULL REFERENCES publications(id), actor TEXT NOT NULL, revoked_at INTEGER, PRIMARY KEY(post_id,actor));
      CREATE INDEX IF NOT EXISTS recipients_actor ON recipients(actor,revoked_at);
      CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, post_id TEXT NOT NULL REFERENCES publications(id), actor TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS likes (post_id TEXT NOT NULL REFERENCES publications(id), actor TEXT NOT NULL, activity_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(post_id,actor));
      CREATE TABLE IF NOT EXISTS tombstones (object_id TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(object_id,actor,kind));
      CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, reporter_id TEXT NOT NULL REFERENCES users(id), target_actor TEXT NOT NULL, post_id TEXT, reason TEXT NOT NULL, evidence TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS appeals (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), body TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open', response TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, resolved_at INTEGER);
      CREATE TABLE IF NOT EXISTS rate_buckets (key TEXT PRIMARY KEY, started_at INTEGER NOT NULL, count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS domain_events (id TEXT PRIMARY KEY, kind TEXT NOT NULL, actor TEXT NOT NULL, recipient_actor TEXT NOT NULL, object_id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, acknowledged_at INTEGER, cancelled_at INTEGER);
      CREATE TABLE IF NOT EXISTS domain_admission (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE);
      CREATE INDEX IF NOT EXISTS domain_pending ON domain_events(acknowledged_at,cancelled_at,created_at);
      CREATE TABLE IF NOT EXISTS received_events (id TEXT NOT NULL, actor TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(id,actor));
      CREATE TABLE IF NOT EXISTS account_deletions (user_id TEXT PRIMARY KEY REFERENCES users(id), created_at INTEGER NOT NULL, archive_completed_at INTEGER);
      CREATE TABLE IF NOT EXISTS notification_records (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL, actor TEXT NOT NULL, post_id TEXT, source_id TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER, UNIQUE(user_id,kind,source_id));
      CREATE INDEX IF NOT EXISTS notification_owner ON notification_records(user_id,created_at DESC,id);
      INSERT OR IGNORE INTO schema_versions(component,version) VALUES('core',1);
    `);
    // Additive migration for pre-release development snapshots of schema 1.
    if (
      !(store.db.prepare('PRAGMA table_info(users)').all() as Row[]).some(
        (row) => row.name === 'compact_feed',
      )
    )
      store.db.exec('ALTER TABLE users ADD COLUMN compact_feed INTEGER NOT NULL DEFAULT 0');
  }
  private one(sql: string, ...params: any[]): Row | undefined {
    return this.store.db.prepare(sql).get(...params) as Row | undefined;
  }
  private all(sql: string, ...params: any[]): Row[] {
    return this.store.db.prepare(sql).all(...params) as Row[];
  }
  private run(sql: string, ...params: any[]) {
    return this.store.db.prepare(sql).run(...params);
  }
  private fail(status: number, message: string): never {
    throw new CoreError(status, message);
  }
  private safeUser(row: Row): User {
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      bio: row.bio,
      discoverable: !!row.discoverable,
      quietNotifications: !!row.quiet_notifications,
      compactFeed: !!row.compact_feed,
      admin: !!row.admin,
      suspended: !!row.suspended,
      createdAt: row.created_at,
      actor: `${this.origin}/users/${row.username}`,
    };
  }
  user(id: string): User {
    const row = this.one('SELECT * FROM users WHERE id=? AND deleted=0', id);
    return row ? this.safeUser(row) : this.fail(404, 'Account not found.');
  }
  userByName(username: string): User | null {
    const row = this.one(
      'SELECT * FROM users WHERE username=? AND deleted=0',
      username.toLowerCase(),
    );
    return row ? this.safeUser(row) : null;
  }
  adminMembers(adminId: string, options: { offset?: number; limit?: number } = {}): User[] {
    this.admin(adminId);
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 500;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 500
    )
      this.fail(400, 'Choose a valid member page.');
    return this.all(
      'SELECT * FROM users WHERE deleted=0 ORDER BY created_at,id LIMIT ? OFFSET ?',
      limit,
      offset,
    ).map((row) => this.safeUser(row));
  }
  adminMemberCount(adminId: string): number {
    this.admin(adminId);
    return this.one('SELECT count(*) AS total FROM users WHERE deleted=0')!.total;
  }
  profile(
    viewerId: string | undefined,
    username: string,
  ): Pick<User, 'id' | 'username' | 'displayName' | 'bio' | 'actor'> {
    const viewer = viewerId ? this.user(viewerId) : undefined;
    const target = this.userByName(username);
    const own = !!target && viewer?.id === target.id;
    const friend = !!target && !!viewer && this.areFriends(viewer.actor, target.actor);
    if (!target || (target.suspended && !own) || (!own && !friend && !target.discoverable))
      this.fail(404, 'Profile not found.');
    return {
      id: target.id,
      username: target.username,
      displayName: target.displayName,
      bio: own || friend ? target.bio : '',
      actor: target.actor,
    };
  }
  localActor(username: string): {
    id: string;
    userId: string;
    username: string;
    displayName: string;
    discoverable: boolean;
    suspended: boolean;
    deleted: boolean;
  } | null {
    const row = this.one('SELECT * FROM users WHERE username=?', username);
    if (!row) return null;
    const user = this.safeUser(row);
    return {
      id: user.actor,
      userId: user.id,
      username: user.username,
      displayName: user.username,
      discoverable: user.discoverable && !row.deleted,
      suspended: user.suspended,
      deleted: !!row.deleted,
    };
  }
  actor(userId: string): string {
    return this.user(userId).actor;
  }
  private local(actor: string): User | null {
    const prefix = `${this.origin}/users/`;
    const user = actor.startsWith(prefix) ? this.userByName(actor.slice(prefix.length)) : null;
    return user?.actor === actor ? user : null;
  }
  private active(id: string): User {
    const user = this.user(id);
    if (user.suspended)
      this.fail(403, 'This account is suspended. You can submit an appeal in settings.');
    return user;
  }
  private admin(id: string): User {
    const user = this.active(id);
    if (!user.admin) this.fail(403, 'Administrator access required.');
    return user;
  }
  isSetup(): boolean {
    return !!this.one('SELECT 1 FROM users LIMIT 1');
  }
  private credentials(username: string, displayName: string, password: string) {
    if (!/^[a-z0-9][a-z0-9_]{2,31}$/.test(username))
      this.fail(400, 'Use 3–32 lowercase letters, numbers or underscores for your username.');
    if (!displayName.trim() || displayName.length > 80)
      this.fail(400, 'Your name must contain 1–80 characters.');
    this.password(password);
  }
  private password(password: string) {
    if (typeof password !== 'string' || password.length < 12 || password.length > 1024)
      this.fail(400, 'Choose a password between 12 and 1,024 characters.');
  }
  private codes(userId: string): string[] {
    const codes = Array.from({ length: 8 }, () =>
      randomBytes(12)
        .toString('hex')
        .match(/.{1,6}/g)!
        .join('-'),
    );
    this.run('DELETE FROM recovery_codes WHERE user_id=?', userId);
    for (const code of codes)
      this.run('INSERT INTO recovery_codes(user_id,hash) VALUES(?,?)', userId, digest(code));
    return codes;
  }
  private insertUser(
    input: { username: string; displayName: string },
    passwordHash: string,
    admin: boolean,
  ): AuthResult {
    if (this.one('SELECT 1 FROM users WHERE username=?', input.username))
      this.fail(409, 'That username is already taken.');
    const id = randomUUID();
    this.run(
      'INSERT INTO users(id,username,display_name,password_hash,admin,created_at) VALUES(?,?,?,?,?,?)',
      id,
      input.username,
      input.displayName.trim(),
      passwordHash,
      admin ? 1 : 0,
      this.now(),
    );
    return { user: this.user(id), recoveryCodes: this.codes(id) };
  }
  async setup(input: AccountInput): Promise<AuthResult>;
  async setup(input: AccountInput, signIn: true): Promise<SignedInAuthResult>;
  async setup(input: AccountInput, signIn = false): Promise<AuthResult | SignedInAuthResult> {
    this.credentials(input.username, input.displayName, input.password);
    const passwordHash = await hash(input.password, ARGON);
    return this.store.transaction(() => {
      if (this.isSetup()) this.fail(409, 'This circle has already been set up.');
      const result = this.insertUser(input, passwordHash, true);
      return signIn ? { ...result, session: this.createSession(result.user.id) } : result;
    });
  }
  async register(input: RegistrationInput): Promise<AuthResult>;
  async register(input: RegistrationInput, signIn: true): Promise<SignedInAuthResult>;
  async register(
    input: RegistrationInput,
    signIn = false,
  ): Promise<AuthResult | SignedInAuthResult> {
    this.credentials(input.username, input.displayName, input.password);
    this.validInvite(input.inviteToken, 'registration');
    const passwordHash = await hash(input.password, ARGON);
    return this.store.transaction(() => {
      const invite = this.validInvite(input.inviteToken, 'registration');
      if (
        this.one('SELECT count(*) AS n FROM users WHERE deleted=0')!.n >=
        (this.options.maxAccounts ?? 200)
      )
        this.fail(409, 'This circle has reached its account limit.');
      const result = this.insertUser(input, passwordHash, false);
      this.run('UPDATE invitations SET consumed_at=? WHERE id=?', this.now(), invite.id);
      return signIn ? { ...result, session: this.createSession(result.user.id) } : result;
    });
  }
  /** Operational rate keys are hashes; no IP address or credential is persisted here. */
  rate(key: string, limit: number, windowMs: number) {
    const value = digest(key);
    const now = this.now();
    const row = this.one('SELECT * FROM rate_buckets WHERE key=?', value);
    if (!row || row.started_at + windowMs <= now) {
      this.run(
        'INSERT INTO rate_buckets(key,started_at,count) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET started_at=excluded.started_at,count=1',
        value,
        now,
      );
    } else {
      if (row.count >= limit) this.fail(429, 'Too many attempts. Please wait and try again.');
      this.run('UPDATE rate_buckets SET count=count+1 WHERE key=?', value);
    }
  }
  async login(username: string, password: string): Promise<Session & { token: string }> {
    if (typeof password !== 'string' || password.length > 1024)
      this.fail(401, 'Username or password is incorrect.');
    const row = this.one(
      'SELECT * FROM users WHERE username=? AND deleted=0',
      username.toLowerCase(),
    );
    // Random nonexistent names must not consume every member's login budget.
    // Keep their expensive dummy password work bounded separately; real names
    // retain an account-specific brute-force limit. Unknown names cannot grow
    // the durable bucket table without bound.
    if (!row) this.rate('login:unknown', 60, 60_000);
    else this.rate(`login:${username.toLowerCase()}`, 10, 15 * 60_000);
    const valid = row
      ? await verify(row.password_hash, password).catch(() => false)
      : (await hash(password || 'invalid password', ARGON), false);
    if (!valid || !row) this.fail(401, 'Username or password is incorrect.');
    // Suspended people retain access to export, deletion and an appeal, not posting.
    return this.store.transaction(() => {
      const current = this.one('SELECT password_hash FROM users WHERE id=? AND deleted=0', row.id);
      if (!current || current.password_hash !== row.password_hash)
        this.fail(401, 'Credentials changed. Sign in again.');
      return this.createSession(row.id);
    });
  }
  private createSession(userId: string): Session & { token: string } {
    const token = secret();
    const csrf = secret();
    const expiresAt = this.now() + (this.options.sessionTtlMs ?? 7 * DAY);
    this.run('DELETE FROM sessions WHERE expires_at<=?', this.now());
    this.run(
      'INSERT INTO sessions(hash,user_id,csrf,expires_at) VALUES(?,?,?,?)',
      digest(token),
      userId,
      csrf,
      expiresAt,
    );
    return { user: this.user(userId), token, csrf, expiresAt };
  }
  session(token: string | undefined): Session | null {
    if (!token || token.length > 256) return null;
    const row = this.one(
      'SELECT * FROM sessions WHERE hash=? AND expires_at>?',
      digest(token),
      this.now(),
    );
    if (!row) return null;
    const user = this.one('SELECT * FROM users WHERE id=? AND deleted=0', row.user_id);
    return user ? { user: this.safeUser(user), csrf: row.csrf, expiresAt: row.expires_at } : null;
  }
  validCsrf(session: Session, supplied: string): boolean {
    const a = Buffer.from(session.csrf);
    const b = Buffer.from(supplied);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  logout(token: string) {
    this.run('DELETE FROM sessions WHERE hash=?', digest(token));
  }
  logoutAll(userId: string) {
    this.user(userId);
    this.run('DELETE FROM sessions WHERE user_id=?', userId);
  }
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    authorize?: () => void,
  ): Promise<string[]>;
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    authorize: (() => void) | undefined,
    signIn: true,
  ): Promise<SignedInAuthResult>;
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    authorize?: () => void,
    signIn = false,
  ): Promise<string[] | SignedInAuthResult> {
    this.password(newPassword);
    this.rate(`password:${userId}`, 5, 15 * 60_000);
    const row = this.one('SELECT * FROM users WHERE id=? AND deleted=0', userId);
    if (!row || !(await verify(row.password_hash, currentPassword).catch(() => false)))
      this.fail(401, 'Current password is incorrect.');
    const passwordHash = await hash(newPassword, ARGON);
    return this.store.transaction(() => {
      authorize?.();
      const current = this.one('SELECT password_hash FROM users WHERE id=? AND deleted=0', userId);
      if (!current || current.password_hash !== row.password_hash)
        this.fail(401, 'Credentials changed. Sign in again.');
      this.run('UPDATE users SET password_hash=? WHERE id=?', passwordHash, userId);
      this.logoutAll(userId);
      const recoveryCodes = this.codes(userId);
      return signIn
        ? { user: this.user(userId), recoveryCodes, session: this.createSession(userId) }
        : recoveryCodes;
    });
  }
  async recover(username: string, code: string, newPassword: string): Promise<AuthResult>;
  async recover(
    username: string,
    code: string,
    newPassword: string,
    signIn: true,
  ): Promise<SignedInAuthResult>;
  async recover(
    username: string,
    code: string,
    newPassword: string,
    signIn = false,
  ): Promise<AuthResult | SignedInAuthResult> {
    this.password(newPassword);
    const user = this.userByName(username);
    if (!user) this.rate('recover:unknown', 20, 60_000);
    else this.rate(`recover:${username.toLowerCase()}`, 5, 60 * 60_000);
    if (
      !user ||
      !this.one(
        'SELECT 1 FROM recovery_codes WHERE user_id=? AND hash=?',
        user.id,
        digest(code.trim()),
      )
    )
      this.fail(401, 'Username or recovery code is incorrect.');
    const passwordHash = await hash(newPassword, ARGON);
    return this.store.transaction(() => {
      if (
        !this.one(
          'SELECT 1 FROM recovery_codes WHERE user_id=? AND hash=?',
          user.id,
          digest(code.trim()),
        )
      )
        this.fail(401, 'Username or recovery code is incorrect.');
      this.run('UPDATE users SET password_hash=? WHERE id=?', passwordHash, user.id);
      this.logoutAll(user.id);
      const result = { user: this.user(user.id), recoveryCodes: this.codes(user.id) };
      return signIn ? { ...result, session: this.createSession(user.id) } : result;
    });
  }
  updateSettings(
    userId: string,
    patch: {
      displayName?: string;
      bio?: string;
      discoverable?: boolean;
      quietNotifications?: boolean;
      compactFeed?: boolean;
    },
  ): User {
    const user = this.active(userId);
    const name = patch.displayName?.trim() ?? user.displayName;
    const bio = patch.bio ?? user.bio;
    if (!name || name.length > 80 || bio.length > 500)
      this.fail(400, 'Names have an 80-character limit; biographies have a 500-character limit.');
    this.run(
      'UPDATE users SET display_name=?,bio=?,discoverable=?,quiet_notifications=?,compact_feed=? WHERE id=?',
      name,
      bio,
      (patch.discoverable ?? user.discoverable) ? 1 : 0,
      (patch.quietNotifications ?? user.quietNotifications) ? 1 : 0,
      (patch.compactFeed ?? user.compactFeed) ? 1 : 0,
      userId,
    );
    return this.user(userId);
  }
  createInvite(
    userId: string,
    kind: 'registration' | 'friendship',
    ttlMs = 7 * DAY,
  ): { id: string; token: string; expiresAt: number } {
    this.active(userId);
    if (!['registration', 'friendship'].includes(kind)) this.fail(400, 'Unknown invitation type.');
    this.rate(`invite:${userId}`, 10, DAY);
    const id = randomUUID();
    const token = secret();
    const expiresAt = this.now() + Math.max(60_000, Math.min(ttlMs, 30 * DAY));
    this.run(
      'INSERT INTO invitations(id,owner_id,hash,kind,expires_at,created_at) VALUES(?,?,?,?,?,?)',
      id,
      userId,
      digest(token),
      kind,
      expiresAt,
      this.now(),
    );
    return { id, token, expiresAt };
  }
  private validInvite(token: string, kind?: string): Row {
    if (!token || token.length > 256) this.fail(400, 'This invitation is invalid or has expired.');
    const row = this.one(
      'SELECT i.* FROM invitations i JOIN users u ON u.id=i.owner_id WHERE i.hash=? AND i.expires_at>? AND i.consumed_at IS NULL AND i.revoked_at IS NULL AND u.deleted=0 AND u.suspended=0',
      digest(token),
      this.now(),
    );
    if (!row || (kind && row.kind !== kind))
      this.fail(400, 'This invitation is invalid or has expired.');
    return row;
  }
  inspectInvite(token: string): { kind: string; inviter: string; expiresAt: number } {
    const row = this.validInvite(token);
    return {
      kind: row.kind,
      inviter: this.user(row.owner_id).displayName,
      expiresAt: row.expires_at,
    };
  }
  invites(userId: string): Row[] {
    this.user(userId);
    return this.all(
      'SELECT id,kind,expires_at AS expiresAt,consumed_at AS consumedAt,revoked_at AS revokedAt FROM invitations WHERE owner_id=? ORDER BY created_at DESC LIMIT 100',
      userId,
    );
  }
  revokeInvite(userId: string, inviteId: string) {
    this.user(userId);
    this.run(
      'UPDATE invitations SET revoked_at=? WHERE id=? AND owner_id=?',
      this.now(),
      inviteId,
      userId,
    );
  }
  acceptFriendInvite(userId: string, token: string): string {
    this.active(userId);
    return this.store.transaction(() => {
      const invite = this.validInvite(token, 'friendship');
      if (invite.owner_id === userId) this.fail(400, 'This is your own invitation.');
      const id = this.makeRequest(this.actor(invite.owner_id), this.actor(userId));
      const row = this.one('SELECT * FROM friendships WHERE id=?', id)!;
      if (row.state === 'pending')
        this.acceptFriend(row.to_actor === this.actor(userId) ? userId : invite.owner_id, id);
      this.run('UPDATE invitations SET consumed_at=? WHERE id=?', this.now(), invite.id);
      return id;
    });
  }
  private validateActor(actor: string) {
    let url: URL;
    try {
      url = new URL(actor);
    } catch {
      return this.fail(400, 'Enter a complete profile URL.');
    }
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      actor.length > 2048
    )
      this.fail(400, 'Invalid profile URL.');
    if (url.origin === this.origin && !this.local(actor)) this.fail(404, 'Account not found.');
  }
  private blocked(a: string, b: string): boolean {
    return !!this.one(
      'SELECT 1 FROM blocks WHERE (owner_actor=? AND target_actor=?) OR (owner_actor=? AND target_actor=?)',
      a,
      b,
      b,
      a,
    );
  }
  areFriends(a: string, b: string): boolean {
    return (
      a !== b &&
      !this.blocked(a, b) &&
      !!this.one(
        "SELECT 1 FROM friendships WHERE state='accepted' AND ((from_actor=? AND to_actor=?) OR (from_actor=? AND to_actor=?))",
        a,
        b,
        b,
        a,
      )
    );
  }
  private makeRequest(from: string, to: string, remoteId?: string, remoteExpiry?: unknown): string {
    if (
      remoteExpiry !== undefined &&
      (!Number.isSafeInteger(remoteExpiry) || (remoteExpiry as number) <= this.now())
    )
      this.fail(410, 'This friendship request has expired.');
    const expiresAt = Math.min(
      this.now() + 7 * DAY,
      (remoteExpiry as number | undefined) ?? Infinity,
    );
    const id = remoteId ?? randomUUID();
    this.validateActor(from);
    this.validateActor(to);
    if (from === to || this.blocked(from, to))
      this.fail(400, 'This friendship request cannot be made.');
    if (
      this.one(
        "SELECT 1 FROM tombstones WHERE object_id=? AND actor=? AND kind='friend.request'",
        id,
        from,
      )
    )
      this.fail(410, 'This friendship request was withdrawn.');
    if (this.local(to)?.suspended || this.local(from)?.suspended)
      this.fail(400, 'This friendship request cannot be made.');
    this.run(
      "UPDATE friendships SET state='expired',updated_at=? WHERE state='pending' AND expires_at<=?",
      this.now(),
      this.now(),
    );
    const priorId = this.one('SELECT * FROM friendships WHERE id=?', id);
    if (priorId) {
      if (
        priorId.from_actor === from &&
        priorId.to_actor === to &&
        ['pending', 'accepted'].includes(priorId.state)
      )
        return id;
      this.fail(409, 'This request has already been used.');
    }
    const existing = this.one(
      "SELECT * FROM friendships WHERE state IN ('accepted','pending') AND ((from_actor=? AND to_actor=?) OR (from_actor=? AND to_actor=?))",
      from,
      to,
      to,
      from,
    );
    if (existing && !remoteId) return existing.id;
    if (!existing)
      for (const actor of [from, to])
        if (
          this.local(actor) &&
          this.one(
            "SELECT count(*) AS n FROM friendships WHERE (state='accepted' AND (from_actor=? OR to_actor=?)) OR (state='pending' AND from_actor=?)",
            actor,
            actor,
            actor,
          )!.n >= 500
        )
          this.fail(429, 'This account has reached its friendship and pending-request limit.');
    if (this.local(to) && !this.local(from)) {
      const incoming = this.all(
        "SELECT from_actor FROM friendships WHERE to_actor=? AND state='pending' AND from_actor<>?",
        to,
        from,
      );
      if (
        incoming.length >= 500 ||
        incoming.filter((row) => new URL(row.from_actor).origin === new URL(from).origin).length >=
          20
      )
        this.fail(429, 'Too many incoming friendship requests.');
    }
    // A new signed Follow is a new consent cycle. Revoke previous grants before
    // offering it, even if an earlier removal is still in a peer's retry queue.
    if (existing) this.revokePair(from, to);
    this.run(
      "INSERT INTO friendships(id,from_actor,to_actor,state,expires_at,created_at,updated_at) VALUES(?,?,?,'pending',?,?,?)",
      id,
      from,
      to,
      expiresAt,
      this.now(),
      this.now(),
    );
    this.queue('friend.request', from, to, id, 1, { requestId: id, from, to, expiresAt });
    this.notify(to, 'friend.request', from, id);
    return id;
  }
  requestFriend(userId: string, targetActor: string): string {
    const user = this.active(userId);
    this.rate(`friend:${userId}`, 20, DAY);
    return this.store.transaction(() => this.makeRequest(user.actor, targetActor));
  }
  acceptFriend(userId: string, requestId: string) {
    const user = this.active(userId);
    return this.store.transaction(() => {
      const row = this.one('SELECT * FROM friendships WHERE id=?', requestId);
      const requester = row?.from_actor.startsWith(`${this.origin}/users/`)
        ? this.localActor(row.from_actor.slice(`${this.origin}/users/`.length))
        : null;
      if (
        !row ||
        row.to_actor !== user.actor ||
        row.state !== 'pending' ||
        row.expires_at <= this.now() ||
        this.blocked(row.from_actor, row.to_actor) ||
        requester?.deleted ||
        requester?.suspended
      )
        this.fail(404, 'This friendship request is unavailable.');
      if (
        this.one(
          "SELECT count(*) AS n FROM friendships WHERE (state='accepted' AND (from_actor=? OR to_actor=?)) OR (state='pending' AND from_actor=?)",
          user.actor,
          user.actor,
          user.actor,
        )!.n >= 500
      )
        this.fail(429, 'This account has reached its friendship and pending-request limit.');
      this.run(
        "UPDATE friendships SET state='accepted',updated_at=? WHERE id=?",
        this.now(),
        requestId,
      );
      this.queue('friend.accept', user.actor, row.from_actor, requestId, 1, {
        requestId,
        from: row.from_actor,
        to: row.to_actor,
      });
      this.notify(row.from_actor, 'friend.accept', user.actor, requestId);
    });
  }
  rejectFriend(userId: string, requestId: string) {
    this.closeRequest(userId, requestId, 'rejected');
  }
  cancelFriend(userId: string, requestId: string) {
    this.closeRequest(userId, requestId, 'cancelled');
  }
  private closeRequest(userId: string, id: string, state: string) {
    const user = this.active(userId);
    const row = this.one('SELECT * FROM friendships WHERE id=?', id);
    const expected = state === 'rejected' ? row?.to_actor : row?.from_actor;
    if (!row || expected !== user.actor || row.state !== 'pending')
      this.fail(404, 'This request is unavailable.');
    this.store.transaction(() => {
      this.run('UPDATE friendships SET state=?,updated_at=? WHERE id=?', state, this.now(), id);
      this.queue(
        'friend.close',
        user.actor,
        row.from_actor === user.actor ? row.to_actor : row.from_actor,
        id,
        1,
        { requestId: id },
      );
    });
  }
  private relationshipList(userId: string, state: string): Friendship[] {
    const actor = this.actor(userId);
    const rows = this.all(
      "SELECT * FROM friendships WHERE state=? AND (from_actor=? OR to_actor=?) AND (?<>'pending' OR expires_at>?) ORDER BY updated_at DESC LIMIT 500",
      state,
      actor,
      actor,
      state,
      this.now(),
    );
    return rows.map((row) => {
      const target = row.from_actor === actor ? row.to_actor : row.from_actor;
      const pref = this.one(
        'SELECT * FROM friend_preferences WHERE owner_id=? AND target_actor=?',
        userId,
        target,
      );
      return {
        id: row.id,
        actor: target,
        name: this.local(target)?.displayName ?? target,
        state: row.state,
        direction: row.from_actor === actor ? ('outgoing' as const) : ('incoming' as const),
        muted: !!pref?.muted,
        favorite: !!pref?.favorite,
        expiresAt: row.expires_at,
      };
    });
  }
  friends(userId: string): Friendship[] {
    return this.relationshipList(userId, 'accepted').filter(
      (f) => !this.blocked(this.actor(userId), f.actor),
    );
  }
  pendingFriends(userId: string): Friendship[] {
    return this.relationshipList(userId, 'pending');
  }
  setFriendPreference(
    userId: string,
    targetActor: string,
    patch: { muted?: boolean; favorite?: boolean },
  ) {
    this.active(userId);
    if (!this.areFriends(this.actor(userId), targetActor)) this.fail(404, 'Friend not found.');
    const old = this.one(
      'SELECT * FROM friend_preferences WHERE owner_id=? AND target_actor=?',
      userId,
      targetActor,
    );
    this.run(
      'INSERT INTO friend_preferences(owner_id,target_actor,muted,favorite) VALUES(?,?,?,?) ON CONFLICT(owner_id,target_actor) DO UPDATE SET muted=excluded.muted,favorite=excluded.favorite',
      userId,
      targetActor,
      (patch.muted ?? !!old?.muted) ? 1 : 0,
      (patch.favorite ?? !!old?.favorite) ? 1 : 0,
    );
  }
  private revokePair(a: string, b: string) {
    const rows = this.all(
      'SELECT p.id,p.author_actor,p.revision,r.actor FROM publications p JOIN recipients r ON r.post_id=p.id WHERE r.revoked_at IS NULL AND ((p.author_actor=? AND r.actor=?) OR (p.author_actor=? AND r.actor=?))',
      a,
      b,
      b,
      a,
    );
    for (const row of rows) this.revoke(row.id, row.author_actor, row.actor, row.revision);
    this.run(
      "UPDATE friendships SET state='cancelled',updated_at=? WHERE state IN ('pending','accepted') AND ((from_actor=? AND to_actor=?) OR (from_actor=? AND to_actor=?))",
      this.now(),
      a,
      b,
      b,
      a,
    );
  }
  unfriend(userId: string, targetActor: string) {
    const user = this.active(userId);
    this.validateActor(targetActor);
    const relationship = this.one(
      "SELECT id FROM friendships WHERE state IN ('accepted','pending') AND ((from_actor=? AND to_actor=?) OR (from_actor=? AND to_actor=?))",
      user.actor,
      targetActor,
      targetActor,
      user.actor,
    );
    if (!relationship) this.fail(404, 'Friendship not found.');
    this.store.transaction(() => {
      this.revokePair(user.actor, targetActor);
      this.queue('friend.remove', user.actor, targetActor, relationship.id, 1, {
        requestId: relationship.id,
      });
    });
  }
  block(userId: string, targetActor: string) {
    const user = this.active(userId);
    this.validateActor(targetActor);
    if (user.actor === targetActor) this.fail(400, 'You cannot block yourself.');
    this.rate(`block:${userId}`, 100, DAY);
    const known = this.one(
      "SELECT id FROM friendships WHERE state IN ('accepted','pending') AND ((from_actor=? AND to_actor=?) OR (from_actor=? AND to_actor=?))",
      user.actor,
      targetActor,
      targetActor,
      user.actor,
    );
    this.store.transaction(() => {
      this.run(
        'INSERT OR IGNORE INTO blocks(owner_actor,target_actor,created_at) VALUES(?,?,?)',
        user.actor,
        targetActor,
        this.now(),
      );
      this.revokePair(user.actor, targetActor);
      if (known)
        this.queue('friend.remove', user.actor, targetActor, known.id, 1, { requestId: known.id });
    });
  }
  unblock(userId: string, targetActor: string) {
    this.active(userId);
    this.run(
      'DELETE FROM blocks WHERE owner_actor=? AND target_actor=?',
      this.actor(userId),
      targetActor,
    );
  }
  blockedActors(userId: string): string[] {
    return this.all('SELECT target_actor FROM blocks WHERE owner_actor=?', this.actor(userId)).map(
      (r) => r.target_actor,
    );
  }
  private validateBody(body: string, limit = 20_000) {
    if (typeof body !== 'string' || body.length > limit)
      this.fail(400, `Text must be no longer than ${limit.toLocaleString()} characters.`);
  }
  private validateMedia(userId: string, mediaIds: string[]) {
    if (
      mediaIds.length > 12 ||
      new Set(mediaIds).size !== mediaIds.length ||
      mediaIds.some((id) => typeof id !== 'string' || id.length > 2048)
    )
      this.fail(400, 'Choose up to 12 distinct photos.');
    if (mediaIds.length && !this.options.validateMedia)
      this.fail(400, 'Photo sharing is unavailable.');
    this.options.validateMedia?.(userId, mediaIds);
  }
  publish(
    userId: string,
    input: {
      body: string;
      audience: 'private' | 'friends' | 'selected';
      recipientActors?: string[];
      mediaIds?: string[];
      archiveSourceId?: string;
    },
  ): Post {
    const user = this.active(userId);
    this.validateBody(input.body);
    const media = input.mediaIds ?? [];
    this.validateMedia(userId, media);
    if (!input.body.trim() && !media.length) this.fail(400, 'Write something or choose a photo.');
    if (!['private', 'friends', 'selected'].includes(input.audience))
      this.fail(400, 'Choose who can see this post.');
    this.rate(`post:${userId}`, 60, 60 * 60_000);
    const recipients =
      input.audience === 'friends'
        ? this.friends(userId).map((f) => f.actor)
        : input.audience === 'selected'
          ? [...new Set(input.recipientActors ?? [])]
          : [];
    this.validateRecipients(user.actor, recipients);
    if (input.audience === 'selected' && !recipients.length)
      this.fail(400, 'Choose at least one friend or make this private.');
    return this.store.transaction(() => {
      const id = randomUUID();
      const now = this.now();
      this.run(
        'INSERT INTO publications(id,author_id,author_actor,body,media_ids,archive_source_id,audience,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
        id,
        userId,
        user.actor,
        input.body,
        JSON.stringify(media),
        input.archiveSourceId ?? null,
        input.audience,
        now,
        now,
      );
      for (const actor of recipients) {
        this.run('INSERT INTO recipients(post_id,actor) VALUES(?,?)', id, actor);
        this.queuePost('post.create', id, actor);
        this.notify(actor, 'post', user.actor, id, id);
      }
      return this.post(id, userId);
    });
  }
  private validateRecipients(actor: string, recipients: string[]) {
    if (recipients.length > 500 || recipients.some((target) => !this.areFriends(actor, target)))
      this.fail(400, 'Only mutually accepted friends can receive this post.');
  }
  canRead(postId: string, viewerId: string): boolean {
    const user = this.user(viewerId);
    const post = this.one('SELECT * FROM publications WHERE id=? AND deleted_at IS NULL', postId);
    if (!post) return false;
    if (post.author_id === viewerId) return true;
    if (this.options.sharingAllowed && !this.options.sharingAllowed()) return false;
    if (
      user.suspended ||
      this.local(post.author_actor)?.suspended ||
      !this.areFriends(post.author_actor, user.actor)
    )
      return false;
    return !!this.one(
      'SELECT 1 FROM recipients WHERE post_id=? AND actor=? AND revoked_at IS NULL',
      postId,
      user.actor,
    );
  }
  canActorRead(postId: string, actor: string): boolean {
    const post = this.one('SELECT * FROM publications WHERE id=? AND deleted_at IS NULL', postId);
    if (!post) return false;
    if (post.author_actor === actor) return true;
    if (this.options.sharingAllowed && !this.options.sharingAllowed()) return false;
    if (
      this.local(actor)?.suspended ||
      this.local(post.author_actor)?.suspended ||
      !this.areFriends(post.author_actor, actor)
    )
      return false;
    return !!this.one(
      'SELECT 1 FROM recipients WHERE post_id=? AND actor=? AND revoked_at IS NULL',
      postId,
      actor,
    );
  }
  post(postId: string, viewerId: string): Post {
    if (!this.canRead(postId, viewerId)) this.fail(404, 'Post not found.');
    const row = this.one('SELECT * FROM publications WHERE id=?', postId)!;
    const actor = this.actor(viewerId);
    const comments = this.all(
      "SELECT * FROM comments WHERE post_id=? AND body<>'' ORDER BY created_at,id LIMIT 500",
      postId,
    )
      .filter((c) => !this.blocked(actor, c.actor))
      .map((c) => ({
        id: c.id,
        postId,
        actor: c.actor,
        authorName: this.local(c.actor)?.displayName ?? c.actor,
        body: c.body,
        createdAt: c.created_at,
      }));
    return {
      id: row.id,
      authorId: row.author_id,
      authorActor: row.author_actor,
      authorName: this.local(row.author_actor)?.displayName ?? row.author_actor,
      body: row.body,
      mediaIds: JSON.parse(row.media_ids),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      revision: row.revision,
      audience: row.author_id === viewerId ? row.audience : 'shared',
      ...(row.author_id === viewerId
        ? {
            recipientActors: this.all(
              'SELECT actor FROM recipients WHERE post_id=? AND revoked_at IS NULL',
              postId,
            ).map((r) => r.actor),
          }
        : {}),
      comments,
      likes: this.one('SELECT count(*) AS n FROM likes WHERE post_id=?', postId)!.n,
      liked: !!this.one('SELECT 1 FROM likes WHERE post_id=? AND actor=?', postId, actor),
    };
  }
  feed(
    viewerId: string,
    options: {
      before?: number;
      beforeId?: string;
      limit?: number;
      query?: string;
      favoritesOnly?: boolean;
    } = {},
  ): Post[] {
    const user = this.user(viewerId);
    const limit = Math.max(1, Math.min(options.limit ?? 30, 100));
    const query = (options.query ?? '').slice(0, 200);
    const escaped = query.replace(/[\\%_]/g, '\\$&');
    const before = options.before ?? Number.MAX_SAFE_INTEGER;
    const beforeId = (options.beforeId ?? '').slice(0, 2048);
    const rows = this.all(
      `SELECT p.id FROM publications p LEFT JOIN friend_preferences f ON f.owner_id=? AND f.target_actor=p.author_actor WHERE p.deleted_at IS NULL AND (p.created_at<? OR (p.created_at=? AND p.id<?)) AND (p.author_id=? OR EXISTS(SELECT 1 FROM recipients r WHERE r.post_id=p.id AND r.actor=? AND r.revoked_at IS NULL)) AND coalesce(f.muted,0)=0 AND (?=0 OR f.favorite=1) AND p.body LIKE ? ESCAPE '\\' ORDER BY p.created_at DESC,p.id DESC LIMIT 500`,
      viewerId,
      before,
      before,
      beforeId,
      viewerId,
      user.actor,
      options.favoritesOnly ? 1 : 0,
      `%${escaped}%`,
    );
    return rows
      .filter((row) => this.canRead(row.id, viewerId))
      .slice(0, limit)
      .map((row) => this.post(row.id, viewerId));
  }
  private owned(userId: string, postId: string): Row {
    this.active(userId);
    const row = this.one(
      'SELECT * FROM publications WHERE id=? AND author_id=? AND deleted_at IS NULL',
      postId,
      userId,
    );
    return row ?? this.fail(404, 'Post not found.');
  }
  editPost(userId: string, postId: string, input: { body: string; mediaIds?: string[] }): Post {
    const row = this.owned(userId, postId);
    this.validateBody(input.body);
    const media = input.mediaIds ?? JSON.parse(row.media_ids);
    this.validateMedia(userId, media);
    if (!input.body.trim() && !media.length) this.fail(400, 'Write something or choose a photo.');
    return this.store.transaction(() => {
      this.run(
        'UPDATE publications SET body=?,media_ids=?,revision=revision+1,updated_at=? WHERE id=?',
        input.body,
        JSON.stringify(media),
        this.now(),
        postId,
      );
      for (const actor of this.audience(postId)) this.queuePost('post.update', postId, actor);
      return this.post(postId, userId);
    });
  }
  private audience(postId: string): string[] {
    return this.all(
      'SELECT actor FROM recipients WHERE post_id=? AND revoked_at IS NULL',
      postId,
    ).map((r) => r.actor);
  }
  grantRecipients(userId: string, postId: string, recipients: string[]) {
    const row = this.owned(userId, postId);
    this.validateRecipients(row.author_actor, recipients);
    this.store.transaction(() => {
      for (const actor of new Set(recipients)) {
        const existing = this.one(
          'SELECT revoked_at FROM recipients WHERE post_id=? AND actor=?',
          postId,
          actor,
        );
        if (existing?.revoked_at === null) continue;
        if (existing)
          this.fail(409, 'Revoked historical grants cannot be restored. Share a new copy instead.');
        this.run('INSERT INTO recipients(post_id,actor) VALUES(?,?)', postId, actor);
        this.queuePost('post.create', postId, actor);
        this.notify(actor, 'post', row.author_actor, postId, postId);
      }
      if (recipients.length)
        this.run("UPDATE publications SET audience='selected' WHERE id=?", postId);
    });
  }
  private purgeRemoteWithoutReaders(postId: string) {
    const row = this.one('SELECT author_id FROM publications WHERE id=?', postId);
    if (!row || row.author_id || this.audience(postId).length) return;
    this.run("UPDATE publications SET body='',media_ids='[]' WHERE id=?", postId);
    this.run(
      'DELETE FROM comments WHERE post_id=? AND actor NOT IN (SELECT ? || username FROM users)',
      postId,
      `${this.origin}/users/`,
    );
    this.run("UPDATE comments SET body='' WHERE post_id=?", postId);
    this.run('DELETE FROM likes WHERE post_id=?', postId);
  }
  private revoke(postId: string, author: string, recipient: string, revision: number) {
    this.run(
      'UPDATE recipients SET revoked_at=? WHERE post_id=? AND actor=?',
      this.now(),
      postId,
      recipient,
    );
    this.run(
      "UPDATE domain_events SET payload='{}',cancelled_at=? WHERE object_id=? AND recipient_actor=? AND acknowledged_at IS NULL AND kind NOT IN ('post.delete','post.revoke','comment.delete','like.remove')",
      this.now(),
      postId,
      recipient,
    );
    this.purgeRemoteWithoutReaders(postId);
    this.queue('post.revoke', author, recipient, postId, revision + 1, { postId });
    this.run(
      'INSERT OR IGNORE INTO tombstones(object_id,actor,kind,created_at) VALUES(?,?,?,?)',
      postId,
      recipient,
      `grant:${author}`,
      this.now(),
    );
  }
  revokeRecipients(userId: string, postId: string, recipients: string[]) {
    const row = this.owned(userId, postId);
    this.store.transaction(() => {
      for (const actor of recipients)
        if (
          this.one(
            'SELECT 1 FROM recipients WHERE post_id=? AND actor=? AND revoked_at IS NULL',
            postId,
            actor,
          )
        )
          this.revoke(postId, row.author_actor, actor, row.revision);
    });
  }
  deletePost(userId: string, postId: string) {
    const row = this.owned(userId, postId);
    this.store.transaction(() => this.removePost(row));
  }
  private removePost(row: Row) {
    for (const actor of this.audience(row.id)) {
      this.revoke(row.id, row.author_actor, actor, row.revision);
      this.queue('post.delete', row.author_actor, actor, row.id, row.revision + 1, {
        postId: row.id,
      });
    }
    this.run(
      "UPDATE publications SET body='',media_ids='[]',archive_source_id=NULL,deleted_at=?,updated_at=?,revision=revision+1 WHERE id=?",
      this.now(),
      this.now(),
      row.id,
    );
    this.run('DELETE FROM comments WHERE post_id=?', row.id);
    this.run('DELETE FROM likes WHERE post_id=?', row.id);
    this.run(
      'INSERT OR IGNORE INTO tombstones(object_id,actor,kind,created_at) VALUES(?,?,?,?)',
      row.id,
      row.author_actor,
      'post',
      this.now(),
    );
    this.run(
      "UPDATE domain_events SET payload='{}',cancelled_at=? WHERE object_id=? AND kind IN ('post.create','post.update','comment.create','like.create','like.remove')",
      this.now(),
      row.id,
    );
  }
  comment(userId: string, postId: string, body: string): Comment {
    const user = this.active(userId);
    this.validateBody(body, 5000);
    if (!body.trim()) this.fail(400, 'Write a comment first.');
    if (!this.canRead(postId, userId)) this.fail(404, 'Post not found.');
    this.rate(`comment:${userId}`, 120, 60 * 60_000);
    return this.store.transaction(() => {
      const id = randomUUID();
      const createdAt = this.now();
      this.run(
        'INSERT INTO comments(id,post_id,actor,body,created_at) VALUES(?,?,?,?,?)',
        id,
        postId,
        user.actor,
        body,
        createdAt,
      );
      this.distributeInteraction(postId, 'comment.create', user.actor, {
        id,
        postId,
        actor: user.actor,
        body,
        createdAt,
      });
      return { id, postId, actor: user.actor, authorName: user.displayName, body, createdAt };
    });
  }
  ownComments(
    userId: string,
    options: { before?: number; beforeId?: string; limit?: number } = {},
  ): { id: string; postId: string; body: string; createdAt: number; postAvailable: boolean }[] {
    const user = this.active(userId);
    const before = options.before ?? Number.MAX_SAFE_INTEGER;
    return this.all(
      'SELECT id,post_id,body,created_at FROM comments WHERE actor=? AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?',
      user.actor,
      before,
      before,
      (options.beforeId ?? '').slice(0, 2048),
      Math.max(1, Math.min(options.limit ?? 20, 100)),
    ).map((row) => ({
      id: row.id,
      postId: row.post_id,
      body: row.body,
      createdAt: row.created_at,
      postAvailable: this.canRead(row.post_id, userId),
    }));
  }
  deleteComment(userId: string, commentId: string) {
    const user = this.active(userId);
    const row = this.one(
      'SELECT c.*,p.author_id FROM comments c JOIN publications p ON p.id=c.post_id WHERE c.id=?',
      commentId,
    );
    if (!row || (row.actor !== user.actor && row.author_id !== userId))
      this.fail(404, 'Comment not found.');
    this.store.transaction(() => {
      this.run('DELETE FROM comments WHERE id=?', commentId);
      this.run(
        'INSERT OR IGNORE INTO tombstones(object_id,actor,kind,created_at) VALUES(?,?,?,?)',
        commentId,
        row.actor,
        'comment',
        this.now(),
      );
      this.distributeInteraction(row.post_id, 'comment.delete', user.actor, {
        id: commentId,
        postId: row.post_id,
        actor: row.actor,
      });
    });
  }
  like(userId: string, postId: string, enabled = true) {
    const user = this.active(userId);
    if (!this.canRead(postId, userId)) this.fail(404, 'Post not found.');
    this.rate(`like:${userId}`, 240, 60 * 60_000);
    this.store.transaction(() => {
      const old = this.one(
        'SELECT activity_id FROM likes WHERE post_id=? AND actor=?',
        postId,
        user.actor,
      );
      if ((enabled && old) || (!enabled && !old)) return;
      const id = old?.activity_id ?? `${this.origin}/federation/activities/${randomUUID()}`;
      if (enabled)
        this.run(
          'INSERT INTO likes(post_id,actor,activity_id,created_at) VALUES(?,?,?,?)',
          postId,
          user.actor,
          id,
          this.now(),
        );
      else {
        this.run('DELETE FROM likes WHERE post_id=? AND actor=?', postId, user.actor);
        this.run(
          'INSERT OR IGNORE INTO tombstones(object_id,actor,kind,created_at) VALUES(?,?,?,?)',
          id,
          user.actor,
          'like',
          this.now(),
        );
      }
      this.distributeInteraction(postId, enabled ? 'like.create' : 'like.remove', user.actor, {
        activityId: id,
        postId,
        actor: user.actor,
      });
    });
  }
  private distributeInteraction(
    postId: string,
    kind: string,
    actor: string,
    payload: Record<string, unknown>,
  ) {
    const post = this.one('SELECT * FROM publications WHERE id=?', postId)!;
    const targets = post.author_id ? this.audience(postId) : [post.author_actor];
    for (const target of targets)
      if (target !== actor)
        this.queue(
          kind,
          post.author_id ? post.author_actor : actor,
          target,
          postId,
          post.revision,
          payload,
        );
    if (kind === 'comment.create' || kind === 'like.create')
      this.notifyInteraction(
        postId,
        kind === 'comment.create' ? 'comment' : 'like',
        actor,
        String(payload.id ?? payload.activityId),
      );
  }
  private notify(
    recipient: string,
    kind: Notification['kind'],
    actor: string,
    sourceId: string,
    postId?: string,
  ) {
    const local = this.local(recipient);
    if (!local || recipient === actor || this.blocked(recipient, actor)) return;
    this.run(
      'INSERT OR IGNORE INTO notification_records(id,user_id,kind,actor,post_id,source_id,created_at) VALUES(?,?,?,?,?,?,?)',
      randomUUID(),
      local.id,
      kind,
      actor,
      postId ?? null,
      sourceId,
      this.now(),
    );
  }
  private notifyInteraction(
    postId: string,
    kind: 'comment' | 'like',
    actor: string,
    sourceId: string,
  ) {
    const post = this.one(
      'SELECT author_actor FROM publications WHERE id=? AND deleted_at IS NULL',
      postId,
    );
    if (!post) return;
    for (const target of new Set([post.author_actor, ...this.audience(postId)]))
      if (this.canActorRead(postId, target)) this.notify(target, kind, actor, sourceId, postId);
  }
  notifications(
    userId: string,
    options: { limit?: number; before?: number; beforeId?: string } = {},
  ): Notification[] {
    const user = this.user(userId);
    const limit = Math.max(1, Math.min(options.limit ?? 50, 100));
    const before = options.before ?? Number.MAX_SAFE_INTEGER;
    const rows = this.all(
      "SELECT * FROM notification_records WHERE user_id=? AND (created_at<? OR (created_at=? AND id<?)) AND (?=0 OR kind NOT IN ('post','like')) ORDER BY created_at DESC,id DESC LIMIT 500",
      userId,
      before,
      before,
      (options.beforeId ?? '').slice(0, 2048),
      user.quietNotifications ? 1 : 0,
    );
    return rows
      .filter((row) => {
        if (user.quietNotifications && (row.kind === 'post' || row.kind === 'like')) return false;
        if (this.blocked(user.actor, row.actor)) return false;
        if (row.post_id) {
          if (!this.canRead(row.post_id, userId)) return false;
          if (row.kind === 'comment')
            return !!this.one(
              'SELECT 1 FROM comments WHERE id=? AND actor=? AND post_id=?',
              row.source_id,
              row.actor,
              row.post_id,
            );
          if (row.kind === 'like')
            return !!this.one(
              'SELECT 1 FROM likes WHERE activity_id=? AND actor=? AND post_id=?',
              row.source_id,
              row.actor,
              row.post_id,
            );
          return true;
        }
        const relationship = this.one('SELECT * FROM friendships WHERE id=?', row.source_id);
        if (row.kind === 'friend.failed')
          return relationship?.state === 'expired' && relationship.to_actor === user.actor;
        if (row.kind === 'friend.request')
          return (
            relationship?.state === 'pending' &&
            relationship.to_actor === user.actor &&
            relationship.expires_at > this.now()
          );
        return (
          relationship?.state === 'accepted' &&
          (relationship.from_actor === user.actor || relationship.to_actor === user.actor)
        );
      })
      .slice(0, limit)
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        actor: row.actor,
        actorName: this.local(row.actor)?.displayName ?? row.actor,
        ...(row.post_id ? { postId: row.post_id } : { requestId: row.source_id }),
        createdAt: row.created_at,
        read: row.read_at !== null,
      }));
  }
  markNotificationsRead(userId: string) {
    this.user(userId);
    this.run(
      'UPDATE notification_records SET read_at=? WHERE user_id=? AND read_at IS NULL',
      this.now(),
      userId,
    );
  }
  report(userId: string, targetActor: string, reason: string, postId?: string): string {
    this.active(userId);
    this.validateActor(targetActor);
    this.validateBody(reason, 2000);
    if (!reason.trim()) this.fail(400, 'Explain what happened.');
    this.rate(`report:${userId}`, 10, DAY);
    let evidence = '';
    if (postId) {
      const post = this.post(postId, userId);
      if (post.authorActor !== targetActor)
        this.fail(400, 'The selected post belongs to a different account.');
      evidence = post.body;
    }
    const id = randomUUID();
    this.run(
      'INSERT INTO reports(id,reporter_id,target_actor,post_id,reason,evidence,created_at) VALUES(?,?,?,?,?,?,?)',
      id,
      userId,
      targetActor,
      postId ?? null,
      reason,
      evidence,
      this.now(),
    );
    return id;
  }
  adminReports(adminId: string): Row[] {
    this.admin(adminId);
    return this.all(
      'SELECT id,target_actor AS targetActor,post_id AS postId,reason,evidence,state,created_at AS createdAt FROM reports ORDER BY created_at DESC LIMIT 200',
    );
  }
  resolveReport(adminId: string, reportId: string) {
    this.admin(adminId);
    this.run("UPDATE reports SET state='resolved' WHERE id=?", reportId);
  }
  suspend(adminId: string, userId: string, suspended = true) {
    this.store.transaction(() => {
      this.admin(adminId);
      const target = this.user(userId);
      if (target.admin) this.fail(400, 'Administrator accounts cannot be suspended here.');
      this.run('UPDATE users SET suspended=? WHERE id=?', suspended ? 1 : 0, userId);
      if (suspended) {
        this.logoutAll(userId);
        for (const friend of this.friends(userId)) {
          this.revokePair(target.actor, friend.actor);
          this.queue('friend.remove', target.actor, friend.actor, friend.id, 1, {
            requestId: friend.id,
          });
        }
        this.closePendingRelationships(target);
        this.run(
          'UPDATE invitations SET revoked_at=? WHERE owner_id=? AND consumed_at IS NULL',
          this.now(),
          userId,
        );
      }
    });
  }
  private closePendingRelationships(user: User) {
    for (const request of this.pendingFriends(user.id)) {
      this.run(
        "UPDATE friendships SET state='cancelled',updated_at=? WHERE id=?",
        this.now(),
        request.id,
      );
      this.queue('friend.close', user.actor, request.actor, request.id, 1, {
        requestId: request.id,
      });
    }
  }
  appeal(userId: string, body: string): string {
    const user = this.user(userId);
    if (!user.suspended) this.fail(400, 'This account is not suspended.');
    this.validateBody(body, 4000);
    if (!body.trim()) this.fail(400, 'Write your appeal first.');
    this.rate(`appeal:${userId}`, 3, DAY);
    const id = randomUUID();
    this.run(
      'INSERT INTO appeals(id,user_id,body,created_at) VALUES(?,?,?,?)',
      id,
      userId,
      body,
      this.now(),
    );
    return id;
  }
  appeals(userId: string): Row[] {
    this.user(userId);
    return this.all(
      'SELECT id,body,state,response,created_at AS createdAt FROM appeals WHERE user_id=? ORDER BY created_at DESC',
      userId,
    );
  }
  adminAppeals(adminId: string): Row[] {
    this.admin(adminId);
    return this.all(
      'SELECT id,user_id AS userId,body,state,response,created_at AS createdAt FROM appeals ORDER BY created_at DESC LIMIT 200',
    );
  }
  resolveAppeal(adminId: string, appealId: string, accepted: boolean, response: string) {
    this.validateBody(response, 2000);
    this.store.transaction(() => {
      this.admin(adminId);
      const appeal = this.one('SELECT * FROM appeals WHERE id=?', appealId);
      if (!appeal) this.fail(404, 'Appeal not found.');
      if (appeal.state !== 'open') this.fail(409, 'This appeal has already been resolved.');
      this.run(
        "UPDATE appeals SET state=?,response=?,resolved_at=? WHERE id=? AND state='open'",
        accepted ? 'accepted' : 'declined',
        response,
        this.now(),
        appealId,
      );
      if (accepted) this.run('UPDATE users SET suspended=0 WHERE id=?', appeal.user_id);
    });
  }
  exportAccount(userId: string): Record<string, unknown> {
    const user = this.user(userId);
    return {
      format: 'clean-bookface-account/1',
      exportedAt: new Date(this.now()).toISOString(),
      account: user,
      publications: this.all(
        'SELECT id,body,media_ids AS mediaIds,audience,created_at AS createdAt,updated_at AS updatedAt FROM publications WHERE author_id=? AND deleted_at IS NULL',
        userId,
      ).map((p) => ({ ...p, mediaIds: JSON.parse(p.mediaIds) })),
      comments: this.all(
        'SELECT id,post_id AS postId,body,created_at AS createdAt FROM comments WHERE actor=?',
        user.actor,
      ),
      friendships: this.friends(userId),
      settings: { blockedActors: this.blockedActors(userId) },
    };
  }
  deleteAccount(userId: string): { userId: string; removedMediaIds: string[] } {
    const user = this.user(userId);
    if (user.admin)
      this.fail(
        400,
        'The circle administrator must transfer administration or remove the installation.',
      );
    return this.store.transaction(() => {
      const posts = this.all(
        'SELECT * FROM publications WHERE author_id=? AND deleted_at IS NULL',
        userId,
      );
      const removedMediaIds = posts.flatMap((p) => JSON.parse(p.media_ids));
      for (const post of posts) this.removePost(post);
      for (const c of this.all('SELECT id,post_id FROM comments WHERE actor=?', user.actor)) {
        this.distributeInteraction(c.post_id, 'comment.delete', user.actor, {
          id: c.id,
          postId: c.post_id,
          actor: user.actor,
        });
        this.run(
          'INSERT OR IGNORE INTO tombstones(object_id,actor,kind,created_at) VALUES(?,?,?,?)',
          c.id,
          user.actor,
          'comment',
          this.now(),
        );
      }
      for (const like of this.all(
        'SELECT post_id,activity_id FROM likes WHERE actor=?',
        user.actor,
      )) {
        this.distributeInteraction(like.post_id, 'like.remove', user.actor, {
          activityId: like.activity_id,
          postId: like.post_id,
          actor: user.actor,
        });
        this.run(
          'INSERT OR IGNORE INTO tombstones(object_id,actor,kind,created_at) VALUES(?,?,?,?)',
          like.activity_id,
          user.actor,
          'like',
          this.now(),
        );
      }
      for (const friend of this.friends(userId)) {
        this.revokePair(user.actor, friend.actor);
        this.queue('friend.remove', user.actor, friend.actor, friend.id, 1, {
          requestId: friend.id,
        });
      }
      this.run(
        "UPDATE domain_events SET payload='{}',cancelled_at=? WHERE kind IN ('post.create','post.update','comment.create','like.create') AND (actor=? OR json_extract(payload,'$.actor')=?)",
        this.now(),
        user.actor,
        user.actor,
      );
      this.run('DELETE FROM comments WHERE actor=?', user.actor);
      this.run('DELETE FROM likes WHERE actor=?', user.actor);
      this.run('DELETE FROM recovery_codes WHERE user_id=?', userId);
      this.run('DELETE FROM sessions WHERE user_id=?', userId);
      this.run('DELETE FROM invitations WHERE owner_id=?', userId);
      this.run('DELETE FROM friend_preferences WHERE owner_id=?', userId);
      this.run('DELETE FROM appeals WHERE user_id=?', userId);
      this.run('DELETE FROM notification_records WHERE user_id=? OR actor=?', userId, user.actor);
      this.closePendingRelationships(user);
      this.run(
        "UPDATE friendships SET state='cancelled',updated_at=? WHERE state='pending' AND (from_actor=? OR to_actor=?)",
        this.now(),
        user.actor,
        user.actor,
      );
      this.run(
        "UPDATE reports SET reason='',evidence='',state='deleted' WHERE reporter_id=? OR target_actor=?",
        userId,
        user.actor,
      );
      this.run(
        "UPDATE users SET deleted=1,display_name='Deleted account',bio='',password_hash='',discoverable=0 WHERE id=?",
        userId,
      );
      this.run('INSERT INTO account_deletions(user_id,created_at) VALUES(?,?)', userId, this.now());
      return { userId, removedMediaIds };
    });
  }
  transferAdministration(adminId: string, recipientId: string) {
    this.store.transaction(() => {
      this.admin(adminId);
      this.active(recipientId);
      if (recipientId === adminId) this.fail(400, 'Choose another account.');
      this.run('UPDATE users SET admin=1 WHERE id=?', recipientId);
      this.run('UPDATE users SET admin=0 WHERE id=?', adminId);
    });
  }
  pendingAccountDeletions(): string[] {
    return this.all(
      'SELECT user_id FROM account_deletions WHERE archive_completed_at IS NULL ORDER BY created_at LIMIT 100',
    ).map((row) => row.user_id);
  }
  completeAccountDeletion(userId: string) {
    this.run(
      'UPDATE account_deletions SET archive_completed_at=? WHERE user_id=?',
      this.now(),
      userId,
    );
  }
  private queue(
    kind: string,
    actor: string,
    recipient: string,
    objectId: string,
    revision: number,
    payload: Record<string, unknown>,
  ) {
    if (this.local(recipient)) return;
    const eventId = randomUUID();
    this.run(
      'INSERT INTO domain_events(id,kind,actor,recipient_actor,object_id,revision,payload,created_at) VALUES(?,?,?,?,?,?,?,?)',
      eventId,
      kind,
      actor,
      recipient,
      objectId,
      revision,
      JSON.stringify(payload),
      this.now(),
    );
    this.run('INSERT INTO domain_admission(event_id) VALUES(?)', eventId);
  }
  private queuePost(kind: string, postId: string, actor: string) {
    const post = this.one('SELECT * FROM publications WHERE id=?', postId)!;
    this.queue(kind, post.author_actor, actor, post.id, post.revision, {
      id: post.id,
      authorActor: post.author_actor,
      body: post.body,
      mediaIds: JSON.parse(post.media_ids),
      createdAt: post.created_at,
      updatedAt: post.updated_at,
      revision: post.revision,
    });
  }
  private event(row: Row): DomainEvent {
    return {
      id: row.id,
      kind: row.kind,
      actor: row.actor,
      recipientActor: row.recipient_actor,
      objectId: row.object_id,
      revision: row.revision,
      payload: JSON.parse(row.payload),
      createdAt: row.created_at,
    };
  }
  /** Prioritize recent admission independently of stuck retries. The legacy round-robin
   * scan still advances older events, so continuous new arrivals cannot forget them.
   * Consumed only in the transport admission transaction. */
  takeNewEvents(limit = 100): DomainEvent[] {
    const rows = this.all(
      'SELECT event_id FROM domain_admission ORDER BY sequence DESC LIMIT ?',
      Math.max(1, Math.min(limit, 100)),
    );
    const events: DomainEvent[] = [];
    for (const row of rows) {
      const event = this.outboundEvent(row.event_id);
      if (event) events.push(event);
      this.run('DELETE FROM domain_admission WHERE event_id=?', row.event_id);
    }
    return events;
  }
  rejectAcceptance(id: string) {
    const event = this.one(
      "SELECT * FROM domain_events WHERE id=? AND kind='friend.accept' AND acknowledged_at IS NULL",
      id,
    );
    if (!event) return;
    const request = this.one(
      "SELECT * FROM friendships WHERE id=? AND state='accepted' AND from_actor=? AND to_actor=?",
      event.object_id,
      event.recipient_actor,
      event.actor,
    );
    if (!request) return;
    this.revokePair(request.from_actor, request.to_actor);
    this.run(
      "UPDATE friendships SET state='expired',updated_at=? WHERE id=?",
      this.now(),
      request.id,
    );
    this.notify(event.actor, 'friend.failed', event.recipient_actor, request.id);
  }
  pendingEvents(limit = 100, afterId = ''): DomainEvent[] {
    return this.all(
      'SELECT * FROM domain_events WHERE acknowledged_at IS NULL AND cancelled_at IS NULL AND id>? ORDER BY id LIMIT ?',
      afterId,
      Math.max(1, Math.min(limit, 500)),
    ).map((row) => this.event(row));
  }
  outboundEvent(id: string): DomainEvent | null {
    const row = this.one(
      'SELECT * FROM domain_events WHERE id=? AND acknowledged_at IS NULL AND cancelled_at IS NULL',
      id,
    );
    if (!row) return null;
    const cancel = () => {
      this.run("UPDATE domain_events SET cancelled_at=?,payload='{}' WHERE id=?", this.now(), id);
      return null;
    };
    if (['post.create', 'post.update', 'comment.create', 'like.create'].includes(row.kind)) {
      const post = this.one(
        'SELECT * FROM publications WHERE id=? AND deleted_at IS NULL',
        row.object_id,
      );
      const allowed = post?.author_id
        ? this.canActorRead(row.object_id, row.recipient_actor)
        : post && this.canActorRead(row.object_id, row.actor);
      if (
        !post ||
        !allowed ||
        (['post.create', 'post.update'].includes(row.kind) && post.revision !== row.revision)
      )
        return cancel();
      if (
        row.kind === 'comment.create' &&
        !this.one('SELECT 1 FROM comments WHERE id=?', JSON.parse(row.payload).id)
      )
        return cancel();
    }
    if (row.kind === 'friend.request' || row.kind === 'friend.accept') {
      const friendship = this.one('SELECT * FROM friendships WHERE id=?', row.object_id);
      if (
        !friendship ||
        this.blocked(row.actor, row.recipient_actor) ||
        (row.kind === 'friend.request'
          ? friendship.state !== 'pending' || friendship.expires_at <= this.now()
          : friendship.state !== 'accepted')
      )
        return cancel();
    }
    return this.event(row);
  }
  ackEvent(id: string) {
    this.run("UPDATE domain_events SET acknowledged_at=?,payload='{}' WHERE id=?", this.now(), id);
  }
  objectUrl(id: string): string {
    return /^https?:\/\//.test(id) ? id : `${this.origin}/federation/objects/${id}`;
  }
  private postId(url: string): string {
    const prefix = `${this.origin}/federation/objects/`;
    return url.startsWith(prefix) ? url.slice(prefix.length) : url;
  }
  private requestId(url: string): string {
    const prefix = `${this.origin}/federation/activities/`;
    return url.startsWith(prefix) ? url.slice(prefix.length) : url;
  }
  private absolute(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.length > 2048) this.fail(400, `Invalid ${label}.`);
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return this.fail(400, `Invalid ${label}.`);
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      url.href !== value
    )
      this.fail(400, `Invalid ${label}.`);
    return value;
  }
  private ownsRemoteId(actor: string, objectId: string) {
    if (
      new URL(actor).origin !== new URL(objectId).origin ||
      new URL(objectId).origin === this.origin
    )
      this.fail(403, 'The sender does not own this object.');
  }
  /** Minimal bootstrap data only. Display names and biographies remain private. */
  federationObject(objectURL: string, requestingActor: string): Record<string, unknown> | null {
    const id = this.postId(objectURL);
    const row = this.one(
      'SELECT * FROM publications WHERE id=? AND author_id IS NOT NULL AND deleted_at IS NULL',
      id,
    );
    if (!row || !this.canActorRead(id, requestingActor)) return null;
    return {
      id: this.objectUrl(id),
      type: 'Note',
      attributedTo: row.author_actor,
      content: row.body,
      mediaType: 'text/plain',
      published: new Date(row.created_at).toISOString(),
      updated: new Date(row.updated_at).toISOString(),
      'cb:revision': row.revision,
      to: [requestingActor],
      attachment: (JSON.parse(row.media_ids) as string[]).map((mediaId) => ({
        type: 'Image',
        mediaType: 'image/webp',
        url: `${this.origin}/federation/media/${encodeURIComponent(mediaId)}`,
      })),
    };
  }
  sharedMediaAllowed(mediaId: string, requestingActor: string): boolean {
    return this.all(
      'SELECT id FROM publications WHERE deleted_at IS NULL AND author_id IS NOT NULL AND EXISTS(SELECT 1 FROM json_each(media_ids) WHERE value=?)',
      mediaId,
    ).some((row) => this.canActorRead(row.id, requestingActor));
  }
  /** Called only after transport authenticates the actor/key and validates the envelope. */
  receiveActivity(
    recipientUserId: string,
    verifiedActor: string,
    activity: Record<string, any>,
  ): void {
    const removal = ['Delete', 'Remove', 'Block', 'Undo', 'Reject'].includes(activity.type);
    const recipientRow = removal
      ? this.one('SELECT * FROM users WHERE id=?', recipientUserId)
      : undefined;
    const recipient = recipientRow ? this.safeUser(recipientRow) : this.active(recipientUserId);
    this.validateActor(verifiedActor);
    if (this.local(verifiedActor))
      this.fail(403, 'Remote delivery cannot impersonate a local account.');
    const eventId = this.absolute(activity.id, 'activity identifier');
    this.ownsRemoteId(verifiedActor, eventId);
    if (
      activity.actor !== verifiedActor ||
      !Array.isArray(activity.to) ||
      activity.to.length !== 1 ||
      activity.to[0] !== recipient.actor ||
      activity.cc ||
      activity.bcc ||
      activity.bto
    )
      this.fail(403, 'The activity audience does not match this inbox.');
    if (
      this.one(
        'SELECT 1 FROM received_events WHERE id=? AND actor=?',
        `${eventId}#${recipient.id}`,
        verifiedActor,
      )
    )
      return;
    this.rate(`incoming:${recipient.id}:${verifiedActor}`, 1000, 60 * 60_000);
    this.store.transaction(() => {
      const type = activity.type;
      const object = activity.object;
      if (type === 'Follow') {
        if (object !== recipient.actor || this.blocked(recipient.actor, verifiedActor))
          this.fail(403, 'Friendship request refused.');
        this.rate(
          `incoming-follow:${recipient.id}:${new URL(verifiedActor).origin}`,
          100,
          60 * 60_000,
        );
        this.makeRequest(verifiedActor, recipient.actor, eventId, activity['cb:expiresAt']);
      } else if (type === 'Accept' || type === 'Reject') {
        const request = this.requestId(
          this.absolute(typeof object === 'string' ? object : object?.id, 'original request'),
        );
        const row = this.one('SELECT * FROM friendships WHERE id=?', request);
        if (
          !row ||
          row.from_actor !== recipient.actor ||
          row.to_actor !== verifiedActor ||
          (type === 'Accept' && (row.state !== 'pending' || row.expires_at <= this.now())) ||
          this.blocked(recipient.actor, verifiedActor)
        )
          this.fail(403, 'The original friendship request is no longer pending.');
        if (type === 'Reject' && ['pending', 'accepted'].includes(row.state))
          this.revokePair(row.from_actor, row.to_actor);
        this.run(
          'UPDATE friendships SET state=?,updated_at=? WHERE id=?',
          type === 'Accept' ? 'accepted' : 'rejected',
          this.now(),
          request,
        );
        if (type === 'Accept')
          this.notify(recipient.actor, 'friend.accept', verifiedActor, request);
      } else if (type === 'Block' || type === 'RemoveFriend') {
        this.revokePair(recipient.actor, verifiedActor);
      } else if (type === 'Create' || type === 'Update') {
        if (
          !object ||
          typeof object !== 'object' ||
          Array.isArray(object) ||
          object.type !== 'Note' ||
          object.mediaType !== 'text/plain' ||
          !Array.isArray(object.to) ||
          object.to.length !== 1 ||
          object.to[0] !== recipient.actor ||
          object.cc ||
          object.bcc ||
          object.bto
        )
          this.fail(400, 'Unsupported private note.');
        if (object.inReplyTo) this.receiveComment(recipient, verifiedActor, object);
        else this.receivePost(recipient, verifiedActor, object, type === 'Update');
      } else if (type === 'Delete') {
        const objectURL = this.absolute(
          typeof object === 'string' ? object : object?.id,
          'deleted object',
        );
        if (activity['cb:inReplyTo'])
          this.receiveCommentDelete(
            recipient,
            verifiedActor,
            objectURL,
            this.absolute(activity['cb:inReplyTo'], 'parent post'),
            activity['cb:interactionActor'],
          );
        else {
          this.ownsRemoteId(verifiedActor, objectURL);
          const postId = this.postId(objectURL);
          const row = this.one('SELECT * FROM publications WHERE id=?', postId);
          if (row && row.author_actor !== verifiedActor)
            this.fail(403, 'Only the author can delete a post.');
          if (row) this.removePost(row);
          this.run(
            'INSERT OR IGNORE INTO tombstones(object_id,actor,kind,created_at) VALUES(?,?,?,?)',
            postId,
            verifiedActor,
            'post',
            this.now(),
          );
        }
      } else if (type === 'Remove') {
        if (activity['cb:relationship'] === true) {
          if (object !== recipient.actor)
            this.fail(403, 'This relationship removal is not for this recipient.');
          const request = this.requestId(
            this.absolute(activity['cb:relationshipId'], 'original relationship'),
          );
          const row = this.one('SELECT * FROM friendships WHERE id=?', request);
          if (!row) {
            this.ownsRemoteId(verifiedActor, this.absolute(request, 'original relationship'));
            this.run(
              'INSERT OR IGNORE INTO tombstones(object_id,actor,kind,created_at) VALUES(?,?,?,?)',
              request,
              verifiedActor,
              'friend.request',
              this.now(),
            );
          } else {
            if (!(
              (row.from_actor === verifiedActor && row.to_actor === recipient.actor) ||
              (row.to_actor === verifiedActor && row.from_actor === recipient.actor)
            ))
              this.fail(403, 'This relationship cannot be removed.');
            if (['pending', 'accepted'].includes(row.state))
              this.revokePair(recipient.actor, verifiedActor);
          }
          this.run(
            'INSERT INTO received_events(id,actor,created_at) VALUES(?,?,?)',
            `${eventId}#${recipient.id}`,
            verifiedActor,
            this.now(),
          );
          return;
        }
        if (activity.target !== recipient.actor)
          this.fail(403, 'The removal target is not this recipient.');
        const objectURL = this.absolute(
          typeof object === 'string' ? object : object?.id,
          'revoked object',
        );
        this.ownsRemoteId(verifiedActor, objectURL);
        const postId = this.postId(objectURL);
        const row = this.one('SELECT * FROM publications WHERE id=?', postId);
        if (row && row.author_actor !== verifiedActor)
          this.fail(403, 'Only the author can revoke a post.');
        this.run(
          'UPDATE recipients SET revoked_at=? WHERE post_id=? AND actor=?',
          this.now(),
          postId,
          recipient.actor,
        );
        this.run(
          'INSERT OR IGNORE INTO tombstones(object_id,actor,kind,created_at) VALUES(?,?,?,?)',
          postId,
          recipient.actor,
          `grant:${verifiedActor}`,
          this.now(),
        );
        this.purgeRemoteWithoutReaders(postId);
      } else if (type === 'Like') {
        this.receiveLike(recipient, verifiedActor, activity, true);
      } else if (type === 'Undo') {
        if (typeof object === 'string') {
          if (activity['cb:relationship'] === true) {
            const request = this.requestId(this.absolute(object, 'original request'));
            const row = this.one('SELECT * FROM friendships WHERE id=?', request);
            if (!row) {
              this.ownsRemoteId(verifiedActor, this.absolute(request, 'original request'));
              this.run(
                'INSERT OR IGNORE INTO tombstones(object_id,actor,kind,created_at) VALUES(?,?,?,?)',
                request,
                verifiedActor,
                'friend.request',
                this.now(),
              );
            } else {
              if (row.from_actor !== verifiedActor || row.to_actor !== recipient.actor)
                this.fail(403, 'This friendship cannot be undone.');
              if (['pending', 'accepted'].includes(row.state))
                this.revokePair(recipient.actor, verifiedActor);
            }
          } else {
            this.receiveLike(
              recipient,
              verifiedActor,
              {
                id: object,
                actor: activity['cb:interactionActor'] ?? verifiedActor,
                object: activity['cb:inReplyTo'],
              },
              false,
            );
          }
          this.run(
            'INSERT INTO received_events(id,actor,created_at) VALUES(?,?,?)',
            `${eventId}#${recipient.id}`,
            verifiedActor,
            this.now(),
          );
          return;
        }
        if (!object || typeof object !== 'object' || Array.isArray(object))
          this.fail(400, 'Undo must name the exact original activity.');
        if (object.type === 'Follow') {
          const request = this.requestId(this.absolute(object.id, 'original request'));
          const row = this.one('SELECT * FROM friendships WHERE id=?', request);
          if (
            object.actor !== verifiedActor ||
            object.object !== recipient.actor ||
            (row && (row.from_actor !== verifiedActor || row.to_actor !== recipient.actor))
          )
            this.fail(403, 'This friendship cannot be undone.');
          if (!row) {
            this.ownsRemoteId(verifiedActor, this.absolute(request, 'original request'));
            this.run(
              'INSERT OR IGNORE INTO tombstones(object_id,actor,kind,created_at) VALUES(?,?,?,?)',
              request,
              verifiedActor,
              'friend.request',
              this.now(),
            );
          } else if (['pending', 'accepted'].includes(row.state))
            this.revokePair(recipient.actor, verifiedActor);
        } else if (object.type === 'Like') {
          this.receiveLike(recipient, verifiedActor, object, false);
        } else this.fail(400, 'Unsupported undo activity.');
      } else this.fail(400, 'Unsupported private-sharing activity.');
      this.run(
        'INSERT INTO received_events(id,actor,created_at) VALUES(?,?,?)',
        `${eventId}#${recipient.id}`,
        verifiedActor,
        this.now(),
      );
    });
  }
  private receivePost(recipient: User, actor: string, object: Row, update: boolean) {
    const id = this.absolute(object.id, 'post identifier');
    this.ownsRemoteId(actor, id);
    if (object.attributedTo !== actor || !this.areFriends(recipient.actor, actor))
      this.fail(403, 'This post is not from an accepted friend.');
    this.validateBody(object.content);
    const revision = object['cb:revision'];
    if (!Number.isSafeInteger(revision) || revision < 1) this.fail(400, 'Invalid post revision.');
    if (
      this.one(
        "SELECT 1 FROM tombstones WHERE object_id=? AND ((actor=? AND kind='post') OR (actor=? AND kind=?))",
        id,
        actor,
        recipient.actor,
        `grant:${actor}`,
      )
    )
      this.fail(410, 'This post or its grant has been removed.');
    const old = this.one('SELECT * FROM publications WHERE id=?', id);
    if (old && old.author_actor !== actor) this.fail(403, 'Post author cannot change.');
    const grant = this.one(
      'SELECT * FROM recipients WHERE post_id=? AND actor=?',
      id,
      recipient.actor,
    );
    if (update && (!old || !grant || grant.revoked_at !== null))
      this.fail(403, 'An update cannot grant an audience.');
    if (
      typeof object.published !== 'string' ||
      (object.updated !== undefined && typeof object.updated !== 'string')
    )
      this.fail(400, 'Invalid publication date.');
    const createdAt = Date.parse(object.published);
    const updatedAt = Date.parse(object.updated ?? object.published);
    if (
      !Number.isFinite(createdAt) ||
      !Number.isFinite(updatedAt) ||
      createdAt > this.now() + 5 * 60_000 ||
      updatedAt > this.now() + 5 * 60_000
    )
      this.fail(400, 'Invalid publication date.');
    const attachments = object.attachment ?? [];
    if (!Array.isArray(attachments) || attachments.length > 12)
      this.fail(400, 'Invalid attachment list.');
    const media = attachments.map((a: Row) => {
      if (!a || a.type !== 'Image' || a.mediaType !== 'image/webp')
        this.fail(400, 'Unsupported shared photo.');
      const url = this.absolute(a.url, 'shared photo URL');
      if (new URL(url).origin !== new URL(actor).origin)
        this.fail(403, 'Photos must be served by the author’s host.');
      return url;
    });
    if (!old)
      this.run(
        "INSERT INTO publications(id,author_actor,body,media_ids,audience,revision,created_at,updated_at) VALUES(?,?,?,?,'shared',?,?,?)",
        id,
        actor,
        object.content,
        JSON.stringify(media),
        revision,
        createdAt,
        updatedAt,
      );
    else if (
      revision > old.revision ||
      (!update &&
        !grant &&
        revision === old.revision &&
        !old.deleted_at &&
        old.body === '' &&
        old.media_ids === '[]' &&
        !this.audience(id).length)
    )
      this.run(
        'UPDATE publications SET body=?,media_ids=?,revision=?,updated_at=? WHERE id=?',
        object.content,
        JSON.stringify(media),
        revision,
        updatedAt,
        id,
      );
    else if (revision < old.revision) return;
    if (!update)
      this.run('INSERT OR IGNORE INTO recipients(post_id,actor) VALUES(?,?)', id, recipient.actor);
    if (!grant && !update) this.notify(recipient.actor, 'post', actor, id, id);
  }
  private interactionAuthority(
    recipient: User,
    signer: string,
    postId: string,
    author: string,
  ): Row {
    const post = this.one('SELECT * FROM publications WHERE id=? AND deleted_at IS NULL', postId);
    if (!post || !this.canRead(postId, recipient.id)) this.fail(404, 'Post not found.');
    if (post.author_id) {
      if (
        signer !== author ||
        recipient.id !== post.author_id ||
        !this.canActorRead(postId, signer)
      )
        this.fail(403, 'This account cannot interact with that post.');
    } else if (signer !== post.author_actor || author === recipient.actor)
      this.fail(403, 'Only the post’s home server can distribute its conversation.');
    return post;
  }
  private receiveComment(recipient: User, actor: string, object: Row) {
    const objectId = this.absolute(object.id, 'comment identifier');
    const postId = this.postId(this.absolute(object.inReplyTo, 'parent post'));
    const author = this.absolute(object.attributedTo, 'comment author');
    if (new URL(author).origin !== new URL(objectId).origin)
      this.fail(403, 'Comment identity does not belong to its author.');
    const prefix = `${this.origin}/federation/comments/`;
    const id = objectId.startsWith(prefix) ? objectId.slice(prefix.length) : objectId;
    const post = this.interactionAuthority(recipient, actor, postId, author);
    this.validateBody(object.content, 5000);
    if (!object.content.trim()) this.fail(400, 'An empty comment cannot be published.');
    if (
      this.one(
        "SELECT 1 FROM tombstones WHERE object_id=? AND actor=? AND kind='comment'",
        id,
        author,
      )
    )
      this.fail(410, 'This comment was deleted.');
    const old = this.one('SELECT * FROM comments WHERE id=?', id);
    if (new URL(author).origin === this.origin && !old)
      this.fail(403, 'A peer cannot invent comments by local accounts.');
    if (old && (old.post_id !== postId || old.actor !== author || old.body !== object.content))
      this.fail(409, 'Comment identity cannot be reused.');
    if (old) return;
    if (
      typeof object.published !== 'string' ||
      (object.updated !== undefined && typeof object.updated !== 'string')
    )
      this.fail(400, 'Invalid publication date.');
    const createdAt = Date.parse(object.published);
    if (!Number.isFinite(createdAt) || createdAt > this.now() + 5 * 60_000)
      this.fail(400, 'Invalid comment date.');
    this.run(
      'INSERT INTO comments(id,post_id,actor,body,created_at) VALUES(?,?,?,?,?)',
      id,
      postId,
      author,
      object.content,
      createdAt,
    );
    if (post.author_id)
      this.distributeInteraction(postId, 'comment.create', author, {
        id,
        postId,
        actor: author,
        body: object.content,
        createdAt,
      });
    else this.notifyInteraction(postId, 'comment', author, id);
  }
  private receiveCommentDelete(
    recipient: User,
    actor: string,
    id: string,
    parentURL: string,
    interactionActor?: unknown,
  ) {
    const prefix = `${this.origin}/federation/comments/`;
    if (id.startsWith(prefix)) id = id.slice(prefix.length);
    const postId = this.postId(parentURL);
    const post = this.one('SELECT * FROM publications WHERE id=? AND deleted_at IS NULL', postId);
    const comment = this.one('SELECT * FROM comments WHERE id=?', id);
    if (!post || (post.author_id !== recipient.id && !this.canRead(postId, recipient.id)))
      this.fail(404, 'Post not found.');
    const author = comment?.actor ?? this.absolute(interactionActor ?? actor, 'comment author');
    if (
      post.author_id
        ? recipient.id !== post.author_id || actor !== author
        : actor !== post.author_actor
    )
      this.fail(403, 'Comment deletion is not authorized.');
    if (comment && comment.post_id !== postId) this.fail(403, 'Comment is on another post.');
    this.run('DELETE FROM comments WHERE id=?', id);
    this.run(
      'INSERT OR IGNORE INTO tombstones(object_id,actor,kind,created_at) VALUES(?,?,?,?)',
      id,
      author,
      'comment',
      this.now(),
    );
    if (post.author_id)
      this.distributeInteraction(postId, 'comment.delete', author, { id, postId, actor: author });
  }
  private receiveLike(recipient: User, signer: string, object: Row, enabled: boolean) {
    const postId = this.postId(
      this.absolute(
        typeof object.object === 'string' ? object.object : object.object?.id,
        'liked post',
      ),
    );
    const author = this.absolute(object['cb:interactionActor'] ?? object.actor, 'like author');
    const id = this.absolute(object['cb:interactionId'] ?? object.id, 'like identifier');
    if (new URL(author).origin !== new URL(id).origin)
      this.fail(403, 'Like identity does not belong to its author.');
    const parent = this.one('SELECT * FROM publications WHERE id=? AND deleted_at IS NULL', postId);
    const post =
      !enabled && parent?.author_id === recipient.id && signer === author
        ? parent
        : this.interactionAuthority(recipient, signer, postId, author);
    if (
      new URL(author).origin === this.origin &&
      enabled &&
      !this.one(
        'SELECT 1 FROM likes WHERE post_id=? AND actor=? AND activity_id=?',
        postId,
        author,
        id,
      )
    )
      this.fail(403, 'A peer cannot invent likes by local accounts.');
    if (!enabled) {
      const old = this.one(
        'SELECT activity_id FROM likes WHERE post_id=? AND actor=?',
        postId,
        author,
      );
      if (old && old.activity_id !== id) this.fail(403, 'Undo must reference the exact like.');
      this.run(
        'DELETE FROM likes WHERE post_id=? AND actor=? AND activity_id=?',
        postId,
        author,
        id,
      );
      this.run(
        'INSERT OR IGNORE INTO tombstones(object_id,actor,kind,created_at) VALUES(?,?,?,?)',
        id,
        author,
        'like',
        this.now(),
      );
    } else {
      if (
        this.one(
          "SELECT 1 FROM tombstones WHERE object_id=? AND actor=? AND kind='like'",
          id,
          author,
        )
      )
        this.fail(410, 'This like was removed.');
      const existing = this.one(
        'SELECT activity_id FROM likes WHERE post_id=? AND actor=?',
        postId,
        author,
      );
      if (existing) {
        if (existing.activity_id !== id)
          this.fail(409, 'A like already exists with another identity.');
        return;
      }
      this.run(
        'INSERT OR IGNORE INTO likes(post_id,actor,activity_id,created_at) VALUES(?,?,?,?)',
        postId,
        author,
        id,
        this.now(),
      );
    }
    if (post.author_id)
      this.distributeInteraction(postId, enabled ? 'like.create' : 'like.remove', author, {
        activityId: id,
        postId,
        actor: author,
      });
    else if (enabled) this.notifyInteraction(postId, 'like', author, id);
  }
  maintenance() {
    this.run('DELETE FROM sessions WHERE expires_at<=?', this.now());
    this.run('DELETE FROM rate_buckets WHERE started_at<?', this.now() - 2 * DAY);
    this.run(
      "UPDATE friendships SET state='expired',updated_at=? WHERE state='pending' AND expires_at<=?",
      this.now(),
      this.now(),
    );
  }
}
