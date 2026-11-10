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
import { ApiRequestError, previewEnabled } from "./api.js";
import { Icon } from "./icon.js";
import { NodeDescriptionEditor } from "./node-description.js";
import { DescriptionClient } from "./description-client.js";
import { previewPollDelay } from "./preview-poll.js";
import { AccessDialog, confirmPublicSource } from "./access.js";
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
  const [accessOpen, setAccessOpen] = useState(false);
  const [metadataBusy, setMetadataBusy] = useState(false);
  const [metadataDirty, setMetadataDirty] = useState(false);
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
    method = "POST",
  ): Promise<T> {
    const payload = JSON.stringify({ path, body, method });
    if (pendingRequest.current?.payload !== payload)
      pendingRequest.current = { payload, requestId: crypto.randomUUID() };
    const result = await requestJson<T>(path, {
      ...json({ ...body, requestId: pendingRequest.current.requestId }),
      method,
    });
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
    setAccessOpen(false);
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
    <>
      <Dialog
        open={!!publication || !!pin}
        title={
          pin
            ? convert
              ? "Convert to publication"
              : "Add to a publication"
            : "Publication details"
        }
        busy={busy || drawerOpen || metadataBusy}
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
          if (
            discardDetailsDraft(
              metadataDirty || (pin ? !!title.trim() : task && !!cid),
            )
          )
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
                if (
                  existing &&
                  !confirmPublicSource(pin.visibility, existing.visibility)
                )
                  return;
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
                        acknowledgePublicExposure:
                          existing.visibility === "public",
                      }
                    : {
                        title,
                        ...(convert ? {} : { cid: pin.cid }),
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
            <p className="muted">
              Access:{" "}
              {convert
                ? pin.visibility
                : target
                  ? publications.find((item) => item.id === target)?.visibility
                  : "private"}
              . Conversion inherits the source; updates inherit the destination.
              Return to details to change access.
            </p>
            <p>
              {convert
                ? "Replace this fixed Pin with a publication in place; original content becomes v1. The original CID remains readable. "
                : "Link this pin without removing or renaming it. "}
              New publications are private; conversion preserves the source's
              access. Updates preserve the target's access, including all
              history and version descriptions. Publishing the current CID is a
              NOP and does not apply description changes.
            </p>
            {convert && onConverted ? (
              <p>
                After confirming, choose new content to publish v2. Canceling
                the next step does not undo this conversion. The title and
                descriptions retain the source's access with v1.
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
                Publication title
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
                <p>
                  Access: {current.visibility}. Updates keep this setting;
                  return to details to change it.
                </p>
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
                      const source = pins.find((item) => item.cid === cid)!;
                      if (
                        !confirmPublicSource(
                          source.visibility,
                          current.visibility,
                        )
                      )
                        return;
                      const result = await mutate<PublicationResult>(
                        `/api/publications/${current.id}/publish`,
                        {
                          cid,
                          expectedSequence: current.sequence,
                          acknowledgePublicExposure:
                            current.visibility === "public",
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
                    onBusyChange={setMetadataBusy}
                    onDirtyChange={setMetadataDirty}
                    onSaveDetails={
                      viewing.revision === current.currentRevision
                        ? async (title, description) => {
                            if (
                              current.visibility === "public" &&
                              !window.confirm(
                                "Save public publication details? The title and new description will be public. Description changes create a new version with the same file CID; earlier descriptions stay unchanged. Downloaded and cached copies cannot be recalled.",
                              )
                            )
                              return false;
                            const result = await mutate<PublicationResult>(
                              `/api/publications/${current.id}`,
                              {
                                title,
                                description,
                                expectedSequence: current.sequence,
                                acknowledgePublicExposure:
                                  current.visibility === "public",
                              },
                              "PATCH",
                            ).catch((failure: unknown) => {
                              if (
                                failure instanceof ApiRequestError &&
                                failure.status === 409
                              )
                                throw new Error(
                                  "Publication changed. Your draft is preserved; cancel editing and reopen details to use the latest version before saving again.",
                                );
                              throw failure;
                            });
                            setHistory((previous) => ({
                              publication: result.publication,
                              revisions: previous?.revisions.some(
                                (item) =>
                                  item.revision ===
                                  result.publication.currentRevision,
                              )
                                ? previous.revisions
                                : [
                                    result.publication.current,
                                    ...(previous?.revisions ?? []),
                                  ],
                              operations:
                                result.status === "nop"
                                  ? (previous?.operations ?? [])
                                  : [
                                      {
                                        sequence: result.publication.sequence,
                                        revision:
                                          result.publication.currentRevision,
                                        kind: "edit",
                                        createdAt: result.publication.updatedAt,
                                      },
                                      ...(previous?.operations ?? []),
                                    ],
                            }));
                            setSelectedRevision(null);
                            setNotice(
                              result.status === "nop"
                                ? "Details unchanged."
                                : "Publication details saved. Earlier descriptions are unchanged.",
                            );
                            try {
                              await onChanged();
                            } catch (failure) {
                              setHistoryError(
                                `Details saved, but the list could not refresh. ${failure instanceof Error ? failure.message : String(failure)}`,
                              );
                            }
                            return;
                          }
                        : undefined
                    }
                    heading={(contentType, editor) => (
                      <DetailHeading
                        name={current.title}
                        visibility={current.visibility}
                        onAccess={() => setAccessOpen(true)}
                        cid={viewing.cid}
                        contentType={contentType}
                        disabled={busy || editor.busy || editor.editing}
                        publication={{
                          id: current.id,
                          revision: viewing.revision,
                        }}
                        onCopy={copy}
                        badge={
                          <>
                            <button
                              ref={versionTrigger}
                              className="detail-version-badge"
                              aria-label={`Viewing v${viewing.revision}. Open version history`}
                              aria-haspopup="dialog"
                              disabled={busy || editor.editing}
                              onClick={() => setDrawerOpen(true)}
                            >
                              v{viewing.revision} ·{" "}
                              {viewing.revision === current.currentRevision
                                ? "Current"
                                : "History"}
                            </button>
                            {viewing.revision === current.currentRevision ? (
                              <button
                                className="detail-rename"
                                aria-label="Edit details"
                                title="Edit publication title and description"
                                aria-pressed={editor.editing}
                                disabled={
                                  busy ||
                                  editor.busy ||
                                  editor.editing ||
                                  !editor.ready
                                }
                                onClick={editor.start}
                              >
                                <Icon name="edit" size={16} /> Edit details
                              </button>
                            ) : null}
                          </>
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
                          <Icon name="download" size={16} /> Download selected
                          CAR
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
                    busy={busy}
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
                            onClick={() =>
                              setHistoryReload((value) => value + 1)
                            }
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
                                {revision.revision === latest
                                  ? " · Latest"
                                  : ""}
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
                      {history &&
                      viewing.revision !== current.currentRevision ? (
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
      {current && (
        <AccessDialog
          open={accessOpen}
          kind="publication"
          id={current.id}
          item={current}
          {...(viewing ? { revision: viewing.revision } : {})}
          onClose={() => setAccessOpen(false)}
          onSaved={(item) => {
            setHistory((previous) =>
              previous
                ? { ...previous, publication: item }
                : {
                    publication: item,
                    revisions: [item.current],
                    operations: [],
                  },
            );
            void onChanged();
          }}
        />
      )}
    </>
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
  const [owned, setOwned] = useState<Publication | null>(null);
  const [accessOpen, setAccessOpen] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setHistory(null);
    setOwned(null);
    setError("");
    setNotice("");
    setAccessOpen(false);
    void requestJson<Publication>(
      `/api/publications/${encodeURIComponent(id)}`,
      { signal: controller.signal },
    )
      .then((item) => {
        if (!controller.signal.aborted) setOwned(item);
      })
      .catch((failure: unknown) => {
        if (
          controller.signal.aborted ||
          (failure instanceof ApiRequestError &&
            (failure.status === 401 || failure.status === 404))
        )
          return;
        setError(
          `Could not check ownership. ${failure instanceof Error ? failure.message : String(failure)}`,
        );
      });
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
    <>
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
          <p role="alert">
            Content unavailable.{" "}
            <a href="/">Sign in to check access or switch accounts</a>. Signing
            in does not guarantee permission.
          </p>
        ) : !history ? (
          <p role="status">Loading publication...</p>
        ) : null}
        {publication && actual ? (
          <>
            <DetailHeading
              name={publication.title}
              cid={actual.cid}
              contentType={null}
              disabled={false}
              visibility={publication.visibility}
              {...(owned ? { onAccess: () => setAccessOpen(true) } : {})}
              publication={{ id, revision: actual.revision }}
              onCopy={(text) => void copy(text)}
              badge={<span>v{actual.revision}</span>}
            />
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
      {owned && (
        <AccessDialog
          open={accessOpen}
          kind="publication"
          id={id}
          item={owned}
          {...(actual ? { revision: actual.revision } : {})}
          onClose={() => setAccessOpen(false)}
          onSaved={(item) => {
            setOwned(item);
            setHistory((before) =>
              before ? { ...before, publication: item } : before,
            );
          }}
        />
      )}
    </>
  );
}
