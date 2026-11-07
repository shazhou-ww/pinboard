import { useEffect, useState } from "react";
import type { NodeDescription } from "@shazhou/pinboard-contracts";
import { requestJson } from "./manager.js";
import { PreviewContent } from "./pin-preview.js";
import { previewPollDelay } from "./preview-poll.js";

export function NodeDescriptionEditor({
  rootCid,
  publicationId,
  revision,
  onChanged,
}: {
  rootCid: string;
  publicationId?: string;
  revision?: number;
  onChanged?: () => Promise<void>;
}) {
  const [node, setNode] = useState(rootCid);
  const [selectedNode, setSelectedNode] = useState(rootCid);
  const [data, setData] = useState<NodeDescription | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
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
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
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
      setData(next);
      setText(next.description.user.text ?? "");
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
  return (
    <section className="node-description-editor" aria-label="Node description">
      <h4>
        {publicationId ? "Published node description" : "Node description"}
      </h4>
      <form
        onSubmit={(event) => {
          event.preventDefault();
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
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {data ? (
        <>
          {publicationId ? (
            <p className="node-user-description">
              {data.description.user.text ??
                "No user description in this version."}
            </p>
          ) : (
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
            </form>
          )}
          <h4>System preview</h4>
          <div className="pin-preview">
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
