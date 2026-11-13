import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify,
} from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";

assert.equal(process.env.PINBOARD_IPNS_TARGET_PROBE, "authorized");
const root = process.cwd();
const worker = join(root, "apps", "worker");
const requireWorker = createRequire(join(worker, "package.json"));
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } =
  requireWorker("miniflare");
const { CID } = requireWorker("multiformats/cid");
const { base36 } = requireWorker("multiformats/bases/base36");
const { unmarshalIPNSRecord } = requireWorker("ipns");
const run = promisify(execFile);
const origin = "https://pinboard.shazhou.work";
const cfBase =
  "https://api.cloudflare.com/client/v4/accounts/92c3c4fdcc84a1590555bccf4f111de2";
const queryPath = "/d1/database/9f15fd50-e103-459f-9f3f-9db3036f91de/query";
const output = resolve(process.argv[2]);
const protectedBackup = `${output}.dpapi`;
const scratch = join(root, `.ipns-target-recovery-${randomUUID()}`);
const bundle = join(scratch, "bundle");
const label = `ipns-cron-recovery-${randomUUID()}`;
const result = {
  label,
  startedAt: new Date().toISOString(),
  publications: [],
  checks: [],
  cleanup: [],
};
const hash = (bytes) => createHash("sha256").update(bytes).digest();
let runtime;
let pin;
let token;
let cfToken;
let master;
let masterBuffer;
let failure;
let localOrigin;
let db;
const localToken = `pb_${randomBytes(32).toString("base64url")}`;
const scopes = [
  "pins:read",
  "pins:write",
  "pins:delete",
  "publications:read",
  "publications:write",
  "publications:delete",
];
async function credential(name) {
  const { stdout } = await run(
    "powershell.exe",
    ["-NoProfile", "-Command", `cfg get --remote ${name}`],
    { timeout: 30000, maxBuffer: 16384, windowsHide: true },
  );
  const value = stdout.trim();
  assert(value && !value.includes("\n"));
  return value;
}
async function api(
  path,
  { method = "GET", body, status = 200, auth = token, base = origin } = {},
) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
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
async function query(sql, params = []) {
  const response = await api(queryPath, {
    method: "POST",
    body: { sql, params },
    auth: cfToken,
    base: cfBase,
  });
  const parsed = await response.json();
  assert.equal(parsed.success, true);
  return parsed.result[0];
}
function independent(name, bytes) {
  const cid = CID.parse(name, base36);
  assert.equal(cid.code, 0x72);
  assert.equal(cid.multihash.code, 0);
  assert.deepEqual(
    Buffer.from(cid.multihash.digest.subarray(0, 4)),
    Buffer.from([8, 1, 18, 32]),
  );
  const parsed = unmarshalIPNSRecord(bytes);
  const key = createPublicKey({
    format: "jwk",
    key: {
      kty: "OKP",
      crv: "Ed25519",
      x: Buffer.from(cid.multihash.digest.subarray(4)).toString("base64url"),
    },
  });
  assert(
    verify(
      null,
      Buffer.concat([Buffer.from("ipns-signature:"), parsed.data]),
      key,
      parsed.signatureV2,
    ),
  );
  assert(Date.parse(parsed.validity) > Date.now());
  assert.equal(parsed.ttl, 300000000000n);
  assert.equal(parsed.value, `/ipfs/${pin}`);
  return parsed;
}
async function checkpoint() {
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
}
async function protect(bytes, unprotect = false) {
  const method = unprotect ? "Unprotect" : "Protect";
  const script = `Add-Type -AssemblyName System.Security; $s=[IO.MemoryStream]::new(); [Console]::OpenStandardInput().CopyTo($s); $b=$s.ToArray(); try { $o=[Security.Cryptography.ProtectedData]::${method}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::OpenStandardOutput().Write($o,0,$o.Length); [Array]::Clear($o,0,$o.Length) } finally { [Array]::Clear($b,0,$b.Length); $s.Dispose() }`;
  return new Promise((resolvePromise, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-Command", script], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.resume();
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolvePromise(Buffer.concat(chunks))
        : reject(new Error("DPAPI backup operation failed")),
    );
    child.stdin.end(bytes);
  });
}
async function scopedSnapshot(id, cid) {
  assert.match(id, /^[a-f0-9-]+$/);
  assert.match(cid, /^[a-z0-9]+$/);
  const object = `SELECT object_key FROM car_dags WHERE root='${cid}'`;
  const filters = {
    publications: `id='${id}'`,
    publication_revisions: `publication_id='${id}'`,
    publication_operations: `publication_id='${id}'`,
    publication_retention: `publication_id='${id}'`,
    publication_ipns: `publication_id='${id}'`,
    storage_objects: `object_key IN (${object})`,
    car_dags: `root='${cid}'`,
    car_blocks: `object_key IN (${object})`,
    object_blocks: `object_key IN (${object})`,
    dag_roots: `root='${cid}'`,
    dag_members: `root='${cid}'`,
    retained_blocks: `cid='${cid}'`,
  };
  const schemas = {};
  const projections = [];
  for (const [table, filter] of Object.entries(filters)) {
    const schema = await query(`PRAGMA table_info(${table})`);
    schemas[table] = schema.results;
    const fields = schema.results.flatMap((column) => [
      `'${column.name}'`,
      column.type === "BLOB" ? `hex("${column.name}")` : `"${column.name}"`,
    ]);
    projections.push(
      `'${table}',json((SELECT json_group_array(json_object(${fields.join(",")})) FROM ${table} WHERE ${filter}))`,
    );
  }
  const snapshot = await query(
    `SELECT json_object(${projections.join(",")}) AS snapshot`,
  );
  assert.equal(snapshot.meta.rows_written, 0);
  return { schemas, rows: JSON.parse(snapshot.results[0].snapshot) };
}
class QuietLog extends Log {
  log() {}
}
try {
  await mkdir(scratch);
  const sid = (
    await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
      ],
      { windowsHide: true },
    )
  ).stdout.trim();
  await run("icacls.exe", [
    scratch,
    "/inheritance:r",
    "/grant:r",
    `*${sid}:(OI)(CI)F`,
    "*S-1-5-18:(OI)(CI)F",
  ]);
  token = await credential("PINBOARD_AGENT_TOKEN");
  cfToken = await credential("CLOUDFLARE_API_TOKEN");
  result.commit = (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
  const baseline = await query(
    "SELECT count(*) AS live FROM publication_ipns i JOIN publications p ON p.id=i.publication_id WHERE p.deleted_at IS NULL",
  );
  result.liveBefore = baseline.results[0].live;
  assert.equal(
    result.liveBefore,
    0,
    "Capacity probe requires an empty live baseline",
  );
  const text = `${label}-raw`;
  const uploaded = await fetch(
    `${origin}/api/pins/upload?kind=file&name=${label}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: text,
      signal: AbortSignal.timeout(60000),
    },
  );
  assert.equal(uploaded.status, 201);
  pin = (await uploaded.json()).cid;
  result.pin = pin;
  for (let index = 0; index < 32; index++) {
    const created = await (
      await api("/api/publications", {
        method: "POST",
        status: 201,
        body: { title: `${label}-${index}`, cid: pin, requestId: randomUUID() },
      })
    ).json();
    const id = created.publication.id;
    result.publications.push({ id });
    await checkpoint();
    const enabled = await (
      await api(`/api/publications/${id}/ipns`, { method: "POST", body: {} })
    ).json();
    result.publications.at(-1).name = enabled.name;
  }
  await checkpoint();
  const first = result.publications[0];
  const before = await scopedSnapshot(first.id, pin);
  const carResponse = await api(
    `/api/public/publications/${first.id}/download?format=car`,
  );
  const car = Buffer.from(await carResponse.arrayBuffer());
  assert.equal(car.length, before.rows.car_dags[0].size);
  assert(carResponse.headers.get("etag"));
  const secondCarResponse = await api(
    `/api/public/publications/${first.id}/download?format=car`,
  );
  assert.equal(
    secondCarResponse.headers.get("etag"),
    carResponse.headers.get("etag"),
  );
  assert.deepEqual(
    hash(Buffer.from(await secondCarResponse.arrayBuffer())),
    hash(car),
  );
  const location = before.rows.car_blocks.find((row) => row.cid === pin);
  assert(location);
  assert.deepEqual(
    hash(
      car.subarray(
        location.byte_offset,
        location.byte_offset + location.byte_length,
      ),
    ),
    Buffer.from(CID.parse(pin).multihash.digest),
  );
  const after = await scopedSnapshot(first.id, pin);
  assert.deepEqual(before.rows, after.rows);
  const backup = Buffer.from(
    JSON.stringify({ snapshot: before, car: car.toString("base64") }),
  );
  await writeFile(protectedBackup, await protect(backup), { flag: "wx" });
  const restoredBytes = await protect(await readFile(protectedBackup), true);
  assert.deepEqual(hash(restoredBytes), hash(backup));
  const recovered = JSON.parse(restoredBytes.toString("utf8"));
  backup.fill(0);
  restoredBytes.fill(0);
  result.backup = {
    scoped: true,
    tables: Object.keys(before.rows),
    carSha256: hash(car).toString("hex"),
    stableBeforeAfter: true,
    dpapiRoundtrip: true,
  };
  const decrypted = await run(
    "C:\\Program Files\\Git\\usr\\bin\\gpg.exe",
    [
      "--no-symkey-cache",
      "--decrypt",
      "C:\\Users\\Wei\\Downloads\\ipns-master.asc",
    ],
    {
      encoding: "buffer",
      timeout: 180000,
      maxBuffer: 16384,
      windowsHide: true,
    },
  );
  masterBuffer = decrypted.stdout;
  master = masterBuffer.toString("utf8").trim();
  assert.match(master, /^[a-fA-F0-9]{64}$/);
  masterBuffer.fill(0);
  await run(
    process.execPath,
    [
      join(root, "node_modules", "wrangler", "bin", "wrangler.js"),
      "deploy",
      "--dry-run",
      "--outdir",
      relative(worker, bundle),
    ],
    {
      cwd: worker,
      timeout: 120000,
      maxBuffer: 1048576,
      env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
    },
  );
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      host: "127.0.0.1",
      port: 0,
      unsafeTriggerHandlers: true,
      log: new QuietLog(LogLevel.ERROR),
      modules: [
        { type: "ESModule", path: join(bundle, "index.js") },
        ...(await readdir(bundle))
          .filter((name) => /\.(wasm|ttf)$/u.test(name))
          .map((name) => ({
            type: name.endsWith(".wasm") ? "CompiledWasm" : "Data",
            path: join(bundle, name),
          })),
      ],
      compatibilityDate: "2026-10-14",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: ["DB"],
      r2Buckets: ["BLOCKS"],
      resourcePersistencePath: join(scratch, "restored"),
      resourceTmpPath: join(scratch, "runtime"),
      bindings: {
        APP_NAME: "IPNS recovery",
        PUBLIC_ORIGIN: "http://127.0.0.1",
        AUTH_SECRET: randomBytes(32).toString("hex"),
        IPNS_MASTER_KEY: master,
      },
    }),
  );
  localOrigin = (await runtime.ready).origin;
  await api("/api/health", { base: localOrigin, auth: null });
  const bindings = await runtime.getBindings();
  db = bindings.DB;
  for (const name of (await readdir(join(worker, "migrations")))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    const sql = await readFile(join(worker, "migrations", name), "utf8");
    await db.batch(
      sql
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => db.prepare(part)),
    );
  }
  const owner = recovered.snapshot.rows.publications[0].account_id;
  await db
    .prepare(
      "INSERT INTO accounts(id,provider,subject) VALUES (?,'google','synthetic-recovery-owner')",
    )
    .bind(owner)
    .run();
  const order = [
    "storage_objects",
    "car_dags",
    "car_blocks",
    "object_blocks",
    "dag_roots",
    "dag_members",
    "retained_blocks",
    "publications",
    "publication_revisions",
    "publication_operations",
    "publication_retention",
    "publication_ipns",
  ];
  for (const table of order) {
    for (const row of recovered.snapshot.rows[table]) {
      const columns = recovered.snapshot.schemas[table];
      await db
        .prepare(
          `INSERT INTO ${table} (${columns.map((column) => `"${column.name}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
        )
        .bind(
          ...columns.map((column) =>
            column.type === "BLOB"
              ? [...Buffer.from(row[column.name], "hex")]
              : row[column.name],
          ),
        )
        .run();
    }
  }
  await bindings.BLOCKS.put(
    recovered.snapshot.rows.car_dags[0].object_key,
    Buffer.from(recovered.car, "base64"),
  );
  await db
    .prepare(
      "INSERT INTO agent_tokens(id,account_id,name,prefix,token_hash,scopes,expires_at) VALUES (?,?,?,?,?,?,?)",
    )
    .bind(
      randomUUID(),
      owner,
      "local recovery",
      localToken.slice(0, 11),
      hash(localToken).toString("hex"),
      JSON.stringify(scopes),
      new Date(Date.now() + 7200000).toISOString(),
    )
    .run();
  const local = { base: localOrigin, auth: localToken };
  const recordPath = `/ipns/${first.name}?format=ipns-record`;
  await api(recordPath, { base: localOrigin, auth: null, status: 404 });
  await api(`/ipfs/${pin}?format=raw`, {
    base: localOrigin,
    auth: null,
    status: 404,
  });
  const raw = Buffer.from(
    await (await api(`/ipfs/${pin}?format=raw`, local)).arrayBuffer(),
  );
  assert.equal(raw.toString("utf8"), text);
  assert.deepEqual(hash(raw), Buffer.from(CID.parse(pin).multihash.digest));
  const original = Buffer.from(
    await (await api(recordPath, local)).arrayBuffer(),
  );
  independent(first.name, original);
  const oldHistory = await (
    await api(`/api/public/publications/${first.id}/history`, local)
  ).json();
  await db
    .prepare("UPDATE publication_ipns SET expires_at=? WHERE publication_id=?")
    .bind(Date.now() - 1, first.id)
    .run();
  const fresh = Buffer.from(await (await api(recordPath, local)).arrayBuffer());
  const parsed = independent(first.name, fresh);
  assert.equal(parsed.sequence, 0n);
  assert.notDeepEqual(fresh, original);
  assert.deepEqual(
    await (
      await api(`/api/public/publications/${first.id}/history`, local)
    ).json(),
    oldHistory,
  );
  result.recovery = {
    at: new Date().toISOString(),
    origin: localOrigin,
    name: first.name,
    sequence: 0,
    freshSignatureSha256: hash(fresh).toString("hex"),
    rawCid: pin,
    privateRejection: true,
    unchangedHistory: true,
  };
  await runtime.dispose();
  runtime = undefined;
  master = undefined;
  await checkpoint();
  const placeholders = result.publications.map(() => "?").join(",");
  const ids = result.publications.map((item) => item.id);
  const dueAt = Date.now() + 6 * 3600000;
  const injected = await query(
    `UPDATE publication_ipns SET expires_at=? WHERE publication_id IN (${placeholders}) AND sequence=0`,
    [dueAt, ...ids],
  );
  assert.equal(injected.meta.changes, 32);
  result.cron = {
    waitingSince: new Date().toISOString(),
    injectedRows: 32,
    metadataEol: new Date(dueAt).toISOString(),
    note: "Synthetic-only metadata injection; stored signatures retain actual EOL. No signing/record reads while awaiting real cron.",
  };
  await checkpoint();
  const deadline = Date.now() + 65 * 60000;
  let observed;
  do {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 60000));
    const state = await query(
      `SELECT count(*) AS total,sum(CASE WHEN generation=1 AND expires_at>? THEN 1 ELSE 0 END) AS renewed,min(expires_at) AS min_eol,max(generation) AS max_generation FROM publication_ipns WHERE publication_id IN (${placeholders})`,
      [dueAt, ...ids],
    );
    observed = state.results[0];
    if (observed.renewed === 32) break;
    assert(
      Date.now() < deadline,
      "Real cron renewal did not complete within 65 minutes",
    );
  } while (true);
  const cronHistory = await (
    await api(`/api/public/publications/${first.id}/history`)
  ).json();
  assert.deepEqual(cronHistory, oldHistory);
  const cronBytes = Buffer.from(await (await api(recordPath)).arrayBuffer());
  const cronRecord = independent(first.name, cronBytes);
  assert.equal(cronRecord.sequence, 0n);
  result.cron = {
    ...result.cron,
    observedAt: new Date().toISOString(),
    ...observed,
    sequence: cronRecord.sequence.toString(),
    verifiedRecordSha256: hash(cronBytes).toString("hex"),
    unchangedHistory: true,
  };
  result.checks.push(
    "Consistent synthetic-publication D1 snapshot and exact production CAR DPAPI backup restored into restricted loopback workerd with actual master; fresh signature, unchanged history, private HTTP rejection and raw CID verified",
  );
  result.checks.push(
    "32 synthetic bindings renewed by actual production cron, no manual scheduled invocation or read-triggered renewal before generation observation; current empty-baseline batch demonstrated, not unlimited capacity/SLA",
  );
} catch (error) {
  failure = error;
  result.failure =
    error instanceof Error ? error.message : "Verification failed";
  if (result.failure.includes("Command failed:"))
    result.failure =
      "External decryption/build command failed; diagnostics suppressed";
} finally {
  try {
    await runtime?.dispose();
    for (const item of result.publications) {
      await api(`/api/publications/${item.id}`, {
        method: "DELETE",
        status: 204,
      });
      result.cleanup.push(item.id);
    }
    if (pin) await api(`/api/pins/${pin}`, { method: "DELETE", status: 204 });
    result.normalSoftDelete = true;
  } catch {
    result.cleanupFailure =
      "Normal API cleanup failed; use recorded owned IDs to recover";
    failure ??= new Error(result.cleanupFailure);
  }
  masterBuffer?.fill(0);
  master = undefined;
  token = undefined;
  cfToken = undefined;
  await rm(scratch, { recursive: true, force: true });
  result.finishedAt = new Date().toISOString();
  result.passed = !failure;
  await checkpoint();
}
console.log(JSON.stringify(result, null, 2));
if (failure) process.exitCode = 1;
