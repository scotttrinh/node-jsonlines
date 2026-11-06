import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { cpus, platform, arch, release } from "node:os";
import { basename, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzip } from "node:zlib";
import { configuration } from "./config.js";
import { scenarios } from "./fixtures.js";
import { formatResult, summarize } from "./report.js";

const { values } = parseArgs({
  options: {
    quick: { type: "boolean", default: false },
    baseline: { type: "string" },
    processes: { type: "string" },
    records: { type: "string" },
    time: { type: "string" },
    iterations: { type: "string" },
    "warmup-time": { type: "string" },
    "warmup-iterations": { type: "string" },
    "warmup-windows": { type: "string" },
    "threshold-percent": { type: "string" },
    "memory-records": { type: "string" },
    seed: { type: "string" },
    scenario: { type: "string", multiple: true },
    output: { type: "string" },
  },
});
const config = configuration({
  ...values,
  baseline: values.baseline ? pathToFileURL(resolve(values.baseline)).href : undefined,
  warmupTime: values["warmup-time"],
  warmupIterations: values["warmup-iterations"],
  warmupWindows: values["warmup-windows"],
  thresholdPercent: values["threshold-percent"],
  memoryRecords: values["memory-records"],
});
const selected = values.scenario ?? scenarios;
if (
  !selected.length ||
  new Set(selected).size !== selected.length ||
  selected.some((scenario) => !scenarios.includes(scenario))
)
  throw new Error("Select distinct known scenarios");
const execute = promisify(execFile);
const compress = promisify(gzip);
const runs = [],
  diagnostics = [];
const environment = {
  date: new Date().toISOString(),
  node: process.version,
  v8: process.versions.v8,
  platform: `${platform()} ${release()} ${arch()}`,
  cpu: cpus()[0]?.model,
  logicalCpus: cpus().length,
  baseline: config.baseline,
  legacyVersion: config.baseline === "jsonlines-legacy" ? "0.1.1" : null,
  tinybenchVersion: "6.2.3",
};
const rawPath = values.output
  ? values.output.replace(/\.json$/, "") + ".samples.json.gz"
  : undefined;
async function checkpoint(complete = false) {
  if (!values.output) return;
  const summary = {
    schemaVersion: 2,
    complete,
    environment,
    config,
    comparisons: summarize(runs, config),
    diagnostics,
    rawSamples: basename(rawPath),
  };
  // Compression and disk I/O happen between workers, outside every measurement.
  await writeFile(rawPath, await compress(JSON.stringify({ ...summary, runs })));
  await writeFile(values.output, JSON.stringify(summary, null, 2) + "\n");
}
async function worker(implementation, scenario, pair, mode) {
  const { stdout } = await execute(
    process.execPath,
    [
      "--expose-gc",
      fileURLToPath(new URL("./worker.js", import.meta.url)),
      implementation,
      scenario,
      JSON.stringify({ ...config, seed: config.seed + pair }),
      mode,
    ],
    { maxBuffer: 32 * 1024 * 1024, timeout: 10 * 60_000 },
  );
  return { pair, ...JSON.parse(stdout) };
}
console.log(JSON.stringify({ environment, config }));
await checkpoint();
for (const scenario of selected) {
  for (let pair = 0; pair < config.processes; pair++) {
    for (const implementation of pair % 2 ? ["legacy", "modern"] : ["modern", "legacy"]) {
      runs.push(await worker(implementation, scenario, pair, "timing"));
      await checkpoint();
    }
    const recent = runs.filter((r) => r.scenario === scenario && r.pair === pair);
    console.log(
      `${scenario}: process pair ${pair + 1}/${config.processes}, iterations ${recent.map((r) => `${r.implementation}=${r.latency.samplesCount}`).join(", ")}; warmup ${recent.every((r) => r.warmup.stable) ? "stable" : "NOT STABLE"}`,
    );
  }
  for (const implementation of ["modern", "legacy"]) {
    diagnostics.push(await worker(implementation, scenario, 0, "memory"));
  }
  console.log(formatResult(summarize(runs, config).find((r) => r.scenario === scenario)));
  await checkpoint();
}
await checkpoint(true);
