import { readFile, readdir } from "node:fs/promises";

export async function migrate(
  db: D1Database,
  range: { after?: string; through?: string } = {},
): Promise<void> {
  const directory = new URL("../migrations/", import.meta.url);
  for (const file of (await readdir(directory))
    .filter(
      (name) =>
        name.endsWith(".sql") &&
        (!range.after || name > range.after) &&
        (!range.through || name <= range.through),
    )
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
