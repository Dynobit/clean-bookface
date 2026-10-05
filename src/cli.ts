import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readConfig } from './config.js';
import {
  initializeBackup,
  createBackup,
  restoreBackup,
  exportReconciliation,
  reconcileRestore,
  unlockStoppedInstance,
  type BackupOptions,
} from './operations.js';

const config = readConfig();
const [command = 'help', ...args] = process.argv.slice(2);
function option(name: string): string | undefined {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
}
function required(name: string): string {
  const value = option(name);
  if (!value || value.startsWith('--')) throw new Error(`Supply ${name}`);
  return value;
}
function backupOptions(): BackupOptions {
  const {
    RESTIC_REPOSITORY: repository,
    RESTIC_PASSWORD_FILE: passwordFile,
    RECOVERY_PASSWORD_FILE: recoveryPasswordFile,
    RESTIC_BINARY: resticBinary,
  } = process.env;
  if (!repository || !passwordFile || !recoveryPasswordFile)
    throw new Error(
      'Set RESTIC_REPOSITORY, RESTIC_PASSWORD_FILE and RECOVERY_PASSWORD_FILE. See docs/OPERATIONS.md.',
    );
  return { repository, passwordFile, recoveryPasswordFile, resticBinary };
}
function recoverySecret(): string {
  if (!process.env.RECOVERY_PASSWORD_FILE) throw new Error('Set RECOVERY_PASSWORD_FILE');
  return process.env.RECOVERY_PASSWORD_FILE;
}
async function main(): Promise<void> {
  if (command === 'status') {
    const db = new DatabaseSync(join(config.dataDir, 'bookface.sqlite'), { readOnly: true });
    try {
      const get = (key: string) =>
        db.prepare('SELECT value FROM instance_settings WHERE key=?').get(key)?.value ?? null;
      console.log(
        JSON.stringify({
          reconciliationRequired: get('restore_reconciliation_required') === 'true',
          lastBackupAt: get('last_backup_at'),
          lastBackupSnapshot: get('last_backup_snapshot'),
          installationBound: !!get('installation_id'),
        }),
      );
    } finally {
      db.close();
    }
    return;
  }
  if (command === 'setup-token' || command === 'setup') {
    // Deliberately print the one-time setup credential only on explicit operator invocation.
    const code = readFileSync(join(config.dataDir, '.setup-token'), 'utf8').trim();
    if (!/^[a-zA-Z0-9_-]{32,128}$/u.test(code)) throw new Error('Invalid setup code');
    console.log(code);
    return;
  }
  if (command === 'init-backup-secrets') {
    const dir = resolve(required('--directory'));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const name of ['restic-password', 'recovery-password'])
      writeFileSync(join(dir, name), `${randomBytes(32).toString('base64url')}\n`, {
        mode: 0o600,
        flag: 'wx',
      });
    console.log(
      'Two independent owner-only secret files created. Store offline recovery copies separately from the backup repository.',
    );
    return;
  }
  if (command === 'backup-init') {
    await initializeBackup(backupOptions(), config.dataDir);
    console.log('Encrypted backup repository initialized.');
    return;
  }
  if (command === 'backup') {
    const result = await createBackup(config.dataDir, config.origin, backupOptions());
    console.log(JSON.stringify(result));
    return;
  }
  if (command === 'restore') {
    const result = await restoreBackup(
      required('--target'),
      config.origin,
      required('--snapshot'),
      backupOptions(),
    );
    console.log(
      `Restored backup ${result.backupId}. Sharing remains disabled pending current-state reconciliation.`,
    );
    return;
  }
  if (command === 'reconciliation-export') {
    await exportReconciliation(config.dataDir, recoverySecret(), required('--output'));
    console.log(
      'Encrypted current-state ledger exported. Keep it private and newer than any backup you restore.',
    );
    return;
  }
  if (command === 'reconcile') {
    await reconcileRestore(config.dataDir, config.origin, required('--ledger'), recoverySecret());
    console.log(
      'Current-state reconciliation applied. Old sessions, invitation links, recovery codes and in-flight uploads were invalidated.',
    );
    return;
  }
  if (command === 'unlock') {
    if (!args.includes('--stopped'))
      throw new Error('Verify the application stopped, then use unlock --stopped');
    unlockStoppedInstance(
      config.dataDir,
      option('--container-inspect')
        ? { inspectFile: required('--container-inspect'), lockToken: required('--lock-token') }
        : undefined,
    );
    console.log(
      'Lock removed using stopped-process evidence. Keep other instances stopped until the next start.',
    );
    return;
  }
  console.log(
    `Clean Bookface host commands\n\nstatus                      Read backup and restore-pause status without opening the application\nsetup-token                 Print the initial setup code\ninit-backup-secrets --directory DIR\nbackup-init                 Initialize the encrypted restic repository\nbackup                      Take a complete offline backup\nrestore --target EMPTY_DIR --snapshot ID\nreconciliation-export --output NEW_FILE\nreconcile --ledger CURRENT_ENCRYPTED_FILE\nunlock --stopped             Remove a same-host lock only when its process no longer exists\nunlock --stopped --container-inspect FILE --lock-token TOKEN\n                            Explicit recovery using exact stopped-container evidence\n\nConfiguration: DATA_DIR, APP_ORIGIN, RESTIC_REPOSITORY, RESTIC_PASSWORD_FILE,\nRECOVERY_PASSWORD_FILE, optional RESTIC_BINARY. See docs/OPERATIONS.md.`,
  );
  if (command !== 'help') process.exitCode = 1;
}
try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Operation failed');
  process.exitCode = 1;
}
