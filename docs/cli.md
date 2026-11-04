# Pinboard CLI

The CLI is a direct client of the existing Pinboard HTTP API. It needs Node.js
22.13+ and pnpm 11.22+, **not Kubo, an IPFS executable, or a daemon**. It does
not fetch remote CIDs to create pins.

## Build and run

From a checkout, install and build the CLI and its workspace dependencies:

```powershell
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter=@workspace/cli
node .\apps\cli\dist\main.js --help
```

For convenience, define a function in your PowerShell profile (use the absolute
path to your checkout):

```powershell
function pinboard { node C:\Code\pinboard\apps\cli\dist\main.js @args }
```

On POSIX shells the equivalent is
`pinboard() { node "$HOME/code/pinboard/apps/cli/dist/main.js" "$@"; }`. Keep
the built checkout and its installed dependencies together. This is a local
workspace installation, not an npm-published standalone package. For automation,
invoke `node` directly so package-manager banners cannot affect JSON stdout.

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

## Endpoints and credentials

Every network command resolves its endpoint in this order: `--endpoint` >
`PINBOARD_ENDPOINT` > `config.json` > `https://pinboard.shazhou.work`. Only
HTTP(S) origins without credentials, paths, queries or fragments are accepted.
Plain HTTP is restricted to loopback (`localhost`, IPv4 127/8, or `::1`).
Credential-bearing requests never follow redirects, even on the same origin. A
hostile server or compromised local DNS remains outside the client's trust
boundary.

Get an agent token in Web, with only the required scopes (`pins:write` for
upload/import, `pins:read` for list/inspect, `pins:delete` for remove). The
server checks scope, expiry and revocation on every request.

- `pinboard config set-token` reads hidden input from a TTY, without echo.
- For scripts, `pinboard config set-token --token-stdin` reads one token from
  stdin through EOF, optionally followed by one newline. Use a secret manager or
  secure input source; do not put a literal token in shell history.
- Network commands accept `PINBOARD_AGENT_TOKEN` **or** `--token-stdin` as a
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
