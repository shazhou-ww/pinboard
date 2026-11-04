import type { Pin } from "@shazhou/pinboard-contracts";
import { CID } from "multiformats/cid";
import { CliError, usage } from "./errors.js";
import { maxCarBytes } from "./retrieval.js";

export function canonicalCid(value: string): string {
  try {
    return CID.parse(value).toV1().toString();
  } catch {
    return usage("A valid CID is required.");
  }
}

function pin(value: unknown): Pin {
  if (
    !value ||
    typeof value !== "object" ||
    !("cid" in value) ||
    typeof value.cid !== "string" ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !("size" in value) ||
    typeof value.size !== "number" ||
    !("blocks" in value) ||
    typeof value.blocks !== "number" ||
    !("createdAt" in value) ||
    typeof value.createdAt !== "string"
  )
    throw new CliError("INVALID_RESPONSE", "Server returned an invalid pin.");
  let cid: string;
  try {
    cid = CID.parse(value.cid).toV1().toString();
  } catch {
    throw new CliError("INVALID_RESPONSE", "Server returned an invalid CID.");
  }
  return {
    cid,
    name: value.name,
    size: value.size,
    blocks: value.blocks,
    createdAt: value.createdAt,
  };
}

export class Client {
  constructor(
    readonly origin: string,
    private readonly token: string | undefined,
    private readonly signal: AbortSignal,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async request(
    path: string,
    method = "GET",
    body?: Uint8Array<ArrayBuffer> | string,
    recovery?: string,
    binary = false,
  ): Promise<unknown> {
    const write = method !== "GET";
    let dispatched = false;
    try {
      this.signal.throwIfAborted();
      dispatched = true;
      const response = await this.fetcher(new URL(path, this.origin), {
        method,
        signal: this.signal,
        redirect: "manual",
        headers: {
          ...(!binary && this.token
            ? { Authorization: `Bearer ${this.token}` }
            : {}),
          ...(binary ? { Accept: "application/vnd.ipld.car" } : {}),
          ...(body !== undefined
            ? {
                "Content-Type":
                  typeof body === "string"
                    ? "application/json"
                    : "application/octet-stream",
                ...(typeof body === "string"
                  ? {}
                  : { "X-Pinboard-Public": "true" }),
              }
            : {}),
        },
        ...(body !== undefined ? { body } : {}),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const redirect = response.status >= 300 && response.status < 400;
        throw new CliError(
          redirect ? "REDIRECT_REFUSED" : "HTTP_ERROR",
          redirect
            ? "Credential-bearing redirects are refused."
            : `Pinboard HTTP request failed (${response.status}).`,
          1,
          write && (redirect || response.status >= 500),
          recovery,
          response.status,
        );
      }
      if (method === "DELETE") {
        await response.body?.cancel();
        return undefined;
      }
      if (!response.body) throw new Error("Missing body");
      const limit = binary ? maxCarBytes : 4 * 1024 * 1024;
      if (
        Number(response.headers.get("content-length")) > limit ||
        (binary &&
          response.headers.get("content-type")?.split(";")[0]?.trim() !==
            "application/vnd.ipld.car")
      ) {
        await response.body.cancel();
        throw new CliError(
          "INVALID_RESPONSE",
          "Server returned an oversized response or unexpected content type.",
        );
      }
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          total += item.value.length;
          if (total > limit)
            throw new CliError(
              "RESPONSE_LIMIT",
              "Server response exceeds the download limit.",
            );
          chunks.push(item.value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      const buffer = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.length;
      }
      if (binary) return buffer;
      const value = JSON.parse(new TextDecoder().decode(buffer)) as unknown;
      if (
        this.token &&
        JSON.stringify(value).includes(JSON.stringify(this.token).slice(1, -1))
      )
        throw new Error("Credential reflected in response");
      return value;
    } catch (error) {
      if (error instanceof CliError && error !== this.signal.reason)
        throw error;
      const cancelled = this.signal.aborted;
      const interrupted =
        cancelled &&
        this.signal.reason instanceof CliError &&
        this.signal.reason.exitCode === 130;
      throw new CliError(
        interrupted ? "INTERRUPTED" : cancelled ? "TIMEOUT" : "NETWORK_ERROR",
        cancelled
          ? "Request cancelled or timed out."
          : "Request failed or returned invalid data.",
        interrupted ? 130 : 1,
        write && dispatched,
        recovery,
      );
    }
  }

  async upload(
    bytes: Uint8Array<ArrayBuffer>,
    kind: "file" | "car",
    name: string,
    root?: string,
  ): Promise<Pin> {
    const recovery = root
      ? `Inspect ${root} before retrying; the write may already have completed.`
      : "Check the account list and upload name before retrying; the write may already have completed.";
    const value = await this.request(
      `/api/pins/upload?${new URLSearchParams({ kind, name }).toString()}`,
      "POST",
      bytes,
      recovery,
    );
    try {
      const result = pin(value);
      if (
        root !== undefined &&
        !CID.parse(result.cid).toV1().equals(CID.parse(root).toV1())
      )
        throw new Error("Upload root mismatch");
      return result;
    } catch {
      throw new CliError(
        "INVALID_RESPONSE",
        "Upload returned an invalid pin; outcome is uncertain.",
        1,
        true,
        recovery,
      );
    }
  }

  async list(
    cursor?: string,
    all = false,
  ): Promise<{ pins: Pin[]; nextCursor: string | null }> {
    const pins: Pin[] = [];
    const seen = new Set<string>();
    let next = cursor;
    for (let page = 0; page < 10000; page++) {
      if (next !== undefined) {
        if (seen.has(next))
          throw new CliError(
            "INVALID_RESPONSE",
            "Server repeated a pagination cursor; no partial list was emitted.",
          );
        seen.add(next);
      }
      const value = await this.request(
        `/api/pins${next === undefined ? "" : `?${new URLSearchParams({ cursor: next }).toString()}`}`,
      );
      if (
        !value ||
        typeof value !== "object" ||
        !("pins" in value) ||
        !Array.isArray(value.pins) ||
        !("nextCursor" in value) ||
        !(value.nextCursor === null || typeof value.nextCursor === "string")
      )
        throw new CliError(
          "INVALID_RESPONSE",
          "Server returned an invalid page; no partial list was emitted.",
        );
      pins.push(...value.pins.map(pin));
      if (!all || value.nextCursor === null)
        return { pins, nextCursor: value.nextCursor };
      next = value.nextCursor;
      if (pins.length > 1000000) break;
    }
    throw new CliError(
      "PAGINATION_LIMIT",
      "List exceeded the safety limit; use --cursor. No partial list was emitted.",
    );
  }

  async inspect(cid: string): Promise<Pin> {
    cid = canonicalCid(cid);
    const result = pin(await this.request(`/api/pins/${cid}`));
    if (result.cid !== cid)
      throw new CliError(
        "INVALID_RESPONSE",
        "Server returned a different pin CID.",
      );
    return result;
  }

  async rename(cid: string, name: string): Promise<Pin> {
    cid = canonicalCid(cid);
    name = name.trim();
    if (!name || name.length > 200)
      return usage("Pin names must contain 1-200 characters.");
    const recovery = `Inspect ${cid} before retrying; the rename may already have completed.`;
    const value = await this.request(
      `/api/pins/${cid}`,
      "PATCH",
      JSON.stringify({ name }),
      recovery,
    );
    try {
      const result = pin(value);
      if (result.cid !== cid || result.name !== name)
        throw new Error("Rename response mismatch");
      return result;
    } catch {
      throw new CliError(
        "INVALID_RESPONSE",
        "Rename returned an invalid pin; outcome is uncertain.",
        1,
        true,
        recovery,
      );
    }
  }

  async car(cid: string): Promise<Uint8Array<ArrayBuffer>> {
    const value = await this.request(
      `/api/public/${canonicalCid(cid)}/car`,
      "GET",
      undefined,
      undefined,
      true,
    );
    if (
      !(value instanceof Uint8Array) ||
      !(value.buffer instanceof ArrayBuffer)
    )
      throw new CliError(
        "INVALID_RESPONSE",
        "Server returned invalid CAR data.",
      );
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  async remove(cid: string): Promise<{ removed: true; cid: string }> {
    cid = canonicalCid(cid);
    await this.request(
      `/api/pins/${cid}`,
      "DELETE",
      undefined,
      `Inspect ${cid} before retrying; removal may already have completed.`,
    );
    return { removed: true, cid };
  }
}
