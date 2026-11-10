import {
  createContext,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Icon } from "./icon.js";

export const DialogPanelContext = createContext<HTMLDialogElement | null>(null);

export function Dialog({
  open,
  title,
  busy = false,
  dismissOnOutsideClick = false,
  showClose = true,
  glyphClose = false,
  className = "",
  returnFocusKey,
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
  returnFocusKey?: string | undefined;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [panel, setPanel] = useState<HTMLDialogElement | null>(null);
  const attachPanel = useCallback((element: HTMLDialogElement | null) => {
    ref.current = element;
    setPanel(element);
  }, []);
  const opener = useRef<HTMLElement | null>(null);
  const openerKey = useRef<string | null>(null);
  if (returnFocusKey) openerKey.current = returnFocusKey;
  const outsidePress = useRef(false);
  const hasDrawer = useCallback(
    () => !!ref.current?.querySelector(":scope > .detail-drawer-layer"),
    [],
  );
  useEffect(() => {
    outsidePress.current = false;
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      opener.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      openerKey.current =
        returnFocusKey ??
        opener.current?.getAttribute("data-detail-key") ??
        null;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
      requestAnimationFrame(() => {
        if (document.querySelector("dialog[open]")) {
          if (
            opener.current?.isConnected &&
            opener.current.closest("dialog[open]")
          )
            opener.current.focus();
          return;
        }
        if (openerKey.current)
          document
            .querySelector<HTMLElement>(
              `[data-detail-key="${CSS.escape(openerKey.current)}"]`,
            )
            ?.focus();
        else if (opener.current?.isConnected) opener.current.focus();
      });
    }
  }, [open, returnFocusKey]);
  useEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return;
    if (busy && !dialog.contains(document.activeElement)) dialog.focus();
    const escapeOutside = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (
        Array.from(document.querySelectorAll("dialog[open]")).at(-1) !== dialog
      )
        return;
      if (event.key === "Tab") {
        const controls = Array.from(
          dialog.querySelectorAll<HTMLElement>(
            "a[href], button, input, select, textarea, summary, [tabindex]",
          ),
        ).filter(
          (element) =>
            element.tabIndex >= 0 &&
            !element.matches(":disabled") &&
            !element.closest("[inert]") &&
            element.getClientRects().length > 0,
        );
        const first = controls[0];
        const last = controls.at(-1);
        if (
          !first ||
          !dialog.contains(document.activeElement) ||
          (event.shiftKey && document.activeElement === first) ||
          (!event.shiftKey && document.activeElement === last)
        ) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
          if (!first) dialog.focus();
        }
      }
      if (
        event.key === "Escape" &&
        event.target instanceof Node &&
        !dialog.contains(event.target)
      ) {
        event.preventDefault();
        if (!busy && !hasDrawer()) onClose();
      }
    };
    document.addEventListener("keydown", escapeOutside);
    return () => document.removeEventListener("keydown", escapeOutside);
  }, [open, busy, onClose, hasDrawer]);
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
      ref={attachPanel}
      className={`canvas-dialog${className ? ` ${className}` : ""}`}
      aria-label={title}
      aria-busy={busy}
      closedby="none"
      tabIndex={-1}
      onPointerDown={(event) => {
        outsidePress.current =
          dismissOnOutsideClick &&
          !busy &&
          !hasDrawer() &&
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
          if (!busy && !hasDrawer()) onClose();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy && !hasDrawer()) onClose();
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
      <DialogPanelContext.Provider value={panel}>
        {children}
      </DialogPanelContext.Provider>
    </dialog>
  );
}
