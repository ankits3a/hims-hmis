// Pre-flight for plan-09-memberships.js — MANDATORY, and every probe ships with a NEGATIVE CONTROL
// that must be OBSERVED TO FAIL in the same run (§2.15/§2.18/§2.22). A probe nobody has watched
// fail is not a probe.
//
// §2.52 rides on all of it: read the exit VALUE, never a pipe's or a wrapper's status — and that
// trap is MOST dangerous on a negative control, where it produces a false FAIL on the instrument
// and gets a working probe "fixed" into a green one. Every `node --check` below is spawnSync with
// `status` read directly; nothing is piped.
//
// THE HEADLINE IS PROBE 5 (§2.54): the script's per-task `files` arrays must EQUAL the plan's §6
// Files lists, parsed from the plan file, in BOTH directions. §2.25 makes the brief's frozen-path
// block GENERATED from those arrays, so a drift between the two copies silently FORBIDS what the
// plan REQUIRES — the coder obeys the brief, correctly, and the work does not happen. That entry
// cost Plan 08.5 its headline deliverable.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(HERE, 'plan-09-memberships.js')
const PLAN = resolve(HERE, '../plans/2026-08-25-phase1-09-memberships-coupons-accrual-ledger.md')

// AGENT-RULES rule 3 forbids ANY write to /tmp on this host — "not even a throwaway sanity check".
// A checker that breaches the rule it is checking for is worse than one that refuses to start.
const TMP = process.env.PREFLIGHT_TMP || join(tmpdir(), 'hmis-preflight-plan-09')
if (TMP === '/tmp' || TMP.startsWith('/tmp/')) {
  console.log('ABORT: PREFLIGHT_TMP resolves under /tmp (' + TMP + ').')
  console.log('AGENT-RULES rule 3 forbids ANY write to /tmp on the build host. Re-run with:')
  console.log('  PREFLIGHT_TMP=/opt/hmis/.preflight-tmp node docs/superpowers/pipelines/plan-09-memberships.preflight.js')
  process.exit(2)
}
mkdirSync(TMP, { recursive: true })

let passed = 0
const failures = []
function ok(label) { passed += 1; console.log('  PASS  ' + label) }
function assert(cond, label) { if (cond) ok(label); else { failures.push(label); console.log('  FAIL  ' + label) } }

// ---------------------------------------------------------------------------------------------
console.log('\nPROBE 0 — the artifacts exist (§2.51: stat it before you grep it)')
// ---------------------------------------------------------------------------------------------
let src = null, plan = null
try { src = readFileSync(SCRIPT, 'utf8') } catch (e) { failures.push('script unreadable: ' + e.message) }
try { plan = readFileSync(PLAN, 'utf8') } catch (e) { failures.push('plan unreadable: ' + e.message) }
assert(src && src.length > 30000, 'script present and non-trivial (' + (src ? src.length : 0) + ' bytes)')
assert(plan && plan.length > 60000, 'plan present and non-trivial (' + (plan ? plan.length : 0) + ' bytes)')
if (!src || !plan) { console.log('\nABORT: cannot proceed without both artifacts.'); process.exit(1) }

// ---------------------------------------------------------------------------------------------
console.log('\nPROBE 1 — module parse (.mjs), with three negative controls')
// ---------------------------------------------------------------------------------------------
const RET = '\nreturn {\n  ran: RUN,'
assert(src.split(RET).length === 2, 'exactly one top-level `return {` to rewrite')
const asModule = src.replace(RET, '\nconst __result = {\n  ran: RUN,')

function nodeCheckExitValue(name, text) {
  const p = join(TMP, name)
  writeFileSync(p, text, 'utf8')
  const r = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' })
  return { value: r.status, stderr: (r.stderr || '').split('\n')[0] }
}

const main = nodeCheckExitValue('probe1.main.mjs', asModule)
assert(main.value === 0, 'module parse of the rewritten script: exit VALUE 0 (got ' + main.value + (main.value ? ' — ' + main.stderr : '') + ')')

const negDup = nodeCheckExitValue('probe1.neg-dup.mjs', asModule + '\nfunction frozenBlock() {}\n')
assert(negDup.value !== 0, 'NEGATIVE CONTROL observed to fail: duplicate `function frozenBlock` rejected under module parsing (exit VALUE ' + negDup.value + ')')

const negStr = nodeCheckExitValue('probe1.neg-str.mjs', asModule.replace("const RULES = '/opt/hmis", "const RULES = '/opt/hmis\n"))
assert(negStr.value !== 0, 'NEGATIVE CONTROL observed to fail: broken string literal rejected (exit VALUE ' + negStr.value + ')')

const rawBroken = nodeCheckExitValue('probe1.raw-broken.js', src.replace("const RULES = '/opt/hmis", "const RULES = '/opt/hmis\n"))
assert(rawBroken.value === 0, 'CONFIRMED INERT (§2.22): `node --check` on the raw .js exits 0 even on a genuine syntax error — a NON-probe here, not a weaker one')

// ---------------------------------------------------------------------------------------------
console.log('\nPROBE 2 — dry run with stubbed agent/parallel/phase/log')
// ---------------------------------------------------------------------------------------------
const spawned = []
const phases = []
const logs = []

const body = src.replace(/^export const meta =/m, 'const meta =')
  .replace(RET, '\nconst __result = {\n  ran: RUN,')
  + '\nreturn { __meta: meta, __TASKS: TASKS, __result, __coderPrompt: coderPrompt, __gatePrompt: gatePrompt, __mechanicalPrompt: mechanicalPrompt, __DISCOVERY_PROMPT: DISCOVERY_PROMPT, __frozenBlock: frozenBlock, __BASELINE: BASELINE }\n'

async function stubAgent(prompt, opts) {
  spawned.push({ prompt, label: opts.label, model: opts.model, agentType: opts.agentType, phase: opts.phase, schema: opts.schema })
  if (opts.label.startsWith('discovery:')) return { summary: 'stub', findings: [] }
  if (opts.label.startsWith('gate:') || opts.label.startsWith('check:')) {
    return { verdict: 'pass', violations: [], corrections: [], findings: [], tests: { ran: 'stub', passed: 1, failed: 0 } }
  }
  return { outcome: 'stub', files_changed: [], tests: 'stub', interpretations: [], commit_sha: 'stub' }
}
const stubParallel = (thunks) => Promise.all(thunks.map(f => f()))
const stubPhase = (t) => { phases.push(t) }
const stubLog = (m) => { logs.push(m) }

const runner = new Function('agent', 'parallel', 'phase', 'log', 'args',
  '"use strict"; return (async () => {' + body + '})()')
const out = await runner(stubAgent, stubParallel, stubPhase, stubLog, undefined)

const TASKS = out.__TASKS
const meta = out.__meta
const R = out.__result

assert(TASKS.length === 8, 'eight tasks (got ' + TASKS.length + ')')
assert(R.stalled === false, 'dry run did not stall')
assert(R.halted.length === 0, 'halted is empty (got [' + R.halted.join(',') + '])')
assert(Object.values(R.tasks).every(r => r.status === 'done'), 'every task reached done')
assert(R.summary === '8/8 done', 'summary is 8/8 done (got ' + R.summary + ')')
assert(R.discovery !== null, 'the discovery reviewer ran')

const wantPhases = ['Wave 1', 'Wave 2', 'Wave 3', 'Wave 4', 'Wave 5', 'Wave 6', 'Wave 7', 'Wave 8', 'Discovery']
assert(JSON.stringify(meta.phases.map(p => p.title)) === JSON.stringify(wantPhases), 'meta.phases titles are exactly the nine expected')
assert(JSON.stringify(phases) === JSON.stringify(wantPhases), 'phase() called with exactly those titles in that order (got ' + phases.join(', ') + ')')

// §2.62 — ONE TASK PER WAVE. No parallel wave, so no two commits can coalesce into one push and
// leave the earlier commit with NO CI run at all.
const byWave = {}
TASKS.forEach(t => { byWave[t.wave] = (byWave[t.wave] || 0) + 1 })
assert(Object.values(byWave).every(n => n === 1), '§2.62: EVERY wave holds exactly ONE task — no parallel wave anywhere')
const WAVE_OF = Object.fromEntries(TASKS.map(t => [t.id, t.wave]))
assert(TASKS.every(t => t.deps.every(d => WAVE_OF[d] < t.wave)), 'every dependency sits in a STRICTLY earlier wave')

// Model routing (EXECUTE-METHOD §3): opus wherever correctness rests on proving an assertion has
// teeth — which is every CRITICAL task. Sonnet for the one ROUTINE task.
const CRIT = TASKS.filter(t => t.tier === 'CRITICAL').map(t => t.id)
const ROUT = TASKS.filter(t => t.tier === 'ROUTINE').map(t => t.id)
assert(CRIT.join(',') === 'T1,T2,T3,T4,T5,T6,T7', 'CRITICAL tier is exactly T1..T7 (got ' + CRIT.join(',') + ')')
assert(ROUT.join(',') === 'T8', 'ROUTINE tier is exactly T8 (got ' + ROUT.join(',') + ')')
assert(TASKS.every(t => (t.tier === 'CRITICAL') === (t.model === 'opus')), 'every CRITICAL task routes to opus and the ROUTINE one does not')
assert(TASKS.every(t => (t.tier === 'CRITICAL') === (t.gate === true)), 'every CRITICAL task carries an opus gate and the ROUTINE one carries none')
assert(spawned.filter(s => s.label.startsWith('gate:')).every(s => s.model === 'opus'), 'every gate is dispatched on opus')
assert(spawned.every(s => s.agentType === 'general-purpose'), 'every agent uses an agentType that EXISTS in the active registry')

// §2.50 — EVERY task has a judge. A task nothing judges cannot fail, so the wave-stall break is
// dead for it — and wave 1 APPLIES A MIGRATION.
const judgedIds = new Set(spawned.filter(s => s.label.startsWith('gate:') || s.label.startsWith('check:')).map(s => s.label.split(':')[1].split('#')[0]))
assert(TASKS.every(t => judgedIds.has(t.id)), '§2.50: EVERY task has a judge — no task can silently pass')
const checkers = spawned.filter(s => s.label.startsWith('check:')).map(s => s.label.split(':')[1])
assert(JSON.stringify(checkers) === JSON.stringify(['T8']), 'mechanical checker on exactly T8 (got ' + checkers.join(',') + ')')
assert(spawned.length === 17, 'seventeen agents on a clean full run: 8 coders + 7 gates + 1 mechanical check + 1 discovery (got ' + spawned.length + ')')

// ---------------------------------------------------------------------------------------------
console.log('\nPROBE 3 — shared blocks in the RENDERED prompt of EVERY spawned agent (§2.32/§2.19)')
// ---------------------------------------------------------------------------------------------
// §2.32: the mechanical-check prompt inherits NONE of what the coder and gate prompts carry, and
// the pre-flight cannot catch that unless it iterates `spawned` rather than `coders.concat(gates)`.
// §2.19: assert MARKER TEXT IN THE RENDERED PROMPT, never `typeof CONST !== 'undefined'`.
const RULES_MARK = 'READ `/opt/hmis/docs/superpowers/AGENT-RULES.md` IN FULL BEFORE YOU TOUCH ANYTHING.'
const EVIDENCE_MARK = 'NEVER take a PIPELINE\'s exit status as a COMMAND\'s verdict'
const RELAY_MARK = '/opt/hmis/.plan-09-relay.md'
const BASELINE_MARK = out.__BASELINE
const CONTEXT_MARK = 'NOTHING FROM THEM MAY EVER REACH A TRACKED FILE'
const F1_MARK = '`apps/core/.env` EXISTS on this host and can NEVER exist in CI'

for (const mark of [RULES_MARK, EVIDENCE_MARK, RELAY_MARK, BASELINE_MARK, F1_MARK]) {
  const missing = spawned.filter(s => !s.prompt.includes(mark)).map(s => s.label)
  assert(missing.length === 0, 'every one of the 17 rendered prompts carries: "' + mark.slice(0, 52) + '…"' + (missing.length ? ' — MISSING from ' + missing.join(', ') : ''))
}
// The context ban must reach every agent that can WRITE or JUDGE a tracked file. The mechanical
// checker gets it through its own checklist item 8 instead, which is asserted separately below.
const ctxMissing = spawned.filter(s => !s.label.startsWith('check:') && !s.prompt.includes(CONTEXT_MARK)).map(s => s.label)
assert(ctxMissing.length === 0, 'the /opt/hmis-context ban reaches every coder, gate and the reviewer' + (ctxMissing.length ? ' — MISSING from ' + ctxMissing.join(', ') : ''))
assert(spawned.filter(s => s.label.startsWith('check:')).every(s => s.prompt.includes('Nothing from `/opt/hmis-context/` appears anywhere in the diff')), 'the mechanical checker carries the context ban as checklist item 8')

// The plan pointer must reach everyone who needs the design law; the checker deliberately does not
// get it (it verifies claims, it does not judge design) and that is asserted, not assumed.
const PLAN_MARK = '/opt/hmis/docs/superpowers/plans/2026-08-25-phase1-09-memberships-coupons-accrual-ledger.md'
const planMissing = spawned.filter(s => !s.label.startsWith('check:') && !s.prompt.includes(PLAN_MARK)).map(s => s.label)
assert(planMissing.length === 0, 'the plan pointer reaches every coder, gate and the reviewer' + (planMissing.length ? ' — MISSING from ' + planMissing.join(', ') : ''))

// Rule 22 and the mirror are STRUCK (v3 §8). Two different properties, and the first draft of this
// probe conflated them into a false FAIL — which is §2.52's warning about negative controls in a
// different costume, and worth keeping as a comment: the RULES pointer deliberately NAMES the
// struck mirror so an agent reading a stale brief elsewhere knows what happened. What must never
// appear is an INSTRUCTION to use one.
const tellsStruck = spawned.filter(s => s.prompt.includes('rule 13 and ALL of rule 22 (the')).map(s => s.label)
assert(tellsStruck.length === spawned.length, 'every rendered prompt TELLS the agent rule 22 is struck (' + tellsStruck.length + '/' + spawned.length + ')')
const mirrorInstructions = spawned.filter(s => /pull the mirror|mirror-<taskid>|scp "\$M|LEAVE YOUR LOCAL MIRROR ALONE/i.test(s.prompt)).map(s => s.label)
assert(mirrorInstructions.length === 0, 'no rendered prompt INSTRUCTS an agent to pull, sync or preserve a mirror' + (mirrorInstructions.length ? ' — found in ' + mirrorInstructions.join(', ') : ''))
// NEGATIVE CONTROL: the instruction detector must actually fire on the struck text.
assert(/pull the mirror|mirror-<taskid>|scp "\$M|LEAVE YOUR LOCAL MIRROR ALONE/i.test('(a) Pull the mirror — ONE command'), 'NEGATIVE CONTROL: the mirror-instruction detector fires on rule 22(a)\'s own struck wording')

// ---------------------------------------------------------------------------------------------
console.log('\nPROBE 4 — the generated frozen block (§2.25)')
// ---------------------------------------------------------------------------------------------
const frozenBlock = out.__frozenBlock
for (const t of TASKS) {
  const fb = frozenBlock(t)
  const ownMissing = t.files.filter(f => !fb.includes('  ' + f + '\n') && !fb.includes('  ' + f))
  assert(ownMissing.length === 0, t.id + ': every path in its Files list appears in its OWN list' + (ownMissing.length ? ' — missing ' + ownMissing.join(', ') : ''))
  const ownFrozen = t.files.filter(f => fb.includes(f + '   (owned by '))
  assert(ownFrozen.length === 0, t.id + ': none of its OWN files appears in its frozen list' + (ownFrozen.length ? ' — ' + ownFrozen.join(', ') : ''))
}
// A file two tasks share must NOT be frozen to either of them. `router.tsx` is shared by four.
const SHARED = 'apps/web/src/router.tsx'
const sharers = TASKS.filter(t => t.files.includes(SHARED)).map(t => t.id)
assert(sharers.length === 4, SHARED + ' is owned by four tasks (got ' + sharers.join(',') + ')')
assert(sharers.every(id => !frozenBlock(TASKS.find(t => t.id === id)).includes(SHARED + '   (owned by ')), 'a shared file is not frozen to any of its owners')
// NEGATIVE CONTROL: a task that does NOT own it must see it frozen.
const nonOwner = TASKS.find(t => !t.files.includes(SHARED))
assert(frozenBlock(nonOwner).includes(SHARED + '   (owned by '), 'NEGATIVE CONTROL: ' + nonOwner.id + ' does not own ' + SHARED + ' and DOES see it frozen')

// ---------------------------------------------------------------------------------------------
console.log('\nPROBE 5 — §2.54: the script\'s `files` arrays EQUAL the plan\'s §6 Files lists, per task, BOTH directions')
// ---------------------------------------------------------------------------------------------
// The plan and this script are two hand-maintained copies of one fact, and §2.25 makes the frozen
// block generated from the script's copy. Nothing else reconciles them.
function planFilesFor(id) {
  const start = plan.indexOf('### ' + id + ' — ')
  if (start === -1) return null
  let end = plan.indexOf('\n### T', start + 5)
  if (end === -1) end = plan.indexOf('\n## 7. Routed', start)
  const section = plan.slice(start, end === -1 ? undefined : end)
  const out = []
  const fenceRe = /\*\*Files — (?:create|modify)\*\*\n```\n([\s\S]*?)```/g
  let m
  while ((m = fenceRe.exec(section)) !== null) {
    for (let line of m[1].split('\n')) {
      line = line.split('(')[0].replace(/\s+$/, '')
      if (line) out.push(line)
    }
  }
  return out
}
let filesOk = true
for (const t of TASKS) {
  const fromPlan = planFilesFor(t.id)
  if (fromPlan === null || fromPlan.length === 0) {
    assert(false, t.id + ': the plan\'s §6 section was found and yielded a non-empty Files list')
    filesOk = false
    continue
  }
  const a = [...new Set(t.files)].sort()
  const b = [...new Set(fromPlan)].sort()
  const onlyScript = a.filter(x => !b.includes(x))
  const onlyPlan = b.filter(x => !a.includes(x))
  const same = onlyScript.length === 0 && onlyPlan.length === 0
  if (!same) filesOk = false
  assert(same, t.id + ': script files == plan files (' + a.length + ' vs ' + b.length + ')'
    + (onlyScript.length ? ' | ONLY IN SCRIPT: ' + onlyScript.join(', ') : '')
    + (onlyPlan.length ? ' | ONLY IN PLAN: ' + onlyPlan.join(', ') : ''))
}
// NEGATIVE CONTROL: the comparator must actually detect a difference.
{
  const a = ['x.ts', 'y.ts'], b = ['x.ts', 'z.ts']
  const detects = a.filter(x => !b.includes(x)).length > 0 && b.filter(x => !a.includes(x)).length > 0
  assert(detects, 'NEGATIVE CONTROL: the comparator detects a planted one-file difference in both directions')
}
// And the parser must THROW rather than return empty on a shape it does not recognise (§2.49) —
// an empty list agrees with every files array ever written.
assert(planFilesFor('T99') === null, 'NEGATIVE CONTROL: the plan parser returns null for a task the plan does not have (never a silent [])')

// ---------------------------------------------------------------------------------------------
console.log('\nPROBE 6 — a commit message per task, present in the RENDERED brief (§3 sweep item 6)')
// ---------------------------------------------------------------------------------------------
for (const t of TASKS) {
  assert(typeof t.commit === 'string' && t.commit.length > 20, t.id + ': carries a commit message')
  assert(plan.includes('`' + t.commit + '`'), t.id + ': its commit message appears VERBATIM in the plan')
  const coder = spawned.find(s => s.label.endsWith(':' + t.id) && !s.label.startsWith('gate:') && !s.label.startsWith('check:'))
  assert(coder && coder.prompt.includes(t.commit), t.id + ': the commit message reaches the RENDERED coder prompt')
}

// ---------------------------------------------------------------------------------------------
console.log('\nPROBE 7 — the subset-run mode (args.tasks), because this phase ships as two pipelines')
// ---------------------------------------------------------------------------------------------
{
  const spawnedB = []
  const phasesB = []
  async function stubAgentB(prompt, opts) {
    spawnedB.push({ label: opts.label })
    if (opts.label.startsWith('discovery:')) return { summary: 'stub', findings: [] }
    if (opts.label.startsWith('gate:') || opts.label.startsWith('check:')) return { verdict: 'pass', violations: [], corrections: [], findings: [], tests: { ran: 'stub', passed: 1, failed: 0 } }
    return { outcome: 'stub', files_changed: [], tests: 'stub', interpretations: [], commit_sha: 'stub' }
  }
  const runnerB = new Function('agent', 'parallel', 'phase', 'log', 'args',
    '"use strict"; return (async () => {' + body + '})()')
  const outB = await runnerB(stubAgentB, stubParallel, (t) => phasesB.push(t), stubLog,
    { tasks: ['T1', 'T2', 'T3', 'T4'], discovery: false })
  assert(outB.__result.summary === '4/4 done', 'subset run T1-T4: summary is 4/4 done (got ' + outB.__result.summary + ')')
  assert(outB.__result.discovery === null, 'subset run with discovery:false does NOT spawn the reviewer')
  assert(JSON.stringify(phasesB) === JSON.stringify(['Wave 1', 'Wave 2', 'Wave 3', 'Wave 4']), 'subset run enters only its own four waves')
  assert(spawnedB.length === 8, 'subset run T1-T4 spawns 8 agents: 4 coders + 4 gates (got ' + spawnedB.length + ')')
  // The frozen block must STILL name T5-T8's files, or a pipeline-A task could clobber them.
  const t1 = outB.__TASKS.find(t => t.id === 'T1')
  assert(outB.__frozenBlock(t1).includes('apps/core/src/modules/partners/accrual.ts   (owned by T6)'), 'in a subset run the frozen block still names files owned by tasks NOT in this run')

  const spawnedC = []
  const runnerC = new Function('agent', 'parallel', 'phase', 'log', 'args',
    '"use strict"; return (async () => {' + body + '})()')
  const outC = await runnerC(async (p, o) => { spawnedC.push({ label: o.label }); if (o.label.startsWith('discovery:')) return { summary: 's', findings: [] }; if (o.label.startsWith('gate:') || o.label.startsWith('check:')) return { verdict: 'pass', violations: [], corrections: [], findings: [], tests: { ran: 's', passed: 1, failed: 0 } }; return { outcome: 's', files_changed: [], tests: 's', interpretations: [], commit_sha: 's' } },
    stubParallel, () => {}, stubLog, { tasks: ['T5', 'T6', 'T7', 'T8'] })
  assert(outC.__result.summary === '4/4 done', 'subset run T5-T8 does NOT stall on deps satisfied by an earlier pipeline (got ' + outC.__result.summary + ')')
  assert(outC.__result.discovery !== null, 'subset run T5-T8 DOES spawn the reviewer (discovery defaults on)')
  assert(spawnedC.length === 9, 'subset run T5-T8 spawns 9 agents: 4 coders + 3 gates + 1 check + 1 discovery (got ' + spawnedC.length + ')')
}

// ---------------------------------------------------------------------------------------------
console.log('\nPROBE 8 — the ladder never promotes on infrastructure (§2.1)')
// ---------------------------------------------------------------------------------------------
{
  let coderCalls = 0
  const labels = []
  async function flakyAgent(prompt, opts) {
    labels.push(opts.label)
    if (opts.label.startsWith('discovery:')) return { summary: 'stub', findings: [] }
    if (opts.label.startsWith('gate:') || opts.label.startsWith('check:')) return { verdict: 'pass', violations: [], corrections: [], findings: [], tests: { ran: 'stub', passed: 1, failed: 0 } }
    coderCalls += 1
    if (coderCalls === 1) return null // one infrastructure death on T1's first coder
    return { outcome: 'stub', files_changed: [], tests: 'stub', interpretations: [], commit_sha: 'stub' }
  }
  const runnerD = new Function('agent', 'parallel', 'phase', 'log', 'args',
    '"use strict"; return (async () => {' + body + '})()')
  const outD = await runnerD(flakyAgent, stubParallel, () => {}, stubLog, { tasks: ['T1'], discovery: false })
  assert(outD.__result.summary === '1/1 done', 'a dead coder does not fail the task (got ' + outD.__result.summary + ')')
  const t1Coders = labels.filter(l => l.includes('T1') && !l.startsWith('gate:'))
  assert(t1Coders.length === 2 && t1Coders[0].startsWith('opus:') && t1Coders[1].startsWith('opus:'), 'the retry after an infra death stays on the SAME rung and the SAME model (got ' + t1Coders.join(', ') + ')')
  assert(!t1Coders.some(l => l.startsWith('escalate:')), 'an infrastructure death never promotes the tier')
}

// ---------------------------------------------------------------------------------------------
console.log('\n' + '='.repeat(90))
if (failures.length === 0) {
  console.log('PRE-FLIGHT PASSED — ' + passed + ' assertions, 0 failures.')
  console.log('Run with: Workflow({ scriptPath: "' + SCRIPT + '", args: { tasks: [...], discovery: true|false } })')
  process.exit(0)
}
console.log('PRE-FLIGHT FAILED — ' + failures.length + ' of ' + (passed + failures.length) + ':')
for (const f of failures) console.log('  - ' + f)
process.exit(1)
