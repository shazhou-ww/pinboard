import { signIn } from "@hono/auth-js/react";
import { useEffect, useState } from "react";

type Consent = {
  accountId: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
  expiresAt: number;
};
type Grant = {
  id: string;
  clientName: string;
  clientId: string;
  scopes: string;
  createdAt: number;
  codeExpiresAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
};
const labels: Record<string, string> = {
  "pins:read": "Read your pins",
  "pins:write": "Upload public content and create or rename pins",
  "pins:delete": "Remove your pin references",
};

async function oauthJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok)
    throw new Error(
      `Request failed (${response.status}). Restart the connection if it expired.`,
    );
  return response.status === 204
    ? (undefined as T)
    : ((await response.json()) as T);
}

export function ConsentDetails({
  consent,
  selected,
  busy,
  onToggle,
  onDecide,
}: {
  consent: Consent;
  selected: string[];
  busy: boolean;
  onToggle: (scope: string) => void;
  onDecide: (approve: boolean) => void;
}) {
  return (
    <section className="panel">
      <h1>Connect MCP client?</h1>
      <p>
        <strong>{consent.clientName}</strong> requests access to your Pinboard
        account.
      </p>
      <p>
        Client names are self-registered, not verified by Pinboard. Only
        continue if you initiated this connection.
      </p>
      <dl>
        <dt>Client ID</dt>
        <dd>
          <code>{consent.clientId}</code>
        </dd>
        <dt>Return address</dt>
        <dd className="cid">{consent.redirectUri}</dd>
        <dt>Resource</dt>
        <dd className="cid">{consent.resource}</dd>
        <dt>Pinboard account</dt>
        <dd>
          <code>{consent.accountId}</code>
        </dd>
      </dl>
      <fieldset disabled={busy}>
        <legend>Choose permissions</legend>
        {consent.scopes.map((scope) => (
          <label key={scope}>
            <input
              type="checkbox"
              checked={selected.includes(scope)}
              onChange={() => onToggle(scope)}
            />
            {labels[scope] ?? scope}
          </label>
        ))}
      </fieldset>
      <p>
        Access expires after one hour. Reconnect to authorize again. Revoke at
        any time on the homepage. Uploaded content is public. Google credentials
        are never shared with this client.
      </p>
      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={busy || !selected.length}
          onClick={() => onDecide(true)}
        >
          Allow selected permissions
        </button>
        <button type="button" disabled={busy} onClick={() => onDecide(false)}>
          Cancel connection
        </button>
      </div>
    </section>
  );
}

export function OAuthConsent() {
  const id = new URLSearchParams(location.search).get("request");
  const [consent, setConsent] = useState<Consent | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
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
    void fetch(path, { signal: controller.signal })
      .then(async (response) => {
        if (response.status === 401) {
          setLogin(true);
          return;
        }
        if (!response.ok)
          throw new Error(
            "Authorization expired or account changed. Restart the connection.",
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
    <main className="shell">
      <a className="brand" href="/">
        Pinboard
      </a>
      {error ? (
        <p role="alert">{error}</p>
      ) : login ? (
        <section className="panel">
          <h1>Sign in to connect MCP</h1>
          <p>
            Sign-in does not grant access. You will review permissions next.
          </p>
          <button disabled={busy} onClick={signInWithGoogle}>
            Continue with Google
          </button>
          <a href="/">Leave without authorizing</a>
        </section>
      ) : consent ? (
        <ConsentDetails
          consent={consent}
          selected={selected}
          busy={busy}
          onToggle={(scope) =>
            setSelected((values) =>
              values.includes(scope)
                ? values.filter((value) => value !== scope)
                : [...values, scope],
            )
          }
          onDecide={decide}
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
}: {
  grants: Grant[];
  busy: boolean;
  onRevoke: (id: string) => void;
}) {
  return (
    <ul>
      {grants.map((grant) => {
        const status = grant.revokedAt
          ? "Revoked"
          : !grant.expiresAt
            ? grant.codeExpiresAt <= Date.now()
              ? "Expired"
              : "Awaiting code exchange"
            : grant.expiresAt <= Date.now()
              ? "Expired"
              : "Active";
        return (
          <li key={grant.id}>
            <strong>{grant.clientName}</strong> — {status}
            <p>
              <code>{grant.clientId}</code> · {grant.scopes}
            </p>
            <p>
              Created {new Date(grant.createdAt).toLocaleString()}
              {grant.expiresAt
                ? ` · Expires ${new Date(grant.expiresAt).toLocaleString()}`
                : ""}
            </p>
            {!grant.revokedAt && (
              <button
                type="button"
                disabled={busy}
                onClick={() => onRevoke(grant.id)}
              >
                Revoke client authorization
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function OAuthGrants() {
  const [grants, setGrants] = useState<Grant[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  function load() {
    return oauthJson<{ grants: Grant[] }>("/api/oauth/grants").then((data) =>
      setGrants(data.grants),
    );
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
  return (
    <section className="panel">
      <h2>MCP client authorizations</h2>
      <p>
        Separate from API tokens. Access lasts one hour; revocation blocks
        subsequent requests, not operations already in flight.
      </p>
      {error && <p role="alert">{error}</p>}
      {grants.length ? (
        <GrantList grants={grants} busy={busy} onRevoke={revoke} />
      ) : (
        <p>No client authorizations loaded.</p>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          void load().catch(() =>
            setError("Unable to load MCP authorizations."),
          );
        }}
      >
        Refresh authorizations
      </button>
    </section>
  );
}
