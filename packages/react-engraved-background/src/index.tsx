import { useId, useMemo } from "react";
import type {
  ComponentType,
  CSSProperties,
  HTMLAttributes,
  SVGProps,
} from "react";
import {
  defaultIconSize,
  defaultTileSize,
  generateIconLayout,
  positive,
} from "./layout.js";
import { resolveEngraving } from "./engraving.js";
import type { EngravingOptions } from "./engraving.js";
import { mistPalette } from "./palettes.js";
import type { EngravedPalette } from "./palettes.js";

export { generateIconLayout } from "./layout.js";
export type { IconPlacement, LayoutOptions } from "./layout.js";
export { engravingStyles, engravingPresets } from "./engraving.js";
export type { EngravingOptions, EngravingStyle } from "./engraving.js";
export { mistPalette, sandPalette, icePalette } from "./palettes.js";
export type { EngravedPalette } from "./palettes.js";

export type EngravedIcon = ComponentType<SVGProps<SVGSVGElement>>;
export type EngravedBackgroundProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  "color"
> & {
  icons: readonly EngravedIcon[];
  palette?: EngravedPalette;
  engraving?: EngravingOptions;
  seed?: string | number;
  tileSize?: readonly [width: number, height: number];
  iconSize?: readonly [min: number, max: number];
  spacing?: number;
  strokeWidth?: number;
};

const offsets = [-1, 0, 1] as const;
const decorationStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  pointerEvents: "none",
};

export function EngravedBackground({
  icons,
  palette = mistPalette,
  engraving,
  seed = "engraved-v1",
  tileSize = defaultTileSize,
  iconSize = defaultIconSize,
  spacing = 96,
  strokeWidth = 1.6,
  children,
  style,
  ...props
}: EngravedBackgroundProps) {
  const id = useId();
  const motifId = `${id}-motif`;
  const filterId = `${id}-engraving`;
  const patternId = `${id}-pattern`;
  const [width, height] = tileSize;
  const [min, max] = iconSize;
  const layout = useMemo(
    () =>
      generateIconLayout({
        iconCount: icons.length,
        seed,
        tileSize: [width, height],
        iconSize: [min, max],
        spacing,
      }),
    [icons.length, seed, width, height, min, max, spacing],
  );
  positive(strokeWidth, "strokeWidth");
  const effect = resolveEngraving(engraving);
  const { background, engraving: colors } = palette;
  return (
    <div
      {...props}
      style={{
        position: "relative",
        isolation: "isolate",
        ...style,
      }}
    >
      <div
        aria-hidden="true"
        style={{
          ...decorationStyle,
          zIndex: -1,
          backgroundColor: background.start,
          backgroundImage: `radial-gradient(ellipse at 12% 10%, ${background.light}, transparent 68%), radial-gradient(ellipse at 90% 92%, ${background.wash}, transparent 66%), linear-gradient(145deg, ${background.start}, ${background.end})`,
        }}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="100%"
          height="100%"
          focusable="false"
          style={decorationStyle}
        >
          <style>{`g[id="${motifId}"] :is(path,rect,circle,ellipse,line,polyline,polygon){vector-effect:non-scaling-stroke}`}</style>
          <defs>
            <filter
              id={filterId}
              x="-25%"
              y="-25%"
              width="150%"
              height="150%"
              colorInterpolationFilters="sRGB"
            >
              <feGaussianBlur
                in="SourceAlpha"
                stdDeviation={effect.blur}
                result="groove"
              />
              <feOffset
                in="groove"
                dx={-effect.dx}
                dy={-effect.dy}
                result="upper-edge"
              />
              <feFlood
                floodColor={colors.shadow}
                floodOpacity={effect.shadow}
                result="shadow-color"
              />
              <feComposite
                in="shadow-color"
                in2="upper-edge"
                operator="in"
                result="shadow"
              />
              <feOffset
                in="groove"
                dx={effect.dx}
                dy={effect.dy}
                result="lower-edge"
              />
              <feFlood
                floodColor={colors.highlight}
                floodOpacity={effect.highlight}
                result="light-color"
              />
              <feComposite
                in="light-color"
                in2="lower-edge"
                operator="in"
                result="highlight"
              />
              <feFlood
                floodColor={colors.shadow}
                floodOpacity={effect.core}
                result="core-color"
              />
              <feComposite
                in="core-color"
                in2="SourceAlpha"
                operator="in"
                result="core"
              />
              <feMerge>
                <feMergeNode in="highlight" />
                <feMergeNode in="core" />
                <feMergeNode in="shadow" />
              </feMerge>
            </filter>
            <g id={motifId} filter={`url(#${filterId})`}>
              {layout.map(({ iconIndex, x, y, size, rotation }, index) => {
                const Icon = icons[iconIndex]!;
                return (
                  <g
                    key={index}
                    transform={`translate(${x} ${y}) rotate(${rotation}) translate(${-size / 2} ${-size / 2})`}
                  >
                    <Icon
                      width={size}
                      height={size}
                      fill="none"
                      stroke="#000000"
                      color="#000000"
                      strokeWidth={strokeWidth}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                      focusable="false"
                      overflow="visible"
                    />
                  </g>
                );
              })}
            </g>
            <pattern
              id={patternId}
              width={width}
              height={height}
              patternUnits="userSpaceOnUse"
            >
              {offsets.flatMap((y) =>
                offsets.map((x) => (
                  <use
                    key={`${x}:${y}`}
                    href={`#${motifId}`}
                    transform={`translate(${x * width} ${y * height})`}
                  />
                )),
              )}
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill={`url(#${patternId})`} />
        </svg>
      </div>
      {children}
    </div>
  );
}
