import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeletedPage } from "@shazhou/pinboard-contracts";

const host = vi.hoisted(() => ({
  index: 0,
  slots: [] as unknown[],
  effects: [] as (() => void)[],
  cleanups: new Map<number, () => void>(),
  request: vi.fn(),
}));
vi.mock("../src/manager.js", () => ({ requestJson: host.request }));
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
    useRef: (initial: unknown) => {
      const index = host.index++;
      if (!(index in host.slots)) host.slots[index] = { current: initial };
      return host.slots[index];
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
import { RecentlyDeleted } from "../src/recently-deleted.js";

const fixture: DeletedPage = {
  items: [
    {
      kind: "pin",
      id: "fixture-cid",
      title: "Old pin",
      deletedAt: "2026-11-01T10:00:00Z",
      expiresAt: "2026-12-01T10:00:00Z",
    },
  ],
  nextCursor: "pin:fixture-cid",
  total: 52,
  matchedTotal: 52,
};
const onBusyChange = vi.fn();
const onChanged = vi.fn();
let active = true;
let disabled = false;

function render() {
  host.index = 0;
  const tree = RecentlyDeleted({ active, disabled, onBusyChange, onChanged });
  for (const effect of host.effects.splice(0)) effect();
  return tree;
}
const markup = () => renderToStaticMarkup(render());
const flush = async () => {
  render();
  await vi.advanceTimersByTimeAsync(250);
  return markup();
};
type Handlers = {
  children?: ReactNode;
  retry?: ReactNode;
  "aria-label"?: string;
  disabled?: boolean;
  onClick?: () => void;
  onChange?: (event: { target: { value: string } }) => void;
};
function find(
  node: ReactNode,
  label: string,
): ReactElement<Handlers> | undefined {
  if (!isValidElement<Handlers>(node)) return undefined;
  if (
    node.props["aria-label"] === label ||
    (node.type === "button" && node.props.children === label)
  )
    return node;
  for (const child of Children.toArray([
    node.props.children,
    node.props.retry,
  ])) {
    const result = find(child, label);
    if (result) return result;
  }
  return undefined;
}
const control = (label: string) => {
  const element = find(render(), label);
  if (!element) throw new Error(`Missing control: ${label}`);
  return element.props;
};
const search = (value: string) =>
  control("Search recently deleted").onChange?.({ target: { value } });

beforeEach(() => {
  vi.useFakeTimers();
  host.index = 0;
  host.slots = [];
  host.effects = [];
  host.cleanups.clear();
  host.request.mockReset().mockResolvedValue(fixture);
  onBusyChange.mockReset();
  onChanged.mockReset().mockResolvedValue(undefined);
  active = true;
  disabled = false;
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    callback();
    return 0;
  });
});
afterEach(() => {
  for (const cleanup of host.cleanups.values()) cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("inline Settings Trash", () => {
  it("loads only when active and shares table styling with count-only footer content", async () => {
    active = false;
    expect(await flush()).toContain("Loading recently deleted");
    expect(host.request).not.toHaveBeenCalled();
    active = true;
    const html = await flush();
    expect(html).toContain(
      'class="authorization-table-scroll recently-deleted-table"',
    );
    expect(html).toContain("52 items");
    expect(html).toContain('<div class="settings-table-footer">');
    expect(html).toContain("Page 1 / 2");
    expect(html).toContain("Recover before");
    expect(html).not.toContain("<dialog");
    expect(html).not.toContain("seven-day cleanup");
    expect(html).not.toContain("Demo data");
    expect(control("Previous page").disabled).toBe(true);
  });

  it("uses cursor paging and resets search to page one without replacing the overall total", async () => {
    await flush();
    host.request.mockResolvedValue({ ...fixture, nextCursor: null });
    control("Next page").onClick?.();
    expect(await flush()).toContain("Page 2 / 2");
    expect(host.request.mock.lastCall?.[0]).toBe(
      "/api/recently-deleted?cursor=pin%3Afixture-cid",
    );
    expect(control("Next page").disabled).toBe(true);
    control("Previous page").onClick?.();
    await flush();
    expect(host.request.mock.lastCall?.[0]).toBe("/api/recently-deleted");
    host.request.mockResolvedValue({
      ...fixture,
      nextCursor: null,
      matchedTotal: 1,
    });
    search(" PUBLICATION ");
    const html = await flush();
    expect(host.request.mock.lastCall?.[0]).toBe(
      "/api/recently-deleted?q=publication",
    );
    expect(html).toContain("52 items");
    expect(html).not.toContain("Trash pagination");
  });

  it("distinguishes loading, request failures, empty lists and unmatched search", async () => {
    expect(markup()).toContain("Loading recently deleted");
    host.request.mockRejectedValue(new Error("Recovery unavailable"));
    const failure = await flush();
    expect(failure).toContain('role="alert"');
    expect(failure).toContain("Recovery unavailable");
    expect(failure).not.toContain("No recoverable items.");
    host.request.mockResolvedValue({
      items: [],
      nextCursor: null,
      total: 0,
      matchedTotal: 0,
    });
    control("Retry").onClick?.();
    expect(await flush()).toContain("No recoverable items.");
    host.request.mockResolvedValue({
      items: [],
      nextCursor: null,
      total: 52,
      matchedTotal: 0,
    });
    search("missing");
    const empty = await flush();
    expect(empty).toContain("No matching items. Try another name or type.");
    expect(empty).toContain("52 items");
  });

  it("returns to the first page if items expire before the next page loads", async () => {
    await flush();
    host.request.mockResolvedValueOnce({
      items: [],
      nextCursor: null,
      total: 49,
      matchedTotal: 49,
    });
    host.request.mockResolvedValue({
      ...fixture,
      nextCursor: null,
      total: 49,
      matchedTotal: 49,
    });
    control("Next page").onClick?.();
    await flush();
    const html = await flush();
    expect(host.request.mock.lastCall?.[0]).toBe("/api/recently-deleted");
    expect(html).toContain("49 items");
    expect(html).not.toContain("Trash pagination");
    expect(html).not.toContain("No recoverable items.");
  });

  it("aborts obsolete searches and prevents stale responses from overwriting the current page", async () => {
    let resolveOld!: (page: DeletedPage) => void;
    host.request.mockReturnValueOnce(
      new Promise<DeletedPage>((resolve) => {
        resolveOld = resolve;
      }),
    );
    await flush();
    const signal = host.request.mock.calls[0]![1].signal as AbortSignal;
    search("publication");
    host.request.mockResolvedValue({
      ...fixture,
      items: [{ ...fixture.items[0]!, title: "Current match" }],
      nextCursor: null,
      matchedTotal: 1,
    });
    await flush();
    expect(signal.aborted).toBe(true);
    resolveOld(fixture);
    const html = await flush();
    expect(html).toContain("Current match");
    expect(html).not.toContain("Old pin");
    active = false;
    render();
    expect(host.request.mock.lastCall?.[1].signal.aborted).toBe(true);
  });

  it.each(["pin", "publication"] as const)(
    "restores %s without closing Settings and refreshes the first page",
    async (kind) => {
      host.request.mockResolvedValue({
        ...fixture,
        items: [{ ...fixture.items[0]!, kind }],
      });
      await flush();
      control("Next page").onClick?.();
      await flush();
      let finishRestore!: () => void;
      host.request.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          finishRestore = resolve;
        }),
      );
      control("Restore Old pin").onClick?.();
      render();
      expect(onBusyChange).toHaveBeenLastCalledWith(true);
      expect(control("Restore Old pin").disabled).toBe(true);
      expect(host.request.mock.lastCall?.[0]).toBe(
        `/api/${kind === "pin" ? "pins" : "publications"}/fixture-cid/restore`,
      );
      expect(host.request.mock.lastCall?.[1]).toMatchObject({
        method: "POST",
        body: "{}",
      });
      host.request.mockResolvedValue({
        ...fixture,
        nextCursor: null,
        total: 51,
        matchedTotal: 51,
      });
      finishRestore();
      await flush();
      const html = await flush();
      expect(onChanged).toHaveBeenCalledOnce();
      expect(onBusyChange).toHaveBeenLastCalledWith(false);
      expect(host.request.mock.lastCall?.[0]).toBe("/api/recently-deleted");
      expect(html).toContain("51 items");
      expect(html).toContain("Restored Old pin.");
    },
  );

  it("reports restore failures and distinguishes successful restore from failed account refresh", async () => {
    await flush();
    host.request.mockRejectedValueOnce(new Error("Recovery expired"));
    control("Restore Old pin").onClick?.();
    expect(await flush()).toContain(
      "Could not restore Old pin. Recovery expired",
    );
    expect(onChanged).not.toHaveBeenCalled();
    onChanged.mockRejectedValueOnce(new Error("Account unavailable"));
    control("Restore Old pin").onClick?.();
    await flush();
    expect(await flush()).toContain(
      "Restored Old pin, but refreshing the account failed. Account unavailable",
    );
  });
});
