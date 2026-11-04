import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { endpoint, validToken } from "./endpoint.js";
import { CliError, missing } from "./errors.js";
import {
  createProtectedFile,
  sameFileIdentity,
  secureDirectory,
  verify,
} from "./permissions.js";

export function configDirectory(env: NodeJS.ProcessEnv): string {
  const base =
    process.platform === "win32"
      ? env.LOCALAPPDATA
      : (env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
  if (!base || !isAbsolute(base))
    throw new CliError(
      "CONFIG_PATH",
      "An absolute LOCALAPPDATA or XDG_CONFIG_HOME configuration directory is required.",
    );
  return join(base, "pinboard");
}

export class Store {
  constructor(
    readonly directory: string,
    private readonly signal?: AbortSignal,
  ) {}

  private async read(name: string): Promise<unknown> {
    this.signal?.throwIfAborted();
    const path = join(this.directory, name);
    try {
      await verify(this.directory, true);
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
    let before;
    try {
      before = await verify(path);
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
    const handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
    );
    try {
      const actual = await handle.stat({ bigint: true });
      if (
        !sameFileIdentity(before, actual) ||
        actual.nlink !== 1n ||
        actual.size > 1024n * 1024n
      )
        throw new CliError(
          "UNSAFE_PATH",
          "Credentials changed or exceed the local storage limit.",
        );
      try {
        return JSON.parse(await handle.readFile("utf8")) as unknown;
      } catch {
        throw new CliError(
          "INVALID_CONFIG",
          "Invalid local Pinboard JSON. Inspect or remove the affected file manually; no credentials were used.",
        );
      }
    } finally {
      await handle.close();
    }
  }

  async config(): Promise<{ endpoint?: string }> {
    const value = await this.read("config.json");
    if (value === undefined) return {};
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => key !== "endpoint") ||
      ("endpoint" in value && typeof value.endpoint !== "string")
    )
      throw new CliError(
        "INVALID_CONFIG",
        "config.json may contain only a non-secret endpoint setting.",
      );
    return "endpoint" in value
      ? { endpoint: endpoint(value.endpoint as string) }
      : {};
  }

  private async tokens(): Promise<Record<string, string>> {
    const value = await this.read("tokens.json");
    if (value === undefined)
      return Object.create(null) as Record<string, string>;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new CliError("INVALID_CONFIG", "Invalid endpoint-token map.");
    const result = Object.create(null) as Record<string, string>;
    for (const [key, token] of Object.entries(value)) {
      if (endpoint(key) !== key || typeof token !== "string")
        throw new CliError("INVALID_CONFIG", "Invalid endpoint-token map.");
      result[key] = validToken(token);
    }
    return result;
  }

  async token(origin: string): Promise<string | undefined> {
    return (await this.tokens())[origin];
  }

  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    await secureDirectory(this.directory);
    const lock = join(this.directory, ".write-lock");
    let acquired = false;
    for (let attempt = 0; attempt < 600; attempt++) {
      this.signal?.throwIfAborted();
      try {
        await mkdir(lock, { mode: 0o700 });
        acquired = true;
        break;
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "EEXIST"
        ))
          throw error;
        const stat = await lstat(lock).catch((error: unknown) => {
          if (missing(error)) return undefined;
          throw error;
        });
        if (!stat) continue;
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new CliError("UNSAFE_PATH", "Unsafe credentials lock.");
        await sleep(50, undefined, { signal: this.signal });
      }
    }
    if (!acquired)
      throw new CliError(
        "CONFIG_BUSY",
        "Pinboard configuration is busy. If a prior process crashed, inspect and remove .write-lock manually.",
      );
    try {
      return await operation();
    } finally {
      await rmdir(lock);
    }
  }

  private async write(name: string, value: unknown): Promise<void> {
    const text = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(text) > 1024 * 1024)
      throw new CliError(
        "CONFIG_LIMIT",
        "Local Pinboard storage exceeds 1 MiB. Remove unused endpoint tokens before adding more.",
      );
    const target = join(this.directory, name);
    try {
      await verify(target);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const path = join(this.directory, `.${name}.${randomUUID()}`);
    try {
      await createProtectedFile(path);
      const handle = await open(
        path,
        constants.O_WRONLY | (constants.O_NOFOLLOW || 0),
      );
      try {
        this.signal?.throwIfAborted();
        await handle.writeFile(text, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await verify(path);
      this.signal?.throwIfAborted();
      await rename(path, target);
      await verify(target);
    } finally {
      await unlink(path).catch((error: unknown) => {
        if (!missing(error)) throw error;
      });
    }
  }

  async setEndpoint(value: string): Promise<void> {
    const origin = endpoint(value);
    await this.locked(() => this.write("config.json", { endpoint: origin }));
  }

  async setToken(origin: string, token: string): Promise<void> {
    validToken(token);
    await this.locked(async () => {
      const values = await this.tokens();
      values[origin] = token;
      await this.write("tokens.json", values);
    });
  }

  async removeToken(origin: string): Promise<void> {
    await this.locked(async () => {
      const values = await this.tokens();
      delete values[origin];
      await this.write("tokens.json", values);
    });
  }
}
