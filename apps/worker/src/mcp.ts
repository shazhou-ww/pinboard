import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Bindings } from "./env.js";
import type { Principal } from "./identity.js";
import { PinService } from "./service.js";
import {
  nameSchema,
  publicationCreateSchema,
  publicationWriteSchema,
  publicationPublishSchema,
  publicationRollbackSchema,
} from "./schemas.js";
import { PublicationService, publicationHistory } from "./publications.js";
import { listDeleted, restorePin } from "./recently-deleted.js";

export async function handleMcp(
  request: Request,
  env: Bindings,
  principal: Principal,
  schedule?: (work: Promise<void>) => void,
): Promise<Response> {
  const service = new PinService(env, principal, schedule);
  const publications = new PublicationService(env, principal);
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
        "Reference an already stored complete DAG. No remote CID fetching. All bytes are public.",
      inputSchema: {
        cid: z.string().max(256),
        name: nameSchema,
        public: z.literal(true),
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
        public: z.literal(true),
        publicationId: z.string().max(128).optional(),
        publicationWrite: publicationWriteSchema.optional(),
      },
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
        "Create a stable public publication from an owned active pin. Title and all revisions are public; private labels and account identity are not.",
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
        "Resolve a public publication, optionally at a fixed revision. Same public metadata for everyone.",
      inputSchema: {
        id: z.string().max(128),
        revision: z.number().int().positive().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ id, revision }) =>
      result(async () => {
        const history = await publicationHistory(env, id);
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
      description: "Read the complete public revision and pointer history.",
      inputSchema: { id: z.string().max(128) },
      annotations: { readOnlyHint: true },
    },
    ({ id }) => result(() => publicationHistory(env, id)),
  );
  server.registerTool(
    "publication_publish",
    {
      description:
        "Publish an owned pin using CAS and a persistent request ID. Current CID is NOP; historical noncurrent CID creates a new revision.",
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
        "Restore the original pin or publication before its 30-day expiry. No revision is created.",
      inputSchema: {
        kind: z.enum(["pin", "publication"]),
        id: z.string().max(256),
      },
    },
    ({ kind, id }) =>
      result(async () => {
        if (kind === "publication") return publications.restore(id);
        await restorePin(env, principal, id);
        return { restored: true };
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
