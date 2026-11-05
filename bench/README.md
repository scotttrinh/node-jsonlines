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
They run one preflight, GC, then one observed pass. On Linux, RSS uses
`/proc/self/status`'s **VmHWM**, including fixture construction and preflight,
rather than live allocation or a memory confidence interval. The report records
`peakRssSource`; other platforms fall back to `resourceUsage().maxRSS`. The raw
resource-usage value is also retained as `resourceUsageMaxRssMiB`. Linux rusage
can retain the spawning process's resident footprint across `exec()`, inflating
apparent worker peaks. VmHWM resets with the executable's address space and avoids
that contamination. The initial recorded RSS values below used rusage and are
superseded by the follow-up probes. Queue counts sample the parser and sink
together only while the slow sink is stalled.

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

To compare an optimization with a previous revision, build that revision in a
separate checkout and pass its ESM entry point. The same workloads, seeds and
process-pair protocol then compare the two versions in one session:

```sh
git worktree add --detach /tmp/jsonlines-before 934eaef
npm --prefix /tmp/jsonlines-before ci
npm --prefix /tmp/jsonlines-before run build
npm run bench -- --baseline /tmp/jsonlines-before/dist/index.js \
  --scenario stringify-small --scenario stringify-unicode \
  --output bench/results.local.json
```

The configuration and environment record the baseline module. For compatibility,
the reference implementation is still called `legacy` inside the JSON schema,
even when `--baseline` selects a previous ESM build. Omitting that flag always
compares with published `jsonlines@0.1.1`.

## Initial recorded results

Recorded on 2026-11-05 on Linux x64, Intel Xeon 2.90 GHz, four logical CPUs.
There are seven independent process pairs per row. MiB/s columns show the mean
± sample SD **between processes**, not the smaller error across inner iterations.
Ratios are geometric means of paired legacy/modern mean latencies, with 95%
per-scenario intervals. These new corpus/batch sizes supersede the one-shot
measurements; compare implementations within each row, not across protocols.
The stringifier follow-up below supersedes these initial serialization results;
the parser implementation at that point is unchanged. See the parser ablation
follow-up below for the simplification comparison.

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
32 objects versus 299,985. Its original rusage-based RSS readings are superseded
by the corrected VmHWM probes below. These are different batch sizes: the memory
probe does not establish throughput at 300,000 records.

Six Node 22 workers and two Node 26 workers exhausted the warm-up budget.
Rows marked **Warm-up warning** retain all samples and their intervals, but are
not accepted as clean steady-state wins. In particular, the large-record effect
is substantial while its exact steady-state multiplier remains qualified.
No outliers or failed convergence checks were silently removed.

## Batched encoding follow-up

The stringifier now collects at most 64 records within the byte target and uses
one native `join()` and UTF-8 encoding per batch. This removes manual buffer
growth, copying during growth, and per-record UTF-8 writes. The record cap bounds
reference-array metadata even for tiny values. Byte targets, oversized records,
sparse-write flushing and backpressure remain covered by stream tests.

The confirmation runs below use seven fresh-process pairs, three-second/50-iteration
measurement budgets and the same 5% practical threshold. Their maximum warm-up
budget is 12 windows; the convergence rule and 500 ms minimum window are unchanged.
All 112 timing workers and 32,931 measured iterations are retained. One worker
exhausted its warm-up budget. Screening experiments are excluded from these
confirmation samples. MiB/s again shows process mean ± sample SD; ratios have
paired, per-case 95% intervals. Absolute rates from separate sessions should not
be compared as if they were paired observations.

### Against the previous modern implementation

The reference is commit `934eaef`, before this encoding change. These comparisons
measure the incremental benefit of the change, independently of legacy's behavior.

| Node | Scenario          | Current MiB/s ± SD | Previous MiB/s ± SD |         Ratio [95% CI] | Decision           |
| ---- | ----------------- | -----------------: | ------------------: | ---------------------: | ------------------ |
| 22   | stringify-small   |        129.5 ± 3.4 |         128.4 ± 4.2 | 1.009 [0.9698, 1.0500] | Inconclusive at 5% |
| 22   | stringify-unicode |         88.9 ± 4.6 |          79.7 ± 5.2 | 1.116 [1.0311, 1.2080] | Warm-up warning    |
| 26   | stringify-small   |        126.8 ± 5.2 |         108.6 ± 6.5 | 1.168 [1.0736, 1.2716] | ≥5% gain supported |
| 26   | stringify-unicode |         99.6 ± 4.8 |          87.5 ± 1.5 | 1.137 [1.0769, 1.2010] | ≥5% gain supported |

[Node 22 summary](results-batching-before-node22.json) ·
[Node 22 samples](results-batching-before-node22.samples.json.gz) ·
[Node 26 summary](results-batching-before-node26.json) ·
[Node 26 samples](results-batching-before-node26.samples.json.gz)

Node 26 supports about 17% faster ASCII encoding and 14% faster Unicode encoding
with less implementation code. Incremental Node 22 gains remain inconclusive;
its ASCII upper bound is just above 1.05 before rounding, and its Unicode case
also has a failed warm-up convergence check.

### Against published jsonlines@0.1.1

| Node | Scenario          | Current MiB/s ± SD | Legacy MiB/s ± SD |         Ratio [95% CI] | Decision           |
| ---- | ----------------- | -----------------: | ----------------: | ---------------------: | ------------------ |
| 22   | stringify-small   |        114.4 ± 8.5 |        93.7 ± 5.8 | 1.219 [1.1044, 1.3463] | ≥5% gain supported |
| 22   | stringify-unicode |         85.1 ± 3.5 |        81.0 ± 7.3 | 1.054 [0.9716, 1.1425] | Inconclusive at 5% |
| 26   | stringify-small   |        120.2 ± 9.4 |        95.0 ± 6.3 | 1.265 [1.1764, 1.3594] | ≥5% gain supported |
| 26   | stringify-unicode |         99.9 ± 5.7 |        79.7 ± 4.4 | 1.253 [1.1542, 1.3604] | ≥5% gain supported |

[Node 22 summary](results-batching-node22.json) ·
[Node 22 samples](results-batching-node22.samples.json.gz) ·
[Node 26 summary](results-batching-node26.json) ·
[Node 26 samples](results-batching-node26.samples.json.gz)

### Corrected memory observations

Single, separate 300,000-record VmHWM probes compare current serialization with
the previous modern implementation. They do not establish a memory confidence
interval or equivalence. Unicode still has a modest observed RSS cost:

| Node | Scenario          | Current peak MiB | Previous peak MiB |
| ---- | ----------------- | ---------------: | ----------------: |
| 22   | stringify-small   |             62.2 |              62.5 |
| 22   | stringify-unicode |             65.7 |              63.0 |
| 26   | stringify-small   |             66.7 |              67.5 |
| 26   | stringify-unicode |             71.3 |              68.4 |

Against published legacy, Unicode peaks are 66.3 / 61.2 MiB on Node 22 and
70.9 / 66.3 MiB on Node 26 (current / legacy), again single observations.

Fresh [backpressure probes](results-memory-backpressure.json) supersede the
initial rusage-based parser RSS readings. They still queue 32 objects versus
299,985 for legacy. Corrected peaks are 101.6 / 227.1 MiB on Node 22 and
107.6 / 261.6 MiB on Node 26 (modern / legacy). Fixture/preflight allocation is
included. Those probes use the original modern parser and its earlier timings, including
the Node 26 slow-consumer throughput regression.

Native line splitting, StringDecoder framing and a direct Duplex parser were
screened without consistent gains across workloads. Their parser changes were
discarded. The retained runtime change is the simpler bounded-batch stringifier.

## Parser simplification and ablation

The minimal parser at `7884ce2` keeps byte-level newline framing, one final
`Buffer.concat()` for a fragmented record, original-byte limits, physical line
numbers, split UTF-8 correctness and the existing Transform backpressure handling.
It removes both the growing scratch buffer and the decoded-text window. All 26
behavioral/tooling tests pass, including a new malformed-UTF-8 byte-limit check.
This is a correctness-preserving baseline, rather than a parser that gains
simplicity by dropping limits or expanding entire input chunks into objects.

The original parser is `a76f8d8`. Its confirmation comparison with that minimal
baseline uses seven fresh-process pairs per scenario and Node version, three
seconds and 50 iterations per worker, up to 12 warm-up windows and a new corpus
seed of 60301. The 5% threshold and convergence rule are unchanged. Shorter,
three-pair screening runs are excluded from these confirmation artifacts.

The Unicode fixture ends every chunk at LF, so it never uses fragment
accumulation and isolates the decoded-text window. Conversely, every record in
the seven-byte and fragmented-large-record fixtures spans chunks, so they never
use the decoded-text window and isolate the accumulation strategy. The other
fixtures exercise the combined paths. Both parsers retain backpressure; the
separate memory diagnostics compare their implementation overhead, rather than
comparing a bounded parser with the unbounded legacy implementation.

### Confirmation results

These ratios compare **original modern / minimal modern**, rather than legacy.
The JSON schema calls the minimal reference `legacy`; its baseline metadata
identifies the actual module. MiB/s is the process mean ± sample SD. All **168
timing workers and 79,280 measured iterations** are retained. Three workers
failed warm-up convergence: Node 22 large records, Node 26 Unicode, and Node 26
limited lines. Their rows remain qualified, regardless of their intervals.

| Node | Scenario           | Original MiB/s ± SD | Minimal MiB/s ± SD |         Ratio [95% CI] | Decision           |
| ---- | ------------------ | ------------------: | -----------------: | ---------------------: | ------------------ |
| 22   | parse-small        |         126.8 ± 3.3 |        117.8 ± 4.7 | 1.077 [1.0276, 1.1277] | Inconclusive at 5% |
| 22   | parse-unicode      |          94.3 ± 4.8 |         79.4 ± 3.2 | 1.186 [1.1485, 1.2252] | ≥5% gain supported |
| 22   | parse-limited      |         123.7 ± 6.2 |        120.6 ± 3.6 | 1.025 [0.9796, 1.0724] | Inconclusive at 5% |
| 22   | parse-fragmented   |          19.6 ± 1.0 |         14.7 ± 0.3 | 1.331 [1.2678, 1.3972] | ≥5% gain supported |
| 22   | parse-large-record |        431.6 ± 20.9 |       439.2 ± 31.7 | 0.984 [0.9051, 1.0697] | Warm-up warning    |
| 22   | parse-backpressure |          89.9 ± 2.1 |         77.1 ± 1.5 | 1.166 [1.1318, 1.2006] | ≥5% gain supported |
| 26   | parse-small        |         144.5 ± 5.1 |        115.9 ± 7.4 | 1.248 [1.1488, 1.3560] | ≥5% gain supported |
| 26   | parse-unicode      |        127.7 ± 15.7 |        102.6 ± 4.3 | 1.236 [1.1099, 1.3769] | Warm-up warning    |
| 26   | parse-limited      |         134.2 ± 6.1 |        116.0 ± 9.9 | 1.160 [1.0756, 1.2502] | Warm-up warning    |
| 26   | parse-fragmented   |          24.4 ± 1.2 |         20.5 ± 0.8 | 1.187 [1.1616, 1.2132] | ≥5% gain supported |
| 26   | parse-large-record |        690.3 ± 54.2 |       908.4 ± 22.9 | 0.758 [0.7029, 0.8178] | ≥5% loss supported |
| 26   | parse-backpressure |         106.7 ± 3.6 |         88.9 ± 4.3 | 1.201 [1.1480, 1.2562] | ≥5% gain supported |

[Node 22 summary](results-parser-original-vs-simple-node22.json) ·
[Node 22 samples](results-parser-original-vs-simple-node22.samples.json.gz) ·
[Node 26 summary](results-parser-original-vs-simple-node26.json) ·
[Node 26 samples](results-parser-original-vs-simple-node26.samples.json.gz)

The window supports about 19% faster Unicode parsing on Node 22 (95% CI +15% to
+23%). The combined parser is about 25% faster on Node 26 small ASCII (+15% to
+36%) and 17–20% faster in the slow-consumer timing case. The scratch buffer
supports about 33% faster seven-byte fragments on Node 22 (+27% to +40%) and
19% on Node 26 (+16% to +21%). These effects justify the respective layers for
those workloads; ordinary-parser improvements over published legacy remain
subject to the earlier, separate comparison.

There is a clear cost: on Node 26, the minimal accumulator parses 256 KiB records
split into 1 KiB chunks about **32% faster** (95% CI +22% to +42%). Node 22 does
not establish a large-record difference. In separate single-pass memory probes,
original/minimal large-record peaks are 85.8/75.8 MiB on Node 22 and 94.0/79.7 MiB
on Node 26. The growing buffer is not a universal throughput or RSS improvement.
Both implementations queue only 32 objects in the backpressure memory case;
that guarantee belongs to the core stream handling. Its original/minimal peaks
are 101.6/92.4 MiB on Node 22 and 106.7/97.7 MiB on Node 26. All of these RSS
values include fixture construction and preflight and are observations, not
memory confidence intervals.

### Fragment retention diagnostics

A third source revision, `f0c6cbd`, retains the window but borrows fragment buffers
and concatenates once. Whole input chunks are reused without allocating extra
views. This tests whether avoiding redundant views resolves the fragment-array
memory cost. All three parser implementations pass the current 26-test suite.

The [memory artifact](results-parser-memory.json) contains **three fresh workers
per implementation/scenario/Node version**, 36 workers total, with rotating
variant order. These diagnostics use [parser-memory.js](parser-memory.js) and
are separate from timing. Peak RSS includes preflight and fixtures. Ranges show
all three observations, rather than formal intervals:

| Node | 256 KiB record, one-byte chunks: original peak MiB | Minimal peak MiB | Borrowed-fragment peak MiB |
| ---- | -------------------------------------------------: | ---------------: | -------------------------: |
| 22   |                                          63.5–63.7 |      121.5–123.5 |                118.2–119.1 |
| 26   |                                          67.4–67.9 |      153.6–154.8 |                150.8–151.3 |

Views are generated lazily here. Prebuilding all the views as timing fixtures do
would retain them for both implementations and conceal the cost of keeping a
reference per fragment. The growing buffer lets those source views be collected
as chunks are consumed. Avoiding duplicate views alone does not remove the
reference-retention cost.

A second probe writes a 32 MiB chunk containing empty lines and one unfinished
quote, waits for the write callback, drops the source reference, then performs
two GCs separated by event-loop turns while the parser remains open. Completing
the quoted string afterwards verifies the retained partial record. This measures
**live ArrayBuffer allocation**, not peak RSS, because both implementations must
allocate the input chunk initially:

| Node | Original live ArrayBuffer MiB | Minimal live MiB | Borrowed-fragment live MiB |
| ---- | ----------------------------: | ---------------: | -------------------------: |
| 22   |                         0.018 |           32.010 |                     32.010 |
| 26   |                         0.132 |           32.132 |                     32.132 |

Every repetition gives the displayed allocation to three decimal places. Keeping
a view of a one-byte tail pins the entire 32 MiB input allocation. The scratch
buffer copies that tail and releases the source. These are deliberately extreme
fragmentation/retention probes, not estimates of savings for normal 64 KiB file
chunks. They explain the allocator's value under the low-memory requirement.

### Retained implementation and reproduction

Retain the decoded window for its supported throughput gains and the growing
fragment buffer for fine-fragment throughput and bounded fragment retention.
The parser algorithms remain those of `a76f8d8`; this pass establishes their
benefits and their large-record cost against a simpler correct implementation.
The minimal and borrowed-fragment alternatives remain available as source
commits for reproduction. No throughput claim is made for the borrowed variant;
its retention measurements already rule it out for the intended memory bounds.

Build the three source revisions in fresh directories:

```sh
git worktree add --detach /tmp/parser-original a76f8d8
git worktree add --detach /tmp/parser-minimal 7884ce2
git worktree add --detach /tmp/parser-borrowed f0c6cbd
for checkout in /tmp/parser-original /tmp/parser-minimal /tmp/parser-borrowed; do
  npm --prefix "$checkout" ci
  npm --prefix "$checkout" run build
done
```

From the original checkout (or the retained implementation), reproduce a timing
comparison with the common runner:

```sh
node bench/run.js --baseline /tmp/parser-minimal/dist/index.js \
  --seed 60301 --warmup-windows 12 \
  --scenario parse-small --scenario parse-unicode --scenario parse-limited \
  --scenario parse-fragmented --scenario parse-large-record \
  --scenario parse-backpressure --output bench/results.local.json
```

Use a Node 26 executable for the other runtime. From the retained checkout,
each independent memory worker can be reproduced with:

```sh
node --expose-gc bench/parser-memory.js /tmp/parser-original/dist/index.js fragmented-record
node --expose-gc bench/parser-memory.js /tmp/parser-minimal/dist/index.js retained-tail
node --expose-gc bench/parser-memory.js /tmp/parser-borrowed/dist/index.js retained-tail
```

Run each module/scenario combination three times in fresh workers, rotating
starting order, to match the memory artifact. It records source commit IDs and
SHA-256 hashes of each framing implementation.

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
