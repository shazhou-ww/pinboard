# Agents and remote MCP

## Browser OAuth for interactive clients

The OAuth implementation uses the authorization primitives in MCP's
[2026-07-28 authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
(also compatible with the 2025-11-25 discovery/PKCE flow): RFC 9728 resource
discovery, RFC 8414 authorization-server discovery, RFC 7591 dynamic
registration of **public clients**, and authorization-code grant with mandatory
**S256 PKCE** and RFC 8707 resource indicators. Google remains the browser
identity provider, not the MCP authorization server: no Google access/refresh/ID
token is issued to the MCP client.

The newer specification prefers Client ID Metadata Documents (CIMD) and retains
DCR as a deprecated compatibility fallback. This implementation deliberately
offers that fallback, not CIMD/remote metadata fetching; clients must support
DCR. Registration returns only `authorization_code` even if a client
additionally requests refresh/device grants. Authorization responses include the
issuer (`iss`) for mix-up protection.

**Selected real client: Visual Studio Code with GitHub Copilot**. VS Code
[documents MCP OAuth support](https://code.visualstudio.com/api/extension-guides/ai/mcp)
and
[remote HTTP configuration](https://code.visualstudio.com/docs/agents/reference/mcp-configuration).
This is the intended external compatibility target, **not an externally tested
claim**. Record the exact stable VS Code/Copilot versions during authorized
deployment validation; local protocol tests do not replace that check.

After an authorized migration/release, add a remote HTTP server in VS Code's MCP
configuration, with **no Authorization header or pasted token**:

```json
{
  "servers": {
    "pinboard": {
      "type": "http",
      "url": "https://pinboard.shazhou.work/mcp"
    }
  }
}
```

1. Start the server/connection in VS Code. Its first unauthenticated request
   receives a `401` challenge linking to
   `/.well-known/oauth-protected-resource/mcp`. Discovery points to the same
   origin's `/.well-known/oauth-authorization-server`.
2. The client registers its callback at `POST /oauth/register` and opens
   `/oauth/authorize` with `resource` exactly equal to the canonical `/mcp` URL,
   `response_type=code`, a fresh verifier's S256 challenge, and client state.
   The callback must exactly match a registered URI (including port/query).
   HTTPS is supported; HTTP is allowed only for numeric loopback `127.0.0.1` or
   `[::1]`, per RFC 8252 §7.3. No wildcards, fragments, credentials in the
   authority, arbitrary HTTP hosts or `localhost` exception.
3. Sign in through the existing CSRF-protected Google browser login. The return
   path is the local `/connect/mcp` consent page. **Sign-in alone never grants
   access.** Review the unverified client name, client ID, exact callback,
   resource, account and requested permissions. Select only required scopes.
   With no requested scope the server defaults to `pins:read`; clients must
   request write/delete scopes explicitly if needed.
4. Choose **Allow selected permissions** or **Cancel connection**. Cancellation
   returns `access_denied` with the original client state and creates no grant.
   Closing the page also grants nothing. Requests are browser-cookie-bound,
   account-bound when reviewed, single-use and expire after **10 minutes**.
   Switching accounts requires restarting authorization. A signed browser
   session whose account no longer exists in D1 is rejected by protected routes
   and requires Google sign-in again, rather than failing consent with a server
   error. If an older deployed release shows a server error immediately, sign
   out of Pinboard, sign in again and start a new connection from the MCP
   client.
5. After approval, the client exchanges the **60-second**, one-use code at
   `POST /oauth/token` with the original client ID, exact callback, resource and
   verifier. One atomic database update prevents concurrent double redemption.
   The response contains an opaque **one-hour** access token and selected scope.
   Access credentials are only accepted in an Authorization header at `/mcp`,
   never in a URL and never at private `/api/*` routes.

**No refresh token is issued.** Reconnect and approve again after expiry. This
keeps refresh rotation/reuse recovery out of scope. The homepage's **MCP client
authorizations** section lists approval metadata, scope and status, and permits
revocation using only a Google browser session. API tokens and OAuth credentials
cannot view or change grants or API tokens. Revocation invalidates both any
unexchanged code and issued credential; every subsequent MCP request checks D1.
An operation already authenticated/in flight may finish. Expired/revoked
metadata remains visible; OAuth records currently have no automatic history
purge. Only token/code/browser-binding hashes are persisted.

Consent/API/code/token responses use `Cache-Control: no-store` and
`Referrer-Policy: no-referrer`; the static consent page supplies these headers
too. Treat the browser history's short-lived OAuth authorization code as
sensitive even though it cannot be exchanged without PKCE. No request URLs,
credentials or verifier values should be captured in access logs or diagnostics.
Public DCR permits self-selected, **unverified client labels**, not trusted
software identities. Before exposing this flow publicly, configure appropriate
edge rate limits/abuse controls for registration/authorization/token endpoints;
registration and grant metadata consume D1 storage.

### External verification still pending

Migration `0004_mcp_oauth.sql` is additive. Applying it in production requires
separate authorization; release/deploy follows the existing
[deployment guide](deployment.md). No new Google callback or additional secrets
are required: keep the canonical `AUTH_URL` origin, Google callback and SPA/API
origin aligned. Vite proxies `/oauth/*` and `/.well-known/*` locally; Workers
routes those paths before assets while `/connect/mcp` remains the SPA.

In the authorized HTTPS environment, record the environment and exact client
versions, then verify discovery, real Google sign-in, explicit approval and an
allowed `list` tool call without copying credentials. Repeat with write scope,
read-only denial, cancel/close, account switching, expiry/reconnection,
revocation and another account's pins. Verify unchanged API-token MCP and CLI
calls. Record sanitized outcomes only, including the observed in-flight
revocation boundary. These are deployment-pending checks, not local acceptance
or lifecycle approval.

## API tokens for CLI, scripts and non-interactive agents

Sign in with Google, create an Agent token, select the minimum permissions, copy
it once, and configure the intended agent to send it as:

```text
Authorization: Bearer <YOUR_AGENT_TOKEN>
```

Remote endpoint: `https://pinboard.shazhou.work/mcp` after deployment. Local
endpoint: `http://localhost:5173/mcp` via the Vite proxy. Never put tokens in
URLs or commit them to an agent config. Use your agent's
secret/environment-variable mechanism. A label such as `My assistant` provides
no authentication.

The official `@modelcontextprotocol/sdk` implements stateless Streamable HTTP
with JSON responses. POST is supported; standalone SSE GET/session DELETE
return 405. Every request is authenticated independently, including initialized
notifications. Clients should send the normal MCP Accept headers:

```text
Accept: application/json, text/event-stream
Content-Type: application/json
```

Tools:

| Tool     | Scope         | Input                                                                 |
| -------- | ------------- | --------------------------------------------------------------------- |
| `list`   | `pins:read`   | optional `cursor`                                                     |
| `detail` | `pins:read`   | `cid`                                                                 |
| `upload` | `pins:write`  | `kind`, `name`, `contentBase64`, `public: true`; `cid` for block mode |
| `pin`    | `pins:write`  | `cid`, `name`, `public: true`                                         |
| `unpin`  | `pins:delete` | `cid`                                                                 |

Inline MCP data is limited to 2 MiB decoded. `kind` is `file`, `car` or `block`.
CAR requires a single root and all reachable blocks; `pin` only references
content already in Pinboard. Unpin removes only the calling account's reference.
Expected permission/validation errors are MCP tool results with `isError: true`,
not success-shaped fallbacks.

For a larger file/CAR (up to 32 MiB), use an API token on the HTTP route (MCP
OAuth credentials are deliberately not accepted there), then use MCP to list or
manage the returned CID. Example PowerShell:

```powershell
# Set PINBOARD_AGENT_TOKEN locally using your secret manager, not in this file.
$headers = @{
  Authorization = "Bearer $env:PINBOARD_AGENT_TOKEN"
  'X-Pinboard-Public' = 'true'
}
Invoke-RestMethod `
  -Uri 'https://pinboard.shazhou.work/api/pins/upload?kind=car&name=archive.car' `
  -Method Post -Headers $headers -ContentType 'application/vnd.ipld.car' `
  -InFile .\archive.car
```

Use the Google-authenticated Web UI to revoke tokens. Agent tokens cannot mint,
list or revoke tokens, and cannot choose an `accountId`. Identity is always
derived from the credential server-side. Revocation/expiry are checked on each
request; an in-flight authorized operation may complete. Existing API-token
formats, CLI environment variables and MCP configurations remain unchanged.
