export const scenarios = [
  "parse-small",
  "parse-unicode",
  "parse-limited",
  "parse-fragmented",
  "parse-large-record",
  "parse-backpressure",
  "stringify-small",
  "stringify-unicode",
];

/** Build deterministic, varied records outside timing. A pair shares its seed. */
export function fixture(scenario, requestedRecords, seed = 0x5eed, bounded = false) {
  if (!scenarios.includes(scenario)) throw new Error(`Unknown scenario: ${scenario}`);
  const unicode = scenario.endsWith("unicode");
  const large = scenario === "parse-large-record";
  const records = large ? Math.max(4, Math.ceil(requestedRecords / 2000)) : requestedRecords;
  const poolSize = bounded ? Math.min(records, large ? 4 : 1024) : records;
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  const rows = Array.from({ length: poolSize }, (_, id) => {
    const token = random().toString(36);
    const text = large
      ? (token + "x".repeat(256 * 1024)).slice(0, 256 * 1024)
      : (unicode ? "café 日本語 🦄 " : "the quick brown fox ").repeat(1 + (random() % 4)) + token;
    return id % 3 === 0
      ? {
          id,
          active: id % 2 === 0,
          text,
          tags: [id % 7, token],
          detail: { score: random() % 1000 },
        }
      : { id, active: id % 2 === 0, text };
  });
  const lines = rows.map((row) => JSON.stringify(row) + "\n");
  const lengths = lines.map((line) => Buffer.byteLength(line));
  const pool = Buffer.from(lines.join(""));
  const cycles = Math.floor(records / poolSize);
  const remainder = records % poolSize;
  const remainderBytes = lengths.slice(0, remainder).reduce((a, b) => a + b, 0);
  const bytes = pool.length * cycles + remainderBytes;
  const sum = (fn) =>
    rows.reduce((a, row) => a + fn(row), 0) * cycles +
    rows.slice(0, remainder).reduce((a, row) => a + fn(row), 0);
  const checksum = sum((row) => row.id);
  const textLength = sum((row) => row.text.length);
  const chunkSize = large ? 1024 : scenario === "parse-fragmented" ? 7 : 64 * 1024;
  const blocks = [];
  for (let start = 0; start < pool.length;) {
    let end = Math.min(pool.length, start + chunkSize);
    // Keep baseline Unicode correct. Fragmentation comparisons deliberately use ASCII.
    if (unicode && end < pool.length) end = pool.lastIndexOf(10, end - 1) + 1;
    if (end <= start) throw new Error("Record does not fit Unicode chunk size");
    blocks.push(pool.subarray(start, end));
    start = end;
  }
  let entire;
  if (scenario === "parse-backpressure") {
    entire = Buffer.allocUnsafe(bytes);
    for (let i = 0; i < cycles; i++) pool.copy(entire, i * pool.length);
    if (remainder) pool.copy(entire, cycles * pool.length, 0, remainderBytes);
  }
  function* chunks() {
    if (entire) {
      yield entire;
      return;
    }
    for (let i = 0; i < cycles; i++) yield* blocks;
    if (remainder) {
      for (const block of blocks) {
        if (block.byteOffset - pool.byteOffset >= remainderBytes) break;
        yield block.subarray(
          0,
          Math.min(block.length, remainderBytes - (block.byteOffset - pool.byteOffset)),
        );
      }
    }
  }
  function* values() {
    for (let i = 0; i < cycles; i++) yield* rows;
    for (let i = 0; i < remainder; i++) yield rows[i];
  }
  return { records, bytes, checksum, textLength, chunks, values };
}
