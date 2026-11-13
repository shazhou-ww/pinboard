import {
  generateKeyPair,
  privateKeyFromProtobuf,
  privateKeyToProtobuf,
  publicKeyFromMultihash,
  publicKeyToProtobuf,
} from "@libp2p/crypto/keys";
import {
  createIPNSRecordWithExpiration,
  marshalIPNSRecord,
  unmarshalIPNSRecord,
} from "ipns";
import { validate as validateRecord } from "ipns/validator";
import { CID } from "multiformats/cid";
import { base36 } from "multiformats/bases/base36";
import { HTTPException } from "hono/http-exception";
import type { Bindings } from "./env.js";
import { blobBytes, type D1Blob } from "./storage.js";
import { requireScope, type Principal } from "./identity.js";

export const IPNS_LIFETIME = 24 * 60 * 60 * 1000;
export const IPNS_RENEW_BEFORE = IPNS_LIFETIME / 2;
export const IPNS_TTL_NS = 300_000_000_000n;
export const IPNS_BATCH = 32;
const unavailable = () =>
  new HTTPException(503, { message: "IPNS signing or record unavailable" });
const changed = () =>
  new HTTPException(409, { message: "Publication changed; retry IPNS operation" });

export interface IpnsBinding {
  publication_id: string;
  name: string;
  public_key: D1Blob;
  key_version: number;
  encrypted_key: D1Blob;
  nonce: D1Blob;
  record: D1Blob;
  record_cid: string;
  sequence: number;
  generation: number;
  expires_at: number;
}

export function parseIpnsName(name: string) {
  try {
    const cid = CID.parse(name, base36);
    if (cid.version !== 1 || cid.code !== 0x72 || cid.multihash.code !== 0)
      throw new Error("Not an inline libp2p key");
    const publicKey = publicKeyFromMultihash(cid.multihash);
    if (publicKey.type !== "Ed25519" || cid.toString(base36) !== name)
      throw new Error("Not a canonical Ed25519 name");
    return publicKey;
  } catch {
    throw new HTTPException(400, { message: "Invalid Ed25519 IPNS name" });
  }
}

async function masterKey(env: Bindings): Promise<CryptoKey> {
  const secret = env.IPNS_MASTER_KEY;
  if (!secret || !/^[0-9a-fA-F]{64}$/.test(secret)) throw unavailable();
  const bytes = Uint8Array.from(
    secret.match(/../g)!,
    (part) => Number.parseInt(part, 16),
  );
  try {
    return await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
  } finally {
    bytes.fill(0);
  }
}

function aad(id: string, name: string, version: number) {
  return new TextEncoder().encode(JSON.stringify(["pinboard-ipns", version, id, name]));
}

async function unwrap(env: Bindings, row: IpnsBinding) {
  const master = await masterKey(env);
  let bytes: Uint8Array | undefined;
  try {
    if (row.key_version !== 1) throw unavailable();
    bytes = new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: blobBytes(row.nonce),
        additionalData: aad(row.publication_id, row.name, row.key_version) },
      master,
      blobBytes(row.encrypted_key),
    ));
    const key = privateKeyFromProtobuf(bytes);
    if (key.type !== "Ed25519" ||
      key.publicKey.toCID().toString(base36) !== row.name ||
      !publicKeyToProtobuf(key.publicKey).every((byte, i) => byte === blobBytes(row.public_key)[i]))
      throw unavailable();
    return key;
  } catch {
    throw unavailable();
  } finally {
    bytes?.fill(0);
  }
}

async function sign(
  key: Awaited<ReturnType<typeof unwrap>>,
  cid: string,
  sequence: number,
) {
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw unavailable();
  const expires = Date.now() + IPNS_LIFETIME;
  const record = marshalIPNSRecord(await createIPNSRecordWithExpiration(
    key, `/ipfs/${cid}`, sequence, new Date(expires).toISOString(),
    { ttlNs: IPNS_TTL_NS, v1Compatible: false },
  ));
  if (record.length > 10240) throw unavailable();
  return { record, expires };
}

export async function ipnsBinding(env: Bindings, id: string) {
  return env.DB.prepare("SELECT * FROM publication_ipns WHERE publication_id = ?")
    .bind(id).first<IpnsBinding>();
}

function metadata(row: IpnsBinding | null) {
  return row ? {
    enabled: true, name: row.name, sequence: row.sequence,
    value: `/ipfs/${row.record_cid}`,
    expiresAt: new Date(row.expires_at).toISOString(),
    ttlSeconds: 300, lifetimeSeconds: 86400, custody: "pinboard",
  } : { enabled: false };
}

async function owned(env: Bindings, principal: Principal, id: string) {
  requireScope(principal, "publications:read");
  const row = await env.DB.prepare(
    `SELECT p.sequence, p.visibility, r.cid FROM publications p
    JOIN publication_revisions r ON r.publication_id = p.id AND r.revision = p.current_revision
    WHERE p.id = ? AND p.account_id = ? AND p.deleted_at IS NULL`,
  ).bind(id, principal.accountId).first<{ sequence: number; visibility: string; cid: string }>();
  if (!row) throw new HTTPException(404, { message: "Publication not found" });
  return row;
}

export async function publicationIpns(env: Bindings, principal: Principal, id: string) {
  await owned(env, principal, id);
  return metadata(await ipnsBinding(env, id));
}

export async function enableIpns(
  env: Bindings, principal: Principal, id: string, acknowledgePublicExposure: boolean,
) {
  requireScope(principal, "publications:write");
  const current = await owned(env, principal, id);
  const existing = await ipnsBinding(env, id);
  if (existing) return metadata(existing);
  if (current.visibility === "public" && !acknowledgePublicExposure)
    throw new HTTPException(400, { message: "Confirm public IPNS pointer exposure and Pinboard key custody" });
  const master = await masterKey(env);
  const key = await generateKeyPair("Ed25519");
  const name = key.publicKey.toCID().toString(base36);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const bytes = privateKeyToProtobuf(key);
  let encrypted: ArrayBuffer;
  try {
    encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: aad(id, name, 1) }, master, bytes,
    );
  } finally {
    bytes.fill(0);
  }
  const signed = await sign(key, current.cid, 0);
  await env.DB.prepare(
    `INSERT INTO publication_ipns
    (publication_id, name, public_key, encrypted_key, nonce, record, record_cid, sequence, expires_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, 0, ? WHERE EXISTS
    (SELECT 1 FROM publications WHERE id = ? AND account_id = ? AND deleted_at IS NULL AND sequence = ?)
    ON CONFLICT(publication_id) DO NOTHING`,
  ).bind(id, name, publicKeyToProtobuf(key.publicKey), encrypted, nonce, signed.record,
    current.cid, signed.expires, id, principal.accountId, current.sequence).run();
  await owned(env, principal, id);
  const saved = await ipnsBinding(env, id);
  if (!saved) throw changed();
  return metadata(saved);
}

// The business request fence includes the binding generation (or its absence).
// Its signed bytes are only persisted in the same transaction as the CID change.
export async function prepareIpnsChange(env: Bindings, id: string, cid: string) {
  const row = await ipnsBinding(env, id);
  if (!row) return {
    guard: "NOT EXISTS (SELECT 1 FROM publication_ipns WHERE publication_id = ?)",
    values: [id] as (string | number)[],
    statements: (_attempt: string) => [] as D1PreparedStatement[],
  };
  const key = await unwrap(env, row);
  const sequence = row.sequence + (cid === row.record_cid ? 0 : 1);
  const signed = await sign(key, cid, sequence);
  return {
    guard: "EXISTS (SELECT 1 FROM publication_ipns WHERE publication_id = ? AND generation = ?)",
    values: [id, row.generation],
    statements: (attempt: string) => [
      env.DB.prepare(
        `UPDATE publication_ipns SET record = ?, record_cid = ?, sequence = ?,
        expires_at = ?, generation = generation + 1, retry_at = 0
        WHERE publication_id = ? AND EXISTS (SELECT 1 FROM publication_requests WHERE attempt_id = ?)`,
      ).bind(signed.record, cid, sequence, signed.expires, id, attempt),
    ],
  };
}

export async function renewIpns(env: Bindings, row: IpnsBinding) {
  const signed = await sign(await unwrap(env, row), row.record_cid, row.sequence);
  return env.DB.prepare(
    `UPDATE publication_ipns SET record = ?, expires_at = ?, generation = generation + 1, retry_at = 0
    WHERE publication_id = ? AND generation = ? AND EXISTS
    (SELECT 1 FROM publications p JOIN publication_revisions r
    ON r.publication_id = p.id AND r.revision = p.current_revision
    WHERE p.id = publication_ipns.publication_id AND p.deleted_at IS NULL AND r.cid = publication_ipns.record_cid)`,
  ).bind(signed.record, signed.expires, row.publication_id, row.generation).run();
}

export async function checkedIpnsBytes(row: IpnsBinding) {
  const bytes = blobBytes(row.record);
  try {
    if (bytes.length > 10240 || row.expires_at <= Date.now()) throw unavailable();
    await validateRecord(parseIpnsName(row.name), bytes);
    const record = unmarshalIPNSRecord(bytes);
    if (record.value !== `/ipfs/${row.record_cid}` ||
      record.sequence !== BigInt(row.sequence) ||
      record.ttl !== IPNS_TTL_NS ||
      Date.parse(record.validity) !== row.expires_at) throw unavailable();
  } catch {
    throw unavailable();
  }
  return bytes;
}

export async function runIpnsRenewal(env: Bindings): Promise<void> {
  const now = Date.now();
  const due = await env.DB.prepare(
    `SELECT i.* FROM publication_ipns i JOIN publications p ON p.id = i.publication_id
    WHERE p.deleted_at IS NULL AND i.retry_at <= ? AND i.expires_at < ?
    ORDER BY i.retry_at, i.expires_at, i.publication_id LIMIT ?`,
  ).bind(now, now + IPNS_RENEW_BEFORE, IPNS_BATCH).all<IpnsBinding>();
  for (const row of due.results) {
    try {
      await renewIpns(env, row);
    } catch {
      // No keys, names, account IDs, CIDs, SQL, or exception text in cron logs.
      console.error(JSON.stringify({ event: "ipns_renewal_failed", reason: "sign_or_persist" }));
      await env.DB.prepare(
        "UPDATE publication_ipns SET retry_at = ? WHERE publication_id = ? AND generation = ?",
      ).bind(now + 3600000, row.publication_id, row.generation).run();
    }
  }
}
