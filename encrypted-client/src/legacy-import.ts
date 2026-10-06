import type { MemoryRecord, ARCHIVE_LIMITS } from './archive.js';
type Row = Record<string, unknown>;
interface Dependencies {
  limits: typeof ARCHIVE_LIMITS;
  check(): void;
  hash(value: Blob | string): Promise<string>;
  safePath(value: string): string;
  timestamp(value: unknown, milliseconds: boolean): number | null;
  validateStructure(value: unknown): void;
  rejectExecutable(value: Blob): Promise<void>;
  extract(value: Blob): Promise<Map<string, Blob>>;
}
const object = (v: unknown): Row => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Invalid legacy object');
  return v as Row;
};
const text = (v: unknown, max = 2048, empty = false): string => {
  if (typeof v !== 'string' || v.length > max || (!empty && !v))
    throw new Error('Invalid legacy text');
  return v;
};
const id = (v: unknown): string => {
  const s = text(v, 200);
  if (!/^[a-zA-Z0-9_-]+$/u.test(s)) throw new Error('Invalid legacy identity');
  return s;
};
function metadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(metadata);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !/^(?:password(?:_hash)?|private[_-]?key|private[_-]?jwk|public[_-]?jwk|signing[_-]?key|session(?:s)?|session[_-]?token|csrf|recovery[_-]?(?:codes?|keys?)|access[_-]?token|refresh[_-]?token|authorization|cookie|credentials)$/iu.test(
            key,
          ),
      )
      .map(([k, v]) => [k, metadata(v)]),
  );
}
const extensions: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
};
/** Reads declared v0.1 formats only; nested extraction shares the outer decompression budget. */
export async function importLegacy(
  input: Map<string, Blob>,
  d: Dependencies,
): Promise<{ records: MemoryRecord[]; warnings: string[] } | null> {
  const json = async (blob: Blob): Promise<Row> => {
    if (blob.size > d.limits.maxJsonBytes) throw new Error('Legacy JSON limit exceeded');
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(await blob.arrayBuffer()),
    );
    d.validateStructure(value);
    return object(value);
  };
  const rooted = (files: Map<string, Blob>, marker: string): Map<string, Blob> => {
    const prefix = marker.slice(0, marker.lastIndexOf('/') + 1);
    if ([...files.keys()].some((p) => !p.startsWith(prefix)))
      throw new Error('Legacy files outside archive root');
    return new Map([...files].map(([p, b]) => [p.slice(prefix.length), b]));
  };
  const markers = (files: Map<string, Blob>, name: string) =>
    [...files.keys()].filter((p) => p === name || p.endsWith(`/${name}`));
  let files = input;
  let account: Row | undefined;
  const accounts = markers(files, 'account.json');
  if (accounts.length > 1) throw new Error('Ambiguous legacy account manifest');
  if (accounts.length) {
    account = await json(files.get(accounts[0])!);
    if (account.format !== 'clean-bookface-account/1')
      throw new Error('Unsupported declared account format');
    const outer = rooted(files, accounts[0]);
    if (outer.size !== 2 || !outer.has('private-archive.zip'))
      throw new Error('Legacy account requires account.json and private-archive.zip');
    files = await d.extract(outer.get('private-archive.zip')!);
  }
  const manifests = markers(files, 'manifest.json');
  if (!manifests.length && !account) return null;
  if (manifests.length !== 1) throw new Error('Legacy archive manifest missing or ambiguous');
  const manifest = await json(files.get(manifests[0])!);
  if (manifest.format !== 'clean-bookface-archive/1')
    throw new Error('Unsupported declared archive format');
  files = rooted(files, manifests[0]);
  if (
    !files.has('archive.ndjson') ||
    !files.has('revisions.ndjson') ||
    !Array.isArray(manifest.media)
  )
    throw new Error('Invalid legacy archive manifest');
  const allowed = new Set(['manifest.json', 'archive.ndjson', 'revisions.ndjson']);
  const media = new Map<
    string,
    { attachment: MemoryRecord['attachments'][number]; sha256: string }
  >();
  for (const raw of manifest.media) {
    d.check();
    const m = object(raw),
      key = id(m.id),
      path = d.safePath(text(m.file));
    const extension = extensions[text(m.mime, 100)];
    if (
      !extension ||
      !['original', 'shared'].includes(String(m.purpose)) ||
      path !== `media/${key}.${m.purpose === 'shared' ? 'webp' : 'original'}` ||
      media.has(key)
    )
      throw new Error('Invalid legacy media manifest');
    const bytes = files.get(path);
    if (
      !bytes ||
      !Number.isSafeInteger(m.size) ||
      m.size !== bytes.size ||
      !/^[a-f0-9]{64}$/u.test(text(m.sha256, 64)) ||
      (await d.hash(bytes)) !== m.sha256
    )
      throw new Error('Legacy media checksum or size mismatch');
    await d.rejectExecutable(bytes);
    allowed.add(path);
    media.set(key, {
      attachment: {
        path: `legacy-media/${key}.${extension}`,
        mimeType: String(m.mime),
        bytes: new Blob([bytes], { type: String(m.mime) }),
      },
      sha256: String(m.sha256),
    });
  }
  if ([...files.keys()].some((p) => !allowed.has(p)))
    throw new Error('Unexpected legacy file or nested ZIP');
  const date = (v: unknown): number | null => {
    if (v === null || v === undefined) return null;
    const n = d.timestamp(v, true);
    if (n === null) throw new Error('Invalid legacy date');
    return n;
  };
  const refs = (v: unknown): string[] => {
    if (!Array.isArray(v) || v.length > d.limits.maxEntries)
      throw new Error('Invalid legacy media references');
    return [
      ...new Set(
        v.map((value) => {
          const key = id(value);
          if (!media.has(key)) throw new Error('Missing legacy media reference');
          return key;
        }),
      ),
    ];
  };
  const records: MemoryRecord[] = [],
    warnings = [
      'Legacy copies were imported privately. Credentials, account roles, friendships, blocks and sharing permissions were not restored.',
    ];
  const seen = new Set<string>();
  const add = (record: MemoryRecord) => {
    d.check();
    if (seen.has(record.id)) throw new Error('Duplicate legacy record identity');
    seen.add(record.id);
    records.push(record);
    if (records.length > d.limits.maxRecords) throw new Error('Legacy record limit exceeded');
  };
  async function* rows(name: string): AsyncGenerator<Row> {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const reader = files.get(name)!.stream().getReader();
    let buffer = '';
    const parse = (line: string) => {
      if (new TextEncoder().encode(line).length > d.limits.maxJsonBytes)
        throw new Error('Legacy record JSON limit exceeded');
      const value: unknown = JSON.parse(line);
      d.validateStructure(value);
      return object(value);
    };
    try {
      while (true) {
        d.check();
        const { done, value } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (line.trim()) yield parse(line);
        }
        if (new TextEncoder().encode(buffer).length > d.limits.maxJsonBytes)
          throw new Error('Legacy record JSON limit exceeded');
        if (done) break;
      }
      if (buffer.trim()) yield parse(buffer);
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  }
  const originals = new Map<string, { sourceKey: string; version: number }>();
  async function archiveRecord(row: Row, history?: number): Promise<MemoryRecord> {
    const originalId = id(row.id),
      sourceKey = text(row.sourceKey, 64),
      kind = text(row.kind, 20);
    if (
      !/^[a-f0-9]{64}$/u.test(sourceKey) ||
      !['post', 'photo', 'album', 'message', 'friend', 'profile'].includes(kind) ||
      !Number.isSafeInteger(row.version) ||
      Number(row.version) < 1
    )
      throw new Error('Invalid legacy record');
    const mediaIds = refs(row.mediaIds);
    if (kind === 'profile' && !warnings.some((w) => w.startsWith('Profiles')))
      warnings.push('Profiles are preserved as private memories, not applied to your account.');
    return {
      id:
        history === undefined
          ? originalId
          : `legacy-revision-${await d.hash(`${originalId}\0${sourceKey}\0${history}`)}`,
      kind: kind === 'profile' ? 'message' : (kind as MemoryRecord['kind']),
      timestamp: date(row.occurredAt),
      text: text(row.body, d.limits.maxJsonBytes, true),
      title: text(row.title, 4096, true),
      sourcePath: text(row.source),
      privateOnly: ['message', 'friend', 'profile'].includes(kind),
      attachments: mediaIds.map((key) => media.get(key)!.attachment),
      provenance: {
        legacy: {
          format: 'clean-bookface-archive/1',
          originalId,
          sourceKey,
          version: row.version,
          importedAt: date(row.importedAt),
          originalKind: kind,
          ...(history === undefined ? {} : { historyVersion: history }),
          media: mediaIds.map((key) => ({ id: key, sha256: media.get(key)!.sha256 })),
        },
        metadata: metadata(object(row.metadata ?? {})),
      },
    };
  }
  for await (const row of rows('archive.ndjson')) {
    const r = await archiveRecord(row);
    add(r);
    originals.set(r.id, { sourceKey: String(row.sourceKey), version: Number(row.version) });
  }
  for await (const history of rows('revisions.ndjson')) {
    const originalId = id(history.item_id),
      original = originals.get(originalId);
    if (
      !original ||
      !Number.isSafeInteger(history.version) ||
      Number(history.version) < 1 ||
      Number(history.version) >= original.version
    )
      throw new Error('Orphan or invalid legacy revision');
    const row = object(
      typeof history.record === 'string' ? JSON.parse(history.record) : history.record,
    );
    d.validateStructure(row);
    if (
      row.id !== originalId ||
      row.sourceKey !== original.sourceKey ||
      row.version !== history.version
    )
      throw new Error('Legacy revision identity mismatch');
    add(await archiveRecord(row, Number(history.version)));
  }
  if (account) {
    const profile = object(account.account),
      actor = text(profile.actor);
    const url = new URL(actor);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('Invalid legacy actor');
    if (!Array.isArray(account.publications) || !Array.isArray(account.comments))
      throw new Error('Invalid legacy account collections');
    for (const [category, values] of [
      ['publication', account.publications],
      ['comment', account.comments],
    ] as const) {
      for (const raw of values) {
        const row = object(raw),
          originalId = category === 'publication' ? id(row.id) : text(row.id),
          mediaIds = category === 'publication' ? refs(row.mediaIds) : [];
        add({
          id: `legacy-${category}-${await d.hash(`${actor}\0${originalId}`)}`,
          kind: category === 'comment' ? 'message' : 'post',
          timestamp: date(row.createdAt),
          text: text(row.body, d.limits.maxJsonBytes, true),
          title: `Your ${category} — private legacy copy`,
          sourcePath: `legacy-account/${category}s`,
          privateOnly: category === 'comment',
          attachments: mediaIds.map((key) => media.get(key)!.attachment),
          provenance: {
            legacy: {
              format: 'clean-bookface-account/1',
              originalId,
              sourceActor: actor,
              category,
              media: mediaIds.map((key) => ({ id: key, sha256: media.get(key)!.sha256 })),
              ...(category === 'comment'
                ? { parentReference: text(row.postId) }
                : { updatedAt: date(row.updatedAt) }),
            },
          },
        });
      }
    }
    warnings.push(
      'The legacy account profile, settings and relationship lists remain in your original export; they were not imported.',
    );
  }
  const usedMedia = new Set(records.flatMap((record) => record.attachments.map((a) => a.path)));
  const unused = [...media.values()].filter((m) => !usedMedia.has(m.attachment.path)).length;
  if (unused)
    warnings.push(
      `${unused} unreferenced legacy media file(s) remain in your original export and were not imported.`,
    );
  return { records, warnings };
}
