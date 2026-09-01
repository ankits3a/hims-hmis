// Plan 11a T1 / D2: `@hmis/contracts`'s package `main` now points at `./dist/index.js`, because
// production runs COMPILED output and plain `node` cannot load the `./src/index.ts` it used to
// name (FORK-A's real blocker, measured by the spike). Jest resolves packages through `main`
// too, so without the pin below the suite would silently start consuming whatever compiled
// output happens to be sitting in `packages/contracts/dist` — AGENT-RULES rule 5's stale-emit
// hazard one level up, and silently GREEN until contracts change. `types` deliberately stays on
// `./src/index.ts` so typecheck keeps reading source; this makes jest agree with typecheck.
// The only workspace that depends on @hmis/contracts is apps/core, so this is the only mapper
// the repo needs.
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/test/**/*.test.ts", "**/src/**/*.test.ts"],
  testTimeout: 15000,
  // Ledger §2.151 (owner ruling 2026-09-01): jest defaults maxWorkers to CPU count (8 here, so 7
  // workers). Measured ~1.2 GB per worker => ~8.4 GB, which OOM-kills this 15 GB box even with a
  // SINGLE lane running, and produced CI run 33436302396's false red (846 setupTestDb HOOK
  // timeouts, ZERO assertion diffs, 117 min vs 57). The cap is the durable fix for both; three
  // lanes independently recommended it. Raising it re-opens that class of failure.
  maxWorkers: 2,
  setupFiles: ["<rootDir>/test/helpers/env.ts"],
  moduleNameMapper: { "^@hmis/contracts$": "<rootDir>/../../packages/contracts/src/index.ts" },
};
