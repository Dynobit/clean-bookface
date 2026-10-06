/** Only these SDK-owned stores belong to this exact authenticated device. */
export function deviceCryptoDatabaseNames(session: {
  baseUrl: string;
  userId: string;
  deviceId: string;
}): string[] {
  if (!session.baseUrl || !session.userId || !session.deviceId)
    throw new Error('An exact device identity is required for cleanup.');
  const prefix = `clean-bookface:${session.baseUrl}:${session.userId}:${session.deviceId}`;
  return [`${prefix}::matrix-sdk-crypto`, `${prefix}::matrix-sdk-crypto-meta`];
}

/** Native deletion deliberately does not use SDK clearStores, which swallows errors. */
export async function forgetDeviceCrypto(
  session: { baseUrl: string; userId: string; deviceId: string },
  timeoutMs = 10_000,
): Promise<void> {
  return deleteLocalDatabases(deviceCryptoDatabaseNames(session), timeoutMs);
}

/** Delete only explicitly named stores; callers own the account/device scope. */
export async function deleteLocalDatabases(names: string[], timeoutMs = 10_000): Promise<void> {
  if (names.some((name) => !name || typeof name !== 'string'))
    throw new Error('Explicit local database names are required.');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error('A positive cleanup deadline is required.');
  if (!globalThis.indexedDB) throw new Error('Local encryption storage is unavailable.');
  await Promise.all(
    names.map(
      (name) =>
        new Promise<void>((resolve, reject) => {
          let settled = false;
          let blocked = false;
          const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            error ? reject(error) : resolve();
          };
          const timer = setTimeout(
            () =>
              finish(
                new Error(
                  blocked
                    ? 'Local key removal is blocked by another open tab. Close it and retry.'
                    : 'Local key removal timed out. Retry before leaving this browser.',
                ),
              ),
            timeoutMs,
          );
          try {
            const request = indexedDB.deleteDatabase(name);
            request.onsuccess = () => finish();
            request.onerror = () =>
              finish(new Error('Local key removal failed. Retry before leaving this browser.'));
            request.onblocked = () => {
              blocked = true;
            };
          } catch {
            finish(new Error('Local key removal failed. Retry before leaving this browser.'));
          }
        }),
    ),
  );
}
