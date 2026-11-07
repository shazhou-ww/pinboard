import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";

export default defineConfig({
  plugins: [
    {
      name: "test-precompiled-wasm",
      enforce: "pre",
      load(id) {
        if (id.endsWith(".ttf"))
          return `export default Uint8Array.from(Buffer.from(${JSON.stringify(readFileSync(id).toString("base64"))}, "base64")).buffer;`;
        if (id.endsWith(".wasm"))
          return `export default new WebAssembly.Module(Uint8Array.from(Buffer.from(${JSON.stringify(readFileSync(id).toString("base64"))}, "base64")));`;
        return undefined;
      },
    },
  ],
  test: {
    maxWorkers: 2,
    testTimeout: 30000,
    server: { deps: { inline: [/@jsquash\//u] } },
    coverage: {
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "json", "html"],
      thresholds: {
        branches: 90,
        functions: 90,
        lines: 90,
        statements: 90,
      },
    },
    include: ["test/**/*.test.ts"],
  },
});
