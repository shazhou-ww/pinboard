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
- Give an agent a scoped, expiring, revocable token for HTTP and remote MCP.
- Connect an interactive MCP client through browser Google sign-in and explicit
  OAuth consent, without copying an API token (after the OAuth
  migration/release).
- Use explicitly configured Kubo clients as readers, without a server-side Kubo.

All uploaded bytes are **public**, including bytes in failed partial writes.
Account lists, labels, and tokens are private. Unpinning deletes **only your
account reference** and immediately removes the pin from your list. Content is
eligible for scheduled cleanup 7 days after its last account or DAG reference
disappears. Shared CARs may remain longer; CDN, other nodes and downloaded
copies are not erased. There is no recycle bin, restore or permanent-delete
action. Revoked/expired Agent tokens stop authenticating immediately; their
management records are kept for 30 days from the earlier invalidation time. The
Web token list defaults to active entries, with a separate history view.

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
authorization. The demo has synthetic images and pins; uploads, edits, token
changes and other API writes are rejected. It does not validate real
upload/download or OAuth flows. No test-account credentials or production
authentication bypass exist.

### Choosing content

The signed-in homepage is a responsive content wall, not a free-positioned or
zoomable canvas. **Add** opens the file picker directly; hover or keyboard focus
reveals **Choose folder**. Mobile and touch devices show the file and folder
actions directly, without an expansion arrow. The floating add actions are
vertically arranged circular icon buttons with accessible names. A compact
frosted-glass header keeps branding on the left and the signed-in account on the
right. The account dropdown contains **Settings** and **Sign out**; Settings is
no longer a floating action. There is no visible wall title or explanatory
footer. Drop instructions appear in the empty state, on drag-over and in the Add
tooltip instead of occupying a permanent row above the pins.

Right-click a pin card or use its **…** button to open **View details**, **Copy
link** (the public share page), **Copy CID** and **Unpin**. Keyboard users can
open the menu with Shift+F10, navigate with arrow keys, Home and End, and
dismiss it with Escape. Unpin keeps the existing confirmation and removes only
the account reference.

On desktop, the compact **…** button appears when hovering the preview or
focusing the button with the keyboard. The bottom information strip expands only
when hovered or focused itself, not when hovering the rest of the card. Touch
devices keep the menu button and CID action visible. Operation feedback floats
below the fixed header without moving the wall; success messages dismiss after
five seconds. Errors remain visible for recovery, and progress remains until the
operation completes.

Pin details open immediately with the listed metadata and refresh in the
background without inserting a loading row or resizing the panel. Click or tap
outside the panel, press Escape or use Close to dismiss it, including while its
details are loading. Closing cancels the read so late responses cannot reopen
the panel. Pending writes still prevent dismissal. Upload and Settings dialogs
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
the browser separately loads immutable `/ipfs/:thumbnailCid` images.

After loading the current account's authorized Pin list, visible cards first
reuse preview descriptions from memory or account-scoped IndexedDB. Ready
descriptions are fresh for one hour, unsupported descriptions for five minutes;
stale entries up to seven days old render immediately while being refreshed.
Pending and failed states are not persisted. The cache stores no account labels
or image BLOBs: memory holds at most 128 entries; IndexedDB retains at most 500
entries and 2 MiB of JSON payloads, with a 16 KiB per-entry budget and
least-recently-used eviction. Browser storage failures are logged and leave
normal authenticated network loading available.

Visible misses and stale descriptions are coalesced over 16 ms into
`POST /api/pins/previews` requests, with at most 32 CIDs per batch. Duplicate
in-flight requests share one result. Each CID is checked against the current
account, and missing/unowned entries return individual 404 results without
revealing shared metadata. Batch responses remain private and `no-store`; the
single-Pin endpoint remains supported. Each batch starts at most two generation
jobs, and pending cards poll every two seconds at most 24 times. Account changes
dispose the previous request client; cached descriptions are never a substitute
for an authorized Pin list or server-side access checks.

UTF-8 excerpts contain at most 2,400 characters. Display Markdown escapes source
punctuation; structured/code text uses literal code fences, not invented
headings or AI summaries. Links, HTML and remote images remain inert text.
Verified directories show at most 24 actual names across two entry levels,
without subfolder navigation. Sampled/truncated overviews are labelled and never
claim unverified totals. PDF, GIF, video, audio and unknown binary content use
explicit unsupported placeholders with only reliably identified metadata.
Invalid or oversized images fail explicitly instead of downloading originals.

Previews are shared by source CID and generation version, without account names.
`pending`, `ready`, `unsupported` and `failed` are distinct from their
`contentType`/`content` payload. Authenticated uploads (Web, CLI, HTTP and MCP)
enqueue generation after the pin is saved; errors are logged without undoing the
pin. The existing hourly cron processes at most two due jobs and discovers at
most two missing legacy previews per run. Opening a card lazily enqueues missing
previews too. A two-minute fenced lease prevents duplicate publication; failed
jobs retry with backoff, at most three attempts per version. A generation
version bump is required to retry exhausted/unsupported content after fixing a
generator.

Different originals can share identical thumbnail bytes. Each source retains its
last published generation until a replacement is published, even if the new
generation is pending or fails. GC rechecks published source previews and
account pins, including directly pinned thumbnails and DAG membership, in the
same D1 transaction as deletion. Unreferenced thumbnails and metadata have a
seven-day grace period; version swaps do not erase old images immediately. A
direct pin suspended during GC republishes its verified image BLOB atomically
with the new reference. Preview artifacts never create account pins on their
own. Cached copies cannot be recalled after collection.

Cards remain preview-first, with a translucent, frosted-glass bottom strip
showing the name and size by default. Hovering over a card or focusing it with
the keyboard raises the strip to reveal a single-line CID copy capsule, with a
copy icon instead of link styling. Long CIDs are visually ellipsized, while the
tooltip and copied value retain the complete CID. The transition respects
reduced-motion preferences. Clicking the capsule copies the full CID without
opening details. Successful copies show "CID copied" and a checkmark inside the
capsule for 1.5 seconds, then restore the CID; repeated copies restart the
confirmation. Copy failures show an error instead of success. Touch users can
also copy the full CID in the details dialog. Clicking anywhere else on the card
(or using its keyboard action) opens a modal with the full CID, timestamp, block
count, rename, share, CAR download and Unpin actions. Renaming updates both the
card and modal without changing the CID.

SVG, HTML and other active content are never embedded. Preview errors remain
visible on the card and do not prevent pin management or CAR downloads.

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
| `/share/:cid`                                     | Public                 | Safe share page; no content preview/execution                             |
| `/api/pins`                                       | Session or Agent token | List or pin an already stored DAG                                         |
| `/api/pins/upload?kind=file\|car\|block&name=...` | Session or Agent token | Upload; block mode also requires `cid`                                    |
| `/api/pins/:cid`                                  | Session or Agent token | Detail or DELETE own reference                                            |
| `/api/pins/:cid/preview`                          | Session or Agent token | Own pin's typed preview; lazy generation, no image bytes                  |
| `/api/pins/previews`                              | Session or Agent token | POST up to 32 CIDs; per-item authorized preview descriptions              |
| `/api/tokens` and `/api/tokens/:id`               | Browser session only   | Issue, list active (`?view=history` for invalid) or revoke account tokens |
| `/mcp`                                            | Agent Bearer token     | Stateless MCP Streamable HTTP (POST)                                      |

The same `/mcp` also accepts short-lived MCP OAuth credentials, restricted to
that resource rather than `/api/*`. OAuth discovery uses `/.well-known/*`;
public client registration and authorization-code/S256 endpoints use `/oauth/*`.
Browser-session-only `/api/oauth/grants` lists authorizations and
`DELETE /api/oauth/grants/:id` revokes them. The homepage provides the same
management UI. See
[OAuth setup, lifecycle and pending real-client checks](docs/mcp.md). These
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
  `pins:write`, `pins:delete`. Secrets are shown once and only SHA-256 hashes
  are stored.

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
