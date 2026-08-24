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
    // PLAN 11g / DD1 — ONE KEY, BECAUSE THE ORIGIN NOW HAS ONE RULE.
    //
    // This block held twelve prefixes mirrored from the production Caddyfile — `/auth`,
    // `/patients`, `/billing`, `/admin`, `/ops` … — the same paths `src/router.tsx` declares
    // SCREENS on. In dev the vite server resolved that collision in the SPA's favour and
    // everything worked; in production Caddy resolved it in the API's favour and 15 of 20 screens
    // were dark (the smoke test's D1). The fix is path-space separation, so there is exactly one
    // prefix here for ever and adding an API module no longer edits this file at all.
    //
    // `rewrite` strips `/api` so the dev server hands the API its own unprefixed path, which is
    // precisely what `uri strip_prefix /api` does at the production edge. `ws: true` carries the
    // realtime gateway on the same key — vite applies `rewrite` to the upgrade URL too.
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        ws: true,
        rewrite: (path: string) => path.replace(/^\/api/, ""),
      },
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
