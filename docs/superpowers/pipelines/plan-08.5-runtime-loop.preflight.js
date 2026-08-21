// Pre-flight for Plan 08.5's pipeline (EXECUTE-METHOD v2).
//
// PROBE 1 = module parse, with negative controls PROVED TO FAIL in the same run.
// PROBE 2 = dry run with stubbed agent/parallel/phase/log, asserting the RENDERED briefs.
// `node --check` on the .js is INERT for this script shape (a top-level `return` makes it exit 0
// on genuine syntax errors, EXECUTION-LESSONS 2.22) and is deliberately NOT used as a gate.
//
// The division of labour is proved by control and neither half substitutes for the other (2.18):
// the module-parse probe catches duplicate declarations and real syntax errors and CANNOT catch a
// dropped constant (a ReferenceError is not a parse error); the dry run catches the dropped
// constant and cannot catch the duplicate.
//
// WHAT THIS PRE-FLIGHT ADDS OVER PIPELINE C'S:
//   2.34  CROSS-REFERENCES ARE RESOLVED, NOT MATCHED. Every plan section a brief cites is looked
//         up IN THE PLAN FILE. A marker assertion is a spell-check, not a fact-check, and the last
//         compile shipped "D5 (the counter flow), D10 (the wedge scanner)" past 40 green marker
//         assertions when D5 is "Document series" and D10 is "what we don't build".
//   2.25  THE FROZEN BLOCK IS GENERATED, and this asserts the generation actually happened: each
//         brief must list its OWN files as allowed and the OTHER tasks' files as forbidden.
//   FORK  No unfilled fork slot may survive into a rendered brief. The compile leaves __TOKENS__
//         where the spike's measurements go; if one survives, an agent reads a placeholder.
const fs = require("fs");
const cp = require("child_process");
const NL = String.fromCharCode(10);
const SRC = process.argv[2] || "plan-08.5-runtime-loop.js";
const PLAN = process.argv[3] || "../plans/2026-08-21-phase1-08.5-runtime-loop.md";
let fails = 0;
function ok(name, cond, extra) {
  if (cond) console.log("  PASS  " + name);
  else { console.log("  FAIL  " + name + (extra ? "  <<< " + extra : "")); fails++; }
}
function check(file) {
  const r = cp.spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  return { code: r.status, err: (r.stderr || "").split(NL).slice(0, 5).join(" | ") };
}

const src = fs.readFileSync(SRC, "utf8");
const plan = fs.readFileSync(PLAN, "utf8");

console.log(NL + "== PROBE 1: module parse, with negative controls ==");
const returns = src.match(/^return \{/gm) || [];
ok('exactly one top-level "return {"', returns.length === 1, "found " + returns.length);
const asModule = src.replace(/^return \{/m, "const __result = {");
fs.writeFileSync("p085.probe.mjs", asModule);
const pos = check("p085.probe.mjs");
ok("script parses as an ES module", pos.code === 0, pos.err);

fs.writeFileSync("p085.negdup.mjs", asModule + NL + "function brief() {}" + NL);
const negA = check("p085.negdup.mjs");
ok("NEG-CONTROL A: a duplicate function brief() IS REJECTED (exit " + negA.code + ")", negA.code === 1,
   "the probe is INERT if this passes");

const brokenSep = "const SEP = " + "'" + NL + NL + "'" + " + " + "'x'";
fs.writeFileSync("p085.negstr.mjs", asModule.replace(/^const SEP = .*$/m, brokenSep));
const negB = check("p085.negstr.mjs");
ok("NEG-CONTROL B: a broken string literal IS REJECTED (exit " + negB.code + ")", negB.code === 1,
   "the probe is INERT if this passes");

console.log(NL + "== PROBE 0: no unfilled fork slot survives the compile ==");
const slots = src.match(/__[A-Z0-9_]+__/g) || [];
ok("every fork slot has been filled from the spike report", slots.length === 0,
   "SURVIVING: " + [...new Set(slots)].join(" "));

console.log(NL + "== PROBE 2: dry run ==");
const calls = [], phases = [], logs = [];
async function stubAgent(prompt, opts) {
  calls.push({ prompt, label: String(opts.label), model: opts.model, phase: opts.phase, schema: opts.schema });
  const l = String(opts.label);
  if (l.indexOf("discovery:") === 0) return { findings: ["stub"], commits_read: ["abc1234"], cross_task_risks: [], carried_forward: [] };
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
    ok("not stalled", result.stalled === false, String(result.stalled));
    ok("discovery ran and returned", !!result.discovery);
    ok("phases are Wave 1..6 then Discovery",
      phases.join(",") === "Wave 1,Wave 2,Wave 3,Wave 4,Wave 5,Wave 6,Discovery", phases.join(","));

    const coders = calls.filter((c) => !/^(gate:|check:|discovery:)/.test(c.label));
    const gates = calls.filter((c) => /^gate:/.test(c.label));
    const checks = calls.filter((c) => /^check:/.test(c.label));
    const disc = calls.filter((c) => /^discovery:/.test(c.label));
    const reviewers = gates.concat(checks);

    ok("13 agents total (6 coder + 2 gate + 4 check + 1 discovery)", calls.length === 13, "got " + calls.length);
    ok("6 coders / 2 gates / 4 checks / 1 discovery",
      coders.length === 6 && gates.length === 2 && checks.length === 4 && disc.length === 1,
      `${coders.length}/${gates.length}/${checks.length}/${disc.length}`);
    ok("the two GATES are on the two CRITICAL tasks (t3, t4) and both opus",
      gates.map((g) => g.label.replace(/#.*/, "")).sort().join(",") === "gate:t3,gate:t4" &&
      gates.every((g) => g.model === "opus"),
      gates.map((g) => g.label + "=" + g.model).join(" "));
    ok("the four CHECKS are on the four ROUTINE tasks (t1, t2, t5, t6) and all sonnet",
      checks.map((c) => c.label.replace(/#.*/, "")).sort().join(",") === "check:t1,check:t2,check:t5,check:t6" &&
      checks.every((c) => c.model === "sonnet"),
      checks.map((c) => c.label + "=" + c.model).join(" "));
    ok("discovery is opus", disc[0].model === "opus", disc[0].model);
    ok("no task has BOTH a gate and a check",
      gates.concat(checks).map((c) => c.label.replace(/^[a-z]+:/, "").replace(/#.*/, "")).length ===
      new Set(gates.concat(checks).map((c) => c.label.replace(/^[a-z]+:/, "").replace(/#.*/, ""))).size);

    // ---- SHARED BLOCKS, over EVERY agent this script spawns (EXECUTION-LESSONS 2.32) ----------
    // NOT coders.concat(gates). That form excludes the checkers and the discovery reviewer BY
    // CONSTRUCTION, and that exclusion is exactly how a checker shipped without the rules pointer
    // and breached the absolute no-/tmp rule it had never been shown.
    const EVERY_AGENT_MUST = [
      "/opt/hmis/docs/superpowers/AGENT-RULES.md",
      "IT BINDS YOU WHATEVER YOUR ROLE IS",
      "22(g)",
      "NOT EVIDENCE ABOUT THE SERVER'S TREE",
    ];
    let amiss = [];
    calls.forEach((c) => EVERY_AGENT_MUST.forEach((m) => { if (c.prompt.indexOf(m) === -1) amiss.push(c.label + " :: " + m); }));
    ok("2.32 FIX: EVERY agent (coders + gates + CHECKS + discovery) carries the rules pointer and 22(g)",
      amiss.length === 0, amiss.slice(0, 5).join(" | "));
    ok("2.32 FIX: every agent is told /tmp is absolutely forbidden",
      calls.every((c) => /\/tmp/.test(c.prompt)),
      calls.filter((c) => !/\/tmp/.test(c.prompt)).map((c) => c.label).join(" "));
    ok("the rules are REFERENCED, never inlined: no prompt pastes a numbered hard-rules block",
      calls.every((c) => c.prompt.indexOf("## 1. Hard rules") === -1 &&
                         c.prompt.indexOf("HARD RULES (violating any one of these") === -1));

    const CODER_AND_REVIEWER_MUST = [
      "STEP 0, BEFORE ANYTHING ELSE - READ THE FINDINGS INBOX",   // coders read it
      "THIS IS A CORE PIPELINE",
      "THE PLAN IS THE SPEC",
      "2026-08-21-phase1-08.5-runtime-loop.md",
      "plan-08.5-spike-report.md",
      "BASELINE - MEASURED, WITH ITS TIMESTAMP",
      "RE-CONFIRM BEFORE YOU TRUST IT",
      "THE MIRROR WORKFLOW",
      "FROZEN PATHS WHILE THIS PIPELINE RUNS",
      "HALT CONDITIONS",
      "MIGRATIONS - AGENT-RULES SECTION 6",
      "THE DATED BOMB IS LIVE",
      "DEVIATIONS NOT TO FIX",
      "COMMIT MESSAGE - EXACTLY THIS",
      "FINISH BLOCK",
    ];
    let bmiss = [];
    coders.concat(reviewers).forEach((c) => CODER_AND_REVIEWER_MUST.forEach((m) => {
      if (c.prompt.indexOf(m) === -1) bmiss.push(c.label + " :: " + m);
    }));
    ok("every shared block renders in every coder + gate + check prompt (2.19: assert the ARTIFACT)",
      bmiss.length === 0, bmiss.slice(0, 5).join(" | "));

    // ---- THE MIRROR BLOCK IS A POINTER, NOT A SECOND COPY (EXECUTION-LESSONS 2.40) ------------
    ok("2.40: the MIRROR block POINTS at rule 22 and says it is not restated",
      coders.concat(reviewers).every((c) =>
        c.prompt.indexOf("IT IS AGENT-RULES **RULE 22**, AND IT IS DELIBERATELY NOT RESTATED HERE") !== -1));
    ok("2.40: the MIRROR block does NOT restate the rule's mechanics in the compiler's words",
      coders.concat(reviewers).every((c) =>
        c.prompt.indexOf("tar czf - --exclude=node_modules") === -1 &&
        c.prompt.indexOf("1. PULL, once, at the very start") === -1),
      "a second copy of rule 22 has crept back in");
    ok("2.40: every agent gets a mirror directory UNIQUE TO ITSELF (22(a) as amended)",
      (() => {
        const dirs = coders.concat(reviewers).map((c) => (c.prompt.match(/mirror-[a-z0-9]+-[a-z]+/) || [""])[0]);
        return dirs.every(Boolean) && new Set(dirs).size === dirs.length;
      })(),
      coders.concat(reviewers).map((c) => (c.prompt.match(/mirror-[a-z0-9]+-[a-z]+/) || ["NONE"])[0]).join(" "));

    // ---- THE FINDINGS INBOX (EXECUTION-LESSONS 2.39) ------------------------------------------
    const INBOX = "/opt/hmis/docs/superpowers/plans/reports/plan-08.5-findings-inbox.md";
    ok("2.39: every CODER is told to READ the findings inbox as step 0",
      coders.every((c) => c.prompt.indexOf("STEP 0, BEFORE ANYTHING ELSE - READ THE FINDINGS INBOX") !== -1 &&
                          c.prompt.indexOf(INBOX) !== -1));
    ok("2.39: every GATE and CHECK is told to APPEND later-task findings to it",
      reviewers.every((c) => c.prompt.indexOf("IF YOU FIND SOMETHING A LATER TASK IN THIS PIPELINE MUST KNOW") !== -1 &&
                             c.prompt.indexOf(INBOX) !== -1));
    ok("2.39: the discovery reviewer is told the inbox exists and to read it",
      disc[0].prompt.indexOf("plan-08.5-findings-inbox.md") !== -1);

    // ---- THE FROZEN BLOCK IS GENERATED FROM THE FILES LISTS (EXECUTION-LESSONS 2.25) ----------
    // Assert the GENERATION, not the text: each brief must allow its own files and forbid the
    // others'. A hand-written block cannot satisfy this for six tasks by accident.
    const TASKS_META = [
      { id: "t1", own: "apps/core/src/kernel/db/schema/worker.ts", other: "apps/core/src/kernel/events/dispatcher.ts" },
      { id: "t2", own: "apps/core/src/kernel/worker/scheduler.ts", other: "apps/core/test/alerts.e2e.test.ts" },
      { id: "t3", own: "apps/core/src/kernel/events/dispatcher.ts", other: "apps/core/src/kernel/alerts/consumer.ts" },
      { id: "t4", own: "apps/core/src/kernel/alerts/consumer.ts", other: "apps/web/src/components/alerts-bell.tsx" },
      { id: "t5", own: "apps/web/src/components/alerts-bell.tsx", other: "apps/core/test/worker-runtime.e2e.test.ts" },
      { id: "t6", own: "apps/core/test/worker-runtime.e2e.test.ts", other: "apps/core/src/kernel/db/schema/alerts.ts" },
    ];
    let fmiss = [];
    TASKS_META.forEach((tm) => {
      const c = coders.find((x) => x.label.endsWith(":" + tm.id));
      if (!c) { fmiss.push(tm.id + " :: no coder"); return; }
      const seg = c.prompt.slice(c.prompt.indexOf("YOUR TASK (" + tm.id.toUpperCase() + ") MAY TOUCH"),
                                c.prompt.indexOf("OWNED BY OTHER TASKS IN THIS PIPELINE"));
      if (seg.indexOf(tm.own) === -1) fmiss.push(tm.id + " :: own file not allowed: " + tm.own);
      const rest = c.prompt.slice(c.prompt.indexOf("OWNED BY OTHER TASKS IN THIS PIPELINE"));
      if (rest.indexOf(tm.other) === -1) fmiss.push(tm.id + " :: other task's file not forbidden: " + tm.other);
      if (seg.indexOf(tm.other) !== -1) fmiss.push(tm.id + " :: another task's file is in its ALLOWED list: " + tm.other);
    });
    ok("2.25: the frozen block is GENERATED - each brief allows its own files and forbids the others'",
      fmiss.length === 0, fmiss.slice(0, 4).join(" | "));
    ok("2.25: the frozen block says it was generated and cannot contradict the Files lists",
      coders.every((c) => c.prompt.indexOf("GENERATED from the tasks' own Files lists at compile time") !== -1));

    // ---- 2.34: CROSS-REFERENCES RESOLVE **INTO THE PLAN FILE**, they are not merely present ----
    // This is the check the last compile did not have. Every plan section a brief names is looked
    // up in the plan itself. Audit the RENDERED prompt, never the source file (2.34 corollary (a)):
    // a grep over the source cannot match across the \n inside a JS string literal.
    const PLAN_SECTIONS = [
      "### Task 1: Schema", "### Task 2: The worker process", "### Task 3: Dispatcher correctness",
      "### Task 4: The consumer", "### Task 5: The bell", "### Task 6: The lifecycle e2e",
      "### D1.", "### D3.", "### D4.", "### D5.", "### D6.", "### D7.", "### D8.", "### D9.",
      "### D10.", "### D11.", "### D12.",
      "## Global Constraints", "## Assertion Book", "## Commit messages",
      "## Verify-by-execution flags", "## File Structure",
    ];
    const unresolved = PLAN_SECTIONS.filter((s) => plan.indexOf(s) === -1);
    ok("2.34: every plan section this pipeline cites EXISTS IN THE PLAN FILE",
      unresolved.length === 0, "NOT IN PLAN: " + unresolved.join(" | "));

    // and the per-task design-context citations point at sections that govern that task
    const DC = {
      t1: ["D7", "D4", "D6", "D9"],
      t2: ["D1", "D2", "D3", "D8", "D9"],
      t3: ["D4", "D5", "D3"],
      t4: ["D6", "D4", "D8"],
      t5: ["D6", "D11", "D12"],
      t6: ["D10", "D1"],
    };
    let dcmiss = [];
    Object.keys(DC).forEach((id) => {
      const c = coders.find((x) => x.label.endsWith(":" + id));
      const seg = (c.prompt.match(/Design context:[\s\S]{0,900}/) || [""])[0];
      if (!seg) { dcmiss.push(id + " :: declares NO design context"); return; }
      DC[id].forEach((d) => { if (!new RegExp("\\*\\*" + d + "\\*\\*|\\b" + d + "\\b").test(seg)) dcmiss.push(id + " :: " + d); });
    });
    ok("2.34: every coder brief declares a design context naming the sections that govern IT",
      dcmiss.length === 0, dcmiss.slice(0, 6).join(" | "));

    // the Assertion Book rows each task is told to own must exist in the plan's Book
    const ROWS = { t1: ["L15", "L16"], t2: ["L14"], t3: ["L1", "L2", "L3", "L4", "L5", "L6"],
                   t4: ["L7", "L8", "L9", "L10", "L11", "L12", "L13"], t6: ["L17", "L18"] };
    let rmiss = [];
    Object.keys(ROWS).forEach((id) => {
      const c = coders.find((x) => x.label.endsWith(":" + id));
      ROWS[id].forEach((r) => {
        if (plan.indexOf("| " + r + " |") === -1) rmiss.push("plan has no Book row " + r);
        if (c.prompt.indexOf(r) === -1) rmiss.push(id + " brief never names " + r);
      });
    });
    ok("2.34: every Assertion Book row a brief claims exists IN THE PLAN'S BOOK and is named in that brief",
      rmiss.length === 0, [...new Set(rmiss)].slice(0, 6).join(" | "));

    // ---- TIER DISCIPLINE ----------------------------------------------------------------------
    ok("the two CRITICAL briefs carry the CRITICAL mutant block and not the ROUTINE one",
      ["t3", "t4"].every((id) => {
        const c = coders.find((x) => x.label.endsWith(":" + id));
        return c.prompt.indexOf("YOUR TASK IS **CRITICAL** TIER") !== -1 &&
               c.prompt.indexOf("YOUR TASK IS **ROUTINE** TIER") === -1;
      }));
    ok("the four ROUTINE briefs carry the ROUTINE mutant block and not the CRITICAL one",
      ["t1", "t2", "t5", "t6"].every((id) => {
        const c = coders.find((x) => x.label.endsWith(":" + id));
        return c.prompt.indexOf("YOUR TASK IS **ROUTINE** TIER") !== -1 &&
               c.prompt.indexOf("YOUR TASK IS **CRITICAL** TIER") === -1;
      }));
    ok("2.35: every brief requires ONE KILL PLUS ONE CONTROL and none prescribes three repetitions",
      coders.every((c) => /one\s+kill\s+run\s+plus\s+one\s+CONTROL\s+run/i.test(c.prompt) &&
                          c.prompt.indexOf("3 isolated runs each") === -1 &&
                          c.prompt.indexOf("run 3 times ISOLATED") === -1));
    ok("2.26 + 2.45: every brief says a TYPECHECK death and a TIMEOUT death are both NON-KILLS",
      coders.every((c) => /TYPECHECK/.test(c.prompt) && /TIMEOUT/.test(c.prompt)));
    ok("2.45: every brief carries the `await expect(x).rejects` warning that produces the fake kill",
      coders.every((c) => c.prompt.indexOf("rejects") !== -1 && c.prompt.indexOf("RESOLVE") !== -1));
    ok("3.44: the not-over-broad rule is in every brief AND in the criteria of every task that adds a guard",
      coders.every((c) => c.prompt.indexOf("NOT-OVER-BROAD") !== -1));
    ok("2.13: every fail-first criterion carries the NAMED-COMMIT fallback",
      coders.filter((c) => /FAIL-FIRST, EXECUTED AND QUOTED/.test(c.prompt))
            .every((c) => c.prompt.indexOf("NAMING THAT COMMIT SHA") !== -1 || c.prompt.indexOf("NAMING A COMMIT SHA") !== -1));
    ok("T5 is told fail-first is NOT owed and to say so rather than manufacture one",
      coders.find((c) => c.label.endsWith(":t5")).prompt.indexOf("FAIL-FIRST IS NOT OWED AND THE REPORT SAYS SO PLAINLY") !== -1);
    ok("no per-task test-count target survives in any brief",
      coders.every((c) => c.prompt.indexOf("There is NO per-task test-count target") !== -1 &&
                          !/apps\/core totals = \d+ suites/.test(c.prompt)));

    // ---- THE MIGRATION IS T1'S ALONE ----------------------------------------------------------
    ok("every brief says only T1 generates a migration, and the others NEVER run db:generate",
      coders.every((c) => c.prompt.indexOf("ONLY T1 GENERATES A MIGRATION") !== -1));
    ok("T1 is told to state the rollback BEFORE the generator runs",
      coders.find((c) => c.label.endsWith(":t1")).prompt
        .indexOf("STATE THE ROLLBACK IN YOUR REPORT BEFORE YOU RUN THE GENERATOR") !== -1);

    // ---- D3: NO LOCK-OBSERVATION TEST MAY BE WRITTEN OR DEMANDED (3.21's class) ---------------
    ok("D3: every brief forbids a lock-observation test, and the gates are bound by it too",
      coders.concat(reviewers).every((c) => c.prompt.indexOf("A lock-observation test") !== -1));

    // ---- 2.33: CI IS NOT CHECKABLE FROM THE BUILD HOST ---------------------------------------
    ok("2.33: every reviewer is told CI is unrunnable there and must not fail a task for it",
      reviewers.every((c) => c.prompt.indexOf("CI IS NOT CHECKABLE FROM THE BUILD HOST") !== -1));

    // ---- 3.41: the dated bomb ----------------------------------------------------------------
    ok("3.41: every brief carries the dated bomb and the never-push-in-that-window rule",
      coders.concat(reviewers).every((c) => c.prompt.indexOf("THE DATED BOMB IS LIVE") !== -1 &&
                                            c.prompt.indexOf("NEVER PUSH INSIDE THAT WINDOW") !== -1));

    // ---- per-task content spot checks ---------------------------------------------------------
    const spot = {
      t1: ["RISK TIER: **ROUTINE**, with an OPUS coder and TWO MUTANTS EXPLICITLY OWED",
           "NO FK ANYWHERE IN `schema/worker.ts`",
           "alerts` JOINS THE AUTH STATEMENT",
           "L15's RED IS A LEAKED ROW, NOT AN FK ERROR",
           "never `down`"],
      t2: ["RISK TIER", "registerAllJobs", "L14", "SIGTERM"],
      t3: ["THE ONE DECISION THIS TASK EXISTS TO ENCODE",
           "OPPOSITE of\nbilling's `withIdempotency`",
           "L2 is the mutant that inverts it",
           "M-D1 .. M-D5",
           "ONE WHERE chain"],
      t4: ["THE IDEMPOTENCY UNIT IS THE (EVENT, RECIPIENT) PAIR",
           "ONE PROPERTY ACCESS AWAY",
           "404, not a 403",
           "M-A1 .. M-A6",
           "B must also hold its own working subscription"],
      t5: ["FIVE FILE-STRUCTURE AMENDMENTS",
           "src/locales/en.json",
           "NOT in `lib/i18n.ts`",
           "REPO ROOT",
           "NINE files, not six",
           "CITE THE T6 TEST BY NAME"],
      t6: ["FAIL-FIRST IS THE BOMB MADE DETERMINISTIC",
           "23:46 IST",
           "sandboxed `process`",
           "NO SLEEPS",
           "IS NOT YOURS AND IS NOT A TEST"],
    };
    Object.keys(spot).forEach((id) => {
      const c = coders.find((x) => x.label.endsWith(":" + id));
      spot[id].forEach((n) => ok(id + ' brief contains "' + n.slice(0, 48).replace(/\n/g, " ") + '"',
        c && c.prompt.indexOf(n) !== -1));
    });

    ok("every coder prompt renders its acceptance criteria",
      coders.every((c) => c.prompt.indexOf("Acceptance criteria your work must meet:") !== -1));
    ok("gate prompts carry criteria + coder report + tier + the rebuild-a-mutant instruction",
      gates.every((g) => g.prompt.indexOf("Acceptance criteria:") !== -1 &&
        g.prompt.indexOf('"files_changed":["stub.ts"]') !== -1 &&
        g.prompt.indexOf("Its risk tier is CRITICAL") !== -1 &&
        g.prompt.indexOf("REBUILD AT LEAST ONE MUTANT YOURSELF") !== -1));
    ok("check prompts carry the seven-item checklist and the detached-verify recipe",
      checks.every((c) => c.prompt.indexOf("THE CHECKLIST") !== -1 &&
        c.prompt.indexOf("exit VALUE read from a file") !== -1 &&
        c.prompt.indexOf("NEVER `/tmp`, which is rule 3 and is absolute") !== -1));
    ok("checks are told they are NOT design reviewers (so they do not become a second gate)",
      checks.every((c) => c.prompt.indexOf("You are NOT a design reviewer") !== -1));
    ok("discovery prompt names all seven hunt classes and forbids writes",
      ["DORMANT DEFECTS ARMED BY A LATER TASK", "CONVENTIONS NOTHING TESTS",
       "ASSERTIONS THAT CANNOT DISCRIMINATE", "THE THREE MUTANTS THIS PLAN DOES NOT OWE IN-TASK",
       "CROSS-TASK DUPLICATION AND DRIFT", "ANYTHING THE PLAN PROMISED THAT NOTHING PROVES",
       "THE FIVE FILE-STRUCTURE AMENDMENTS", "read-only apart from your own scratch"]
      .every((m) => disc[0].prompt.indexOf(m) !== -1));
    ok("discovery is told to build M-S1, M-S2 and the bell polling mutant (the three routed to it)",
      disc[0].prompt.indexOf("M-S1") !== -1 && disc[0].prompt.indexOf("M-S2") !== -1 &&
      disc[0].prompt.indexOf("2026-08-21T18:35:00Z") !== -1);
    ok("schemas attached correctly",
      coders.every((c) => c.schema.required.join() === "outcome,files_changed,tests,interpretations") &&
      reviewers.every((g) => g.schema.required.join() === "verdict,violations,corrections,tests") &&
      disc[0].schema.required.join() === "findings,commits_read");

    // ---- the commit message each task is given is the plan's own line -------------------------
    let cmiss = [];
    coders.forEach((c) => {
      const m = c.prompt.match(/COMMIT MESSAGE - EXACTLY THIS[\s\S]{0,400}?\n\n    (.+)\n/);
      if (!m) { cmiss.push(c.label + " :: no commit line rendered"); return; }
      if (plan.indexOf("`" + m[1].trim() + "`") === -1) cmiss.push(c.label + " :: not in the plan's table: " + m[1].trim());
    });
    ok("every task's commit message is the plan's own line from its Commit messages table",
      cmiss.length === 0, cmiss.join(" | "));

    console.log(NL + "  brief sizes:  " + coders.map((c) => c.label + "=" + Math.round(c.prompt.length / 1000) + "k").join(" "));
    console.log("  gate  sizes:  " + gates.map((c) => c.label.replace(/#.*/, "") + "=" + Math.round(c.prompt.length / 1000) + "k").join(" "));
    console.log("  check sizes:  " + checks.map((c) => c.label.replace(/#.*/, "") + "=" + Math.round(c.prompt.length / 1000) + "k").join(" "));
    console.log("  discovery:    " + Math.round(disc[0].prompt.length / 1000) + "k");
    console.log(NL + (fails === 0 ? "PRE-FLIGHT PASSED — " : "PRE-FLIGHT FAILED — ") + fails + " failure(s)");
    ["p085.probe.mjs", "p085.negdup.mjs", "p085.negstr.mjs"].forEach((f) => { try { fs.unlinkSync(f); } catch (e) {} });
    process.exit(fails === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error("DRY RUN THREW: " + (e && e.stack || e));
    ["p085.probe.mjs", "p085.negdup.mjs", "p085.negstr.mjs"].forEach((f) => { try { fs.unlinkSync(f); } catch (e2) {} });
    process.exit(1);
  });
