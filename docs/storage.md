# CAR-indexed storage

See [item access](access-control.md): new items are private; migration
`0009_item_visibility.sql` preserves existing public references. Storage and
retention tables do not themselves authorize reads.

## Scoped user metadata

Migration `0007_descriptions.sql` adds owner/root/node-keyed `node_descriptions`
and an additive default-empty JSON `publication_revisions.descriptions` column.
Pin metadata has an `(account_id, root_cid)` foreign key to `pins` with
cascading expiry cleanup; clearing keeps a versioned tombstone for CAS.
Publication revisions snapshot metadata in their guarded D1 commit and never
reference mutable Pin annotations. Preview tables, generation and GC remain
separate. On-demand previews also support reachable DAG members: generation and
thumbnail cleanup recheck retention through their root without adding standalone
Pins or coupling user metadata to cache rows. Conversion retains v1 and its
snapshot before atomically deleting the fixed Pin row; it creates no recoverable
duplicate. Publication deletion/restore and expiry continue to control its own
retained roots. No schema migration runs automatically in production.

Descriptions do not change original DAG blocks, CIDs, CARs or ordinary content
exports. Metadata requires explicit API/CLI sidecar export; see
[publications](publications.md#user-descriptions-and-system-previews).

New file, raw-block and CAR uploads share one validated storage path. The Worker
checks hashes, supported codecs and complete DAG closure first, then normalizes
the reachable blocks into a single-root CARv1. CARv2 imports and CIDv0 links are
accepted as before; stored block identifiers and export roots use CIDv1.

## Layout and reads

- R2 `cars/<random-UUID>.car` holds the complete immutable archive. Previously
  published content-addressed CAR keys remain readable.
- D1 `car_dags` maps an uploaded or explicitly pinned root to its CAR object and
  archive length. `car_blocks` maps each normalized block CID to the object,
  **payload** offset and payload length (excluding section framing and CID).
- New writes do not create independent full block objects. Within a CAR each
  reachable CID occurs once. Each retry uses a fresh key so an old or delayed
  garbage-collection delete cannot erase a new publication. Overlapping DAGs and
  retries each retain their complete CAR: cross-CAR payload duplication is
  intentional, not global deduplication. The global block index points to the
  latest successfully published location.
- Export of an indexed root performs one D1 lookup and one streamed R2 GET. It
  does not walk block indexes, fetch individual blocks or re-encode a CAR.
- Raw GET performs one D1 lookup and an R2 range GET for the exact block
  payload. HEAD, conditional hits and provider discovery check R2 metadata
  without reading payload bytes. Empty blocks use metadata and an empty stream,
  avoiding an invalid zero-length R2 range.
- An unindexed raw CID falls back to the existing independent R2 block key.
  Archive reads never traverse or encode: legacy/mixed and unprepared sub-DAG
  exports return 503 with re-upload/explicit-pin recovery instructions if the
  root block exists, or 404 if absent. Explicitly pinning an available DAG or
  re-uploading a verified CAR prepares subsequent direct exports without
  deleting legacy data. Existing explicit Publication writes still prepare
  legacy targets before their atomic retention checks; Publication downloads
  never do. No schema change or automatic archive backfill is required.

HTTP reads now authorize eligible live DAG roots before any storage access or
conditional response. Gateway caches are private/no-store; raw ETags,
negotiation and security headers are retained. R2 range reads are internal; the
raw gateway still does not offer HTTP byte-range responses.

## Original content downloads

`GET /api/public/:cid/download` reconstructs raw and UnixFS files as original
bytes and UnixFS directories as ZIP attachments. The pin detail, CID share and
publication share pages offer this alongside unchanged CAR exports. Optional
`?name=...` supplies the filename (or folder name before `.zip`); the pin UI
supplies its current name. Without it, the filename is `<CID>.bin` or
`<CID>.zip`: UnixFS file roots do not retain the original upload filename, and
public retrieval never exposes account-scoped pin names.

Downloads verify the complete DAG against the existing block/count/32 MiB limits
before decoding. ZIP output preserves relative paths, Unicode names and empty
directories/files. Output is streamed with backpressure, without buffering an
additional complete file or ZIP; aggregate reconstructed file bytes are limited
to 32 MiB even when shared DAG links expand repeatedly. Trees exceeding 10,000
entries or 256 levels, unsafe/non-portable or conflicting paths, symlinks and
other IPLD content fail explicitly; use CAR export for those DAGs. Content is
always an attachment with sandbox and `nosniff` headers, never executed as a
website.

Publication downloads also accept
`/api/public/publications/:id/download/:revision?format=original` (omit
`:revision` to follow the current version). Publication resolution and deletion
checks still apply. The default and `?format=car` remain CAR downloads,
including their existing conditional request behavior.

## Publication, failures and recovery

The writer first reserves a `storage_objects` row in `writing` state. The
complete immutable CAR PUT finishes **before** one D1 batch transaction
publishes its manifest, block locations, physical membership and complete DAG
membership, and marks the object `ready`. Index rows are expanded with SQLite
`json_each` from one bound JSON value, not one network request or SQL statement
per block. The batch rolls back completely on a statement error. Only after
publication does a second transaction save the caller's account pin and clear
the DAG blocks' last-unreferenced timestamps. A CHECK-constrained write guard
rolls back either transaction if cleanup already claimed its object.

R2 and D1 are not a distributed transaction. A failed PUT publishes no index; a
failed SQL transaction can leave an unindexed CAR. A failed pin save or a lost
response after commit can leave stored content without a successful account-pin
response. Without an eligible live public reference it is not anonymously
readable. No operation reports success before all required writes finish.
Retrying the identical upload creates a fresh complete archive, updates the
index and upserts the caller's pin; concurrent retries are safe. Do not delete
an object as error compensation: a concurrent writer or a commit whose response
was lost may already reference it.

An indexed object that is missing, truncated, or does not yield the requested
range fails closed with 503. It is not reported as an ordinary missing CID or a
positive cache hit. Restore it by re-uploading the verified original DAG. R2/D1
service failures continue to surface as errors. Downloads remain trustless:
clients must verify block CIDs; same-length out-of-band object corruption is not
detected by metadata alone.

## Retention and automatic cleanup

Unpin moves an account pin to recently deleted for 30 days, without releasing
its content reference. Publication delete closes all its public resolution
routes and retains all revisions for the same recovery window. Expiry releases
only that object's references, atomically with last-unreferenced timestamps.
`retained_roots` unifies pins (including recoverable deleted pins) and
independent publication references; `dag_members` stores each verified root's
complete reachable closure. A timestamp starts only when the last pin, retained
DAG or publication stops referencing a block. A new reference clears it. Archive
creation time is never proof of the last reference loss. See
[publications and recovery](publications.md).

The hourly UTC cron (`17 * * * *`) performs bounded, retryable work:

- Release at most 50 expired pins and 50 expired publications' references.
  Restore and expiry serialize on the same D1 rows. Restore is denied at the
  deadline even if cron has not run. Repeated deletion never extends recovery.
- Delete at most 100 token records whose earlier revocation/expiry is at least
  30 days old. Repeated revocations never move the original revocation time.
  Authentication always checks revocation and expiry, regardless of cleanup.
- Verify at most one existing pinned DAG (at most the existing 256 blocks / 32
  MiB bounds) to backfill its closure. Failures rotate behind other roots; **any
  unverified live pin blocks new content deletion claims**. A legacy pin removed
  before backfill also imposes a global seven-day safety floor.
- Discover at most 50 R2 objects, checkpointing the opaque list cursor in D1.
  Canonical legacy CID keys and `cars/*.car` objects are registered; other keys
  are retained and counted for operator review. Undated legacy/orphan content
  receives a fresh seven-day grace period from observation, not upload time.
- Claim at most 20 old objects. Every physical member must be unreferenced for
  at least seven days, and no active manifest may depend on the object. A whole
  CAR containing any live/shared block remains intact, including duplicate
  payloads; there is no CAR compaction or global deduplication.
- Recheck liveness and mark `deleting` atomically with removing only that
  object's manifest/block locations. Delete R2 next, then remove its registry
  and physical membership. Finish bounded cleanup of unused closure/retention
  metadata (50 roots, 256 block records and 50 backfill records per pass).

Deletion claims do not expire and object keys are never reused. If cleanup fails
or its response is lost, the persistent claim can be retried idempotently. A
suspended writer cannot publish into a claimed/deleted object. A concurrent
repin writes its own complete fresh archive before committing a reference; an
in-flight read that loses a race on already-unreferenced content may fail and be
retried, but cannot create a successful broken pin. A late abandoned PUT is
rediscovered as an orphan, with a new conservative grace period.

Seven days and 30 days are eligibility boundaries, not exact deletion deadlines.
The hourly schedule, backlog, backfill, shared CARs and failures can extend
retention. Pins and publications can be restored only during their 30-day
recovery window; token history has no restore action. There is no permanent
delete. CDN caches, other IPFS nodes and downloaded copies are outside this
cleanup's scope.

### Observability and recovery

Structured `retention_completed` logs report token/object deletion counts,
discoveries, unknown keys, backfill progress, blocked pins and per-object
failures. `retention_backfill_failed` identifies an unverifiable root;
`retention_object_failed` identifies a failing key. `retention_failed` signals
an aborted invocation and is rethrown to the scheduled event. No token
plaintext, hash or account identity is logged.

Per-object failures use exponential retry delay (one minute initially, capped at
24 hours); failed entries do not starve other eligible work. Monitor repeated
failures, blocked roots, unknown keys and backlog, for example:

```sql
SELECT state, count(*) FROM storage_objects GROUP BY state;
SELECT object_key, attempts, retry_at FROM storage_objects WHERE attempts > 0;
SELECT DISTINCT p.cid FROM retained_roots p
WHERE NOT EXISTS (SELECT 1 FROM dag_roots d WHERE d.root = p.cid);
```

For unavailable legacy blocks, recover verified bytes from a trusted source and
upload/pin the complete DAG; do not mark a root verified by hand. For R2/D1
failures restore service and let the next cron retry. To pause cleanup, remove
the Worker's Cron Trigger through a separately authorized configuration change;
do not roll back to the old writer or clear deletion claims. Already-running
invocations may finish. Take verified D1/R2 backups before manual recovery;
never perform bucket lifecycle expiry or delete objects from root-pin counts.

## Schema and operational compatibility

Apply [`0002_car_storage.sql`](../apps/worker/migrations/0002_car_storage.sql)
and [`0003_retention.sql`](../apps/worker/migrations/0003_retention.sql) through
a separately authorized schema operation **before** deploying the new Worker.
The normal tag deployment workflow does not migrate D1. For a database with
manually initialized `0001` and no migration history, inspect existing tables
first and execute only missing migrations; do not blindly replay `0001`. See
[deployment prerequisites](deployment.md#car-storage-rollout-prerequisite).

Migration 0003 preserves existing manifests/indexes, registers their physical
providers and initializes a seven-day safety floor; old pins are deliberately
not declared verified. It changes the writer protocol: stop old writers before
migration/cutover and never let an old release mutate this schema after cleanup
activation. Forward-fix with the retention-aware reader/writer, or pause all
writes and cleanup for a separately verified recovery. A pre-CAR or
pre-retention Worker is **not** a data-compatible rollback. Cron activation,
schema operations and production deployment require their own release approval.

An explicitly authorized disposable-data reset can instead delete the old D1 and
create a fresh database UUID, then apply all three migrations before publishing
the retention-aware Worker. Keep the old deployed writer bound only to the
deleted UUID until cutover; never bind it to the new schema. This causes an
intentional database-backed API outage, invalidates old account pins and Agent
tokens, and does not erase R2 objects. Unindexed CARs receive the normal
first-observation seven-day grace period; unknown keys remain preserved. The
[2026-11-04 production reset](retention-production.md) used this separately
authorized path. It is not permission for future resets.

## Reproducible checks

`pnpm check` includes Miniflare-backed storage tests with counted R2 operations,
real D1 batch rollback injection, range checks, overlapping/concurrent uploads,
legacy/mixed content and independent CAR parsing. Retention tests also cover
exact boundaries, nested/shared references, repinning concurrent with deletion,
late PUTs, migration/backfill, discovery pagination, bounded work and failure
retries, plus authenticated active/history token views. Its
`CAR_STORAGE_MEASUREMENT` lines describe fixture size, request counts and
storage overhead; local timings are not production latency evidence.

With Kubo installed, independently import and reconstruct the stored directory
CAR in an empty offline repository:

```powershell
pnpm exec turbo run build --filter=@shazhou/pinboard-encoding --filter=@shazhou/pinboard
$env:PINBOARD_TEST_KUBO = "1"
pnpm --filter @shazhou/pinboard-worker exec vitest run test\storage.test.ts
Remove-Item Env:\PINBOARD_TEST_KUBO
```

The test creates and removes only its project-local `.car-storage-kubo` fixture.
It needs no production credentials or network fetches.
