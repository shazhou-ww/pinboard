import { HTTPException } from "hono/http-exception";
import type { Bindings } from "./env.js";
import { requireScope, type Principal } from "./identity.js";
import {
  completeDag,
  importFile,
  key,
  MAX_UPLOAD,
  parseCid,
  readCar,
  type Dag,
  verifyBlock,
} from "./content.js";
import { readBlock, storeDag, writeGuard } from "./storage.js";
import { itemFilterSchema, nameSchema, validate } from "./schemas.js";
import { matchesItemFilter } from "./item-filter.js";
import {
  previewBatchLimit,
  type Pin,
  type PreviewBatchResponse,
} from "@shazhou/pinboard-contracts";
import {
  enqueuePreview,
  getPreviews,
  previewLog,
  processPreview,
  refreshPreviewReferences,
} from "./previews.js";

interface ExistingThumbnail {
  cid: string;
  width: number;
  height: number;
}

export class PinService {
  constructor(
    private readonly env: Bindings,
    private readonly principal: Principal,
    private readonly schedule?: (work: Promise<void>) => void,
  ) {}

  async list(
    cursor?: string,
    query = "",
  ): Promise<{ pins: Pin[]; nextCursor: string | null }> {
    requireScope(this.principal, "pins:read");
    validate(itemFilterSchema, query);
    const filtered = query.trim().length > 0;
    const result = await this.env.DB.prepare(
      `SELECT cid, name, size, blocks, created_at AS createdAt${filtered ? ", (SELECT text FROM node_descriptions n WHERE n.account_id = pins.account_id AND n.root_cid = pins.cid AND n.node_cid = pins.cid) AS rootDescription" : ""} FROM pins WHERE account_id = ? AND cid > ? AND NOT EXISTS (SELECT 1 FROM deleted_pins d WHERE d.account_id = pins.account_id AND d.cid = pins.cid) ORDER BY cid${filtered ? "" : " LIMIT 51"}`,
    )
      .bind(this.principal.accountId, cursor ?? "")
      .all<Pin & { rootDescription?: string | null }>();
    const matches = filtered
      ? result.results.filter((pin) =>
          matchesItemFilter(query, pin.name, pin.rootDescription ?? null),
        )
      : result.results;
    const pins = matches.slice(0, 50).map((pin) => ({
      cid: pin.cid,
      name: pin.name,
      size: pin.size,
      blocks: pin.blocks,
      createdAt: pin.createdAt,
    }));
    return {
      pins,
      nextCursor: matches.length > 50 ? pins.at(-1)!.cid : null,
    };
  }

  async detail(cid: string): Promise<Pin> {
    requireScope(this.principal, "pins:read");
    const pin = await this.env.DB.prepare(
      "SELECT cid, name, size, blocks, created_at AS createdAt FROM pins WHERE account_id = ? AND cid = ? AND NOT EXISTS (SELECT 1 FROM deleted_pins d WHERE d.account_id = pins.account_id AND d.cid = pins.cid)",
    )
      .bind(this.principal.accountId, key(parseCid(cid)))
      .first<Pin>();
    if (!pin)
      throw new HTTPException(404, {
        message: "Pin not found in your account",
      });
    return pin;
  }

  async previews(cids: readonly string[]): Promise<PreviewBatchResponse> {
    requireScope(this.principal, "pins:read");
    if (!cids.length || cids.length > previewBatchLimit)
      throw new HTTPException(400, {
        message: "Expected 1 to 32 preview CIDs",
      });
    const unique = [...new Set(cids.map((cid) => key(parseCid(cid))))];
    const owned = await this.env.DB.prepare(
      `SELECT cid FROM pins WHERE account_id = ? AND NOT EXISTS (SELECT 1 FROM deleted_pins d WHERE d.account_id = pins.account_id AND d.cid = pins.cid) AND cid IN (${unique.map(() => "?").join(",")})`,
    )
      .bind(this.principal.accountId, ...unique)
      .all<{ cid: string }>();
    const previews = await getPreviews(
      this.env,
      owned.results.map((pin) => pin.cid),
    );
    return {
      previews: unique.map((cid) => {
        const preview = previews.get(cid);
        return preview
          ? { cid, preview }
          : {
              cid,
              error: { status: 404, message: "Pin not found in your account" },
            };
      }),
    };
  }

  async upload(
    bytes: Uint8Array,
    kind: "file" | "car" | "block",
    name: string,
    cid?: string,
  ): Promise<Pin> {
    requireScope(this.principal, "pins:write");
    validate(nameSchema, name);
    if (bytes.length > MAX_UPLOAD)
      throw new HTTPException(413, { message: "Upload exceeds 32 MiB" });
    let dag: Dag;
    if (kind === "car") {
      dag = await readCar(bytes);
    } else if (kind === "file") {
      dag = await importFile(bytes);
    } else {
      if (!cid)
        throw new HTTPException(400, {
          message: "Block upload requires a CID",
        });
      const root = parseCid(cid);
      await verifyBlock(root, bytes);
      dag = await completeDag(root, async (link) =>
        key(link) === key(root) ? bytes : this.readBlock(link.toString()),
      );
    }
    const images = await this.existingThumbnails([...dag.blocks.keys()]);
    const objectKey = await storeDag(this.env, dag);
    return this.save(dag, name, objectKey, images);
  }

  async pin(cid: string, name: string): Promise<Pin> {
    requireScope(this.principal, "pins:write");
    validate(nameSchema, name);
    const root = key(parseCid(cid));
    const images = new Map(
      (await this.existingThumbnails([root], root)).map((image) => [
        image.cid,
        image,
      ]),
    );
    const dag = await completeDag(parseCid(cid), (link) =>
      this.readBlock(link.toString()),
    );
    for (const image of await this.existingThumbnails([...dag.blocks.keys()]))
      images.set(image.cid, image);
    const objectKey = await storeDag(this.env, dag);
    return this.save(dag, name, objectKey, [...images.values()]);
  }

  async unpin(cid: string): Promise<void> {
    requireScope(this.principal, "pins:delete");
    const root = key(parseCid(cid));
    const now = new Date();
    const pin = await this.env.DB.prepare(
      "SELECT cid FROM pins WHERE account_id = ? AND cid = ?",
    )
      .bind(this.principal.accountId, root)
      .first();
    if (!pin)
      throw new HTTPException(404, {
        message: "Pin not found in your account",
      });
    await this.env.DB.prepare(
      `INSERT OR IGNORE INTO deleted_pins (account_id, cid, deleted_at, expires_at)
      SELECT account_id, cid, ?, ? FROM pins WHERE account_id = ? AND cid = ?`,
    )
      .bind(
        now.toISOString(),
        new Date(now.getTime() + 30 * 86400000).toISOString(),
        this.principal.accountId,
        root,
      )
      .run();
  }

  async rename(cid: string, name: string): Promise<Pin> {
    requireScope(this.principal, "pins:write");
    const label = validate(nameSchema, name);
    const pin = await this.env.DB.prepare(
      "UPDATE pins SET name = ? WHERE account_id = ? AND cid = ? AND NOT EXISTS (SELECT 1 FROM deleted_pins d WHERE d.account_id = pins.account_id AND d.cid = pins.cid) RETURNING cid, name, size, blocks, created_at AS createdAt",
    )
      .bind(label, this.principal.accountId, key(parseCid(cid)))
      .first<Pin>();
    if (!pin)
      throw new HTTPException(404, {
        message: "Pin not found in your account",
      });
    return pin;
  }

  private async readBlock(cid: string): Promise<Uint8Array | undefined> {
    return readBlock(this.env, cid);
  }

  private async existingThumbnails(
    cids: string[],
    root?: string,
  ): Promise<ExistingThumbnail[]> {
    const rows = await this.env.DB.prepare(
      `SELECT cid, width, height FROM preview_images
       WHERE cid IN (SELECT value FROM json_each(?))
       OR cid IN (SELECT cid FROM dag_members WHERE root = ?)`,
    )
      .bind(JSON.stringify(cids), root ?? null)
      .all<ExistingThumbnail>();
    return rows.results;
  }

  private async save(
    dag: Dag,
    name: string,
    objectKey: string,
    images: ExistingThumbnail[],
  ): Promise<Pin> {
    const cid = key(dag.root);
    const results = await this.env.DB.batch([
      writeGuard(this.env.DB, objectKey, "ready"),
      this.env.DB.prepare(
        "INSERT INTO pins (account_id, cid, name, size, blocks) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id, cid) DO UPDATE SET name = excluded.name RETURNING cid, name, size, blocks, created_at AS createdAt",
      ).bind(this.principal.accountId, cid, name, dag.size, dag.blocks.size),
      this.env.DB.prepare(
        "UPDATE retained_blocks SET unreferenced_at = NULL WHERE cid IN (SELECT cid FROM dag_members WHERE root = ?)",
      ).bind(cid),
      this.env.DB.prepare(
        "UPDATE content_previews SET unreferenced_at = NULL WHERE source_cid = ?",
      ).bind(cid),
      this.env.DB.prepare(
        "DELETE FROM deleted_pins WHERE account_id = ? AND cid = ?",
      ).bind(this.principal.accountId, cid),
      ...images.flatMap((image) => {
        const bytes = dag.blocks.get(image.cid);
        return bytes
          ? [
              this.env.DB.prepare(
                "INSERT OR IGNORE INTO preview_images (cid, bytes, width, height) VALUES (?, ?, ?, ?)",
              ).bind(image.cid, bytes, image.width, image.height),
            ]
          : [];
      }),
      refreshPreviewReferences(this.env.DB, Date.now(), cid),
    ]);
    const result = results[1]!.results[0] as Pin | undefined;
    if (!result) throw new Error("Failed to save pin reference");
    try {
      await enqueuePreview(this.env, cid);
      if (this.schedule) this.schedule(processPreview(this.env, cid));
    } catch (error) {
      previewLog("preview_scheduling_failed", cid, error);
    }
    return result;
  }
}
