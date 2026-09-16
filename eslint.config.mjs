import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  // `docs/**` is documentation and pipeline tooling, not application source. The pipeline
  // compilers/pre-flights under docs/superpowers/pipelines are plain CommonJS `.js` scripts run
  // by `node` directly (the repo root package.json declares no `"type": "module"`), so the
  // TypeScript-oriented recommended rules flag `require()` in files where `import` would not even
  // execute. Ignore the tree rather than rewrite the tooling into a module system it does not use.
  { ignores: ["**/dist/**", "**/drizzle/**", "**/node_modules/**", "docs/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["apps/core/src/modules/**/*.ts"],
    rules: {
      // NOTE: the plan's literal patterns (["../*/!(index)", ...]) use bash-style
      // extglob syntax. ESLint 9's no-restricted-imports "patterns.group" matches via
      // the `ignore` npm package (gitignore semantics), which does not support
      // extglob — verified empirically that none of the four extglob patterns ever
      // match any import specifier, so the rule as literally written never fires.
      // Rewritten below to the same intent using gitignore-compatible syntax: a
      // module-name segment restricted to identifier characters (so it can never
      // match the literal ".." of a deeper kernel import) instead of "!(index)",
      // plus a same-shape negation to exempt the module's own index. Verified against
      // sibling-module internals (blocked), sibling-module index (allowed), kernel
      // imports at any depth (allowed), and bare package specifiers (allowed).
      "no-restricted-imports": ["error", {
        patterns: [{
          group: [
            "../[a-zA-Z0-9_-]*/**",
            "!../[a-zA-Z0-9_-]*/index",
            "**/modules/[a-zA-Z0-9_-]*/**",
            "!**/modules/[a-zA-Z0-9_-]*/index",
          ],
          message: "Modules may only import another module's index.ts (its declared interface). Cross-module internals are forbidden (spec §4).",
        }],
      }],
      /*
       * ═══ AND A MODULE MAY NOT GO ROUND ANOTHER MODULE TO ITS TABLES ═══
       *
       * `no-restricted-imports` above stops `modules/x` importing `modules/y/internal`. It does not
       * stop `modules/x` importing `formularyMedicines` from `kernel/db/schema` and querying y's
       * tables itself, which arrives at the same place by a different road — and the formulary's
       * own `index.ts` states that boundary in prose that nothing enforced.
       *
       * A PATH-BASED FORM OF THIS RULE WOULD MATCH NOTHING, and that is measured rather than
       * guessed: `grep -rn 'kernel/db/schema/formulary' apps/core/src` returns ONE hit and it is a
       * sentence in a doc comment, because every module imports the barrel
       * (`from "../../kernel/db/schema"`, 339 of them). A `no-restricted-imports` group on a
       * `kernel/db/schema/formulary` path would therefore land green for ever while the thing it
       * forbids went on happening — the same failure the comment above records for the extglob
       * patterns, which is why it is worth saying twice. So this matches the imported SPECIFIER
       * NAME, which catches the barrel import that is the only form anybody actually writes.
       *
       * Scoped to the formulary because that is the boundary that was crossed and has just been
       * fixed: `materials/items.ts` selected from `formulary_medicines` to check an id exists and
       * now asks `medicineExists`. The argument for routing it through the module is in
       * `modules/formulary/reads.ts` — the unbounded read this repo spent two PRs deleting was
       * reachable precisely because asking the table was easier than asking the module.
       *
       * IT CANNOT SEE RAW SQL. `modules/cds/allergens.ts` reads `formulary_salts` in a raw
       * statement and is invisible to any import rule. Recorded so a green lint is not mistaken
       * for an enforced boundary.
       */
      "no-restricted-syntax": ["error", {
        selector: "ImportSpecifier[imported.name=/^formulary[A-Z]/]",
        message: "Do not query another module's tables. Ask modules/formulary through its index.ts (medicineExists, medicinesByIds, pageMedicines...) — it owns these tables and the bounds live with them.",
      }],
    },
  },
  {
    /* The formulary owns these tables, so it is the one module that may name them. */
    files: ["apps/core/src/modules/formulary/**/*.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
  {
    /**
     * PLAN 09 T1 — BARE `loadConfig()` IS BANNED IN TEST FILES, and this rule is here because F1
     * cost the last phase a red CI commit and about an hour.
     *
     * `apps/core/.env` EXISTS on the build host and can NEVER exist in CI. `loadConfig()` with no
     * argument reads `process.env` (loading that file first), so a test that calls it resolves
     * here and throws `SECRET_KEY must be 64 lowercase hex chars` — or `DATABASE_URL` missing —
     * in CI, for ever. It passes locally, on the machine the author is looking at, and fails on
     * the machine that decides.
     *
     * The shipped workaround is one line and every test in this repository already uses it:
     *
     *     loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! })
     *
     * v3 §4 is why this is a lint rule rather than another prose checklist line: a check that
     * cannot execute is not method. It is `no-restricted-syntax` with an argument-count selector
     * rather than a custom plugin — the repo has no plugin infrastructure and does not need one
     * for a single call shape — and it is scoped to test files alone because `main.ts`,
     * `app.module.ts` and `worker.module.ts` are exactly where a bare call is CORRECT.
     */
    files: ["**/*.test.ts"],
    rules: {
      "no-restricted-syntax": ["error", {
        selector: "CallExpression[callee.name='loadConfig'][arguments.length=0]",
        message:
          "loadConfig() with no argument reads process.env and apps/core/.env — which exists on the build host and NEVER in CI, so this test passes locally and fails in CI for ever (Plan 09 F1). Pass an explicit env: loadConfig({ DATABASE_URL: \"postgres://unused\", SECRET_KEY: process.env.SECRET_KEY! }).",
      }],
    },
  },
  {
    // Accommodation for pre-existing committed code (Task 4 test helper destructuring):
    // typescript-eslint's recommended no-unused-vars flags `pool` in
    // apps/core/src/kernel/db/schema/events.test.ts, captured from setupTestDb() per the
    // plan's exact Step 3 text but not read directly in the test body. Do not rewrite
    // committed test files to satisfy the linter; relax this one rule for test files
    // instead. Does not touch the module-isolation rule above.
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    // apps/web (Plan 05): the hooks rules catch the one class of silent UI bug lint can
    // catch. Plugin registered manually — no preset dependency on the plugin's config names.
    files: ["apps/web/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    // shadcn CLI output (Plan 05 T13) uses `interface X extends Y {}` idioms; generated
    // code is registry-owned — relax, don't rewrite (the deviations-not-to-fix principle).
    files: ["apps/web/src/components/ui/**"],
    rules: {
      "@typescript-eslint/no-empty-object-type": "off",
    },
  },
);
