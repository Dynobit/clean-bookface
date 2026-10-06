import { resolve } from 'node:path';
export interface Config {
  origin: string;
  dataDir: string;
  host: string;
  port: number;
  production: boolean;
  maintenance: boolean;
  federation: boolean;
  maxUploadBytes: number;
  maxDirectUploadBytes: number;
  archiveAccountBytes: number;
  maxAccounts: number;
  cloudflareProxy: boolean;
  pilotReadOnlyAt?: string;
  pilotEndsAt?: string;
  instanceName: string;
}
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';
  const port = Number(env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('PORT must be a valid port');
  const origin = new URL(env.APP_ORIGIN ?? `http://localhost:${port}`);
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/')
    throw new Error('APP_ORIGIN must be an origin without a path or credentials');
  if (!['http:', 'https:'].includes(origin.protocol))
    throw new Error('APP_ORIGIN must use HTTP(S)');
  if (production && origin.protocol !== 'https:')
    throw new Error('Production requires an HTTPS APP_ORIGIN');
  const maxUploadBytes = Number(env.MAX_UPLOAD_BYTES ?? 1024 * 1024 * 1024);
  if (
    !Number.isSafeInteger(maxUploadBytes) ||
    maxUploadBytes < 1024 ||
    maxUploadBytes > 20 * 1024 ** 3
  )
    throw new Error('MAX_UPLOAD_BYTES must be between 1 KiB and 20 GiB');
  function bounded(name: string, fallback: number, min: number, max: number): number {
    const value = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`${name} must be an integer between ${min} and ${max}`);
    return value;
  }
  const maxAccounts = bounded('MAX_ACCOUNTS', 200, 1, 1000);
  const maxDirectUploadBytes = bounded(
    'MAX_DIRECT_UPLOAD_BYTES',
    maxUploadBytes,
    1024,
    20 * 1024 ** 3,
  );
  const archiveAccountBytes = bounded(
    'ARCHIVE_ACCOUNT_BYTES',
    5 * 1024 ** 3,
    1024 ** 2,
    100 * 1024 ** 3,
  );
  const pilotReadOnlyAt = env.PILOT_READ_ONLY_AT;
  const pilotEndsAt = env.PILOT_ENDS_AT;
  if ((pilotReadOnlyAt === undefined) !== (pilotEndsAt === undefined))
    throw new Error('PILOT_READ_ONLY_AT and PILOT_ENDS_AT must be set together');
  for (const [name, value] of [
    ['PILOT_READ_ONLY_AT', pilotReadOnlyAt],
    ['PILOT_ENDS_AT', pilotEndsAt],
  ]) {
    if (value !== undefined) {
      if (
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString() !== value.replace(/(?<!\.\d{3})Z$/, '.000Z')
      )
        throw new Error(`${name} must be an absolute UTC ISO date, such as 2027-01-01T00:00:00Z`);
    }
  }
  if (
    pilotReadOnlyAt !== undefined &&
    pilotEndsAt !== undefined &&
    Date.parse(pilotReadOnlyAt) >= Date.parse(pilotEndsAt)
  )
    throw new Error('PILOT_READ_ONLY_AT must be before PILOT_ENDS_AT');
  if (pilotReadOnlyAt !== undefined && env.FEDERATION_ENABLED === 'true')
    throw new Error(
      'Pilot dates require FEDERATION_ENABLED=false; export-only pilots cannot receive federated removals.',
    );
  return {
    origin: origin.origin,
    dataDir: resolve(env.DATA_DIR ?? './data'),
    host: env.BIND_ADDRESS ?? '127.0.0.1',
    port,
    production,
    maintenance: env.MAINTENANCE_MODE === 'true',
    federation: env.FEDERATION_ENABLED === 'true',
    maxUploadBytes,
    maxDirectUploadBytes,
    archiveAccountBytes,
    maxAccounts,
    cloudflareProxy: env.CLOUDFLARE_PROXY === 'true',
    pilotReadOnlyAt,
    pilotEndsAt,
    instanceName: env.INSTANCE_NAME?.trim().slice(0, 80) || 'Clean Bookface',
  };
}
