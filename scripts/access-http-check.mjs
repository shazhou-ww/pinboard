// Operator-invoked smoke checks. Uses supplied real scoped credentials, never database/auth fixtures.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
const origin = new URL(
  process.env.PINBOARD_ACCEPTANCE_ORIGIN ?? "http://127.0.0.1:8787",
).origin;
assert(
  ["localhost", "127.0.0.1"].includes(new URL(origin).hostname) ||
    process.env.PINBOARD_ACCEPTANCE_ALLOW_REMOTE === "1",
  "Remote checks require explicit PINBOARD_ACCEPTANCE_ALLOW_REMOTE=1",
);
const owner = process.env.PINBOARD_ACCEPTANCE_TOKEN;
const other = process.env.PINBOARD_ACCEPTANCE_OTHER_TOKEN;
const read = process.env.PINBOARD_ACCEPTANCE_READ_ONLY_TOKEN;
const upload = process.env.PINBOARD_ACCEPTANCE_UPLOAD_ONLY_TOKEN;
assert(
  owner,
  "PINBOARD_ACCEPTANCE_TOKEN must be a real Agent token with all pin/publication scopes",
);
const missing = [
  ["other-account", other],
  ["read-only", read],
  ["upload-only", upload],
]
  .filter(([, token]) => !token)
  .map(([name]) => name);
assert(
  !missing.length || process.env.PINBOARD_ACCEPTANCE_ALLOW_PARTIAL === "1",
  `Missing supplied credentials: ${missing.join(", ")}. Partial checks require explicit PINBOARD_ACCEPTANCE_ALLOW_PARTIAL=1`,
);
const prefix = `access-smoke-${Date.now()}-${randomUUID()}`;
const pins = [],
  publications = [],
  checks = [];
const request = async (path, token, init = {}) => {
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  return fetch(new URL(path, origin), {
    ...init,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(60000),
  });
};
const json = (body, method = "POST") => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
async function expectStatus(path, token, status, init) {
  const response = await request(path, token, init);
  assert.equal(
    response.status,
    status,
    `${path}: expected ${status}, received ${response.status}`,
  );
  return response;
}
async function visibility(kind, id, value) {
  return (
    await expectStatus(
      `/api/${kind}/${id}/visibility`,
      owner,
      200,
      json({ visibility: value, acknowledge: true }, "PATCH"),
    )
  ).json();
}
const check = (name) => checks.push({ name, result: "passed" });
let failure;
try {
  await expectStatus("/api/health", undefined, 200);
  await expectStatus("/api/pins", owner, 200);
  let otherPublicationWriteDeniedByScope = false;
  if (other) {
    const otherPublications = await request("/api/publications", other);
    assert(
      otherPublications.status === 200 || otherPublications.status === 403,
      "Other-account credential must authenticate; publication scope denial must be explicit",
    );
    otherPublicationWriteDeniedByScope = otherPublications.status === 403;
    await otherPublications.body?.cancel();
  }
  const bytes = new TextEncoder().encode((prefix + "\n").repeat(12000));
  const pin = await (
    await expectStatus(
      `/api/pins/upload?kind=file&name=${encodeURIComponent(prefix)}`,
      owner,
      201,
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: bytes,
      },
    )
  ).json();
  assert.equal(pin.visibility, "private");
  assert(pin.blocks > 1, "Fixture must be a complete multiblock DAG");
  pins.push({ cid: pin.cid, token: owner });
  const created = await (
    await expectStatus(
      "/api/publications",
      owner,
      201,
      json({
        title: prefix + "-publication",
        cid: pin.cid,
        requestId: randomUUID(),
      }),
    )
  ).json();
  const id = created.publication.id;
  publications.push(id);
  assert.equal(created.publication.visibility, "private");
  check("New multiblock Pin and Publication default private");
  const rpc = await expectStatus("/mcp", owner, 200, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "block_get", arguments: { cid: pin.cid } },
    }),
  });
  const mcpRead = (await rpc.json()).result;
  assert(!mcpRead.isError, "Scoped MCP private block read failed");
  const mcpBlock = JSON.parse(mcpRead.content[0].text);
  assert.equal(mcpBlock.byteAccess, "private");
  const ownerRaw = await expectStatus(
    `/ipfs/${pin.cid}?format=raw&access=v1`,
    owner,
    200,
  );
  assert.deepEqual(
    new Uint8Array(Buffer.from(mcpBlock.contentBase64, "base64")),
    new Uint8Array(await ownerRaw.arrayBuffer()),
  );
  check(
    "Real supplied MCP credential reads private raw bytes without public sharing",
  );
  for (const token of [undefined, other, upload].filter(
    (token, index) => index === 0 || token,
  )) {
    for (const path of [
      `/ipfs/${pin.cid}?format=raw&access=v1`,
      `/api/public/${pin.cid}/car?access=v1`,
      `/api/public/${pin.cid}/download?access=v1`,
      `/api/public/publications/${id}/history`,
      `/api/public/publications/${id}/versions/1/nodes/${pin.cid}/description`,
      `/api/public/publications/${id}/download/1?format=original`,
    ]) {
      for (const method of ["GET", "HEAD"]) {
        const denied = await expectStatus(path, token, 404, {
          method,
          headers: { "if-none-match": "*" },
        });
        assert.equal(denied.headers.get("etag"), null);
        assert.equal(denied.headers.get("cache-control"), "private, no-store");
        await denied.body?.cancel();
      }
    }
  }
  check(
    "Private raw/CAR/original/history/description GET, HEAD and 304 requests denied",
  );
  const providers = await (
    await expectStatus(`/routing/v1/providers/${pin.cid}`, undefined, 200)
  ).json();
  assert.deepEqual(providers, { Providers: [] });
  check("Private provider discovery does not advertise");
  if (other) {
    await expectStatus(
      "/api/pins",
      other,
      404,
      json({ cid: pin.cid, name: prefix + "-denied" }),
    );
    const root = new Uint8Array(
      await (
        await expectStatus(`/ipfs/${pin.cid}?format=raw&access=v1`, owner, 200)
      ).arrayBuffer(),
    );
    await expectStatus(
      `/api/pins/upload?kind=block&cid=${pin.cid}&name=${encodeURIComponent(prefix + "-completion-denied")}`,
      other,
      404,
      { method: "POST", body: root },
    );
    await expectStatus(
      "/api/publications",
      other,
      otherPublicationWriteDeniedByScope ? 403 : 404,
      json({
        title: prefix + "-denied",
        cid: pin.cid,
        requestId: randomUUID(),
      }),
    );
    check(
      "Other account cannot acquire private roots by CID, omitted-block completion or publication creation",
    );
    if (otherPublicationWriteDeniedByScope)
      check(
        "Other account's Publication creation is denied by its limited scopes; full-scope cross-account Publication ownership is covered by local authorization tests",
      );
  }
  for (const token of [read, upload].filter(Boolean)) {
    await expectStatus(
      `/api/pins/${pin.cid}/visibility`,
      token,
      403,
      json({ visibility: "public", acknowledge: true }, "PATCH"),
    );
  }
  if (read) {
    const readable = await expectStatus(
      `/api/public/${pin.cid}/download?access=v1`,
      read,
      200,
    );
    assert.deepEqual(new Uint8Array(await readable.arrayBuffer()), bytes);
    check("Owner read-only credential can read bytes, not change access");
  }
  await visibility("publications", id, "public");
  const publicRead = await expectStatus(
    `/ipfs/${pin.cid}?format=raw&access=v1`,
    undefined,
    200,
  );
  const etag = publicRead.headers.get("etag");
  assert.equal(publicRead.headers.get("cache-control"), "private, no-store");
  await publicRead.body?.cancel();
  await expectStatus(`/ipfs/${pin.cid}?format=raw&access=v1`, undefined, 304, {
    headers: { "if-none-match": etag },
  });
  assert.equal(
    (await (await expectStatus(`/api/pins/${pin.cid}`, owner, 200)).json())
      .visibility,
    "private",
  );
  const privatePublication = await (
    await expectStatus(
      "/api/publications",
      owner,
      201,
      json({
        title: prefix + "-isolated",
        cid: pin.cid,
        requestId: randomUUID(),
      }),
    )
  ).json();
  publications.push(privatePublication.publication.id);
  await expectStatus(
    `/api/public/publications/${privatePublication.publication.id}`,
    undefined,
    404,
  );
  check(
    "Public byte overlap leaves private Pin and separate Publication metadata isolated",
  );
  await visibility("publications", id, "private");
  await expectStatus(`/ipfs/${pin.cid}?format=raw&access=v1`, undefined, 404, {
    method: "HEAD",
    headers: { "if-none-match": etag },
  });
  await expectStatus(`/api/public/publications/${id}/history`, undefined, 404, {
    headers: { "if-none-match": "*" },
  });
  check(
    "Last public reference revocation denies new anonymous reads and validators",
  );
  await expectStatus(`/api/publications/${id}`, owner, 204, {
    method: "DELETE",
  });
  const restored = await (
    await expectStatus(`/api/publications/${id}/restore`, owner, 200, json({}))
  ).json();
  assert.equal(restored.visibility, "private");
  await expectStatus(`/api/public/publications/${id}/history`, undefined, 404);
  check(
    "Restore preserves private access and does not reopen anonymous history",
  );
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  const cleanup = [];
  for (const id of publications) {
    try {
      await visibility("publications", id, "private");
      await expectStatus(`/api/publications/${id}`, owner, 204, {
        method: "DELETE",
      });
    } catch {
      cleanup.push({ kind: "publication", id, result: "cleanup incomplete" });
    }
  }
  for (const { cid, token } of pins) {
    try {
      await expectStatus(`/api/pins/${cid}`, token, 204, { method: "DELETE" });
    } catch {
      cleanup.push({ kind: "pin", id: cid, result: "cleanup incomplete" });
    }
  }
  const report = {
    origin,
    prefix,
    status:
      failure || cleanup.length
        ? "failed"
        : missing.length
          ? "partial"
          : "passed",
    checks,
    missingCredentialChecks: missing,
    failure,
    cleanup,
    fixtureIds: { pins: pins.map(({ cid }) => cid), publications },
  };
  const output = process.env.PINBOARD_ACCEPTANCE_REPORT;
  if (output) {
    const path = resolve(output),
      pathRelative = relative(process.cwd(), path);
    assert(
      !pathRelative.startsWith("..") && !isAbsolute(pathRelative),
      "Report must stay in the current project",
    );
    await writeFile(path, JSON.stringify(report, null, 2) + "\n");
  }
  console.log(JSON.stringify(report, null, 2));
  process.exitCode =
    report.status === "passed" ? 0 : report.status === "partial" ? 2 : 1;
}
