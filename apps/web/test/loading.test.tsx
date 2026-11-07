import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  index: 0,
  slots: [] as unknown[],
  effects: [] as (() => void)[],
  cleanups: new Map<number, () => void>(),
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = host.index++;
      if (!(index in host.slots)) host.slots[index] = initial;
      return [
        host.slots[index],
        (next: unknown) => {
          host.slots[index] =
            typeof next === "function" ? next(host.slots[index]) : next;
        },
      ];
    },
    useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
      const index = host.index++;
      const previous = host.slots[index] as unknown[] | undefined;
      if (!previous || deps.some((value, i) => value !== previous[i])) {
        host.slots[index] = deps;
        host.effects.push(() => {
          host.cleanups.get(index)?.();
          const cleanup = effect();
          if (cleanup) host.cleanups.set(index, cleanup);
          else host.cleanups.delete(index);
        });
      }
    },
  };
});

import {
  LoadingIndicator,
  LoadingReveal,
  loadingFadeDuration,
  loadingQuoteInterval,
} from "../src/loading.js";

function render<T>(component: () => T): T {
  host.index = 0;
  const tree = component();
  for (const effect of host.effects.splice(0)) effect();
  return tree;
}
const indicator = (active = true, compact = false) =>
  renderToStaticMarkup(
    render(() => LoadingIndicator({ label: "Loading pins", active, compact })),
  );
const reveal = (loading: boolean) => {
  const tree = render(() =>
    LoadingReveal({
      loading,
      label: "Loading pins",
      children: <button>Ready action</button>,
    }),
  );
  const [overlay, content] = tree.props.children;
  return { overlay, content };
};
const unmount = () => {
  for (const cleanup of host.cleanups.values()) cleanup();
  host.cleanups.clear();
};

beforeEach(() => {
  vi.useFakeTimers();
  host.index = 0;
  host.slots = [];
  host.effects = [];
  host.cleanups.clear();
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
});
afterEach(() => {
  unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("editorial loading thoughts", () => {
  it("rotates original copy every 2.6 seconds with a soft handoff and wraps", () => {
    expect(indicator()).toContain("Keep what matters.");
    vi.advanceTimersByTime(loadingQuoteInterval - 1);
    expect(indicator()).not.toContain("loading-quote changing");
    vi.advanceTimersByTime(1);
    expect(indicator()).toContain("loading-quote changing");
    vi.advanceTimersByTime(loadingFadeDuration / 2);
    expect(indicator()).toContain("Your content. Your address.");
    expect(indicator()).not.toContain("loading-quote changing");
    vi.advanceTimersByTime(loadingQuoteInterval * 4);
    expect(indicator()).toContain("Keep what matters.");
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps copy decorative and freezes it when the whole scene is leaving", () => {
    const html = indicator();
    expect(html).toContain('role="status" aria-label="Loading pins"');
    expect(html).toContain('class="loading-editorial" aria-hidden="true"');
    vi.advanceTimersByTime(loadingQuoteInterval);
    expect(indicator(false)).not.toContain("loading-quote changing");
    vi.advanceTimersByTime(loadingQuoteInterval * 3);
    expect(indicator(false)).toContain("Keep what matters.");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps filtering compact without quote copy or timers", () => {
    const html = indicator(true, true);
    expect(html).toContain("loading-indicator-compact");
    expect(html).not.toContain("loading-editorial");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("loading scene reveal", () => {
  it("fades the whole scene before revealing interactive results", () => {
    expect(reveal(true).content.props.hidden).toBe(true);
    const leaving = reveal(false);
    expect(leaving.overlay.props.className).toContain("leaving");
    expect(leaving.content.props.hidden).toBe(true);
    expect(leaving.overlay.props.children.props.active).toBe(false);
    vi.advanceTimersByTime(loadingFadeDuration - 1);
    expect(reveal(false).content.props.hidden).toBe(true);
    vi.advanceTimersByTime(1);
    expect(reveal(false).overlay).toBeNull();
    expect(reveal(false).content.props.hidden).toBe(false);
  });

  it("does not hold content that was ready at mount", () => {
    expect(reveal(false).overlay).toBeNull();
    expect(reveal(false).content.props.hidden).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reveals on the scene's animation end, not a child's, and cancels its fallback", () => {
    reveal(true);
    const leaving = reveal(false);
    const surface = {};
    leaving.overlay.props.onAnimationEnd({
      target: {},
      currentTarget: surface,
    });
    expect(reveal(false).content.props.hidden).toBe(true);
    leaving.overlay.props.onAnimationEnd({
      target: surface,
      currentTarget: surface,
    });
    expect(reveal(false).content.props.hidden).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels the old exit if a retry starts and clears timers on unmount", () => {
    reveal(true);
    reveal(false);
    vi.advanceTimersByTime(loadingFadeDuration / 2);
    expect(reveal(true).overlay.props.className).not.toContain("leaving");
    vi.advanceTimersByTime(loadingFadeDuration * 2);
    expect(reveal(true).content.props.hidden).toBe(true);
    reveal(false);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("skips the exit delay when reduced motion is requested", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    reveal(true);
    reveal(false);
    expect(reveal(false).overlay).toBeNull();
    expect(reveal(false).content.props.hidden).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
