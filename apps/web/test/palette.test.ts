import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  engravingPresets,
  mistPalette,
  sandPalette,
  icePalette,
} from "react-engraved-background";
import type { EngravedPalette } from "react-engraved-background";

const engravingPalettes: Record<string, EngravedPalette> = {
  mist: mistPalette,
  sand: sandPalette,
  ice: icePalette,
};

const styles = readFileSync(
  new URL("../src/styles.css", import.meta.url),
  "utf8",
);
const rules = Array.from(
  styles.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g),
  ([, selectors = "", body = ""]) => ({
    selectors: [
      selectors.trim(),
      ...selectors.split(",").map((selector) => selector.trim()),
    ],
    declarations: Object.fromEntries(
      Array.from(
        body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g),
        ([, key, value]) => [key, value?.trim()],
      ),
    ) as Record<string, string>,
  }),
);
function rule(selector: string) {
  const found = rules.find((entry) => entry.selectors.includes(selector));
  if (!found) throw new Error(`Missing CSS rule: ${selector}`);
  return found.declarations;
}

const roles = [
  "background-start",
  "background-end",
  "background-light",
  "background-wash",
  "surface",
  "subtle",
  "hover",
  "selected",
  "border",
  "control",
  "text",
  "muted",
  "accent",
  "accent-hover",
  "accent-pressed",
];
const approved = {
  mist: [
    "#e6edf3",
    "#e8e3ef",
    "#f0f4f8",
    "#dcd9eb",
    "#fafbfe",
    "#eef0f7",
    "#e3e7f2",
    "#d9e0f0",
    "#cbd0df",
    "#7a829c",
    "#283044",
    "#515971",
    "#505c86",
    "#414d75",
    "#354163",
  ],
  sand: [
    "#f0e9e1",
    "#eddfdf",
    "#f7f1e9",
    "#e9d7d9",
    "#fdfafb",
    "#f5edef",
    "#eee1e6",
    "#e8d5df",
    "#dfccd5",
    "#9b778a",
    "#3d3038",
    "#69555f",
    "#794c62",
    "#70435a",
    "#60364c",
  ],
  ice: [
    "#e9eef8",
    "#dce5f7",
    "#f4f7fc",
    "#d0ddf3",
    "#f8faff",
    "#edf1fa",
    "#e1e9f8",
    "#d2def5",
    "#c7d4e8",
    "#7385a8",
    "#29344a",
    "#4e5e7d",
    "#425e96",
    "#3c5588",
    "#314773",
  ],
};
type RGB = readonly number[];
function rgb(hex: string): RGB {
  if (!/^#[\da-f]{6}$/.test(hex)) throw new Error(`Not an RGB color: ${hex}`);
  return [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
}
function luminance(color: RGB) {
  return color.reduce((sum, channel, index) => {
    const value = channel / 255;
    const linear =
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    return sum + linear * [0.2126, 0.7152, 0.0722][index]!;
  }, 0);
}
function contrast(foreground: RGB, background: RGB) {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function composite(surface: RGB, opacity: number, underlay: RGB) {
  return surface.map(
    (channel, index) => channel * opacity + underlay[index]! * (1 - opacity),
  );
}
const shared = rule(":root");

describe("global palette contract", () => {
  it("defines every referenced role and keeps component colors token-only", () => {
    const declared = new Set(
      Array.from(styles.matchAll(/(--[\w-]+)\s*:/g), ([, name]) => name),
    );
    for (const [, name] of styles.matchAll(/var\((--[\w-]+)/g)) {
      expect(declared.has(name), name).toBe(true);
    }
    for (const { declarations } of rules) {
      for (const [property, value] of Object.entries(declarations)) {
        if (!property.startsWith("--")) {
          expect(value, property).not.toMatch(
            /#[\da-f]{3,8}\b|rgba?\(|hsla?\(/i,
          );
        }
      }
    }
    expect(shared["--focus"]).toBe("var(--accent)");
  });

  it.each(Object.entries(approved))(
    "keeps the complete approved %s palette, also used by its swatch",
    (id, values) => {
      const palette = rule(`.background-swatch[data-background="${id}"]`);
      expect(Object.keys(palette).sort()).toEqual(
        roles.map((role) => `--${role}`).sort(),
      );
      expect(roles.map((role) => palette[`--${role}`])).toEqual(values);
      expect(rule(`:root[data-background="${id}"]`)).toBe(palette);
      for (const name of ["success", "warning", "error", "on-accent"]) {
        expect(palette).not.toHaveProperty(`--${name}`);
      }
    },
  );

  it.each(Object.keys(approved))(
    "maintains text, controls and focus contrast in %s",
    (id) => {
      const palette = rule(`:root[data-background="${id}"]`);
      const color = (name: string) => rgb(palette[`--${name}`]!);
      const backgrounds = [
        "surface",
        "subtle",
        "hover",
        "selected",
        "background-start",
        "background-end",
        "background-light",
        "background-wash",
      ];
      for (const foreground of ["text", "muted"]) {
        for (const background of backgrounds) {
          expect(
            contrast(color(foreground), color(background)),
            `${id}: ${foreground}/${background}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
      for (const background of ["surface", "subtle", "hover", "selected"]) {
        expect(
          contrast(color("accent"), color(background)),
        ).toBeGreaterThanOrEqual(4.5);
      }
      for (const state of ["accent", "accent-hover", "accent-pressed"]) {
        expect(
          contrast(rgb(shared["--on-accent"]!), color(state)),
        ).toBeGreaterThanOrEqual(4.5);
      }
      expect(
        contrast(color("control"), color("surface")),
      ).toBeGreaterThanOrEqual(3);
      for (const background of backgrounds) {
        expect(
          contrast(color("accent"), color(background)),
        ).toBeGreaterThanOrEqual(3);
      }
    },
  );

  it.each(Object.keys(approved))(
    "keeps canvas text and focus readable over palette-tinted shallow engraving in %s",
    (id) => {
      const palette = rule(`:root[data-background="${id}"]`);
      expect(shared["--canvas-muted"]).toBe(
        "color-mix(in srgb, var(--muted) 70%, var(--text))",
      );
      const text = rgb(palette["--text"]!);
      const muted = rgb(palette["--muted"]!);
      const canvasMuted = composite(muted, 0.7, text);
      const colors = engravingPalettes[id]!;
      const effect = engravingPresets.paper;
      const floods = new Map([
        [
          "light-color",
          { color: rgb(colors.engraving.highlight), opacity: effect.highlight },
        ],
        [
          "core-color",
          { color: rgb(colors.engraving.shadow), opacity: effect.core },
        ],
        [
          "shadow-color",
          { color: rgb(colors.engraving.shadow), opacity: effect.shadow },
        ],
      ]);
      expect(floods.size).toBe(3);
      for (const background of [
        "background-start",
        "background-end",
        "background-light",
        "background-wash",
      ]) {
        let strokes = [rgb(palette[`--${background}`]!)];
        // Bound each layer's coverage from zero to one in SVG merge order.
        for (const name of ["light-color", "core-color", "shadow-color"]) {
          const flood = floods.get(name);
          if (!flood) throw new Error(`Missing engraving flood: ${name}`);
          strokes = [
            ...strokes,
            ...strokes.map((stroke) =>
              composite(flood.color, flood.opacity, stroke),
            ),
          ];
        }
        for (const stroke of strokes) {
          expect(contrast(text, stroke)).toBeGreaterThanOrEqual(4.5);
          expect(contrast(canvasMuted, stroke)).toBeGreaterThanOrEqual(4.5);
          expect(
            contrast(rgb(palette["--accent"]!), stroke),
          ).toBeGreaterThanOrEqual(3);
        }
      }
      for (const selector of [
        ".eyebrow",
        ".intro > p:last-child",
        "footer",
        ".publication-page > .muted",
        ".canvas-empty .muted",
      ]) {
        expect(rule(selector).color).toBe("var(--canvas-muted)");
      }
    },
  );

  it.each(Object.keys(approved))(
    "keeps dense overlays readable and restores visible frosting in %s",
    (id) => {
      const palette = rule(`:root[data-background="${id}"]`);
      for (const [role, opacity] of [
        ["surface-glass", 72],
        ["surface-glass-light", 45],
        ["surface-glass-dense", 90],
        ["surface-glass-header-start", 66],
        ["surface-glass-header-end", 62],
        ["surface-glass-input", 75],
      ] as const) {
        expect(shared[`--${role}`]?.replace(/\s+/g, "")).toBe(
          `color-mix(insrgb,var(--surface)${opacity}%,transparent)`,
        );
      }
      for (const role of ["surface-glass-dense"]) {
        const definition = shared[`--${role}`]!;
        expect(definition).toMatch(
          /^color-mix\(in srgb, var\(--surface\) \d+%, transparent\)$/,
        );
        const opacity = Number(/(\d+)%/.exec(definition)![1]) / 100;
        // Each sRGB channel lies between black and white, including blurred content.
        // All tested foregrounds are darker than the darkest composite.
        for (const underlay of [
          [0, 0, 0],
          [255, 255, 255],
        ]) {
          const background = composite(
            rgb(palette["--surface"]!),
            opacity,
            underlay,
          );
          for (const foreground of ["text", "muted", "accent"]) {
            const text = rgb(palette[`--${foreground}`]!);
            expect(luminance(text)).toBeLessThan(luminance(background));
            expect(
              contrast(text, background),
              `${id}: ${foreground}/${role}`,
            ).toBeGreaterThanOrEqual(4.5);
          }
        }
      }
      for (const role of ["surface-glass", "surface-glass-light"]) {
        const opacity = Number(/(\d+)%/.exec(shared[`--${role}`]!)![1]) / 100;
        const background = composite(
          rgb(palette["--surface"]!),
          opacity,
          rgb(palette["--subtle"]!),
        );
        for (const foreground of ["text", "muted"]) {
          expect(
            contrast(rgb(palette[`--${foreground}`]!), background),
            `${id}: ${foreground}/${role} over themed preview`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(rule(".pin-info").background).toBe("var(--surface-glass)");
      expect(
        rule(
          ".pin-card:has(.preview-text, .preview-code, .preview-directory) .pin-info",
        ).background,
      ).toBe("var(--surface-glass-light)");
      expect(rule(".pin-open:focus-visible")["box-shadow"]).toBe(
        "inset 0 0 0 6px var(--surface)",
      );
    },
  );

  it("keeps semantic foreground/background pairs independent and readable", () => {
    const expected = {
      success: ["#286044", "#edf6ef"],
      warning: ["#79500d", "#fff4dc"],
      error: ["#a13645", "#fceef0"],
    };
    for (const [name, colors] of Object.entries(expected)) {
      const foreground = shared[`--${name}`]!;
      const background = shared[`--${name}-bg`]!;
      expect([foreground, background]).toEqual(colors);
      expect(contrast(rgb(foreground), rgb(background))).toBeGreaterThanOrEqual(
        4.5,
      );
    }
    for (const selector of [".notice", ".snackbar-error", ".danger"]) {
      expect(rule(selector).color).toBe("var(--error)");
    }
    expect(rule(".oauth-warning").color).toBe("var(--warning)");
    expect(rule(".success").color).toBe("var(--success)");
  });

  it("themes the integrated filter input and clear action with shared roles", () => {
    expect(rule('.item-filter input[type="search"]')).toMatchObject({
      border: "1px solid var(--control)",
      background: "var(--surface-glass-input)",
      color: "var(--text)",
    });
    expect(rule(".item-filter button").color).toBe("var(--accent)");
    expect(rule(".item-filter button:hover:not(:disabled)").background).toBe(
      "radial-gradient(circle, var(--hover) 0%, transparent 70%)",
    );
    expect(rule(".item-filter button:active:not(:disabled)").background).toBe(
      "radial-gradient(circle, var(--selected) 0%, transparent 70%)",
    );
  });

  it("maps interactive and translucent surfaces without tinting content", () => {
    for (const selector of [
      ".primary:hover:not(:disabled)",
      ".primary:active:not(:disabled)",
    ]) {
      expect(rule(selector).background).toMatch(
        /^var\(--accent-(hover|pressed)\)$/,
      );
    }
    expect(rule(".secondary:active:not(:disabled)").background).toBe(
      "var(--selected)",
    );
    expect(rule(".background-choice:has(input:checked)").background).toBe(
      "var(--selected)",
    );
    expect(rule(".pin-card.drop-target").outline).toBe(
      "3px solid var(--focus)",
    );
    expect(rule("button:disabled").opacity).toBe("0.5");
    for (const selector of [
      ".account-popover",
      ".snackbar",
      ".publication-badge",
      ".canvas-drop",
    ]) {
      expect(rule(selector).background).toBe("var(--surface-glass-dense)");
    }
    expect(rule(".home-header").background?.replace(/\s+/g, " ")).toBe(
      "linear-gradient( 135deg, var(--surface-glass-header-start), var(--surface-glass-header-end) )",
    );
    expect(rule(".home-header")["backdrop-filter"]).toBe(
      "blur(24px) saturate(1.6)",
    );
    expect(rule(".account-popover")["backdrop-filter"]).toBe("blur(16px)");
    expect(rule(".account-trigger").background).toBe(
      "color-mix(in srgb, var(--surface) 40%, transparent)",
    );
    expect(rule(".pin-preview img")).not.toHaveProperty("filter");
    expect(rule(".pin-preview img")).not.toHaveProperty("mix-blend-mode");
  });
});
