import { mkdir, mkdtemp } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export async function fixtureDirectory(prefix: string): Promise<string> {
  const parent = resolve(
    process.env.PINBOARD_TEST_ROOT ??
      (process.platform === "win32" ? homedir() : "."),
  );
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, prefix));
}
