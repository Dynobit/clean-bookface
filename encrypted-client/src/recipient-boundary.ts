import type { Room } from 'matrix-js-sdk';
import sdkPackage from 'matrix-js-sdk/package.json' with { type: 'json' };

const boundaries = new WeakMap<
  Room,
  { scope: string; collect: Room['getEncryptionTargetMembers'] }
>();
/**
 * Matrix SDK 43.0.0 RoomEncryptor.ensureEncryptionSession awaits this method,
 * then derives BOTH tracked users and the actual shareRoomKey userList from
 * its returned array. RoomMember.userId is constructor-readonly and is never
 * rewritten by remote membership updates. Copy the array to prevent later
 * room-list mutations from widening the validated recipient list.
 * The application must not call shareRoomHistoryWithUser: it bypasses this path.
 *
 * The SDK can queue encryption after application guards. Enforce scope here,
 * at recipient collection, not just before sendEvent. Never silently filter.
 */
export function enforceRecipientBoundary(
  room: Room,
  allowedIds: readonly string[],
  assertScope: () => void,
  discardSession: () => Promise<void>,
): void {
  if (sdkPackage.version !== '43.0.0')
    throw new Error('Recipient boundary requires reviewed Matrix SDK 43.0.0');
  const allowed = new Set(allowedIds);
  if (!allowed.size || allowed.size !== allowedIds.length)
    throw new Error('Invalid encryption recipient scope');
  const scope = [...allowed].sort().join('\0');
  const existing = boundaries.get(room);
  if (existing) {
    if (existing.scope !== scope || room.getEncryptionTargetMembers !== existing.collect)
      throw new Error('Encryption recipient boundary changed');
    return;
  }
  const original = room.getEncryptionTargetMembers;
  if (typeof original !== 'function')
    throw new Error('Encryption recipient collection unavailable');
  let initialized: Promise<void> | undefined;
  const collect: Room['getEncryptionTargetMembers'] = async () => {
    // At this boundary RoomEncryptor exists, so the public discard API cannot
    // silently no-op on an as-yet unconstructed encryptor for a persisted room.
    initialized ??= discardSession().catch((error) => {
      initialized = undefined;
      throw error;
    });
    await initialized;
    const members = await original.call(room);
    assertScope();
    const found = new Set(members.map((member) => member.userId));
    if (
      members.length !== allowed.size ||
      found.size !== allowed.size ||
      [...found].some((user) => !allowed.has(user))
    )
      throw new Error('Encryption recipients differ from the authorized room scope');
    return members.slice();
  };
  Object.defineProperty(room, 'getEncryptionTargetMembers', {
    value: collect,
    writable: false,
    configurable: false,
  });
  boundaries.set(room, { scope, collect });
}
