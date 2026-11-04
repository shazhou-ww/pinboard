import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createSecureServer } from "node:http2";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await mkdtemp(path.join(root, ".kubo-poc-"));
const ipfs = process.env.IPFS_BIN ?? "ipfs";
const openssl = process.env.OPENSSL_BIN ?? "openssl";
const children = [];
const requests = [];
const env = (repo) => ({ ...process.env, IPFS_PATH: path.join(temp, repo) });
const run = (repo, args, options = {}) =>
  execFileSync(ipfs, args, {
    env: env(repo),
    timeout: 90000,
    maxBuffer: 40 * 1024 * 1024,
    ...options,
  });
const start = (command, args, options = {}) => {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  let log = "";
  child.stdout.on("data", (chunk) => {
    log += chunk;
  });
  child.stderr.on("data", (chunk) => {
    log += chunk;
  });
  child.on("error", (error) => {
    log += error.message;
  });
  children.push(child);
  return { child, log: () => log };
};
async function ready(url, child, method = "GET") {
  for (let i = 0; i < 120; i++) {
    if (child.child.exitCode !== null) throw new Error(child.log());
    try {
      if ((await fetch(url, { method, signal: AbortSignal.timeout(2000) })).ok)
        return;
    } catch (error) {
      if (!(error instanceof TypeError) && error.name !== "TimeoutError")
        throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Not ready: ${url}\n${child.log()}`);
}
async function command(repo, args) {
  const process = start(ipfs, args, { env: env(repo) });
  const chunks = [];
  process.child.stdout.on("data", (chunk) => chunks.push(chunk));
  const timer = setTimeout(() => process.child.kill(), 90000);
  const code = await new Promise((resolve, reject) => {
    process.child.on("error", reject);
    process.child.on("exit", resolve);
  });
  clearTimeout(timer);
  assert.equal(code, 0, process.log());
  return Buffer.concat(chunks);
}
let proxy;
try {
  console.log(run("source", ["version"]).toString().trim());
  await mkdir(path.join(temp, "input"));
  const payload = randomBytes(3 * 1024 * 1024 + 137);
  const note = Buffer.from("Pin blocks. Share by CID.\n");
  await writeFile(path.join(temp, "input", "payload.bin"), payload);
  await writeFile(path.join(temp, "input", "note.txt"), note);
  run("source", ["init", "--profile=test"]);
  const cid = run("source", [
    "add",
    "--offline",
    "-Qr",
    "--cid-version=1",
    "--raw-leaves=true",
    "--chunker=size-262144",
    path.join(temp, "input"),
  ])
    .toString()
    .trim();
  const car = run("source", ["dag", "export", "--offline", cid]);
  const sourceConfigPath = path.join(temp, "source", "config");
  const sourceConfig = JSON.parse(await readFile(sourceConfigPath, "utf8"));
  sourceConfig.Addresses.API = "/ip4/127.0.0.1/tcp/15000";
  sourceConfig.Addresses.Gateway = "";
  sourceConfig.Addresses.Swarm = [];
  await writeFile(sourceConfigPath, JSON.stringify(sourceConfig));
  const source = start(ipfs, ["daemon", "--offline"], { env: env("source") });
  await ready("http://127.0.0.1:15000/api/v0/version", source, "POST");
  await command("source", ["shutdown"]);
  if (source.child.exitCode === null)
    await new Promise((resolve) => source.child.once("exit", resolve));
  console.log(
    `Source daemon stopped; exported ${car.length} bytes, root ${cid}`,
  );

  const wrangler = path.join(
    root,
    "apps",
    "worker",
    "node_modules",
    "wrangler",
    "bin",
    "wrangler.js",
  );
  execFileSync(
    process.execPath,
    [
      wrangler,
      "d1",
      "migrations",
      "apply",
      "DB",
      "--local",
      "--config",
      "wrangler.poc.jsonc",
      "--persist-to",
      path.join(temp, "worker-state"),
    ],
    {
      cwd: path.join(root, "apps", "worker"),
      env: { ...process.env, CI: "true" },
    },
  );
  const worker = start(
    process.execPath,
    [
      path.join(
        root,
        "apps",
        "worker",
        "node_modules",
        "wrangler",
        "bin",
        "wrangler.js",
      ),
      "dev",
      "--config",
      "wrangler.poc.jsonc",
      "--ip",
      "127.0.0.1",
      "--port",
      "8787",
      "--persist-to",
      path.join(temp, "worker-state"),
    ],
    { cwd: path.join(root, "apps", "worker") },
  );
  await ready("http://127.0.0.1:8787/routing/v1/providers/bafkqaaa", worker);
  const upload = await fetch("http://127.0.0.1:8787/poc/car", {
    method: "POST",
    body: car,
  });
  const receipt = await upload.json();
  assert.equal(upload.status, 200, JSON.stringify(receipt));
  assert.equal(receipt.cid, cid);
  assert.ok(receipt.blocks > 3);
  console.log("CAR stored:", receipt);

  execFileSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `
    import { readFile, writeFile } from "node:fs/promises";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const source = process.env.PINBOARD_WEB_SOURCE;
    const { selectionForDirectory } = await import(pathToFileURL(path.join(source, "uploads.ts")).href);
    const { buildDirectoryCar } = await import(pathToFileURL(path.join(source, "directory.ts")).href);
    const input = process.env.PINBOARD_TEST_INPUT;
    const selection = selectionForDirectory([
      { path: "browser-folder/payload.bin", file: new File([await readFile(path.join(input, "payload.bin"))], "payload.bin") },
      { path: "browser-folder/nested/note.txt", file: new File([await readFile(path.join(input, "note.txt"))], "note.txt") },
      { path: "browser-folder/empty.txt", file: new File([], "empty.txt") },
    ]);
    const car = await buildDirectoryCar(selection);
    await writeFile(process.env.PINBOARD_BROWSER_CAR, new Uint8Array(await car.arrayBuffer()));
  `,
    ],
    {
      env: {
        ...process.env,
        PINBOARD_WEB_SOURCE: path.join(root, "apps", "web", "src"),
        PINBOARD_TEST_INPUT: path.join(temp, "input"),
        PINBOARD_BROWSER_CAR: path.join(temp, "browser.car"),
      },
      timeout: 90000,
    },
  );
  const browserUpload = await fetch("http://127.0.0.1:8787/poc/car", {
    method: "POST",
    body: await readFile(path.join(temp, "browser.car")),
  });
  const browserReceipt = await browserUpload.json();
  assert.equal(browserUpload.status, 200, JSON.stringify(browserReceipt));
  assert.ok(browserReceipt.blocks > 3);
  console.log(
    "Browser-encoded directory CAR accepted by Worker:",
    browserReceipt,
  );

  execFileSync(
    openssl,
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      path.join(temp, "key.pem"),
      "-out",
      path.join(temp, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  proxy = createSecureServer(
    {
      key: await readFile(path.join(temp, "key.pem")),
      cert: await readFile(path.join(temp, "cert.pem")),
      allowHTTP1: true,
    },
    async (request, response) => {
      try {
        requests.push({
          method: request.method,
          path: request.url,
          http: request.httpVersion,
        });
        const upstream = await fetch(`http://127.0.0.1:8787${request.url}`, {
          method: request.method,
          headers: { accept: request.headers.accept ?? "*/*" },
        });
        response.writeHead(
          upstream.status,
          Object.fromEntries(upstream.headers),
        );
        response.end(Buffer.from(await upstream.arrayBuffer()));
      } catch (error) {
        console.error("Proxy failure", error);
        response.writeHead(502).end();
      }
    },
  );
  await new Promise((resolve) => proxy.listen(9443, "127.0.0.1", resolve));
  const probe = await fetch("http://127.0.0.1:8787/ipfs/bafkqaaa?format=raw", {
    method: "HEAD",
  });
  assert.equal(probe.status, 200);
  assert.equal(probe.headers.get("content-length"), "0");
  assert.equal(probe.headers.get("content-type"), "application/vnd.ipld.raw");

  const clients = [
    {
      repo: "consumer-cat",
      mode: "cat",
      port: 15001,
      cid,
      notePath: "note.txt",
    },
    {
      repo: "consumer-get",
      mode: "get",
      port: 15002,
      cid,
      notePath: "note.txt",
    },
    {
      repo: "consumer-browser-get",
      mode: "get",
      port: 15003,
      cid: browserReceipt.cid,
      notePath: "nested/note.txt",
      emptyFile: true,
    },
  ];
  for (const {
    repo,
    mode,
    port,
    cid: targetCid,
    notePath,
    emptyFile,
  } of clients) {
    run(repo, ["init", "--profile=test"]);
    const configPath = path.join(temp, repo, "config");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.Bootstrap = [];
    config.Addresses.API = `/ip4/127.0.0.1/tcp/${port}`;
    config.Addresses.Gateway = "";
    config.Addresses.Swarm = [];
    config.Discovery.MDNS.Enabled = false;
    config.Routing.Type = "autoclient";
    config.Routing.DelegatedRouters = ["http://127.0.0.1:8787"];
    config.HTTPRetrieval = {
      Enabled: true,
      TLSInsecureSkipVerify: true,
      Allowlist: ["127.0.0.1"],
    };
    config.Provide = { Enabled: false };
    await writeFile(configPath, JSON.stringify(config));
    assert.throws(() =>
      run(repo, ["block", "stat", "--offline", targetCid], { stdio: "pipe" }),
    );
    const daemon = start(ipfs, ["daemon"], { env: env(repo) });
    await ready(`http://127.0.0.1:${port}/api/v0/version`, daemon, "POST");
    const providers = (
      await command(repo, [
        "routing",
        "findprovs",
        "--num-providers=1",
        targetCid,
      ])
    )
      .toString()
      .trim();
    assert.equal(
      providers,
      "12D3KooWCjfPiojcCUmv78Wd1NJzi4Mraj1moxigp7AfQVQvGLwH",
    );
    if (mode === "cat") {
      assert.deepEqual(
        await command(repo, ["cat", `/ipfs/${targetCid}/payload.bin`]),
        payload,
      );
      assert.deepEqual(
        await command(repo, ["cat", `/ipfs/${targetCid}/${notePath}`]),
        note,
      );
    } else {
      const retrieved = path.join(temp, `retrieved-${repo}`);
      await command(repo, ["get", "-o", retrieved, targetCid]);
      assert.deepEqual(
        await readFile(path.join(retrieved, "payload.bin")),
        payload,
      );
      assert.deepEqual(
        await readFile(path.join(retrieved, ...notePath.split("/"))),
        note,
      );
      if (emptyFile)
        assert.equal(
          (await readFile(path.join(retrieved, "empty.txt"))).length,
          0,
        );
    }
    await command(repo, ["shutdown"]);
    console.log(
      `PASS fresh ${repo}: routing + ${mode}; sha256=${createHash("sha256").update(payload).digest("hex")}`,
    );
  }
  assert.ok(
    requests.some((r) => r.path.includes("bafkqaaa") && r.http === "2.0"),
    "Missing HTTP/2 gateway probe",
  );
  assert.ok(
    requests.filter((r) => r.method === "GET" && r.path.includes("format=raw"))
      .length > 3,
  );
  console.log(
    "PASS HTTP/2 probe, multi-block requests, cold cat/get, source unavailable",
  );
  console.log(
    JSON.stringify(
      {
        receipt,
        browserReceipt,
        http2Requests: requests.filter((r) => r.http === "2.0").length,
        probes: requests.filter((r) => r.path.includes("bafkqaaa")).length,
      },
      null,
      2,
    ),
  );
} finally {
  for (const child of children.reverse()) {
    if (child.exitCode === null && child.pid) {
      if (process.platform === "win32") {
        execFileSync("powershell.exe", [
          "-NoProfile",
          "-Command",
          `function Stop-Tree([int]$processId) { Get-CimInstance Win32_Process | Where-Object ParentProcessId -eq $processId | ForEach-Object { Stop-Tree $_.ProcessId }; Stop-Process -Id $processId -ErrorAction SilentlyContinue }; Stop-Tree ${child.pid}; exit 0`,
        ]);
      } else {
        child.kill("SIGTERM");
      }
    }
  }
  proxy?.closeAllConnections?.();
  proxy?.close();
  await rm(temp, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 500,
  });
}
