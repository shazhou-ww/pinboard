import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentPreview } from "@shazhou/pinboard-contracts";
import { PreviewClient } from "../src/preview-client.js";
import {
  previewCacheBytes,
  previewCacheLimit,
  previewFreshMs,
  previewRetentionMs,
  readCachedPreview,
  writeCachedPreviews,
  type CachedPreview,
} from "../src/preview-cache.js";

const ready = (
  version = 1,
): Extract<
  ContentPreview,
  { contentType: "text/plain" | "text/markdown" }
> => ({
  version,
  status: "ready",
  truncated: false,
  contentType: "text/markdown",
  content: `version ${version}`,
});
const clients: PreviewClient[] = [];
const client = (account = "account-a") => {
  const instance = new PreviewClient(account);
  clients.push(instance);
  return instance;
};
const key = (cid: string, account = "account-a") =>
  JSON.stringify([account, cid]);
const response = (cids: string[], preview: ContentPreview = ready()) =>
  Response.json({ previews: cids.map((cid) => ({ cid, preview })) });
const requestCids = (init?: RequestInit): string[] => {
  if (typeof init?.body !== "string")
    throw new Error("Expected JSON batch body");
  return (JSON.parse(init.body) as { cids: string[] }).cids;
};
const rows = async (): Promise<CachedPreview[]> => {
  const open = indexedDB.open("pinboard-preview-descriptions", 1);
  const db = await new Promise<IDBDatabase>((resolve) => {
    open.onsuccess = () => {
      resolve(open.result);
    };
  });
  try {
    return await new Promise((resolve) => {
      const request = db
        .transaction("descriptions")
        .objectStore("descriptions")
        .getAll();
      request.onsuccess = () => {
        resolve(request.result as CachedPreview[]);
      };
    });
  } finally {
    db.close();
  }
};

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init: RequestInit) =>
      Promise.resolve(response(requestCids(init))),
    ),
  );
});
afterEach(() => {
  for (const instance of clients.splice(0)) instance.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("account-scoped, bounded preview description cache", () => {
  it("coalesces duplicate in-flight CIDs and splits visible misses at the batch limit", async () => {
    const previews = client();
    const first = previews.request("cid-0");
    expect(previews.request("cid-0")).toBe(first);
    await Promise.all([
      first,
      ...Array.from({ length: 39 }, (_, i) => previews.request(`cid-${i + 1}`)),
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(fetch).mock.calls;
    expect(
      calls.map(([, init]) => requestCids(init).length).sort((a, b) => a - b),
    ).toEqual([8, 32]);
    expect(calls.every(([url]) => url === "/api/pins/previews")).toBe(true);
  });

  it("persists descriptions across clients but never shares them across accounts", async () => {
    await client().request("cid");
    expect(await client().cached("cid")).toEqual({
      preview: ready(),
      fresh: true,
    });
    expect(await client("account-b").cached("cid")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.key).toBe(key("cid"));
    expect(JSON.stringify(stored)).not.toMatch(/pinName|blob|Base64/);
  });

  it("returns stale data for immediate display and replaces it with the server's new version", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const previews = client();
    await previews.request("cid");
    vi.mocked(Date.now).mockReturnValue(now + previewFreshMs + 1);
    expect(await previews.cached("cid")).toEqual({
      preview: ready(),
      fresh: false,
    });
    vi.mocked(fetch).mockResolvedValueOnce(response(["cid"], ready(2)));
    await previews.request("cid");
    expect(await client().cached("cid")).toEqual({
      preview: ready(2),
      fresh: true,
    });
  });

  it.each(["pending", "failed"] as const)(
    "never persists %s states",
    async (status) => {
      vi.mocked(fetch).mockResolvedValueOnce(
        response(["cid"], { ...ready(), status }),
      );
      await client().request("cid");
      expect(await client().cached("cid")).toBeNull();
    },
  );

  it("refreshes unsupported descriptions after five minutes", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    vi.mocked(fetch).mockResolvedValueOnce(
      response(["cid"], {
        version: 1,
        status: "unsupported",
        truncated: false,
        contentType: "application/vnd.pinboard.file+json",
        content: {},
      }),
    );
    const previews = client();
    await previews.request("cid");
    vi.mocked(Date.now).mockReturnValue(now + 5 * 60 * 1000);
    expect((await previews.cached("cid"))?.fresh).toBe(false);
    vi.mocked(Date.now).mockReturnValue(now + previewRetentionMs);
    expect(await previews.cached("cid")).toBeNull();
    expect(await client().cached("cid")).toBeNull();
  });

  it("invalidates persisted data when authorization expires", async () => {
    const previews = client();
    await previews.request("cid");
    vi.mocked(fetch).mockResolvedValueOnce(new Response("", { status: 401 }));
    await expect(previews.request("cid")).rejects.toThrow("HTTP 401");
    expect(await client().cached("cid")).toBeNull();
  });

  it("reports per-CID denial without discarding other authorized results", async () => {
    const previews = client();
    await previews.request("missing");
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({
        previews: [
          {
            cid: "missing",
            error: { status: 404, message: "Pin not found in your account" },
          },
          { cid: "owned", preview: ready() },
        ],
      }),
    );
    const outcomes = await Promise.allSettled([
      previews.request("missing"),
      previews.request("owned"),
    ]);
    expect(outcomes.map((item) => item.status)).toEqual([
      "rejected",
      "fulfilled",
    ]);
    expect(await client().cached("missing")).toBeNull();
    expect((await client().cached("owned"))?.preview).toEqual(ready());
  });

  it("rejects malformed, duplicate or incomplete batch responses", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response(["wrong"]));
    await expect(client().request("cid")).rejects.toThrow(
      "Invalid or duplicate",
    );
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ previews: [] }));
    await expect(client().request("cid")).rejects.toThrow(
      "Invalid preview batch",
    );
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({
        previews: [
          { cid: "a", preview: ready() },
          { cid: "a", preview: ready() },
        ],
      }),
    );
    const previews = client();
    const result = await Promise.allSettled([
      previews.request("a"),
      previews.request("b"),
    ]);
    expect(result.every((item) => item.status === "rejected")).toBe(true);
  });

  it("surfaces unavailable IndexedDB and still uses normal authenticated requests", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const previews = client();
    expect(await previews.cached("cid")).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("Preview persistence unavailable"),
      expect.anything(),
    );
    await previews.request("cid");
    expect((await previews.cached("cid"))?.preview).toEqual(ready());
  });

  it("survives StrictMode's immediate effect cleanup/setup but closes on actual unmount", async () => {
    const previews = client();
    const firstRelease = previews.attach();
    firstRelease();
    const release = previews.attach();
    await Promise.resolve();
    await previews.request("cid");
    release();
    await Promise.resolve();
    await expect(previews.request("next")).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("does not publish late responses after the account client is disposed", async () => {
    let finish!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const previews = client();
    const pending = previews.request("cid");
    await new Promise((resolve) => setTimeout(resolve, 25));
    previews.dispose();
    finish(response(["cid"]));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(await client().cached("cid")).toBeNull();
  });

  it("bounds persisted entry count with least-recently-used eviction", async () => {
    const now = Date.now();
    const records = Array.from({ length: 510 }, (_, i) => ({
      key: key(String(i)),
      preview: ready(),
      savedAt: now,
      accessedAt: now + i,
      bytes: new TextEncoder().encode(JSON.stringify(ready())).length,
    }));
    await writeCachedPreviews(records);
    expect(await rows()).toHaveLength(previewCacheLimit);
    expect(await readCachedPreview(key("0"))).toBeNull();
    expect(await readCachedPreview(key("509"))).not.toBeNull();
  });

  it("enforces the JSON payload byte budget independently of the entry count", async () => {
    const now = Date.now();
    const records = Array.from({ length: 200 }, (_, i) => {
      const preview = { ...ready(), content: "x".repeat(14000) };
      return {
        key: key(String(i)),
        preview,
        savedAt: now,
        accessedAt: now + i,
        bytes: new TextEncoder().encode(JSON.stringify(preview)).length,
      };
    });
    await writeCachedPreviews(records);
    const stored = await rows();
    expect(stored.length).toBeLessThan(200);
    expect(stored.reduce((sum, row) => sum + row.bytes, 0)).toBeLessThanOrEqual(
      previewCacheBytes,
    );
    expect(await readCachedPreview(key("199"))).not.toBeNull();
  });

  it("does not cache oversized descriptions and discards corrupt persisted payloads", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      response(["large"], {
        ...ready(),
        content: "x".repeat(20000),
      }),
    );
    await client().request("large");
    expect(await client().cached("large")).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("exceeds the local cache entry budget"),
    );
    await writeCachedPreviews([
      {
        key: key("corrupt"),
        preview: ready(),
        savedAt: Date.now(),
        accessedAt: Date.now(),
        bytes: 1,
      },
    ]);
    expect(await client().cached("corrupt")).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("Discarding invalid"),
    );
  });
});
