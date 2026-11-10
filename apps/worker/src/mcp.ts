import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Bindings } from "./env.js";
import type { Principal } from "./identity.js";
import { PinService } from "./service.js";
import { authorizeBlock, canReadBlock } from "./access.js";
import { getBlock } from "./storage.js";
import { key, parseCid } from "./content.js";
import { uploadLimits, type BlockRead } from "@shazhou/pinboard-contracts";
import {
  nameSchema,
  publicationCreateSchema,
  publicationWriteSchema,
  publicationPublishSchema,
  publicationRollbackSchema,
  publicationEditSchema,
  visibilitySchema,
} from "./schemas.js";
import { PublicationService, publicationHistory } from "./publications.js";
import { listDeleted, restorePin } from "./recently-deleted.js";
import {
  DescriptionService,
  descriptionWriteSchema,
  publishedDescription,
} from "./descriptions.js";

export async function handleMcp(
  request: Request,
  env: Bindings,
  principal: Principal,
  schedule?: (work: Promise<void>) => void,
): Promise<Response> {
  const service = new PinService(env, principal, schedule);
  const publications = new PublicationService(env, principal);
  const descriptions = new DescriptionService(env, principal, schedule);
  const server = new McpServer({ name: "pinboard", version: "0.1.0" });
  const result = async (operation: () => Promise<unknown>) => {
    try {
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(await operation()) },
        ],
      };
    } catch (error) {
      if (!(error instanceof HTTPException)) {
        console.error(
          JSON.stringify({
            event: "mcp_tool_failed",
            message: error instanceof Error ? error.message : "Unknown error",
          }),
        );
        return {
          isError: true,
          content: [{ type: "text" as const, text: "Internal server error" }],
        };
      }
      return {
        isError: true,
        content: [
          { type: "text" as const, text: `${error.status}: ${error.message}` },
        ],
      };
    }
  };
  server.registerTool(
    "block_get",
    {
      description:
        "Read an accessible raw DAG block as base64 (max 2 MiB). Private blocks require the owner's matching pin/publication read scope. OAuth stays MCP-only; traverse verified CID links to read complete private DAGs. Verify returned bytes against the CID. byteAccess reflects live public root overlap, not a private item's metadata.",
      inputSchema: { cid: z.string().min(1).max(256) },
      annotations: { readOnlyHint: true },
    },
    ({ cid }) =>
      result(async (): Promise<BlockRead> => {
        cid = key(parseCid(cid));
        await authorizeBlock(env, cid, principal);
        const byteAccess = (await canReadBlock(env, cid))
          ? "public"
          : "private";
        const block = await getBlock(env, cid);
        if (!block)
          throw new HTTPException(404, { message: "Content unavailable" });
        if (block.size > uploadLimits.maxBlockBytes) {
          await block.body.cancel();
          throw new HTTPException(413, {
            message:
              "MCP inline block exceeds 2 MiB; use an HTTP API Agent token for this block",
          });
        }
        const bytes = new Uint8Array(
          await new Response(block.body).arrayBuffer(),
        );
        if (bytes.length !== block.size)
          throw new HTTPException(503, {
            message: "Stored block is unavailable",
          });
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 32768)
          binary += String.fromCharCode(
            ...bytes.subarray(offset, offset + 32768),
          );
        return {
          cid,
          size: bytes.length,
          byteAccess,
          encoding: "base64",
          contentBase64: btoa(binary),
        };
      }),
  );
  server.registerTool(
    "publication_description",
    {
      description:
        "Read a public immutable revision's root or reachable child user description alongside its system preview. Never reads a live account annotation.",
      inputSchema: {
        id: z.string().max(128),
        revision: z.number().int().positive(),
        nodeCid: z.string().max(256),
      },
      annotations: { readOnlyHint: true },
    },
    ({ id, revision, nodeCid }) =>
      result(() =>
        publishedDescription(env, id, revision, nodeCid, schedule, principal),
      ),
  );
  server.registerTool(
    "publication_convert",
    {
      description:
        "Convert an owned Pin to a publication, preserving visibility and descriptions. The Pin is replaced, not trashed. Retry the identical request ID safely.",
      inputSchema: publicationCreateSchema.shape,
    },
    ({ title, cid, requestId }) =>
      result(() => publications.create(title, cid, requestId, true)),
  );
  server.registerTool(
    "description_get",
    {
      description:
        "Read a reachable node's account/root-scoped user description alongside the system preview. No global CID annotations.",
      inputSchema: {
        rootCid: z.string().max(256),
        nodeCid: z.string().max(256),
      },
      annotations: { readOnlyHint: true },
    },
    ({ rootCid, nodeCid }) => result(() => descriptions.read(rootCid, nodeCid)),
  );
  server.registerTool(
    "description_set",
    {
      description:
        "Set or clear (text:null) a pure-text description for an active owned root and reachable node using expectedVersion CAS. Published snapshots never change.",
      inputSchema: {
        rootCid: z.string().max(256),
        nodeCid: z.string().max(256),
        ...descriptionWriteSchema.shape,
      },
    },
    ({ rootCid, nodeCid, ...input }) =>
      result(() => descriptions.write(rootCid, nodeCid, input)),
  );
  server.registerTool(
    "description_export",
    {
      description:
        "Explicitly export account/root-scoped description sidecar metadata. Ordinary CAR exports contain original content only.",
      inputSchema: { rootCid: z.string().max(256) },
      annotations: { readOnlyHint: true },
    },
    ({ rootCid }) => result(() => descriptions.export(rootCid)),
  );
  server.registerTool(
    "list",
    {
      description:
        "List this account's pins. Follow nextCursor for the next page.",
      inputSchema: { cursor: z.string().max(256).optional() },
      annotations: { readOnlyHint: true },
    },
    ({ cursor }) => result(() => service.list(cursor)),
  );
  server.registerTool(
    "detail",
    {
      description: "Get a pin owned by this account.",
      inputSchema: { cid: z.string().max(256) },
      annotations: { readOnlyHint: true },
    },
    ({ cid }) => result(() => service.detail(cid)),
  );
  server.registerTool(
    "pin",
    {
      description:
        "Reference an accessible complete DAG as a private Pin. CID knowledge grants no access. No remote CID fetching.",
      inputSchema: {
        cid: z.string().max(256),
        name: nameSchema,
        public: z.literal(true).optional(),
      },
    },
    ({ cid, name }) => result(() => service.pin(cid, name)),
  );
  server.registerTool(
    "unpin",
    {
      description:
        "Move this account's pin to recently deleted for 30 days. Publication references and public bytes remain independent.",
      inputSchema: { cid: z.string().max(256) },
      annotations: { destructiveHint: true },
    },
    ({ cid }) =>
      result(async () => {
        await service.unpin(cid);
        return { unpinned: true };
      }),
  );
  server.registerTool(
    "upload",
    {
      description:
        "MCP OAuth credentials support inline uploads only; HTTP uploads require a separate API token. " +
        "Upload public file, raw block or complete single-root CAR (inline max 2 MiB). For larger uploads use POST /api/pins/upload with this Bearer token, X-Pinboard-Public: true; max 32 MiB.",
      inputSchema: {
        kind: z.enum(["file", "car", "block"]),
        name: nameSchema,
        cid: z.string().max(256).optional(),
        contentBase64: z.string().max(2796204),
        public: z.literal(true).optional(),
        publicationId: z.string().max(128).optional(),
        publicationWrite: publicationWriteSchema.optional(),
      },
      ...Object.fromEntries([
        [
          "description",
          "Upload a PRIVATE file, block or complete CAR (inline max 2 MiB). Omitted DAG blocks require existing read access. OAuth credentials support inline MCP uploads only; HTTP uploads require a separate API token (max 32 MiB). Public-target updates require publicationWrite.acknowledgePublicExposure:true; private links grant nothing.",
        ],
      ]),
    },
    ({ kind, name, cid, contentBase64, publicationId, publicationWrite }) =>
      result(async () => {
        if (
          contentBase64.length % 4 !== 0 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64)
        ) {
          throw new HTTPException(400, { message: "Invalid base64" });
        }
        const bytes = Uint8Array.from(atob(contentBase64), (char) =>
          char.charCodeAt(0),
        );
        if (bytes.length > 2 * 1024 * 1024)
          throw new HTTPException(413, {
            message: "MCP inline upload exceeds 2 MiB; use HTTP upload",
          });
        if (publicationId) {
          if (!publicationWrite)
            throw new HTTPException(400, {
              message: "publicationWrite required",
            });
          return publications.upload(
            publicationId,
            publicationWrite,
            bytes,
            kind,
            name,
            cid,
            schedule,
          );
        }
        return service.upload(bytes, kind, name, cid);
      }),
  );
  server.registerTool(
    "publication_create",
    {
      description:
        "Create a private publication from an owned active Pin. Creation does not make content public.",
      inputSchema: publicationCreateSchema.shape,
    },
    ({ title, cid, requestId }) =>
      result(() => publications.create(title, cid, requestId)),
  );
  server.registerTool(
    "publication_list",
    {
      description: "List your active publications; follow nextCursor.",
      inputSchema: { cursor: z.string().max(256).optional() },
      annotations: { readOnlyHint: true },
    },
    ({ cursor }) => result(() => publications.list(cursor)),
  );
  server.registerTool(
    "publication_get",
    {
      description:
        "Resolve an accessible publication. Private metadata requires owner publications:read; OAuth credentials remain MCP-only.",
      inputSchema: {
        id: z.string().max(128),
        revision: z.number().int().positive().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ id, revision }) =>
      result(async () => {
        const history = await publicationHistory(env, id, principal);
        if (!revision) return history.publication;
        const fixed = history.revisions.find(
          (item) => item.revision === revision,
        );
        if (!fixed)
          throw new HTTPException(404, { message: "Revision not found" });
        return { publication: history.publication, revision: fixed };
      }),
  );
  server.registerTool(
    "publication_history",
    {
      description:
        "Read accessible revision and pointer history under the publication's visibility.",
      inputSchema: { id: z.string().max(128) },
      annotations: { readOnlyHint: true },
    },
    ({ id }) => result(() => publicationHistory(env, id, principal)),
  );
  server.registerTool(
    "publication_publish",
    {
      description:
        "Link an owned pin using CAS and a persistent request ID without moving or renaming it. Current CID is NOP and does not apply draft description edits; historical noncurrent CID creates a new snapshot revision.",
      inputSchema: {
        id: z.string().max(128),
        ...publicationPublishSchema.shape,
      },
    },
    ({ id, cid, ...write }) =>
      result(() => publications.publish(id, cid, write)),
  );
  server.registerTool(
    "publication_rollback",
    {
      description:
        "Move current to an existing revision without creating another revision.",
      inputSchema: {
        id: z.string().max(128),
        ...publicationRollbackSchema.shape,
      },
    },
    ({ id, revision, ...write }) =>
      result(() => publications.rollback(id, revision, write)),
  );
  server.registerTool(
    "publication_edit",
    {
      description:
        "Edit an owned publication title and root description with sequence CAS and an idempotency key. A changed description creates a new revision with the same CID and preserved child descriptions; old snapshots remain unchanged. Title-only edits do not create a revision. Public edits require acknowledgePublicExposure:true.",
      inputSchema: { id: z.string().max(128), ...publicationEditSchema.shape },
    },
    ({ id, ...input }) => result(() => publications.edit(id, input)),
  );
  server.registerTool(
    "publication_delete",
    {
      description:
        "Close every public publication link and move to recently deleted for 30 days.",
      inputSchema: { id: z.string().max(128) },
      annotations: { destructiveHint: true },
    },
    ({ id }) =>
      result(async () => {
        await publications.delete(id);
        return { deleted: true };
      }),
  );
  server.registerTool(
    "access_set",
    {
      description:
        "Change an owned item's visibility with read and write scopes. acknowledge:true confirms all history exposure and irreversible downloads/copies, or revocation with public-byte overlap. Private links grant no access.",
      inputSchema: {
        kind: z.enum(["pin", "publication"]),
        id: z.string().max(256),
        ...visibilitySchema.shape,
      },
    },
    ({ kind, id, visibility }) =>
      result(() =>
        kind === "pin"
          ? service.setVisibility(id, visibility)
          : publications.setVisibility(id, visibility),
      ),
  );
  server.registerTool(
    "recently_deleted",
    {
      description: "List recoverable pins and publications with expiry times.",
      inputSchema: { cursor: z.string().max(512).optional() },
      annotations: { readOnlyHint: true },
    },
    ({ cursor }) => result(() => listDeleted(env, principal, cursor)),
  );
  server.registerTool(
    "restore",
    {
      description:
        "Restore before 30-day expiry, preserving visibility. Public restores reopen anonymous links and ALL history/downloads. Existing copies cannot be recalled. No revision is created.",
      inputSchema: {
        kind: z.enum(["pin", "publication"]),
        id: z.string().max(256),
      },
    },
    ({ kind, id }) =>
      result(async () => {
        if (kind === "publication") return publications.restore(id);
        return restorePin(env, principal, id);
      }),
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    maxRequestBodySize: 3 * 1024 * 1024,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
