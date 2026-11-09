# react-engraved-background

A React background with seamlessly tiled, shallow-engraved SVG icons. No icon
library, stylesheet, browser storage, or global theme is required. This package
is developed in the Pinboard workspace. npm releases use independent
`react-engraved-background@x.y.z` tags and GitHub Actions trusted publishing.
See the repository's
[npm release guide](https://github.com/shazhou-ww/pinboard/blob/main/docs/npm-release.md).

```tsx
import type { SVGProps } from "react";
import { EngravedBackground, mistPalette } from "react-engraved-background";

function CodeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="-4 -4 33 33" {...props}>
      <path d="m7 5-6 7 6 7m10-14 6 7-6 7M14 2l-4 20" />
    </svg>
  );
}

const icons = [CodeIcon];

export function Hero() {
  return (
    <EngravedBackground
      icons={icons}
      palette={mistPalette}
      seed="landing-v1"
      engraving={{ style: "paper", depth: 0.5 }}
      style={{ minHeight: 400 }}
    >
      <main>Your content</main>
    </EngravedBackground>
  );
}
```

## API

The wrapper accepts normal `div` attributes and children. It defaults to
`position: relative` and `isolation: isolate`; preserve a positioned, isolated
wrapper when overriding its styles. Its decoration is hidden from assistive
technology and cannot intercept pointer events. The wrapper's content remains
accessible. Its height comes from its content or your CSS.

| Prop          | Default                          | Meaning                                             |
| ------------- | -------------------------------- | --------------------------------------------------- |
| `icons`       | Required                         | Nonempty array of SVG React components              |
| `palette`     | `mistPalette`                    | Background and engraving colors                     |
| `seed`        | `"engraved-v1"`                  | String or finite number identifying the arrangement |
| `engraving`   | `{ style: "paper", depth: 0.5 }` | Style and depth, from 0 (invisible) to 1            |
| `tileSize`    | `[480, 960]`                     | Tile width and height in CSS pixels                 |
| `iconSize`    | `[48, 88]`                       | Minimum and maximum icon sizes                      |
| `spacing`     | `96`                             | Approximate horizontal spacing; rows are staggered  |
| `strokeWidth` | `1.6`                            | Unscaled outline width in CSS pixels                |

Icons must forward SVG props, including `width`, `height`, `stroke`, `fill`,
`strokeWidth`, and decorative accessibility attributes. Use outline SVG geometry
and a padded viewBox to leave room for the engraving edges. Library icons can be
adapted with a small wrapper. Filled icons are not automatically converted to
outlines. Scoped CSS keeps standard SVG shape strokes from scaling with icon
size without affecting other icons on the page.

`paper` preserves a delicate paper groove. `deboss` uses deeper, softer recessed
edges; `emboss` reverses their direction for a raised effect; `etched` uses
sharp lines and restrained highlights. `engravingStyles` and `engravingPresets`
expose the centralized definitions. These presets describe edge geometry, not
simulated metal or wood materials.

`EngravedPalette` contains:

```ts
type EngravedPalette = {
  background: {
    start: string;
    end: string;
    light: string;
    wash: string;
  };
  engraving: { shadow: string; highlight: string };
};
```

Colors are CSS color values, including `var(--color)`. `mistPalette`,
`sandPalette`, and `icePalette` are included; the groove core reuses the shadow
color. Names, selected palette IDs, and persistence belong to the application.

## Deterministic layouts

The same seed, icon order, icon count, and geometry settings reproduce the same
layout across refreshes and server/client rendering. Keep the seed stable; do
not generate it randomly during render. Changing palette or engraving settings
does not regenerate the layout. Geometry is memoized using scalar parameters, so
recreating tuple props does not invalidate it.

`generateIconLayout({ iconCount, seed, tileSize, iconSize, spacing })` exposes
the same pure algorithm for tests or inspection. No layout snapshots or storage
integration are needed. Seed reproducibility applies to the current algorithm;
changing its behavior in a future release can change layouts.

Invalid numeric settings throw descriptive `RangeError`s. Icon sizes must fit
inside the tile, and layouts are limited to 10,000 placements per tile. Each
tile references nine neighboring motif copies so artwork crossing an edge wraps
on both axes. SVG pattern units remain fixed CSS pixels as the container
resizes; only the gradient stretches. Filter and pattern IDs are isolated with
React `useId`; multiple independent React roots should use distinct
`identifierPrefix` values, as with other `useId` consumers.

## Workspace development

From the repository root:

```sh
pnpm --filter react-engraved-background build
pnpm --filter react-engraved-background test
pnpm test:background-package
pnpm check
```

For an authorized release, `pnpm prepare:background x.y.z` stages a clean
publishable manifest and compiled files under `dist/npm`. It does not modify
source versions or publish anything. The release workflow packs and tests that
exact version before publishing it with provenance.
