import type { BootstrapResponse, SessionResponse } from "@workspace/contracts";
import { useEffect, useState } from "react";

import { Dashboard, SharePage, type DashboardState } from "./ui.js";

export function App() {
  const shared = /^\/share\/([^/]+)$/.exec(location.pathname);
  return shared?.[1] ? <SharePage cid={shared[1]} /> : <Home />;
}

function Home() {
  const [state, setState] = useState<DashboardState>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();

    void loadDashboard(controller.signal)
      .then(({ bootstrap, session }) => {
        setState({
          kind: "ready",
          bootstrap,
          session,
        });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }

        setState({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      controller.abort();
    };
  }, []);

  return <Dashboard state={state} />;
}

async function loadDashboard(signal: AbortSignal): Promise<{
  readonly bootstrap: BootstrapResponse;
  readonly session: SessionResponse | null;
}> {
  const [bootstrap, session] = await Promise.all([
    fetchJson<BootstrapResponse>("/api/bootstrap", signal),
    fetchJson<SessionResponse | null>("/api/auth/session", signal),
  ]);

  return { bootstrap, session };
}

async function fetchJson<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    headers: {
      accept: "application/json",
    },
    signal,
  });

  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}`);
  }

  return (await response.json()) as T;
}
