import * as dagPb from "@ipld/dag-pb";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { gateway } from "../src/gateway.js";
import type { Bindings } from "../src/env.js";
import { PROBE_CID } from "../src/content.js";
import { migrate } from "./migrations.js";

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    compatibilityDate: "2026-10-14",
    r2Buckets: ["BLOCKS"],
    d1Databases: ["DB"],
  }),
);
const bytes = new Uint8Array([
  0, 255, 13, 10, 60, 115, 99, 114, 105, 112, 116, 62,
]);
let env: Bindings;
let cid: string;
let missing: string;
let legacyCid: CID;
let dagBytes: Uint8Array;
const request = (
  root: string,
  method = "GET",
  headers: Record<string, string> = {},
  query = "?format=raw",
) =>
  gateway.request(
    `http://example.test/ipfs/${root}${query}`,
    { method, headers },
    env,
  );
const etag = (root: string) => `"${root}.raw"`;

beforeAll(async () => {
  env = await mf.getBindings<Bindings>();
  await migrate(env.DB);
  cid = CID.createV1(0x55, await sha256.digest(bytes)).toString();
  missing = CID.createV1(
    0x55,
    await sha256.digest(new Uint8Array([99])),
  ).toString();
  dagBytes = dagPb.encode({ Data: bytes, Links: [] });
  legacyCid = CID.createV0(await sha256.digest(dagBytes));
  await env.BLOCKS.put(cid, bytes);
  await env.BLOCKS.put(legacyCid.toV1().toString(), dagBytes);
  const bucket = env.BLOCKS;
  // Snapshot RPC methods so spies can observe and inject storage failures.
  env = {
    ...env,
    BLOCKS: {
      ...bucket,
      get: bucket.get.bind(bucket),
      head: bucket.head.bind(bucket),
    },
  };
}, 30000);
afterEach(() => vi.restoreAllMocks());
afterAll(() => mf.dispose());

describe("raw gateway protocol", () => {
  it.each(["GET", "HEAD"])(
    "%s preserves raw bytes, representation headers and the empty probe",
    async (method) => {
      for (const root of [cid, PROBE_CID]) {
        const get = vi.spyOn(env.BLOCKS, "get");
        const head = vi.spyOn(env.BLOCKS, "head");
        const response = await request(root, method);
        expect(response.status).toBe(200);
        expect(response.headers.get("etag")).toBe(etag(root));
        expect(response.headers.get("content-type")).toBe(
          "application/vnd.ipld.raw",
        );
        expect(response.headers.get("content-length")).toBe(
          String(root === PROBE_CID ? 0 : bytes.length),
        );
        expect(response.headers.get("content-disposition")).toBe(
          `attachment; filename="${root}.bin"`,
        );
        expect(response.headers.get("content-security-policy")).toBe(
          "default-src 'none'; sandbox",
        );
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        expect(response.headers.get("access-control-allow-origin")).toBe("*");
        expect(response.headers.get("cache-control")).toBe(
          "public, max-age=29030400, immutable",
        );
        expect(response.headers.get("x-ipfs-path")).toBe(`/ipfs/${root}`);
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(
          method === "HEAD" || root === PROBE_CID ? new Uint8Array() : bytes,
        );
        expect(get).toHaveBeenCalledTimes(
          method === "GET" && root === cid ? 1 : 0,
        );
        expect(head).toHaveBeenCalledTimes(
          method === "HEAD" && root === cid ? 1 : 0,
        );
        vi.restoreAllMocks();
      }
    },
  );

  it("keeps GET and HEAD representation headers identical", async () => {
    for (const root of [cid, PROBE_CID]) {
      const get = await request(root);
      const head = await request(root, "HEAD");
      expect([...head.headers]).toEqual([...get.headers]);
      expect(await head.text()).toBe("");
    }
  });

  it.each(["GET", "HEAD"])(
    "%s weakly compares validators and lists only after checking availability",
    async (method) => {
      for (const root of [cid, PROBE_CID]) {
        for (const validator of [
          etag(root),
          `W/${etag(root)}`,
          `"other", W/${etag(root)}, "last"`,
          `"comma,inside", ${etag(root)}`,
          "*",
        ]) {
          const get = vi.spyOn(env.BLOCKS, "get");
          const head = vi.spyOn(env.BLOCKS, "head");
          const response = await request(root, method, {
            "if-none-match": validator,
          });
          expect(response.status).toBe(304);
          expect(response.body).toBeNull();
          expect(await response.text()).toBe("");
          expect(response.headers.get("etag")).toBe(etag(root));
          expect(response.headers.get("cache-control")).toContain("immutable");
          expect(response.headers.get("content-type")).toBe(
            "application/vnd.ipld.raw",
          );
          expect(get).not.toHaveBeenCalled();
          expect(head).toHaveBeenCalledTimes(root === PROBE_CID ? 0 : 1);
          vi.restoreAllMocks();
        }
        for (const validator of [
          '"other"',
          `W/"${root}"`,
          `"prefix${root}.raw"`,
          `invalid, ${etag(root)}`,
          `"unterminated`,
          "",
        ]) {
          const response = await request(root, method, {
            "if-none-match": validator,
          });
          expect(response.status).toBe(200);
          expect(new Uint8Array(await response.arrayBuffer())).toEqual(
            method === "GET" && root === cid ? bytes : new Uint8Array(),
          );
        }
      }
      for (const validator of [
        "*",
        etag(missing),
        `W/${etag(missing)}`,
        '"other"',
      ]) {
        expect(
          (await request(missing, method, { "if-none-match": validator }))
            .status,
        ).toBe(404);
      }
    },
  );

  it("normalizes equivalent CIDv0/v1 representations and validators", async () => {
    const canonical = legacyCid.toV1().toString();
    for (const root of [legacyCid.toString(), canonical]) {
      for (const method of ["GET", "HEAD"]) {
        const response = await request(root, method);
        expect(response.status).toBe(200);
        expect(response.headers.get("etag")).toBe(etag(canonical));
        expect(response.headers.get("content-length")).toBe(
          String(dagBytes.length),
        );
        expect(response.headers.get("x-ipfs-path")).toBe(`/ipfs/${root}`);
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(
          method === "GET" ? dagBytes : new Uint8Array(),
        );
        const conditional = await request(root, method, {
          "if-none-match": `W/${etag(canonical)}`,
        });
        expect(conditional.status).toBe(304);
        expect(conditional.headers.get("etag")).toBe(etag(canonical));
        expect(conditional.body).toBeNull();
      }
    }
  });

  it.each(["GET", "HEAD"])(
    "%s negotiates only acceptable raw media ranges",
    async (method) => {
      for (const accept of [
        "application/vnd.ipld.raw",
        "APPLICATION/VND.IPLD.RAW; Q=0.1",
        "application/*",
        "*/*",
        "text/html;q=1, application/vnd.ipld.raw;q=0.2",
        "application/vnd.ipld.car;q=1, application/*;q=0.5",
        "*/*;q=0, application/*;q=0.5",
        "application/*;q=0, application/vnd.ipld.raw;q=0.001",
        "application/vnd.ipld.raw;q=0, application/vnd.ipld.raw;q=1",
        'text/html;note="comma,semicolon;escaped\\"quote", application/vnd.ipld.raw',
        "application/vnd.ipld.raw;version=1, */*;q=0.5",
      ]) {
        const response = await request(cid, method, { accept }, "");
        expect(response.status, accept).toBe(200);
        expect(response.headers.get("content-type")).toBe(
          "application/vnd.ipld.raw",
        );
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(
          method === "GET" ? bytes : new Uint8Array(),
        );
      }
      for (const accept of [
        "application/vnd.ipld.raw;q=0",
        "application/vnd.ipld.raw;q=0.000",
        "application/vnd.ipld.raw-extra",
        "text/html",
        "application/vnd.ipld.car",
        "application/vnd.ipld.raw;q=0, */*;q=1",
        "application/*;q=0, */*;q=1",
        "application/vnd.ipld.raw;q=0, application/*;q=1",
        "application/vnd.ipld.raw;version=1",
        'application/vnd.ipld.raw;version="a,b;c"',
      ]) {
        expect(
          (await request(cid, method, { accept }, "")).status,
          accept,
        ).toBe(406);
      }
    },
  );

  it.each(["GET", "HEAD"])(
    "%s rejects malformed Accept but lets explicit format override it",
    async (method) => {
      for (const accept of [
        "",
        " ",
        "raw",
        "*/raw",
        "application /vnd.ipld.raw",
        "application/vnd.ipld.raw,",
        "application/vnd.ipld.raw;q=2",
        "application/vnd.ipld.raw;q=-1",
        "application/vnd.ipld.raw;q=NaN",
        "application/vnd.ipld.raw;q=.5",
        "application/vnd.ipld.raw;q=0.1234",
        'application/vnd.ipld.raw;q="0.5"',
        "application/vnd.ipld.raw;q=0;q=1",
        "application/vnd.ipld.raw;unknown",
        'application/vnd.ipld.raw;note="unterminated',
        "application/vnd.ipld.raw, text/html;q=invalid",
      ]) {
        expect(
          (await request(cid, method, { accept }, "")).status,
          accept,
        ).toBe(400);
        expect((await request(cid, method, { accept })).status, accept).toBe(
          200,
        );
      }
      expect((await request(cid, method, {}, "")).status).toBe(400);
      expect((await request(cid, method)).status).toBe(200);
      for (const query of [
        "?format=",
        "?format=car",
        "?format=RAW",
        "?format=html",
      ]) {
        expect(
          (
            await request(
              cid,
              method,
              { accept: "application/vnd.ipld.raw" },
              query,
            )
          ).status,
        ).toBe(406);
      }
      for (const accept of ["application/vnd.ipld.raw;q=0", "text/html"]) {
        expect((await request(cid, method, { accept })).status).toBe(200);
      }
    },
  );

  it.each(["GET", "HEAD"])(
    "%s applies only-if-cached to unavailable roots without network retrieval",
    async (method) => {
      const network = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("No remote retrieval"));
      for (const directive of [
        "only-if-cached",
        "ONLY-IF-CACHED",
        "max-age=0, Only-If-Cached, no-cache",
        'extension="contains,comma", only-if-cached',
      ]) {
        expect(
          (await request(missing, method, { "cache-control": directive }))
            .status,
        ).toBe(412);
        expect(
          (
            await request(missing, method, {
              "cache-control": directive,
              "if-none-match": "*",
            })
          ).status,
        ).toBe(412);
        for (const root of [cid, PROBE_CID]) {
          const response = await request(root, method, {
            "cache-control": directive,
          });
          expect(response.status).toBe(200);
          expect(new Uint8Array(await response.arrayBuffer())).toEqual(
            method === "GET" && root === cid ? bytes : new Uint8Array(),
          );
          const conditional = await request(root, method, {
            "cache-control": directive,
            "if-none-match": "*",
          });
          expect(conditional.status).toBe(304);
          expect(conditional.body).toBeNull();
        }
      }
      for (const directive of [
        "",
        "x-only-if-cached",
        "only-if-cached-extra",
        "only-if-cached=1",
        'extension="only-if-cached"',
        'extension="prefix,only-if-cached,suffix"',
        'extension="unterminated,only-if-cached',
      ]) {
        expect(
          (await request(missing, method, { "cache-control": directive }))
            .status,
        ).toBe(404);
      }
      expect(network).not.toHaveBeenCalled();
    },
  );

  it.each(["GET", "HEAD"])(
    "%s applies raw negotiation consistently to the probe",
    async (method) => {
      const get = vi.spyOn(env.BLOCKS, "get");
      const head = vi.spyOn(env.BLOCKS, "head");
      for (const [query, accept, status] of [
        ["", undefined, 400],
        ["", "", 400],
        ["", "application/vnd.ipld.raw;q=bad", 400],
        ["", "application/vnd.ipld.raw;q=0, */*", 406],
        ["", "application/vnd.ipld.raw-extra", 406],
        ["?format=", "application/vnd.ipld.raw", 406],
        ["?format=car", "application/vnd.ipld.raw", 406],
        ["?format=raw", undefined, 200],
        ["?format=raw", "text/html", 200],
        ["", "application/*", 200],
        ["", "*/*", 200],
      ] as const) {
        const response = await request(
          PROBE_CID,
          method,
          accept === undefined ? {} : { accept },
          query,
        );
        expect(response.status).toBe(status);
        if (status === 200) {
          expect(response.headers.get("etag")).toBe(etag(PROBE_CID));
          expect(response.headers.get("content-length")).toBe("0");
          expect(await response.text()).toBe("");
        }
      }
      expect(get).not.toHaveBeenCalled();
      expect(head).not.toHaveBeenCalled();
    },
  );

  it("does not turn storage failures into cache hits, 304s or missing roots", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const method of ["GET", "HEAD"]) {
      for (const validator of ["*", etag(cid), '"other"']) {
        const operation =
          method === "HEAD" || validator !== '"other"' ? "head" : "get";
        const failure = vi
          .spyOn(env.BLOCKS, operation)
          .mockRejectedValueOnce(new Error("R2 unavailable"));
        const response = await request(cid, method, {
          "if-none-match": validator,
          "cache-control": "only-if-cached",
        });
        expect(response.status).toBe(500);
        expect(failure).toHaveBeenCalledTimes(1);
        failure.mockRestore();
      }
    }
  });
});
