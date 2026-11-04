import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, cp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { encode } from "@auth/core/jwt";

const root = process.cwd();
const idea = "01M6KB4DE7A6X7E3M0W6A6ZGRW";
const outer = path.join(".silvermoon", "ideas", idea, "outer");
const resume = process.env.PINBOARD_VERIFY_STATE;
const resumeAfterOrphans =
  process.env.PINBOARD_VERIFY_STAGE === "after-orphans";
const directory =
  resume ?? path.join(".wrangler", `retention-runtime-${randomUUID()}`);
assert.ok(
  path.resolve(directory).startsWith(path.resolve(".wrangler") + path.sep),
);
const stateDirectory = path.join(directory, ".wrangler", "state");
const state = path.resolve(stateDirectory);
const config = path.resolve(directory, "wrangler.jsonc");
const execute = promisify(execFile);
const wrangler = path.join(
  root,
  "apps",
  "worker",
  "node_modules",
  "wrangler",
  "bin",
  "wrangler.js",
);
const workerPackage = pathToFileURL(
  path.join(root, "apps", "worker", "package.json"),
).href;
const load = (name) => import(import.meta.resolve(name, workerPackage));
const DAY = 86400000;
const secret = randomBytes(32).toString("base64url");
let accountA = `fixture-a-${randomUUID()}`;
let accountB = `fixture-b-${randomUUID()}`;
const bucket = "retention-local-fixture";
const journal = [];
const events = [];
const runtimeLogs = [];
const children = [];
let worker;
let browser;
let browserCdp;
let appConfig;
let origin;
let leaf;
let mainRoot;
let cookieA;
let cookieB;
let browserLog = "";
let scheduledEnabled = true;
const env = {
  ...process.env,
  CI: "true",
  WRANGLER_SEND_METRICS: "false",
  NO_COLOR: "1",
};
for (const name of [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_EMAIL",
  "AUTH_SECRET",
  "AUTH_GOOGLE_ID",
  "AUTH_GOOGLE_SECRET",
])
  delete env[name];
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function record(name, details = {}) {
  const entry = { name, ...details };
  journal.push(entry);
  console.log(JSON.stringify(entry));
}
async function port() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}
async function cli(args) {
  const result = await execute(
    process.execPath,
    [wrangler, ...args, "--config", config],
    {
      cwd: root,
      env,
      timeout: 120000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  return result.stdout;
}
async function sql(statement) {
  const file = path.join(directory, "fixture.sql");
  await writeFile(file, statement);
  const output = await cli([
    "d1",
    "execute",
    "DB",
    "--local",
    "--persist-to",
    state,
    "--file",
    path.resolve(file),
    "--json",
  ]);
  const start = output.indexOf("[");
  assert.ok(start >= 0, output.slice(0, 300));
  return JSON.parse(output.slice(start));
}
async function query(statement) {
  const result = await sql(statement);
  return result.at(-1).results;
}
async function put(key, file) {
  await cli([
    "r2",
    "object",
    "put",
    `${bucket}/${key}`,
    "--local",
    "--persist-to",
    state,
    "--file",
    path.resolve(file),
  ]);
}
function capture(stream) {
  let pending = "";
  stream.on("data", (chunk) => {
    pending += chunk.toString().replace(/\u001b\[[0-9;]*m/g, "");
    for (;;) {
      const end = pending.indexOf("\n");
      if (end < 0) break;
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      runtimeLogs.push(line);
      const start = line.indexOf('{"event":"retention');
      if (start >= 0) {
        try {
          events.push(JSON.parse(line.slice(start).trim()));
        } catch {}
      }
    }
  });
}
async function waitFor(check, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await pause(100);
  }
  throw new Error("等待外部运行结果超时");
}
async function startWorker() {
  const args = [
    "dev",
    "--local",
    "--config",
    config,
    "--ip",
    "127.0.0.1",
    "--port",
    new URL(origin).port,
    "--inspector-port",
    String(await port()),
    "--persist-to",
    state,
    "--show-interactive-dev-session=false",
  ];
  if (scheduledEnabled) args.push("--test-scheduled");
  const child = spawn(process.execPath, [wrangler, ...args], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  capture(child.stdout);
  capture(child.stderr);
  worker = child;
  await waitFor(async () => {
    if (child.exitCode !== null)
      throw new Error(runtimeLogs.slice(-15).join("\n"));
    try {
      return (
        (
          await fetch(origin + "/api/health", {
            signal: AbortSignal.timeout(1000),
          })
        ).status === 200
      );
    } catch {
      return false;
    }
  }, 60000);
  record("独立 Worker 已就绪", { pid: child.pid, origin, localOnly: true });
}
async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") {
    const script = `$ErrorActionPreference='SilentlyContinue'; function Stop-Tree([int]$p) { Get-CimInstance Win32_Process -Filter \"ParentProcessId=$p\" | ForEach-Object { Stop-Tree $_.ProcessId }; Stop-Process -Id $p }; Stop-Tree ${child.pid}`;
    await execute(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 30000 },
    );
  } else child.kill("SIGTERM");
  await waitFor(
    () => child.exitCode !== null || child.signalCode !== null,
    30000,
  );
}
async function http(route, options = {}, cookie = cookieA) {
  const response = await fetch(origin + route, {
    ...options,
    headers: { ...(cookie ? { cookie } : {}), ...options.headers },
    signal: AbortSignal.timeout(30000),
  });
  return response;
}
async function json(route, options, cookie) {
  const response = await http(route, options, cookie);
  const body = await response.json();
  assert.ok(
    response.ok,
    `${route}: ${response.status}: ${JSON.stringify(body)}`,
  );
  return body;
}
async function trigger(label) {
  const start = events.length;
  const route =
    "/cdn-cgi/local/scheduled?format=json&cron=" +
    encodeURIComponent("17 * * * *");
  const response = await fetch(origin + route, {
    signal: AbortSignal.timeout(60000),
  });
  const body = await response.text();
  assert.equal(response.status, 200, body.slice(0, 300));
  await writeFile(path.join(directory, "scheduled-response.json"), body);
  const collect = (value) => {
    if (typeof value === "string" && value.includes('{"event":"retention')) {
      try {
        events.push(
          JSON.parse(value.slice(value.indexOf('{"event":"retention'))),
        );
      } catch {}
    } else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object")
      Object.values(value).forEach(collect);
  };
  try {
    collect(JSON.parse(body));
  } catch {}
  await waitFor(
    () =>
      events
        .slice(start)
        .some((entry) => entry.event === "retention_runtime_budget"),
    60000,
  );
  const current = events.slice(start);
  const result = current.find((entry) => entry.event === "retention_completed");
  const budget = current.find(
    (entry) => entry.event === "retention_runtime_budget",
  );
  assert.ok(result, JSON.stringify(current));
  assert.equal(budget.ok, true);
  assert.ok(budget.bindingCalls <= 900, JSON.stringify(budget));
  assert.ok(budget.wallMs <= 30000, JSON.stringify(budget));
  record(label, {
    transport: "/cdn-cgi/local/scheduled?format=json",
    result,
    budget,
  });
  return { result, budget, current };
}
async function createToken(name, cookie = cookieA) {
  return json(
    "/api/tokens",
    {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ name, scopes: ["pins:read"], expiresInDays: 365 }),
    },
    cookie,
  );
}
async function unpin(cid, cookie = cookieA) {
  const response = await http(
    `/api/pins/${cid}`,
    { method: "DELETE", headers: { origin } },
    cookie,
  );
  assert.equal(response.status, 204);
}
async function cdp(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const listeners = new Map();
  let id = 0;
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (message) => {
    const event = JSON.parse(message.data);
    if (event.id) {
      const request = pending.get(event.id);
      pending.delete(event.id);
      if (event.error) request.reject(new Error(JSON.stringify(event.error)));
      else request.resolve(event.result);
    } else
      for (const listener of listeners.get(event.method) ?? [])
        listener(event.params);
  });
  return {
    send(method, params = {}) {
      const requestId = ++id;
      const result = new Promise((resolve, reject) =>
        pending.set(requestId, { resolve, reject }),
      );
      socket.send(JSON.stringify({ id: requestId, method, params }));
      return result;
    },
    on(method, listener) {
      listeners.set(method, [...(listeners.get(method) ?? []), listener]);
    },
    close() {
      socket.close();
    },
  };
}
async function browserSmoke(upload) {
  const debugPort = await port();
  const binary =
    process.env.PINBOARD_VERIFY_BROWSER ??
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  browser = spawn(
    binary,
    [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${path.resolve(directory, "browser-profile")}`,
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(browser);
  browser.stderr.on("data", (chunk) => {
    browserLog += chunk.toString();
  });
  const endpoint = `http://127.0.0.1:${debugPort}`;
  const version = await waitFor(async () => {
    try {
      return await (await fetch(endpoint + "/json/version")).json();
    } catch {
      return false;
    }
  }, 30000);
  browserCdp = await cdp(version.webSocketDebuggerUrl);
  const target = await (
    await fetch(endpoint + "/json/new?about:blank", { method: "PUT" })
  ).json();
  const page = await cdp(target.webSocketDebuggerUrl);
  const requested = [];
  page.on("Network.requestWillBeSent", ({ request }) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/tokens")
      requested.push(url.pathname + url.search);
  });
  await page.send("Network.enable");
  await page.send("Runtime.enable");
  const evaluate = async (expression) => {
    const response = await page.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    assert.ok(
      !response.exceptionDetails,
      JSON.stringify(response.exceptionDetails),
    );
    return response.result.value;
  };
  await page.send("Network.setCookie", {
    name: "authjs.session-token",
    value: cookieA.slice("authjs.session-token=".length),
    url: origin,
    httpOnly: true,
    sameSite: "Lax",
  });
  await page.send("Page.navigate", { url: origin });
  await waitFor(() =>
    evaluate(
      "document.body.innerText.includes('Your pins') && document.querySelector('select')?.value === 'active'",
    ),
  );
  await waitFor(() =>
    evaluate("document.body.innerText.includes('FixtureActive')"),
  );
  assert.equal(
    await evaluate(
      "document.body.innerText.includes('FixtureRevoked') || document.body.innerText.includes('FixtureExpired')",
    ),
    false,
  );
  await evaluate(
    "document.querySelector('select').value = 'history'; document.querySelector('select').dispatchEvent(new Event('change', {bubbles:true}))",
  );
  await waitFor(() =>
    evaluate(
      "document.body.innerText.includes('FixtureRevoked') && document.body.innerText.includes('FixtureExpired')",
    ),
  );
  assert.equal(
    await evaluate("document.body.innerText.includes('FixtureActive')"),
    false,
  );
  assert.ok(requested.includes("/api/tokens?view=history"));
  await evaluate(
    "window.confirm = () => true; const row = [...document.querySelectorAll('.pin-list li')].find(x => x.innerText.includes('FixtureUpload')); if (!row) throw new Error('Missing upload row'); [...row.querySelectorAll('button')].find(x => x.innerText === 'Unpin').click()",
  );
  await waitFor(() =>
    evaluate(
      "![...document.querySelectorAll('.pin-list li')].some(x => x.innerText.includes('FixtureUpload')) && !document.querySelector('[aria-busy=\"true\"]')",
    ),
  );
  assert.equal(
    (await json("/api/pins")).pins.some((pin) => pin.cid === upload.cid),
    false,
  );
  const safetyText = await evaluate(
    "document.body.innerText.includes('7 days') && document.body.innerText.includes('30') && document.body.innerText.includes('no restore or permanent-delete')",
  );
  assert.equal(safetyText, true);
  record("独立浏览器真实交互通过", {
    browser: version.Browser,
    activeDefault: true,
    historySwitch: true,
    unpinRemoved: true,
    retentionNotice: true,
    tokenRequests: [...new Set(requested)],
  });
  page.close();
}

const innerPath = `${outer.split(path.sep).join("/")}/inner`;
assert.equal(
  (await execute("git", ["rev-parse", `HEAD:${innerPath}`])).stdout.trim(),
  "503ebb7ce2c4dc8f57397920baea6768c75fdfa3",
);
await execute("git", [
  "diff",
  "--exit-code",
  "674133fe3c304e5e2c192362e2fb535dd9e151f4",
  "--",
  "apps",
  "packages",
  "scripts",
  ".github",
]);
const contractPath = `${outer.split(path.sep).join("/")}/Deployment.md`;
const baselineContract = await execute("git", [
  "show",
  `674133fe3c304e5e2c192362e2fb535dd9e151f4:${contractPath}`,
]);
assert.equal(
  hash(await readFile(path.join(outer, "Deployment.md"))),
  hash(baselineContract.stdout),
);
if (process.argv.includes("--preflight")) {
  console.log("契约、已接受实现与产品源码前置校验通过；未启动运行环境。");
  process.exit(0);
}
if (resume)
  assert.equal(
    JSON.parse(await readFile(path.join(directory, "owner.json"), "utf8")).idea,
    idea,
  );
if (resumeAfterOrphans) {
  const previous = JSON.parse(
    await readFile(path.join(directory, "failure.json"), "utf8"),
  );
  journal.push(...previous.journal);
  events.push(...previous.events);
}
await mkdir(directory, { recursive: true });
await writeFile(
  path.join(directory, "owner.json"),
  JSON.stringify({ idea, createdAt: new Date().toISOString() }),
);
try {
  const servePort = await port();
  origin = `http://127.0.0.1:${servePort}`;
  appConfig = {
    name: "pinboard-retention-verification",
    main: path.relative(directory, path.join(outer, "probe-entry.mjs")),
    compatibility_date: "2026-10-14",
    compatibility_flags: ["nodejs_compat"],
    triggers: { crons: ["17 * * * *"] },
    assets: {
      binding: "ASSETS",
      directory: path.relative(directory, path.join("apps", "web", "dist")),
      not_found_handling: "single-page-application",
      run_worker_first: ["/api/*", "/ipfs/*", "/routing/*", "/mcp"],
    },
    d1_databases: [
      {
        binding: "DB",
        database_name: bucket,
        database_id: "10000000-0000-4000-8000-000000000003",
      },
    ],
    r2_buckets: [{ binding: "BLOCKS", bucket_name: bucket }],
    vars: {
      APP_NAME: "Retention isolated fixture",
      PUBLIC_ORIGIN: origin,
      AUTH_URL: origin + "/api/auth",
      PROVIDER_MULTIADDR: `/ip4/127.0.0.1/tcp/${servePort}/http`,
      PROVIDER_ID: "12D3KooWCjfPiojcCUmv78Wd1NJzi4Mraj1moxigp7AfQVQvGLwH",
    },
    observability: { enabled: true, traces: { enabled: true } },
  };
  await writeFile(config, JSON.stringify(appConfig));
  await writeFile(path.join(directory, ".dev.vars"), `AUTH_SECRET=${secret}\n`);
  const { buildDirectoryCar } = await load("@workspace/encoding");
  const { CarReader, CarIndexer, CarWriter } = await load("@ipld/car");
  const fixtures = Array.from({ length: 255 }, (_, index) => {
    const bytes = new Uint8Array(128 * 1024).fill(index);
    return {
      path: `max-${String(index).padStart(3, "0")}.bin`,
      size: bytes.length,
      content: (async function* () {
        yield bytes;
      })(),
    };
  });
  const maximum = await buildDirectoryCar(fixtures);
  mainRoot = maximum.root;
  const rows = [];
  for await (const entry of await CarIndexer.fromBytes(maximum.bytes))
    rows.push({
      cid: entry.cid.toV1().toString(),
      offset: entry.blockOffset,
      length: entry.blockLength,
    });
  assert.equal(rows.length, 256);
  assert.ok(maximum.bytes.length < 32 * 1024 * 1024);
  leaf = rows.find((row) => row.cid !== mainRoot);
  const reader = await CarReader.fromBytes(maximum.bytes);
  const leafBlock = await reader.get(
    (await load("multiformats/cid")).CID.parse(leaf.cid),
  );
  await writeFile(path.join(directory, "maximum.car"), maximum.bytes);
  await writeFile(path.join(directory, "legacy.block"), leafBlock.bytes);
  const { writer, out } = CarWriter.create([leafBlock.cid]);
  const parts = [];
  const collected = (async () => {
    for await (const part of out) parts.push(part);
  })();
  await writer.put(leafBlock);
  await writer.close();
  await collected;
  await writeFile(path.join(directory, "orphan.car"), Buffer.concat(parts));
  await writeFile(
    path.join(directory, "unknown.block"),
    "仅属于隔离夹具的保留对象",
  );
  if (resume) {
    const accounts = await query("SELECT id, subject FROM accounts");
    accountA = accounts.find((account) => account.subject === "fixture-a").id;
    accountB = accounts.find((account) => account.subject === "fixture-b").id;
    assert.equal((await query("SELECT root FROM car_dags"))[0].root, mainRoot);
  } else {
    for (const file of ["0001_pinboard.sql", "0002_car_storage.sql"])
      await cli([
        "d1",
        "execute",
        "DB",
        "--local",
        "--persist-to",
        state,
        "--file",
        path.join(root, "apps", "worker", "migrations", file),
        "--json",
      ]);
    await sql(`
    INSERT INTO accounts (id, provider, subject) VALUES (${quote(accountA)}, 'google', 'fixture-a'), (${quote(accountB)}, 'google', 'fixture-b');
    INSERT INTO pins (account_id,cid,name,size,blocks) VALUES (${quote(accountA)},${quote(mainRoot)},'FixtureMaximum',${rows.reduce((sum, row) => sum + row.length, 0)},256),(${quote(accountB)},${quote(leaf.cid)},'FixtureSharedLeaf',${leaf.length},1);
    INSERT INTO car_dags VALUES (${quote(mainRoot)},'cars/shared-max.car',${maximum.bytes.length});
    INSERT INTO car_blocks (cid,object_key,byte_offset,byte_length) VALUES ${rows.map((row) => `(${quote(row.cid)},'cars/shared-max.car',${row.offset},${row.length})`).join(",")};
  `);
    await put("cars/shared-max.car", path.join(directory, "maximum.car"));
    await put(leaf.cid, path.join(directory, "legacy.block"));
    await put("operator-owned-fixture", path.join(directory, "unknown.block"));
    for (let index = 0; index < 55; index++) {
      await put(
        `cars/orphan-${String(index).padStart(2, "0")}.car`,
        path.join(directory, "orphan.car"),
      );
      if (index % 10 === 0) console.log(`孤儿夹具 ${index + 1}/55 已写入`);
    }
    await cli([
      "d1",
      "execute",
      "DB",
      "--local",
      "--persist-to",
      state,
      "--file",
      path.join(root, "apps", "worker", "migrations", "0003_retention.sql"),
      "--json",
    ]);
  }
  if (!resumeAfterOrphans) {
    const migration = {
      foreignKeys: await query("PRAGMA foreign_key_check"),
      objects: await query("SELECT count(*) AS n FROM storage_objects"),
      memberships: await query("SELECT count(*) AS n FROM object_blocks"),
      state: await query("SELECT safe_after FROM retention_state"),
      known: await query("SELECT count(*) AS n FROM dag_roots"),
    };
    assert.deepEqual(migration.foreignKeys, []);
    assert.equal(migration.objects[0].n, 1);
    assert.equal(migration.memberships[0].n, 256);
    assert.equal(migration.known[0].n, 0);
    assert.ok(
      Date.parse(migration.state[0].safe_after) > Date.now() + 6.99 * DAY,
    );
    record("存量迁移保留真实索引并初始化安全下限", {
      ...migration,
      root: mainRoot,
      blocks: rows.length,
      carBytes: maximum.bytes.length,
    });
  }
  const session = async (accountId) =>
    "authjs.session-token=" +
    (await encode({
      token: { accountId, name: "Local Fixture" },
      secret,
      salt: "authjs.session-token",
    }));
  cookieA = await session(accountA);
  cookieB = await session(accountB);
  await startWorker();
  if (!resumeAfterOrphans) {
    const first = await trigger(
      "首次真实 scheduled 回填后仍阻止未知 live pin 回收",
    );
    assert.equal(first.result.backfilled, 1);
    assert.equal(first.result.blockedPins, 1);
    assert.equal(first.result.objectsDeleted, 0);
    const beforeBoundary = new Date(
      Date.now() - 30 * DAY + 3600000,
    ).toISOString();
    await sql(`
    UPDATE retention_state SET safe_after = '2000', scan_cursor = NULL;
    UPDATE storage_objects SET unreferenced_at = '2000';
    UPDATE retained_blocks SET unreferenced_at = '2000' WHERE unreferenced_at IS NOT NULL;
    INSERT INTO agent_tokens (id, account_id,name,prefix,token_hash,scopes,expires_at,revoked_at)
      SELECT 'expired-'||value, ${quote(accountA)}, 'FixtureOld','pb_fixture','fixture-hash-'||value,'["pins:read"]',
      CASE WHEN value=98 THEN '2099-01-01T00:00:00.000Z' ELSE '2000-01-01T00:00:00.000Z' END,
      CASE WHEN value=98 THEN '2000-01-01T00:00:00.000Z' WHEN value=99 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END
      FROM json_each(${quote(JSON.stringify(Array.from({ length: 100 }, (_, index) => index)))});
    INSERT INTO agent_tokens VALUES ('boundary',${quote(accountA)},'FixtureBoundary','pb_fixture','boundary-hash','["pins:read"]',${quote(beforeBoundary)},NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
  `);
    const maximumRun = await trigger(
      "最大 256-block 近 32MiB 回填与清理预算实测",
    );
    assert.equal(maximumRun.result.backfilled, 1);
    assert.equal(maximumRun.result.blockedPins, 0);
    assert.equal(maximumRun.result.tokensDeleted, 100);
    assert.equal(maximumRun.result.objectsDeleted, 20);
    assert.equal(maximumRun.budget.r2Operations.get, 256);
    assert.equal(
      (
        await query(
          "SELECT count(*) AS n FROM agent_tokens WHERE id='boundary'",
        )
      )[0].n,
      1,
    );
    assert.equal(
      (await http(`/ipfs/${leaf.cid}?format=raw`, {}, null)).status,
      200,
    );
    await sql(
      "CREATE TRIGGER fixture_fail_finalize BEFORE DELETE ON storage_objects WHEN OLD.object_key = 'cars/orphan-20.car' BEGIN SELECT RAISE(FAIL, 'fixture-finalization-failure'); END;",
    );
    const failed = await trigger("真实数据库故障保留删除声明并记录失败");
    assert.equal(failed.result.objectsFailed, 1);
    assert.ok(
      failed.current.some(
        (entry) =>
          entry.event === "retention_object_failed" &&
          entry.objectKey === "cars/orphan-20.car",
      ),
    );
    const claim = (
      await query(
        "SELECT state,attempts,retry_at FROM storage_objects WHERE object_key='cars/orphan-20.car'",
      )
    )[0];
    assert.equal(claim.state, "deleting");
    assert.equal(claim.attempts, 1);
    assert.ok(Date.parse(claim.retry_at) > Date.now());
    await sql(
      "DROP TRIGGER fixture_fail_finalize; UPDATE storage_objects SET retry_at='2000' WHERE state='deleting'; UPDATE agent_tokens SET expires_at='2000-01-01T00:00:00.000Z' WHERE id='boundary';",
    );
  }
  const freshOrphans = (
    await query(
      `SELECT count(*) AS n FROM storage_objects WHERE object_key LIKE 'cars/orphan-%' AND unreferenced_at > ${quote(new Date(Date.now() - 7 * DAY).toISOString())}`,
    )
  )[0].n;
  assert.equal(freshOrphans, 6);
  record("后续页新观测孤儿仍享有完整宽限期", { freshOrphans });
  await sql(
    "UPDATE storage_objects SET unreferenced_at='2000' WHERE object_key LIKE 'cars/orphan-%';",
  );
  await trigger("外部故障移除后幂等重试与剩余孤儿收敛");
  assert.equal(
    (
      await query(
        "SELECT count(*) AS n FROM storage_objects WHERE object_key LIKE 'cars/orphan-%'",
      )
    )[0].n,
    0,
  );
  assert.equal(
    (
      await query("SELECT count(*) AS n FROM agent_tokens WHERE id='boundary'")
    )[0].n,
    0,
  );
  const active = await createToken("FixtureActive");
  const revoked = await createToken("FixtureRevoked");
  const expired = await createToken("FixtureExpired");
  await createToken("FixtureOtherAccount", cookieB);
  assert.equal(
    (
      await http(`/api/tokens/${revoked.id}`, {
        method: "DELETE",
        headers: { origin },
      })
    ).status,
    204,
  );
  await sql(
    `UPDATE agent_tokens SET expires_at=${quote(new Date(Date.now() - 3600000).toISOString())} WHERE id=${quote(expired.id)};`,
  );
  const bearer = (token) => ({ authorization: `Bearer ${token}` });
  const authResults = {
    anonymousPins: (await http("/api/pins", {}, null)).status,
    anonymousTokens: (await http("/api/tokens", {}, null)).status,
    active: (await http("/api/pins", { headers: bearer(active.token) }, null))
      .status,
    revoked: (await http("/api/pins", { headers: bearer(revoked.token) }, null))
      .status,
    expired: (await http("/api/pins", { headers: bearer(expired.token) }, null))
      .status,
    agentManagement: (
      await http(
        "/api/tokens?view=history",
        { headers: bearer(active.token) },
        null,
      )
    ).status,
    crossAccountUnpin: (
      await http(
        `/api/pins/${mainRoot}`,
        { method: "DELETE", headers: { origin } },
        cookieB,
      )
    ).status,
  };
  assert.deepEqual(authResults, {
    anonymousPins: 401,
    anonymousTokens: 401,
    active: 200,
    revoked: 401,
    expired: 401,
    agentManagement: 403,
    crossAccountUnpin: 404,
  });
  assert.deepEqual(
    (await json("/api/tokens")).tokens.map((token) => token.name),
    ["FixtureActive"],
  );
  assert.deepEqual(
    (await json("/api/tokens?view=history")).tokens
      .map((token) => token.name)
      .sort(),
    ["FixtureExpired", "FixtureRevoked"],
  );
  record("真实 HTTP 鉴权与隔离通过", authResults);
  const upload = await json("/api/pins/upload?kind=file&name=FixtureUpload", {
    method: "POST",
    headers: {
      origin,
      "x-pinboard-public": "true",
      "content-type": "application/octet-stream",
    },
    body: new TextEncoder().encode("仅属于非生产浏览器的上传内容"),
  });
  await browserSmoke(upload);
  const car = await http(`/api/public/${mainRoot}/car`, {}, null);
  const carBytes = new Uint8Array(await car.arrayBuffer());
  assert.equal(car.status, 200);
  assert.equal(hash(carBytes), hash(maximum.bytes));
  await writeFile(path.join(directory, "backup.car"), carBytes);
  await cli([
    "d1",
    "export",
    "DB",
    "--local",
    "--output",
    path.resolve(directory, "backup.sql"),
  ]);
  await stopChild(worker);
  await cp(stateDirectory, path.join(directory, "backup-state"), {
    recursive: true,
  });
  record("停止自有 Worker 后取得一致备份", {
    sqlExportBytes: (await readFile(path.join(directory, "backup.sql"))).length,
    carSha256: hash(carBytes),
    carBytes: carBytes.length,
  });
  await startWorker();
  const started = Date.now();
  await unpin(mainRoot);
  const lost = (
    await query(
      `SELECT unreferenced_at FROM retained_blocks WHERE cid=${quote(mainRoot)}`,
    )
  )[0].unreferenced_at;
  assert.ok(Date.parse(lost) >= started && Date.parse(lost) <= Date.now());
  assert.equal(
    (
      await query(
        `SELECT unreferenced_at FROM retained_blocks WHERE cid=${quote(leaf.cid)}`,
      )
    )[0].unreferenced_at,
    null,
  );
  await sql(
    "UPDATE storage_objects SET unreferenced_at='2000'; UPDATE retained_blocks SET unreferenced_at='2000' WHERE unreferenced_at IS NOT NULL;",
  );
  await trigger("最后根账号 unpin 后跨账号 leaf 仍保护整个共享 CAR");
  assert.equal(
    (await http(`/api/public/${mainRoot}/car`, {}, null)).status,
    200,
  );
  assert.equal(
    (await http(`/ipfs/${leaf.cid}?format=raw`, {}, null)).status,
    200,
  );
  await unpin(leaf.cid, cookieB);
  const nearSevenDays = new Date(Date.now() - 7 * DAY + 3600000).toISOString();
  await sql(
    `UPDATE retained_blocks SET unreferenced_at=${quote(nearSevenDays)} WHERE unreferenced_at IS NOT NULL; UPDATE storage_objects SET unreferenced_at='2000';`,
  );
  await trigger("最后有效引用失去后不足七天仍保留");
  assert.equal(
    (await http(`/api/public/${mainRoot}/car`, {}, null)).status,
    200,
  );
  await sql(
    "UPDATE retained_blocks SET unreferenced_at='2000' WHERE unreferenced_at IS NOT NULL;",
  );
  await trigger("隔离时间夹具超过七天后回收内容和索引");
  assert.equal(
    (await http(`/api/public/${mainRoot}/car`, {}, null)).status,
    404,
  );
  assert.equal(
    (await http(`/ipfs/${leaf.cid}?format=raw`, {}, null)).status,
    404,
  );
  for (const table of [
    "storage_objects",
    "object_blocks",
    "car_dags",
    "car_blocks",
    "dag_roots",
    "dag_members",
    "retained_blocks",
  ]) {
    assert.equal(
      (await query(`SELECT count(*) AS n FROM ${table}`))[0].n,
      0,
      table,
    );
  }
  await stopChild(worker);
  await rm(stateDirectory, { recursive: true });
  await cp(path.join(directory, "backup-state"), stateDirectory, {
    recursive: true,
  });
  await startWorker();
  assert.ok((await json("/api/pins")).pins.some((pin) => pin.cid === mainRoot));
  const restored = await http(`/api/public/${mainRoot}/car`, {}, null);
  assert.equal(
    hash(new Uint8Array(await restored.arrayBuffer())),
    hash(carBytes),
  );
  assert.equal(
    (await http("/api/pins", { headers: bearer(revoked.token) }, null)).status,
    401,
  );
  record("真实快照恢复后 pin、CAR 与撤销状态一致", {
    restoredCarSha256: hash(carBytes),
    restoredPins: true,
    revokedStillDenied: true,
  });
  await stopChild(worker);
  appConfig.triggers.crons = [];
  await writeFile(config, JSON.stringify(appConfig));
  scheduledEnabled = false;
  await startWorker();
  assert.equal((await http("/api/health", {}, null)).status, 200);
  assert.equal((await http("/api/pins", {}, null)).status, 401);
  assert.equal(
    (await http(`/ipfs/${leaf.cid}?format=raw`, {}, null)).status,
    200,
  );
  record("移除本地 Cron 配置并停止主动触发后 API 与鉴权保持正常", {
    configuredCrons: appConfig.triggers.crons,
    legacyTestScheduledFlag: false,
    caveat:
      "本地 Cron 不自动按时钟运行；Local Explorer 手工入口不属于自动调度；不宣称验证远程调度暂停",
  });
  const sourceRevision = (
    await execute("git", ["rev-parse", "HEAD"], { cwd: root })
  ).stdout.trim();
  const report = {
    idea,
    contractRevision: "9550fba5fc89ced92539f0cd678320431748cd90",
    contractPrimary: "674133fe3c304e5e2c192362e2fb535dd9e151f4",
    acceptedImplementationRevision: "503ebb7ce2c4dc8f57397920baea6768c75fdfa3",
    sourceRevision,
    recordedAt: new Date().toISOString(),
    scope: "隔离本地独立 workerd / 真实 HTTP 与浏览器 / 无远程资源变更",
    productionMutations: 0,
    journal,
    scheduledEvents: events,
  };
  await writeFile(
    path.join(outer, "RuntimeEvidence.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log("所有外部非生产验证通过，证据已写入 Outer World。");
} catch (error) {
  console.error(error.stack ?? error);
  await writeFile(
    path.join(directory, "failure.json"),
    JSON.stringify(
      {
        message: error.message,
        journal,
        events,
        lastLogs: runtimeLogs.slice(-40),
        browserLog: browserLog.slice(-2000),
      },
      null,
      2,
    ),
  );
  console.error(`保留隔离现场：${directory}`);
  process.exitCode = 1;
} finally {
  if (browserCdp) {
    try {
      await Promise.race([browserCdp.send("Browser.close"), pause(3000)]);
    } catch {}
    browserCdp.close();
  }
  for (const child of children.reverse()) {
    try {
      await stopChild(child);
    } catch (error) {
      console.error(`停止自有进程 ${child.pid} 失败：${error.message}`);
    }
  }
  if (!process.exitCode) await rm(directory, { recursive: true });
}
