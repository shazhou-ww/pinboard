import type { SVGProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  EngravedBackground,
  engravingPresets,
  engravingStyles,
  generateIconLayout,
  icePalette,
  mistPalette,
  sandPalette,
} from "../src/index.js";
import { resolveEngraving } from "../src/engraving.js";

function Icon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="-4 -4 33 33" {...props}>
      <path d="M2 2h20v20H2Z" />
    </svg>
  );
}
const icons = [Icon];

describe("deterministic icon layout", () => {
  it("reproduces all 70 placements without browser globals or random state", () => {
    const layout = generateIconLayout({ iconCount: 11 });
    expect(layout).toHaveLength(70);
    expect(generateIconLayout({ iconCount: 11 })).toEqual(layout);
    expect(
      generateIconLayout({ iconCount: 11, seed: "different" }),
    ).not.toEqual(layout);
    expect(generateIconLayout({ iconCount: 11, seed: 42 })).toEqual(
      generateIconLayout({ iconCount: 11, seed: 42 }),
    );
    expect(generateIconLayout({ iconCount: 11, seed: 42 })).not.toEqual(
      generateIconLayout({ iconCount: 11, seed: "42" }),
    );
    for (const placement of layout) {
      expect(placement.iconIndex).toBeGreaterThanOrEqual(0);
      expect(placement.iconIndex).toBeLessThan(11);
      expect([48, 68, 88]).toContain(placement.size);
      expect(Math.abs(placement.rotation)).toBeLessThanOrEqual(14);
      expect(placement.x).toBeGreaterThan(-4);
      expect(placement.x).toBeLessThan(484);
      expect(placement.y).toBeGreaterThan(-4);
      expect(placement.y).toBeLessThan(964);
    }
    expect(new Set(layout.map((item) => item.iconIndex)).size).toBe(11);
  });

  it("supports geometry changes, fixed icon sizes, and explicit defaults", () => {
    const options = {
      iconCount: 1,
      seed: "",
      tileSize: [200, 300] as const,
      iconSize: [24, 24] as const,
      spacing: 100,
    };
    const layout = generateIconLayout(options);
    expect(layout).toHaveLength(10);
    expect(
      layout.every((item) => item.size === 24 && item.iconIndex === 0),
    ).toBe(true);
    expect(
      generateIconLayout({ iconCount: 1, tileSize: [480, 960], spacing: 96 }),
    ).toEqual(generateIconLayout({ iconCount: 1 }));
  });

  it.each([
    [{ iconCount: 0 }, /iconCount/],
    [{ iconCount: -1 }, /iconCount/],
    [{ iconCount: Number.NaN }, /iconCount/],
    [{ iconCount: Infinity }, /iconCount/],
    [{ iconCount: 1.5 }, /safe integer/],
    [{ iconCount: Number.MAX_SAFE_INTEGER + 1 }, /safe integer/],
    [{ iconCount: 1, seed: Infinity }, /seed/],
    [{ iconCount: 1, tileSize: [0, 960] as const }, /tile width/],
    [{ iconCount: 1, tileSize: [480, -1] as const }, /tile height/],
    [{ iconCount: 1, iconSize: [0, 88] as const }, /minimum icon size/],
    [{ iconCount: 1, iconSize: [48, Infinity] as const }, /maximum icon size/],
    [{ iconCount: 1, spacing: 0 }, /spacing/],
    [{ iconCount: 1, iconSize: [88, 48] as const }, /ordered/],
    [{ iconCount: 1, iconSize: [48, 481] as const }, /fit within/],
    [{ iconCount: 1, spacing: 0.1 }, /10000/],
  ])("rejects invalid settings %j explicitly", (options, message) => {
    expect(() => generateIconLayout(options)).toThrow(message);
  });
});

describe("engraving presets", () => {
  it("preserves the approved paper effect by default", () => {
    expect(resolveEngraving()).toEqual(engravingPresets.paper);
    expect(engravingStyles).toEqual(["paper", "deboss", "emboss", "etched"]);
    expect(resolveEngraving({ style: "paper", depth: 0 })).toEqual({
      blur: 0,
      dx: 0,
      dy: 0,
      shadow: 0,
      highlight: 0,
      core: 0,
    });
    expect(resolveEngraving({ depth: 1 }).shadow).toBe(0.24);
  });

  it("reverses recessed edges for emboss and sharpens etched grooves", () => {
    const deboss = resolveEngraving({ style: "deboss" });
    const emboss = resolveEngraving({ style: "emboss" });
    expect(emboss.dx).toBe(-deboss.dx);
    expect(emboss.dy).toBe(-deboss.dy);
    expect(resolveEngraving({ style: "etched" }).blur).toBe(0);
  });

  it.each([-1, 1.01, Infinity, Number.NaN])(
    "rejects invalid depth %s",
    (depth) => {
      expect(() => resolveEngraving({ depth })).toThrow(/between 0 and 1/);
    },
  );

  it("rejects unsupported styles rather than silently substituting paper", () => {
    // @ts-expect-error Exercise invalid input from untyped consumers.
    expect(() => resolveEngraving({ style: "wood" })).toThrow(/Unknown/);
  });
});

describe("React background", () => {
  it("renders fixed-size seamless wrapping and accessible wrapper content", () => {
    const html = renderToStaticMarkup(
      <EngravedBackground
        icons={icons}
        className="hero"
        aria-label="Example"
        style={{ minHeight: 400 }}
      >
        <button>Open</button>
      </EngravedBackground>,
    );
    expect(html).toContain('class="hero" aria-label="Example"');
    expect(html).toContain(
      "position:relative;isolation:isolate;min-height:400px",
    );
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("pointer-events:none");
    expect(html).toContain("<button>Open</button>");
    expect(html).toContain(
      'width="480" height="960" patternUnits="userSpaceOnUse"',
    );
    expect(html.match(/rotate\(/g)).toHaveLength(70);
    expect(html.match(/<use /g)).toHaveLength(9);
    for (const y of [-960, 0, 960]) {
      for (const x of [-480, 0, 480]) {
        expect(html).toContain(`transform="translate(${x} ${y})"`);
      }
    }
    expect(html).toContain("vector-effect:non-scaling-stroke");
    expect(html).toContain('stroke-width="1.6"');
    expect(html).toContain('stdDeviation="0.12"');
    expect(html).toContain('dx="-0.45" dy="-0.55"');
    expect(html).toContain('dx="0.45" dy="0.55"');
    expect(html).not.toMatch(/<script|onload=/i);
  });

  it.each([mistPalette, sandPalette, icePalette])(
    "changes tint without changing geometry for %j",
    (palette) => {
      const render = (value: typeof palette) =>
        renderToStaticMarkup(
          <EngravedBackground icons={icons} palette={value} seed="stable" />,
        );
      const html = render(palette);
      expect(html).toContain(`flood-color="${palette.engraving.shadow}"`);
      expect(html).toContain(`flood-color="${palette.engraving.highlight}"`);
      expect(html).toContain(palette.background.start);
      expect(
        Array.from(html.matchAll(/transform="([^"]+)"/g), ([value]) => value),
      ).toEqual(
        Array.from(
          render(mistPalette).matchAll(/transform="([^"]+)"/g),
          ([value]) => value,
        ),
      );
    },
  );

  it.each(engravingStyles)("renders the %s style", (style) => {
    const effect = resolveEngraving({ style, depth: 1 });
    const html = renderToStaticMarkup(
      <EngravedBackground
        icons={icons}
        engraving={{ style, depth: 1 }}
        tileSize={[200, 300]}
        iconSize={[24, 24]}
        spacing={100}
        strokeWidth={2}
        seed={123}
      />,
    );
    expect(html).toContain(`stdDeviation="${effect.blur}"`);
    expect(html).toContain(`flood-opacity="${effect.shadow}"`);
    expect(html).toContain('width="200" height="300"');
    expect(html).toContain('stroke-width="2"');
    expect(html.match(/rotate\(/g)).toHaveLength(10);
  });

  it("supports CSS variable colors and independent SVG IDs", () => {
    const palette = {
      ...mistPalette,
      engraving: {
        shadow: "var(--engraving-shadow)",
        highlight: "rgb(255 255 255)",
      },
    };
    const html = renderToStaticMarkup(
      <>
        <EngravedBackground icons={icons} palette={palette} />
        <EngravedBackground icons={icons} />
      </>,
    );
    const ids = Array.from(
      html.matchAll(/<(?:g|filter|pattern)\b[^>]*\bid="([^"]+)"/g),
      ([, id]) => id,
    );
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
    expect(html).toContain('flood-color="var(--engraving-shadow)"');
    for (const [, target] of html.matchAll(/(?:url\(#|href="#)([^")]+)/g)) {
      expect(ids).toContain(target);
    }
  });

  it("rejects empty icons and invalid outline widths at render time", () => {
    expect(() =>
      renderToStaticMarkup(<EngravedBackground icons={[]} />),
    ).toThrow(/iconCount/);
    expect(() =>
      renderToStaticMarkup(
        <EngravedBackground icons={icons} strokeWidth={0} />,
      ),
    ).toThrow(/strokeWidth/);
  });
});
