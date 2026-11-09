import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icon.js";
import type { Visibility } from "@shazhou/pinboard-contracts";

export function detailCopyLinks(
  cid: string,
  name: string,
  origin: string,
  publication?: { id: string; revision: number },
  visibility: Visibility = "public",
) {
  return [
    {
      label:
        visibility === "private"
          ? "Copy personal access link"
          : "Copy HTTP download link",
      value:
        visibility === "private"
          ? `${origin}/share/${cid}`
          : `${origin}/api/public/${cid}/download?name=${encodeURIComponent(name)}`,
    },
    { label: "Copy IPFS link", value: `ipfs://${cid}` },
    ...(publication
      ? [
          {
            label: "Copy follow link",
            value: `${origin}/p/${publication.id}`,
          },
          {
            label: `Copy fixed v${publication.revision} link`,
            value: `${origin}/p/${publication.id}/v/${publication.revision}`,
          },
        ]
      : []),
  ];
}

export function DetailHeading({
  name,
  cid,
  disabled,
  visibility,
  onAccess,
  publication,
  badge,
  onCopy,
}: {
  name: string;
  cid: string;
  contentType: string | null;
  visibility: Visibility;
  onAccess?: () => void;
  disabled: boolean;
  publication?: { id: string; revision: number };
  badge?: ReactNode;
  onCopy: (text: string, onCopied?: () => void) => void;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    setCopied(false);
    clearTimeout(timer.current);
  }, [cid]);
  return (
    <header className="detail-heading">
      <div className="detail-identity">
        <div className="detail-title">
          {onAccess ? (
            <button
              className="detail-access"
              aria-label={`${visibility === "private" ? "Private" : "Public"}. Access and sharing`}
              title="Access and sharing"
              aria-haspopup="dialog"
              disabled={disabled}
              onClick={onAccess}
            >
              <Icon name={visibility === "private" ? "lock" : "globe"} />
            </button>
          ) : (
            <span
              className="detail-access"
              role="img"
              aria-label={visibility === "private" ? "Private" : "Public"}
              title={visibility === "private" ? "Private" : "Public"}
            >
              <Icon name={visibility === "private" ? "lock" : "globe"} />
            </span>
          )}
          <h3>{name}</h3>
          {badge}
        </div>
        <div className="detail-cid-combo">
          <button
            className="detail-cid-copy"
            aria-label="Copy CID"
            title="Copy complete CID"
            disabled={disabled}
            data-copied={copied}
            onClick={() =>
              onCopy(cid, () => {
                setCopied(true);
                clearTimeout(timer.current);
                timer.current = setTimeout(() => setCopied(false), 1800);
              })
            }
          >
            <code>{cid}</code>
            <Icon name={copied ? "check" : "copy"} size={16} />
          </button>
          <DetailMenu label="More copy options">
            {detailCopyLinks(
              cid,
              name,
              typeof location === "undefined" ? "" : location.origin,
              publication,
              visibility,
            ).map((link) => (
              <button
                key={link.label}
                disabled={disabled}
                onClick={() => onCopy(link.value)}
              >
                {link.label}
              </button>
            ))}
          </DetailMenu>
        </div>
      </div>
    </header>
  );
}

export function DetailDrawer({
  onClose,
  children,
}: {
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const drawer = ref.current;
    if (!drawer) return;
    (
      drawer.querySelector<HTMLElement>('[aria-pressed="true"]') ?? drawer
    ).focus();
  }, []);
  return (
    <div className="detail-drawer-layer">
      <button
        className="detail-drawer-backdrop"
        aria-label="Close version history"
        tabIndex={-1}
        onClick={onClose}
      />
      <section
        ref={ref}
        className="detail-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Version history"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
          if (event.key === "Tab") {
            const controls = Array.from(
              ref.current?.querySelectorAll<HTMLButtonElement>(
                "button:not(:disabled)",
              ) ?? [],
            );
            const first = controls[0];
            const last = controls.at(-1);
            if (
              !ref.current?.contains(document.activeElement) ||
              document.activeElement === ref.current ||
              (event.shiftKey && document.activeElement === first) ||
              (!event.shiftKey && document.activeElement === last)
            ) {
              event.preventDefault();
              (event.shiftKey ? last : first)?.focus();
            }
          }
        }}
      >
        <h3>Version history</h3>
        <p className="muted">
          Selecting a version only changes your reading view, not public
          current.
        </p>
        {children}
      </section>
    </div>
  );
}

export function DetailMenu({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (
        ref.current?.open &&
        event.target instanceof Node &&
        !ref.current.contains(event.target)
      )
        ref.current.open = false;
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  const close = () => {
    if (!ref.current) return;
    ref.current.open = false;
    ref.current.querySelector("summary")?.focus();
  };
  return (
    <details
      ref={ref}
      name="reading-detail-actions"
      className="detail-menu"
      onKeyDown={(event) => {
        if (event.key === "Escape" && ref.current?.open) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <summary aria-label={label === "More copy options" ? label : undefined}>
        {label === "More copy options" ? (
          <Icon name="caretDown" size={16} />
        ) : (
          label
        )}
      </summary>
      <div
        className="detail-menu-items"
        role="group"
        aria-label={`${label} actions`}
        onClick={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest("button, a")
          )
            close();
        }}
      >
        {children}
      </div>
    </details>
  );
}

export function discardDetailsDraft(dirty: boolean): boolean {
  return !dirty || window.confirm("Discard unsaved changes?");
}
