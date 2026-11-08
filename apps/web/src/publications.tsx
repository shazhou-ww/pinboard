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
import { DetailMenu, discardDetailsDraft } from "./detail-actions.js";

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
  const [selectedRevision, setSelectedRevision] = useState<number | null>(null);
  const [task, setTask] = useState(false);
  const taskTrigger = useRef<HTMLButtonElement>(null);
  const [historyError, setHistoryError] = useState("");
  const [historyReload, setHistoryReload] = useState(0);
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
    setHistoryError("");
    setError("");
    setNotice("");
    setTitle("");
    setTarget(initialTarget);
    setCid(pin?.cid ?? "");
    setSelectedRevision(null);
    setTask(false);
    if (!publication) return;
    const controller = new AbortController();
    void requestJson<PublicationHistory>(
      `/api/public/publications/${publication.id}/history`,
      { signal: controller.signal },
    )
      .then((next) => {
        if (!controller.signal.aborted) setHistory(next);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setHistoryError(
            failure instanceof Error ? failure.message : String(failure),
          );
      });
    return () => controller.abort();
  }, [publication?.id, pin?.cid, initialTarget, convert, historyReload]);
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
  const viewing = current
    ? (history?.revisions.find(
        (item) =>
          item.revision === (selectedRevision ?? current.currentRevision),
      ) ?? current.current)
    : null;
  const latest = history
    ? Math.max(...history.revisions.map((item) => item.revision))
    : current?.revisionCount;
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
      className={pin || task ? "" : "reading-dialog"}
      returnFocusKey={
        publication
          ? `publication:${publication.id}`
          : pin
            ? `pin:${pin.cid}`
            : undefined
      }
      onClose={() => {
        if (discardDetailsDraft(pin ? !!title.trim() : task && !!cid))
          onClose();
      }}
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
      ) : current && viewing ? (
        <>
          <h3>{current.title}</h3>
          <p className="muted">
            Viewing v{viewing.revision} · Public current v
            {current.currentRevision} · Latest v{latest} ·{" "}
            {current.revisionCount} versions
          </p>
          {task ? (
            <section aria-label="Publish new version task">
              <h4>Publish new version</h4>
              <p className="muted">
                Publish to this identity, not the browsing version. New
                revisions publish root and reachable-child user descriptions.
                The current CID is a NOP: no new revision or description
                snapshot.
              </p>
              <div className="actions">
                {onUploadFile ? (
                  <button
                    disabled={busy || !history}
                    onClick={() => onUploadFile(current)}
                  >
                    Upload file to publication
                  </button>
                ) : null}
                {onUploadFolder ? (
                  <button
                    disabled={busy || !history}
                    onClick={() => onUploadFolder(current)}
                  >
                    Upload folder to publication
                  </button>
                ) : null}
              </div>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void perform(async () => {
                    if (
                      !pins.some((item) => item.cid === cid) ||
                      choicesLoading ||
                      choicesError
                    )
                      throw new Error(
                        "Choose an available owned pin before publishing.",
                      );
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
                  Publish an existing owned pin
                  <select
                    value={cid}
                    onChange={(event) => setCid(event.target.value)}
                    required
                    disabled={busy || choicesLoading || !!choicesError}
                  >
                    <option value="">Choose a pin by name</option>
                    {pins.map((item) => (
                      <option key={item.cid} value={item.cid}>
                        {item.name} · {formatSize(item.size)} · {item.cid}
                      </option>
                    ))}
                  </select>
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
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (!discardDetailsDraft(!!cid)) return;
                  setCid("");
                  setTask(false);
                  requestAnimationFrame(() => {
                    taskTrigger.current
                      ?.closest("details")
                      ?.querySelector("summary")
                      ?.focus();
                  });
                }}
              >
                Cancel publishing
              </button>
            </section>
          ) : (
            <>
              <div
                className="actions detail-toolbar"
                aria-label="Publication actions"
                inert={busy}
              >
                <DetailMenu label="Share">
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
                        `${location.origin}/p/${current.id}/v/${viewing.revision}`,
                      )
                    }
                  >
                    Copy fixed v{viewing.revision} link
                  </button>
                  <button disabled={busy} onClick={() => copy(viewing.cid)}>
                    Copy selected CID
                  </button>
                  <a href={`/p/${current.id}`}>
                    Open public page <Icon name="externalLink" size={16} />
                  </a>
                  <p className="muted">
                    Follow link points to current v{current.currentRevision};
                    fixed version and CID never change.
                  </p>
                </DetailMenu>
                <DetailMenu label="Download">
                  <a
                    href={`/api/public/${viewing.cid}/download?name=${encodeURIComponent(current.title)}`}
                  >
                    Download selected file / ZIP
                  </a>
                  <a href={`/api/public/${viewing.cid}/car`}>
                    Download selected CAR
                  </a>
                </DetailMenu>
                <DetailMenu label="More">
                  <button
                    ref={taskTrigger}
                    disabled={busy || !history}
                    onClick={() => setTask(true)}
                  >
                    Publish new version
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => {
                      void perform(() => refresh(current.id));
                    }}
                  >
                    Refresh details
                  </button>
                  <button
                    className="danger"
                    disabled={busy}
                    onClick={() => {
                      if (
                        !window.confirm(
                          "Move this publication to recently deleted? All its public links and history will close. Restore within 30 days to reopen the original links. Pins remain independent. Public bytes and external copies cannot be recalled.",
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
                </DetailMenu>
              </div>
              <NodeDescriptionEditor
                key={`${current.id}:${viewing.revision}`}
                readingFirst
                name={current.title}
                rootCid={viewing.cid}
                publicationId={current.id}
                revision={viewing.revision}
                facts={
                  <p className="muted">
                    {formatSize(viewing.size)} · {viewing.blocks} blocks
                    <br />
                    Published {new Date(viewing.createdAt).toLocaleString()}
                  </p>
                }
                sidebar={
                  <section aria-label="Version history">
                    <h4>Version history</h4>
                    <p className="muted">
                      Selecting a version only changes your reading view, not
                      public current.
                    </p>
                    {historyError ? (
                      <div role="alert">
                        <p>{historyError}</p>
                        <button
                          disabled={busy}
                          onClick={() => setHistoryReload((value) => value + 1)}
                        >
                          Retry history
                        </button>
                      </div>
                    ) : !history ? (
                      <p role="status">Loading history...</p>
                    ) : (
                      <ol className="publication-history">
                        {history.revisions.map((revision) => (
                          <li key={revision.revision}>
                            <button
                              disabled={busy}
                              aria-pressed={
                                revision.revision === viewing.revision
                              }
                              onClick={() =>
                                setSelectedRevision(revision.revision)
                              }
                            >
                              View v{revision.revision}
                              {revision.revision === current.currentRevision
                                ? " · Current"
                                : ""}
                              {revision.revision === latest ? " · Latest" : ""}
                            </button>
                            <p className="muted">
                              {formatSize(revision.size)} ·{" "}
                              {new Date(
                                revision.createdAt,
                              ).toLocaleDateString()}
                            </p>
                          </li>
                        ))}
                      </ol>
                    )}
                    {history && viewing.revision !== current.currentRevision ? (
                      <button
                        disabled={busy}
                        onClick={() => {
                          if (
                            !window.confirm(
                              `Make v${viewing.revision} current? No new revision will be created. All versions remain in history.`,
                            )
                          )
                            return;
                          void perform(async () => {
                            await mutate(
                              `/api/publications/${current.id}/rollback`,
                              {
                                revision: viewing.revision,
                                expectedSequence: current.sequence,
                              },
                            );
                            await refresh(current.id);
                            setNotice(`Current is now v${viewing.revision}.`);
                          });
                        }}
                      >
                        Make viewed v{viewing.revision} current
                      </button>
                    ) : null}
                    <details>
                      <summary>Publication technical identity</summary>
                      <p className="muted">
                        Publication ID: {current.id}
                        <br />
                        Sequence: {current.sequence}
                      </p>
                    </details>
                  </section>
                }
              />
            </>
          )}
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
