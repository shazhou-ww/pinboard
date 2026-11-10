import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { boundedBody } from "./content.js";
import { itemFilterMaxLength } from "@shazhou/pinboard-contracts";

export const nameSchema = z.string().trim().min(1).max(200);
export const descriptionTextSchema = z
  .string()
  .max(8000)
  .refine(
    (text) =>
      Array.from(text).every((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 || code === 9 || code === 10 || code === 13;
      }),
    "Use plain text without control characters",
  )
  .nullable();
export const itemFilterSchema = z.string().max(itemFilterMaxLength).optional();
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
  public: z.literal(true).optional(),
});
export const renamePinSchema = z.object({ name: nameSchema }).strict();
export const visibilitySchema = z
  .object({
    visibility: z.enum(["private", "public"]),
    acknowledge: z.literal(true),
  })
  .strict();
export const tokenSchema = z.object({
  name: nameSchema,
  scopes: z.array(scopeSchema).min(1).max(scopes.length),
  expiresInDays: z.number().int().min(1).max(365).default(30),
});

export const publicationWriteSchema = z.object({
  acknowledgePublicExposure: z.boolean().optional(),
  expectedSequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  requestId: z.string().min(1).max(128),
});
export const publicationCreateSchema = z
  .object({
    title: nameSchema,
    cid: z.string().min(1).max(256),
    requestId: z.string().min(1).max(128),
    public: z.literal(true).optional(),
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
export const publicationEditSchema = publicationWriteSchema
  .extend({
    title: nameSchema,
    description: descriptionTextSchema,
  })
  .strict();

export function validate<Output, Input>(
  schema: z.ZodType<Output, Input>,
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
