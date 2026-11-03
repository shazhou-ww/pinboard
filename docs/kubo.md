# Kubo HTTP retrieval

## Verified locally, not yet verified on the production domain

The latest non-prerelease Kubo release checked on 2026-11-03 was **v0.43.1**
(published 2026-09-15). The Windows AMD64 release was downloaded and its SHA-512
matched the release checksum.

Versioned upstream evidence:

- [HTTPRetrieval configuration](https://github.com/ipfs/kubo/blob/v0.43.1/docs/config.md#httpretrieval)
- [Kubo's HTTP-only provider test](https://github.com/ipfs/kubo/blob/v0.43.1/test/cli/http_retrieval_client_test.go)
- [Trustless raw responses and probe](https://specs.ipfs.tech/http-gateways/trustless-gateway/)
- [Delegated Routing HTTP specification](https://specs.ipfs.tech/routing/http-routing-v1/)

The source and config require **TLS and HTTP/2** for block providers. Plain HTTP
providers are ignored. A local `wrangler dev` HTTP server alone is therefore not
a meaningful Kubo retrieval test.

Kubo probes `HEAD /ipfs/bafkqaaa?format=raw` (empty identity block), expects a
200 raw response, and subsequently requests individual blocks with `?format=raw`
/ `Accept: application/vnd.ipld.raw`.

Provider responses use the `peer` schema, a stable Peer ID and a
`/dns4/.../tcp/443/tls/http` multiaddr. The Peer ID here is an HTTP provider
identifier, not an account, Agent credential, or a claim that a libp2p server
exists. Both JSON `{ "Providers": [...] }` and streaming NDJSON are supported.
Unknown blocks produce an empty provider set.

## Reproducible PoC

From the repository root:

```powershell
$env:IPFS_BIN = 'C:\tools\kubo\ipfs.exe'
$env:OPENSSL_BIN = 'C:\Program Files\Git\usr\bin\openssl.exe'
pnpm test:kubo
```

Requires unused loopback ports 8787, 9443, 15000-15003. The script:

1. Creates a fresh source repo and a directory containing random 3 MiB +
   137-byte content and a text file.
2. Adds it with 256 KiB chunks, CIDv1/raw leaves, and exports its complete CAR.
3. Starts an offline source daemon, shuts it down, and waits for its exit.
4. Uploads the CAR to the actual block validator and local simulated R2 using
   `wrangler.poc.jsonc`. No production bucket is accessed.
5. Places a temporary self-signed TLS **HTTP/2** proxy before the gateway.
6. Initializes separate `consumer-cat` and `consumer-get` repos, confirms the
   root is absent offline, and disables bootstrap, swarm listeners and mDNS. The
   only delegated router is the local service.
7. Asserts routing returns the advertised HTTP provider, runs `ipfs cat` and
   `ipfs get` in the separate repos, and compares both files byte-for-byte.
8. Runs the exact browser directory encoder on the same bytes, arranged as a
   nested folder with an empty file, then uploads its CAR through the Worker's
   existing validator. A third fresh repo retrieves this root using `ipfs get`
   and verifies the nested paths, empty file and byte equality.
9. Asserts an HTTP/2 probe and multiple raw block requests were observed.
10. Stops its own processes and removes its exact temporary directory.

The local test requires `HTTPRetrieval.TLSInsecureSkipVerify=true` solely for
the generated self-signed certificate. **Never copy that setting to
production.** The test entry has an unauthenticated upload route solely for this
temporary loopback fixture. The production entry does not import it.

A recorded local run downloaded a 16-block DAG (3,146,662 unique block bytes)
through both cold repos. This establishes the protocol path using the Worker
handlers/R2 simulator, not public edge TLS, remote R2, real Google sign-in or
general public IPFS discovery.

The source-stopped run returned root
`bafybeigkqgoazhm57rt3wxnmoxpotp3ld6wu2a4hqkqljfb2wcghau42f4`; both consumers
verified payload SHA-256
`7245c91c5b6be3e68da624f6e215c7dbdae4790998f40b63cf5e3ff03f30983e`. It observed
38 HTTP/2 requests including two dedicated probes. Random input means later runs
intentionally produce different CIDs and hashes.

## Production client configuration (after an approved deployment)

Stop your Kubo daemon before changing config:

```powershell
ipfs config --json HTTPRetrieval.Enabled true
ipfs config --json Routing.Type '"autoclient"'
ipfs config --json Routing.DelegatedRouters '["https://pinboard.shazhou.work"]'
ipfs config --json HTTPRetrieval.Allowlist '["pinboard.shazhou.work"]'
ipfs daemon
```

On Windows shells where native JSON argument quoting is altered, use
`ipfs config edit` and set these exact values instead:

```json
{
  "Routing": {
    "Type": "autoclient",
    "DelegatedRouters": ["https://pinboard.shazhou.work"]
  },
  "HTTPRetrieval": {
    "Enabled": true,
    "Allowlist": ["pinboard.shazhou.work"]
  }
}
```

Merge those keys into the existing config; do not replace the entire file. Leave
TLS verification enabled. `auto` also supports delegated routers; `dht`/`none`
alone do not establish this HTTP-provider route. The shown delegated router list
replaces previous routers; add other trusted routers only if you intentionally
want them. The allowlist restricts HTTP block providers to Pinboard; it does not
disable Bitswap or the DHT.

```powershell
ipfs routing findprovs <CID>
ipfs cat /ipfs/<CID>/path/to/file
ipfs get <CID> -o .\retrieved
```

For a single file root, `ipfs cat <CID>` is sufficient. Only uploaded DAGs are
available. Pinning an absent CID returns an incomplete-DAG error instead of
causing a recursive internet fetch.

## Acceptance before claiming production compatibility

- Check `HEAD https://pinboard.shazhou.work/ipfs/bafkqaaa?format=raw` over
  HTTP/2: 200, raw content type, length 0, no redirect.
- Check routing JSON and NDJSON and the advertised production multiaddr.
- Upload using a real account, turn off the source node, then use a **new
  independent** Kubo repo with no cached content for `cat` and `get`.
- Verify full directory bytes/hashes, not only the root block.

No public-network or production-domain validation has been claimed. If edge
HTTP/2/probe/routing fails, first correct that configuration. The minimal
fallback is public CAR download followed by local `ipfs dag import`; it does not
require adding a server-side Kubo or expanding the architecture.
