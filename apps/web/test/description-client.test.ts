import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeDescription } from "@shazhou/pinboard-contracts";
import {
  DescriptionClient,
  descriptionCacheBytes,
  descriptionCacheLimit,
  descriptionEntryBytes,
  descriptionPath,
  descriptionRetentionMs,
  type DescriptionContext,
} from "../src/description-client.js";
import { ApiRequestError } from "../src/api.js";

const context = (rootCid = "root", nodeCid = "node"): DescriptionContext => ({
  rootCid,
  nodeCid,
});
const publicContext = (revision = 1, id = "publication") => ({
  ...context(),
  publicationId: id,
  revision,
});
const description = (
  ctx = context(),
  text = "private",
  version = ctx.revision ?? 1,
): NodeDescription => ({
  rootCid: ctx.rootCid,
  nodeCid: ctx.nodeCid,
  description: {
    user: { text, version },
    preview: {
      version: 1,
      status: "ready",
      contentType: "text/plain",
      truncated: false,
      preview: { kind: "markdown", text: "preview" },
    },
  },
});
const sized = (ctx: DescriptionContext, bytes: number) => {
  const empty = description(ctx, "");
  const overhead = new TextEncoder().encode(JSON.stringify(empty)).length;
  return description(ctx, "x".repeat(bytes - overhead));
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (value: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const clients: DescriptionClient[] = [];
const client = (account = "account") => {
  const value = new DescriptionClient(account);
  clients.push(value);
  return value;
};

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(Response.json(description()))),
  );
});
afterEach(() => {
  clients.splice(0).forEach((value) => {
    value.dispose();
  });
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("session-only full node description cache", () => {
  it("deduplicates simultaneous readers but revalidates every later open", async () => {
    const value = client();
    const pending = deferred<Response>();
    vi.mocked(fetch).mockReturnValueOnce(pending.promise);
    const first = value.request(context());
    expect(value.request(context())).toBe(first);
    pending.resolve(Response.json(description()));
    await first;
    expect(value.cached(context())).toEqual(description());
    await value.request(context());
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("isolates accounts, roots, nodes, publication IDs and explicit revisions", () => {
    const first = client("a");
    const second = client("b");
    const scopes = [
      context(),
      context("other"),
      context("root", "child"),
      publicContext(),
      publicContext(2),
      publicContext(1, "other"),
    ];
    scopes.forEach((ctx, index) => {
      first.saved(ctx, description(ctx, `scope ${index}`));
    });
    scopes.forEach((ctx, index) => {
      expect(first.cached(ctx)?.description.user.text).toBe(`scope ${index}`);
      expect(second.cached(ctx)).toBeNull();
    });
    expect(() =>
      descriptionPath({ ...context(), publicationId: "publication" }),
    ).toThrow("explicit publication revision");
    expect(() =>
      descriptionPath({ ...publicContext(), revision: 0 }),
    ).toThrow();
    expect(descriptionPath(context("a/b", "a ?"))).toBe(
      "/api/pins/a%2Fb/nodes/a%20%3F/description",
    );
  });

  it("shares successful PUT responses and prevents an older GET from replacing them", async () => {
    const value = client();
    const readerA = vi.fn();
    const readerB = vi.fn();
    value.subscribe(context(), readerA);
    value.subscribe(context(), readerB);
    const pending = deferred<Response>();
    vi.mocked(fetch)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(Response.json(description(context(), "saved", 2)));
    const old = value.request(context());
    const saved = await value.save(context(), "saved", 1);
    pending.resolve(Response.json(description()));
    expect(await old).toBeNull();
    expect(value.cached(context())).toEqual(saved);
    expect(readerA).toHaveBeenCalledExactlyOnceWith(saved, "");
    expect(readerB).toHaveBeenCalledExactlyOnceWith(saved, "");
    const body = vi.mocked(fetch).mock.calls[1]![1]?.body;
    if (typeof body !== "string") throw new Error("Missing PUT body");
    expect(JSON.parse(body)).toEqual({ text: "saved", expectedVersion: 1 });
  });

  it("does not cancel a shared GET when just one reader closes", async () => {
    const value = client();
    const reader = vi.fn();
    const closed = vi.fn();
    value.subscribe(context(), reader);
    const unsubscribe = value.subscribe(context(), closed);
    const pending = deferred<Response>();
    vi.mocked(fetch).mockReturnValueOnce(pending.promise);
    const request = value.request(context());
    unsubscribe();
    expect(vi.mocked(fetch).mock.calls[0]![1]?.signal?.aborted).toBe(false);
    pending.resolve(Response.json(description()));
    await request;
    expect(reader).toHaveBeenCalledOnce();
    expect(closed).not.toHaveBeenCalled();
  });

  it.each([401, 403])(
    "clears the whole private session on HTTP %i but not public snapshots",
    async (status) => {
      const value = client();
      const privateReader = vi.fn();
      value.subscribe(context("other"), privateReader);
      value.saved(context(), description());
      value.saved(context("other"), description(context("other")));
      value.saved(publicContext(), description(publicContext(), "public"));
      privateReader.mockClear();
      vi.mocked(fetch).mockResolvedValueOnce(
        Response.json({ error: "Denied" }, { status }),
      );
      await expect(value.request(context())).rejects.toThrow("Denied");
      expect(value.cached(context())).toBeNull();
      expect(value.cached(context("other"))).toBeNull();
      expect(privateReader).toHaveBeenCalledWith(null, "Denied");
      expect(value.cached(publicContext())?.description.user.text).toBe(
        "public",
      );
      expect(value.canUsePreview(context("new"))).toBe(false);
    },
  );

  it.each([context(), publicContext()])(
    "scopes 404 invalidation without deleting other roots or revisions: %j",
    async (ctx) => {
      const value = client();
      value.saved(ctx, description(ctx));
      value.saved(context("other"), description(context("other")));
      value.saved(publicContext(2), description(publicContext(2)));
      vi.mocked(fetch).mockResolvedValueOnce(
        Response.json({ error: "Gone" }, { status: 404 }),
      );
      await expect(value.request(ctx)).rejects.toThrow("Gone");
      expect(value.cached(ctx)).toBeNull();
      expect(value.cached(context("other"))).not.toBeNull();
      expect(value.cached(publicContext(2))).not.toBeNull();
      expect(value.canUsePreview(ctx)).toBe(false);
    },
  );

  it.each([500, 409])(
    "retains snapshots and reports refresh/save HTTP %i without extending TTL",
    async (status) => {
      vi.useFakeTimers();
      const value = client();
      value.saved(context(), description());
      const reader = vi.fn();
      value.subscribe(context(), reader);
      vi.advanceTimersByTime(descriptionRetentionMs - 1);
      vi.mocked(fetch).mockResolvedValueOnce(
        Response.json({ error: "Failure" }, { status }),
      );
      await expect(value.save(context(), "draft", 1)).rejects.toThrow(
        "Failure",
      );
      expect(value.cached(context())).not.toBeNull();
      expect(reader).toHaveBeenCalledWith(undefined, "Failure");
      vi.advanceTimersByTime(1);
      expect(value.cached(context())).toBeNull();
    },
  );

  it.each([
    { rootCid: "wrong" },
    { nodeCid: "wrong" },
    {
      description: {
        user: { text: 1, version: 1 },
        preview: description().description.preview,
      },
    },
    {
      description: {
        user: { text: "x", version: -1 },
        preview: description().description.preview,
      },
    },
    {
      description: {
        user: { text: "x", version: 1.5 },
        preview: description().description.preview,
      },
    },
    {
      description: {
        user: { text: "x", version: 1 },
        preview: { status: "invented" },
      },
    },
  ])(
    "rejects invalid response fields and clears unverifiable display: %j",
    async (patch) => {
      const value = client();
      value.saved(context(), description());
      vi.mocked(fetch).mockResolvedValueOnce(
        Response.json({ ...description(), ...patch }),
      );
      await expect(value.request(context())).rejects.toThrow(
        "Invalid node description response",
      );
      expect(value.cached(context())).toBeNull();
    },
  );

  it("rejects malformed JSON, preserves snapshots on network errors, and allows a real retry", async () => {
    const value = client();
    value.saved(context(), description());
    vi.mocked(fetch).mockRejectedValueOnce(new Error("offline"));
    await expect(value.request(context())).rejects.toThrow("offline");
    expect(value.cached(context())).not.toBeNull();
    vi.mocked(fetch).mockResolvedValueOnce(new Response("{"));
    await expect(value.request(context())).rejects.toBeInstanceOf(SyntaxError);
    expect(value.cached(context())).toBeNull();
    await value.request(context());
    expect(value.cached(context())).not.toBeNull();
  });

  it("rejects a published response from a different revision even when CIDs match", async () => {
    const value = client();
    const ctx = publicContext(2);
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json(description(ctx, "wrong revision", 1)),
    );
    await expect(value.request(ctx)).rejects.toThrow(
      "Invalid node description response",
    );
    expect(value.cached(ctx)).toBeNull();
  });

  it.each(["root", "publication", "dispose"] as const)(
    "invalidates %s, aborts pending GET and PUT, and rejects late resurrection",
    async (kind) => {
      const value = client();
      const ctx = kind === "publication" ? publicContext() : context();
      value.saved(ctx, description(ctx));
      value.saved(context("other"), description(context("other")));
      const pendingGet = deferred<Response>();
      const pendingPut = deferred<Response>();
      vi.mocked(fetch)
        .mockReturnValueOnce(pendingGet.promise)
        .mockReturnValueOnce(pendingPut.promise);
      const get = value.request(ctx);
      const put = value.save(ctx, "late", 1);
      if (kind === "root") value.invalidateRoot(ctx.rootCid);
      else if (kind === "publication")
        value.invalidatePublication(ctx.publicationId!);
      else value.dispose();
      for (const [, init] of vi.mocked(fetch).mock.calls)
        expect(init?.signal?.aborted).toBe(true);
      pendingGet.resolve(Response.json(description(ctx)));
      pendingPut.resolve(Response.json(description(ctx, "late", 2)));
      expect(await get).toBeNull();
      expect(await put).toBeNull();
      expect(value.cached(ctx)).toBeNull();
      expect(value.cached(context("other")) !== null).toBe(kind !== "dispose");
    },
  );

  it("handles StrictMode ownership replay then disposes on final session detach", async () => {
    const value = client();
    const detach = value.attach();
    detach();
    const last = value.attach();
    await Promise.resolve();
    value.saved(context(), description());
    expect(value.cached(context())).not.toBeNull();
    last();
    await Promise.resolve();
    expect(value.cached(context())).toBeNull();
    await expect(value.request(context())).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("uses exact 128-entry LRU including invalidation markers", () => {
    expect(descriptionCacheLimit).toBe(128);
    const value = client();
    for (let index = 0; index < 128; index++) {
      const ctx = context(String(index));
      value.saved(ctx, description(ctx));
    }
    expect(value.cached(context("0"))).not.toBeNull();
    value.saved(context("128"), description(context("128")));
    expect(value.cached(context("1"))).toBeNull();
    expect(value.cached(context("0"))).not.toBeNull();
    value.invalidateRoot("128");
    expect(value.canUsePreview(context("128"))).toBe(false);
  });

  it("accepts exactly 64 KiB, skips one extra UTF-8 byte with explicit warning, and still publishes oversize data", () => {
    expect(descriptionEntryBytes).toBe(65536);
    const value = client();
    const reader = vi.fn();
    value.subscribe(context(), reader);
    value.saved(context(), sized(context(), descriptionEntryBytes));
    expect(value.cached(context())).not.toBeNull();
    const extra = sized(context(), descriptionEntryBytes + 1);
    value.saved(context(), extra);
    expect(value.cached(context())).toBeNull();
    expect(reader).toHaveBeenLastCalledWith(extra, "");
    expect(console.warn).toHaveBeenCalledWith(
      "Node description exceeds the session cache entry budget",
    );
    const utf8 = sized(context(), descriptionEntryBytes);
    const multibyte = {
      ...utf8,
      description: {
        ...utf8.description,
        user: {
          ...utf8.description.user,
          text: utf8.description.user.text!.slice(1) + "中",
        },
      },
    };
    value.saved(context(), multibyte);
    expect(value.cached(context())).toBeNull();
  });

  it("keeps exactly 2 MiB, evicts LRU at one extra byte, and accounts for replacement sizes", () => {
    expect(descriptionCacheBytes).toBe(2097152);
    const value = client();
    for (let index = 0; index < 32; index++) {
      const ctx = context(String(index));
      value.saved(ctx, sized(ctx, descriptionEntryBytes));
    }
    expect(value.cached(context("0"))).not.toBeNull();
    value.saved(
      context("31"),
      sized(context("31"), descriptionEntryBytes - 512),
    );
    value.saved(context("extra"), sized(context("extra"), 513));
    expect(value.cached(context("1"))).toBeNull();
    expect(value.cached(context("0"))).not.toBeNull();
    // All entries survive at the exact aggregate boundary before overflow.
    const exact = client();
    for (let index = 0; index < 32; index++) {
      const ctx = context(String(index));
      exact.saved(ctx, sized(ctx, descriptionEntryBytes));
    }
    for (let index = 0; index < 32; index++)
      expect(exact.cached(context(String(index)))).not.toBeNull();
  });

  it("expires at exactly one hour, never extends retention on access, and rejects future timestamps", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10000000);
    expect(descriptionRetentionMs).toBe(3600000);
    const value = client();
    value.saved(context(), description());
    vi.advanceTimersByTime(descriptionRetentionMs - 1);
    expect(value.cached(context())).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(value.cached(context())).toBeNull();
    value.saved(context(), description());
    vi.setSystemTime(Date.now() - 1);
    expect(value.cached(context())).toBeNull();
  });

  it("does not treat 409 as authorization loss", () => {
    const value = client();
    value.saved(context(), description());
    value.failure(context(), new ApiRequestError("Conflict", 409));
    expect(value.cached(context())).not.toBeNull();
  });

  it.each([401, 403, 404])(
    "a scoped public HTTP %i also cancels a late outstanding mutation",
    async (status) => {
      const value = client();
      const ctx = publicContext();
      const pending = deferred<Response>();
      vi.mocked(fetch)
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValueOnce(Response.json({ error: "Denied" }, { status }));
      const mutation = value.save(ctx, "late", 1);
      await expect(value.request(ctx)).rejects.toThrow("Denied");
      expect(vi.mocked(fetch).mock.calls[0]![1]?.signal?.aborted).toBe(true);
      pending.resolve(Response.json(description(ctx, "late", 2)));
      expect(await mutation).toBeNull();
      expect(value.cached(ctx)).toBeNull();
    },
  );

  it("invalid schema also cancels a private mutation before its late response", async () => {
    const value = client();
    const pending = deferred<Response>();
    vi.mocked(fetch)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(
        Response.json({ ...description(), nodeCid: "wrong" }),
      );
    const mutation = value.save(context(), "late", 1);
    await expect(value.request(context())).rejects.toThrow(
      "Invalid node description response",
    );
    pending.resolve(Response.json(description(context(), "late", 2)));
    expect(await mutation).toBeNull();
    expect(value.cached(context())).toBeNull();
  });
});
