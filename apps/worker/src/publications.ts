import { HTTPException } from "hono/http-exception";
import type {
  Publication,
  PublicationHistory,
  PublicationResult,
  PublicationRevision,
  PublicationWrite,
  PublicationEdit,
  UploadPublicationResult,
} from "@shazhou/pinboard-contracts";
import type { Bindings } from "./env.js";
import { requireScope, type Principal } from "./identity.js";
import { completeDag, key, parseCid } from "./content.js";
import { PinService } from "./service.js";
import {
  itemFilterSchema,
  nameSchema,
  publicationEditSchema,
  validate,
} from "./schemas.js";
import { getCar, readBlock, storeDag } from "./storage.js";
import { matchesItemFilter } from "./item-filter.js";
import { authorizePublication } from "./access.js";
import { prepareIpnsChange } from "./ipns.js";

const fields = `p.id, p.title, p.visibility, p.current_revision AS currentRevision,
  p.sequence, p.created_at AS createdAt, p.updated_at AS updatedAt,
  (SELECT count(*) FROM publication_revisions WHERE publication_id = p.id) AS revisionCount`;
const revisionFields =
  "revision, cid, size, blocks, created_at AS createdAt, descriptions";
const descriptionSnapshot = `(SELECT coalesce(json_group_object(node_cid, text), '{}') FROM node_descriptions WHERE account_id = ? AND root_cid = ? AND text IS NOT NULL)`;
function decodeRevision(
  row: Omit<PublicationRevision, "descriptions"> & {
    descriptions?: string | Readonly<Record<string, string>>;
  },
): PublicationRevision {
  return {
    ...row,
    descriptions:
      typeof row.descriptions === "string"
        ? (JSON.parse(row.descriptions) as Record<string, string>)
        : (row.descriptions ?? {}),
  };
}
type Row = Omit<Publication, "current">;
type RequestRow = { payload: string; result: string };
const conflict = () =>
  new HTTPException(409, {
    message:
      "Publication changed, target is unavailable, or publication is deleted. Refresh and retry with a new request ID.",
  });

export async function readPublication(
  env: Bindings,
  id: string,
  principal?: Principal,
): Promise<Publication> {
  return (await resolvePublication(env, id, undefined, principal)).publication;
}

export async function resolvePublication(
  env: Bindings,
  id: string,
  revision?: number,
  principal?: Principal,
): Promise<{ publication: Publication; revision: PublicationRevision }> {
  await authorizePublication(env, id, principal);
  if (
    revision !== undefined &&
    (!Number.isSafeInteger(revision) || revision < 1)
  )
    throw new HTTPException(404, { message: "Revision not found" });
  const row = await env.DB.prepare(
    `SELECT ${fields},
    c.cid AS currentCid, c.size AS currentSize, c.blocks AS currentBlocks, c.created_at AS currentCreatedAt, c.descriptions AS currentDescriptions,
    r.revision, r.cid, r.size, r.blocks, r.created_at AS revisionCreatedAt, r.descriptions
    FROM publications p
    JOIN publication_revisions c ON c.publication_id = p.id AND c.revision = p.current_revision
    JOIN publication_revisions r ON r.publication_id = p.id AND r.revision = coalesce(?, p.current_revision)
    WHERE p.id = ? AND p.deleted_at IS NULL`,
  )
    .bind(revision ?? null, id)
    .first<
      Row & {
        currentCid: string;
        currentSize: number;
        currentBlocks: number;
        currentCreatedAt: string;
        currentDescriptions: string;
        descriptions: string;
        revision: number;
        cid: string;
        size: number;
        blocks: number;
        revisionCreatedAt: string;
      }
    >();
  if (!row)
    throw new HTTPException(404, {
      message: "Publication or revision not found",
    });
  return {
    publication: {
      id: row.id,
      title: row.title,
      visibility: row.visibility,
      currentRevision: row.currentRevision,
      revisionCount: row.revisionCount,
      sequence: row.sequence,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      current: {
        revision: row.currentRevision,
        cid: row.currentCid,
        size: row.currentSize,
        blocks: row.currentBlocks,
        createdAt: row.currentCreatedAt,
        descriptions: JSON.parse(row.currentDescriptions) as Record<
          string,
          string
        >,
      },
    },
    revision: {
      revision: row.revision,
      cid: row.cid,
      size: row.size,
      blocks: row.blocks,
      createdAt: row.revisionCreatedAt,
      descriptions: JSON.parse(row.descriptions) as Record<string, string>,
    },
  };
}

export async function publicationHistory(
  env: Bindings,
  id: string,
  principal?: Principal,
): Promise<PublicationHistory> {
  await authorizePublication(env, id, principal);
  // One D1 batch is a consistent snapshot, including the deletion check.
  const rows = await env.DB.batch<
    | Row
    | (Omit<PublicationRevision, "descriptions"> & { descriptions: string })
    | PublicationHistory["operations"][number]
  >([
    env.DB.prepare(
      `SELECT ${fields} FROM publications p WHERE id = ? AND deleted_at IS NULL`,
    ).bind(id),
    env.DB.prepare(
      `SELECT ${revisionFields} FROM publication_revisions WHERE publication_id = ? ORDER BY revision DESC`,
    ).bind(id),
    env.DB.prepare(
      "SELECT sequence, revision, kind, created_at AS createdAt FROM publication_operations WHERE publication_id = ? ORDER BY sequence DESC",
    ).bind(id),
  ]);
  const row = rows[0]!.results[0] as Row | undefined;
  if (!row) throw new HTTPException(404, { message: "Publication not found" });
  const revisions = (
    rows[1]!.results as (Omit<PublicationRevision, "descriptions"> & {
      descriptions: string;
    })[]
  ).map(decodeRevision);
  const current = revisions.find(
    (item) => item.revision === row.currentRevision,
  );
  if (!current) throw new Error("Publication current revision missing");
  return {
    publication: { ...row, current },
    revisions,
    operations: rows[2]!.results as PublicationHistory["operations"],
  };
}

// All predicates run inside the same D1 batch that adds the retention reference.
// The manifest and every DAG member must still be fenced against GC.
const availablePin = `EXISTS (
  SELECT 1 FROM pins pin JOIN car_dags cd ON cd.root = pin.cid
  JOIN storage_objects so ON so.object_key = cd.object_key AND so.state = 'ready'
  WHERE pin.account_id = ? AND pin.cid = ?
  AND NOT EXISTS (SELECT 1 FROM deleted_pins d WHERE d.account_id = pin.account_id AND d.cid = pin.cid)
  AND EXISTS (SELECT 1 FROM dag_roots WHERE root = pin.cid)
  AND NOT EXISTS (SELECT 1 FROM dag_members dm
    LEFT JOIN car_blocks cb ON cb.cid = dm.cid
    LEFT JOIN storage_objects s ON s.object_key = cb.object_key
    WHERE dm.root = pin.cid AND (s.state IS NULL OR s.state != 'ready'))
)`;

export class PublicationService {
  constructor(
    private readonly env: Bindings,
    private readonly principal: Principal,
  ) {}

  async list(
    cursor = "",
    query = "",
    visibility: Publication["visibility"] | "all" = "all",
  ) {
    requireScope(this.principal, "publications:read");
    validate(itemFilterSchema, query);
    const filtered = query.trim().length > 0;
    const rows = await this.env.DB.prepare(
      filtered
        ? `SELECT p.id, p.title,
          (SELECT j.value FROM json_each(r.descriptions) j WHERE j.key = r.cid) AS rootDescription
          FROM publications p JOIN publication_revisions r
          ON r.publication_id = p.id AND r.revision = p.current_revision
          WHERE p.account_id = ? AND p.deleted_at IS NULL AND p.id > ? AND (? = 'all' OR p.visibility = ?) ORDER BY p.id`
        : "SELECT id FROM publications WHERE account_id = ? AND deleted_at IS NULL AND id > ? AND (? = 'all' OR visibility = ?) ORDER BY id LIMIT 51",
    )
      .bind(this.principal.accountId, cursor, visibility, visibility)
      .all<{ id: string; title: string; rootDescription: string | null }>();
    const matches = filtered
      ? rows.results.filter((row) =>
          matchesItemFilter(query, row.title, row.rootDescription),
        )
      : rows.results;
    const page = matches.slice(0, 50);
    const publications = await Promise.all(
      page.map(({ id }) => readPublication(this.env, id, this.principal)),
    );
    return {
      publications,
      nextCursor: matches.length > 50 ? page.at(-1)!.id : null,
    };
  }

  async owned(id: string): Promise<Publication> {
    requireScope(this.principal, "publications:read");
    await this.owner(id);
    return readPublication(this.env, id, this.principal);
  }

  private async owner(id: string): Promise<void> {
    const row = await this.env.DB.prepare(
      "SELECT id FROM publications WHERE id = ? AND account_id = ?",
    )
      .bind(id, this.principal.accountId)
      .first();
    if (!row)
      throw new HTTPException(404, {
        message: "Publication not found in your account",
      });
  }

  private async replay(
    requestId: string,
    payload: string,
  ): Promise<PublicationResult | null> {
    const reference = await this.env.DB.prepare(
      "SELECT json_extract(result, '$.publication.id') AS id FROM publication_requests WHERE account_id = ? AND request_id = ?",
    )
      .bind(this.principal.accountId, requestId)
      .first<{ id: string }>();
    if (!reference) return null;
    const visibility = await authorizePublication(
      this.env,
      reference.id,
      this.principal,
    );
    const row = await this.env.DB.prepare(
      "SELECT payload, result FROM publication_requests WHERE account_id = ? AND request_id = ?",
    )
      .bind(this.principal.accountId, requestId)
      .first<RequestRow>();
    if (!row) throw conflict();
    if (row.payload !== payload)
      throw new HTTPException(409, {
        message: "Request ID was already used with a different payload",
      });
    const result = JSON.parse(row.result) as PublicationResult;
    return { ...result, publication: { ...result.publication, visibility } };
  }

  async create(
    title: string,
    cid: string,
    requestId: string,
    convert = false,
  ): Promise<PublicationResult> {
    requireScope(this.principal, "publications:write");
    requireScope(this.principal, "publications:read");
    if (convert) requireScope(this.principal, "pins:delete");
    title = validate(nameSchema, title);
    cid = key(parseCid(cid));
    const payload = JSON.stringify({
      kind: convert ? "convert" : "create",
      title,
      cid,
    });
    const replay = await this.replay(requestId, payload);
    if (replay) return replay;
    let pin;
    try {
      pin = await new PinService(this.env, this.principal).detail(cid);
    } catch (error) {
      if (convert && error instanceof HTTPException && error.status === 404) {
        const completed = await this.replay(requestId, payload);
        if (completed) return completed;
      }
      throw error;
    }
    await this.prepareTarget(cid);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const current: PublicationRevision = {
      revision: 1,
      cid,
      size: pin.size,
      blocks: pin.blocks,
      createdAt: now,
    };
    const result: PublicationResult = {
      status: convert ? "converted" : "created",
      publication: {
        id,
        title,
        visibility: convert ? pin.visibility : "private",
        currentRevision: 1,
        sequence: 1,
        revisionCount: 1,
        createdAt: now,
        updatedAt: now,
        current,
      },
    };
    const attempt = crypto.randomUUID();
    const guard =
      "EXISTS (SELECT 1 FROM publication_requests WHERE attempt_id = ?)";
    await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO publication_requests (account_id, request_id, payload, attempt_id, result) SELECT ?, ?, ?, ?, ? WHERE ${availablePin} AND EXISTS (SELECT 1 FROM pins WHERE account_id = ? AND cid = ? AND visibility = ?)`,
      ).bind(
        this.principal.accountId,
        requestId,
        payload,
        attempt,
        JSON.stringify(result),
        this.principal.accountId,
        cid,
        this.principal.accountId,
        cid,
        pin.visibility,
      ),
      this.env.DB.prepare(
        `INSERT INTO publications (id, account_id, title, visibility, current_revision, sequence, created_at, updated_at) SELECT ?, ?, ?, ?, 1, 1, ?, ? WHERE ${guard}`,
      ).bind(
        id,
        this.principal.accountId,
        title,
        result.publication.visibility,
        now,
        now,
        attempt,
      ),
      this.env.DB.prepare(
        `INSERT INTO publication_revisions (publication_id, revision, cid, size, blocks, created_at, descriptions) SELECT ?, 1, ?, ?, ?, ?, ${descriptionSnapshot} WHERE ${guard}`,
      ).bind(
        id,
        cid,
        pin.size,
        pin.blocks,
        now,
        this.principal.accountId,
        cid,
        attempt,
      ),
      this.env.DB.prepare(
        `INSERT INTO publication_retention (publication_id, cid) SELECT ?, ? WHERE ${guard}`,
      ).bind(id, cid, attempt),
      this.env.DB.prepare(
        `INSERT INTO publication_operations (publication_id, sequence, revision, kind, created_at) SELECT ?, 1, 1, 'create', ? WHERE ${guard}`,
      ).bind(id, now, attempt),
      ...this.retain(cid, attempt),
      this.snapshotResult(attempt, id, 1),
      ...(convert
        ? [
            this.env.DB.prepare(
              `DELETE FROM pins WHERE account_id = ? AND cid = ? AND ${guard}`,
            ).bind(this.principal.accountId, cid, attempt),
          ]
        : []),
    ]);
    const saved = await this.replay(requestId, payload);
    if (!saved) throw conflict();
    return saved;
  }

  async publish(
    id: string,
    cid: string,
    write: PublicationWrite,
  ): Promise<PublicationResult> {
    return this.change(id, { cid: key(parseCid(cid)) }, write);
  }

  async rollback(
    id: string,
    revision: number,
    write: PublicationWrite,
  ): Promise<PublicationResult> {
    return this.change(id, { revision }, write);
  }

  async edit(id: string, input: PublicationEdit): Promise<PublicationResult> {
    const write = validate(publicationEditSchema, input);
    return this.change(
      id,
      {
        metadata: {
          title: write.title,
          description: write.description || null,
        },
      },
      write,
    );
  }

  private async change(
    id: string,
    target:
      | { cid: string }
      | { revision: number }
      | { metadata: { title: string; description: string | null } },
    write: PublicationWrite,
  ): Promise<PublicationResult> {
    requireScope(this.principal, "publications:write");
    requireScope(this.principal, "publications:read");
    const payload = JSON.stringify({
      id,
      ...target,
      expectedSequence: write.expectedSequence,
      acknowledgePublicExposure: write.acknowledgePublicExposure,
    });
    const replay = await this.replay(write.requestId, payload);
    if (replay) return replay;
    await this.owner(id);
    const { publication: before, revisions } = await publicationHistory(
      this.env,
      id,
      this.principal,
    );
    if (before.sequence !== write.expectedSequence) throw conflict();
    const metadata = "metadata" in target ? target.metadata : undefined;
    const descriptionChanged =
      !!metadata &&
      (before.current.descriptions?.[before.current.cid] ?? null) !==
        metadata.description;
    const rollback = "revision" in target;
    const previous = rollback
      ? revisions.find((item) => item.revision === target.revision)
      : undefined;
    if (rollback && !previous)
      throw new HTTPException(404, { message: "Revision not found" });
    const cid =
      "cid" in target
        ? target.cid
        : rollback
          ? previous!.cid
          : before.current.cid;
    const nop = metadata
      ? !descriptionChanged && metadata.title === before.title
      : rollback
        ? before.currentRevision === target.revision
        : before.current.cid === cid;
    if (!rollback && !metadata) requireScope(this.principal, "pins:read");
    const pin =
      metadata || nop
        ? before.current
        : rollback
          ? previous!
          : await new PinService(this.env, this.principal).detail(cid);
    if (
      !metadata &&
      !rollback &&
      !nop &&
      before.visibility === "public" &&
      "visibility" in pin &&
      pin.visibility === "private" &&
      !write.acknowledgePublicExposure
    )
      throw new HTTPException(400, {
        message:
          "Confirm that private source bytes and descriptions will become public; the source Pin remains private",
      });
    if (
      metadata &&
      !nop &&
      before.visibility === "public" &&
      !write.acknowledgePublicExposure
    )
      throw new HTTPException(400, {
        message:
          "Confirm that edited publication metadata will be public; downloaded and cached copies cannot be recalled",
      });
    if (!nop && !metadata) await this.prepareTarget(cid);
    const now = new Date().toISOString();
    const descriptions = { ...before.current.descriptions };
    if (metadata && descriptionChanged) {
      if (metadata.description === null) delete descriptions[cid];
      else descriptions[cid] = metadata.description;
    }
    const current = nop
      ? before.current
      : metadata && !descriptionChanged
        ? before.current
        : rollback
          ? previous!
          : {
              revision: revisions[0]!.revision + 1,
              cid,
              size: pin.size,
              blocks: pin.blocks,
              createdAt: now,
              ...(metadata ? { descriptions } : {}),
            };
    const result: PublicationResult = {
      status: nop
        ? "nop"
        : metadata
          ? "updated"
          : rollback
            ? "rolled-back"
            : "published",
      publication: nop
        ? before
        : {
            ...before,
            title: metadata?.title ?? before.title,
            current,
            currentRevision: current.revision,
            revisionCount:
              before.revisionCount +
              (rollback || (metadata && !descriptionChanged) ? 0 : 1),
            sequence: before.sequence + 1,
            updatedAt: now,
          },
    };
    const attempt = crypto.randomUUID();
    const guard =
      "EXISTS (SELECT 1 FROM publication_requests WHERE attempt_id = ?)";
    const ipns = await prepareIpnsChange(this.env, id, cid);
    const statements = [
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO publication_requests (account_id, request_id, payload, attempt_id, result)
        SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM publications WHERE id = ? AND account_id = ? AND deleted_at IS NULL AND sequence = ?) AND ${ipns.guard}
        ${rollback || nop || metadata ? "" : `AND ${availablePin} AND (? OR EXISTS (SELECT 1 FROM publications p JOIN pins pin ON pin.account_id = p.account_id WHERE p.id = ? AND pin.cid = ? AND (p.visibility = 'private' OR pin.visibility = 'public')))`}`,
      ).bind(
        this.principal.accountId,
        write.requestId,
        payload,
        attempt,
        JSON.stringify(result),
        id,
        this.principal.accountId,
        write.expectedSequence,
        ...ipns.values,
        ...(rollback || nop || metadata
          ? []
          : [
              this.principal.accountId,
              cid,
              write.acknowledgePublicExposure ? 1 : 0,
              id,
              cid,
            ]),
      ),
    ];
    if (!nop) {
      if (!rollback && (!metadata || descriptionChanged))
        statements.push(
          this.env.DB.prepare(
            `INSERT INTO publication_revisions (publication_id, revision, cid, size, blocks, created_at, descriptions) SELECT ?, ?, ?, ?, ?, ?, ${metadata ? "?" : descriptionSnapshot} WHERE ${guard}`,
          ).bind(
            id,
            current.revision,
            cid,
            pin.size,
            pin.blocks,
            now,
            ...(metadata
              ? [JSON.stringify(descriptions)]
              : [this.principal.accountId, cid]),
            attempt,
          ),
          this.env.DB.prepare(
            `INSERT OR IGNORE INTO publication_retention (publication_id, cid) SELECT ?, ? WHERE ${guard}`,
          ).bind(id, cid, attempt),
        );
      statements.push(
        this.env.DB.prepare(
          `UPDATE publications SET title = ?, current_revision = ?, sequence = sequence + 1, updated_at = ? WHERE id = ? AND ${guard}`,
        ).bind(result.publication.title, current.revision, now, id, attempt),
        this.env.DB.prepare(
          `INSERT INTO publication_operations (publication_id, sequence, revision, kind, created_at) SELECT ?, ?, ?, ?, ? WHERE ${guard}`,
        ).bind(
          id,
          result.publication.sequence,
          current.revision,
          metadata ? "edit" : rollback ? "rollback" : "publish",
          now,
          attempt,
        ),
        ...this.retain(cid, attempt),
        this.snapshotResult(attempt, id, current.revision),
      );
    }
    statements.push(...ipns.statements(attempt));
    await this.env.DB.batch(statements);
    const saved = await this.replay(write.requestId, payload);
    if (!saved) throw conflict();
    return saved;
  }

  private retain(cid: string, attempt: string) {
    return [
      this.env.DB.prepare(
        "UPDATE retained_blocks SET unreferenced_at = NULL WHERE cid IN (SELECT cid FROM dag_members WHERE root = ?) AND EXISTS (SELECT 1 FROM publication_requests WHERE attempt_id = ?)",
      ).bind(cid, attempt),
      this.env.DB.prepare(
        "UPDATE content_previews SET unreferenced_at = NULL WHERE source_cid = ? AND EXISTS (SELECT 1 FROM publication_requests WHERE attempt_id = ?)",
      ).bind(cid, attempt),
    ];
  }

  private snapshotResult(attempt: string, id: string, revision: number) {
    return this.env.DB.prepare(
      "UPDATE publication_requests SET result = json_set(result, '$.publication.current.descriptions', json((SELECT descriptions FROM publication_revisions WHERE publication_id = ? AND revision = ?))) WHERE attempt_id = ?",
    ).bind(id, revision, attempt);
  }

  private async prepareTarget(cid: string): Promise<void> {
    const manifest = await this.env.DB.prepare(
      "SELECT root FROM car_dags WHERE root = ?",
    )
      .bind(cid)
      .first();
    if (!manifest) {
      // Publication writes already prepare legacy targets before retaining them.
      // Keep that explicit write separate from archive reads.
      await storeDag(
        this.env,
        await completeDag(parseCid(cid), (link) =>
          readBlock(this.env, key(link)),
        ),
      );
    }
    const car = await getCar(this.env, cid);
    if (!car)
      throw new HTTPException(503, {
        message: "Publication target content is unavailable",
      });
    await car.body.cancel();
  }

  async delete(id: string): Promise<void> {
    requireScope(this.principal, "publications:delete");
    await this.owner(id);
    const time = Date.now();
    await this.env.DB.prepare(
      "UPDATE publications SET deleted_at = ?, expires_at = ? WHERE id = ? AND account_id = ? AND deleted_at IS NULL",
    )
      .bind(
        new Date(time).toISOString(),
        new Date(time + 30 * 86400000).toISOString(),
        id,
        this.principal.accountId,
      )
      .run();
  }

  async restore(id: string): Promise<Publication> {
    requireScope(this.principal, "publications:delete");
    requireScope(this.principal, "publications:read");
    const row = await this.env.DB.prepare(
      "UPDATE publications SET deleted_at = NULL, expires_at = NULL, sequence = sequence + 1 WHERE id = ? AND account_id = ? AND expires_at > ? RETURNING id",
    )
      .bind(id, this.principal.accountId, new Date().toISOString())
      .first();
    if (!row)
      throw new HTTPException(404, {
        message: "Recoverable publication not found",
      });
    return (await publicationHistory(this.env, id, this.principal)).publication;
  }

  async setVisibility(
    id: string,
    visibility: Publication["visibility"],
  ): Promise<Publication> {
    requireScope(this.principal, "publications:write");
    requireScope(this.principal, "publications:read");
    const row = await this.env.DB.prepare(
      "UPDATE publications SET visibility = ?, sequence = sequence + 1, updated_at = ? WHERE id = ? AND account_id = ? AND deleted_at IS NULL RETURNING id",
    )
      .bind(visibility, new Date().toISOString(), id, this.principal.accountId)
      .first();
    if (!row)
      throw new HTTPException(404, {
        message: "Publication not found in your account",
      });
    return readPublication(this.env, id, this.principal);
  }

  async upload(
    id: string,
    write: PublicationWrite,
    bytes: Uint8Array,
    kind: "file" | "car" | "block",
    name: string,
    cid?: string,
    schedule?: (work: Promise<void>) => void,
  ): Promise<UploadPublicationResult> {
    requireScope(this.principal, "publications:write");
    const pin = await new PinService(this.env, this.principal, schedule).upload(
      bytes,
      kind,
      name,
      cid,
    );
    try {
      return { pin, publication: await this.publish(id, pin.cid, write) };
    } catch (error) {
      if (!(error instanceof HTTPException))
        console.error(
          JSON.stringify({
            event: "upload_publication_failed",
            publicationId: id,
            cid: pin.cid,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      return {
        pin,
        partialSuccess: true,
        publicationError: {
          status: error instanceof HTTPException ? error.status : 500,
          message:
            error instanceof HTTPException
              ? error.message
              : "Publication failed after successful upload. Retry the same publication request ID and payload.",
        },
      };
    }
  }
}
