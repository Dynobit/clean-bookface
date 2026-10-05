import { workerData } from 'node:worker_threads';
import { Store } from '../storage.js';
import { Archive } from '../archive.js';
import sharp from 'sharp';

sharp.concurrency(1);
sharp.cache({ memory: 16, files: 0, items: 16 });

const store = new Store(workerData.dataDir, { filename: workerData.path });
try {
  await new Archive(store, { limits: workerData.limits }).runJob(workerData.jobId);
} catch {
  // The private job report records bounded diagnostics. Never log archive content.
} finally {
  store.db.close();
}
