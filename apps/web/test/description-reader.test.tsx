import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeDescription } from "@shazhou/pinboard-contracts";

type Frame = {
  index: number;
  slots: unknown[];
  effects: (() => void)[];
  cleanups: Map<number, () => void>;
};
const host = vi.hoisted(() => ({ current: null as Frame | null }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const memo = (factory: () => unknown, deps: unknown[]) => {
    const frame = host.current!;
    const index = frame.index++;
    const prior = frame.slots[index] as
      { deps: unknown[]; value: unknown } | undefined;
    if (!prior || deps.some((dep, i) => !Object.is(dep, prior.deps[i])))
      frame.slots[index] = { deps, value: factory() };
    return (frame.slots[index] as { value: unknown }).value;
  };
  return {
    ...actual,
    useState: (initial: unknown) => {
      if (!host.current) return actual.useState(initial);
      const frame = host.current;
      const index = frame.index++;
      if (!(index in frame.slots))
        frame.slots[index] =
          typeof initial === "function" ? initial() : initial;
      return [
        frame.slots[index],
        (next: unknown) => {
          frame.slots[index] =
            typeof next === "function" ? next(frame.slots[index]) : next;
        },
      ];
    },
    useRef: (initial: unknown) =>
      host.current
        ? memo(() => ({ current: initial }), [])
        : actual.useRef(initial),
    useMemo: (factory: () => unknown, deps: unknown[]) =>
      host.current ? memo(factory, deps) : actual.useMemo(factory, deps),
    useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
      if (!host.current) return actual.useEffect(effect, deps);
      const frame = host.current;
      const index = frame.index++;
      const prior = frame.slots[index] as unknown[] | undefined;
      if (!prior || deps.some((dep, i) => !Object.is(dep, prior[i]))) {
        frame.slots[index] = deps;
        frame.effects.push(() => {
          frame.cleanups.get(index)?.();
          const cleanup = effect();
          if (cleanup) frame.cleanups.set(index, cleanup);
          else frame.cleanups.delete(index);
        });
      }
    },
  };
});

import { NodeDescriptionEditor } from "../src/node-description.js";
import {
  DescriptionClient,
  type DescriptionContext,
} from "../src/description-client.js";
import { PreviewClient } from "../src/preview-client.js";
import { IDBFactory } from "fake-indexeddb";
import { writeCachedPreviews } from "../src/preview-cache.js";
import { PublicationDialog, PublicationPage } from "../src/publications.js";
import type { PublicationHistory } from "@shazhou/pinboard-contracts";

const ctx = { rootCid: "root", nodeCid: "root" };
const value = (
  text = "original",
  version = 1,
  context: DescriptionContext = ctx,
): NodeDescription => ({
  rootCid: context.rootCid,
  nodeCid: context.nodeCid,
  description: {
    user: { text, version },
    preview: {
      version: 1,
      status: "ready",
      truncated: false,
      contentType: "text/plain",
      preview: { kind: "markdown", text: `preview ${text}` },
    },
  },
});
const pendingValue = (failed = false): NodeDescription => ({
  ...value(),
  description: {
    ...value().description,
    preview: {
      version: 1,
      status: failed ? "failed" : "pending",
      truncated: false,
      contentType: "text/plain",
      preview: null,
      ...(failed
        ? { reason: "Preview generation failed; retry scheduled" }
        : {}),
    },
  },
});
const deferred = () => {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
const frame = (): Frame => ({
  index: 0,
  slots: [],
  effects: [],
  cleanups: new Map(),
});
const componentFrames: Frame[] = [];
const componentReader = <P,>(
  component: (props: P) => ReactElement,
  initial: P,
) => {
  const state = frame();
  componentFrames.push(state);
  return (props = initial) => {
    host.current = state;
    state.index = 0;
    const tree = component(props);
    host.current = null;
    state.effects.splice(0).forEach((effect) => {
      effect();
    });
    return renderToStaticMarkup(tree);
  };
};
const publicationHistory = (id: string): PublicationHistory => {
  const current = {
    revision: 1,
    cid: "root",
    size: 10,
    blocks: 1,
    createdAt: "2026-11-09T00:00:00Z",
  };
  return {
    publication: {
      id,
      title: `Public ${id}`,
      currentRevision: 1,
      revisionCount: 1,
      sequence: 1,
      createdAt: current.createdAt,
      updatedAt: current.createdAt,
      current,
    },
    revisions: [current],
    operations: [],
  };
};
const clear = (state: Frame) => {
  state.cleanups.forEach((cleanup) => cleanup());
  state.cleanups.clear();
};
type Props = Parameters<typeof NodeDescriptionEditor>[0];
type Element = ReactElement<Record<string, unknown>>;
interface Reader {
  render: (props?: Props) => string;
  click: (label: string) => void;
  edit: (text: string) => void;
  submit: () => void;
  find: (predicate: (node: Element) => boolean) => Element;
  close: () => void;
}
const readers: Reader[] = [];
function reader(props: Props): Reader {
  const outer = frame();
  let inner = frame();
  let key: string | null = null;
  let tree: ReactElement;
  const render = (next = props) => {
    props = next;
    outer.index = 0;
    host.current = outer;
    const wrapper = NodeDescriptionEditor(props);
    if (key !== wrapper.key) {
      clear(inner);
      inner = frame();
      key = wrapper.key;
    }
    inner.index = 0;
    host.current = inner;
    tree = (wrapper.type as (props: unknown) => ReactElement)(wrapper.props);
    host.current = null;
    for (const effect of [
      ...outer.effects.splice(0),
      ...inner.effects.splice(0),
    ])
      effect();
    return renderToStaticMarkup(tree);
  };
  const find = (
    predicate: (node: ReactElement<Record<string, unknown>>) => boolean,
  ) => {
    const visit = (
      node: ReactNode,
    ): ReactElement<Record<string, unknown>> | undefined => {
      if (Array.isArray(node)) {
        for (const child of node) {
          const found = visit(child);
          if (found) return found;
        }
      } else if (isValidElement<Record<string, unknown>>(node)) {
        if (predicate(node)) return node;
        return visit(node.props.children as ReactNode);
      }
      return undefined;
    };
    const found = visit(tree);
    if (!found) throw new Error("Missing element");
    return found;
  };
  const click = (label: string) => {
    const button = find(
      (node) =>
        node.type === "button" &&
        (node.props.children === label || node.props["aria-label"] === label),
    );
    (button.props.onClick as () => void)();
  };
  const edit = (text: string) => {
    const textarea = find((node) => node.type === "textarea");
    (textarea.props.onChange as (event: unknown) => void)({
      target: { value: text },
    });
  };
  const submit = () => {
    const form = find((node) => node.type === "form");
    (form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
  };
  const instance = {
    render,
    click,
    edit,
    submit,
    find,
    close: () => {
      clear(outer);
      clear(inner);
    },
  };
  readers.push(instance);
  return instance;
}
const clients: DescriptionClient[] = [];
const client = (account = "a", previews?: PreviewClient) => {
  const instance = new DescriptionClient(account, previews);
  clients.push(instance);
  return instance;
};
const flush = async () => {
  for (let index = 0; index < 15; index++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    confirm: vi.fn(() => true),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(Response.json(value()))),
  );
});
afterEach(() => {
  readers.splice(0).forEach((instance) => instance.close());
  clients.splice(0).forEach((instance) => instance.dispose());
  componentFrames.splice(0).forEach((state) => {
    clear(state);
  });
  host.current = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("cached detail reader integration", () => {
  it("does not render another publication's old resolved history while a new follow link resolves", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json(publicationHistory("a")),
    );
    const page = componentReader(PublicationPage, { id: "a" });
    page();
    await flush();
    expect(page()).toContain("<h1>Public a</h1>");
    const pending = deferred();
    vi.mocked(fetch).mockReturnValueOnce(pending.promise);
    const switched = page({ id: "b" });
    expect(switched).not.toContain("Public a");
    expect(switched).toContain("Loading publication...");
    pending.resolve(Response.json(publicationHistory("b")));
    await flush();
    expect(page({ id: "b" })).toContain("<h1>Public b</h1>");
  });

  it("ignores a late old publication history response after switching IDs", async () => {
    const pending = deferred();
    vi.mocked(fetch)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(Response.json(publicationHistory("b")));
    const page = componentReader(PublicationPage, { id: "a" });
    page();
    page({ id: "b" });
    await flush();
    expect(page({ id: "b" })).toContain("<h1>Public b</h1>");
    pending.resolve(Response.json(publicationHistory("a")));
    await flush();
    expect(page({ id: "b" })).toContain("<h1>Public b</h1>");
    expect(page({ id: "b" })).not.toContain("Public a");
  });

  it("does not reuse another publication's resolved history in the account dialog", async () => {
    const props = {
      publication: publicationHistory("a").publication,
      pin: null,
      pins: [],
      publications: [],
      onClose: () => {},
      onChanged: async () => {},
    };
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json(publicationHistory("a")),
    );
    const dialog = componentReader(PublicationDialog, props);
    dialog();
    await flush();
    expect(dialog()).toContain("Public a");
    const switched = dialog({
      ...props,
      publication: publicationHistory("b").publication,
    });
    expect(switched).toContain("Public b");
    expect(switched).not.toContain("Public a");
  });

  it("immediately renders a reopened snapshot while a real background GET is delayed", async () => {
    const cache = client();
    const first = reader({
      rootCid: "root",
      readingFirst: true,
      client: cache,
    });
    expect(first.render()).toContain("Loading content...");
    await flush();
    expect(first.render()).toContain("preview original");
    first.close();
    const pending = deferred();
    vi.mocked(fetch).mockReturnValueOnce(pending.promise);
    const reopened = reader({
      rootCid: "root",
      readingFirst: true,
      client: cache,
    });
    const html = reopened.render();
    expect(html).toContain("preview original");
    expect(html).not.toContain("Loading content...");
    expect(html).toContain('aria-busy="false"');
    expect(fetch).toHaveBeenCalledTimes(2);
    const concurrent = reader({
      rootCid: "root",
      readingFirst: true,
      client: cache,
    });
    expect(concurrent.render()).toContain("preview original");
    expect(fetch).toHaveBeenCalledTimes(2);
    pending.resolve(Response.json(value("fresh", 2)));
    await flush();
    expect(reopened.render()).toContain("preview fresh");
    expect(concurrent.render()).toContain("preview fresh");
  });

  it("shows only existing system preview while the description waits, without inventing an editable user version", async () => {
    vi.useRealTimers();
    vi.stubGlobal("indexedDB", new IDBFactory());
    const previews = new PreviewClient("a");
    const preview = value().description.preview;
    await writeCachedPreviews([
      {
        key: JSON.stringify(["a", "root"]),
        preview,
        savedAt: Date.now(),
        accessedAt: Date.now(),
        bytes: new TextEncoder().encode(JSON.stringify(preview)).length,
      },
    ]);
    const cache = client("a", previews);
    const pending = deferred();
    vi.mocked(fetch).mockReturnValueOnce(pending.promise);
    const detail = reader({
      rootCid: "root",
      readingFirst: true,
      client: cache,
    });
    detail.render();
    await flush();
    // IndexedDB events run outside fake timers.
    vi.useRealTimers();
    await vi.waitFor(() =>
      expect(detail.render()).toContain("preview original"),
    );
    const html = detail.render();
    expect(html).toContain("Loading description...");
    expect(html).not.toContain("Edit description");
    pending.resolve(Response.json(value("authorized")));
    await flush();
    expect(detail.render()).toContain("Edit description");
    previews.dispose();
  });

  it("warns and still loads from the network when persistent preview storage is unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("indexedDB", undefined);
    const previews = new PreviewClient("a");
    const detail = reader({
      rootCid: "root",
      readingFirst: true,
      client: client("a", previews),
    });
    detail.render();
    await flush();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Preview persistence unavailable"),
      expect.anything(),
    );
    expect(detail.render()).toContain("preview original");
    previews.dispose();
  });

  it("does not paint the previous node, account or publication revision during context changes", () => {
    const first = client("a");
    first.saved(ctx, value("a"));
    const detail = reader({
      rootCid: "root",
      readingFirst: true,
      client: first,
    });
    expect(detail.render()).toContain("preview a");
    const other = { rootCid: "other", readingFirst: true, client: first };
    expect(detail.render(other)).not.toContain("preview a");
    expect(
      detail.render({
        rootCid: "root",
        readingFirst: true,
        client: client("b"),
      }),
    ).not.toContain("preview a");
    const publicOne = { ...ctx, publicationId: "pub", revision: 1 };
    first.saved(publicOne, value("v1", 1, publicOne));
    expect(
      detail.render({
        rootCid: "root",
        readingFirst: true,
        client: first,
        publicationId: "pub",
        revision: 1,
      }),
    ).toContain("preview v1");
    expect(
      detail.render({
        rootCid: "root",
        readingFirst: true,
        client: first,
        publicationId: "pub",
        revision: 2,
      }),
    ).not.toContain("preview v1");
  });

  it("holds the draft text and original CAS version through refresh, shares saves with nested readers, and wins old GET races", async () => {
    const cache = client();
    cache.saved(ctx, value());
    const pending = deferred();
    vi.mocked(fetch).mockReturnValueOnce(pending.promise);
    const main = reader({ rootCid: "root", readingFirst: true, client: cache });
    main.render();
    main.click("Edit description");
    main.render();
    main.edit("my draft");
    main.render();
    const nested = reader({ rootCid: "root", client: cache });
    nested.render();
    cache.saved(ctx, value("external", 2));
    expect(main.render()).toContain("my draft</textarea>");
    const older = deferred();
    vi.mocked(fetch).mockReturnValueOnce(older.promise);
    const oldRequest = cache.request(ctx);
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(value("my draft", 3)));
    main.submit();
    await flush();
    const putCall = vi
      .mocked(fetch)
      .mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(JSON.parse(String(putCall[1]?.body))).toEqual({
      text: "my draft",
      expectedVersion: 1,
    });
    expect(nested.render()).toContain("preview my draft");
    older.resolve(Response.json(value("external", 2)));
    pending.resolve(Response.json(value()));
    await oldRequest;
    await flush();
    expect(main.render()).toContain("preview my draft");
    expect(main.render()).not.toContain("<textarea");
  });

  it("keeps a conflicting draft and only discards it after explicit retry confirmation", async () => {
    const cache = client();
    cache.saved(ctx, value());
    const detail = reader({
      rootCid: "root",
      readingFirst: true,
      client: cache,
    });
    detail.render();
    await flush();
    detail.render();
    detail.click("Edit description");
    detail.render();
    detail.edit("draft");
    detail.render();
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ error: "Version conflict" }, { status: 409 }),
    );
    detail.submit();
    await flush();
    expect(detail.render()).toContain("draft</textarea>");
    expect(detail.render()).toContain("Version conflict");
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    detail.click("Retry description");
    expect(detail.render()).toContain("draft</textarea>");
    detail.click("Retry description");
    detail.render();
    await flush();
    expect(detail.render()).not.toContain("<textarea");
    expect(detail.render()).toContain("original");
  });

  it.each([401, 403, 404])(
    "withdraws cached protected content on HTTP %i",
    async (status) => {
      const cache = client();
      cache.saved(ctx, value());
      vi.mocked(fetch).mockResolvedValueOnce(
        Response.json({ error: "Denied" }, { status }),
      );
      const detail = reader({
        rootCid: "root",
        readingFirst: true,
        client: cache,
      });
      expect(detail.render()).toContain("preview original");
      await flush();
      const html = detail.render();
      expect(html).not.toContain("preview original");
      expect(html).toContain("Denied");
      expect(html).toContain("Retry description");
      expect(cache.cached(ctx)).toBeNull();
    },
  );

  it("retains displayed snapshots on background failure and actually retries the description request", async () => {
    const cache = client();
    cache.saved(ctx, value());
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ error: "Service unavailable" }, { status: 503 }),
    );
    const detail = reader({
      rootCid: "root",
      readingFirst: true,
      client: cache,
    });
    detail.render();
    await flush();
    expect(detail.render()).toContain("preview original");
    expect(detail.render()).toContain("Service unavailable");
    detail.click("Retry description");
    detail.render();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(detail.render()).not.toContain("Service unavailable");
  });

  it("retains a displayed oversize response on failure even though it was intentionally not cached", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cache = client();
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json(value("x".repeat(65536))),
    );
    const detail = reader({
      rootCid: "root",
      readingFirst: true,
      client: cache,
    });
    detail.render();
    await flush();
    expect(detail.render()).toContain("preview " + "x".repeat(100));
    expect(cache.cached(ctx)).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "Node description exceeds the session cache entry budget",
    );
    vi.mocked(fetch).mockRejectedValueOnce(new Error("offline"));
    await expect(cache.request(ctx)).rejects.toThrow("offline");
    expect(detail.render()).toContain("preview " + "x".repeat(100));
    expect(detail.render()).toContain("offline");
  });

  it("revokes stale stable descriptors on pending and failed responses but not published snapshots", async () => {
    const previews = new PreviewClient("a");
    const invalidate = vi.spyOn(previews, "invalidate").mockResolvedValue();
    const cache = client("a", previews);
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(pendingValue()));
    await cache.request(ctx);
    expect(invalidate).toHaveBeenCalledExactlyOnceWith("root");
    cache.saved(ctx, pendingValue(true));
    expect(invalidate).toHaveBeenCalledTimes(2);
    const published = { ...ctx, publicationId: "pub", revision: 1 };
    cache.saved(published, pendingValue());
    expect(invalidate).toHaveBeenCalledTimes(2);
    previews.dispose();
  });

  it("stops polling as soon as a pending preview becomes ready", async () => {
    const cache = client();
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json(pendingValue()))
      .mockResolvedValueOnce(Response.json(value("ready")));
    const detail = reader({
      rootCid: "root",
      readingFirst: true,
      client: cache,
    });
    detail.render();
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    expect(detail.render()).toContain("preview ready");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    "polls cached pending/failed states at the existing interval and stops at 24 attempts: failed=%s",
    async (failed) => {
      const cache = client();
      cache.saved(ctx, pendingValue(failed));
      vi.mocked(fetch).mockImplementation(() =>
        Promise.resolve(Response.json(pendingValue(failed))),
      );
      const detail = reader({
        rootCid: "root",
        readingFirst: true,
        client: cache,
      });
      detail.render();
      await flush();
      const delay = failed ? 30000 : 2000;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(delay * 30);
      expect(fetch).toHaveBeenCalledTimes(24);
      expect(vi.getTimerCount()).toBe(0);
      detail.render();
      detail.click("Retry preview");
      detail.render();
      await flush();
      expect(fetch).toHaveBeenCalledTimes(25);
      detail.close();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("clears descriptions and returns successful clear responses to all readers", async () => {
    const cache = client();
    cache.saved(ctx, value());
    const detail = reader({
      rootCid: "root",
      readingFirst: true,
      client: cache,
    });
    detail.render();
    await flush();
    detail.render();
    detail.click("Edit description");
    detail.render();
    const cleared = {
      ...value("", 2),
      description: {
        ...value("", 2).description,
        user: { text: null, version: 2 },
      },
    };
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(cleared));
    detail.click("Clear description");
    await flush();
    expect(detail.render()).toContain("No private description.");
    expect(cache.cached(ctx)?.description.user).toEqual({
      text: null,
      version: 2,
    });
  });

  it("synchronizes edits from advanced readers only to the matching root and node", async () => {
    const cache = client();
    cache.saved(ctx, value());
    const main = reader({ rootCid: "root", readingFirst: true, client: cache });
    const advanced = reader({ rootCid: "root", client: cache });
    main.render();
    advanced.render();
    await flush();
    advanced.render();
    advanced.click("Edit description");
    advanced.render();
    advanced.edit("advanced edit");
    advanced.render();
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json(value("advanced edit", 2)),
    );
    const saveForm = advanced.find(
      (node) =>
        node.type === "form" &&
        Array.isArray(node.props.children) &&
        node.props.children.some(
          (child) =>
            isValidElement<Record<string, unknown>>(child) &&
            child.type === "button" &&
            child.props.children === "Save description",
        ),
    );
    (saveForm.props.onSubmit as (event: unknown) => void)({
      preventDefault() {},
    });
    await flush();
    expect(main.render()).toContain("preview advanced edit");
    const input = advanced.find((node) => node.type === "input");
    (input.props.onChange as (event: unknown) => void)({
      target: { value: "child" },
    });
    advanced.render();
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json(value("child only", 1, { ...ctx, nodeCid: "child" })),
    );
    advanced.submit();
    expect(advanced.render()).not.toContain("preview advanced edit");
    await flush();
    expect(advanced.render()).toContain("preview child only");
    expect(main.render()).toContain("preview advanced edit");
  });
});
