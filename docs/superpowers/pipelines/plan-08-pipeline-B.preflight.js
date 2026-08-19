// Pre-flight for pipeline B (EXECUTE-METHOD v2).
// Probe 1 = module parse (with negative controls proved to fail). Probe 2 = dry run.
// node --check on the .js is INERT for this script shape and is not used as a gate.
const fs = require("fs");
const cp = require("child_process");
const NL = String.fromCharCode(10);
const SRC = process.argv[2] || "plan-08-pipeline-B.js";
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
fs.writeFileSync("pf.probe.mjs", asModule);
ok("script parses as an ES module", check("pf.probe.mjs").code === 0, check("pf.probe.mjs").err);
fs.writeFileSync("pf.negdup.mjs", asModule + NL + "function brief() {}" + NL);
ok("NEG-CONTROL A: duplicate function brief() rejected", check("pf.negdup.mjs").code === 1);
const brokenSep = "const SEP = " + "'" + NL + NL + "'" + " + " + "'x'";
fs.writeFileSync("pf.negstr.mjs", asModule.replace(/^const SEP = .*$/m, brokenSep));
ok("NEG-CONTROL B: broken string literal rejected", check("pf.negstr.mjs").code === 1);

console.log(NL + "== PROBE 2: dry run ==");
const calls = [], phases = [], logs = [];
async function stubAgent(prompt, opts) {
  calls.push({ prompt, label: opts.label, model: opts.model, phase: opts.phase, schema: opts.schema });
  const l = String(opts.label);
  if (l.indexOf("discovery:") === 0) return { findings: ["stub"], commits_read: ["abc1234"], cross_task_risks: [], carried_forward_to_c: [] };
  if (l.indexOf("gate:") === 0 || l.indexOf("check:") === 0)
    return { verdict: "pass", violations: [], corrections: [], findings: [], tests: { ran: "stub", passed: 1, failed: 0 } };
  return { outcome: "stub", files_changed: ["stub.ts"], tests: "stub", interpretations: [] };
}
async function stubParallel(thunks) { return Promise.all(thunks.map((f) => f())); }
const body = src.replace(/^export const meta/m, "const meta");
const run = new Function("agent", "parallel", "phase", "log",
  '"use strict"; return (async () => {' + NL + body + NL + "})()");

run(stubAgent, stubParallel, (t) => phases.push(t), (m) => logs.push(m))
  .then((result) => {
    console.log("  result.summary = " + result.summary);
    ok("all six tasks done", result.summary === "6/6 done", result.summary);
    ok("halted empty", result.halted.length === 0, JSON.stringify(result.halted));
    ok("discovery ran and returned", !!result.discovery);
    ok("13 agents (6 coder + 4 gate + 2 check + 1 discovery)", calls.length === 13, "got " + calls.length);
    ok("phases Wave 1..6 then Discovery",
      phases.join(",") === "Wave 1,Wave 2,Wave 3,Wave 4,Wave 5,Wave 6,Discovery", phases.join(","));

    const coders = calls.filter((c) => !/^(gate:|check:|discovery:)/.test(c.label));
    const gates = calls.filter((c) => /^gate:/.test(c.label));
    const checks = calls.filter((c) => /^check:/.test(c.label));
    const disc = calls.filter((c) => /^discovery:/.test(c.label));

    ok("6 coders / 4 gates / 2 checks / 1 discovery",
      coders.length === 6 && gates.length === 4 && checks.length === 2 && disc.length === 1,
      `${coders.length}/${gates.length}/${checks.length}/${disc.length}`);
    ok("coder models = opus,opus,sonnet,opus,opus,sonnet",
      coders.map((c) => c.model).join(",") === "opus,opus,sonnet,opus,opus,sonnet",
      coders.map((c) => c.label + "=" + c.model).join(" "));
    ok("gates are on t7,t8,t9,t10 and all opus",
      gates.map((g) => g.label.replace(/#.*/, "")).join(",") === "gate:t7,gate:t8,gate:t9,gate:t10" &&
      gates.every((g) => g.model === "opus"),
      gates.map((g) => g.label + "=" + g.model).join(" "));
    ok("mechanical checks are on t11,t12 and are sonnet",
      checks.map((c) => c.label.replace(/#.*/, "")).join(",") === "check:t11,check:t12" &&
      checks.every((c) => c.model === "sonnet"),
      checks.map((c) => c.label + "=" + c.model).join(" "));
    ok("discovery is opus", disc[0].model === "opus", disc[0].model);

    // --- rendered-brief assertions (EXECUTION-LESSONS 2.19)
    const SHARED = [
      "/opt/hmis/docs/superpowers/AGENT-RULES.md",
      "READ RULE 22 BEFORE YOU TOUCH A FILE",
      "THE PLAN IS THE SPEC",
      "2026-08-18-phase1-08-billing-counter.md",
      "plan-08-pipeline-A-notes.md",
      "BASELINE — MEASURED, WITH ITS TIMESTAMP",
      "RE-CONFIRM BEFORE YOU TRUST IT",
      "THE MIRROR WORKFLOW",
      "FROZEN PATHS WHILE THIS PIPELINE RUNS",
      "HALT CONDITIONS",
      "DEVIATIONS NOT TO FIX",
      "FINISH BLOCK",
      "STANDING RESOLUTION: settlement.ts stays PURE",
    ];
    let miss = [];
    coders.concat(gates).forEach((c) => SHARED.forEach((m) => { if (c.prompt.indexOf(m) === -1) miss.push(c.label + " :: " + m); }));
    ok("every shared block renders in every coder+gate prompt", miss.length === 0, miss.slice(0, 4).join(" | "));

    // the rules are REFERENCED, not inlined — the old tripwire block must be absent
    ok("the old inlined tripwire block is GONE from every prompt",
      calls.every((c) => c.prompt.indexOf("HARD RULES (violating any one of these") === -1));

    // tier-correct mutant block
    const critIds = ["t7", "t8", "t9", "t10"], routIds = ["t11", "t12"];
    ok("CRITICAL briefs carry the CRITICAL mutant block and not the ROUTINE one",
      critIds.every((id) => {
        const c = coders.find((x) => x.label.endsWith(":" + id));
        return c.prompt.indexOf("YOUR TASK IS **CRITICAL** TIER") !== -1 &&
               c.prompt.indexOf("Mutants are NOT required") === -1;
      }));
    ok("ROUTINE briefs carry the ROUTINE mutant block and not the CRITICAL one",
      routIds.every((id) => {
        const c = coders.find((x) => x.label.endsWith(":" + id));
        return c.prompt.indexOf("**Mutants are NOT required for this task.**") !== -1 &&
               c.prompt.indexOf("YOUR TASK IS **CRITICAL** TIER") === -1;
      }));
    ok("no per-task test-count target survives in any brief",
      coders.every((c) => !/apps\/core totals = \d+ suites/.test(c.prompt)));

    // per-task content spot checks, incl. the carried-forward items
    const spot = {
      t7: ["RISK TIER: **CRITICAL**", "K24, K25, K26", "loadRuleConfig", "M-C2"],
      t8: ["advanceOf is NOT floored at zero", "insertReceiptWithTenders", "K27, K28, K29, K30", "for no key update"],
      t9: ["expectedNetPaise is ALREADY STAMPED", "M-N1", "No PSP API anywhere"],
      t10: ["K35's discriminating fixture ALREADY EXISTS", "b09", "EXACTLY these four OPD files"],
      t11: ["RISK TIER: **ROUTINE**", "updateBillingConfig throws a raw ZodError", "confirmClose performs NO actor check", "listSessions ships with zero test coverage"],
      t12: ["OWES NO RED RUN", "validate:billing` returns ok=true", "16-char ceiling", "PIPELINE B ENDS WITH THIS TASK"],
    };
    Object.keys(spot).forEach((id) => {
      const c = coders.find((x) => x.label.endsWith(":" + id));
      spot[id].forEach((n) => ok(id + ' brief contains "' + n.slice(0, 44) + '"', c && c.prompt.indexOf(n) !== -1));
    });

    ok("every coder prompt renders its acceptance criteria",
      coders.every((c) => c.prompt.indexOf("Acceptance criteria your work must meet:") !== -1));
    ok("gate prompts carry criteria + coder report + tier",
      gates.every((g) => g.prompt.indexOf("Acceptance criteria:") !== -1 &&
        g.prompt.indexOf('"files_changed":["stub.ts"]') !== -1 &&
        g.prompt.indexOf("Its risk tier is CRITICAL") !== -1));
    ok("mechanical prompts carry the fixed checklist and refuse design review",
      checks.every((c) => c.prompt.indexOf("RUN EXACTLY THIS CHECKLIST") !== -1 &&
        c.prompt.indexOf("You are NOT a design reviewer") !== -1));
    ok("discovery prompt names all six hunt classes and forbids writes",
      disc[0].prompt.indexOf("DORMANT DEFECTS ARMED BY A LATER TASK") !== -1 &&
      disc[0].prompt.indexOf("CONVENTIONS NOTHING TESTS") !== -1 &&
      disc[0].prompt.indexOf("You are read-only apart from your own scratch") !== -1 &&
      disc[0].prompt.indexOf("ASSERTIONS THAT CANNOT DISCRIMINATE") !== -1 &&
      disc[0].prompt.indexOf("THE CARRIED-FORWARD LIST") !== -1);
    ok("schemas attached correctly",
      coders.every((c) => c.schema.required.join() === "outcome,files_changed,tests,interpretations") &&
      gates.concat(checks).every((g) => g.schema.required.join() === "verdict,violations,corrections,tests") &&
      disc[0].schema.required.join() === "findings,commits_read");

    console.log("  brief sizes: " + coders.map((c) => c.label + "=" + Math.round(c.prompt.length / 1000) + "k").join(" "));
    console.log("  discovery prompt: " + Math.round(disc[0].prompt.length / 1000) + "k");
    console.log(NL + (fails === 0 ? "PRE-FLIGHT PASSED — " : "PRE-FLIGHT FAILED — ") + fails + " failure(s)");
    ["pf.probe.mjs", "pf.negdup.mjs", "pf.negstr.mjs"].forEach((f) => { try { fs.unlinkSync(f); } catch (e) {} });
    process.exit(fails === 0 ? 0 : 1);
  })
  .catch((e) => { console.error("DRY RUN THREW: " + (e && e.stack || e)); process.exit(1); });
