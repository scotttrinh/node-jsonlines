import { performance } from 'node:perf_hooks'
import { readFileSync } from 'node:fs'
import { configuration } from './config.js'
import { fixture } from './fixtures.js'
import { statistics } from './statistics.js'
import { workload } from './workload.js'

const [implementation, scenario, encoded = '{}', mode = 'timing'] =
  process.argv.slice(2)
const config = configuration(JSON.parse(encoded))
const baseline =
  config.baseline === 'jsonlines-legacy'
    ? undefined
    : await import(config.baseline)
if (!['timing', 'memory'].includes(mode)) throw new Error('Unknown worker mode')
const data = fixture(
  scenario,
  mode === 'memory' ? config.memoryRecords : config.records,
  config.seed,
  mode === 'memory',
)
const task = workload(
  implementation,
  scenario,
  data,
  mode === 'memory',
  baseline,
)
await task.run()
task.validate()
globalThis.gc() // Before warmup, never between measured iterations.

let result
if (mode === 'memory') {
  const baselineRssMiB = process.memoryUsage().rss / 1024 ** 2
  await task.run()
  const observed = task.validate()
  const resourceUsageMaxRssMiB = process.resourceUsage().maxRSS / 1024
  // Linux rusage can retain the spawning process's peak across exec(). VmHWM
  // belongs to this executable's address space, including fixture/preflight work.
  const vmHwm =
    process.platform === 'linux'
      ? readFileSync('/proc/self/status', 'utf8').match(/^VmHWM:\s+(\d+) kB$/m)
      : null
  result = {
    baselineRssMiB,
    peakRssMiB: vmHwm ? Number(vmHwm[1]) / 1024 : resourceUsageMaxRssMiB,
    peakRssSource: vmHwm ? 'linux-vmhwm' : 'resource-usage',
    resourceUsageMaxRssMiB,
    maxBufferedObjects: observed.maxBufferedObjects,
  }
} else {
  const { Bench } = await import('tinybench')
  const warmup = []
  const orderedSamples = []
  let start, phaseSamples
  const warnings = []
  const bench = new Bench({
    name: `${implementation}/${scenario}`,
    concurrency: null,
    warmup: false,
    warmupTime: config.warmupTime,
    warmupIterations: config.warmupIterations,
    time: config.time,
    iterations: config.iterations,
    timestampProvider: 'hrtimeNow',
    retainSamples: true,
    throws: true,
  })
  bench.addEventListener('warning', (event) => warnings.push(event.reason))
  bench.add(implementation, task.run, {
    async: true,
    beforeEach() {
      start = performance.now()
    },
    afterEach() {
      phaseSamples.push(performance.now() - start)
      task.validate()
    },
  })
  let stableTransitions = 0
  let stable = false
  for (let window = 0; window < config.warmupWindows; window++) {
    phaseSamples = []
    await bench.getTask(implementation).warmup()
    const summary = statistics(phaseSamples)
    const previous = warmup.at(-1)?.median
    const changePercent =
      previous === undefined ? null : 100 * (summary.median / previous - 1)
    stableTransitions =
      changePercent !== null &&
      Math.abs(changePercent) <= config.stabilityPercent
        ? stableTransitions + 1
        : 0
    warmup.push({ ...summary, changePercent, samples: phaseSamples })
    if (stableTransitions >= 2) {
      stable = true
      break
    }
  }
  phaseSamples = orderedSamples
  const cpuStart = process.cpuUsage()
  await bench.run()
  const cpu = process.cpuUsage(cpuStart)
  const measured = bench.getTask(implementation).result
  if (measured.state !== 'completed')
    throw new Error(`Incomplete benchmark: ${measured.state}`)
  const third = Math.max(1, Math.floor(orderedSamples.length / 3))
  const first = statistics(orderedSamples.slice(0, third)).median
  const last = statistics(orderedSamples.slice(-third)).median
  result = {
    warmup: { stable, windows: warmup },
    latency: measured.latency,
    throughput: measured.throughput,
    mibPerSecond: ((data.bytes / 1024 ** 2) * 1000) / measured.latency.mean,
    recordsPerSecond: (data.records * 1000) / measured.latency.mean,
    cpuMilliseconds: (cpu.user + cpu.system) / 1000,
    measurementDriftPercent: 100 * (last / first - 1),
    orderedSamples,
    warnings,
  }
}
process.stdout.write(
  JSON.stringify({
    implementation,
    scenario,
    mode,
    records: data.records,
    bytes: data.bytes,
    seed: config.seed,
    ...result,
  }),
)
