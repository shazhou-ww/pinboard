import type { NodeDescription } from "@shazhou/pinboard-contracts";
import { isContentPreview } from "@shazhou/pinboard-contracts";
import { ApiRequestError, previewEnabled } from "./api.js";
import { requestJson } from "./manager.js";
import type { PreviewClient } from "./preview-client.js";

export const descriptionCacheLimit = 128;
export const descriptionCacheBytes = 2 * 1024 * 1024;
export const descriptionEntryBytes = 64 * 1024;
export const descriptionRetentionMs = 60 * 60 * 1000;

export interface DescriptionContext {
  rootCid: string;
  nodeCid: string;
  publicationId?: string | undefined;
  revision?: number | undefined;
}
type Listener = (
  value: NodeDescription | null | undefined,
  error: string,
) => void;
interface Entry {
  value: NodeDescription | null;
  bytes: number;
  savedAt: number;
}
interface Request {
  controller: AbortController;
  promise: Promise<NodeDescription | null>;
}
let nextIdentity = 0;

export function descriptionPath(context: DescriptionContext) {
  const root = encodeURIComponent(context.rootCid);
  const node = encodeURIComponent(context.nodeCid);
  if (context.publicationId) {
    if (!Number.isSafeInteger(context.revision) || context.revision! <= 0)
      throw new Error("An explicit publication revision is required");
    return `/api/public/publications/${encodeURIComponent(context.publicationId)}/versions/${context.revision}/nodes/${node}/description`;
  }
  return `/api/pins/${root}/nodes/${node}/description`;
}

export function validateDescription(
  value: unknown,
  context: DescriptionContext,
) {
  const candidate = value as {
    rootCid?: unknown;
    nodeCid?: unknown;
    description?: {
      user?: { text?: unknown; version?: unknown };
      preview?: unknown;
    };
  } | null;
  if (
    candidate?.rootCid !== context.rootCid ||
    candidate.nodeCid !== context.nodeCid ||
    !candidate.description?.user ||
    (candidate.description.user.text !== null &&
      typeof candidate.description.user.text !== "string") ||
    typeof candidate.description.user.version !== "number" ||
    !Number.isSafeInteger(candidate.description.user.version) ||
    candidate.description.user.version < 0 ||
    (context.publicationId !== undefined &&
      candidate.description.user.version !== context.revision) ||
    !isContentPreview(candidate.description.preview, previewEnabled)
  )
    throw new Error("Invalid node description response");
  return value as NodeDescription;
}

/** Owned by an account session or public page, never by a detail dialog. */
export class DescriptionClient {
  readonly identity = ++nextIdentity;
  private readonly memory = new Map<string, Entry>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly requests = new Map<string, Request>();
  private readonly mutations = new Map<string, AbortController>();
  private bytes = 0;
  private disposed = false;
  private owners = 0;
  private privateDenied = false;

  constructor(
    private readonly accountId?: string,
    readonly previews?: PreviewClient,
  ) {}

  private isDisposed() {
    return this.disposed;
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

  private key(context: DescriptionContext) {
    descriptionPath(context);
    return JSON.stringify([
      context.publicationId ? "public" : "private",
      context.publicationId ?? this.accountId,
      context.revision ?? null,
      context.rootCid,
      context.nodeCid,
    ]);
  }

  cached(context: DescriptionContext): NodeDescription | null {
    if (this.disposed) return null;
    const key = this.key(context);
    const entry = this.memory.get(key);
    if (!entry) return null;
    if (
      entry.savedAt > Date.now() ||
      Date.now() - entry.savedAt >= descriptionRetentionMs
    ) {
      this.forget(key);
      return null;
    }
    this.memory.delete(key);
    this.memory.set(key, entry);
    return entry.value;
  }

  subscribe(context: DescriptionContext, listener: Listener) {
    const key = this.key(context);
    const readers = this.listeners.get(key) ?? new Set<Listener>();
    readers.add(listener);
    this.listeners.set(key, readers);
    return () => {
      readers.delete(listener);
      if (!readers.size) this.listeners.delete(key);
    };
  }

  canUsePreview(context: DescriptionContext) {
    if (this.disposed || this.privateDenied || context.publicationId)
      return false;
    return (
      this.memory.get(this.key(context))?.value !== null &&
      this.memory.get(this.key({ ...context, nodeCid: context.rootCid }))
        ?.value !== null
    );
  }

  private forget(key: string) {
    this.bytes -= this.memory.get(key)?.bytes ?? 0;
    this.memory.delete(key);
  }

  private emit(
    key: string,
    value: NodeDescription | null | undefined,
    error = "",
  ) {
    for (const listener of this.listeners.get(key) ?? [])
      listener(value, error);
  }

  private remember(key: string, value: NodeDescription | null) {
    this.forget(key);
    const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
    if (bytes > descriptionEntryBytes) {
      console.warn("Node description exceeds the session cache entry budget");
      return;
    }
    this.memory.set(key, { value, bytes, savedAt: Date.now() });
    this.bytes += bytes;
    while (
      this.memory.size > descriptionCacheLimit ||
      this.bytes > descriptionCacheBytes
    )
      this.forget(this.memory.keys().next().value!);
  }

  private cancel(key: string) {
    this.requests.get(key)?.controller.abort();
    this.requests.delete(key);
  }

  private invalidate(key: string, error = "") {
    this.cancel(key);
    this.mutations.get(key)?.abort();
    this.mutations.delete(key);
    this.remember(key, null);
    this.emit(key, null, error);
  }

  private clearMatching(predicate: (parts: unknown[]) => boolean, error = "") {
    const keys = new Set([
      ...this.memory.keys(),
      ...this.requests.keys(),
      ...this.mutations.keys(),
      ...this.listeners.keys(),
    ]);
    for (const key of keys)
      if (predicate(JSON.parse(key) as unknown[])) this.invalidate(key, error);
  }

  invalidateRoot(rootCid: string) {
    this.clearMatching(
      (parts) => parts[0] === "private" && parts[3] === rootCid,
    );
    this.remember(this.key({ rootCid, nodeCid: rootCid }), null);
    void this.previews?.invalidate(rootCid);
  }

  invalidatePublication(id: string) {
    this.clearMatching((parts) => parts[0] === "public" && parts[1] === id);
  }

  failure(context: DescriptionContext, failure: unknown) {
    const key = this.key(context);
    const error = failure instanceof Error ? failure.message : String(failure);
    if (
      failure instanceof ApiRequestError &&
      [401, 403].includes(failure.status) &&
      !context.publicationId
    ) {
      this.privateDenied = true;
      this.clearMatching((parts) => parts[0] === "private", error);
    } else if (
      (failure instanceof ApiRequestError && failure.status === 404) ||
      failure instanceof SyntaxError ||
      (failure instanceof Error &&
        failure.message === "Invalid node description response")
    ) {
      this.invalidate(key, error);
    } else if (
      failure instanceof ApiRequestError &&
      [401, 403].includes(failure.status)
    ) {
      this.invalidate(key, error);
    } else this.emit(key, undefined, error);
  }

  request(context: DescriptionContext): Promise<NodeDescription | null> {
    if (this.disposed)
      return Promise.reject(
        new DOMException("Description client closed", "AbortError"),
      );
    const key = this.key(context);
    const existing = this.requests.get(key);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const request: Request = {
      controller,
      promise: Promise.resolve(null),
    };
    this.requests.set(key, request);
    request.promise = requestJson<NodeDescription>(descriptionPath(context), {
      signal: controller.signal,
    })
      .then((value) => {
        if (this.disposed || this.requests.get(key) !== request) return null;
        validateDescription(value, context);
        this.remember(key, value);
        this.emit(key, value);
        if (
          !context.publicationId &&
          ["pending", "failed"].includes(value.description.preview.status)
        )
          void this.previews?.invalidate(context.nodeCid);
        return value;
      })
      .catch((failure: unknown) => {
        if (this.disposed || this.requests.get(key) !== request) return null;
        this.failure(context, failure);
        throw failure;
      })
      .finally(() => {
        if (this.requests.get(key) === request) this.requests.delete(key);
      });
    return request.promise;
  }

  saved(context: DescriptionContext, value: NodeDescription) {
    if (this.disposed) return;
    validateDescription(value, context);
    const key = this.key(context);
    this.cancel(key);
    this.remember(key, value);
    this.emit(key, value);
    if (
      !context.publicationId &&
      ["pending", "failed"].includes(value.description.preview.status)
    )
      void this.previews?.invalidate(context.nodeCid);
  }

  async save(
    context: DescriptionContext,
    text: string | null,
    expectedVersion: number,
  ) {
    if (this.disposed) return null;
    const key = this.key(context);
    const controller = new AbortController();
    this.mutations.get(key)?.abort();
    this.mutations.set(key, controller);
    try {
      const value = await requestJson<NodeDescription>(
        descriptionPath(context),
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, expectedVersion }),
          signal: controller.signal,
        },
      );
      if (this.isDisposed() || this.mutations.get(key) !== controller)
        return null;
      this.saved(context, value);
      return value;
    } catch (failure) {
      if (this.isDisposed() || this.mutations.get(key) !== controller)
        return null;
      this.failure(context, failure);
      throw failure;
    } finally {
      if (this.mutations.get(key) === controller) this.mutations.delete(key);
    }
  }

  dispose() {
    this.disposed = true;
    this.clearMatching(() => true);
    this.memory.clear();
    this.bytes = 0;
    this.listeners.clear();
  }
}
