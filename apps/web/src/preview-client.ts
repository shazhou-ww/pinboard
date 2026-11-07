import {
  previewBatchLimit,
  type ContentPreview,
} from "@shazhou/pinboard-contracts";
import {
  deleteCachedPreview,
  isContentPreview,
  isFresh,
  previewEntryBytes,
  readCachedPreview,
  writeCachedPreviews,
  previewRetentionMs,
  type CachedPreview,
} from "./preview-cache.js";
import { apiFetch, previewEnabled } from "./api.js";

export class PreviewRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

interface Waiting {
  resolve: (preview: ContentPreview) => void;
  reject: (error: unknown) => void;
}

export class PreviewClient {
  private readonly memory = new Map<string, CachedPreview>();
  private readonly waiting = new Map<string, Waiting>();
  private readonly requests = new Map<string, Promise<ContentPreview>>();
  private readonly controllers = new Set<AbortController>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private persistent: boolean;
  private owners = 0;

  constructor(private readonly accountId?: string) {
    this.persistent = !!accountId;
  }

  attach() {
    this.owners++;
    return () => {
      this.owners--;
      queueMicrotask(() => {
        if (!this.owners) this.dispose();
      });
    };
  }

  private key(cid: string) {
    return JSON.stringify([this.accountId, cid]);
  }

  private isDisposed() {
    return this.disposed;
  }

  private storageFailure(error: unknown) {
    console.warn(
      "Preview persistence unavailable; using memory and authenticated requests",
      error,
    );
    this.persistent = false;
  }

  async cached(
    cid: string,
  ): Promise<{ preview: ContentPreview; fresh: boolean } | null> {
    if (this.disposed) return null;
    let entry = this.memory.get(cid);
    if (!entry && this.persistent) {
      try {
        entry = (await readCachedPreview(this.key(cid))) ?? undefined;
      } catch (error) {
        this.storageFailure(error);
      }
    }
    if (!entry || this.isDisposed()) return null;
    if (
      entry.savedAt > Date.now() ||
      Date.now() - entry.savedAt >= previewRetentionMs
    ) {
      await this.invalidate(cid);
      return null;
    }
    this.remember(cid, entry);
    return { preview: entry.preview, fresh: isFresh(entry) };
  }

  private remember(cid: string, entry: CachedPreview) {
    this.memory.delete(cid);
    this.memory.set(cid, entry);
    if (this.memory.size > 128)
      this.memory.delete(this.memory.keys().next().value!);
  }

  request(cid: string): Promise<ContentPreview> {
    if (this.disposed)
      return Promise.reject(
        new DOMException("Preview client closed", "AbortError"),
      );
    const existing = this.requests.get(cid);
    if (existing) return existing;
    const request = new Promise<ContentPreview>((resolve, reject) => {
      this.waiting.set(cid, { resolve, reject });
    });
    this.requests.set(cid, request);
    if (this.timer === undefined)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, 16);
    return request;
  }

  private async flush(): Promise<void> {
    const batch = [...this.waiting.entries()].slice(0, previewBatchLimit);
    for (const [cid] of batch) this.waiting.delete(cid);
    if (this.waiting.size && this.timer === undefined)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, 16);
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      const response = await apiFetch("/api/pins/previews", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cids: batch.map(([cid]) => cid) }),
        signal: controller.signal,
      });
      if (!response.ok)
        throw new PreviewRequestError(
          `Preview batch unavailable (HTTP ${response.status})`,
          response.status,
        );
      const body: unknown = await response.json();
      if (
        !body ||
        typeof body !== "object" ||
        !("previews" in body) ||
        !Array.isArray(body.previews) ||
        body.previews.length !== batch.length
      )
        throw new Error("Invalid preview batch response");
      const results = new Map<string, ContentPreview | PreviewRequestError>();
      const expected = new Set(batch.map(([cid]) => cid));
      for (const item of body.previews as unknown[]) {
        if (
          !item ||
          typeof item !== "object" ||
          !("cid" in item) ||
          typeof item.cid !== "string" ||
          !expected.delete(item.cid)
        )
          throw new Error("Invalid or duplicate preview batch CID");
        if ("preview" in item && isContentPreview(item.preview, previewEnabled))
          results.set(item.cid, item.preview);
        else if (
          "error" in item &&
          item.error &&
          typeof item.error === "object" &&
          "status" in item.error &&
          item.error.status === 404 &&
          "message" in item.error &&
          typeof item.error.message === "string"
        )
          results.set(
            item.cid,
            new PreviewRequestError(item.error.message, 404),
          );
        else throw new Error("Invalid preview batch item");
      }
      if (this.isDisposed())
        throw new DOMException("Preview client closed", "AbortError");
      const updates: CachedPreview[] = [];
      for (const [cid, result] of results) {
        if (result instanceof Error) {
          await this.invalidate(cid);
        } else if (result.status === "pending" || result.status === "failed") {
          await this.invalidate(cid);
        } else {
          const bytes = new TextEncoder().encode(JSON.stringify(result)).length;
          if (bytes <= previewEntryBytes) {
            const entry = {
              key: this.key(cid),
              preview: result,
              savedAt: Date.now(),
              accessedAt: Date.now(),
              bytes,
            };
            this.remember(cid, entry);
            if (
              result.preview?.kind !== "image" ||
              !result.preview.image.url.startsWith("blob:")
            )
              updates.push(entry);
          } else
            console.warn(
              "Preview description exceeds the local cache entry budget",
            );
        }
      }
      if (this.persistent && updates.length) {
        try {
          await writeCachedPreviews(updates);
        } catch (error) {
          this.storageFailure(error);
        }
      }
      if (this.disposed)
        throw new DOMException("Preview client closed", "AbortError");
      for (const [cid, waiter] of batch) {
        const result = results.get(cid)!;
        if (result instanceof Error) waiter.reject(result);
        else waiter.resolve(result);
      }
    } catch (error) {
      if (
        error instanceof PreviewRequestError &&
        [401, 403, 404].includes(error.status)
      )
        for (const [cid] of batch) await this.invalidate(cid);
      for (const [, waiter] of batch) waiter.reject(error);
    } finally {
      this.controllers.delete(controller);
      for (const [cid] of batch) this.requests.delete(cid);
    }
  }

  private async invalidate(cid: string) {
    this.memory.delete(cid);
    if (this.persistent) {
      try {
        await deleteCachedPreview(this.key(cid));
      } catch (error) {
        this.storageFailure(error);
      }
    }
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    for (const controller of this.controllers) controller.abort();
    for (const [, waiter] of this.waiting)
      waiter.reject(new DOMException("Preview client closed", "AbortError"));
    this.waiting.clear();
    this.requests.clear();
    this.memory.clear();
  }
}
