/** Incremental UTF-8 framing. Only a record spanning chunks is copied. */
export class Lines {
  line = 0
  private chunk: Buffer | undefined
  private offset = 0
  private scratch: Buffer | undefined
  private length = 0
  private text = ''
  private textOffset = 0

  constructor(private readonly maxLineBytes: number) {
    if (
      maxLineBytes !== Infinity &&
      (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1)
    ) {
      throw new RangeError(
        'maxLineBytes must be a positive safe integer or Infinity',
      )
    }
  }

  setChunk(chunk: Buffer): void {
    this.chunk = chunk
    this.offset = 0
  }

  next(): string | undefined {
    if (this.textOffset < this.text.length) return this.nextText()
    return this.nextChunk()
  }

  private nextChunk(): string | undefined {
    this.text = ''
    const chunk = this.chunk
    if (chunk === undefined) return undefined
    const start = this.offset
    const end = chunk.indexOf(10, start)
    if (end === -1) {
      this.append(chunk, start, chunk.length)
      this.chunk = undefined
      return undefined
    }
    this.checkLength(this.length + end - start)
    this.offset = end + 1
    if (this.length === 0 && this.maxLineBytes >= 64 * 1024) {
      // Decode a bounded window once instead of invoking the UTF-8 decoder for
      // every small record. Window boundaries always fall on LF, so split
      // multibyte characters stay in the byte-oriented partial-record path.
      // Every record in the window fits the byte limit. If the first record
      // itself exceeds the window, checkLength() above has already checked it.
      const windowEnd = Math.max(
        end,
        chunk.lastIndexOf(10, Math.min(start + 64 * 1024, chunk.length - 1)),
      )
      this.text = chunk.toString('utf8', start, windowEnd + 1)
      this.textOffset = 0
      this.offset = windowEnd + 1
      return this.nextText()
    }
    this.line++
    if (this.length === 0) return chunk.toString('utf8', start, end)
    this.append(chunk, start, end)
    return this.takePartial()
  }

  finish(): string | undefined {
    if (this.length === 0) return undefined
    this.line++
    return this.takePartial()
  }

  clear(): void {
    this.chunk = undefined
    this.scratch = undefined
    this.length = 0
    this.text = ''
  }

  private nextText(): string {
    const end = this.text.indexOf('\n', this.textOffset)
    const result = this.text.slice(this.textOffset, end)
    this.textOffset = end + 1
    this.line++
    return result
  }

  private checkLength(length: number): void {
    if (length > this.maxLineBytes) {
      throw Object.assign(
        new RangeError(
          `JSON line ${this.line + 1} exceeds maxLineBytes (${this.maxLineBytes})`,
        ),
        { code: 'ERR_JSONLINES_MAX_LINE', line: this.line + 1 },
      )
    }
  }

  private append(chunk: Buffer, start: number, end: number): void {
    const length = end - start
    if (length === 0) return
    const required = this.length + length
    this.checkLength(required)
    if (this.scratch === undefined || this.scratch.length < required) {
      // Geometric growth prevents quadratic copying of highly fragmented lines.
      const capacity = Math.min(
        this.maxLineBytes,
        Math.max(required, (this.scratch?.length ?? 512) * 2),
      )
      const next = Buffer.allocUnsafe(capacity)
      this.scratch?.copy(next, 0, 0, this.length)
      this.scratch = next
    }
    chunk.copy(this.scratch, this.length, start, end)
    this.length = required
  }

  private takePartial(): string {
    const result = this.scratch!.toString('utf8', 0, this.length)
    this.length = 0
    // Don't retain an unusually large allocation for the rest of the stream.
    if (this.scratch!.length > 64 * 1024) this.scratch = undefined
    return result
  }
}
