import type { BootstrapResponse, SessionResponse } from "@workspace/contracts";
import type { MouseEventHandler } from "react";
import { AccountManager } from "./manager.js";

export type DashboardState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly bootstrap: BootstrapResponse;
      readonly session: SessionResponse | null;
    };

export function Dashboard({
  state,
  onSignIn,
  signingIn = null,
}: {
  readonly state: DashboardState;
  readonly onSignIn?: MouseEventHandler<HTMLButtonElement>;
  readonly signingIn?: string | null;
}) {
  return (
    <main className="shell">
      <header className="masthead">
        <a className="brand" href="/" aria-label="Pinboard home">
          <span className="brand-mark" aria-hidden="true" />
          Pinboard
        </a>
        {state.kind === "ready" && state.session?.user ? (
          <a href="/api/auth/signout">Sign out</a>
        ) : (
          <span>Small by design.</span>
        )}
      </header>
      <section className="intro">
        <p className="eyebrow">A quiet home for content-addressed things</p>
        <h1>
          Pin blocks.
          <br />
          <em>Share by CID.</em>
        </h1>
        <p>
          Save a file or a complete IPFS DAG. Keep the CID.
          <br />
          No feeds. No folders to organize. Just what you pin.
        </p>
      </section>
      {state.kind === "loading" ? (
        <p role="status">Checking your session...</p>
      ) : state.kind === "error" ? (
        <div className="notice" role="alert">
          <p>{state.message}</p>
          <a href="/">Try again</a>
        </div>
      ) : state.session?.user ? (
        <>
          <p className="identity">
            Signed in as{" "}
            {state.session.user.name ??
              state.session.user.email ??
              "Google account"}
          </p>
          <AccountManager />
        </>
      ) : (
        <section className="panel signin">
          <h2>Keep something worth keeping.</h2>
          <p>
            Sign in to upload and manage your pins. Reading by CID is always
            public.
          </p>
          {state.bootstrap.providers.length ? (
            <div className="actions" role="group" aria-label="Sign-in options">
              {state.bootstrap.providers.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  className="primary"
                  value={provider.id}
                  onClick={onSignIn}
                  disabled={signingIn !== null}
                  aria-busy={signingIn === provider.id}
                >
                  {signingIn === provider.id
                    ? `Connecting to ${provider.label}...`
                    : `Continue with ${provider.label}`}
                  <span aria-hidden="true">↗</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="muted">
              Google sign-in is not configured. Set Google credentials in{" "}
              <code>.dev.vars</code>.
            </p>
          )}
        </section>
      )}
      <footer>
        <span>Content is public. Ownership is private.</span>
        <a href="https://docs.ipfs.tech/concepts/content-addressing/">
          What is a CID? ↗
        </a>
      </footer>
    </main>
  );
}

export function SharePage({ cid }: { readonly cid: string }) {
  const valid = /^[A-Za-z0-9]{10,256}$/.test(cid);
  return (
    <main className="shell">
      <header className="masthead">
        <a className="brand" href="/">
          Pinboard
        </a>
        <span>Shared by CID</span>
      </header>
      <section className="intro">
        <p className="eyebrow">Public content</p>
        <h1>
          A pin, <em>not a platform.</em>
        </h1>
      </section>
      {valid ? (
        <section className="panel">
          <h2>Retrieve this content</h2>
          <code className="cid">{cid}</code>
          <p>
            Download the complete DAG as a CAR archive, or read with a
            configured Kubo client.
          </p>
          <div className="actions">
            <a className="primary" href={`/api/public/${cid}/car`}>
              Download CAR
            </a>
            <a href={`/ipfs/${cid}?format=raw`}>Download root block</a>
          </div>
          <pre>ipfs get {cid}</pre>
          <p className="muted">
            Kubo must use this service as a delegated router with HTTP retrieval
            enabled. This link does not announce content to the public IPFS
            network. Uploaded pages are never rendered here.
          </p>
        </section>
      ) : (
        <p role="alert">Invalid CID link.</p>
      )}
      <footer>
        <a href="/">Pin blocks. Share by CID.</a>
      </footer>
    </main>
  );
}
