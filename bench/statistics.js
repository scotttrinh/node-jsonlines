// Two-sided Student t critical values at 95%, df 1..30. For larger df,
// use df=30 conservatively rather than a normal approximation.
const critical95 = [
  NaN,
  12.7062047364,
  4.30265272975,
  3.18244630528,
  2.7764451052,
  2.57058183564,
  2.44691184879,
  2.36462425101,
  2.3060041352,
  2.2621571628,
  2.22813885196,
  2.20098516008,
  2.17881282966,
  2.16036865646,
  2.14478668792,
  2.13144954556,
  2.11990529922,
  2.10981557783,
  2.10092204024,
  2.09302405441,
  2.08596344727,
  2.07961384473,
  2.0738730679,
  2.06865761042,
  2.06389856163,
  2.05953855275,
  2.05552943864,
  2.05183051648,
  2.0484071418,
  2.04522964213,
  2.0422724563,
]

export function statistics(values) {
  if (values.length === 0 || values.some((v) => !Number.isFinite(v))) {
    throw new Error('Statistics require finite samples')
  }
  const n = values.length
  const mean = values.reduce((sum, value) => sum + value, 0) / n
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(n / 2)
  const median =
    n % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
  const sd =
    n < 2
      ? null
      : Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1))
  const margin =
    sd === null ? null : (critical95[Math.min(n - 1, 30)] * sd) / Math.sqrt(n)
  return {
    n,
    mean,
    median,
    sd,
    cvPercent: sd === null || mean === 0 ? null : (100 * sd) / Math.abs(mean),
    ci95: margin === null ? null : [mean - margin, mean + margin],
    min: sorted[0],
    max: sorted.at(-1),
  }
}

/** The independent unit is a fresh-process pair, never an inner iteration. */
export function comparison(pairs, thresholdPercent, smokeOnly = false) {
  const ratios = pairs.map(({ modern, legacy }) => {
    if (modern <= 0 || legacy <= 0)
      throw new Error('Latencies must be positive')
    return Math.log(legacy / modern)
  })
  const log = statistics(ratios)
  const ratio = Math.exp(log.mean)
  const ci95 = log.ci95?.map(Math.exp) ?? null
  const threshold = thresholdPercent / 100
  let verdict = 'inconclusive'
  if (smokeOnly || pairs.length < 3) verdict = 'smoke-only'
  else if (pairs.some((pair) => !pair.stable)) verdict = 'inconclusive-warmup'
  else if (ci95[0] > 1 + threshold) verdict = 'meaningfully-faster'
  else if (ci95[1] < 1 - threshold) verdict = 'meaningfully-slower'
  else if (ci95[0] >= 1 - threshold && ci95[1] <= 1 + threshold)
    verdict = 'within-practical-band'
  return {
    pairs: pairs.length,
    ratio,
    changePercent: 100 * (ratio - 1),
    ci95,
    thresholdPercent,
    verdict,
    logRatio: log,
  }
}
