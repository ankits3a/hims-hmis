import { test } from "node:test";
import assert from "node:assert/strict";
import { closedIssues, violations } from "./spec-guard.mjs";

const SPECS = ["docs/specs/695-specs-in-git.md", "docs/specs/593-copilot-reminders.md"];

test("closing keywords are read from the PR body, case-insensitive, many per body", () => {
  assert.deepEqual(closedIssues("Closes #695\nfixes #12, Resolves #7. Refs #9"), [695, 12, 7]);
  assert.deepEqual(closedIssues("Refs #695 only"), []);
  assert.deepEqual(closedIssues(null), []);
});
test("a code PR that closes an issue with a spec, without touching the spec, is caught", () => {
  const found = violations({ body: "Closes #695", changed: ["apps/core/src/x.ts"], specFiles: SPECS });
  assert.deepEqual(found, ["#695: docs/specs/695-specs-in-git.md"]);
});
test("the same PR passes when it edits the spec", () => {
  const changed = ["packages/contracts/src/a.ts", "docs/specs/695-specs-in-git.md"];
  assert.deepEqual(violations({ body: "Closes #695", changed, specFiles: SPECS }), []);
});
test("an issue with no spec (a bug fix) passes", () => {
  assert.deepEqual(violations({ body: "Fixes #900", changed: ["apps/web/src/a.tsx"], specFiles: SPECS }), []);
});
test("a PR that changes no code passes, and Refs never binds", () => {
  assert.deepEqual(violations({ body: "Closes #695", changed: ["docs/x.md", "tools/ci/a.mjs"], specFiles: SPECS }), []);
  assert.deepEqual(violations({ body: "Refs #695", changed: ["apps/core/src/x.ts"], specFiles: SPECS }), []);
});
test("a spec number is matched whole, not by prefix", () => {
  const specFiles = ["docs/specs/6950-other.md"];
  assert.deepEqual(violations({ body: "Closes #695", changed: ["apps/core/src/x.ts"], specFiles }), []);
});
test("outside a pull_request event the guard does nothing and exits 0", async () => {
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync("node", [new URL("./spec-guard.mjs", import.meta.url).pathname], {
    env: { ...process.env, GITHUB_EVENT_NAME: "push" },
    encoding: "utf8",
  });
  assert.match(out, /not a pull request/);
});
