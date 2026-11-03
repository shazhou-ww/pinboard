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
  storeDag,
  type Dag,
  verifyBlock,
} from "./content.js";
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
    await storeDag(this.env.BLOCKS, dag);
    return this.save(dag, name);
  }

  async pin(cid: string, name: string): Promise<Pin> {
    requireScope(this.principal, "pins:write");
    validate(nameSchema, name);
    const dag = await completeDag(parseCid(cid), (link) =>
      this.readBlock(link.toString()),
    );
    return this.save(dag, name);
  }

  async unpin(cid: string): Promise<void> {
    requireScope(this.principal, "pins:delete");
    const result = await this.env.DB.prepare(
      "DELETE FROM pins WHERE account_id = ? AND cid = ?",
    )
      .bind(this.principal.accountId, key(parseCid(cid)))
      .run();
    if (!result.meta.changes)
      throw new HTTPException(404, {
        message: "Pin not found in your account",
      });
  }

  private async readBlock(cid: string): Promise<Uint8Array | undefined> {
    const block = await this.env.BLOCKS.get(key(parseCid(cid)));
    return block ? new Uint8Array(await block.arrayBuffer()) : undefined;
  }

  private async save(dag: Dag, name: string): Promise<Pin> {
    const cid = key(dag.root);
    const result = await this.env.DB.prepare(
      "INSERT INTO pins (account_id, cid, name, size, blocks) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id, cid) DO UPDATE SET name = excluded.name RETURNING cid, name, size, blocks, created_at AS createdAt",
    )
      .bind(this.principal.accountId, cid, name, dag.size, dag.blocks.size)
      .first<Pin>();
    if (!result) throw new Error("Failed to save pin reference");
    return result;
  }
}
