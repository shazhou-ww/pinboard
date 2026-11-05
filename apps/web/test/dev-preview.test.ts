import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const demo = vi.hoisted(() => {
  const pin = {
    cid: "bafkreia5ncapmfbrvhm3477lwtbhwrffqpujnsx7cfihnmbu3wcipu326u",
    name: "demo.png",
    size: 3,
    blocks: 1,
    createdAt: "2026-01-01T00:00:00Z",
  };
  const preview = {
    version: 1,
    status: "ready",
    truncated: false,
    contentType: "image/webp",
    content: {
      cid: "thumbnail",
      url: "/ipfs/thumbnail",
      width: 480,
      height: 320,
    },
  } as const;
  return {
    pin,
    preview,
    createPreviewAssets: vi.fn(() =>
      Promise.resolve([{ pin, preview, car: new Uint8Array([1, 2, 3]) }]),
    ),
  };
});

vi.mock("../src/dev-preview-data.js", () => ({
  createPreviewAssets: demo.createPreviewAssets,
}));

const key = "pinboard:ui-preview";
let url: URL;
let stored: Map<string, string>;
let events: EventTarget;
const cleanup: (() => void)[] = [];
const reload = vi.fn();
const replaceState =
  vi.fn<(_state: unknown, title: string, target: string) => void>();
const setItem = vi.fn<(name: string, value: string) => void>();

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("DEV", true);
  vi.stubEnv("VITE_UI_PREVIEW", "true");
  url = new URL("http://127.0.0.1:5178/");
  stored = new Map();
  events = new EventTarget();
  vi.stubGlobal("window", events);
  vi.stubGlobal("location", {
    get hostname() {
      return url.hostname;
    },
    get origin() {
      return url.origin;
    },
    get pathname() {
      return url.pathname;
    },
    get search() {
      return url.search;
    },
    get hash() {
      return url.hash;
    },
    reload,
  });
  replaceState.mockImplementation((_state, _title, target) => {
    url = new URL(target, url);
  });
  vi.stubGlobal("history", {
    state: { existing: "state" },
    replaceState,
  });
  setItem.mockImplementation((name, value) => {
    stored.set(name, value);
  });
  vi.stubGlobal("sessionStorage", {
    getItem: vi.fn((name: string) => stored.get(name) ?? null),
    setItem,
    removeItem: vi.fn((name: string) => {
      stored.delete(name);
    }),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(Response.json({ realApi: true }))),
  );
});

afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("one-shot local UI preview", () => {
  it("consumes the hash before returning to the same route and query", async () => {
    url = new URL("http://127.0.0.1:5178/share/example?sort=recent#preview");
    const { initializePreview } = await import("../src/dev-preview.js");
    cleanup.push(initializePreview(vi.fn()));
    expect(stored.get(key)).toBe("read-only");
    expect(url.href).toBe("http://127.0.0.1:5178/share/example?sort=recent");
    expect(replaceState).toHaveBeenCalledWith(
      { existing: "state" },
      "",
      "/share/example?sort=recent",
    );
    expect(reload).not.toHaveBeenCalled();
  });

  it("preserves unrelated fragments and real API requests", async () => {
    url.hash = "#signin";
    const { initializePreview } = await import("../src/dev-preview.js");
    cleanup.push(initializePreview(vi.fn()));
    const { apiFetch } = await import("../src/api.js");
    const init = { headers: { accept: "application/json" } };
    expect(await (await apiFetch("/api/auth/session", init)).json()).toEqual({
      realApi: true,
    });
    expect(fetch).toHaveBeenCalledWith("/api/auth/session", init);
    expect(url.hash).toBe("#signin");
    expect(stored.size).toBe(0);
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("keeps the active mode on refresh without another trigger", async () => {
    stored.set(key, "read-only");
    const { initializePreview } = await import("../src/dev-preview.js");
    cleanup.push(initializePreview(vi.fn()));
    const { apiFetch } = await import("../src/api.js");
    expect(await (await apiFetch("/api/auth/session")).json()).toMatchObject({
      user: { name: "UI preview (read-only)" },
    });
    expect(replaceState).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("consumes a later hash change once and reinitializes the normal route", async () => {
    const { initializePreview } = await import("../src/dev-preview.js");
    cleanup.push(initializePreview(vi.fn()));
    url.hash = "#preview";
    events.dispatchEvent(new Event("hashchange"));
    events.dispatchEvent(new Event("hashchange"));
    expect(url.hash).toBe("");
    expect(stored.get(key)).toBe("read-only");
    expect(reload).toHaveBeenCalledOnce();
  });

  it("exits only the local tab mode without calling real sign-out", async () => {
    stored.set(key, "read-only");
    const { leavePreviewMode, apiFetch } = await import("../src/api.js");
    expect(await leavePreviewMode()).toBe(true);
    expect(stored.has(key)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(await leavePreviewMode()).toBe(false);
    expect(await (await apiFetch("/api/auth/session")).json()).toEqual({
      realApi: true,
    });
  });

  it.each(["production", "disabled", "remote"])(
    "ignores the switch when %s",
    async (mode) => {
      stored.set(key, "read-only");
      url.hash = "#preview";
      if (mode === "production") vi.stubEnv("DEV", false);
      if (mode === "disabled") vi.stubEnv("VITE_UI_PREVIEW", "false");
      if (mode === "remote") url = new URL("https://example.test/#preview");
      const { previewEnabled, apiFetch, leavePreviewMode } =
        await import("../src/api.js");
      expect(previewEnabled).toBe(false);
      expect(await (await apiFetch("/api/auth/session")).json()).toEqual({
        realApi: true,
      });
      expect(await leavePreviewMode()).toBe(false);
      expect(url.hash).toBe("#preview");
      expect(demo.createPreviewAssets).not.toHaveBeenCalled();
    },
  );

  it("reports blocked storage without removing the trigger or falling through", async () => {
    url.hash = "#preview";
    setItem.mockImplementation(() => {
      throw new Error("Storage blocked");
    });
    const { initializePreview } = await import("../src/dev-preview.js");
    expect(() => initializePreview(vi.fn())).toThrow("Storage blocked");
    expect(url.hash).toBe("#preview");
    expect(replaceState).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("surfaces later trigger failures through the startup error handler", async () => {
    const onError = vi.fn();
    const { initializePreview } = await import("../src/dev-preview.js");
    cleanup.push(initializePreview(onError));
    setItem.mockImplementation(() => {
      throw new Error("Storage blocked");
    });
    url.hash = "#preview";
    events.dispatchEvent(new Event("hashchange"));
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Storage blocked" }),
    );
    expect(reload).not.toHaveBeenCalled();
  });

  it("rejects invalid stored state explicitly", async () => {
    stored.set(key, "invalid");
    const { apiFetch } = await import("../src/api.js");
    await expect(apiFetch("/api/pins")).rejects.toThrow(
      "Invalid local preview state",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["POST", "PATCH", "DELETE"])(
    "blocks %s before invoking any backend",
    async (method) => {
      stored.set(key, "read-only");
      const { apiFetch } = await import("../src/api.js");
      const response = await apiFetch("/api/pins/upload", {
        method,
        body: "test",
      });
      expect(response.status).toBe(405);
      expect(await response.json()).toHaveProperty(
        "error",
        expect.stringContaining("read-only"),
      );
      expect(fetch).not.toHaveBeenCalled();
      expect(demo.createPreviewAssets).not.toHaveBeenCalled();
    },
  );

  it("serves synthetic reads and CAR bytes, sharing one asset generation", async () => {
    stored.set(key, "read-only");
    const { apiFetch } = await import("../src/api.js");
    expect(await (await apiFetch("/api/bootstrap")).json()).toMatchObject({
      appName: "Pinboard",
    });
    expect(await (await apiFetch("/api/tokens?view=history")).json()).toEqual({
      tokens: [],
    });
    expect(await (await apiFetch("/api/oauth/grants")).json()).toEqual({
      grants: [],
    });
    expect(await (await apiFetch("/api/pins")).json()).toEqual({
      pins: [demo.pin],
      nextCursor: null,
    });
    expect(await (await apiFetch(`/api/pins/${demo.pin.cid}`)).json()).toEqual(
      demo.pin,
    );
    expect(
      await (await apiFetch(`/api/pins/${demo.pin.cid}/preview`)).json(),
    ).toEqual(demo.preview);
    const car = await apiFetch(`/api/public/${demo.pin.cid}/car`);
    expect(car.headers.get("content-type")).toBe("application/vnd.ipld.car");
    expect(new Uint8Array(await car.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(
      (
        await apiFetch(
          "/api/oauth/requests/12345678-1234-1234-1234-123456789abc",
        )
      ).status,
    ).toBe(404);
    expect(demo.createPreviewAssets).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("honors abort signals and passes non-API paths through", async () => {
    stored.set(key, "read-only");
    const { apiFetch } = await import("../src/api.js");
    const controller = new AbortController();
    controller.abort();
    await expect(
      apiFetch("/api/pins", { signal: controller.signal }),
    ).rejects.toThrow();
    expect(demo.createPreviewAssets).not.toHaveBeenCalled();
    expect(await (await apiFetch("/static/example")).json()).toEqual({
      realApi: true,
    });
  });
});
