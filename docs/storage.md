# CAR-indexed storage

New file, raw-block and CAR uploads share one validated storage path. The Worker
checks hashes, supported codecs and complete DAG closure first, then normalizes
the reachable blocks into a single-root CARv1. CARv2 imports and CIDv0 links are
accepted as before; stored block identifiers and export roots use CIDv1.

## Layout and reads

- R2 `cars/<sha2-256-raw-CID-of-CAR-bytes>.car` holds the complete archive.
- D1 `car_dags` maps an uploaded or explicitly pinned root to its CAR object and
  archive length. `car_blocks` maps each normalized block CID to the object,
  **payload** offset and payload length (excluding section framing and CID).
- New writes do not create independent full block objects. Within a CAR each
  reachable CID occurs once. Exact retries reuse the same content-addressed
  object. Overlapping but different DAGs each retain their complete CAR:
  cross-CAR payload duplication is intentional, not global deduplication. The
  global block index retains the first published location for each CID.
- Export of an indexed root performs one D1 lookup and one streamed R2 GET. It
  does not walk block indexes, fetch individual blocks or re-encode a CAR.
- Raw GET performs one D1 lookup and an R2 range GET for the exact block
  payload. HEAD, conditional hits and provider discovery check R2 metadata
  without reading payload bytes. Empty blocks use metadata and an empty stream,
  avoiding an invalid zero-length R2 range.
- An unindexed CID falls back to the existing independent R2 block key. Legacy
  and mixed DAG exports still traverse and encode; an arbitrary sub-DAG root not
  previously uploaded/pinned also uses this compatibility path. Explicitly
  pinning an available DAG packs it for subsequent direct exports, without
  deleting existing legacy data.

HTTP routes, account authorization, explicit public-upload consent, raw ETags,
negotiation and security headers are unchanged. R2 range reads are internal; the
raw gateway still does not offer HTTP byte-range responses.

## Publication, failures and recovery

The complete immutable CAR PUT finishes **before** one D1 batch transaction
publishes its manifest and all missing block locations. Index rows are expanded
with SQLite `json_each` from one bound JSON value, not one network request or
SQL statement per block. The batch rolls back completely on a statement error.
Only after publication does the service save the caller's account pin.

R2 and D1 are not a distributed transaction. A failed PUT publishes no index; a
failed SQL transaction can leave an unindexed CAR. A failed pin save or a lost
response after commit can leave complete public content without a successful
account-pin response. No operation reports success before all required writes
finish. Retrying the identical upload deterministically restores the object,
reuses the index and upserts the caller's pin; concurrent retries are safe. Do
not delete an object as error compensation: a concurrent writer or a commit
whose response was lost may already reference it.

An indexed object that is missing, truncated, or does not yield the requested
range fails closed with 503. It is not reported as an ordinary missing CID or a
positive cache hit. Restore it by re-uploading the verified original DAG. R2/D1
service failures continue to surface as errors. Downloads remain trustless:
clients must verify block CIDs; same-length out-of-band object corruption is not
detected by metadata alone.

Physical garbage collection is deliberately not implemented. Unpin removes only
the account reference; CARs, block indexes and legacy objects remain. For
reconciliation, compare a paginated R2 listing under `cars/` with **all**
`car_dags.object_key` values, not just live pins. Unreferenced objects are
orphan candidates, not immediately safe deletions: pause writers, settle
in-flight/ambiguous commits and take a fresh consistent inventory before any
separately approved cleanup. Never delete a referenced CAR simply because its
root has no pins: another DAG's block locations may point into it. There is no
automatic backfill, destructive migration or global deduplication.

## Schema and operational compatibility

Apply [`0002_car_storage.sql`](../apps/worker/migrations/0002_car_storage.sql)
through a separately authorized schema operation **before** deploying the new
Worker. The normal tag deployment workflow does not migrate D1. For a database
with manually initialized `0001` and no migration history, inspect existing
tables first and execute only `0002`; do not blindly replay `0001`. See
[deployment prerequisites](deployment.md#car-storage-rollout-prerequisite).

The old Worker can continue using the additive schema before cutover, but cannot
read CAR-only content created by the new Worker. After new writes begin, rolling
back to a pre-CAR Worker is **not** a data-compatible rollback. Keep the new
reader available and forward-fix, or stop new uploads and use a separately
verified compatibility release. Do not copy all new blocks to independent
objects merely to make rollback possible.

## Reproducible checks

`pnpm check` includes Miniflare-backed storage tests with counted R2 operations,
real D1 batch rollback injection, range checks, overlapping/concurrent uploads,
legacy/mixed content and independent CAR parsing. Its `CAR_STORAGE_MEASUREMENT`
lines describe fixture size, request counts and storage overhead; local timings
are not production latency evidence.

With Kubo installed, independently import and reconstruct the stored directory
CAR in an empty offline repository:

```powershell
pnpm exec turbo run build --filter=@workspace/encoding --filter=@workspace/cli
$env:PINBOARD_TEST_KUBO = "1"
pnpm --filter @workspace/worker exec vitest run test\storage.test.ts
Remove-Item Env:\PINBOARD_TEST_KUBO
```

The test creates and removes only its project-local `.car-storage-kubo` fixture.
It needs no production credentials or network fetches.
