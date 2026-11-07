export class PreviewDeferred extends Error {}
export class PreviewUnsupported extends Error {}
export class PreviewLimit extends PreviewUnsupported {}

let occupied = false;
export async function admitPreview<T>(operation: () => Promise<T>): Promise<T> {
  if (occupied) throw new PreviewDeferred("Preview renderer busy");
  occupied = true;
  try {
    return await operation();
  } finally {
    occupied = false;
  }
}
