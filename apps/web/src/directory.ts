import { buildDirectoryCar as encode } from "@workspace/encoding";
import type { DirectorySelection } from "./uploads.js";

async function* content(file: File): AsyncGenerator<Uint8Array> {
  const reader = file.stream().getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export async function buildDirectoryCar(
  selection: DirectorySelection,
): Promise<Blob> {
  const { bytes } = await encode(
    selection.files.map(({ path, file }) => ({
      path,
      size: file.size,
      content: content(file),
    })),
  );
  return new Blob([bytes], { type: "application/vnd.ipld.car" });
}
