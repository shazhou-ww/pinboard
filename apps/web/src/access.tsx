import { useEffect, useState } from "react";
import type { Visibility } from "@shazhou/pinboard-contracts";
import { Dialog } from "./dialog.js";
import { requestJson } from "./manager.js";

export function confirmPublicSource(
  source: Visibility,
  target: Visibility,
): boolean {
  return (
    source !== "private" ||
    target !== "public" ||
    window.confirm(
      "This publication is public. The private source's file bytes and version descriptions will become public, including downloads and external copies that cannot be recalled. The source Pin remains private. Continue?",
    )
  );
}

export function AccessDialog<T extends { visibility: Visibility }>({
  open,
  kind,
  id,
  item,
  revision,
  onClose,
  onSaved,
}: {
  open: boolean;
  kind: "pin" | "publication";
  id: string;
  item: T;
  revision?: number;
  onClose: () => void;
  onSaved: (item: T) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    setError("");
    setNotice("");
  }, [id, open]);
  const publication = kind === "publication";
  const origin = typeof location === "undefined" ? "" : location.origin;
  const link = publication ? `${origin}/p/${id}` : `${origin}/share/${id}`;
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(
        item.visibility === "private"
          ? "Copied. This link grants no access to others."
          : "Share link copied.",
      );
    } catch {
      setError("Could not copy the link. Retry or copy it from your browser.");
    }
  };
  const save = async () => {
    const visibility = item.visibility === "private" ? "public" : "private";
    const warning =
      visibility === "public"
        ? `Make this ${kind} public? ${publication ? "Its title, descriptions, previews, current version and ALL history will be public. " : "Its file bytes and previews will be public. "}Anyone can download or cache copies that cannot be recalled.`
        : `Make this ${kind} private? New anonymous reads through this item will stop${publication ? ", including ALL history" : ""}. Existing downloads, browser caches and external copies cannot be recalled. If the same bytes have another public reference, those bytes remain anonymously readable; private item metadata stays isolated.`;
    if (!window.confirm(warning)) return;
    setBusy(true);
    setError("");
    try {
      const updated = await requestJson<T>(
        `/api/${publication ? "publications" : "pins"}/${id}/visibility`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ visibility, acknowledge: true }),
        },
      );
      onSaved(updated);
      setNotice(`Access saved: ${updated.visibility}.`);
    } catch (failure) {
      setError(
        `Access was not confirmed. The displayed setting is unchanged. ${failure instanceof Error ? failure.message : String(failure)} Refresh details to check the server state, then retry saving.`,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      title="Access and sharing"
      busy={busy}
      onClose={onClose}
    >
      <p>
        {item.visibility === "private"
          ? "Private. Only your account and Agents with the required read permission can access this item. Copying a link grants no access."
          : "Public. Anyone with a link can read and download this item."}
      </p>
      {publication && (
        <p>
          Access applies to the title, descriptions, previews, current version
          and all history.
        </p>
      )}
      <p className="muted">
        Shared bytes may remain public through other public references. Existing
        downloads, caches and external copies cannot be recalled.
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <div className="actions">
        <button disabled={busy} onClick={() => void copy(link)}>
          {item.visibility === "private"
            ? "Copy personal access link"
            : publication
              ? "Copy follow link"
              : "Copy share link"}
        </button>
        {publication && item.visibility === "public" && revision && (
          <button
            disabled={busy}
            onClick={() => void copy(`${link}/v/${revision}`)}
          >
            Copy fixed v{revision} link
          </button>
        )}
        <button className="primary" disabled={busy} onClick={() => void save()}>
          Make {item.visibility === "private" ? "public" : "private"}
        </button>
      </div>
    </Dialog>
  );
}
