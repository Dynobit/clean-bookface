export type ArchiveKind = 'post' | 'photo' | 'album' | 'message' | 'friend' | 'profile';
export interface ArchiveLimits {
  maxFiles: number;
  maxDepth: number;
  maxFileBytes: number;
  maxJsonBytes: number;
  maxExpandedBytes: number;
  maxCompressedBytes: number;
  maxCompressionRatio: number;
  maxRecords: number;
  maxPixels: number;
  ownerBytes: number;
  timeoutMs: number;
}
export const DEFAULT_LIMITS: ArchiveLimits = {
  maxFiles: 20000,
  maxDepth: 24,
  maxFileBytes: 256 * 1024 * 1024,
  maxJsonBytes: 32 * 1024 * 1024,
  maxExpandedBytes: 2 * 1024 ** 3,
  maxCompressedBytes: 1024 ** 3,
  maxCompressionRatio: 200,
  maxRecords: 100000,
  maxPixels: 40_000_000,
  ownerBytes: 5 * 1024 ** 3,
  timeoutMs: 30 * 60 * 1000,
};
export interface ArchiveMedia {
  id: string;
  ownerId: string;
  mime: string;
  size: number;
  sha256: string;
  path: string;
  width: number | null;
  height: number | null;
  purpose: 'original' | 'shared';
  originalId: string | null;
}
export interface ArchiveItem {
  id: string;
  ownerId: string;
  kind: ArchiveKind;
  body: string;
  title: string;
  occurredAt: number | null;
  importedAt: number;
  version: number;
  mediaIds: string[];
  source: string;
  sourceKey: string;
  metadata: Record<string, unknown>;
}
export interface ImportReport {
  added: number;
  revised: number;
  unchanged: number;
  skipped: number;
  failed: number;
  files: number;
  records: number;
  media: number;
  warnings: string[];
}
export interface ImportJob {
  id: string;
  ownerId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: number;
  updatedAt: number;
  completedFiles: number;
  totalFiles: number;
  report: ImportReport | null;
  error: string | null;
}
export interface NormalizedRecord {
  kind: ArchiveKind;
  body: string;
  title: string;
  occurredAt: number | null;
  sourceKey: string;
  source: string;
  metadata: Record<string, unknown>;
  mediaPaths: string[];
  ambiguous: boolean;
}
