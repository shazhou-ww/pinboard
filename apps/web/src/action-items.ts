import { useCallback, useEffect, useState } from "react";
import type { Pin, Publication } from "@shazhou/pinboard-contracts";
import { apiFetch } from "./api.js";

async function choices<T>(
  path: string,
  field: string,
  signal: AbortSignal,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  do {
    const response = await apiFetch(
      cursor ? `${path}?cursor=${encodeURIComponent(cursor)}` : path,
      { signal },
    );
    if (!response.ok)
      throw new Error(
        `Could not load action choices (HTTP ${response.status}).`,
      );
    const page = (await response.json()) as Record<string, T[] | string | null>;
    signal.throwIfAborted();
    items.push(...(page[field] as T[]));
    cursor = page.nextCursor as string | null;
  } while (cursor);
  return items;
}

export function useActionItems(
  context: string,
  needsPins: boolean,
  needsPublications: boolean,
) {
  const [result, setResult] = useState<{
    context: string;
    revision: number;
    pins: Pin[];
    publications: Publication[];
    error: string;
  } | null>(null);
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => {
    setRevision((value) => value + 1);
  }, []);
  useEffect(() => {
    if (!context) return;
    const controller = new AbortController();
    setResult(null);
    void Promise.all([
      needsPins
        ? choices<Pin>("/api/pins", "pins", controller.signal)
        : Promise.resolve([]),
      needsPublications
        ? choices<Publication>(
            "/api/publications",
            "publications",
            controller.signal,
          )
        : Promise.resolve([]),
    ]).then(
      ([nextPins, nextPublications]) => {
        if (controller.signal.aborted) return;
        setResult({
          context,
          revision,
          pins: nextPins,
          publications: nextPublications,
          error: "",
        });
      },
      (failure: unknown) => {
        if (controller.signal.aborted) return;
        setResult({
          context,
          revision,
          pins: [],
          publications: [],
          error: failure instanceof Error ? failure.message : String(failure),
        });
      },
    );
    return () => {
      controller.abort();
    };
  }, [context, needsPins, needsPublications, revision]);
  const current =
    context && result?.context === context && result.revision === revision
      ? result
      : null;
  return {
    pins: current?.pins ?? [],
    publications: current?.publications ?? [],
    loading: !!context && !current,
    error: current?.error ?? "",
    retry,
  };
}
