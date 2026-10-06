import type { DatabaseSync } from 'node:sqlite';
import type { FederationNetwork } from './network.js';

export const PROFILE = 'https://github.com/Dynobit/clean-bookface#private-v1';
export const CONTEXT = [
  'https://www.w3.org/ns/activitystreams',
  { cb: 'https://github.com/Dynobit/clean-bookface/ns#' },
];
export type Activity = Record<string, unknown>;
export interface FederationStore {
  db: DatabaseSync;
  dataDir: string;
  transaction<T>(fn: () => T): T;
}
export interface LocalActor {
  id: string;
  userId: string;
  username: string;
  displayName: string;
  discoverable: boolean;
  suspended?: boolean;
  deleted?: boolean;
}
export interface DomainEvent {
  id: string;
  kind: string;
  actor: string;
  recipientActor: string;
  objectId: string;
  revision: number;
  payload: Activity | string;
  createdAt: number;
}
export interface FederationAdapter {
  localActor(username: string): LocalActor | null;
  pendingEvents(limit: number, afterId?: string): DomainEvent[];
  /** Called within the admission transaction, separately from retry scans. */
  takeNewEvents?(limit: number): DomainEvent[];
  rejectAcceptance?(eventId: string): void;
  outboundEvent(id: string): DomainEvent | null;
  ackEvent(id: string): void;
  /** Called synchronously inside same SQLite transaction as transport dedupe.
   * Must enforce actor/object ownership, current friendship, exact grant,
   * monotonic revisions, tombstones, and exact Undo/Accept references. */
  receiveActivity(recipientUserId: string, verifiedActor: string, activity: Activity): void;
  /** Returns already redacted recipient-specific JSON, only when currently permitted. */
  federationObject(url: string, requestingActor: string): Activity | null;
  /** Only shared derivative files; never imported originals. */
  federationMedia(id: string, requestingActor: string): { path: string; mime: string } | null;
  /** False while restore reconciliation is incomplete. */
  sharingAllowed?(): boolean;
}
export interface FederationOptions {
  origin: string;
  enabled: boolean;
  /** Explicit dependency injection for tests; server config never exposes this. */
  network?: FederationNetwork;
  now?: () => number;
}
