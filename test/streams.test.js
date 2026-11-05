import assert from 'node:assert/strict'
import { once } from 'node:events'
import { Readable, Writable } from 'node:stream'
import { finished, pipeline } from 'node:stream/promises'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import {
  JsonLineError,
  parse,
  parseValues,
  stringify,
  stringifyValues,
} from '../dist/index.js'

async function collect(chunks, options) {
  const values = []
  await pipeline(
    Readable.from(chunks, { objectMode: false }),
    parse(options),
    new Writable({
      objectMode: true,
      write(value, _, callback) {
        values.push(value)
        callback()
      },
    }),
  )
  return values
}

test('parses Unicode, CRLF, empty lines and a final unterminated record at every byte boundary', async () => {
  const expected = [
    { text: 'café 🦄 日本語' },
    false,
    0,
    '',
    [1, 2],
    { last: true },
  ]
  const input = Buffer.from(
    '\n\r\n' + expected.map(JSON.stringify).join('\r\n\n'),
  )
  for (let split = 0; split <= input.length; split++) {
    assert.deepEqual(
      await collect([input.subarray(0, split), input.subarray(split)]),
      expected,
      `split at byte ${split}`,
    )
  }
  assert.deepEqual(
    await collect(Array.from(input, (byte) => Buffer.from([byte]))),
    expected,
  )
  assert.deepEqual(await collect([]), [])
})

test('round trips an object stream into real bytes and back', async () => {
  const values = [{ message: 'hello\nworld' }, false, 42, '', ['🐈']]
  const output = []
  const encoder = stringify()
  assert.equal(encoder.readableObjectMode, false)
  assert.equal(encoder.writableObjectMode, true)
  const decoder = parse()
  assert.equal(decoder.readableObjectMode, true)
  assert.equal(decoder.writableObjectMode, false)
  await pipeline(
    Readable.from(values),
    encoder,
    decoder,
    new Writable({
      objectMode: true,
      write(value, _, callback) {
        output.push(value)
        callback()
      },
    }),
  )
  assert.deepEqual(output, values)
})

test('reports malformed records with source, cause and physical line number', async () => {
  for (const suffix of ['', '\n']) {
    await assert.rejects(collect(['\ntrue\n{broken}' + suffix]), (error) => {
      assert.ok(error instanceof JsonLineError)
      assert.ok(error.cause instanceof SyntaxError)
      assert.equal(error.source, '{broken}')
      assert.equal(error.line, 3)
      return true
    })
  }
})

test('can skip invalid records, including an invalid final record', async () => {
  const decoder = parse({ emitInvalidLines: true })
  const errors = []
  decoder.on('invalid-line', (error) => errors.push(error))
  decoder.end('1\nno\n2\nnull\n3\nbad')
  assert.deepEqual(await Array.fromAsync(decoder), [1, 2, 3])
  assert.deepEqual(
    errors.map(({ source, line }) => [source, line]),
    [
      ['no', 2],
      ['null', 4],
      ['bad', 6],
    ],
  )
})

test('limits UTF-8 line bytes for complete and fragmented records', async () => {
  assert.deepEqual(await collect(['"é"\n'], { maxLineBytes: 4 }), ['é'])
  for (const chunks of [['\n"é"\n'], ['\n"', 'é', '"']]) {
    await assert.rejects(collect(chunks, { maxLineBytes: 3 }), {
      code: 'ERR_JSONLINES_MAX_LINE',
      line: 2,
    })
  }
  for (const maxLineBytes of [0, -1, NaN, 1.5]) {
    assert.throws(() => parse({ maxLineBytes }), RangeError)
  }
  // A limit is terminal even when malformed JSON is otherwise skipped.
  await assert.rejects(
    collect(['1234'], { maxLineBytes: 3, emitInvalidLines: true }),
    {
      code: 'ERR_JSONLINES_MAX_LINE',
    },
  )
})

test('handles large fragmented records without losing the next line', async () => {
  const value = '🌍'.repeat(40_000)
  const input = Buffer.from(JSON.stringify(value) + '\ntrue\n')
  const chunks = []
  for (let offset = 0; offset < input.length; offset += 97) {
    chunks.push(input.subarray(offset, offset + 97))
  }
  assert.deepEqual(await collect(chunks), [value, true])
  assert.deepEqual(await collect([input]), [value, true])
})

test('enforces byte limits across many records and at the decoding window boundary', async () => {
  for (const maxLineBytes of [65536, 65537]) {
    const prefix = 'true\n'.repeat(15000)
    const exact = '"' + 'x'.repeat(maxLineBytes - 2) + '"'
    const values = await collect([prefix + exact + '\nfalse\n'], {
      maxLineBytes,
    })
    assert.equal(values.length, 15002)
    assert.equal(values.at(-2).length, maxLineBytes - 2)
    assert.equal(values.at(-1), false)
    await assert.rejects(collect([prefix + exact + ' \n'], { maxLineBytes }), {
      code: 'ERR_JSONLINES_MAX_LINE',
      line: 15001,
    })
  }
})

for (const highWaterMark of [0, 1, 4]) {
  test(`pauses within a single expanding input chunk (high water mark ${highWaterMark})`, async () => {
    const decoder = parse({
      readableHighWaterMark: highWaterMark,
      writableHighWaterMark: 1,
    })
    const input = Array.from({ length: 512 }, (_, i) =>
      JSON.stringify({ i }),
    ).join('\n')
    let written = false
    decoder.end(input, () => {
      written = true
    })
    await setImmediate()
    assert.ok(decoder.readableLength <= Math.max(1, highWaterMark))
    assert.equal(written, false)
    let count = 0
    await pipeline(
      decoder,
      new Writable({
        objectMode: true,
        highWaterMark: 1,
        write(value, _, callback) {
          assert.equal(value.i, count++)
          setImmediate().then(() => callback(), callback)
        },
      }),
    )
    assert.equal(count, 512)
    assert.equal(written, true)
  })
}

test('destroy and abort release a paused write and close the pipeline', async () => {
  for (const factory of [parse, stringify]) {
    await assert.rejects(finished(factory({ signal: AbortSignal.abort() })), {
      name: 'AbortError',
    })
  }
  for (const abort of [false, true]) {
    const controller = new AbortController()
    const decoder = parse({
      readableHighWaterMark: 1,
      signal: controller.signal,
    })
    const done = finished(decoder)
    let calls = 0
    decoder.write('1\n2\n3\n', (error) => {
      calls++
      assert.ok(error)
    })
    if (abort) controller.abort()
    else decoder.destroy(new Error('stop'))
    await assert.rejects(
      done,
      abort ? { name: 'AbortError' } : { message: 'stop' },
    )
    assert.equal(calls, 1)
  }
  const source = Readable.from(['1\n', 'broken\n', '2\n'])
  await assert.rejects(
    pipeline(
      source,
      parse(),
      new Writable({
        objectMode: true,
        write(_, __, callback) {
          callback()
        },
      }),
    ),
    JsonLineError,
  )
  assert.equal(source.destroyed, true)
})

test('early iteration exit and destruction inside an invalid-line listener close cleanly', async () => {
  const decoder = parse({ readableHighWaterMark: 1 })
  decoder.end('1\n2\n3\n')
  for await (const value of decoder) {
    assert.equal(value, 1)
    break
  }
  assert.equal(decoder.destroyed, true)
  const skipping = parse({ emitInvalidLines: true })
  skipping.on('invalid-line', () => skipping.destroy())
  const closed = once(skipping, 'close')
  skipping.end('bad\n1\n')
  await closed
})

test('JSON null fails explicitly in object streams instead of silently ending them', async () => {
  await assert.rejects(collect(['null\n1\n']), {
    code: 'ERR_JSONLINES_NULL',
    line: 1,
    source: 'null',
  })
})

test('serializes compact newline-terminated JSON and rejects unrepresentable values', async () => {
  const values = [{ text: 'é\n' }, false, 0, '']
  const output = []
  await pipeline(
    Readable.from(values),
    stringify(),
    new Writable({
      write(chunk, _, callback) {
        assert.ok(Buffer.isBuffer(chunk))
        output.push(chunk)
        callback()
      },
    }),
  )
  assert.equal(
    Buffer.concat(output).toString(),
    values.map((v) => JSON.stringify(v) + '\n').join(''),
  )
  const circular = {}
  circular.self = circular
  for (const value of [
    circular,
    1n,
    undefined,
    () => {},
    Symbol('no'),
    {
      toJSON() {
        throw Object.freeze(new Error('frozen'))
      },
    },
  ]) {
    const encoder = stringify()
    const done = finished(encoder)
    encoder.write(value)
    encoder.end()
    await assert.rejects(done, (error) => {
      assert.equal(error.code, 'ERR_JSONLINES_STRINGIFY')
      assert.equal(error.source, value)
      return true
    })
  }
  await assert.rejects(Array.fromAsync(stringifyValues([undefined])), {
    code: 'ERR_JSONLINES_STRINGIFY',
  })
})

test('batches output with slow consumers and flushes sparse writes without waiting for end', async () => {
  const values = Array.from({ length: 1000 }, (_, id) => ({ id, text: 'é 🦄' }))
  const expected = values.map((value) => JSON.stringify(value) + '\n').join('')
  for (const batchBytes of [0, 1, 4096, 65536]) {
    const output = []
    await pipeline(
      Readable.from(values),
      stringify({ batchBytes, readableHighWaterMark: 1 }),
      new Writable({
        highWaterMark: 1,
        write(chunk, _, callback) {
          output.push(chunk)
          setImmediate().then(() => callback(), callback)
        },
      }),
    )
    assert.equal(Buffer.concat(output).toString(), expected)
    if (batchBytes >= 4096) assert.ok(output.length < 20)
  }
  const encoder = stringify()
  encoder.write({ sparse: true })
  const [chunk] = await once(encoder, 'data')
  assert.equal(chunk.toString(), '{"sparse":true}\n')
  encoder.end()
  await finished(encoder)
  const destroyed = stringify()
  destroyed.write({ pending: true })
  destroyed.destroy()
  await once(destroyed, 'close')
  assert.equal(destroyed.readableLength, 0)
  for (const batchBytes of [-1, Infinity, 1.5]) {
    assert.throws(() => stringify({ batchBytes }), RangeError)
  }
})

test('iterable APIs round trip every JSON value, including null, over Web Streams', async () => {
  const values = [null, true, 0, '', { text: '🧑‍🚀' }, [null]]
  const encoded = await Array.fromAsync(stringifyValues(values))
  const bytes = Buffer.from(encoded.join(''))
  const web = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i++)
        controller.enqueue(bytes.subarray(i, i + 1))
      controller.close()
    },
  })
  assert.deepEqual(await Array.fromAsync(parseValues(web)), values)
  assert.deepEqual(await Array.fromAsync(parseValues(['\r\nnull\n1'])), [
    null,
    1,
  ])
  await assert.rejects(Array.fromAsync(parseValues(['bad'])), JsonLineError)
  await assert.rejects(
    Array.fromAsync(parseValues(['123'], { maxLineBytes: 2 })),
    {
      code: 'ERR_JSONLINES_MAX_LINE',
    },
  )
})

test('iterable cancellation closes the source and signals stop between records', async () => {
  let closed = false
  async function* source() {
    try {
      yield '1\n2\n3\n'
    } finally {
      closed = true
    }
  }
  for await (const value of parseValues(source())) {
    assert.equal(value, 1)
    break
  }
  assert.equal(closed, true)
  const controller = new AbortController()
  const iterator = parseValues(['1\n2\n'], { signal: controller.signal })
  assert.deepEqual(await iterator.next(), { value: 1, done: false })
  controller.abort()
  await assert.rejects(iterator.next(), { name: 'AbortError' })
  await assert.rejects(
    Array.fromAsync(parseValues([], { signal: controller.signal })),
    { name: 'AbortError' },
  )
  const last = new AbortController()
  const finalRecord = parseValues(['1\n'], { signal: last.signal })
  assert.equal((await finalRecord.next()).value, 1)
  last.abort()
  await assert.rejects(finalRecord.next(), { name: 'AbortError' })
})
