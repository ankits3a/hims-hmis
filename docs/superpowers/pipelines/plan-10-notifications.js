export const meta = {
  name: 'plan-10-notifications',
  description: 'Plan 10 The Notifications Gateway (T1-T6) on execute method v2: migration 0015 and the outbox, the template registry, the console adapters and config, the pump with claim-before-send and the suppression gauntlet, the kernel.notify consumer with both halves of the wire, and the patient-master opt-in/deceased surface.',
  phases: [
    { title: 'Wave 1', detail: 'T1 [ROUTINE/opus] Migration 0015 - the notifications outbox, promotional_opt_in, deceased_at, users.phone, both truncate groups' },
    { title: 'Wave 2', detail: 'T2 [ROUTINE/sonnet] The template registry + the four notify events. T3 [ROUTINE/sonnet] Console adapters + three defaulted config keys' },
    { title: 'Wave 3', detail: 'T4 [CRITICAL/opus] The pump - claim-before-send, the gauntlet, quiet hours, the ladder, and the seventh scheduler job' },
    { title: 'Wave 4', detail: 'T5 [CRITICAL/opus] The kernel.notify consumer, occurredAt on the envelope, the manual_notify desk flag, one importable consumers map' },
    { title: 'Wave 5', detail: 'T6 [ROUTINE/sonnet] Opt-in at registration, deceased on the patient record, the notify strings' },
    { title: 'Discovery', detail: 'One cross-task discovery review over all six commits' },
  ],
}

// ==== Plan 10, compiled 2026-08-21 under EXECUTE-METHOD v2 ===================================
// Plan:   docs/superpowers/plans/2026-08-21-phase1-10-notifications.md
//         Pipeline Notes are the compile contract. AMENDMENT 7 (this compile's own, landed in the
//         plan in the SAME commit as this script - EXECUTION-LESSONS 2.54) moved two census files
//         into T4's Files list; the `files` arrays below are the second copy of that fact and the
//         pre-flight asserts them EQUAL to the plan's File Structure, per task, both directions.
// Rules:  docs/superpowers/AGENT-RULES.md v2 - POINTED AT, never inlined; the MIRROR block is a
//         POINTER for the reason 2.40 records.
// Spike:  NONE. Owner ruling 3 - every mechanism reuses a shipped, measured pattern.
//
// COMPILE-TIME OBLIGATIONS DISCHARGED HERE:
//   2.46  Every path in the File Structure resolved against the SERVER tree before a brief was
//         written: 27 modify-targets EXIST, 14 create-targets ABSENT, no drizzle/0015*, latest
//         migration 0014_true_dark_beast.sql. Run 2026-08-21 at 5641931.
//   2.47  Forward-reference pass found the defect amendment 7 fixes: T4 registers a SEVENTH
//         scheduler job and widens JobIntervals, which breaks THE_SIX + spyOnTheSix +
//         CENSUS_INTERVALS in scheduler.test.ts (owned by NOBODY, therefore frozen to all six)
//         and THE_SIX in test/worker-runtime.e2e.test.ts (owned by T5, one wave later).
//   2.54  The plan's File Structure and these `files` arrays are asserted EQUAL at pre-flight.
//         That assertion is the one 08.5's pre-flight lacked and it cost that plan its headline.
//   2.25  The frozen block is GENERATED from these arrays (frozenBlock()), never hand-written.
//   2.40  The MIRROR block is a POINTER at rule 22, not a second copy in the compiler's words.
//   2.32  EVERY agent this script spawns renders the rules pointer - coders, gates, the four
//         mechanical checkers, the discovery reviewer - and the pre-flight asserts it over ALL.
//   2.39  The findings inbox, with 2.60's caution riding on it: a routed finding is a CLAIM.
//   2.50  T1, T2, T3 and T6 have no opus gate (Pipeline Notes), so each gets a MECHANICAL CHECK
//         agent. Without one a task cannot fail, and the wave-stall break is dead for it - and
//         T1 APPLIES A MIGRATION, which is an irreversible mutation of shared host state.
//   2.55  CI cannot be checked by any in-pipeline agent. `ci-watch.sh` runs on the owner's
//         machine for the duration of this run; every prompt says the CI item is delegated.
//   2.57  Assertion Book row N5 is marked P: its stated input is a PREDICTION and T4 must
//         confirm by execution that it separates the two implementations.
// =============================================================================================

const PLAN = '/opt/hmis/docs/superpowers/plans/2026-08-21-phase1-10-notifications.md'

const RULES = 'THE RULES ARE IN THE REPO. READ THEM FIRST, IN FULL, BEFORE YOU TOUCH ANYTHING.\n\n'
  + '  /opt/hmis/docs/superpowers/AGENT-RULES.md   (version 2; rule 22 amended 2026-08-20 and 2026-08-21)\n\n'
  + 'That file is the binding contract: 22 hard rules, the evidence discipline, the risk-tiered mutant\n'
  + 'discipline, the counting rule, the finish block, and the migration rule. It is NOT pasted into this\n'
  + 'prompt - there is ONE copy, versioned with the repo, because two copies of a rule drift and one does\n'
  + 'not. Where this prompt and AGENT-RULES.md disagree about PROCESS, AGENT-RULES.md wins; where they\n'
  + 'disagree about CODE, the plan wins.\n\n'
  + 'IT BINDS YOU WHATEVER YOUR ROLE IS - implementer, reviewer, mechanical checker, discovery reviewer.\n'
  + 'A pipeline two plans ago shipped a checker that had never been shown rule 3, and it wrote four files\n'
  + "to the build host's /tmp (EXECUTION-LESSONS 2.32). That is why this pointer is the first thing in\n"
  + 'every prompt this pipeline spawns, and why the pre-flight asserts it over EVERY agent.\n\n'
  + 'READ RULE 22 IN FULL - it changes where you read, where you type, and what you may conclude from\n'
  + 'what you read. Read rules 16-21 in full before you report ANY test result.'

const MIRROR = 'YOUR LOCAL MIRROR - AGENT-RULES rule 22, which you have just read. This block adds exactly one\n'
  + 'fact rule 22 cannot know, and restates nothing (2.40: the restatement is what drifted and produced a\n'
  + 'false accusation of rule-breaking against a compliant agent).\n\n'
  + 'THE DIRECTORY THAT IS YOURS ALONE, and it must appear nowhere in any other agent\'s work:\n\n'
  + '  <SCRATCHPAD>/mirror-<taskid>-<role>        e.g. mirror-t4-coder, mirror-t4-gate, mirror-t4-check\n\n'
  + '<SCRATCHPAD> is your own session scratchpad directory - a Windows path, so Read, Grep, Glob, Edit and\n'
  + 'Write all work natively against it. A RETRY of your own task deliberately reuses your own directory.\n'
  + 'Rule 22 governs everything else about it, including 22(f) (you do NOT delete it, and `rm -rf` is\n'
  + 'denied on this host) and 22(g) (a mirror is not evidence about the SERVER\'s tree).'

const BASELINE = 'THE MEASURED BASELINE - re-measured by the compiling session immediately before this brief was\n'
  + 'written, NOT copied from the plan. Build host /opt/hmis at commit 5641931, `pnpm verify` run\n'
  + 'DETACHED with the exit VALUE read from /opt/hmis/.baseline.exit (rules 17-18):\n\n'
  + '  EXIT VALUE 0\n'
  + '  apps/core          Test Suites: 126 passed, 126 total | Tests: 811 passed, 811 total\n'
  + '  apps/web           Test Files  31 passed (31)         | Tests  147 passed (147)\n'
  + '  packages/contracts Test Suites: 3 passed, 3 total     | Tests: 7 passed, 7 total\n\n'
  + '`pgrep -af jest` was clear at measurement time - the single matched line was the probe\'s own shell\n'
  + '(rule 20: read the matched COMMAND LINES, never the count).\n\n'
  + 'THIS IS A SEQUENTIAL PIPELINE. Earlier tasks in it have already committed by the time you run, so\n'
  + 'your HEAD will NOT be 5641931 and your counts will be HIGHER than the numbers above. That is\n'
  + 'expected and is not drift; do not spend a paragraph reconciling it (2.6). What binds you is\n'
  + 'AGENT-RULES section 4: the workspace total must not DECREASE and your diff must delete no test.\n'
  + 'There are no per-task test-count targets in this plan.'

const PLAN_POINTER = 'THE PLAN IS DESIGN LAW AND IT IS IN THE REPO. READ IT, do not work from this brief alone:\n\n'
  + '  ' + PLAN + '\n\n'
  + 'It is OWNER-APPROVED. You re-litigate nothing in D1-D14. Read, at minimum: the Owner rulings block,\n'
  + 'AMENDMENT 7 at the top, the Design decisions your task names below, the Global Constraints, the File\n'
  + 'Structure, your own Task section IN FULL, the Assertion Book rows your task owns, and the commit\n'
  + 'messages table. If this brief and the plan disagree about CODE, the plan wins - and say so in your\n'
  + 'report rather than silently choosing. If the plan is internally contradictory or contradicts the\n'
  + 'shipped tree, that is a PLAN DEFECT: report it with evidence, do not work around it (EXECUTE-METHOD\n'
  + 'section 6 - both such disclosures in an earlier pipeline were exactly right and cost nothing).'

const FINDINGS_INBOX = '/opt/hmis/docs/superpowers/plans/reports/plan-10-findings-inbox.md'

const INBOX_READ = 'STEP 0, BEFORE ANYTHING ELSE: read\n\n  ' + FINDINGS_INBOX + '\n\n'
  + 'If it exists it holds findings that EARLIER tasks in THIS pipeline recorded FOR YOU - facts about the\n'
  + 'surfaces you are about to build on that were discovered after this brief was compiled. If it does not\n'
  + 'exist, nothing was found; say so and move on.\n\n'
  + 'AND READ IT THE WAY 2.60 REQUIRES. A finding routed forward is a CLAIM, not a fact. The last pipeline\n'
  + 'routed a specific, well-argued, entirely false explanation through this exact channel and the\n'
  + 'downstream task believed it precisely because it was well argued. If an inbox entry EXPLAINS an\n'
  + 'observation, treat the explanation as a prediction under rule 21: verify the part you are about to\n'
  + 'rely on, and say in your report which part you ran and which part you only read.'

const INBOX_WRITE = 'IF YOU FIND SOMETHING A LATER TASK IN THIS PIPELINE MUST KNOW, WRITE IT DOWN WHERE THAT TASK WILL\n'
  + 'READ IT. The waves run BACK-TO-BACK with no human in the gap, so a finding that names a later task\n'
  + 'has nowhere to go unless you put it here:\n\n  ' + FINDINGS_INBOX + '\n\n'
  + 'APPEND to that file (never rewrite it) a dated entry naming the task it is for, what you found, and\n'
  + 'the evidence. Then also put it in your findings array. Do not assume anyone is between the waves.\n'
  + 'State plainly which part of the entry you EXECUTED and which part you REASONED (2.60).'

const CI_NOTE = 'CI: `gh` is installed on the build host but deliberately left UNAUTHENTICATED, so you cannot check\n'
  + 'CI and you must NOT fail anything for it (2.33). Report the CI item as DELEGATED TO THE MAIN SESSION,\n'
  + 'which is watching every commit on origin/main with docs/superpowers/pipelines/ci-watch.sh for the\n'
  + 'duration of this run. If you somehow can run `gh`: pass a FULL sha, and remember a CI result has\n'
  + 'THREE states - green, red, and DID NOT RUN - and the third reports identically to the second (2.59).'

const HALTS = 'HALT CONDITIONS - stop, commit nothing further, and report. These are the owner\'s, not mine:\n'
  + '  - A finding that would push this pipeline past SIX tasks.\n'
  + '  - A SECOND migration, or ANY new dependency. A `pnpm-lock.yaml` diff in any task is a halt.\n'
  + '    `pg-boss` is not a dependency of this repo and must not become one.\n'
  + '  - Any edit to `apps/core/src/kernel/events/dispatcher.ts` beyond the three envelope lines D5/GC10\n'
  + '    permit. The window predicate, the delivery claim, the cursor arithmetic and the backoff are\n'
  + '    BYTE-FROZEN.\n'
  + '  - Anything that would overturn D2\'s claim-before-send placement.\n'
  + '  - Anything that would weaken the D-33 deceased hard stop (Assertion Book N1) or the promotional\n'
  + '    refusal (N2). On this surface a polite pass is the worst available outcome: the machinery you\n'
  + '    are testing is what will one day message a real patient\'s family.\n'
  + '  - MIGRATION DEBRIS. AGENT-RULES section 6: if a migration has been applied and you must abandon,\n'
  + '    DO NOT delete the file and walk away - STOP and REPORT which migrations are applied to the\n'
  + '    worker databases. `git checkout` does not undo an applied migration.\n'
  + '  - A permission-system denial: record it VERBATIM and stop; never route around it with another tool.\n'
  + 'Everything else is yours to decide. Choose the most reasonable reading, finish the task, and list\n'
  + 'every such choice in your interpretations array.'

const FINISH = 'THE FINISH BLOCK - AGENT-RULES section 5, three numbered steps, never chained onto one line:\n'
  + '  0. BEFORE any `git add`: run `git status --porcelain` ON THE SERVER and READ IT. Delete every\n'
  + '     SERVER-side scratch file you made - mutants, scratch specs, .log, .exit, generated reports -\n'
  + '     with plain `rm -f`. LEAVE YOUR LOCAL MIRROR ALONE (rule 22(f)). The tree must contain ONLY\n'
  + '     files your Files list names.\n'
  + '  1. Commit with YOUR TASK\'S EXACT SUBJECT, quoted in the COMMIT MESSAGE block below.\n'
  + '  2. `git pull --rebase origin main`\n'
  + '  3. `git push origin main`\n'
  + 'Then report `git status` clean and the resulting commit SHA. If step 2 conflicts in a way you cannot\n'
  + 'resolve without rewriting pushed history, STOP and report - never amend, never force-push (rule 15).'

// ==== THE TASKS ==============================================================================
// `files` is the SECOND copy of the plan's File Structure rows for this task. The pre-flight
// asserts it EQUAL to the plan's, per task, both directions (2.54). If you amend one, amend both,
// in the same commit.

const TASKS = [
  {
    id: 't1',
    tier: 'ROUTINE',
    model: 'opus',
    wave: 1,
    deps: [],
    gate: false,
    commit: 'feat(core): migration 0015 — the notifications outbox, opt-in and deceased columns, staff phone',
    files: [
      'apps/core/drizzle/0015_<generated-name>.sql',
      'apps/core/drizzle/meta/*',
      'apps/core/src/kernel/db/schema/notifications.ts',
      'apps/core/src/kernel/db/schema/notifications.test.ts',
      'apps/core/src/kernel/db/schema/patients.ts',
      'apps/core/src/kernel/db/schema/auth.ts',
      'apps/core/src/kernel/db/schema/index.ts',
      'apps/core/test/helpers/db.ts',
    ],
    brief: `GOAL - Plan 10 Task 1. Ship migration 0015: the \`notifications\` outbox table, plus three columns
the gateway reads at send time. This is the ONLY migration in the whole plan.

READ IN THE PLAN: Task 1 (all five steps), D2, D4, D5, D9, D10, D12, Global Constraint 13, and the
"Consumed shipped surfaces" entries for \`patients\`, \`users\` and the truncate helper.

WHAT THE TABLE IS FOR, so you can judge your own columns: every would-be message becomes a row here
FIRST and nothing human ever blocks on it (GC1). A pump (T4, next wave but one) claims rows with
\`FOR UPDATE SKIP LOCKED\` BEFORE calling any adapter, because a WhatsApp message cannot be un-sent
(D2). Contact truth - phone, language, deceased state, merge state - is resolved at SEND time and is
deliberately NOT snapshotted here (D4). So this table stores WHO (patientId or userId), WHICH
template + params, WHEN it dies (expiresAt), and the claim/ladder state. Nothing else.

THE THREE COLUMNS AND WHY EACH EXISTS:
  - \`patients.promotional_opt_in boolean NOT NULL DEFAULT false\` - DPDP consent, captured at
    registration from go-live day one (D9). Default FALSE: opt-IN means the patient acted.
  - \`patients.deceased_at timestamptz NULL\` - D-33. Nothing in this schema records death today
    (measured: zero matches for deceased/died across apps/core/src). The gateway's hard stop reads
    this column from the first message; IPD's death cascade will write it later (D10).
  - \`users.phone text NULL\` - staff/owner external messages. Same normalized-10-digit convention as
    \`patients.phone\`; carry a comment saying so. Numbers are deployment data, not this plan's.

SECTION 6 IS THE RISK IN THIS TASK, NOT THE SQL. Running \`db:generate\` and letting a suite migrate
MUTATES EVERY PER-WORKER DATABASE and \`git checkout\` does not undo it. An earlier pipeline generated
a migration, applied it, deleted the file and walked away - fourteen orphan tables, a phantom
migration row in seven databases, origin/main itself red on the host, ~934k tokens, nothing
delivered. Generate 0015 only when you are ready to carry it to a commit. THE ROLLBACK IS STATED IN
THE PLAN BEFORE THE GENERATOR RUNS (Task 1 step 3) - read it, and after generating, CHECK IT AGAINST
THE GENERATED SQL and say in your report whether it still covers everything the generator emitted.
Commit the generator's FULL output (the .sql AND drizzle/meta/*), never a hand-edited subset, and
NEVER hand-edit drizzle/meta/_journal.json.

THE TRUNCATE EDIT IS THE OTHER TRAP AND IT IS SUBTLE (Task 1 step 4). \`notifications\` FKs into BOTH
\`patients\` AND \`users\`, and those two tables are truncated by TWO DIFFERENT statements in
apps/core/test/helpers/db.ts. Postgres checks whether an FK constraint POINTS AT the table being
truncated - constraint EXISTENCE, never row counts and never statement order - so \`notifications\`
must be named in BOTH statements. A separate earlier statement does not satisfy Postgres and every
schema test dies at setup before any assertion runs. The file already carries both ledger rules
verbatim in its comments, and \`approvals\` is the shipped precedent for one table appearing in two
statements. Get this wrong and wave 1 fails; get it right and nobody notices.

THE SCHEMA TEST (step 5): columns, defaults, uniques; an insert plus a dedupe-key conflict; FK
behaviour. Audience/recipient coherence is APP-enforced - state that in a comment rather than adding
CHECK constraints.

RISK TIER: ROUTINE. Tests are required and must pass. MUTANTS ARE NOT REQUIRED and fail-first is not
owed - say so in your report rather than manufacturing a red. If you NOTICE an assertion that cannot
discriminate, that is a finding and it is worth more than a mutant nobody asked for.`,
    criteria: [
      'apps/core/drizzle/ contains exactly one new migration, numbered 0015, and it is the generator\'s full unedited output; drizzle/meta/ is the generator\'s own update; drizzle/meta/_journal.json was not hand-edited.',
      'The report quotes the rollback statements from the plan\'s Task 1 step 3 CHECKED AGAINST the generated SQL, and states explicitly whether they still cover everything the generator emitted.',
      'schema/notifications.ts declares every column the plan\'s Task 1 step 1 names, with the unique index on dedupe_key and the (status, next_attempt_at) and (ref_type, ref_id) indexes; a comment states that audience/recipient coherence is app-enforced.',
      'patients gains promotional_opt_in (boolean NOT NULL DEFAULT false) and deceased_at (timestamptz NULL), each commented with its D-number; users gains phone (text NULL) with the normalization comment.',
      'apps/core/test/helpers/db.ts names `notifications` in BOTH truncate statements - the users-group statement and the opd/billing/patients-group statement - and the report quotes both edited lines.',
      'notifications.test.ts asserts columns, defaults, uniques, an insert, a dedupe-key conflict and FK behaviour, and its runner summary line is quoted by exact path.',
      'Detached `pnpm verify` on the build host with the exit VALUE read from a file is 0, and the per-workspace summary lines are quoted; no workspace total decreased and no test was deleted.',
      'The server tree is clean (`git status --porcelain` empty) and the commit touches only paths this task\'s Files list names.',
    ],
  },

  {
    id: 't2',
    tier: 'ROUTINE',
    model: 'sonnet',
    wave: 2,
    deps: ['t1'],
    gate: false,
    commit: 'feat(core): the template registry — five templates, two languages by type, four notify events',
    files: [
      'apps/core/src/kernel/notify/templates.ts',
      'apps/core/src/kernel/notify/templates.test.ts',
      'apps/core/src/kernel/notify/events.ts',
    ],
    brief: `GOAL - Plan 10 Task 2. Create the versioned template registry and the four notify events. Three new
files in a new directory \`apps/core/src/kernel/notify/\` (it does not exist yet; you create it).

READ IN THE PLAN: Task 2, D8 (the type is given VERBATIM there - transcribe it, do not improvise),
D12 (the four event payloads, exactly), D5 (why every template computes its OWN expiry), D9 (why the
promotional leg matters), Global Constraints 5, 11 and 12.

THE TYPE IS THE ENFORCEMENT. \`render: Record<"hi" | "en", (params) => string>\` means a template
missing a language DOES NOT COMPILE. That is deliberate and it is the whole reason the registry is
code rather than data. Do not widen it to a partial record for convenience.

THE FIVE TEMPLATES ARE ONLY THE ONES WITH LIVE PRODUCERS: patient_welcome, appointment_confirmed,
appointment_reminder, staff_escalation, owner_escalation_sms. The plan's D8 table gives each one's
audience, urgency, expiry anchor and EXACT params - and the params are exactly the producing event's
payload fields, nothing more. No doctor-name or patient-name lookups: \`kernel/notify\` imports no
module's TABLES (GC12), and staff/owner bodies carry no patient identity at all (GC5 - that is L8's
rule extended to outbound text, and it is a hard one).

THE COPY IS YOURS TO WRITE and it is real text a real person will one day read: short, factual,
bilingual, params interpolated, no names beyond the hospital's. \`owner_escalation_sms\` narrows its
own ladder to \`channels: ["sms"]\` (D6, fix 11 names SMS).

EVENTS (events.ts): four \`defineEvent\`s - notification.sent / .failed / .suppressed / .expired -
module \`notify\`, payloads EXACTLY as D12 states. \`defineEvent(name, module, payloadSchema, version=1)\`
lives in @hmis/contracts and it THROWS unless the name is lowercase \`entity.verb_past\`. The
envelope's own patientId column carries patient linkage; payloads do not duplicate it.
\`notification.delivered\` is deliberately NOT defined - an event with zero possible producers is a
vacuous assertion waiting to happen, and it arrives with the real provider.

MUTANT N2 IS YOURS AND IT IS A DELIBERATE TIER OVERRIDE (plan Pipeline Notes; EXECUTION-LESSONS 3.14).
This task is ROUTINE, but N2's work is fixture-discrimination, so it is exempted from "no mutants" and
you must do it properly. THE TRAP THE OVERRIDE EXISTS FOR: the shipped catalog contains ZERO
promotional templates, so an assertion that "no promotional template can be enqueued" would be
[] === [] - it passes forever and protects nothing (2.49). N2 therefore has TWO LEGS and SHIPPING
ONLY THE PIN IS A TASK FAILURE, stated here so you cannot read past it:
  (a) THE DISCRIMINATING LEG - a SYNTHETIC promotional template registered in a TEST-LOCAL registry,
      asserted to be refused. Your half of it is making the registry's shape admit such a fixture;
      the refusal itself is \`enqueueNotification\`, which is T4's. Build what leg (a) needs from this
      side and say in your report exactly what you left for T4, and write it into the findings inbox.
  (b) THE HONEST PIN - the SHIPPED catalog contains zero \`class: "promotional"\` entries. Label it in
      the test as the pin it is, not as the proof.

THE OTHER TESTS: registry keys match record keys; every version >= 1; every \`hi\` render for a PATIENT
template matches /[\\u0900-\\u097F]/ (verify-by-execution flag 2 - Devanagari, and you must SEE it pass,
not assume the range); \`expiresAt\` anchors per the D8 table (confirmation and reminder both die at
\`slotStart\`; welcome at occurredAt + 24 h; both escalations at occurredAt + 4 h).

RISK TIER: ROUTINE, with the N2 override above. Fail-first is not owed for the routine parts - say so
rather than manufacturing a red.`,
    criteria: [
      'apps/core/src/kernel/notify/templates.ts declares the NotificationTemplate type exactly as plan D8 states it, including `render: Record<"hi" | "en", ...>`, and exports notificationTemplates plus a throwing templateByKey accessor.',
      'All five catalog templates exist with the audience, urgency, class, expiry anchor and params the plan\'s D8 table gives; owner_escalation_sms narrows channels to ["sms"]; no template\'s params contain any field that is not in its producing event\'s payload.',
      'apps/core/src/kernel/notify/events.ts defines exactly four events - notification.sent, .failed, .suppressed, .expired - via defineEvent with module "notify" and the payloads D12 states; notification.delivered is NOT defined.',
      'N2 leg (b) ships as an explicitly-labelled pin: the shipped catalog contains zero promotional entries. The report states in one sentence what leg (a) still needs from T4, and the same statement is appended to the findings inbox.',
      'A test asserts every patient template\'s `hi` render contains Devanagari, and the report quotes the passing runner output for it (flag 2).',
      'Tests assert registry-key/record-key agreement, every version >= 1, and each template\'s expiresAt anchor against the D8 table.',
      'Detached `pnpm verify` with the exit VALUE read from a file is 0; per-workspace summary lines quoted; no total decreased and no test deleted.',
      'The server tree is clean and the commit touches only the three files this task\'s Files list names.',
    ],
  },

  {
    id: 't3',
    tier: 'ROUTINE',
    model: 'sonnet',
    wave: 2,
    deps: ['t1'],
    gate: false,
    commit: 'feat(core): channel adapters — console WhatsApp/SMS, provider selection, three defaulted keys',
    files: [
      'apps/core/src/kernel/notify/adapters.ts',
      'apps/core/src/kernel/notify/adapters.test.ts',
      'apps/core/src/kernel/config.ts',
      'apps/core/src/kernel/config.test.ts',
    ],
    brief: `GOAL - Plan 10 Task 3. The channel adapter interface with its console implementations, and three
new config keys. Small task, one sharp edge.

READ IN THE PLAN: Task 3, D11 (the ChannelAdapter type verbatim, and the honest semantics of
"sent"), and the "Consumed shipped surfaces" entry for \`kernel/config.ts\`.

adapters.ts: \`ChannelAdapter\` exactly as D11 gives it. \`consoleWhatsappAdapter\` and
\`consoleSmsAdapter\` log ONE structured line (channel, to, notificationId, first 80 chars of the
text) and return \`{ providerMessageId: null }\`. \`adaptersFor(cfg)\` returns the channel -> adapter map
for \`NOTIFY_PROVIDER\`, and it uses an EXHAUSTIVE SWITCH so that widening the enum fails compilation
until the new provider is mapped. That exhaustiveness is the point of the function; a lookup object
with a default would silently ship an unmapped provider.

WHAT \`sent\` MEANS, and the plan says this out loud rather than pretending otherwise: with a console
sink, "the adapter accepted the message" is a statement about the GATEWAY, not about delivery. Real
delivery, delivery callbacks and \`notification.delivered\` all arrive with the provider integration.

config.ts: three keys, ALL DEFAULTED, added to the zod schema, the AppConfig type and the loadConfig
mapping (that file hand-maintains all three - miss one and it will not compile, which is the good case):
  WORKER_NOTIFY_INTERVAL_MS  z.coerce.number().int().positive().default(5000)
  NOTIFY_PROVIDER            z.enum(["console"]).default("console")
  NOTIFY_STUCK_AFTER_MS      z.coerce.number().int().positive().default(300000)
Camel accessors beside the existing ones: workerNotifyIntervalMs, notifyProvider, notifyStuckAfterMs.

THE B1 SCAR IS WHY \`config.test.ts\` MATTERS MORE THAN IT LOOKS. NOTHING you add here may require a
value. The previous plan promised exactly this and was still CI-red for six consecutive commits -
not because a new key lacked a default, but because a wiring function reached for \`loadConfig()\`,
which parses the WHOLE environment through a schema in which \`DATABASE_URL\` is REQUIRED. A
config-defaults promise is discharged by the whole call graph, not by the new keys. So: assert in
\`config.test.ts\` that the three new defaults resolve from an EMPTY environment, in the shape that
file already uses, and do not introduce any new caller of \`loadConfig()\`.

NO .env CHANGE ANYWHERE - not on the server, not in CI, not in an example file. If you believe one is
needed, that is a finding, not an edit.

RISK TIER: ROUTINE. Tests required and passing; no mutants; fail-first not owed - say so.`,
    criteria: [
      'apps/core/src/kernel/notify/adapters.ts declares ChannelAdapter exactly as plan D11 gives it and exports consoleWhatsappAdapter, consoleSmsAdapter and adaptersFor.',
      'adaptersFor selects on NOTIFY_PROVIDER through an EXHAUSTIVE switch - the report shows or explains why adding an unmapped enum member would fail to compile.',
      'The console adapters emit one structured line containing channel, to, notificationId and a truncated body, and return { providerMessageId: null }; adapters.test.ts asserts both.',
      'kernel/config.ts gains WORKER_NOTIFY_INTERVAL_MS (5000), NOTIFY_PROVIDER (z.enum(["console"]).default("console")) and NOTIFY_STUCK_AFTER_MS (300000) in the zod schema, the AppConfig type AND the loadConfig mapping.',
      'config.test.ts asserts all three defaults resolve with an EMPTY environment, and the report quotes that test passing.',
      'No .env file anywhere is created or modified, and no new caller of loadConfig() is introduced.',
      'Detached `pnpm verify` with the exit VALUE read from a file is 0; per-workspace summary lines quoted; no total decreased and no test deleted.',
      'The server tree is clean and the commit touches only the four files this task\'s Files list names.',
    ],
  },

  {
    id: 't4',
    tier: 'CRITICAL',
    model: 'opus',
    wave: 3,
    deps: ['t1', 't2', 't3'],
    gate: true,
    commit: 'feat(core): the notification pump — claim-before-send, the suppression gauntlet, quiet hours, the ladder',
    files: [
      'apps/core/src/kernel/notify/enqueue.ts',
      'apps/core/src/kernel/notify/enqueue.test.ts',
      'apps/core/src/kernel/notify/pump.ts',
      'apps/core/src/kernel/notify/pump.test.ts',
      'apps/core/src/kernel/worker/jobs.ts',
      'apps/core/src/kernel/worker/jobs.test.ts',
      'apps/core/src/kernel/worker/scheduler.test.ts',
      'apps/core/test/worker-runtime.e2e.test.ts',
    ],
    brief: `GOAL - Plan 10 Task 4. The send path. This is the task where a defect reaches a person.

READ IN THE PLAN: Task 4 (all four steps), D2, D3, D4, D5, D6, D7, D11, D12, Global Constraints 1-9,
AMENDMENT 7 at the top of the plan, and Assertion Book rows N1, N2(a), N3, N4, N5, N7, N9, N13, N14,
N15 - every one of them is yours.

WHAT YOU ARE BUILDING:
  1. \`enqueue.ts\` - \`enqueueNotification(tx, input)\`: validate the template exists, THROW on
     \`class === "promotional"\` (this is N2's refusal and D9's whole Phase-1 mechanism), compute
     \`expiresAt = template.expiresAt(params, occurredAt)\`, insert \`ON CONFLICT (dedupe_key) DO
     NOTHING RETURNING id\`, return \`{id} | null\`. Plus \`expireByRef(tx, refType, refId, now)\` - the
     conditional UPDATE over \`status='queued'\` rows only, appending \`notification.expired\` per WON
     row. It must never touch a \`sending\` or \`sent\` row.
     T2 left you the other half of N2 leg (a) - read the findings inbox for what it says it left.
  2. \`pump.ts\` - \`runNotifyPump(db, opts?: { batchSize?, maxAttemptsPerRung?, stuckAfterMs?, now? })\`.
     Claim the batch with \`FOR UPDATE SKIP LOCKED\` and flip to \`sending\` BEFORE any adapter call.
     Then, PER ROW inside its own try/catch (one poison row never stalls the batch), the suppression
     gauntlet IN D4'S EXACT ORDER: expiry -> deceased -> promotional belt -> quiet-hours deferral ->
     channel resolution (merge chain and phone read AT SEND, never snapshotted). Render via
     \`templateByKey(...).render[language]\`; a render THROW is not a channel failure and never enters
     the ladder - straight to \`undeliverable\` + \`failed(render_error)\`, because retrying a render
     cannot fix params. Adapter send, then a GUARDED flip to \`sent\` (\`WHERE status='sending' ...
     RETURNING\`) and only a WON flip appends \`notification.sent\`. Failure: backoff min(2^attempts,
     60) s; rung advance at maxAttemptsPerRung; exhaustion or no-phone -> \`undeliverable\` +
     \`notification.failed\`. Stuck-\`sending\` recovery per D2/N14. Quiet hours per D7, ONE pure
     function, the only place that rule exists.
  3. \`jobs.ts\` - see AMENDMENT 7 below. This is the part that has already gone wrong once.

WHY THE CLAIM COMES FIRST, because you must not "fix" it: the dispatcher claims AFTER its handler
succeeds, deliberately, because its nightmare is LOSING an event. Yours is the mirror image - a
WhatsApp message cannot be un-sent - so the gateway's nightmare is SENDING TWICE. All three claim
placements in this codebase now exist with written reasoning. Moving this one is a HALT.

AMENDMENT 7 - THE PART THE PLAN GOT WRONG AND THE COMPILE FIXED. Registering a SEVENTH scheduler job
and widening \`JobIntervals\` breaks three shipped things, and the plan originally pointed at the wrong
file for them (\`jobs.test.ts\` holds NO job-name census; it tests only \`buildSubscriptionBus\`). Both
real files are IN YOUR FILES LIST and both are yours to grow:
  - \`src/kernel/worker/scheduler.test.ts\`: \`THE_SIX\` (:104) becomes seven; \`spyOnTheSix\` (:74) gains a
    SEVENTH spy on \`runNotifyPump\` - without it a REAL pump body runs inside jest against a live
    database on a 25-fake-hour advance, which GC8 forbids and which will hurt; and
    \`CENSUS_INTERVALS\` (:184) is a \`JobIntervals\` OBJECT LITERAL that stops typechecking the instant
    the Pick widens, so it needs the new key. Rename the helpers honestly if you grow them.
  - \`test/worker-runtime.e2e.test.ts\`: its OWN \`THE_SIX\` (:89) and
    \`expect(scheduler.jobs()).toEqual(THE_SIX)\` (:326). THIS FILE IS ALSO T5'S, ONE WAVE LATER - a
    deliberate two-owner file across SEQUENTIAL waves, carried forward per plan amendment 7. You
    grow its JOB census; T5 grows its PAIRS census. Touch nothing else in it, and say in your report
    exactly what you changed there so T5 reads the file as you left it.
  \`worker.ts\` needs NO edit: it passes the whole \`cfg\`, which satisfies the widened Pick structurally.
  \`worker.ts\` is T5's file and is FROZEN to you.

RISK TIER: CRITICAL. AGENT-RULES section 3's CRITICAL column binds you in full: build EVERY mutant the
Assertion Book names for this task, each as a SEPARATE SCRATCH FILE beside its source - never by
editing, moving or reverting the shipped file - run it ISOLATED and quote the isolation line from the
OUTPUT, and record DIED or SURVIVED with the ASSERTION's own expected-vs-received. Fail-first is owed.

READ RULE 21 AND ITS TWO NON-KILL TRAPS BEFORE YOU START. A mutant that dies at TYPECHECK proves
nothing: this repo compiles with \`noUncheckedIndexedAccess\`, so an indexed array literal dies at
TS2532 before any assertion runs; and a class with \`private\` members is compared NOMINALLY, so a
byte-copy of such a class cannot be passed to a function typed against the shipped one. When a mutant
will not compile, ask whether the obstacle is the LANGUAGE or the ASSERTION before rewriting either.
A DIED verdict is owed an assertion's own expected-vs-received, always.

N5 IS PRE-DECLARED AS A PREDICTION (2.57), AND THIS IS NOT A HALT. The Book names 20:59:59.999 /
21:00:00.000 / 07:59:59.999 / 08:00:00.000 IST plus an urgent row at 23:00. An "exact discriminating
input" written before any code exists is a claim like any other, and in the last plan the Book's own
stated input did not discriminate in EITHER direction. If both implementations survive on the stated
input, that routes to YOU ADJUSTING THE INPUT until it separates them and recording the confirmed
input and the verdict - not to accepting the mutant, and not to stopping the pipeline.

N1 IS THE ROW WHERE A POLITE PASS IS THE WORST OUTCOME. Deceased suppression beats urgency and beats
everything. Mark the patient deceased AFTER the row is enqueued, run a pump cycle with a RECORDING
adapter, and the shipped code must produce a \`suppressed\` row, a \`notification.suppressed(deceased)\`
event, and ZERO adapter calls. Delete the check and the adapter must be called. If you cannot make
the mutant reach that assertion, you have not built a mutant yet - say so.

TESTS DRIVE \`runNotifyPump\` DIRECTLY with an injected \`now\` and recording/failing fake adapters
(GC8: jest never goes through the Scheduler). No timing assertion may gate on a wall-clock mean or
median (GC9/10); this plan authors no performance budget.

TEST-RUN ECONOMY (AGENT-RULES 2.8): run the NARROW suite while iterating and the full workspace suite
ONCE, at the end. A full suite per iteration is the most expensive habit available to you.`,
    criteria: [
      'enqueueNotification validates the template, THROWS on promotional class, computes expiresAt from the template with occurredAt, inserts ON CONFLICT (dedupe_key) DO NOTHING RETURNING id, and returns {id} | null; expireByRef updates only status=\'queued\' rows and appends notification.expired per WON row.',
      'runNotifyPump claims with FOR UPDATE SKIP LOCKED and flips to \'sending\' BEFORE any adapter call, and mutant N4 (claim moved after the send) is built and DIES with the assertion\'s expected-vs-received quoted.',
      'The suppression gauntlet runs in D4\'s exact order and each stage is asserted: expiry, deceased, promotional belt, quiet-hours deferral, channel resolution with merge-chain and phone read at send time.',
      'N1 (deceased) is built as a mutant and DIES: shipped produces a suppressed row, a notification.suppressed(deceased) event and ZERO adapter calls; the mutant calls the adapter. Isolation line quoted from output.',
      'Every Assertion Book row this task owns - N1, N2(a), N3, N4, N5, N7, N9, N13, N14, N15 - has a built mutant with a DIED or SURVIVED verdict, counts, and the assertion\'s own expected-vs-received. No required-DIED survivor is silently fixed or silently accepted (AGENT-RULES section 3\'s two branches).',
      'N5\'s discriminating input is CONFIRMED BY EXECUTION to separate shipped from mutant; if the Book\'s stated boundary inputs did not, the report states the input that did and why.',
      'A render throw goes to undeliverable + failed(render_error) and never enters the ladder; a per-row try/catch means one poison row does not stall the batch; both are asserted.',
      'jobs.ts registers runNotifyPump as the seventh job with every: intervals.workerNotifyIntervalMs, and JobIntervals gains workerNotifyIntervalMs. src/worker.ts is NOT modified.',
      'scheduler.test.ts\'s job census and its spy helper both cover seven jobs, its JobIntervals literal carries the new key, and no real runNotifyPump body executes inside jest.',
      'test/worker-runtime.e2e.test.ts\'s job census covers seven jobs and NOTHING ELSE in that file was changed; the report states exactly what was changed there for T5 to read.',
      'apps/core/src/kernel/events/dispatcher.ts is not in the diff at all.',
      'Detached `pnpm verify` with the exit VALUE read from a file is 0; per-workspace summary lines quoted; no total decreased and no test deleted.',
      'The server tree is clean - no *.mutant.* and no scratch residue anywhere under /opt/hmis - and the commit touches only paths this task\'s Files list names.',
    ],
  },

  {
    id: 't5',
    tier: 'CRITICAL',
    model: 'opus',
    wave: 4,
    deps: ['t4'],
    gate: true,
    commit: 'feat(core): the notify consumer — five subscriptions, the owner-SMS dead-end, one importable consumers map',
    files: [
      'apps/core/src/kernel/notify/consumer.ts',
      'apps/core/src/kernel/notify/consumer.test.ts',
      'apps/core/src/kernel/notify/manifest.ts',
      'apps/core/src/kernel/alerts/manifest.ts',
      'apps/core/src/kernel/alerts/consumer.ts',
      'apps/core/src/kernel/alerts/consumer.test.ts',
      'apps/core/src/kernel/events/subscriptions.ts',
      'apps/core/src/kernel/events/dispatcher.ts',
      'apps/core/src/kernel/events/dispatcher.test.ts',
      'apps/core/src/kernel/worker/worker.module.ts',
      'apps/core/src/worker.ts',
      'apps/core/test/worker-runtime.e2e.test.ts',
    ],
    brief: `GOAL - Plan 10 Task 5. The consumer that turns events into outbox rows, the envelope widening it
needs, the desk flag that catches a patient nobody could reach, and the one importable consumers map
that closes the previous plan's booked residual.

READ IN THE PLAN: Task 5 (all five steps), D5, D6, D12, D13, Global Constraints 5, 10, 11, 12, 15,
AMENDMENT 7 at the top, Assertion Book rows N6, N8, N10, N11, N12, and the "Carried forward /
residuals" section.

  1. \`consumer.ts\` + \`manifest.ts\` - \`notifyConsumer(db): Handler\`, \`NOTIFY_CONSUMER = "kernel.notify"\`,
     and the FIVE subscriptions from D13's table, DECLARED (manifest) and HANDLED (consumer) in this
     one task. Amendment 6 made a declaration with no matching handler a BOOT ERROR, so the two
     halves are one edit and neither can ship alone. The handler holds NO other logic: rendering,
     suppression and channels are the pump's. Every enqueue is dedupe-keyed ON CONFLICT DO NOTHING
     (GC15 - at-least-once is inherited from the dispatcher, so redelivery must change nothing).
     Scheduling decisions read \`e.occurredAt\`, NEVER the wall clock, so a replay computes the same
     answer. \`escalation.triggered\` with \`fallbackExhausted\` enqueues \`owner_escalation_sms\` per
     holder of role \`owner\` - that is the owner-SMS half of fix 11 that \`alerts/consumer.ts:18\`
     has been promising in a comment.
  2. \`subscriptions.ts\` + \`dispatcher.ts\` + \`dispatcher.test.ts\` - \`DispatchedEvent\` gains
     \`occurredAt: Date\`. IN \`dispatcher.ts\` THAT IS EXACTLY THREE THINGS: one added select column
     (\`e.occurred_at as "occurredAt"\` in the :140-151 window query), one \`WindowRow\` field, and one
     line in the \`DispatchedEvent\` construction at :173-180. THE WINDOW PREDICATE, THE DELIVERY
     CLAIM, THE CURSOR ARITHMETIC AND THE BACKOFF ARE BYTE-FROZEN, the one-WHERE-chain shape is
     preserved, and \`event_cursors\` semantics are untouched. A diff in that file beyond those lines
     is a TASK FAILURE, not a judgement call (GC10). N11 pins that a handler receives the inserted
     row's own \`occurred_at\`, not \`now()\`.
  3. \`alerts/manifest.ts\` + \`alerts/consumer.ts\` + its test - the second subscription
     (\`notification.failed\` -> \`kernel.alerts\`) and the \`manual_notify\` branch per D6: PATIENT
     audience only, fan out to \`usersHoldingRole(tx, "duty_manager")\`, title built FROM
     \`templateKey\` ONLY, \`refType: "patient"\`, \`refId: patientId\`. An id, not an identity - the desk
     reaches the patient through permission-checked routes. GC5 and the alerts table's own header
     comment are the rule and L8/M-A2 is the mutant class. Alert uniqueness keys on the
     \`notification.failed\` EVENT's id so it cannot collide with an escalation alert on the same
     source event. Staff/owner failures raise no desk flag. NOTE: \`alerts/consumer.test.ts:141\`
     asserts \`alertsManifest.subscriptions\` with WHOLE-ARRAY equality - it must grow, and growing it
     is the point, not a chore.
  4. \`worker.module.ts\` - install \`notifyManifest\`, and EXTRACT
     \`workerConsumers(db): Record<string, Handler>\` returning BOTH entries. That function is the one
     importable place the production consumers map exists, and it CLOSES the previous gate report's
     booked item 1: \`worker.ts\` calls \`bootstrap()\` at import, so nothing could import the entry
     point to assert its half of the wire, and that is exactly how a worker that dispatched to
     nobody survived six tasks and two opus gates. \`worker.ts:36\` becomes
     \`registerAllJobs(scheduler, db, registry, workerConsumers(db), cfg)\`.
  5. \`worker-runtime.e2e.test.ts\` - INSTALLING \`notifyManifest\` MAKES THE TWO SHIPPED
     \`registerAllJobs(...)\` CALL SITES IN THIS FILE (:316 and :363, both passing only
     \`{ [ALERTS_CONSUMER]: alertsConsumer(workerDb) }\` against the CONTEXT'S OWN registry) THROW THE
     AMENDMENT-6 BOOT ERROR - five declared \`kernel.notify\` subscriptions with no handler. Both
     become \`workerConsumers(workerDb)\`. Then the pairs assertion, asserted WHOLE against the REAL
     registry and \`workerConsumers\`, sorted:
       [["kernel.alerts", ["escalation.triggered", "notification.failed"]],
        ["kernel.notify",  ["appointment.booked", "appointment.cancelled", "appointment.rescheduled",
                            "escalation.triggered", "patient.registered"]]]
     plus the boot-error leg for a declaration with no handler. Deleting either consumers-map entry
     must now fail this file (N12). T4 ALREADY GREW THIS FILE'S JOB CENSUS TO SEVEN (amendment 7) -
     read the file as T4 left it and do NOT restore six; T4's report says what it changed.

WHY N12 HAS TWO LEGS AND WHY THE PIN ALONE IS A FAILURE (2.49): every earlier seam test built a
PRIVATE registry inside the test file, so nothing anywhere read the registry production builds. The
whole-pairs equality against the BOOTED context is the leg with teeth; the boot-error leg is what
makes a half-wire fail loudly instead of silently. Ship both.

RISK TIER: CRITICAL. AGENT-RULES section 3's CRITICAL column in full: every mutant the Book names for
this task, separate scratch files, isolated runs with the isolation line quoted from OUTPUT, DIED or
SURVIVED with the assertion's own expected-vs-received. Fail-first is owed. Read rule 21's two
non-kill traps (TS2532 under noUncheckedIndexedAccess; nominal comparison of classes with \`private\`
members) before you build anything - and when a mutant will not compile, ask whether the obstacle is
the LANGUAGE or the ASSERTION before rewriting either. The fix that works for the second trap is to
copy the ONE intermediate module between mutant and test with only its \`import type\` line repointed.

N10 IS THE IDENTITY ROW AND IT IS ASSERTED WHOLE: a staff/owner enqueue's params must be EXACTLY
{defKey, state, rung, role} - \`toEqual\` on the whole object, from a patientful \`escalation.triggered\`,
so that a consumer copying \`e.patientId\` into params fails. Patient identity never enters a
staff-facing body or an alert column.

TEST-RUN ECONOMY (AGENT-RULES 2.8): narrow suite while iterating, full workspace suite ONCE at the end.`,
    criteria: [
      'notifyConsumer + notifyManifest declare AND handle exactly the five subscriptions in plan D13\'s table, in one commit; NOTIFY_CONSUMER is "kernel.notify".',
      'Every enqueue is dedupe-keyed ON CONFLICT DO NOTHING and N6 is built as a mutant that DIES: the same DispatchedEvent handled twice yields one row; the mutant yields two or throws.',
      'All scheduling decisions read e.occurredAt and never the wall clock; the reminder is enqueued only when slotStart - 24h is still at least 1h ahead of occurredAt.',
      'escalation.triggered with fallbackExhausted enqueues owner_escalation_sms per holder of role "owner" via usersHoldingRole.',
      'The dispatcher.ts diff is EXACTLY three things - one added select column, one WindowRow field, one construction line. The report quotes `git show --stat` and the actual dispatcher.ts hunk, and confirms the window predicate, delivery claim, cursor arithmetic and backoff are byte-identical.',
      'N11 is built and DIES: a handler receives the inserted row\'s own occurred_at; the mutant (now() or the dropped column) is caught by the assertion, expected-vs-received quoted.',
      'alertsManifest gains the notification.failed subscription, alerts/consumer.test.ts:141\'s whole-array assertion is grown accordingly, and the manual_notify branch fans out to duty_manager holders with a title built from templateKey only, refType "patient", refId patientId, keyed on the notification.failed event id.',
      'N8 is built and DIES: with both fakes always throwing, the undeliverable + notification.failed path produces a manual_notify alert row per duty_manager; deleting the branch produces none. N10 asserts staff/owner params WHOLE as {defKey, state, rung, role}.',
      'worker.module.ts installs notifyManifest and exports workerConsumers(db) returning both entries; worker.ts:36 calls registerAllJobs(scheduler, db, registry, workerConsumers(db), cfg).',
      'worker-runtime.e2e.test.ts: both registerAllJobs call sites pass workerConsumers(workerDb); the pairs assertion is whole-equality against the BOOTED context\'s own registry in the sorted shape the brief gives; the boot-error leg is present; the seven-job census T4 left is intact.',
      'Every Assertion Book row this task owns - N6, N8, N10, N11, N12 - has a built mutant with a DIED or SURVIVED verdict, counts, and the assertion\'s own expected-vs-received. No required-DIED survivor is silently fixed or silently accepted.',
      'Detached `pnpm verify` with the exit VALUE read from a file is 0; per-workspace summary lines quoted; no total decreased and no test deleted.',
      'The server tree is clean - no *.mutant.* and no scratch residue - and the commit touches only paths this task\'s Files list names.',
    ],
  },

  {
    id: 't6',
    tier: 'ROUTINE',
    model: 'sonnet',
    wave: 5,
    deps: ['t5'],
    gate: false,
    commit: 'feat(web): opt-in at registration, deceased on the patient record, the notify strings',
    files: [
      'apps/core/src/modules/patients/patients.controller.ts',
      'apps/core/src/modules/patients/registration.ts',
      'apps/core/src/modules/patients/registration.test.ts',
      'apps/web/src/screens/registration-desk.tsx',
      'apps/web/src/screens/registration-desk.test.tsx',
      'apps/web/src/screens/patient-detail.tsx',
      'apps/web/src/screens/patient-detail.test.tsx',
      'apps/web/src/locales/en.json',
      'apps/web/src/locales/hi.json',
    ],
    brief: `GOAL - Plan 10 Task 6. The human surfaces for the two columns T1 shipped: a consent answer captured
at registration, and a way to mark a patient deceased. Both are patient-master edits on routes that
already exist.

READ IN THE PLAN: Task 6, D9, D10, verify-by-execution flag 5, and the "Consumed shipped surfaces"
entry for \`patients.controller.ts\`.

API (\`patients.controller.ts\`): the POST body gains \`promotionalOptIn: z.boolean().default(false)\`.
The PATCH body gains \`promotionalOptIn: z.boolean()\` and \`deceasedAt: z.string().datetime().nullable()\`,
BOTH OPTIONAL in PATCH. \`registration.ts\` persists the opt-in on create, and the SHIPPED update path
diffs both fields into \`patient.updated\`'s \`changes\` array - so marking deceased AND clearing it are
both audited, which is the point of putting it through the existing diff rather than beside it.

NO NEW PERMISSION IS MINTED. The routes' existing guards stand. If you find yourself wanting one,
that is a finding, not an edit.

WEB: \`registration-desk.tsx\` gets ONE checkbox, UNCHECKED BY DEFAULT, posted with registration -
"opt-IN" means the patient actively said yes, and a pre-checked box is not consent.
\`patient-detail.tsx\` gets the opt-in toggle and a deceased mark/clear control (a date plus a
confirm). \`SubmitButton\` mounts on BOTH new writes - that is the shipped single-submit convention
(the component exists at apps/web/src/components/submit-button.tsx). Strings go in
\`locales/en.json\` AND \`locales/hi.json\`; a key in one and not the other is a defect.

SCREEN TESTS: the checkbox defaults OFF and its value is what gets posted; the deceased mark and
clear round-trip; the PATCH payloads are asserted EXACTLY - not "contains", exactly, because "we
sent something" is not the claim.

FLAG 5 IS YOURS TO DISCHARGE IN \`registration.test.ts\`: a registration POST with the checkbox on
persists \`promotional_opt_in = true\`, and a PATCH marking deceased lands in \`patient.updated.changes\`.

RISK TIER: ROUTINE. Tests required and passing; no mutants; fail-first not owed - say so rather than
manufacturing a red. If you notice an assertion that cannot discriminate, that is a finding.

apps/web runs VITEST, not jest. apps/core runs jest. Do not carry one runner's flags to the other.`,
    criteria: [
      'patients.controller.ts POST body gains promotionalOptIn: z.boolean().default(false); PATCH body gains optional promotionalOptIn: z.boolean() and deceasedAt: z.string().datetime().nullable().',
      'registration.ts persists promotionalOptIn on create, and the shipped update path diffs BOTH promotionalOptIn and deceasedAt into patient.updated\'s changes array so marking and clearing are both audited.',
      'No new permission is minted and no route guard is changed.',
      'registration-desk.tsx renders one checkbox that is unchecked by default and posts its value; registration-desk.test.tsx asserts both the default and the posted value.',
      'patient-detail.tsx renders the opt-in toggle and a deceased mark/clear control, both mounting SubmitButton; patient-detail.test.tsx asserts the set/clear round-trip and the EXACT PATCH payloads.',
      'locales/en.json and locales/hi.json both gain every new key - no key exists in one file and not the other.',
      'Flag 5 is discharged in registration.test.ts: a POST with the checkbox on persists promotional_opt_in = true, and a PATCH marking deceased appears in patient.updated.changes. The report quotes both assertions passing.',
      'Detached `pnpm verify` with the exit VALUE read from a file is 0; per-workspace summary lines quoted for apps/core, apps/web and packages/contracts; no total decreased and no test deleted.',
      'The server tree is clean and the commit touches only paths this task\'s Files list names.',
    ],
  },
]

// ==== GENERATED BLOCKS =======================================================================
// 2.25: the frozen-path block is GENERATED from the tasks' own `files` arrays. Two hand-maintained
// lists of the same fact drift by construction, and the drift ships as a brief that FORBIDS what
// the plan REQUIRES. A file owned by TWO tasks (here: test/worker-runtime.e2e.test.ts, T4 then T5,
// sequential waves) is frozen to NEITHER of them and to everyone else - which falls out of the set
// arithmetic below rather than being special-cased.

function frozenBlock(t) {
  const mine = new Set(t.files)
  const others = []
  for (const o of TASKS) {
    if (o.id === t.id) continue
    for (const f of o.files) if (!mine.has(f) && !others.includes(f)) others.push(f)
  }
  return 'FILES YOU MAY TOUCH - this list is exhaustive and it is also your SYNC LIST (rule 22(c)):\n'
    + t.files.map(f => '  ' + f).join('\n')
    + '\n\nOWNED BY OTHER TASKS IN THIS PIPELINE - DO NOT TOUCH THEM, EVEN IF YOUR CHANGE WOULD BE CORRECT:\n'
    + others.map(f => '  ' + f).join('\n')
    + '\n\nAND NOTHING ELSE IN THE REPOSITORY IS YOURS EITHER. If you find yourself needing to edit a file\n'
    + 'this list does not name, STOP: that is either a scope violation or a PLAN DEFECT, and the right\n'
    + 'move is to report it with evidence, not to work around it. If you find yourself SYNCING a file\n'
    + 'your Files list does not name, that is a scope violation and not a sync problem (rule 22(c)).'
}

function commitBlock(t) {
  return 'COMMIT MESSAGE - the subject line is EXACT. It comes from the plan\'s own commit-messages table,\n'
    + 'which exists because the previous plan omitted it and AGENT-RULES section 5 step 1 resolved to\n'
    + 'nothing:\n\n  ' + t.commit + '\n\nA body is welcome; the subject is not yours to reword.'
}

function tierBlock(t) {
  return 'RISK TIER: ' + t.tier + '. AGENT-RULES section 3 is the definition and it binds you; the task body\n'
    + 'above states what that means for this specific task.'
}

function briefFor(t) {
  return [
    RULES,
    INBOX_READ,
    MIRROR,
    PLAN_POINTER,
    BASELINE,
    t.brief,
    tierBlock(t),
    frozenBlock(t),
    HALTS,
    CI_NOTE,
    commitBlock(t),
    FINISH,
  ].join('\n\n' + '-'.repeat(92) + '\n\n')
}

// ==== SCHEMAS ================================================================================

const REPORT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['outcome', 'files_changed', 'tests', 'interpretations'],
  properties: {
    outcome: { type: 'string' },
    files_changed: { type: 'array', items: { type: 'string' } },
    tests: { type: 'string' },
    interpretations: { type: 'array', items: { type: 'string' } },
  },
}

const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdict', 'violations', 'corrections', 'tests'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    violations: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['type', 'detail'],
        properties: {
          type: { type: 'string', enum: ['criterion-unmet', 'test-failure', 'scope-creep', 'overengineering', 'bad-interpretation', 'agent-error'] },
          detail: { type: 'string' },
        },
      },
    },
    corrections: { type: 'array', items: { type: 'string' } },
    retry_mode: { type: 'string', enum: ['reimplement', 'verify-only'] },
    findings: { type: 'array', items: { type: 'string' } },
    tests: {
      type: 'object', additionalProperties: false, required: ['ran', 'passed', 'failed'],
      properties: { ran: { type: 'string' }, passed: { type: 'number' }, failed: { type: 'number' } },
    },
  },
}

const DISCOVERY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['summary', 'findings'],
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['severity', 'where', 'what', 'evidence'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'note'] },
          where: { type: 'string' },
          what: { type: 'string' },
          evidence: { type: 'string' },
        },
      },
    },
  },
}

// ==== PROMPTS ================================================================================
// 2.32: EVERY agent this script spawns renders RULES. Coders, gates, mechanical checkers and the
// discovery reviewer alike. `coders.concat(gates)` excludes checkers and the reviewer BY
// CONSTRUCTION, which is exactly how a reviewer once shipped without the rules pointer and wrote
// four files to the build host's /tmp - the absolute prohibition of rule 3, which it had never
// been shown. The pre-flight asserts this over ALL of them.

const SEP = '\n\n' + '-'.repeat(92) + '\n\n'

function coderPrompt(t, history) {
  let p = briefFor(t)
  p += SEP + 'Acceptance criteria your work must meet:\n' + t.criteria.map(c => '- ' + c).join('\n')
  p += '\n\nIf any part of this brief is ambiguous, choose the most reasonable interpretation, complete the task,'
  p += ' and list every such choice in the interpretations field of your report. Never expand scope beyond the brief.'
  p += '\n\nIf a tool call is denied by the permission system, do not attempt the same change through another tool'
  p += ' or shell command; stop and record the denial VERBATIM in the outcome field of your report.'
  if (history && history.length) {
    p += '\n\nA reviewer FAILED ' + history.length + ' previous attempt(s) at this task. Full failure history, oldest first:'
    history.forEach(function (v, idx) {
      p += '\nAttempt ' + (idx + 1) + ' violations: ' + v.violations.map(function (x) { return x.type + ' - ' + x.detail }).join('; ')
      p += '\nAttempt ' + (idx + 1) + ' corrections: ' + v.corrections.join('; ')
    })
    if ((history[history.length - 1] || {}).retry_mode === 'verify-only') {
      p += '\nThe reviewer judged the implementation itself CORRECT AND COMPLETE. Do not rewrite, re-generate, or'
        + ' re-commit the code. This attempt is verification only: re-run the required commands, capture their real'
        + ' output, and satisfy every correction with evidence. Do NOT manufacture a fail-first run by mutating'
        + ' shipped state (no throwaway databases, no relocating or deleting source files) - if a legitimate red run'
        + ' is impossible without mutating what already shipped, say so plainly in interpretations and quote the'
        + ' evidence you can legitimately obtain.'
    } else {
      p += '\nThe files are currently in the state the most recent attempt left them. Apply every correction.'
    }
  }
  return p
}

function gatePrompt(t, report) {
  return RULES + SEP + INBOX_WRITE + SEP + MIRROR + SEP + PLAN_POINTER + SEP + CI_NOTE
    + SEP + 'Review one completed implementation task. This is a CRITICAL-tier task, which is why it has a'
    + ' full gate rather than a mechanical check.\n\nTask brief given to the coder:\n' + briefFor(t)
    + SEP + 'Acceptance criteria:\n' + t.criteria.map(c => '- ' + c).join('\n')
    + '\n\nCoder report (JSON):\n' + JSON.stringify(report)
    + '\n\nRead the changed files yourself, re-run the covering tests yourself, check every criterion one by one.'
    + ' Fail scope creep (changes beyond the brief and criteria) and overengineering (speculative abstractions,'
    + ' unrequested features). Rule on each flagged interpretation.'
    + '\n\nTHE MUTANTS ARE THE POINT OF THIS GATE. Rule 21: a hand-walk of "a wrong implementation would produce X"'
    + ' is a PREDICTION, not evidence, and it has been wrong in BOTH directions in the same plan. For every'
    + ' required-DIED row in this task\'s Assertion Book, confirm from the coder\'s OUTPUT that a mutant was built as'
    + ' a separate scratch file, run ISOLATED, and killed by an ASSERTION with its own expected-vs-received quoted.'
    + ' A mutant that died at TYPECHECK proves nothing (noUncheckedIndexedAccess makes an indexed array literal die'
    + ' at TS2532; a class with `private` members is compared NOMINALLY so a byte-copy cannot be passed to a function'
    + ' typed against the shipped one) and neither does one that died by TIMEOUT. Where you doubt a kill, REBUILD THE'
    + ' MUTANT YOURSELF - that is what caught the last plan\'s surviving census mutant.'
    + '\n\nEVIDENCE DISCIPLINE (binding on you, not only on the coder). (a) A test-name filter must ISOLATE, and you'
    + ' must confirm isolation from the OUTPUT, never from an exit code: `pnpm --filter <pkg> test -- <path>'
    + ' --testNamePattern=X` does NOT isolate - pnpm injects a literal `--`, yargs stops option parsing, and the'
    + ' pattern becomes a second PATH pattern, so the whole suite runs and a 1-in-N flake reports as N/N clean. Use'
    + ' `pnpm --filter @hmis/core exec jest --passWithNoTests <path> -t "<name>"` and read the "N skipped, 1 passed"'
    + ' line. (b) Never take a pipeline\'s or a wrapper\'s exit status as a command\'s verdict (`| tail` exits 0 when'
    + ' the command failed; `; echo "exit: $?"` exits 0 because the echo succeeded) - read a captured exit file or run'
    + ' the command unpiped, and read the VALUE. This trap fires on NEGATIVE CONTROLS too, where it produces a false'
    + ' FAIL on the instrument and gets a working probe "fixed" (2.52). (c) NEVER lower an evidence bar an earlier'
    + ' gate on this same task already set. (d) Before trusting any timing, race or flake measurement, confirm'
    + ' nothing else is running - and READ THE MATCHED COMMAND LINES of `pgrep -af jest`, never the count: that'
    + ' compound shell contains the literal string `jest` and matches ITSELF (2.53). (e) YOUR OWN scratch obeys the'
    + ' same hygiene rule the coder has: under /opt/hmis, never /tmp, deleted with plain `rm -f` before you return,'
    + ' and your local mirror LEFT IN PLACE (rule 22(f)). Confirm the working tree is clean of your own residue and'
    + ' say so.'
    + '\n\nRECORD WHAT YOU DISCOVER THAT DOES NOT FAIL THE TASK. If your verification turns up anything worth keeping'
    + ' that is not a violation - a mutant you built unprompted that SURVIVED, an acceptance criterion that claims a'
    + ' proof its test cannot deliver, a latent defect outside this task\'s scope, an assumption in the brief you'
    + ' found to be false - put each one in the findings array as its own entry, and pass the task anyway if the'
    + ' criteria are met. Do NOT bury such a discovery inside the tests.ran string or a correction: findings is the'
    + ' only field that survives into the pipeline report, and a discovery recorded nowhere else dies with your'
    + ' transcript.'
    + '\n\nIf you fail the task, set retry_mode: "verify-only" when the implementation itself is correct and complete'
    + ' and your corrections only ask for verification, evidence, or cleanup outside the code; "reimplement" when'
    + ' code must actually change. Never write a correction that asks the next agent to discard, revert, or delete'
    + ' anything in a working tree the user did not name for destruction - report such residue and leave it in place.'
    + ' Never write a correction that instructs rewriting published history (git commit --amend, git rebase, git'
    + ' reset --hard, git push --force or --force-with-lease) on a commit that has already been pushed, INCLUDING one'
    + ' this pipeline pushed minutes ago - the only correct fix for an already-pushed commit is a NEW follow-up commit.'
}

function mechanicalPrompt(t, report) {
  return RULES + SEP + INBOX_WRITE + SEP + MIRROR + SEP + CI_NOTE
    + SEP + 'You are the MECHANICAL CHECK on one completed ROUTINE task. You are NOT a design reviewer: you verify'
    + ' that what was claimed actually happened. Do not re-litigate the approach, and do not fail the task for a'
    + ' judgement you would have made differently. Fail it for a claim that is not true.'
    + '\n\nWHY YOU EXIST AT ALL, so you know what your verdict is for: this pipeline runs its waves BACK-TO-BACK with'
    + ' no human in the gap. A task nothing judges cannot FAIL, and a task that cannot fail cannot trip the'
    + ' wave-stall break - so five later tasks would run on top of a broken one before anybody looked (2.50). Your'
    + ' verdict is the thing that stops the chain in time. Wave 1 APPLIES A MIGRATION, which is an irreversible'
    + ' mutation of shared host state that `git checkout` does not undo.'
    + '\n\nTask brief:\n' + briefFor(t)
    + SEP + 'Acceptance criteria:\n' + t.criteria.map(c => '- ' + c).join('\n')
    + '\n\nImplementer report (JSON):\n' + JSON.stringify(report)
    + '\n\nTHE CHECKLIST - run each one YOURSELF on the build host and quote what you observed:\n'
    + '1. `pnpm verify`, run DETACHED, with the exit VALUE read from a file. Never a pipeline\'s exit status'
    + ' (`| tail` exits 0 when the command failed) and never a wrapper\'s (`; echo "exit: $?"` exits 0 because the'
    + ' echo succeeded) - read the VALUE.\n'
    + '2. `git show --stat` of the ACTUAL commit against the task\'s Files list - never against the implementer\'s'
    + ' summary of it. Every path in the diff must be named by the Files list.\n'
    + '3. A frozen-path grep over that same diff. Any hit is a violation.\n'
    + '4. CI: delegated to the main session, per the CI block above. Report it as delegated; do NOT fail the task'
    + ' for it.\n'
    + '5. The server tree is clean: `git status --porcelain` EMPTY, no mutant, no scratch, no .log or .exit residue'
    + ' anywhere under /opt/hmis.\n'
    + '6. Workspace test totals did not DECREASE and the diff deletes no test. Quote the runner summary lines.\n'
    + '7. Each acceptance criterion, one by one, against what you can actually observe.\n'
    + '8. YOUR OWN scratch obeys the same hygiene rule: under /opt/hmis, NEVER /tmp, deleted with plain `rm -f`'
    + ' before you return. Leave your local mirror in place; do not try to delete it (rule 22(f)).'
    + '\n\nWHERE THE TASK APPLIED A MIGRATION: also confirm the drizzle output in the diff is the generator\'s FULL'
    + ' output, that drizzle/meta/_journal.json shows exactly one new entry, and that no migration file was created'
    + ' and then removed. If a migration was applied and then abandoned, that is AGENT-RULES section 6 territory:'
    + ' report which migrations are applied, and never clean up by hand.'
    + '\n\nRECORD WHAT YOU DISCOVER THAT DOES NOT FAIL THE TASK in the findings array - it is the only field that'
    + ' survives into the pipeline report. And when you route a finding forward into the inbox, say which part you'
    + ' EXECUTED and which part you REASONED: the last pipeline propagated a specific, well-argued, entirely false'
    + ' explanation through that channel and it was believed precisely because it was well argued (2.60).'
    + '\n\nSet retry_mode "verify-only" when the code is right and only evidence or cleanup is missing; "reimplement"'
    + ' when code must change. Never instruct rewriting published history.'
}

const DISCOVERY_PROMPT = RULES + SEP + MIRROR + SEP + PLAN_POINTER + SEP + CI_NOTE
  + SEP + 'You are the ONE DISCOVERY REVIEWER for this pipeline (EXECUTE-METHOD v2 section 4). You read ALL SIX'
  + ' commits TOGETHER. You are not a seventh gate and you do not re-judge tasks that already passed.\n\n'
  + 'YOUR JOB IS THE CLASS OF FINDING A PER-TASK GATE STRUCTURALLY CANNOT SEE:\n'
  + '  - a defect shipped DORMANT by one task and ARMED by a later one;\n'
  + '  - a convention several tasks honour that no test protects;\n'
  + '  - an assertion that looks like a reconciliation but is actually `[] === []` (2.49);\n'
  + '  - a test that SETS configuration without asserting the configuration took effect (2.60);\n'
  + '  - a claim in one task\'s report that a later task\'s code silently contradicts;\n'
  + '  - a wire with two halves where only one half is protected by a test.\n\n'
  + 'THE SPECIMENS THIS PROJECT HAS ALREADY PAID FOR, so you know what to hunt:\n'
  + '  - A worker that dispatched to NOBODY for six tasks and two opus gates, because every seam test built a'
  + ' PRIVATE registry and none read the one production builds. Ask of every assertion in this pipeline: could this'
  + ' pass if the production wiring were absent?\n'
  + '  - A census that asserted a SET and therefore could not see a mutation that preserved the set.\n'
  + '  - A `WORKER_DAILY_TICK_MS` override that was read by nobody, with a long persuasive comment explaining a'
  + ' margin that had never existed.\n\n'
  + 'THE SURFACES THIS PLAN MAKES WORTH LOOKING AT: the suppression gauntlet\'s ORDER (does anything actually pin'
  + ' that expiry is checked before deceased, and deceased before everything else?); the claim-before-send placement'
  + ' against the dispatcher\'s deliberately opposite one; whether the promotional refusal is protected by anything'
  + ' that could fail; whether quiet hours really exists in exactly ONE place; whether patient identity can reach a'
  + ' staff-facing body or an alert column by any path; and whether `workerConsumers` is actually the ONLY place the'
  + ' production consumers map exists.\n\n'
  + 'Read the six commits with `git log`/`git show` on the build host, read the plan, and RUN things - a finding you'
  + ' executed outranks six you reasoned. Rule 21 binds you: if you claim an assertion cannot discriminate, BUILD'
  + ' THE MUTANT and show it surviving, with the assertion\'s own output. Where you only reasoned, say so.\n\n'
  + 'Return findings as data. `blocker` means something is WRONG IN THE SHIPPED CODE and you have the evidence;'
  + ' `major` means a real gap in protection; `minor` and `note` are for the ledger. Empty findings is an acceptable'
  + ' answer if you genuinely found nothing - but say what you looked at and what you ran, because "I found nothing"'
  + ' and "I looked at nothing" report identically otherwise.\n\n'
  + 'YOUR OWN scratch: under /opt/hmis, never /tmp, deleted with plain `rm -f` before you return. Leave your local'
  + ' mirror in place. CHANGE NO SOURCE FILE AND COMMIT NOTHING - you are a reader.'

// ==== THE RUNNER =============================================================================

const results = {}
const failed = new Set()

async function runTask(t) {
  const unmet = t.deps.filter(d => (results[d] || {}).status !== 'done')
  if (unmet.length) {
    results[t.id] = { status: 'skipped', reason: 'dependency not done: ' + unmet.join(',') }
    failed.add(t.id)
    return
  }
  const history = []
  // A rung advances ONLY on a real gate rejection. Infrastructure failures (a dead coder, a dead
  // judge) retry the SAME rung and never promote the model: an API 529 is not a code defect and
  // must not cost an escalation (2.1).
  const LADDER = [
    { model: t.model, label: t.model + ':' + t.id },
    { model: t.model, label: 'retry:' + t.id },
    { model: 'opus', label: 'escalate:' + t.id },
  ]
  const MAX_INFRA = 3
  let infra = 0
  for (let rung = 0; rung < LADDER.length; ) {
    const a = LADDER[rung]
    const report = await agent(coderPrompt(t, history), { model: a.model, label: a.label + (infra ? '~' + infra : ''), phase: 'Wave ' + t.wave, schema: REPORT_SCHEMA })
    if (!report) {
      if (++infra > MAX_INFRA) {
        results[t.id] = { status: 'failed', reason: 'infrastructure: coder unavailable', attempts: rung + 1, history }
        failed.add(t.id)
        return
      }
      log(t.id + ': coder infra failure ' + infra + ' - same rung, model unchanged')
      continue
    }
    // A dead judge re-judges the SAME report. It must never trigger a fresh coder attempt.
    const isGate = t.gate
    let verdict = null
    for (let g = 0; g <= MAX_INFRA; g++) {
      verdict = await agent(
        isGate ? gatePrompt(t, report) : mechanicalPrompt(t, report),
        {
          model: isGate ? 'opus' : 'sonnet',
          label: (isGate ? 'gate:' : 'check:') + t.id + '#' + (rung + 1) + (g ? '~' + g : ''),
          phase: 'Wave ' + t.wave,
          schema: VERDICT_SCHEMA,
        },
      )
      if (verdict) break
      infra++
      log(t.id + ': judge infra failure ' + infra + ' - re-judging the same work, no new coder attempt')
    }
    if (!verdict) {
      results[t.id] = { status: 'failed', reason: 'infrastructure: judge unavailable', attempts: rung + 1, history }
      failed.add(t.id)
      return
    }
    if (verdict.verdict === 'pass') {
      results[t.id] = { status: 'done', attempts: rung + 1, files: report.files_changed, tests: verdict.tests, interpretations: report.interpretations, findings: verdict.findings }
      return
    }
    history.push(verdict)
    log(t.id + ': rung ' + (rung + 1) + ' rejected - ' + verdict.violations.map(v => v.type).join(',') + (verdict.retry_mode === 'verify-only' ? ' (verify-only retry)' : ''))
    rung++
  }
  results[t.id] = { status: 'failed', attempts: LADDER.length, history }
  failed.add(t.id)
}

const waves = [...new Set(TASKS.map(t => t.wave))].sort((a, b) => a - b)
// THE WAVE-STALL BREAK (2.23). NOT redundant with the dependency edges: the edges mark later tasks
// `skipped`, but the break is what stops the run from spending its budget discovering that.
let stalled = false
for (const w of waves) {
  phase('Wave ' + w)
  const inWave = TASKS.filter(t => t.wave === w)
  await parallel(inWave.map(t => () => runTask(t)))
  if (inWave.some(t => (results[t.id] || {}).status !== 'done')) {
    log('wave ' + w + ' did not complete - stopping the run rather than letting later waves discover it')
    stalled = true
    break
  }
}

let discovery = null
if (!stalled) {
  phase('Discovery')
  discovery = await agent(DISCOVERY_PROMPT, { model: 'opus', label: 'discovery:plan10', phase: 'Discovery', schema: DISCOVERY_SCHEMA })
}

return {
  tasks: results,
  stalled,
  halted: [...failed],
  discovery,
  summary: Object.values(results).filter(r => r.status === 'done').length + '/' + TASKS.length + ' done',
}
