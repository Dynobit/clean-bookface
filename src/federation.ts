import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { relative, isAbsolute, resolve } from 'node:path';
import { signRequest, verifyRequest } from '@fedify/fedify/sig';
import { CryptographicKey } from '@fedify/fedify/vocab';
import {
  safeFederationNetwork,
  validateRemoteURL,
  MAX_DOCUMENT_BYTES,
  MAX_MEDIA_BYTES,
} from './federation/network.js';
import {
  CONTEXT,
  PROFILE,
  type Activity,
  type FederationAdapter,
  type FederationOptions,
  type FederationStore,
  type LocalActor,
  type DomainEvent,
} from './federation/types.js';
export * from './federation/types.js';
export { safeFederationNetwork, validateRemoteURL, publicAddress } from './federation/network.js';

const AP = 'application/activity+json';
const FIVE_MINUTES = 300_000;
const REMOVALS = new Set(['Delete', 'Remove', 'Block', 'Undo', 'Reject']);
const TYPES = new Set([
  'Follow',
  'Accept',
  'Reject',
  'Create',
  'Update',
  'Delete',
  'Remove',
  'Like',
  'Undo',
  'Block',
]);
const json = (value: unknown, status = 200, type = AP) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': type,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      vary: 'Signature, Signature-Input, Accept',
    },
  });
const fail = (status = 400) =>
  json({ error: status === 404 ? 'Not found' : 'Federation request rejected' }, status);
const record = (v: unknown): v is Activity => !!v && typeof v === 'object' && !Array.isArray(v);
function requiredString(value: unknown, max = 2048): string {
  if (typeof value !== 'string' || !value.length || value.length > max)
    throw new Error('Invalid string');
  return value;
}
function canonicalURL(value: unknown): URL {
  const u = new URL(requiredString(value));
  if (u.username || u.password || u.hash || u.search || u.href !== value)
    throw new Error('Invalid identity URL');
  return u;
}
function fingerprint(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

export class Federation {
  readonly origin: string;
  readonly enabled: boolean;
  private readonly network;
  private readonly now;
  private flushing = false;
  private stopped = false;
  private inflight = 0;
  private keyPromises = new Map<
    string,
    Promise<{ privateKey: CryptoKey; publicKey: CryptoKey; publicPem: string }>
  >();
  constructor(
    private readonly store: FederationStore,
    private readonly adapter: FederationAdapter,
    options: FederationOptions,
  ) {
    this.origin = new URL(options.origin).origin;
    this.enabled = options.enabled;
    if (this.enabled) validateRemoteURL(this.origin);
    this.network = options.network ?? safeFederationNetwork;
    this.now = options.now ?? Date.now;
    store.transaction(() => {
      const schema = store.db
        .prepare("SELECT version FROM schema_versions WHERE component='federation'")
        .get() as { version: number } | undefined;
      if (schema && schema.version > 1)
        throw new Error(
          'Federation schema is newer than this application; restore the matching application release.',
        );
      store.db.exec(`
      CREATE TABLE IF NOT EXISTS federation_keys(actor TEXT PRIMARY KEY, private_jwk TEXT NOT NULL, public_jwk TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS federation_deliveries(event_id TEXT PRIMARY KEY, sender TEXT NOT NULL, recipient TEXT NOT NULL,
        object_id TEXT NOT NULL, kind TEXT NOT NULL, wire_type TEXT, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0,
        lease_until INTEGER NOT NULL DEFAULT 0, last_status INTEGER, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS federation_first_attempt ON federation_deliveries(state,attempts,updated_at DESC,event_id);
      CREATE INDEX IF NOT EXISTS federation_retry_due ON federation_deliveries(state,next_attempt,lease_until,updated_at,event_id);
      CREATE TABLE IF NOT EXISTS federation_received(activity_id TEXT NOT NULL, recipient TEXT NOT NULL, actor TEXT NOT NULL,
        body_hash TEXT NOT NULL, received_at INTEGER NOT NULL, PRIMARY KEY(activity_id,recipient));
      CREATE TABLE IF NOT EXISTS federation_rate(subject TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS federation_blocked_hosts(host TEXT PRIMARY KEY, blocked_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS federation_scan(id INTEGER PRIMARY KEY CHECK(id=1), cursor TEXT NOT NULL);
      INSERT OR IGNORE INTO federation_scan VALUES(1,'');
      INSERT INTO schema_versions(component,version) VALUES('federation',1) ON CONFLICT(component) DO UPDATE SET version=1;
      `);
    });
  }
  setBlockedHost(host: string, blocked = true): void {
    const normalized = host.trim().toLowerCase();
    const url = validateRemoteURL(`https://${normalized}`);
    if (
      url.host !== normalized ||
      url.pathname !== '/' ||
      url.hostname === new URL(this.origin).hostname
    )
      throw new Error('Enter a different, exact peer hostname.');
    if (blocked)
      this.store.db
        .prepare('INSERT OR IGNORE INTO federation_blocked_hosts VALUES(?,?)')
        .run(url.hostname, this.now());
    else
      this.store.db.prepare('DELETE FROM federation_blocked_hosts WHERE host=?').run(url.hostname);
  }
  listBlockedHosts(): { host: string; blockedAt: number }[] {
    return this.store.db
      .prepare('SELECT host,blocked_at AS blockedAt FROM federation_blocked_hosts ORDER BY host')
      .all() as { host: string; blockedAt: number }[];
  }
  isHostBlocked(url: string): boolean {
    return !!this.store.db
      .prepare('SELECT 1 FROM federation_blocked_hosts WHERE host=?')
      .get(new URL(url).hostname);
  }
  private assertAllowedPeer(url: string): void {
    if (this.isHostBlocked(url)) throw new Error('This peer host is blocked.');
  }
  private active(): boolean {
    return this.enabled && (this.adapter.sharingAllowed?.() ?? true);
  }
  private localActor(username: string, allowDeleted = false): LocalActor | null {
    if (!/^[a-z0-9_]{3,32}$/.test(username)) return null;
    const a = this.adapter.localActor(username);
    if (
      !a ||
      ((a.suspended || a.deleted) && !allowDeleted) ||
      a.id !== `${this.origin}/users/${username}`
    )
      return null;
    return a;
  }
  private rate(subject: string, cap: number): boolean {
    const now = this.now();
    return this.store.transaction(() => {
      const row = this.store.db
        .prepare('SELECT window_start,count FROM federation_rate WHERE subject=?')
        .get(subject) as { window_start: number; count: number } | undefined;
      if (!row || row.window_start < now - 60_000) {
        this.store.db
          .prepare(
            'INSERT INTO federation_rate VALUES(?,?,1) ON CONFLICT(subject) DO UPDATE SET window_start=excluded.window_start,count=1',
          )
          .run(subject, now);
        this.store.db
          .prepare('DELETE FROM federation_rate WHERE window_start<?')
          .run(now - 120_000);
        return true;
      }
      if (row.count >= cap) return false;
      this.store.db
        .prepare('UPDATE federation_rate SET count=count+1 WHERE subject=?')
        .run(subject);
      return true;
    });
  }
  private async keys(actor: string) {
    let promise = this.keyPromises.get(actor);
    if (promise) return promise;
    promise = (async () => {
      let row = this.store.db
        .prepare('SELECT private_jwk,public_jwk FROM federation_keys WHERE actor=?')
        .get(actor) as { private_jwk: string; public_jwk: string } | undefined;
      if (!row) {
        const generated = await crypto.subtle.generateKey(
          {
            name: 'RSASSA-PKCS1-v1_5',
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]),
            hash: 'SHA-256',
          },
          true,
          ['sign', 'verify'],
        );
        const privateJwk = await crypto.subtle.exportKey('jwk', generated.privateKey);
        const publicJwk = await crypto.subtle.exportKey('jwk', generated.publicKey);
        this.store.db
          .prepare('INSERT OR IGNORE INTO federation_keys VALUES(?,?,?)')
          .run(actor, JSON.stringify(privateJwk), JSON.stringify(publicJwk));
        row = this.store.db
          .prepare('SELECT private_jwk,public_jwk FROM federation_keys WHERE actor=?')
          .get(actor) as typeof row;
      }
      if (!row) throw new Error('Signing key unavailable');
      const privateJwk = JSON.parse(row.private_jwk) as JsonWebKey;
      const publicJwk = JSON.parse(row.public_jwk) as JsonWebKey;
      return {
        privateKey: await crypto.subtle.importKey(
          'jwk',
          privateJwk,
          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
          true,
          ['sign'],
        ),
        publicKey: await crypto.subtle.importKey(
          'jwk',
          publicJwk,
          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
          true,
          ['verify'],
        ),
        publicPem: createPublicKey(
          createPrivateKey({ key: privateJwk as import('node:crypto').JsonWebKey, format: 'jwk' }),
        )
          .export({ type: 'spki', format: 'pem' })
          .toString(),
      };
    })();
    this.keyPromises.set(actor, promise);
    promise.catch(() => this.keyPromises.delete(actor));
    return promise;
  }
  async actorDocument(username: string): Promise<Activity | null> {
    if (!this.active()) return null;
    const actor = this.localActor(username, true);
    if (!actor) return null;
    const keys = await this.keys(actor.id);
    // Bootstrap data must stay minimal: no real name, biography, roster, counts or avatars.
    return {
      '@context': [...CONTEXT, 'https://w3id.org/security/v1'],
      id: actor.id,
      type: 'Person',
      preferredUsername: actor.username,
      inbox: `${actor.id}/inbox`,
      'cb:profile': PROFILE,
      manuallyApprovesFollowers: true,
      publicKey: { id: `${actor.id}#main-key`, owner: actor.id, publicKeyPem: keys.publicPem },
    };
  }
  private async remoteActor(actorURL: string): Promise<Activity> {
    canonicalURL(actorURL);
    this.assertAllowedPeer(actorURL);
    const response = await this.network(new Request(actorURL, { headers: { accept: AP } }));
    if (
      response.status !== 200 ||
      !/application\/(activity\+json|ld\+json|json)/i.test(
        response.headers.get('content-type') ?? '',
      )
    )
      throw new Error('Actor unavailable');
    this.assertAllowedPeer(actorURL);
    const a: unknown = JSON.parse(Buffer.from(response.body).toString('utf8'));
    if (
      !record(a) ||
      a.id !== actorURL ||
      a.type !== 'Person' ||
      a['cb:profile'] !== PROFILE ||
      a.inbox !== `${actorURL}/inbox` ||
      !record(a.publicKey) ||
      a.publicKey.owner !== actorURL ||
      a.publicKey.id !== `${actorURL}#main-key`
    )
      throw new Error('Incompatible or mismatched actor');
    requiredString(a.publicKey.publicKeyPem, 8192);
    return a;
  }
  async discover(input: string, username: string): Promise<{ id: string; username: string }> {
    if (!this.active() || !this.localActor(username)) throw new Error('Federation unavailable');
    let actorURL = input.trim();
    if (!actorURL.startsWith('https://')) {
      const m = /^@?([a-z0-9_]{3,32})@([^/@:\s]+)$/.exec(actorURL);
      if (!m) throw new Error('Enter a profile link or @name@host');
      const host = validateRemoteURL(`https://${m[2]!}`).host;
      const resource = `acct:${m[1]}@${host}`;
      const endpoint = `https://${host}/.well-known/webfinger?resource=${encodeURIComponent(resource)}`;
      this.assertAllowedPeer(endpoint);
      const response = await this.network(
        new Request(endpoint, { headers: { accept: 'application/jrd+json' } }),
      );
      if (response.status !== 200) throw new Error('Handle is not discoverable');
      const wf = JSON.parse(Buffer.from(response.body).toString('utf8')) as Activity;
      if (wf.subject !== resource || !Array.isArray(wf.links))
        throw new Error('Invalid handle response');
      const links = wf.links.filter(
        (l): l is Activity => record(l) && l.rel === 'self' && l.type === AP,
      );
      if (links.length !== 1) throw new Error('Ambiguous handle');
      actorURL = requiredString(links[0]!.href);
      if (new URL(actorURL).origin !== `https://${host}`)
        throw new Error('Cross-host handle redirection prohibited');
    }
    const actor = await this.remoteActor(actorURL);
    return { id: requiredString(actor.id), username: requiredString(actor.preferredUsername, 32) };
  }
  async sign(username: string, request: Request, removal = false): Promise<Request> {
    if (!this.active()) throw new Error('Federation unavailable');
    const actor = this.localActor(username, removal);
    if (!actor) throw new Error('Actor unavailable');
    return signRequest(
      request,
      (await this.keys(actor.id)).privateKey,
      new URL(`${actor.id}#main-key`),
      { spec: 'rfc9421', rfc9421: { expires: true } },
    );
  }
  async signedFetch(username: string, url: string, maxBytes = MAX_DOCUMENT_BYTES) {
    this.assertAllowedPeer(url);
    const response = await this.network(
      await this.sign(username, new Request(url, { headers: { accept: AP } })),
      Math.min(maxBytes, MAX_MEDIA_BYTES),
    );
    this.assertAllowedPeer(url);
    return response;
  }
  private async authenticate(req: Request): Promise<string> {
    const input = req.headers.get('signature-input') ?? '';
    // This intentionally narrow profile accepts exactly the library's default
    // RFC 9421 covered components and parameter order. No ambiguous signatures.
    const body = req.method !== 'GET' && req.method !== 'HEAD';
    const prefix = `sig1=("@method" "@target-uri" "@authority" "host" "date"${body ? ' "content-digest"' : ''});alg="rsa-v1_5-sha256";keyid="`;
    if (!input.startsWith(prefix)) throw new Error('Required signed components missing');
    const tail = input.slice(prefix.length).match(/^([^"\\]+)";created=(\d+);expires=(\d+)$/);
    if (!tail || !/^sig1=:[A-Za-z0-9+/]+=*:$/.test(req.headers.get('signature') ?? ''))
      throw new Error('Malformed signature');
    const created = Number(tail[2]) * 1000,
      expires = Number(tail[3]) * 1000;
    if (
      !Number.isSafeInteger(created) ||
      Math.abs(this.now() - created) > FIVE_MINUTES ||
      expires < this.now() ||
      expires > created + 3_600_000 ||
      expires <= created
    )
      throw new Error('Expired signature');
    const keyId = new URL(tail[1]!);
    if (keyId.hash !== '#main-key') throw new Error('Unknown key');
    keyId.hash = '';
    const actorId = keyId.href;
    const actor = await this.remoteActor(actorId);
    const pem = (actor.publicKey as Activity).publicKeyPem as string;
    const nodeKey = createPublicKey(pem);
    if (
      nodeKey.asymmetricKeyType !== 'rsa' ||
      (nodeKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    )
      throw new Error('Invalid actor key');
    const spki = nodeKey.export({ format: 'der', type: 'spki' });
    const publicKey = await crypto.subtle.importKey(
      'spki',
      new Uint8Array(spki),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      true,
      ['verify'],
    );
    const key = new CryptographicKey({
      id: new URL(`${actorId}#main-key`),
      owner: new URL(actorId),
      publicKey,
    });
    const denyLoader = async () => {
      throw new Error('Remote contexts and additional key lookups prohibited');
    };
    const verified = await verifyRequest(req, {
      spec: 'rfc9421',
      timeWindow: { minutes: 5 },
      maxSignatures: 1,
      keyCache: {
        get: async (id) => (id.href === `${actorId}#main-key` ? key : null),
        set: async () => {},
      },
      documentLoader: denyLoader,
      contextLoader: denyLoader,
    });
    if (
      !verified ||
      verified.id?.href !== `${actorId}#main-key` ||
      verified.ownerId?.href !== actorId
    )
      throw new Error('Invalid signature');
    this.assertAllowedPeer(actorId);
    if (!this.rate(`key:${fingerprint(actorId)}`, 120)) throw new Error('Too many requests');
    return actorId;
  }
  private validateActivity(a: unknown, actor: string, recipient: string): asserts a is Activity {
    if (
      !record(a) ||
      !TYPES.has(String(a.type)) ||
      a.actor !== actor ||
      !Array.isArray(a.to) ||
      a.to.length !== 1 ||
      a.to[0] !== recipient ||
      a['cb:profile'] !== PROFILE
    )
      throw new Error('Invalid private envelope');
    if ('cc' in a || 'bcc' in a || 'bto' in a || 'audience' in a)
      throw new Error('Audience expansion prohibited');
    const id = canonicalURL(a.id);
    if (id.origin !== new URL(actor).origin) throw new Error('Activity ownership mismatch');
    if (!Number.isSafeInteger(a['cb:revision']) || Number(a['cb:revision']) < 1)
      throw new Error('Missing revision');
    if (JSON.stringify(a['@context']) !== JSON.stringify(CONTEXT))
      throw new Error('Unsupported context');
    if (
      a.type === 'Follow' &&
      a['cb:expiresAt'] !== undefined &&
      (!Number.isSafeInteger(a['cb:expiresAt']) || Number(a['cb:expiresAt']) < 1)
    )
      throw new Error('Invalid friendship expiry');
    if (a['cb:interactionId'] !== undefined) canonicalURL(a['cb:interactionId']);
    if (a['cb:interactionActor'] !== undefined) canonicalURL(a['cb:interactionActor']);
    if (['Create', 'Update'].includes(String(a.type))) {
      const o = a.object;
      if (
        !record(o) ||
        o.type !== 'Note' ||
        (o.attributedTo !== actor && !o.inReplyTo) ||
        o.mediaType !== 'text/plain' ||
        typeof o.content !== 'string' ||
        o.content.length > 20_000 ||
        !Array.isArray(o.to) ||
        o.to.length !== 1 ||
        o.to[0] !== recipient ||
        'cc' in o ||
        'bcc' in o ||
        'bto' in o ||
        'audience' in o
      )
        throw new Error('Invalid private object');
      canonicalURL(o.id);
      if (!o.inReplyTo && canonicalURL(o.id).origin !== new URL(actor).origin)
        throw new Error('Object ownership mismatch');
      if (o.inReplyTo !== undefined) canonicalURL(o.inReplyTo);
      if (o.attachment !== undefined) {
        if (!Array.isArray(o.attachment) || o.attachment.length > 12)
          throw new Error('Too many attachments');
        for (const media of o.attachment) {
          if (
            !record(media) ||
            media.type !== 'Image' ||
            !['image/jpeg', 'image/png', 'image/webp'].includes(String(media.mediaType)) ||
            canonicalURL(media.url).origin !== new URL(actor).origin ||
            !new URL(String(media.url)).pathname.startsWith('/federation/media/')
          )
            throw new Error('Invalid attachment');
        }
      }
    } else {
      const object = record(a.object) ? a.object.id : a.object;
      canonicalURL(object);
    }
  }
  async handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const actorMatch = /^\/users\/([a-z0-9_]{3,32})(\/inbox)?$/.exec(url.pathname);
    const objectMatch =
      /^\/federation\/objects\/[^/]+$/.test(url.pathname) ||
      (/^\/posts\/[^/]+$/.test(url.pathname) && (request.headers.get('accept') ?? '').includes(AP));
    const mediaMatch = /^\/federation\/media\/([^/]+)$/.exec(url.pathname);
    const webfinger = url.pathname === '/.well-known/webfinger';
    if (!actorMatch && !objectMatch && !mediaMatch && !webfinger) return null;
    if (!this.active() || url.origin !== this.origin) return fail(404);
    if (this.inflight >= 8 || !this.rate('global', 240)) return fail(429);
    this.inflight++;
    try {
      if (webfinger) {
        if (request.method !== 'GET') return fail(405);
        const resource = url.searchParams.get('resource') ?? '';
        const m = new RegExp(
          `^acct:([a-z0-9_]{3,32})@${url.host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
        ).exec(resource);
        const a = m ? this.localActor(m[1]!) : null;
        if (!a?.discoverable) return fail(404);
        return json(
          { subject: resource, links: [{ rel: 'self', type: AP, href: a.id }] },
          200,
          'application/jrd+json',
        );
      }
      if (url.search) return fail(400);
      if (actorMatch && !actorMatch[2]) {
        if (request.method !== 'GET') return fail(405);
        const doc = await this.actorDocument(actorMatch[1]!);
        return doc ? json(doc) : fail(404);
      }
      if (actorMatch?.[2]) {
        if (request.method !== 'POST') return fail(405);
        const local = this.localActor(actorMatch[1]!, true);
        if (!local) return fail(404);
        if (
          !(request.headers.get('content-type') ?? '').startsWith(AP) ||
          request.headers.has('content-encoding')
        )
          return fail(415);
        // Reject known blocked key origins before spending time on a streaming body.
        // This is only an early deny; authenticate still verifies the complete signature.
        const claimedKey = /;keyid="([^"\\]+)"/.exec(request.headers.get('signature-input') ?? '');
        if (claimedKey) this.assertAllowedPeer(claimedKey[1]!);
        const declared = Number(request.headers.get('content-length') ?? '0');
        if (declared > MAX_DOCUMENT_BYTES) return fail(413);
        const reader = request.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (!reader) return fail(400);
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          const timeout = new Promise<never>((_, reject) => {
            deadline = setTimeout(() => {
              void reader.cancel();
              reject(new Error('Inbox body timeout'));
            }, 10_000);
            deadline.unref();
          });
          for (;;) {
            const { done, value } = await Promise.race([reader.read(), timeout]);
            if (done) break;
            size += value.length;
            if (size > MAX_DOCUMENT_BYTES) {
              await reader.cancel();
              return fail(413);
            }
            chunks.push(value);
          }
        } finally {
          if (deadline) clearTimeout(deadline);
          reader.releaseLock();
        }
        const bytes = Buffer.concat(chunks);
        // Bind the exact buffered bytes independently of signature-library behavior.
        const digest = createHash('sha256').update(bytes).digest('base64');
        if (request.headers.get('content-digest') !== `sha-256=:${digest}:`)
          throw new Error('Invalid content digest');
        const verifiedRequest = new Request(request.url, {
          method: 'POST',
          headers: request.headers,
          body: bytes,
        });
        const actor = await this.authenticate(verifiedRequest);
        const text = bytes.toString('utf8');
        const activity: unknown = JSON.parse(text);
        this.validateActivity(activity, actor, local.id);
        const hash = fingerprint(text);
        this.store.transaction(() => {
          const current = this.localActor(actorMatch[1]!, REMOVALS.has(String(activity.type)));
          if (
            !this.active() ||
            !current ||
            current.id !== local.id ||
            current.userId !== local.userId
          )
            throw new Error('Recipient unavailable');
          const seen = this.store.db
            .prepare(
              'SELECT actor,body_hash FROM federation_received WHERE activity_id=? AND recipient=?',
            )
            .get(String(activity.id), local.id) as { actor: string; body_hash: string } | undefined;
          if (seen) {
            if (seen.actor !== actor || seen.body_hash !== hash)
              throw new Error('Activity identifier reused');
            return;
          }
          this.adapter.receiveActivity(local.userId, actor, activity);
          this.store.db
            .prepare('INSERT INTO federation_received VALUES(?,?,?,?,?)')
            .run(String(activity.id), local.id, actor, hash, this.now());
        });
        return json({ accepted: true }, 202);
      }
      if (request.method !== 'GET') return fail(405);
      const actor = await this.authenticate(request);
      if (objectMatch) {
        const object = this.adapter.federationObject(url.href, actor);
        return object ? json(object) : fail(404);
      }
      if (mediaMatch) {
        const media = this.adapter.federationMedia(decodeURIComponent(mediaMatch[1]!), actor);
        if (!media || !['image/jpeg', 'image/png', 'image/webp'].includes(media.mime))
          return fail(404);
        const rel = relative(resolve(this.store.dataDir), resolve(media.path));
        if (rel.startsWith('..') || isAbsolute(rel)) return fail(404);
        if ((await stat(media.path)).size > MAX_MEDIA_BYTES) return fail(413);
        const data = await readFile(media.path);
        if (
          !this.active() ||
          !this.adapter.federationMedia(decodeURIComponent(mediaMatch[1]!), actor)
        )
          return fail(404);
        return new Response(data, {
          headers: {
            'content-type': media.mime,
            'cache-control': 'private, no-store',
            'x-content-type-options': 'nosniff',
            vary: 'Signature, Signature-Input',
            'content-disposition': 'inline',
          },
        });
      }
      return fail(404);
    } catch {
      return fail(403);
    } finally {
      this.inflight--;
    }
  }
  private envelope(event: DomainEvent): Activity {
    const p =
      typeof event.payload === 'string' ? (JSON.parse(event.payload) as Activity) : event.payload;
    const objectURL = (id: unknown) =>
      String(id).startsWith('https://') ? String(id) : `${this.origin}/federation/objects/${id}`;
    const activityURL = (id: unknown) =>
      String(id).startsWith('https://') ? String(id) : `${this.origin}/federation/activities/${id}`;
    const commentURL = (id: unknown) =>
      String(id).startsWith('https://') ? String(id) : `${this.origin}/federation/comments/${id}`;
    const a: Activity = {
      '@context': CONTEXT,
      'cb:profile': PROFILE,
      'cb:revision': event.revision,
      id: activityURL(event.id),
      actor: event.actor,
      to: [event.recipientActor],
    };
    switch (event.kind) {
      case 'friend.request':
        Object.assign(a, {
          type: 'Follow',
          id: activityURL(p.requestId),
          object: event.recipientActor,
          ...(p.expiresAt === undefined ? {} : { 'cb:expiresAt': p.expiresAt }),
        });
        break;
      case 'friend.accept':
        Object.assign(a, { type: 'Accept', object: activityURL(p.requestId) });
        break;
      case 'friend.close':
        Object.assign(a, {
          type: String(p.requestId).startsWith('https://') ? 'Reject' : 'Undo',
          object: activityURL(p.requestId),
          'cb:relationship': true,
        });
        break;
      case 'friend.remove':
        Object.assign(a, {
          type: 'Remove',
          object: event.recipientActor,
          'cb:relationship': true,
          'cb:relationshipId': activityURL(requiredString(p.requestId)),
        });
        break;
      case 'post.create':
      case 'post.update': {
        const delivery = this.store.db
          .prepare('SELECT wire_type FROM federation_deliveries WHERE event_id=?')
          .get(event.id) as { wire_type: string | null } | undefined;
        const granted = this.store.db
          .prepare(
            "SELECT 1 FROM federation_deliveries WHERE object_id=? AND recipient=? AND state='delivered' AND kind IN ('post.create','post.update')",
          )
          .get(event.objectId, event.recipientActor);
        const wireType =
          delivery?.wire_type ?? (event.kind === 'post.create' || !granted ? 'Create' : 'Update');
        this.store.db
          .prepare(
            'UPDATE federation_deliveries SET wire_type=? WHERE event_id=? AND wire_type IS NULL',
          )
          .run(wireType, event.id);
        Object.assign(a, {
          type: wireType,
          object: {
            id: objectURL(p.id),
            type: 'Note',
            attributedTo: event.actor,
            mediaType: 'text/plain',
            content: p.body,
            published: new Date(Number(p.createdAt)).toISOString(),
            updated: new Date(Number(p.updatedAt)).toISOString(),
            'cb:revision': event.revision,
            to: [event.recipientActor],
            attachment: (Array.isArray(p.mediaIds) ? p.mediaIds : []).map((id) => ({
              type: 'Image',
              mediaType: 'image/webp',
              url: `${this.origin}/federation/media/${encodeURIComponent(String(id))}`,
            })),
          },
        });
        break;
      }
      case 'post.delete':
      case 'post.revoke':
        Object.assign(a, {
          type: event.kind === 'post.delete' ? 'Delete' : 'Remove',
          object: objectURL(p.postId),
          ...(event.kind === 'post.revoke' ? { target: event.recipientActor } : {}),
        });
        break;
      case 'comment.create':
        Object.assign(a, {
          type: 'Create',
          object: {
            id: commentURL(p.id),
            type: 'Note',
            attributedTo: p.actor,
            mediaType: 'text/plain',
            content: p.body,
            published: new Date(Number(p.createdAt)).toISOString(),
            inReplyTo: objectURL(p.postId),
            to: [event.recipientActor],
          },
        });
        break;
      case 'comment.delete':
        Object.assign(a, {
          type: 'Delete',
          object: commentURL(p.id),
          'cb:inReplyTo': objectURL(p.postId),
          'cb:interactionActor': p.actor,
        });
        break;
      case 'like.create':
        Object.assign(a, {
          type: 'Like',
          object: objectURL(p.postId),
          'cb:interactionActor': p.actor,
          'cb:interactionId': p.activityId ?? activityURL(event.id),
        });
        break;
      case 'like.remove':
        Object.assign(a, {
          type: 'Undo',
          object: requiredString(p.activityId),
          'cb:inReplyTo': objectURL(p.postId),
          'cb:interactionActor': p.actor,
        });
        break;
      default:
        throw new Error('Unsupported domain event');
    }
    this.validateActivity(a, event.actor, event.recipientActor);
    return a;
  }
  /** At-least-once durable delivery. A lost acknowledgement repeats the exact
   * activity; receiver dedupe and domain tombstones make this safe. */
  async flush(limit = 20): Promise<{ delivered: number; pending: number }> {
    if (this.stopped || !this.active() || this.flushing) return { delivered: 0, pending: 0 };
    limit = Math.min(Math.max(Math.floor(limit) || 20, 1), 100);
    this.flushing = true;
    let delivered = 0;
    try {
      const now = this.now();
      this.store.transaction(() => {
        const cursor = (
          this.store.db.prepare('SELECT cursor FROM federation_scan WHERE id=1').get() as {
            cursor: string;
          }
        ).cursor;
        let events = this.adapter.pendingEvents(100, cursor);
        if (events.length < 100 && cursor) {
          const wrapped = this.adapter
            .pendingEvents(100 - events.length, '')
            .filter((e) => e.id <= cursor);
          events = [...events, ...wrapped];
        }
        const fresh = this.adapter.takeNewEvents?.(100) ?? [];
        for (const e of [...fresh, ...events]) {
          this.store.db
            .prepare(
              'INSERT OR IGNORE INTO federation_deliveries(event_id,sender,recipient,object_id,kind,updated_at) VALUES(?,?,?,?,?,?)',
            )
            .run(e.id, e.actor, e.recipientActor, e.objectId, e.kind, now);
        }
        this.store.db
          .prepare('UPDATE federation_scan SET cursor=? WHERE id=1')
          .run(events.length ? events[events.length - 1]!.id : '');
      });
      type DueDelivery = { event_id: string; attempts: number };
      // Reserve at most half the bounded send budget for recent first attempts.
      // Run them before slow old peers, while keeping the remaining oldest-due
      // slots for retries/older admission. Mandatory removals stay durable.
      const first = this.store.db
        .prepare(
          "SELECT event_id,attempts FROM federation_deliveries WHERE state='pending' AND attempts=0 AND next_attempt<=? AND lease_until<=? ORDER BY updated_at DESC,event_id LIMIT ?",
        )
        .all(now, now, Math.ceil(limit / 2)) as DueDelivery[];
      const oldest = this.store.db
        .prepare(
          "SELECT event_id,attempts FROM federation_deliveries WHERE state='pending' AND next_attempt<=? AND lease_until<=? ORDER BY updated_at,event_id LIMIT ?",
        )
        .all(now, now, limit) as DueDelivery[];
      const selected = new Map(first.map((row) => [row.event_id, row]));
      for (const row of oldest) if (selected.size < limit) selected.set(row.event_id, row);
      const rows = [...selected.values()];
      for (const row of rows) {
        if (this.stopped) break;
        // Acquire in a transaction. Expired leases recover after a process dies.
        const leased = this.store.db
          .prepare(
            "UPDATE federation_deliveries SET lease_until=?,updated_at=? WHERE event_id=? AND state='pending' AND lease_until<=?",
          )
          .run(this.now() + 30_000, this.now(), row.event_id, this.now());
        if (!leased.changes) continue;
        const event = this.adapter.outboundEvent(row.event_id);
        if (!event) {
          this.store.transaction(() => {
            this.store.db
              .prepare(
                "UPDATE federation_deliveries SET state='cancelled',lease_until=0 WHERE event_id=?",
              )
              .run(row.event_id);
            this.adapter.ackEvent(row.event_id);
          });
          continue;
        }
        let status = 0;
        try {
          const username = new URL(event.actor).pathname.split('/').at(-1)!;
          const initialEnvelope = this.envelope(event);
          if (!this.localActor(username, REMOVALS.has(String(initialEnvelope.type))))
            throw new Error('Actor unavailable');
          const actor = await this.remoteActor(event.recipientActor);
          if (this.stopped) {
            this.store.db
              .prepare('UPDATE federation_deliveries SET lease_until=0 WHERE event_id=?')
              .run(row.event_id);
            break;
          }
          // Recheck after discovery/signing awaits: a revoke can happen while a peer is slow.
          const latest = this.adapter.outboundEvent(row.event_id);
          if (!latest) throw new Error('Audience revoked');
          const body = JSON.stringify(this.envelope(latest));
          const signed = await this.sign(
            username,
            new Request(String(actor.inbox), {
              method: 'POST',
              headers: { 'content-type': AP, accept: AP },
              body,
            }),
            REMOVALS.has(String(this.envelope(latest).type)),
          );
          if (this.stopped) {
            this.store.db
              .prepare('UPDATE federation_deliveries SET lease_until=0 WHERE event_id=?')
              .run(row.event_id);
            break;
          }
          if (!this.adapter.outboundEvent(row.event_id)) throw new Error('Audience revoked');
          this.assertAllowedPeer(signed.url);
          const result = await this.network(signed);
          status = result.status;
          if (status < 200 || status >= 300) throw new Error('Peer did not accept delivery');
          this.store.transaction(() => {
            this.store.db
              .prepare(
                "UPDATE federation_deliveries SET state='delivered',lease_until=0,last_status=?,attempts=attempts+1,updated_at=? WHERE event_id=?",
              )
              .run(status, this.now(), row.event_id);
            this.adapter.ackEvent(row.event_id);
          });
          delivered++;
        } catch {
          if (
            event.kind === 'friend.accept' &&
            [403, 410].includes(status) &&
            this.adapter.rejectAcceptance
          ) {
            this.store.transaction(() => {
              this.adapter.rejectAcceptance!(event.id);
              this.store.db
                .prepare(
                  "UPDATE federation_deliveries SET state='failed',lease_until=0,last_status=?,attempts=attempts+1,updated_at=? WHERE event_id=?",
                )
                .run(status, this.now(), event.id);
              this.adapter.ackEvent(event.id);
            });
            continue;
          }
          const attempts = row.attempts + 1;
          // Never discard removals or content merely because the peer is offline.
          // The ledger exposes the pending state to the operator and survives restarts.
          const delay = Math.min(6 * 3_600_000, 5_000 * 2 ** Math.min(attempts - 1, 12));
          this.store.db
            .prepare(
              'UPDATE federation_deliveries SET lease_until=0,attempts=?,last_status=?,next_attempt=?,updated_at=? WHERE event_id=?',
            )
            .run(attempts, status, this.now() + delay, this.now(), row.event_id);
        }
      }
      const count = this.store.db
        .prepare("SELECT count(*) AS n FROM federation_deliveries WHERE state='pending'")
        .get() as { n: number };
      return { delivered, pending: count.n };
    } finally {
      this.flushing = false;
    }
  }
  /** Stop claiming or sending deliveries. Await the current flush before closing
   * SQLite; an in-flight request finishes and every unsent job stays durable. */
  stop(): void {
    this.stopped = true;
  }
  deliveryStatus() {
    return this.store.db
      .prepare('SELECT state,count(*) AS count FROM federation_deliveries GROUP BY state')
      .all();
  }
}
