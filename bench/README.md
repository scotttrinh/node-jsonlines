# Benchmarks

Tinybench **6.2.3** measures the Transform API against the exact published
`jsonlines@0.1.1` (the `jsonlines-legacy` npm alias). Both are development
dependencies; the library still has zero runtime dependencies.

```sh
npm ci
npm run bench:quick
npm run bench -- --output bench/results.local.json
npm run bench -- --scenario parse-small --processes 7 --time 5000 --iterations 100
```

`bench:quick` checks that the workloads run and validate. Its results are labeled
**smoke-only** and must not be used to claim a speedup. A full default suite takes
several minutes per Node version. Workers run sequentially, never in competition.

## Warm-up and measurement

Each implementation/scenario gets **seven fresh processes**, organized into
pairs with the same corpus seed. Implementation order alternates between pairs.
Fixtures are built outside the timer. A correctness preflight runs once, then GC
runs before warm-up. There is no forced GC between warm-up and measurement or
between measured iterations; normal allocation and collection costs are included.

Tinybench warms each worker in windows of **at least 500 ms and eight complete
workloads**. Warm-up requires two consecutive changes in window median latency
within 5%, so it takes at least three windows (1.5 seconds by default). It stops
after eight windows if this heuristic does not converge. Every window and its raw
timings are retained. An unconverged worker makes the comparison inconclusive;
this is an operational stability check, not proof that all JIT activity stopped.

After warm-up, Tinybench measures for **at least three seconds and 50 iterations**,
using `process.hrtime.bigint()` with concurrency disabled. Each iteration constructs
fresh streams and runs an entire pipeline, including source/sink work and teardown.
It processes 10,000 records by default (five 256 KiB records for the large-record
case). Assertions run in Tinybench's `afterEach` hook, outside the timed body.
Every iteration checks byte count or record count, ID checksum and text length.

Tinybench exports mean, sample SD, percentiles, relative margin of error and every
measured latency sample. Rates use bytes or records divided by **mean latency**,
rather than the biased mean of instantaneous reciprocal rates. Ordered timings
are also retained to show first-third versus last-third measurement drift.

## Distinguishing an improvement from noise

The independent statistical unit is a **process pair**. Hundreds of iterations
inside one warmed process are not treated as hundreds of independent launches.
For each pair, the runner takes `log(legacy mean latency / modern mean latency)`.
It computes a two-sided **95% Student t interval across the seven log ratios**,
then exponentiates the mean and bounds. A ratio above 1 favors modern. This
assumes approximately independent, normally distributed process-level log ratios.
For more than 31 processes, the df=30 critical value conservatively widens the CI.

The default practical threshold is **5%**, chosen before running:

- **meaningfully-faster**: the entire ratio interval is above 1.05.
- **meaningfully-slower**: the entire interval is below 0.95.
- **within-practical-band**: the entire interval lies within [0.95, 1.05].
- **inconclusive**: the interval cannot establish any of those conclusions.
- **inconclusive-warmup**: at least one process exhausted its warm-up budget.

A statistically detectable 0.1% gain is therefore not reported as a meaningful
improvement. An interval can exclude 1 yet remain inconclusive about a 5% effect;
that is different from saying there is no detectable difference. Verdicts use
unrounded bounds. Reports show SD/CV between process means, plus Tinybench SD/CV/RME
within every process. The confidence intervals are **per scenario**, exploratory,
and not corrected for testing multiple scenarios or Node versions. They are not
a simultaneous guarantee about the entire suite. Shared-host scheduling, CPU
frequency changes, process order and GC can still affect results. Prefer the
recorded intervals and drift diagnostics to tiny differences in point estimates;
confirm performance on deployment hardware before setting regression thresholds.

## Fixtures and memory diagnostics

Timing fixtures contain a deterministic corpus with distinct IDs, varied lengths,
ASCII/Unicode text, two object shapes, arrays and nested objects. A process pair
uses the same seed; subsequent pairs use different seeds. This replaces the old
benchmark's single identical record. Repeating a finite corpus still permits
engine caches; it does not model every production dataset.

Scenarios cover 64 KiB input chunks, Unicode chunks ending at LF, a modern-only
1 MiB line limit, seven-byte ASCII chunks, 256 KiB records fragmented into 1 KiB
chunks, one expanding chunk with a slow sink, and ASCII/Unicode serialization.
The baseline cannot enforce line limits. Fragmented comparisons use ASCII because
the old parser corrupts split UTF-8. Both versions use identical byte/object
sources and sinks, including UTF-8 encoding of the old stringifier's strings.
Async iterable promise costs are not measured by these Transform benchmarks.

Memory and queue measurements run in **separate workers**, without importing
Tinybench or collecting timing samples. They process 300,000 records (150 large
records) from a bounded pool of at most 1,024 varied objects, or four large objects.
The backpressure case assembles the requested single large byte chunk. This
keeps fixture allocation from scaling with the number of decoded objects and
makes buffering visible. These diagnostics are not used in the speed comparison.
They run one preflight, GC, then one observed pass. RSS is the **whole-process
high-water mark**, including fixture construction and preflight, rather than live
allocation or a memory confidence interval. Queue counts sample the parser and
sink together only while the slow sink is stalled.

## Artifacts and controls

`--output bench/results.local.json` writes a readable process-level summary and
`bench/results.local.samples.json.gz` containing the full Tinybench results,
ordered measurements and warm-up samples. Artifacts are checkpointed between
workers; only a completed suite has `complete: true`. Compression and writes run
outside every measurement. CI's manual benchmark job uploads both files.

Useful controls (times are milliseconds):

```sh
npm run bench -- --scenario stringify-small --records 20000 --time 5000
npm run bench -- --warmup-time 1000 --warmup-iterations 16 --warmup-windows 10
npm run bench -- --processes 11 --threshold-percent 5 --memory-records 1000000
```

To run another installed Node version, build first and run the orchestrator with
that binary; child workers automatically use the same executable:

```sh
npm run build
npm exec --yes --package=node@26 -- node bench/run.js --output bench/results.local.json
```

Raw samples can be read without additional tools:

```js
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
const raw = JSON.parse(
  gunzipSync(readFileSync('bench/results.local.samples.json.gz')),
)
console.log(raw.runs[0].latency)
```

## Recorded results

Recorded on 2026-11-05 on Linux x64, Intel Xeon 2.90 GHz, four logical CPUs.
There are seven independent process pairs per row. MiB/s columns show the mean
± sample SD **between processes**, not the smaller error across inner iterations.
Ratios are geometric means of paired legacy/modern mean latencies, with 95%
per-scenario intervals. These new corpus/batch sizes supersede the one-shot
measurements; compare implementations within each row, not across protocols.

### Node 22.23.4

[Summary](results-node22.json) · [Full samples](results-node22.samples.json.gz)

| Scenario           | Modern MiB/s ± SD | Legacy MiB/s ± SD |            Ratio [95% CI] | Decision           |
| ------------------ | ----------------: | ----------------: | ------------------------: | ------------------ |
| parse-small        |       116.1 ± 9.4 |      119.7 ± 14.2 |    0.973 [0.8231, 1.1499] | Warm-up warning    |
| parse-unicode      |       83.4 ± 13.3 |        87.3 ± 9.9 |    0.949 [0.8415, 1.0704] | Inconclusive at 5% |
| parse-limited      |       116.6 ± 9.7 |      116.6 ± 17.8 |    1.008 [0.8236, 1.2335] | Inconclusive at 5% |
| parse-fragmented   |        18.3 ± 2.6 |        12.0 ± 0.7 |    1.504 [1.2802, 1.7673] | ≥5% gain supported |
| parse-large-record |      402.2 ± 22.5 |        15.1 ± 0.9 | 26.571 [24.8581, 28.4009] | Warm-up warning    |
| parse-backpressure |        81.2 ± 7.6 |        82.3 ± 9.8 |    0.988 [0.8525, 1.1444] | Warm-up warning    |
| stringify-small    |       127.7 ± 4.3 |        93.8 ± 6.6 |    1.364 [1.2676, 1.4676] | ≥5% gain supported |
| stringify-unicode  |       73.9 ± 11.6 |        75.0 ± 5.2 |    0.975 [0.8085, 1.1756] | Inconclusive at 5% |

### Node 26.13.0

[Summary](results-node26.json) · [Full samples](results-node26.samples.json.gz)

| Scenario           | Modern MiB/s ± SD | Legacy MiB/s ± SD |            Ratio [95% CI] | Decision           |
| ------------------ | ----------------: | ----------------: | ------------------------: | ------------------ |
| parse-small        |       140.4 ± 4.0 |       142.4 ± 7.4 |    0.987 [0.9392, 1.0375] | Inconclusive at 5% |
| parse-unicode      |      130.7 ± 12.3 |      126.3 ± 10.0 |    1.033 [0.9196, 1.1604] | Inconclusive at 5% |
| parse-limited      |       134.9 ± 6.5 |       144.2 ± 6.5 |    0.936 [0.8840, 0.9904] | Inconclusive at 5% |
| parse-fragmented   |        24.3 ± 1.1 |        13.6 ± 0.7 |    1.782 [1.6559, 1.9182] | Warm-up warning    |
| parse-large-record |      740.8 ± 13.6 |        56.3 ± 2.8 | 13.174 [12.5639, 13.8144] | Warm-up warning    |
| parse-backpressure |       108.8 ± 4.3 |       121.3 ± 2.2 |    0.897 [0.8549, 0.9402] | ≥5% loss supported |
| stringify-small    |       114.3 ± 3.8 |       103.6 ± 2.6 |    1.103 [1.0499, 1.1587] | Inconclusive at 5% |
| stringify-unicode  |        82.7 ± 5.3 |        80.0 ± 3.9 |    1.033 [0.9794, 1.0896] | Inconclusive at 5% |

The Node 22 runs support about 50% faster seven-byte-fragment parsing (95% CI
+28% to +77%) and 36% faster ASCII serialization (+27% to +47%). Ordinary
small-record parser improvements are not established. Node 26 ASCII serialization
has a positive effect estimate of about 10%, but its unrounded lower bound falls
slightly below the predeclared 5% threshold. It remains inconclusive at that bar.

The timed 10,000-record backpressure case is about 10% slower on Node 26
(95% ratio interval 0.8549–0.9402). The separate 300,000-record memory probe queued
32 objects versus 299,985; peak RSS was 99.8 / 220.4 MiB on Node 22 and
105.8 / 257.2 MiB on Node 26 (modern / legacy). These are different batch sizes:
the memory probe does not establish throughput at 300,000 records.

Six Node 22 workers and two Node 26 workers exhausted the warm-up budget.
Rows marked **Warm-up warning** retain all samples and their intervals, but are
not accepted as clean steady-state wins. In particular, the large-record effect
is substantial while its exact steady-state multiplier remains qualified.
No outliers or failed convergence checks were silently removed.

## Profiling

Profile a worker rather than the process orchestrator. Profiling changes timing
and memory overhead, so keep its output separate from the comparative artifacts:

```sh
npm run build
node --expose-gc --cpu-prof bench/worker.js modern parse-small
node --expose-gc --heap-prof bench/worker.js modern parse-backpressure
node --expose-gc --trace-gc bench/worker.js legacy stringify-unicode
```

Replace `modern` with `legacy` to profile the baseline. Inspector profiles may be
opened in Chrome DevTools. Keep profiles outside version control.
