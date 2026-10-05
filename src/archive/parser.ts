import { createHash } from 'node:crypto';
import type { ArchiveKind, NormalizedRecord } from './types.js';
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
export const digest = (v: string | Buffer): string => createHash('sha256').update(v).digest('hex');
export function timestamp(v: unknown, alreadyMilliseconds = false): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const milliseconds = !alreadyMilliseconds && Math.abs(v) < 100_000_000_000 ? v * 1000 : v;
  return Number.isSafeInteger(milliseconds) &&
    milliseconds >= -62135596800000 &&
    milliseconds <= 253402300799999
    ? milliseconds
    : null;
}
export function validateStructure(value: unknown): void {
  const stack: Array<[unknown, number]> = [[value, 0]];
  let nodes = 0;
  while (stack.length) {
    const [node, depth] = stack.pop()!;
    if (++nodes > 2_000_000 || depth > 64) throw new Error('JSON structure limit exceeded');
    if (node && typeof node === 'object')
      for (const child of Object.values(node)) stack.push([child, depth + 1]);
  }
}
function mediaPaths(value: unknown): string[] {
  const result = new Set<string>();
  const stack = [value];
  while (stack.length) {
    const next = stack.pop();
    if (!next || typeof next !== 'object') continue;
    if (Array.isArray(next)) {
      stack.push(...next);
      continue;
    }
    for (const [key, v] of Object.entries(next)) {
      if ((key === 'uri' || key === 'media_uri') && typeof v === 'string') result.add(v);
      else if (v && typeof v === 'object' && !['comments', 'reactions', 'tags'].includes(key))
        stack.push(v);
    }
  }
  return [...result];
}
/** Preserve decoded Unicode exactly. Facebook mojibake is never repaired by guessing. */
export function parseFacebook(value: unknown, filename: string): NormalizedRecord[] {
  validateStructure(value);
  const root = obj(value);
  const lower = filename.toLowerCase();
  const result: NormalizedRecord[] = [];
  const counters = new Map<string, number>();
  function add(
    kind: ArchiveKind,
    input: unknown,
    index: number,
    context: string,
    title = '',
  ): void {
    const r = obj(input);
    if (!Object.keys(r).length) return;
    const occurredAt = timestamp(
      r.timestamp_ms ?? r.timestamp ?? r.creation_timestamp ?? r.created_timestamp,
      typeof r.timestamp_ms === 'number',
    );
    const textParts = arr(r.data)
      .map((d) => str(obj(d).post))
      .filter(Boolean);
    const body =
      kind === 'profile'
        ? JSON.stringify(input, null, 2)
        : textParts.length
          ? textParts.join('\n\n')
          : str(r.post) ||
            str(r.content) ||
            str(r.description) ||
            str(r.text) ||
            (kind === 'photo' ? str(r.title) : kind === 'friend' ? str(r.name) : '');
    const providerId = r.id ?? r.post_id ?? r.message_id ?? r.photo_id;
    const hasId =
      (typeof providerId === 'string' && providerId.length > 0 && providerId.length <= 512) ||
      typeof providerId === 'number';
    // Without a provider ID, source path + source position preserves equal-text records.
    // File reshuffling cannot be reliably identified as an edit; report this limitation.
    let fallback = `${filename}\0${index}`;
    if (kind === 'message' && occurredAt !== null) {
      const base = `${context}\0${occurredAt}\0${str(r.sender_name)}`;
      const occurrence = counters.get(base) ?? 0;
      counters.set(base, occurrence + 1);
      fallback = `${base}\0${filename.match(/message_(\d+)\.json$/u)?.[1] ?? '1'}\0${occurrence}`;
    }
    const sourceKey = digest(
      `${kind}\0${context}\0${hasId ? `id:${String(providerId)}` : `position:${fallback}`}`,
    );
    result.push({
      kind,
      body,
      title: title || str(r.title) || str(r.name),
      occurredAt,
      sourceKey,
      source: filename,
      metadata: { original: input, ...(context ? { context } : {}) },
      mediaPaths: kind === 'friend' || kind === 'profile' ? [] : mediaPaths(input),
      ambiguous: !hasId,
    });
  }
  if (Array.isArray(root.messages)) {
    const context =
      str(root.thread_path) || str(root.thread_id) || filename.replace(/\/message_\d+\.json$/u, '');
    root.messages.forEach((r, i) => add('message', r, i, context, str(root.title)));
  } else if (/\bprofile\b|profile_information/u.test(lower) || root.profile_v2 || root.profile) {
    add('profile', root.profile_v2 ?? root.profile ?? value, 0, 'profile', 'Profile');
  } else if (root.friends_v2 || root.friends || /(?:^|\/)friends(?:_\d+)?\.json$/u.test(lower)) {
    arr(root.friends_v2 ?? root.friends ?? value).forEach((r, i) => add('friend', r, i, 'friends'));
  } else if (
    root.photos ||
    root.photos_v2 ||
    root.your_photos ||
    /(?:^|\/)(?:your_)?(?:uncategorized_)?photos(?:_\d+)?\.json$/u.test(lower)
  ) {
    const photos = arr(root.photos ?? root.photos_v2 ?? root.your_photos ?? value);
    const album = str(root.name) || str(root.title);
    if (album)
      add(
        'album',
        {
          name: album,
          description: root.description,
          timestamp: root.last_modified_timestamp,
          photos,
        },
        0,
        filename,
        album,
      );
    photos.forEach((r, i) => add('photo', r, i, album));
  } else if (root.albums || root.albums_v2) {
    arr(root.albums ?? root.albums_v2).forEach((a, n) => {
      const album = obj(a);
      const name = str(album.name) || str(album.title);
      add('album', a, n, filename, name);
      arr(album.photos).forEach((p, i) => add('photo', p, i, `${filename}:${n}`, name));
    });
  } else if (
    root.posts ||
    root.posts_v2 ||
    root.your_posts ||
    /(?:^|\/)(?:posts|your_posts(?:__check_ins__photos_and_videos)?)(?:_\d+)?\.json$/u.test(lower)
  ) {
    arr(root.posts ?? root.posts_v2 ?? root.your_posts ?? value).forEach((r, i) =>
      add('post', r, i, 'posts'),
    );
  }
  return result;
}
