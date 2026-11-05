import type {
  BootstrapResponse,
  SessionResponse,
  SessionUser,
} from "@shazhou/pinboard-contracts";
import { useRef, type MouseEventHandler } from "react";
import { AccountManager } from "./manager.js";
import { Icon } from "./icon.js";

export type DashboardState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly bootstrap: BootstrapResponse;
      readonly session: SessionResponse | null;
    };

export function HomeHeader({
  user,
  onSettings,
  onSignOut,
  signingOut = false,
  disabled = false,
}: {
  user: SessionUser | null;
  onSettings?: () => void;
  onSignOut?: MouseEventHandler<HTMLButtonElement> | undefined;
  signingOut?: boolean;
  disabled?: boolean;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const name = user?.name?.trim() || user?.email || "Google account";
  return (
    <header
      className="home-header"
      onKeyDown={(event) => {
        if (event.key === "Escape" && menu.current?.matches(":popover-open")) {
          event.preventDefault();
          menu.current.hidePopover();
          trigger.current?.focus();
        }
      }}
    >
      <a className="brand" href="/" aria-label="Pinboard home">
        <Icon name="brand" className="brand-mark" />
        Pinboard
      </a>
      {user ? (
        <>
          <button
            ref={trigger}
            type="button"
            className="account-trigger"
            popoverTarget="account-menu"
            aria-label={`Account options for ${name}`}
            aria-busy={signingOut}
            disabled={disabled || signingOut}
          >
            <span className="account-avatar" aria-hidden="true">
              {Array.from(name)[0]?.toUpperCase()}
            </span>
            <span className="account-name">
              {signingOut ? "Signing out..." : name}
            </span>
            <Icon name="caretDown" />
          </button>
          <div
            ref={menu}
            id="account-menu"
            popover="auto"
            className="account-popover"
            role="group"
            aria-label="Account actions"
          >
            <div className="account-identity">
              <strong>{name}</strong>
              {user.email && user.email !== name ? (
                <span>{user.email}</span>
              ) : null}
            </div>
            <button
              type="button"
              disabled={disabled || signingOut}
              onClick={() => {
                menu.current?.hidePopover();
                onSettings?.();
              }}
            >
              <Icon name="settings" />
              Settings
            </button>
            <button
              type="button"
              onClick={(event) => {
                menu.current?.hidePopover();
                onSignOut?.(event);
              }}
              disabled={disabled || signingOut}
              aria-busy={signingOut}
            >
              <Icon name="signOut" />
              {signingOut ? "Signing out..." : "Sign out"}
            </button>
          </div>
        </>
      ) : (
        <a className="header-signin" href="#signin">
          Sign in
        </a>
      )}
    </header>
  );
}

export function Dashboard({
  state,
  onSignIn,
  signingIn = null,
  onSignOut,
  signingOut = false,
}: {
  readonly state: DashboardState;
  readonly onSignIn?: MouseEventHandler<HTMLButtonElement>;
  readonly signingIn?: string | null;
  readonly onSignOut?: MouseEventHandler<HTMLButtonElement>;
  readonly signingOut?: boolean;
}) {
  const user = state.kind === "ready" ? (state.session?.user ?? null) : null;
  return (
    <main className={`shell home-shell${user ? " canvas-shell" : ""}`}>
      {!user ? <HomeHeader user={null} /> : null}
      {!user ? (
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
      ) : null}
      {state.kind === "loading" ? (
        <p role="status">Checking your session...</p>
      ) : state.kind === "error" ? (
        <div className="notice" role="alert">
          <p>{state.message}</p>
          <a href="/">Try again</a>
        </div>
      ) : user ? (
        <AccountManager
          key={user.id}
          accountId={user.id}
          renderHeader={(onSettings, disabled) => (
            <HomeHeader
              user={user}
              onSettings={onSettings}
              disabled={disabled}
              onSignOut={onSignOut}
              signingOut={signingOut}
            />
          )}
        />
      ) : (
        <section className="panel signin" id="signin" tabIndex={-1}>
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
                  <Icon name="externalLink" />
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
