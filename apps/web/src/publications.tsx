import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ContentPreview,
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
import { DescriptionClient } from "./description-client.js";
import { previewPollDelay } from "./preview-poll.js";
import {
  DetailDrawer,
  DetailHeading,
  discardDetailsDraft,
} from "./detail-actions.js";

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
  startPublishing = false,
  onConverted,
  descriptionClient,
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
  startPublishing?: boolean;
  onConverted?: (publication: Publication) => void;
  descriptionClient?: DescriptionClient | undefined;
}) {
  const descriptions = useMemo(
    () => descriptionClient ?? new DescriptionClient(),
    [descriptionClient],
  );
  useEffect(
    () => (descriptionClient ? undefined : descriptions.attach()),
    [descriptionClient, descriptions],
  );
  const [receivedHistory, setHistory] = useState<PublicationHistory | null>(
    null,
  );
  const history =
    publication && receivedHistory?.publication.id !== publication.id
      ? null
      : receivedHistory;
  const [title, setTitle] = useState("");
  const [target, setTarget] = useState("");
  const [cid, setCid] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedRevision, setSelectedRevision] = useState<number | null>(null);
  const [task, setTask] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const versionTrigger = useRef<HTMLButtonElement>(null);
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
    setTask(startPublishing);
    setDrawerOpen(false);
  }, [publication?.id, pin?.cid, initialTarget, convert, startPublishing]);
  useEffect(() => {
    if (!publication) return;
    setHistoryError("");
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
  }, [publication?.id, historyReload]);
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
  const copy = (text: string, onCopied?: () => void) => {
    void perform(async () => {
      await navigator.clipboard.writeText(text);
      setNotice("Copied to clipboard.");
      onCopied?.();
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
      busy={busy || drawerOpen}
      className={pin || task ? "" : "reading-dialog"}
      glyphClose={!pin && !task}
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
      {(task || (pin && !convert)) && choicesLoading ? (
        <p role="status">Loading action choices...</p>
      ) : null}
      {(task || (pin && !convert)) && choicesError ? (
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
              if (result.status !== "nop") {
                if (convert && onConverted) onConverted(result.publication);
                else onClose();
              }
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
          {convert && onConverted ? (
            <p>
              After confirming, choose new content to publish v2. Canceling the
              next step does not undo this conversion. The public title and
              descriptions become public with v1.
            </p>
          ) : null}
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
            {convert
              ? onConverted
                ? "Convert to v1 and continue"
                : "Convert to publication"
              : "Publish"}
          </button>
        </form>
      ) : current && viewing ? (
        <>
          {task ? (
            <section aria-label="Publish new version task">
              <h3>{current.title}</h3>
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
                    setSelectedRevision(null);
                    setCid("");
                    setTask(false);
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
                    taskTrigger.current?.focus();
                  });
                }}
              >
                Cancel publishing
              </button>
            </section>
          ) : (
            <div className="publication-detail-shell">
              <div inert={drawerOpen}>
                <NodeDescriptionEditor
                  client={descriptions}
                  key={`${current.id}:${viewing.revision}`}
                  readingFirst
                  name={current.title}
                  rootCid={viewing.cid}
                  publicationId={current.id}
                  revision={viewing.revision}
                  heading={(contentType) => (
                    <DetailHeading
                      name={current.title}
                      cid={viewing.cid}
                      contentType={contentType}
                      disabled={busy}
                      publication={{
                        id: current.id,
                        revision: viewing.revision,
                      }}
                      onCopy={copy}
                      badge={
                        <button
                          ref={versionTrigger}
                          className="detail-version-badge"
                          aria-label={`Viewing v${viewing.revision}. Open version history`}
                          aria-haspopup="dialog"
                          disabled={busy}
                          onClick={() => setDrawerOpen(true)}
                        >
                          v{viewing.revision} ·{" "}
                          {viewing.revision === current.currentRevision
                            ? "Current"
                            : "History"}
                        </button>
                      }
                    />
                  )}
                  facts={
                    <dl className="detail-facts">
                      <dt>Size</dt>
                      <dd>{formatSize(viewing.size)}</dd>
                      <dt>Blocks</dt>
                      <dd>{viewing.blocks}</dd>
                      <dt>Published</dt>
                      <dd>{new Date(viewing.createdAt).toLocaleString()}</dd>
                    </dl>
                  }
                  actions={
                    <div
                      className="detail-action-list"
                      aria-label="Publication actions"
                      inert={busy}
                    >
                      <a
                        href={`/api/public/${viewing.cid}/download?name=${encodeURIComponent(current.title)}`}
                      >
                        <Icon name="download" size={16} /> Download selected
                        file / ZIP
                      </a>
                      <a href={`/api/public/${viewing.cid}/car`}>
                        <Icon name="download" size={16} /> Download selected CAR
                      </a>
                      <button
                        ref={taskTrigger}
                        disabled={busy || !history}
                        onClick={() => setTask(true)}
                      >
                        <Icon name="publication" size={16} /> Publish new
                        version
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
                            await requestJson(
                              `/api/publications/${current.id}`,
                              { method: "DELETE" },
                            );
                            descriptions.invalidatePublication(current.id);
                            await onChanged();
                            onClose();
                          });
                        }}
                      >
                        <Icon name="brand" size={16} /> Delete publication
                      </button>
                    </div>
                  }
                />
              </div>
              {drawerOpen ? (
                <DetailDrawer
                  onClose={() => {
                    if (busy) return;
                    setDrawerOpen(false);
                    requestAnimationFrame(() =>
                      versionTrigger.current?.focus(),
                    );
                  }}
                >
                  <section aria-label="Version history">
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
                              onClick={() => {
                                setSelectedRevision(revision.revision);
                                setDrawerOpen(false);
                                requestAnimationFrame(() =>
                                  versionTrigger.current?.focus(),
                                );
                              }}
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
                </DetailDrawer>
              ) : null}
            </div>
          )}
        </>
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
  const descriptions = useMemo(() => new DescriptionClient(), []);
  useEffect(() => descriptions.attach(), [descriptions]);
  const [receivedHistory, setHistory] = useState<PublicationHistory | null>(
    null,
  );
  const history =
    receivedHistory?.publication.id === id ? receivedHistory : null;
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setNotice("");
    void requestJson<PublicationHistory>(
      `/api/public/publications/${encodeURIComponent(id)}/history`,
      { signal: controller.signal },
    )
      .then((next) => {
        if (!controller.signal.aborted) setHistory(next);
      })
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
            client={descriptions}
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
