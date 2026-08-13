/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    // Dev-only convenience; production serving is Caddy (Plan 11). Same-origin '/…' paths in code.
    proxy: {
      "/auth": "http://localhost:3000",
      "/patients": "http://localhost:3000",
      "/approvals": "http://localhost:3000",
      "/workflow": "http://localhost:3000",
      "/health": "http://localhost:3000",
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
  },
});
