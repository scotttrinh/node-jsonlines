import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import * as modern from '../dist/index.js'
import legacy from 'jsonlines-legacy'

export function workload(
  implementation,
  scenario,
  data,
  diagnostic = false,
  baseline = legacy,
) {
  if (!['modern', 'legacy'].includes(implementation))
    throw new Error('Unknown implementation')
  const library = implementation === 'modern' ? modern : baseline
  const serializing = scenario.startsWith('stringify')
  let observed
  async function run() {
    let records = 0,
      checksum = 0,
      textLength = 0,
      bytes = 0,
      maxBufferedObjects = 0
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
        if (serializing) bytes += value.length
        else {
          records++
          checksum += value.id
          textLength += value.text.length
        }
        if (scenario === 'parse-backpressure' && records % 16 === 0) {
          setImmediate(() => {
            if (diagnostic)
              maxBufferedObjects = Math.max(
                maxBufferedObjects,
                transform.readableLength + sink.writableLength,
              )
            callback()
          })
        } else callback()
      },
    })
    await pipeline(
      Readable.from(serializing ? data.values() : data.chunks(), {
        objectMode: serializing,
      }),
      transform,
      sink,
    )
    observed = { records, checksum, textLength, bytes, maxBufferedObjects }
  }
  // Tinybench calls this in afterEach, outside the timed task body.
  function validate() {
    if (serializing) assert.equal(observed.bytes, data.bytes)
    else {
      assert.equal(observed.records, data.records)
      assert.equal(observed.checksum, data.checksum)
      assert.equal(observed.textLength, data.textLength)
    }
    return observed
  }
  return { run, validate }
}
