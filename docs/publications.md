# Publications and recently deleted

A publication gives public immutable content a stable identity. Its random ID
does not depend on a title, email or private pin label. Publishing does not
convert or remove the source pin unless **Convert to publication** is explicitly
selected. Multiple publications may use the same CID. The title and **complete
revision and pointer history are public**; account identities and private pin
labels are not included.

## Web

Use a pin's **Publish new version** sidebar action to confirm conversion to a
new publication with an explicit public title. Original content becomes v1; the
next task chooses an owned Pin or file/folder upload for v2. Canceling the next
task does not undo the confirmed conversion. To publish a Pin into an existing
publication without converting it, drag it onto that publication or select it in
the publication's **Publish new version** task. The upload dialog also lets you
**Create a publication** with a separate explicit **Public title**, even when
you have no publications yet, or select an existing publication. The default
**Keep as a pin only** does not publish. Upload always finishes first; if
publication fails, the uploaded pin remains and the UI reports that partial
success.

Drop a file or folder **onto a publication card** to highlight that target and
confirm upload/publish. Drop onto a fixed Pin to confirm **conversion** with a
separate, required public title: original content becomes v1, then uploaded
content becomes v2. Cancel does not upload, convert or publish. If conversion
succeeds but upload/publish fails, the new publication and original v1 remain;
the error identifies this partial success. Dropping on blank space still makes a
Pin by default.

Dragging a fixed Pin onto a publication opens the link confirmation. It does not
upload, move, remove or rename the source, or change the target title. The **Add
to a publication** confirmation remains separate from conversion. The Pin's
sidebar **Publish new version** offers the conversion flow to keyboard and touch
users. Publication details → **Publish new version** offers file/folder upload
and an owned-Pin selector showing names and content facts; card context menus
are not required.

Explicit conversion needs no upload. It atomically replaces the Pin identity
with a new random-ID publication and original-content v1. The source Pin is not
put in trash, so restoring the publication cannot resurrect a duplicate static
card. Original CID links remain readable through publication retention. Ordinary
link and creation remain separate, non-destructive operations.

Pins and publications share the same 4:3 wall cards, preview spacing and
single-line name/size summary. A publication has a floating icon-only identity
badge in the top-right corner. Non-image wall previews use compact 12px top
padding while retaining 24px side padding; ordinary image previews remain
edge-to-edge. PDF image material instead uses the shared floating-paper layout:
full aspect ratio, upper-left PDF badge and a separate bottom information row,
including on touch and keyboard expansion. PDF cards have a 280px minimum height
so expanded metadata does not squeeze the page to an unrecognizable sliver on
narrow screens; ordinary cards retain their existing ratio. The Publication
badge stays at upper right. Unknown source types still display valid material;
missing material or an image-load failure uses the ordinary source-type icon,
not an error screen. The publication's **Current v3** and **5 versions**
information appears with the CID when the information strip expands on hover or
keyboard focus; touch devices keep that information visible. Rollback does not
erase later history. Open details to publish another owned pin, inspect the
public history, make an old version current, or delete.

- `/p/<id>` follows current.
- `/p/<id>/v/3` identifies fixed revision 3.
- `/p/<id>/history` shows the same public history.
- `/share/<cid>` continues to identify immutable bytes.

Copy actions explicitly distinguish follow links, fixed-version links and CID.
Previews use the existing safe text/image/directory renderers, not executable
HTML. Downloads resolve one actual CID before reading the complete content.

Details open on **current**, even when rollback leaves newer revisions in
history. **View vN** changes only the local reading context: content, public
description snapshot, size, date and CID. Click the title's version badge to
open a version drawer within the detail panel, distinguishing the viewed,
current and latest revisions. History is not permanently shown in the sidebar.
Selection closes the drawer; outside click and Escape also dismiss it, without a
close glyph. The inline CID/copy button copies the complete viewed CID; its
dropdown offers HTTP downloads, IPFS, follow and fixed-version links. The follow
link stays tied to the publication identity, while fixed links and file/ZIP/CAR
downloads use the viewed revision. **Make viewed vN current** in the drawer
requires confirmation and the actual publication sequence; it does not create a
revision. Publishing is a separate task using the current publication state,
never the browsed snapshot as a write baseline.

Public descriptions remain read-only immutable snapshots. Pin descriptions are
private and shown read-only until explicit editing; cancel restores the
original, conflicts preserve the draft, and unsaved closing requires
confirmation. Technical root/reachable-child queries are available through API,
CLI and MCP, not in the detail panel. Desktop content and description/history
columns stack on narrow screens; copying lives below the title and downloads
below the sidebar facts. The content preview reserves the same height while
loading and after content arrives (360px on desktop, 240px on narrow screens).
Long text, code and directory previews scroll inside that keyboard-focusable
region instead of resizing the details; images and PDF thumbnails fit within it.
Ready previews do not add explanatory footer lines. Generation status and
failure retry actions stay inside this fixed-height area rather than pushing the
content below it down.

Settings → **Trash** directly lists pins and publications in the same compact
table style as Tokens and OAuth, with deletion and expiry times and a restore
action. Search matches names and types across all pages. The footer shows the
total recoverable item count; previous/next controls appear only when needed (50
items per page). Restore refreshes the account and returns the table to its
first page without closing Settings. No permanent-delete action is offered.

The explicit local read-only UI preview includes single-version publications,
multiple independent publications sharing a CID, a v3-of-5 rollback state and
recently deleted items. Its write restrictions are unchanged.

## HTTP

Management endpoints use existing same-origin session or Agent-token checks.
OAuth credentials remain restricted to `/mcp`. JSON writes use
`Content-Type: application/json`.

| Method | Route                                    | Input / result                                                   |
| ------ | ---------------------------------------- | ---------------------------------------------------------------- |
| POST   | `/api/publications`                      | `{title,cid,public:true,requestId}`; first revision              |
| POST   | `/api/pins/:cid/convert`                 | `{title,public:true,requestId}`; atomic in-place conversion      |
| GET    | `/api/publications?cursor=...&q=...`     | owned active publications, `nextCursor`                          |
| GET    | `/api/publications/:id`                  | owned active publication                                         |
| POST   | `/api/publications/:id/publish`          | `{cid,expectedSequence,requestId}`                               |
| POST   | `/api/publications/:id/rollback`         | `{revision,expectedSequence,requestId}`                          |
| DELETE | `/api/publications/:id`                  | move entire publication to recently deleted                      |
| POST   | `/api/publications/:id/restore`          | restore before expiry                                            |
| GET    | `/api/recently-deleted?cursor=...&q=...` | owned recoverable `items`, `nextCursor`, `total`, `matchedTotal` |
| DELETE | `/api/pins/:cid`                         | move pin to recently deleted                                     |
| POST   | `/api/pins/:cid/restore`                 | restore before expiry                                            |

`publications:read` permits private publication listing and recovery listing.
Recovery counts exclude expired items and other accounts, respect read scopes,
and are independent of the cursor. `total` counts all visible recoverable items;
`matchedTotal` counts name/type search matches. The optional `q` filter uses a
case-insensitive literal substring (maximum 200 characters).
`publications:write` permits creation, publish and rollback; an existing-pin
target also requires `pins:read`. Upload additionally requires `pins:write`.
`publications:delete` permits deletion and restoration. Pin recovery uses
`pins:delete`; private recovery listing uses the respective object's read scope.
Old `pins:write` tokens do **not** acquire publication write authority. Issue a
new scoped token or explicitly consent to new OAuth scopes when needed.
Conversion requires `publications:write`, `pins:read` and `pins:delete`.

Targets must be active owned pins backed by a verified complete, ready DAG/CAR.
No remote content fetching is performed. Sequence checks, publication activity,
pin activity, storage fencing and retention insertion are rechecked in the D1
commit transaction.

### Homepage item filtering

`GET /api/pins` and `GET /api/publications` accept optional `q` alongside
`cursor`. The entire query is trimmed and matched as a Unicode-lowercased
literal substring against the name/title **or** user-entered root description.
Internal whitespace is preserved; `%` and `_` are literal. Pins use the
account's current private root description; publications use only the current
published revision's root description snapshot. CID, child descriptions, old
versions, previews and content are excluded.

Matching happens in the Worker before the unchanged 50-item result pagination
and CID/ID ordering. Omitted or whitespace-only `q` retains ordinary browsing.
Queries longer than 200 UTF-16 code units return 400. Each cursor must be used
with the same query; changing the query starts a new first page. Responses
remain the existing card contracts, without a total count or Pin descriptions.
Both listing responses use `Cache-Control: private, no-store`.

The authenticated homepage applies input after 200ms (or Enter), waits for IME
confirmation, and clears with Escape or Clear filter. Mobile uses a second
header row. Failed requests show retry rather than no-results. Metadata writes
refresh the current condition without closing an open Pin detail dialog. No
database migration or backfill is required: filtering reads authoritative
metadata directly. Nonempty queries scan candidate metadata server-side, so
large-account latency, D1 read volume and Worker memory should be assessed
before deployment; no full-account payload is sent to the browser.

### Concurrency and retry

Read `sequence`, then supply it as `expectedSequence`. A concurrent write yields
409 rather than silent last-writer-wins. Refresh before starting a new
operation. Supply a unique `requestId` (1–128 characters), retain it on network
failure, and retry **the identical payload with the same ID** to recover the
original result. Reusing an ID with a different payload yields 409. Request
results are persisted, including NOPs; a retry returns the original snapshot
even after current changes.

Publishing the canonical current CID returns `status: "nop"` without changing
revision count, sequence or update time. An outdated expected sequence still
conflicts, even for the current CID. A noncurrent historical CID creates the
next numbered revision; explicit rollback moves current without creating a
revision. Publish and rollback responses contain `{status, publication}`. **NOP
does not apply draft description changes.** Editing descriptions alone cannot
rewrite an already published version. Publishing a noncurrent CID creates a new
snapshot; rollback reuses the chosen version's original snapshot.

## User descriptions and system previews

Names belong to pinned-item identities, not content nodes. A publication title
is explicit public input; linking never copies a private name, changes either
item's name, or rewrites embedded file names/paths.

An optional user description is bounded pure text (8,000 characters, no NUL or
unsafe control characters). It is persisted as a sidecar keyed by **account +
retained root CID + reachable node CID**. The root and reachable child nodes are
supported; arbitrary attached CIDs and other accounts/roots cannot be read or
edited through this context. It remains private until explicitly published.

- `GET /api/pins/:root/nodes/:node/description` requires `pins:read`.
- `PUT` to that path requires `pins:read` + `pins:write` and strict JSON
  `{text: "plain text" | null, expectedVersion: 0}`. Read the actual version
  before updating. First write uses 0; each write/clear advances it. A stale
  version returns 409. `null` clears; `""` is a valid explicit empty value.
- The result is `{rootCid,nodeCid,description:{user:{text,version},preview}}`.
  `preview` is the same normalized `ContentPreview` used by private single/batch
  and public publication endpoints: source `contentType: string | null`, a
  discriminated `preview` material (image/markdown/text/directory) only when
  ready, otherwise null, plus version/status/truncated/reason and optional size.
  Node details use the same validated rendering and image fallback. Generation,
  retries and cleanup never write or delete the user sidecar.
- `GET /api/pins/:root/descriptions` explicitly exports
  `{rootCid,descriptions:{"nodeCID":"text"}}` for clients to save separately.
- `GET /api/public/publications/:id/versions/:revision/nodes/:node/description`
  uses that immutable revision's root, reachability and user snapshot, never a
  live account annotation. Its `user.version` identifies the public revision; it
  is not an editable CAS version. Public revision/history responses also include
  `descriptions` maps. The node endpoint supports ETags and checks deletion
  before 304, like the other publication routes. CLI
  `publication description ID NODE_CID --revision N` and MCP
  `publication_description({id,revision,nodeCid})` expose the same contextual
  public node response without requiring an active source Pin.

Creation/conversion/publish snapshot the entire selected root's user-description
map in the same D1 transaction as the revision. Later private edits, other
publications and source-pin expiry cannot alter it. Published descriptions
cannot be edited in place. Trashed Pins retain sidecars for 30-day recovery;
expiry releases only that owner/root's sidecars. Publication snapshots are
independent of source Pin and generated preview lifetimes.

Sidecars never alter raw CID/CAR bytes. Ordinary downloads/exports contain only
the original content, **not descriptions**; use the explicit metadata export or
revision JSON when you need both. The standalone Web node editor supports
root/child editing; root item details remain reading-focused. Public version
pages offer read-only node lookup.

### Web detail snapshots

Private and published node readers share a session-memory description client:
reopening shows an already authorized snapshot immediately while a real GET
revalidates descriptions, previews and access. Concurrent reads of the same
account/root/node or publication/revision/root/node are combined. Public
`current` links resolve history to an explicit revision before reading a node.
Snapshots are never persisted and are limited to 128 entries, 2 MiB total, 64
KiB per serialized UTF-8 response, and one hour since the last successful
response. Oversize responses still display but emit a cache-budget warning.

Private readers may initially display an existing account-scoped list preview
without inventing a user description or editable version. Preview persistence
failure warns and falls back to memory/network reads. Pending or failed system
previews invalidate old stable descriptors and keep the existing polling limits.
Saving broadcasts the PUT response to matching readers; an older GET cannot
overwrite it. Drafts retain their original optimistic-concurrency version during
refresh. Network/5xx failures keep displayed content and show a retry action;
401/403/404 and invalid responses withdraw protected or unverifiable content.
Account changes dispose the session; successful Unpin/publication deletion
invalidates matching snapshots and outstanding reads/writes.

A cached snapshot is not a new authorization decision: previously authorized
content can briefly appear until revalidation detects revoked access.
Server-side authorization, same-origin API routing and public HTTP validators
are unchanged.

### Upload and publish

`POST /api/publications/:id/upload?kind=file&name=...` accepts the same binary
file/CAR/block kinds and 32 MiB bounds as ordinary uploads. Block mode also
requires the `cid` query parameter. Required headers:

```text
X-Pinboard-Public: true
Idempotency-Key: <requestId for the publication step>
If-Publication-Sequence: <expectedSequence>
```

Success is 201 `{pin,publication}`. A successful upload followed by failed
publication returns **207**
`{pin,partialSuccess:true,publicationError:{status,message}}`. Keep the pin and
retry only publication with the same ID/payload if its outcome is uncertain.
Never delete public bytes as compensation. The idempotency key governs
publication, not the underlying immutable upload.

### Public reads and caching

No authentication is required. Supplying a session or token does not change the
public representation.

| GET route                                 | Result                                     |
| ----------------------------------------- | ------------------------------------------ |
| `/api/public/publications/:id`            | current publication metadata               |
| `/api/public/publications/:id/history`    | publication, revisions, pointer operations |
| `/api/public/publications/:id/versions/3` | publication metadata and fixed revision    |
| `/api/public/publications/:id/preview/3`  | safe source-derived preview descriptor     |
| `/api/public/publications/:id/download`   | CAR for current resolved once              |
| `/api/public/publications/:id/download/3` | CAR for fixed revision                     |

These responses use `Cache-Control: public, no-cache` and
representation-specific ETags. `If-None-Match` can return 304, but activity is
checked first: deleted publications return 404 for current, fixed, preview,
download and history reads, even with an old validator. Metadata and preview
validators cover the serialized response; CAR validators include its actual
stored representation. No permanent redirect or positive freshness interval
caches an outdated current pointer.

## Recovery and retention

Both pin Unpin and publication delete remove the object from normal lists and
start a **30-day** recovery window. Repeat deletion never extends the original
expiry. Deleted publications cannot publish or rollback. Restore before expiry
preserves the original pin name/creation time or publication ID/title/history/
current and reopens its original links; it creates no new revision. Restoring a
publication advances its lifecycle sequence so old concurrent writes conflict.
Expiry denies restore even if scheduled cleanup has not run.

During recovery, references to every DAG block, CAR manifest/object and preview
remain intact. Active publications retain all revisions, not just current.
Source pins remain independent: unpinning or expiring a source pin cannot remove
publication content. Expiry releases **only** that pin/account or publication's
references. Only after the last reference is released does the existing
**seven-day** physical-GC grace begin. Backlog, sharing and failures may extend
retention. There is no per-revision deletion or permanent-delete operation.
Publication deletion closes resolution, not already-public CID bytes, caches or
external copies.

Schema migration `0006_publications.sql` is additive: it introduces tables and a
retention view without changing existing tables or existing rows. Applying it
before the new Worker code is inert. After feature activation, storage, previews
and GC must all run the new reference-aware code; do not roll back to an older
Worker that does not understand publication retention.

Existing complete pins stored as legacy independent blocks are supported too.
Before first publication use, the service verifies their full DAG and prepares a
fresh indexed CAR using the existing storage write/GC fence. This preserves the
pin's CID, private label and timestamps. Publication commits still atomically
require an active owned pin and ready storage for every DAG member; incomplete
content or a concurrent GC claim cannot commit an unavailable revision.
