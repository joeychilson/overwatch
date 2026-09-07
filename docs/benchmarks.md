# History performance baseline

Run from the repository root with the development prerequisites installed:

```sh
vp run benchmark
```

This runs an optimized Rust benchmark against synthetic JSONL histories, then
benchmarks the actual frontend aggregation functions against the resulting native
snapshots. No application launch, credentials, real histories, or network access
are needed. The first run may spend several minutes compiling Rust; compilation
is outside the measurements. Benchmarks are opt-in, outside the normal test suite.

## Workloads

| Fixture | Sessions/files | Responses per ordinary session | Large reader events | Total usage records |
| ------- | -------------: | -----------------------------: | ------------------: | ------------------: |
| small   |            100 |                             10 |               2,000 |               1,990 |
| large   |          5,000 |                             40 |              50,000 |             224,960 |

Each fixture includes one large reader session. Histories use the Pi JSONL format,
20 nested project folders, fixed timestamps spread across 365 days, two model
identities, roughly 500-byte message bodies, and both recorded and estimated
costs. Generation is deterministic and excluded from timing. Temporary source
paths and filesystem timestamps vary by run. Fixture version 1 deliberately
isolates history size; it does not represent every adapter, tool payload, or
SQLite/WAL workload.

The harness verifies session counts, usage counts, token totals, reader event
counts, and search result counts before accepting measurements. Source parsing
issues or a supposedly idle scan reporting changes fail the run.

## Measurements

`native.json` contains seven samples per operation, with min/median/max in ms:

- **coldIndexToSnapshot**: open a fresh index, scan all files, load the snapshot,
  and serialize it. Each sample starts with a new index database.
- **cachedOpenToSnapshot**: reopen an existing index and serialize its snapshot,
  without waiting for background reconciliation.
- **idleScan**: an unchanged reconciliation after a warm-up scan. Together with
  corpus file/byte counts, this baselines the cost of each idle polling pass.
- **snapshotRead / snapshotSerialize**: database read/deserialization versus
  serialization of an already-loaded snapshot, measured separately.
- **uncachedReaderOpen**: parse the large transcript and build its timeline using
  a fresh reader cache; opening the index is excluded.
- **firstReaderSearch**: the first case-insensitive sparse search after opening
  each fresh reader, excluding transcript parsing. This keeps first-query cost
  visible if repeated queries gain a match cache in the future.
- **warmReaderSearch**: absent, sparse case-insensitive, broad, and second-page
  searches on an already-open transcript. Broad paging intentionally exposes
  repeated full-transcript search work.
- **snapshotBytes / timelineBytes**: actual serialized payload sizes.

`frontend.json` is Vitest's benchmark report, with timings and statistical
information for snapshot JSON parsing, lifetime and date-scoped aggregation,
the three aggregate calls used by Overview, and full bundled catalog decoding.
File reads and fixture validation are outside timing. Each frontend benchmark
warms up for 250 ms and samples for at least one second and ten iterations.
Pricing fixtures use a small, fixed catalog to isolate usage-volume scaling;
the separate catalog benchmark uses the real bundled catalog.

These are component benchmarks: native cold indexing is **not** full desktop
time-to-first-paint. Frontend timings run in Node, not WKWebView. The filesystem
cache is not flushed, so “cold” means an empty application index, not a cold disk.
Idle timings are wall time per explicit scan, not syscall counts, process CPU,
battery estimates, or watcher wakeup frequency. Use Instruments/File Activity
for those system-level measurements. No artificial polling sleeps are timed.
There are no backend aggregate queries yet; the frontend measurements establish
the baseline for their replacement.

## Comparing revisions

The runner prints a unique directory under the OS temporary directory containing
`environment.json`, `native.json`, and `frontend.json`. Environment metadata records
the Git revision/dirty state, CPU, OS, architecture, Rust and Node versions, and
timezone (fixed to UTC). Synthetic histories are automatically removed; generated
snapshots are removed after a successful frontend run. Partial results remain on
failure for diagnosis. Copy result directories elsewhere if retaining a baseline
across OS temporary-directory cleanup.

Run the same command on each revision, on the same machine and power mode with
other heavy work stopped. Compare native medians and payload bytes and frontend
mean times, checking variability rather than treating one sample as a regression.
Repeat the whole run when results are noisy. Keep fixture versions, toolchains,
and the bundled catalog identical for like-for-like comparisons. Seven native
samples are too few for meaningful tail-percentile claims.

There are intentionally no absolute timing assertions in CI: shared-runner load
would turn them into flaky tests. Count assertions protect benchmark validity;
performance decisions should use locally collected before/after results.
