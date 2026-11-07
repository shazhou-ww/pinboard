# PDF first-page previews

PDF thumbnails use the existing preview descriptor, raw WebP CID, publication
transaction and retained-root/DAG-member garbage collection. They do not create
account pins or expose PDF byte ranges. Existing cards still center-crop images.

## Supported content and failure policy

- Only page zero, white background, preserved aspect ratio, at most 480 pixels
  on the longest edge and 65,536 encoded bytes.
- Ordinary pages, embedded images, rotation and intersecting MediaBox/CropBox
  bounds; empty pages are allowed. Non-finite, zero or disjoint bounds fail.
- Bundled Droid Sans Fallback supports the tested simplified/traditional Chinese
  glyphs. Embedded and fallback output is checked against independent FreeType
  glyph masks. This is not a guarantee of every script or missing-glyph
  detection. Known unembedded Hangul is explicitly unsupported.
- All AcroForms, XFA and first-page annotations are unsupported, including forms
  with appearances. Flatten them externally first. No form environment, document
  action, JavaScript execution or external-resource loader is invoked.
- Password protection, malformed PDFs and deterministic resource limits produce
  explicit unsupported descriptions. Missing/corrupt source blocks and transient
  execution errors follow the existing bounded failure/backoff mechanism.

## Resource boundaries

`preview-source.ts` owns verified block promises and UnixFS ranges; PDFium sees
only `size/readAt`, not R2, D1, CIDs, accounts or publication state.

| Resource            | Bound                                                                |
| ------------------- | -------------------------------------------------------------------- |
| PDF logical file    | 32 MiB, checked as `bigint` before wasm32 conversion                 |
| Physical reads      | 64 distinct block fetches, 12 MiB aggregate, 2 MiB per block         |
| Logical windows     | 64 KiB each, 8 MiB total, at most 64 availability rounds             |
| Small files         | At most 256 KiB: fully cache, then load with synchronous callbacks   |
| PDF text inspection | 20,000 first-page characters                                         |
| Native decode arena | One host-owned 32 MiB memory shared by PDFium/JPEG/PNG/WebP decoders |
| WebP encoder        | Separate host-owned 16 MiB memory                                    |
| Asynchronous job    | 20-second deadline checked between phases and during stream reads    |

Budgets are reserved before consuming block streams or allocating logical
windows. Rejected/aborted streams are cancelled; concurrent reads of a CID share
one Promise. Download hints are filled asynchronously; an uncached synchronous
read is an error, never zero-filled image data.

Only one generation is admitted per isolate. Busy tasks release their fenced D1
lease, undo the attempt increment and defer for two seconds. There is no
cross-request wait queue. This is not a global cross-isolate rate limiter.
Synchronous WASM cannot be interrupted by a JavaScript timer; production CPU and
background-work limits still apply.

### Why image initialization also changed

Keeping all original decoder heaps plus a new 64 MiB PDF heap is not a safe
combined budget. The immutable WASM modules now import one reusable decode
memory. Switching codecs or recovering from a trap zeros that backing memory
before instantiating fresh native state. Reinitialization never allocates a
second 32 MiB heap and does not assume immediate garbage collection. PDFium
allocates exactly three callback slots per instance and clears its session
reference and logical windows in `finally`. Poisoned instances are never cleaned
up by calling more native functions. The encoder has the same reset-on-error
policy on its separate 16 MiB backing memory.

PNG's Rust allocator expects to grow from its original 17-page heap. The build
therefore replaces only its `memory.size/grow` instructions with per-instance
virtual-page accounting (maximum 512 pages) inside the already committed arena.
JPEG/WebP decode behavior, orientation, transparency, resize and encoding
parameters remain covered by the original image tests; a 1,999,396-pixel,
near-8-MiB RGBA PNG is additionally exercised between PDF jobs.

This is deliberately broader than extracting the pixel encoder: leaving the
existing decoder heaps resident would defeat the combined-memory bound, and
allocating replacement heaps after failures would depend on immediate GC. The
pinned transformations and cross-codec tests are therefore part of the
shared-arena change, not evidence that an unmodified decoder initializer is
safe.

The two admission lifetimes are distinct. `nativeSession` holds the decode arena
until its entire operation settles, including awaited initialization/source
reads and native cleanup. PDF cleanup clears the callback session before this
lock is released; the returned RGBA is an independent copy. **PDF WebP encoding
happens afterward**, on the separate encoder memory. The outer `admitPreview`
still spans source loading, rendering and encoding/CID-result creation. Image
thumbnails currently retain their native session through encoding as well.
Changing codec or recovering from failure resets the arena only after the
previous native session has settled and increments its generation.

Real-workerd race tests suspend a PDF's R2 read through an owner-request service
binding. Image and PDF contenders must return busy before the held read is
released, without changing arena generation or owner state. Resuming the owner
produces exact independent red/blue pixels; subsequent image/PDF switches remain
correct. Separate cases fail or cancel the suspended owner. In the cancellation
case, test-only `waitUntil` keeps the old transport alive after the owner
response, an image switches the arena, and then the original read completes: the
production source adapter cancels the unread late body, and a checksum of the
entire 32-MiB arena remains unchanged. The control gates and checksum routes
exist only in the test entry point, not the production Worker.

The conservative live-buffer ledger is roughly **84 MiB for PDF**: 48 MiB native
heaps, 12 MiB verified blocks, 8 MiB windows, 9 MiB font allowance, 4 MiB
read/hash transients and 3 MiB raster/output allowance. The image path reserves
roughly **104 MiB**, including 16 MiB input copies and 16 MiB decoded/transient
pixels. These are component bounds/reserves, **not measured isolate peaks**.
Local workerd stress, codec switching and repeated native abort/recovery pass,
but compiled code, JavaScript/application allocations and unrelated concurrent
requests must still fit the platform's 128-MB isolate budget. Production
memory/CPU/startup acceptance remains a deployment gate, not a local-test claim.

## Reproducible assets and tests

Versions live in the root pnpm catalog; `@hyzyla/pdfium` is pinned to 3.0.0 and
WABT to 1.0.39. `pnpm --filter @shazhou/pinboard-worker preview:assets` rebuilds
WASM and the static callback bridge into ignored `.preview-assets`. The same
command runs before tests and every Wrangler build. It checks every input and
output SHA-256 against
[`preview-assets.json`](../apps/worker/assets/preview-assets.json), including
the font and PNG glue. It neither downloads fonts nor compiles WASM at request
time.

Dependency upgrades require review of the ABI/memory transformations, then
`node apps/worker/scripts/build-preview-assets.mjs --record` and the complete
regression suite. Do not refresh hashes merely to bypass a mismatch. Licenses,
font origin and native build provenance are in
[`apps/worker/assets/README.md`](../apps/worker/assets/README.md).

Fixtures are original deterministic PDF/PNG generators in
`test/pdf-fixtures.ts`; embedded fonts use only the bundled licensed TTF.
Independent Chinese reference masks are checked in. Their optional generator
uses Python and Pillow 11.1.0, not system fonts. Normal tests require neither.

```sh
pnpm --filter @shazhou/pinboard-worker exec vitest run test/pdf-runtime.test.ts test/pdf.test.ts test/pdf-data.test.ts test/preview-source.test.ts test/previews.test.ts test/image-runtime.test.ts
pnpm check
```

Runtime tests use actual workerd, D1 migrations in isolated test databases and
R2 CAR storage, then dispose their runtimes. They do not deploy or migrate
production. The representative 5,760,921-byte non-linearized two-page fixture
reads **519,150 bytes / 3 R2 GETs**, versus **5,762,030 bytes / 23 GETs** for
full loading (90.99% fewer physical bytes), with identical first-page pixels.
Files whose first page needs most resources need not save reads.

The production dry-run bundle is **13,304.84 KiB uncompressed**; the reported
**5,553.39 KiB gzip** is informational. The current
[official Worker-size limit](https://developers.cloudflare.com/workers/platform/limits/#worker-size),
verified on 2026-11-07, is **64 MiB uncompressed for both Free and Paid**; there
is no compressed-size limit. This bundle is below the limit on both plans. This
size check does not establish CPU, actual account configuration, peak isolate
memory or startup acceptance; those and release authorization remain separate
production prerequisites.
