import assert from "node:assert/strict";
import { once } from "node:events";
import { Readable, Writable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import fc from "fast-check";
import { JsonLineError, parse, parseValues, stringify, stringifyValues } from "../dist/index.js";

fc.configureGlobal({
  numRuns: Number(process.env.FC_RUNS ?? 100),
  ...(process.env.FC_SEED === undefined ? {} : { seed: Number(process.env.FC_SEED) }),
  ...(process.env.FC_PATH === undefined ? {} : { path: process.env.FC_PATH }),
});

const textUnit = fc.oneof(
  fc.constantFrom("é", "日本語", "🦄", "\n", "\r", "\t", '"', "\\", "\ud800", "\udfff", "\0"),
  fc.string({ unit: "binary", minLength: 1, maxLength: 1 }),
);
const jsonValue = fc.jsonValue({ maxDepth: 3, stringUnit: textUnit });
// Node reserves top-level null for EOF; nested null is still valid.
const streamValue = jsonValue.filter((value) => value !== null);
const chunkSizes = fc.array(fc.integer({ min: 1, max: 128 }), {
  minLength: 1,
  maxLength: 12,
});
const lineEnding = fc.constantFrom("\n", "\r\n");
const blankLines = fc.array(lineEnding, { maxLength: 3 }).map((lines) => lines.join(""));
const normalize = (value) => JSON.parse(JSON.stringify(value));

function* fragment(bytes, sizes) {
  let offset = 0;
  for (let i = 0; offset < bytes.length; i++) {
    const end = Math.min(bytes.length, offset + sizes[i % sizes.length]);
    yield bytes.subarray(offset, end);
    offset = end;
  }
}

async function collect(chunks, options, invalidLines) {
  const decoder = parse(options);
  if (invalidLines) decoder.on("invalid-line", (error) => invalidLines.push(error));
  const values = [];
  await pipeline(
    Readable.from(chunks, { objectMode: false }),
    decoder,
    new Writable({
      objectMode: true,
      write(value, _, callback) {
        values.push(value);
        callback();
      },
    }),
  );
  return values;
}

test("parsing is independent of UTF-8 chunk boundaries and line layout", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(streamValue, { maxLength: 20 }),
      lineEnding,
      blankLines,
      fc.boolean(),
      chunkSizes,
      async (values, ending, padding, terminated, sizes) => {
        const input = Buffer.from(
          padding +
            values.map(JSON.stringify).join(ending + padding) +
            (values.length && terminated ? ending : ""),
        );
        const expected = values.map(normalize);
        assert.deepEqual(await collect(fragment(input, sizes)), expected);
        assert.deepEqual(await Array.fromAsync(parseValues(fragment(input, sizes))), expected);
      },
    ),
    {
      examples: [
        [[{ text: "café 🦄 日本語" }, false, 0, "", [1, null]], "\r\n", "\n\r\n", false, [1]],
        [[], "\n", "", false, [1]],
      ],
    },
  );
});

test("stream sides use bytes and objects in the expected directions", () => {
  const encoder = stringify();
  assert.equal(encoder.readableObjectMode, false);
  assert.equal(encoder.writableObjectMode, true);
  const decoder = parse();
  assert.equal(decoder.readableObjectMode, true);
  assert.equal(decoder.writableObjectMode, false);
  encoder.destroy();
  decoder.destroy();
});

test("malformed records retain their source and physical line across fragmentation", async () => {
  const validLine = fc.oneof(
    fc
      .tuple(streamValue, fc.boolean())
      .map(([value, cr]) => JSON.stringify(value) + (cr ? "\r" : "")),
    fc.constantFrom("", "\r"),
  );
  const malformed = fc.oneof(
    fc.constantFrom(" ", "\t", "{", "[1,]", '"unterminated', "\ufeff1"),
    streamValue.map((value) => JSON.stringify(value) + "!"),
  );
  await fc.assert(
    fc.asyncProperty(
      fc.array(validLine, { maxLength: 10 }),
      fc.tuple(malformed, fc.boolean()).map(([source, cr]) => source + (cr ? "\r" : "")),
      fc.array(validLine, { maxLength: 10 }),
      fc.boolean(),
      chunkSizes,
      async (before, source, after, terminated, sizes) => {
        const input = Buffer.from(
          [...before, source, ...after].join("\n") + (terminated ? "\n" : ""),
        );
        const checkError = (error) => {
          assert.ok(error instanceof JsonLineError);
          assert.ok(error.cause instanceof SyntaxError);
          assert.equal(error.code, "ERR_JSONLINES_PARSE");
          assert.equal(error.source, source);
          assert.equal(error.line, before.length + 1);
          return true;
        };
        await assert.rejects(collect(fragment(input, sizes)), checkError);
        await assert.rejects(Array.fromAsync(parseValues(fragment(input, sizes))), checkError);
        const errors = [];
        const expected = [...before, ...after]
          .filter((line) => line !== "" && line !== "\r")
          .map((line) => JSON.parse(line));
        assert.deepEqual(
          await collect(fragment(input, sizes), { emitInvalidLines: true }, errors),
          expected,
        );
        assert.equal(errors.length, 1);
        checkError(errors[0]);
      },
    ),
  );
});

test("can skip invalid records, including an invalid final record", async () => {
  const decoder = parse({ emitInvalidLines: true });
  const errors = [];
  decoder.on("invalid-line", (error) => errors.push(error));
  decoder.end("1\nno\n2\nnull\n3\nbad");
  assert.deepEqual(await Array.fromAsync(decoder), [1, 2, 3]);
  assert.deepEqual(
    errors.map(({ source, line }) => [source, line]),
    [
      ["no", 2],
      ["null", 4],
      ["bad", 6],
    ],
  );
});

test("line limits accept the exact UTF-8 byte length and reject one byte less", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.string({ unit: textUnit, maxLength: 80 }),
      fc.integer({ min: 0, max: 8 }),
      lineEnding,
      fc.boolean(),
      chunkSizes,
      async (value, blanks, ending, terminated, sizes) => {
        const source = JSON.stringify(value) + (ending === "\r\n" ? "\r" : "");
        const bytes = Buffer.byteLength(source);
        const input = Buffer.from(ending.repeat(blanks) + source + (terminated ? "\n" : ""));
        assert.deepEqual(await collect(fragment(input, sizes), { maxLineBytes: bytes }), [value]);
        assert.deepEqual(
          await Array.fromAsync(parseValues(fragment(input, sizes), { maxLineBytes: bytes })),
          [value],
        );
        const error = { code: "ERR_JSONLINES_MAX_LINE", line: blanks + 1 };
        await assert.rejects(
          collect(fragment(input, sizes), {
            maxLineBytes: bytes - 1,
            emitInvalidLines: true,
          }),
          error,
        );
        await assert.rejects(
          Array.fromAsync(parseValues(fragment(input, sizes), { maxLineBytes: bytes - 1 })),
          error,
        );
      },
    ),
    { examples: [["é🦄", 2, "\r\n", false, [1]]] },
  );
});

test("validates line limits and treats oversized invalid JSON as terminal", async () => {
  for (const maxLineBytes of [0, -1, NaN, 1.5]) {
    assert.throws(() => parse({ maxLineBytes }), RangeError);
  }
  await assert.rejects(collect(["broken"], { maxLineBytes: 3, emitInvalidLines: true }), {
    code: "ERR_JSONLINES_MAX_LINE",
  });
});

test("counts original bytes when malformed UTF-8 decodes to replacement characters", async () => {
  const input = Buffer.from([10, 34, 0xf0, 0x9f, 34, 10]);
  for (let split = 0; split <= input.length; split++) {
    const chunks = [input.subarray(0, split), input.subarray(split)];
    assert.deepEqual(await collect(chunks, { maxLineBytes: 4 }), ["�"]);
    assert.deepEqual(await Array.fromAsync(parseValues(chunks, { maxLineBytes: 4 })), ["�"]);
    await assert.rejects(collect(chunks, { maxLineBytes: 3 }), {
      code: "ERR_JSONLINES_MAX_LINE",
      line: 2,
    });
  }
});

test("handles large fragmented records without losing the next line", async () => {
  const value = "🌍".repeat(40_000);
  const input = Buffer.from(JSON.stringify(value) + "\ntrue\n");
  const chunks = [];
  for (let offset = 0; offset < input.length; offset += 97) {
    chunks.push(input.subarray(offset, offset + 97));
  }
  assert.deepEqual(await collect(chunks), [value, true]);
  assert.deepEqual(await collect([input]), [value, true]);
});

test("enforces byte limits across many records and 64 KiB boundaries", async () => {
  for (const maxLineBytes of [65536, 65537]) {
    const prefix = "true\n".repeat(15000);
    const exact = '"' + "x".repeat(maxLineBytes - 2) + '"';
    const values = await collect([prefix + exact + "\nfalse\n"], {
      maxLineBytes,
    });
    assert.equal(values.length, 15002);
    assert.equal(values.at(-2).length, maxLineBytes - 2);
    assert.equal(values.at(-1), false);
    await assert.rejects(collect([prefix + exact + " \n"], { maxLineBytes }), {
      code: "ERR_JSONLINES_MAX_LINE",
      line: 15001,
    });
  }
});

for (const highWaterMark of [0, 1, 4]) {
  test(`pauses within a single expanding input chunk (high water mark ${highWaterMark})`, async () => {
    const decoder = parse({
      readableHighWaterMark: highWaterMark,
      writableHighWaterMark: 1,
    });
    const input = Array.from({ length: 512 }, (_, i) => JSON.stringify({ i })).join("\n");
    let written = false;
    decoder.end(input, () => {
      written = true;
    });
    await setImmediate();
    assert.ok(decoder.readableLength <= Math.max(1, highWaterMark));
    assert.equal(written, false);
    let count = 0;
    await pipeline(
      decoder,
      new Writable({
        objectMode: true,
        highWaterMark: 1,
        write(value, _, callback) {
          assert.equal(value.i, count++);
          setImmediate().then(() => callback(), callback);
        },
      }),
    );
    assert.equal(count, 512);
    assert.equal(written, true);
  });
}

test("destroy and abort release a paused write and close the pipeline", async () => {
  for (const factory of [parse, stringify]) {
    await assert.rejects(finished(factory({ signal: AbortSignal.abort() })), {
      name: "AbortError",
    });
  }
  for (const abort of [false, true]) {
    const controller = new AbortController();
    const decoder = parse({
      readableHighWaterMark: 1,
      signal: controller.signal,
    });
    const done = finished(decoder);
    let calls = 0;
    decoder.write("1\n2\n3\n", (error) => {
      calls++;
      assert.ok(error);
    });
    if (abort) controller.abort();
    else decoder.destroy(new Error("stop"));
    await assert.rejects(done, abort ? { name: "AbortError" } : { message: "stop" });
    assert.equal(calls, 1);
  }
  const source = Readable.from(["1\n", "broken\n", "2\n"]);
  await assert.rejects(
    pipeline(
      source,
      parse(),
      new Writable({
        objectMode: true,
        write(_, __, callback) {
          callback();
        },
      }),
    ),
    JsonLineError,
  );
  assert.equal(source.destroyed, true);
});

test("early iteration exit and destruction inside an invalid-line listener close cleanly", async () => {
  const decoder = parse({ readableHighWaterMark: 1 });
  decoder.end("1\n2\n3\n");
  for await (const value of decoder) {
    assert.equal(value, 1);
    break;
  }
  assert.equal(decoder.destroyed, true);
  const skipping = parse({ emitInvalidLines: true });
  skipping.on("invalid-line", () => skipping.destroy());
  const closed = once(skipping, "close");
  skipping.end("bad\n1\n");
  await closed;
});

test("JSON null fails explicitly in object streams instead of silently ending them", async () => {
  await assert.rejects(collect(["null\n1\n"]), {
    code: "ERR_JSONLINES_NULL",
    line: 1,
    source: "null",
  });
});

test("serialization matches native JSON bytes regardless of batching and backpressure", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(streamValue, { maxLength: 100 }),
      fc.oneof(fc.constantFrom(0, 1, 4096, 65536), fc.integer({ min: 0, max: 65536 })),
      fc.constantFrom(0, 1, 4, 16),
      async (values, batchBytes, highWaterMark) => {
        const output = [];
        await pipeline(
          Readable.from(values),
          stringify({ batchBytes, readableHighWaterMark: highWaterMark }),
          new Writable({
            highWaterMark: 1,
            write(chunk, _, callback) {
              output.push(chunk);
              setImmediate().then(() => callback(), callback);
            },
          }),
        );
        const expected = Buffer.from(values.map((value) => JSON.stringify(value) + "\n").join(""));
        assert.ok(output.every(Buffer.isBuffer));
        assert.deepEqual(Buffer.concat(output), expected);
        assert.deepEqual(await collect(output), values.map(normalize));
        for (const chunk of output) {
          const lines = chunk.toString("utf8").split("\n");
          assert.equal(lines.at(-1), "");
          assert.ok(lines.length - 1 <= 64);
          if (batchBytes > 0 && chunk.length > batchBytes) assert.equal(lines.length, 2);
        }
      },
    ),
    {
      examples: [
        [
          Array.from({ length: 129 }, (_, id) => ({
            id,
            text: 'é🦄\ud800\n"\\',
          })),
          4096,
          1,
        ],
        [[false, 0, "", [null]], 0, 0],
      ],
    },
  );
});

test("rejects values without a JSON representation", async () => {
  const circular = {};
  circular.self = circular;
  for (const value of [
    circular,
    1n,
    undefined,
    () => {},
    Symbol("no"),
    {
      toJSON() {
        throw Object.freeze(new Error("frozen"));
      },
    },
  ]) {
    const encoder = stringify();
    const done = finished(encoder);
    encoder.write(value);
    encoder.end();
    await assert.rejects(done, (error) => {
      assert.equal(error.code, "ERR_JSONLINES_STRINGIFY");
      assert.equal(error.source, value);
      return true;
    });
  }
  await assert.rejects(Array.fromAsync(stringifyValues([undefined])), {
    code: "ERR_JSONLINES_STRINGIFY",
  });
});

test("batches output with slow consumers and flushes sparse writes without waiting for end", async () => {
  const values = Array.from({ length: 1000 }, (_, id) => ({ id, text: "é 🦄" }));
  values.splice(50, 0, { id: -1, text: "🌍".repeat(20000) }, { id: -2, text: '\ud800\n\r\t"\\' });
  const expected = values.map((value) => JSON.stringify(value) + "\n").join("");
  for (const batchBytes of [0, 1, 4096, 65536]) {
    const output = [];
    await pipeline(
      Readable.from(values),
      stringify({ batchBytes, readableHighWaterMark: 1 }),
      new Writable({
        highWaterMark: 1,
        write(chunk, _, callback) {
          output.push(chunk);
          setImmediate().then(() => callback(), callback);
        },
      }),
    );
    assert.equal(Buffer.concat(output).toString(), expected);
    if (batchBytes > 0) {
      for (const chunk of output) {
        if (chunk.length > batchBytes) {
          // Only an individual record may exceed the byte target.
          assert.equal(chunk.toString().split("\n").length, 2);
        }
      }
    }
    if (batchBytes >= 4096) assert.ok(output.length < 20);
  }
  const encoder = stringify();
  encoder.write({ sparse: true });
  const [chunk] = await once(encoder, "data");
  assert.equal(chunk.toString(), '{"sparse":true}\n');
  encoder.end();
  await finished(encoder);
  const destroyed = stringify();
  destroyed.write({ pending: true });
  destroyed.destroy();
  await once(destroyed, "close");
  assert.equal(destroyed.readableLength, 0);
  for (const batchBytes of [-1, Infinity, 1.5]) {
    assert.throws(() => stringify({ batchBytes }), RangeError);
  }
});

test("iterable APIs preserve JSON values including null through fragmented Web Streams", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(jsonValue, { maxLength: 20 }),
      chunkSizes,
      async (generated, sizes) => {
        const values = [null, ...generated];
        const encoded = await Array.fromAsync(stringifyValues(values));
        assert.deepEqual(
          encoded,
          values.map((value) => JSON.stringify(value) + "\n"),
        );
        const bytes = Buffer.from(encoded.join(""));
        const web = new ReadableStream({
          start(controller) {
            for (const chunk of fragment(bytes, sizes)) controller.enqueue(chunk);
            controller.close();
          },
        });
        assert.deepEqual(await Array.fromAsync(parseValues(web)), values.map(normalize));
      },
    ),
    { examples: [[["🧑‍🚀", false, 0, "", [null]], [1]]] },
  );
});

test("iterable cancellation closes the source and signals stop between records", async () => {
  let closed = false;
  async function* source() {
    try {
      yield "1\n2\n3\n";
    } finally {
      closed = true;
    }
  }
  for await (const value of parseValues(source())) {
    assert.equal(value, 1);
    break;
  }
  assert.equal(closed, true);
  const controller = new AbortController();
  const iterator = parseValues(["1\n2\n"], { signal: controller.signal });
  assert.deepEqual(await iterator.next(), { value: 1, done: false });
  controller.abort();
  await assert.rejects(iterator.next(), { name: "AbortError" });
  await assert.rejects(Array.fromAsync(parseValues([], { signal: controller.signal })), {
    name: "AbortError",
  });
  const last = new AbortController();
  const finalRecord = parseValues(["1\n"], { signal: last.signal });
  assert.equal((await finalRecord.next()).value, 1);
  last.abort();
  await assert.rejects(finalRecord.next(), { name: "AbortError" });
});
