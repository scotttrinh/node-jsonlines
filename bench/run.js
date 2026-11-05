import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { cpus, platform, arch, release } from 'node:os'
import { parseArgs, promisify } from 'node:util'
import { scenarios } from './fixtures.js'

const { values } = parseArgs({
  options: {
    quick: { type: 'boolean', default: false },
    samples: { type: 'string' },
    records: { type: 'string' },
    scenario: { type: 'string', multiple: true },
    output: { type: 'string' },
  },
})
const samples = Number(values.samples ?? (values.quick ? 2 : 5))
const records = Number(values.records ?? (values.quick ? 30_000 : 300_000))
for (const [name, value] of Object.entries({ samples, records })) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`)
}
const selected = values.scenario ?? scenarios
if (selected.some((scenario) => !scenarios.includes(scenario)))
  throw new Error('Unknown scenario')
const execute = promisify(execFile)
const runs = []
const environment = {
  date: new Date().toISOString(),
  node: process.version,
  v8: process.versions.v8,
  platform: `${platform()} ${release()} ${arch()}`,
  cpu: cpus()[0]?.model,
  logicalCpus: cpus().length,
  legacyVersion: '0.1.1',
  samples,
  requestedRecords: records,
}
console.log(JSON.stringify(environment))
for (const scenario of selected) {
  for (let sample = 0; sample < samples; sample++) {
    // Alternate order to reduce systematic bias; never run competing workers.
    for (const implementation of sample % 2
      ? ['legacy', 'modern']
      : ['modern', 'legacy']) {
      const { stdout } = await execute(
        process.execPath,
        [
          '--expose-gc',
          new URL('./worker.js', import.meta.url).pathname,
          implementation,
          scenario,
          String(records),
        ],
        { maxBuffer: 1024 * 1024, timeout: 120_000 },
      )
      runs.push({ sample, ...JSON.parse(stdout) })
    }
  }
  const summarize = (implementation) => {
    const matching = runs.filter(
      (r) => r.scenario === scenario && r.implementation === implementation,
    )
    const median = (key) => {
      const sorted = matching.map((r) => r[key]).sort((a, b) => a - b)
      const middle = Math.floor(sorted.length / 2)
      return sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2
    }
    return {
      mibPerSecond: median('mibPerSecond'),
      recordsPerSecond: median('recordsPerSecond'),
      peakRssMiB: median('peakRssMiB'),
      maxBufferedObjects: Math.max(
        ...matching.map((r) => r.maxBufferedObjects),
      ),
      minMilliseconds: Math.min(...matching.map((r) => r.milliseconds)),
      maxMilliseconds: Math.max(...matching.map((r) => r.milliseconds)),
    }
  }
  const current = summarize('modern')
  const old = summarize('legacy')
  console.log(
    `${scenario}: modern ${current.mibPerSecond.toFixed(1)} MiB/s, legacy ${old.mibPerSecond.toFixed(1)} MiB/s, ${(current.mibPerSecond / old.mibPerSecond).toFixed(2)}x; peak RSS ${current.peakRssMiB.toFixed(1)}/${old.peakRssMiB.toFixed(1)} MiB; buffered objects ${current.maxBufferedObjects}/${old.maxBufferedObjects}; time range ${current.minMilliseconds.toFixed(0)}–${current.maxMilliseconds.toFixed(0)}/${old.minMilliseconds.toFixed(0)}–${old.maxMilliseconds.toFixed(0)} ms`,
  )
}
if (values.output)
  await writeFile(
    values.output,
    JSON.stringify({ environment, runs }, null, 2) + '\n',
  )
