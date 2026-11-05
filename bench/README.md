# Benchmarks

Tinybench measures complete Transform pipelines against published `jsonlines@0.1.1`
using shared, deterministic ASCII/Unicode fixtures. Scenarios cover ordinary and
fragmented input, large records, a slow consumer, line limits and serialization.
Fixtures are built before timing and results are validated outside timed bodies.

```sh
npm ci
npm run bench:quick
npm run bench -- --output bench/results.local.json
npm run bench -- --scenario parse-small --processes 7 --time 5000
```

The runner executes seven fresh process pairs per scenario, sequentially with
alternating implementation order. Each worker checks warm-up convergence before
measuring for at least three seconds and 50 iterations. Reports include standard
deviation, CV and paired 95% confidence intervals; a meaningful difference must
clear a 5% threshold. Failed warm-up makes a comparison inconclusive, and quick
runs are smoke tests only. Workers use the runner's Node executable. To compare
another implementation, pass its built ESM entry point:

```sh
npm run bench -- --baseline ../baseline/dist/index.js --scenario parse-unicode
npm exec --yes --package=node@26 -- node bench/run.js --scenario stringify-small
```

Memory and queue diagnostics run in separate workers with bounded fixture pools.
Linux peak RSS uses VmHWM and includes fixtures and preflight; these observations
are separate from timing confidence intervals. `--output` saves a JSON summary
and compressed raw samples beside it. Reports are ignored by Git; the manual CI
benchmark job uploads them as artifacts. Additional retention probes generate
fragments lazily or check whether a tiny unfinished tail retains a large input:

```sh
npm run build
node --expose-gc bench/parser-memory.js ./dist/index.js fragmented-record
node --expose-gc bench/parser-memory.js ./dist/index.js retained-tail
```
