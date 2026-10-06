/** Pairwise conversations: never forward these events into another recipient's room. */
export type SocialAction =
  | { kind: 'comment'; text: string }
  | { kind: 'remove-comment'; commentId: string }
  | { kind: 'reaction'; reaction: string | null }
  | { kind: 'remove-post' };
export type SocialPayload = {
  version: 1;
  purpose: 'social';
  id: string;
  postId: string;
  postSender: string;
} & SocialAction;
export interface SocialEvent {
  payload: SocialPayload;
  sender: string;
  timestamp: number;
}
export interface SocialState {
  removed: boolean;
  comments: { id: string; sender: string; text: string; timestamp: number }[];
  reactions: { sender: string; reaction: string }[];
}
export function parseSocial(value: unknown): SocialPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid social content');
  const p = value as Record<string, unknown>;
  const fields = ['version', 'purpose', 'id', 'postId', 'postSender', 'kind'];
  if (p.kind === 'comment') fields.push('text');
  else if (p.kind === 'remove-comment') fields.push('commentId');
  else if (p.kind === 'reaction') fields.push('reaction');
  else if (p.kind !== 'remove-post') throw new Error('Unknown social action');
  if (
    Object.keys(p).sort().join(',') !== fields.sort().join(',') ||
    p.version !== 1 ||
    p.purpose !== 'social' ||
    typeof p.id !== 'string' ||
    !/^[a-zA-Z0-9_-]{16,128}$/u.test(p.id) ||
    typeof p.postId !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(p.postId) ||
    typeof p.postSender !== 'string' ||
    !/^@[^\s:]+:[^\s]+$/u.test(p.postSender)
  )
    throw new Error('Invalid social binding');
  if (
    p.kind === 'comment' &&
    (typeof p.text !== 'string' || !p.text.trim() || p.text.length > 4000)
  )
    throw new Error('Comment must contain 1–4000 characters');
  if (
    p.kind === 'remove-comment' &&
    (typeof p.commentId !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/u.test(p.commentId))
  )
    throw new Error('Invalid comment identity');
  if (
    p.kind === 'reaction' &&
    p.reaction !== null &&
    (typeof p.reaction !== 'string' || !['♥', '👍', '😂', '😮', '😢'].includes(p.reaction))
  )
    throw new Error('Unsupported reaction');
  return p as SocialPayload;
}
/** Input order is the authenticated room timeline, not server-supplied timestamps. */
export function socialState(
  post: { id: string; sender: string },
  events: SocialEvent[],
): SocialState {
  const state: SocialState = { removed: false, comments: [], reactions: [] };
  const seen = new Map<string, string>();
  const comments = new Map<string, SocialState['comments'][number]>();
  const removed = new Set<string>();
  const reactions = new Map<string, string>();
  for (const event of events) {
    const p = parseSocial(event.payload);
    if (p.postId !== post.id || p.postSender !== post.sender)
      throw new Error('Social post binding mismatch');
    const key = `${event.sender}\0${p.id}`;
    const fingerprint = JSON.stringify(Object.entries(p).sort(([a], [b]) => a.localeCompare(b)));
    if (seen.has(key)) {
      if (seen.get(key) !== fingerprint) throw new Error('Conflicting social operation identity');
      continue;
    }
    seen.set(key, fingerprint);
    if (p.kind === 'remove-post') {
      if (event.sender !== post.sender) throw new Error('Only the post owner can remove a post');
      state.removed = true;
    } else if (p.kind === 'comment') {
      const commentKey = `${event.sender}\0${p.id}`;
      comments.set(commentKey, {
        id: p.id,
        sender: event.sender,
        text: p.text,
        timestamp: event.timestamp,
      });
    } else if (p.kind === 'remove-comment') {
      const commentKey = `${event.sender}\0${p.commentId}`;
      if (!comments.has(commentKey))
        throw new Error('Only the commenter can remove an existing comment');
      removed.add(commentKey);
    } else if (p.reaction === null) reactions.delete(event.sender);
    else reactions.set(event.sender, p.reaction);
  }
  state.comments = [...comments].filter(([key]) => !removed.has(key)).map(([, comment]) => comment);
  state.reactions = [...reactions].map(([sender, reaction]) => ({ sender, reaction }));
  return state;
}
