export const engravingStyles = ["paper", "deboss", "emboss", "etched"] as const;
export type EngravingStyle = (typeof engravingStyles)[number];
export type EngravingOptions = {
  style?: EngravingStyle;
  depth?: number;
};

export const engravingPresets = {
  paper: {
    blur: 0.12,
    dx: 0.45,
    dy: 0.55,
    shadow: 0.12,
    highlight: 0.42,
    core: 0.035,
  },
  deboss: {
    blur: 0.35,
    dx: 0.9,
    dy: 1.1,
    shadow: 0.3,
    highlight: 0.5,
    core: 0.08,
  },
  emboss: {
    blur: 0.35,
    dx: -0.9,
    dy: -1.1,
    shadow: 0.3,
    highlight: 0.5,
    core: 0.04,
  },
  etched: {
    blur: 0,
    dx: 0.2,
    dy: 0.25,
    shadow: 0.2,
    highlight: 0.12,
    core: 0.12,
  },
} as const;

export function resolveEngraving({
  style = "paper",
  depth = 0.5,
}: EngravingOptions = {}) {
  if (!engravingStyles.includes(style)) {
    throw new RangeError(`Unknown engraving style: ${style}`);
  }
  if (!Number.isFinite(depth) || depth < 0 || depth > 1) {
    throw new RangeError("Engraving depth must be between 0 and 1.");
  }
  const preset = engravingPresets[style];
  const scale = depth * 2;
  return {
    blur: preset.blur * scale,
    dx: preset.dx * scale,
    dy: preset.dy * scale,
    shadow: preset.shadow * scale,
    highlight: preset.highlight * scale,
    core: preset.core * scale,
  };
}
