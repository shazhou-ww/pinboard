import { useEffect, useRef, useState } from "react";
import type {
  ContentPreview,
  DeletedItem,
  Pin,
  Publication,
  PublicationHistory,
  PublicationResult,
} from "@shazhou/pinboard-contracts";
import { Dialog } from "./dialog.js";
import { requestJson, formatSize } from "./manager.js";
import { PreviewContent, previewClassName, TypeCover } from "./pin-preview.js";
import { isContentPreview } from "@shazhou/pinboard-contracts";
import { previewEnabled } from "./api.js";
import { Icon } from "./icon.js";
import { NodeDescriptionEditor } from "./node-description.js";
import { previewPollDelay } from "./preview-poll.js";

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export function PublicationPreview({
  publication,
  revision,
}: {
  publication: Publication;
  revision?: number;
}) {
  const [preview, setPreview] = useState<ContentPreview | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    setPreview(null);
    setError("");
    const load = async () => {
      try {
        const next = await requestJson<unknown>(
          `/api/public/publications/${publication.id}/preview/${revision ?? publication.currentRevision}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        if (!isContentPreview(next, previewEnabled))
          throw new Error("Invalid preview response");
        setPreview(next);
        setError("");
        const delay = previewPollDelay(next, ++attempts);
        if (delay !== undefined)
          timer = setTimeout(() => {
            void load();
          }, delay);
      } catch (failure) {
        if (!controller.signal.aborted) {
          setPreview(null);
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
        }
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [publication.id, publication.currentRevision, revision]);
  return (
    <div className={previewClassName(preview)}>
      {preview ? (
        <PreviewContent preview={preview} name={publication.title} />
      ) : error ? (
        <p className="muted" role="status">
          {error}
        </p>
      ) : (
        <TypeCover contentType={null} />
      )}
    </div>
  );
}

export function PublicationDialog({
  publication,
  pin,
  pins,
  publications,
  onClose,
  onChanged,
  convert = false,
  initialTarget = "",
  onUploadFile,
  onUploadFolder,
  choicesLoading = false,
  choicesError = "",
  onRetryChoices,
}: {
  publication: Publication | null;
  pin: Pin | null;
  pins: readonly Pin[];
  publications: readonly Publication[];
  onClose: () => void;
  onChanged: () => Promise<void>;
  convert?: boolean;
  initialTarget?: string;
  onUploadFile?: (publication: Publication) => void;
  onUploadFolder?: (publication: Publication) => void;
  choicesLoading?: boolean;
  choicesError?: string;
  onRetryChoices?: () => void;
}) {
  const [history, setHistory] = useState<PublicationHistory | null>(null);
  const [title, setTitle] = useState("");
  const [target, setTarget] = useState("");
  const [cid, setCid] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pendingRequest = useRef<{ payload: string; requestId: string } | null>(
    null,
  );
  async function mutate<T>(
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const payload = JSON.stringify({ path, body });
    if (pendingRequest.current?.payload !== payload)
      pendingRequest.current = { payload, requestId: crypto.randomUUID() };
    const result = await requestJson<T>(
      path,
      json({ ...body, requestId: pendingRequest.current.requestId }),
    );
    return result;
  }
  useEffect(() => {
    pendingRequest.current = null;
    setHistory(null);
    setError("");
    setNotice("");
    setTitle("");
    setTarget(initialTarget);
    setCid(pin?.cid ?? "");
    if (!publication) return;
    const controller = new AbortController();
    void requestJson<PublicationHistory>(
      `/api/public/publications/${publication.id}/history`,
      { signal: controller.signal },
    )
      .then(setHistory)
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
      });
    return () => controller.abort();
  }, [publication?.id, pin?.cid, initialTarget, convert]);
  const perform = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const refresh = async (id: string) => {
    setHistory(
      await requestJson<PublicationHistory>(
        `/api/public/publications/${id}/history`,
      ),
    );
    await onChanged();
  };
  const current = history?.publication ?? publication;
  const copy = (text: string) => {
    void perform(async () => {
      await navigator.clipboard.writeText(text);
      setNotice("Copied to clipboard.");
    });
  };
  return (
    <Dialog
      open={!!publication || !!pin}
      title={
        pin
          ? convert
            ? "Convert to publication"
            : "Add to a publication"
          : "Publication details"
      }
      busy={busy}
      onClose={onClose}
    >
      {error ? (
        <p role="alert">
          {error} Refresh the details before retrying a conflict.
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {choicesLoading ? <p role="status">Loading action choices...</p> : null}
      {choicesError ? (
        <div role="alert">
          <p>{choicesError}</p>
          <button type="button" onClick={onRetryChoices}>
            Retry action choices
          </button>
        </div>
      ) : null}
      {pin ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void perform(async () => {
              const existing = convert
                ? undefined
                : publications.find((item) => item.id === target);
              if (
                !convert &&
                (choicesLoading || choicesError || (target && !existing))
              )
                throw new Error(
                  "Publication choices are unavailable. Retry loading before publishing.",
                );
              const result = await mutate<PublicationResult>(
                existing
                  ? `/api/publications/${existing.id}/publish`
                  : convert
                    ? `/api/pins/${pin.cid}/convert`
                    : "/api/publications",
                existing
                  ? {
                      cid: pin.cid,
                      expectedSequence: existing.sequence,
                    }
                  : {
                      title,
                      ...(convert ? {} : { cid: pin.cid }),
                      public: true,
                    },
              );
              await onChanged();
              setNotice(
                result.status === "nop"
                  ? "Already current. No version was created; draft description changes were not applied."
                  : "Published.",
              );
              if (result.status !== "nop") onClose();
            });
          }}
        >
          <p>
            {convert
              ? "Replace this fixed Pin with a publication in place; original content becomes v1. The original CID remains readable. "
              : "Link this pin without removing or renaming it. "}
            The public title, stable link and complete version history are
            visible to everyone. Your private pin label and account identity
            stay private. Root and reachable-child user descriptions are public
            with each new revision. Publishing the current CID is a NOP: draft
            description changes are not applied to the existing public version.
          </p>
          {!convert ? (
            <label>
              Publication
              <select
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                disabled={busy || choicesLoading || !!choicesError}
              >
                <option value="">Create a publication</option>
                {publications.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title} (current v{item.currentRevision})
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {!target ? (
            <label>
              Public title
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                required
                maxLength={200}
                disabled={busy}
              />
            </label>
          ) : null}
          <button
            className="primary"
            disabled={
              busy ||
              (!convert && (choicesLoading || !!choicesError)) ||
              (!target && !title.trim())
            }
          >
            {convert ? "Convert to publication" : "Publish"}
          </button>
        </form>
      ) : current ? (
        <>
          <h3>{current.title}</h3>
          <NodeDescriptionEditor
            key={`${current.id}:${current.currentRevision}`}
            rootCid={current.current.cid}
            publicationId={current.id}
            revision={current.currentRevision}
          />
          <p>
            Publication · Current v{current.currentRevision} ·{" "}
            {current.revisionCount} versions · Sequence {current.sequence}
          </p>
          <div className="actions">
            {onUploadFile ? (
              <button disabled={busy} onClick={() => onUploadFile(current)}>
                Upload file to publication
              </button>
            ) : null}
            {onUploadFolder ? (
              <button disabled={busy} onClick={() => onUploadFolder(current)}>
                Upload folder to publication
              </button>
            ) : null}
            <a href={`/p/${current.id}`}>
              Open public page <Icon name="externalLink" size={16} />
            </a>
            <button
              disabled={busy}
              onClick={() => copy(`${location.origin}/p/${current.id}`)}
            >
              Copy follow link
            </button>
            <button
              disabled={busy}
              onClick={() =>
                copy(
                  `${location.origin}/p/${current.id}/v/${current.currentRevision}`,
                )
              }
            >
              Copy fixed v{current.currentRevision} link
            </button>
            <button disabled={busy} onClick={() => copy(current.current.cid)}>
              Copy current CID
            </button>
            <button
              disabled={busy}
              onClick={() => {
                void perform(() => refresh(current.id));
              }}
            >
              Refresh details
            </button>
          </div>
          <p className="muted">
            The follow link changes with publication and rollback. Fixed-version
            links and CID bytes never change.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void perform(async () => {
                const result = await mutate<PublicationResult>(
                  `/api/publications/${current.id}/publish`,
                  {
                    cid,
                    expectedSequence: current.sequence,
                  },
                );
                await refresh(current.id);
                setNotice(
                  result.status === "nop"
                    ? "Already current. No version was created; draft description changes were not applied."
                    : "Published.",
                );
              });
            }}
          >
            <label>
              Publish an existing pin
              <input
                list="publication-pin-options"
                value={cid}
                onChange={(event) => setCid(event.target.value)}
                placeholder="Owned pin CID"
                required
                disabled={busy}
              />
              <datalist id="publication-pin-options">
                {pins.map((item) => (
                  <option key={item.cid} value={item.cid}>
                    {item.name}
                  </option>
                ))}
              </datalist>
            </label>
            <button
              disabled={
                busy ||
                !history ||
                !cid.trim() ||
                choicesLoading ||
                !!choicesError
              }
            >
              Publish new version
            </button>
          </form>
          <h3>Version history</h3>
          {!history ? (
            <p role="status">Loading history...</p>
          ) : (
            <ol className="publication-history">
              {history.revisions.map((revision) => (
                <li key={revision.revision}>
                  <div>
                    <a href={`/p/${current.id}/v/${revision.revision}`}>
                      v{revision.revision}
                    </a>
                    {revision.revision === current.currentRevision
                      ? " · Current"
                      : ""}
                    <p className="muted">
                      {new Date(revision.createdAt).toLocaleString()} ·{" "}
                      {formatSize(revision.size)}
                    </p>
                    <code className="cid">{revision.cid}</code>
                  </div>
                  <button
                    disabled={
                      busy || revision.revision === current.currentRevision
                    }
                    onClick={() => {
                      if (
                        !window.confirm(
                          `Make v${revision.revision} current? No new revision will be created.`,
                        )
                      )
                        return;
                      void perform(async () => {
                        await mutate(
                          `/api/publications/${current.id}/rollback`,
                          {
                            revision: revision.revision,
                            expectedSequence: current.sequence,
                          },
                        );
                        await refresh(current.id);
                        setNotice(`Current is now v${revision.revision}.`);
                      });
                    }}
                  >
                    Make current
                  </button>
                </li>
              ))}
            </ol>
          )}
          <button
            className="danger"
            disabled={busy}
            onClick={() => {
              if (
                !window.confirm(
                  "Move this publication to recently deleted? All its public links and history will close. Restore within 30 days to reopen the original links. Pins remain independent.",
                )
              )
                return;
              void perform(async () => {
                await requestJson(`/api/publications/${current.id}`, {
                  method: "DELETE",
                });
                await onChanged();
                onClose();
              });
            }}
          >
            Move to recently deleted
          </button>
        </>
      ) : null}
    </Dialog>
  );
}

export function DeletedDialog({
  open,
  onClose,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [items, setItems] = useState<DeletedItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = async (next?: string) => {
    const page = await requestJson<{
      items: DeletedItem[];
      nextCursor: string | null;
    }>(
      `/api/recently-deleted${next ? `?cursor=${encodeURIComponent(next)}` : ""}`,
    );
    setItems((previous) => (next ? [...previous, ...page.items] : page.items));
    setCursor(page.nextCursor);
  };
  useEffect(() => {
    if (!open) return;
    setError("");
    void load().catch((failure: unknown) =>
      setError(failure instanceof Error ? failure.message : String(failure)),
    );
  }, [open]);
  return (
    <Dialog open={open} title="Recently deleted" busy={busy} onClose={onClose}>
      <p>
        Restore within 30 days. Expiry releases only this object's references;
        the last reference then starts a seven-day cleanup grace period. Public
        CID copies cannot be recalled.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {!items.length ? (
        <p>No recoverable items.</p>
      ) : (
        <ul className="publication-history">
          {items.map((item) => (
            <li key={`${item.kind}:${item.id}`}>
              <div>
                <strong>{item.title}</strong>
                <p>{item.kind === "pin" ? "Pin" : "Publication"}</p>
                <p className="muted">
                  Deleted {new Date(item.deletedAt).toLocaleString()}
                  <br />
                  Recover before {new Date(item.expiresAt).toLocaleString()}
                </p>
              </div>
              <button
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setError("");
                  void requestJson(
                    item.kind === "pin"
                      ? `/api/pins/${item.id}/restore`
                      : `/api/publications/${item.id}/restore`,
                    json({}),
                  )
                    .then(async () => {
                      await load();
                      await onChanged();
                    })
                    .catch((failure: unknown) =>
                      setError(
                        failure instanceof Error
                          ? failure.message
                          : String(failure),
                      ),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                Restore
              </button>
            </li>
          ))}
        </ul>
      )}
      {cursor ? (
        <button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void load(cursor)
              .catch((failure: unknown) =>
                setError(
                  failure instanceof Error ? failure.message : String(failure),
                ),
              )
              .finally(() => setBusy(false));
          }}
        >
          Load more
        </button>
      ) : null}
    </Dialog>
  );
}

export function PublicationPage({
  id,
  revision,
}: {
  id: string;
  revision?: number;
}) {
  const [history, setHistory] = useState<PublicationHistory | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void requestJson<PublicationHistory>(
      `/api/public/publications/${encodeURIComponent(id)}/history`,
      { signal: controller.signal },
    )
      .then(setHistory)
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
      });
    return () => controller.abort();
  }, [id]);
  const publication = history?.publication;
  const actual = revision
    ? history?.revisions.find((item) => item.revision === revision)
    : publication?.current;
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice("Copied to clipboard.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  return (
    <main className="shell publication-page">
      <header className="masthead">
        <a className="brand" href="/">
          Pinboard
        </a>
        <span>
          <Icon name="publication" /> Publication
        </span>
      </header>
      {error ? (
        <p role="alert">{error}</p>
      ) : !history ? (
        <p role="status">Loading publication...</p>
      ) : null}
      {publication && actual ? (
        <>
          <h1>{publication.title}</h1>
          <NodeDescriptionEditor
            key={`${id}:${actual.revision}`}
            rootCid={actual.cid}
            publicationId={id}
            revision={actual.revision}
          />
          <p>
            {revision
              ? `Fixed v${actual.revision}`
              : `Following current v${actual.revision}`}{" "}
            · {publication.revisionCount} versions · {formatSize(actual.size)}
          </p>
          <div className="actions">
            <button
              onClick={() => {
                void copy(`${location.origin}/p/${id}`);
              }}
            >
              Copy follow link
            </button>
            <button
              onClick={() => {
                void copy(`${location.origin}/p/${id}/v/${actual.revision}`);
              }}
            >
              Copy fixed v{actual.revision} link
            </button>
            <button
              onClick={() => {
                void copy(actual.cid);
              }}
            >
              Copy CID
            </button>
            <a
              href={`/api/public/publications/${publication.id}/download/${actual.revision}?format=original`}
            >
              Download file / ZIP <Icon name="download" size={16} />
            </a>
            <a href={`/api/public/${actual.cid}/car`}>
              Download complete CAR <Icon name="download" size={16} />
            </a>
            <a href={`/share/${actual.cid}`}>Open CID share</a>
          </div>
          <p className="muted">
            Follow links can change. Cite a fixed version or CID to identify
            these exact bytes. Content is never executed as a website.
          </p>
          <code className="cid">{actual.cid}</code>
          {notice ? <p role="status">{notice}</p> : null}
          <h2>Public version history</h2>
          <ol className="publication-history">
            {history!.revisions.map((item) => (
              <li key={item.revision}>
                <a href={`/p/${id}/v/${item.revision}`}>
                  v{item.revision}
                  {item.revision === publication.currentRevision
                    ? " · Current"
                    : ""}
                </a>
                <span>{new Date(item.createdAt).toLocaleString()}</span>
              </li>
            ))}
          </ol>
          <a href={`/p/${id}`}>Follow current</a>
        </>
      ) : history ? (
        <p role="alert">Version not found.</p>
      ) : null}
    </main>
  );
}
