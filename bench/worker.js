import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import * as modern from '../dist/index.js'
import legacy from 'jsonlines-legacy'
import { fixture } from './fixtures.js'

const [implementation, scenario, count] = process.argv.slice(2)
const library = implementation === 'modern' ? modern : legacy
const data = fixture(scenario, Number(count))

async function run() {
  let records = 0
  let checksum = 0
  let bytes = 0
  let maxBufferedObjects = 0
  const serializing = scenario.startsWith('stringify')
  const transform = serializing
    ? library.stringify()
    : library.parse(
        scenario === 'parse-limited'
          ? { maxLineBytes: 1024 * 1024 }
          : undefined,
      )
  const sink = new Writable({
    objectMode: !serializing,
    highWaterMark: serializing ? 64 * 1024 : 16,
    write(value, _, callback) {
      if (serializing) {
        bytes += value.length
      } else {
        records++
        checksum += value.id
      }
      if (scenario === 'parse-backpressure' && records % 16 === 0) {
        setImmediate(() => {
          maxBufferedObjects = Math.max(
            maxBufferedObjects,
            transform.readableLength + sink.writableLength,
          )
          callback()
        })
      } else callback()
    },
  })
  const start = performance.now()
  const cpuStart = process.cpuUsage()
  await pipeline(
    Readable.from(serializing ? data.values() : data.chunks(), {
      objectMode: serializing,
    }),
    transform,
    sink,
  )
  const milliseconds = performance.now() - start
  const cpu = process.cpuUsage(cpuStart)
  if (serializing) assert.equal(bytes, data.bytes)
  else {
    assert.equal(records, data.records)
    assert.equal(checksum, 42 * data.records)
  }
  return {
    milliseconds,
    cpuMilliseconds: (cpu.user + cpu.system) / 1000,
    maxBufferedObjects,
  }
}

await run() // Exercise the same path before timing; do not time fixture generation.
globalThis.gc()
const baselineRss = process.memoryUsage().rss
const result = await run()
process.stdout.write(
  JSON.stringify({
    ...result,
    implementation,
    scenario,
    records: data.records,
    bytes: data.bytes,
    recordsPerSecond: data.records / (result.milliseconds / 1000),
    mibPerSecond: data.bytes / 1024 ** 2 / (result.milliseconds / 1000),
    baselineRssMiB: baselineRss / 1024 ** 2,
    peakRssMiB: process.resourceUsage().maxRSS / 1024,
  }),
)
