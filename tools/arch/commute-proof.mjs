#!/usr/bin/env node
/**
 * Replays "two PRs each add a route, then merge one after the other" in a throwaway clone and runs
 * `gen.mjs --check` on the result: the failure that turned main red three times on 2026-10-16 (#906).
 *
 *   node tools/arch/commute-proof.mjs                  # the generator in this working tree
 *   node tools/arch/commute-proof.mjs --gen <file>     # any other generator, e.g. main's, to see it fail
 *
 * Each PR branches from the same base, regenerates the map on its own and commits it, as lanes do.
 * The merge is a cherry-pick of PR B onto main-after-A: what GitHub's rebase or squash merge does
 * under this repo's linear history. Scenarios:
 *   same-module   A and B each add a route to a different controller of one module, in a URL area it
 *                 already serves (the 2026-10-16 opd case).
 *   two-modules   A and B each add a new controller (a new URL area) to two different modules.
 * A scenario passes when the merge is clean and `--check` is green. A git conflict is reported as
 * its own outcome: GitHub refuses that merge, so main stays green, but the second PR must regenerate.
 *
 * Slow (~7 generator runs; ~45 s each on CI), so it is a proof to run by hand after changing what
 * gen.mjs renders, not a CI step. It never touches this checkout: the clone lives in the OS temp dir
 * and has its own refs.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";

const HERE = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const genArg = process.argv.indexOf("--gen");
const GEN = resolve(genArg > 0 ? process.argv[genArg + 1] : join(HERE, "tools/arch/gen.mjs"));
const TMP = mkdtempSync(join(tmpdir(), "arch-commute-"));
const W = join(TMP, "repo");

const git = (...a) => execFileSync("git", ["-C", W, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const gen = (...a) => {
  try {
    execFileSync("node", ["tools/arch/gen.mjs", ...a], { cwd: W, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, out: "" };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() };
  }
};
const commit = (msg) => {
  git("add", "--", "apps", "docs", "tools");
  git("commit", "-q", "--no-verify", "--allow-empty", "-m", msg);
  return git("rev-parse", "HEAD");
};

const MODULES = () => join(W, "apps/core/src/modules");
const controllersOf = (m) =>
  readdirSync(join(MODULES(), m), { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".controller.ts"))
    .sort()
    .map((f) => join(MODULES(), m, f));

/** A quoted `@Get("x")` whose full path (controller prefix + x) has at least two segments. */
function routeInExistingArea(file) {
  const s = readFileSync(file, "utf8");
  const prefix = (s.match(/@Controller\(\s*["'`]([^"'`]*)["'`]/) ?? [])[1] ?? "";
  for (const m of s.matchAll(/@Get\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
    if ([prefix, m[1]].join("/").split("/").filter(Boolean).length >= 2 && !m[1].includes(":")) return m[1];
  }
  return null;
}

function addMethod(file, path, name) {
  const s = readFileSync(file, "utf8");
  const end = s.lastIndexOf("}");
  writeFileSync(file, `${s.slice(0, end)}\n  @Get("${path}")\n  ${name}() {\n    return null;\n  }\n${s.slice(end)}`);
}

function addController(m, tag) {
  const cls = `CommuteProof${tag.toUpperCase()}Controller`;
  writeFileSync(
    join(MODULES(), m, `commute-proof-${tag}.controller.ts`),
    `import { Controller, Get } from "@nestjs/common";\n\n@Controller("commute-proof-${tag}")\nexport class ${cls} {\n  @Get("probe")\n  probe() {\n    return null;\n  }\n}\n`,
  );
}

/** Branch PR A and PR B from base, regenerate on each, then land A and cherry-pick B on top. */
function replay(name, base, editA, editB) {
  const tip = (edit, tag) => {
    git("checkout", "-q", "--detach", base);
    edit();
    const g = gen();
    if (!g.ok) throw new Error(`${name}: PR ${tag} could not regenerate:\n${g.out}`);
    return commit(`PR ${tag}`);
  };
  const a = tip(editA, "a");
  const b = tip(editB, "b");
  git("checkout", "-q", "--detach", a);
  try {
    git("cherry-pick", "--allow-empty", b);
  } catch {
    const files = git("diff", "--name-only", "--diff-filter=U");
    git("cherry-pick", "--abort");
    return { name, outcome: "conflict", detail: files.replace(/\n/g, ", ") };
  }
  const c = gen("--check");
  return { name, outcome: c.ok ? "green" : "RED", detail: c.ok ? "" : c.out.split("\n").filter((l) => /stale/.test(l)).join(" ") };
}

const results = [];
try {
  execFileSync("git", ["clone", "-q", "--shared", HERE, W], { stdio: "ignore" });
  git("config", "user.email", "commute-proof@localhost");
  git("config", "user.name", "commute-proof");
  copyFileSync(GEN, join(W, "tools/arch/gen.mjs"));
  if (!gen().ok) throw new Error("base: the generator under test failed");
  const base = commit("base: map regenerated by the generator under test");

  const modules = readdirSync(MODULES()).filter((m) => existsSync(join(MODULES(), m, "index.ts"))).sort();
  // Prefer opd (the module that went red); otherwise the first module with two usable controllers.
  const pick = ["opd", ...modules].find((m) => modules.includes(m) && controllersOf(m).filter(routeInExistingArea).length >= 2);
  if (!pick) throw new Error("no module has two controllers with a two-segment GET route");
  // First and last controller: under a count-bearing generator, neighbouring controller lines would
  // conflict instead of merging clean-but-stale, which hides the failure this replays.
  const usable = controllersOf(pick).filter(routeInExistingArea);
  const [c1, c2] = [usable[0], usable[usable.length - 1]];
  results.push(
    replay(
      `same-module (${pick}: ${c1.split("/").pop()} + ${c2.split("/").pop()})`,
      base,
      () => addMethod(c1, `${routeInExistingArea(c1)}/commute-proof-a`, "commuteProofA"),
      () => addMethod(c2, `${routeInExistingArea(c2)}/commute-proof-b`, "commuteProofB"),
    ),
  );
  const [x, y] = [modules[0], modules[modules.length - 1]];
  results.push(replay(`two-modules (${x} + ${y}, new URL areas)`, base, () => addController(x, "a"), () => addController(y, "b")));
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

console.log(`generator: ${GEN}`);
for (const r of results) console.log(`${r.outcome.padEnd(8)} ${r.name}${r.detail ? `\n         ${r.detail}` : ""}`);
process.exit(results.every((r) => r.outcome === "green") ? 0 : 1);
