import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import type { Publication } from "@shazhou/pinboard-contracts";

it("overrides generic input styling with the pill-shaped search selector", () => {
  const styles = readFileSync(
    new URL("../src/styles.css", import.meta.url),
    "utf8",
  );
  const selector = '.item-filter input[type="search"]';
  expect(styles).toMatch(
    /\.item-filter input\[type="search"\]\s*\{[^}]*border-radius:\s*999px;/u,
  );
  expect(styles.indexOf(selector)).toBeGreaterThan(
    styles.indexOf('input:not([type="checkbox"]):not([type="radio"])'),
  );
  expect(styles).toMatch(
    /\.item-filter input\[type="search"\]\s*\{[^}]*height:\s*44px;/u,
  );
  expect(styles).toMatch(
    /\.item-filter:focus-within\s*\{[^}]*width:\s*min\(420px,\s*calc\(100vw - 600px\)\);/u,
  );
});

it("keeps the clear action circular without clipping its keyboard focus", () => {
  const styles = readFileSync(
    new URL("../src/styles.css", import.meta.url),
    "utf8",
  );
  const rule = styles.match(/\.item-filter button\s*\{([^}]+)\}/u)?.[1];
  expect(rule).toMatch(/width:\s*44px;/u);
  expect(rule).toMatch(/height:\s*44px;/u);
  expect(rule).toMatch(/border-radius:\s*50%;/u);
  expect(rule).toMatch(/place-items:\s*center;/u);
  expect(rule).toMatch(/outline-offset:\s*-4px;/u);
  expect(rule).toMatch(/border:\s*0;/u);
  expect(styles).toMatch(
    /\.item-filter button:hover:not\(:disabled\)\s*\{[^}]*radial-gradient\(circle,\s*var\(--hover\) 0%,\s*transparent 70%\)/u,
  );
});

const host = vi.hoisted(() => ({
  slots: [] as unknown[],
  index: 0,
  effects: [] as (() => void | (() => void))[],
  cleanups: [] as (() => void)[],
  cleanupSlots: new Map<number, () => void>(),
  fetch: vi.fn(),
}));
vi.mock("../src/api.js", () => ({ apiFetch: host.fetch }));
vi.mock("../src/preview-client.js", () => ({
  PreviewClient: class {
    attach() {
      return () => {};
    }
  },
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const memo = (fn: unknown, deps: unknown[]) => {
    const index = host.index++;
    const old = host.slots[index] as
      { value: unknown; deps: unknown[] } | undefined;
    if (!old || deps.some((value, i) => value !== old.deps[i]))
      host.slots[index] = { value: fn, deps };
    return (host.slots[index] as { value: unknown }).value;
  };
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
    useCallback: memo,
    useMemo: (factory: () => unknown, deps: unknown[]) => {
      const index = host.index++;
      const old = host.slots[index] as
        { value: unknown; deps: unknown[] } | undefined;
      if (!old || deps.some((value, i) => value !== old.deps[i]))
        host.slots[index] = { value: factory(), deps };
      return (host.slots[index] as { value: unknown }).value;
    },
    useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
      const index = host.index++;
      const previous = host.slots[index] as unknown[] | undefined;
      if (!previous || deps.some((value, i) => value !== previous[i])) {
        host.slots[index] = deps;
        host.effects.push(() => {
          host.cleanupSlots.get(index)?.();
          const cleanup = effect();
          if (cleanup) host.cleanupSlots.set(index, cleanup);
          else host.cleanupSlots.delete(index);
          return cleanup;
        });
      }
    },
  };
});
import { useItemLists } from "../src/item-filter.js";
import { useActionItems } from "../src/action-items.js";
import { AccountManager } from "../src/manager.js";
import { LoadingIndicator } from "../src/loading.js";
import { PublicationDialog } from "../src/publications.js";

function render() {
  host.index = 0;
  const result = useItemLists("test-account");
  for (const effect of host.effects.splice(0)) {
    const cleanup = effect();
    if (cleanup) host.cleanups.push(cleanup);
  }
  return result;
}
type InputHandlers = {
  onChange: (event: { target: { value: string } }) => void;
  onCompositionStart: () => void;
  onCompositionEnd: (event: { currentTarget: { value: string } }) => void;
  onKeyDown: (event: {
    key: string;
    nativeEvent: { isComposing?: boolean };
    preventDefault: () => void;
    stopPropagation: () => void;
  }) => void;
};
const input = () =>
  (
    (
      render().filter.props.children as ReactElement[]
    )[0] as ReactElement<InputHandlers>
  ).props;
const change = (value: string) => input().onChange({ target: { value } });
const flush = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms);
  return render();
};
const reply = (
  path: string,
  label = "default",
  nextCursor: string | null = null,
) =>
  Response.json(
    path.includes("/api/pins")
      ? { pins: [{ cid: label, name: label }], nextCursor }
      : { publications: [{ id: label, title: label }], nextCursor },
  );

beforeEach(() => {
  vi.useFakeTimers();
  host.index = 0;
  host.slots = [];
  host.effects = [];
  host.cleanups = [];
  host.cleanupSlots.clear();
  host.fetch
    .mockReset()
    .mockImplementation(async (path: string) => reply(path));
});
afterEach(() => {
  for (const cleanup of host.cleanups) cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("item filter lifecycle", () => {
  it("debounces 200ms, preserves internal whitespace, and fetches only item lists", async () => {
    render();
    await flush();
    host.fetch.mockClear();
    change("  É  中文  ");
    expect(render().loading).toBe(true);
    await flush(199);
    expect(host.fetch).not.toHaveBeenCalled();
    await flush(1);
    expect(host.fetch).toHaveBeenCalledTimes(2);
    for (const [path] of host.fetch.mock.calls) {
      expect(
        new URL(path as string, "http://local").searchParams.get("q"),
      ).toBe("É  中文");
      expect(path).not.toContain("tokens");
    }
  });

  const targetPublication: Publication = {
    id: "existing-publication",
    title: "Existing destination",
    currentRevision: 1,
    revisionCount: 1,
    sequence: 7,
    createdAt: "2026-11-01",
    updatedAt: "2026-11-01",
    current: {
      revision: 1,
      cid: "existing-cid",
      size: 1,
      blocks: 1,
      createdAt: "2026-11-01",
    },
  };
  function effects() {
    for (const effect of host.effects.splice(0)) {
      const cleanup = effect();
      if (cleanup) host.cleanups.push(cleanup);
    }
  }
  function renderActions(
    context: string,
    needsPins = false,
    needsPublications = true,
  ) {
    host.index = 0;
    const state = useActionItems(context, needsPins, needsPublications);
    effects();
    return state;
  }
  type TreeProps = {
    children?: ReactNode;
    className?: string;
    value?: string;
    disabled?: boolean;
    label?: string;
    compact?: boolean;
    "aria-label"?: string;
    onClick?: () => void;
    onChange?: (event: {
      target: { value: string };
      currentTarget?: { files: File[] };
    }) => void;
    onSubmit?: (event: { preventDefault: () => void }) => void;
  };
  function find(
    node: ReactNode,
    predicate: (node: ReactElement<TreeProps>) => boolean,
  ): ReactElement<TreeProps> | undefined {
    if (!isValidElement<TreeProps>(node)) return undefined;
    if (predicate(node)) return node;
    for (const child of Children.toArray(node.props.children)) {
      const found = find(child, predicate);
      if (found) return found;
    }
    return undefined;
  }
  let managerFilter: ReactElement<{ children: ReactNode }>;
  function renderManager() {
    host.index = 0;
    const tree = AccountManager({
      accountId: "test-account",
      renderHeader: (_settings, _disabled, filter) => {
        managerFilter = filter as ReactElement<{ children: ReactNode }>;
        return null;
      },
    });
    effects();
    return tree;
  }
  it("uses one loader for initial items and filtering, then stops on failure and recovers on retry", async () => {
    vi.stubGlobal("document", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("localStorage", { getItem: () => null });
    const respond = async (path: string) =>
      path.startsWith("/api/tokens")
        ? Response.json({ tokens: [] })
        : path.startsWith("/api/publications")
          ? Response.json({
              publications: [targetPublication],
              nextCursor: null,
            })
          : reply(path);
    host.fetch.mockImplementation(respond);
    const loader = (tree: ReactNode) =>
      find(tree, (node) => node.type === LoadingIndicator);
    let tree = renderManager();
    expect(loader(tree)?.props).toMatchObject({
      label: "Loading your pins...",
      compact: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(loader(renderManager())).toBeUndefined();
    const filterInput = (
      managerFilter.props.children as ReactElement<InputHandlers>[]
    )[0]!.props;
    filterInput.onChange({ target: { value: "query" } });
    tree = renderManager();
    expect(loader(tree)?.props).toMatchObject({
      label: "Filtering...",
      compact: true,
    });
    expect(
      find(tree, (node) => node.props.className === "pin-list"),
    ).toBeDefined();
    host.fetch.mockResolvedValue(new Response("", { status: 503 }));
    await vi.advanceTimersByTimeAsync(200);
    tree = renderManager();
    expect(loader(tree)).toBeUndefined();
    const retry = find(
      tree,
      (node) => node.type === "button" && node.props.children === "Try again",
    );
    expect(retry).toBeDefined();
    host.fetch.mockImplementation(respond);
    retry?.props.onClick?.();
    expect(loader(renderManager())?.props.compact).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(loader(renderManager())).toBeUndefined();
  });
  describe("unfiltered action choices", () => {
    it("loads only on demand, follows unfiltered cursors, and reports errors with retry", async () => {
      host.fetch.mockImplementation(async (path: string) => {
        if (path === "/api/publications")
          return Response.json({
            publications: [targetPublication],
            nextCursor: "next",
          });
        expect(path).toBe("/api/publications?cursor=next");
        return Response.json({
          publications: [{ ...targetPublication, id: "second" }],
          nextCursor: null,
        });
      });
      renderActions("");
      expect(host.fetch).not.toHaveBeenCalled();
      expect(renderActions("upload").loading).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(renderActions("upload").publications).toHaveLength(2);
      expect(host.fetch).toHaveBeenCalledTimes(2);
      host.fetch.mockResolvedValue(new Response("", { status: 503 }));
      expect(renderActions("other-upload").loading).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      let state = renderActions("other-upload");
      expect(state.error).toContain("503");
      expect(state.publications).toEqual([]);
      host.fetch.mockResolvedValue(
        Response.json({ publications: [targetPublication], nextCursor: null }),
      );
      state.retry();
      renderActions("other-upload");
      await vi.advanceTimersByTimeAsync(0);
      state = renderActions("other-upload");
      expect(state.error).toBe("");
      expect(state.publications[0]?.id).toBe(targetPublication.id);
    });
    it("aborts closed or replaced chooser requests even if transport ignores abort", async () => {
      let resolve!: (response: Response) => void;
      host.fetch.mockImplementationOnce(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      );
      renderActions("upload");
      const signal = (host.fetch.mock.calls[0]?.[1] as RequestInit).signal;
      renderActions("");
      expect(signal?.aborted).toBe(true);
      host.fetch.mockResolvedValue(
        Response.json({
          publications: [{ ...targetPublication, id: "new" }],
          nextCursor: null,
        }),
      );
      renderActions("new-upload");
      await vi.advanceTimersByTimeAsync(0);
      resolve(
        Response.json({ publications: [targetPublication], nextCursor: null }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(renderActions("new-upload").publications[0]?.id).toBe("new");
    });
    it("keeps existing upload destinations and selected target when the filtered wall has no matches", async () => {
      vi.stubGlobal("document", {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      });
      vi.stubGlobal("localStorage", { getItem: () => null });
      host.fetch.mockImplementation(
        async (path: string, init?: RequestInit) => {
          if (path.startsWith("/api/tokens"))
            return Response.json({ tokens: [] });
          if (path.startsWith("/api/pins/upload"))
            return Response.json({
              cid: "uploaded",
              name: "file.txt",
              size: 1,
              blocks: 1,
              createdAt: "2026-11-01",
            });
          if (path === `/api/publications/${targetPublication.id}/publish`) {
            expect(JSON.parse(init?.body as string)).toMatchObject({
              cid: "uploaded",
              expectedSequence: 7,
            });
            return Response.json({
              status: "published",
              publication: targetPublication,
            });
          }
          const url = new URL(path, "http://test");
          if (url.pathname === "/api/publications")
            return Response.json({
              publications: url.searchParams.get("q")
                ? []
                : [targetPublication],
              nextCursor: null,
            });
          return Response.json({ pins: [], nextCursor: null });
        },
      );
      renderManager();
      await vi.advanceTimersByTimeAsync(0);
      renderManager();
      const filterInput = () =>
        (managerFilter.props.children as ReactElement<InputHandlers>[])[0]!
          .props;
      filterInput().onChange({ target: { value: "no-match" } });
      await vi.advanceTimersByTimeAsync(200);
      let tree = renderManager();
      expect(
        find(tree, (node) => node.props.className === "pin-list"),
      ).toBeUndefined();
      const picker = find(
        tree,
        (node) =>
          node.props["aria-label"] === "Choose file" && node.type === "input",
      );
      picker?.props.onChange?.({
        target: { value: "" },
        currentTarget: { files: [new File(["x"], "file.txt")] },
      });
      await vi.advanceTimersByTimeAsync(0);
      tree = renderManager();
      expect(
        find(tree, (node) => node.type === "select" && node.props.value === "")
          ?.props.disabled,
      ).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      tree = renderManager();
      const chooser = find(
        tree,
        (node) =>
          node.type === "select" &&
          !!find(
            node,
            (child) =>
              child.type === "option" &&
              child.props.value === targetPublication.id,
          ),
      );
      expect(chooser).toBeDefined();
      chooser?.props.onChange?.({ target: { value: targetPublication.id } });
      const destinationRequests = host.fetch.mock.calls.filter(
        ([path]) => path === "/api/publications",
      ).length;
      filterInput().onChange({ target: { value: "another-no-match" } });
      await vi.advanceTimersByTimeAsync(200);
      tree = renderManager();
      expect(
        host.fetch.mock.calls.filter(([path]) => path === "/api/publications"),
      ).toHaveLength(destinationRequests);
      expect(
        find(
          tree,
          (node) =>
            node.type === "select" && node.props.value === targetPublication.id,
        ),
      ).toBeDefined();
      const uploadForm = find(
        tree,
        (node) =>
          node.type === "form" &&
          !!find(
            node,
            (child) =>
              child.type === "select" &&
              child.props.value === targetPublication.id,
          ),
      );
      uploadForm?.props.onSubmit?.({ preventDefault: vi.fn() });
      await vi.advanceTimersByTimeAsync(0);
      expect(
        host.fetch.mock.calls.some(
          ([path]) =>
            path === `/api/publications/${targetPublication.id}/publish`,
        ),
      ).toBe(true);
      expect(
        host.fetch.mock.calls.some(
          ([path, init]) =>
            path === "/api/publications" &&
            (init as RequestInit)?.method === "POST",
        ),
      ).toBe(false);
      const dialog = find(tree, (node) => node.type === PublicationDialog);
      expect(dialog).toBeDefined();
    });
    it("loads unfiltered Pin choices independently for publishing an existing Pin", async () => {
      host.fetch.mockResolvedValue(
        Response.json({
          pins: [{ cid: "hidden-pin", name: "Outside filter" }],
          nextCursor: null,
        }),
      );
      renderActions("publication:existing", true, false);
      await vi.advanceTimersByTimeAsync(0);
      expect(
        renderActions("publication:existing", true, false).pins[0]?.cid,
      ).toBe("hidden-pin");
      expect(host.fetch.mock.calls[0]?.[0]).toBe("/api/pins");
    });
  });
  it("does not turn an unavailable existing publication selection into accidental creation", async () => {
    const renderDialog = () => {
      host.index = 0;
      const tree = PublicationDialog({
        publication: null,
        pin: {
          cid: "owned-pin",
          name: "Private name",
          size: 1,
          blocks: 1,
          createdAt: "2026-11-01",
        },
        pins: [],
        publications: [],
        onClose: () => {},
        onChanged: async () => {},
      });
      effects();
      return tree;
    };
    let tree = renderDialog();
    find(tree, (node) => node.type === "select")?.props.onChange?.({
      target: { value: "unavailable-destination" },
    });
    tree = renderDialog();
    find(tree, (node) => node.type === "form")?.props.onSubmit?.({
      preventDefault: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(host.fetch).not.toHaveBeenCalled();
    expect(
      find(
        renderDialog(),
        (node) =>
          node.type === "p" &&
          Children.toArray(node.props.children).some(
            (child) =>
              typeof child === "string" &&
              child.includes("Publication choices are unavailable"),
          ),
      ),
    ).toBeDefined();
  });
  it("suppresses IME intermediates and allows Enter only after composition", async () => {
    render();
    await flush();
    host.fetch.mockClear();
    input().onCompositionStart();
    change("中");
    input().onKeyDown({
      key: "Enter",
      nativeEvent: { isComposing: true },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });
    await flush(250);
    expect(host.fetch).not.toHaveBeenCalled();
    input().onCompositionEnd({ currentTarget: { value: "中文" } });
    await flush(200);
    expect(host.fetch).toHaveBeenCalledTimes(2);
    change("next");
    input().onKeyDown({
      key: "Enter",
      nativeEvent: {},
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });
    await flush();
    expect(host.fetch).toHaveBeenCalledTimes(4);
    await flush(200);
    expect(host.fetch).toHaveBeenCalledTimes(4);
  });
  it("aborts and ignores old queries even if transport ignores abort", async () => {
    render();
    await flush();
    const pending: (() => void)[] = [];
    host.fetch.mockImplementation(
      (path: string) =>
        new Promise<Response>((resolve) => {
          pending.push(() => resolve(reply(path, "old")));
        }),
    );
    change("old");
    await flush(200);
    const oldSignal = (host.fetch.mock.calls.at(-1)?.[1] as RequestInit).signal;
    change("new");
    expect(oldSignal?.aborted).toBe(true);
    host.fetch.mockImplementation(async (path: string) => reply(path, "new"));
    await flush(200);
    for (const resolve of pending) resolve();
    const state = await flush();
    expect(state.pins[0]?.name).toBe("new");
    expect(state.publications[0]?.title).toBe("new");
  });
  it("guards stale load-more and refresh, with cursor and q bound together", async () => {
    host.fetch.mockImplementation(async (path: string) =>
      reply(path, "first", "cursor-one"),
    );
    render();
    await flush();
    change("active");
    let state = await flush(200);
    let resolve!: (response: Response) => void;
    host.fetch.mockImplementationOnce((path: string) => {
      expect(new URL(path, "http://local").searchParams.get("q")).toBe(
        "active",
      );
      expect(new URL(path, "http://local").searchParams.get("cursor")).toBe(
        "cursor-one",
      );
      return new Promise<Response>((done) => {
        resolve = done;
      });
    });
    void state.loadMore("pins");
    change("latest");
    host.fetch.mockImplementation(async (path: string) =>
      reply(path, "latest"),
    );
    await flush(200);
    resolve(reply("/api/pins", "stale"));
    state = await flush();
    expect(state.pins.map((pin) => pin.name)).toEqual(["latest"]);
    const old: (() => void)[] = [];
    host.fetch.mockImplementation(
      (path: string) =>
        new Promise<Response>((done) =>
          old.push(() => done(reply(path, "stale-refresh"))),
        ),
    );
    void state.refresh();
    change("final");
    host.fetch.mockImplementation(async (path: string) => reply(path, "final"));
    await flush(200);
    old.forEach((done) => done());
    expect((await flush()).pins[0]?.name).toBe("final");
  });
  it("keeps partial failure distinct from empty, retries and clears immediately", async () => {
    render();
    await flush();
    host.fetch.mockImplementation(async (path: string) =>
      path.includes("publications")
        ? new Response("", { status: 503 })
        : reply(path),
    );
    change("failure");
    let state = await flush(200);
    expect(state.error).toContain("503");
    expect(state.loading).toBe(false);
    host.fetch.mockImplementation(async (path: string) =>
      reply(path, "recovered"),
    );
    await state.refresh();
    expect(render().error).toBe("");
    change("pending");
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    input().onKeyDown({
      key: "Escape",
      nativeEvent: {},
      preventDefault,
      stopPropagation,
    });
    state = await flush();
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
    expect(state.filtered).toBe(false);
    expect(host.fetch.mock.calls.at(-1)?.[0]).toBe("/api/publications?q=");
    expect((state.filter.props.children as unknown[])[1]).toBeNull();
  });
});
