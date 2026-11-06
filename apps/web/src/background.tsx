import { useId, useState } from "react";

export const backgroundStorageKey = "pinboard:background";
export const backgroundPalettes = [
  { id: "mist", label: "晨光雾屿 · Mist blue & lavender" },
  { id: "sand", label: "玫瑰沙丘 · Sand & rose" },
  { id: "ice", label: "晴空冰海 · Clear sky blue" },
] as const;
export type BackgroundPalette = (typeof backgroundPalettes)[number]["id"];

function isBackgroundPalette(value: unknown): value is BackgroundPalette {
  return backgroundPalettes.some((palette) => palette.id === value);
}

export function readBackground(): BackgroundPalette {
  const saved = localStorage.getItem(backgroundStorageKey);
  if (saved === null) return "mist";
  if (!isBackgroundPalette(saved)) {
    throw new Error(
      "Unrecognized background preference. Choose a palette in Settings to replace it.",
    );
  }
  return saved;
}

function applyBackground(palette: BackgroundPalette) {
  document.documentElement.dataset.background = palette;
}

export function initializeBackground() {
  try {
    applyBackground(readBackground());
  } catch (failure) {
    console.warn(
      "Could not restore the background preference. Using 晨光雾屿 (Mist blue & lavender).",
      failure,
    );
    applyBackground("mist");
  }
}

export function saveBackground(palette: BackgroundPalette) {
  localStorage.setItem(backgroundStorageKey, palette);
  applyBackground(palette);
}

function currentBackground(): BackgroundPalette {
  const palette =
    typeof document === "undefined"
      ? undefined
      : document.documentElement.dataset.background;
  return isBackgroundPalette(palette) ? palette : "mist";
}

export function BackgroundSettings({
  disabled,
  onError,
}: {
  disabled: boolean;
  onError: (message: string) => void;
}) {
  const name = useId();
  const [selected, setSelected] = useState(currentBackground);
  return (
    <fieldset className="background-options" disabled={disabled}>
      <legend>Background palette</legend>
      <div className="background-choices">
        {backgroundPalettes.map(({ id, label }) => (
          <label className="background-choice" key={id}>
            <span
              className="background-swatch"
              data-background={id}
              aria-hidden="true"
            />
            <input
              type="radio"
              name={name}
              value={id}
              checked={selected === id}
              onChange={() => {
                try {
                  saveBackground(id);
                  setSelected(id);
                } catch {
                  onError(
                    "Could not save the background preference. Try enabling browser storage.",
                  );
                }
              }}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
