import { comparison, statistics } from "./statistics.js";

export function summarize(runs, config) {
  const scenarios = [...new Set(runs.map((run) => run.scenario))];
  return scenarios.flatMap((scenario) => {
    const selected = runs.filter((run) => run.scenario === scenario);
    const pairs = [];
    for (let pair = 0; pair < config.processes; pair++) {
      const modern = selected.find((r) => r.pair === pair && r.implementation === "modern");
      const legacy = selected.find((r) => r.pair === pair && r.implementation === "legacy");
      if (modern && legacy)
        pairs.push({
          modern: modern.latency.mean,
          legacy: legacy.latency.mean,
          stable: modern.warmup.stable && legacy.warmup.stable,
        });
    }
    if (!pairs.length) return [];
    const implementations = Object.fromEntries(
      ["modern", "legacy"].map((name) => {
        const matching = selected.filter((r) => r.implementation === name);
        return [
          name,
          {
            processMeanLatencyMs: statistics(matching.map((r) => r.latency.mean)),
            mibPerSecond: statistics(matching.map((r) => r.mibPerSecond)),
            recordsPerSecond: statistics(matching.map((r) => r.recordsPerSecond)),
            withinProcess: matching.map((r) => ({
              pair: r.pair,
              iterations: r.latency.samplesCount,
              meanMs: r.latency.mean,
              sdMs: r.latency.sd,
              cvPercent: (100 * r.latency.sd) / r.latency.mean,
              rmePercent: r.latency.rme,
              warmupStable: r.warmup.stable,
              warmupWindows: r.warmup.windows.length,
              measurementDriftPercent: r.measurementDriftPercent,
            })),
          },
        ];
      }),
    );
    return [
      {
        scenario,
        ...comparison(pairs, config.thresholdPercent, config.quick),
        ...implementations,
      },
    ];
  });
}

export function formatResult(result) {
  const ci = result.ci95?.map((v) => v.toFixed(4)).join(", ") ?? "unavailable";
  const rate = (impl) =>
    `${result[impl].mibPerSecond.mean.toFixed(1)} ± ${result[impl].mibPerSecond.sd?.toFixed(1) ?? "n/a"} MiB/s (process SD; CV ${result[impl].mibPerSecond.cvPercent?.toFixed(1) ?? "n/a"}%)`;
  return `${result.scenario}: ${rate("modern")} / ${rate("legacy")}; ratio ${result.ratio.toFixed(3)}x, 95% CI [${ci}]; ${result.verdict}`;
}
