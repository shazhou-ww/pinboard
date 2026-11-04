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
import { nameSchema, validate } from "./schemas.js";
import type { Pin } from "@workspace/contracts";

export class PinService {
  constructor(
    private readonly env: Bindings,
    private readonly principal: Principal,
  ) {}

  async list(
    cursor?: string,
  ): Promise<{ pins: Pin[]; nextCursor: string | null }> {
    requireScope(this.principal, "pins:read");
    const result = await this.env.DB.prepare(
      "SELECT cid, name, size, blocks, created_at AS createdAt FROM pins WHERE account_id = ? AND cid > ? ORDER BY cid LIMIT 51",
    )
      .bind(this.principal.accountId, cursor ?? "")
      .all<Pin>();
    const pins = result.results.slice(0, 50);
    return {
      pins,
      nextCursor: result.results.length > 50 ? pins.at(-1)!.cid : null,
    };
  }

  async detail(cid: string): Promise<Pin> {
    requireScope(this.principal, "pins:read");
    const pin = await this.env.DB.prepare(
      "SELECT cid, name, size, blocks, created_at AS createdAt FROM pins WHERE account_id = ? AND cid = ?",
    )
      .bind(this.principal.accountId, key(parseCid(cid)))
      .first<Pin>();
    if (!pin)
      throw new HTTPException(404, {
        message: "Pin not found in your account",
      });
    return pin;
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
    const objectKey = await storeDag(this.env, dag);
    return this.save(dag, name, objectKey);
  }

  async pin(cid: string, name: string): Promise<Pin> {
    requireScope(this.principal, "pins:write");
    validate(nameSchema, name);
    const dag = await completeDag(parseCid(cid), (link) =>
      this.readBlock(link.toString()),
    );
    const objectKey = await storeDag(this.env, dag);
    return this.save(dag, name, objectKey);
  }

  async unpin(cid: string): Promise<void> {
    requireScope(this.principal, "pins:delete");
    const root = key(parseCid(cid));
    const now = new Date();
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        "UPDATE retention_state SET safe_after = max(safe_after, ?) WHERE id = 1 AND EXISTS (SELECT 1 FROM pins WHERE account_id = ? AND cid = ? AND NOT EXISTS (SELECT 1 FROM dag_roots WHERE root = pins.cid))",
      ).bind(
        new Date(now.getTime() + 7 * 86400000).toISOString(),
        this.principal.accountId,
        root,
      ),
      this.env.DB.prepare(
        "DELETE FROM pins WHERE account_id = ? AND cid = ?",
      ).bind(this.principal.accountId, root),
      this.env.DB.prepare(
        "UPDATE retained_blocks SET unreferenced_at = ? WHERE unreferenced_at IS NULL AND cid IN (SELECT cid FROM dag_members WHERE root = ?) AND NOT EXISTS (SELECT 1 FROM dag_members m JOIN pins p ON p.cid = m.root WHERE m.cid = retained_blocks.cid)",
      ).bind(now.toISOString(), root),
    ]);
    const result = results[1]!;
    if (!result.meta.changes)
      throw new HTTPException(404, {
        message: "Pin not found in your account",
      });
  }

  async rename(cid: string, name: string): Promise<Pin> {
    requireScope(this.principal, "pins:write");
    const label = validate(nameSchema, name);
    const pin = await this.env.DB.prepare(
      "UPDATE pins SET name = ? WHERE account_id = ? AND cid = ? RETURNING cid, name, size, blocks, created_at AS createdAt",
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

  private async save(dag: Dag, name: string, objectKey: string): Promise<Pin> {
    const cid = key(dag.root);
    const results = await this.env.DB.batch([
      writeGuard(this.env.DB, objectKey, "ready"),
      this.env.DB.prepare(
        "INSERT INTO pins (account_id, cid, name, size, blocks) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id, cid) DO UPDATE SET name = excluded.name RETURNING cid, name, size, blocks, created_at AS createdAt",
      ).bind(this.principal.accountId, cid, name, dag.size, dag.blocks.size),
      this.env.DB.prepare(
        "UPDATE retained_blocks SET unreferenced_at = NULL WHERE cid IN (SELECT cid FROM dag_members WHERE root = ?)",
      ).bind(cid),
    ]);
    const result = results[1]!.results[0] as Pin | undefined;
    if (!result) throw new Error("Failed to save pin reference");
    return result;
  }
}
