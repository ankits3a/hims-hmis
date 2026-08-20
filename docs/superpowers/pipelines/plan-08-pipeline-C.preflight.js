// Pre-flight for pipeline C (EXECUTE-METHOD v2).
// Probe 1 = module parse (with negative controls proved to fail). Probe 2 = dry run.
// node --check on the .js is INERT for this script shape and is not used as a gate.
//
// CHANGED FROM PIPELINE B'S PRE-FLIGHT, per EXECUTION-LESSONS 2.32: the shared-block assertion now
// runs over EVERY agent the script spawns, not `coders.concat(gates)`. B's version excluded the
// mechanical checkers and the discovery reviewer by construction, which is precisely why a reviewer
// shipped without the rules pointer and breached the no-/tmp rule it had never been shown.
const fs = require("fs");
const cp = require("child_process");
const NL = String.fromCharCode(10);
const SRC = process.argv[2] || "plan-08-pipeline-C.js";
let fails = 0;
function ok(name, cond, extra) {
  if (cond) console.log("  PASS  " + name);
  else { console.log("  FAIL  " + name + (extra ? "  <<< " + extra : "")); fails++; }
}
function check(file) {
  const r = cp.spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  return { code: r.status, err: (r.stderr || "").split(NL)[3] || "" };
}

const src = fs.readFileSync(SRC, "utf8");

console.log(NL + "== PROBE 1: module parse, with negative controls ==");
const returns = src.match(/^return \{/gm) || [];
ok('exactly one top-level "return {"', returns.length === 1, "found " + returns.length);
const asModule = src.replace(/^return \{/m, "const __result = {");
fs.writeFileSync("pfc.probe.mjs", asModule);
ok("script parses as an ES module", check("pfc.probe.mjs").code === 0, check("pfc.probe.mjs").err);
fs.writeFileSync("pfc.negdup.mjs", asModule + NL + "function brief() {}" + NL);
ok("NEG-CONTROL A: duplicate function brief() rejected", check("pfc.negdup.mjs").code === 1);
const brokenSep = "const SEP = " + "'" + NL + NL + "'" + " + " + "'x'";
fs.writeFileSync("pfc.negstr.mjs", asModule.replace(/^const SEP = .*$/m, brokenSep));
ok("NEG-CONTROL B: broken string literal rejected", check("pfc.negstr.mjs").code === 1);

console.log(NL + "== PROBE 2: dry run ==");
const calls = [], phases = [], logs = [];
async function stubAgent(prompt, opts) {
  calls.push({ prompt, label: opts.label, model: opts.model, phase: opts.phase, schema: opts.schema });
  const l = String(opts.label);
  if (l.indexOf("discovery:") === 0) return { findings: ["stub"], commits_read: ["abc1234"], cross_task_risks: [], carried_forward: [] };
  if (l.indexOf("gate:") === 0)
    return { verdict: "pass", violations: [], corrections: [], findings: [], tests: { ran: "stub", passed: 1, failed: 0 } };
  return { outcome: "stub", files_changed: ["stub.tsx"], tests: "stub", interpretations: [] };
}
async function stubParallel(thunks) { return Promise.all(thunks.map((f) => f())); }
const body = src.replace(/^export const meta/m, "const meta");
const run = new Function("agent", "parallel", "phase", "log",
  '"use strict"; return (async () => {' + NL + body + NL + "})()");

run(stubAgent, stubParallel, (t) => phases.push(t), (m) => logs.push(m))
  .then((result) => {
    console.log("  result.summary = " + result.summary);
    ok("all four tasks done", result.summary === "4/4 done", result.summary);
    ok("halted empty", result.halted.length === 0, JSON.stringify(result.halted));
    ok("discovery ran and returned", !!result.discovery);
    ok("9 agents (4 coder + 4 gate + 1 discovery)", calls.length === 9, "got " + calls.length);
    ok("phases Wave 1..4 then Discovery",
      phases.join(",") === "Wave 1,Wave 2,Wave 3,Wave 4,Discovery", phases.join(","));

    const coders = calls.filter((c) => !/^(gate:|discovery:)/.test(c.label));
    const gates = calls.filter((c) => /^gate:/.test(c.label));
    const disc = calls.filter((c) => /^discovery:/.test(c.label));

    ok("4 coders / 4 gates / 1 discovery",
      coders.length === 4 && gates.length === 4 && disc.length === 1,
      `${coders.length}/${gates.length}/${disc.length}`);
    ok("EVERY task is CRITICAL, so there is NO mechanical-check agent",
      calls.every((c) => !/^check:/.test(String(c.label))), calls.map((c) => c.label).join(" "));
    ok("all four coders are opus", coders.every((c) => c.model === "opus"),
      coders.map((c) => c.label + "=" + c.model).join(" "));
    ok("gates are on t13,t14,t15,t16 and all opus",
      gates.map((g) => g.label.replace(/#.*/, "")).join(",") === "gate:t13,gate:t14,gate:t15,gate:t16" &&
      gates.every((g) => g.model === "opus"),
      gates.map((g) => g.label + "=" + g.model).join(" "));
    ok("discovery is opus", disc[0].model === "opus", disc[0].model);

    // --- rendered-brief assertions (EXECUTION-LESSONS 2.19)
    const SHARED = [
      "/opt/hmis/docs/superpowers/AGENT-RULES.md",
      "RULE 22(f) - you do NOT delete your local mirror",
      "THIS IS A WEB PIPELINE",
      "VITEST 3",
      "THE PLAN IS THE SPEC",
      "2026-08-18-phase1-08-billing-counter.md",
      "plan-08-pipeline-B-notes.md",
      "BASELINE - MEASURED, WITH ITS TIMESTAMP",
      "RE-CONFIRM BEFORE YOU TRUST IT",
      "THE MIRROR WORKFLOW",
      "FROZEN PATHS WHILE THIS PIPELINE RUNS",
      "HALT CONDITIONS",
      "CARRIED FORWARD FROM PIPELINES A AND B",
      "DEVIATIONS NOT TO FIX",
      "THE DATED-SUITE TRIPWIRE",
      "FINISH BLOCK",
      "TWO REFUSALS ARE TERMINAL BY DESIGN",
      "THE CLEARANCE-DISCOUNT LANE IS DEAD BY DEFAULT",
    ];
    let miss = [];
    coders.concat(gates).forEach((c) => SHARED.forEach((m) => { if (c.prompt.indexOf(m) === -1) miss.push(c.label + " :: " + m); }));
    ok("every shared block renders in every coder+gate prompt", miss.length === 0, miss.slice(0, 4).join(" | "));

    // *** THE 2.32 FIX: the discovery reviewer is an agent too, and it must carry the rules. ***
    const DISC_MUST = [
      "docs/superpowers/AGENT-RULES.md",
      "NEVER write to /tmp on the build host",
      "rule 3 and it is absolute",
      "Do NOT delete the mirror at the end and do not try",
      "plan-08-pipeline-B-notes.md",
    ];
    const dmiss = DISC_MUST.filter((m) => disc[0].prompt.indexOf(m) === -1);
    ok("2.32 FIX: the discovery prompt carries the rules pointer and the no-/tmp prohibition",
      dmiss.length === 0, dmiss.join(" | "));
    ok("2.32 FIX: EVERY agent this script spawns names AGENT-RULES.md",
      calls.every((c) => c.prompt.indexOf("AGENT-RULES.md") !== -1),
      calls.filter((c) => c.prompt.indexOf("AGENT-RULES.md") === -1).map((c) => c.label).join(" "));

    // the rules are REFERENCED, not inlined
    ok("the old inlined tripwire block is GONE from every prompt",
      calls.every((c) => c.prompt.indexOf("HARD RULES (violating any one of these") === -1));

    // every task is CRITICAL tier
    ok("all four briefs carry the CRITICAL mutant block and none carries the ROUTINE one",
      coders.every((c) => c.prompt.indexOf("EVERY TASK IN THIS PIPELINE IS **CRITICAL** TIER") !== -1 &&
                          c.prompt.indexOf("Mutants are NOT required") === -1));
    ok("no per-task test-count target survives in any brief",
      coders.every((c) => !/apps\/web totals = \d+ files/.test(c.prompt)));
    ok("the not-over-broad rule (3.44) is in every brief AND every criteria set",
      coders.every((c) => c.prompt.indexOf("NOT-OVER-BROAD") !== -1 &&
                          c.prompt.indexOf("WRITE AND ASSERT THE NOT-OVER-BROAD CASE TOO") !== -1));

    // per-task content spot checks, incl. the verified plan defect and the carried items
    const spot = {
      t13: ["RISK TIER: **CRITICAL**", "That file already", "26 files", "W-1, W-2, W-3, W-4",
            "THIS TASK OWNS THE POLLING CONVENTION'S TEETH", "DELETION ONLY"],
      t14: ["UPGRADED from the plan body's '(sonnet coder)'", "THE LOAD-BEARING ASSERTION IS THE POSTED PARTIAL AMOUNT",
            "cannot separate W-5 from", "CONFIGURATION MESSAGE", "W-5, W-6"],
      t15: ["W-8 AND W-9 ARE PLAN 07's SURVIVING MUTANTS", "FIXTURE REORDER, not a rewrite",
            "byte-frozen", "W-7, W-8, W-9"],
      t16: ["K46 IS THE HEART OF THIS TASK", "INTENTIONALLY INCONSISTENT", "todayIst",
            "THE PERMISSION MAP IS UNTESTED SERVER-SIDE", "W-10, W-11"],
    };
    Object.keys(spot).forEach((id) => {
      const c = coders.find((x) => x.label.endsWith(":" + id));
      spot[id].forEach((n) => ok(id + ' brief contains "' + n.slice(0, 46) + '"', c && c.prompt.indexOf(n) !== -1));
    });

    ok("every coder prompt renders its acceptance criteria",
      coders.every((c) => c.prompt.indexOf("Acceptance criteria your work must meet:") !== -1));
    ok("gate prompts carry criteria + coder report + tier + the CI carve-out",
      gates.every((g) => g.prompt.indexOf("Acceptance criteria:") !== -1 &&
        g.prompt.indexOf('"files_changed":["stub.tsx"]') !== -1 &&
        g.prompt.indexOf("Its risk tier is CRITICAL") !== -1 &&
        g.prompt.indexOf("CI IS NOT CHECKABLE FROM THE BUILD HOST") !== -1));
    ok("gate prompts require the reviewer to rebuild a mutant itself",
      gates.every((g) => g.prompt.indexOf("REBUILD AT LEAST ONE MUTANT YOURSELF") !== -1));
    ok("gate prompts require naming a correction that no retry could satisfy",
      gates.every((g) => g.prompt.indexOf("that means no retry can fix it") !== -1));
    ok("discovery prompt names all seven hunt classes and forbids writes",
      disc[0].prompt.indexOf("DORMANT DEFECTS ARMED BY A LATER TASK") !== -1 &&
      disc[0].prompt.indexOf("CONVENTIONS NOTHING TESTS") !== -1 &&
      disc[0].prompt.indexOf("ASSERTIONS THAT CANNOT DISCRIMINATE") !== -1 &&
      disc[0].prompt.indexOf("CROSS-TASK DUPLICATION AND DRIFT") !== -1 &&
      disc[0].prompt.indexOf("THE CARRIED-FORWARD LIST") !== -1 &&
      disc[0].prompt.indexOf("ANYTHING THE PLAN PROMISED THAT NOTHING PROVES") !== -1 &&
      disc[0].prompt.indexOf("THE TWO ABSORBED PLAN 07 ASSERTIONS") !== -1 &&
      disc[0].prompt.indexOf("read-only apart from your own scratch") !== -1);
    ok("schemas attached correctly",
      coders.every((c) => c.schema.required.join() === "outcome,files_changed,tests,interpretations") &&
      gates.every((g) => g.schema.required.join() === "verdict,violations,corrections,tests") &&
      disc[0].schema.required.join() === "findings,commits_read");

    console.log("  brief sizes: " + coders.map((c) => c.label + "=" + Math.round(c.prompt.length / 1000) + "k").join(" "));
    console.log("  gate  sizes: " + gates.map((c) => c.label + "=" + Math.round(c.prompt.length / 1000) + "k").join(" "));
    console.log("  discovery prompt: " + Math.round(disc[0].prompt.length / 1000) + "k");
    console.log(NL + (fails === 0 ? "PRE-FLIGHT PASSED — " : "PRE-FLIGHT FAILED — ") + fails + " failure(s)");
    ["pfc.probe.mjs", "pfc.negdup.mjs", "pfc.negstr.mjs"].forEach((f) => { try { fs.unlinkSync(f); } catch (e) {} });
    process.exit(fails === 0 ? 0 : 1);
  })
  .catch((e) => { console.error("DRY RUN THREW: " + (e && e.stack || e)); process.exit(1); });
