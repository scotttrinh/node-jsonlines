import { addAbortSignal, Transform, type TransformCallback } from "node:stream";
import { Lines } from "./lines.js";

export interface StreamOptions {
  /** Objects for parse(), bytes for stringify(). Defaults to Node's high water mark. */
  readableHighWaterMark?: number;
  /** Bytes for parse(), objects for stringify(). Defaults to Node's high water mark. */
  writableHighWaterMark?: number;
  signal?: AbortSignal;
}

export interface ParseOptions extends StreamOptions {
  /** Emit 'invalid-line' and continue after malformed JSON. Defaults to false. */
  emitInvalidLines?: boolean;
  /** Maximum UTF-8 bytes per line, excluding LF. Defaults to Infinity. */
  maxLineBytes?: number;
}

export interface ParseValuesOptions {
  maxLineBytes?: number;
  signal?: AbortSignal;
}

export interface StringifyOptions extends StreamOptions {
  /** Coalesce up to this many UTF-8 bytes and 64 records. Defaults to 65536; 0 disables batching. */
  batchBytes?: number;
}

export interface InvalidLineError extends Error {
  readonly source: string;
  readonly line: number;
  readonly code: "ERR_JSONLINES_PARSE" | "ERR_JSONLINES_NULL";
}

/** A malformed JSON record, including its original text and 1-based line number. */
export class JsonLineError extends SyntaxError {
  readonly code = "ERR_JSONLINES_PARSE";

  constructor(
    readonly source: string,
    readonly line: number,
    cause: unknown,
  ) {
    super(
      `Invalid JSON at line ${line}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "JsonLineError";
  }
}

function decode(source: string, line: number): unknown {
  try {
    return JSON.parse(source);
  } catch (cause) {
    throw new JsonLineError(source, line, cause);
  }
}

/** A byte-to-object Transform. Use parseValues() if records may be JSON null. */
export class Parser<T = unknown> extends Transform {
  private readonly lines: Lines;
  private readonly emitInvalidLines: boolean;
  private pending: TransformCallback | undefined;

  constructor(options: ParseOptions = {}) {
    super({
      readableHighWaterMark: options.readableHighWaterMark,
      writableHighWaterMark: options.writableHighWaterMark,
      readableObjectMode: true,
      writableObjectMode: false,
    });
    this.lines = new Lines(options.maxLineBytes ?? Infinity);
    this.emitInvalidLines = options.emitInvalidLines ?? false;
    // An already-aborted signal destroys synchronously; attach only after all
    // state used by _destroy() has been initialized.
    if (options.signal) addAbortSignal(options.signal, this);
  }

  declare [Symbol.asyncIterator]: () => NodeJS.AsyncIterator<T>;
  declare iterator: (options?: { destroyOnReturn?: boolean }) => NodeJS.AsyncIterator<T>;
  declare read: (size?: number) => T | null;

  override on(event: "data", listener: (value: T) => void): this;
  override on(event: "invalid-line", listener: (error: InvalidLineError) => void): this;
  override on(event: string | symbol, listener: (...args: any[]) => void): this;
  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.lines.setChunk(chunk);
    this.pending = callback;
    this.drainLines();
  }

  override _read(size: number): void {
    // A single input chunk can expand into millions of objects. Resume only
    // when the consumer requests more, not when the next write arrives.
    if (this.pending !== undefined) this.drainLines();
    super._read(size);
  }

  private drainLines(): void {
    try {
      let source: string | undefined;
      while ((source = this.lines.next()) !== undefined) {
        if (!this.pushLine(source)) return;
      }
      this.complete();
    } catch (error) {
      this.complete(error as Error);
    }
  }

  private pushLine(source: string): boolean {
    if (source === "" || source === "\r") return true;
    let value: unknown;
    try {
      value = decode(source, this.lines.line);
      if (value === null) {
        throw Object.assign(
          new TypeError("JSON null cannot be emitted by a Node object stream; use parseValues()"),
          { code: "ERR_JSONLINES_NULL", source, line: this.lines.line },
        );
      }
    } catch (error) {
      if (!this.emitInvalidLines) throw error;
      this.emit("invalid-line", error);
      return true;
    }
    return this.push(value);
  }

  private complete(error?: Error): void {
    const callback = this.pending;
    this.pending = undefined;
    callback?.(error);
  }

  override _flush(callback: TransformCallback): void {
    try {
      const source = this.lines.finish();
      if (source !== undefined && !this.destroyed) this.pushLine(source);
      this.lines.clear();
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.lines.clear();
    this.complete(error ?? new Error("Parser destroyed"));
    callback(error);
  }
}

/** Parse UTF-8 chunks into JavaScript values with native stream backpressure. */
export function parse<T = unknown>(options?: ParseOptions): Parser<T> {
  return new Parser<T>(options);
}

function encode(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) {
      throw new TypeError("Value has no JSON representation");
    }
    return json;
  } catch (cause) {
    // A user-provided toJSON() can throw any value, even a frozen Error.
    const error = new TypeError(cause instanceof Error ? cause.message : String(cause), { cause });
    throw Object.assign(error, {
      source: value,
      code: "ERR_JSONLINES_STRINGIFY",
    });
  }
}

/** An object-to-byte Transform with bounded UTF-8 encoding batches. */
export class Stringifier extends Transform {
  private readonly batchBytes: number;
  private buffered: string[] = [];
  private bufferedBytes = 0;
  private scheduled = false;

  constructor(options: StringifyOptions = {}) {
    super({
      readableHighWaterMark: options.readableHighWaterMark,
      writableHighWaterMark: options.writableHighWaterMark,
      readableObjectMode: false,
      writableObjectMode: true,
    });
    this.batchBytes = options.batchBytes ?? 64 * 1024;
    if (!Number.isSafeInteger(this.batchBytes) || this.batchBytes < 0) {
      throw new RangeError("batchBytes must be a nonnegative safe integer");
    }
    if (options.signal) addAbortSignal(options.signal, this);
  }

  override _transform(
    value: unknown,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    let line: string;
    try {
      line = encode(value);
    } catch (error) {
      callback(error as Error);
      return;
    }
    if (this.batchBytes === 0) {
      callback(null, line + "\n");
      return;
    }
    const lineBytes = Buffer.byteLength(line) + 1;
    let output: Buffer | undefined;
    if (lineBytes >= this.batchBytes) {
      if (this.bufferedBytes !== 0) this.push(this.takeBatch());
      callback(null, line + "\n");
      return;
    }
    if (this.bufferedBytes + lineBytes > this.batchBytes) output = this.takeBatch();
    this.buffered.push(line);
    this.bufferedBytes += lineBytes;
    // Bound string references as well as bytes, including for tiny records.
    if (this.buffered.length === 64) output = this.takeBatch();
    // Flush sparse writes promptly while letting synchronous producers share
    // one downstream write and UTF-8 encoding per batch.
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        if (!this.destroyed && this.bufferedBytes !== 0) this.push(this.takeBatch());
      });
    }
    callback(null, output);
  }

  private takeBatch(): Buffer {
    const result = Buffer.from(this.buffered.join("\n") + "\n");
    this.buffered = [];
    this.bufferedBytes = 0;
    return result;
  }

  override _flush(callback: TransformCallback): void {
    callback(null, this.bufferedBytes === 0 ? undefined : this.takeBatch());
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.buffered = [];
    this.bufferedBytes = 0;
    callback(error);
  }
}

/** Serialize one compact JSON record per line, with a trailing LF. */
export function stringify(options?: StringifyOptions): Stringifier {
  return new Stringifier(options);
}

export type InputChunk = string | Uint8Array;

/**
 * Parse an iterable of UTF-8 chunks, including JSON null. Works directly with
 * Node Readables and Web ReadableStreams; breaking iteration closes the source.
 * A signal is checked between chunks and records; pass it to the source too
 * when cancellation must interrupt a pending read.
 */
export async function* parseValues<T = unknown>(
  source: AsyncIterable<InputChunk> | Iterable<InputChunk>,
  options: ParseValuesOptions = {},
): AsyncGenerator<T> {
  const lines = new Lines(options.maxLineBytes ?? Infinity);
  try {
    options.signal?.throwIfAborted();
    for await (const chunk of source) {
      options.signal?.throwIfAborted();
      lines.setChunk(
        typeof chunk === "string"
          ? Buffer.from(chunk)
          : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength),
      );
      let line: string | undefined;
      while ((line = lines.next()) !== undefined) {
        options.signal?.throwIfAborted();
        if (line !== "" && line !== "\r") yield decode(line, lines.line) as T;
      }
      options.signal?.throwIfAborted();
    }
    options.signal?.throwIfAborted();
    const line = lines.finish();
    if (line !== undefined && line !== "" && line !== "\r") {
      options.signal?.throwIfAborted();
      yield decode(line, lines.line) as T;
    }
  } finally {
    lines.clear();
  }
}

/** Serialize an iterable of values, including null, without an object stream. */
export async function* stringifyValues(
  source: AsyncIterable<unknown> | Iterable<unknown>,
): AsyncGenerator<string> {
  for await (const value of source) yield encode(value) + "\n";
}
