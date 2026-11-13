# Publication IPNS reading

This is a local implementation candidate, not evidence of production deployment.
Publication IDs, history, permissions, `/p/{id}` and fixed-version links remain
Pinboard APIs. IPNS adds a signed mutable pointer, not a file renderer or user
identity certificate. There is no DHT, PubSub, delegated-routing, DNSLink or
arbitrary IPNS upstream lookup.

## Enabling and reading

Names are allocated lazily: existing Publications are not backfilled, and new
Publications do not require signing infrastructure until their owner opts in.
Using the normal authenticated API:

- `GET /api/publications/{id}/ipns` returns `{ "enabled": false }` before
  opt-in, otherwise the name, sequence, value, expiry, TTL, lifetime and
  custody.
- `POST /api/publications/{id}/ipns` with JSON
  `{ "acknowledgePublicExposure": true }` enables IPNS idempotently. Public
  Publications require that acknowledgement. The owner needs `publications:read`
  and `publications:write`; metadata reads require read scope. Private
  Publications may enable with `{}` without making the pointer public. Establish
  the Publication-to-name association using this trusted owner API and trusted
  sharing; a valid signature alone does not establish that association.
- `GET` or `HEAD /ipns/{name}?format=ipns-record`, or the same path with
  `Accept: application/vnd.ipfs.ipns-record`, returns the raw signed record.
  Names are Ed25519 inline-public-key libp2p-key CIDs, emitted in base36; base32
  CID representations resolve to the same binding.
- Paths, other query parameters, duplicate formats, unsupported formats and
  unacceptable media ranges return 406. The endpoint does not return Publication
  JSON, plaintext CIDs, redirects or UnixFS paths.

Private records require the same owning account and `publications:read` scope;
anonymous, other-account and insufficient-scope requests get 404, including
conditional requests. Deleted Publications return 404. Every response is
`private, no-store`; successful responses vary on Accept, Authorization and
Cookie. ETags identify serialized signed bytes, and HEAD/304 carry no body.
Anonymous public reads allow CORS; credentialed and private reads do not. Do not
treat HTTP cache directives as cryptographic revocation.

Verify the name/public-key binding, V2 signature, sequence and EOL using an IPNS
client, then fetch `/ipfs/{cid}?format=raw`, verify each block's CID and
traverse locally. Neither this service nor a signature guarantees global
latestness.

## Lifecycle and failure behavior

Each enabled Publication owns one stable name and one encrypted private key.
Records contain only `/ipfs/{cid}`, sequence, EOL, TTL and signature; no title,
account identity or history. New names start at sequence 0. Changing the content
CID increments the IPNS sequence; rollback increments it too. Same-CID
description/title edits and no-op publication do not replace the record.
Publication business sequence and IPNS sequence are independent.

Records have a 24-hour EOL and 300-second advisory TTL. Renewal keeps the same
sequence and value and extends EOL; IPNS ordering prefers later EOL for equal
sequences. The existing hourly cron renews up to 32 live bindings whose EOL is
within 12 hours, oldest first; failures defer retry for one hour and emit
`{"event":"ipns_renewal_failed","reason":"sign_or_persist"}` without identifiers
or exception text. Expired authorized reads also attempt renewal; signing,
validation or persistence failure fails closed (503), never serves an expired
record. A still-valid stored record can be read without the master key.

Operations must monitor cron execution, that failure event, eligible backlog and
minimum live EOL headroom. The fixed batch is bounded work, not an unlimited
availability promise: sustained demand above 32 renewals/hour needs a separately
validated capacity adjustment before enabling more bindings. Alert if a cron run
fails or any live record has less than two hours' headroom; deployment must wire
and test those external alerts. No external alert was configured by this change.

Business updates fence both Publication sequence and binding generation (or
absence). Signed bytes and the committed business pointer are written in one D1
batch transaction. A failed batch rolls both back; a racing
enable/renewal/update loser must retry after 409. Renewal checks generation,
live status and current CID. It does not create revisions or operations.

Deletion stops serving and renewing immediately at subsequent authorized
reads/updates. Restore within the existing recovery window retains the name and
sequence; expired records renew on read or cron. Final Publication removal
cascades to its binding. Downloaded signatures can remain valid until EOL, and
old CIDs/copies cannot be erased remotely. Clients that have seen a newer
sequence must not roll back to an older one.

Without a binding, normal Publication behavior does not need the master secret.
With a binding, content changes fail closed if signing is unavailable; metadata
edits remain usable. Re-enabling an existing binding does not rotate or replace
its identity.

## Custody and recovery

Apply the additive
[`0010_publication_ipns.sql`](../apps/worker/migrations/0010_publication_ipns.sql)
before deploying this code, **only with separate target-database
authorization**. It creates an empty binding table and renewal index, with no
backfill or keys. The deployment workflow never performs this migration. Even
unbound publication writes now query that table; do not deploy against an
unmigrated database.

`IPNS_MASTER_KEY` is a separate 32-byte AES-256-GCM secret, encoded as exactly
64 hex characters; never reuse `AUTH_SECRET`. It is optional until opt-in.
Provision target secrets only with explicit authorization; do not put them in
Wrangler configuration, logs, responses, Git or SQL. `.dev.vars.example`
contains only an empty placeholder. Tests generate ephemeral keys in memory.

D1 holds AES-GCM ciphertext, a fresh 96-bit nonce, public key and key format
version 1. Authenticated additional data binds the ciphertext to Publication ID,
name and version. Decryption verifies that the key matches both stored public
key and name before signing. Serialized and library-owned raw private buffers
are cleared after use; JavaScript/crypto internals cannot promise complete
memory erasure. Only encrypted blobs are persistent. The service can sign on the
owner's behalf: this is hosted custody, not user-exclusive control.

Back up the master secret in an access-controlled secret manager **separately**
from a consistent D1 backup (including bindings, Publications and revisions). R2
backup remains necessary for content. Restore those databases and the same
master secret into an isolated, access-restricted environment before resuming
traffic or cron. Verify original names, current CID/sequence, an independently
verified fresh signature and private-access rejection. Do not copy production
keys into tests. The automated test reconstructs the signer from persisted
encrypted material and the same ephemeral master; a real target backup/restore
drill is a deployment prerequisite, not a claimed completed operation.

Loss of the master secret or ciphertext loses update ability; replacing a key
changes the name. There is no automatic master-key rotation or private-key
export endpoint. Do not overwrite the master secret as a rotation procedure.
After suspected compromise, disable signing and serving at the affected target,
investigate, notify clients through trusted Publication channels, and plan a
separately authorized migration/re-encryption or new identity. Existing valid
signatures cannot be recalled, and a stolen publication private key can forge
updates. Old database backups can also contain stale sequences: never resume
signing from a backup without reconciling newer committed/externally observed
sequences. This implementation does not solve disaster rollback by silently
resetting sequence numbers.

## Local verification

`apps/worker/test/publications.test.ts` exercises ephemeral key allocation, HTTP
negotiation/HEAD/ETag, independent WebCrypto Ed25519 verification of
`"ipns-signature:" || Data`, the IPNS routing-key validator, CID changes,
rollback, renewal ordering, encrypted-key reconstruction, tamper/wrong-name/EOL
rejection, private authorization, deletion/restore, transaction rollback,
generation races, signer failure and unbound behavior. No production migration,
master-key provisioning, release tag or deployment is part of these tests.

`apps/worker/test/image-runtime.test.ts` additionally allocates, decrypts and
signs through the Wrangler-bundled Worker in workerd, then independently
verifies the returned bytes in the Node client. On 2026-11-13, `pnpm check`
passed, including worker lint/typecheck/build and 321 passing worker tests (one
existing skip); the 13 IPNS lifecycle cases and the bundled-runtime signing case
passed.
