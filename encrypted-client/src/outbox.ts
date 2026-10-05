import type { MemoryRecord } from './archive';
import type { Session } from './identity';

export interface PendingPost {
  record: MemoryRecord;
  recipients: string[];
}
/** Local retry state only. It is not an account backup or a substitute for recovery. */
export class BrowserOutbox {
  private constructor(
    private db: IDBDatabase,
    private key: CryptoKey,
    private context: Uint8Array<ArrayBuffer>,
  ) {}
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
  private async read(): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const request = this.db.transaction('state').objectStore('state').get('post');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Could not read the queued post.'));
    });
  }
  async load(): Promise<PendingPost | null> {
    const saved = await this.read();
    if (!saved) return null;
    const { iv, ciphertext } = saved as { iv: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer };
    if (
      !(iv instanceof Uint8Array) ||
      iv.length !== 12 ||
      !(ciphertext instanceof ArrayBuffer) ||
      ciphertext.byteLength > 100_000
    )
      throw new Error('Invalid queued post.');
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: this.context },
      this.key,
      ciphertext,
    );
    try {
      const value = JSON.parse(new TextDecoder().decode(plain)) as PendingPost;
      const r = value.record;
      if (
        !r ||
        r.kind !== 'post' ||
        typeof r.id !== 'string' ||
        typeof r.text !== 'string' ||
        r.text.length > 20_000 ||
        !Number.isSafeInteger(r.timestamp) ||
        r.attachments?.length !== 0 ||
        !Array.isArray(value.recipients) ||
        !value.recipients.length ||
        value.recipients.length > 100 ||
        value.recipients.some((p) => typeof p !== 'string' || !/^@[^\s:]+:[^\s]+$/.test(p))
      )
        throw new Error('Invalid queued post.');
      return value;
    } finally {
      new Uint8Array(plain).fill(0);
    }
  }
  async save(post: PendingPost): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify(post));
    if (plain.byteLength > 99_000) throw new Error('Queued post is too large.');
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
      tx.objectStore('state').put({ iv, ciphertext }, 'post');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error('Could not save retry state; nothing was sent.'));
      tx.onabort = tx.onerror;
    });
  }
  async clear(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const tx = this.db.transaction('state', 'readwrite');
      tx.objectStore('state').delete('post');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error('Could not clear the delivered post.'));
      tx.onabort = tx.onerror;
    });
  }
  close(): void {
    this.db.close();
  }
}
