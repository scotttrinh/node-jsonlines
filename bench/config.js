export function configuration(values = {}) {
  const quick = values.quick ?? false
  const config = {
    quick,
    processes: Number(values.processes ?? (quick ? 1 : 7)),
    records: Number(values.records ?? (quick ? 1000 : 10000)),
    time: Number(values.time ?? (quick ? 100 : 3000)),
    iterations: Number(values.iterations ?? (quick ? 2 : 50)),
    warmupTime: Number(values.warmupTime ?? (quick ? 50 : 500)),
    warmupIterations: Number(values.warmupIterations ?? (quick ? 2 : 8)),
    warmupWindows: Number(values.warmupWindows ?? (quick ? 3 : 8)),
    thresholdPercent: Number(values.thresholdPercent ?? 5),
    stabilityPercent: 5,
    memoryRecords: Number(values.memoryRecords ?? (quick ? 1000 : 300000)),
    seed: Number(values.seed ?? 0x5eed),
  }
  for (const [name, value] of Object.entries(config)) {
    if (
      typeof value === 'number' &&
      (!Number.isSafeInteger(value) || value < 1)
    ) {
      throw new Error(`${name} must be a positive safe integer`)
    }
  }
  if (config.warmupWindows < 3)
    throw new Error('At least three warmup windows are required')
  if (config.thresholdPercent >= 100)
    throw new Error('thresholdPercent must be less than 100')
  if (!quick && config.processes < 3)
    throw new Error(
      'Use at least three process pairs, or --quick for a smoke test',
    )
  return config
}
