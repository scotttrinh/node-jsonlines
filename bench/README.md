# Benchmarks

The baseline is the exact published `jsonlines@0.1.1`, installed through the
`jsonlines-legacy` npm alias. It is a development dependency only. Both
implementations run on the same Node binary with the same fixtures and sinks.

```sh
npm ci
npm run bench:quick
npm run bench -- --output bench/results.local.json
npm run bench -- --scenario parse-backpressure --records 1000000 --samples 7
```

The default is five independent processes per implementation and scenario, each
processing 300,000 records after one untimed warmup. Workers run sequentially and
alternate implementation order. Fixtures are constructed outside the timer and
reused without storing all input, except for the deliberately large single-chunk
backpressure case. Every run checks parsed record count and checksum or serialized
byte count. The generated fixtures contain no `null` records, and the fragmented
baseline comparison uses ASCII because the old parser corrupts split UTF-8.
Each scenario repeats a representative record to isolate framing and stream
costs. This synthetic workload can benefit from engine caches; it does not model
the full distribution of sizes, shapes or entropy in production data.

Scenarios cover small ASCII records, Unicode, a 1 MiB line limit, seven-byte chunks,
256 KiB records fragmented into 1 KiB chunks, one expanding input chunk with a slow consumer, and
small/Unicode serialization. The large-record scenario uses `ceil(records / 2000)`
records (at least eight) to keep its total byte volume comparable. Byte sources,
byte sinks, object sources and object sinks use the appropriate stream modes for
both implementations; the old stringifier's strings are encoded by the byte sink.

The runner reports median MiB/s and records/s, timing ranges, process peak RSS,
and maximum observed queued objects in the slow-consumer case. The JSON artifact
also includes every sample, CPU time, post-warmup RSS, Node/V8 versions, OS and CPU.
RSS is **whole-process peak**, including imports, fixtures, warmup and allocator
retention, rather than a claim about live allocations. Explicit GC runs between
warmup and measurement, outside the timer. A slow sink samples the parser and
sink queues together; ordinary throughput cases do not poll their queues.

Small samples and shared runners can vary substantially. Compare distributions
and repeat on deployment hardware before drawing conclusions. There are no CI
performance thresholds; a manually dispatched CI job uploads the raw benchmark
artifact. These benchmarks measure the Transform API; async iterable performance
has a different per-record promise cost and is not included in this comparison.

## Recorded results

Recorded on 2026-11-05, Linux x64, Intel Xeon 2.90 GHz, four logical CPUs, with
five samples per implementation and 300,000 records (150 large records).
Raw samples, timing ranges, CPU time and memory measurements are available for
[Node 22.23.4](results-node22.json) and [Node 26.13.0](results-node26.json).
Ratios above 1 favor this implementation. These runs used default options,
except `parse-limited`, which gives the modern parser a 1 MiB byte limit;
the legacy parser does not implement that option.

| Scenario           | Node 22 modern / legacy MiB/s |  Ratio | Node 26 modern / legacy MiB/s |  Ratio |
| ------------------ | ----------------------------: | -----: | ----------------------------: | -----: |
| parse-small        |                 146.4 / 156.7 |  0.93× |                 154.0 / 145.7 |  1.06× |
| parse-unicode      |                 107.4 / 117.1 |  0.92× |                 174.1 / 171.0 |  1.02× |
| parse-limited      |                 133.0 / 153.9 |  0.86× |                 149.3 / 154.2 |  0.97× |
| parse-fragmented   |                   15.2 / 11.7 |  1.30× |                   16.5 / 11.0 |  1.50× |
| parse-large-record |                  370.1 / 16.9 | 21.87× |                  669.3 / 48.1 | 13.91× |
| parse-backpressure |                   91.3 / 63.5 |  1.44× |                   89.6 / 77.7 |  1.15× |
| stringify-small    |                  109.0 / 79.3 |  1.37× |                  104.9 / 75.1 |  1.40× |
| stringify-unicode  |                   92.2 / 87.5 |  1.05× |                 101.5 / 107.8 |  0.94× |

The slow-consumer case queued at most 32 objects versus 299,985 for the baseline.
Its median process peak RSS was 97.4 / 189.1 MiB on Node 22 and 97.6 / 227.6 MiB
on Node 26 (modern / legacy). Large fragmented records used 85.1 / 123.1 MiB and
87.1 / 169.3 MiB respectively. Small-record memory use is similar. Small-record
parsing on Node 22 and Unicode serialization on Node 26 can be slower; the
bounded framing and byte-output paths are a measurable tradeoff, not a universal
speedup. Several small differences also overlap the sample timing ranges.

To reproduce the Node 26 run with that binary:

```sh
npm run build
npm exec --yes --package=node@26 -- node bench/run.js --output bench/results.local.json
```

## Implementation choices

The parser frames UTF-8 before decoding, preserving characters across chunks.
The fast path decodes windows ending on LF (normally at most 64 KiB)
and scans them with `indexOf`, without a whole-chunk `split()` array. A single
large record can exceed that window. Limits of at least 64 KiB use that same path:
each contained record fits within the window's byte length, and an oversized first
record is checked separately. Smaller limits count raw bytes per record before
decoding, which can cost throughput on small lines.
Fragmented records use geometrically growing scratch storage, giving linear total
copying instead of repeatedly concatenating and rescanning an ever-growing string.
Large scratch allocations are released after their record.

The parser stops when `push()` returns false, even midway through one input chunk.
Memory scales with the input chunk, partial record, decoding window and stream
water marks, rather than all decoded objects in that chunk. Choose source chunk
sizes, `maxLineBytes` and stream water marks for the workload.

The stringifier encodes directly into geometrically growing byte batches and
appends LF in the output buffer, avoiding a second string allocation per record.
Emitted buffers are never reused. Batching reduces allocations and downstream
writes, with a bounded pending buffer and microtask delivery for sparse writes.
Set `batchBytes: 0` for synchronous, per-record output.
Serialization itself uses the platform's `JSON.stringify()`; there is no eval,
handwritten JSON encoder or schema-specific assumption.

## Profiling

Build once, then isolate a worker from the orchestration overhead:

```sh
npm run build
node --expose-gc --cpu-prof bench/worker.js modern parse-small 1000000
node --expose-gc --heap-prof bench/worker.js modern parse-backpressure 1000000
node --expose-gc --trace-gc bench/worker.js modern stringify-unicode 1000000
```

Replace `modern` with `legacy` to profile the baseline. Inspector profiles may be
opened in Chrome DevTools. Keep profiles outside version control.
