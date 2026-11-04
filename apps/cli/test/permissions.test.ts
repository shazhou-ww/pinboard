import { execFile, type ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Store, configDirectory } from "../src/store.js";
import {
  createProtectedFile,
  sameFileIdentity,
  secureDirectory,
  verify,
} from "../src/permissions.js";

const executeFile = promisify(execFile);
const execute = (
  file: string,
  args: string[],
  options: ExecFileOptions = {},
) => {
  const pending = executeFile(file, args, { ...options, encoding: "utf8" });
  pending.child.stdin?.end();
  return pending;
};
const root = resolve(
  process.env.PINBOARD_TEST_ROOT ?? ".",
  ".permission-tests",
);
beforeAll(async () => {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
const one = "https://one.example",
  two = "https://two.example";

describe(`real ${process.platform} credential protection`, () => {
  it("compares exact file IDs across real path and handle stat APIs", async () => {
    const path = join(root, "identity");
    await writeFile(path, "identity");
    const before = await lstat(path, { bigint: true });
    const handle = await open(path);
    try {
      const actual = await handle.stat({ bigint: true });
      expect(sameFileIdentity(before, actual)).toBe(true);
      expect(
        sameFileIdentity(actual, { ...actual, ino: actual.ino + 1n }),
      ).toBe(false);
      expect(
        sameFileIdentity(
          { ...actual, ino: 9007199254740992n },
          { ...actual, ino: 9007199254740993n },
        ),
      ).toBe(false);
      expect(
        sameFileIdentity({ ...actual, dev: 1n }, { ...actual, dev: 2n }),
      ).toBe(false);
      expect(
        sameFileIdentity({ ...actual, dev: 0n }, { ...actual, dev: 1n }),
      ).toBe(process.platform === "win32");
    } finally {
      await handle.close();
    }
  });

  it("uses only the platform configuration location", () => {
    const env = { LOCALAPPDATA: root, XDG_CONFIG_HOME: root };
    expect(configDirectory(env)).toBe(join(root, "pinboard"));
    expect(() =>
      configDirectory({
        LOCALAPPDATA: "relative",
        XDG_CONFIG_HOME: "relative",
      }),
    ).toThrow();
  });

  it("securely creates, reads, updates and removes endpoint entries without losing concurrent writes", async () => {
    const store = new Store(join(root, "concurrent"));
    expect(await store.config()).toEqual({});
    expect(await store.token(one)).toBeUndefined();
    await store.setToken(one, "synthetic-one");
    await Promise.all([
      store.setToken(one, "synthetic-updated"),
      store.setToken(two, "synthetic-two"),
    ]);
    expect(await store.token(one)).toBe("synthetic-updated");
    expect(await store.token(two)).toBe("synthetic-two");
    expect(await store.token("https://missing.example")).toBeUndefined();
    await store.setEndpoint(one);
    expect(await store.config()).toEqual({ endpoint: one });
    expect(
      await readFile(join(store.directory, "config.json"), "utf8"),
    ).not.toContain("synthetic");
    await verify(store.directory, true);
    await verify(join(store.directory, "tokens.json"));
    if (process.platform !== "win32") {
      expect((await lstat(store.directory)).mode & 0o777).toBe(0o700);
      expect(
        (await lstat(join(store.directory, "tokens.json"))).mode & 0o777,
      ).toBe(0o600);
    } else {
      const { stdout } = await execute(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$a=Get-Acl -LiteralPath $env:PINBOARD_TEST_PATH; $s=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; if(-not $a.AreAccessRulesProtected -or $a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $s.Value){exit 9}; $r=@($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])); if($r.Count -ne 1 -or $r[0].IdentityReference.Value -ne $s.Value -or $r[0].IsInherited){exit 10}; Write-Output 'verified'",
        ],
        {
          env: {
            ...process.env,
            PINBOARD_TEST_PATH: join(store.directory, "tokens.json"),
          },
        },
      );
      expect(stdout.trim()).toBe("verified");
    }
    await store.removeToken(one);
    expect(await store.token(one)).toBeUndefined();
    expect(await store.token(two)).toBe("synthetic-two");
  });

  it("establishes permissions on empty files before any secret write", async () => {
    const directory = join(root, "before-secret");
    await secureDirectory(directory);
    const path = join(directory, "empty");
    await createProtectedFile(path);
    expect((await lstat(path)).size).toBe(0);
    await verify(path);
  });

  it("rejects malformed or mixed-secret config without treating it as anonymous", async () => {
    const store = new Store(join(root, "invalid"));
    await secureDirectory(store.directory);
    for (const [file, text] of [
      ["tokens.json", "not-json"],
      ["config.json", '{"token":"synthetic"}'],
    ] as const) {
      const path = join(store.directory, file);
      await createProtectedFile(path);
      await writeFile(path, text);
      if (file === "tokens.json")
        await expect(store.token(one)).rejects.toMatchObject({
          code: "INVALID_CONFIG",
        });
      else
        await expect(store.config()).rejects.toMatchObject({
          code: "INVALID_CONFIG",
        });
    }
  });

  it("rejects nonexpected hard links instead of reading or replacing them", async () => {
    const store = new Store(join(root, "hardlink"));
    await store.setToken(one, "synthetic");
    const path = join(store.directory, "tokens.json");
    await link(path, join(store.directory, "extra-link"));
    await expect(store.token(one)).rejects.toMatchObject({
      code: "UNSAFE_PATH",
    });
    await expect(store.setToken(two, "synthetic")).rejects.toMatchObject({
      code: "UNSAFE_PATH",
    });
  });

  it("rejects directory junctions/symbolic links and linked token files", async () => {
    const original = join(root, "original");
    await secureDirectory(original);
    const linked = join(root, "linked");
    await symlink(
      original,
      linked,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(secureDirectory(linked)).rejects.toMatchObject({
      code: "UNSAFE_PATH",
    });
    if (process.platform !== "win32") {
      const source = join(original, "source");
      await createProtectedFile(source);
      await writeFile(source, "{}");
      await symlink(source, join(original, "tokens.json"));
      await expect(new Store(original).token(one)).rejects.toMatchObject({
        code: "UNSAFE_PATH",
      });
    }
  });

  it("refuses broad permissions without silently repairing existing credentials", async () => {
    const store = new Store(join(root, "unsafe"));
    await store.setToken(one, "synthetic");
    const path = join(store.directory, "tokens.json");
    if (process.platform === "win32") {
      await execute(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$p=$env:PINBOARD_TEST_PATH; $a=[System.IO.File]::GetAccessControl($p); $s=New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0'); $r=New-Object System.Security.AccessControl.FileSystemAccessRule($s,'Read','Allow'); $a.AddAccessRule($r); [System.IO.File]::SetAccessControl($p,$a)",
        ],
        { env: { ...process.env, PINBOARD_TEST_PATH: path } },
      );
    } else await chmod(path, 0o644);
    await expect(store.token(one)).rejects.toMatchObject({
      code: "UNSAFE_PERMISSIONS",
    });
    await expect(store.setToken(one, "replacement")).rejects.toMatchObject({
      code: "UNSAFE_PERMISSIONS",
    });
    expect(await readFile(path, "utf8")).toContain("synthetic");
  });

  it("refuses replaceable configuration ancestors before writing credentials", async () => {
    const ancestor = join(root, "replaceable-ancestor");
    await secureDirectory(ancestor);
    if (process.platform === "win32") {
      await execute(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$p=$env:PINBOARD_TEST_PATH; $a=[System.IO.Directory]::GetAccessControl($p); $s=New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0'); $r=New-Object System.Security.AccessControl.FileSystemAccessRule($s,'ChangePermissions','Allow'); $a.AddAccessRule($r); [System.IO.Directory]::SetAccessControl($p,$a)",
        ],
        { env: { ...process.env, PINBOARD_TEST_PATH: ancestor } },
      );
    } else await chmod(ancestor, 0o777);
    const store = new Store(join(ancestor, "pinboard"));
    await expect(
      store.setToken(one, "must-never-be-written"),
    ).rejects.toMatchObject({ code: "UNSAFE_PERMISSIONS" });
    await expect(
      lstat(join(store.directory, "tokens.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform !== "win32")(
    "fails closed when the real Windows ACL helper is unavailable",
    async () => {
      const directory = join(root, "no-helper");
      vi.stubEnv("PATH", directory);
      try {
        await expect(
          new Store(directory).setToken(one, "must-never-be-written"),
        ).rejects.toMatchObject({ code: "UNSAFE_PERMISSIONS" });
        await expect(
          lstat(join(directory, "tokens.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it.skipIf(process.platform !== "win32")(
    "rejects a protected file with another real Windows owner when the host permits assigning one",
    async (context) => {
      const store = new Store(join(root, "other-owner"));
      await store.setToken(one, "synthetic");
      try {
        await execute(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$p=$env:PINBOARD_TEST_PATH; $a=[System.IO.File]::GetAccessControl($p); $s=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544'); $a.SetOwner($s); [System.IO.File]::SetAccessControl($p,$a)",
          ],
          {
            env: {
              ...process.env,
              PINBOARD_TEST_PATH: join(store.directory, "tokens.json"),
            },
          },
        );
      } catch {
        context.skip(
          "This host cannot assign a different real owner without elevated privileges.",
        );
      }
      await expect(store.token(one)).rejects.toMatchObject({
        code: "UNSAFE_PERMISSIONS",
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses an unsafe directory and a different real owner",
    async () => {
      const directory = join(root, "unsafe-directory");
      await mkdir(directory, { mode: 0o755 });
      await expect(secureDirectory(directory)).rejects.toMatchObject({
        code: "UNSAFE_PERMISSIONS",
      });
      // This standard root-owned file proves the owner check without requiring sudo
      // or modifying another account's files. It is never read.
      const owner = await lstat("/etc/passwd");
      if (process.getuid?.() !== owner.uid)
        await expect(verify("/etc/passwd")).rejects.toMatchObject({
          code: "UNSAFE_PERMISSIONS",
        });
    },
  );
});
