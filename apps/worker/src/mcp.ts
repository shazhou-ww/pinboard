import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Bindings } from "./env.js";
import type { Principal } from "./identity.js";
import { PinService } from "./service.js";
import { nameSchema } from "./schemas.js";

export async function handleMcp(
  request: Request,
  env: Bindings,
  principal: Principal,
): Promise<Response> {
  const service = new PinService(env, principal);
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
        "Delete only this account's reference. Public bytes are not erased; GC is deferred.",
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
        "Upload public file, raw block or complete single-root CAR (inline max 2 MiB). For larger uploads use POST /api/pins/upload with this Bearer token, X-Pinboard-Public: true; max 32 MiB.",
      inputSchema: {
        kind: z.enum(["file", "car", "block"]),
        name: nameSchema,
        cid: z.string().max(256).optional(),
        contentBase64: z.string().max(2796204),
        public: z.literal(true),
      },
    },
    ({ kind, name, cid, contentBase64 }) =>
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
        return service.upload(bytes, kind, name, cid);
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
