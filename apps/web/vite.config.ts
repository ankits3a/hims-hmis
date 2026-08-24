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
      // PLAN 11e CLOSE — THREE PREFIXES THE SPA CALLED AND NOTHING PROXIED.
      //
      // `/admin` is 11e's own (the user-administration surface). `/ops` and `/tariff` are OLDER
      // and were live defects: `/ops` is Plan 11c's operating-mode and downtime-kit surface — one
      // letter away from `/opd`, which is why it survived review — and `/tariff` feeds the billing
      // counter's service picker. In production all three fell through to the SPA handler and came
      // back as index.html with HTTP 200, exactly as this file's parity pin warned.
      //
      // The parity test now reads a THIRD source — the prefixes `src/lib/*.ts` actually calls —
      // because two lists compared only to each other agree forever about a prefix in neither.
      "/admin": "http://localhost:3000",
      "/ops": "http://localhost:3000",
      "/tariff": "http://localhost:3000",
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
