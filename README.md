# Pinboard

**Pin blocks. Share by CID.**

A deliberately small public IPFS content store: Cloudflare Workers + R2 for
verified blocks, D1 for Google account identities, pin references and Agent
token hashes. React and Hono reuse the fullstack template's same-origin/Auth.js
setup.

Target origin: `https://pinboard.shazhou.work`. **Not deployed.**

## What it does

- Upload a file (UnixFS), a single block, or a complete single-root CAR.
- Validate CID hashes and complete DAG closure before accepting a pin.
- Share by CID without authentication, through raw block responses or CAR
  export.
- Sign in with Google to list, inspect and unpin your own content.
- Give an agent a scoped, expiring, revocable token for HTTP and remote MCP.
- Use explicitly configured Kubo clients as readers, without a server-side Kubo.

All uploaded bytes are **public**, including bytes in failed partial writes.
Account lists, labels, and tokens are private. Unpinning deletes **only your
account reference**. Shared blocks, CDN copies and downloaded copies are not
erased. Physical garbage collection is not implemented.

There is no arbitrary remote CID fetching, DHT announcement, IPNS publishing,
always-on Kubo/Cluster, billing or organization system. A public HTTP endpoint
does **not** make its content automatically discoverable on the public IPFS
network.

## Local development

Requires Node.js >=22.13 and pnpm 11.22 (the pinned package manager).

```powershell
pnpm install
Copy-Item apps\worker\.dev.vars.example apps\worker\.dev.vars
# Set a random AUTH_SECRET and your Google OAuth client ID/secret in .dev.vars.
pnpm --filter @workspace/worker exec wrangler d1 migrations apply pinboard --local
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

## Interfaces

| Route                                             | Access                 | Purpose                                       |
| ------------------------------------------------- | ---------------------- | --------------------------------------------- |
| `/ipfs/:cid?format=raw`                           | Public GET/HEAD        | Raw verified block, never an HTML document    |
| `/routing/v1/providers/:cid`                      | Public GET             | Delegated Routing JSON or NDJSON              |
| `/api/public/:cid/car`                            | Public GET             | Complete DAG as an attachment                 |
| `/share/:cid`                                     | Public                 | Safe share page; no content preview/execution |
| `/api/pins`                                       | Session or Agent token | List or pin an already stored DAG             |
| `/api/pins/upload?kind=file\|car\|block&name=...` | Session or Agent token | Upload; block mode also requires `cid`        |
| `/api/pins/:cid`                                  | Session or Agent token | Detail or DELETE own reference                |
| `/api/tokens` and `/api/tokens/:id`               | Browser session only   | Issue, list or revoke account tokens          |
| `/mcp`                                            | Agent Bearer token     | Stateless MCP Streamable HTTP (POST)          |

Uploads require `X-Pinboard-Public: true`. JSON pin requests require
`{"cid":"...","name":"...","public":true}`. Cookie-authenticated mutations also
require an Origin matching `AUTH_URL` (or `PUBLIC_ORIGIN`). Agent names are
labels, not credentials. Web and MCP use the same `PinService`, accountId and
scopes.

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
pnpm --filter @workspace/worker types

# Install a stable Kubo executable and OpenSSL outside the repository:
$env:IPFS_BIN = 'C:\tools\kubo\ipfs.exe'
$env:OPENSSL_BIN = 'C:\Program Files\Git\usr\bin\openssl.exe'
pnpm test:kubo
```

The Kubo PoC uses a **separate local-only Worker entry** and temporary storage;
its unauthenticated uploader is never mounted by the production Worker. It
starts and stops an offline source daemon, then validates two independent cold
repos, HTTP/2 probe, delegated routing, `cat`, `get`, and byte equality. No
credentials or public deployment are required.

See [Kubo configuration and evidence](docs/kubo.md),
[Agent/MCP usage](docs/mcp.md), and [deployment checklist](docs/deployment.md).

### Local validation completed

- `pnpm check`: all 12 workspace tasks passed (36 tests); the unchanged Worker
  coverage thresholds passed, including 92.89% branch coverage.
- `pnpm test:kubo`: Kubo v0.43.1, stopped source daemon, 16-block DAG, separate
  cold `cat`/`get` repos, 38 HTTP/2 requests and two probes; byte/hash equality.
- Real local Worker + browser, using a synthetic signed test session: upload,
  list/details, copy link, public share, scoped MCP read, rejected write (403),
  token revocation (401), and unpin with continued public block availability
  (200). Management/share layouts fit a 390px viewport. Uploaded HTML did not
  execute.

Synthetic sessions test application behavior, **not Google's OAuth exchange**.
Real Google credentials and the production Cloudflare/domain acceptance checks
remain outstanding.

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
