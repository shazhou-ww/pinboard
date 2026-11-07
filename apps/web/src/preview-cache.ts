import type { ContentPreview } from "@shazhou/pinboard-contracts";
import { isContentPreview } from "@shazhou/pinboard-contracts";
export { isContentPreview } from "@shazhou/pinboard-contracts";

export const previewFreshMs = 60 * 60 * 1000;
export const previewRetentionMs = 7 * 24 * previewFreshMs;
export const previewCacheLimit = 500;
export const previewCacheBytes = 2 * 1024 * 1024;
export const previewEntryBytes = 16 * 1024;
const databaseName = "pinboard-preview-descriptions";
const storeName = "descriptions";

export interface CachedPreview {
  key: string;
  preview: ContentPreview;
  savedAt: number;
  accessedAt: number;
  bytes: number;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function isFresh(entry: CachedPreview, now = Date.now()): boolean {
  const ttl =
    entry.preview.status === "unsupported" ? 5 * 60 * 1000 : previewFreshMs;
  return entry.savedAt <= now && now - entry.savedAt < ttl;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 2);
    let blocked = false;
    request.onupgradeneeded = () => {
      if (request.result.objectStoreNames.contains(storeName))
        request.result.deleteObjectStore(storeName);
      request.result.createObjectStore(storeName, { keyPath: "key" });
    };
    request.onblocked = () => {
      blocked = true;
      reject(new Error("Preview cache upgrade is blocked by another tab"));
    };
    request.onerror = () => {
      reject(request.error ?? new Error("Unable to open preview cache"));
    };
    request.onsuccess = () => {
      if (blocked) request.result.close();
      else {
        request.result.onversionchange = () => {
          request.result.close();
        };
        resolve(request.result);
      }
    };
  });
}

async function transaction(
  work: (store: IDBObjectStore) => void,
): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.oncomplete = () => {
        resolve();
      };
      tx.onabort = () => {
        reject(tx.error ?? new Error("Preview cache transaction aborted"));
      };
      tx.onerror = () => {
        reject(tx.error ?? new Error("Preview cache transaction failed"));
      };
      work(tx.objectStore(storeName));
    });
  } finally {
    db.close();
  }
}

export async function readCachedPreview(
  key: string,
): Promise<CachedPreview | null> {
  let result: CachedPreview | null = null;
  await transaction((store) => {
    const request = store.get(key);
    request.onsuccess = () => {
      const row: unknown = request.result;
      if (row === undefined) return;
      try {
        if (
          !object(row) ||
          row.key !== key ||
          !isContentPreview(row.preview) ||
          !["ready", "unsupported"].includes(row.preview.status) ||
          !integer(row.savedAt) ||
          !integer(row.bytes) ||
          row.bytes > previewEntryBytes ||
          row.bytes !==
            new TextEncoder().encode(JSON.stringify(row.preview)).length
        ) {
          console.warn("Discarding invalid cached preview description");
          store.delete(key);
          return;
        }
        const now = Date.now();
        if (row.savedAt > now || now - row.savedAt >= previewRetentionMs) {
          store.delete(key);
          return;
        }
        result = {
          key,
          preview: row.preview,
          savedAt: row.savedAt,
          accessedAt: now,
          bytes: row.bytes,
        };
        store.put(result);
      } catch (error) {
        console.warn("Discarding unreadable cached preview description", error);
        result = null;
        store.delete(key);
      }
    };
  });
  return result;
}

export async function writeCachedPreviews(
  entries: CachedPreview[],
): Promise<void> {
  if (!entries.length) return;
  await transaction((store) => {
    for (const entry of entries) store.put(entry);
    const request = store.getAll();
    request.onsuccess = () => {
      const rows = request.result as CachedPreview[];
      rows.sort((a, b) => b.accessedAt - a.accessedAt);
      let bytes = 0;
      let count = 0;
      for (const row of rows) {
        if (
          Date.now() - row.savedAt >= previewRetentionMs ||
          count >= previewCacheLimit ||
          bytes + row.bytes > previewCacheBytes
        ) {
          store.delete(row.key);
        } else {
          count++;
          bytes += row.bytes;
        }
      }
    };
  });
}

export async function deleteCachedPreview(key: string): Promise<void> {
  await transaction((store) => {
    store.delete(key);
  });
}
