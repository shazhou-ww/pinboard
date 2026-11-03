# Deployment checklist

No push, remote resource creation, secret update, DNS change or deployment was
performed during implementation. The commands below are instructions, not a
record of completed operations. Run them only after explicit approval.

## Missing configuration

- Cloudflare account and a narrowly scoped API token for the exact target
  Worker, R2 bucket and D1 database.
- R2 bucket `pinboard-blocks`, D1 database `pinboard`, and its real database
  UUID.
- Google OAuth Web client ID/secret and callback configuration.
- Random `AUTH_SECRET` and correct `AUTH_URL`.
- Domain `pinboard.shazhou.work` attached as the Worker's custom domain, valid
  TLS/HTTP2, and matching provider multiaddr.

## 1. Provision and configure

From the Worker workspace, after confirming the intended Cloudflare account:

```powershell
pnpm --filter @workspace/worker exec wrangler r2 bucket create pinboard-blocks
pnpm --filter @workspace/worker exec wrangler d1 create pinboard
```

Replace the placeholder `database_id` in
[`wrangler.jsonc`](../apps/worker/wrangler.jsonc) with the returned UUID. Do not
treat the all-zero placeholder as a working remote binding. R2 should remain
private: public reads are mediated by the raw gateway, not an R2 website.

The Worker uses the template's pinned runtime and compatibility date
`2026-10-14`. A local attempt with `2026-11-03` failed because the installed
workerd supports dates only through `2026-10-19`; the template baseline was
retained rather than silently upgrading it. Advance the date only alongside
runtime support and regression tests.

Generate and check binding types after configuration changes:

```powershell
pnpm --filter @workspace/worker types
pnpm check
```

## 2. Google and secrets

Google Web client settings:

```text
Authorized JavaScript origin:
https://pinboard.shazhou.work

Authorized redirect URI:
https://pinboard.shazhou.work/api/auth/callback/google
```

Set these Worker secrets using interactive input or a protected stdin/file
workflow; do not paste secret values into command history:

```powershell
pnpm --filter @workspace/worker exec wrangler secret put AUTH_SECRET
pnpm --filter @workspace/worker exec wrangler secret put AUTH_URL
pnpm --filter @workspace/worker exec wrangler secret put AUTH_GOOGLE_ID
pnpm --filter @workspace/worker exec wrangler secret put AUTH_GOOGLE_SECRET
```

`AUTH_URL` is `https://pinboard.shazhou.work/api/auth`. Note that
`wrangler secret put` changes the deployed Worker; it is not merely local
configuration. Use the versioned secret workflow if staging is required.

The initial version intentionally ignores other template identity providers. D1
maps Google's stable subject to an internal random accountId. Email, display
name and Agent label never determine ownership.

## 3. Migrate and deploy

```powershell
pnpm --filter @workspace/worker exec wrangler d1 migrations apply pinboard --remote
pnpm check
pnpm deploy
```

Attach the custom domain through Cloudflare's approved domain-management path.
`PUBLIC_ORIGIN`, `AUTH_URL`, the actual domain and `PROVIDER_MULTIADDR` must
agree. The stable HTTP provider ID identifies only this HTTP endpoint; no libp2p
private key or network listener is required.

Static assets run the Worker first for `/api/*`, `/ipfs/*`, `/routing/*` and
`/mcp`. Do not change those routes to SPA fallback. The `wrangler.poc.jsonc`
fixture is **never** a deployment configuration.

The inherited GitHub workflow keeps push deployment disabled unless
`CLOUDFLARE_DEPLOY_ENABLED=true` is explicitly set. Do not enable it as part of
local initialization. Review workflow permissions/secrets before any manual run.

## 4. Production acceptance

- Google sign-in/out, stable accountId across repeat logins.
- Upload/download a multi-block DAG with a real account and real R2/D1.
- Anonymous lists and writes rejected; cross-account pin deletion rejected.
- Shared blocks remain readable after either account unpins.
- Agent scope restrictions, expiry, revocation, actual agent MCP client.
- Uploaded HTML/JS is returned only as a raw/CAR attachment with `nosniff` and a
  restrictive sandbox CSP; it is never inserted as HTML or framed in the
  authenticated interface.
- Fresh independent Kubo repos successfully `cat`/`get` after source shutdown,
  following [the Kubo acceptance checks](kubo.md).
- Cloudflare logs and traces enabled; verify latency, CPU, subrequest limits and
  error rates under your expected traffic.

Local tests and `wrangler deploy --dry-run` do not verify these production
properties. Physical block GC, takedown workflows, upload quotas/rate limiting
and abuse operations are not implemented. Review them before broad public
registration; Google login is authentication, not an abuse policy.
