import { mkdir, rm, writeFile, open, symlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { CID } from "multiformats/cid";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { run } from "../src/cli.js";
import { endpoint, resolveEndpoint } from "../src/endpoint.js";
import { Client } from "../src/client.js";
import { credentials, stdinToken } from "../src/credentials.js";
import { Store } from "../src/store.js";
import { prepareInput } from "../src/input.js";

const directory = resolve(".cli-tests");
const token = "synthetic-test-token";
const cid = "bafkreigh2akiscaildcxxbmjcwt4svm6yv6oubkcb3i3m2ak6bpgxy3s6a";
const record = {
  cid,
  name: "test",
  size: 3,
  blocks: 1,
  createdAt: "2026-01-01",
};
beforeAll(async () => {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function invoke(
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    fetcher?: typeof fetch;
    stdin?: string;
    signal?: AbortSignal;
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
      PINBOARD_AGENT_TOKEN: token,
      ...options.env,
    },
    input: Readable.from([options.stdin ?? ""]),
    out: capture((text) => {
      out += text;
    }),
    err: capture((text) => {
      err += text;
    }),
    signal: options.signal ?? new AbortController().signal,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  });
  return { code, out, err };
}

describe("origins", () => {
  it.each([
    "https://example.com/a",
    "https://a:b@example.com",
    "https://example.com?x",
    "https://example.com#",
    "ftp://localhost",
    "http://example.com",
    "",
    "invalid",
  ])("rejects %s", (value) => {
    expect(() => endpoint(value)).toThrow();
  });
  it("allows only HTTPS or loopback HTTP and normalizes origins", () => {
    expect(endpoint("https://EXAMPLE.com:443/")).toBe("https://example.com");
    for (const value of [
      "http://localhost:8787",
      "http://127.0.0.2",
      "http://[::1]:8787",
    ])
      expect(endpoint(value)).toBe(value);
    expect(
      resolveEndpoint(
        "https://flag",
        { PINBOARD_ENDPOINT: "https://env" },
        { endpoint: "https://config" },
      ),
    ).toBe("https://flag");
    expect(
      resolveEndpoint(
        undefined,
        { PINBOARD_ENDPOINT: "https://env" },
        { endpoint: "https://config" },
      ),
    ).toBe("https://env");
    expect(resolveEndpoint(undefined, {}, { endpoint: "https://config" })).toBe(
      "https://config",
    );
  });
});

describe("top-level command and output contracts", () => {
  it("documents inherently public uploads and unpin-not-erasure without a pins group", async () => {
    const result = await invoke(["--help"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("PUBLIC");
    expect(result.out).toContain("NOT erased");
    expect(result.out).not.toContain("pinboard pins");
  });
  it.each([
    ["pins"],
    ["pin", cid],
    ["upload"],
    ["list", "x"],
    ["list", "--public"],
    ["list", "--all", "--all"],
    ["inspect", cid, "--name", "a"],
    ["list", "--endpoint"],
    ["list", "--timeout", "0"],
  ])("rejects misuse %j", async (...args) => {
    const result = await invoke([...args, "--json"]);
    expect(result.code).toBe(2);
    expect(result.out).toBe("");
    expect(JSON.parse(result.err)).toHaveProperty("error.code", "USAGE");
  });
  it.each(["upload", "import", "list", "inspect", "remove"])(
    "supports per-command endpoint for %s",
    async (command) => {
      const path = join(directory, "ordinary");
      await writeFile(path, new Uint8Array([0, 255, 1]));
      let url = "",
        method = "",
        authorization = "";
      const fetcher: typeof fetch = (input, init) => {
        url = input instanceof Request ? input.url : input.toString();
        method = init!.method!;
        authorization = new Headers(init!.headers).get("authorization")!;
        if (command === "upload") {
          expect(new Headers(init!.headers).get("x-pinboard-public")).toBe(
            "true",
          );
          expect(init!.body).toEqual(new Uint8Array([0, 255, 1]));
        }
        return Promise.resolve(
          command === "remove"
            ? new Response(null, { status: 204 })
            : Response.json(
                command === "list"
                  ? { pins: [record], nextCursor: null }
                  : record,
              ),
        );
      };
      if (command === "import") {
        // CAR coverage uses the real local Worker integration; invalid CAR is rejected
        // before a request and cannot accidentally fall through to ordinary upload.
        const result = await invoke(
          ["import", path, "--endpoint", "http://localhost:8787", "--json"],
          { fetcher },
        );
        expect(result.code).toBe(1);
        expect(url).toBe("");
        return;
      }
      const args = [
        command,
        ...(command === "upload" ? [path] : command === "list" ? [] : [cid]),
        "--endpoint",
        "http://localhost:8787",
        "--json",
      ];
      const result = await invoke(args, { fetcher });
      expect(result.code).toBe(0);
      expect(url.startsWith("http://localhost:8787/api/pins")).toBe(true);
      expect(authorization).toBe(`Bearer ${token}`);
      expect(method).toBe(
        command === "remove" ? "DELETE" : command === "upload" ? "POST" : "GET",
      );
      expect(result.out.split("\n").filter(Boolean)).toHaveLength(1);
      expect(result.out).not.toContain(token);
    },
  );
  it("returns structured failures without echoing server diagnostics or credentials", async () => {
    const result = await invoke(["list", "--json"], {
      fetcher: () => Promise.resolve(new Response(token, { status: 401 })),
    });
    expect(result.code).toBe(1);
    expect(result.out).toBe("");
    expect(JSON.parse(result.err)).toMatchObject({
      error: { code: "HTTP_ERROR", status: 401 },
    });
    expect(result.err).not.toContain(token);
    const reflected = await invoke(["inspect", cid, "--json"], {
      fetcher: () => Promise.resolve(Response.json({ ...record, name: token })),
    });
    expect(reflected.out).toBe("");
    expect(reflected.err).not.toContain(token);
  });
  it("never follows redirects or retries writes and marks lost outcomes uncertain", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 307,
        headers: { Location: "https://other.invalid" },
      }),
    );
    const client = new Client(
      "https://example.com",
      token,
      new AbortController().signal,
      fetcher,
    );
    await expect(client.remove(cid)).rejects.toMatchObject({
      code: "REDIRECT_REFUSED",
      uncertain: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1]!.redirect).toBe("manual");
    fetcher.mockRejectedValueOnce(new Error(`untrusted ${token}`));
    await expect(
      client.upload(new Uint8Array(), "file", "x"),
    ).rejects.toMatchObject({ uncertain: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("rejects a response CID that differs from the known upload root without retrying", async () => {
    const root = CID.createV1(0x70, CID.parse(cid).multihash).toString();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(record));
    const client = new Client(
      "https://example.com",
      token,
      new AbortController().signal,
      fetcher,
    );
    await expect(
      client.upload(new Uint8Array(), "car", "directory", root),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      exitCode: 1,
      uncertain: true,
      recovery: `Inspect ${root} before retrying; the write may already have completed.`,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["v0", "v1"])(
    "accepts equivalent CID encodings when the known root is %s",
    async (version) => {
      const v0 = CID.createV1(0x70, CID.parse(cid).multihash).toV0();
      const v1 = v0.toV1();
      const root = (version === "v0" ? v0 : v1).toString();
      const returned = (version === "v0" ? v1 : v0).toString();
      const fetcher: typeof fetch = () =>
        Promise.resolve(Response.json({ ...record, cid: returned }));
      const client = new Client(
        "https://example.com",
        token,
        new AbortController().signal,
        fetcher,
      );
      await expect(
        client.upload(new Uint8Array(), "car", "archive", root),
      ).resolves.toEqual({
        ...record,
        cid: v1.toString(),
      });
    },
  );

  it("handles all-page pagination atomically and detects cursor loops", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ pins: [record], nextCursor: "two" }),
      )
      .mockResolvedValueOnce(
        Response.json({ pins: [record], nextCursor: null }),
      );
    const first = await invoke(["list", "--all", "--cursor", "one", "--json"], {
      fetcher,
    });
    expect(first.code).toBe(0);
    expect((JSON.parse(first.out) as { pins: unknown[] }).pins).toHaveLength(2);
    const secondUrl = fetcher.mock.calls[1]![0];
    expect(
      secondUrl instanceof Request ? secondUrl.url : secondUrl.toString(),
    ).toContain("cursor=two");
    fetcher
      .mockResolvedValueOnce(
        Response.json({ pins: [record], nextCursor: "next" }),
      )
      .mockResolvedValueOnce(new Response("bad", { status: 503 }));
    const failed = await invoke(["list", "--all", "--json"], { fetcher });
    expect(failed.code).toBe(1);
    expect(failed.out).toBe("");
    const looping = () =>
      Promise.resolve(Response.json({ pins: [], nextCursor: "x" }));
    expect(
      (await invoke(["list", "--all", "--json"], { fetcher: looping })).code,
    ).toBe(1);
  });
  it("honors timeouts and interruption without reporting write success", async () => {
    const fetcher: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener(
          "abort",
          () => {
            reject(new Error("cancelled"));
          },
          { once: true },
        );
      });
    const timed = await invoke(["remove", cid, "--timeout", "10", "--json"], {
      fetcher,
    });
    expect(timed.code).toBe(1);
    expect(timed.out).toBe("");
    expect(JSON.parse(timed.err)).toMatchObject({
      error: { code: "TIMEOUT", uncertain: true },
    });
    const controller = new AbortController();
    const result = invoke(["remove", cid, "--json"], {
      fetcher,
      signal: controller.signal,
    });
    setTimeout(() => {
      controller.abort(new Error("interrupt"));
    }, 20);
    expect((await result).code).toBe(130);
  });
});

describe("credentials and local inputs", () => {
  it("supports real config/token commands without exposing secrets in output", async () => {
    const configRoot = join(directory, "config-commands");
    const env = {
      LOCALAPPDATA: configRoot,
      XDG_CONFIG_HOME: configRoot,
      PINBOARD_AGENT_TOKEN: undefined,
    };
    expect((await invoke(["config", "get", "--json"], { env })).code).toBe(0);
    expect(
      (
        await invoke(
          ["config", "set", "endpoint", "https://stored.example", "--json"],
          { env },
        )
      ).code,
    ).toBe(0);
    const saved = await invoke(
      ["config", "set-token", "--token-stdin", "--json"],
      { env, stdin: token + "\n" },
    );
    expect(saved.code).toBe(0);
    expect(saved.out).not.toContain(token);
    const shown = await invoke(["config", "get", "endpoint", "--json"], {
      env,
    });
    expect(JSON.parse(shown.out)).toEqual({
      endpoint: "https://stored.example",
    });
    const fetched = await invoke(["list", "--json"], {
      env,
      fetcher: () =>
        Promise.resolve(Response.json({ pins: [], nextCursor: null })),
    });
    expect(fetched.code).toBe(0);
    expect(
      (await invoke(["config", "remove-token", "--json"], { env })).code,
    ).toBe(0);
    expect((await invoke(["list", "--json"], { env })).err).toContain(
      "TOKEN_REQUIRED",
    );
    expect(
      (await invoke(["config", "set-token", "--json"], { env })).code,
    ).toBe(2);
  });
  it("uses explicit credentials without reading the local token map", async () => {
    const store = new Store("not-read");
    const read = vi
      .spyOn(store, "token")
      .mockRejectedValue(new Error("must not read"));
    const signal = new AbortController().signal;
    expect(
      await credentials(
        store,
        "https://one",
        { PINBOARD_AGENT_TOKEN: token },
        false,
        Readable.from([]),
        signal,
      ),
    ).toBe(token);
    expect(
      await credentials(
        store,
        "https://one",
        {},
        true,
        Readable.from([token + "\n"]),
        signal,
      ),
    ).toBe(token);
    expect(read).not.toHaveBeenCalled();
    await expect(
      credentials(
        store,
        "https://one",
        { PINBOARD_AGENT_TOKEN: "" },
        false,
        Readable.from([]),
        signal,
      ),
    ).rejects.toMatchObject({ exitCode: 2 });
    await expect(
      credentials(
        store,
        "https://one",
        { PINBOARD_AGENT_TOKEN: token },
        true,
        Readable.from([]),
        signal,
      ),
    ).rejects.toMatchObject({ exitCode: 2 });
    await expect(
      stdinToken(Readable.from(["bad\ntoken"]), signal),
    ).rejects.toThrow();
  });
  it("rejects an empty directory and unsupported import input; ignores empty subdirectories", async () => {
    const empty = join(directory, "empty");
    await mkdir(empty);
    await expect(
      prepareInput(empty, false, undefined, new AbortController().signal),
    ).rejects.toThrow("Empty folders");
    await expect(
      prepareInput(empty, true, undefined, new AbortController().signal),
    ).rejects.toMatchObject({ exitCode: 2 });
    await writeFile(join(empty, ".hidden"), "");
    await mkdir(join(empty, "ignored"));
    const result = await prepareInput(
      empty,
      false,
      "rename",
      new AbortController().signal,
    );
    expect(result.name).toBe("rename");
    expect(result.root).toBeDefined();
    await expect(
      prepareInput(empty, false, " ".repeat(201), new AbortController().signal),
    ).rejects.toMatchObject({ exitCode: 2 });
  });

  it("rejects oversized files and linked input roots before uploading", async () => {
    const path = join(directory, "too-large");
    const file = await open(path, "w");
    await file.truncate(32 * 1024 * 1024 + 1);
    await file.close();
    const result = await invoke(["upload", path, "--json"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("INPUT_LIMIT");
    const folder = join(directory, "link-target");
    await mkdir(folder);
    const linked = join(directory, "input-link");
    await symlink(
      folder,
      linked,
      process.platform === "win32" ? "junction" : "dir",
    );
    expect((await invoke(["upload", linked, "--json"])).err).toContain(
      "UNSAFE_PATH",
    );
  });
});
