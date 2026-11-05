import type { PreviewAsset } from "./dev-preview-data.js";
import { previewBatchLimit } from "@shazhou/pinboard-contracts";

export const previewStorageKey = "pinboard:ui-preview";
let assets: Promise<readonly PreviewAsset[]> | undefined;

function active(): boolean {
  const value = sessionStorage.getItem(previewStorageKey);
  if (value !== null && value !== "read-only")
    throw new Error(
      "Invalid local preview state. Clear this tab's session storage.",
    );
  return value === "read-only";
}

function consumeTrigger(): boolean {
  if (location.hash !== "#preview") return false;
  sessionStorage.setItem(previewStorageKey, "read-only");
  history.replaceState(history.state, "", location.pathname + location.search);
  return true;
}

export function initializePreview(
  onError: (error: unknown) => void,
): () => void {
  consumeTrigger();
  const handleHash = () => {
    try {
      if (consumeTrigger()) location.reload();
    } catch (error) {
      onError(error);
    }
  };
  window.addEventListener("hashchange", handleHash);
  return () => {
    window.removeEventListener("hashchange", handleHash);
  };
}

export function leavePreview(): boolean {
  if (!active()) return false;
  sessionStorage.removeItem(previewStorageKey);
  return true;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export async function previewRequest(
  path: string,
  init?: RequestInit,
): Promise<Response | null> {
  if (!active() || !path.startsWith("/api/")) return null;
  init?.signal?.throwIfAborted();
  const pathname = new URL(path, location.origin).pathname;
  const method = (init?.method ?? "GET").toUpperCase();
  const batch = method === "POST" && pathname === "/api/pins/previews";
  if (method !== "GET" && !batch)
    return json(
      {
        error:
          "This is a read-only UI preview. Real uploads and account changes are disabled.",
      },
      405,
    );
  let cids: string[] | undefined;
  if (batch) {
    let input: unknown;
    try {
      input = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return json({ error: "Invalid preview batch JSON" }, 400);
    }
    if (
      !input ||
      typeof input !== "object" ||
      !("cids" in input) ||
      Object.keys(input).length !== 1 ||
      !Array.isArray(input.cids) ||
      input.cids.length < 1 ||
      input.cids.length > previewBatchLimit
    )
      return json({ error: "Expected 1 to 32 preview CIDs" }, 400);
    cids = [];
    for (const cid of input.cids as unknown[]) {
      if (typeof cid !== "string" || !cid.length || cid.length > 256)
        return json({ error: "Invalid preview CID" }, 400);
      if (!cids.includes(cid)) cids.push(cid);
    }
  }
  switch (pathname) {
    case "/api/bootstrap":
      return json({
        appName: "Pinboard",
        providers: [{ id: "google", label: "Google" }],
      });
    case "/api/auth/session":
      return json({
        user: { name: "UI preview (read-only)", email: "preview@example.test" },
      });
    case "/api/tokens":
      return json({ tokens: [] });
    case "/api/oauth/grants":
      return json({ grants: [] });
  }
  assets ??= import("./dev-preview-data.js").then(({ createPreviewAssets }) =>
    createPreviewAssets(),
  );
  const data = await assets;
  init?.signal?.throwIfAborted();
  if (cids)
    return json({
      previews: cids.map((cid) => {
        const asset = data.find((item) => item.pin.cid === cid);
        return asset
          ? { cid, preview: asset.preview }
          : {
              cid,
              error: { status: 404, message: "Pin not found in your account" },
            };
      }),
    });
  if (pathname === "/api/pins")
    return json({ pins: data.map((asset) => asset.pin), nextCursor: null });
  for (const asset of data) {
    if (pathname === `/api/pins/${asset.pin.cid}/preview`)
      return json(asset.preview);
    if (pathname === `/api/pins/${asset.pin.cid}`) return json(asset.pin);
    if (pathname === `/api/public/${asset.pin.cid}/car`)
      return new Response(asset.car, {
        headers: { "content-type": "application/vnd.ipld.car" },
      });
  }
  return json(
    { error: "This API is unavailable in the local UI preview." },
    404,
  );
}
