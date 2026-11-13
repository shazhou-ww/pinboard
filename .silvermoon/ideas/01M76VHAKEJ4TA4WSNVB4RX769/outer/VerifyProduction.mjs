import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const root = process.cwd();
const requireWorker = createRequire(
  join(root, "apps", "worker", "package.json"),
);
const { CID } = requireWorker("multiformats/cid");
const { base36 } = requireWorker("multiformats/bases/base36");
const { unmarshalIPNSRecord } = requireWorker("ipns");
const { decode } = requireWorker("@ipld/dag-cbor");
const origin = "https://pinboard.shazhou.work";
const output = resolve(process.argv[2] ?? "ipns-production-result.json");
assert.equal(process.env.PINBOARD_IPNS_PRODUCTION_PROBE, "authorized");
const token = execFileSync(
  "powershell.exe",
  ["-NoProfile", "-Command", "cfg get --remote PINBOARD_AGENT_TOKEN"],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
).trim();
assert(token && !token.includes("\n"));
const result = {
  startedAt: new Date().toISOString(),
  commit: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  node: process.version,
  origin,
  label: `ipns-acceptance-${randomUUID()}`,
  checks: [],
  pins: [],
  cleanup: [],
};
let publicationId;
let deleted = false;
let failure;
const hash = (bytes) => createHash("sha256").update(bytes).digest();

async function request(
  path,
  { method = "GET", body, auth = true, status = 200, headers = {} } = {},
) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
    redirect: "error",
  });
  if (response.status !== status) {
    await response.body?.cancel();
    throw new Error(
      `${method} ${path}: expected ${status}, got ${response.status}`,
    );
  }
  return response;
}
async function json(path, options) {
  return (await request(path, options)).json();
}
function independent(name, bytes) {
  const cid = CID.parse(name, base36);
  assert.equal(cid.code, 0x72);
  assert.equal(cid.multihash.code, 0);
  assert.deepEqual(
    Buffer.from(cid.multihash.digest.subarray(0, 4)),
    Buffer.from([8, 1, 18, 32]),
  );
  const key = createPublicKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      x: Buffer.from(cid.multihash.digest.subarray(4)).toString("base64url"),
    },
    format: "jwk",
  });
  const record = unmarshalIPNSRecord(bytes);
  assert(
    verify(
      null,
      Buffer.concat([Buffer.from("ipns-signature:"), record.data]),
      key,
      record.signatureV2,
    ),
  );
  const signed = decode(record.data);
  assert.equal(new TextDecoder().decode(signed.Value), record.value);
  assert.equal(BigInt(signed.Sequence), record.sequence);
  assert.equal(new TextDecoder().decode(signed.Validity), record.validity);
  assert.equal(Number(signed.ValidityType), 0);
  assert(Date.parse(record.validity) > Date.now());
  assert.equal(record.ttl, 300000000000n);
  assert(bytes.length <= 10240);
  return record;
}
async function record(name, auth = true) {
  const response = await request(`/ipns/${name}?format=ipns-record`, { auth });
  assert.equal(
    response.headers.get("content-type"),
    "application/vnd.ipfs.ipns-record",
  );
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const bytes = Buffer.from(await response.arrayBuffer());
  return { parsed: independent(name, bytes), bytes, headers: response.headers };
}
async function current() {
  return json(`/api/publications/${publicationId}`);
}
async function mutate(action, body) {
  return json(`/api/publications/${publicationId}/${action}`, {
    method: "POST",
    body: {
      ...body,
      requestId: randomUUID(),
      expectedSequence: (await current()).sequence,
    },
  });
}
try {
  await json("/api/health", { auth: false });
  await json("/api/publications");
  for (const suffix of ["first", "second"]) {
    const text = `${result.label}-${suffix}`;
    const response = await fetch(
      `${origin}/api/pins/upload?kind=file&name=${result.label}-${suffix}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: text,
        signal: AbortSignal.timeout(60000),
        redirect: "error",
      },
    );
    assert.equal(response.status, 201);
    const pin = await response.json();
    result.pins.push(pin.cid);
    const raw = Buffer.from(
      await (await request(`/ipfs/${pin.cid}?format=raw`)).arrayBuffer(),
    );
    const cid = CID.parse(pin.cid);
    assert.equal(cid.code, 0x55);
    assert.equal(cid.multihash.code, 0x12);
    assert.deepEqual(hash(raw), Buffer.from(cid.multihash.digest));
    assert.equal(raw.toString(), text);
    await request(`/ipfs/${pin.cid}?format=raw`, { auth: false, status: 404 });
  }
  const created = await json("/api/publications", {
    method: "POST",
    status: 201,
    body: { title: result.label, cid: result.pins[0], requestId: randomUUID() },
  });
  publicationId = created.publication.id;
  result.publicationId = publicationId;
  const metadataPath = `/api/publications/${publicationId}/ipns`;
  assert.equal((await json(metadataPath)).enabled, false);
  const enabled = await json(metadataPath, { method: "POST", body: {} });
  const name = enabled.name;
  result.name = name;
  const path = `/ipns/${name}?format=ipns-record`;
  await request(path, { auth: false, status: 404 });
  const original = await record(name);
  assert.equal(original.parsed.sequence, 0n);
  assert.equal(original.parsed.value, `/ipfs/${result.pins[0]}`);
  const etag = original.headers.get("etag");
  assert(etag);
  await request(path, { headers: { "if-none-match": etag }, status: 304 });
  const head = await request(path, { method: "HEAD" });
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal(
    Number(head.headers.get("content-length")),
    original.bytes.length,
  );
  await request(`/ipns/${name}`, {
    headers: { accept: "application/vnd.ipfs.ipns-record" },
  });
  await request(`${path}&extra=1`, { status: 406 });
  await request(path, {
    headers: { accept: "application/vnd.ipfs.ipns-record;q=0" },
    status: 406,
  });
  const tampered = Buffer.from(original.bytes);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => independent(name, tampered));
  result.checks.push(
    "HTTPS raw CID verification, private rejection, independent Ed25519/name/CBOR/EOL verification, tamper rejection, HEAD/ETag/Accept",
  );
  const same = await json(metadataPath, { method: "POST", body: {} });
  assert.equal(same.name, name);
  await mutate("publish", { cid: result.pins[1] });
  const updated = await record(name);
  assert.equal(updated.parsed.sequence, 1n);
  assert.equal(updated.parsed.value, `/ipfs/${result.pins[1]}`);
  await mutate("rollback", { revision: 1 });
  const rolledBack = await record(name);
  assert.equal(rolledBack.parsed.sequence, 2n);
  assert.equal(rolledBack.parsed.value, `/ipfs/${result.pins[0]}`);
  const beforeEdit = await current();
  await json(`/api/publications/${publicationId}`, {
    method: "PATCH",
    body: {
      title: `${result.label}-edited`,
      description: "",
      expectedSequence: beforeEdit.sequence,
      requestId: randomUUID(),
    },
  });
  assert.deepEqual((await record(name)).bytes, rolledBack.bytes);
  await json(`/api/publications/${publicationId}/visibility`, {
    method: "PATCH",
    body: { visibility: "public", acknowledge: true },
  });
  await record(name, false);
  await json(`/api/publications/${publicationId}/visibility`, {
    method: "PATCH",
    body: { visibility: "private", acknowledge: true },
  });
  await request(path, {
    auth: false,
    headers: { "if-none-match": "*" },
    status: 404,
  });
  result.checks.push(
    "Idempotent enable, publication update sequence 0→1, rollback 1→2, metadata does not resign, public/private conditional authorization",
  );
  await request(`/api/publications/${publicationId}`, {
    method: "DELETE",
    status: 204,
  });
  deleted = true;
  await request(path, { status: 404 });
  await request(`/api/publications/${publicationId}/restore`, {
    method: "POST",
  });
  deleted = false;
  const restored = await record(name);
  assert.deepEqual(restored.bytes, rolledBack.bytes);
  const history = await json(`/api/publications/${publicationId}/history`);
  assert(history);
  result.finalRecord = {
    sha256: hash(restored.bytes).toString("hex"),
    sequence: restored.parsed.sequence.toString(),
    value: restored.parsed.value,
    eol: restored.parsed.validity,
    bytes: restored.bytes.length,
  };
  result.checks.push(
    "Delete stops serving; restore preserves name, sequence and signed bytes; business history remains readable",
  );
} catch (error) {
  failure = error;
  result.failure = error instanceof Error ? error.message : String(error);
} finally {
  try {
    if (publicationId && !deleted) {
      await request(`/api/publications/${publicationId}`, {
        method: "DELETE",
        status: 204,
      });
      result.cleanup.push("Publication soft-deleted through normal API");
    }
    if (result.name)
      await request(`/ipns/${result.name}?format=ipns-record`, { status: 404 });
    for (const cid of result.pins) {
      await request(`/api/pins/${cid}`, { method: "DELETE", status: 204 });
      result.cleanup.push(`Pin soft-deleted: ${cid}`);
    }
    result.cleanup.push(
      "No retention bypass or physical deletion; objects remain subject to normal recovery window",
    );
  } catch (error) {
    result.cleanupFailure =
      error instanceof Error ? error.message : String(error);
    failure ??= error;
  }
  result.finishedAt = new Date().toISOString();
  result.passed = !failure;
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
}
if (failure) throw failure;
console.log(JSON.stringify(result, null, 2));
