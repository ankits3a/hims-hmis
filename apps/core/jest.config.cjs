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
  setupFiles: ["<rootDir>/test/helpers/env.ts"],
  moduleNameMapper: { "^@hmis/contracts$": "<rootDir>/../../packages/contracts/src/index.ts" },
};
