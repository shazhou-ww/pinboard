# Preview asset provenance and redistribution notices

- `DroidSansFallbackFull.ttf`: Android `android-4.4_r1`,
  [`frameworks/base/data/fonts`](https://android.googlesource.com/platform/frameworks/base/+/android-4.4_r1/data/fonts/DroidSansFallbackFull.ttf).
  Full unmodified font, 4,529,044 bytes, SHA-256
  `97320619b0f1ce4a7cda74cf064a0ce44ef3091287bc42755597e177cccf94c2`. The
  adjacent upstream `NOTICE` is retained as `FONT-LICENSE.txt` (Apache-2.0). No
  operating-system font is used.
- `@hyzyla/pdfium@3.0.0`: npm integrity is pinned in the lockfile; wrapper MIT
  notice retained in `PDFIUM-WRAPPER-LICENSE.md`. Its upstream
  [`LAST_RELEASE.txt`](https://github.com/hyzyla/pdfium/blob/v3.0.0/src/vendor/LAST_RELEASE.txt)
  identifies `paulocoutinhox/pdfium-lib` release `8046d`. That release's build
  configuration identifies PDFium `chromium/8046` and Emscripten 6.0.0. The
  distributed binary input hash, rather than a claim of reproducing the upstream
  C++ compilation, is our build authority.
- `PDFIUM-LICENSE.txt` and `PDFIUM-THIRD-PARTY.txt` preserve the PDFium and
  native-dependency notices. The optional `scripts/update-preview-notices.py`
  pins the branch's license-source snapshot to
  `f91ca5a72358bb0b00b4da9481b21fe668157614`, resolves its pinned DEPS and
  records each source URL. The bundle conservatively includes optional native
  component notices too. It is not executed during builds or tests.
- Existing `@jsquash/jpeg`, `@jsquash/png` and `@jsquash/webp` codec inputs are
  locked in pnpm and hashed in `preview-assets.json`; their wrapper Apache-2.0
  notice is retained in `JSQUASH-LICENSE.txt`. PNG glue preserves its inline
  copyright notice. PDFium's native codec notices are included separately.

Generated WASM is not vendored here. `scripts/build-preview-assets.mjs` uses
WABT 1.0.39 to import bounded host-owned memories, model PNG allocator growth,
compile `preview-callbacks.wat`, and validate input/output hashes. The `shared`
manifest field means _imported host memory_: PDFium and image decoders share a
32-MiB arena; the WebP encoder uses a separate 16-MiB arena. PNG glue changes
only initialization/cache reset and memory-import injection. These modifications
do not change native PDF drawing or image decoding algorithms.
