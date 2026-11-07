import reference from "./fixtures/pdf-glyph-reference.json";

export function glyphSimilarity(
  bytes: Uint8Array,
  width: number,
  x: number,
  char: keyof typeof reference,
) {
  let left = width,
    top = 100,
    right = 0,
    bottom = 0;
  for (let y = 0; y < 100; y++)
    for (let px = x; px < x + 60; px++)
      if (bytes[(y * width + px) * 4]! < 128) {
        left = Math.min(left, px);
        top = Math.min(top, y);
        right = Math.max(right, px);
        bottom = Math.max(bottom, y);
      }
  if (right < left) return 0;
  let intersection = 0,
    union = 0;
  for (let y = 0; y < 32; y++)
    for (let px = 0; px < 32; px++) {
      const sourceX =
        left +
        Math.min(
          right - left,
          Math.floor(((px + 0.5) * (right - left + 1)) / 32),
        );
      const sourceY =
        top +
        Math.min(
          bottom - top,
          Math.floor(((y + 0.5) * (bottom - top + 1)) / 32),
        );
      const actual = bytes[(sourceY * width + sourceX) * 4]! < 128;
      const expected = reference[char][y * 32 + px] === "1";
      if (actual && expected) intersection++;
      if (actual || expected) union++;
    }
  return intersection / union;
}
