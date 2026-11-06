import type {
  BootstrapResponse,
  SessionResponse,
} from "@shazhou/pinboard-contracts";
import { signIn, signOut } from "@hono/auth-js/react";
import { useEffect, useState, type MouseEvent } from "react";

import { Dashboard, SharePage, type DashboardState } from "./ui.js";
import { OAuthConsent } from "./oauth.js";
import { apiFetch, leavePreviewMode } from "./api.js";
import { PublicationPage } from "./publications.js";

export function App() {
  if (location.pathname === "/connect/mcp") return <OAuthConsent />;
  const publication = /^\/p\/([^/]+)(?:\/v\/([1-9]\d*)|\/history)?$/.exec(
    location.pathname,
  );
  if (publication?.[1])
    return (
      <PublicationPage
        id={publication[1]}
        {...(publication[2] ? { revision: Number(publication[2]) } : {})}
      />
    );
  const shared = /^\/share\/([^/]+)$/.exec(location.pathname);
  return shared?.[1] ? <SharePage cid={shared[1]} /> : <Home />;
}

function Home() {
  const [state, setState] = useState<DashboardState>({ kind: "loading" });
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  function showAuthError(error: unknown) {
    setState({
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  function handleSignIn(event: MouseEvent<HTMLButtonElement>) {
    const provider = event.currentTarget.value;
    setSigningIn(provider);
    void signIn(provider, { callbackUrl: "/" })
      .catch(showAuthError)
      .finally(() => setSigningIn(null));
  }

  function handleSignOut() {
    setSigningOut(true);
    void (async () => {
      if (await leavePreviewMode()) {
        location.assign("/");
        return;
      }
      await signOut({ callbackUrl: "/" });
    })()
      .catch(showAuthError)
      .finally(() => setSigningOut(false));
  }

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

  return (
    <Dashboard
      state={state}
      onSignIn={handleSignIn}
      signingIn={signingIn}
      onSignOut={handleSignOut}
      signingOut={signingOut}
    />
  );
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
  const response = await apiFetch(path, {
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
