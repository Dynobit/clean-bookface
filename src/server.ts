import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { readConfig } from './config.js';
import { createApplication } from './app.js';
import { acquireInstanceLock } from './operations.js';
import { createMaintenanceApplication } from './maintenance.js';
const config = readConfig();
const releaseLock = config.maintenance ? () => {} : acquireInstanceLock(config.dataDir, 'server');
// Release only after every writer has drained; abnormal exits deliberately retain the lock.
const runtime = config.maintenance
  ? { app: createMaintenanceApplication(config), core: undefined, close: async () => {} }
  : createApplication(config, { startWorkers: true });
const server = serve({ fetch: runtime.app.fetch, hostname: config.host, port: config.port }, () => {
  console.log(`Clean Bookface is listening on ${config.host}:${config.port}.`);
  if (config.maintenance)
    console.log(
      'Maintenance mode: accounts are closed and the data volume is available to host commands.',
    );
  if ('store' in runtime && runtime.store.setting('restore_reconciliation_required') === 'true')
    console.log(
      'Restored installation is paused, including login. Stop this process and run reconcile with a newer ledger from the original installation.',
    );
  if (runtime.core && !runtime.core.isSetup())
    console.log(
      'New installation: run the setup command on this server to get your private setup code.',
    );
});
(server as Server).requestTimeout = 30 * 60_000;
(server as Server).headersTimeout = 30_000;
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const overallDeadline = setTimeout(() => {
    console.error(
      'Shutdown did not finish within 50 seconds. Retaining instance lock; verify the stopped process before recovery.',
    );
    process.exit(1);
  }, 50_000);
  const deadline = setTimeout(() => {
    (server as Server).closeAllConnections();
  }, 20_000);
  deadline.unref();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  clearTimeout(deadline);
  await runtime.close();
  clearTimeout(overallDeadline);
  releaseLock();
  process.exit(0);
}
const stop = () =>
  void shutdown().catch(() => {
    console.error('Shutdown failed. Instance lock retained for stopped-process recovery.');
    process.exit(1);
  });
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
