import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { configuration } from '../bench/config.js'
import { fixture, scenarios } from '../bench/fixtures.js'
import { comparison, statistics } from '../bench/statistics.js'
import { workload } from '../bench/workload.js'

test('sample SD and Student t interval match a reference dataset', () => {
  const result = statistics([2, 4, 4, 4, 5, 5, 7, 9])
  assert.equal(result.mean, 5)
  assert.equal(result.median, 4.5)
  assert.ok(Math.abs(result.sd - 2.138089935299395) < 1e-10)
  assert.ok(Math.abs(result.ci95[0] - 3.21251208176379) < 1e-9)
  assert.ok(Math.abs(result.ci95[1] - 6.78748791823621) < 1e-9)
  assert.equal(statistics([5]).sd, null)
  assert.equal(statistics([5]).ci95, null)
  assert.throws(() => statistics([]))
})

test('comparison requires independent pairs and a practically meaningful effect', () => {
  const pairs = (modern, legacy) =>
    modern.map((v, i) => ({ modern: v, legacy: legacy[i], stable: true }))
  const constant = (value) => Array(7).fill(value)
  const cases = [
    [constant(10), constant(20), 'meaningfully-faster'],
    [constant(20), constant(10), 'meaningfully-slower'],
    [constant(100), constant(100.1), 'within-practical-band'],
    [[10, 10, 10, 10, 10, 10, 30], constant(12), 'inconclusive'],
  ]
  for (const [modern, legacy, expected] of cases) {
    assert.equal(comparison(pairs(modern, legacy), 5).verdict, expected)
  }
  const result = comparison(pairs([10, 10, 10], [5, 10, 20]), 5)
  assert.equal(result.ratio, 1) // Paired log ratios are symmetric under swapping.
  assert.ok(result.ci95[0] < 1 && result.ci95[1] > 1)
  assert.equal(comparison(pairs([10], [20]), 5).verdict, 'smoke-only')
  assert.equal(
    comparison(pairs(constant(10), constant(20)), 5, true).verdict,
    'smoke-only',
  )
  const unstable = pairs(constant(10), constant(20))
  unstable[0].stable = false
  assert.equal(comparison(unstable, 5).verdict, 'inconclusive-warmup')
})

test('configuration rejects insufficient replication and invalid durations', () => {
  for (const values of [
    { processes: 1 },
    { time: 0 },
    { records: NaN },
    { iterations: 0 },
    { warmupWindows: 2 },
    { baseline: '' },
  ]) {
    assert.throws(() => configuration(values))
  }
  assert.equal(configuration({ quick: true }).processes, 1)
  assert.equal(configuration().processes, 7)
})

test('varied fixtures are repeatable within a pair and change between seeds', () => {
  const a = fixture('parse-small', 200, 42)
  const b = fixture('parse-small', 200, 42)
  const c = fixture('parse-small', 200, 43)
  const bytes = (data) => Buffer.concat([...data.chunks()])
  assert.deepEqual(bytes(a), bytes(b))
  assert.notDeepEqual(bytes(a), bytes(c))
  assert.equal(new Set([...a.values()].map(JSON.stringify)).size, 200)
  assert.equal(bytes(a).length, a.bytes)
})

test('both implementations validate every workload, including bounded fixture remainders', async () => {
  for (const scenario of scenarios) {
    for (const bounded of [false, true]) {
      const data = fixture(
        scenario,
        scenario === 'parse-large-record' ? 10001 : 1100,
        42,
        bounded,
      )
      for (const implementation of ['modern', 'legacy']) {
        const task = workload(implementation, scenario, data, true)
        await task.run()
        const observed = task.validate()
        if (scenario === 'parse-backpressure' && bounded) {
          if (implementation === 'modern')
            assert.ok(observed.maxBufferedObjects <= 32)
          else assert.ok(observed.maxBufferedObjects > 32)
        }
      }
    }
  }
})

test('Tinybench smoke runs export raw samples without claiming significance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jsonlines-bench-'))
  try {
    const output = join(directory, 'result.json')
    await promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(new URL('../bench/run.js', import.meta.url)),
        '--quick',
        '--baseline',
        fileURLToPath(new URL('../dist/index.js', import.meta.url)),
        '--scenario',
        'parse-large-record',
        '--time',
        '1',
        '--warmup-time',
        '1',
        '--output',
        output,
      ],
      { timeout: 30000 },
    )
    const report = JSON.parse(await readFile(output, 'utf8'))
    assert.equal(report.complete, true)
    assert.equal(report.environment.legacyVersion, null)
    assert.equal(
      report.config.baseline,
      new URL('../dist/index.js', import.meta.url).href,
    )
    assert.equal(report.comparisons[0].verdict, 'smoke-only')
    assert.equal(report.comparisons[0].ci95, null)
    const raw = JSON.parse(
      gunzipSync(await readFile(join(directory, report.rawSamples))),
    )
    assert.equal(raw.runs.length, 2)
    for (const run of raw.runs) {
      assert.ok(run.latency.samplesCount >= 2)
      assert.equal(run.latency.samples.length, run.latency.samplesCount)
      assert.equal(run.warmup.windows.length, 3)
      assert.ok(Number.isFinite(run.measurementDriftPercent))
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test(
  'Linux memory diagnostics exclude RSS inherited before exec',
  { skip: process.platform !== 'linux' },
  async () => {
    const worker = fileURLToPath(new URL('../bench/worker.js', import.meta.url))
    const parent = `
      import { execFileSync } from 'node:child_process'
      const retained = Buffer.alloc(128 * 1024 ** 2, 1)
      const result = execFileSync(process.execPath, [
        '--expose-gc', process.argv[1], 'modern', 'stringify-small',
        '{"quick":true}', 'memory',
      ])
      process.stdout.write(JSON.stringify({
        parentRssMiB: process.memoryUsage().rss / 1024 ** 2,
        report: JSON.parse(result),
      }))
      if (retained[0] !== 1) throw new Error('Allocation was not retained')
    `
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--input-type=module', '-e', parent, worker],
      { timeout: 30000 },
    )
    const { report, parentRssMiB } = JSON.parse(stdout)
    assert.equal(report.peakRssSource, 'linux-vmhwm')
    assert.ok(report.peakRssMiB < parentRssMiB - 64)
  },
)
