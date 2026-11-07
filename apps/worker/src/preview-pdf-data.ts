import { checkRange, type PreviewFileSource } from "./preview-file.js";
import { PreviewLimit, PreviewUnsupported } from "./preview-limits.js";

const WINDOW = 65536;
export const MAX_PDF_CACHE = 8 * 1024 * 1024;
export const MAX_PDF_ROUNDS = 64;

export class PdfData {
  readonly stats = { rounds: 0, logicalBytes: 0, windows: 0 };
  error?: Error;
  private readonly windows = new Map<number, Uint8Array>();
  private readonly wanted = new Set<number>();
  constructor(
    private readonly source: PreviewFileSource,
    private readonly memory: WebAssembly.Memory,
    private readonly signal: AbortSignal,
  ) {}

  check() {
    this.signal.throwIfAborted();
    if (this.error) throw this.error;
  }
  private offsets(offset: number, length: number) {
    checkRange(this.source.size, offset, length);
    const result: number[] = [];
    if (!length) return result;
    for (
      let start = Math.floor(offset / WINDOW) * WINDOW;
      start < offset + length;
      start += WINDOW
    )
      result.push(start);
    return result;
  }
  available(offset: number, length: number) {
    return this.offsets(offset, length).every((start) =>
      this.windows.has(start),
    )
      ? 1
      : 0;
  }
  read(offset: number, pointer: number, length: number) {
    const starts = this.offsets(offset, length);
    if (!starts.every((start) => this.windows.has(start)))
      throw new Error("PDF attempted an uncached synchronous read");
    checkRange(this.memory.buffer.byteLength, pointer, length);
    let copied = 0;
    for (const start of starts) {
      const bytes = this.windows.get(start)!;
      const begin = Math.max(0, offset - start);
      const count = Math.min(bytes.length - begin, length - copied);
      new Uint8Array(this.memory.buffer).set(
        bytes.subarray(begin, begin + count),
        pointer + copied,
      );
      copied += count;
    }
    return copied === length ? 1 : 0;
  }
  hint(offset: number, length: number) {
    for (const start of this.offsets(offset, length))
      if (!this.windows.has(start)) this.wanted.add(start);
  }
  async fill() {
    for (const start of [...this.wanted].sort((a, b) => a - b)) {
      this.check();
      const length = Math.min(WINDOW, this.source.size - start);
      if (length > MAX_PDF_CACHE - this.stats.logicalBytes)
        throw new PreviewLimit("PDF exceeds 8 MiB logical cache budget");
      this.stats.logicalBytes += length;
      const bytes = await this.source.readAt(start, length);
      this.check();
      if (bytes.length !== length)
        throw new Error("PDF source range length mismatch");
      this.windows.set(start, bytes);
      this.stats.windows++;
    }
    this.wanted.clear();
  }
  async untilAvailable(operation: () => number) {
    while (++this.stats.rounds <= MAX_PDF_ROUNDS) {
      this.check();
      this.wanted.clear();
      const status = operation();
      this.check();
      if (status === 1) return;
      if (status !== 0)
        throw new PreviewUnsupported("PDF data is damaged or unsupported");
      if (!this.wanted.size)
        throw new PreviewUnsupported("PDF availability made no progress");
      await this.fill();
    }
    throw new PreviewLimit("PDF exceeds 64 availability rounds");
  }
  clear() {
    this.windows.clear();
    this.wanted.clear();
    this.stats.windows = 0;
  }
}
