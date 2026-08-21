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
      "/opd": "http://localhost:3000",
      "/billing": "http://localhost:3000",
      "/alerts": "http://localhost:3000",
      "/ws": { target: "ws://localhost:3000", ws: true },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    // Belt, not a replacement for AGENT-RULES §5 step 0 (Plan 08.5 T5 / carried item 6): makes
    // leftover mutant/control scratch structurally invisible to the suite even if a future task
    // forgets to delete it before committing. Vitest's `exclude` REPLACES its own default array
    // rather than extending it, so the defaults are carried here verbatim (vitest 3's
    // `defaultExclude`) plus the two new patterns.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
      "**/*.mutant.*",
      "**/*.control.*",
    ],
  },
});
