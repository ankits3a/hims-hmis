#!/usr/bin/env node
/**
 * token-audit.js — WHERE THE TOKENS WENT, and whether they bought anything.
 *
 * WHY THIS EXISTS. Plan 09 cost ~7M tokens for eight tasks. The post-hoc analysis found that
 * OUTPUT — every line of code, every mutant, every test — was 2.08M, and CONTEXT RE-READ was
 * 871M: 420x the output, at an average of 374,458 tokens carried into every single tool call.
 * An agent pays for its whole context on every call, so cost is `turns x context`, and neither
 * term was ever measured while a phase ran. This script measures both.
 *
 * IT IS A SCRIPT AND NOT A CHECKLIST, per EXECUTE-METHOD-V3 §4: a recurring check enters the
 * method only as something you run and read a verdict from. It costs ZERO model tokens — which
 * matters, because an audit that is itself expensive is an audit nobody will run twice.
 *
 * ITS OUTPUT IS DELIBERATELY TINY. Roughly 40 lines. The model reads the verdict, never the
 * journals — reading 900MB of transcript to find out that reading is expensive would be the
 * defect it exists to catch.
 *
 *   node docs/superpowers/pipelines/token-audit.js [--since YYYY-MM-DD] [--json]
 *
 * Exit value: 0 always. It reports; it never gates. A gate here would stop a phase closing over
 * a number nobody has agreed on yet.
 */
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const sinceArg = args.includes("--since") ? args[args.indexOf("--since") + 1] : null;
const since = sinceArg ? new Date(sinceArg + "T00:00:00Z").getTime() : 0;

const PROJECTS = "/root/.claude/projects";
const BASELINES = path.resolve(__dirname, "token-baselines.json");

/** Every workflow-run directory under every session of this project. */
function runDirs() {
  const out = [];
  let projects = [];
  try { projects = fs.readdirSync(PROJECTS); } catch { return out; }
  for (const proj of projects) {
    if (!proj.includes("hmis")) continue;
    const sessions = path.join(PROJECTS, proj);
    let entries = [];
    try { entries = fs.readdirSync(sessions); } catch { continue; }
    for (const s of entries) {
      const wf = path.join(sessions, s, "subagents", "workflows");
      let runs = [];
      try { runs = fs.readdirSync(wf); } catch { continue; }
      for (const r of runs) out.push(path.join(wf, r));
    }
  }
  return out;
}

/** One agent transcript -> the four numbers that decide whether it was worth it. */
function readAgent(file) {
  let out = 0, cache = 0, calls = 0, mtime = 0;
  const tools = Object.create(null);
  try { mtime = fs.statSync(file).mtimeMs; } catch { return null; }
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return null; }
  for (const line of text.split("\n")) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o?.type !== "assistant" || typeof o.message !== "object" || o.message === null) continue;
    const u = o.message.usage || {};
    out += u.output_tokens || 0;
    cache += (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.input_tokens || 0);
    for (const c of o.message.content || []) {
      if (c && c.type === "tool_use") { calls += 1; tools[c.name] = (tools[c.name] || 0) + 1; }
    }
  }
  return { out, cache, calls, tools, mtime };
}

const runs = [];
for (const dir of runDirs()) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.startsWith("agent-") && f.endsWith(".jsonl")); } catch { continue; }
  let out = 0, cache = 0, calls = 0, agents = 0, newest = 0;
  const tools = Object.create(null);
  for (const f of files) {
    const a = readAgent(path.join(dir, f));
    if (!a) continue;
    if (a.mtime < since) continue;
    agents += 1; out += a.out; cache += a.cache; calls += a.calls;
    newest = Math.max(newest, a.mtime);
    for (const [k, v] of Object.entries(a.tools)) tools[k] = (tools[k] || 0) + v;
  }
  if (agents === 0) continue;
  runs.push({ run: path.basename(dir), agents, out, cache, calls, tools, newest });
}
runs.sort((a, b) => a.newest - b.newest);

const T = runs.reduce((a, r) => ({
  agents: a.agents + r.agents, out: a.out + r.out, cache: a.cache + r.cache, calls: a.calls + r.calls,
}), { agents: 0, out: 0, cache: 0, calls: 0 });

const perCall = T.calls ? Math.round(T.cache / T.calls) : 0;
const ratio = T.out ? T.cache / T.out : 0;

let baselines = [];
try { baselines = JSON.parse(fs.readFileSync(BASELINES, "utf8")).phases || []; } catch { /* first run */ }

if (asJson) {
  console.log(JSON.stringify({ runs, total: T, perCall, ratio, baselines }, null, 2));
  process.exit(0);
}

const n = (x) => x.toLocaleString("en-US");
console.log("TOKEN AUDIT — where they went" + (sinceArg ? ` (since ${sinceArg})` : ""));
console.log("=".repeat(64));
if (runs.length === 0) {
  console.log("No workflow agent transcripts found in range.");
  console.log("A phase run entirely in-session (the LIGHT lane) leaves none — that is the point:");
  console.log("its cost is main-session tokens, which only the owner's /cost can see.");
  process.exit(0);
}
for (const r of runs) {
  const pc = r.calls ? Math.round(r.cache / r.calls) : 0;
  console.log(`${r.run.slice(0, 18).padEnd(19)} ${String(r.agents).padStart(3)} agents  ` +
    `${String(n(r.calls)).padStart(6)} calls  out ${String(n(r.out)).padStart(10)}  ` +
    `ctx ${String(n(r.cache)).padStart(13)}  ${n(pc).padStart(8)}/call`);
}
console.log("-".repeat(64));
console.log(`TOTAL${" ".repeat(15)}${String(T.agents).padStart(3)} agents  ${String(n(T.calls)).padStart(6)} calls  ` +
  `out ${String(n(T.out)).padStart(10)}  ctx ${String(n(T.cache)).padStart(13)}  ${n(perCall).padStart(8)}/call`);
console.log("");
console.log(`THE RATIO: context re-read is ${ratio.toFixed(0)}x the output produced.`);
console.log(`COST MODEL: turns x context = ${n(T.calls)} x ${n(perCall)} = ${n(T.calls * perCall)}`);
console.log("");
const mix = Object.entries(runs.reduce((a, r) => {
  for (const [k, v] of Object.entries(r.tools)) a[k] = (a[k] || 0) + v;
  return a;
}, {})).sort((a, b) => b[1] - a[1]).slice(0, 5);
console.log("TURN MIX (what the calls were): " + mix.map(([k, v]) => `${k} ${v}`).join(" · "));
console.log("");
if (baselines.length) {
  console.log("AGAINST THE RECORD:");
  for (const b of baselines) {
    const per = b.tasks ? Math.round(b.subagentTokens / b.tasks) : 0;
    console.log(`  ${String(b.phase).padEnd(8)} ${String(b.lane).padEnd(6)} ${String(b.tasks).padStart(2)} tasks  ` +
      `${String(b.agents).padStart(3)} agents  ${n(b.subagentTokens).padStart(11)}  ${n(per).padStart(9)}/task` +
      (b.note ? `  — ${b.note}` : ""));
  }
  console.log("");
}
console.log("READ THIS NEXT: the two terms are independent, and BOTH are attackable.");
console.log("  · context/call is set by what each agent was told to READ. Measure it:");
console.log("      wc -c the files a brief points at. A ledger or a whole phase doc is 30-80k,");
console.log("      re-billed on EVERY call. Cite entries by number instead of pointing at files.");
console.log("  · turns are set by lane and by how agents read. 90%+ Bash means file reading");
console.log("      through cat/sed/grep, one billed turn each.");
console.log("  · agents multiply BOTH. A LIGHT phase pays main-session tokens instead — which");
console.log("      this script cannot see, so compare lanes only against the owner's /cost.");
