# Pinboard CLI

## Conversion and node descriptions

```shell
pinboard publication convert CID --title "Explicit public title" --request-id UNIQUE
pinboard description get ROOT_CID NODE_CID
pinboard description set ROOT_CID NODE_CID --text "Plain text" --version 0
pinboard description clear ROOT_CID NODE_CID --version 1
pinboard description export ROOT_CID --json
pinboard publication description PUBLICATION_ID NODE_CID --revision 1
```

Conversion atomically replaces the fixed Pin with original-content v1; it is not
a link or upload. Retry an uncertain conversion with the identical title, CID
and request ID. Linking still uses `publication publish` and retains the source
Pin unchanged. Descriptions are scoped to this account and active root,
including reachable children. Read the actual CAS version before set/clear. CAR
exports remain original bytes and omit sidecar metadata: explicitly save
`description export` JSON separately. Publication JSON/history includes
immutable description maps; publishing the current CID is a NOP and does not
apply draft description changes. See [publication semantics](publications.md).

## Publications and recovery

Publication titles and the complete revision history are public. Private pin
labels and account identity are not. Existing pin-write tokens do not gain
publication authority: explicitly grant the appropriate `publications:read`,
`publications:write` or `publications:delete` scopes. Publishing an existing pin
also needs `pins:read`; uploading needs `pins:write`.

```powershell
pinboard publication create <CID> --title "Field notes" --request-id create-notes
pinboard publication list
pinboard publication get <ID>
pinboard publication get <ID> --revision 3
pinboard publication history <ID>
pinboard publication download <ID> --revision 3 --output .\fixed-notes.txt
pinboard publication export <ID> --output .\current.car
pinboard publication publish <ID> <CID> --sequence 1 --request-id publish-notes-2
pinboard publication rollback <ID> 1 --sequence 2 --request-id rollback-notes
pinboard upload .\notes.txt --publication <ID> --sequence 3 --request-id upload-notes
pinboard publication remove <ID>
pinboard deleted
pinboard publication restore <ID>
pinboard remove <CID>
pinboard restore <CID>
```

Public get/history/download/export commands send no token. Publication downloads
resolve once and verify/download only that actual CID for the whole operation.
Omit `--revision` to resolve current. `--sequence` is the current publication
sequence, not a revision number. Retry an uncertain operation with the same
`--request-id` and identical payload to get its persisted result. Outdated
sequence or request-ID payload reuse yields 409. Current-CID publish is NOP;
noncurrent historical CID creates a new revision. Rollback creates none.

Upload/import with `--publication` preserves the successful pin if publication
fails, emits `{pin,partialSuccess:true,publicationError}` (also with `--json`)
and exits 1. Retry just `publication publish` using the reported CID, sequence
and request ID. Removal moves a pin or publication to recently deleted for 30
days. `deleted --cursor ...` paginates recovery items and their deadlines;
restore retains original IDs and history. Only expiry releases references, then
the last reference starts the existing seven-day GC grace. No permanent deletion
or content recall is implied. See
[the HTTP and lifecycle reference](publications.md).

The CLI is a direct client of the existing Pinboard HTTP API. It needs Node.js
22.13+ and pnpm 11.22+, **not Kubo, an IPFS executable, or a daemon**. It does
not fetch remote CIDs to create pins.

## Build and run

Stable npm releases are standalone and do not require pnpm or this checkout:

```powershell
npm install --global @shazhou/pinboard
pinboard --help
```

The `0.0.0-bootstrap.0` package is only a placeholder, not a working CLI.
Release packaging and the `@shazhou/pinboard@x.y.z` tag workflow are described
in [npm releases](npm-release.md).

From a checkout, install and build the CLI and its workspace dependencies:

```powershell
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter=@shazhou/pinboard
node .\apps\cli\dist\main.js --help
```

For convenience, define a function in your PowerShell profile (use the absolute
path to your checkout):

```powershell
function pinboard { node C:\Code\pinboard\apps\cli\dist\main.js @args }
```

On POSIX shells the equivalent is
`pinboard() { node "$HOME/code/pinboard/apps/cli/dist/main.js" "$@"; }`. Keep
the built checkout and its installed dependencies together when using this local
workspace function rather than an installed npm release. For automation, invoke
`node` directly so package-manager banners cannot affect JSON stdout.

Running `pinboard` or `pinboard --help` shows a concise command and option
reference. Detailed behavior, endpoint resolution and credential handling are
documented below.

## Public uploads

**Every upload/import publishes public content. Anyone knowing the CID can read
the blocks. Removing your pin does not erase public blocks, CDN caches, or other
people's copies.** There is no private mode, public flag, or confirmation
prompt. Review the input, especially hidden files, before running an upload.

```powershell
pinboard config set endpoint https://pinboard.shazhou.work
pinboard config set-token
pinboard upload .\photo.bin
pinboard upload '.\my folder' --name example
pinboard import .\archive.car --name example
pinboard list --json
pinboard list --cursor CURSOR --json
pinboard list --all --json
pinboard inspect CID --json
pinboard rename CID "New name"
pinboard remove CID --json
pinboard upload .\photo.bin --endpoint http://localhost:8787
```

`upload` sends ordinary files as binary `kind=file`, including files named
`.car`. It encodes a directory as a complete single-root UnixFS CAR using the
same encoder/options as Web. `import` sends an existing CAR unchanged with
`kind=car`, preserving its root. The server validates authorization, hashes,
codecs and complete DAGs; client checks do not replace these checks.

Hidden files are included, `.gitignore` is not consulted, empty files are kept,
empty directories are ignored, and an entirely empty directory is rejected.
Links and special files are refused. Relative paths are retained under the
directory root without adding the selected directory's name. Inputs changing
during reads fail, but scanning is not an atomic filesystem snapshot.

The upload body and unique DAG bytes are limited to 32 MiB, with at most 256
unique blocks and 2 MiB per block. CAR/directory overhead can exceed the limit
even when the source bytes fit. The encoder uses bounded memory, not a local
IPFS repository or a disk cache.

`--name` defaults to the input basename, must meet the server's 1–200 character
label limit, and does not change content or CIDs. Duplicate labels are allowed.
Saving the same account/CID again updates that pin's label rather than creating
a second reference.

## Rename an existing pin

```powershell
pinboard rename CID "New name"
pinboard rename CID "New name" --json
```

Rename updates only the current account's label, without uploading or reading
content blocks. It requires `pins:write`; names are trimmed and must contain
1-200 characters. The CID, size, block count and creation time do not change,
and other accounts' names for the same CID are independent. Renaming a missing
pin returns 404 rather than creating a reference. Success returns the updated
pin, with the same human/JSON layout as inspect. A lost response can mean the
rename completed; inspect the CID before retrying.

The HTTP API is `PATCH /api/pins/:cid` with a JSON body `{ "name": "New name" }`
and returns the updated pin with status 200. It requires an authenticated
same-origin browser session or an Agent token with `pins:write`. Only `name` is
accepted in the body. The Web **Your pins → Rename** form uses this API, with
Save name and Cancel actions; saving also updates any open details.

## Download and CAR export

`download` reverses `upload`: raw/UnixFS files become ordinary files and UnixFS
directories become local directory trees. `export` pairs with `import`: it saves
a complete single-root CAR without changing its bytes or root CID.

```powershell
pinboard download CID --output .\restored-file.bin
pinboard download DIRECTORY_CID --output .\restored-folder
pinboard export CID --output .\archive.car
pinboard import .\archive.car
```

Both fetch content from the selected endpoint's public CAR API, without an
Authorization header. Endpoint and timeout options still apply; redirects are
refused. No pin is created by either command.

`--output` always wins and skips credentials and private metadata entirely.
Otherwise, an available `PINBOARD_AGENT_TOKEN` or endpoint-bound stored token is
used only to inspect the pin's name (`pins:read` required). Download uses that
name as-is; export appends `.car` unless the name already ends in `.car`
(case-insensitive). Names are treated as a single portable filename, never a
path. Missing credentials, HTTP 401/403/404 for metadata, or an unsafe/overlong
name cause an explicit warning and fallback to `.\CID` or `.\CID.car`. Invalid
local credentials/configuration, network errors, server failures and malformed
metadata remain errors, not silent fallbacks. `--token-stdin` is not accepted by
these public read commands.

The destination must not exist, and its parent must already be a real directory.
Existing files, directories and links are never overwritten or merged.

Before creating output, the CLI verifies the requested root, every block's
SHA-256 hash, supported codecs and complete DAG closure. The existing 32 MiB
unique DAG, 256-block and 2 MiB block limits apply, with bounded CAR framing
overhead. Restoration additionally limits expanded file bytes to 32 MiB, entries
to 10,000 and depth to 256. File contents, hidden files, nested paths and empty
files are retained; metadata/permissions and empty folders ignored by upload
cannot be recovered.

Download refuses symlinks, special entries, path traversal, Windows-reserved or
non-portable names and case-insensitive/Unicode-normalized path collisions.
Generic IPLD DAGs that are not raw/UnixFS files or directories can still be
exported as CARs. Unsafe or unsupported content fails explicitly before output
is created. A failed local write cleans up newly created output when its
identity is still unchanged; a killed process can leave partial output that must
be removed or moved before retrying.

Success returns `{ "cid", "path", "type", "size" }` in `--json` mode, with an
absolute local path and type `file`, `directory` or `car`. Size is restored file
bytes for download and archive bytes for export; binary content is written only
to the destination, never stdout. Human output uses a vertical summary table and
the same timestamped progress/separator style as upload. In JSON mode, filename
fallback emits one structured
`{ "warning": { "code": "PIN_NAME_UNAVAILABLE", "message": "..." } }` line on
stderr; stdout remains the single successful result document.

## Endpoints and credentials

Every network command resolves its endpoint in this order: `--endpoint` >
`PINBOARD_ENDPOINT` > `config.json` > `https://pinboard.shazhou.work`. Only
HTTP(S) origins without credentials, paths, queries or fragments are accepted.
Plain HTTP is restricted to loopback (`localhost`, IPv4 127/8, or `::1`).
Credential-bearing requests never follow redirects, even on the same origin. A
hostile server or compromised local DNS remains outside the client's trust
boundary.

Get an agent token in Web, with only the required scopes (`pins:write` for
upload/import/rename, `pins:read` for list/inspect, `pins:delete` for remove).
The server checks scope, expiry and revocation on every request.

- `pinboard config set-token` reads hidden input from a TTY, without echo.
- For scripts, `pinboard config set-token --token-stdin` reads one token from
  stdin through EOF, optionally followed by one newline. Use a secret manager or
  secure input source; do not put a literal token in shell history.
- Account commands accept `PINBOARD_AGENT_TOKEN` **or** `--token-stdin` as a
  non-persistent override. They are mutually exclusive. An empty environment
  variable is an error, not a fallback. Explicit overrides never read the local
  token map. No token positional argument or `--token VALUE` is supported.
- Unset `PINBOARD_AGENT_TOKEN` before `config set-token`. Explicit token storage
  only uses hidden TTY input or explicit stdin, never silently stores the
  environment.
- Tokens are keyed by normalized origin. Switching endpoints never falls back to
  another origin's token. An explicit token is trusted only for the endpoint
  selected by that command; check the target before providing it.
- `pinboard config remove-token [--endpoint ORIGIN]` removes only that local
  entry. **It does not revoke the server token.** Revoke it in Web.
- `pinboard config get [endpoint]` shows only the effective non-secret endpoint;
  configuration queries never print tokens.

### Local plaintext storage

Non-secret `config.json` and adjacent endpoint-keyed `tokens.json` live in
`%LOCALAPPDATA%\pinboard` on Windows or `$XDG_CONFIG_HOME/pinboard` on POSIX
(default `~/.config/pinboard`). The CLI does not search the working directory.

This is **permission-protected plaintext, not encryption or an OS keychain**. It
isolates ordinary other OS users, not processes running as your user,
administrators/root, backups, or a compromised account.

- POSIX: the directory must be owned by the current user with `0700`; files must
  have `0600`, one hard link and current-user ownership. These zero
  group-mask/other bits also bound effective POSIX ACL access. Configuration
  ancestors must be user/root-owned and not group/world writable.
- Windows: the directory and credential files have verified protected DACLs
  granting only the current user SID full control. `chmod` is **not** used as a
  substitute. Windows PowerShell/.NET ACL support on a suitable local filesystem
  is required. The helper receives only paths, never token bytes or
  token-bearing subprocess arguments. Untrusted ancestor owners or delete-child
  access are rejected.
- Permissions are established and verified **before** secret bytes are written.
  Writes use restricted same-directory staging files, flush, atomic replacement
  and a cross-process lock. Concurrent updates re-read the map under the lock so
  other endpoints are not lost. Links, reparse paths, unexpected hard links,
  malformed maps and unsafe existing files fail closed.

Unknown existing files are not automatically repaired. Inspect ownership,
effective permissions/ACLs and links yourself; if necessary move the old
Pinboard directory aside, create a new secure location and re-enter credentials.
Do not broaden permissions to make a failing filesystem work. If ACL support
cannot be verified, use an explicit environment/stdin override without local
secret storage instead. An unsafe existing non-secret configuration directory
still requires manual repair. A crashed writer can leave `.write-lock` or an
empty/restricted staging file; verify that no writer is active before manually
removing **only** that stale operation-owned path.

## Automation, cancellation and recovery

Human-readable lists show a table of name, size (B, KiB or MiB) and full CID,
without share links. Names are limited to 32 terminal columns, including `...`
when truncated; Unicode display widths are respected. Use `inspect CID` to see
the full name and share link. Inspect displays an aligned vertical table with
Name, Size, CID, Blocks, Created and Share fields. Upload uses the same detail
layout as inspect. An empty list shows `No pins.`. JSON names are never
truncated.

When stdout is a TTY, tables use Unicode box-drawing borders. Pipes and
redirected output keep the plain aligned layout. JSON output never uses borders.

Uploads, imports, downloads and exports show timestamped progress logs on
stderr, without headings or indentation. Non-JSON output separates the logs and
successful stdout table with one blank line, including pipes and redirection.
Progress writes finish before the result is emitted; failures never display a
success table.

`--json` produces exactly one JSON document on success and no stdout on failure.
Human progress goes to stderr; JSON mode suppresses progress and emits one
structured `{ "error": { "code", "message", ... } }` document to stderr. Raw
server/subprocess diagnostics are not echoed. Pin successes use the shared pin
shape; list uses `{ "pins": [...], "nextCursor": null | "..." }`; removal
returns `{ "removed": true, "cid": "..." }`.

Lists default to one page. `--all` buffers pages and emits only after every page
succeeds; a failure, repeated cursor or safety limit never emits a partial
success-shaped list. Extremely large lists should use explicit cursors.

Exit codes: `0` success, `1` operation/service failure, `2` usage/invalid
explicit configuration, `130` interruption. `--timeout MS` bounds input
preparation, token input and network work (default 60000, maximum 3600000).
Ctrl-C cancels reads/encoding and HTTP requests; streams and listeners are
closed. OS permission helpers have a separate 15-second execution bound.

**Writes are never automatically retried.** A lost response, timeout,
interruption or server error may leave a completed upload/removal. Structured
errors include `uncertain: true` and recovery advice when a sent write's outcome
cannot be established. For a known directory/CAR root, inspect that CID before
retrying; for an ordinary file without a returned CID, inspect the account list
and upload name. Do not interpret progress as a completed pin.

## Checks

`pnpm check` includes CLI/shared tests, browser regressions, and actual local
HTTP API integration against the compiled Worker running in workerd, with
synthetic scoped credentials and Miniflare D1/R2. Turbo builds that Worker
before its integration tests; for a direct targeted run, build it first. The CI
matrix runs on Ubuntu and Windows; permission tests exercise the real host
filesystem, not mocked ACL results. Local synthetic credentials are
implementation evidence, not proof of production account authorization. Kubo
interoperability checks remain separate and optional.

Windows CI places credential fixtures under the current user's profile rather
than a potentially replaceable checkout directory. `PINBOARD_TEST_ROOT` can
select a dedicated fixture parent for local tests; it does not change the CLI's
configuration location or relax ownership, DACL, or ancestor checks.
