import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BackgroundSettings,
  PinboardBackground,
  backgroundPalettes,
  backgroundStorageKey,
  initializeBackground,
  readBackground,
  saveBackground,
} from "../src/background.js";

describe("browser background preferences", () => {
  let saved: Map<string, string>;
  let dataset: { background?: string };

  beforeEach(() => {
    saved = new Map();
    dataset = {};
    vi.stubGlobal("document", { documentElement: { dataset } });
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => saved.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => saved.set(key, value)),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("preserves storage identifiers and exposes the approved names with English descriptions", () => {
    expect(backgroundStorageKey).toBe("pinboard:background");
    expect(backgroundPalettes).toEqual([
      { id: "mist", label: "晨光雾屿 · Mist blue & lavender" },
      { id: "sand", label: "玫瑰沙丘 · Sand & rose" },
      { id: "ice", label: "晴空冰海 · Clear sky blue" },
    ]);
  });

  it("defaults to mist blue and lavender before rendering", () => {
    expect(readBackground()).toBe("mist");
    initializeBackground();
    expect(dataset.background).toBe("mist");
    expect(saved.size).toBe(0);
  });

  it.each(backgroundPalettes)(
    "applies and restores $id across page loads",
    ({ id }) => {
      saveBackground(id);
      expect(saved.get(backgroundStorageKey)).toBe(id);
      expect(dataset.background).toBe(id);
      delete dataset.background;
      initializeBackground();
      expect(dataset.background).toBe(id);
      expect(readBackground()).toBe(id);
    },
  );

  it("reports invalid stored values and explicitly restores the default", () => {
    saved.set(backgroundStorageKey, "invalid");
    expect(() => readBackground()).toThrow(
      "Unrecognized background preference",
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    initializeBackground();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not restore the background preference"),
      expect.any(Error),
    );
    expect(dataset.background).toBe("mist");
    saveBackground("ice");
    expect(readBackground()).toBe("ice");
  });

  it("logs blocked reads while keeping the default background available", () => {
    vi.mocked(localStorage.getItem).mockImplementation(() => {
      throw new Error("Storage is blocked");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    initializeBackground();
    expect(dataset.background).toBe("mist");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("surfaces failed writes without changing the displayed or saved palette", () => {
    saveBackground("sand");
    vi.mocked(localStorage.setItem).mockImplementation(() => {
      throw new Error("Storage is blocked");
    });
    expect(() => saveBackground("ice")).toThrow("Storage is blocked");
    expect(dataset.background).toBe("sand");
    expect(saved.get(backgroundStorageKey)).toBe("sand");
  });

  it("renders three labeled native radio controls with the current palette selected", () => {
    saveBackground("sand");
    const html = renderToStaticMarkup(
      <BackgroundSettings disabled={false} onError={() => {}} />,
    );
    expect(html).toContain("<legend>Background palette</legend>");
    expect(html.match(/type="radio"/g)).toHaveLength(3);
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(html).toContain('checked="" value="sand"');
    for (const { id, label } of backgroundPalettes) {
      expect(html).toContain(`data-background="${id}"`);
      expect(html).toContain(label.replace("&", "&amp;"));
    }
  });

  it("disables the palette group while account operations are pending", () => {
    const html = renderToStaticMarkup(
      <BackgroundSettings disabled onError={() => {}} />,
    );
    expect(html).toContain('<fieldset class="background-options" disabled="">');
  });

  it("uses the default in server-rendered settings without browser globals", () => {
    vi.stubGlobal("document", undefined);
    const html = renderToStaticMarkup(
      <BackgroundSettings disabled={false} onError={() => {}} />,
    );
    expect(html).toContain('checked="" value="mist"');
  });

  it("renders the approved paper effect as a noninteractive fixed backdrop", () => {
    const html = renderToStaticMarkup(<PinboardBackground />);
    expect(html).toContain('class="pinboard-backdrop" aria-hidden="true"');
    expect(html).toContain("position:fixed");
    expect(html).toContain("z-index:-1");
    expect(html).toContain(
      'width="480" height="960" patternUnits="userSpaceOnUse"',
    );
    expect(html.match(/rotate\(/g)).toHaveLength(70);
    expect(html.match(/<use /g)).toHaveLength(9);
    expect(html).toContain('stroke-width="1.6"');
    expect(html).toContain('stdDeviation="0.12"');
    expect(html).toContain('dx="-0.45" dy="-0.55"');
    expect(html).toContain('dx="0.45" dy="0.55"');
    for (const opacity of ["0.12", "0.42", "0.035"]) {
      expect(html).toContain(`flood-opacity="${opacity}"`);
    }
    expect(html).toContain(
      '<feMergeNode in="highlight"></feMergeNode><feMergeNode in="core"></feMergeNode><feMergeNode in="shadow"></feMergeNode>',
    );
    expect(renderToStaticMarkup(<PinboardBackground />)).toBe(html);
  });
});
