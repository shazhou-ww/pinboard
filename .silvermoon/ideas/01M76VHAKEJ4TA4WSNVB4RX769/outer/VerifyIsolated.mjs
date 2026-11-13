import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify,
} from "node:crypto";
import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const root = process.cwd();
const worker = join(root, "apps", "worker");
const requireWorker = createRequire(join(worker, "package.json"));
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } =
  requireWorker("miniflare");
const { CID } = requireWorker("multiformats/cid");
const { base36 } = requireWorker("multiformats/bases/base36");
const {
  unmarshalIPNSRecord,
  createIPNSRecordWithExpiration,
  marshalIPNSRecord,
} = requireWorker("ipns");
const { generateKeyPair } = requireWorker("@libp2p/crypto/keys");
const { decode } = requireWorker("@ipld/dag-cbor");
const scratch = join(root, `.ipns-outer-runtime-${randomUUID()}`);
const bundle = join(scratch, "bundle");
const live = join(scratch, "live");
const restored = join(scratch, "restored");
const master = randomBytes(32).toString("hex");
const token = `pb_${randomBytes(32).toString("base64url")}`;
const foreignToken = `pb_${randomBytes(32).toString("base64url")}`;
const scopes = [
  "pins:read",
  "pins:write",
  "pins:delete",
  "publications:read",
  "publications:write",
  "publications:delete",
];
const checks = [];
const captured = [];
let runtime;
let db;
let origin;
let initialOrigin;
let finalOrigin;
const media = "application/vnd.ipfs.ipns-record";
const hash = (bytes) => createHash("sha256").update(bytes).digest();
const blob = (value) =>
  Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
class CapturedLog extends Log {
  log(message) {
    captured.push(String(message));
  }
}
async function version(name) {
  return JSON.parse(
    await readFile(
      join(worker, "node_modules", ...name.split("/"), "package.json"),
      "utf8",
    ),
  ).version;
}
async function start(persistence, signingMaster = master) {
  const bindings = {
    APP_NAME: "IPNS 隔离部署验证",
    PUBLIC_ORIGIN: "http://127.0.0.1",
    AUTH_SECRET: randomBytes(32).toString("hex"),
  };
  if (signingMaster !== undefined) bindings.IPNS_MASTER_KEY = signingMaster;
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      host: "127.0.0.1",
      port: 0,
      unsafeTriggerHandlers: true,
      log: new CapturedLog(LogLevel.VERBOSE),
      handleStructuredLogs: (entry) => captured.push(JSON.stringify(entry)),
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
      resourcePersistencePath: persistence,
      resourceTmpPath: join(scratch, `runtime-${randomUUID()}`),
      bindings,
    }),
  );
  origin = (await runtime.ready).origin;
  db = (await runtime.getBindings()).DB;
  assert.equal((await fetch(`${origin}/api/health`)).status, 200);
}
async function stop() {
  await runtime?.dispose();
  runtime = undefined;
}
async function request(
  path,
  { method = "GET", body, auth = token, headers = {}, status = 200 } = {},
) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal(
    response.status,
    status,
    `${method} ${path}: ${response.status}`,
  );
  return response;
}
async function json(path, options) {
  return (await request(path, options)).json();
}
async function current(id) {
  return json(`/api/publications/${id}`);
}
async function binding(id) {
  return db
    .prepare("SELECT * FROM publication_ipns WHERE publication_id = ?")
    .bind(id)
    .first();
}
async function record(name, auth = token, extra = {}) {
  const response = await request(`/ipns/${name}?format=ipns-record`, {
    auth,
    ...extra,
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  const parsed = independent(name, bytes);
  return { bytes, parsed, headers: response.headers };
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
  const parsed = unmarshalIPNSRecord(bytes);
  assert(
    verify(
      null,
      Buffer.concat([Buffer.from("ipns-signature:"), parsed.data]),
      key,
      parsed.signatureV2,
    ),
  );
  const signed = decode(parsed.data);
  assert.equal(new TextDecoder().decode(signed.Value), parsed.value);
  assert.equal(BigInt(signed.Sequence), parsed.sequence);
  assert.equal(new TextDecoder().decode(signed.Validity), parsed.validity);
  assert.equal(Number(signed.ValidityType), 0);
  assert(Date.parse(parsed.validity) > Date.now());
  return parsed;
}
async function trigger(status = 200) {
  const start = performance.now();
  await request("/cdn-cgi/local/scheduled?cron=17%20*%20*%20*%20*", {
    auth: undefined,
    status,
  });
  return Math.round(performance.now() - start);
}
async function upload(text) {
  const response = await fetch(
    `${origin}/api/pins/upload?kind=file&name=isolated`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: text,
    },
  );
  assert.equal(response.status, 201);
  return response.json();
}
async function create(pin) {
  const result = await json("/api/publications", {
    method: "POST",
    status: 201,
    body: { title: "隔离 IPNS", cid: pin.cid, requestId: randomUUID() },
  });
  return result.publication.id;
}
async function enable(id) {
  return json(`/api/publications/${id}/ipns`, { method: "POST", body: {} });
}
async function mutate(id, action, body) {
  return json(`/api/publications/${id}/${action}`, {
    method: "POST",
    body: {
      ...body,
      requestId: randomUUID(),
      expectedSequence: (await current(id)).sequence,
    },
  });
}
async function seedCredentials() {
  for (const [id, credential] of [
    ["outer-owner", token],
    ["outer-foreign", foreignToken],
  ]) {
    await db
      .prepare(
        "INSERT INTO accounts (id, provider, subject) VALUES (?, 'google', ?)",
      )
      .bind(id, id)
      .run();
    await db
      .prepare(
        "INSERT INTO agent_tokens (id, account_id, name, prefix, token_hash, scopes, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        randomUUID(),
        id,
        "隔离凭据",
        credential.slice(0, 11),
        hash(credential).toString("hex"),
        JSON.stringify(scopes),
        new Date(Date.now() + 86400000).toISOString(),
      )
      .run();
  }
}

await mkdir(scratch);
try {
  const commit = (
    await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: root })
  ).stdout.trim();
  const contractBlob = (
    await promisify(execFile)(
      "git",
      [
        "rev-parse",
        "HEAD:.silvermoon/ideas/01M76VHAKEJ4TA4WSNVB4RX769/outer/Deployment.md",
      ],
      { cwd: root },
    )
  ).stdout.trim();
  await promisify(execFile)(
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
      env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
    },
  );
  await start(live);
  initialOrigin = origin;
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
  await seedCredentials();
  const firstText = "隔离外部 HTTP first";
  const first = await upload(firstText);
  const second = await upload("隔离外部 HTTP second");
  const id = await create(first);
  const info = await enable(id);
  const name = info.name;
  const path = `/ipns/${name}?format=ipns-record`;
  await request(path, { auth: null, status: 404 });
  await request(path, { auth: foreignToken, status: 404 });
  const original = await record(name);
  assert.equal(original.parsed.value, `/ipfs/${first.cid}`);
  assert.equal(original.parsed.sequence, 0n);
  assert.equal(original.parsed.ttl, 300000000000n);
  assert(original.bytes.length <= 10240);
  assert.equal(original.headers.get("cache-control"), "private, no-store");
  const head = await request(path, { method: "HEAD" });
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal(
    Number(head.headers.get("content-length")),
    original.bytes.length,
  );
  await request(path, {
    headers: { "if-none-match": original.headers.get("etag") },
    status: 304,
  });
  await request(`/ipns/${name}`, { headers: { accept: media } });
  await request(path, { headers: { accept: `${media};q=0` }, status: 406 });
  await request(`${path}&extra=1`, { status: 406 });
  const raw = Buffer.from(
    await (await request(`/ipfs/${first.cid}?format=raw`)).arrayBuffer(),
  );
  assert.equal(CID.parse(first.cid).code, 0x55);
  assert.equal(CID.parse(first.cid).multihash.code, 0x12);
  assert.deepEqual(
    hash(raw),
    Buffer.from(CID.parse(first.cid).multihash.digest),
  );
  assert.equal(raw.toString(), firstText);
  await request(`/ipfs/${first.cid}?format=raw`, { auth: null, status: 404 });
  checks.push(
    "真实回环 HTTP：标准签名/名称/CBOR/sequence/EOL、HEAD、Accept、ETag、私有权限、raw CID",
  );
  const tampered = Buffer.from(original.bytes);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => independent(name, tampered));
  const wrongKey = await generateKeyPair("Ed25519");
  const wrongName = wrongKey.publicKey.toCID().toString(base36);
  assert.throws(() => independent(wrongName, original.bytes));
  const expired = marshalIPNSRecord(
    await createIPNSRecordWithExpiration(
      wrongKey,
      `/ipfs/${first.cid}`,
      0,
      new Date(Date.now() - 1000).toISOString(),
      { v1Compatible: false },
    ),
  );
  assert.throws(() => independent(wrongName, expired));
  wrongKey.raw.fill(0);
  checks.push("独立客户端拒绝篡改、错名及带真实签名的过期 fixture");
  await mutate(id, "publish", { cid: second.cid });
  assert.equal((await record(name)).parsed.sequence, 1n);
  await mutate(id, "rollback", { revision: 1 });
  assert.equal((await record(name)).parsed.sequence, 2n);
  assert.equal((await record(name)).parsed.value, `/ipfs/${first.cid}`);
  await request(`/api/publications/${id}/visibility`, {
    method: "PATCH",
    body: { visibility: "public", acknowledge: true },
  });
  await record(name, null);
  await request(`/api/publications/${id}/visibility`, {
    method: "PATCH",
    body: { visibility: "private", acknowledge: true },
  });
  await request(path, {
    auth: null,
    headers: { "if-none-match": "*" },
    status: 404,
  });
  checks.push("发布 0→1、回滚 1→2、名称不变及公开→私有的条件请求隔离");
  const beforeRenewal = await current(id);
  const previous = await binding(id);
  await db
    .prepare(
      "UPDATE publication_ipns SET expires_at = ? WHERE publication_id = ?",
    )
    .bind(Date.now() + 3600000, id)
    .run();
  await trigger();
  const renewed = await record(name);
  assert.equal(renewed.parsed.sequence, 2n);
  assert(Date.parse(renewed.parsed.validity) >= previous.expires_at);
  assert.deepEqual(await current(id), beforeRenewal);
  await request(`/api/publications/${id}`, { method: "DELETE", status: 204 });
  const deleted = await binding(id);
  await db
    .prepare(
      "UPDATE publication_ipns SET expires_at = ? WHERE publication_id = ?",
    )
    .bind(Date.now() - 1, id)
    .run();
  await trigger();
  assert.equal((await binding(id)).generation, deleted.generation);
  await request(path, { status: 404 });
  await request(`/api/publications/${id}/restore`, { method: "POST" });
  assert.equal((await record(name)).parsed.sequence, 2n);
  checks.push(
    "手动 scheduled 续签不新增业务版本；删除停服停签；恢复后过期元数据触发续签",
  );
  const saved = await binding(id);
  const beforeBackup = await current(id);
  await stop();
  await cp(live, restored, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  await start(restored);
  finalOrigin = origin;
  assert.equal((await binding(id)).name, name);
  assert.deepEqual(await current(id), beforeBackup);
  assert.deepEqual(
    blob((await binding(id)).encrypted_key),
    blob(saved.encrypted_key),
  );
  await request(path, { auth: null, status: 404 });
  await db
    .prepare(
      "UPDATE publication_ipns SET expires_at = ? WHERE publication_id = ?",
    )
    .bind(Date.now() - 1, id)
    .run();
  const recovered = await record(name);
  assert.equal(recovered.parsed.sequence, 2n);
  assert.notDeepEqual(recovered.bytes, blob(saved.record));
  assert.equal((await binding(id)).name, name);
  const restoredRaw = Buffer.from(
    await (await request(`/ipfs/${first.cid}?format=raw`)).arrayBuffer(),
  );
  assert.deepEqual(
    hash(restoredRaw),
    Buffer.from(CID.parse(first.cid).multihash.digest),
  );
  checks.push(
    "停止进程→离线复制 D1/R2→新进程同 master 恢复：名称/sequence/CID/私有权限及新签名保持",
  );
  const many = [];
  for (let index = 0; index < 33; index++) {
    const item = await create(first);
    await enable(item);
    many.push(item);
  }
  await db.batch(
    many.map((item) =>
      db
        .prepare(
          "UPDATE publication_ipns SET expires_at = ? WHERE publication_id = ?",
        )
        .bind(Date.now() + 3600000, item),
    ),
  );
  const cronMs = await trigger();
  const counts = await db
    .prepare(
      "SELECT count(*) AS total, sum(generation = 1) AS renewed, sum(expires_at - ? < 7200000) AS low_headroom FROM publication_ipns WHERE publication_id != ?",
    )
    .bind(Date.now(), id)
    .first();
  assert.equal(counts.total, 33);
  assert.equal(counts.renewed, 32);
  assert.equal(counts.low_headroom, 1);
  const alert = counts.low_headroom > 0;
  assert(alert);
  await trigger();
  const remainder = await db
    .prepare(
      "SELECT count(*) AS count FROM publication_ipns WHERE expires_at - ? < 7200000",
    )
    .bind(Date.now())
    .first();
  assert.equal(remainder.count, 0);
  checks.push(
    "33 条到期元数据：首轮 scheduled 仅续签 32 条、1 条低于两小时阈值触发本地观察，次轮清空",
  );
  await db
    .prepare(
      "UPDATE publication_ipns SET expires_at = ?, retry_at = 0 WHERE publication_id = ?",
    )
    .bind(Date.now() - 1, id)
    .run();
  await stop();
  await start(restored, "");
  const logStart = captured.length;
  await trigger();
  await request(path, { status: 503 });
  const failed = await binding(id);
  assert(failed.retry_at > Date.now());
  assert(
    captured
      .slice(logStart)
      .some((line) => line.includes("ipns_renewal_failed")),
  );
  checks.push(
    "缺失 master：scheduled 失败事件可观察、一小时 retry_at、过期 HTTP 503",
  );
  await db
    .prepare("ALTER TABLE publication_ipns RENAME TO isolated_disabled_ipns")
    .run();
  let cronFailed;
  try {
    await trigger(500);
    cronFailed = true;
  } finally {
    await db
      .prepare("ALTER TABLE isolated_disabled_ipns RENAME TO publication_ipns")
      .run();
  }
  assert(cronFailed);
  checks.push(
    "隔离 schema 故障：scheduled HTTP 500，可被外部 cron 失败探针观察",
  );
  await stop();
  await start(restored);
  await record(name);
  const report = {
    timestamp: new Date().toISOString(),
    testedCommit: commit,
    deploymentContractBlob: contractBlob,
    environment: {
      os: process.platform,
      node: process.version,
      openssl: process.versions.openssl,
      miniflare: await version("miniflare"),
      wrangler: await version("wrangler"),
      ipns: await version("ipns"),
      compatibilityDate: "2026-10-14",
      compatibilityFlags: ["nodejs_compat"],
      initialOrigin,
      restoredOrigin: finalOrigin,
    },
    name,
    cid: first.cid,
    recordSha256: hash(recovered.bytes).toString("hex"),
    recoveredRecord: {
      sequence: recovered.parsed.sequence.toString(),
      validity: recovered.parsed.validity,
      ttlNs: recovered.parsed.ttl.toString(),
    },
    bulk: {
      due: 33,
      firstRunRenewed: 32,
      firstRunRemainingLowHeadroom: 1,
      secondRunRemaining: 0,
      firstRunMilliseconds: cronMs,
    },
    checks,
    limitations: [
      "仅隔离回环环境，无生产操作",
      "到期调度使用隔离 SQL 修改 expires_at；未等待真实 24 小时",
      "真实过期签名另用临时 fixture 验证",
      "scheduled 为手动触发，不证明 Cloudflare 小时调度 SLA",
      "本地阈值观察不等于目标告警投递；33 条演示不等于生产容量证明",
    ],
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  await stop();
  await rm(scratch, { recursive: true, force: true });
}
