# A measured import, with its limits

The application completed a synthetic **50,000-record import in 17.39 seconds** while five authenticated HTTP readers used it. That result is from one unconstrained development host. It is not a promise about a rented server, a large personal archive, or a particular hosting bill.

## What was actually measured

Run date: 2026-10-02. Runtime: Node.js 24.15.0 on macOS ARM64. The process reported 20 available logical execution slots and no cgroup CPU or memory limit. Other work could run on the host; this was not a dedicated laboratory machine. No host name, user name, machine address or personal data is included in the report.

| Input or condition | Measured value |
| --- | ---: |
| Fictional accounts | 20 |
| Synthetic private posts | 50,000 |
| Segmented JSON files | 50 |
| JSON bytes | 10,484,920 |
| Real generated JPEG files | 100 |
| Original JPEG bytes | 11,195,735 (10.68 MiB) |
| Concurrent HTTP read loops | 5 |
| Pause between each loop's requests | 100 ms |
| Seeded shared posts | 20 |
| Import duration, including worker startup and commit | 17.39 s |
| Stored private records / media | 50,000 / 100 |
| Records visible to another account | 0 |
| Import skips / failures | 0 / 0 |
| HTTP requests during import | 752 |
| HTTP failures or timeouts | 0 |
| Process peak resident memory | 545.20 MiB |
| Import CPU time, user + system | 13.71 s |

The JPEGs are 640 × 360 coloured noise generated with fixed seeds. They exercise actual image validation and decoding without using anyone's photographs. Photos are attached to the first 100 synthetic posts. The importer uses its normal worker, staging tables, quotas, original-media storage and final transaction. Twenty accounts and a small shared feed are created through the normal core services. The import is private; it creates no social posts.

HTTP timings include consuming each complete response over a loopback HTTP socket. Five clients cycle through authenticated feed, archive JSON, archive HTML, photos HTML and health routes. The clients run in the same Node process as the HTTP server and add some CPU and memory overhead. These timings do not include browser rendering or fetching every image in a page.

| Route | Requests | Median | 95th percentile | Maximum |
| --- | ---: | ---: | ---: | ---: |
| Feed JSON | 151 | 14.50 ms | 35.40 ms | 195.80 ms |
| Archive JSON | 151 | 7.92 ms | 24.28 ms | 55.85 ms |
| Archive HTML | 150 | 3.07 ms | 33.72 ms | 195.97 ms |
| Photos HTML | 150 | 4.42 ms | 33.58 ms | 195.78 ms |
| Health | 150 | 7.23 ms | 33.00 ms | 58.65 ms |
| All measured requests | 752 | 8.75 ms | 33.72 ms | 195.97 ms |

A 20-request health baseline before import had a median of 0.60 ms and a 95th percentile of 2.60 ms. The result above is the successful run after the specific correctness/performance fix described below. It is not an average over repeated tuning runs.

## What this run found and fixed

The first run staged all 50,000 records by 30.04 seconds but had not finished its final transaction when the application's 60-second maintenance timer fired. Finalization counted and summed the growing archive once per record, producing quadratic work. Maintenance then encountered SQLite write contention and its uncaught error stopped the process.

Finalization now takes one owner record count and exact byte total inside the writer transaction, then updates those counters for each inserted or revised item. A revision subtracts the replaced record's bytes and adds both the replacement and its retained history. The whole import still rolls back if any quota is exceeded. Tests cover the exact byte boundary, revisions, unchanged imports at the count limit, and rollback over either limit. Background maintenance defers known SQLite contention instead of crashing the server.

The next full run produced the measurements above. This is evidence that the identified blocker was removed for this workload, not evidence that every large-archive edge case has been exercised.

## Reproduce it

From a development checkout with dependencies installed:

```sh
node --import tsx scripts/benchmark.ts
```

The script creates an isolated temporary installation, starts a local HTTP listener on an available port, generates only fictional content, measures the run, prints a JSON report and removes its temporary data. It never opens a real account, imports a personal archive, sends federation traffic or changes machine networking. The default import deadline is ten minutes; a timed-out run stops its own import worker and reports failure.

Useful options:

```sh
node --import tsx scripts/benchmark.ts \
  --records 50000 --photos 100 --accounts 20 --readers 5 \
  --think-ms 100 --max-seconds 600 --output /tmp/bookface-benchmark.json
```

A smaller diagnostic run can use `--records 1000 --photos 10`. A small run is not a substitute for the larger measurement. The output includes actual bytes, runtime versions, process RSS, CPU time, endpoint percentiles, counts and cgroup limits where available. Do not publish temporary filesystem paths or add generated databases and archives to the repository.

For a future constrained Linux measurement, the same script can run in a development container with an explicit two-CPU/two-GiB limit. This command installs Linux development dependencies into a separate volume and keeps the source checkout read-only:

```sh
docker run --rm --cpus=2 --memory=2g --memory-swap=2g \
  --mount "type=bind,src=$(pwd),dst=/workspace,readonly" \
  --mount type=volume,src=bookface-benchmark-modules,dst=/workspace/node_modules \
  --tmpfs /tmp:size=1g --workdir /workspace \
  node:24.21.0-bookworm-slim \
  sh -c 'npm ci --ignore-scripts && node --import tsx scripts/benchmark.ts'
```

Inspect the report's `cgroupCpuMax` and `cgroupMemoryMax` before describing that run as constrained. Dependency installation happens before the measured import. The temporary filesystem also consumes container memory. A container's resource limits do not reproduce a hosting provider's storage, CPU scheduling or network behavior.

## What remains unqualified

The JPEG input here is **10.68 MiB**, not 10 GB. This run does not measure upload transfer time, very large media collections, slow disks, archive diversity, browser paint time, concurrent writes, off-host federation delivery, backup duration or restoration under load. The first run exposed maintenance contention; the corrected run completed before that timer interval, while separate tests cover the deferral behavior.

Default parser, storage, pixel and account limits are safeguards defined in the archive module. They are not throughput promises. Likewise, the hosting guide's cost examples are budget estimates, not evidence that those machines passed this workload. A particular VPS or managed platform needs its own bounded run and restore drill before it is called a qualified production host.

## Constrained Pi workload: 25 accounts and 10.06 GiB of originals

On 2026-10-05, a separate run exercised the reviewed Linux ARM64 application
image on the proposed Pi host with **one CPU and 2 GiB of enforced container
memory**. It completed 25 queued imports while five authenticated readers and
one paced writer used the application. This is evidence for the workload below,
not a claim that 1,000 people can use this host or that public hosting is ready.

The exact image ID was
`sha256:1d4bad6043eb0aa3b8757d44c250ba4dd3a949c8cd538e69157bbbad29b83e36`,
using Node.js 24.21.0. The isolated container had no network interface beyond
loopback, no published ports, a private disposable data volume, a read-only root
filesystem, 128 permitted processes and no additional swap allowance. Its own
cgroup reported `cpu.max=100000 100000` and `memory.max=2147483648` before the
workload was admitted. The run had a 25-minute external watchdog and a planned
35 GiB disk envelope; it completed in 509.78 seconds including fixture generation,
verification and export. The test container and volume were removed afterwards,
and their absence was checked. Other installations were not stopped or modified.

### Workload and observed results

Each of 25 fictional accounts received 1,000 private posts and 125 JPEGs, with
a 1 GiB per-account archive allowance. The generated JPEGs use 25 deterministic
2048 × 2048 noise patterns, one pattern per account. Each file contains a unique
valid JPEG comment so that content hashing does not deduplicate it. The bytes
were physically written, imported, decoded and retained; this is repeated
synthetic imagery, not a collection of naturally varied photographs.

| Input or result | Measured value |
| --- | ---: |
| Accounts / queued import jobs | 25 / 25 |
| Private records retained | 25,000 |
| JPEG originals retained | 3,125 |
| Original media bytes | 10,801,491,500 (10.060 GiB) |
| Input JSON bytes | 3,034,275 |
| Fixture preparation | 76.28 s |
| All queued imports completed | 317.41 s |
| Longest observed wait before an import ran | 305.84 s |
| Import skips / failures | 0 / 0 |
| Concurrent HTTP reads | 7,700 |
| Concurrent post writes accepted / attempted | 157 / 157 |
| HTTP errors or timeouts | 0 |
| Original media hashes and sizes verified | All 3,125 |
| Cross-account private-record checks denied | 25 / 25 |
| Peak process resident memory | 503.72 MiB |
| Container OOM events / OOM kills | 0 / 0 |

The queue measurement matters: the worker processes imports sequentially. A
responsive feed does not mean every queued archive appears immediately. The
last account waited about five minutes in this simultaneous-import workload.

Five readers each paused 200 ms between requests and cycled through feed JSON,
archive JSON, archive HTML, photos HTML and health. A writer posted every two
seconds, rotating through the accounts. The clients and HTTP server shared a
process, as in the earlier benchmark; their overhead is included. Reads consumed
the full response body but did not render a browser or fetch every photo.

| Route or action | Requests | Median | 95th percentile | Maximum |
| --- | ---: | ---: | ---: | ---: |
| Feed JSON | 1,540 | 3.55 ms | 5.78 ms | 91.26 ms |
| Archive JSON | 1,540 | 3.19 ms | 7.61 ms | 67.05 ms |
| Archive HTML | 1,540 | 5.57 ms | 10.53 ms | 86.98 ms |
| Photos HTML | 1,540 | 6.16 ms | 10.99 ms | 86.87 ms |
| Health | 1,540 | 1.42 ms | 5.79 ms | 76.96 ms |
| Post writes | 157 | 6.29 ms | 50.24 ms | 546.71 ms |

After imports and concurrent clients finished, one account's complete HTTP
export streamed **432,493,603 bytes (412.46 MiB) in 52.99 seconds**. The response
headers arrived after 66.17 ms; that field is labelled `firstByteMs` in the
private receipt, but it measures response-header availability, not a separately
instrumented first body byte. Both nested ZIPs were opened. The export contained
1,000 archive records and all 125 expected media hashes. This was one account's
export after the concurrent workload, not 25 simultaneous exports.

### Memory enforcement and the initial failed attempt

The first attempt stopped before generating fixtures or sending application
requests: Docker reported no memory-limit support, and the container had no
`memory.max`. Its requested `--memory=2g` had been ignored. That failed preflight
receipt is retained; it is not counted as a successful constrained measurement.
Following the separately authorized host correction, the same application image
and unchanged workload harness passed with actual kernel limits present.

During the successful run, total cgroup memory reached its 2 GiB limit. Cgroup
accounting includes filesystem cache as well as process memory; the harness did
not record a complete breakdown. The final kernel counter recorded 36,574 `max`
events, with zero
`oom` and zero `oom_kill` events. Those limit-pressure events are not the
application's resident memory, and they are not OOM kills. The kernel's recorded
peak was 2,147,516,416 bytes, slightly above the configured limit. The 503.72 MiB process RSS above is a separate measurement. This
run does not establish the absence of memory pressure under other workloads.

### Evidence boundaries

The private harness adapts the existing benchmark's setup, normal import worker,
authenticated HTTP loops and measurements to the compiled release image. It adds
per-account media volume, paced writes, full original-media hash verification
and account-export verification. The sanitized report's SHA-256 is
`081a280abc07d10d4ec72e569f0f7998200d5a53f07d74dc9780395b7552e625`.
Private execution receipts and generated archives are not shipped in this
repository. The smaller development benchmark above is not a command that
reproduces this larger run unchanged.

Imports were enqueued internally from synthetic directories. This did **not**
measure browser uploads, Internet transfer, Cloudflare, DNS, TLS, natural archive
diversity, device rendering, federation, backups or restoration under load. The
harness replaced the image's ordinary server command and listened on an ephemeral
loopback port. Consequently the unchanged Docker health probe for port 3000
reported unhealthy even though all 1,540 measured health requests to the harness
port succeeded. Normal image startup and production health require their own
checks; they are not established by this application workload test.

The result supports starting with the proposed small invited trial once its
separate deployment, recovery and public-route checks pass. It does not justify
increasing the account limit, guaranteeing service availability, or presenting
the earlier unconstrained development measurement as a provider benchmark.
