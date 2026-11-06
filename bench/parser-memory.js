import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const [modulePath, scenario] = process.argv.slice(2);
const library = await import(pathToFileURL(modulePath));
async function run() {
  if (scenario === "fragmented-record") {
    const text = "x".repeat(256 * 1024);
    const bytes = Buffer.from(JSON.stringify({ text }) + "\n");
    let count = 0;
    function* chunks() {
      // Generate views lazily: a prebuilt array would keep all views alive for
      // both parsers and conceal the cost of retaining fragment references.
      for (let i = 0; i < bytes.length; i++) yield bytes.subarray(i, i + 1);
    }
    await pipeline(
      Readable.from(chunks(), { objectMode: false }),
      library.parse(),
      new Writable({
        objectMode: true,
        write(value, _, callback) {
          assert.equal(value.text, text);
          count++;
          callback();
        },
      }),
    );
    assert.equal(count, 1);
    return {};
  }
  if (scenario !== "retained-tail") throw new Error("Unknown scenario");
  const parser = library.parse();
  let input = Buffer.alloc(32 * 1024 ** 2, 10);
  input[input.length - 1] = 34; // An unfinished JSON string after empty lines.
  await new Promise((resolve, reject) =>
    parser.write(input, (error) => (error ? reject(error) : resolve())),
  );
  input = undefined;
  await setImmediate();
  globalThis.gc();
  await setImmediate();
  globalThis.gc();
  const retainedArrayBuffersMiB = process.memoryUsage().arrayBuffers / 1024 ** 2;
  const done = finished(parser);
  let count = 0;
  parser.on("data", (value) => {
    assert.equal(value, "");
    count++;
  });
  parser.end('"');
  await done;
  assert.equal(count, 1);
  return { retainedArrayBuffersMiB };
}
await run(); // Preflight is included in the peak, just like bench/worker.js.
globalThis.gc();
const baselineRssMiB = process.memoryUsage().rss / 1024 ** 2;
const observed = await run();
const resourceUsageMaxRssMiB = process.resourceUsage().maxRSS / 1024;
const vmHwm =
  process.platform === "linux"
    ? readFileSync("/proc/self/status", "utf8").match(/^VmHWM:\s+(\d+) kB$/m)
    : null;
process.stdout.write(
  JSON.stringify({
    node: process.version,
    modulePath,
    scenario,
    baselineRssMiB,
    peakRssMiB: vmHwm ? Number(vmHwm[1]) / 1024 : resourceUsageMaxRssMiB,
    peakRssSource: vmHwm ? "linux-vmhwm" : "resource-usage",
    resourceUsageMaxRssMiB,
    ...observed,
  }),
);
