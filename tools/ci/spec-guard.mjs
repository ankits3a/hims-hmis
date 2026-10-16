#!/usr/bin/env node
/**
 * SPECS LIVE IN GIT AND CHANGE WITH THE CODE (owner 2026-10-14, #695). An approved feature spec sits at
 * `docs/specs/<issue#>-<slug>.md`. A pull request whose body closes issue #N (`Closes #N`, `Fixes #N`,
 * `Resolves #N`) and that changes code under `apps/` or `packages/` fails here when `docs/specs/N-*.md`
 * exists and the PR does not touch it. The spec is the project's memory: if the build changed what the spec
 * says, the spec says so in the same diff; at the least its `status` flips to `built`. `Refs #N` never binds,
 * and an issue with no spec file (a bug fix) passes untouched.
 *
 * Runs in CI's required `static` job. Outside a pull_request event it does nothing.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const CODE = /^(apps|packages)\//;
const CLOSES = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;

/** PR body → the issue numbers it closes, in order of appearance. */
export function closedIssues(body) {
  return [...String(body ?? "").matchAll(CLOSES)].map((m) => Number(m[1]));
}

/** The spec files of issue `n` among `specFiles` (paths under docs/specs/). */
function specsOf(n, specFiles) {
  return specFiles.filter((p) => p.startsWith(`docs/specs/${n}-`) && p.endsWith(".md"));
}

/** → one line per closed issue whose spec exists but is untouched by a code-changing PR. */
export function violations({ body, changed, specFiles }) {
  if (!changed.some((p) => CODE.test(p))) return [];
  const touched = new Set(changed);
  const out = [];
  for (const n of closedIssues(body)) {
    const specs = specsOf(n, specFiles);
    if (specs.length > 0 && !specs.some((p) => touched.has(p))) out.push(`#${n}: ${specs.join(", ")}`);
  }
  return out;
}

/**
 * #696 — A SPEC'S "DONE MEANS" ARE LOCKED ACCEPTANCE TESTS. Each done-means line carries an id `D1..Dn`;
 * the build lane's first commit adds one test under an `acceptance/` folder whose name contains
 * `spec #N Dk` (red against main), and a PR that sets the spec to `status: built` fails here while any
 * `Dk` has no such test. Ids are read from the `## Done means` section only. `acceptance-guard` keeps
 * those tests from being edited afterwards; this only asks that they exist.
 */
export function doneMeansIds(specText) {
  const lines = String(specText ?? "").split("\n");
  const start = lines.findIndex((l) => /^#{1,6}\s*done means\b/i.test(l.trim()));
  if (start < 0) return [];
  const ids = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line.trim())) break;
    const m = /^\s*(?:[-*]\s*)?(?:\*\*)?(D\d+)\b/.exec(line);
    if (m && !ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
}

const isBuilt = (specText) => /^status:\s*built\s*$/m.test(String(specText ?? "").split(/^---\s*$/m)[1] ?? "");
const ACCEPTANCE = /(^|\/)acceptance\//;

/** → the `spec #N Dk` names a built spec still lacks among the acceptance tests (`[{ path, text }]`). */
export function missingAcceptance({ issue, specText, tests }) {
  if (!isBuilt(specText)) return [];
  const texts = tests.filter((t) => ACCEPTANCE.test(t.path)).map((t) => t.text);
  return doneMeansIds(specText)
    .map((id) => `spec #${issue} ${id}`)
    .filter((name) => !texts.some((t) => new RegExp(`${name.replace(/[#]/g, "\\#")}(?!\\d)`).test(t)));
}

function main() {
  if (process.env.GITHUB_EVENT_NAME !== "pull_request") {
    console.log("spec-guard: not a pull request; nothing to check.");
    return;
  }
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const pr = event.pull_request;
  try {
    execFileSync("git", ["fetch", "-q", "--no-tags", "origin", pr.base.sha, pr.head.sha], { stdio: "ignore" });
  } catch {
    // A shallow checkout lacks the base commit; a full one already has both. Either way diff below decides.
  }
  const lines = (out) => out.split("\n").filter(Boolean);
  const changed = lines(execFileSync("git", ["diff", "--name-only", `${pr.base.sha}...${pr.head.sha}`], { encoding: "utf8" }));
  const specFiles = lines(execFileSync("git", ["ls-tree", "-r", "--name-only", pr.head.sha, "docs/specs/"], { encoding: "utf8" }));
  const found = violations({ body: pr.body, changed, specFiles });
  if (found.length > 0) {
    console.error(
      `spec-guard: this PR changes code and closes issue(s) whose spec it does not touch:\n  ${found.join("\n  ")}\n` +
        `Update the spec in this PR: what changed against it, and \`status: built\` when the build is done.`,
    );
    process.exit(1);
  }
  // #696 — a spec this PR touches and leaves at `status: built` needs a locked acceptance test per done-means id.
  const touched = new Set(changed);
  const show = (path) => execFileSync("git", ["show", `${pr.head.sha}:${path}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  let tests = null;
  const missing = [];
  for (const n of closedIssues(pr.body)) {
    for (const spec of specsOf(n, specFiles).filter((p) => touched.has(p))) {
      const specText = show(spec);
      if (doneMeansIds(specText).length === 0) continue;
      tests ??= lines(execFileSync("git", ["ls-tree", "-r", "--name-only", pr.head.sha], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }))
        .filter((p) => ACCEPTANCE.test(p) && /\.(test|spec)\.[cm]?[jt]sx?$/.test(p))
        .map((path) => ({ path, text: show(path) }));
      for (const name of missingAcceptance({ issue: n, specText, tests })) missing.push(`${spec}: no acceptance test named "${name}"`);
    }
  }
  if (missing.length > 0) {
    console.error(
      `spec-guard: a spec set to \`status: built\` lacks locked acceptance tests for its done-means ids:\n  ${missing.join("\n  ")}\n` +
        "Add one test per id under an acceptance/ folder, named `spec #N Dk`, red against main before the build.",
    );
    process.exit(1);
  }
  console.log("spec-guard: every closed issue's spec moved with the code (or has no spec), and built specs have their acceptance tests.");
}

if (import.meta.url === `file://${process.argv[1]}`) main();
