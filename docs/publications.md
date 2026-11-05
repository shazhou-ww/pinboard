# Publications and recently deleted

A publication gives public immutable content a stable identity. Its random ID
does not depend on a title, email or private pin label. Publishing does not
convert or remove the source pin. Multiple publications may use the same CID.
The title and **complete revision and pointer history are public**; account
identities and private pin labels are not included.

## Web

Use a pin's **Add to a publication** menu action to create a publication with an
explicit public title, or publish that pin to an existing publication. The
upload dialog also lets you select an existing publication. Upload always
finishes first; if publication fails, the uploaded pin remains and the UI
reports that partial success.

Pins and publications share the same 4:3 wall cards. A publication has a
permanent identity badge and separate **Current v3** and **5 versions**
information: rollback does not erase later history. Open details to publish
another owned pin, inspect the public history, make an old version current, or
delete.

- `/p/<id>` follows current.
- `/p/<id>/v/3` identifies fixed revision 3.
- `/p/<id>/history` shows the same public history.
- `/share/<cid>` continues to identify immutable bytes.

Copy actions explicitly distinguish follow links, fixed-version links and CID.
Previews use the existing safe text/image/directory renderers, not executable
HTML. Downloads resolve one actual CID before reading the complete content.

Settings → **Recently deleted** lists pins and publications with deletion and
expiry times and a restore action.

The explicit local read-only UI preview includes single-version publications,
multiple independent publications sharing a CID, a v3-of-5 rollback state and
recently deleted items. Its write restrictions are unchanged.

## HTTP

Management endpoints use existing same-origin session or Agent-token checks.
OAuth credentials remain restricted to `/mcp`. JSON writes use
`Content-Type: application/json`.

| Method | Route                              | Input / result                                      |
| ------ | ---------------------------------- | --------------------------------------------------- |
| POST   | `/api/publications`                | `{title,cid,public:true,requestId}`; first revision |
| GET    | `/api/publications?cursor=...`     | owned active publications, `nextCursor`             |
| GET    | `/api/publications/:id`            | owned active publication                            |
| POST   | `/api/publications/:id/publish`    | `{cid,expectedSequence,requestId}`                  |
| POST   | `/api/publications/:id/rollback`   | `{revision,expectedSequence,requestId}`             |
| DELETE | `/api/publications/:id`            | move entire publication to recently deleted         |
| POST   | `/api/publications/:id/restore`    | restore before expiry                               |
| GET    | `/api/recently-deleted?cursor=...` | owned recoverable `items`, `nextCursor`             |
| DELETE | `/api/pins/:cid`                   | move pin to recently deleted                        |
| POST   | `/api/pins/:cid/restore`           | restore before expiry                               |

`publications:read` permits private publication listing and recovery listing.
`publications:write` permits creation, publish and rollback; an existing-pin
target also requires `pins:read`. Upload additionally requires `pins:write`.
`publications:delete` permits deletion and restoration. Pin recovery uses
`pins:delete`; private recovery listing uses the respective object's read scope.
Old `pins:write` tokens do **not** acquire publication write authority. Issue a
new scoped token or explicitly consent to new OAuth scopes when needed.

Targets must be active owned pins backed by a verified complete, ready DAG/CAR.
No remote content fetching is performed. Sequence checks, publication activity,
pin activity, storage fencing and retention insertion are rechecked in the D1
commit transaction.

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
revision. Publish and rollback responses contain `{status, publication}`.

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
