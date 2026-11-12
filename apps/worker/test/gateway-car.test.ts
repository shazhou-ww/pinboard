import { CarReader } from "@ipld/car";
import * as dagCbor from "@ipld/dag-cbor";
import * as dagPb from "@ipld/dag-pb";
import { importer } from "ipfs-unixfs-importer";
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
import {
  completeDag,
  importFile,
  key,
  PROBE_CID,
  type Dag,
} from "../src/content.js";
import type { Bindings } from "../src/env.js";
import { gateway } from "../src/gateway.js";
import { pathProof } from "../src/gateway-car.js";
import { storeDag } from "../src/storage.js";
import { createToken } from "../src/tokens.js";
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
const text = (value: string) => new TextEncoder().encode(value);
const signal = () => new AbortController().signal;
let env: Bindings;
let nested: Dag;
let folder: Dag;
let file: Dag;
let sibling: Dag;
let cbor: Dag;
let hamt: Dag;
let hamtPath: string[];
let hamtCids: CID[];
const query = "?format=car&dag-scope=block";
const get = (
  root: CID | string,
  path = "",
  search = query,
  method = "GET",
  headers: Record<string, string> = {},
) =>
  gateway.request(
    `http://example.test/ipfs/${root.toString()}${path}${search}`,
    { method, headers },
    env,
  );

async function node(
  bytes: Uint8Array,
  code: number,
  children: Dag[] = [],
): Promise<Dag> {
  const root = CID.createV1(code, await sha256.digest(bytes));
  const blocks = new Map(children.flatMap((dag) => [...dag.blocks]));
  blocks.set(key(root), bytes);
  return completeDag(root, (cid) => blocks.get(key(cid)));
}
async function directory(children: { name: string; dag: Dag }[]) {
  return node(
    dagPb.encode(
      dagPb.prepare({
        Data: new Uint8Array([8, 1]),
        Links: children.map(({ name, dag }) => ({
          Name: name,
          Hash: dag.root,
        })),
      }),
    ),
    dagPb.code,
    children.map(({ dag }) => dag),
  );
}
async function save(dag: Dag, visibility = "public") {
  await storeDag(env, dag);
  await env.DB.prepare(
    "INSERT INTO pins (account_id, cid, name, size, blocks, visibility) VALUES ('car-owner', ?, 'CAR proof', ?, ?, ?) ON CONFLICT(account_id, cid) DO UPDATE SET visibility = excluded.visibility",
  )
    .bind(key(dag.root), dag.size, dag.blocks.size, visibility)
    .run();
}

// This verifier does not call the gateway's traversal, storage or verification.
async function readProof(response: Response, root: CID) {
  expect(response.status).toBe(200);
  const reader = await CarReader.fromBytes(
    new Uint8Array(await response.arrayBuffer()),
  );
  expect((await reader.getRoots()).map((cid) => cid.toString())).toEqual([
    root.toString(),
  ]);
  const blocks = new Map<string, Uint8Array>();
  const cids: CID[] = [];
  for await (const { cid, bytes } of reader.blocks()) {
    expect(
      CID.createV1(cid.code, await sha256.digest(bytes)).equals(cid.toV1()),
    ).toBe(true);
    expect(blocks.has(key(cid))).toBe(false);
    blocks.set(key(cid), bytes);
    cids.push(cid);
  }
  return { blocks, cids };
}
async function verifyUnixFS(
  blocks: Map<string, Uint8Array>,
  root: CID,
  parts: string[],
): Promise<CID[]> {
  let cid = root;
  const visited = [root];
  for (const part of parts) {
    for (;;) {
      const bytes = blocks.get(key(cid));
      if (!bytes) throw new Error("Missing proof block");
      if (
        !CID.createV1(cid.code, await sha256.digest(bytes)).equals(cid.toV1())
      )
        throw new Error("Invalid hash");
      const pb = dagPb.decode(bytes);
      const sharded = pb.Data?.[1] === 5;
      const link = pb.Links.find((link) =>
        sharded ? link.Name?.slice(2) === part : link.Name === part,
      );
      if (link) {
        cid = link.Hash;
        visited.push(cid);
        break;
      }
      // Fixture shard paths are independently identified from their named leaf;
      // only one branch in the partial proof may lead to that leaf.
      const shards = pb.Links.filter(
        (link) =>
          sharded && link.Name?.length === 2 && blocks.has(key(link.Hash)),
      );
      if (shards.length !== 1) throw new Error("Missing path link");
      cid = shards[0]!.Hash;
      visited.push(cid);
    }
  }
  const terminal = blocks.get(key(cid));
  if (!terminal) throw new Error("Missing terminal");
  if (!CID.createV1(cid.code, await sha256.digest(terminal)).equals(cid.toV1()))
    throw new Error("Invalid terminal hash");
  return visited;
}

beforeAll(async () => {
  const bindings = await mf.getBindings<Bindings>();
  const bucket = bindings.BLOCKS;
  env = {
    ...bindings,
    BLOCKS: {
      ...bucket,
      get: bucket.get.bind(bucket),
      head: bucket.head.bind(bucket),
      put: bucket.put.bind(bucket),
      delete: bucket.delete.bind(bucket),
    },
  };
  await migrate(env.DB);
  await env.DB.prepare(
    "INSERT INTO accounts (id, provider, subject) VALUES ('car-owner', 'google', 'car-owner')",
  ).run();
  file = await importFile(new Uint8Array(700000).fill(42));
  sibling = await importFile(text("unrelated sibling"));
  folder = await directory([
    { name: "资料:CON?.bin", dag: file },
    { name: "copy", dag: file },
    { name: "%2f", dag: file },
    { name: "unrelated", dag: sibling },
  ]);
  nested = await directory([
    { name: "nested", dag: folder },
    { name: "sibling", dag: sibling },
  ]);
  const child = await node(
    dagCbor.encode({ list: ["inline", { leaf: file.root }], null: null }),
    dagCbor.code,
    [file],
  );
  cbor = await node(
    dagCbor.encode({ child: child.root, sibling: sibling.root, __key: 7 }),
    dagCbor.code,
    [child, sibling],
  );
  const hamtBlocks = new Map<string, Uint8Array>();
  let hamtRoot: CID | undefined;
  for await (const entry of importer(
    Array.from({ length: 60 }, (_, index) => ({
      path: `entry-${index}`,
      content: text(`entry-${index}`),
    })),
    {
      async put(cid, block) {
        const chunks: Uint8Array[] = [];
        if (block instanceof Uint8Array) chunks.push(block);
        else for await (const chunk of block) chunks.push(chunk);
        hamtBlocks.set(
          key(CID.parse(cid.toString())),
          Uint8Array.from(chunks.flatMap((chunk) => [...chunk])),
        );
        return cid;
      },
    },
    {
      wrapWithDirectory: true,
      shardSplitThresholdBytes: 1,
      cidVersion: 1,
      rawLeaves: true,
    },
  ))
    hamtRoot = CID.parse(entry.cid.toString());
  hamt = await completeDag(hamtRoot!, (cid) => hamtBlocks.get(key(cid)));
  // Select an actual sub-shard, not a HAMT that happens to resolve at the root.
  const shard = dagPb
    .decode(hamt.blocks.get(key(hamt.root))!)
    .Links.find((link) => link.Name?.length === 2)!;
  const leaf = dagPb
    .decode(hamt.blocks.get(key(shard.Hash))!)
    .Links.find((link) => link.Name!.length > 2)!;
  hamtPath = [leaf.Name!.slice(2)];
  hamtCids = [hamt.root, shard.Hash, leaf.Hash];
  for (const dag of [nested, cbor, hamt]) await save(dag);
}, 30000);
afterEach(() => vi.restoreAllMocks());
afterAll(() => mf.dispose());

describe("bounded standard CAR path proofs", () => {
  it("proves nested Unicode UnixFS paths, excludes siblings and terminal file chunks", async () => {
    const parts = ["nested", "资料:CON?.bin"];
    const response = await get(
      nested.root,
      "/" + parts.map(encodeURIComponent).join("/"),
    );
    const proof = await readProof(response, nested.root);
    expect(proof.cids.map(key)).toEqual(
      [nested.root, folder.root, file.root].map(key),
    );
    expect(
      (await verifyUnixFS(proof.blocks, nested.root, parts)).map(key),
    ).toEqual(proof.cids.map(key));
    expect(file.blocks.size).toBeGreaterThan(1);
    for (const cid of proof.cids)
      expect(proof.blocks.get(key(cid))).toEqual(nested.blocks.get(key(cid)));
    const deleted = new Map(proof.blocks);
    deleted.delete(key(folder.root));
    await expect(verifyUnixFS(deleted, nested.root, parts)).rejects.toThrow();
    const tampered = new Map(proof.blocks);
    tampered.set(key(folder.root), text("tampered"));
    await expect(verifyUnixFS(tampered, nested.root, parts)).rejects.toThrow(
      "Invalid hash",
    );
    const copy = await readProof(
      await get(nested.root, "/nested/copy"),
      nested.root,
    );
    expect(copy.cids.map(key)).toEqual(proof.cids.map(key));
    const directoryProof = await readProof(
      await get(nested.root, "/nested"),
      nested.root,
    );
    expect(directoryProof.cids.map(key)).toEqual(
      [nested.root, folder.root].map(key),
    );
    const encoded = await readProof(
      await get(nested.root, "/nested/%252f"),
      nested.root,
    );
    await verifyUnixFS(encoded.blocks, nested.root, ["nested", "%2f"]);
  });

  it("includes only the HAMT shards required to authenticate the selected entry", async () => {
    const proof = await readProof(
      await get(hamt.root, "/" + hamtPath[0]),
      hamt.root,
    );
    expect(proof.cids.map(key)).toEqual(hamtCids.map(key));
    expect(
      (await verifyUnixFS(proof.blocks, hamt.root, hamtPath)).map(key),
    ).toEqual(hamtCids.map(key));
    expect(proof.blocks.size).toBeLessThan(hamt.blocks.size);
  });

  it("proves DAG-CBOR map/list links and inline terminals without sibling traversal", async () => {
    for (const [path, terminal, expectedLength] of [
      ["/child/list/0", "inline", 2],
      ["/child/list/1", undefined, 2],
      ["/child/list/1/leaf", file.root, 3],
      ["/child/null", null, 2],
      ["/__key", 7, 1],
    ] as const) {
      const proof = await readProof(await get(cbor.root, path), cbor.root);
      expect(proof.blocks.size).toBe(expectedLength);
      let value: unknown = dagCbor.decode(proof.blocks.get(key(cbor.root))!);
      for (const part of path.slice(1).split("/")) {
        const cid = CID.asCID(value);
        if (cid) value = dagCbor.decode(proof.blocks.get(key(cid))!);
        value = (value as Record<string, unknown>)[part];
      }
      if (CID.asCID(terminal))
        expect(CID.asCID(value)?.equals(terminal as CID)).toBe(true);
      else if (terminal !== undefined) expect(value).toEqual(terminal);
      expect(proof.blocks.has(key(sibling.root))).toBe(false);
    }
  });

  it("preserves CIDv0 roots, linked CID versions and original bytes", async () => {
    const v0 = CID.createV0(
      await sha256.digest(file.blocks.get(key(file.root))!),
    );
    const bytes = dagPb.encode({
      Data: new Uint8Array([8, 1]),
      Links: [{ Name: "old", Hash: v0 }],
    });
    const legacy = await node(bytes, dagPb.code, [file]);
    await save(legacy);
    const root = CID.createV0(await sha256.digest(bytes));
    const proof = await readProof(await get(root, "/old"), root);
    expect(proof.cids.map((cid) => cid.version)).toEqual([0, 0]);
    await verifyUnixFS(proof.blocks, root, ["old"]);
    expect(proof.blocks.get(key(root))).toEqual(bytes);
  });

  it.each(["GET", "HEAD"])(
    "%s validates paths and proof availability before success or 304",
    async (method) => {
      const response = await get(nested.root, "/nested/copy", query, method);
      expect(response.status).toBe(200);
      const headers = response.headers;
      expect(headers.get("content-type")).toBe(
        "application/vnd.ipld.car; version=1; order=dfs; dups=n",
      );
      expect(headers.get("content-disposition")).toContain(".car");
      expect(headers.get("x-content-type-options")).toBe("nosniff");
      expect(headers.get("content-security-policy")).toBe(
        "default-src 'none'; sandbox",
      );
      expect(headers.get("cache-control")).toBe("private, no-store");
      expect(headers.get("access-control-allow-origin")).toBe("*");
      const body = await response.arrayBuffer();
      expect(body.byteLength).toBe(
        method === "HEAD" ? 0 : Number(headers.get("content-length")),
      );
      for (const validator of [
        "*",
        `W/${headers.get("etag")}`,
        `"other", ${headers.get("etag")}`,
      ]) {
        const conditional = await get(
          nested.root,
          "/nested/copy",
          query,
          method,
          { "if-none-match": validator },
        );
        expect(conditional.status).toBe(304);
        expect(conditional.body).toBeNull();
        expect([...conditional.headers]).toEqual([...headers]);
        expect(
          (
            await get(nested.root, "/nested/missing", query, method, {
              "if-none-match": validator,
            })
          ).status,
        ).toBe(404);
      }
      const other = await get(nested.root, "/nested", query, method);
      expect(other.headers.get("etag")).not.toBe(headers.get("etag"));
      await other.arrayBuffer();
      const raw = await get(nested.root, "", "?format=raw", method);
      expect(raw.headers.get("etag")).not.toBe(headers.get("etag"));
      await raw.arrayBuffer();
    },
  );

  it.each(["GET", "HEAD"])(
    "%s emits a valid header-only identity probe CAR",
    async (method) => {
      const read = vi.spyOn(env.BLOCKS, "get");
      for (const [search, headers] of [
        ["?format=car", {}],
        ["", { accept: "application/vnd.ipld.car" }],
        [query, {}],
      ] as const) {
        const response = await get(PROBE_CID, "", search, method, headers);
        expect(response.status).toBe(200);
        expect(Number(response.headers.get("content-length"))).toBeGreaterThan(
          0,
        );
        if (method === "GET")
          expect(
            (await readProof(response, CID.parse(PROBE_CID))).blocks.size,
          ).toBe(0);
        else expect(await response.text()).toBe("");
      }
      expect(read).not.toHaveBeenCalled();
      expect(
        (
          await get(PROBE_CID, "/missing", query, method, {
            "if-none-match": "*",
          })
        ).status,
      ).toBe(404);
      expect(
        (await get(PROBE_CID, "", query + "&dag-scope=entity", method)).status,
      ).toBe(400);
    },
  );

  it.each(["GET", "HEAD"])(
    "%s applies only-if-cached only to authorized missing roots, before conditional success",
    async (method) => {
      const absent = await importFile(
        text(`authorized absent CAR root ${method}`),
      );
      await env.DB.prepare(
        "INSERT INTO pins (account_id, cid, name, size, blocks, visibility) VALUES ('car-owner', ?, 'Missing public root', ?, 1, 'public')",
      )
        .bind(key(absent.root), absent.size)
        .run();
      for (const validator of [undefined, "*", '"unrelated"']) {
        const conditional: Record<string, string> =
          validator === undefined ? {} : { "if-none-match": validator };
        expect(
          (await get(absent.root, "", query, method, conditional)).status,
        ).toBe(404);
        for (const directive of [
          "only-if-cached",
          "max-age=0, Only-If-Cached",
        ]) {
          expect(
            (
              await get(absent.root, "", query, method, {
                ...conditional,
                "cache-control": directive,
              })
            ).status,
          ).toBe(412);
        }
        expect(
          (
            await get(nested.root, "/missing", query, method, {
              ...conditional,
              "cache-control": "only-if-cached",
            })
          ).status,
        ).toBe(404);
      }
      const probe = await get(PROBE_CID, "", "?format=car", method, {
        "cache-control": "only-if-cached",
        "if-none-match": "*",
      });
      expect(probe.status).toBe(304);
      expect(probe.body).toBeNull();
    },
  );

  it("negotiates honest CAR variants with query precedence and raw fallback", async () => {
    const implicitProbe = await get(PROBE_CID, "", "?format=car", "HEAD");
    const explicitProbe = await get(PROBE_CID, "", query, "HEAD");
    expect(implicitProbe.headers.get("etag")).not.toBe(
      explicitProbe.headers.get("etag"),
    );
    for (const [search, accept] of [
      [
        "?dag-scope=block",
        'APPLICATION/VND.IPLD.CAR; version="1"; order=dfs; dups=n; q=0.1',
      ],
      [query, "malformed"],
      [
        "?dag-scope=block&car-version=1&car-dups=n",
        "application/vnd.ipld.car;version=2;dups=y",
      ],
    ] as const) {
      const response = await get(nested.root, "", search, "GET", { accept });
      expect((await readProof(response, nested.root)).blocks.size).toBe(1);
    }
    for (const [search, status] of [
      ["?format=car", 406],
      [query + "&car-version=2", 406],
      [query + "&car-order=unk", 406],
      [query + "&car-dups=y", 406],
      [query + "&entity-bytes=0:1", 406],
      ["?format=car&dag-scope=entity", 406],
      ["?format=car&dag-scope=all", 406],
      ["?format=car&dag-scope=", 400],
      ["?format=car&dag-scope=bad", 400],
      [query + "&dag-scope=block", 400],
      [query + "&car-version=1&car-version=2", 400],
    ] as const)
      expect((await get(nested.root, "", search)).status).toBe(status);
    for (const accept of [
      "application/vnd.ipld.car;version=2",
      "application/vnd.ipld.car;dups=y",
      "application/vnd.ipld.car;order=bfs",
      "application/vnd.ipld.car;unknown=1",
      "application/vnd.ipld.car;q=0",
    ])
      expect(
        (await get(nested.root, "", "?dag-scope=block", "GET", { accept }))
          .status,
      ).toBe(406);
    for (const search of [
      "",
      "?dag-scope=all",
      "?dag-scope=entity",
      "?dag-scope=block&car-version=2",
      "?dag-scope=block&entity-bytes=0:1",
    ]) {
      const response = await get(nested.root, "", search, "GET", {
        accept: "application/vnd.ipld.car, application/vnd.ipld.raw;q=0.2",
      });
      expect(response.headers.get("content-type")).toBe(
        "application/vnd.ipld.raw",
      );
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(
        nested.blocks.get(key(nested.root)),
      );
    }
  });

  it("rejects malformed, absent and unsupported paths without ZIP filename restrictions", async () => {
    for (const path of [
      "/%",
      "/%FF",
      "/a%2fb",
      "/a%5Cb",
      "/%00",
      "/nested//copy",
      "/%2E%2E%2F",
    ]) {
      expect((await get(nested.root, path)).status, path).toBe(400);
    }
    expect((await get(nested.root, "/" + "x".repeat(8192))).status).toBe(414);
    expect(
      (await get(nested.root, "/" + Array(258).fill("a").join("/"))).status,
    ).toBe(400);
    for (const path of [
      "/unknown",
      "/nested/copy/extra",
      "/nested/copy/extra/more",
    ])
      expect((await get(nested.root, path)).status).toBe(404);
    for (const path of [
      "/child/list/01",
      "/child/list/-1",
      "/child/list/3",
      "/child/list/length",
      "/child/list/0/more",
      "/child/null/x",
      "/toString",
    ])
      expect((await get(cbor.root, path)).status, path).toBe(404);
    expect((await get(nested.root, "/nested", "?format=raw")).status).toBe(406);
    expect(
      (
        await get(nested.root, "/nested", query, "GET", {
          "service-worker": " script ",
        })
      ).status,
    ).toBe(400);
    const trailing = await readProof(
      await get(nested.root, "/nested/"),
      nested.root,
    );
    expect(trailing.cids.map(key)).toEqual([nested.root, folder.root].map(key));
    expect((await get("bad", "", query)).status).toBe(400);
  });

  it("does not mistake stored private, deleted or unknown roots for public authorization", async () => {
    const privateDag = await importFile(text("private CAR"));
    await save(privateDag, "private");
    const unknown = await importFile(text("unknown CAR"));
    const unpinned = await importFile(
      text("stored CAR with no live reference"),
    );
    await storeDag(env, unpinned);
    const deleted = await importFile(text("deleted CAR"));
    await save(deleted);
    await env.DB.prepare(
      "INSERT INTO deleted_pins (account_id, cid, deleted_at, expires_at) VALUES ('car-owner', ?, '2026-11-12', '2099-01-01')",
    )
      .bind(key(deleted.root))
      .run();
    for (const dag of [privateDag, unknown, unpinned, deleted]) {
      const read = vi.spyOn(env.BLOCKS, "get");
      expect(
        (
          await get(dag.root, "", query, "HEAD", {
            "if-none-match": "*",
            "cache-control": "only-if-cached",
          })
        ).status,
      ).toBe(404);
      expect(read).not.toHaveBeenCalled();
      read.mockRestore();
    }
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No fetch"));
    const proof = await readProof(
      await get(nested.root, "/nested/copy"),
      nested.root,
    );
    expect(proof.blocks.size).toBe(3);
    expect(network).not.toHaveBeenCalled();
  });

  it("allows live members and owner-authorized private paths without widening anonymous access", async () => {
    const memberProof = await readProof(
      await get(folder.root, "/copy"),
      folder.root,
    );
    expect(memberProof.cids.map(key)).toEqual(
      [folder.root, file.root].map(key),
    );
    const privateRoot = await directory([{ name: "private-name", dag: file }]);
    await save(privateRoot, "private");
    const principal = {
      accountId: "car-owner",
      scopes: ["pins:read"] as const,
      kind: "session" as const,
    };
    const { token } = await createToken(env, principal, {
      name: "CAR owner",
      scopes: ["pins:read"],
      expiresInDays: 1,
    });
    const headers = { authorization: `Bearer ${token}` };
    const owner = await readProof(
      await get(privateRoot.root, "/private-name", query, "GET", headers),
      privateRoot.root,
    );
    expect(owner.cids.map(key)).toEqual([privateRoot.root, file.root].map(key));
    expect(
      (
        await get(privateRoot.root, "/private-name", query, "HEAD", {
          ...headers,
          "if-none-match": "*",
        })
      ).status,
    ).toBe(304);
    expect(
      (
        await get(privateRoot.root, "/private-name", query, "HEAD", {
          "if-none-match": "*",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await get(privateRoot.root, "/private-name", query, "GET", {
          authorization: "Bearer invalid",
        })
      ).status,
    ).toBe(401);
  });

  it("fails before response headers for missing, corrupt and faulty indexed blocks", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const method of ["GET", "HEAD"]) {
      const read = vi
        .spyOn(env.BLOCKS, "get")
        .mockRejectedValueOnce(new Error("storage down"));
      expect(
        (await get(nested.root, "", query, method, { "if-none-match": "*" }))
          .status,
      ).toBe(500);
      read.mockRestore();
    }
    const broken = await directory([
      { name: "broken", dag: await importFile(text("lost child")) },
    ]);
    await save(broken);
    const row = await env.DB.prepare(
      "SELECT object_key FROM car_dags WHERE root = ?",
    )
      .bind(key(broken.root))
      .first<{ object_key: string }>();
    await env.BLOCKS.delete(row!.object_key);
    for (const method of ["GET", "HEAD"])
      expect(
        (
          await get(broken.root, "/broken", query, method, {
            "if-none-match": "*",
            "cache-control": "only-if-cached",
          })
        ).status,
      ).toBe(503);
    const legacy = await directory([
      { name: "file", dag: await importFile(text("legacy missing child")) },
    ]);
    await save(legacy);
    await env.DB.prepare(
      "DELETE FROM car_blocks WHERE cid IN (SELECT cid FROM dag_members WHERE root = ?)",
    )
      .bind(key(legacy.root))
      .run();
    await env.BLOCKS.put(
      key(legacy.root),
      legacy.blocks.get(key(legacy.root))!,
    );
    for (const method of ["GET", "HEAD"])
      expect(
        (
          await get(legacy.root, "/file", query, method, {
            "if-none-match": "*",
            "cache-control": "only-if-cached",
          })
        ).status,
      ).toBe(503);
    await env.BLOCKS.put(key(legacy.root), text("tampered"));
    expect((await get(legacy.root)).status).toBe(503);
    await env.BLOCKS.delete(key(legacy.root));
    expect(
      (await get(legacy.root, "", query, "HEAD", { "if-none-match": "*" }))
        .status,
    ).toBe(404);
  });

  it("preserves storage errors encountered inside a HAMT resolver", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const original = env.BLOCKS.get.bind(env.BLOCKS);
    const shardFailure = vi
      .spyOn(env.BLOCKS, "get")
      .mockImplementationOnce(original)
      .mockRejectedValueOnce(new Error("HAMT storage failure"));
    expect(
      (
        await get(hamt.root, "/" + hamtPath[0], query, "HEAD", {
          "if-none-match": "*",
        })
      ).status,
    ).toBe(500);
    expect(shardFailure).toHaveBeenCalledTimes(2);
  });

  it("cancels oversized or aborted storage streams and rejects truncated payloads", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const legacy = await importFile(text("bounded stream fixture"));
    await save(legacy);
    await env.DB.prepare("DELETE FROM car_blocks WHERE cid = ?")
      .bind(key(legacy.root))
      .run();
    for (const [declared, actual, status] of [
      [2 * 1024 * 1024 + 1, 0, 413],
      [1, 2 * 1024 * 1024 + 1, 413],
      [10, 1, 503],
    ] as const) {
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(actual));
        },
        pull(controller) {
          // Keep oversized streams open so cancellation is observable.
          if (actual <= 1 && declared <= 10) controller.close();
        },
        cancel,
      });
      const read = vi
        .spyOn(env.BLOCKS, "get")
        .mockResolvedValueOnce({ size: declared, body } as R2ObjectBody);
      expect((await get(legacy.root)).status).toBe(status);
      if (status === 413) expect(cancel).toHaveBeenCalled();
      read.mockRestore();
    }
    const abort = new AbortController();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    vi.spyOn(env.BLOCKS, "get").mockImplementationOnce(() => {
      setTimeout(() => {
        abort.abort(new Error("client disconnected"));
      }, 10);
      return Promise.resolve({ size: 10, body } as R2ObjectBody);
    });
    const response = await gateway.request(
      new Request(
        `http://example.test/ipfs/${legacy.root.toString()}${query}`,
        {
          signal: abort.signal,
        },
      ),
      undefined,
      env,
    );
    expect(response.status).toBe(500);
    expect(cancel).toHaveBeenCalledWith(abort.signal.reason);
  });

  it("explicitly rejects non-UnixFS DAG-PB paths, invalid CBOR and scalar child traversal", async () => {
    const pb = await node(dagPb.encode({ Links: [] }), dagPb.code);
    await save(pb);
    expect((await get(pb.root, "/Links")).status).toBe(422);
    const bytes = new Uint8Array([255]);
    const root = CID.createV1(dagCbor.code, await sha256.digest(bytes));
    await save({
      root,
      blocks: new Map([[key(root), bytes]]),
      size: bytes.length,
    });
    expect((await get(root, "/child")).status).toBe(503);
    expect((await get(sibling.root, "/child")).status).toBe(404);
    const raw = await importFile(text("byte array"));
    const byteMap = await node(
      dagCbor.encode({ bytes: text("not a list") }),
      dagCbor.code,
    );
    await save(byteMap);
    expect((await get(byteMap.root, "/bytes/0")).status).toBe(404);
    expect(
      (
        await pathProof(
          raw.root,
          [],
          (cid) => raw.blocks.get(key(cid)),
          signal(),
        )
      ).length,
    ).toBe(1);
  });

  it("retains default image and explicit raw bytes while CAR is a separate representation", async () => {
    const imageBytes = text("image gateway regression");
    const image = await importFile(imageBytes);
    await save(image);
    await env.DB.prepare(
      "INSERT INTO preview_images (cid, bytes, width, height) VALUES (?, ?, 1, 1)",
    )
      .bind(key(image.root), imageBytes)
      .run();
    for (const headers of [
      {},
      { accept: "image/webp" },
      { accept: "application/vnd.ipld.car, image/webp" },
    ]) {
      const response = await get(image.root, "", "", "GET", headers);
      expect(response.headers.get("content-type")).toBe("image/webp");
      expect(response.headers.get("etag")).toBe(
        `"${image.root.toString()}.webp"`,
      );
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(imageBytes);
    }
    const raw = await get(image.root, "", "?format=raw");
    expect(raw.headers.get("content-type")).toBe("application/vnd.ipld.raw");
    expect(new Uint8Array(await raw.arrayBuffer())).toEqual(imageBytes);
    const car = await get(image.root);
    expect(car.headers.get("etag")).not.toBe(raw.headers.get("etag"));
    expect(
      (await readProof(car, image.root)).blocks.get(key(image.root)),
    ).toEqual(imageBytes);
  });

  it("bounds proof blocks, total bytes, individual bytes and checks cancellation", async () => {
    const root = file.root;
    const read = vi.fn(() => file.blocks.get(key(root)));
    const abort = new AbortController();
    abort.abort(new Error("cancelled"));
    await expect(pathProof(root, [], read, abort.signal)).rejects.toThrow(
      "cancelled",
    );
    expect(read).not.toHaveBeenCalled();
    const duringRead = new AbortController();
    await expect(
      pathProof(
        root,
        [],
        () => {
          duringRead.abort(new Error("cancelled during read"));
          return file.blocks.get(key(root));
        },
        duringRead.signal,
      ),
    ).rejects.toThrow("cancelled during read");
    await expect(
      pathProof(root, [], () => new Uint8Array(2 * 1024 * 1024 + 1), signal()),
    ).rejects.toMatchObject({ status: 413 });
    let tail = await importFile(text("chain terminal"));
    const chain = new Map(tail.blocks);
    for (let index = 0; index < 256; index++) {
      const bytes = dagCbor.encode({ next: tail.root });
      const cid = CID.createV1(dagCbor.code, await sha256.digest(bytes));
      chain.set(key(cid), bytes);
      tail = { root: cid, blocks: chain, size: 0 };
    }
    await expect(
      pathProof(
        tail.root,
        Array<string>(256).fill("next"),
        (cid) => chain.get(key(cid)),
        signal(),
      ),
    ).rejects.toMatchObject({ status: 413 });
    const large = new Map<string, Uint8Array>();
    let link = file.root;
    for (let index = 0; index < 18; index++) {
      const bytes = dagCbor.encode({
        next: link,
        padding: new Uint8Array(1900000),
      });
      link = CID.createV1(dagCbor.code, await sha256.digest(bytes));
      large.set(key(link), bytes);
    }
    await expect(
      pathProof(
        link,
        Array<string>(17).fill("next"),
        (cid) => large.get(key(cid)),
        signal(),
      ),
    ).rejects.toMatchObject({ status: 413 });
  });
});
