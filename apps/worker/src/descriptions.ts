import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { NodeDescription } from "@shazhou/pinboard-contracts";
import type { Bindings } from "./env.js";
import { completeDag, key, parseCid } from "./content.js";
import { requireScope, type Principal } from "./identity.js";
import { getPreview, processPreview } from "./previews.js";
import { descriptionTextSchema, validate } from "./schemas.js";
import { dagStatements, readBlock } from "./storage.js";
import { resolvePublication } from "./publications.js";

export async function publishedDescription(
  env: Bindings,
  id: string,
  version: number,
  node: string,
  schedule?: (work: Promise<void>) => void,
  principal?: Principal,
): Promise<NodeDescription> {
  const { revision } = await resolvePublication(env, id, version, principal);
  const nodeCid = key(parseCid(node));
  const reachable = await env.DB.prepare(
    "SELECT 1 FROM dag_members WHERE root = ? AND cid = ?",
  )
    .bind(revision.cid, nodeCid)
    .first();
  if (!reachable)
    throw new HTTPException(404, { message: "Node not in this revision" });
  const result: NodeDescription = {
    rootCid: revision.cid,
    nodeCid,
    description: {
      user: {
        text: revision.descriptions?.[nodeCid] ?? null,
        version: revision.revision,
      },
      preview: await getPreview(env, nodeCid),
    },
  };
  if (
    result.description.preview.status === "pending" ||
    result.description.preview.status === "failed"
  )
    schedule?.(processPreview(env, nodeCid));
  return result;
}

export const descriptionWriteSchema = z
  .object({
    text: descriptionTextSchema,
    expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

const activeNode = `EXISTS (
  SELECT 1 FROM pins p WHERE p.account_id = ? AND p.cid = ?
  AND NOT EXISTS (SELECT 1 FROM deleted_pins d WHERE d.account_id = p.account_id AND d.cid = p.cid)
  AND (p.cid = ? OR EXISTS (SELECT 1 FROM dag_members m WHERE m.root = p.cid AND m.cid = ?))
)`;

export class DescriptionService {
  constructor(
    private readonly env: Bindings,
    private readonly principal: Principal,
    private readonly schedule?: (work: Promise<void>) => void,
  ) {}

  private async context(root: string, node: string) {
    const rootCid = key(parseCid(root));
    const nodeCid = key(parseCid(node));
    const activeRoot = await this.env.DB.prepare(
      `SELECT 1 FROM pins p WHERE account_id = ? AND cid = ?
       AND NOT EXISTS (SELECT 1 FROM deleted_pins d WHERE d.account_id = p.account_id AND d.cid = p.cid)
       AND NOT EXISTS (SELECT 1 FROM dag_roots WHERE root = p.cid)`,
    )
      .bind(this.principal.accountId, rootCid)
      .first();
    if (activeRoot) {
      const dag = await completeDag(parseCid(rootCid), (cid) =>
        readBlock(this.env, key(cid)),
      );
      await this.env.DB.batch(
        dagStatements(this.env.DB, dag, new Date().toISOString()),
      );
    }
    const row = await this.env.DB.prepare(`SELECT 1 WHERE ${activeNode}`)
      .bind(this.principal.accountId, rootCid, nodeCid, nodeCid)
      .first();
    if (!row)
      throw new HTTPException(404, {
        message: "Active owned root or reachable node not found",
      });
    return { rootCid, nodeCid };
  }

  async read(root: string, node: string): Promise<NodeDescription> {
    requireScope(this.principal, "pins:read");
    const { rootCid, nodeCid } = await this.context(root, node);
    const user = await this.env.DB.prepare(
      "SELECT text, version FROM node_descriptions WHERE account_id = ? AND root_cid = ? AND node_cid = ?",
    )
      .bind(this.principal.accountId, rootCid, nodeCid)
      .first<{ text: string | null; version: number }>();
    const result: NodeDescription = {
      rootCid,
      nodeCid,
      description: {
        user: user ?? { text: null, version: 0 },
        preview: await getPreview(this.env, nodeCid),
      },
    };
    if (
      result.description.preview.status === "pending" ||
      result.description.preview.status === "failed"
    )
      this.schedule?.(processPreview(this.env, nodeCid));
    return result;
  }

  async write(
    root: string,
    node: string,
    input: z.infer<typeof descriptionWriteSchema>,
  ) {
    requireScope(this.principal, "pins:write");
    requireScope(this.principal, "pins:read");
    input = validate(descriptionWriteSchema, input);
    const { rootCid, nodeCid } = await this.context(root, node);
    const saved = await this.env.DB.prepare(
      `INSERT INTO node_descriptions (account_id, root_cid, node_cid, text, version)
       SELECT ?, ?, ?, ?, 1 WHERE ${activeNode}
       AND (? = 0 OR EXISTS (SELECT 1 FROM node_descriptions WHERE account_id = ? AND root_cid = ? AND node_cid = ? AND version = ?))
       ON CONFLICT(account_id, root_cid, node_cid) DO UPDATE SET text = excluded.text, version = node_descriptions.version + 1
       WHERE node_descriptions.version = ? RETURNING version`,
    )
      .bind(
        this.principal.accountId,
        rootCid,
        nodeCid,
        input.text,
        this.principal.accountId,
        rootCid,
        nodeCid,
        nodeCid,
        input.expectedVersion,
        this.principal.accountId,
        rootCid,
        nodeCid,
        input.expectedVersion,
        input.expectedVersion,
      )
      .first();
    if (!saved)
      throw new HTTPException(409, {
        message:
          "Description changed or root is no longer active. Read and retry.",
      });
    return this.read(rootCid, nodeCid);
  }

  async export(
    root: string,
  ): Promise<{ rootCid: string; descriptions: Record<string, string> }> {
    requireScope(this.principal, "pins:read");
    const { rootCid } = await this.context(root, root);
    const rows = await this.env.DB.prepare(
      "SELECT node_cid, text FROM node_descriptions WHERE account_id = ? AND root_cid = ? AND text IS NOT NULL",
    )
      .bind(this.principal.accountId, rootCid)
      .all<{ node_cid: string; text: string }>();
    return {
      rootCid,
      descriptions: Object.fromEntries(
        rows.results.map((row) => [row.node_cid, row.text]),
      ),
    };
  }
}
