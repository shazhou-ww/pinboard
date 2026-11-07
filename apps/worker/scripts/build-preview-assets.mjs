import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import wabtFactory from "wabt";

const require = createRequire(import.meta.url);
const output = new URL("../.preview-assets/", import.meta.url);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const wabt = await wabtFactory();
await mkdir(output, { recursive: true });
const records = {};
async function writeAsset(name, bytes) {
  const destination = new URL(name, output);
  const existing = await readFile(destination).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (existing?.equals(Buffer.from(bytes))) return;
  const staging = new URL(`${name}.${process.pid}.building`, output);
  try {
    await writeFile(staging, bytes);
    await rename(staging, destination);
  } finally {
    await rm(staging, { force: true });
  }
}
for (const [name, path, pages, shared] of [
  ["pdfium", "@hyzyla/pdfium/pdfium.wasm", 512, true],
  ["jpeg", "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm", 512, true],
  ["png", "@jsquash/png/codec/pkg/squoosh_png_bg.wasm", 512, true],
  ["webp", "@jsquash/webp/codec/dec/webp_dec.wasm", 512, true],
  ["encoder", "@jsquash/webp/codec/enc/webp_enc.wasm", 256, true],
]) {
  const source = await readFile(require.resolve(path));
  const module = wabt.readWasm(source, { readDebugNames: false });
  try {
    let text = module.toText({ foldExprs: false, inlineExport: false });
    const matches = [
      ...text.matchAll(/^\s*\(memory \(;0;\) (\d+)(?: (\d+))?\)$/gm),
    ];
    assert.equal(matches.length, 1, `${name}: exactly one memory required`);
    const [declaration, initial] = matches[0];
    assert.ok(Number(initial) <= pages);
    text = shared
      ? text
          .replace(declaration, "")
          .replace(
            "(module",
            `(module\n  (import "pinboard" "memory" (memory ${initial} ${pages}))`,
          )
      : text.replace(declaration, `  (memory (;0;) ${initial} ${pages})`);
    if (name === "png") {
      // Rust's allocator grows memory to obtain its first arena. Model its
      // original page count inside our already committed, reusable arena.
      assert.ok(text.includes("memory.grow"));
      text = text
        .replace(/^(\s*)memory\.size$/gm, "$1call $pinboard_size")
        .replace(/^(\s*)memory\.grow$/gm, "$1call $pinboard_grow");
      const end = text.lastIndexOf(")");
      text = `${text.slice(0, end)}
        (global $pinboard_pages (mut i32) (i32.const ${initial}))
        (func $pinboard_size (result i32) global.get $pinboard_pages)
        (func $pinboard_grow (param $delta i32) (result i32)
          local.get $delta i32.const ${pages} global.get $pinboard_pages i32.sub i32.gt_u
          if (result i32) i32.const -1
          else
            global.get $pinboard_pages
            global.get $pinboard_pages local.get $delta i32.add global.set $pinboard_pages
          end)
        ${text.slice(end)}`;
    }
    const rebuilt = wabt.parseWat(`${name}.wat`, text);
    try {
      rebuilt.validate();
      const { buffer } = rebuilt.toBinary({ write_debug_names: false });
      assert.ok(WebAssembly.validate(buffer));
      records[name] = {
        source: path,
        originalSha256: hash(source),
        sha256: hash(buffer),
        maximumBytes: pages * 65536,
        shared,
      };
      await writeAsset(`${name}.wasm`, buffer);
    } finally {
      rebuilt.destroy();
    }
  } finally {
    module.destroy();
  }
}
const bridgeSource = await readFile(
  new URL("preview-callbacks.wat", import.meta.url),
  "utf8",
);
const bridge = wabt.parseWat("preview-callbacks.wat", bridgeSource);
try {
  bridge.validate();
  const { buffer } = bridge.toBinary({ write_debug_names: false });
  await writeAsset("callbacks.wasm", buffer);
  records.callbacks = { sha256: hash(buffer) };
} finally {
  bridge.destroy();
}
// wasm-bindgen does not expose an instantiate hook. Keep its glue unchanged
// except for explicitly supplying our memory import to each initialization.
const png = await readFile(
  require.resolve("@jsquash/png/codec/pkg/squoosh_png.js"),
  "utf8",
);
assert.equal(png.split("async function __wbg_init(input) {").length, 2);
assert.equal(png.split("const imports = __wbg_get_imports();").length, 3);
const glue = png
  .replace(
    "async function __wbg_init(input) {",
    "async function __wbg_init(input, memory) {",
  )
  .replaceAll("if (wasm !== undefined) return wasm;", "")
  .replace(
    "const { instance, module } = await __wbg_load(await input, imports);",
    "imports.pinboard = { memory };\n    const { instance, module } = await __wbg_load(await input, imports);",
  );
assert.notEqual(glue, png);
await writeAsset("preview-png.js", glue);
records.pngGlue = { originalSha256: hash(png), sha256: hash(glue) };
const font = await readFile(
  new URL("../assets/DroidSansFallbackFull.ttf", import.meta.url),
);
records.font = { sha256: hash(font), bytes: font.length };
const manifest = { tool: "wabt@1.0.39", records };
const manifestUrl = new URL("../assets/preview-assets.json", import.meta.url);
if (process.argv.includes("--record")) {
  await writeFile(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`);
} else {
  assert.deepEqual(
    manifest,
    JSON.parse(await readFile(manifestUrl, "utf8")),
    "Preview input/output hashes changed; review dependencies and rebuild evidence before --record",
  );
}
