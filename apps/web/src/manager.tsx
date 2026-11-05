import type { AgentToken, Pin } from "@shazhou/pinboard-contracts";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  selectionForDirectory,
  selectionForFile,
  selectionFromDrop,
  type UploadSelection,
} from "./uploads.js";
import { Dialog } from "./dialog.js";
import { OAuthGrants } from "./oauth.js";
import { PinPreview } from "./pin-preview.js";
import { PreviewClient } from "./preview-client.js";
import { apiFetch } from "./api.js";

type PinPage = { pins: Pin[]; nextCursor: string | null };
export const publicReminderKey = "pinboard:skip-public-upload-reminder";
export async function requestJson<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await apiFetch(path, init);
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

export function AccountManager({
  accountId,
  renderHeader,
}: {
  accountId?: string | undefined;
  renderHeader: (onSettings: () => void, disabled: boolean) => ReactNode;
}) {
  const previews = useMemo(() => new PreviewClient(accountId), [accountId]);
  useEffect(() => previews.attach(), [previews]);
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [skipReminder, setSkipReminder] = useState(false);
  const [rememberReminder, setRememberReminder] = useState(false);
  const [uploadName, setUploadName] = useState("");
  const [tokenName, setTokenName] = useState("");
  const [tokenScopes, setTokenScopes] = useState(["pins:read"]);
  const [expires, setExpires] = useState(30);
  const [newToken, setNewToken] = useState("");

  useEffect(() => {
    try {
      setSkipReminder(localStorage.getItem(publicReminderKey) === "true");
    } catch {
      setError(
        "Browser preferences are unavailable. Public upload reminders will remain enabled.",
      );
    }
  }, []);
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

  const copy = (text: string, onCopied?: () => void) =>
    perform(async () => {
      await navigator.clipboard.writeText(text);
      if (onCopied) onCopied();
      else setNotice("Copied to clipboard.");
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
    setRememberReminder(false);
    void perform(async () => {
      setProgress("Reading selection...");
      const selection = await prepare();
      setUploadName(selection.name);
      setUploadSelection(selection);
    });
  };
  useEffect(() => {
    let depth = 0;
    const enter = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      depth++;
      setDragging(!busy && !settingsOpen && !uploadSelection && !selected);
    };
    const over = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect =
        busy || settingsOpen || uploadSelection || selected ? "none" : "copy";
      setDragging(!busy && !settingsOpen && !uploadSelection && !selected);
    };
    const leave = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      depth = 0;
      setDragging(false);
      if (settingsOpen || uploadSelection || selected) {
        setError(
          "Close the current dialog before adding another file or folder.",
        );
        return;
      }
      const items = Array.from(event.dataTransfer.items);
      choose(() => selectionFromDrop(items));
    };
    document.addEventListener("dragenter", enter);
    document.addEventListener("dragover", over);
    document.addEventListener("dragleave", leave);
    document.addEventListener("drop", drop);
    return () => {
      document.removeEventListener("dragenter", enter);
      document.removeEventListener("dragover", over);
      document.removeEventListener("dragleave", leave);
      document.removeEventListener("drop", drop);
    };
  }, [busy, settingsOpen, uploadSelection, selected]);
  const upload = (event: FormEvent) => {
    event.preventDefault();
    if (
      !uploadSelection ||
      !uploadName.trim() ||
      uploadName.trim().length > 200
    ) {
      setError(
        "Choose a file or folder and enter a pin name containing 1-200 characters.",
      );
      return;
    }
    void perform(async () => {
      if (!skipReminder && rememberReminder) {
        try {
          localStorage.setItem(publicReminderKey, "true");
          setSkipReminder(true);
        } catch {
          setRememberReminder(false);
          throw new Error(
            "Could not save the browser preference. Uncheck 'Do not remind me in this browser' and try again.",
          );
        }
      }
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
        name: uploadName.trim(),
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
      setUploadSelection(null);
      setPins((previous) => [
        pin,
        ...previous.filter((entry) => entry.cid !== pin.cid),
      ]);
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
  const openPin = (pin: Pin) => {
    setSelected(pin);
    setRenaming(null);
    void perform(async () => {
      setProgress("Loading pin details...");
      setSelected(await requestJson<Pin>(`/api/pins/${pin.cid}`));
    });
  };
  const unpin = (pin: Pin) => {
    if (
      !window.confirm(
        "Remove your pin reference? Unreferenced content is retained for 7 days. Public copies elsewhere may remain.",
      )
    )
      return;
    void perform(async () => {
      await requestJson(`/api/pins/${pin.cid}`, { method: "DELETE" });
      setPins((previous) => previous.filter((item) => item.cid !== pin.cid));
      setSelected(null);
      setRenaming(null);
      await refresh();
      setNotice(
        "Reference removed. Unreferenced content becomes eligible for cleanup after 7 days. Shared and external copies may remain.",
      );
    });
  };
  const uploadFileCount =
    uploadSelection?.kind === "folder"
      ? uploadSelection.files.length
      : uploadSelection
        ? 1
        : 0;
  return (
    <div
      className={`manager canvas${dragging ? " drag-active" : ""}`}
      aria-busy={busy}
    >
      {renderHeader(
        () => setSettingsOpen(true),
        busy || settingsOpen || !!uploadSelection || !!selected,
      )}
      {dragging ? (
        <div className="canvas-drop" aria-hidden="true">
          Drop one file or folder to make a pin
        </div>
      ) : null}
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
      <div
        className="floating-tools"
        role="toolbar"
        aria-label="Pinboard tools"
      >
        <div className="add-tool">
          <button
            type="button"
            className="floating-button primary"
            aria-label="Add file"
            title="Choose a file, or drop one file or folder anywhere."
            disabled={busy || !!uploadSelection || settingsOpen || !!selected}
            onClick={() => {
              if (filePicker.current) {
                filePicker.current.value = "";
                filePicker.current.click();
              }
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <div className="add-options" id="add-options">
            <button
              type="button"
              className="floating-button secondary"
              aria-label="Choose folder"
              title="Choose folder"
              disabled={busy || !!uploadSelection || settingsOpen || !!selected}
              onClick={() => {
                if (folderPicker.current) {
                  folderPicker.current.value = "";
                  folderPicker.current.click();
                }
              }}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M3 7V5h6l3 3h9v12H3V7ZM12 11v6M9 14h6" />
              </svg>
            </button>
          </div>
        </div>
      </div>
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
      <Dialog
        open={!!uploadSelection}
        title="Make a pin"
        busy={busy}
        onClose={() => setUploadSelection(null)}
      >
        {error ? (
          <p role="alert" className="notice">
            {error}
          </p>
        ) : null}
        {progress ? <p role="status">{progress}</p> : null}
        <form onSubmit={upload}>
          <label>
            Pin name
            <input
              value={uploadName}
              disabled={busy}
              required
              maxLength={200}
              onChange={(event) => setUploadName(event.target.value)}
            />
          </label>
          <p className="muted">
            {uploadSelection?.name} · {uploadFileCount}{" "}
            {uploadFileCount === 1 ? "file" : "files"} ·{" "}
            {formatSize(uploadSelection?.size ?? 0)}
          </p>
          <p className="muted">
            Up to 32 MiB including directory metadata. Empty folders are not
            included.
          </p>
          {!skipReminder ? (
            <div className="public-reminder">
              <strong>Uploaded content will be public</strong>
              <p>
                Anyone with the CID can read these bytes, even after unpinning.
                Downloaded or cached copies cannot be recalled. Do not upload
                sensitive information.
              </p>
              <label className="check">
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={rememberReminder}
                  onChange={(event) =>
                    setRememberReminder(event.target.checked)
                  }
                />
                Do not remind me in this browser
              </label>
            </div>
          ) : null}
          <div className="actions">
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setUploadSelection(null)}
            >
              Cancel
            </button>
            <button
              className="primary"
              disabled={busy || !uploadSelection || !uploadName.trim()}
            >
              Upload &amp; pin
            </button>
          </div>
        </form>
      </Dialog>
      <section className="pin-wall" aria-label="Your pins">
        <h1 className="visually-hidden">Your pins</h1>
        {!loaded ? (
          <p role="status">Loading your pins...</p>
        ) : !pins.length ? (
          <div className="canvas-empty">
            <h3>Keep something here.</h3>
            <p className="muted">
              Drop one file or folder here to make your first pin.
            </p>
          </div>
        ) : (
          <ul className="pin-list">
            {pins.map((pin) => (
              <PinCard
                key={pin.cid}
                pin={pin}
                previews={previews}
                busy={busy}
                onOpen={() => openPin(pin)}
                onCopyCid={(onCopied) => {
                  void copy(pin.cid, onCopied);
                }}
                onCopyLink={() => {
                  void copy(`${location.origin}/share/${pin.cid}`);
                }}
                onUnpin={() => unpin(pin)}
              />
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
      </section>
      <Dialog
        open={!!selected}
        title="Pin details"
        busy={busy}
        onClose={() => {
          setSelected(null);
          setRenaming(null);
        }}
      >
        {error ? (
          <p className="notice" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="notice success" role="status">
            {notice}
          </p>
        ) : null}
        {progress ? <p role="status">{progress}</p> : null}
        {selected ? (
          <div className="pin-detail">
            <h3>{selected.name}</h3>
            <button
              className="detail-cid"
              title="Copy full CID"
              aria-label={`Copy CID ${selected.cid}`}
              disabled={busy}
              onClick={() => {
                void copy(selected.cid);
              }}
            >
              <code className="cid">{selected.cid}</code>
            </button>
            <p className="muted">
              {formatSize(selected.size)} · {selected.blocks} blocks ·{" "}
              {new Date(selected.createdAt).toLocaleString()}
            </p>
            <div className="actions">
              <button
                disabled={busy}
                onClick={() =>
                  setRenaming({ cid: selected.cid, name: selected.name })
                }
              >
                Rename
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  void copy(`${location.origin}/share/${selected.cid}`);
                }}
              >
                Copy link
              </button>
              <a href={`/share/${selected.cid}`}>Open share ↗</a>
              <a href={`/api/public/${selected.cid}/car`}>
                Download complete CAR ↓
              </a>
              <button
                className="danger"
                disabled={busy}
                onClick={() => unpin(selected)}
              >
                Unpin
              </button>
            </div>
            {renaming ? (
              <form onSubmit={rename} aria-label={`Rename ${selected.name}`}>
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
                        cid: renaming.cid,
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
            <p className="muted policy">
              Unpinning removes only your account reference. Unreferenced
              content is retained for 7 days; downloaded and cached copies may
              remain.
            </p>
          </div>
        ) : null}
      </Dialog>
      <Dialog
        open={settingsOpen}
        title="Settings"
        busy={busy}
        onClose={() => setSettingsOpen(false)}
      >
        {error ? (
          <p role="alert" className="notice">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="notice success">
            {notice}
          </p>
        ) : null}
        <section>
          <div className="section-title">
            <h2>Let an agent help</h2>
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
            <button
              disabled={busy || !tokenScopes.length}
              className="secondary"
            >
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
            Revocation and expiry take effect immediately. History is kept for
            30 days from whichever happens first, then removed by scheduled
            cleanup.
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
        <OAuthGrants />
        <section className="browser-settings">
          <h3>Browser preferences</h3>
          <label className="check">
            <input
              type="checkbox"
              checked={!skipReminder}
              disabled={busy}
              onChange={(event) => {
                try {
                  if (event.target.checked)
                    localStorage.removeItem(publicReminderKey);
                  else localStorage.setItem(publicReminderKey, "true");
                  setSkipReminder(!event.target.checked);
                } catch {
                  setError(
                    "Could not save browser preferences. Try enabling browser storage.",
                  );
                }
              }}
            />
            Remind me that uploaded content is public
          </label>
          <p className="muted">
            Saved only in this browser. Not synced to your account or other
            devices.
          </p>
        </section>
        <p className="muted policy">
          Unpinning removes only your account reference. Shared blocks are never
          deleted by another account. Content without any account or DAG
          reference is retained for 7 days before scheduled cleanup. CDN, other
          nodes and downloaded copies may remain; there is no restore or
          permanent-delete action.
        </p>
      </Dialog>
    </div>
  );
}

export function PinCard({
  pin,
  previews,
  busy,
  onOpen,
  onCopyCid,
  onCopyLink,
  onUnpin,
}: {
  pin: Pin;
  previews?: PreviewClient;
  busy: boolean;
  onOpen: () => void;
  onCopyCid: (onCopied: () => void) => void;
  onCopyLink: () => void;
  onUnpin: () => void;
}) {
  const menuId = useId();
  const menu = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [copyConfirmation, setCopyConfirmation] = useState<number | null>(null);
  const copySequence = useRef(0);
  const copied = copyConfirmation !== null;
  useEffect(() => {
    if (copyConfirmation === null) return;
    const timer = setTimeout(() => setCopyConfirmation(null), 1500);
    return () => clearTimeout(timer);
  }, [copyConfirmation]);
  const closeMenu = () => {
    menu.current?.hidePopover();
    menuTrigger.current?.focus();
  };
  const openMenu = (point?: { x: number; y: number }, last = false) => {
    const popover = menu.current;
    const trigger = menuTrigger.current;
    if (busy || !popover || !trigger) return;
    const anchor = trigger.getBoundingClientRect();
    popover.showPopover();
    const bounds = popover.getBoundingClientRect();
    popover.style.left = `${Math.max(8, Math.min(point?.x ?? anchor.right - bounds.width, window.innerWidth - bounds.width - 8))}px`;
    popover.style.top = `${Math.max(8, Math.min(point?.y ?? anchor.bottom + 4, window.innerHeight - bounds.height - 8))}px`;
    const items =
      popover.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    items[last ? items.length - 1 : 0]?.focus();
  };
  useEffect(() => {
    if (busy) menu.current?.hidePopover();
  }, [busy]);
  useEffect(() => {
    if (!menuOpen) return;
    const dismiss = () => menu.current?.hidePopover();
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && menu.current?.contains(event.target))
        return;
      dismiss();
    };
    window.addEventListener("resize", dismiss);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", dismiss);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [menuOpen]);
  const copyCid = () => {
    setCopyConfirmation(null);
    onCopyCid(() => setCopyConfirmation(++copySequence.current));
  };
  return (
    <li
      className={`pin-card${copied ? " copy-confirmed" : ""}`}
      onContextMenu={(event) => {
        if (busy) return;
        event.preventDefault();
        openMenu({ x: event.clientX, y: event.clientY });
      }}
      onKeyDown={(event) => {
        if (
          event.key === "ContextMenu" ||
          (event.shiftKey && event.key === "F10")
        ) {
          event.preventDefault();
          openMenu();
        }
      }}
    >
      <PinPreview pin={pin} client={previews} />
      <button
        type="button"
        className="pin-open"
        aria-label={`View details for ${pin.name}`}
        disabled={busy}
        onClick={onOpen}
      />
      <button
        ref={menuTrigger}
        type="button"
        className="pin-menu-trigger"
        aria-label={`Pin options for ${pin.name}`}
        aria-haspopup="menu"
        aria-controls={menuId}
        aria-expanded={menuOpen}
        disabled={busy}
        onClick={() => {
          if (menu.current?.matches(":popover-open")) closeMenu();
          else openMenu();
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openMenu(undefined, event.key === "ArrowUp");
          }
        }}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <circle cx="5" cy="12" r="1" />
          <circle cx="12" cy="12" r="1" />
          <circle cx="19" cy="12" r="1" />
        </svg>
      </button>
      <div
        ref={menu}
        id={menuId}
        popover="auto"
        className="pin-context-menu"
        role="menu"
        aria-label={`Pin options for ${pin.name}`}
        onToggle={(event) => setMenuOpen(event.newState === "open")}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onKeyDown={(event) => {
          const items = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>(
              '[role="menuitem"]',
            ),
          );
          const index = items.findIndex(
            (item) => item === document.activeElement,
          );
          let next: number;
          switch (event.key) {
            case "ArrowDown":
              next = (index + 1) % items.length;
              break;
            case "ArrowUp":
              next = (index - 1 + items.length) % items.length;
              break;
            case "Home":
              next = 0;
              break;
            case "End":
              next = items.length - 1;
              break;
            case "Escape":
            case "Tab":
              if (event.key === "Escape") event.preventDefault();
              event.stopPropagation();
              closeMenu();
              return;
            default:
              return;
          }
          event.preventDefault();
          items[next]?.focus();
        }}
      >
        {[
          { label: "View details", action: onOpen },
          { label: "Copy link", action: onCopyLink },
          { label: "Copy CID", action: copyCid },
          { label: "Unpin", action: onUnpin },
        ].map(({ label, action }) => (
          <button
            key={label}
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={label === "Unpin" ? "danger" : undefined}
            disabled={busy}
            onClick={() => {
              closeMenu();
              action();
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="pin-info">
        <div className="pin-info-summary">
          <strong className="pin-name" title={pin.name}>
            {pin.name}
          </strong>
          <span className="pin-size">{formatSize(pin.size)}</span>
        </div>
        <div className="pin-info-cid">
          <button
            type="button"
            className="pin-cid"
            aria-label={`Copy CID for ${pin.name}`}
            title={`Copy full CID: ${pin.cid}`}
            disabled={busy}
            onClick={copyCid}
          >
            <code>{copied ? "CID copied" : pin.cid}</code>
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              {copied ? (
                <path d="m5 12 4 4L19 6" />
              ) : (
                <>
                  <rect x="9" y="9" width="11" height="11" rx="2" />
                  <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
                </>
              )}
            </svg>
            <span className="visually-hidden" role="status">
              {copied ? "CID copied" : ""}
            </span>
          </button>
        </div>
      </div>
    </li>
  );
}

export function formatSize(size: number): string {
  return size < 1024
    ? `${size} B`
    : size < 1024 * 1024
      ? `${(size / 1024).toFixed(1)} KiB`
      : `${(size / 1024 / 1024).toFixed(1)} MiB`;
}
