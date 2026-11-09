import {
  itemFilterMaxLength,
  normalizeItemFilter,
  recentlyDeletedPageSize,
  type DeletedItem,
  type DeletedPage,
} from "@shazhou/pinboard-contracts";
import { useEffect, useRef, useState } from "react";
import { SettingsTable } from "./authorizations.js";
import { Icon } from "./icon.js";
import { requestJson } from "./manager.js";

export function RecentlyDeleted({
  active,
  disabled,
  onBusyChange,
  onChanged,
}: {
  active: boolean;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onChanged: () => Promise<void>;
}) {
  const [page, setPage] = useState<DeletedPage | null>(null);
  const [query, setQuery] = useState("");
  const [cursors, setCursors] = useState([""]);
  const [pageIndex, setPageIndex] = useState(0);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [restoreError, setRestoreError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const cursor = cursors[pageIndex]!;
  const filter = normalizeItemFilter(query);

  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setPage(null);
    const timer = setTimeout(
      () => {
        const params = new URLSearchParams();
        if (cursor) params.set("cursor", cursor);
        if (filter) params.set("q", filter);
        void requestJson<DeletedPage>(
          `/api/recently-deleted${params.size ? `?${params}` : ""}`,
          { signal: controller.signal },
        )
          .then((result) => {
            if (controller.signal.aborted) return;
            if (
              cursor &&
              (!result.items.length ||
                pageIndex * recentlyDeletedPageSize >= result.matchedTotal)
            ) {
              setCursors([""]);
              setPageIndex(0);
            } else {
              setPage(result);
            }
          })
          .catch((failure: unknown) => {
            if (!controller.signal.aborted)
              setError(
                failure instanceof Error ? failure.message : String(failure),
              );
          })
          .finally(() => {
            if (!controller.signal.aborted) setLoading(false);
          });
      },
      filter ? 200 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [active, cursor, filter, pageIndex, reload]);

  const resetPage = () => {
    setCursors([""]);
    setPageIndex(0);
  };
  const refresh = () => {
    resetPage();
    setRestoreError("");
    setReload((previous) => previous + 1);
  };
  const restore = async (item: DeletedItem) => {
    if (busy || disabled) return;
    setBusy(true);
    setRestoreError("");
    setStatus("");
    let restored = false;
    try {
      await requestJson(
        item.kind === "pin"
          ? `/api/pins/${encodeURIComponent(item.id)}/restore`
          : `/api/publications/${encodeURIComponent(item.id)}/restore`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );
      restored = true;
      refresh();
      setStatus(`Restored ${item.title}.`);
      await onChanged();
    } catch (failure) {
      const message =
        failure instanceof Error ? failure.message : String(failure);
      setRestoreError(
        restored
          ? `Restored ${item.title}, but refreshing the account failed. ${message}`
          : `Could not restore ${item.title}. ${message}`,
      );
    } finally {
      setBusy(false);
      if (restored) requestAnimationFrame(() => search.current?.focus());
    }
  };
  const locked = disabled || busy;
  const totalPages = page
    ? Math.max(1, Math.ceil(page.matchedTotal / recentlyDeletedPageSize))
    : 1;

  return (
    <section className="authorization recently-deleted">
      <div>
        <h2>Recently deleted</h2>
        <p className="recently-deleted-intro muted">
          Restore pins and publications within 30 days, keeping their original
          identity and links.
        </p>
      </div>
      <div
        className="authorization-toolbar"
        role="group"
        aria-label="recently deleted toolbar"
      >
        <div className="authorization-filter">
          <input
            ref={search}
            type="search"
            aria-label="Search recently deleted"
            placeholder="Filter by name or type"
            maxLength={itemFilterMaxLength}
            value={query}
            disabled={locked}
            onChange={(event) => {
              resetPage();
              setQuery(event.target.value);
            }}
          />
        </div>
        <button
          type="button"
          className="glyph-button"
          aria-label="Refresh recently deleted"
          title="Refresh recently deleted"
          disabled={locked || loading}
          onClick={refresh}
        >
          <Icon name="refresh" />
        </button>
      </div>
      {restoreError && (
        <p className="notice" role="alert">
          {restoreError}
        </p>
      )}
      <SettingsTable
        name="recently deleted"
        columns={["Name", "Type", "Deleted", "Recover before", "Actions"]}
        className="recently-deleted-table"
        loading={loading}
        error={error}
        empty={
          !page?.items.length
            ? filter
              ? "No matching items. Try another name or type."
              : "No recoverable items."
            : ""
        }
        retry={
          <button type="button" disabled={locked} onClick={refresh}>
            Retry
          </button>
        }
      >
        {page?.items.map((item) => (
          <tr key={`${item.kind}:${item.id}`}>
            <td>
              <strong>{item.title}</strong>
            </td>
            <td>
              <span className="authorization-badge">
                {item.kind === "pin" ? "Pin" : "Publication"}
              </span>
            </td>
            <td>
              <time dateTime={item.deletedAt}>
                {new Date(item.deletedAt).toLocaleDateString()}
              </time>
              <small>
                {new Date(item.deletedAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </small>
            </td>
            <td>
              <time dateTime={item.expiresAt}>
                {new Date(item.expiresAt).toLocaleDateString()}
              </time>
              <small>
                {new Date(item.expiresAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </small>
            </td>
            <td>
              <button
                type="button"
                disabled={locked || loading}
                aria-label={`Restore ${item.title}`}
                onClick={() => void restore(item)}
              >
                Restore
              </button>
            </td>
          </tr>
        ))}
      </SettingsTable>
      {page && (
        <div className="settings-table-footer">
          <span className="authorization-count">{page.total} items</span>
          {(pageIndex > 0 || page.nextCursor) && (
            <nav className="settings-pagination" aria-label="Trash pagination">
              <button
                type="button"
                className="glyph-button"
                aria-label="Previous page"
                title="Previous page"
                disabled={locked || loading || pageIndex === 0}
                onClick={() => setPageIndex((previous) => previous - 1)}
              >
                <Icon name="caretLeft" />
              </button>
              <span aria-live="polite">
                Page {pageIndex + 1} / {totalPages}
              </span>
              <button
                type="button"
                className="glyph-button"
                aria-label="Next page"
                title="Next page"
                disabled={locked || loading || !page.nextCursor}
                onClick={() => {
                  if (!page.nextCursor) return;
                  setCursors([
                    ...cursors.slice(0, pageIndex + 1),
                    page.nextCursor,
                  ]);
                  setPageIndex((previous) => previous + 1);
                }}
              >
                <Icon name="caretRight" />
              </button>
            </nav>
          )}
        </div>
      )}
      <p className="visually-hidden" role="status">
        {status}
      </p>
    </section>
  );
}
