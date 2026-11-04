import { readFile, readdir } from "node:fs/promises";

export async function migrate(db: D1Database): Promise<void> {
  const directory = new URL("../migrations/", import.meta.url);
  for (const file of (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    const sql = await readFile(new URL(file, directory), "utf8");
    await db.batch(
      sql
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => db.prepare(part)),
    );
  }
}
