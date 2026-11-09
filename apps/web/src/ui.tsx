import type {
  BootstrapResponse,
  SessionResponse,
  SessionUser,
  Visibility,
} from "@shazhou/pinboard-contracts";
import {
  useEffect,
  useState,
  useRef,
  type MouseEventHandler,
  type ReactNode,
} from "react";
import { apiFetch } from "./api.js";
import { AccountManager } from "./manager.js";
import { Icon } from "./icon.js";
import { LoadingReveal } from "./loading.js";
import { DetailHeading } from "./detail-actions.js";

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
  filter,
  showSignIn = true,
}: {
  user: SessionUser | null;
  onSettings?: () => void;
  onSignOut?: MouseEventHandler<HTMLButtonElement> | undefined;
  signingOut?: boolean;
  disabled?: boolean;
  filter?: ReactNode;
  showSignIn?: boolean;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const name = user?.name?.trim() || user?.email || "Google account";
  const image = user?.image?.trim();
  return (
    <header
      className={`home-header${filter ? " has-filter" : ""}`}
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
      {user ? filter : null}
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
              {image ? (
                <img
                  key={image}
                  src={image}
                  alt=""
                  referrerPolicy="no-referrer"
                  onError={(event) => {
                    event.currentTarget.hidden = true;
                    console.warn("Account avatar failed to load.");
                  }}
                />
              ) : null}
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
                trigger.current?.focus();
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
      ) : showSignIn ? (
        <a className="header-signin" href="#signin">
          Sign in
        </a>
      ) : null}
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
  const signedOut = state.kind === "ready" && !user;
  return (
    <main className={`shell home-shell${signedOut ? "" : " canvas-shell"}`}>
      {!user ? <HomeHeader user={null} showSignIn={signedOut} /> : null}
      {user ? (
        <AccountManager
          key={user.id}
          accountId={user.id}
          renderHeader={(onSettings, disabled, filter) => (
            <HomeHeader
              user={user}
              onSettings={onSettings}
              disabled={disabled}
              onSignOut={onSignOut}
              signingOut={signingOut}
              filter={filter}
            />
          )}
        />
      ) : (
        <LoadingReveal
          loading={state.kind === "loading"}
          label="Loading Pinboard..."
          className="canvas"
        >
          {signedOut ? (
            <section className="intro">
              <p className="eyebrow">
                A quiet home for content-addressed things
              </p>
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
          {state.kind === "error" ? (
            <div className="notice" role="alert">
              <p>{state.message}</p>
              <a href="/">Try again</a>
            </div>
          ) : state.kind === "ready" ? (
            <section className="panel signin" id="signin" tabIndex={-1}>
              <h2>Keep something worth keeping.</h2>
              <p>
                Sign in to upload and manage private content. Public links can
                be read by anyone; knowing a CID grants no private access.
              </p>
              {state.bootstrap.providers.length ? (
                <div
                  className="actions"
                  role="group"
                  aria-label="Sign-in options"
                >
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
          ) : null}
        </LoadingReveal>
      )}
    </main>
  );
}

export function ContentDownloads({ cid }: { readonly cid: string }) {
  return (
    <div className="actions">
      <a className="primary" href={`/api/public/${cid}/download?access=v1`}>
        Download file / ZIP
      </a>
      <a href={`/api/public/${cid}/car?access=v1`}>Download CAR</a>
      <a href={`/ipfs/${cid}?format=raw&access=v1`}>Download root block</a>
    </div>
  );
}

export function SharePage({ cid }: { readonly cid: string }) {
  const valid = /^[A-Za-z0-9]{10,256}$/.test(cid);
  const [access, setAccess] = useState<"loading" | "allowed" | "unavailable">(
    "loading",
  );
  const [visibility, setVisibility] = useState<Visibility>("public");
  const [copyError, setCopyError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setAccess("loading");
    setCopyError("");
    if (!valid) {
      setAccess("unavailable");
      return;
    }
    void apiFetch(`/api/public/${cid}/access`, { signal: controller.signal })
      .then((response) => {
        if (!controller.signal.aborted) {
          if (response.ok)
            setVisibility(
              response.headers.get("x-pinboard-byte-access") === "private"
                ? "private"
                : "public",
            );
          setAccess(response.ok ? "allowed" : "unavailable");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setAccess("unavailable");
      });
    return () => controller.abort();
  }, [cid, valid]);
  return (
    <main className="shell">
      <header className="masthead">
        <a className="brand" href="/">
          Pinboard
        </a>
        <span>Shared by CID</span>
      </header>
      <section className="intro">
        <p className="eyebrow">Content link</p>
        <h1>
          A pin, <em>not a platform.</em>
        </h1>
      </section>
      {valid && access === "allowed" ? (
        <section className="panel">
          <DetailHeading
            name="Content"
            cid={cid}
            contentType={null}
            visibility={visibility}
            disabled={false}
            onCopy={(value, onCopied) => {
              void navigator.clipboard
                .writeText(value)
                .then(() => onCopied?.())
                .catch(() =>
                  setCopyError(
                    "Could not copy the link or CID. Retry copying.",
                  ),
                );
            }}
          />
          {copyError && <p role="alert">{copyError}</p>}
          <p>
            Download the original file or a folder as ZIP. You can also export
            the complete DAG as a CAR archive. Public bytes can also be read
            with a configured Kubo client.
          </p>
          <ContentDownloads cid={cid} />
          {visibility === "public" ? (
            <>
              <pre>ipfs get {cid}</pre>
              <p className="muted">
                Kubo must use this service as a delegated router with HTTP
                retrieval enabled. This link does not announce content to the
                public IPFS network. Uploaded pages are never rendered here.
              </p>
            </>
          ) : (
            <p className="muted">
              Private bytes require an authorized browser session, API Agent
              token or scoped MCP block_get. Copying a link or CID grants no
              access. This CID view does not change any item's visibility.
            </p>
          )}
        </section>
      ) : valid && access === "loading" ? (
        <p role="status">Checking access...</p>
      ) : valid ? (
        <p role="alert">
          Content unavailable.{" "}
          <a href="/">Sign in to check access or switch accounts</a>. Signing in
          does not guarantee permission.
        </p>
      ) : (
        <p role="alert">Invalid CID link.</p>
      )}
      <footer>
        <a href="/">Pin blocks. Share by CID.</a>
      </footer>
    </main>
  );
}
