import { PreviewLimit } from "./preview-limits.js";

export interface PreviewFileSource {
  readonly size: number;
  readAt(offset: number, length: number): Promise<Uint8Array>;
}
export const MAX_PDF_SIZE = 32 * 1024 * 1024;
export function checkRange(size: number, offset: number, length: number) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > size ||
    length > size - offset
  )
    throw new PreviewLimit("Invalid preview file range");
}
