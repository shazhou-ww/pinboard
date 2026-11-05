# Tag-driven production deployment

This guide covers the Cloudflare application. CLI npm publication uses separate
`@shazhou/pinboard@x.y.z` tags and is documented in
[npm releases](npm-release.md).

Production deployment is driven by **`release-YYMMDD-INDEX` tags**, not npm
semantic versions, GitHub Releases, or a release branch.

- A push to `main` runs CI only.
- A tag such as `release-261103-1` runs the production deployment workflow.
- `YYMMDD` is a valid calendar date in 2000-2099, chosen by the releaser; it
  does not have to equal the runner's UTC date.
- `INDEX` is a positive integer without leading zeros: `1`, `2`, `3`, etc.
- The tagged commit must already be on `origin/main`.
- A bare `release-*` match is not enough: invalid dates and tag formats fail
  before any remote mutation.
- There is no `workflow_dispatch` deployment or `CLOUDFLARE_DEPLOY_ENABLED`
  switch. Normal branch pushes cannot deploy, regardless of old variable values.

No release tag or production deployment is created by configuring this workflow.

## One-time bootstrap status

On 2026-11-03 the authorized bootstrap created the application resources. The
table records their current identities, including the separately authorized
2026-11-04 D1 replacement described below:

| Resource              | Value                                               |
| --------------------- | --------------------------------------------------- |
| Cloudflare account ID | `92c3c4fdcc84a1590555bccf4f111de2`                  |
| Worker                | `pinboard`, initially a 503 placeholder             |
| D1 database           | `pinboard` / `9f15fd50-e103-459f-9f3f-9db3036f91de` |
| Private R2 bucket     | `pinboard-blocks`, managed public access disabled   |
| Custom domain         | `pinboard.shazhou.work`, attached to `pinboard`     |

At bootstrap time, the full application and OAuth secrets were **not** deployed.
The initial schema was subsequently prepared on 2026-11-03 through a separately
authorized operation before the first application release. Deployment does not
initialize or migrate D1. Do not re-create these resources or re-bind the domain
during routine CI. The bootstrap credential stays in `cfg`; it must not be
copied into GitHub.

On 2026-11-04 the user explicitly authorized discarding all production D1 test
data and recreating this database for the retention release. The original D1
UUID `625b568d-106b-4fe1-af33-3eac4fe0a354` was deleted; the current UUID above
is a new empty database, not an in-place migration or fallback. R2 was not
deleted. See [production reset evidence](retention-production.md) for the
independently authorized schema operation, cutover and acceptance results.

The publications release requires the additive
[`0006_publications.sql`](../apps/worker/migrations/0006_publications.sql)
migration before deploying its application code. It can be applied while the
previous release is still serving traffic; doing so does not activate the
feature. Once publications or recently deleted objects exist, do not roll back
to retention-unaware application code: it cannot protect publication-only
references or enforce the recovery window. Prefer a forward fix that preserves
the new retention model. Schema application still requires separate
authorization and is not part of tag-driven deployment.

## 1. Provision production resources once

The workflow expects these resources to exist in the intended Cloudflare
account:

- Worker `pinboard`.
- Private R2 bucket `pinboard-blocks`.
- D1 database `pinboard`.
- Custom domain `pinboard.shazhou.work`, with valid TLS and HTTP/2.

If needed, provision the bucket/database with an explicitly authorized bootstrap
credential, not the long-lived least-privilege deployment token:

```powershell
pnpm --filter @shazhou/pinboard-worker exec wrangler r2 bucket create pinboard-blocks
pnpm --filter @shazhou/pinboard-worker exec wrangler d1 create pinboard
```

The verified production database UUID is recorded in
[`wrangler.jsonc`](../apps/worker/wrangler.jsonc). If provisioning a different
environment, record its real database UUID **before** creating a release tag.
The workflow rejects an all-zero placeholder before deployment. Resource
creation and custom-domain setup are not performed automatically.

An existing Worker can be deployed with per-Worker Editor permissions; creating
a new Worker instead requires product-level Workers Admin. Either bootstrap the
Worker separately or deliberately authorize the broader first deployment, then
reduce the CI token's permissions. Do not silently broaden the permanent token.

Keep the R2 bucket private; reads go through the trustless gateway, not an R2
website. Attach the custom domain through Cloudflare's approved
domain-management path. `PUBLIC_ORIGIN`, the domain and `PROVIDER_MULTIADDR`
must agree.

The pinned workerd does not support today's compatibility date. Keep the
template's `2026-10-14` baseline until a separately validated runtime upgrade.
After binding configuration changes:

```powershell
pnpm --filter @shazhou/pinboard-worker types
pnpm check
```

## 2. Create a dedicated Cloudflare deployment token

Use an account-owned API token with **Individual/Specified Workers → pinboard →
Editor** as its only permission policy. In the dashboard, select the account,
then **Manage account → Account API tokens → Create Token**.

Editor can deploy code/assets and update the existing Worker's secrets. Do not
add account-wide `Workers Scripts / Edit`: that legacy permission is broader
than the individual-Worker policy. Remove unrelated selected permissions and
empty policies rather than granting permissions to the entire account to clear a
form error.

The deployment token does **not** need D1 administrative/query permissions.
Production schema changes, backfills and cutovers use separately authorized
credentials and never run in the release workflow. The deployed application's
normal access through its configured D1/R2 bindings is unaffected; control-plane
token scoping does not remove those runtime capabilities.

Separate R2 data permissions are **not** required just to deploy a Worker with
an existing R2 binding. Bucket creation or direct R2 administration is a
bootstrap operation and requires its own permissions.

Do not grant Workers Routes Write, Zone or DNS permissions to the deployment
token. The domain has already been attached; changing Routes or Custom Domains
is a separate, explicitly authorized operation, not part of this workflow.
Cloudflare currently documents additional limitations for per-Worker roles and
Custom Domains; verify the token against your actual setup before releasing.

References:
[Workers permissions](https://developers.cloudflare.com/workers/authorization/workers/)
and
[API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/).

## 3. Configure GitHub's `production` Environment

In the repository's **Settings → Environments**, create `production`. Store
these **Environment secrets** there:

| Name                    | Value                                                                  |
| ----------------------- | ---------------------------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID` | Target Cloudflare account's 32-character ID                            |
| `CLOUDFLARE_API_TOKEN`  | Dedicated deployment token                                             |
| `AUTH_SECRET`           | New cryptographically random production secret, at least 32 characters |
| `AUTH_GOOGLE_ID`        | Google OAuth Web client ID                                             |
| `AUTH_GOOGLE_SECRET`    | Google OAuth client secret                                             |

Enter values directly in GitHub or through a protected CLI/stdin workflow; never
put them in committed files or command arguments. The ignored local `.dev.vars`
file is **not** uploaded by CI. Use a separate production `AUTH_SECRET`;
rotating it invalidates existing browser sessions.

The deployment derives `AUTH_URL` from `PUBLIC_ORIGIN`, producing
`https://pinboard.shazhou.work/api/auth`. Do not copy the localhost auth URL
into production.

Google Web client settings:

```text
Authorized JavaScript origin:
https://pinboard.shazhou.work

Authorized redirect URI:
https://pinboard.shazhou.work/api/auth/callback/google
```

For deployment branch/tag protection, allow **tags matching `release-*`**. A
"protected branches only" rule can reject tag deployments even when their
commits are on main. Required reviewers may be added if desired; the workflow
then waits for approval instead of deploying immediately.

Use repository tag rulesets to restrict creation of `release-*` tags to trusted
release operators and prevent tag rewrites. The workflow's `GITHUB_TOKEN` has
only `contents: read`; the release operator's separate Git credential needs
permission to push the code, workflow files and tags.

## 4. Publish a release

After production configuration is complete and `main` has passed CI:

```powershell
git switch main
git pull --ff-only origin main
pnpm check

git tag -a release-261103-1 -m "Release 261103-1"
git push origin release-261103-1
```

Use your intended date and the next unused daily index. Push `main` before its
release tag. Do not create a release branch or change package versions.

The workflow checks out the **tagged commit**, validates its name and main
ancestry, installs the lockfile, and runs all repository checks. It then:

1. Checks that all five production secrets and the real D1 UUID are configured.
2. Writes only the Worker auth secrets to a mode-0600 temporary JSON file.
3. Deploys the Worker, built static assets and auth secrets together using
   Wrangler's supported `--secrets-file`, with the release tag as version
   metadata.
4. Removes the temporary file on success or failure.

The
[atomic secrets upload](https://developers.cloudflare.com/workers/configuration/secrets/#upload-secrets-alongside-code)
avoids a second `wrangler secret bulk` deployment after the code deployment. The
Cloudflare API token is never included in the Worker's secret file.

There is no production D1 command in the deployment workflow. The D1 UUID check
reads only local configuration and does not query or change the remote database.
Retrying a release does not initialize tables, apply SQL or start a data
migration.

Deployments share one production concurrency group and do not cancel an active
deployment. GitHub may replace pending runs; this is not a guaranteed FIFO
release queue. Publish one release at a time and verify it before publishing
another. Re-running an older successful release can roll back code, **not D1
schema or stored content**.

The deploy command explicitly uses the production `wrangler.jsonc`, never the
unauthenticated local PoC fixture.

### CAR storage rollout prerequisite

The CAR-indexed Worker requires the additive
[`0002_car_storage.sql`](../apps/worker/migrations/0002_car_storage.sql) schema
**before code deployment**. This is a separate authorized operation; do not give
the release token D1 administrative permissions or add migrations to the release
workflow.

After implementation acceptance, use the authorized D1 operator credential
without printing or copying it. Target account
`92c3c4fdcc84a1590555bccf4f111de2`, database `pinboard`
(`625b568d-106b-4fe1-af33-3eac4fe0a354`), and the production config explicitly.
First inspect the actual schema and migration tracking:

```powershell
pnpm --filter @shazhou/pinboard-worker exec wrangler d1 execute pinboard --remote --config wrangler.jsonc --command "SELECT name, sql FROM sqlite_master WHERE type='table' AND name IN ('accounts','pins','car_dags','car_blocks','d1_migrations')"
```

For the existing manually initialized database, if the original tables exist and
both CAR tables are absent, apply **only** the additive file:

```powershell
pnpm --filter @shazhou/pinboard-worker exec wrangler d1 execute pinboard --remote --config wrangler.jsonc --file migrations\0002_car_storage.sql
```

Do not blindly run all migrations on an existing database whose `0001` was
initialized outside Wrangler's migration ledger. If CAR tables already exist,
verify their exact columns, checks, foreign key and indexes against `0002`; do
not rerun non-idempotent CREATE statements. A partial or conflicting schema
needs deliberate reconciliation before deployment. For a genuinely empty new
database, the normal `d1 migrations apply` path can initialize both migrations.

Verify the schema again, record the result without credentials, then publish the
next unused `release-YYMMDD-INDEX` tag at the accepted primary commit using the
existing workflow. No tag is created by the implementation or this guide. After
CAR-only writes begin, **do not roll back to the old block-only reader**:
additive schema compatibility does not make old code able to read new objects.
Retain the CAR-aware reader and forward-fix. See [storage recovery](storage.md).

Production smoke must use the existing authenticated upload API/CLI, scoped
short-lived Agent credentials supplied through the environment, and public
raw/CAR download routes. Never mount the unauthenticated local PoC uploader.
Record cold/cache-busted and repeated-response timings separately, verify raw
payloads and independently reconstruct the CAR in offline Kubo, check a
pre-existing legacy CID and denial of anonymous writes, then revoke the smoke
token and remove only its account pins. Content remains public by design. R2
request-count claims require platform traces/metrics, not HTTP latency alone;
local counted-binding evidence is not a substitute for real R2 evidence.

## 5. Independent hot migrations

Hot migration means **dual-write → backfill/catch-up → cutover**, not running
SQL as a deployment step:

1. Prepare the compatible target schema/storage through a separately authorized
   operation. The initial schema remains in
   [`0001_pinboard.sql`](../apps/worker/migrations/0001_pinboard.sql); it is not
   executed automatically in production.
2. Introduce dual-write compatibility code and enable it under migration
   control, with idempotent writes, retry/reconciliation and observable
   failures.
3. Backfill historical data and catch up incremental changes, tracking progress
   and verifying consistency before switching reads.
4. Cut over reads only after validation; retain dual-write and a rollback
   window.
5. Stop old writes and clean up obsolete data/schema only as a separate,
   explicitly approved follow-up.

Application releases may contain compatibility code needed for a phase, but
publishing a tag must not automatically start backfills, change migration state
or cut over traffic. Migration credentials stay outside the deployment
Environment and are granted only to the independently authorized process.

No active data migration or migration controller is introduced by this
configuration change. For a new environment, separately initialize and verify
its empty database before the first full application release; otherwise
authenticated application operations cannot work.

## 6. Production acceptance and remaining setup

The real D1 UUID and one-time resource/domain allocation are recorded above. The
initial schema was independently verified before `release-261103-1`, whose
deployment workflow completed successfully. Production acceptance is separate
from a successful upload.

The homepage lists only configured login providers. Its buttons use the existing
`@hono/auth-js/react` sign-in client to obtain CSRF protection, POST to the
provider's sign-in endpoint, and redirect directly to that provider without an
intermediate Auth.js sign-in page. Only Google is enabled in the first version.
Google authorization requests explicitly use `prompt=select_account`, preserving
Google's account chooser even when a Google browser session already exists.

The homepage's sign-out button uses the same client's CSRF-protected
`POST /api/auth/signout` and returns directly to `/`, without a confirmation
page. Signing out clears this site's browser session; it does not sign out the
Google account globally or revoke Agent tokens.

`GET /api/auth/signin?callbackUrl=/` remains a native Auth.js fallback. A direct
provider `GET /api/auth/signin/google` is unsupported and must not be used as a
login link. Regression tests cover configured homepage options, the native form,
CSRF cookie and OAuth authorization redirect; a real Google round trip still
requires the user's browser.

Before calling a release successful, verify:

- Google sign-in/out and stable internal accountId across repeat logins.
- Upload/download a multi-block DAG using real R2/D1.
- Anonymous lists/writes and cross-account pin deletion are rejected.
- Shared blocks remain readable after either account unpins.
- Agent scopes, expiry, revocation and an actual MCP client work.
- Uploaded HTML/JS is returned only as a raw/CAR attachment with `nosniff` and a
  restrictive sandbox CSP, never rendered in the logged-in interface.
- Fresh independent Kubo repos can `cat`/`get` after source shutdown; follow
  [the Kubo acceptance checks](kubo.md).
- Logs/traces, CPU, subrequest limits and expected traffic are acceptable.

Local checks and `wrangler deploy --dry-run` are not a production deployment.
The retention-aware release includes bounded automatic GC; see the rollout
prerequisite below. Takedown workflows, quotas/rate limiting and abuse
operations remain separate. Google login is authentication, not an abuse policy.

## Retention rollout prerequisite

Before deploying the retention-aware Worker, separately authorize and verify
`0003_retention.sql` after the existing migrations. Stop old writers during this
cutover: the new object reservation/fencing and reference timestamp protocol is
not compatible with an old writer. Do not add migrations to the tag workflow.
Keep verified D1/R2 backups and a retention-aware forward-fix artifact.

The new configuration registers an hourly UTC Cron Trigger. In a separately
authorized non-production environment, verify migration against representative
existing CAR/legacy data, unknown-pin backfill safety, the scheduled entrypoint,
logs, failure retries and active/history token views before authorizing any
production rollout. New deletion claims stay blocked until live pin closures are
verified, and legacy/orphan observations get conservative grace periods. Check
actual Workers CPU/subrequest budgets against the bounded workload.

To pause cleanup, remove the Cron Trigger using a separately authorized
configuration update; allow already-running invocations to settle. Do not
downgrade to an old writer, erase `deleting` claims, or apply R2 lifecycle
expiry. See
[storage retention and recovery](storage.md#retention-and-automatic-cleanup) for
limits, operational queries and failure handling. Local tests/dry runs do not
prove external scheduled execution. This repository change does not deploy,
create a release tag, or enable deployment on branch pushes.
