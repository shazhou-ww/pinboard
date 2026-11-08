import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "./icon.js";

export function Dialog({
  open,
  title,
  busy = false,
  dismissOnOutsideClick = false,
  showClose = true,
  glyphClose = false,
  className = "",
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  busy?: boolean;
  dismissOnOutsideClick?: boolean;
  showClose?: boolean;
  glyphClose?: boolean;
  className?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const outsidePress = useRef(false);
  useEffect(() => {
    outsidePress.current = false;
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);
  const isOutside = (event: {
    currentTarget: HTMLDialogElement;
    clientX: number;
    clientY: number;
  }) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    );
  };
  return (
    <dialog
      ref={ref}
      className={`canvas-dialog${className ? ` ${className}` : ""}`}
      aria-label={title}
      aria-busy={busy}
      onPointerDown={(event) => {
        outsidePress.current =
          dismissOnOutsideClick &&
          !busy &&
          event.button === 0 &&
          event.target === event.currentTarget &&
          isOutside(event);
      }}
      onPointerCancel={() => {
        outsidePress.current = false;
      }}
      onClick={(event) => {
        const dismiss =
          outsidePress.current &&
          !busy &&
          event.target === event.currentTarget &&
          isOutside(event);
        outsidePress.current = false;
        if (dismiss) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          if (!busy) onClose();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="section-title">
        <h2>{title}</h2>
        {showClose && (
          <button
            type="button"
            aria-label={`Close ${title}`}
            title={`Close ${title}`}
            className={glyphClose ? "glyph-button" : undefined}
            disabled={busy}
            onClick={onClose}
          >
            {glyphClose ? <Icon name="close" /> : "Close"}
          </button>
        )}
      </div>
      {children}
    </dialog>
  );
}
