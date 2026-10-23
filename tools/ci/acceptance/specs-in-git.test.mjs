// Owner-approved done-means of docs/specs/695-specs-in-git.md (decision 0081). Locked by acceptance-guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

const root = new URL("../../../", import.meta.url).pathname;
const read = (p) => readFileSync(root + p, "utf8");

test("spec #695 D1 the guard's own tests pass", () => {
  execFileSync("node", ["--test", root + "tools/ci/spec-guard.test.mjs"], { stdio: "pipe" });
});
test("spec #695 D2 CI's static job runs the guard and its tests", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /- run: node --test tools\/ci\/spec-guard\.test\.mjs/);
  assert.match(ci, /- run: node tools\/ci\/spec-guard\.mjs/);
});
test("spec #695 D3 every spec has frontmatter and nothing on the public scrub list", () => {
  const scrub = /([0-9]{1,3}\.){3}[0-9]{1,3}|\b[0-9]{2}\.[0-9]{5,}|\b[6-9][0-9]{9}\b|BEGIN [A-Z]+ PRIVATE|whatsapp\.env|password\s*[:=]/i;
  const specs = readdirSync(root + "docs/specs").filter((f) => /^\d+-.+\.md$/.test(f));
  assert.ok(specs.length > 0);
  for (const f of specs) {
    const s = read("docs/specs/" + f);
    const n = f.split("-")[0];
    assert.match(s, new RegExp(`^---\\nissue: ${n}\\nstatus: (approved|built|superseded)\\napproved: \\d{4}-\\d{2}-\\d{2}\\n---`), f);
    assert.doesNotMatch(s, scrub, f);
  }
});
test("spec #695 D4 every ROADMAP file is marked superseded and CLAUDE.md names docs/specs and milestones", () => {
  const files = execFileSync("git", ["-C", root, "ls-files", "docs"], { encoding: "utf8" }).split("\n").filter((p) => /ROADMAP[^/]*\.md$/.test(p));
  assert.ok(files.length > 0);
  for (const p of files) assert.match(read(p).slice(0, 600), /SUPERSEDED \(/, p);
  const claude = read("CLAUDE.md");
  assert.match(claude, /docs\/specs\//);
  assert.match(claude, /GitHub milestones are the only roadmap/);
});
