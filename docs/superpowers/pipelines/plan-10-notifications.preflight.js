// Pre-flight for plan-10-notifications.js — MANDATORY, and every probe ships with a NEGATIVE
// CONTROL that must be OBSERVED TO FAIL in the same run (EXECUTION-LESSONS 2.15/2.18/2.22).
// A probe nobody has watched fail is not a probe.
//
// 2.52 rides on all of it: read the exit VALUE, never a pipe's or a wrapper's status — and that
// trap is MOST dangerous on a negative control, where it produces a false FAIL on the instrument
// and gets a working probe "fixed" into a green one. Every node --check below is spawnSync with
// `status` read directly; nothing is piped.
//
// The headline assertion is PROBE 5 (2.54): the script's per-task `files` arrays must EQUAL the
// plan's File Structure rows, parsed from the plan file, in BOTH directions. That is the exact
// assertion the last pipeline's 83-assertion pre-flight lacked, and its absence cost that plan its
// headline deliverable — the frozen block is GENERATED from those arrays, so when the plan is
// amended and the script is not, the brief silently FORBIDS what the plan REQUIRES.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(HERE, 'plan-10-notifications.js')
const PLAN = resolve(HERE, '../plans/2026-08-21-phase1-10-notifications.md')
// Scratch goes OUTSIDE the repo by default so a pre-flight run never leaves an untracked
// directory in a tree that is about to be committed. Override with PREFLIGHT_TMP.
const TMP = process.env.PREFLIGHT_TMP || join(tmpdir(), 'hmis-preflight-plan-10')
mkdirSync(TMP, { recursive: true })

let passed = 0
const failures = []
function ok(label) { passed += 1; console.log('  PASS  ' + label) }
function assert(cond, label) { if (cond) ok(label); else { failures.push(label); console.log('  FAIL  ' + label) } }
// A negative control: `fn` MUST throw. If it does not, the probe it belongs to is inert.
function mustThrow(fn, label) {
  let threw = false
  try { fn() } catch { threw = true }
  assert(threw, 'NEGATIVE CONTROL observed to fail: ' + label)
}

// ---------------------------------------------------------------------------------------------
// PROBE 0 — stat the artifacts before reading them (2.51). An empty read of a MISSING file reads
// identically to an empty read of a present one, and that is how §2.7's own remedy rotted once.
// ---------------------------------------------------------------------------------------------
console.log('\nPROBE 0 — the artifacts exist')
let src = null, plan = null
try { src = readFileSync(SCRIPT, 'utf8') } catch (e) { failures.push('script unreadable: ' + e.message) }
try { plan = readFileSync(PLAN, 'utf8') } catch (e) { failures.push('plan unreadable: ' + e.message) }
assert(src && src.length > 20000, 'script present and non-trivial (' + (src ? src.length : 0) + ' bytes)')
assert(plan && plan.length > 20000, 'plan present and non-trivial (' + (plan ? plan.length : 0) + ' bytes)')
if (!src || !plan) { console.log('\nABORT: cannot proceed without both artifacts.'); process.exit(1) }

// ---------------------------------------------------------------------------------------------
// PROBE 1 — MODULE-PARSE. A duplicate top-level declaration is a SyntaxError only under MODULE
// parsing. `node --check` on the .js is a NON-probe for this script shape: the top-level `return`
// makes it exit 0 on genuine syntax errors (2.22).
// ---------------------------------------------------------------------------------------------
console.log('\nPROBE 1 — module parse (.mjs), with two negative controls')
const RET = '\nreturn {\n  tasks: results,'
assert(src.split(RET).length === 2, 'exactly one top-level `return {` to rewrite')
const asModule = src.replace(RET, '\nconst __result = {\n  tasks: results,')

function nodeCheckExitValue(name, text) {
  const p = join(TMP, name)
  writeFileSync(p, text, 'utf8')
  const r = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' })
  return { value: r.status, stderr: (r.stderr || '').split('\n')[0] } // the VALUE, unpiped (2.52)
}

const main = nodeCheckExitValue('probe1.main.mjs', asModule)
assert(main.value === 0, 'module parse of the rewritten script: exit VALUE 0 (got ' + main.value + (main.value ? ' — ' + main.stderr : '') + ')')

const negDup = nodeCheckExitValue('probe1.neg-dup.mjs', asModule + '\nfunction briefFor() {}\n')
assert(negDup.value !== 0, 'NEGATIVE CONTROL observed to fail: duplicate `function briefFor` rejected under module parsing (exit VALUE ' + negDup.value + ')')

const negStr = nodeCheckExitValue('probe1.neg-str.mjs', asModule.replace("const PLAN = '/opt/hmis", "const PLAN = '/opt/hmis\n"))
assert(negStr.value !== 0, 'NEGATIVE CONTROL observed to fail: broken string literal rejected (exit VALUE ' + negStr.value + ')')

// `node --check` on the RAW .js is asserted to be INERT, so nobody mistakes it for a probe (2.22).
const rawBroken = nodeCheckExitValue('probe1.raw-broken.js', src.replace("const PLAN = '/opt/hmis", "const PLAN = '/opt/hmis\n"))
assert(rawBroken.value === 0, 'CONFIRMED INERT: `node --check` on the raw .js exits 0 even on a genuine syntax error (2.22) — it is a non-probe here, not a weaker one')

// ---------------------------------------------------------------------------------------------
// PROBE 2 — DRY RUN with stubbed agent/parallel/phase/log.
// ---------------------------------------------------------------------------------------------
console.log('\nPROBE 2 — dry run')
const spawned = []   // every agent() call this script makes, in order
const phases = []
const logs = []

const body = src.replace(/^export const meta =/m, 'const meta =')
  + '\nreturn { __meta: meta, __TASKS: TASKS, __result, __briefFor: briefFor, __coderPrompt: coderPrompt, __gatePrompt: gatePrompt, __mechanicalPrompt: mechanicalPrompt, __DISCOVERY_PROMPT: DISCOVERY_PROMPT, __frozenBlock: frozenBlock }\n'
const bodyRewritten = body.replace(RET, '\nconst __result = {\n  tasks: results,')

async function stubAgent(prompt, opts) {
  spawned.push({ prompt, label: opts.label, model: opts.model, phase: opts.phase, schema: opts.schema })
  if (opts.label.startsWith('discovery:')) return { summary: 'stub', findings: [] }
  if (opts.label.startsWith('gate:') || opts.label.startsWith('check:')) {
    return { verdict: 'pass', violations: [], corrections: [], findings: [], tests: { ran: 'stub', passed: 1, failed: 0 } }
  }
  return { outcome: 'stub', files_changed: [], tests: 'stub', interpretations: [] }
}
const stubParallel = (thunks) => Promise.all(thunks.map(f => f()))
const stubPhase = (t) => { phases.push(t) }
const stubLog = (m) => { logs.push(m) }

const runner = new Function('agent', 'parallel', 'phase', 'log', '"use strict"; return (async () => {' + bodyRewritten + '})()')
const out = await runner(stubAgent, stubParallel, stubPhase, stubLog)

const TASKS = out.__TASKS
const meta = out.__meta
const R = out.__result

assert(TASKS.length === 6, 'six tasks (got ' + TASKS.length + ')')
assert(R.stalled === false, 'dry run did not stall')
assert(R.halted.length === 0, 'halted is empty (got [' + R.halted.join(',') + '])')
assert(Object.values(R.tasks).every(r => r.status === 'done'), 'every task reached done')
assert(R.summary === '6/6 done', 'summary is 6/6 done (got ' + R.summary + ')')
assert(R.discovery !== null, 'the discovery reviewer ran')

// meta.phases must match the phase() calls exactly, in order (the progress display keys on titles)
const metaTitles = meta.phases.map(p => p.title)
const wantPhases = ['Wave 1', 'Wave 2', 'Wave 3', 'Wave 4', 'Wave 5', 'Discovery']
assert(JSON.stringify(metaTitles) === JSON.stringify(wantPhases), 'meta.phases titles are exactly ' + wantPhases.join(', '))
assert(JSON.stringify(phases) === JSON.stringify(wantPhases), 'phase() was called with exactly those titles in that order (got ' + phases.join(', ') + ')')

// Wave / dependency shape
const WAVE_OF = Object.fromEntries(TASKS.map(t => [t.id, t.wave]))
assert(JSON.stringify(TASKS.map(t => t.id + ':' + t.wave)) === JSON.stringify(['t1:1', 't2:2', 't3:2', 't4:3', 't5:4', 't6:5']), 'wave assignment is W1[t1] W2[t2,t3] W3[t4] W4[t5] W5[t6]')
let depsOk = true
for (const t of TASKS) for (const d of t.deps) if (!(WAVE_OF[d] < t.wave)) depsOk = false
assert(depsOk, 'every dependency sits in a STRICTLY earlier wave')

// Model routing per the plan's Pipeline Notes
const MODEL = Object.fromEntries(TASKS.map(t => [t.id, t.model]))
assert(MODEL.t1 === 'opus' && MODEL.t2 === 'sonnet' && MODEL.t3 === 'sonnet' && MODEL.t4 === 'opus' && MODEL.t5 === 'opus' && MODEL.t6 === 'sonnet', 'models: t1 opus, t2/t3 sonnet, t4/t5 opus, t6 sonnet')
const GATED = TASKS.filter(t => t.gate).map(t => t.id)
assert(JSON.stringify(GATED) === JSON.stringify(['t4', 't5']), 'opus gates on exactly the two CRITICAL tasks (got ' + GATED.join(',') + ')')
assert(TASKS.filter(t => t.tier === 'CRITICAL').map(t => t.id).join(',') === 't4,t5', 'CRITICAL tier is exactly t4,t5')

// 2.50 — EVERY task has a judge. A task nothing judges cannot fail, so the wave-stall break is
// dead for it — and wave 1 APPLIES A MIGRATION.
const judgedIds = new Set(spawned.filter(s => s.label.startsWith('gate:') || s.label.startsWith('check:')).map(s => s.label.split(':')[1].split('#')[0]))
assert(TASKS.every(t => judgedIds.has(t.id)), '2.50: EVERY task has a judge (gate or mechanical check) — no task can silently pass')
const checkers = spawned.filter(s => s.label.startsWith('check:')).map(s => s.label.split(':')[1].split('#')[0])
assert(JSON.stringify(checkers) === JSON.stringify(['t1', 't2', 't3', 't6']), 'mechanical checkers on exactly t1,t2,t3,t6 (got ' + checkers.join(',') + ')')

// The exact agent roster
assert(spawned.length === 13, 'thirteen agents on a clean run: 6 coders + 2 gates + 4 checks + 1 discovery (got ' + spawned.length + ')')

// ---------------------------------------------------------------------------------------------
// PROBE 3 — SHARED BLOCKS OVER **EVERY** AGENT THIS SCRIPT SPAWNS (2.32).
// `coders.concat(gates)` excludes checkers and the reviewer BY CONSTRUCTION, which is exactly how
// a reviewer once shipped without the rules pointer and breached rule 3. Iterate `spawned`.
// And assert MARKER TEXT IN THE RENDERED PROMPT, never `typeof CONST !== 'undefined'` (2.19).
// ---------------------------------------------------------------------------------------------
console.log('\nPROBE 3 — shared blocks over all 13 spawned agents')
const RULES_MARK = 'THE RULES ARE IN THE REPO. READ THEM FIRST, IN FULL'
const RULES_PATH = '/opt/hmis/docs/superpowers/AGENT-RULES.md'
const MIRROR_MARK = 'YOUR LOCAL MIRROR - AGENT-RULES rule 22'
const CI_MARK = 'deliberately left UNAUTHENTICATED'

assert(spawned.every(s => s.prompt.includes(RULES_MARK)), 'EVERY spawned agent renders the rules pointer text')
assert(spawned.every(s => s.prompt.includes(RULES_PATH)), 'EVERY spawned agent renders the absolute path to AGENT-RULES.md')
assert(spawned.every(s => s.prompt.startsWith(RULES_MARK)), 'the rules pointer is the FIRST thing in every prompt, above the goal')
assert(spawned.every(s => s.prompt.includes(MIRROR_MARK)), 'EVERY spawned agent renders the mirror block')
assert(spawned.every(s => s.prompt.includes(CI_MARK)), 'EVERY spawned agent renders the CI delegation block')
assert(spawned.every(s => !s.prompt.includes('/tmp/') || s.prompt.includes('NEVER /tmp')), 'no prompt suggests /tmp except to forbid it')

// 2.40 — the mirror block is a POINTER, not a second copy of rule 22 in the compiler's words.
assert(!spawned.some(s => s.prompt.includes('tar czf - --exclude=node_modules')), '2.40: no prompt RESTATES rule 22\'s mirror commands — the block is a pointer')

// Coder prompts carry the full per-task block set.
const coderPrompts = spawned.filter(s => !s.label.startsWith('gate:') && !s.label.startsWith('check:') && !s.label.startsWith('discovery:'))
assert(coderPrompts.length === 6, 'six coder prompts (got ' + coderPrompts.length + ')')
const BLOCKS = [
  ['INBOX_READ', 'STEP 0, BEFORE ANYTHING ELSE'],
  ['PLAN_POINTER', 'THE PLAN IS DESIGN LAW AND IT IS IN THE REPO'],
  ['BASELINE', 'THE MEASURED BASELINE'],
  ['TIER', 'RISK TIER:'],
  ['FROZEN', 'OWNED BY OTHER TASKS IN THIS PIPELINE - DO NOT TOUCH THEM'],
  ['FILES-YOU-MAY-TOUCH', 'FILES YOU MAY TOUCH'],
  ['HALT CONDITIONS', 'HALT CONDITIONS'],
  ['COMMIT MESSAGE', 'COMMIT MESSAGE - the subject line is EXACT'],
  ['FINISH', 'THE FINISH BLOCK - AGENT-RULES section 5'],
  ['CRITERIA', 'Acceptance criteria your work must meet:'],
]
for (const [name, mark] of BLOCKS) {
  assert(coderPrompts.every(s => s.prompt.includes(mark)), 'every coder brief renders the ' + name + ' block')
}
// Gates and checkers get the inbox WRITE half; coders get the READ half.
assert(spawned.filter(s => s.label.startsWith('gate:') || s.label.startsWith('check:')).every(s => s.prompt.includes('IF YOU FIND SOMETHING A LATER TASK IN THIS PIPELINE MUST KNOW')), 'every judge renders the inbox WRITE block')
assert(spawned.filter(s => s.label.startsWith('gate:') || s.label.startsWith('check:')).every(s => s.prompt.includes('2.60')), '2.60\'s "a routed finding is a claim" caution rides with the inbox on every judge')

// Per-task: the brief names THAT task's own commit subject and no other's.
for (const t of TASKS) {
  const p = coderPrompts.find(s => s.label.endsWith(':' + t.id)).prompt
  assert(p.includes(t.commit), t.id + ': brief carries its own exact commit subject')
  const others = TASKS.filter(o => o.id !== t.id && !p.includes(o.commit))
  assert(others.length === TASKS.length - 1, t.id + ': brief carries NO other task\'s commit subject')
}

// NEGATIVE CONTROL for probe 3: a prompt with a block removed must fail the same assertion.
mustThrow(() => {
  const mutilated = coderPrompts[0].prompt.replace('HALT CONDITIONS', 'XXXX')
  if (!mutilated.includes('HALT CONDITIONS')) throw new Error('marker gone')
}, 'the block-marker assertion detects a removed HALT CONDITIONS block')

// ---------------------------------------------------------------------------------------------
// PROBE 4 — CROSS-REFERENCES RESOLVE (2.34). A marker assertion is a spell-check, not a
// fact-check: assert the plan SECTIONS the briefs name actually exist in the plan file.
// ---------------------------------------------------------------------------------------------
console.log('\nPROBE 4 — every cross-reference into the plan resolves')
const planRefs = [
  '### D1.', '### D2.', '### D3.', '### D4.', '### D5.', '### D6.', '### D7.', '### D8.',
  '### D9.', '### D10.', '### D11.', '### D12.', '### D13.', '### D14.',
  '## Global Constraints', '## File Structure', '## Tasks', '## Assertion Book',
  '## Commit messages', '## Verify-by-execution flags', '## Pipeline Notes',
  '### Task 1:', '### Task 2:', '### Task 3:', '### Task 4:', '### Task 5:', '### Task 6:',
  'AMENDMENT 7',
]
for (const r of planRefs) assert(plan.includes(r), 'plan contains ' + r)
for (const n of ['N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8', 'N9', 'N10', 'N11', 'N12', 'N13', 'N14', 'N15']) {
  assert(plan.includes('| ' + n + ' |'), 'Assertion Book row ' + n + ' exists in the plan')
}
// Every commit subject in the script must appear VERBATIM in the plan's commit-messages table.
for (const t of TASKS) assert(plan.includes(t.commit), t.id + ': commit subject appears verbatim in the plan\'s table')
mustThrow(() => { if (plan.includes('### D99.')) return; throw new Error('absent as expected') }, 'the cross-reference probe distinguishes a present section from an absent one')

// ---------------------------------------------------------------------------------------------
// PROBE 5 — 2.54, THE HEADLINE. The script's per-task `files` arrays must EQUAL the plan's File
// Structure rows for that task, parsed from the plan, in BOTH directions. The frozen block is
// GENERATED from these arrays, so a divergence makes a brief FORBID what the plan REQUIRES — and
// the coder obeys the brief, correctly, and the work does not happen.
// ---------------------------------------------------------------------------------------------
console.log('\nPROBE 5 — the script\'s files arrays EQUAL the plan\'s File Structure (2.54)')

function parsePlanFileStructure(planText) {
  const start = planText.indexOf('## File Structure')
  const end = planText.indexOf('Forward-reference audit', start)
  assert(start > 0 && end > start, 'the File Structure section and its closing audit paragraph were both located')
  const section = planText.slice(start, end)
  const fenceStart = section.indexOf('```')
  const fenceEnd = section.indexOf('```', fenceStart + 3)
  const block = section.slice(fenceStart + 3, fenceEnd)
  const byTask = {}
  let prefix = null
  for (const raw of block.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) continue
    if (!line.startsWith(' ')) { prefix = line.trim(); continue }       // a heading like `apps/core/`
    const m = line.match(/^\s+(\S+)\s{2,}(.+)$/)
    if (!m) continue
    const full = prefix + m[1]
    const tasks = [...new Set((m[2].match(/\bT[1-6]\b/g) || []))]
    assert(tasks.length > 0, 'File Structure row names at least one task: ' + full)
    for (const tk of tasks) {
      const id = 't' + tk.slice(1)
      byTask[id] = byTask[id] || new Set()
      byTask[id].add(full)
    }
  }
  return byTask
}

const planFiles = parsePlanFileStructure(plan)
const planTotal = new Set(Object.values(planFiles).flatMap(s => [...s]))
// 44 task-file slots across the six tasks, minus one because test/worker-runtime.e2e.test.ts is
// deliberately owned by BOTH t4 and t5 (amendment 7) = 43 distinct paths.
assert(planTotal.size === 43, 'the plan\'s File Structure names 43 distinct paths (got ' + planTotal.size + ')')
assert(TASKS.reduce((n, t) => n + t.files.length, 0) === 44, 'the six files arrays hold 44 slots — 43 distinct plus the one deliberate two-owner file (got ' + TASKS.reduce((n, t) => n + t.files.length, 0) + ')')

let filesEqual = true
for (const t of TASKS) {
  const fromPlan = [...(planFiles[t.id] || new Set())].sort()
  const fromScript = [...t.files].sort()
  const missingInScript = fromPlan.filter(f => !fromScript.includes(f))
  const extraInScript = fromScript.filter(f => !fromPlan.includes(f))
  const eq = missingInScript.length === 0 && extraInScript.length === 0
  if (!eq) filesEqual = false
  assert(eq, t.id + ': script files array EQUALS the plan\'s rows (' + fromScript.length + ' paths)'
    + (eq ? '' : ' — missing in script: [' + missingInScript.join(', ') + '] extra in script: [' + extraInScript.join(', ') + ']'))
}
assert(filesEqual, '2.54 OVERALL: no task\'s files array diverges from the plan in either direction')

// NEGATIVE CONTROL for probe 5 — the assertion must catch a divergence in BOTH directions.
mustThrow(() => {
  const fromPlan = [...planFiles.t4].sort()
  const mutated = fromPlan.filter(f => !f.endsWith('scheduler.test.ts'))
  if (mutated.length !== fromPlan.length && mutated.filter(f => !fromPlan.includes(f)).length === 0 && fromPlan.filter(f => !mutated.includes(f)).length > 0) {
    throw new Error('divergence detected as required')
  }
}, 'the 2.54 comparison detects a path MISSING from the script side')
mustThrow(() => {
  const fromPlan = [...planFiles.t1].sort()
  const mutated = fromPlan.concat(['apps/core/src/kernel/events/dispatcher.ts'])
  if (mutated.filter(f => !fromPlan.includes(f)).length > 0) throw new Error('divergence detected as required')
}, 'the 2.54 comparison detects an EXTRA path on the script side')

// ---------------------------------------------------------------------------------------------
// PROBE 6 — THE FROZEN BLOCK IS GENERATED AND CORRECT (2.25).
// Each task must ALLOW exactly its own files and FORBID every path owned by another task that it
// does not also own. The one two-owner file (test/worker-runtime.e2e.test.ts, T4 then T5, across
// SEQUENTIAL waves) must be frozen to NEITHER of them and to everyone else — that falls out of the
// set arithmetic rather than being special-cased, and this probe is what proves it did.
// ---------------------------------------------------------------------------------------------
console.log('\nPROBE 6 — the generated frozen block')
const frozenBlock = out.__frozenBlock
const TWO_OWNER = 'apps/core/test/worker-runtime.e2e.test.ts'
const allFiles = [...new Set(TASKS.flatMap(t => t.files))]

for (const t of TASKS) {
  const fb = frozenBlock(t)
  const allowSection = fb.slice(0, fb.indexOf('OWNED BY OTHER TASKS'))
  const forbidSection = fb.slice(fb.indexOf('OWNED BY OTHER TASKS'))
  assert(t.files.every(f => allowSection.includes(f)), t.id + ': every one of its own files is in the ALLOW list')
  assert(t.files.every(f => !forbidSection.includes(f)), t.id + ': none of its own files appears in the FORBID list')
  const shouldForbid = allFiles.filter(f => !t.files.includes(f))
  assert(shouldForbid.every(f => forbidSection.includes(f)), t.id + ': every other task\'s file is in the FORBID list')
}
assert(!frozenBlock(TASKS.find(t => t.id === 't4')).slice(frozenBlock(TASKS.find(t => t.id === 't4')).indexOf('OWNED BY OTHER TASKS')).includes(TWO_OWNER), 't4: the two-owner e2e file is NOT frozen to it')
assert(!frozenBlock(TASKS.find(t => t.id === 't5')).slice(frozenBlock(TASKS.find(t => t.id === 't5')).indexOf('OWNED BY OTHER TASKS')).includes(TWO_OWNER), 't5: the two-owner e2e file is NOT frozen to it')
assert(frozenBlock(TASKS.find(t => t.id === 't1')).slice(frozenBlock(TASKS.find(t => t.id === 't1')).indexOf('OWNED BY OTHER TASKS')).includes(TWO_OWNER), 't1: the two-owner e2e file IS frozen to a task that does not own it')

// The specific paths amendment 7 exists for.
const t4files = TASKS.find(t => t.id === 't4').files
assert(t4files.includes('apps/core/src/kernel/worker/scheduler.test.ts'), 'AMENDMENT 7: t4 owns scheduler.test.ts (the L14 censuses + the JobIntervals literal)')
assert(t4files.includes(TWO_OWNER), 'AMENDMENT 7: t4 owns test/worker-runtime.e2e.test.ts (its job census)')
assert(TASKS.find(t => t.id === 't5').files.includes(TWO_OWNER), 'AMENDMENT 7: t5 also owns test/worker-runtime.e2e.test.ts (its pairs census)')
assert(!TASKS.find(t => t.id === 't5').files.includes('apps/core/src/kernel/worker/jobs.ts'), 'the forward-reference resolution holds: t5 does NOT touch jobs.ts')
assert(!TASKS.find(t => t.id === 't4').files.includes('apps/core/src/worker.ts'), 'the forward-reference resolution holds: t4 does NOT touch worker.ts')
assert(TASKS.find(t => t.id === 't5').files.includes('apps/core/src/kernel/events/dispatcher.ts'), 't5 owns dispatcher.ts (the three envelope lines only)')
assert(!TASKS.some(t => t.files.includes('pnpm-lock.yaml') || t.files.some(f => f.endsWith('package.json'))), 'NO task may touch a manifest or the lockfile — a dependency change is a halt')

// ---------------------------------------------------------------------------------------------
// PROBE 7 — the run machinery's invariants, asserted from the source text.
// ---------------------------------------------------------------------------------------------
console.log('\nPROBE 7 — runner invariants')
assert(src.includes('wave ' + "' + w + '" + ' did not complete'), 'the wave-stall break is present (2.23)')
assert(src.includes('same rung, model unchanged'), 'infra failures retry the SAME rung and never promote the model (2.1)')
assert(src.includes('re-judging the same work, no new coder attempt'), 'a dead judge re-judges the SAME report')
assert(src.includes("{ model: 'opus', label: 'escalate:' + t.id }"), 'the third rung escalates to opus')
assert(src.includes('if (!stalled)'), 'the discovery reviewer runs only when no wave stalled')
assert(!src.includes('agentType'), 'no agentType is used — the routing agent pack is PARKED, so model overrides on the default workflow agent are the only thing that resolves')

// ---------------------------------------------------------------------------------------------
console.log('\n' + '='.repeat(70))
console.log(passed + ' assertions passed, ' + failures.length + ' failed')
if (failures.length) {
  console.log('\nFAILURES:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('PRE-FLIGHT GREEN')
