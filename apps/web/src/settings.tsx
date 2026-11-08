import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Dialog } from "./dialog.js";

export const settingsCategories = [
  "Browser preferences",
  "Access tokens",
  "OAuth authorizations",
  "Recently deleted",
] as const;
export type SettingsCategory = (typeof settingsCategories)[number];

export function settingsTabTarget(
  key: string,
  current: number,
  horizontal: boolean,
): number | null {
  if (key === "Home") return 0;
  if (key === "End") return settingsCategories.length - 1;
  if (key === (horizontal ? "ArrowRight" : "ArrowDown"))
    return (current + 1) % settingsCategories.length;
  if (key === (horizontal ? "ArrowLeft" : "ArrowUp"))
    return (
      (current + settingsCategories.length - 1) % settingsCategories.length
    );
  return null;
}

export function SettingsDialog({
  open,
  busy,
  category,
  onCategory,
  onClose,
  secretPending,
  error,
  panels,
}: {
  open: boolean;
  busy: boolean;
  category: SettingsCategory;
  onCategory: (category: SettingsCategory) => void;
  onClose: () => void;
  secretPending: boolean;
  error: string;
  panels: Record<SettingsCategory, ReactNode>;
}) {
  const id = useId();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const [horizontal, setHorizontal] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 640px)");
    const update = () => setHorizontal(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return (
    <Dialog
      open={open}
      title="Settings"
      busy={busy}
      onClose={onClose}
      dismissOnOutsideClick
      showClose={false}
      className="settings-dialog"
    >
      <div className="settings-layout">
        <div
          role="tablist"
          aria-label="Settings categories"
          aria-orientation={horizontal ? "horizontal" : "vertical"}
          className="settings-nav"
        >
          {settingsCategories.map((name, index) => (
            <button
              key={name}
              ref={(element) => {
                tabs.current[index] = element;
              }}
              type="button"
              role="tab"
              id={`${id}-tab-${index}`}
              aria-controls={`${id}-panel-${index}`}
              aria-selected={category === name}
              tabIndex={category === name ? 0 : -1}
              onClick={() => onCategory(name)}
              onKeyDown={(event) => {
                const target = settingsTabTarget(event.key, index, horizontal);
                if (target === null) return;
                event.preventDefault();
                onCategory(settingsCategories[target]!);
                tabs.current[target]?.focus();
                tabs.current[target]?.scrollIntoView({
                  block: "nearest",
                  inline: "nearest",
                });
              }}
            >
              {name}
            </button>
          ))}
        </div>
        <div className="settings-detail">
          {error && (
            <p role="alert" className="notice">
              {error}
            </p>
          )}
          {busy && (
            <p role="status">
              An operation is in progress. Settings cannot close yet.
            </p>
          )}
          {secretPending && category !== "Access tokens" && (
            <p role="status" className="settings-secret-reminder">
              A new token is still shown only once.{" "}
              <button type="button" onClick={() => onCategory("Access tokens")}>
                Return to copy token
              </button>
            </p>
          )}
          {settingsCategories.map((name, index) => (
            <div
              key={name}
              role="tabpanel"
              id={`${id}-panel-${index}`}
              aria-labelledby={`${id}-tab-${index}`}
              hidden={category !== name}
              tabIndex={0}
            >
              {panels[name]}
            </div>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
