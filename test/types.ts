import { parse, parseValues, stringify, stringifyValues, type ParseOptions } from "../src/index.js";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

interface Row {
  id: number;
}
const options: ParseOptions = { maxLineBytes: 1024, readableHighWaterMark: 1 };
parse<Row>(options)
  .on("data", (row) => {
    const id: number = row.id;
    // @ts-expect-error typed data listeners must not receive any
    const bad: string = row.id;
    void [id, bad];
  })
  .on("invalid-line", (error) => {
    const source: string = error.source;
    const line: number = error.line;
    void [source, line];
  });
for await (const row of parse<Row>(options)) {
  const id: number = row.id;
  // @ts-expect-error typed iteration must not yield any
  const bad: string = row.id;
  void [id, bad];
}
for await (const value of parseValues<Row | null>(["null\n"])) {
  const id: number | undefined = value?.id;
  void id;
}
for await (const line of stringifyValues([null, { id: 1 }])) {
  const text: string = line;
  void text;
}
await pipeline(Readable.from([{ id: 1 }]), stringify(), parse<Row>());
