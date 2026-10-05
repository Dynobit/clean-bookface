import type { Config } from './config.js';

type PilotConfig = Pick<Config, 'pilotReadOnlyAt' | 'pilotEndsAt'>;
export type PilotPhase = 'normal' | 'active' | 'export-only' | 'ended';

/** Absolute dates survive process restarts; no uptime-based extension of a pilot. */
export function pilotPhase(config: PilotConfig, now = Date.now()): PilotPhase {
  if (!config.pilotReadOnlyAt && !config.pilotEndsAt) return 'normal';
  if (!config.pilotReadOnlyAt || !config.pilotEndsAt || !Number.isFinite(now)) return 'ended';
  const readOnly = Date.parse(config.pilotReadOnlyAt),
    end = Date.parse(config.pilotEndsAt);
  if (!Number.isFinite(readOnly) || !Number.isFinite(end) || readOnly >= end) return 'ended';
  if (now >= end) return 'ended';
  return now >= readOnly ? 'export-only' : 'active';
}

const safePosts = new Set([
  '/actions/login',
  '/actions/logout',
  '/actions/recover',
  '/actions/password',
  '/actions/logout-all',
  '/actions/settings',
  '/actions/export',
  '/actions/delete-account',
  '/actions/report',
  '/actions/appeal',
  '/actions/notifications/read',
  '/actions/friends/remove',
  '/actions/friends/block',
  '/actions/friends/unblock',
  '/actions/friends/preferences',
]);
const safePostPatterns = [
  /^\/api\/uploads\/[^/]+\/cancel$/,
  /^\/actions\/posts\/[^/]+\/(?:delete|revoke)$/,
  /^\/actions\/comments\/[^/]+\/delete$/,
  /^\/actions\/archive\/[^/]+\/delete$/,
  /^\/actions\/imports\/[^/]+\/cancel$/,
  /^\/actions\/invites\/[^/]+\/revoke$/,
  /^\/actions\/friends\/[^/]+\/(?:reject|cancel)$/,
  /^\/actions\/admin\/reports\/[^/]+\/resolve$/,
  /^\/actions\/admin\/members\/[^/]+\/suspend$/,
  /^\/actions\/admin\/appeals\/[^/]+$/,
];

/** Call before route handlers, including federation. Public ended-page exceptions belong to the caller. */
export function pilotAllowsRequest(
  config: PilotConfig,
  method: string,
  path: string,
  now = Date.now(),
): boolean {
  const phase = pilotPhase(config, now);
  if (phase === 'normal' || phase === 'active') return true;
  if (phase === 'ended') return false;
  if (path === '/setup') return false;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  return (
    method === 'POST' &&
    (safePosts.has(path) || safePostPatterns.some((pattern) => pattern.test(path)))
  );
}

function displayDate(value: string | undefined): string {
  if (!value) return 'the announced closing date';
  return (
    new Intl.DateTimeFormat('en', {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: 'UTC',
    }).format(new Date(value)) + ' UTC'
  );
}

/** Plain text only; HTML callers must escape it. */
export function pilotNotice(config: PilotConfig, now = Date.now()): string | null {
  const phase = pilotPhase(config, now);
  if (phase === 'normal') return null;
  if (phase === 'ended') return 'This pilot has ended. This host is closed.';
  if (phase === 'export-only')
    return `This pilot is closing. Download your account before ${displayDate(config.pilotEndsAt)}. You can still export your account, remove content, and manage your privacy. New sharing and imports are closed.`;
  return `This is a temporary pilot. New sharing and imports close on ${displayDate(config.pilotReadOnlyAt)}. Download your account before this host closes on ${displayDate(config.pilotEndsAt)}.`;
}
