import { test } from "node:test";
import assert from "node:assert/strict";
import { closedIssues, doneMeansIds, missingAcceptance, violations } from "./spec-guard.mjs";

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

// ── #696 — a spec set to `status: built` needs one locked acceptance test per done-means id ──────────────

const SPEC_BUILT = `---
issue: 702
status: built
approved: 2026-10-14
---
# SPEC — something

## Done means
- D1 the first check
- D2 the second check
- D10 the tenth check

## Notes
- D99 is mentioned outside the section and is not an id here
`;

test("done-means ids are read from the Done means section only, in order", () => {
  assert.deepEqual(doneMeansIds(SPEC_BUILT), ["D1", "D2", "D10"]);
  assert.deepEqual(doneMeansIds("---\nstatus: built\n---\n## Done means\n- prose with no ids\n"), []);
});

test("built with a missing Dk acceptance test fails; D1 does not satisfy D10", () => {
  const tests = [
    { path: "apps/core/test/acceptance/x.test.ts", text: 'it("spec #702 D1: ...", () => {});\nit("spec #702 D2 ...", () => {});' },
  ];
  assert.deepEqual(missingAcceptance({ issue: 702, specText: SPEC_BUILT, tests }), ["spec #702 D10"]);
});

test("built with every Dk present passes; tests outside acceptance folders do not count", () => {
  const tests = [
    { path: "apps/core/test/acceptance/x.test.ts", text: 'it("spec #702 D1 and spec #702 D2", () => {});' },
    { path: "apps/web/src/acceptance/y.test.tsx", text: 'it("spec #702 D10: the tenth", () => {});' },
  ];
  assert.deepEqual(missingAcceptance({ issue: 702, specText: SPEC_BUILT, tests }), []);
  const outside = [{ path: "apps/core/src/x.test.ts", text: 'it("spec #702 D1 D2 D10")' }];
  assert.equal(missingAcceptance({ issue: 702, specText: SPEC_BUILT, tests: outside }).length, 3);
});

test("a spec not set to built is not checked", () => {
  assert.deepEqual(missingAcceptance({ issue: 702, specText: SPEC_BUILT.replace("status: built", "status: approved"), tests: [] }), []);
});
