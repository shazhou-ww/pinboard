import "@fontsource-variable/instrument-sans";
import "@fontsource-variable/newsreader";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app.js";
import { previewEnabled } from "./api.js";
import "./styles.css";

const root = document.querySelector("#root");

if (!(root instanceof HTMLElement)) {
  throw new Error("Root element #root was not found.");
}

const appRoot = createRoot(root);
function showStartupError(error: unknown) {
  appRoot.render(
    <main className="shell">
      <p className="notice" role="alert">
        {error instanceof Error ? error.message : String(error)}
      </p>
    </main>,
  );
}
async function start() {
  if (import.meta.env.DEV && previewEnabled) {
    const { initializePreview } = await import("./dev-preview.js");
    const dispose = initializePreview(showStartupError);
    import.meta.hot?.dispose(dispose);
  }
  appRoot.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
void start().catch(showStartupError);
