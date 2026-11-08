import { useEffect, useState } from "react";
import type { NodeDescription } from "@shazhou/pinboard-contracts";
import { isContentPreview } from "@shazhou/pinboard-contracts";
import { ApiRequestError, previewEnabled } from "./api.js";
import { requestJson } from "./manager.js";
import { PreviewContent, previewClassName } from "./pin-preview.js";
import { previewPollDelay } from "./preview-poll.js";

export function NodeDescriptionEditor({
  rootCid,
  publicationId,
  revision,
  onChanged,
  readingFirst = false,
  name,
  facts,
  sidebar,
  onDirtyChange,
  onBusyChange,
}: {
  rootCid: string;
  publicationId?: string | undefined;
  revision?: number | undefined;
  onChanged?: (() => Promise<void>) | undefined;
  readingFirst?: boolean;
  name?: string;
  facts?: React.ReactNode;
  sidebar?: React.ReactNode;
  onDirtyChange?: ((dirty: boolean) => void) | undefined;
  onBusyChange?: ((busy: boolean) => void) | undefined;
}) {
  const [node, setNode] = useState(rootCid);
  const [selectedNode, setSelectedNode] = useState(rootCid);
  const [data, setData] = useState<NodeDescription | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [advancedDirty, setAdvancedDirty] = useState(false);
  const [advancedBusy, setAdvancedBusy] = useState(false);
  const dirty = editing && text !== (data?.description.user.text ?? "");
  useEffect(() => {
    if (!dirty && !advancedDirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, advancedDirty]);
  useEffect(() => {
    onDirtyChange?.(dirty || advancedDirty);
    return () => onDirtyChange?.(false);
  }, [dirty, advancedDirty, onDirtyChange]);
  useEffect(() => {
    onBusyChange?.(busy || advancedBusy);
    return () => onBusyChange?.(false);
  }, [busy, advancedBusy, onBusyChange]);
  const path = publicationId
    ? `/api/public/publications/${publicationId}/versions/${revision}/nodes/${selectedNode}/description`
    : `/api/pins/${rootCid}/nodes/${selectedNode}/description`;
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    let first = true;
    setData(null);
    setError("");
    setNotice("");
    const load = async () => {
      try {
        const value = await requestJson<NodeDescription>(path, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (!isContentPreview(value?.description?.preview, previewEnabled)) {
          setData(null);
          throw new Error("Invalid node preview response");
        }
        setError("");
        if (first) {
          setData(value);
          setText(value.description.user.text ?? "");
          first = false;
        } else {
          setData((current) =>
            current
              ? {
                  ...current,
                  description: {
                    ...current.description,
                    preview: value.description.preview,
                  },
                }
              : value,
          );
        }
        const delay = previewPollDelay(value.description.preview, ++attempts);
        if (delay !== undefined)
          timer = setTimeout(() => {
            void load();
          }, delay);
      } catch (failure) {
        if (!controller.signal.aborted) {
          if (
            (failure instanceof ApiRequestError &&
              [401, 403, 404].includes(failure.status)) ||
            failure instanceof SyntaxError
          )
            setData(null);
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
  }, [path, reload]);
  const save = async (value: string | null) => {
    if (!data) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await requestJson<NodeDescription>(path, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: value,
          expectedVersion: data.description.user.version,
        }),
      });
      if (!isContentPreview(next?.description?.preview, previewEnabled)) {
        setData(null);
        throw new Error("Invalid node preview response");
      }
      setData(next);
      setText(next.description.user.text ?? "");
      setEditing(false);
      setNotice(
        "Saved privately for this root. Published version snapshots are unchanged.",
      );
      await onChanged?.();
    } catch (failure) {
      if (
        failure instanceof ApiRequestError &&
        [401, 403, 404].includes(failure.status)
      )
        setData(null);
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
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
        <div className="reading-layout">
          <section className="reading-content" aria-label="Content preview">
            <h4>Content</h4>
            <div className="reading-preview-viewport">
              <div
                className={previewClassName(data?.description.preview ?? null)}
                tabIndex={0}
                role="region"
                aria-label="Scrollable content preview"
                aria-busy={!data && !error}
              >
                {data ? (
                  <PreviewContent
                    preview={data.description.preview}
                    name={name ?? rootCid}
                  />
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
                    disabled={busy || dirty || advancedBusy || advancedDirty}
                    onClick={() => setReload((value) => value + 1)}
                  >
                    Retry preview
                  </button>
                </div>
              ) : null}
            </div>
          </section>
          <aside className="reading-sidebar">
            <section
              aria-label={
                publicationId ? "Published description" : "Private description"
              }
            >
              <div className="section-title">
                <h4>
                  {publicationId
                    ? "Published description"
                    : "Private description"}
                </h4>
                {!publicationId && data && !editing ? (
                  <button
                    type="button"
                    disabled={busy || advancedDirty || advancedBusy}
                    onClick={() => setEditing(true)}
                  >
                    Edit description
                  </button>
                ) : null}
              </div>
              {errors}
              {data ? (
                editing ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void save(text);
                    }}
                  >
                    <label>
                      User description (optional, plain text)
                      <textarea
                        autoFocus
                        maxLength={8000}
                        value={text}
                        disabled={busy}
                        onChange={(event) => setText(event.target.value)}
                      />
                    </label>
                    <p className="muted">
                      Private for this root. Published snapshots and CAR exports
                      are unchanged.
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
            {sidebar}
          </aside>
        </div>
        <details
          className="detail-advanced"
          onToggle={(event) => setAdvanced(event.currentTarget.open)}
        >
          <summary
            onClick={(event) => {
              if (!advanced && (busy || dirty)) {
                event.preventDefault();
                return;
              }
              if (
                advanced &&
                (advancedBusy ||
                  (advancedDirty &&
                    !window.confirm("Discard unsaved node changes?")))
              )
                event.preventDefault();
            }}
          >
            Advanced information and node query
          </summary>
          <code className="cid">{rootCid}</code>
          {advanced ? (
            <NodeDescriptionEditor
              rootCid={rootCid}
              publicationId={publicationId}
              revision={revision}
              onChanged={async () => {
                await onChanged?.();
                setReload((value) => value + 1);
              }}
              onDirtyChange={setAdvancedDirty}
              onBusyChange={setAdvancedBusy}
            />
          ) : null}
        </details>
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
              <button
                type="button"
                disabled={busy}
                onClick={() => setEditing(true)}
              >
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
