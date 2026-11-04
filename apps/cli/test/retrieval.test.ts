import { CarReader } from "@ipld/car";
import {
  createWriter,
  blockLength,
  headerLength,
} from "@ipld/car/buffer-writer";
import * as dagPb from "@ipld/dag-pb";
import * as dagCbor from "@ipld/dag-cbor";
import { uploadLimits } from "@shazhou/pinboard-contracts";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "../src/client.js";
import { run } from "../src/cli.js";
import { prepareInput } from "../src/input.js";
import {
  maxCarBytes,
  pinFilename,
  saveContent,
  verifyCar,
} from "../src/retrieval.js";
import { Store } from "../src/store.js";

const directory = resolve(
  process.env.PINBOARD_TEST_ROOT ?? ".",
  ".retrieval-tests",
);
const signal = () => new AbortController().signal;
const origin = "https://example.com";
const data = new Uint8Array([0, 255, 128, 10, 0]);

beforeAll(async () => {
  await mkdir(directory, { recursive: true });
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function block(bytes: Uint8Array, code = 0x55) {
  return { cid: CID.createV1(code, await sha256.digest(bytes)), bytes };
}
interface Block {
  cid: CID;
  bytes: Uint8Array;
}

function car(
  blocks: Block[],
  roots: CID[] = [blocks[0]!.cid],
): Uint8Array<ArrayBuffer> {
  const length =
    headerLength({ roots }) +
    blocks.reduce((sum, entry) => sum + blockLength(entry), 0);
  const writer = createWriter(new ArrayBuffer(length), { roots });
  for (const entry of blocks) writer.write(entry);
  return new Uint8Array(writer.close());
}

async function folder(names: string[]) {
  const child = await block(data);
  const root = await block(
    dagPb.encode(
      dagPb.prepare({
        Data: new Uint8Array([8, 1]),
        Links: names.map((Name) => ({
          Name,
          Hash: child.cid,
          Tsize: data.length,
        })),
      }),
    ),
    dagPb.code,
  );
  return { bytes: car([root, child]), root: root.cid.toString() };
}

async function invoke(
  args: string[],
  fetcher: typeof fetch,
  options: {
    tty?: boolean;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  let out = "",
    err = "";
  const capture = (write: (text: string) => void) =>
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        write(chunk.toString());
        done();
      },
    });
  const code = await run(args, {
    env: {
      LOCALAPPDATA: directory,
      XDG_CONFIG_HOME: directory,
      PINBOARD_ENDPOINT: origin,
      ...options.env,
    },
    input: Readable.from([]),
    out: Object.assign(
      capture((text) => {
        out += text;
      }),
      { isTTY: options.tty ?? false },
    ),
    err: capture((text) => {
      err += text;
    }),
    signal: options.signal ?? signal(),
    fetcher,
  });
  return { code, out, err };
}

function response(bytes: Uint8Array<ArrayBuffer>) {
  return new Response(bytes, {
    headers: { "content-type": "application/vnd.ipld.car; version=1" },
  });
}

describe("verified CAR retrieval and file restoration", () => {
  it.each([new Uint8Array(), data])(
    "round-trips raw bytes, including empty files",
    async (bytes) => {
      const raw = await block(bytes);
      const target = join(directory, `raw-${bytes.length}`);
      const result = await saveContent(
        car([raw]),
        raw.cid.toString(),
        target,
        false,
        signal(),
      );
      expect(result).toEqual({
        cid: raw.cid.toString(),
        path: target,
        type: "file",
        size: bytes.length,
      });
      expect(new Uint8Array(await readFile(target))).toEqual(bytes);
    },
  );

  it("round-trips uploaded directories, hidden files, nested Unicode names and chunked files", async () => {
    const source = join(directory, "source");
    await mkdir(join(source, "nested"), { recursive: true });
    const large = new Uint8Array(1024 * 1024 + 19);
    for (let index = 0; index < large.length; index++)
      large[index] = index % 251;
    const entries = [
      { parts: [".hidden"], bytes: data },
      { parts: ["nested", "\u6587\u4ef6.bin"], bytes: large },
      { parts: ["empty"], bytes: new Uint8Array() },
    ];
    for (const entry of entries)
      await writeFile(join(source, ...entry.parts), entry.bytes);
    const input = await prepareInput(source, false, undefined, signal());
    const destination = join(directory, "restored");
    const result = await saveContent(
      input.bytes,
      input.root!,
      destination,
      false,
      signal(),
    );
    expect(result.type).toBe("directory");
    expect(result.size).toBe(large.length + data.length);
    for (const entry of entries)
      expect(
        new Uint8Array(await readFile(join(destination, ...entry.parts))),
      ).toEqual(entry.bytes);
    expect(
      (await prepareInput(destination, false, undefined, signal())).root,
    ).toBe(input.root);

    const reader = await CarReader.fromBytes(input.bytes);
    const root = dagPb.decode(
      (await reader.get(CID.parse(input.root!)))!.bytes,
    );
    const nested = dagPb.decode(
      (await reader.get(
        root.Links.find((link) => link.Name === "nested")!.Hash,
      ))!.bytes,
    );
    const fileRoot = nested.Links[0]!.Hash;
    const blocks: Block[] = [];
    for await (const entry of reader.blocks()) blocks.push(entry);
    const reachable = new Map<string, Block>();
    const queue = [fileRoot];
    while (queue.length) {
      const cid = queue.pop()!;
      if (reachable.has(cid.toString())) continue;
      const entry = blocks.find((entry) => entry.cid.equals(cid))!;
      reachable.set(cid.toString(), entry);
      if (cid.code === dagPb.code)
        queue.push(...dagPb.decode(entry.bytes).Links.map((link) => link.Hash));
    }
    const fileCar = car([...reachable.values()], [fileRoot]);
    const chunked = join(directory, "chunked.bin");
    await saveContent(fileCar, fileRoot.toString(), chunked, false, signal());
    expect(new Uint8Array(await readFile(chunked))).toEqual(large);
  });

  it("exports CAR bytes unchanged and preserves their import root", async () => {
    const fixture = await folder(["one", "two"]);
    const destination = join(directory, "export.car");
    const result = await saveContent(
      fixture.bytes,
      fixture.root,
      destination,
      true,
      signal(),
    );
    expect(result.type).toBe("car");
    expect(new Uint8Array(await readFile(destination))).toEqual(fixture.bytes);
    expect(
      (await prepareInput(destination, true, undefined, signal())).root,
    ).toBe(fixture.root);
  });

  it("exports generic DAG-CBOR but refuses to invent a file representation", async () => {
    const child = await block(data);
    const root = await block(
      dagCbor.encode({ child: child.cid }),
      dagCbor.code,
    );
    const bytes = car([root, child]);
    await saveContent(
      bytes,
      root.cid.toString(),
      join(directory, "object.car"),
      true,
      signal(),
    );
    await expect(
      saveContent(
        bytes,
        root.cid.toString(),
        join(directory, "object"),
        false,
        signal(),
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CONTENT" });
    expect(await readdir(directory)).not.toContain("object");
  });

  it.each([
    "../escape",
    "/absolute",
    "sub/file",
    "sub\\file",
    "C:drive",
    "NUL",
    "a.",
    "a ",
    "a\u0000b",
  ])("rejects unsafe directory name %j before writing", async (name) => {
    const fixture = await folder([name]);
    const target = join(directory, "unsafe");
    await expect(
      saveContent(fixture.bytes, fixture.root, target, false, signal()),
    ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    expect(await readdir(directory)).not.toContain("unsafe");
  });

  it("refuses case-insensitive collisions instead of overwriting entries", async () => {
    const fixture = await folder(["file", "FILE"]);
    await expect(
      saveContent(
        fixture.bytes,
        fixture.root,
        join(directory, "collision"),
        false,
        signal(),
      ),
    ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    expect(await readdir(directory)).not.toContain("collision");
  });

  it("never overwrites existing output or follows output junctions", async () => {
    const raw = await block(data);
    const bytes = car([raw]);
    const target = join(directory, "existing");
    await writeFile(target, "keep");
    await expect(
      saveContent(bytes, raw.cid.toString(), target, false, signal()),
    ).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
    expect(await readFile(target, "utf8")).toBe("keep");
    const existingDirectory = join(directory, "existing-dir");
    await mkdir(existingDirectory);
    await expect(
      saveContent(bytes, raw.cid.toString(), existingDirectory, true, signal()),
    ).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
    const link = join(directory, "junction");
    await symlink(
      existingDirectory,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      saveContent(
        bytes,
        raw.cid.toString(),
        join(link, "file"),
        false,
        signal(),
      ),
    ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    expect(await readdir(existingDirectory)).toEqual([]);
  });

  it("cleans up a new directory if a local write fails", async () => {
    const fixture = await folder(["x".repeat(300)]);
    const target = join(directory, "failed-write");
    await expect(
      saveContent(fixture.bytes, fixture.root, target, false, signal()),
    ).rejects.toThrow();
    expect(await readdir(directory)).not.toContain("failed-write");
  });

  it("refuses invalid roots, corrupt blocks, missing links and unreachable blocks", async () => {
    const child = await block(data);
    const other = await block(new Uint8Array([42]));
    const root = await block(
      dagPb.encode({
        Data: new Uint8Array([8, 1]),
        Links: [{ Name: "file", Hash: child.cid }],
      }),
      dagPb.code,
    );
    const invalid = [
      car([child], [other.cid]),
      car([child], []),
      car([child], [child.cid, other.cid]),
      car([{ ...child, bytes: new Uint8Array([99]) }]),
      car([root]),
      car([root, child, other]),
      car([{ ...root, bytes: new Uint8Array([255]) }]),
      new Uint8Array([1, 2, 3]),
    ];
    for (const bytes of invalid)
      await expect(
        verifyCar(bytes, root.cid.toString(), signal()),
      ).rejects.toMatchObject({ code: "INVALID_CAR" });
    await expect(
      verifyCar(
        car([{ ...child, bytes: new Uint8Array([99]) }]),
        child.cid.toString(),
        signal(),
      ),
    ).rejects.toMatchObject({ code: "INVALID_CAR" });
  });

  it("enforces block and CAR size bounds and cancellation", async () => {
    const oversized = await block(
      new Uint8Array(uploadLimits.maxBlockBytes + 1),
    );
    await expect(
      verifyCar(car([oversized]), oversized.cid.toString(), signal()),
    ).rejects.toMatchObject({ code: "INVALID_CAR" });
    const raw = await block(data);
    await expect(
      verifyCar(new Uint8Array(maxCarBytes + 1), raw.cid.toString(), signal()),
    ).rejects.toMatchObject({ code: "INVALID_CAR" });
    await expect(
      verifyCar(
        car([raw]),
        raw.cid.toString(),
        AbortSignal.abort(new Error("cancelled")),
      ),
    ).rejects.toThrow("cancelled");
  });

  it("bounds logical expansion when a DAG reuses the same blocks", async () => {
    const payload = new Uint8Array(1024 * 1024);
    const child = await block(payload);
    const root = await block(
      dagPb.encode(
        dagPb.prepare({
          Data: new Uint8Array([8, 1]),
          Links: Array.from({ length: 33 }, (_, index) => ({
            Name: `file-${index}`,
            Hash: child.cid,
          })),
        }),
      ),
      dagPb.code,
    );
    await expect(
      saveContent(
        car([root, child]),
        root.cid.toString(),
        join(directory, "expanded"),
        false,
        signal(),
      ),
    ).rejects.toMatchObject({ code: "OUTPUT_LIMIT" });
    expect(await readdir(directory)).not.toContain("expanded");
  });

  it("supports empty UnixFS directories", async () => {
    const root = await block(
      dagPb.encode({ Data: new Uint8Array([8, 1]), Links: [] }),
      dagPb.code,
    );
    const target = join(directory, "empty-directory");
    expect(
      (
        await saveContent(
          car([root]),
          root.cid.toString(),
          target,
          false,
          signal(),
        )
      ).type,
    ).toBe("directory");
    expect(await readdir(target)).toEqual([]);
  });
});

describe("public download/export command contracts", () => {
  it.each([
    ["photo.bin", false, "photo.bin"],
    ["my folder", false, "my folder"],
    ["photo.bin", true, "photo.bin.car"],
    ["archive.car", true, "archive.car"],
    ["archive.CAR", true, "archive.CAR"],
    ["\u6587\u4ef6.bin", true, "\u6587\u4ef6.bin.car"],
  ])("derives the pin filename %s (CAR: %s)", (name, car, expected) => {
    expect(pinFilename(name, car)).toBe(expected);
  });
  it.each([
    "",
    " ",
    ".",
    "..",
    "../escape",
    "folder/file",
    "C:\\file",
    "NUL",
    "a.",
    "name ",
    "\u6587".repeat(100),
  ])("rejects unsafe default pin filename %j", (name) => {
    expect(() => pinFilename(name, false)).toThrow();
    expect(() => pinFilename(name, true)).toThrow();
  });
  it.each([
    { command: "download", stored: false },
    { command: "export", stored: false },
    { command: "export", stored: true },
  ])(
    "uses the pin name by default for $command (stored token: $stored)",
    async ({ command, stored }) => {
      const raw = await block(data);
      const name = `pin-name-${randomUUID()}.bin`;
      const target = resolve(command === "export" ? `${name}.car` : name);
      const token = "synthetic-name-token";
      const tokenRead = vi
        .spyOn(Store.prototype, "token")
        .mockResolvedValue(token);
      const paths: string[] = [];
      let created = false;
      try {
        const result = await invoke(
          [command, raw.cid.toString(), "--json"],
          (url, init) => {
            const path = new URL(
              url instanceof Request ? url.url : url.toString(),
            ).pathname;
            paths.push(path);
            const authorization = new Headers(init!.headers).get(
              "authorization",
            );
            if (path.startsWith("/api/pins/")) {
              expect(authorization).toBe(`Bearer ${token}`);
              return Promise.resolve(
                Response.json({
                  cid: raw.cid.toString(),
                  name,
                  size: data.length,
                  blocks: 1,
                  createdAt: "2026-01-01",
                }),
              );
            }
            expect(authorization).toBeNull();
            return Promise.resolve(response(car([raw])));
          },
          stored ? {} : { env: { PINBOARD_AGENT_TOKEN: token } },
        );
        created = result.code === 0;
        expect(result.code, result.err).toBe(0);
        expect(result.err).toBe("");
        expect(JSON.parse(result.out)).toMatchObject({ path: target });
        expect(paths).toEqual([
          `/api/pins/${raw.cid.toString()}`,
          `/api/public/${raw.cid.toString()}/car`,
        ]);
        expect(tokenRead).toHaveBeenCalledTimes(stored ? 1 : 0);
        expect(new Uint8Array(await readFile(target))).toEqual(
          command === "export" ? car([raw]) : data,
        );
      } finally {
        if (created) await rm(target);
      }
    },
  );
  it.each([401, 403, 404, "unsafe"] as const)(
    "falls back to CID with an explicit warning when pin metadata is unavailable: %s",
    async (status) => {
      const raw = await block(new TextEncoder().encode(randomUUID()));
      const target = resolve(`${raw.cid.toString()}.car`);
      let created = false;
      try {
        const result = await invoke(
          ["export", raw.cid.toString(), "--json"],
          (url) => {
            const path = new URL(
              url instanceof Request ? url.url : url.toString(),
            ).pathname;
            if (path.startsWith("/api/pins/"))
              return Promise.resolve(
                status === "unsafe"
                  ? Response.json({
                      cid: raw.cid.toString(),
                      name: "../escape",
                      size: raw.bytes.length,
                      blocks: 1,
                      createdAt: "2026-01-01",
                    })
                  : new Response(null, { status }),
              );
            return Promise.resolve(response(car([raw])));
          },
          { env: { PINBOARD_AGENT_TOKEN: "synthetic-name-token" } },
        );
        created = result.code === 0;
        expect(result.code, result.err).toBe(0);
        expect(JSON.parse(result.out)).toMatchObject({ path: target });
        expect(JSON.parse(result.err)).toMatchObject({
          warning: { code: "PIN_NAME_UNAVAILABLE" },
        });
        expect(new Uint8Array(await readFile(target))).toEqual(car([raw]));
      } finally {
        if (created) await rm(target);
      }
    },
  );
  it.each([500, "mismatched"] as const)(
    "does not silently hide metadata errors: %s",
    async (status) => {
      const raw = await block(data);
      const other = await block(new Uint8Array([99]));
      let calls = 0;
      const result = await invoke(
        ["download", raw.cid.toString(), "--json"],
        () => {
          calls++;
          return Promise.resolve(
            status === "mismatched"
              ? Response.json({
                  cid: other.cid.toString(),
                  name: "untrusted-name",
                  size: 1,
                  blocks: 1,
                  createdAt: "2026-01-01",
                })
              : new Response(null, { status }),
          );
        },
        { env: { PINBOARD_AGENT_TOKEN: "synthetic-name-token" } },
      );
      expect(result.code).toBe(1);
      expect(result.out).toBe("");
      expect(JSON.parse(result.err)).toMatchObject({
        error: {
          code: status === "mismatched" ? "INVALID_RESPONSE" : "HTTP_ERROR",
        },
      });
      expect(calls).toBe(1);
    },
  );
  it("does not consult credentials or private pin metadata with --output", async () => {
    const raw = await block(data);
    const path = join(directory, "explicit-output");
    const tokenRead = vi
      .spyOn(Store.prototype, "token")
      .mockRejectedValue(new Error("must not read tokens"));
    const result = await invoke(
      ["download", raw.cid.toString(), "--output", path, "--json"],
      (url, init) => {
        expect(url instanceof Request ? url.url : url.toString()).toBe(
          `${origin}/api/public/${raw.cid.toString()}/car`,
        );
        expect(new Headers(init!.headers).has("authorization")).toBe(false);
        return Promise.resolve(response(car([raw])));
      },
      { env: { PINBOARD_AGENT_TOKEN: "" } },
    );
    expect(result.code, result.err).toBe(0);
    expect(result.err).toBe("");
    expect(tokenRead).not.toHaveBeenCalled();
    expect(new Uint8Array(await readFile(path))).toEqual(data);
  });
  it.each(["download", "export"])(
    "runs %s without credentials and never sends authorization",
    async (command) => {
      const raw = await block(data);
      const bytes = car([raw]);
      const path = join(directory, `cli-${command}`);
      const result = await invoke(
        [command, raw.cid.toString(), "--output", path, "--json"],
        (url, init) => {
          expect(url instanceof Request ? url.url : url.toString()).toBe(
            `${origin}/api/public/${raw.cid.toString()}/car`,
          );
          expect(new Headers(init!.headers).has("authorization")).toBe(false);
          expect(init!.redirect).toBe("manual");
          return Promise.resolve(response(bytes));
        },
      );
      expect(result.code, result.err).toBe(0);
      expect(result.err).toBe("");
      expect(JSON.parse(result.out)).toEqual({
        cid: raw.cid.toString(),
        path,
        type: command === "export" ? "car" : "file",
        size: command === "export" ? bytes.length : data.length,
      });
      expect(new Uint8Array(await readFile(path))).toEqual(
        command === "export" ? bytes : data,
      );
    },
  );

  it("keeps anonymous default names CID-based with an explicit warning", async () => {
    const raw = await block(new TextEncoder().encode("default-name-fixture"));
    const cid = raw.cid.toString();
    const target = resolve(`${cid}.car`);
    let created = false;
    try {
      const result = await invoke(["export", cid, "--json"], () =>
        Promise.resolve(response(car([raw]))),
      );
      created = result.code === 0;
      expect(result.code, result.err).toBe(0);
      expect(JSON.parse(result.err)).toMatchObject({
        warning: { code: "PIN_NAME_UNAVAILABLE" },
      });

      expect(JSON.parse(result.out)).toMatchObject({ path: target });
      expect(new Uint8Array(await readFile(target))).toEqual(car([raw]));
    } finally {
      if (created) await rm(target);
    }
  });

  it("emits only the error document if an anonymous default download fails", async () => {
    const raw = await block(data);
    const result = await invoke(
      ["download", raw.cid.toString(), "--json"],
      () => Promise.resolve(new Response(null, { status: 404 })),
    );
    expect(result.code).toBe(1);
    expect(result.out).toBe("");
    expect(JSON.parse(result.err)).toMatchObject({
      error: { code: "HTTP_ERROR", status: 404 },
    });
    expect(result.err).not.toContain("warning");
  });

  it("uses a progress/result separator and a TTY summary for saved content", async () => {
    const raw = await block(data);
    const path = join(directory, "tty-download");
    const result = await invoke(
      ["download", raw.cid.toString(), "--output", path],
      () => Promise.resolve(response(car([raw]))),
      { tty: true },
    );
    expect(result.code, result.err).toBe(0);
    expect(result.err).toContain("] Fetching CAR...\n");
    expect(result.err).toContain("] Verifying and restoring content...\n");
    expect(result.out).toMatch(/^\n┌/u);
    expect(result.out).toContain("│ Path");
    expect(result.out).toContain(raw.cid.toString());
  });

  it.each([
    [302, "REDIRECT_REFUSED"],
    [404, "HTTP_ERROR"],
    [500, "HTTP_ERROR"],
  ])("reports HTTP %i with no local success", async (status, code) => {
    const raw = await block(data);
    const path = join(directory, `http-${status}`);
    const result = await invoke(
      ["export", raw.cid.toString(), "--output", path, "--json"],
      () => Promise.resolve(new Response(null, { status })),
    );
    expect(result.code).toBe(1);
    expect(result.out).toBe("");
    expect(JSON.parse(result.err)).toMatchObject({ error: { code, status } });
    expect(await readdir(directory)).not.toContain(`http-${status}`);
  });

  it("checks CAR content type and both declared and actual response sizes", async () => {
    const raw = await block(data);
    const client = (fetcher: typeof fetch) =>
      new Client(origin, "must-not-send", signal(), fetcher);
    await expect(
      client(() => Promise.resolve(new Response("html"))).car(
        raw.cid.toString(),
      ),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(
      client(() =>
        Promise.resolve(
          new Response("small", {
            headers: {
              "content-type": "application/vnd.ipld.car",
              "content-length": String(maxCarBytes + 1),
            },
          }),
        ),
      ).car(raw.cid.toString()),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(
      client(() =>
        Promise.resolve(response(new Uint8Array(maxCarBytes + 1))),
      ).car(raw.cid.toString()),
    ).rejects.toMatchObject({ code: "RESPONSE_LIMIT" });
  });
});
