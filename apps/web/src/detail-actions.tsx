import { useEffect, useRef, type ReactNode } from "react";

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
      <summary>{label}</summary>
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
