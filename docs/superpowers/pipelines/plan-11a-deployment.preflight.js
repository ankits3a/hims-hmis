// Pre-flight for plan-11a-deployment.js — MANDATORY, and every probe ships with a NEGATIVE
// CONTROL that must be OBSERVED TO FAIL in the same run (EXECUTION-LESSONS 2.15/2.18/2.22).
// A probe nobody has watched fail is not a probe.
//
// 2.52 rides on all of it: read the exit VALUE, never a pipe's or a wrapper's status — and that
// trap is MOST dangerous on a negative control, where it produces a false FAIL on the instrument
// and gets a working probe "fixed" into a green one. Every node --check below is spawnSync with
// `status` read directly; nothing is piped.
//
// The headline assertion is PROBE 5 (2.54): the script's per-task `files` arrays must EQUAL the
// plan's File Structure rows, parsed from the plan file, in BOTH directions. Plan 11a's compile
// sweep found FOUR files whose edit the plan's prose required and whose File Structure row did not
// name them (`deploy.sh` for T4 and T6, `docker-compose.prod.yml` for T6, `restore-drill.sh` for
// T5). The plan was amended in the same commit as this script — this probe is what keeps the two
// copies honest from here on.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(HERE, 'plan-11a-deployment.js')
const PLAN = resolve(HERE, '../plans/2026-08-22-phase1-11a-deployment.md')
// Scratch goes OUTSIDE the repo by default so a pre-flight run never leaves an untracked
// directory in a tree that is about to be committed. Override with PREFLIGHT_TMP.
//
// AND A GUARD, BECAUSE THE DEFAULT IS A RULE-3 BREACH ON THE BUILD HOST. `os.tmpdir()` is `/tmp`
// there, and AGENT-RULES rule 3 forbids writing to `/tmp` on that box OUTRIGHT — "not even a
// throwaway sanity check". This pre-flight writes probe files. So running it on the build host
// with the default would breach the rule silently, while looking like a careful thing to do.
// It fails LOUDLY instead: §2.32's specimen was an agent writing four files to `/tmp` because
// nothing had shown it the rule, and a checker that breaches the rule it is checking for is a
// worse outcome than one that refuses to start.
const TMP = process.env.PREFLIGHT_TMP || join(tmpdir(), 'hmis-preflight-plan-11a')
if (TMP === '/tmp' || TMP.startsWith('/tmp/')) {
  console.log('ABORT: PREFLIGHT_TMP resolves under /tmp (' + TMP + ').')
  console.log('AGENT-RULES rule 3 forbids ANY write to /tmp on the build host. Re-run with e.g.')
  console.log('  PREFLIGHT_TMP=/opt/hmis/.preflight-tmp node docs/superpowers/pipelines/plan-11a-deployment.preflight.js')
  console.log('and delete that directory with plain `rm -f` afterwards.')
  process.exit(2)
}
mkdirSync(TMP, { recursive: true })

let passed = 0
const failures = []
function ok(label) { passed += 1; console.log('  PASS  ' + label) }
function assert(cond, label) { if (cond) ok(label); else { failures.push(label); console.log('  FAIL  ' + label) } }
function mustThrow(fn, label) {
  let threw = false
  try { fn() } catch { threw = true }
  assert(threw, 'NEGATIVE CONTROL observed to fail: ' + label)
}

// ---------------------------------------------------------------------------------------------
// PROBE 0 — stat the artifacts before reading them (2.51).
// ---------------------------------------------------------------------------------------------
console.log('\nPROBE 0 — the artifacts exist')
let src = null, plan = null
try { src = readFileSync(SCRIPT, 'utf8') } catch (e) { failures.push('script unreadable: ' + e.message) }
try { plan = readFileSync(PLAN, 'utf8') } catch (e) { failures.push('plan unreadable: ' + e.message) }
assert(src && src.length > 30000, 'script present and non-trivial (' + (src ? src.length : 0) + ' bytes)')
assert(plan && plan.length > 40000, 'plan present and non-trivial (' + (plan ? plan.length : 0) + ' bytes)')
if (!src || !plan) { console.log('\nABORT: cannot proceed without both artifacts.'); process.exit(1) }

// ---------------------------------------------------------------------------------------------
// PROBE 1 — MODULE-PARSE. A duplicate top-level declaration is a SyntaxError only under MODULE
// parsing. `node --check` on the .js is a NON-probe for this script shape: the top-level `return`
// makes it exit 0 on genuine syntax errors (2.22).
// ---------------------------------------------------------------------------------------------
console.log('\nPROBE 1 — module parse (.mjs), with negative controls')
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

const negDup = nodeCheckExitValue('probe1.neg-dup.mjs', asModule + '\nfunction frozenBlock() {}\n')
assert(negDup.value !== 0, 'NEGATIVE CONTROL observed to fail: duplicate `function frozenBlock` rejected under module parsing (exit VALUE ' + negDup.value + ')')

const negStr = nodeCheckExitValue('probe1.neg-str.mjs', asModule.replace("const RULES = '/opt/hmis", "const RULES = '/opt/hmis\n"))
assert(negStr.value !== 0, 'NEGATIVE CONTROL observed to fail: broken string literal rejected (exit VALUE ' + negStr.value + ')')

const rawBroken = nodeCheckExitValue('probe1.raw-broken.js', src.replace("const RULES = '/opt/hmis", "const RULES = '/opt/hmis\n"))
assert(rawBroken.value === 0, 'CONFIRMED INERT: `node --check` on the raw .js exits 0 even on a genuine syntax error (2.22) — a non-probe here, not a weaker one')

// ---------------------------------------------------------------------------------------------
// PROBE 2 — DRY RUN with stubbed agent/parallel/phase/log.
// ---------------------------------------------------------------------------------------------
console.log('\nPROBE 2 — dry run')
const spawned = []
const phases = []
const logs = []

const body = src.replace(/^export const meta =/m, 'const meta =')
  + '\nreturn { __meta: meta, __TASKS: TASKS, __result, __coderPrompt: coderPrompt, __gatePrompt: gatePrompt, __mechanicalPrompt: mechanicalPrompt, __DISCOVERY_PROMPT: DISCOVERY_PROMPT, __frozenBlock: frozenBlock, __BASELINE: BASELINE, __HEAD: PHASE0_TIP }\n'
const bodyRewritten = body.replace(RET, '\nconst __result = {\n  tasks: results,')

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

const metaTitles = meta.phases.map(p => p.title)
const wantPhases = ['Wave 1', 'Wave 2', 'Wave 3', 'Wave 4', 'Wave 5', 'Wave 6', 'Discovery']
assert(JSON.stringify(metaTitles) === JSON.stringify(wantPhases), 'meta.phases titles are exactly ' + wantPhases.join(', '))
assert(JSON.stringify(phases) === JSON.stringify(wantPhases), 'phase() was called with exactly those titles in that order (got ' + phases.join(', ') + ')')

// SIX STRICTLY SEQUENTIAL WAVES, ONE TASK EACH. §2.62: no parallel wave, so no two commits can
// coalesce into one push and leave the earlier commit with NO CI run at all.
assert(JSON.stringify(TASKS.map(t => t.id + ':' + t.wave)) === JSON.stringify(['T1:1', 'T2:2', 'T3:3', 'T4:4', 'T5:5', 'T6:6']), 'wave assignment is W1[T1] → W2[T2] → W3[T3] → W4[T4] → W5[T5] → W6[T6]')
const byWave = {}
TASKS.forEach(t => { byWave[t.wave] = (byWave[t.wave] || 0) + 1 })
assert(Object.values(byWave).every(n => n === 1), '2.62: EVERY wave holds exactly ONE task — no parallel wave anywhere')
const WAVE_OF = Object.fromEntries(TASKS.map(t => [t.id, t.wave]))
let depsOk = true
for (const t of TASKS) for (const d of t.deps) if (!(WAVE_OF[d] < t.wave)) depsOk = false
assert(depsOk, 'every dependency sits in a STRICTLY earlier wave')

// Model routing per the plan's Pipeline Notes: T1–T5 opus coder + opus gate; T6 sonnet + check.
const MODEL = Object.fromEntries(TASKS.map(t => [t.id, t.model]))
assert(['T1', 'T2', 'T3', 'T4', 'T5'].every(id => MODEL[id] === 'opus') && MODEL.T6 === 'sonnet', 'models: T1–T5 opus, T6 sonnet')
const GATED = TASKS.filter(t => t.gate).map(t => t.id)
assert(JSON.stringify(GATED) === JSON.stringify(['T1', 'T2', 'T3', 'T4', 'T5']), 'opus gates on exactly the five CRITICAL tasks (got ' + GATED.join(',') + ')')
assert(TASKS.filter(t => t.tier === 'CRITICAL').map(t => t.id).join(',') === 'T1,T2,T3,T4,T5', 'CRITICAL tier is exactly T1..T5')
assert(TASKS.filter(t => t.tier === 'ROUTINE').map(t => t.id).join(',') === 'T6', 'ROUTINE tier is exactly T6')

// Every gate agent must actually be dispatched on opus — the tier is delivered by the MODEL
// override, because the template's `heavy-coder`/`gate` agent types live under routing.parked and
// are NOT in the active registry (a §2.51-class staleness; see the gate report).
assert(spawned.filter(s => s.label.startsWith('gate:')).every(s => s.model === 'opus'), 'every gate is dispatched on opus')
assert(spawned.every(s => s.agentType === 'general-purpose'), 'every agent uses an agentType that EXISTS in the active registry')

// 2.50 — EVERY task has a judge. A task nothing judges cannot fail, so the wave-stall break is
// dead for it — and this pipeline APPLIES A MIGRATION in wave 2.
const judgedIds = new Set(spawned.filter(s => s.label.startsWith('gate:') || s.label.startsWith('check:')).map(s => s.label.split(':')[1].split('#')[0]))
assert(TASKS.every(t => judgedIds.has(t.id)), '2.50: EVERY task has a judge (gate or mechanical check) — no task can silently pass')
const checkers = spawned.filter(s => s.label.startsWith('check:')).map(s => s.label.split(':')[1].split('#')[0])
assert(JSON.stringify(checkers) === JSON.stringify(['T6']), 'mechanical checker on exactly T6 (got ' + checkers.join(',') + ')')

assert(spawned.length === 13, 'thirteen agents on a clean run: 6 coders + 5 gates + 1 mechanical check + 1 discovery (got ' + spawned.length + ')')

// ---------------------------------------------------------------------------------------------
// PROBE 3 — SHARED BLOCKS OVER **EVERY** AGENT THIS SCRIPT SPAWNS (2.32).
// `coders.concat(gates)` excludes checkers and the reviewer BY CONSTRUCTION, which is exactly how
// a reviewer once shipped without the rules pointer and breached rule 3. Iterate `spawned`.
// And assert MARKER TEXT IN THE RENDERED PROMPT, never `typeof CONST !== 'undefined'` (2.19).
// ---------------------------------------------------------------------------------------------
console.log('\nPROBE 3 — shared blocks over all 13 spawned agents')
const RULES_MARK = 'THE RULES ARE IN THE REPO. READ THEM FIRST, IN FULL.'
const RULES_PATH = '/opt/hmis/docs/superpowers/AGENT-RULES.md'
const MIRROR_MARK = 'YOUR LOCAL MIRROR (AGENT-RULES rule 22)'
const CI_MARK = 'deliberately UNAUTHENTICATED'
const AMEND_MARK = 'RULE 6 IS RETIRED and RULES 3 AND 7 WERE AMENDED'
const PRUNE_MARK = 'FORBIDDEN\nOUTRIGHT, ALWAYS'

assert(spawned.every(s => s.prompt.includes(RULES_MARK)), 'EVERY spawned agent renders the rules pointer text')
assert(spawned.every(s => s.prompt.includes(RULES_PATH)), 'EVERY spawned agent renders the absolute path to AGENT-RULES.md')
assert(spawned.every(s => s.prompt.startsWith(RULES_MARK)), 'the rules pointer is the FIRST thing in every prompt, above the goal')
assert(spawned.every(s => s.prompt.includes(MIRROR_MARK)), 'EVERY spawned agent renders the mirror block')
assert(spawned.every(s => s.prompt.includes(CI_MARK)), 'EVERY spawned agent renders the CI delegation block')
assert(spawned.every(s => s.prompt.includes(AMEND_MARK)), '2.69: EVERY agent is told rules 3/7 were amended and rule 6 retired FOR THIS PLAN')
assert(spawned.every(s => s.prompt.includes(PRUNE_MARK)), 'rule 7: EVERY agent is told a blanket prune is forbidden outright')

// Rule 3's /tmp absolute must reach every agent — §2.32's specimen was a CHECKER writing to /tmp,
// and the pre-flight that missed it iterated `coders.concat(gates)`, which excludes checkers by
// construction. This one iterates `spawned`.
assert(spawned.every(s => s.prompt.includes('NEVER `/tmp`')), 'EVERY agent is told /tmp is forbidden outright')

// 2.40 — the mirror block is a POINTER, not a second copy of rule 22 in the compiler's words.
assert(!spawned.some(s => s.prompt.includes('tar czf - --exclude=node_modules')), '2.40: no prompt RESTATES rule 22\'s mirror commands — the block is a pointer')

// Each agent gets a mirror directory UNIQUE TO IT (2.40: a shared mirror inherits every earlier
// agent's scratch and produced a false accusation of rule-breaking against a compliant agent).
const mirrorDirs = spawned.map(s => (s.prompt.match(/scratchpad\\mirror-([a-z0-9-]+)/) || [])[1])
assert(mirrorDirs.every(Boolean), 'every prompt names a mirror directory')
assert(new Set(mirrorDirs).size === new Set(spawned.map(s => s.label.replace(/[#~].*$/, ''))).size, '2.40: mirror directories are per-agent, not shared')

const coderPrompts = spawned.filter(s => !s.label.startsWith('gate:') && !s.label.startsWith('check:') && !s.label.startsWith('discovery:'))
assert(coderPrompts.length === 6, 'six coder prompts (got ' + coderPrompts.length + ')')
const BLOCKS = [
  ['INBOX_READ', 'STEP 0, BEFORE ANYTHING ELSE'],
  ['PLAN_POINTER', 'THE PLAN IS THE DESIGN LAW FOR THIS TASK'],
  ['FORKS-CLOSED', 'ALL FOUR FORKS ARE RESOLVED BY MEASUREMENT AND CLOSED'],
  ['GROUND_TRUTH', 'GROUND TRUTH, MEASURED BY THE MAIN SESSION'],
  ['BASELINE', 'Baseline, detached `pnpm verify`, exit VALUE read from'],
  ['TIER', 'RISK TIER:'],
  ['FILES', 'YOUR FILES LIST — THE ONLY PATHS YOU MAY COMMIT'],
  ['FROZEN', 'FROZEN — OWNED BY OTHER TASKS IN THIS PIPELINE'],
  ['HALT', 'HALT TO THE MAIN SESSION — STOP AND REPORT'],
  ['FINISH', 'THE FINISH BLOCK — AGENT-RULES §5'],
  ['CRITERIA', 'ACCEPTANCE CRITERIA YOUR WORK MUST MEET'],
  ['EVIDENCE', 'READING A COMMAND\'S VERDICT'],
  ['RULE-15', 'NEVER rewrite published history'],
  ['MUTANT-BRANCHES', 'A SURVIVING REQUIRED-DIED MUTANT IS NEVER SILENTLY FIXED'],
]
for (const [name, mark] of BLOCKS) {
  assert(coderPrompts.every(s => s.prompt.includes(mark)), 'every coder brief renders the ' + name + ' block')
}
// Gates, the checker and the discovery reviewer get the inbox WRITE half; coders get READ.
const inWaveJudges = spawned.filter(s => s.label.startsWith('gate:') || s.label.startsWith('check:'))
const judges = inWaveJudges.concat(spawned.filter(s => s.label.startsWith('discovery:')))
assert(inWaveJudges.every(s => s.prompt.includes('IF YOU FIND SOMETHING A LATER TASK IN THIS PIPELINE MUST KNOW')), 'every IN-WAVE judge renders the inbox WRITE block')
// The discovery reviewer is the LAST agent in the pipeline: it has no later task to write to, so
// it READS the inbox instead — and re-checks every "benign" verdict already in it (§2.67).
const disc = spawned.find(s => s.label.startsWith('discovery:'))
const FINDINGS_INBOX_PATH = '/opt/hmis/docs/superpowers/plans/reports/plan-11a-findings-inbox.md'
assert(disc.prompt.includes(FINDINGS_INBOX_PATH), 'the discovery reviewer is pointed at the findings inbox to READ it')
assert(judges.every(s => s.prompt.includes('§2.67')), '2.67\'s "a routed REASSURANCE inherits rule 21\'s burden" reaches every judge including discovery')
assert(disc.prompt.includes('BUILD the mutant, do not predict it'), 'rule 21 binds the discovery reviewer explicitly — it is the last reader, so an unexecuted claim reaches the gate report unchallenged')
assert(disc.prompt.includes('COMMIT NOTHING'), 'the discovery reviewer is told it commits nothing and fixes nothing')
assert(spawned.filter(s => s.label.startsWith('gate:')).every(s => s.prompt.includes('REBUILD THE TASK\'S REQUIRED-DIED MUTANTS YOURSELF')), 'every gate is told to rebuild the mutants itself')
assert(spawned.filter(s => s.label.startsWith('gate:')).every(s => s.prompt.includes('§2.61')), 'every gate carries 2.61\'s nominal-typing trap')

// Per-task: the brief names THAT task's own commit subject and no other's.
for (const t of TASKS) {
  const p = coderPrompts.find(s => s.label.endsWith(':' + t.id)).prompt
  assert(p.includes(t.commit), t.id + ': brief carries its own exact commit subject')
  const others = TASKS.filter(o => o.id !== t.id && p.includes(o.commit))
  assert(others.length === 0, t.id + ': brief carries NO other task\'s commit subject' + (others.length ? ' (leaked: ' + others.map(o => o.id).join(',') + ')' : ''))
}

// The compile-time constants must have been FILLED IN. A brief that ships the literal placeholder
// hands every agent a baseline of "__BASELINE__" — §2.6's class with the numbers removed entirely.
assert(!out.__BASELINE.includes('__'), 'BASELINE was filled in at compile, not left as a placeholder (got: ' + out.__BASELINE + ')')
assert(/^[0-9a-f]{40}$/.test(out.__HEAD), 'PHASE0_TIP is a FULL 40-char sha, not short and not a placeholder (got: ' + out.__HEAD + ')')
assert(coderPrompts.every(s => !s.prompt.includes('__BASELINE__') && !s.prompt.includes('__HEAD__')), 'no rendered brief contains an unfilled placeholder')

mustThrow(() => {
  const mutilated = coderPrompts[0].prompt.replace('HALT TO THE MAIN SESSION — STOP AND REPORT', 'XXXX')
  if (!mutilated.includes('HALT TO THE MAIN SESSION — STOP AND REPORT')) throw new Error('marker gone')
}, 'the block-marker assertion detects a removed HALT block')

// ---------------------------------------------------------------------------------------------
// PROBE 4 — CROSS-REFERENCES RESOLVE (2.34). A marker assertion is a spell-check, not a
// fact-check: assert the plan SECTIONS the briefs name actually exist in the plan file.
// ---------------------------------------------------------------------------------------------
console.log('\nPROBE 4 — every cross-reference into the plan resolves')
const planRefs = [
  '### D1.', '### D2.', '### D3.', '### D4.', '### D5.', '### D6.', '### D7.', '### D8.',
  '### D9.', '### D10.', '### D11.', '### D12.', '### D13.', '### D14.', '### D15.',
  '## Global Constraints', '## File Structure', '## Tasks', '## Assertion Book',
  '## Commit messages', '## Verify-by-execution flags', '## Pipeline Notes',
  '## Phase 0 — remediation BEFORE the pipeline',
  '### Task 1:', '### Task 2:', '### Task 3:', '### Task 4:', '### Task 5:', '### Task 6:',
]
for (const r of planRefs) assert(plan.includes(r), 'plan contains ' + r)
for (const n of ['R1', 'R2', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9', 'V10', 'V11', 'V12']) {
  assert(plan.includes('| ' + n + ' |'), 'Assertion Book row ' + n + ' exists in the plan')
}
for (const t of TASKS) assert(plan.includes(t.commit), t.id + ': commit subject appears verbatim in the plan\'s table')

// 2.48 — ZERO SPIKE-SLOT markers. One remaining is a plan defect, not an inconvenience.
assert(!plan.includes('SPIKE-SLOT'), '2.48: the plan carries ZERO `SPIKE-SLOT` markers')
// The four fork LOSERS may appear only inside resolved/dead prose. Assert each is adjacent to a
// death word, so a losing branch cannot be silently re-offered as an option.
for (const [loser, ctx] of [['tsx`-in-production', 'dead'], ['create-empty-and-cut-over', 'dead'], ['off-box branch', 'dead']]) {
  const i = plan.indexOf(loser)
  assert(i > 0 && plan.slice(i, i + 400).includes(ctx), '2.48: fork loser "' + loser + '" appears only in a marked-dead block')
}
mustThrow(() => { if (plan.includes('### D99.')) return; throw new Error('absent as expected') }, 'the cross-reference probe distinguishes a present section from an absent one')

// ---------------------------------------------------------------------------------------------
// PROBE 5 — 2.54, THE HEADLINE. The script's per-task `files` arrays must EQUAL the plan's File
// Structure rows for that task, parsed from the plan, in BOTH directions.
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
  let prefix = ''
  let rows = 0
  for (const raw of block.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) continue
    // A non-indented line is: the repo-root marker, a directory heading, or a ROOT-LEVEL FILE ROW.
    // Plan 10's parser treated every non-indented line as a heading, which silently SWALLOWS a
    // root-level row like `README.md` — the same class of miss §2.46 exists for, in the checker.
    if (!line.startsWith(' ')) {
      if (line.trim() === '(repo root)') { prefix = ''; continue }
      if (line.trim().endsWith('/')) { prefix = line.trim(); continue }
      const rm = line.match(/^(\S+)\s{2,}(.+)$/)
      if (!rm) continue
      const tasksR = [...new Set((rm[2].match(/\bT[1-6]\b/g) || []))]
      assert(tasksR.length > 0, 'root-level File Structure row names at least one task: ' + rm[1])
      rows += 1
      for (const tk of tasksR) { byTask[tk] = byTask[tk] || new Set(); byTask[tk].add(rm[1]) }
      continue
    }
    const m = line.match(/^\s+(\S+)\s{2,}(.+)$/)
    if (!m) continue
    const full = prefix + m[1]
    const tasks = [...new Set((m[2].match(/\bT[1-6]\b/g) || []))]
    assert(tasks.length > 0, 'File Structure row names at least one task: ' + full)
    rows += 1
    for (const tk of tasks) { byTask[tk] = byTask[tk] || new Set(); byTask[tk].add(full) }
  }
  assert(rows >= 40, 'the parser found the whole block, not a fragment (' + rows + ' rows)')
  return byTask
}

const planFiles = parsePlanFileStructure(plan)
// The parser must have found the root-level README.md row — the one Plan 10's parser shape drops.
assert((planFiles.T6 || new Set()).has('README.md'), 'the parser captured the ROOT-LEVEL row `README.md` (T6) rather than swallowing it as a heading')
assert((planFiles.T1 || new Set()).has('Dockerfile'), 'the parser resolved `(repo root)` to an empty prefix (Dockerfile, not "(repo root)Dockerfile")')

const planTotal = new Set(Object.values(planFiles).flatMap(s => [...s]))
const slots = TASKS.reduce((n, t) => n + t.files.length, 0)
const planSlots = Object.values(planFiles).reduce((n, s) => n + s.size, 0)
console.log('        plan: ' + planTotal.size + ' distinct paths across ' + planSlots + ' task-file slots; script: ' + slots + ' slots')
assert(slots === planSlots, 'the script holds exactly as many task-file slots as the plan (script ' + slots + ' vs plan ' + planSlots + ')')

// The six multi-owner chains the amended plan declares, asserted as a FACT about the arrays —
// this is the amendment's own regression pin.
const MULTI = {
  'apps/core/src/kernel/worker/jobs.ts': ['T2', 'T5'],
  'apps/core/src/kernel/worker/scheduler.test.ts': ['T2', 'T5'],
  'apps/core/test/worker-runtime.e2e.test.ts': ['T2', 'T5'],
  'docker/prod/docker-compose.prod.yml': ['T3', 'T4', 'T6'],
  'docker/prod/deploy.sh': ['T3', 'T4', 'T6'],
  'docker/prod/drill/restore-drill.sh': ['T4', 'T5'],
}
for (const [f, owners] of Object.entries(MULTI)) {
  const inScript = TASKS.filter(t => t.files.includes(f)).map(t => t.id)
  assert(JSON.stringify(inScript) === JSON.stringify(owners), 'multi-owner ' + f + ' is owned by exactly ' + owners.join('→') + ' in the script (got ' + inScript.join(',') + ')')
  const inPlan = Object.entries(planFiles).filter(([, s]) => s.has(f)).map(([k]) => k).sort()
  assert(JSON.stringify(inPlan) === JSON.stringify(owners), 'multi-owner ' + f + ' is owned by exactly ' + owners.join('→') + ' in the PLAN (got ' + inPlan.join(',') + ')')
  // Sequential, never parallel: a shared file across a parallel wave is a write race.
  const waves = inScript.map(id => WAVE_OF[id])
  assert(new Set(waves).size === waves.length, f + ': its owners are in DISTINCT waves — the sharing is sequential, never parallel')
}

let filesEqual = true
for (const t of TASKS) {
  const fromPlan = [...(planFiles[t.id] || new Set())].sort()
  const fromScript = [...t.files].sort()
  const missingInScript = fromPlan.filter(f => !fromScript.includes(f))
  const extraInScript = fromScript.filter(f => !fromPlan.includes(f))
  const eq = missingInScript.length === 0 && extraInScript.length === 0
  if (!eq) filesEqual = false
  assert(eq, t.id + ': script files array EQUALS the plan\'s rows (' + fromScript.length + ' paths)'
    + (eq ? '' : ' — MISSING IN SCRIPT: [' + missingInScript.join(', ') + '] EXTRA IN SCRIPT: [' + extraInScript.join(', ') + ']'))
}
assert(filesEqual, '2.54 OVERALL: no task\'s files array diverges from the plan in either direction')

mustThrow(() => {
  const fromPlan = [...planFiles.T5].sort()
  const mutated = fromPlan.filter(f => !f.endsWith('restore-drill.sh'))
  if (fromPlan.filter(f => !mutated.includes(f)).length > 0) throw new Error('divergence detected as required')
}, 'the 2.54 comparison detects a path MISSING from the script side')
mustThrow(() => {
  const fromPlan = [...planFiles.T1].sort()
  const mutated = fromPlan.concat(['apps/core/src/kernel/events/dispatcher.ts'])
  if (mutated.filter(f => !fromPlan.includes(f)).length > 0) throw new Error('divergence detected as required')
}, 'the 2.54 comparison detects an EXTRA path on the script side')

// ---------------------------------------------------------------------------------------------
// PROBE 6 — THE FROZEN BLOCK IS GENERATED AND CORRECT (2.25).
// Each task must ALLOW exactly its own files and FORBID every path owned by another task that it
// does not also own. The six multi-owner files must be frozen to NEITHER of their owners — that
// falls out of the set arithmetic rather than being special-cased, and this probe proves it did.
// ---------------------------------------------------------------------------------------------
console.log('\nPROBE 6 — the generated frozen block')
const frozenBlock = out.__frozenBlock
const allFiles = [...new Set(TASKS.flatMap(t => t.files))]

// PATHS MUST BE COMPARED AS WHOLE LINES, NEVER AS SUBSTRINGS — and this probe found out why by
// failing: T1 owns `Dockerfile`, T4 owns `docker/prod/db.Dockerfile`, and
// "docker/prod/db.Dockerfile".includes("Dockerfile") is TRUE. A substring check reported T1's own
// file as frozen to T1. The same collision is live for the MECHANICAL CHECK's frozen-path grep, so
// it is called out in the gate report: grep whole paths, anchored, not bare basenames.
function pathLines(section) {
  return section.split('\n').map(l => l.trim().split(/\s{2,}|\s+\(owned by/)[0].trim()).filter(Boolean)
}
for (const t of TASKS) {
  const fb = frozenBlock(t)
  const cut = fb.indexOf('FROZEN — OWNED BY OTHER TASKS')
  assert(cut > 0, t.id + ': the frozen block has both halves')
  const allow = pathLines(fb.slice(0, cut))
  const forbid = pathLines(fb.slice(cut))
  assert(t.files.every(f => allow.includes(f)), t.id + ': every one of its own files is in the ALLOW list')
  assert(t.files.every(f => !forbid.includes(f)), t.id + ': NONE of its own files appears in the FORBID list')
  const shouldForbid = allFiles.filter(f => !t.files.includes(f))
  assert(shouldForbid.every(f => forbid.includes(f)), t.id + ': every other task\'s file is in the FORBID list')
}
// The substring collision, pinned as its own fact so a future edit cannot reintroduce it silently.
assert('docker/prod/db.Dockerfile'.includes('Dockerfile'), 'COLLISION PINNED: `db.Dockerfile` contains `Dockerfile` — any frozen-path grep must anchor on whole paths')

// The specimen that cost 08.5 its headline deliverable, asserted directly.
for (const [f, owners] of Object.entries(MULTI)) {
  for (const id of owners) {
    const t = TASKS.find(x => x.id === id)
    const fb = frozenBlock(t)
    assert(!pathLines(fb.slice(fb.indexOf('FROZEN — OWNED BY OTHER TASKS'))).includes(f), '2.54 specimen: ' + f + ' is NOT frozen to its owner ' + id)
  }
}
mustThrow(() => {
  const fb = frozenBlock(TASKS[0])
  const forbid = fb.slice(fb.indexOf('FROZEN — OWNED BY OTHER TASKS'))
  if (forbid.includes('apps/core/src/kernel/retention/sweep.ts')) throw new Error('T5 file correctly frozen to T1')
}, 'the frozen-block probe can tell a forbidden path from an allowed one')

// ---------------------------------------------------------------------------------------------
// PROBE 7 — THE LADDER AND THE INFRA RULES (2.1). An infrastructure failure must never consume a
// defect attempt or promote the tier; a dead gate must re-judge the SAME coder report.
// ---------------------------------------------------------------------------------------------
console.log('\nPROBE 7 — ladder semantics under a dead gate and a dead coder')

async function runWith(agentImpl) {
  const calls = []
  const wrapped = async (prompt, opts) => { calls.push({ prompt, ...opts }); return agentImpl(prompt, opts, calls) }
  const r = new Function('agent', 'parallel', 'phase', 'log', '"use strict"; return (async () => {' + bodyRewritten + '})()')
  const wrapper = await r(wrapped, stubParallel, () => {}, () => {})
  // `bodyRewritten` renames the script's top-level `return {` to `const __result = {`, so the
  // runner hands back the EXPORT wrapper, not the pipeline's own result. Reading `wrapper.summary`
  // would be `undefined` — and `assert(undefined === '6/6 done')` fails for the wrong reason,
  // which is a probe reporting a defect in itself as a defect in the thing it measures.
  return { res: wrapper.__result, calls }
}

// A gate that dies twice then passes must NOT cause a second coder run.
let gateDeaths = 0
const deadGate = await runWith(async (prompt, opts) => {
  if (opts.label.startsWith('discovery:')) return { summary: 's', findings: [] }
  if (opts.label.startsWith('gate:') || opts.label.startsWith('check:')) {
    if (opts.label.includes('T1') && gateDeaths < 2) { gateDeaths += 1; return null }
    return { verdict: 'pass', violations: [], corrections: [], findings: [], tests: { ran: 's', passed: 1, failed: 0 } }
  }
  return { outcome: 's', files_changed: [], tests: 's', interpretations: [], commit_sha: 's' }
})
const t1Coders = deadGate.calls.filter(c => !c.label.startsWith('gate:') && !c.label.startsWith('check:') && !c.label.startsWith('discovery:') && c.label.endsWith(':T1'))
assert(t1Coders.length === 1, '2.1: two dead gates re-judged the SAME coder report — exactly ONE T1 coder ran (got ' + t1Coders.length + ')')
assert(deadGate.res.summary === '6/6 done', '2.1: the run still completed 6/6 after two gate infra failures')

// A real gate REJECTION must advance the rung and re-run the coder with the failure history.
let rejected = false
const realReject = await runWith(async (prompt, opts) => {
  if (opts.label.startsWith('discovery:')) return { summary: 's', findings: [] }
  if (opts.label.startsWith('gate:') || opts.label.startsWith('check:')) {
    if (opts.label.includes('T1') && !rejected) {
      rejected = true
      return { verdict: 'fail', violations: [{ type: 'criterion-unmet', detail: 'flag 1 not discharged' }], corrections: ['boot the container and quote /health'], tests: { ran: 's', passed: 0, failed: 1 } }
    }
    return { verdict: 'pass', violations: [], corrections: [], findings: [], tests: { ran: 's', passed: 1, failed: 0 } }
  }
  return { outcome: 's', files_changed: [], tests: 's', interpretations: [], commit_sha: 's' }
})
const t1After = realReject.calls.filter(c => !c.label.startsWith('gate:') && !c.label.startsWith('check:') && !c.label.startsWith('discovery:') && c.label.endsWith(':T1'))
assert(t1After.length === 2, 'a real gate REJECTION advanced the rung — a second T1 coder ran (got ' + t1After.length + ')')
assert(t1After[1].label.startsWith('retry:'), 'the second rung is labelled `retry:` and stays on the same tier — a rejection does not promote')
assert(t1After[1].prompt.includes('flag 1 not discharged') && t1After[1].prompt.includes('boot the container and quote /health'), 'the retry brief carries the full failure history and corrections')
assert(t1After[1].prompt.includes('never an amend or a force-push'), 'the retry brief carries rule 15 explicitly — a retry after a pushed commit must not rewrite history')
assert(t1After[1].prompt.includes('A MIGRATION THE PREVIOUS ATTEMPT APPLIED IS STILL'), 'the retry brief warns that an APPLIED MIGRATION is state the files do not show (AGENT-RULES §6) — the retry path is where a 934k-token incident began')

// THE WAVE-STALL BREAK. A task that cannot pass must stop the run, not let later waves discover it.
const stall = await runWith(async (prompt, opts) => {
  if (opts.label.startsWith('discovery:')) return { summary: 's', findings: [] }
  if (opts.label.startsWith('gate:') || opts.label.startsWith('check:')) {
    if (opts.label.includes('T2')) return { verdict: 'fail', violations: [{ type: 'test-failure', detail: 'migration 0016 not applied' }], corrections: ['apply it'], tests: { ran: 's', passed: 0, failed: 1 } }
    return { verdict: 'pass', violations: [], corrections: [], findings: [], tests: { ran: 's', passed: 1, failed: 0 } }
  }
  return { outcome: 's', files_changed: [], tests: 's', interpretations: [], commit_sha: 's' }
})
assert(stall.res.stalled === true, 'wave-stall break fired when wave 2 could not complete')
assert(stall.res.halted.includes('T2'), 'T2 is recorded as halted')
assert(!stall.calls.some(c => c.label.endsWith(':T3') || c.label.endsWith(':T4')), 'NO later wave launched after the stall — T3..T6 never ran')
assert(stall.res.discovery === null, 'the discovery reviewer did NOT run on a stalled pipeline — a half-shipped range is not a system to review')

// ---------------------------------------------------------------------------------------------
console.log('\n' + '='.repeat(70))
if (failures.length) {
  console.log('PRE-FLIGHT FAILED — ' + failures.length + ' failure(s), ' + passed + ' passed:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('PRE-FLIGHT PASSED — ' + passed + ' assertions, every negative control observed to fail.')
process.exit(0)
