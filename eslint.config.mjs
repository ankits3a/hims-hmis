import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/drizzle/**", "**/node_modules/**"] },
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
