import { useEffect, useRef, useState } from "react";
import type { Pin } from "@shazhou/pinboard-contracts";

export function PinPreview({ pin }: { pin: Pin }) {
  const ref = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState("");
  const candidate = /\.(png|jpe?g|gif|webp)$/iu.test(pin.name);
  useEffect(() => {
    setUrl("");
    setStatus("");
    if (!candidate) return;
    const controller = new AbortController();
    let objectUrl = "";
    let started = false;
    const load = async () => {
      if (started) return;
      started = true;
      setStatus("Loading preview...");
      try {
        const { canPreview, loadImage } = await import("./preview.js");
        if (controller.signal.aborted) return;
        if (!canPreview(pin.name, pin.size)) {
          setStatus("Image exceeds the 8 MiB preview limit.");
          return;
        }
        const image = await loadImage(pin.cid, controller.signal);
        if (controller.signal.aborted) return;
        if (!image) {
          setStatus("This content cannot be previewed as an image.");
          return;
        }
        objectUrl = URL.createObjectURL(image);
        setUrl(objectUrl);
        setStatus("");
      } catch (failure) {
        if (!controller.signal.aborted)
          setStatus(
            failure instanceof Error ? failure.message : String(failure),
          );
      }
    };
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        void load();
      }
    });
    if (ref.current) observer.observe(ref.current);
    return () => {
      observer.disconnect();
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [candidate, pin.cid, pin.name, pin.size]);
  return (
    <div ref={ref} className={`pin-preview${url ? " has-image" : ""}`}>
      {url ? (
        <img
          src={url}
          alt={pin.name}
          loading="lazy"
          onError={() => {
            setUrl("");
            setStatus("Unable to display this image.");
          }}
        />
      ) : (
        <span className="muted">{candidate ? "Image" : "Pinned content"}</span>
      )}
      {status ? (
        <p role="status" className="muted">
          {status}
        </p>
      ) : null}
    </div>
  );
}
