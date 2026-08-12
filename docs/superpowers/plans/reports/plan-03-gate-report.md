# Plan 03 — Workflow Engine: Gate Report

- **Plan:** `docs/superpowers/plans/2026-08-12-phase1-03-workflow-engine.md` (approved as committed `bb4f492`)
- **Executed:** 2026-08-12, two pipelines — `wf_d174a89f-e01` (T1–T5) and `wf_7b7664bd-c3f` (T6–T10)
- **Status:** **10/10 tasks passed their Opus gate.** The generic workflow engine is live, tested, and pushed.
- **Purpose:** ground truth for the next planning session. Where this report and the plan text disagree, **this report is authoritative**.
- **Verified independently by the main session** (not only by agents): `pnpm verify` exit 0 on the server at `6a9d75c` — **35 suites, 152 tests** (7 in `@hmis/contracts`, 145 in `@hmis/core`), typecheck clean, lint zero problems. CI green on **all twelve** pushed commits, latest `31629958395`.

---

## 1. Build environment — what changed since Plan 02

Everything in plan-02 gate report §1 still holds. **This plan changed the environment almost not at all, by design:**

| Fact | Value |
|---|---|
| New dependencies | **none** — `package.json` and `pnpm-lock.yaml` untouched in both root and core |
| New env vars | **none** — `.env.example` untouched; the engine needs no config values |
| CI / jest config | **untouched** — `.github/workflows/*` and `jest.config.cjs` unchanged, and no agent asked to change them |
| Migration | `0004_white_hydra.sql` — 5 tables, FKs, and the partial unique index; applied to `hmis_dev` and verified live |
| Kernel isolation | nothing under `src/kernel/auth/`, `src/kernel/events/`, or `src/kernel/modules/` was modified. The `events` table schema was not touched |
| Test helper | `apps/core/test/helpers/db.ts` gained **one** `truncate` statement for the workflow FK group; `setupTestDb` and `truncateAll` signatures are byte-identical to `bb4f492` |

The plan's "zero dependencies, zero env vars, zero CI changes" design goal **held exactly** — the first plan in this series to change nothing about the build.

---

## 2. Task outcomes

| Task | Result | Attempts | Commit |
|---|---|---|---|
| T1 `defineWorkflow` validation library | pass | 1 | `d332872` |
| T2 Schema (migration 0004) + five event defs | pass | 1 | `2d214ec` |
| T3 Role-holding helpers | pass | 1 | `7eaf0f4` |
| T4 Definition drafts, versioning, immutability | pass | **2** | `7aeaac1` |
| T5 Change-class governance, two-key activation | pass | 1 | `7661e22` |
| T6 Instance lifecycle + SLA timer swap | pass | 1 | `204ab33` |
| T7 `runDueTimers` + escalation ladder | pass | 1 | `8b32fdd` |
| T8 In-flight remediation (D-11) | pass | **2** | `9b946c0`, `d099899` |
| T9 Manifest, module, definition routes, wiring | pass | 1 | `c45f479` |
| T10 Instance routes, full-lifecycle e2e, docs | pass | 1 | `6a9d75c` |

Infrastructure commit: `554a688` (execution-lessons ledger, landed *between* the two pipelines so pipeline B's briefs inherited tripwire 15).

**Cost:** 24 agents, **1,651,636 subagent tokens** (pipeline A 767,045 / pipeline B 884,591), ~2h16m of pipeline wall clock. **Zero infrastructure failures** — no API 529, no dead agent, nothing skipped or escalated. **Both** retries in ten tasks were genuine code defects the gate caught; **no retry was caused by process failure**. Tier map: Sonnet coders on T1–T4, T6, T8, T10; Opus coders on T5, T7, T9; Opus gate on every task.

**Every commit's stat was diffed against its brief's file list by the main session** — each touched only its declared files, and the three extend-only constraints held exactly: `definitions.ts` +164/−0 (T5 over T4), `timers.ts` +126/−0 (T7 over T6), `workflow.controller.ts` +102/−0 (T10 over T9).

---

## 3. Shipped interfaces

All under `apps/core/src/kernel/workflow/`. The engine is **shared kernel**, so the module-isolation lint rule (which targets `src/modules/**`) is untouched and later plans may import it freely.

**Definition library** (`definition.ts` — pure: zod only, no DB, no clock)
```ts
type ChangeClass = "A" | "B" | "C"
type SlaSpec | StateSpec | TransitionSpec | WorkflowDefinition   // z.infer of the schemas
class WorkflowValidationError extends Error { readonly problems: string[] }
defineWorkflow(defJson: unknown): WorkflowDefinition   // throws WorkflowValidationError with the FULL problem list
parseDefinition(stored: unknown): WorkflowDefinition
```
The §18 no-dangling-paths rule is a **reverse-reachability check**: every branch must reach a terminal state or the draft is rejected with every problem listed at once, not just the first.

**Events** (`events.ts`) — the five names this plan owns, `module: "workflow"`, full §10.5 envelope
```ts
workflowDefinitionUpdated · slaBreached · escalationTriggered · instanceMigrated · instanceAborted
```
**Instance starts and transitions mint NO event names** — deliberately. No such catalog entries exist; `workflow_transitions` is their audit record, and domain modules attach their own events with `correlationId` = instance id when they author flows in Plans 07+.

**Roles** (`roles.ts` — the static roster seam)
```ts
actorHoldsAnyRole(tx: Tx, userId: string, roleKeys: string[]): Promise<boolean>
usersHoldingRole(tx: Tx, roleKey: string): Promise<string[]>
```
Resolves `role_assignments` **plus live `temp_role_grants`, at any scope**. Expired grants are excluded (pinned by test). The roster substrate is Plan 11-adjacent and marked in code.

**Definitions + governance** (`definitions.ts`)
```ts
type DefinitionRow = typeof workflowDefinitions.$inferSelect
createDraft(db, actor, defJson: unknown): Promise<{ definitionId: string; defKey: string; version: number }>
getActiveDefinition(tx, defKey): Promise<(DefinitionRow & { parsed: WorkflowDefinition }) | null>
listDefinitions(db, defKey): Promise<DefinitionRow[]>
type ChangeClassPolicy = { requiredRoles: string[]; emergencyRoles: string[] | null }
CHANGE_CLASS_POLICY: Record<ChangeClass, ChangeClassPolicy>
class GovernanceError extends Error {
  readonly code: "actor_not_user" | "unknown_definition" | "not_draft" | "role_not_in_policy"
               | "approver_lacks_role" | "duplicate_approval" | "approvals_missing" }
approveDefinition(db, actor, { definitionId, roleKey, note, emergency? }): Promise<void>
activateDefinition(db, actor, definitionId): Promise<{ retiredVersion: number | null }>
```
```ts
CHANGE_CLASS_POLICY = {
  A: { requiredRoles: ["owner", "medical_superintendent"],
       emergencyRoles: ["duty_manager", "medical_superintendent"] },   // E-5 precedence path
  B: { requiredRoles: ["department_head", "duty_manager"], emergencyRoles: null },
  C: { requiredRoles: [], emergencyRoles: null },
}
```
**Definitions are immutable once active** — no code path updates the `definition` jsonb after activation; every change is a new version. One-active-version-per-key is a **database partial unique index**, not a convention (below). Activation retires the prior version through a conditional single-winner `UPDATE`. Drafter≠activator runs through Plan 02's `assertNotSodPair(db, "workflow_drafter_activator", …)`, and **the emergency two-key path (duty manager + MS) supersedes that SoD pair by declared E-5 precedence**, loudly flagged in the activation event — tested with the MS-drafts-and-activates case. Emergency and normal approval sets do not cross-satisfy.

**Instances** (`instances.ts`)
```ts
type WorkflowSubject = { type: string; id: string; patientId?: string; encounterId?: string }
class WorkflowError extends Error {
  readonly code: "unknown_instance" | "instance_not_active" | "no_active_definition"
    | "unknown_transition" | "role_denied" | "already_on_active_version"
    | "mapping_incomplete" | "mapping_unknown_state" | "stale_transition" | "reason_required" }
startInstance(tx, defKey, subject): Promise<{ instanceId: string; state: string }>
transition(tx, instanceId, to, actor, opts: { note?: string }): Promise<{ state: string; completed: boolean }>
```
`WorkflowError` is **defined once, here**, and reused by remediation and mapped once by the controller. Both engine entry points are `Tx`-first exactly as the roadmap's Produces line specifies.

**Three load-bearing semantics, each proven by execution:**
- **Version pinning** — an instance stores `definitionId`, so in-flight work completes on the version it started on even after a newer version activates (§10.2).
- **Single-winner moves** — `transition`, `migrateInstance`, and `abortInstance` are conditional `UPDATE`s discriminated on the instance's current state. Two concurrent moves cannot both apply; the loser gets `stale_transition` (§11.19-B pass-5 optimistic locking). The gate re-ran a 12-way race probe of its own.
- **Transition role semantics** — a `user` actor must hold one of the transition's allowed roles and **any scope satisfies**; a `system` actor bypasses the role check; an **`agent` actor is denied** (the Plan 12 seam, same as `PermissionGuard`).

**Timers** (`timers.ts`) — rows, never processes
```ts
scheduleSlaTimer(tx, { instanceId, state, sla, enteredAt }): Promise<{ timerId: string; dueAt: Date }>
scheduleEscalationTimer(tx, { instanceId, state, rung, afterMinutes, from }): Promise<{ timerId: string; dueAt: Date }>
cancelOpenTimers(tx, instanceId): Promise<number>
DUTY_MANAGER_ROLE = "duty_manager"
runDueTimers(db, now: Date = new Date()): Promise<number>
```
**`runDueTimers` is deliberately UNSCHEDULED** (owner decision 2026-08-12, option (b)) — invoked by tests today, registered as a pg-boss cron by **Plan 11**, alongside `runDispatchCycle` and `sweepExpiredTempRoles`. It **claims each due timer with a row-level conditional `UPDATE … RETURNING` before firing**, so two processes sweeping simultaneously cannot double-fire; it is idempotent across runs; there is **no in-memory state anywhere**. Alerting is selective per §10.3: a `record_only` state still **records** its breach without escalating. The ladder resolves rungs through `usersHoldingRole`; an empty rung falls back to `duty_manager` holders with `fallback: true`, and an empty fallback sets `fallbackExhausted: true` (§11.19-C fix 11 — **the owner-SMS half is Plan 10's gateway and is not built**).

**Remediation** (`remediation.ts` — D-11)
```ts
migrateInstance(db, actor, { instanceId, stateMapping: Record<string,string>, reason }):
  Promise<{ toDefinitionId: string; toVersion: number; state: string }>
abortInstance(db, actor, { instanceId, reason }): Promise<void>
```
Both are single-winner state moves, both append their catalog event with `correlationId` = instance id, and a migrated instance gets **fresh timers** for the state it lands in. **The mandatory reason is enforced at runtime**, not merely by type: an empty or whitespace-only reason is refused with `reason_required` before any DB read (this was the T8 gate catch). Routing remediation through the approvals engine is a **marked Plan 04 seam — stated, not built**.

**Schema** (`db/schema/workflow.ts`) — five tables, re-exported from `../db/schema`
`workflow_definitions` · `workflow_definition_approvals` · `workflow_instances` · `workflow_transitions` · `workflow_timers`
```ts
uniqueIndex("workflow_definitions_one_active_ux").on(t.defKey).where(sql`${t.status} = 'active'`)
```
**Verify-by-execution flag ① held:** drizzle-kit emitted the partial index with its `WHERE "workflow_definitions"."status" = 'active'` clause intact — no hand-edit was needed and no deviation was recorded. `workflow_transitions` is insert-only; there is no update or delete path in code.

**HTTP surface** (`manifest.ts`, `workflow.module.ts`, `workflow.controller.ts`)
```ts
workflowManifest: ModuleManifest    // key "workflow"; installed in AppModule's MODULE_REGISTRY factory
// permissions — the engine keeps NO list of its own:
workflow.definitions.draft · .approve · .activate · .read
workflow.instances.start · .transition · .read · .remediate
```
Nine routes on one controller, each `@RequirePermission(…, "hospital")`:
`POST /workflow/definitions` · `POST /workflow/definitions/:id/approve` · `POST /workflow/definitions/:id/activate` · `GET /workflow/definitions` · `POST /workflow/instances` · `POST /workflow/instances/:id/transition` · `GET /workflow/instances/:id` · `POST /workflow/instances/:id/migrate` (`.remediate`) · `POST /workflow/instances/:id/abort` (`.remediate`).

**Enforcement is two-layer by design:** the route carries Plan 02's `@RequirePermission` metadata enforced by the global `PermissionGuard`, **and** the engine separately checks the definition's per-transition allowed roles. The module is controller-only — the two global guards keep their load-bearing order (`AuthGuard` then `PermissionGuard`) and were not re-registered. **No boot-time DB call was added**: `syncPermissions` already runs in `AuthModule.onModuleInit` and simply mirrors the enlarged registry, so no e2e database-wiring audit was triggered (EXECUTION-LESSONS §3.6).

One shared error mapper, defined once:
```ts
function toHttp(e: unknown): never {
  if (e instanceof WorkflowValidationError) throw new BadRequestException(e.problems);
  if (e instanceof SodViolationError) throw new ForbiddenException(e.message);
  if (e instanceof GovernanceError) throw new ConflictException(e.message);
  if (e instanceof WorkflowError) throw new ConflictException(e.message);
  throw e;
}
```

---

## 4. Deviations from the plan text (all gate-ratified — do not "fix" these)

Plan 01's and Plan 02's deviations all still stand. New in Plan 03:

1. **`WorkflowError`'s union gained `reason_required`**, added by T8 into T6's `instances.ts` — a deliberate cross-task edit the gate authorized in its correction, precisely so a second error class would *not* appear. `instances.ts` is otherwise unchanged since T6.
2. **T5 added one governance test beyond the plan's eight** (class B: `department_head` + `duty_manager`, and that an `emergency: true` approval on class B is refused with `role_not_in_policy`). The plan's block tested only classes A and C while a criterion required each class covered. The plan's eight tests and its `beforeEach` are unmodified.
3. **T5 added the Plan 04 seam as a code comment** above `approveDefinition`. The plan states the seam in its Interfaces prose but its code block carried no comment; a criterion required one. No behaviour change.
4. **Duplicate import statements from the same module** in `definitions.ts` (`../db/schema`) and `timers.ts` (`drizzle-orm`). Both extending tasks appended a new import line rather than merging a symbol into an existing line, because merging would have modified a byte-identical-frozen line. No `no-duplicate-imports` rule is configured and lint passes clean.
5. **`d099899` uses a descriptive `fix(workflow): …` message.** The plan supplies exact commit messages for its ten task commits only; T8's gate-mandated follow-up needed one and the coder wrote it in the repo's existing conventional-commit style.
6. **Three test-side fixes to plan defects** — see §5. In each case the shipped implementation was correct and the plan's *test* was wrong.

---

## 5. Defects found in the plan itself

**All three are in the plan's TEST code; its implementation code shipped defect-free.** This is the inverse of Plan 01 (three runtime defects in "exact" implementation code) and worth carrying forward: test blocks typecheck and read plausibly, and two of these three were **unsatisfiable against a correct implementation**.

**5.1 — A verify-by-execution flag was discharged in the wrong task.** *(T4, caught by the gate, 1 retry)*
Flag ④ (jsonb round-trip fidelity) claimed it was proven "by T2's `toEqual(DEF_JSON)` and every `parseDefinition` call in T6–T8" — so T4, the task that actually writes a definition to `jsonb`, carried no round-trip assertion at all, and its coder reasonably reported the flag as already satisfied elsewhere. One line fixed it: `expect(rows[0]!.definition).toEqual(DEF_JSON)`. **A flag discharged in a different task than the one whose code it protects is a flag nobody owns.**

**5.2 — An assertion that could never pass.** *(T9, caught by execution)*
The plan's definition e2e asserted:
```ts
expect(JSON.stringify(res.body.message)).toContain('initialState "nowhere" is not a declared state')
```
`JSON.stringify` escapes the inner quotes, producing `["initialState \"nowhere\" is not a declared state"]`, which cannot contain the unescaped needle — **the test was unsatisfiable regardless of implementation**, and the controller under test was correct (`new BadRequestException(e.problems)` is exactly what the plan's own Step 4 code and its stated "400 (body carries problems)" contract require). Fixed by asserting array membership on `res.body.message` directly, with a comment recording why.

**5.3 — A derived fixture the plan's own validator rejects.** *(T10, caught by execution)*
The full-lifecycle e2e built `DEF_V2 = { ...DEF_V1, states: [received, done], … }`. The spread carried `initialState: "open"` while the new `states` array declared only `received` and `done`, so `defineWorkflow` correctly rejected the draft with `initialState "open" is not a declared state` and the migrate-to-v2 leg 400'd. The engine was right; the fixture was wrong. Fixed by overriding `initialState: "received"` — the state the test's own `stateMapping` maps `"open"` onto — with the defect documented inline.

**5.4 — A plan-text nit (no code impact).** T7's Step 4 expects its scheduler grep to print `CLEAN`; it prints one hit, because T6's already-shipped comment reads `// Timers are ROWS, never processes (roadmap trap: survive restarts; no setTimeout).` The grep matches the word inside a comment. **Zero scheduling code exists** — independently re-verified across all of `apps/core/src`. The agent correctly left the frozen comment alone and flagged the expectation instead.

---

## 6. Process failures — what they cost

Recorded in full, with prevention, in **`EXECUTION-LESSONS.md`** (`554a688`). **Net extra-agent cost: zero.** No retry in this plan was caused by a process failure.

| Cause | Class | Cost |
|---|---|---|
| T4's gate correction directed `git commit --amend` + `push --force-with-lease` on an already-pushed, already-CI-green commit; the coder complied and the harness classifier flagged it | Template defect §2.4 + missing tripwire 15 — **previously unrecorded** | ~50k tokens, but the retry itself was a genuine code defect and owed regardless; the rewrite added **no extra agent**. Verified harmless: one-line test addition (`9a9e253` → `7aeaac1`), history linear, `bb4f492` still an ancestor, both SHAs CI-green, no other checkout held the old commit |
| T8 ran `git pull --rebase` *after* editing rather than before (tripwire 11 ordering) | Ordering deviation, self-reported | 0 tokens; `git fetch` confirmed origin had not diverged, so no risk materialized |
| T2 attempted `pnpm verify > /tmp_verify_check.log`; the classifier blocked it and the agent re-ran with `/dev/null` instead of routing around it | **Tripwire 3 working as designed** | 0 tokens. Recorded deliberately — the same breach cost ~100k tokens in Plan 02 T1 |

**Both sides of the force-push defect were fixed *between* pipelines A and B**, so pipeline B's briefs carried tripwire 15 and its gate prompt forbade writing such a correction: no history was rewritten in pipeline B. This is the direct application of Plan 02's meta-lesson that a fix landing after a pipeline is compiled does not protect that pipeline.

---

## 7. Open items carried forward

1. **`runDueTimers` is unscheduled** — by owner decision (2026-08-12, option (b)), not by omission. **Plan 11** registers it as a pg-boss cron in the worker process, alongside `runDispatchCycle` (Plan 01) and `sweepExpiredTempRoles` (Plan 02). **Three unscheduled sweeps now await that one plan.** Correctness never depends on the ticker: timers are rows and survive restarts.
2. **Escalation resolves to static role holders**, any scope, via `usersHoldingRole`. Real on-duty/roster resolution is Plan 11-adjacent; the seam is marked in code.
3. **The owner-SMS half of §11.19-C fix 11 is not built.** `fallbackExhausted: true` is set and evented when a duty-manager fallback is itself empty; **Plan 10**'s notification gateway consumes it.
4. **Remediation is not routed through the approvals engine** — `workflow.instances.remediate` plus a mandatory reason is today's gate. **Plan 04** seam, marked in code.
5. **Agent actors cannot transition instances** — denied exactly as `PermissionGuard` denies them on permission-guarded routes. **Plan 12** seam; no schema change needed before then.
6. **Any scope satisfies a transition's role check.** Inherited deliberately from Plan 02 §7.3: scope ids are opaque codes with no floor→department→hospital inference. Any plan assuming an org hierarchy must ship org masters first and then revisit both `hasPermission` and this check.
7. **Domain flows do not exist yet.** The engine is generic; OPD, billing, and clinical flows are *data* authored in Plans 07+. Test fixtures use synthetic keys (`test_flow`), synthetic roles, and synthetic subjects.
8. Still open from earlier plans: `SECRET_KEY` rotation is destructive (Plan 11 key ceremony), deployment topology (Plan 11), event-log partitioning (Plan 11, hybrid `recorded_at` monthly), break-glass per-access eventing (Plan 05).

---

## 8. What Plan 04 can rely on

The approvals engine can treat the workflow engine as shipped infrastructure:

- **`startInstance(tx, defKey, subject)` / `transition(tx, instanceId, to, actor, { note })`** are `Tx`-first, so an approval flow can drive an instance inside its own transaction.
- **Timeout escalation is already built.** The roadmap's Plan 04 line — *"timeout escalation via Plan 03 ladders"* — is satisfied by per-state `sla` specs plus `runDueTimers`, which emits `sla.breached` and climbs `escalation` rungs to static role holders with a duty-manager dead end. Plan 04 authors ladders as **definition data**; it writes no timer code.
- **`GovernanceError` and `WorkflowError`** are the established error grammar, and `toHttp` is the one place HTTP mapping happens. A new engine should follow that shape rather than inventing exception handling per controller.
- **Two-key approval with role policy** is implemented once in `CHANGE_CLASS_POLICY` + `approveDefinition`, including duplicate-approval rejection and approver-role verification — a working reference for Plan 04's approver-role checks.
- **`assertNotSodPair(db, pairKey, actorA, actorB)`** is now proven in a second consumer (drafter≠activator). Plan 04's requester≠approver check calls it the same way. **Do not conflate this with E-5:** the emergency-governance precedence that supersedes an SoD pair is a *workflow-definition-change* concern and is **not** the approvals engine's — the roadmap names this trap explicitly.
- **Correlation is fixed:** `correlationId` = the workflow instance id (§10.5). Plan 04's approval events should carry the same correlation when an approval belongs to an instance.
- **Permission strings come from `ModuleRegistry.allPermissions()`.** Plan 04 declares its permissions in its own manifest and installs it in `AppModule`'s `MODULE_REGISTRY` factory beside `authManifest` and `workflowManifest` — it must never keep its own list.
- **Single-winner concurrency is the house pattern** for any state move: a conditional `UPDATE` discriminated on current state, with a stale-* error for the loser. Plan 04's approve/reject transitions should use it rather than read-then-write.
