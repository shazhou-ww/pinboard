import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ContentPreview,
  Pin,
  PreviewImage,
} from "@shazhou/pinboard-contracts";
import { PreviewClient, PreviewRequestError } from "./preview-client.js";

function Thumbnail({ image, name }: { image: PreviewImage; name: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    <p className="muted" role="status">
      Unable to load thumbnail. The original is available in details.
    </p>
  ) : (
    <img
      src={image.url}
      width={image.width}
      height={image.height}
      alt={name}
      loading="lazy"
      onError={() => {
        setFailed(true);
      }}
    />
  );
}

export function PreviewContent({
  preview,
  name,
}: {
  preview: ContentPreview;
  name: string;
}) {
  if (preview.status !== "ready")
    return (
      <div>
        <p className="muted" role="status">
          {preview.status === "pending"
            ? "Preview pending"
            : preview.status === "failed"
              ? "Preview failed"
              : "Preview unavailable"}
          {preview.reason ? `: ${preview.reason}` : ""}
        </p>
        {preview.contentType === "application/vnd.pinboard.file+json" ? (
          <p className="muted">
            {preview.content.mediaType}
            {preview.content.size === undefined
              ? ""
              : ` (${preview.content.size} bytes)`}
          </p>
        ) : null}
      </div>
    );
  switch (preview.contentType) {
    case "image/webp":
      return (
        <Thumbnail
          key={preview.content.cid}
          image={preview.content}
          name={name}
        />
      );
    case "text/plain":
      return <div className="preview-text">{preview.content}</div>;
    case "text/markdown": {
      const fence = /^(`{3,})\n/u.exec(preview.content);
      return fence ? (
        <pre className="preview-code">
          <code>
            {preview.content.slice(fence[0].length, -(fence[1]!.length + 1))}
          </code>
        </pre>
      ) : (
        <div className="preview-text">
          {preview.content.replace(/\\([\\`*_{}[\]()#+.!>|~-])/gu, "$1")}
        </div>
      );
    }
    case "application/vnd.pinboard.directory+json":
      return (
        <div className="preview-directory">
          <p className="muted">
            Folder overview
            {preview.content.total === undefined
              ? ""
              : ` (${preview.content.total} top-level ${preview.content.total === 1 ? "entry" : "entries"})`}
          </p>
          <ul>
            {preview.content.entries.map((entry, index) => (
              <li
                key={index}
                style={{ paddingInlineStart: `${entry.depth}em` }}
              >
                <span aria-label={entry.kind}>
                  {entry.kind === "directory" ? "▸ " : "· "}
                </span>
                {entry.name}
              </li>
            ))}
          </ul>
        </div>
      );
    case "application/vnd.pinboard.file+json":
      return (
        <p className="muted">
          {preview.content.mediaType ?? "File"} — no content preview
        </p>
      );
  }
}

export function PinPreview({
  pin,
  client,
}: {
  pin: Pin;
  client?: PreviewClient | undefined;
}) {
  const previews = useMemo(() => client ?? new PreviewClient(), [client]);
  useEffect(() => (client ? undefined : previews.attach()), [client, previews]);
  const ref = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<ContentPreview | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setPreview(null);
    setError("");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let started = false;
    let requests = 0;
    const load = async () => {
      try {
        const next = await previews.request(pin.cid);
        if (controller.signal.aborted) return;
        setPreview(next);
        if (next.status === "pending" && ++requests < 24)
          timer = setTimeout(() => {
            void load();
          }, 2000);
      } catch (failure) {
        if (!controller.signal.aborted) {
          if (
            failure instanceof PreviewRequestError &&
            [401, 403, 404].includes(failure.status)
          )
            setPreview(null);
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
        }
      }
    };
    const start = async () => {
      const cached = await previews.cached(pin.cid);
      if (controller.signal.aborted) return;
      if (cached) {
        setPreview(cached.preview);
        if (cached.fresh) return;
      }
      await load();
    };
    const observer = new IntersectionObserver((entries) => {
      if (!started && entries.some((entry) => entry.isIntersecting)) {
        started = true;
        observer.disconnect();
        void start();
      }
    });
    if (ref.current) observer.observe(ref.current);
    return () => {
      observer.disconnect();
      controller.abort();
      clearTimeout(timer);
    };
  }, [pin.cid, previews]);
  return (
    <div
      ref={ref}
      className={`pin-preview${preview?.status === "ready" && preview.contentType === "image/webp" ? " has-image" : ""}`}
    >
      {preview ? (
        <PreviewContent preview={preview} name={pin.name} />
      ) : (
        <p className="muted" role="status">
          {error || "Preview pending"}
        </p>
      )}
      {preview?.truncated ? (
        <span className="preview-truncated">Excerpt / sampled overview</span>
      ) : null}
      {preview && error ? (
        <p className="muted" role="status">
          {error}
        </p>
      ) : null}
    </div>
  );
}
