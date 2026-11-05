# @scotttrinh/jsonlines

ESM-only, TypeScript-first [JSON Lines](https://jsonlines.org) streams for Node.js 22+.
Zero runtime dependencies.

```sh
npm install @scotttrinh/jsonlines
```

## Node.js streams

`parse<T>(options?)` transforms UTF-8 bytes into JavaScript values.
`stringify(options?)` transforms values into compact JSON encoded as UTF-8 Buffers,
with a trailing LF per record. Both return Node.js Transforms; use `pipeline()`
for backpressure, error propagation and cleanup.

```ts
import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { parse, stringify } from '@scotttrinh/jsonlines'

await pipeline(
  createReadStream('input.jsonl'),
  parse({ maxLineBytes: 8 * 1024 * 1024 }),
  stringify(),
  createWriteStream('output.jsonl'),
)
```

`parse<T>()` types async iteration, `read()` and `on('data')` listeners. `T`
describes the expected JSON and does not perform schema validation. The exported
`Parser<T>` and `Stringifier` classes accept the same options as their factories.

```ts
const parser = parse<{ id: number }>({ emitInvalidLines: true })
parser.on('data', (record) => console.log(record.id))
parser.on('invalid-line', (error) => console.error(error.line, error.source))
await pipeline(createReadStream('input.jsonl'), parser)
```

Node object streams reserve `null` for EOF: `parse()` rejects JSON `null`, and
`stringify()` cannot accept `.write(null)`. Use the iterable APIs for those values.

## Iterables and Web Streams

`parseValues<T>(source, options?)` accepts synchronous or asynchronous iterables
of strings or `Uint8Array`s, including Node Readables and Web ReadableStreams.
It yields parsed values, including `null`. Breaking iteration closes the source.
`stringifyValues(source)` accepts synchronous or asynchronous iterables of values
and yields compact JSON strings with a trailing LF.

```ts
import { parseValues, stringifyValues } from '@scotttrinh/jsonlines'

for await (const record of parseValues<{ id: number } | null>(
  createReadStream('input.jsonl'),
  { maxLineBytes: 8 * 1024 * 1024 },
)) {
  console.log(record?.id)
}

await pipeline(
  stringifyValues([{ id: 1 }, null, { id: 2 }]),
  createWriteStream('output.jsonl'),
)
```

## Options and errors

- `maxLineBytes` in `parse()` and `parseValues()`: maximum UTF-8 bytes per line,
  excluding LF and including any CR. Defaults to `Infinity`. Exceeding it fails
  with `ERR_JSONLINES_MAX_LINE`, even when skipping invalid JSON.
- `emitInvalidLines` in `parse()`: when `true`, emit `invalid-line` and skip
  malformed JSON or unrepresentable `null` records. Defaults to `false`.
  `JsonLineError` (`ERR_JSONLINES_PARSE`) includes `source`, a 1-based physical
  `line`, and the original `cause`; a `null` error has code `ERR_JSONLINES_NULL`,
  `source` and `line`.
- `readableHighWaterMark` and `writableHighWaterMark` in `parse()` and
  `stringify()`: use bytes on byte sides and objects on object sides. Defaults
  follow Node's settings. Input buffers and individual values must fit in memory.
- `signal` in `parse()`, `stringify()` and `parseValues()`: cancel processing.
  `parseValues()` checks between chunks and records; also pass the signal to
  the source to interrupt a pending read.
- `batchBytes` in `stringify()`: output target in UTF-8 bytes. Defaults to 64 KiB,
  with at most 64 records per batch. Sparse writes flush in a microtask; remaining
  output flushes at EOF. `0` disables batching. A single record can exceed the
  target; records are never split between output chunks.

Parsers accept LF, CRLF, empty lines and an unterminated final record. Whitespace-only
lines and BOMs are invalid JSON. Split UTF-8 sequences in byte chunks are preserved;
string chunks must contain complete Unicode characters.

Serialization follows `JSON.stringify()` semantics, including `toJSON()` and
non-finite numbers. Circular references, BigInt and top-level values without a
JSON representation fail with `ERR_JSONLINES_STRINGIFY`, retaining `source` and
`cause`.

## Development

```sh
npm ci
npm run check
npm run bench:quick
```

TypeScript is pinned to **7.0.2**. CI covers Node 22, 24 and 26.
See [benchmarks](bench/README.md) for running throughput and memory comparisons.
