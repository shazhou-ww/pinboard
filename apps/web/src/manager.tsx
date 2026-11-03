import type { AgentToken, Pin } from "@workspace/contracts";
import { useEffect, useState, type FormEvent } from "react";

type PinPage = { pins: Pin[]; nextCursor: string | null };
export async function requestJson<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body: unknown = await response.json();
    const message =
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof body.error === "string"
        ? body.error
        : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return response.status === 204
    ? (undefined as T)
    : ((await response.json()) as T);
}

export function AccountManager() {
  const [pins, setPins] = useState<Pin[]>([]);
  const [tokens, setTokens] = useState<AgentToken[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<Pin | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState("file");
  const [blockCid, setBlockCid] = useState("");
  const [consent, setConsent] = useState(false);
  const [tokenName, setTokenName] = useState("");
  const [tokenScopes, setTokenScopes] = useState(["pins:read"]);
  const [expires, setExpires] = useState(30);
  const [newToken, setNewToken] = useState("");

  const refresh = async () => {
    const [page, list] = await Promise.all([
      requestJson<PinPage>("/api/pins"),
      requestJson<{ tokens: AgentToken[] }>("/api/tokens"),
    ]);
    setPins(page.pins);
    setCursor(page.nextCursor);
    setTokens(list.tokens);
    setLoaded(true);
  };
  const perform = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    let active = true;
    void Promise.all([
      requestJson<PinPage>("/api/pins"),
      requestJson<{ tokens: AgentToken[] }>("/api/tokens"),
    ])
      .then(([page, list]) => {
        if (active) {
          setPins(page.pins);
          setCursor(page.nextCursor);
          setTokens(list.tokens);
          setLoaded(true);
        }
      })
      .catch((failure: unknown) => {
        if (active)
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
      });
    return () => {
      active = false;
    };
  }, []);

  const copy = (text: string) =>
    perform(async () => {
      await navigator.clipboard.writeText(text);
      setNotice("Copied to clipboard.");
    });
  const upload = (event: FormEvent) => {
    event.preventDefault();
    if (!file || !consent) return;
    void perform(async () => {
      if (file.size > 32 * 1024 * 1024)
        throw new Error("Uploads are limited to 32 MiB.");
      const query = new URLSearchParams({
        kind,
        name: file.name,
        ...(kind === "block" ? { cid: blockCid } : {}),
      });
      const pin = await requestJson<Pin>(`/api/pins/upload?${query}`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-pinboard-public": "true",
        },
        body: file,
      });
      setSelected(pin);
      await refresh();
      setNotice("Pinned. These bytes are now public.");
    });
  };
  const createAgent = (event: FormEvent) => {
    event.preventDefault();
    void perform(async () => {
      const issued = await requestJson<AgentToken & { token: string }>(
        "/api/tokens",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: tokenName,
            scopes: tokenScopes,
            expiresInDays: expires,
          }),
        },
      );
      setNewToken(issued.token);
      setTokenName("");
      await refresh();
    });
  };
  return (
    <div className="manager" aria-busy={busy}>
      {error ? (
        <div className="notice" role="alert">
          {error}{" "}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void perform(refresh);
            }}
          >
            Reload
          </button>
        </div>
      ) : null}
      {notice ? (
        <p role="status" className="notice success">
          {notice}
        </p>
      ) : null}
      <section className="panel">
        <div className="section-title">
          <h2>Make a pin</h2>
          <span>01 / Upload</span>
        </div>
        <form onSubmit={upload}>
          <label>
            Content type
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="file">File → UnixFS DAG</option>
              <option value="car">Complete CAR archive</option>
              <option value="block">Raw IPFS block</option>
            </select>
          </label>
          <label className="dropzone">
            Choose a file <span>Up to 32 MiB · no remote fetching</span>
            <input
              aria-label="Upload content"
              type="file"
              required
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          {kind === "block" ? (
            <label>
              Block CID
              <input
                value={blockCid}
                onChange={(e) => setBlockCid(e.target.value)}
                required
                maxLength={256}
                placeholder="bafy… / bafk…"
              />
            </label>
          ) : null}
          <label className="check">
            <input
              type="checkbox"
              checked={consent}
              required
              onChange={(e) => setConsent(e.target.checked)}
            />
            I understand all uploaded bytes are publicly readable by CID, even
            after unpinning.
          </label>
          <button className="primary" disabled={busy || !file || !consent}>
            Upload &amp; pin <span aria-hidden="true">↑</span>
          </button>
        </form>
      </section>
      <section className="panel">
        <div className="section-title">
          <h2>Your pins</h2>
          <span>02 / Keep</span>
        </div>
        {!loaded ? (
          <p role="status">Loading your pins...</p>
        ) : !pins.length ? (
          <p className="muted">
            Nothing pinned yet. Start with one small thing.
          </p>
        ) : (
          <ul className="pin-list">
            {pins.map((pin) => (
              <li key={pin.cid}>
                <button
                  className="pin-name"
                  disabled={busy}
                  onClick={() => {
                    void perform(async () =>
                      setSelected(
                        await requestJson<Pin>(`/api/pins/${pin.cid}`),
                      ),
                    );
                  }}
                >
                  {pin.name}
                </button>
                <span className="muted">
                  {formatSize(pin.size)} · {pin.blocks} blocks
                </span>
                <code>{pin.cid}</code>
                <div className="actions">
                  <button
                    disabled={busy}
                    onClick={() => {
                      void copy(pin.cid);
                    }}
                  >
                    Copy CID
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => {
                      void copy(`${location.origin}/share/${pin.cid}`);
                    }}
                  >
                    Copy link
                  </button>
                  <a href={`/share/${pin.cid}`}>Open share ↗</a>
                  <button
                    className="danger"
                    disabled={busy}
                    onClick={() => {
                      if (
                        !window.confirm(
                          "Remove your pin reference? Public bytes will remain available.",
                        )
                      )
                        return;
                      void perform(async () => {
                        await requestJson(`/api/pins/${pin.cid}`, {
                          method: "DELETE",
                        });
                        if (selected?.cid === pin.cid) setSelected(null);
                        await refresh();
                        setNotice(
                          "Reference removed. Public bytes are retained; garbage collection is not enabled.",
                        );
                      });
                    }}
                  >
                    Unpin
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {cursor ? (
          <button
            disabled={busy}
            onClick={() => {
              void perform(async () => {
                const page = await requestJson<PinPage>(
                  `/api/pins?cursor=${encodeURIComponent(cursor)}`,
                );
                setPins((previous) => [...previous, ...page.pins]);
                setCursor(page.nextCursor);
              });
            }}
          >
            Load more
          </button>
        ) : null}
        {selected ? (
          <aside className="detail">
            <div className="section-title">
              <h3>{selected.name}</h3>
              <button
                onClick={() => setSelected(null)}
                aria-label="Close details"
              >
                ×
              </button>
            </div>
            <code className="cid">{selected.cid}</code>
            <p>
              {formatSize(selected.size)} · {selected.blocks} blocks ·{" "}
              {new Date(selected.createdAt).toLocaleString()}
            </p>
            <a href={`/api/public/${selected.cid}/car`}>
              Download complete CAR ↓
            </a>
          </aside>
        ) : null}
      </section>
      <section className="panel">
        <div className="section-title">
          <h2>Let an agent help</h2>
          <span>03 / Connect</span>
        </div>
        <p className="muted">
          Account-bound, scoped, revocable. A name is a label, never an
          identity.
        </p>
        <p>
          MCP endpoint{" "}
          <code>
            {typeof location === "undefined"
              ? "/mcp"
              : `${location.origin}/mcp`}
          </code>
        </p>
        <form onSubmit={createAgent}>
          <div className="form-row">
            <label>
              Token label
              <input
                value={tokenName}
                onChange={(e) => setTokenName(e.target.value)}
                required
                maxLength={200}
                placeholder="My assistant"
              />
            </label>
            <label>
              Expires in days
              <input
                type="number"
                min={1}
                max={365}
                value={expires}
                onChange={(e) => setExpires(e.target.valueAsNumber)}
                required
              />
            </label>
          </div>
          <fieldset>
            <legend>Permissions</legend>
            {["pins:read", "pins:write", "pins:delete"].map((scope) => (
              <label className="check" key={scope}>
                <input
                  type="checkbox"
                  checked={tokenScopes.includes(scope)}
                  onChange={(e) =>
                    setTokenScopes((previous) =>
                      e.target.checked
                        ? [...previous, scope]
                        : previous.filter((item) => item !== scope),
                    )
                  }
                />
                {scope}
              </label>
            ))}
          </fieldset>
          <button disabled={busy || !tokenScopes.length} className="secondary">
            Create Agent token
          </button>
        </form>
        {newToken ? (
          <div className="token-secret">
            <label>
              Copy now — shown only once
              <input readOnly value={newToken} />
            </label>
            <div className="actions">
              <button
                onClick={() => {
                  void copy(newToken);
                }}
              >
                Copy token
              </button>
              <button onClick={() => setNewToken("")}>Dismiss</button>
            </div>
          </div>
        ) : null}
        <ul className="token-list">
          {tokens.map((token) => (
            <li key={token.id}>
              <div>
                <strong>{token.name}</strong>
                <p>
                  <code>{token.prefix}…</code> · {token.scopes} · expires{" "}
                  {new Date(token.expiresAt).toLocaleDateString()}
                </p>
              </div>
              {token.revokedAt ? (
                <span className="muted">Revoked</span>
              ) : (
                <button
                  disabled={busy}
                  onClick={() => {
                    void perform(async () => {
                      await requestJson(`/api/tokens/${token.id}`, {
                        method: "DELETE",
                      });
                      await refresh();
                      setNotice("Token revoked.");
                    });
                  }}
                >
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
      <p className="muted policy">
        Unpinning removes only your account reference. Shared blocks are never
        deleted by another account. Physical garbage collection is deferred.
      </p>
    </div>
  );
}

export function formatSize(size: number): string {
  return size < 1024
    ? `${size} B`
    : size < 1024 * 1024
      ? `${(size / 1024).toFixed(1)} KiB`
      : `${(size / 1024 / 1024).toFixed(1)} MiB`;
}
