# Agents and remote MCP

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

For a larger file/CAR (up to 32 MiB), use the same token on the HTTP route, then
use MCP to list or manage the returned CID. Example PowerShell:

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
request; an in-flight authorized operation may complete. No refresh flow or MCP
OAuth authorization server is included in this first version.
