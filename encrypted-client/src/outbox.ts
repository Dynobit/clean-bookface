import type { MemoryRecord } from './archive';
import type { Session } from './identity';
import { parseSocial, type SocialAction } from './social';
import { deleteLocalDatabases } from './local-cleanup';

export interface PendingPost {
  record: MemoryRecord;
  recipients: string[];
  operationId?: string;
  delivered?: string[];
}
const POST_LIMIT = 12 * 1024 * 1024;
function encodeBytes(bytes: Uint8Array): string {
  let text = '';
  for (let at = 0; at < bytes.length; at += 8192)
    text += String.fromCharCode(...bytes.subarray(at, at + 8192));
  return btoa(text);
}
function validatePost(value: PendingPost): void {
  const r = value?.record;
  if (
    !r ||
    !['post', 'photo', 'album'].includes(r.kind) ||
    r.privateOnly ||
    typeof r.id !== 'string' ||
    typeof r.text !== 'string' ||
    r.text.length > 20_000 ||
    typeof r.title !== 'string' ||
    r.title.length > 2000 ||
    (r.timestamp !== null && !Number.isSafeInteger(r.timestamp)) ||
    !Array.isArray(r.attachments) ||
    r.attachments.length > 4 ||
    r.attachments.some(
      (a, i) =>
        !(a.bytes instanceof Blob) ||
        a.bytes.size > 2 * 1024 * 1024 ||
        a.mimeType !== 'image/jpeg' ||
        a.path !== `photo-${i + 1}.jpg`,
    ) ||
    !Array.isArray(value.recipients) ||
    !value.recipients.length ||
    value.recipients.length > 100 ||
    new Set(value.recipients).size !== value.recipients.length ||
    value.recipients.some((p) => typeof p !== 'string' || !/^@[^\s:]+:[^\s]+$/.test(p)) ||
    (value.operationId !== undefined && !/^[a-zA-Z0-9_-]{16,128}$/.test(value.operationId)) ||
    (value.delivered !== undefined &&
      (!Array.isArray(value.delivered) ||
        value.delivered.some((p) => !value.recipients.includes(p))))
  )
    throw new Error('Invalid queued post.');
}
export interface PendingSocial {
  post: { roomId: string; id: string; sender: string };
  operationId: string;
  action: SocialAction;
}
/** Local retry state only. It is not an account backup or a substitute for recovery. */
export class BrowserOutbox {
  private constructor(
    private db: IDBDatabase,
    private key: CryptoKey,
    private context: Uint8Array<ArrayBuffer>,
  ) {}
  static async databaseName(
    session: Pick<Session, 'baseUrl' | 'userId' | 'deviceId'>,
  ): Promise<string> {
    const binding = `clean-bookface-outbox-v1\0${session.baseUrl}\0${session.userId}\0${session.deviceId}`;
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(binding));
    return `clean-bookface-outbox-${[...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  }
  static async forgetSession(
    session: Pick<Session, 'baseUrl' | 'userId' | 'deviceId'>,
  ): Promise<void> {
    await deleteLocalDatabases([await BrowserOutbox.databaseName(session)]);
  }
  static async open(session: Session): Promise<BrowserOutbox> {
    const binding = `clean-bookface-outbox-v1\0${session.baseUrl}\0${session.userId}\0${session.deviceId}`;
    const context = new TextEncoder().encode(binding);
    const hash = await crypto.subtle.digest('SHA-256', context);
    const name = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(`clean-bookface-outbox-${name}`, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('state');
      request.onerror = () => reject(new Error('Browser retry storage is unavailable.'));
      request.onsuccess = () => resolve(request.result);
    });
    const candidate = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    const key = await new Promise<CryptoKey>((resolve, reject) => {
      const tx = db.transaction('state', 'readwrite');
      const store = tx.objectStore('state');
      const request = store.get('key');
      let selected: CryptoKey;
      request.onsuccess = () => {
        selected = request.result || candidate;
        if (!request.result) store.add(candidate, 'key');
      };
      tx.oncomplete = () => resolve(selected);
      tx.onerror = () => reject(new Error('Browser retry storage could not save its key.'));
      tx.onabort = tx.onerror;
    });
    return new BrowserOutbox(db, key, context);
  }
  private async read(slot = 'post'): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const request = this.db.transaction('state').objectStore('state').get(slot);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Could not read the queued post.'));
    });
  }
  private async decrypt(slot: string): Promise<unknown> {
    const saved = await this.read(slot);
    if (!saved) return null;
    const { iv, ciphertext } = saved as { iv: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer };
    if (
      !(iv instanceof Uint8Array) ||
      iv.length !== 12 ||
      !(ciphertext instanceof ArrayBuffer) ||
      ciphertext.byteLength > (slot === 'post' ? POST_LIMIT : 100_000)
    )
      throw new Error('Invalid queued post.');
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: this.context },
      this.key,
      ciphertext,
    );
    try {
      return JSON.parse(new TextDecoder().decode(plain));
    } finally {
      new Uint8Array(plain).fill(0);
    }
  }
  async load(): Promise<PendingPost | null> {
    const value = (await this.decrypt('post')) as PendingPost | null;
    if (!value) return null;
    if (!Array.isArray(value.record?.attachments) || value.record.attachments.length > 4)
      throw new Error('Invalid queued post.');
    for (const a of value.record.attachments) {
      const saved = a as unknown as { data?: unknown; bytes: Blob };
      if (typeof saved.data !== 'string' || saved.data.length > 2_800_000)
        throw new Error('Invalid queued photo.');
      const binary = atob(saved.data);
      saved.bytes = new Blob([Uint8Array.from(binary, (c) => c.charCodeAt(0))], {
        type: a.mimeType,
      });
      delete saved.data;
    }
    validatePost(value);
    value.operationId ??= value.record.id;
    value.delivered ??= [];
    return value;
  }
  async loadSocial(): Promise<PendingSocial | null> {
    const value = (await this.decrypt('social')) as PendingSocial | null;
    if (!value) return null;
    if (!value.post || typeof value.post.roomId !== 'string' || !value.post.roomId.startsWith('!'))
      throw new Error('Invalid queued conversation.');
    parseSocial({
      version: 1,
      purpose: 'social',
      id: value.operationId,
      postId: value.post.id,
      postSender: value.post.sender,
      ...value.action,
    });
    return value;
  }
  async saveSocial(value: PendingSocial): Promise<void> {
    parseSocial({
      version: 1,
      purpose: 'social',
      id: value.operationId,
      postId: value.post.id,
      postSender: value.post.sender,
      ...value.action,
    });
    await this.saveValue('social', value);
  }
  async save(post: PendingPost): Promise<void> {
    validatePost(post);
    const attachments = await Promise.all(
      post.record.attachments.map(async (a) => ({
        path: a.path,
        mimeType: a.mimeType,
        data: encodeBytes(new Uint8Array(await a.bytes.arrayBuffer())),
      })),
    );
    await this.saveValue('post', { ...post, record: { ...post.record, attachments } });
  }
  private async saveValue(slot: string, value: unknown): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify(value));
    if (plain.byteLength > (slot === 'post' ? POST_LIMIT - 32 : 99_000))
      throw new Error('Queued post is too large.');
    let ciphertext: ArrayBuffer;
    try {
      ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: this.context },
        this.key,
        plain,
      );
    } finally {
      plain.fill(0);
    }
    await new Promise<void>((resolve, reject) => {
      const tx = this.db.transaction('state', 'readwrite');
      tx.objectStore('state').put({ iv, ciphertext }, slot);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error('Could not save retry state; nothing was sent.'));
      tx.onabort = tx.onerror;
    });
  }
  async clear(slot = 'post'): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const tx = this.db.transaction('state', 'readwrite');
      tx.objectStore('state').delete(slot);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error('Could not clear the delivered post.'));
      tx.onabort = tx.onerror;
    });
  }
  close(): void {
    this.db.close();
  }
  async forget(): Promise<void> {
    const name = this.db.name;
    this.close();
    await deleteLocalDatabases([name]);
  }
}
