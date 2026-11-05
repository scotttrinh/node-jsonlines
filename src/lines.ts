/** Incremental byte framing; decode only after a complete UTF-8 line arrives. */
export class Lines {
  line = 0
  private chunk: Buffer | undefined
  private offset = 0
  private parts: Buffer[] = []
  private length = 0

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
    this.parts = []
    this.length = 0
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
    if (start === end) return
    this.checkLength(this.length + end - start)
    this.parts.push(chunk.subarray(start, end))
    this.length += end - start
  }

  private takePartial(): string {
    const result = Buffer.concat(this.parts, this.length).toString('utf8')
    this.parts = []
    this.length = 0
    return result
  }
}
