# JSON Lines for Node.js

ESM-only, TypeScript-first [JSON Lines](https://jsonlines.org) streams for Node.js 22+.
Zero runtime dependencies. This fork is preparing a breaking `1.0.0-alpha.0` release;
the published `jsonlines@0.1.1` is still the original implementation.

```sh
npm install jsonlines
```

## Streams

`parse()` transforms UTF-8 bytes into objects; `stringify()` transforms objects
into UTF-8 bytes. Use `pipeline()` for backpressure, error propagation and cleanup.

```ts
import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { parse, stringify } from 'jsonlines'

await pipeline(
  createReadStream('input.jsonl'),
  parse({ maxLineBytes: 8 * 1024 * 1024 }),
  stringify(),
  createWriteStream('output.jsonl'),
)
```

`parse<T>()` provides typed async iteration, `read()` and `on('data')` listeners.
`T` describes the expected JSON; it does not perform schema validation.

```ts
const parser = parse<{ id: number }>({ emitInvalidLines: true })
parser.on('data', (record) => console.log(record.id))
parser.on('invalid-line', (error) => console.error(error.line, error.source))
await pipeline(createReadStream('input.jsonl'), parser)
```

## Async iterables and Web Streams

Node object streams reserve `null` for EOF. Use `parseValues()` and
`stringifyValues()` for datasets containing JSON `null`. These APIs also accept
Web `ReadableStream`s and synchronous iterables. Breaking iteration closes the source.

```ts
import { parseValues, stringifyValues } from 'jsonlines'

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

- `parse({ maxLineBytes })` / `parseValues(source, { maxLineBytes })`: limit UTF-8
  bytes per record, excluding LF and including any CR. Defaults to `Infinity`.
  Exceeding the limit is terminal (`ERR_JSONLINES_MAX_LINE`), even when skipping
  invalid JSON. Input buffers and a single parsed value still need to fit in memory.
- `parse({ emitInvalidLines: true })`: emit `invalid-line` and skip malformed JSON
  or unrepresentable `null` records. The default is to fail. `JsonLineError` includes
  `source`, a 1-based physical `line`, and the original `cause`.
- `parse()` / `stringify()`: accept `readableHighWaterMark`,
  `writableHighWaterMark` and `signal`. Water marks use bytes on byte sides and
  objects on object sides. They default to Node's settings.
- `stringify({ batchBytes })`: coalesce output with a default target of 64 KiB;
  flush sparse writes in a microtask and remaining output at EOF. `0` disables
  batching. A single record may exceed the target; records are never split.
- `parseValues(source, { signal })`: check cancellation between chunks and records.
  Also pass the signal to the source to interrupt a pending read.

LF, CRLF, empty lines, and an unterminated final record are supported. Whitespace-only
lines and BOMs are invalid JSON. UTF-8 sequences split across byte chunks are preserved.
String chunks must contain complete Unicode characters.

`stringify()` and `stringifyValues()` produce compact JSON with a trailing LF.
Circular references, BigInt and top-level values without a JSON representation
fail with `ERR_JSONLINES_STRINGIFY` and retain `source` and `cause`. Normal
`JSON.stringify()` semantics apply, including `toJSON()` and non-finite numbers.

## Migrating from 0.1.1

Use named ESM imports instead of `require()`. Node.js 22 is the minimum version.
The parser's writable side and stringifier's readable side now use byte mode.
Stringifier output chunks are Buffers and can contain several records; disable
batching when synchronous per-record output is needed. Use async iterable APIs
for `null`: `parse()` rejects it explicitly instead of silently truncating input,
and Node's object writable streams reject `.write(null)` themselves. Top-level
`undefined`, functions and symbols now fail instead of producing invalid `undefined` lines.

## Development

```sh
npm ci
npm run check
npm run bench:quick
npm run bench -- --output bench/results.local.json
```

The compiler is pinned to TypeScript **7.0.2**. CI covers Node 22, 24 and 26.
See [benchmark methodology and results](bench/README.md) for the comparison with
`jsonlines@0.1.1`, using Tinybench, repeated warm-up, confidence intervals and
a 5% minimum meaningful improvement. Quick benchmarks are smoke tests only.
