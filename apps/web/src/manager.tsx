import type {
  AgentToken,
  Pin,
  Publication,
  PublicationResult,
} from "@shazhou/pinboard-contracts";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type DragEvent as ReactDragEvent,
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
import { apiFetch, ApiRequestError } from "./api.js";
import { Icon } from "./icon.js";
import {
  DeletedDialog,
  PublicationDialog,
  PublicationPreview,
} from "./publications.js";
import { BackgroundSettings } from "./background.js";
import { SettingsDialog, type SettingsCategory } from "./settings.js";
import {
  AuthorizationTable,
  AuthorizationToolbar,
  authorizationMatches,
  fetchTokenViews,
  tokenStatus,
} from "./authorizations.js";
import { NodeDescriptionEditor } from "./node-description.js";
import { DetailMenu, discardDetailsDraft } from "./detail-actions.js";
import { useItemLists } from "./item-filter.js";
import { useActionItems } from "./action-items.js";
import { LoadingIndicator, LoadingReveal } from "./loading.js";

const pinDragType = "application/x-pinboard-pin";
type UploadTarget = Pin | Publication;

export const publicReminderKey = "pinboard:skip-public-upload-reminder";
export async function requestJson<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await apiFetch(path, init);
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message =
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof body.error === "string"
        ? body.error
        : `HTTP ${response.status}`;
    throw new ApiRequestError(message, response.status);
  }
  return response.status === 204
    ? (undefined as T)
    : ((await response.json()) as T);
}

export async function publishUploadedPin(
  pin: Pin,
  target: Publication | { title: string },
): Promise<PublicationResult> {
  const existing = "id" in target;
  const requestId = crypto.randomUUID();
  try {
    return await requestJson<PublicationResult>(
      existing ? `/api/publications/${target.id}/publish` : "/api/publications",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          existing
            ? { cid: pin.cid, expectedSequence: target.sequence, requestId }
            : {
                cid: pin.cid,
                title: target.title.trim(),
                public: true,
                requestId,
              },
        ),
      },
    );
  } catch (failure) {
    throw new Error(
      `Upload succeeded; publication failed or is unconfirmed. Pin ${pin.cid} is preserved. Retry publication request ${requestId}${existing ? ` with sequence ${target.sequence}, or refresh its details` : " with the same public title"}. ${failure instanceof Error ? failure.message : String(failure)}`,
    );
  }
}

export function AccountManager({
  accountId,
  renderHeader,
}: {
  accountId?: string | undefined;
  renderHeader: (
    onSettings: () => void,
    disabled: boolean,
    filter: ReactNode,
  ) => ReactNode;
}) {
  const previews = useMemo(() => new PreviewClient(accountId), [accountId]);
  useEffect(() => previews.attach(), [previews]);
  const lists = useItemLists(accountId);
  const { pins, publications, cursor, publicationCursor, loaded } = lists;
  const [selectedPublication, setSelectedPublication] =
    useState<Publication | null>(null);
  const [publishingPin, setPublishingPin] = useState<Pin | null>(null);
  const [converting, setConverting] = useState(false);
  const [linkTarget, setLinkTarget] = useState("");
  const [uploadTarget, setUploadTarget] = useState<UploadTarget | null>(null);
  const pickerTarget = useRef<UploadTarget | null>(null);
  const conversionRequest = useRef<{
    payload: string;
    requestId: string;
  } | null>(null);
  const [deletedOpen, setDeletedOpen] = useState(false);
  const [uploadPublication, setUploadPublication] = useState("");
  const [uploadPublicTitle, setUploadPublicTitle] = useState("");
  const [tokens, setTokens] = useState<AgentToken[]>([]);
  const [includeInactiveTokens, setIncludeInactiveTokens] = useState(false);
  const [tokenQuery, setTokenQuery] = useState("");
  const tokenRequest = useRef(0);
  const tokenIncludeInactive = useRef(false);
  tokenIncludeInactive.current = includeInactiveTokens;
  const [selected, setSelected] = useState<Pin | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [descriptionBusy, setDescriptionBusy] = useState(false);
  const [descriptionDirty, setDescriptionDirty] = useState(false);
  const [renaming, setRenaming] = useState<{
    cid: string;
    name: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploadSelection, setUploadSelection] =
    useState<UploadSelection | null>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState("");
  const filePicker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsOpener = useRef<HTMLElement | null>(null);
  const [settingsCategory, setSettingsCategory] =
    useState<SettingsCategory>("General");
  const [tokenFormOpen, setTokenFormOpen] = useState(false);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [tokensLoading, setTokensLoading] = useState(true);
  const [tokensError, setTokensError] = useState("");
  const [skipReminder, setSkipReminder] = useState(false);
  const [rememberReminder, setRememberReminder] = useState(false);
  const [uploadName, setUploadName] = useState("");
  const [tokenName, setTokenName] = useState("");
  const [tokenScopes, setTokenScopes] = useState(["pins:read"]);
  const [expires, setExpires] = useState(30);
  const [newToken, setNewToken] = useState("");
  const publicationDialogOpen =
    !!selectedPublication || !!publishingPin || deletedOpen;
  const actionItems = useActionItems(
    uploadSelection
      ? "upload"
      : selectedPublication
        ? `publication:${selectedPublication.id}`
        : publishingPin
          ? `pin:${publishingPin.cid}`
          : "",
    !!selectedPublication && !uploadSelection,
    (!!uploadSelection && uploadPublication !== "convert") ||
      (!!publishingPin && !converting),
  );

  const selectedCid = selected?.cid;
  useEffect(() => {
    if (!selectedCid) {
      setDetailsLoading(false);
      return;
    }
    const controller = new AbortController();
    setDetailsLoading(true);
    void requestJson<Pin>(`/api/pins/${selectedCid}`, {
      signal: controller.signal,
    })
      .then((pin) => {
        if (!controller.signal.aborted)
          setSelected((current) =>
            current?.cid === selectedCid ? pin : current,
          );
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailsLoading(false);
      });
    return () => controller.abort();
  }, [selectedCid]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

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
    await Promise.all([lists.refresh(), loadTokens()]);
  };
  const loadTokens = async () => {
    const revision = ++tokenRequest.current;
    setTokensLoading(true);
    setTokensError("");
    try {
      const records = await fetchTokenViews(
        (view) =>
          requestJson<{ tokens: AgentToken[] }>(`/api/tokens?view=${view}`),
        tokenIncludeInactive.current,
      );
      if (revision === tokenRequest.current) setTokens(records);
    } catch (failure) {
      if (revision === tokenRequest.current)
        setTokensError(
          failure instanceof Error ? failure.message : String(failure),
        );
      throw failure;
    } finally {
      if (revision === tokenRequest.current) setTokensLoading(false);
    }
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
    void loadTokens().catch(() => {});
    return () => {
      tokenRequest.current++;
    };
  }, [includeInactiveTokens]);

  const copy = (text: string, onCopied?: () => void) =>
    perform(async () => {
      await navigator.clipboard.writeText(text);
      if (onCopied) onCopied();
      else setNotice("Copied to clipboard.");
    });
  const choose = (
    prepare: () => UploadSelection | Promise<UploadSelection>,
    target: UploadTarget | null = null,
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
      conversionRequest.current = null;
      setUploadTarget(target);
      setUploadPublication(
        target && "id" in target ? target.id : target ? "convert" : "",
      );
      setUploadPublicTitle("");
      if (target) {
        setSelected(null);
        setSelectedPublication(null);
        setRenaming(null);
      }
      setUploadSelection(selection);
    });
  };
  useEffect(() => {
    let depth = 0;
    const enter = (event: DragEvent) => {
      if (event.target instanceof Element && event.target.closest(".pin-card"))
        return;
      if (!event.dataTransfer?.types.includes("Files")) return;
      depth++;
      setDragging(
        !busy &&
          !settingsOpen &&
          !uploadSelection &&
          !selected &&
          !publicationDialogOpen,
      );
    };
    const over = (event: DragEvent) => {
      if (
        event.defaultPrevented ||
        (event.target instanceof Element && event.target.closest(".pin-card"))
      )
        return;
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect =
        busy ||
        settingsOpen ||
        uploadSelection ||
        selected ||
        publicationDialogOpen
          ? "none"
          : "copy";
      setDragging(
        !busy &&
          !settingsOpen &&
          !uploadSelection &&
          !selected &&
          !publicationDialogOpen,
      );
    };
    const leave = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      if (
        event.defaultPrevented ||
        (event.target instanceof Element && event.target.closest(".pin-card"))
      )
        return;
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      depth = 0;
      setDragging(false);
      if (
        settingsOpen ||
        uploadSelection ||
        selected ||
        publicationDialogOpen
      ) {
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
  }, [busy, settingsOpen, uploadSelection, selected, publicationDialogOpen]);
  const upload = (event: FormEvent) => {
    event.preventDefault();
    const publicationTarget = actionItems.publications.find(
      (item) => item.id === uploadPublication,
    );
    if (
      uploadPublication &&
      uploadPublication !== "create" &&
      uploadPublication !== "convert" &&
      (actionItems.loading || actionItems.error || !publicationTarget)
    ) {
      setError(
        "Publication choices are unavailable. Retry loading before uploading.",
      );
      return;
    }
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
    if (
      (uploadPublication === "create" || uploadPublication === "convert") &&
      (!uploadPublicTitle.trim() || uploadPublicTitle.trim().length > 200)
    ) {
      setError("Enter a public title containing 1-200 characters.");
      return;
    }
    void perform(async () => {
      let converted: Publication | null = null;
      if (
        uploadPublication === "convert" &&
        uploadTarget &&
        !("id" in uploadTarget)
      ) {
        const payload = JSON.stringify({
          cid: uploadTarget.cid,
          title: uploadPublicTitle.trim(),
        });
        if (conversionRequest.current?.payload !== payload)
          conversionRequest.current = {
            payload,
            requestId: crypto.randomUUID(),
          };
        const requestId = conversionRequest.current.requestId;
        let result: PublicationResult;
        try {
          result = await requestJson<PublicationResult>(
            `/api/pins/${uploadTarget.cid}/convert`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                title: uploadPublicTitle.trim(),
                public: true,
                requestId,
              }),
            },
          );
        } catch (failure) {
          throw new Error(
            `Conversion failed or is unconfirmed. No upload was attempted. Retry the identical public title and request ${requestId}, or refresh to check. ${failure instanceof Error ? failure.message : String(failure)}`,
          );
        }
        converted = result.publication;
        await lists.refresh();
      }
      try {
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
        if (uploadPublication) {
          const target =
            converted ??
            (uploadPublication === "create"
              ? { title: uploadPublicTitle }
              : publicationTarget);
          if (!target)
            throw new Error(
              `Upload succeeded (${pin.cid}); publication no longer selected. Pin preserved.`,
            );
          const result = await publishUploadedPin(pin, target);
          setNotice(
            (result.status === "nop"
              ? "Uploaded. Already current; no version was created and draft description changes were not applied."
              : "Uploaded and published.") +
              (lists.filtered ? " Clear the filter to see all items." : ""),
          );
          await refresh();
          return;
        }
        await refresh();
        setNotice(
          lists.filtered
            ? "Pinned. These bytes are now public. Clear the filter to see all items."
            : "Pinned. These bytes are now public.",
        );
      } catch (failure) {
        await lists.refresh();
        if (converted) {
          setUploadSelection(null);
          throw new Error(
            `Conversion succeeded: publication ${converted.id} retains original content as v1. Upload/publish did not complete; refresh before retrying. ${failure instanceof Error ? failure.message : String(failure)}`,
          );
        }
        throw failure;
      }
    });
  };
  const pickFor = (target: UploadTarget, folder: boolean) => {
    pickerTarget.current = target;
    const picker = folder ? folderPicker.current : filePicker.current;
    if (picker) {
      picker.value = "";
      picker.click();
    }
  };
  const cardDrop = (event: ReactDragEvent, target: UploadTarget) => {
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
    if (
      busy ||
      settingsOpen ||
      uploadSelection ||
      selected ||
      publicationDialogOpen
    )
      return;
    if (event.dataTransfer.types.includes(pinDragType)) {
      if (!("id" in target)) return;
      const source = pins.find(
        (pin) => pin.cid === event.dataTransfer.getData(pinDragType),
      );
      if (!source) return;
      setConverting(false);
      setLinkTarget(target.id);
      setPublishingPin(source);
    } else if (event.dataTransfer.types.includes("Files")) {
      const items = Array.from(event.dataTransfer.items);
      choose(() => selectionFromDrop(items), target);
    }
  };
  const createAgent = (event: FormEvent) => {
    event.preventDefault();
    if (busy || oauthBusy || newToken || !tokenScopes.length) return;
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
      setSelected((previous) => (previous?.cid === pin.cid ? pin : previous));
      await lists.refresh();
      setRenaming(null);
      setNotice("Pin renamed. CID and public content are unchanged.");
    });
  };
  const openPin = (pin: Pin) => {
    setSelected(pin);
    setDetailsLoading(true);
    setRenaming(null);
    setError("");
    setNotice("");
    setProgress("");
  };
  const unpin = (pin: Pin) => {
    if (
      !window.confirm(
        "Move this pin to recently deleted? Restore within 30 days. Publications keep their own references. Public copies elsewhere may remain.",
      )
    )
      return;
    void perform(async () => {
      await requestJson(`/api/pins/${pin.cid}`, { method: "DELETE" });
      setSelected(null);
      setRenaming(null);
      await refresh();
      setNotice(
        "Moved to recently deleted. Restore within 30 days in Settings. Publication references and public copies remain independent.",
      );
    });
  };
  const uploadFileCount =
    uploadSelection?.kind === "folder"
      ? uploadSelection.files.length
      : uploadSelection
        ? 1
        : 0;
  const visibleTokens = tokens.filter((token) =>
    authorizationMatches(
      token.name,
      token.scopes,
      tokenStatus(token),
      tokenQuery,
      includeInactiveTokens,
    ),
  );
  return (
    <div
      className={`manager canvas${dragging ? " drag-active" : ""}`}
      aria-busy={busy}
    >
      {renderHeader(
        () => {
          settingsOpener.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
          setSettingsCategory("General");
          setSettingsOpen(true);
        },
        busy ||
          settingsOpen ||
          !!uploadSelection ||
          !!selected ||
          publicationDialogOpen,
        lists.filter,
      )}
      {dragging ? (
        <div className="canvas-drop" aria-hidden="true">
          Drop one file or folder to make a pin
        </div>
      ) : null}
      <Snackbar
        message={
          error ||
          progress ||
          (detailsLoading ? "Loading pin details..." : notice)
        }
        error={!!error}
        busy={busy}
        onReload={() => {
          void perform(refresh);
        }}
      />
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
            disabled={
              busy ||
              !!uploadSelection ||
              settingsOpen ||
              !!selected ||
              publicationDialogOpen
            }
            onClick={() => {
              if (filePicker.current) {
                pickerTarget.current = null;
                filePicker.current.value = "";
                filePicker.current.click();
              }
            }}
          >
            <Icon name="add" />
          </button>
          <div className="add-options" id="add-options">
            <button
              type="button"
              className="floating-button secondary"
              aria-label="Choose folder"
              title="Choose folder"
              disabled={
                busy ||
                !!uploadSelection ||
                settingsOpen ||
                !!selected ||
                publicationDialogOpen
              }
              onClick={() => {
                if (folderPicker.current) {
                  pickerTarget.current = null;
                  folderPicker.current.value = "";
                  folderPicker.current.click();
                }
              }}
            >
              <Icon name="addFolder" />
            </button>
          </div>
        </div>
      </div>
      <PublicationDialog
        publication={selectedPublication}
        pin={publishingPin}
        pins={actionItems.pins}
        publications={actionItems.publications}
        choicesLoading={actionItems.loading}
        choicesError={actionItems.error}
        onRetryChoices={actionItems.retry}
        convert={converting}
        initialTarget={linkTarget}
        onClose={() => {
          setSelectedPublication(null);
          setPublishingPin(null);
          setConverting(false);
          setLinkTarget("");
        }}
        onChanged={refresh}
        onUploadFile={(publication) => pickFor(publication, false)}
        onUploadFolder={(publication) => pickFor(publication, true)}
      />
      <DeletedDialog
        open={deletedOpen}
        onClose={() => {
          setDeletedOpen(false);
          setSettingsCategory("Recently deleted");
          setSettingsOpen(true);
        }}
        onChanged={refresh}
      />
      <input
        ref={filePicker}
        aria-label="Choose file"
        type="file"
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          const target = pickerTarget.current;
          pickerTarget.current = null;
          if (file) choose(() => selectionForFile(file), target);
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
          const target = pickerTarget.current;
          pickerTarget.current = null;
          choose(() => selectionForDirectory(entries), target);
        }}
      />
      <Dialog
        open={!!uploadSelection}
        title={uploadTarget ? "Confirm targeted upload" : "Make a pin"}
        busy={busy}
        onClose={() => setUploadSelection(null)}
      >
        {error ? (
          <p role="alert" className="notice">
            {error}
          </p>
        ) : null}
        {progress ? <p role="status">{progress}</p> : null}
        {actionItems.loading ? (
          <p role="status">Loading publication choices...</p>
        ) : null}
        {actionItems.error ? (
          <div role="alert">
            <p>{actionItems.error}</p>
            <button type="button" onClick={actionItems.retry}>
              Retry publication choices
            </button>
          </div>
        ) : null}
        <form onSubmit={upload}>
          {uploadTarget ? (
            <p>
              {"id" in uploadTarget
                ? `Publish uploaded content to ${uploadTarget.title}. Current v${uploadTarget.currentRevision} and all previous versions remain in history.`
                : `Convert ${uploadTarget.name} in place: original content becomes v1; new uploaded content becomes v2 (identical current CID is NOP and does not apply draft description changes). Enter a separate public title. Cancel makes no changes. Conversion may succeed even if upload or publish fails.`}
            </p>
          ) : null}
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
          <label>
            After uploading
            <select
              value={uploadPublication}
              disabled={
                busy ||
                !!uploadTarget ||
                actionItems.loading ||
                !!actionItems.error
              }
              onChange={(event) => setUploadPublication(event.target.value)}
            >
              <option value="">Keep as a pin only</option>
              <option value="create">Create a publication</option>
              {uploadPublication === "convert" ? (
                <option value="convert">Convert target, then publish v2</option>
              ) : null}
              {actionItems.publications.map((item) => (
                <option key={item.id} value={item.id}>
                  Publish to {item.title} (current v{item.currentRevision})
                </option>
              ))}
            </select>
          </label>
          {uploadPublication ? (
            <p className="muted">
              New revisions publish the selected root's user descriptions too.
              Publishing the current CID is a NOP and does not apply draft
              description changes.
            </p>
          ) : null}
          {uploadPublication === "create" || uploadPublication === "convert" ? (
            <>
              <label>
                Public title
                <input
                  value={uploadPublicTitle}
                  disabled={busy}
                  required
                  maxLength={200}
                  onChange={(event) => setUploadPublicTitle(event.target.value)}
                />
              </label>
              <p className="muted">
                This title and the complete version history will be public. Your
                private pin name stays private. If publication fails, your
                uploaded pin is preserved.
              </p>
            </>
          ) : uploadPublication ? (
            <p className="muted">
              The publication's follow link will change. Its public title stays
              the same. If publication fails, your uploaded pin is preserved.
            </p>
          ) : null}
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
              disabled={
                busy ||
                !uploadSelection ||
                !uploadName.trim() ||
                (!!uploadPublication &&
                  uploadPublication !== "create" &&
                  uploadPublication !== "convert" &&
                  (actionItems.loading ||
                    !!actionItems.error ||
                    !actionItems.publications.some(
                      (item) => item.id === uploadPublication,
                    ))) ||
                ((uploadPublication === "create" ||
                  uploadPublication === "convert") &&
                  !uploadPublicTitle.trim())
              }
            >
              {uploadPublication ? "Upload & publish" : "Upload & pin"}
            </button>
          </div>
        </form>
      </Dialog>
      <section
        className="pin-wall"
        aria-label="Your pins"
        aria-busy={lists.loading}
      >
        <h1 className="visually-hidden">Your pins</h1>
        {loaded && lists.loading && !lists.error ? (
          <LoadingIndicator
            label={lists.filtered ? "Filtering..." : "Loading your pins..."}
            compact={loaded}
          />
        ) : null}
        <LoadingReveal
          loading={!loaded && !lists.error}
          label="Loading your pins..."
        >
          {lists.error ? (
            <div role="alert">
              <p>{lists.error}</p>
              <button type="button" onClick={() => void lists.refresh()}>
                Try again
              </button>
            </div>
          ) : !loaded ? null : !pins.length &&
            !publications.length &&
            !lists.loading ? (
            lists.filtered ? (
              <div className="canvas-empty">
                <p>No items match this filter.</p>
                <button type="button" onClick={lists.clear}>
                  Clear filter
                </button>
              </div>
            ) : (
              <div className="canvas-empty">
                <h3>Keep something here.</h3>
                <p className="muted">
                  Drop one file or folder here to make your first pin.
                </p>
              </div>
            )
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
                  onDrop={(event) => cardDrop(event, pin)}
                  onTargetEnter={() => setDragging(false)}
                />
              ))}
              {publications.map((publication) => (
                <PinCard
                  key={`publication:${publication.id}`}
                  pin={{
                    cid: publication.current.cid,
                    name: publication.title,
                    size: publication.current.size,
                    blocks: publication.current.blocks,
                    createdAt: publication.createdAt,
                  }}
                  publication={publication}
                  busy={busy}
                  onOpen={() => setSelectedPublication(publication)}
                  onCopyCid={(onCopied) => {
                    void copy(publication.current.cid, onCopied);
                  }}
                  onDrop={(event) => cardDrop(event, publication)}
                  onTargetEnter={() => setDragging(false)}
                />
              ))}
            </ul>
          )}
          {cursor ? (
            <button
              disabled={busy || lists.loading || !!lists.error}
              onClick={() => {
                void lists.loadMore("pins");
              }}
            >
              Load more
            </button>
          ) : null}
          {publicationCursor ? (
            <button
              disabled={busy || lists.loading || !!lists.error}
              onClick={() => {
                void lists.loadMore("publications");
              }}
            >
              Load more publications
            </button>
          ) : null}
        </LoadingReveal>
      </section>
      <Dialog
        open={!!selected}
        title="Pin details"
        className="reading-dialog"
        returnFocusKey={selected ? `pin:${selected.cid}` : undefined}
        busy={busy || descriptionBusy}
        dismissOnOutsideClick
        onClose={() => {
          if (!discardDetailsDraft(descriptionDirty || !!renaming)) return;
          setSelected(null);
          setDetailsLoading(false);
          setRenaming(null);
        }}
      >
        {selected ? (
          <div className="pin-detail" aria-busy={busy || detailsLoading}>
            {error ? <p role="alert">{error}</p> : null}
            <h3>{selected.name}</h3>
            <p className="muted">
              Fixed content · {formatSize(selected.size)} · Private Pin ·{" "}
              <code>
                {selected.cid.slice(0, 12)}…{selected.cid.slice(-6)}
              </code>
            </p>
            <div
              className="actions detail-toolbar"
              aria-label="Pin actions"
              inert={busy || descriptionBusy || descriptionDirty || !!renaming}
            >
              <DetailMenu label="Share">
                <button
                  disabled={busy || detailsLoading}
                  onClick={() => {
                    void copy(`${location.origin}/share/${selected.cid}`);
                  }}
                >
                  Copy fixed content link
                </button>
                <button
                  disabled={busy || detailsLoading}
                  onClick={() => {
                    void copy(selected.cid);
                  }}
                >
                  Copy CID
                </button>
                <a href={`/share/${selected.cid}`}>
                  Open share <Icon name="externalLink" size={16} />
                </a>
                <p className="muted">
                  Fixed content link. Private name and description are not
                  shared.
                </p>
              </DetailMenu>
              <DetailMenu label="Download">
                <a
                  href={`/api/public/${selected.cid}/download?name=${encodeURIComponent(selected.name)}`}
                >
                  Download file / ZIP <Icon name="download" size={16} />
                </a>
                <a href={`/api/public/${selected.cid}/car`}>
                  Download complete CAR <Icon name="download" size={16} />
                </a>
              </DetailMenu>
              <DetailMenu label="More">
                <button
                  disabled={busy || detailsLoading}
                  onClick={() => {
                    void perform(async () => {
                      const pin = await requestJson<Pin>(
                        `/api/pins/${selected.cid}`,
                      );
                      setSelected(pin);
                    });
                  }}
                >
                  Refresh pin details
                </button>
                <button
                  disabled={busy || detailsLoading}
                  onClick={() => {
                    setConverting(false);
                    setLinkTarget("");
                    setPublishingPin(selected);
                    setSelected(null);
                  }}
                >
                  Add to a publication
                </button>
                <button
                  disabled={busy || detailsLoading}
                  onClick={() => {
                    setConverting(true);
                    setLinkTarget("");
                    setPublishingPin(selected);
                    setSelected(null);
                  }}
                >
                  Convert to publication
                </button>
                <details>
                  <summary>Convert &amp; upload</summary>
                  <button
                    disabled={busy || detailsLoading}
                    onClick={() => pickFor(selected, false)}
                  >
                    Choose file for conversion
                  </button>
                  <button
                    disabled={busy || detailsLoading}
                    onClick={() => pickFor(selected, true)}
                  >
                    Choose folder for conversion
                  </button>
                </details>
                <button
                  disabled={busy || detailsLoading}
                  onClick={() =>
                    setRenaming({ cid: selected.cid, name: selected.name })
                  }
                >
                  Rename
                </button>
                <button
                  className="danger"
                  disabled={busy || detailsLoading}
                  onClick={() => unpin(selected)}
                >
                  Move to recently deleted
                </button>
                <p className="muted policy">
                  Restore within 30 days. Publication references remain
                  independent; public CID bytes and external copies cannot be
                  recalled.
                </p>
              </DetailMenu>
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
                    onClick={() => {
                      setRenaming(null);
                      requestAnimationFrame(() =>
                        document
                          .querySelector<HTMLElement>(
                            "dialog[open] .detail-toolbar > .detail-menu:last-child > summary",
                          )
                          ?.focus(),
                      );
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : null}
            <NodeDescriptionEditor
              key={selected.cid}
              rootCid={selected.cid}
              name={selected.name}
              readingFirst
              onChanged={lists.refresh}
              onBusyChange={setDescriptionBusy}
              onDirtyChange={setDescriptionDirty}
              facts={
                <p className="muted">
                  {formatSize(selected.size)} · {selected.blocks} blocks
                  <br />
                  Added {new Date(selected.createdAt).toLocaleString()}
                </p>
              }
            />
          </div>
        ) : null}
      </Dialog>
      <SettingsDialog
        open={settingsOpen}
        busy={busy || oauthBusy}
        onClose={() => {
          if (busy || oauthBusy || tokenFormOpen) return;
          setSettingsOpen(false);
          requestAnimationFrame(() => settingsOpener.current?.focus());
        }}
        category={settingsCategory}
        onCategory={setSettingsCategory}
        secretPending={!!newToken}
        error={error}
        panels={{
          "Recently deleted": (
            <>
              <section>
                <h2>Recently deleted</h2>
                <p className="muted">
                  Pins and publications can be restored for 30 days with their
                  original identity and links.
                </p>
                <button
                  disabled={busy || oauthBusy}
                  onClick={() => {
                    setSettingsOpen(false);
                    setDeletedOpen(true);
                  }}
                >
                  Open recently deleted
                </button>
              </section>
              <p className="muted policy">
                Deleted pins and publications are recoverable for 30 days.
                Expiry releases only their own references. The last reference
                then starts seven days of cleanup grace. CDN, other nodes and
                downloaded copies may remain. There is no permanent-delete
                action.
              </p>
            </>
          ),
          "Access tokens": (
            <>
              <section className="authorization">
                <div className="section-title">
                  <h2>Access tokens</h2>
                </div>
                <AuthorizationToolbar
                  name="access tokens"
                  query={tokenQuery}
                  onQuery={setTokenQuery}
                  includeInactive={includeInactiveTokens}
                  onIncludeInactive={setIncludeInactiveTokens}
                  disabled={busy || oauthBusy}
                  action={
                    <button
                      type="button"
                      className="primary glyph-button"
                      title={
                        newToken
                          ? "Copy new access token"
                          : "Create access token"
                      }
                      aria-label={
                        newToken
                          ? "Copy new access token"
                          : "Create access token"
                      }
                      disabled={busy || oauthBusy}
                      onClick={() => setTokenFormOpen(true)}
                    >
                      <Icon name={newToken ? "copy" : "add"} />
                    </button>
                  }
                />
                {newToken && (
                  <button
                    type="button"
                    className="settings-secret-reminder"
                    onClick={() => setTokenFormOpen(true)}
                  >
                    A new token is still shown only once. Return to copy token
                  </button>
                )}
                <Dialog
                  open={settingsOpen && tokenFormOpen}
                  title="Create access token"
                  busy={busy || oauthBusy}
                  dismissOnOutsideClick
                  glyphClose
                  className="token-create-dialog"
                  onClose={() => {
                    if (!busy && !oauthBusy) setTokenFormOpen(false);
                  }}
                >
                  {error && (
                    <p role="alert" className="notice">
                      {error}
                    </p>
                  )}
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
                      {[
                        "pins:read",
                        "pins:write",
                        "pins:delete",
                        "publications:read",
                        "publications:write",
                        "publications:delete",
                      ].map((scope) => (
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
                      disabled={
                        busy || oauthBusy || !tokenScopes.length || !!newToken
                      }
                      className="secondary"
                    >
                      Create access token
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
                          disabled={busy || oauthBusy}
                          onClick={() => {
                            void copy(newToken);
                          }}
                        >
                          Copy token
                        </button>
                        <button
                          disabled={busy || oauthBusy}
                          onClick={() => setNewToken("")}
                        >
                          Dismiss
                        </button>
                      </div>
                    </div>
                  ) : null}
                </Dialog>
                <AuthorizationTable
                  name="access tokens"
                  firstColumn="Name"
                  loading={tokensLoading}
                  error={tokensError}
                  empty={
                    !visibleTokens.length
                      ? tokenQuery.trim()
                        ? "No matching access tokens."
                        : includeInactiveTokens
                          ? "No access tokens."
                          : "No active access tokens."
                      : ""
                  }
                  retry={
                    <button
                      disabled={busy || oauthBusy}
                      onClick={() => {
                        void perform(loadTokens);
                      }}
                    >
                      Retry access tokens
                    </button>
                  }
                >
                  {visibleTokens.map((token) => {
                    const status = tokenStatus(token);
                    return (
                      <tr key={token.id}>
                        <td>
                          <strong>{token.name}</strong>
                          <small>{token.prefix}…</small>
                        </td>
                        <td>
                          <code>{token.scopes}</code>
                        </td>
                        <td>{new Date(token.expiresAt).toLocaleString()}</td>
                        <td>
                          <span
                            className={`authorization-badge${status === "Active" ? " active" : ""}`}
                          >
                            {status}
                          </span>
                        </td>
                        <td>
                          {status === "Active" ? (
                            <button
                              type="button"
                              className="glyph-button danger"
                              title={`Revoke ${token.name}`}
                              aria-label={`Revoke ${token.name}`}
                              disabled={busy || oauthBusy}
                              onClick={() => {
                                void perform(async () => {
                                  if (tokenStatus(token) !== "Active") return;
                                  await requestJson(`/api/tokens/${token.id}`, {
                                    method: "DELETE",
                                  });
                                  await refresh();
                                  setNotice("Token revoked.");
                                });
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
                <output className="authorization-count">
                  {tokensLoading || tokensError
                    ? "Records unavailable"
                    : `Showing ${visibleTokens.length} / ${tokens.length} records`}
                </output>
              </section>
            </>
          ),
          "OAuth authorizations": (
            <OAuthGrants disabled={busy} onBusyChange={setOauthBusy} />
          ),
          General: (
            <section>
              <h2>General</h2>
              <BackgroundSettings
                disabled={busy || oauthBusy}
                onError={setError}
              />
              <label className="check">
                <input
                  type="checkbox"
                  checked={!skipReminder}
                  disabled={busy || oauthBusy}
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
              <p className="muted policy">
                Disabling reminders does not make uploads private. Other nodes,
                CDN and downloaded copies may remain.
              </p>
              <section className="settings-mcp">
                <h2>Configure MCP</h2>
                <p>
                  Add this remote address in an MCP-compatible client, start its
                  OAuth connection, then confirm permissions in Pinboard.
                </p>
                <p>
                  MCP endpoint{" "}
                  <code>
                    {typeof location === "undefined"
                      ? "/mcp"
                      : `${location.origin}/mcp`}
                  </code>
                </p>
                <p>
                  Access tokens can also connect clients that support them.
                  Token names are labels, not identity; client names are not
                  proof of trust. Copy new keys when created: they are shown
                  only once and never appear in authorization tables.
                </p>
                <p>
                  Revocation and expiry take effect immediately; operations
                  already in flight may finish. Token history is kept for 30
                  days from revocation or expiry, whichever happens first, then
                  removed by scheduled cleanup. Enable Show inactive
                  authorizations on either authorization page to see retained
                  expired and revoked records. Expired authorizations do not
                  need to be revoked again.
                </p>
              </section>
            </section>
          ),
        }}
      />
    </div>
  );
}

export function Snackbar({
  message,
  error,
  busy,
  onReload,
}: {
  message: string;
  error: boolean;
  busy: boolean;
  onReload: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (message) ref.current?.showPopover();
    else ref.current?.hidePopover();
  }, [message]);
  return (
    <div
      ref={ref}
      popover="manual"
      className={`snackbar${error ? " snackbar-error" : ""}`}
      role={error ? "alert" : "status"}
      aria-atomic="true"
    >
      {message}
      {error ? (
        <button type="button" disabled={busy} onClick={onReload}>
          Reload
        </button>
      ) : null}
    </div>
  );
}

export function PinCard({
  pin,
  previews,
  busy,
  onOpen,
  onCopyCid,
  publication,
  onDrop,
  onTargetEnter,
}: {
  pin: Pin;
  previews?: PreviewClient;
  busy: boolean;
  onOpen: () => void;
  onCopyCid: (onCopied: () => void) => void;
  publication?: Publication;
  onDrop?: (event: ReactDragEvent) => void;
  onTargetEnter?: () => void;
}) {
  const [dropActive, setDropActive] = useState(false);
  const dragDepth = useRef(0);
  useEffect(() => {
    const reset = () => {
      dragDepth.current = 0;
      setDropActive(false);
    };
    document.addEventListener("dragend", reset);
    return () => document.removeEventListener("dragend", reset);
  }, []);
  const [copyConfirmation, setCopyConfirmation] = useState<number | null>(null);
  const copySequence = useRef(0);
  const copied = copyConfirmation !== null;
  useEffect(() => {
    if (copyConfirmation === null) return;
    const timer = setTimeout(() => setCopyConfirmation(null), 1500);
    return () => clearTimeout(timer);
  }, [copyConfirmation]);
  const copyCid = () => {
    setCopyConfirmation(null);
    onCopyCid(() => setCopyConfirmation(++copySequence.current));
  };
  return (
    <li
      className={`pin-card${copied ? " copy-confirmed" : ""}${dropActive ? " drop-target" : ""}`}
      draggable={!busy && !publication}
      onDragStart={(event) => {
        if (publication || busy) {
          event.preventDefault();
          return;
        }
        event.dataTransfer.setData(pinDragType, pin.cid);
        event.dataTransfer.effectAllowed = "link";
      }}
      onDragEnter={(event) => {
        if (!onDrop || busy) return;
        if (
          !event.dataTransfer.types.includes("Files") &&
          !(publication && event.dataTransfer.types.includes(pinDragType))
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        dragDepth.current++;
        onTargetEnter?.();
        setDropActive(true);
      }}
      onDragOver={(event) => {
        if (!onDrop || busy) return;
        const external = event.dataTransfer.types.includes("Files");
        const internal =
          publication && event.dataTransfer.types.includes(pinDragType);
        if (!external && !internal) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = internal ? "link" : "copy";
      }}
      onDragLeave={(event) => {
        event.stopPropagation();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDropActive(false);
      }}
      onDrop={(event) => {
        dragDepth.current = 0;
        setDropActive(false);
        onDrop?.(event);
      }}
    >
      {publication ? (
        <PublicationPreview
          key={`${publication.id}:${publication.currentRevision}`}
          publication={publication}
        />
      ) : (
        <PinPreview pin={pin} client={previews} />
      )}
      {publication ? (
        <span className="publication-badge" role="img" aria-label="Publication">
          <Icon name="publication" size={14} />
        </span>
      ) : null}
      <button
        type="button"
        className="pin-open"
        aria-label={`View details for ${publication ? "publication " : ""}${pin.name}`}
        data-detail-key={
          publication ? `publication:${publication.id}` : `pin:${pin.cid}`
        }
        disabled={busy}
        onClick={onOpen}
      />
      <div
        className="pin-info"
        role="group"
        aria-label={`${publication ? "Publication" : "Pin"} information for ${pin.name}`}
        tabIndex={0}
        onClick={(event) => {
          if (
            !busy &&
            !(event.target instanceof Element && event.target.closest("button"))
          )
            onOpen();
        }}
        onKeyDown={(event) => {
          if (
            !busy &&
            event.target === event.currentTarget &&
            (event.key === "Enter" || event.key === " ")
          ) {
            event.preventDefault();
            onOpen();
          }
        }}
      >
        <div className="pin-info-summary">
          <strong className="pin-name" title={pin.name}>
            {pin.name}
          </strong>
          <span className="pin-size">{formatSize(pin.size)}</span>
        </div>
        <div className="pin-info-cid">
          {publication ? (
            <div className="pin-publication-version">
              Current v{publication.currentRevision} ·{" "}
              {publication.revisionCount}{" "}
              {publication.revisionCount === 1 ? "version" : "versions"}
            </div>
          ) : null}
          <button
            type="button"
            className="pin-cid"
            aria-label={`Copy CID for ${pin.name}`}
            title={`Copy full CID: ${pin.cid}`}
            disabled={busy}
            onClick={copyCid}
          >
            <code>{copied ? "CID copied" : pin.cid}</code>
            <Icon name={copied ? "check" : "copy"} />
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
