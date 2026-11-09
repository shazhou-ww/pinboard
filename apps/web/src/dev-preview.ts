import type { PreviewAsset } from "./dev-preview-data.js";
import {
  previewBatchLimit,
  normalizeItemFilter,
  type DeletedItem,
  type NodeDescription,
  type PublicationHistory,
} from "@shazhou/pinboard-contracts";

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

const privateRootDescription =
  "Optional user description in this read-only preview.";

function rootDescription(
  asset: PreviewAsset,
  text: string | null,
  version: number,
): NodeDescription {
  return {
    rootCid: asset.pin.cid,
    nodeCid: asset.pin.cid,
    description: { user: { text, version }, preview: asset.preview },
  };
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
  const histories = publicationFixtures(data);
  const query = normalizeItemFilter(
    new URL(path, location.origin).searchParams.get("q") ?? "",
  );
  const matches = (name: string, description = "") =>
    !query ||
    name.toLowerCase().includes(query) ||
    description.toLowerCase().includes(query);
  if (pathname === "/api/publications")
    return json({
      publications: histories
        .map((item) => item.publication)
        .filter((item) =>
          matches(item.title, item.current.descriptions?.[item.current.cid]),
        ),
      nextCursor: null,
    });
  if (pathname === "/api/recently-deleted") {
    const deleted: DeletedItem[] = [
      {
        kind: "pin",
        visibility: "private",
        id: data[0]!.pin.cid,
        title: "Archived coast study",
        deletedAt: "2026-11-01T10:00:00Z",
        expiresAt: "2026-12-01T10:00:00Z",
      },
      {
        kind: "publication",
        visibility: "public",
        id: "preview-deleted-publication",
        title: "Previous field notes",
        deletedAt: "2026-11-03T10:00:00Z",
        expiresAt: "2026-12-03T10:00:00Z",
      },
    ];
    const items = deleted.filter((item) =>
      matches(`${item.title} ${item.kind}`),
    );
    return json({
      items,
      nextCursor: null,
      total: deleted.length,
      matchedTotal: items.length,
    });
  }
  for (const history of histories) {
    const root = `/api/public/publications/${history.publication.id}`;
    if (
      pathname === root ||
      pathname === `/api/publications/${history.publication.id}`
    )
      return json(history.publication);
    if (pathname === `${root}/history`) return json(history);
    const preview = new RegExp(`^${root}/preview/([1-9]\\d*)$`).exec(pathname);
    if (preview) {
      const revision = history.revisions.find(
        (item) => item.revision === Number(preview[1]),
      );
      const asset = data.find((item) => item.pin.cid === revision?.cid);
      return asset
        ? json(asset.preview)
        : json({ error: "Revision not found" }, 404);
    }
    const node = new RegExp(
      `^${root}/versions/([1-9]\\d*)/nodes/([^/]+)/description$`,
    ).exec(pathname);
    if (node) {
      const revision = history.revisions.find(
        (item) => item.revision === Number(node[1]),
      );
      const asset = data.find((item) => item.pin.cid === revision?.cid);
      return revision && asset && node[2] === revision.cid
        ? json(
            rootDescription(
              asset,
              revision.descriptions?.[revision.cid] ?? null,
              revision.revision,
            ),
          )
        : json({ error: "Revision or reachable node not found" }, 404);
    }
    const version = new RegExp(`^${root}/versions/([1-9]\\d*)$`).exec(pathname);
    if (version) {
      const revision = history.revisions.find(
        (item) => item.revision === Number(version[1]),
      );
      return revision
        ? json({ publication: history.publication, revision })
        : json({ error: "Revision not found" }, 404);
    }
  }
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
    return json({
      pins: data
        .map((asset) => asset.pin)
        .filter((pin) => matches(pin.name, privateRootDescription)),
      nextCursor: null,
    });
  for (const asset of data) {
    if (
      pathname ===
      `/api/pins/${asset.pin.cid}/nodes/${asset.pin.cid}/description`
    )
      return json(rootDescription(asset, privateRootDescription, 1));
    if (pathname === `/api/pins/${asset.pin.cid}/descriptions`)
      return json({
        rootCid: asset.pin.cid,
        descriptions: { [asset.pin.cid]: privateRootDescription },
      });
    if (pathname === `/api/pins/${asset.pin.cid}/preview`)
      return json(asset.preview);
    if (pathname === `/api/pins/${asset.pin.cid}`) return json(asset.pin);
    if (pathname === `/api/public/${asset.pin.cid}/car`)
      return new Response(asset.car, {
        headers: { "content-type": "application/vnd.ipld.car" },
      });
  }

  function publicationFixtures(
    data: readonly PreviewAsset[],
  ): PublicationHistory[] {
    return [
      {
        id: "preview-publication-first",
        title: "Coast journal",
        current: 1,
        count: 1,
        asset: 0,
      },
      {
        id: "preview-publication-rollback",
        title: "Field notes, a continuing edition",
        current: 3,
        count: 5,
        asset: 3,
      },
      {
        id: "preview-publication-shared",
        title: "Another publication of the same coast",
        current: 2,
        count: 2,
        asset: 0,
      },
    ].map((fixture) => {
      const source = data[fixture.asset] ?? data[0]!;
      const revisions = Array.from({ length: fixture.count }, (_, index) => ({
        revision: index + 1,
        cid: source.pin.cid,
        size: source.pin.size,
        blocks: source.pin.blocks,
        createdAt: `2026-11-0${index + 1}T10:00:00Z`,
        descriptions: {
          [source.pin.cid]:
            `Published description for ${fixture.title}, v${index + 1}.`,
        },
      }));
      return {
        publication: {
          visibility:
            fixture.id === "preview-publication-first" ? "public" : "private",
          id: fixture.id,
          title: fixture.title,
          currentRevision: fixture.current,
          revisionCount: fixture.count,
          sequence: fixture.count + (fixture.current < fixture.count ? 1 : 0),
          createdAt: revisions[0]!.createdAt,
          updatedAt: revisions.at(-1)!.createdAt,
          current: revisions[fixture.current - 1]!,
        },
        revisions: [...revisions].reverse(),
        operations: revisions.map((revision) => ({
          sequence: revision.revision,
          revision: revision.revision,
          kind: "publish",
          createdAt: revision.createdAt,
        })),
      };
    });
  }
  return json(
    { error: "This API is unavailable in the local UI preview." },
    404,
  );
}
