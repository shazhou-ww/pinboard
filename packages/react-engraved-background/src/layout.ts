export type LayoutOptions = {
  iconCount: number;
  seed?: string | number;
  tileSize?: readonly [width: number, height: number];
  iconSize?: readonly [min: number, max: number];
  spacing?: number;
};

export type IconPlacement = {
  iconIndex: number;
  x: number;
  y: number;
  size: number;
  rotation: number;
};

export const defaultTileSize = [480, 960] as const;
export const defaultIconSize = [48, 88] as const;

export function positive(value: number, name: string) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite positive number.`);
  }
}

export function generateIconLayout({
  iconCount,
  seed = "engraved-v1",
  tileSize = defaultTileSize,
  iconSize = defaultIconSize,
  spacing = 96,
}: LayoutOptions): readonly IconPlacement[] {
  positive(iconCount, "iconCount");
  if (!Number.isSafeInteger(iconCount)) {
    throw new RangeError("iconCount must be a safe integer.");
  }
  if (typeof seed === "number" && !Number.isFinite(seed)) {
    throw new RangeError("seed must be a string or finite number.");
  }
  const [width, height] = tileSize;
  const [min, max] = iconSize;
  positive(width, "tile width");
  positive(height, "tile height");
  positive(min, "minimum icon size");
  positive(max, "maximum icon size");
  positive(spacing, "spacing");
  if (min > max || max > Math.min(width, height)) {
    throw new RangeError("Icon sizes must be ordered and fit within the tile.");
  }
  const columns = Math.ceil(width / spacing);
  const rows = Math.ceil(height / (spacing * (5 / 7)));
  if (columns * rows > 10_000) {
    throw new RangeError("Layout exceeds the limit of 10000 icons per tile.");
  }
  let state = 2166136261;
  for (const char of `${typeof seed}:${seed}`) {
    state = Math.imul(state ^ char.charCodeAt(0), 16777619);
  }
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const result: IconPlacement[] = [];
  const jitter = Math.min(width / columns, height / rows) * 0.045;
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const sizeChoice = random();
      result.push({
        iconIndex: Math.floor(random() * iconCount),
        x:
          ((column + (row % 2) / 2) * width) / columns +
          (random() * 2 - 1) * jitter,
        y: (row * height) / rows + (random() * 2 - 1) * jitter,
        size: sizeChoice < 0.2 ? min : sizeChoice > 0.8 ? max : (min + max) / 2,
        rotation: Math.round(random() * 28 - 14),
      });
    }
  }
  return result;
}
