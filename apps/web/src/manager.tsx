import type { AgentToken, Pin } from "@workspace/contracts";
import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
} from "react";
import {
  selectionForDirectory,
  selectionForFile,
  selectionFromDrop,
  type UploadSelection,
} from "./uploads.js";

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
  const [tokenView, setTokenView] = useState<"active" | "history">("active");
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<Pin | null>(null);
  const [renaming, setRenaming] = useState<{
    cid: string;
    name: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [uploadSelection, setUploadSelection] =
    useState<UploadSelection | null>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState("");
  const filePicker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement>(null);
  const [consent, setConsent] = useState(false);
  const [tokenName, setTokenName] = useState("");
  const [tokenScopes, setTokenScopes] = useState(["pins:read"]);
  const [expires, setExpires] = useState(30);
  const [newToken, setNewToken] = useState("");

  const refresh = async () => {
    const [page, list] = await Promise.all([
      requestJson<PinPage>("/api/pins"),
      requestJson<{ tokens: AgentToken[] }>(`/api/tokens?view=${tokenView}`),
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
    setProgress("");
    try {
      await operation();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
      setProgress("");
    }
  };
  useEffect(() => {
    let active = true;
    void Promise.all([
      requestJson<PinPage>("/api/pins"),
      requestJson<{ tokens: AgentToken[] }>(`/api/tokens?view=${tokenView}`),
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
  }, [tokenView]);

  const copy = (text: string) =>
    perform(async () => {
      await navigator.clipboard.writeText(text);
      setNotice("Copied to clipboard.");
    });
  const choose = (
    prepare: () => UploadSelection | Promise<UploadSelection>,
  ) => {
    if (busy) {
      setError(
        "Wait for the current operation to finish before choosing content.",
      );
      return;
    }
    setUploadSelection(null);
    void perform(async () => {
      setProgress("Reading selection...");
      setUploadSelection(await prepare());
    });
  };
  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const items = Array.from(event.dataTransfer.items);
    choose(() => selectionFromDrop(items));
  };
  const upload = (event: FormEvent) => {
    event.preventDefault();
    if (!uploadSelection || !consent) {
      setError(
        "Choose a file or folder and acknowledge that its content will be public.",
      );
      return;
    }
    void perform(async () => {
      let body: Blob;
      let kind: "file" | "car";
      if (uploadSelection.kind === "folder") {
        setProgress("Preparing folder...");
        const { buildDirectoryCar } = await import("./directory.js");
        body = await buildDirectoryCar(uploadSelection);
        kind = "car";
      } else {
        body = uploadSelection.file;
        kind = "file";
      }
      const query = new URLSearchParams({
        kind,
        name: uploadSelection.name,
      });
      setProgress("Uploading...");
      const pin = await requestJson<Pin>(`/api/pins/upload?${query}`, {
        method: "POST",
        headers: {
          "content-type":
            kind === "car"
              ? "application/vnd.ipld.car"
              : "application/octet-stream",
          "x-pinboard-public": "true",
        },
        body,
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
  const rename = (event: FormEvent) => {
    event.preventDefault();
    if (!renaming) return;
    const { cid, name } = renaming;
    if (!name.trim() || name.trim().length > 200) {
      setError("Pin names must contain 1-200 characters.");
      return;
    }
    void perform(async () => {
      const pin = await requestJson<Pin>(`/api/pins/${cid}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      setPins((previous) =>
        previous.map((entry) => (entry.cid === pin.cid ? pin : entry)),
      );
      setSelected((previous) => (previous?.cid === pin.cid ? pin : previous));
      setRenaming(null);
      setNotice("Pin renamed. CID and public content are unchanged.");
    });
  };
  const uploadFileCount =
    uploadSelection?.kind === "folder"
      ? uploadSelection.files.length
      : uploadSelection
        ? 1
        : 0;
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
      {progress ? (
        <p role="status" className="notice">
          {progress}
        </p>
      ) : null}
      <section className="panel">
        <div className="section-title">
          <h2>Make a pin</h2>
          <span>01 / Upload</span>
        </div>
        <form onSubmit={upload}>
          <div
            className={`dropzone${dragging ? " drag-active" : ""}`}
            role="group"
            aria-label="File or folder upload"
            aria-disabled={busy}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = busy ? "none" : "copy";
              setDragging(!busy);
            }}
            onDragLeave={(event) => {
              if (!(
                event.relatedTarget instanceof Node &&
                event.currentTarget.contains(event.relatedTarget)
              ))
                setDragging(false);
            }}
            onDrop={drop}
          >
            <strong>
              {uploadSelection
                ? uploadSelection.name
                : "Drop one file or folder here"}
            </strong>
            <p className="muted">
              {uploadSelection
                ? `${uploadFileCount} ${uploadFileCount === 1 ? "file" : "files"} · ${formatSize(uploadSelection.size)}`
                : "Or choose content from your device."}
            </p>
            <div className="actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => {
                  if (filePicker.current) {
                    filePicker.current.value = "";
                    filePicker.current.click();
                  }
                }}
              >
                Choose file
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => {
                  if (folderPicker.current) {
                    folderPicker.current.value = "";
                    folderPicker.current.click();
                  }
                }}
              >
                Choose folder
              </button>
            </div>
            <p className="muted">
              Up to 32 MiB including directory metadata. Empty folders are not
              included.
            </p>
            <input
              ref={filePicker}
              aria-label="Choose file"
              type="file"
              hidden
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) choose(() => selectionForFile(file));
              }}
            />
            <input
              ref={folderPicker}
              aria-label="Choose folder"
              type="file"
              hidden
              multiple
              {...{ webkitdirectory: "" }}
              onChange={(event) => {
                const entries = Array.from(event.currentTarget.files ?? []).map(
                  (file) => ({ path: file.webkitRelativePath, file }),
                );
                choose(() => selectionForDirectory(entries));
              }}
            />
          </div>
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
          <button
            className="primary"
            disabled={busy || !uploadSelection || !consent}
          >
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
                    onClick={() =>
                      setRenaming({ cid: pin.cid, name: pin.name })
                    }
                  >
                    Rename
                  </button>
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
                          "Remove your pin reference? Unreferenced content is retained for 7 days. Public copies elsewhere may remain.",
                        )
                      )
                        return;
                      void perform(async () => {
                        await requestJson(`/api/pins/${pin.cid}`, {
                          method: "DELETE",
                        });
                        setPins((previous) =>
                          previous.filter((item) => item.cid !== pin.cid),
                        );
                        if (selected?.cid === pin.cid) setSelected(null);
                        await refresh();
                        setNotice(
                          "Reference removed. Unreferenced content becomes eligible for cleanup after 7 days. Shared and external copies may remain.",
                        );
                      });
                    }}
                  >
                    Unpin
                  </button>
                </div>
                {renaming?.cid === pin.cid ? (
                  <form onSubmit={rename} aria-label={`Rename ${pin.name}`}>
                    <label>
                      Pin name
                      <input
                        autoFocus
                        required
                        maxLength={200}
                        value={renaming.name}
                        disabled={busy}
                        onChange={(event) =>
                          setRenaming({
                            cid: pin.cid,
                            name: event.target.value,
                          })
                        }
                      />
                    </label>
                    <div className="actions">
                      <button
                        type="submit"
                        disabled={busy || !renaming.name.trim()}
                      >
                        Save name
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setRenaming(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : null}
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
        <label>
          Token view
          <select
            value={tokenView}
            disabled={busy}
            onChange={(event) => {
              setTokens([]);
              setTokenView(
                event.target.value === "history" ? "history" : "active",
              );
            }}
          >
            <option value="active">Active tokens</option>
            <option value="history">History (revoked or expired)</option>
          </select>
        </label>
        <p className="muted">
          Revocation and expiry take effect immediately. History is kept for 30
          days from whichever happens first, then removed by scheduled cleanup.
        </p>
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
              ) : token.expiresAt <= new Date().toISOString() ? (
                <span className="muted">Expired</span>
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
        deleted by another account. Content without any account or DAG reference
        is retained for 7 days before scheduled cleanup. CDN, other nodes and
        downloaded copies may remain; there is no restore or permanent-delete
        action.
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
