import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';

/** One local durable database; never place this directory on a network filesystem. */
export class Store {
  readonly db: DatabaseSync;
  readonly dataDir: string;
  readonly path: string;
  private depth = 0;
  constructor(dataDir: string, options: { filename?: string } = {}) {
    this.dataDir = resolve(dataDir);
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.path = resolve(this.dataDir, options.filename ?? 'bookface.sqlite');
    this.db = new DatabaseSync(this.path);
    chmodSync(this.path, 0o600);
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;',
    );
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS instance_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schema_versions (component TEXT PRIMARY KEY, version INTEGER NOT NULL);`);
  }
  transaction<T>(fn: () => T): T {
    const level = this.depth++;
    const savepoint = `tx_${level}`;
    try {
      this.db.exec(level === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
      const value = fn();
      if (value instanceof Promise) throw new Error('Database transactions must be synchronous');
      this.db.exec(level === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
      return value;
    } catch (error) {
      try {
        this.db.exec(level === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      } catch {
        /* preserve original error */
      }
      throw error;
    } finally {
      this.depth--;
    }
  }
  setting(key: string): string | null {
    return (
      (
        this.db.prepare('SELECT value FROM instance_settings WHERE key=?').get(key) as
          { value: string } | undefined
      )?.value ?? null
    );
  }
  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO instance_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, value);
  }
  close(): void {
    this.db.close();
  }
}

/** SQLite extended result codes retain the primary lock code in their low byte. */
export function isDatabaseBusy(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('errcode' in error)) return false;
  const code = Number(error.errcode) & 255;
  return code === 5 || code === 6;
}
