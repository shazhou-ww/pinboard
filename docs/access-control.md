# Item access and sharing

New Pins and Publications default to **private**. Existing items remain public
after migration `0009_item_visibility.sql`, preserving existing share links. The
additive migration adds `visibility TEXT NOT NULL DEFAULT 'private'` with a
`private`/`public` CHECK to `pins` and `publications`, then backfills existing
rows to public. A `publication_revisions(cid, publication_id)` index supports
live-root byte authorization without scanning all historical revisions. It does
not reset data, change credentials, release retention references or run
automatically during deployment.

## Ownership and byte access

Private Pins require their owner's `pins:read`; private Publications require
their owner's `publications:read`. Session users have their account's scopes;
Agents have only their explicitly granted scopes. MCP OAuth credentials remain
restricted to `/mcp`, not gateway or HTTP API routes.

A CID is not authorization. Raw blocks, generated thumbnails, original files,
ZIPs, CARs and provider discovery use live eligible root references and DAG
membership, not a unique CID author. Authorization happens before storage reads
and before HEAD/ETag/304 responses. A Publication's access covers its title,
descriptions, preview and **every historical revision**. Public byte overlap
does not reveal private item labels, annotations, identities or history.

Pin-by-CID and raw-root upload completion cannot borrow inaccessible blocks.
Supplying a complete hash-verified file/CAR is different: the caller already has
those bytes and can create a private reference. Failed storage/index writes
without a live authorized item do not permit anonymous reads. Recovery/GC
retention is not access; deleted references never authorize reads. Restore
preserves visibility, and restoring a public item reopens its links/history.

## Web

Only private wall cards show a readonly lock, immediately before the name in the
existing bottom information strip. There is no visibility preview overlay.
Publication cards show **current vN** at upper right, not the history count;
rollback changes this number. Fixed Pins have no version badge.

Details replace the file-type icon with a leftmost inline lock/globe. Owners
open **Access and sharing** there; visitors see a readonly icon. Uploads show
only a default-private note and open details afterward. Updating content keeps
the destination's visibility. Conversion inherits the source Pin's visibility.
Making a private source part of a public Publication requires confirmation of
byte and description exposure; the source Pin stays private.

Each visibility change requires fresh confirmation. Public confirmation covers
all Publication history and irreversible downloads/caches. Revocation explains
other public byte references and existing external copies. Failure leaves the
original state visible, reports an error and permits retry. Private link copies
grant no access. Protected share pages return a generic unavailable/login prompt
without confirming private metadata or existence.

## HTTP, CLI and MCP

`PATCH /api/pins/:cid/visibility` and `PATCH /api/publications/:id/visibility`
accept `{"visibility":"private|public","acknowledge":true}`. Both require the
matching owner read **and** write scopes. Publication changes advance its CAS
sequence; refresh before publishing. Lists support
`visibility=all|private|public`.

Creation no longer requires `public:true` or `X-Pinboard-Public`. These legacy
acknowledgements are accepted for compatibility but **never** make an item
public. Publication publish accepts `acknowledgePublicExposure:true` when a
private Pin targets a public Publication. The upload-to-Publication endpoint
uses `X-Pinboard-Public-Exposure: true`; upload still leaves a private Pin if
publication fails.

Creation/conversion also require `publications:read` alongside write permission,
so writes never become a private metadata read bypass. Idempotent replay checks
the current live Publication's access before reading a persisted response;
deleted/private replay cannot replace normal access checks.

```powershell
pinboard access pin CID public --acknowledge
pinboard access publication ID private --acknowledge
pinboard publication publish ID CID --sequence N --request-id KEY --acknowledge-public-exposure
```

CLI read commands use an optional configured or supplied Agent credential,
including CAR downloads; anonymous public reads still work without one.
`--output` skips filename metadata lookup, not byte authorization. Redirects are
refused so credentials never follow another origin. Human Pin output and JSON
include access state. MCP `access_set` accepts
`kind,id,visibility, acknowledge:true` with the same scopes and warnings; its
read tools honor Publication access without relaxing OAuth resource
restrictions.

MCP `block_get({cid})` supplies authorized raw bytes as base64 (max 2 MiB per
block). This lets MCP-only OAuth readers traverse complete private DAGs without
an HTTP credential or making content public. `byteAccess` describes shared-byte
availability, not a private item's visibility or metadata.

## Cache and rollout boundary

Keep the fixed empty IPFS transport probe available; it always returns the known
empty bytes and never reveals whether an account item exists. Before rollout,
inspect live legacy roots lacking verified `dag_roots`/ `dag_members` and
complete the existing retention backfill if needed. Do not invent memberships
from a CID or a unique-uploader assumption. Purges should also cover old
`/routing/v1/providers/*` entries (previously cached for 60s), bounded to the
Pinboard origin.

Sensitive item/gateway endpoints use **`Cache-Control: private, no-store`**,
including public content, provider discovery and conditional responses. This
permits revocation of new server/CDN reads after the last public reference is
removed. New thumbnail URLs and CLI CAR requests use `access=v1` to avoid
previous immutable representations; legacy preview descriptors are normalized.

Before rollout, separately authorize/apply the additive D1 migration, deploy the
reviewed application and purge pre-existing long-lived `/ipfs/*` representations
from the CDN. Existing browsers, external nodes and downloaded copies cannot be
recalled; neither new headers nor a purge claim otherwise. Retain same-origin
static assets and `/api/*` Worker routing.

The production migration command, **operator-only after separate
authorization**, is:

```powershell
pnpm --filter @shazhou/pinboard-worker exec wrangler d1 migrations apply pinboard --remote --config wrangler.jsonc
```

Confirm the binding/database name in `apps\worker\wrangler.jsonc` and review the
pending migration list before applying; do not accidentally apply unrelated
pending schema work. See the existing deployment guide for release policy.
