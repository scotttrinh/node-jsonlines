export const scenarios = [
  'parse-small',
  'parse-unicode',
  'parse-limited',
  'parse-fragmented',
  'parse-large-record',
  'parse-backpressure',
  'stringify-small',
  'stringify-unicode',
]

export function fixture(scenario, requestedRecords) {
  const unicode = scenario.endsWith('unicode')
  const large = scenario === 'parse-large-record'
  const row = {
    id: 42,
    active: true,
    text: large
      ? 'x'.repeat(256 * 1024)
      : unicode
        ? 'café 日本語 🦄'.repeat(4)
        : 'the quick brown fox jumps over the lazy dog',
  }
  const line = JSON.stringify(row) + '\n'
  const bytesPerRecord = Buffer.byteLength(line)
  const records = large
    ? Math.max(8, Math.ceil(requestedRecords / 2000))
    : requestedRecords
  const perChunk = Math.max(1, Math.floor((64 * 1024) / bytesPerRecord))
  const block = Buffer.from(line.repeat(perChunk))
  const one = Buffer.from(line)
  const entire =
    scenario === 'parse-backpressure'
      ? Buffer.from(line.repeat(records))
      : undefined

  function* chunks() {
    if (entire) {
      yield entire
      return
    }
    if (scenario === 'parse-fragmented' || large) {
      const size = large ? 1024 : 7
      for (let i = 0; i < records; i++) {
        for (let offset = 0; offset < one.length; offset += size) {
          yield one.subarray(offset, offset + size)
        }
      }
      return
    }
    let remaining = records
    while (remaining >= perChunk) {
      yield block
      remaining -= perChunk
    }
    if (remaining) yield block.subarray(0, remaining * bytesPerRecord)
  }

  function* values() {
    for (let i = 0; i < records; i++) yield row
  }

  return { records, bytes: records * bytesPerRecord, chunks, values }
}
