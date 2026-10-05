/** Synthetic, bounded measurement. This is not a production load generator. */
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir, arch, platform, availableParallelism } from 'node:os';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { serve } from '@hono/node-server';
import sharp from 'sharp';
import { createApplication } from '../src/app.js';

type Runtime = ReturnType<typeof createApplication>;
const argv = process.argv.slice(2);
const setting = (name: string, fallback: string): string => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : (argv[i + 1] ?? fallback);
};
function integer(name: string, fallback: number, min: number, max: number): number {
  const value = Number(setting(name, String(fallback)));
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${name} must be between ${min} and ${max}`);
  return value;
}
const records = integer('--records', 50_000, 100, 100_000);
const photos = integer('--photos', 100, 0, Math.min(records, 1000));
const accounts = integer('--accounts', 20, 5, 100);
const readerCount = integer('--readers', 5, 1, 10);
const maxSeconds = integer('--max-seconds', 600, 30, 1800);
const thinkMs = integer('--think-ms', 100, 20, 2000);
const output = setting('--output', '');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const mib = (bytes: number) => Math.round((bytes / 1024 ** 2) * 100) / 100;
const round = (n: number) => Math.round(n * 100) / 100;
async function cgroup(name: string): Promise<string | null> {
  try {
    return (await readFile(`/sys/fs/cgroup/${name}`, 'utf8')).trim();
  } catch {
    return null;
  }
}
function summary(values: number[]): {
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
} {
  values.sort((a, b) => a - b);
  const percentile = (p: number) =>
    values.length
      ? round(values[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)]!)
      : null;
  return {
    count: values.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    maxMs: values.length ? round(values.at(-1)!) : null,
  };
}
async function generate(
  input: string,
): Promise<{ jsonBytes: number; photoBytes: number; jsonFiles: number }> {
  await mkdir(join(input, 'photos'), { recursive: true });
  let photoBytes = 0;
  let jsonBytes = 0;
  // Deterministic coloured noise exercises JPEG decoding without any real photographs.
  for (let i = 0; i < photos; i++) {
    let seed = (i + 1) * 123457;
    const bytes = Buffer.alloc(640 * 360 * 3);
    for (let j = 0; j < bytes.length; j++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      bytes[j] = seed & 255;
    }
    const path = join(input, 'photos', `synthetic-${i}.jpg`);
    await sharp(bytes, { raw: { width: 640, height: 360, channels: 3 } })
      .jpeg({ quality: 65 })
      .toFile(path);
    photoBytes += (await lstat(path)).size;
  }
  const chunks = Math.ceil(records / 1000);
  for (let n = 0; n < chunks; n++) {
    const entries = [];
    for (let i = n * 1000; i < Math.min((n + 1) * 1000, records); i++)
      entries.push({
        id: `synthetic-benchmark-${i}`,
        timestamp: 946684800 + i * 60,
        data: [
          {
            post: `Fictional memory ${i}. A walk, a shared meal, a new notebook. Café שלום 🌿. This generated record contains no personal data.`,
          },
        ],
        ...(i < photos
          ? { attachments: [{ data: [{ media: { uri: `photos/synthetic-${i}.jpg` } }] }] }
          : {}),
      });
    const text = JSON.stringify(entries);
    jsonBytes += Buffer.byteLength(text);
    await writeFile(join(input, `your_posts_${n + 1}.json`), text, { mode: 0o600 });
  }
  return { jsonBytes, photoBytes, jsonFiles: chunks };
}

const root = await mkdtemp(join(tmpdir(), 'bookface-synthetic-benchmark-'));
let runtime: Runtime | undefined;
const server = serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: (request) =>
    runtime ? runtime.app.fetch(request) : new Response('Starting', { status: 503 }),
});
await new Promise<void>((resolve) =>
  server.listening ? resolve() : server.once('listening', resolve),
);
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Benchmark listener unavailable');
const origin = `http://127.0.0.1:${address.port}`;
let stopReaders = false;
let sampler: ReturnType<typeof setInterval> | undefined;
const readings: Array<Promise<void>> = [];
let peakRss = process.memoryUsage().rss;
let importPeakRss = 0;
let cgroupPeak = 0;
let report: Record<string, unknown> | undefined;
try {
  const fixtureStart = performance.now();
  const input = join(root, 'input');
  const inputStats = await generate(input);
  runtime = createApplication({
    origin,
    dataDir: join(root, 'data'),
    host: '127.0.0.1',
    port: address.port,
    production: false,
    federation: false,
    maxUploadBytes: 1024 ** 3,
    instanceName: 'Synthetic benchmark circle',
  });
  const password = randomBytes(24).toString('base64url');
  const users = [];
  users.push(
    (
      await runtime.core.setup({
        username: 'member000',
        displayName: 'Fictional Member 0',
        password,
      })
    ).user,
  );
  for (let i = 1; i < accounts; i++) {
    const inviter = users[Math.floor((i - 1) / 9)]!;
    const invite = runtime.core.createInvite(inviter.id, 'registration');
    users.push(
      (
        await runtime.core.register({
          username: `member${String(i).padStart(3, '0')}`,
          displayName: `Fictional Member ${i}`,
          password,
          inviteToken: invite.token,
        })
      ).user,
    );
  }
  // A small populated feed exercises audience and session queries during the import.
  for (const user of users.slice(1, Math.min(accounts, 20)))
    runtime.core.acceptFriend(user.id, runtime.core.requestFriend(users[0]!.id, user.actor));
  for (let i = 0; i < 20; i++)
    runtime.core.publish(users[0]!.id, { body: `Fictional shared post ${i}`, audience: 'friends' });
  const sessions = users
    .slice(0, Math.max(5, readerCount))
    .map((user) => runtime!.core.createSession(user.id));
  const baseline: number[] = [];
  for (let i = 0; i < 20; i++) {
    const started = performance.now();
    const response = await fetch(`${origin}/healthz`);
    await response.arrayBuffer();
    if (!response.ok) throw new Error('Baseline health request failed');
    baseline.push(performance.now() - started);
  }
  const generationSeconds = (performance.now() - fixtureStart) / 1000;
  const duration: number[] = [];
  const health: number[] = [];
  const endpoints: Record<string, number[]> = {};
  const failures: Record<string, number> = {};
  let responseBytes = 0;
  const routes = ['/api/feed', '/api/archive', '/archive', '/photos', '/healthz'];
  sampler = setInterval(() => {
    const rss = process.memoryUsage().rss;
    peakRss = Math.max(peakRss, rss);
    importPeakRss = Math.max(importPeakRss, rss);
    void cgroup('memory.current').then((value) => {
      if (value && value !== 'max') cgroupPeak = Math.max(cgroupPeak, Number(value));
    });
  }, 100);
  sampler.unref();
  const cpuStart = process.cpuUsage();
  const started = performance.now();
  const importId = runtime.archive.enqueueImport(users[0]!.id, input);
  runtime.start();
  for (let reader = 0; reader < readerCount; reader++)
    readings.push(
      (async () => {
        let turn = reader;
        while (!stopReaders) {
          const path = routes[turn++ % routes.length]!;
          const begin = performance.now();
          try {
            const response = await fetch(`${origin}${path}`, {
              headers: { cookie: `bookface=${sessions[reader % sessions.length]!.token}` },
              signal: AbortSignal.timeout(10000),
            });
            responseBytes += (await response.arrayBuffer()).byteLength;
            if (response.status !== 200)
              failures[`HTTP ${response.status}`] = (failures[`HTTP ${response.status}`] ?? 0) + 1;
          } catch {
            failures['request failed or timed out'] =
              (failures['request failed or timed out'] ?? 0) + 1;
          }
          const elapsed = performance.now() - begin;
          duration.push(elapsed);
          (endpoints[path] ??= []).push(elapsed);
          if (path === '/healthz') health.push(elapsed);
          await sleep(thinkMs);
        }
      })(),
    );
  let nextProgress = Date.now() + 30000;
  let timedOut = false;
  while (true) {
    const job = runtime.archive.job(users[0]!.id, importId)!;
    if (['completed', 'failed', 'cancelled'].includes(job.status)) break;
    if ((performance.now() - started) / 1000 >= maxSeconds) {
      timedOut = true;
      await runtime.archive.stopWorker();
      break;
    }
    if (Date.now() >= nextProgress) {
      console.error(
        JSON.stringify({
          phase: 'import',
          elapsedSeconds: round((performance.now() - started) / 1000),
          status: job.status,
          completedFiles: job.completedFiles,
          totalFiles: job.totalFiles,
          stagedRecords: job.report?.records ?? 0,
          peakRssMiB: mib(importPeakRss),
        }),
      );
      nextProgress = Date.now() + 30000;
    }
    await sleep(100);
  }
  const importSeconds = (performance.now() - started) / 1000;
  const cpu = process.cpuUsage(cpuStart);
  stopReaders = true;
  await Promise.all(readings);
  clearInterval(sampler);
  sampler = undefined;
  const job = runtime.archive.job(users[0]!.id, importId)!;
  const storedRecords = runtime.archive.count(users[0]!.id);
  const visibleToOther = runtime.archive.count(users[1]!.id);
  const storedMedia = Number(
    runtime.store.db
      .prepare('SELECT count(*) AS n FROM archive_media WHERE owner_id=? AND pending_job IS NULL')
      .get(users[0]!.id)!.n,
  );
  const rss = process.memoryUsage().rss;
  peakRss = Math.max(peakRss, rss, process.resourceUsage().maxRSS * 1024);
  report = {
    format: 'clean-bookface-benchmark/1',
    measuredAt: new Date().toISOString(),
    runtime: {
      node: process.version,
      platform: platform(),
      architecture: arch(),
      availableParallelism: availableParallelism(),
      cgroupCpuMax: await cgroup('cpu.max'),
      cgroupMemoryMax: await cgroup('memory.max'),
    },
    workload: {
      accounts,
      concurrentReaders: readerCount,
      thinkTimeMs: thinkMs,
      requestedRecords: records,
      generatedPhotos: photos,
      jsonFiles: inputStats.jsonFiles,
      jsonBytes: inputStats.jsonBytes,
      originalPhotoBytes: inputStats.photoBytes,
      synthetic: true,
      uploadsIncludedInTiming: false,
      federationEnabled: false,
    },
    preparationSeconds: round(generationSeconds),
    import: {
      status: timedOut ? 'timed out' : job.status,
      maxSeconds,
      elapsedSeconds: round(importSeconds),
      storedRecords,
      storedMedia,
      visibleRecordsForOtherAccount: visibleToOther,
      report: job.report,
      error: job.error,
      recordsPerSecond: job.status === 'completed' ? round(records / importSeconds) : null,
    },
    httpDuringImport: {
      ...summary(duration),
      endpointMetrics: Object.fromEntries(
        Object.entries(endpoints).map(([path, times]) => [path, summary(times)]),
      ),
      health: summary(health),
      failures,
      responseBytes,
    },
    baselineHealth: summary(baseline),
    resourceUsage: {
      peakProcessRssMiB: mib(peakRss),
      sampledImportRssMiB: mib(importPeakRss),
      sampledCgroupMemoryMiB: cgroupPeak ? mib(cgroupPeak) : null,
      cpuUserSeconds: round(cpu.user / 1e6),
      cpuSystemSeconds: round(cpu.system / 1e6),
      cpuSecondsPerImportWallSecond: round((cpu.user + cpu.system) / 1e6 / importSeconds),
    },
    limitations: [
      'One synthetic run; not a capacity guarantee.',
      'HTTP readers run in the same process as the server, adding CPU/memory overhead.',
      'No browser rendering, Internet latency, remote federation, upload transfer, or backup was measured.',
      'Actual cgroup limits are reported when present; an unconstrained host does not qualify a small VPS.',
      'The generated media size is reported in bytes and is not a 10 GB archive test.',
    ],
  };
  if (
    job.status !== 'completed' ||
    storedRecords !== records ||
    storedMedia !== photos ||
    visibleToOther !== 0 ||
    Object.keys(failures).length
  )
    process.exitCode = 1;
} catch (error) {
  process.exitCode = 1;
  report = {
    format: 'clean-bookface-benchmark/1',
    measuredAt: new Date().toISOString(),
    status: 'failed',
    error:
      error instanceof Error
        ? error.message.replaceAll(root, '[temporary benchmark directory]')
        : 'Benchmark failed',
  };
} finally {
  stopReaders = true;
  if (sampler) clearInterval(sampler);
  await Promise.allSettled(readings);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (runtime) await runtime.close();
  await rm(root, { recursive: true, force: true });
}
const text = `${JSON.stringify(report, null, 2)}\n`;
if (output) await writeFile(resolve(output), text, { mode: 0o600 });
console.log(text);
