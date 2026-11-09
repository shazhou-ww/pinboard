import { mkdir, rm, writeFile, open, symlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { CID } from "multiformats/cid";
import stringWidth from "string-width";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { run } from "../src/cli.js";
import { endpoint, resolveEndpoint } from "../src/endpoint.js";
import { Client } from "../src/client.js";
import { credentials, stdinToken } from "../src/credentials.js";
import { Store } from "../src/store.js";
import { prepareInput } from "../src/input.js";
import * as inputModule from "../src/input.js";
import { fixtureDirectory } from "./fixture-directory.js";

let directory: string;
const token = "synthetic-test-token";
const cid = "bafkreigh2akiscaildcxxbmjcwt4svm6yv6oubkcb3i3m2ak6bpgxy3s6a";
const record = {
  cid,
  name: "test",
  size: 3,
  blocks: 1,
  createdAt: "2026-01-01",
  visibility: "private",
};
describe("publication and recovery commands", () => {
  it.each([
    {
      args: [
        "publication",
        "create",
        cid,
        "--title",
        "Public title",
        "--request-id",
        "create-key",
      ],
      path: "/api/publications",
      method: "POST",
    },
    { args: ["publication", "list"], path: "/api/publications", method: "GET" },
    {
      args: ["publication", "get", "stable-id"],
      path: "/api/public/publications/stable-id",
      method: "GET",
    },
    {
      args: ["publication", "get", "stable-id", "--revision", "3"],
      path: "/api/public/publications/stable-id/versions/3",
      method: "GET",
    },
    {
      args: ["publication", "history", "stable-id"],
      path: "/api/public/publications/stable-id/history",
      method: "GET",
    },
    {
      args: [
        "publication",
        "publish",
        "stable-id",
        cid,
        "--sequence",
        "2",
        "--request-id",
        "publish-key",
      ],
      path: "/api/publications/stable-id/publish",
      method: "POST",
    },
    {
      args: [
        "publication",
        "rollback",
        "stable-id",
        "1",
        "--sequence",
        "2",
        "--request-id",
        "rollback-key",
      ],
      path: "/api/publications/stable-id/rollback",
      method: "POST",
    },
    {
      args: ["publication", "remove", "stable-id"],
      path: "/api/publications/stable-id",
      method: "DELETE",
    },
    {
      args: ["publication", "restore", "stable-id"],
      path: "/api/publications/stable-id/restore",
      method: "POST",
    },
    { args: ["deleted"], path: "/api/recently-deleted", method: "GET" },
    {
      args: ["restore", cid],
      path: `/api/pins/${cid}/restore`,
      method: "POST",
    },
  ])("routes $args consistently", async ({ args, path, method }) => {
    let captured: RequestInit | undefined;
    const fetcher: typeof fetch = (input, init) => {
      expect(
        new URL(input instanceof Request ? input.url : input).pathname,
      ).toBe(path);
      expect(init?.method).toBe(method);
      captured = init;
      return Promise.resolve(
        method === "DELETE"
          ? new Response(null, { status: 204 })
          : Response.json({ ok: true }),
      );
    };
    const result = await invoke([...args, "--json"], { fetcher });
    expect(result.code).toBe(0);
    if (path.includes("/api/public/"))
      expect(new Headers(captured?.headers).has("authorization")).toBe(true);
    else
      expect(new Headers(captured?.headers).get("authorization")).toBe(
        `Bearer ${token}`,
      );
    if (args[1] === "publish")
      expect(
        JSON.parse(typeof captured?.body === "string" ? captured.body : ""),
      ).toEqual({
        cid,
        expectedSequence: 2,
        requestId: "publish-key",
      });
    if (args[1] === "create")
      expect(
        JSON.parse(typeof captured?.body === "string" ? captured.body : ""),
      ).toMatchObject({
        title: "Public title",
        public: true,
        requestId: "create-key",
      });
  });

  it("reports an explicitly preserved uploaded pin when publication fails", async () => {
    const file = join(directory, "publication-upload.txt");
    const prepared = vi
      .spyOn(inputModule, "prepareInput")
      .mockResolvedValueOnce({
        bytes: new TextEncoder().encode("publication upload"),
        kind: "file",
        name: "publication-upload.txt",
      });
    const paths: string[] = [];
    const result = await invoke(
      [
        "upload",
        file,
        "--publication",
        "stable-id",
        "--sequence",
        "2",
        "--request-id",
        "partial-key",
        "--json",
      ],
      {
        fetcher: (input, init) => {
          paths.push(
            new URL(input instanceof Request ? input.url : input).pathname,
          );
          if (paths.length === 1) return Promise.resolve(Response.json(record));
          expect(
            JSON.parse(typeof init?.body === "string" ? init.body : ""),
          ).toMatchObject({
            cid,
            expectedSequence: 2,
            requestId: "partial-key",
          });
          return Promise.resolve(
            Response.json({ error: "Sequence conflict" }, { status: 409 }),
          );
        },
      },
    );
    prepared.mockRestore();
    expect(result.code).toBe(1);
    expect(result.err).toBe("");
    expect(JSON.parse(result.out)).toMatchObject({
      partialSuccess: true,
      pin: record,
      publicationError: { status: 409, requestId: "partial-key" },
    });
    expect(paths).toEqual([
      "/api/pins/upload",
      "/api/publications/stable-id/publish",
    ]);
  });
  it("still reports a completed upload when publication is interrupted", async () => {
    const prepared = vi
      .spyOn(inputModule, "prepareInput")
      .mockResolvedValueOnce({
        bytes: new TextEncoder().encode("interrupted publication"),
        kind: "file",
        name: "publication.txt",
      });
    const controller = new AbortController();
    let requests = 0;
    const result = await invoke(
      [
        "upload",
        "publication.txt",
        "--publication",
        "stable-id",
        "--sequence",
        "1",
        "--request-id",
        "interrupt-key",
        "--json",
      ],
      {
        signal: controller.signal,
        fetcher: () => {
          if (++requests === 1) return Promise.resolve(Response.json(record));
          controller.abort();
          return Promise.reject(new Error("Interrupted after upload"));
        },
      },
    );
    prepared.mockRestore();
    expect(result.code).toBe(130);
    expect(JSON.parse(result.out)).toMatchObject({
      partialSuccess: true,
      pin: record,
      publicationError: { requestId: "interrupt-key" },
    });
  });
});
beforeAll(async () => {
  directory = await fixtureDirectory(".cli-tests-");
});
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function invoke(
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    fetcher?: typeof fetch;
    stdin?: string;
    signal?: AbortSignal;
    tty?: boolean;
    errTty?: boolean;
  } = {},
) {
  let out = "",
    err = "",
    combined = "";
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
    out: Object.assign(
      capture((text) => {
        out += text;
        combined += text;
      }),
      { isTTY: options.tty ?? false },
    ),
    err: Object.assign(
      capture((text) => {
        err += text;
        combined += text;
      }),
      { isTTY: options.errTty ?? options.tty ?? false },
    ),
    signal: options.signal ?? new AbortController().signal,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  });
  return { code, out, err, combined };
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
  it.each([{ args: [] }, { args: ["--help"] }, { args: ["--help", "--json"] }])(
    "shows concise command help for $args",
    async ({ args }) => {
      const result = await invoke(args);
      expect(result.code).toBe(0);
      expect(result.err).toBe("");
      const text: string = args.includes("--json")
        ? (JSON.parse(result.out) as { help: string }).help
        : result.out;
      expect(text).toContain("pinboard upload <file|directory>");
      expect(text).toContain("pinboard config set-token");
      expect(text).toContain("pinboard download <CID> [--output PATH]");
      expect(text).toContain("pinboard export <CID> [--output PATH]");
      expect(text).toContain("pinboard rename <CID> <NAME>");
      expect(text).toContain("--endpoint ORIGIN");
      expect(text).toContain("All commands: --json, --help.");
      expect(text).toContain(
        "Private reads use scoped credentials; copying a CID or link grants no access.",
      );
      expect(text).toContain(
        "Public bytes shared by another public reference and external copies cannot be recalled.",
      );
      expect(text).toContain(
        "Directories include hidden and empty files; empty directories are ignored, all-empty rejected.",
      );
      expect(text.trim().split("\n").length).toBeLessThanOrEqual(40);
      expect(text).not.toContain("pinboard pins");
      expect(text).not.toContain("PUBLIC");
      expect(text).not.toContain("NOT erased");
      expect(text).not.toContain("Persistent tokens");
    },
  );
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
    ["download"],
    ["export", cid, "--token-stdin"],
    ["download", cid, "--name", "file"],
    ["export", cid, "--output", ""],
    ["inspect", cid, "--output", "file"],
    ["rename", cid],
    ["rename", cid, "name", "extra"],
    ["rename", cid, "name", "--name", "other"],
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
  it("renames with a JSON PATCH and returns the existing pin receipt", async () => {
    const result = await invoke(
      [
        "rename",
        cid,
        " new name ",
        "--endpoint",
        "http://localhost:8787",
        "--json",
      ],
      {
        fetcher: (input, init) => {
          expect(input instanceof Request ? input.url : input.toString()).toBe(
            `http://localhost:8787/api/pins/${cid}`,
          );
          expect(init!.method).toBe("PATCH");
          expect(init!.redirect).toBe("manual");
          expect(new Headers(init!.headers).get("content-type")).toBe(
            "application/json",
          );
          expect(new Headers(init!.headers).get("authorization")).toBe(
            `Bearer ${token}`,
          );
          expect(new Headers(init!.headers).has("x-pinboard-public")).toBe(
            false,
          );
          expect(init!.body).toBe(JSON.stringify({ name: "new name" }));
          return Promise.resolve(
            Response.json({ ...record, name: "new name" }),
          );
        },
      },
    );
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ ...record, name: "new name" });
    expect(result.err).toBe("");
  });
  it.each(["", "  ", "x".repeat(201)])(
    "refuses invalid rename label %j before a request",
    async (name) => {
      const fetcher = vi.fn<typeof fetch>();
      const result = await invoke(["rename", cid, name, "--json"], { fetcher });
      expect(result.code).toBe(2);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("reports uncertain rename writes without retrying", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("lost response"));
    const result = await invoke(["rename", cid, "new name", "--json"], {
      fetcher,
    });
    expect(result.code).toBe(1);
    expect(result.out).toBe("");
    expect(JSON.parse(result.err)).toMatchObject({
      error: {
        uncertain: true,
      },
    });
    expect(result.err).toContain(`Inspect ${cid}`);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not claim success when a rename response has the wrong label", async () => {
    const result = await invoke(["rename", cid, "new name", "--json"], {
      fetcher: () => Promise.resolve(Response.json(record)),
    });
    expect(result.code).toBe(1);
    expect(result.out).toBe("");
    expect(JSON.parse(result.err)).toMatchObject({
      error: { code: "INVALID_RESPONSE", uncertain: true },
    });
  });
  it("renders a name, size and CID table with a separate cursor", async () => {
    const result = await invoke(["list"], {
      fetcher: () =>
        Promise.resolve(
          Response.json({
            pins: [
              { ...record, name: "test", size: 56083 },
              {
                ...record,
                name: "production-acceptance-261104-1",
                size: 3146793,
              },
            ],
            nextCursor: "next",
          }),
        ),
    });
    expect(result.code).toBe(0);
    expect(result.err).toBe("");
    expect(result.out).toBe(
      `${"NAME".padEnd(30)}  ${"SIZE".padStart(8)}  CID  ACCESS\n` +
        `${"test".padEnd(30)}  54.8 KiB  ${cid}  private\n` +
        `production-acceptance-261104-1   3.0 MiB  ${cid}  private\n\nNext cursor: next\n`,
    );
    expect(result.out).not.toContain("/share/");
  });
  it.each([
    ["a".repeat(32), "a".repeat(32)],
    ["a".repeat(33), "a".repeat(29) + "..."],
    ["\u4e2d".repeat(17), "\u4e2d".repeat(14) + "..."],
    ["\u{1f600}".repeat(17), "\u{1f600}".repeat(14) + "..."],
    ["e\u0301".repeat(33), "e\u0301".repeat(29) + "..."],
  ])("truncates the table name by terminal width: %s", async (name, shown) => {
    const fetcher: typeof fetch = () =>
      Promise.resolve(
        Response.json({ pins: [{ ...record, name }], nextCursor: null }),
      );
    const result = await invoke(["list"], { fetcher });
    expect(result.code).toBe(0);
    const [header, row] = result.out.trimEnd().split("\n");
    expect(row!.startsWith(shown + "  ")).toBe(true);
    expect(stringWidth(shown)).toBeLessThanOrEqual(32);
    expect(row!.endsWith(cid + "  private")).toBe(true);
    expect(stringWidth(header!.slice(0, header!.indexOf("CID")))).toBe(
      stringWidth(row!.slice(0, row!.indexOf(cid))),
    );
    const json = await invoke(["list", "--json"], { fetcher });
    expect(JSON.parse(json.out)).toMatchObject({ pins: [{ name, cid }] });
    const inspected = await invoke(["inspect", cid], {
      fetcher: () => Promise.resolve(Response.json({ ...record, name })),
    });
    expect(
      inspected.out.startsWith("Name     " + JSON.stringify(name).slice(1, -1)),
    ).toBe(true);
  });
  it("renders inspect as an aligned vertical table without changing JSON", async () => {
    const fetcher: typeof fetch = () => Promise.resolve(Response.json(record));
    const result = await invoke(["inspect", cid], { fetcher });
    expect(result.code).toBe(0);
    expect(result.err).toBe("");
    expect(result.out).toBe(
      `Name     test\nSize     3 B\nCID      ${cid}\nBlocks   1\nCreated  2026-01-01\nAccess   private\nShare    https://pinboard.shazhou.work/share/${cid}\n`,
    );
    const json = await invoke(["inspect", cid, "--json"], { fetcher });
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out)).toEqual(record);
  });
  it.each([
    [0, "0 B"],
    [1023, "1023 B"],
    [1024, "1.0 KiB"],
    [1048576, "1.0 MiB"],
  ])("formats a %i byte pin as %s", async (size, label) => {
    const result = await invoke(["inspect", cid], {
      fetcher: () => Promise.resolve(Response.json({ ...record, size })),
    });
    expect(result.code).toBe(0);
    expect(result.out).toContain(`Size     ${label}\n`);
  });
  it("escapes control characters in pin names without breaking the layout", async () => {
    const result = await invoke(["list"], {
      fetcher: () =>
        Promise.resolve(
          Response.json({
            pins: [{ ...record, name: "line\n\t\u001b[31m" }],
            nextCursor: null,
          }),
        ),
    });
    expect(result.code).toBe(0);
    expect(result.out).toContain("line\\n\\t\\u001b[31m   3 B");
    expect(result.out.split("\n")).toHaveLength(3);
  });
  it.each([
    { tty: true, errTty: true },
    { tty: false, errTty: false },
    { tty: true, errTty: false },
    { tty: false, errTty: true },
  ])(
    "separates upload progress and result for $tty/$errTty",
    async (options) => {
      const path = join(directory, "progress-upload");
      await writeFile(path, "test");
      const result = await invoke(["upload", path], {
        ...options,
        fetcher: () => Promise.resolve(Response.json(record)),
      });
      expect(result.code).toBe(0);
      const logLines = result.err.trimEnd().split("\n");
      expect(logLines).toHaveLength(2);
      expect(logLines[0]).toMatch(
        /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] Preparing upload\.\.\.$/u,
      );
      expect(logLines[1]).toMatch(
        /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] Uploading\.\.\.$/u,
      );
      expect(result.out.startsWith("\n")).toBe(true);
      expect(result.out.startsWith("\n\n")).toBe(false);
      expect(result.combined).not.toContain("Progress\n");
      expect(result.combined).not.toContain("Result\n");
      expect(result.out).not.toContain("Preparing");
      expect(result.combined).toBe(result.err + result.out);
    },
  );
  it("suppresses progress and headings for JSON uploads even on a TTY", async () => {
    const path = join(directory, "json-upload");
    await writeFile(path, "test");
    const result = await invoke(["upload", path, "--json"], {
      tty: true,
      fetcher: () => Promise.resolve(Response.json(record)),
    });
    expect(result.code).toBe(0);
    expect(result.err).toBe("");
    expect(result.out).toBe(JSON.stringify(record) + "\n");
  });
  it("does not display a result section when an upload fails", async () => {
    const path = join(directory, "failed-upload");
    await writeFile(path, "test");
    const result = await invoke(["upload", path], {
      tty: true,
      fetcher: () => Promise.resolve(new Response(null, { status: 403 })),
    });
    expect(result.code).toBe(1);
    expect(result.out).toBe("");
    expect(result.err).toContain("] Preparing upload...\n");
    expect(result.err).toContain("HTTP_ERROR");
    expect(result.combined).not.toContain("Result");
  });
  it("draws Unicode borders around list output only on a TTY", async () => {
    const fetcher: typeof fetch = () =>
      Promise.resolve(Response.json({ pins: [record], nextCursor: null }));
    const result = await invoke(["list"], { fetcher, tty: true });
    const top = `┌──────┬──────┬${"─".repeat(cid.length + 2)}┬─────────┐`;
    const middle = `├──────┼──────┼${"─".repeat(cid.length + 2)}┼─────────┤`;
    const bottom = `└──────┴──────┴${"─".repeat(cid.length + 2)}┴─────────┘`;
    expect(result.code).toBe(0);
    expect(result.out).toBe(
      `${top}\n│ NAME │ SIZE │ ${"CID".padEnd(cid.length)} │ ACCESS  │\n${middle}\n│ test │  3 B │ ${cid} │ private │\n${bottom}\n`,
    );
    const plain = await invoke(["list"], { fetcher });
    expect(plain.out).not.toMatch(/[┌┬┐─│├┼┤└┴┘]/u);
    const json = await invoke(["list", "--json"], { fetcher, tty: true });
    expect(JSON.parse(json.out)).toEqual({ pins: [record], nextCursor: null });
  });
  it.each(["test", "\u4e2d".repeat(17), "\u{1f600}".repeat(17)])(
    "aligns TTY list borders for %s",
    async (name) => {
      const result = await invoke(["list"], {
        tty: true,
        fetcher: () =>
          Promise.resolve(
            Response.json({ pins: [{ ...record, name }], nextCursor: null }),
          ),
      });
      expect(result.code).toBe(0);
      const widths = result.out
        .trimEnd()
        .split("\n")
        .map((line) => stringWidth(line));
      expect(new Set(widths).size).toBe(1);
      expect(result.out).toContain(cid);
    },
  );
  it("draws a vertical TTY table for inspect with full field values", async () => {
    const name = "a".repeat(50);
    const pin = { ...record, name };
    const fetcher: typeof fetch = () => Promise.resolve(Response.json(pin));
    const result = await invoke(["inspect", cid], { fetcher, tty: true });
    const share = `https://pinboard.shazhou.work/share/${cid}`;
    const top = `┌─────────┬${"─".repeat(share.length + 2)}┐`;
    const bottom = `└─────────┴${"─".repeat(share.length + 2)}┘`;
    expect(result.code).toBe(0);
    expect(result.out).toBe(
      [
        top,
        `│ Name    │ ${name.padEnd(share.length)} │`,
        `│ Size    │ ${"3 B".padEnd(share.length)} │`,
        `│ CID     │ ${cid.padEnd(share.length)} │`,
        `│ Blocks  │ ${"1".padEnd(share.length)} │`,
        `│ Created │ ${"2026-01-01".padEnd(share.length)} │`,
        `│ Access  │ ${"private".padEnd(share.length)} │`,
        `│ Share   │ ${share} │`,
        bottom,
        "",
      ].join("\n"),
    );
    const json = await invoke(["inspect", cid, "--json"], {
      fetcher,
      tty: true,
    });
    expect(JSON.parse(json.out)).toEqual(pin);
  });
  it("shows an explicit empty list without changing JSON output", async () => {
    const page = { pins: [], nextCursor: null };
    const fetcher: typeof fetch = () => Promise.resolve(Response.json(page));
    const human = await invoke(["list"], { fetcher });
    expect(human.code).toBe(0);
    expect(human.out).toBe("No pins.\n");
    const json = await invoke(["list", "--json"], { fetcher });
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out)).toEqual(page);
  });
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
    let entered!: () => void;
    let dispatched = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const fetcher: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        entered();
        init!.signal!.addEventListener(
          "abort",
          () => {
            reject(new Error("cancelled"));
          },
          { once: true },
        );
      });
    vi.useFakeTimers();
    let timed: Awaited<ReturnType<typeof invoke>>;
    try {
      const pending = invoke(["remove", cid, "--timeout", "10000", "--json"], {
        fetcher,
      });
      await dispatched;
      await vi.advanceTimersByTimeAsync(10000);
      timed = await pending;
    } finally {
      vi.useRealTimers();
    }
    expect(timed.code).toBe(1);
    expect(timed.out).toBe("");
    expect(JSON.parse(timed.err)).toMatchObject({
      error: { code: "TIMEOUT", uncertain: true },
    });
    const controller = new AbortController();
    dispatched = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const result = invoke(["remove", cid, "--json"], {
      fetcher,
      signal: controller.signal,
    });
    await dispatched;
    controller.abort(new Error("interrupt"));
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
