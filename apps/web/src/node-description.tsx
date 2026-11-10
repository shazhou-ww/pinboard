import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ContentPreview,
  NodeDescription,
} from "@shazhou/pinboard-contracts";
import { DescriptionClient } from "./description-client.js";
import { PreviewContent, previewClassName } from "./pin-preview.js";
import { previewPollDelay } from "./preview-poll.js";
import { Icon } from "./icon.js";

type EditorProps = {
  rootCid: string;
  publicationId?: string | undefined;
  revision?: number | undefined;
  client?: DescriptionClient | undefined;
  onChanged?: (() => Promise<void>) | undefined;
  readingFirst?: boolean;
  name?: string;
  facts?: React.ReactNode;
  sidebar?: React.ReactNode;
  heading?: (
    contentType: string | null,
    editor: {
      editing: boolean;
      busy: boolean;
      ready: boolean;
      start: () => void;
    },
  ) => React.ReactNode;
  onRename?: ((name: string) => Promise<void>) | undefined;
  actions?: React.ReactNode;
  onDirtyChange?: ((dirty: boolean) => void) | undefined;
  onBusyChange?: ((busy: boolean) => void) | undefined;
};

export function NodeDescriptionEditor(props: EditorProps) {
  const client = useMemo(
    () => props.client ?? new DescriptionClient(),
    [props.client],
  );
  useEffect(
    () => (props.client ? undefined : client.attach()),
    [client, props.client],
  );
  return (
    <DescriptionEditor
      {...props}
      client={client}
      key={JSON.stringify([
        client.identity,
        props.rootCid,
        props.publicationId,
        props.revision,
      ])}
    />
  );
}

function DescriptionEditor({
  rootCid,
  publicationId,
  revision,
  onChanged,
  readingFirst = false,
  name,
  facts,
  sidebar,
  heading,
  actions,
  onDirtyChange,
  onBusyChange,
  onRename,
  client,
}: EditorProps & { client: DescriptionClient }) {
  const [node, setNode] = useState(rootCid);
  const [selectedNode, setSelectedNode] = useState(rootCid);
  const context = useMemo(
    () => ({ rootCid, nodeCid: selectedNode, publicationId, revision }),
    [rootCid, selectedNode, publicationId, revision],
  );
  const [snapshot, setSnapshot] = useState(() => ({
    context,
    data: client.cached(context),
  }));
  const data =
    snapshot.context === context ? snapshot.data : client.cached(context);
  const [fallback, setFallback] = useState<{
    context: typeof context;
    preview: ContentPreview;
  } | null>(null);
  const preview =
    data?.description.preview ??
    (fallback?.context === context ? fallback.preview : null);
  const [text, setText] = useState(data?.description.user.text ?? "");
  const [draft, setDraft] = useState({
    text: text,
    version: data?.description.user.version ?? 0,
  });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(name ?? "");
  const [originalName, setOriginalName] = useState(name ?? "");
  const editTrigger = useRef<HTMLElement | null>(null);
  const unified = readingFirst && !publicationId && !!onRename;
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const dirty =
    editing && (text !== draft.text || (unified && draftName !== originalName));
  const startEditing = () => {
    if (!data) return;
    editTrigger.current =
      typeof document !== "undefined" &&
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setDraftName(name ?? "");
    setOriginalName(name ?? "");
    setNotice("");
    setError("");
    setText(data.description.user.text ?? "");
    setDraft({
      text: data.description.user.text ?? "",
      version: data.description.user.version,
    });
    setEditing(true);
  };
  const finishEditing = () => {
    setEditing(false);
    if (typeof requestAnimationFrame !== "undefined")
      requestAnimationFrame(() => editTrigger.current?.focus());
  };
  const cancelEditing = () => {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    setText(data?.description.user.text ?? "");
    setDraftName(name ?? "");
    setError("");
    finishEditing();
  };
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  useEffect(() => {
    let active = true;
    let received = false;
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    setError("");
    setNotice("");
    const unsubscribe = client.subscribe(context, (value, failure) => {
      if (!active) return;
      received = true;
      setError(failure);
      if (value === undefined) return;
      clearTimeout(timer);
      setSnapshot({ context, data: value });
      setFallback(null);
      if (!editingRef.current) setText(value?.description.user.text ?? "");
      if (value) {
        const delay = previewPollDelay(value.description.preview, ++attempts);
        if (delay !== undefined)
          timer = setTimeout(() => {
            void load();
          }, delay);
      }
    });
    if (!client.cached(context) && client.canUsePreview(context))
      void client.previews?.cached(selectedNode).then((cached) => {
        if (active && !received && cached && client.canUsePreview(context))
          setFallback({ context, preview: cached.preview });
      });
    const load = async () => {
      try {
        await client.request(context);
      } catch {
        // The shared client notifies all current readers, including errors.
      }
    };
    void load();
    return () => {
      active = false;
      unsubscribe();
      clearTimeout(timer);
    };
  }, [client, context, reload]);
  const save = async (value: string | null) => {
    if (!data) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await client.save(context, value, draft.version);
      if (!next) return;
      setText(next.description.user.text ?? "");
      setEditing(false);
      setNotice(
        "Saved privately for this root. Published version snapshots are unchanged.",
      );
      await onChanged?.();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const saveDetails = async () => {
    if (!data || !onRename || busy) return;
    const nextName = draftName.trim();
    if (!nextName || nextName.length > 200) {
      setError("Pin names must contain 1-200 characters.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    let descriptionSaved = false;
    let nameSaved = false;
    try {
      if (text !== draft.text) {
        const next = await client.save(context, text || null, draft.version);
        if (!next) throw new Error("Description save was not confirmed.");
        const savedText = next.description.user.text ?? "";
        setText(savedText);
        setDraft({ text: savedText, version: next.description.user.version });
        descriptionSaved = true;
      }
      if (nextName !== originalName) {
        await onRename(nextName);
        setOriginalName(nextName);
        setDraftName(nextName);
        nameSaved = true;
      }
    } catch (failure) {
      setError(
        `${descriptionSaved ? "Description saved. Name was not confirmed; " : "Changes were not confirmed; "}${failure instanceof Error ? failure.message : String(failure)} Your remaining draft is preserved. Retry, or cancel to read the current saved values.`,
      );
      return;
    } finally {
      setBusy(false);
    }
    finishEditing();
    setNotice("Details saved. Published snapshots and content are unchanged.");
    if (descriptionSaved || nameSaved) {
      try {
        await onChanged?.();
      } catch (failure) {
        setError(
          `Details saved, but the content list could not refresh. ${failure instanceof Error ? failure.message : String(failure)}`,
        );
      }
    }
  };
  const errors = (
    <>
      {error ? (
        <div role="alert">
          <p>{error}</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (
                dirty &&
                !window.confirm(
                  "Discard unsaved changes and reload description?",
                )
              )
                return;
              setEditing(false);
              setReload((value) => value + 1);
            }}
          >
            Retry description
          </button>
        </div>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
    </>
  );
  if (readingFirst)
    return (
      <>
        {heading?.(preview?.contentType ?? null, {
          editing,
          busy,
          ready: !!data,
          start: startEditing,
        })}
        <div className="reading-layout" data-mode={editing ? "edit" : "read"}>
          <section className="reading-content" aria-label="Content preview">
            {!heading ? <h4>Content</h4> : null}
            <div className="reading-preview-viewport">
              <div
                className={previewClassName(preview)}
                tabIndex={0}
                role="region"
                aria-label="Scrollable content preview"
                aria-busy={!preview && !error}
              >
                {preview ? (
                  <PreviewContent preview={preview} name={name ?? rootCid} />
                ) : (
                  <p role="status">
                    {error
                      ? "Content preview unavailable."
                      : "Loading content..."}
                  </p>
                )}
              </div>
              {data &&
              ["pending", "failed"].includes(
                data.description.preview.status,
              ) ? (
                <div
                  className="preview-details"
                  tabIndex={0}
                  aria-label="Preview information"
                >
                  <p className="muted" role="status">
                    {data.description.preview.status === "pending"
                      ? "Generating preview..."
                      : "Preview generation failed."}
                  </p>
                  <button
                    type="button"
                    disabled={busy || dirty}
                    onClick={() => setReload((value) => value + 1)}
                  >
                    Retry preview
                  </button>
                </div>
              ) : null}
            </div>
          </section>
          <aside
            className={`reading-sidebar${unified ? " metadata-sidebar" : ""}${unified && editing ? " editing-details" : ""}`}
          >
            {unified && editing ? (
              <form
                className="reading-description-form detail-metadata-form"
                aria-label="Edit details"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveDetails();
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    if (!busy) cancelEditing();
                  }
                }}
              >
                <h4>Edit details</h4>
                <label>
                  Name
                  <input
                    autoFocus
                    required
                    maxLength={200}
                    value={draftName}
                    disabled={busy}
                    onChange={(event) => setDraftName(event.target.value)}
                  />
                </label>
                <label>
                  Private description
                  <textarea
                    rows={5}
                    maxLength={8000}
                    placeholder="Add a note..."
                    value={text}
                    disabled={busy}
                    onChange={(event) => setText(event.target.value)}
                  />
                </label>
                <p className="muted">
                  Only for this Pin. Published snapshots are unchanged.
                </p>
                {errors}
                <div className="actions">
                  <button type="button" disabled={busy} onClick={cancelEditing}>
                    Cancel
                  </button>
                  <button
                    className="primary"
                    disabled={busy || !dirty || !draftName.trim()}
                  >
                    {busy ? "Saving..." : "Save changes"}
                  </button>
                </div>
              </form>
            ) : (
              <>
                <section
                  aria-label={
                    publicationId
                      ? "Published description"
                      : "Private description"
                  }
                >
                  <div className="section-title">
                    <h4>
                      {publicationId
                        ? "Published description"
                        : "Private description"}
                    </h4>
                    {!publicationId &&
                    (!unified || !heading) &&
                    data &&
                    !editing ? (
                      <button
                        type="button"
                        className={
                          heading ? "detail-description-edit" : undefined
                        }
                        aria-label={
                          unified ? "Edit details" : "Edit description"
                        }
                        title={unified ? "Edit details" : "Edit description"}
                        disabled={busy}
                        onClick={startEditing}
                      >
                        {unified ? (
                          "Edit details"
                        ) : heading ? (
                          <Icon name="edit" size={16} />
                        ) : (
                          "Edit description"
                        )}
                      </button>
                    ) : null}
                  </div>
                  {errors}
                  {data ? (
                    editing ? (
                      <form
                        className="reading-description-form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void save(text);
                        }}
                      >
                        <label>
                          User description (optional, plain text)
                          <textarea
                            autoFocus
                            rows={5}
                            maxLength={8000}
                            value={text}
                            disabled={busy}
                            onChange={(event) => setText(event.target.value)}
                          />
                        </label>
                        <p className="muted">
                          Private for this root. Published snapshots and CAR
                          exports are unchanged.
                        </p>
                        <div className="actions">
                          <button disabled={busy}>Save description</button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              setText(data.description.user.text ?? "");
                              setEditing(false);
                            }}
                          >
                            Cancel edit
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              void save(null);
                            }}
                          >
                            Clear description
                          </button>
                        </div>
                      </form>
                    ) : (
                      <p className="node-user-description">
                        {data.description.user.text ||
                          (publicationId
                            ? "No user description in this version."
                            : "No private description.")}
                      </p>
                    )
                  ) : !error ? (
                    <p role="status">Loading description...</p>
                  ) : null}
                  {publicationId ? (
                    <p className="muted">Read-only snapshot of this version.</p>
                  ) : null}
                </section>
                {data ? (
                  <p className="muted">
                    Type: {data.description.preview.contentType ?? "Unknown"}
                  </p>
                ) : null}
                {facts}
                {actions}
                {sidebar}
              </>
            )}
          </aside>
        </div>
      </>
    );
  return (
    <section className="node-description-editor" aria-label="Node description">
      <h4>
        {publicationId ? "Published node description" : "Node description"}
      </h4>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (dirty && !window.confirm("Discard unsaved node changes?")) return;
          setEditing(false);
          if (node.trim() === selectedNode) setReload((value) => value + 1);
          else setSelectedNode(node.trim());
        }}
      >
        <label>
          Node CID (root or reachable child)
          <input
            value={node}
            required
            maxLength={256}
            disabled={busy}
            onChange={(event) => setNode(event.target.value)}
          />
        </label>
        <button disabled={busy}>Read node</button>
      </form>
      {errors}
      {data ? (
        <>
          {publicationId ? (
            <p className="node-user-description">
              {data.description.user.text ??
                "No user description in this version."}
            </p>
          ) : editing ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void save(text);
              }}
            >
              <label>
                User description (optional, plain text)
                <textarea
                  maxLength={8000}
                  value={text}
                  disabled={busy}
                  onChange={(event) => setText(event.target.value)}
                />
              </label>
              <p className="muted">
                Private sidecar metadata until published. CAR downloads do not
                include it. Publishing the current CID is a NOP and does not
                apply description changes.
              </p>
              <button disabled={busy}>Save description</button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void save(null);
                }}
              >
                Clear description
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setText(data.description.user.text ?? "");
                  setEditing(false);
                }}
              >
                Cancel edit
              </button>
            </form>
          ) : (
            <>
              <p className="node-user-description">
                {data.description.user.text || "No private description."}
              </p>
              <button type="button" disabled={busy} onClick={startEditing}>
                Edit description
              </button>
            </>
          )}
          <h4>System preview</h4>
          <div className={previewClassName(data.description.preview)}>
            <PreviewContent
              preview={data.description.preview}
              name={selectedNode}
            />
          </div>
        </>
      ) : !error ? (
        <p role="status">Loading node description...</p>
      ) : null}
    </section>
  );
}
