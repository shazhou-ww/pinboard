import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ContentPreview,
  Pin,
  PreviewImage,
} from "@shazhou/pinboard-contracts";
import { PreviewClient, PreviewRequestError } from "./preview-client.js";
import { Icon } from "./icon.js";
import { previewPollDelay } from "./preview-poll.js";

export function TypeCover({ contentType }: { contentType: string | null }) {
  const [icon, label] =
    contentType === "application/pdf"
      ? (["pdf", "PDF"] as const)
      : contentType === "inode/directory"
        ? (["folder", "Folder"] as const)
        : contentType?.startsWith("image/")
          ? (["image", "Image"] as const)
          : contentType?.startsWith("video/") ||
              contentType === "application/mp4"
            ? (["video", "Video"] as const)
            : contentType?.startsWith("audio/")
              ? (["audio", "Audio"] as const)
              : contentType?.startsWith("text/")
                ? (["file", "Text"] as const)
                : contentType
                  ? (["file", "File"] as const)
                  : (["unknown", "Content"] as const);
  return (
    <div className="preview-type-cover" aria-label={`${label} preview`}>
      <Icon name={icon} size={48} weight="duotone" />
      <span>{label}</span>
    </div>
  );
}

export function previewClassName(preview: ContentPreview | null): string {
  return `pin-preview${preview?.preview?.kind === "image" ? " has-image" : ""}${preview?.preview?.kind === "image" && preview.contentType === "application/pdf" ? " has-paper" : ""}`;
}

function Thumbnail({
  image,
  name,
  contentType,
}: {
  image: PreviewImage;
  name: string;
  contentType: string | null;
}) {
  const [failed, setFailed] = useState(false);
  const picture = (
    <img
      src={image.url}
      width={image.width}
      height={image.height}
      alt={name}
      loading="lazy"
      hidden={failed}
      onError={() => {
        setFailed(true);
      }}
      onLoad={() => {
        setFailed(false);
      }}
    />
  );
  return (
    <>
      {failed ? <TypeCover contentType={contentType} /> : null}
      {contentType === "application/pdf" ? (
        <div className="preview-paper" hidden={failed}>
          <span className="preview-type-badge" aria-label="PDF document">
            <Icon name="pdf" size={16} />
            PDF
          </span>
          <div className="preview-paper-sheet">{picture}</div>
        </div>
      ) : (
        picture
      )}
    </>
  );
}

export function PreviewContent({
  preview,
  name,
}: {
  preview: ContentPreview;
  name: string;
}) {
  const material = preview.preview;
  if (!material) return <TypeCover contentType={preview.contentType} />;
  switch (material.kind) {
    case "image":
      return (
        <Thumbnail
          key={`${material.image.cid}:${material.image.url}`}
          image={material.image}
          name={name}
          contentType={preview.contentType}
        />
      );
    case "text":
      return <div className="preview-text">{material.text}</div>;
    case "markdown": {
      const fence = /^(`{3,})\n/u.exec(material.text);
      return fence ? (
        <pre className="preview-code">
          <code>
            {material.text.slice(fence[0].length, -(fence[1]!.length + 1))}
          </code>
        </pre>
      ) : (
        <div className="preview-text">
          {material.text.replace(/\\([\\`*_{}[\]()#+.!>|~-])/gu, "$1")}
        </div>
      );
    }
    case "directory":
      return (
        <div className="preview-directory">
          <div className="preview-folder-heading">
            <Icon
              name="folder"
              className="preview-entry-icon"
              data-kind="directory"
            />
            <span className="preview-entry-name" title={name}>
              {name}
            </span>
            {material.total === undefined ? (
              ""
            ) : (
              <span className="preview-folder-count">
                {material.total} top-level{" "}
                {material.total === 1 ? "entry" : "entries"}
              </span>
            )}
          </div>
          {material.entries.length ? (
            <ul aria-label="Folder contents">
              {material.entries.map((entry, index) => (
                <li key={index} data-depth={entry.depth} data-kind={entry.kind}>
                  <Icon
                    name={
                      entry.kind === "directory"
                        ? "folder"
                        : entry.kind === "file"
                          ? "file"
                          : "unknown"
                    }
                    className="preview-entry-icon"
                    data-kind={entry.kind}
                    role="img"
                    aria-hidden={false}
                    aria-label={
                      entry.kind === "directory"
                        ? "Folder"
                        : entry.kind === "file"
                          ? "File"
                          : "Unknown item"
                    }
                  />
                  <span className="preview-entry-name" title={entry.name}>
                    {entry.name}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="preview-folder-empty">
              {material.total === 0 && !preview.truncated
                ? "Empty folder"
                : "No entries in this preview"}
            </p>
          )}
        </div>
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
        const delay = previewPollDelay(next, ++requests);
        if (delay !== undefined)
          timer = setTimeout(() => {
            void load();
          }, delay);
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
    <div ref={ref} className={previewClassName(preview)}>
      {preview ? (
        <PreviewContent preview={preview} name={pin.name} />
      ) : error ? (
        <p className="muted" role="status">
          {error}
        </p>
      ) : (
        <TypeCover contentType={null} />
      )}
      {preview && error ? (
        <p className="muted" role="status">
          {error}
        </p>
      ) : null}
    </div>
  );
}
