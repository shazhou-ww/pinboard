import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8787",
      },
      "/mcp": { target: "http://localhost:8787" },
      "/ipfs": { target: "http://localhost:8787" },
      "/routing": { target: "http://localhost:8787" },
    },
  },
});
