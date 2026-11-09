import { useCallback, useEffect, useRef, useState } from "react";
import {
  itemFilterMaxLength,
  type Pin,
  type Publication,
} from "@shazhou/pinboard-contracts";
import { apiFetch } from "./api.js";
import { Icon } from "./icon.js";

type PinPage = { pins: Pin[]; nextCursor: string | null };
type PublicationPage = {
  publications: Publication[];
  nextCursor: string | null;
};

async function page<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await apiFetch(path, { signal });
  if (!response.ok)
    throw new Error(`Could not load items (HTTP ${response.status}).`);
  return response.json() as Promise<T>;
}

export function useItemLists(accountId?: string) {
  const [input, setInput] = useState("");
  const [visibility, setVisibility] = useState("all");
  const desiredVisibility = useRef("all");
  const [pins, setPins] = useState<Pin[]>([]);
  const [publications, setPublications] = useState<Publication[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [publicationCursor, setPublicationCursor] = useState<string | null>(
    null,
  );
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const desired = useRef("");
  const composing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const request = useRef({ generation: 0, controller: new AbortController() });
  const cancel = useCallback(() => {
    clearTimeout(timer.current);
    request.current.controller.abort();
    request.current = {
      generation: request.current.generation + 1,
      controller: new AbortController(),
    };
  }, []);
  const refresh = useCallback(async () => {
    cancel();
    const current = request.current;
    const query = new URLSearchParams({ q: desired.current.trim() });
    if (desiredVisibility.current !== "all")
      query.set("visibility", desiredVisibility.current);
    setLoading(true);
    setError("");
    try {
      const [pinPage, publicationPage] = await Promise.all([
        page<PinPage>(`/api/pins?${query}`, current.controller.signal),
        page<PublicationPage>(
          `/api/publications?${query}`,
          current.controller.signal,
        ),
      ]);
      if (request.current !== current || current.controller.signal.aborted)
        return;
      setPins(pinPage.pins);
      setCursor(pinPage.nextCursor);
      setPublications(publicationPage.publications);
      setPublicationCursor(publicationPage.nextCursor);
      setLoaded(true);
    } catch (failure) {
      if (request.current === current && !current.controller.signal.aborted)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (request.current === current && !current.controller.signal.aborted)
        setLoading(false);
    }
  }, [cancel]);
  useEffect(() => {
    void refresh();
    return cancel;
  }, [accountId, refresh, cancel]);

  const change = (value: string, immediate = false) => {
    desired.current = value;
    setInput(value);
    cancel();
    setLoading(true);
    setError("");
    if (composing.current) return;
    if (immediate || !value.trim()) void refresh();
    else timer.current = setTimeout(() => void refresh(), 200);
  };
  const loadMore = async (kind: "pins" | "publications") => {
    const next = kind === "pins" ? cursor : publicationCursor;
    if (!next || loading || error) return;
    const current = request.current;
    const query = new URLSearchParams({
      q: desired.current.trim(),
      cursor: next,
    });
    if (desiredVisibility.current !== "all")
      query.set("visibility", desiredVisibility.current);
    setLoading(true);
    try {
      if (kind === "pins") {
        const result = await page<PinPage>(
          `/api/pins?${query}`,
          current.controller.signal,
        );
        if (request.current !== current || current.controller.signal.aborted)
          return;
        setPins((previous) => [...previous, ...result.pins]);
        setCursor(result.nextCursor);
      } else {
        const result = await page<PublicationPage>(
          `/api/publications?${query}`,
          current.controller.signal,
        );
        if (request.current !== current || current.controller.signal.aborted)
          return;
        setPublications((previous) => [...previous, ...result.publications]);
        setPublicationCursor(result.nextCursor);
      }
    } catch (failure) {
      if (request.current === current && !current.controller.signal.aborted)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (request.current === current && !current.controller.signal.aborted)
        setLoading(false);
    }
  };
  const inputRef = useRef<HTMLInputElement>(null);
  const clear = () => {
    desiredVisibility.current = "all";
    setVisibility("all");
    composing.current = false;
    change("", true);
    inputRef.current?.focus();
  };
  const filter = (
    <div className="item-filter">
      <input
        ref={inputRef}
        type="search"
        aria-label="Filter items by name or description"
        placeholder="Filter items..."
        maxLength={itemFilterMaxLength}
        value={input}
        onChange={(event) => change(event.target.value)}
        onCompositionStart={() => {
          composing.current = true;
          cancel();
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          change(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (composing.current || event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            clear();
          } else if (event.key === "Enter") {
            event.preventDefault();
            void refresh();
          }
        }}
      />
      <select
        aria-label="Filter by access"
        value={visibility}
        onChange={(event) => {
          desiredVisibility.current = event.target.value;
          setVisibility(event.target.value);
          void refresh();
        }}
      >
        <option value="all">All access</option>
        <option value="private">Private</option>
        <option value="public">Public</option>
      </select>
      {input ? (
        <button type="button" aria-label="Clear filter" onClick={clear}>
          <Icon name="close" size={16} />
        </button>
      ) : null}
    </div>
  );
  return {
    pins,
    publications,
    cursor,
    publicationCursor,
    loaded,
    loading,
    error,
    refresh,
    loadMore,
    filter,
    clear,
    filtered: !!input.trim() || visibility !== "all",
  };
}
