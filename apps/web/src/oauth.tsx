import { signIn } from "@hono/auth-js/react";
import { useEffect, useState } from "react";
import {
  defaultOAuthLifetime,
  oauthLifetimes,
  oauthLifetimeOptions,
  type OAuthGrant,
  type OAuthLifetime,
} from "@shazhou/pinboard-contracts";
import { apiFetch } from "./api.js";
import { Icon } from "./icon.js";
import {
  AuthorizationTable,
  AuthorizationToolbar,
  authorizationMatches,
  grantStatus,
} from "./authorizations.js";

type Consent = {
  accountId: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
  expiresAt: number;
};
const permissions: Record<string, { name: string; description: string }> = {
  "pins:read": { name: "Read pins", description: "View your pins." },
  "pins:write": {
    name: "Write pins",
    description: "Upload public content, create or rename pins.",
  },
  "pins:delete": {
    name: "Delete pins",
    description: "Move pins to trash or restore them.",
  },
  "publications:read": {
    name: "Read publications",
    description: "List active and deleted publications.",
  },
  "publications:write": {
    name: "Write publications",
    description: "Create, publish versions or change follow links.",
  },
  "publications:delete": {
    name: "Delete publications",
    description: "Close public links or restore publications.",
  },
};

async function oauthJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(path, init);
  if (!response.ok)
    throw new Error(
      `Request failed (${response.status}). Restart the connection if it expired.`,
    );
  return response.status === 204
    ? (undefined as T)
    : ((await response.json()) as T);
}

export function OAuthSignIn({
  busy,
  onSignIn,
}: {
  busy: boolean;
  onSignIn: () => void;
}) {
  return (
    <section className="panel signin oauth-panel">
      <h1>Sign in to connect MCP</h1>
      <p>Review permissions after signing in. No access granted yet.</p>
      <div className="actions" role="group" aria-label="Sign-in options">
        <button
          type="button"
          className="primary"
          disabled={busy}
          aria-busy={busy}
          onClick={onSignIn}
        >
          {busy ? "Connecting to Google..." : "Continue with Google"}
        </button>
        <a className="secondary" href="/">
          Cancel
        </a>
      </div>
    </section>
  );
}

export function ConsentDetails({
  consent,
  selected,
  lifetime,
  busy,
  onToggle,
  onLifetimeChange,
  onDecide,
}: {
  consent: Consent;
  selected: string[];
  lifetime: OAuthLifetime;
  busy: boolean;
  onToggle: (scope: string) => void;
  onLifetimeChange: (lifetime: OAuthLifetime) => void;
  onDecide: (approve: boolean) => void;
}) {
  return (
    <section className="panel oauth-panel">
      <h1>Connect MCP client?</h1>
      <p className="oauth-request">
        <strong>{consent.clientName}</strong> wants access to Pinboard.
      </p>
      <div className="oauth-warning">
        <Icon name="warning" size={17} />
        <p>Unverified client. Continue only if you started this connection.</p>
      </div>
      <section className="oauth-connection" aria-labelledby="connection-title">
        <h2 id="connection-title">Connection details</h2>
        <dl>
          <dt>Account</dt>
          <dd>
            <code>{consent.accountId}</code>
          </dd>
          <dt>Client ID</dt>
          <dd>
            <code>{consent.clientId}</code>
          </dd>
          <dt>Resource</dt>
          <dd>{consent.resource}</dd>
        </dl>
      </section>
      <fieldset className="oauth-permissions" disabled={busy}>
        <legend>Permissions</legend>
        <div>
          {consent.scopes.map((scope) => (
            <label className="oauth-permission" key={scope}>
              <input
                type="checkbox"
                checked={selected.includes(scope)}
                onChange={() => onToggle(scope)}
              />
              <span>
                <strong>{permissions[scope]?.name ?? scope}</strong>
                {permissions[scope] && `: ${permissions[scope].description}`}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="oauth-lifetime">
        <label htmlFor="oauth-lifetime">Access expires</label>
        <select
          id="oauth-lifetime"
          value={lifetime}
          disabled={busy}
          aria-describedby="oauth-lifetime-help"
          onChange={(event) => {
            const value = event.currentTarget.value;
            const next = oauthLifetimes.find((option) => option === value);
            if (!next) throw new Error("Invalid authorization lifetime");
            onLifetimeChange(next);
          }}
        >
          {oauthLifetimes.map((value) => (
            <option key={value} value={value}>
              {oauthLifetimeOptions[value].label}
            </option>
          ))}
        </select>
        <p id="oauth-lifetime-help" role="status">
          {lifetime === "never"
            ? "No expiry. Access lasts until you revoke it."
            : "Revoke anytime from the homepage."}
        </p>
      </div>
      <p className="oauth-terms">
        Uploads are public. Google credentials aren&apos;t shared.
      </p>
      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={busy || !selected.length}
          onClick={() => onDecide(true)}
        >
          Allow
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => onDecide(false)}
        >
          Cancel
        </button>
      </div>
      {!selected.length && (
        <p className="oauth-selection-note" role="status">
          Select at least one permission.
        </p>
      )}
    </section>
  );
}

export function OAuthConsent() {
  const id = new URLSearchParams(location.search).get("request");
  const [consent, setConsent] = useState<Consent | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [lifetime, setLifetime] = useState<OAuthLifetime>(defaultOAuthLifetime);
  const [login, setLogin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const path = `/api/oauth/requests/${encodeURIComponent(id ?? "")}`;
  useEffect(() => {
    if (!id || !/^[a-f0-9-]{36}$/.test(id)) {
      setError("Invalid authorization request. Restart the connection.");
      return;
    }
    const controller = new AbortController();
    void apiFetch(path, { signal: controller.signal })
      .then(async (response) => {
        if (response.status === 401) {
          setLogin(true);
          return;
        }
        if (!response.ok)
          throw new Error(
            response.status === 400 || response.status === 403
              ? "Authorization expired or account changed. Restart the connection."
              : `Authorization request failed (${response.status}). Please retry.`,
          );
        const data = (await response.json()) as Consent;
        setConsent(data);
        setSelected(data.scopes);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error ? failure.message : "Authorization failed",
          );
      });
    return () => controller.abort();
  }, [id, path]);
  function signInWithGoogle() {
    setBusy(true);
    void signIn("google", {
      callbackUrl: `/connect/mcp?request=${encodeURIComponent(id!)}`,
    }).catch(() => {
      setError("Google sign-in failed. Restart the connection.");
      setBusy(false);
    });
  }
  function decide(approve: boolean) {
    if (!consent) return;
    setBusy(true);
    void oauthJson<{ redirect: string }>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId: consent.accountId,
        approve,
        scopes: selected,
        lifetime,
      }),
    })
      .then(({ redirect }) => {
        const target = new URL(redirect);
        if (
          target.origin !== new URL(consent.redirectUri).origin ||
          target.pathname !== new URL(consent.redirectUri).pathname
        )
          throw new Error("Invalid callback address");
        location.replace(target.href);
      })
      .catch((failure: unknown) => {
        setError(
          failure instanceof Error ? failure.message : "Authorization failed",
        );
        setBusy(false);
      });
  }
  return (
    <main className="shell oauth-shell">
      <a className="brand" href="/">
        <Icon name="brand" className="brand-mark" />
        Pinboard
      </a>
      {error ? (
        <p role="alert">{error}</p>
      ) : login ? (
        <OAuthSignIn busy={busy} onSignIn={signInWithGoogle} />
      ) : consent ? (
        <ConsentDetails
          consent={consent}
          selected={selected}
          lifetime={lifetime}
          busy={busy}
          onToggle={(scope) =>
            setSelected((values) =>
              values.includes(scope)
                ? values.filter((value) => value !== scope)
                : [...values, scope],
            )
          }
          onDecide={decide}
          onLifetimeChange={setLifetime}
        />
      ) : (
        <p role="status">Loading authorization request...</p>
      )}
    </main>
  );
}

export function GrantList({
  grants,
  busy,
  onRevoke,
  loading = false,
  error = "",
  empty = "",
}: {
  grants: OAuthGrant[];
  busy: boolean;
  onRevoke: (id: string) => void;
  loading?: boolean;
  error?: string;
  empty?: string;
}) {
  return (
    <AuthorizationTable
      name="OAuth authorizations"
      firstColumn="Client"
      loading={loading}
      error={error}
      empty={empty}
    >
      {grants.map((grant) => {
        const status = grantStatus(grant);
        return (
          <tr key={grant.id}>
            <td>
              <strong>{grant.clientName}</strong>
              <small>
                <code>{grant.clientId}</code>
              </small>
              <small>
                Created {new Date(grant.createdAt).toLocaleString()}
              </small>
            </td>
            <td>
              <code>{grant.scopes}</code>
            </td>
            <td>
              {grant.expiresAt !== null
                ? new Date(grant.expiresAt).toLocaleString()
                : grant.tokenIssued
                  ? "Never expires"
                  : `Code expires ${new Date(grant.codeExpiresAt).toLocaleString()}`}
            </td>
            <td>
              <span
                className={`authorization-badge${status === "Active" ? " active" : ""}`}
              >
                {status}
              </span>
            </td>
            <td>
              {status === "Active" || status === "Awaiting code exchange" ? (
                <button
                  type="button"
                  className="glyph-button danger"
                  title={`Revoke client authorization: ${grant.clientName}`}
                  aria-label={`Revoke client authorization: ${grant.clientName}`}
                  disabled={busy}
                  onClick={() => {
                    const current = grantStatus(grant);
                    if (
                      current === "Active" ||
                      current === "Awaiting code exchange"
                    )
                      onRevoke(grant.id);
                  }}
                >
                  <Icon name="revoke" />
                </button>
              ) : (
                "—"
              )}
            </td>
          </tr>
        );
      })}
    </AuthorizationTable>
  );
}

export function OAuthGrants({
  disabled = false,
  onBusyChange,
}: {
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
} = {}) {
  const [grants, setGrants] = useState<OAuthGrant[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  function load() {
    setLoading(true);
    return oauthJson<{ grants: OAuthGrant[] }>("/api/oauth/grants")
      .then((data) => setGrants(data.grants))
      .finally(() => setLoading(false));
  }
  useEffect(() => {
    void load().catch(() => setError("Unable to load MCP authorizations."));
  }, []);
  function revoke(id: string) {
    setBusy(true);
    setError("");
    void oauthJson<void>(`/api/oauth/grants/${encodeURIComponent(id)}`, {
      method: "DELETE",
    })
      .then(load)
      .catch(() => setError("Unable to revoke authorization. Try again."))
      .finally(() => setBusy(false));
  }
  const visible = grants.filter((grant) =>
    authorizationMatches(
      grant.clientName,
      grant.scopes,
      grantStatus(grant),
      query,
      includeInactive,
    ),
  );
  return (
    <section className="authorization">
      <h2>OAuth authorizations</h2>
      <AuthorizationToolbar
        name="OAuth authorizations"
        query={query}
        onQuery={setQuery}
        includeInactive={includeInactive}
        onIncludeInactive={setIncludeInactive}
        disabled={busy || disabled}
        action={
          <button
            type="button"
            className="glyph-button"
            aria-label="Refresh authorizations"
            title="Refresh authorizations"
            disabled={busy || disabled}
            onClick={() => {
              setBusy(true);
              setError("");
              void load()
                .catch(() => setError("Unable to load MCP authorizations."))
                .finally(() => setBusy(false));
            }}
          >
            <Icon name="refresh" />
          </button>
        }
      />
      <GrantList
        grants={visible}
        busy={busy || disabled}
        onRevoke={revoke}
        loading={loading}
        error={error}
        empty={
          !visible.length
            ? query.trim()
              ? "No matching OAuth authorizations."
              : grants.length
                ? "No active OAuth authorizations."
                : "No OAuth authorizations."
            : ""
        }
      />
      <output className="authorization-count">
        {loading || error
          ? "Records unavailable"
          : `Showing ${visible.length} / ${grants.length} records`}
      </output>
    </section>
  );
}
