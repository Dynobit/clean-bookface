import { MatrixError, EventType, type MatrixClient } from 'matrix-js-sdk';
import { Method } from 'matrix-js-sdk/lib/http-api';
import type { SharedPost } from './content';
import type { MatrixEvent } from 'matrix-js-sdk';

declare module 'matrix-js-sdk/lib/@types/event' {
  interface AccountDataEvents {
    [key: `org.cleanbookface.block.v1.${string}`]: { blocked: boolean };
  }
}
const BLOCK_PREFIX = 'org.cleanbookface.block.v1.';
function blockType(userId: string): `org.cleanbookface.block.v1.${string}` {
  account(userId);
  return `${BLOCK_PREFIX}${encodeURIComponent(userId)}`;
}
function blockValue(value: unknown): boolean {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).join(',') !== 'blocked' ||
    typeof (value as { blocked: unknown }).blocked !== 'boolean'
  )
    throw new Error('The home returned invalid account block policy.');
  return (value as { blocked: boolean }).blocked;
}
/** Per-peer records are authoritative; old Matrix ignored lists remain a fallback. */
export function isBlocked(client: MatrixClient, userId: string): boolean {
  const event = client.getAccountData(blockType(userId));
  return event ? blockValue(event.getContent()) : client.isUserIgnored(userId);
}
export function blockedUsers(client: MatrixClient): string[] {
  const result = new Set(client.getIgnoredUsers());
  const data = (client.store as unknown as { accountData?: Map<string, MatrixEvent> }).accountData;
  if (!(data instanceof Map)) throw new Error('Account block policy storage is unavailable.');
  for (const [type, event] of data) {
    if (!type.startsWith(BLOCK_PREFIX)) continue;
    let peer: string;
    try {
      peer = decodeURIComponent(type.slice(BLOCK_PREFIX.length));
    } catch {
      throw new Error('Invalid account block policy identity.');
    }
    if (blockType(peer) !== type) throw new Error('Invalid account block policy identity.');
    if (blockValue(event.getContent())) result.add(peer);
    else result.delete(peer);
  }
  return [...result].sort();
}

function account(value: string): void {
  if (!/^@[^\s:]+:[^\s]+$/u.test(value) || value.length > 512)
    throw new Error('Use a complete account name.');
}

async function currentBlocks(client: MatrixClient): Promise<Record<string, unknown>> {
  const own = client.getUserId();
  if (!own) throw new Error('Sign in before changing blocked accounts.');
  try {
    // SDK43 getAccountDataFromServer serves its local cache after initial sync.
    const value = await client.http.authedRequest<{ ignored_users: Record<string, unknown> }>(
      Method.Get,
      `/user/${encodeURIComponent(own)}/account_data/${EventType.IgnoredUserList}`,
    );
    if (
      !value.ignored_users ||
      typeof value.ignored_users !== 'object' ||
      Array.isArray(value.ignored_users)
    )
      throw new Error('The home returned invalid block settings.');
    return value.ignored_users;
  } catch (error) {
    if (error instanceof MatrixError && error.httpStatus === 404 && error.errcode === 'M_NOT_FOUND')
      return {};
    throw error;
  }
}

/** Blocking is account metadata. Content guards enforce it before sharing keys. */
export async function setBlocked(
  client: MatrixClient,
  userId: string,
  blocked: boolean,
): Promise<void> {
  account(userId);
  if (userId === client.getUserId()) throw new Error('You cannot block your own account.');
  const type = blockType(userId);
  // Separate event types prevent different peers' updates from overwriting one
  // another. Opposing changes to the SAME peer remain last-writer-wins.
  await client.setAccountData(type, { blocked });
  const own = client.getUserId();
  if (!own) throw new Error('Sign in before changing blocked accounts.');
  const stored = await client.http.authedRequest(
    Method.Get,
    `/user/${encodeURIComponent(own)}/account_data/${encodeURIComponent(type)}`,
  );
  if (blockValue(stored) !== blocked || isBlocked(client, userId) !== blocked)
    throw new Error(
      'Block settings changed on another device. Retry before treating this account as blocked or unblocked.',
    );
  // Compatibility metadata for other Matrix clients. Clean Bookface guards
  // always consult the per-peer override, including explicit unblock tombstones.
  const users = new Set(Object.keys(await currentBlocks(client)));
  if (blocked) users.add(userId);
  else users.delete(userId);
  await client.setIgnoredUsers([...users]);
  const compatible = Object.hasOwn(await currentBlocks(client), userId);
  if (compatible !== blocked || isBlocked(client, userId) !== blocked)
    throw new Error(
      'Block settings changed on another device. Retry before treating this account as blocked or unblocked.',
    );
}

/** Only the evidence explicitly approved in the report form is revealed to the host. */
export async function reportSelectedEvidence(
  client: MatrixClient,
  post: Pick<SharedPost, 'roomId' | 'eventId'>,
  reason: string,
  selectedText: string,
): Promise<void> {
  if (!post.roomId.startsWith('!') || !post.eventId.startsWith('$'))
    throw new Error('This post has no reportable server event.');
  if (!reason.trim() || reason.length > 1000 || selectedText.length > 4000)
    throw new Error(
      'Write a report of up to 1,000 characters and choose up to 4,000 characters of evidence.',
    );
  await client.reportEvent(
    post.roomId,
    post.eventId,
    -100,
    reason.trim() +
      (selectedText ? `\n\nText selected by the reporting person:\n${selectedText}` : ''),
  );
}

/** Deactivation revokes access; it cannot recall recipient copies or old host backups. */
export async function deactivateAccount(
  client: MatrixClient,
  confirmation: string,
  password: string,
): Promise<void> {
  if (confirmation !== client.getUserId() || !password || password.length > 1024)
    throw new Error('Enter your complete account name and password to close this account.');
  try {
    await client.deactivateAccount(undefined, true);
  } catch (error) {
    if (!(error instanceof MatrixError) || error.httpStatus !== 401) throw error;
    const session = error.data.session;
    if (typeof session !== 'string' || !session)
      throw new Error('The home did not provide an account-closing authentication challenge.');
    await client.deactivateAccount(
      {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: client.getUserId()! },
        password,
        session,
      },
      true,
    );
  }
}
