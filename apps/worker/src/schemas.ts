import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { boundedBody } from "./content.js";

export const nameSchema = z.string().trim().min(1).max(200);
export const scopes = [
  "pins:read",
  "pins:write",
  "pins:delete",
  "publications:read",
  "publications:write",
  "publications:delete",
] as const;
export type Scope = (typeof scopes)[number];
export const scopeSchema = z.enum(scopes);
export const pinSchema = z.object({
  cid: z.string().min(1).max(256),
  name: nameSchema.default("Untitled"),
  public: z.literal(true),
});
export const renamePinSchema = z.object({ name: nameSchema }).strict();
export const tokenSchema = z.object({
  name: nameSchema,
  scopes: z.array(scopeSchema).min(1).max(scopes.length),
  expiresInDays: z.number().int().min(1).max(365).default(30),
});

export const publicationWriteSchema = z.object({
  expectedSequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  requestId: z.string().min(1).max(128),
});
export const publicationCreateSchema = z
  .object({
    title: nameSchema,
    cid: z.string().min(1).max(256),
    requestId: z.string().min(1).max(128),
    public: z.literal(true),
  })
  .strict();
export const publicationPublishSchema = publicationWriteSchema
  .extend({
    cid: z.string().min(1).max(256),
  })
  .strict();
export const publicationRollbackSchema = publicationWriteSchema
  .extend({
    revision: z.number().int().positive(),
  })
  .strict();

export function validate<Output, Input>(
  schema: z.ZodType<Output, z.ZodTypeDef, Input>,
  value: unknown,
): Output {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new HTTPException(400, {
      message: parsed.error.issues.map((issue) => issue.message).join("; "),
    });
  return parsed.data;
}

export async function jsonBody(request: Request): Promise<unknown> {
  const bytes = await boundedBody(request, 16384);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON" });
  }
}
