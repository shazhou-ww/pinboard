# Pinboard

**Pin blocks. Share by CID.**

A deliberately small public IPFS content store: Cloudflare Workers + R2 for
verified CAR archives, D1 for block locations, Google account identities, pin
references and Agent token hashes. React and Hono reuse the fullstack template's
same-origin/Auth.js setup.

Production origin: `https://pinboard.shazhou.work`. Releases are tag-driven; see
the [deployment guide](docs/deployment.md) for acceptance requirements.

## What it does

- Web: choose or drop one file or folder. A folder keeps its relative paths and
  becomes one pin with one directory root CID.
- API/MCP: upload a file (UnixFS), a single block, or a complete single-root
  CAR.
- [CLI](docs/cli.md): upload/download files and directories, import/export CARs,
  list, inspect, rename and remove account pins without installing Kubo or
  running a daemon.
- Validate CID hashes and complete DAG closure before accepting a pin.
- Share by CID without authentication, through raw block responses or CAR
  export.
- Sign in with Google to list, inspect and unpin your own content.
- Rename an account's pin from Web, CLI or `PATCH /api/pins/:cid`, without
  changing its CID or re-uploading public content.
- [Publish evolving content](docs/publications.md) behind a stable public link,
  with immutable numbered revisions, public history and explicit rollback.
- Recover deleted pins and publications for 30 days through Web, CLI, HTTP or
  MCP.
- Explicitly convert a fixed Pin in place, or drop files/folders onto a card to
  confirm targeted publishing. Linking keeps its source Pin unchanged.
- Edit optional account/root-scoped descriptions for root and reachable child
  nodes; publications snapshot them immutably beside system previews.
- Give an agent a scoped, expiring, revocable token for HTTP and remote MCP.
- Connect an interactive MCP client through browser Google sign-in and explicit
  OAuth consent, without copying an API token (after the OAuth
  migration/release).
- Use explicitly configured Kubo clients as readers, without a server-side Kubo.

All uploaded bytes are **public**, including bytes in failed partial writes.
Account lists, labels, and tokens are private. Publication titles and their
complete revision histories are public. Unpin and publication deletion remove
the object from normal lists and retain its references for a 30-day recovery
window in **Recently deleted**. Expiry releases only that object's references;
the last account, DAG or publication reference then starts seven days of cleanup
grace. Shared CARs may remain longer; CDN, other nodes and downloaded copies are
not erased. There is no permanent-delete action. Revoked/expired Agent tokens
stop authenticating immediately; their management records are kept for 30 days
from the earlier invalidation time. The Web token list defaults to active
entries, with a separate history view.

New uploads use one CAR object and a CID-to-object/offset/length index, with
legacy independent-block fallback. Complete indexed CAR downloads stream one
object; raw block reads use R2 ranges. See
[storage and recovery](docs/storage.md) for duplication tradeoffs, publication
guarantees and rollout requirements.

There is no arbitrary remote CID fetching, DHT announcement, IPNS publishing,
always-on Kubo/Cluster, billing or organization system. A public HTTP endpoint
does **not** make its content automatically discoverable on the public IPFS
network.

## Local development

Workspace package names use the `@shazhou` scope:

| Workspace            | Package name                  | Distribution                                          |
| -------------------- | ----------------------------- | ----------------------------------------------------- |
| `apps/cli`           | `@shazhou/pinboard`           | Intended public CLI package; command stays `pinboard` |
| `apps/web`           | `@shazhou/pinboard-web`       | Private application                                   |
| `apps/worker`        | `@shazhou/pinboard-worker`    | Private application                                   |
| `packages/contracts` | `@shazhou/pinboard-contracts` | Private shared contracts                              |
| `packages/encoding`  | `@shazhou/pinboard-encoding`  | Private shared encoding                               |

The root `pinboard` package and all workspace manifests remain private.
`pnpm package:cli` generates the standalone CLI distribution; only its release
manifest is publishable. Internal dependencies stay on `workspace:*`. See
[npm releases](docs/npm-release.md) for the independent
`@shazhou/pinboard@x.y.z` tag workflow, Trusted Publishing and installation
checks. Historical Silvermoon evidence retains the package names used when its
checks were executed.

Requires Node.js >=22.13 and pnpm 11.22 (the pinned package manager).

```powershell
pnpm install
Copy-Item apps\worker\.dev.vars.example apps\worker\.dev.vars
# Set a random AUTH_SECRET and your Google OAuth client ID/secret in .dev.vars.
pnpm --filter @shazhou/pinboard-worker exec wrangler d1 migrations apply pinboard --local
pnpm dev
```

Web: `http://localhost:5173`; local Worker: `http://localhost:8787`. Only the
Google provider is enabled. Its local callback is:

```text
http://localhost:5173/api/auth/callback/google
```

Without Google credentials the public gateway and local tests work, but real
interactive sign-in and account writes are unavailable. There is no development
login bypass in the production Worker.

## Web uploads

UI icons use [Phosphor](https://github.com/phosphor-icons/react) (MIT), with a
regular action icons, duotone content/brand icons and shared semantic color
roles. Import icons through `apps/web/src/icon.tsx` to keep sizing and
accessibility defaults consistent; label meaningful icons and hide decorative
icons from assistive technology.

### Local UI preview

For a read-only UI demo without OAuth, explicitly enable the local preview when
starting Vite. In PowerShell, set `$env:VITE_UI_PREVIEW = "true"` before running
`pnpm dev`, then open `http://localhost:5173/#preview`.

The hash is a one-shot trigger: it is removed with `history.replaceState` before
the app renders, preserving the pathname and query. The preview identity is kept
in this tab's `sessionStorage`, so refresh keeps it active. Entering `#preview`
on an already-open page reinitializes the page once. **Sign out** exits preview,
clears the tab's preview state and returns to `/` without signing out any real
OAuth session. Closing the tab ends its preview session.

Preview requires Vite development mode, the explicit flag and a loopback host.
Production builds exclude the demo modules and continue using real
authorization. The demo has synthetic images, pins, publications (including a
v3-of-5 rollback) and recently deleted items; uploads, edits, token changes and
other API writes are rejected. It does not validate real upload/download or
OAuth flows. No test-account credentials or production authentication bypass
exist.

### Choosing content

The signed-in homepage is a responsive content wall, not a free-positioned or
zoomable canvas. **Add** opens the file picker directly; hover or keyboard focus
reveals **Choose folder**. Mobile and touch devices show the file and folder
actions directly, without an expansion arrow. The floating add actions are
vertically arranged circular icon buttons with accessible names. A compact
frosted-glass header keeps branding on the left and the signed-in account on the
right, extending across the reserved scrollbar gutter even on short pages. The
backdrop defaults to **晨光雾屿 · Mist blue & lavender**. **Settings → Browser
preferences → Background palette** also offers **玫瑰沙丘 · Sand & rose** and
**晴空冰海 · Clear sky blue** (low-saturation true blue, not cyan). Each
selection updates the whole interface, including buttons, previews, dialogs,
menus, focus and interaction states, not just the backdrop. Changes persist in
this browser's `localStorage` under the existing `pinboard:background` key
(`mist`, `sand`, `ice`), not the account, and also apply on public/share and
OAuth pages. Clearing site data restores the default. Unavailable or invalid
saved preferences are logged and leave the default background usable; failed
saves show an error in Settings without changing the current palette. All
palettes share the same shallow-engraved icon geometry: an evenly staggered 480
× 960 px SVG tile with varied icon sizes and seamless wrapping on both axes. The
approved 1.6 px lines use a subtle dark upper-left edge and light lower-right
edge, replacing the metallic gradient without widening or softening the groove.
Bundled static SVG variants tint the engraving to each palette; switching
palettes requires no runtime SVG generation. The fixed CSS size prevents
stretching on larger screens; only the gradient fills the viewport. There is no
runtime layout or collision calculation, and the background adds no interactive
or accessibility nodes. The account dropdown contains **Settings** and **Sign
out**; Settings is no longer a floating action. There is no visible wall title
or explanatory footer. Drop instructions appear in the empty state, on drag-over
and in the Add tooltip instead of occupying a permanent row above the pins.

On refresh, the shared header and content-wall frame remain neutral until the
session is known: neither pins nor sign-in content is shown prematurely. Session
and item-list loading use a single spinner instead of duplicate visible status
lines, with accessible loading labels and reduced-motion support. The sign-in
page appears only after the session is confirmed signed out. Filtering and
pagination keep existing items visible with a compact loading indicator.
Full-page loading pairs an editorial-style original Pinboard thought with the
spinner, rotating every 2.6 seconds without repeatedly announcing it to screen
readers. Once content is ready, the loading scene fades out over 320 ms before
the result fades in at the same pace. Reduced-motion preferences skip this
handoff delay and disable the transitions; filtering and pagination keep their
compact spinner without rotating copy.

Click or tap a pin or publication card to open its details and management
actions; keyboard users can activate the card's details button with Enter or
Space. Cards have no custom right-click menu or overflow button, preserving the
browser's native context menu. The bottom CID capsule remains a shortcut for
copying the complete CID without opening details. Details are reading-first:
content on the left and descriptions/facts on the right, stacked on narrow
screens. **Share** and **Download** remain primary; **More** holds independent
management tasks. Private descriptions are read-only until **Edit description**;
advanced node queries remain available in a collapsed section. Publication
details distinguish the viewed version, public current and latest. Browsing
history does not change current. Fixed-version links and downloads use the
viewed CID; publishing and making a version current are explicit tasks. Unpin
moves only that pin to recently deleted; publication references remain
independent.

The upload dialog's **After uploading** selector always offers **Create a
publication**, including for an account with no existing publications. Enter a
separate **Public title** to publish; **Keep as a pin only** remains the
default.

On desktop, the bottom information strip expands only when hovered or focused
itself, not when hovering the rest of the card. Touch devices keep the CID
action visible. Operation feedback floats below the fixed header without moving
the wall; success messages dismiss after five seconds. Errors remain visible for
recovery, and progress remains until the operation completes.

Pin details open immediately with the listed metadata and refresh in the
background without inserting a loading row or resizing the panel. Click or tap
outside the panel, press Escape or use Close to dismiss it, including while its
details are loading. Closing cancels the read so late responses cannot reopen
the panel and returns focus to the card. Pending writes prevent dismissal;
unsaved edits require confirmation before closing. Upload and Settings dialogs
retain their explicit Close/Cancel behavior.

Drop one file or folder anywhere on the wall to open the same **Make a pin**
dialog. Review the selection and optionally edit its pin name before confirming.
**Settings** opens a dialog for Agent tokens, MCP authorizations and local
browser preferences.

The public-content reminder appears in the upload dialog, not as a permanent
checkbox on the homepage. **Do not remind me in this browser** is saved in this
origin's `localStorage` only when confirming an upload, never on cancellation.
It is not synced to the account or other devices. Clearing site data or enabling
the reminder in Settings restores it. Upload confirmation remains required, and
all uploads still explicitly acknowledge public content to the server.

Cards load small, typed preview descriptions as they enter the viewport; the
wall never downloads original CARs to build previews. The existing Worker
verifies locally stored UnixFS content, not account labels or filename
extensions. JPEG, PNG and WebP images use bundled WebAssembly codecs (no Images
binding or external image service), capped at 8 MiB input and 2 million decoded
pixels. Actual aspect-preserving WebP thumbnails have a 480-pixel maximum edge
and 64 KiB maximum size. D1 stores their binary BLOBs under SHA2-256 raw CIDs;
the browser separately loads immutable `/ipfs/:thumbnailCid` images. PDF nodes
use the same image material for their first page, rendered on white by bundled
PDFium with licensed Chinese font fallback. There is no PDF reader, document
scripting, external resource fetch or new download/Range endpoint. See
[PDF preview limits and build provenance](docs/pdf-previews.md).

After loading the current account's authorized Pin list, visible cards first
reuse preview descriptions from memory or account-scoped IndexedDB. Ready
descriptions are fresh for one hour, unsupported descriptions for five minutes;
stale entries up to seven days old render immediately while being refreshed.
Pending and failed states are not persisted and invalidate older cached
descriptions. The normalized format upgrades IndexedDB to version 2 and clears
all old descriptions once; no old-format adapter or negotiation is provided. The
cache stores no account labels or image BLOBs: memory holds at most 128 entries;
IndexedDB retains at most 500 entries and 2 MiB of JSON payloads, with a 16 KiB
per-entry budget and least-recently-used eviction. Browser storage failures are
logged and leave normal authenticated network loading available.

Visible misses and stale descriptions are coalesced over 16 ms into
`POST /api/pins/previews` requests, with at most 32 CIDs per batch. Duplicate
in-flight requests share one result. Each CID is checked against the current
account, and missing/unowned entries return individual 404 results without
revealing shared metadata. Batch responses remain private and `no-store`; the
single-Pin endpoint remains supported. Each batch starts at most two generation
jobs. Cards make at most 24 polls: two seconds for pending work, thirty seconds
for explicitly retry-scheduled failures; terminal failures are not polled.
Account changes dispose the previous request client; cached descriptions are
never a substitute for an authorized Pin list or server-side access checks.

UTF-8 excerpts contain at most 2,400 characters. Text and directory previews
extend to the card's bottom edge behind the translucent, frosted information
strip rather than stopping above it. Text and directory cards use a lighter tint
and tighter blur so sparse glyphs remain visible as softened shapes beneath the
strip. Images retain stronger frosting for their denser backgrounds.
Theme-tinted information strips retain the original visible frosting: 45%
surface opacity for text/code/directories with 4px blur, and 72% for images with
16px blur. The header uses a 66%-to-62% tint with 24px blur, and the search
input uses 75%; menus, publication badges and floating feedback use 90%. Do not
replace these distinct glass treatments with a near-opaque shared fill:
preserving a blur declaration alone does not preserve the visible effect.
Contrast over arbitrary image content is not guaranteed by these translucent
information strips; check actual image/text underlays visually rather than
claiming a worst-case guarantee from solid-color tests. The card's keyboard
focus ring has a solid surface band so it remains identifiable over thumbnails.
Success, warning and error/danger colors stay fixed independently of the
selected palette. These color-pair checks are regression coverage, not a claim
of whole-site WCAG conformance. Text placed directly on the patterned canvas
uses a stronger derived secondary-text role, with contrast checked against the
composited translucent engraving layers for each palette. Keep interface colors
in the shared roles in `apps/web/src/styles.css`;
`apps/web/test/palette.test.ts` checks palette completeness,
solid/glass/linework contrast and semantic-state independence. Ordinary images
fill the card with a centered crop on the longer axis, without changing the
original bytes, thumbnail CID or stored aspect ratio. Display Markdown escapes
source punctuation; structured/code text uses literal code fences, not invented
headings or AI summaries. Links, HTML and remote images remain inert text.
Verified directories use the current Pin name as their folder-tab heading and a
compact, read-only directory tree with folded-page file icons, folder tabs and
hierarchy lines aligned beneath parent icons without overlapping them. The root
folder heading and every entry use the same 28 px row rhythm, without extra
spacing before the first entry. They show at most 24 actual names across two
entry levels, without subfolder navigation. Cards omit sampling labels;
sampled/truncated overviews never claim unverified totals. GIF, video, audio and
unknown binary content use type-icon covers with only reliably identified source
types. Invalid or oversized images fail explicitly instead of downloading
originals. PDF forms, annotations, password protection and known missing
fallback glyphs require flattening, embedding fonts or removing protection
outside Pinboard; these are not published as successful blank images.

Previews are shared by source CID and generation version, without account names.
`contentType` is the original source MIME (or null when unknown), never the WebP
output type or a guess from an editable filename. `preview` is an `image`,
`markdown`, `text` or `directory` material, or null. Only `ready` descriptors
carry material; `pending`, `unsupported` and `failed` retain their status/reason
with null material. Reliable logical `size` is optional; directory sources use
`inode/directory`. Shared runtime validation rejects invalid combinations at
storage and client boundaries. Authenticated uploads (Web, CLI, HTTP and MCP)
enqueue generation after the pin is saved; errors are logged without undoing the
pin. The existing hourly cron processes at most two due jobs and discovers at
most two missing legacy previews per run. Opening a card lazily enqueues missing
previews too. A two-minute fenced lease prevents duplicate publication; failed
jobs retry with backoff, at most three attempts per version. A generation
version bump is required to retry exhausted/unsupported content after fixing a
generator. Version 3 rebuilds every format into the normalized descriptor
without changing originals, CARs, Pins, Publications or authorization records.
One isolate admits one generation immediately; busy jobs remain durably pending
without spending failure attempts or waiting in a cross-request Promise queue.

Different originals can share identical thumbnail bytes. Each source retains its
last published generation until a replacement is published, even if the new
generation is pending or fails. GC rechecks published source previews and
retained roots (including publications and recovery), directly pinned thumbnails
and DAG membership, in the same D1 transaction as deletion. Unreferenced
thumbnails and metadata have a seven-day grace period; version swaps do not
erase old images immediately. A direct pin suspended during GC republishes its
verified image BLOB atomically with the new reference. Preview artifacts never
create account pins on their own. Cached copies cannot be recalled after
collection.

Cards remain preview-first, with a translucent, frosted-glass bottom strip
showing the name and size by default. The strip covers the card's bottom border
and redraws that edge, preventing a thin preview-colored seam at fractional card
heights without shifting its text. Hovering over a card or focusing it with the
keyboard raises the strip to reveal a single-line CID copy capsule, with a copy
icon instead of link styling. Long CIDs are visually ellipsized, while the
tooltip and copied value retain the complete CID. The transition respects
reduced-motion preferences. Clicking the capsule copies the full CID without
opening details. Successful copies show "CID copied" and a checkmark inside the
capsule for 1.5 seconds, then restore the CID; repeated copies restart the
confirmation. Copy failures show an error instead of success. Touch users can
also copy the full CID in the details dialog. Clicking anywhere else on the card
(or using its keyboard action) opens a reading-first modal with description,
timestamp, block count, Share/Download menus and More management tasks. Complete
CID and reachable-node queries are in **Advanced information and node query**.
Renaming updates both the card and modal without changing the CID.

PDF image material appears as a full, aspect-preserving floating paper on a
neutral backdrop, with a light border/shadow and a small upper-left PDF badge.
The information band occupies its own layout row, including when expanded,
keyboard-focused or on touch; the independent Publication badge remains at upper
right. PDF cards can grow to a minimum 280px height on narrow screens while
staying within their assigned grid width, keeping the paper identifiable with an
expanded band. Pin cards, Publications and node details share this treatment.
Unknown source types still display valid material without guessed decoration.

SVG, HTML and other active content are never embedded. Missing material and
image-load failures use ordinary type-icon covers, without new failure text,
warnings or retry controls. Image failures are local and recover on a new image
identity or a successful load; they never rewrite or persist generation status.
Diagnostics and polling remain intact. Invalid API payloads and authorization
errors remain errors, not successful fallback descriptors.

There is no protocol-format selector. Files, including `.car` files, are saved
as ordinary files in the Web UI; use CLI `import` or the API/MCP CAR mode for
protocol imports.

Folders are packaged into a complete UnixFS directory CAR in the browser and
sent through the existing authenticated upload API. The encoder is loaded only
when uploading a folder. The selected folder's name labels the pin; its contents
are directly beneath the root CID, without an extra enclosing directory.

The same validation applies to picker and drop inputs: one top-level item,
preserved relative paths, no traversal/duplicate/conflicting paths, and no more
than 32 MiB of selected file bytes. Encoded archives and DAGs must also fit the
existing 32 MiB / 256-block limits, so metadata can make a near-limit folder too
large. Limits are checked before uploading and enforced again by the Worker.

Empty files are preserved. Empty directories are not included, and an entirely
empty folder cannot be uploaded. Directory selection/drop requires browser
support for directory entries; file selection remains available when folder
access is unsupported. Hidden files are not silently filtered: review the
selection and public-content acknowledgement before uploading.

## Interfaces

| Route                                             | Access                 | Purpose                                                                   |
| ------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------- |
| `/ipfs/:cid?format=raw`                           | Public GET/HEAD        | Raw verified block, never an HTML document                                |
| `/ipfs/:thumbnailCid`                             | Public GET/HEAD        | Independently cacheable generated WebP image                              |
| `/routing/v1/providers/:cid`                      | Public GET             | Delegated Routing JSON or NDJSON                                          |
| `/api/public/:cid/car`                            | Public GET             | Complete DAG as an attachment                                             |
| `/api/public/:cid/download?name=...`              | Public GET             | Original raw/UnixFS file, or UnixFS directory as ZIP                      |
| `/share/:cid`                                     | Public                 | Safe share page; no content preview/execution                             |
| `/api/pins`                                       | Session or Agent token | List or pin an already stored DAG                                         |
| `/api/pins/upload?kind=file\|car\|block&name=...` | Session or Agent token | Upload; block mode also requires `cid`                                    |
| `/api/pins/:cid`                                  | Session or Agent token | Detail or DELETE own reference                                            |
| `/api/pins/:cid/preview`                          | Session or Agent token | Own pin's typed preview; lazy generation, no image bytes                  |
| `/api/pins/previews`                              | Session or Agent token | POST up to 32 CIDs; per-item authorized preview descriptions              |
| `/api/tokens` and `/api/tokens/:id`               | Browser session only   | Issue, list active (`?view=history` for invalid) or revoke account tokens |
| `/mcp`                                            | Agent Bearer token     | Stateless MCP Streamable HTTP (POST)                                      |

The same `/mcp` also accepts MCP OAuth credentials, restricted to that resource
rather than `/api/*`. OAuth discovery uses `/.well-known/*`; public client
registration and authorization-code/S256 endpoints use `/oauth/*`.
Browser-session-only `/api/oauth/grants` lists authorizations and
`DELETE /api/oauth/grants/:id` revokes them. The homepage provides the same
management UI. Consent defaults to one day, with seven-day, thirty-day and
never-expiring options. Selectable lifetimes require migration
`0008_oauth_lifetimes.sql`; existing credentials retain their original expiry.
See [OAuth setup, lifecycle and pending real-client checks](docs/mcp.md). These
additions require migration `0004_mcp_oauth.sql` in an explicitly authorized
environment; they are not a claim that the current production deployment
supports OAuth.

Uploads require `X-Pinboard-Public: true`. JSON pin requests require
`{"cid":"...","name":"...","public":true}`. Cookie-authenticated mutations also
require an Origin matching `AUTH_URL` (or `PUBLIC_ORIGIN`). Agent names are
labels, not credentials. Web and MCP use the same `PinService`, accountId and
scopes.

### Raw gateway HTTP contract

`GET` and `HEAD /ipfs/:cid` serve a single locally stored block, without remote
retrieval. Select raw with `?format=raw` or an `Accept` header:

- Explicit `format=raw` takes precedence over `Accept`, even if the header is
  malformed or excludes raw. Empty or unsupported `format` values return 406.
  Omitting both `format` and `Accept` returns 400.
- Without `format`, `application/vnd.ipld.raw`, `application/*` and `*/*` are
  supported media ranges, matched case-insensitively. Quality values must be
  between 0 and 1 with at most three decimal places; `q=0` excludes a range. The
  most specific matching range determines raw's quality, so an exact `q=0`
  overrides a positive wildcard. Equal-specificity duplicates use the highest
  quality. Higher-quality unsupported formats never select another
  representation. Raw has no media-type parameters, so parameterized ranges do
  not match it (a separate unparameterized wildcard can still match).
- A valid header that does not accept raw returns 406, including similar but
  different types such as `application/vnd.ipld.raw-extra`. Empty or malformed
  `Accept` returns 400, even if another member accepts raw. This includes
  invalid media ranges, parameters, duplicate parameter names and quality
  values; quoted quality values are rejected.
- Successful responses retain raw bytes and length, attachment disposition,
  CORS, browser safety headers and immutable caching. GET and HEAD share the
  ETag `"<normalized-CIDv1>.raw"`; equivalent CIDv0/v1 inputs share this ETag.
  `X-Ipfs-Path` preserves the requested CID.
- `If-None-Match` uses weak comparison, supports validator lists and `*`, and
  returns a bodyless 304 only after local availability is confirmed. Malformed
  validator lists are ignored. HEAD and matching conditional requests use
  metadata without downloading block bytes.
- Missing roots return 404, or 412 when `Cache-Control` includes the
  case-insensitive, bare `only-if-cached` directive. Storage failures remain
  errors rather than cache hits or missing roots. The empty identity probe
  `bafkqaaa` is always available, with length 0 and the same conditional rules.

Generated thumbnail CIDs additionally serve WebP at `/ipfs/:cid` when the client
accepts images (or sends no `Accept`). Explicit raw requests still deliver the
exact CID-encoded block bytes. Images have their own `.webp` ETag, immutable
caching, `nosniff` and sandbox headers; conditional GET/HEAD work independently
of the private, non-cacheable preview description.

This is a non-recursive gateway, not a general UnixFS rendering service.
Standard CAR negotiation, IPNS, gateway path traversal and byte-range responses
are not supported. The separate `/api/public/:cid/car` endpoint exports a
complete CARv1 DAG; it is not standard trustless CAR gateway negotiation.
Clients must still verify retrieved CIDs.

### Deliberate first-version limits

- Upload body and unique DAG bytes: 32 MiB; block: 2 MiB; DAG: 256 unique
  blocks.
- SHA2-256 hashes; raw, DAG-PB/UnixFS, and DAG-CBOR codecs.
- CARv1 or CARv2, exactly one root, complete and without unreachable blocks.
- Pin lists use 50-item CID-sorted pages (`nextCursor`).
- MCP inline upload: 2 MiB decoded. Larger content uses the same token on the
  HTTP upload route, not a base64-encoded 32 MiB JSON message.
- Tokens expire in 1-365 days (default 30); scopes are `pins:read`,
  `pins:write`, `pins:delete`, `publications:read`, `publications:write`,
  `publications:delete`. Old pin-write tokens gain no publication authority.
  Secrets are shown once and only SHA-256 hashes are stored.

Inputs outside these limits fail explicitly. Additional Worker CPU, memory,
subrequest and account-plan limits still apply; large-load testing is not a
production capacity claim.

## Verification

```powershell
pnpm check
pnpm --filter @shazhou/pinboard-worker types

# Install a stable Kubo executable and OpenSSL outside the repository:
$env:IPFS_BIN = 'C:\tools\kubo\ipfs.exe'
$env:OPENSSL_BIN = 'C:\Program Files\Git\usr\bin\openssl.exe'
pnpm test:kubo
```

Worker integration tests allow 30 seconds per test for local D1/R2 and workerd
I/O on both Linux and Windows; this is a test-runner budget, not a production
latency target. Native OAuth limiter tests fill the configured bucket directly
between HTTP boundary checks and verify that both checks share one wall-clock
minute. Only a detected minute rollover repeats the check with a fresh IP;
unexpected responses within a window still fail immediately.

The Kubo PoC uses a **separate local-only Worker entry** and temporary storage;
its unauthenticated uploader is never mounted by the production Worker. It
starts and stops an offline source daemon, then validates two independent cold
repos, HTTP/2 probe, delegated routing, `cat`, `get`, and byte equality. A third
fresh repo retrieves a directory produced by the browser encoder, including a
nested file and an empty file. No credentials or public deployment are required.

See [Kubo configuration and evidence](docs/kubo.md),
[Agent/MCP usage](docs/mcp.md), and [deployment checklist](docs/deployment.md).

### Local validation completed

- `pnpm check`: all 12 workspace tasks passed (95 tests including release
  guards); the unchanged Worker coverage thresholds passed, including 92.89%
  branch coverage.
- `pnpm test:kubo`: Kubo v0.43.1, stopped source daemon, original 16-block DAG
  plus an 18-block browser-encoded nested folder, three independent cold repos,
  HTTP/2 probes, `cat`/`get`, and byte/hash equality including an empty file.
- Real local Worker + browser, using a synthetic signed test session: upload,
  list/details, copy link, public share, scoped MCP read, rejected write (403),
  token revocation (401), and unpin with continued public block availability
  (200). Management/share layouts fit a 390px viewport. Uploaded HTML did not
  execute.
- Isolated browser upload fixtures exercised file/folder selection and drops:
  the same picked/dropped tree produced one identical root CID, nested paths and
  an empty file survived CAR export and independent Kubo reconstruction, `.car`
  names stayed ordinary files, multi-item drops were rejected, and long names
  fit a 390px viewport. FileList/directory-entry fixtures do not replace manual
  testing of the operating system's native picker on each supported browser.

Synthetic sessions test application behavior, **not Google's OAuth exchange**.
Production acceptance must separately verify a real Google login and a full
uploaded DAG download through independent Kubo clients.

## Tag-driven deployment

Pushes to `main` run CI only. Production deploys from a tag such as
`release-261103-1` (`release-YYMMDD-INDEX`), pointing to a commit already on
main. No release branch or npm version change is needed.

Deployment never runs production database migrations. Data changes use a
separately authorized hot-migration process: dual-write, backfill/catch-up, then
cutover. The initial production schema must be prepared separately before the
first full application release.

Configure the real D1 UUID and GitHub `production` Environment secrets before
creating a release tag. See [the deployment guide](docs/deployment.md) for token
permissions, required secrets and release commands.

## Lineage

Derived with `git-lineage` from
[`preset-cloudflare-fullstack`](https://github.com/shazhou-ww/preset-cloudflare-fullstack),
branch `main`, preserving full template history:

- Source: `48a07c6882f347f736a16f1d69b9e9922ae08111`
- Birth: `336af85d12f0a56a49f48dd054a9157dbfcfebe8`

The birth commit's first parent is the source. `.git-lineage.yaml` records the
immediate parent; `parent` is separate from this repository's `origin`. Run
`git-lineage update` from a clean worktree for future template merges. Nothing
is pushed or deployed by initialization.

## License

MIT
