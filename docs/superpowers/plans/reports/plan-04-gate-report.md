# Plan 04 — Approvals Engine v1 · Gate Report

**Executed 2026-08-13** from the committed plan `docs/superpowers/plans/2026-08-13-phase1-04-approvals-engine.md` at `a1b949e`, in two pipelines (A = T1–T4, B = T5–T8), strictly sequential within each. **8/8 tasks gate-passed on the first attempt. Zero retries. Zero infrastructure failures. Zero escalations.**

Commit range `a1b949e..88d13c9` (eight commits: eight code, one docs interleaved). `pnpm verify` green at final HEAD, independently observed by the main session; CI green on every pushed commit.

**Where this report and the plan text disagree, this report wins.**

---

## 1. Build environment — what changed since Plan 03

Everything in plan-03 gate report §1 still holds. **This plan, like Plan 03, changed the environment essentially not at all:**

| Fact | Value |
|---|---|
| New dependencies | **none** — `package.json` and `pnpm-lock.yaml` untouched, root and core |
| New env vars | **none** — `.env.example` untouched; the engine needs no config values |
| CI / jest config | **untouched** — `.github/workflows/*` and `jest.config.cjs` unchanged; no agent asked to change them |
| Migration | `0005_lame_makkari.sql` — 2 tables, 2 FKs, 1 unique index + 4 secondary indexes. Generated **once**, in T2, via `db:generate`; no later task regenerated and no stray migration appeared |
| Kernel isolation | **nothing** under `src/kernel/workflow/`, `src/kernel/auth/`, `src/kernel/events/`, or `src/kernel/modules/` was modified — verified by the main session with `git diff --name-only a1b949e..HEAD` over those paths, which returned empty. The `events` table schema was not touched |
| Shipped files modified | exactly two: `src/kernel/db/schema/index.ts` (one re-export line, T2) and `src/app.module.ts` (4 added lines + 1 changed, T7) |
| Test helper | `apps/core/test/helpers/db.ts` gained the approvals truncate statement **and one table name on the pre-existing workflow statement** (see §5.1). `setupTestDb` is byte-unchanged |
| Test totals | **45 suites / 208 tests** at `88d13c9` (apps/core 42/201 + packages/contracts 3/7), from 35/152 at `a1b949e`. **+10 suites, +56 tests** |

The plan's "zero dependencies, zero env vars, zero CI changes" goal **held exactly**, for the second plan running. The additive-only constraint (owner decision Q2) held with zero violations across eight tasks.

---

## 2. Task outcomes

| # | Task | Tier | Attempts | Commit | Tests |
|---|---|---|---|---|---|
| T1 | `approvalFlowDefinition` builder (pure) | sonnet | 1 | `595bcf8` | 6 |
| T2 | Schema (migration 0005) + three catalog events | sonnet | 1 | `a150a27` | 13 (flow 6 + events 4 + schema 3) |
| T3 | Type registry + C-12 `cumulativeAmount` | **opus** | 1 | `56673ec` | 15 (types 6 + cumulative 9) |
| T4 | `requestApproval` — instance-backed requests | **opus** | 1 | `0da3034` | 7 |
| T5 | Approve / reject — SoD, single-winner, note | **opus** | 1 | `850db97` | 8 |
| T6 | Approver worklist — role-scoped listing | sonnet | 1 | `a94b9d4` | 6 |
| T7 | Manifest, module, routes, AppModule + e2e | **opus** | 1 | `5587201` | 4 (e2e) |
| T8 | Full-lifecycle e2e + docs | sonnet | 1 | `88d13c9` | 3 (e2e) |

Opus gate on every task regardless of coder tier. **Eight tasks, eight first-attempt passes** — the first plan in the series with no retry of any kind.

**Independent main-session verification** (not agent self-reports): each commit's `--stat` was diffed against its brief's file list and matched exactly; the frozen-path check over `kernel/workflow|auth|events|modules` + `package.json` + `pnpm-lock.yaml` + `.env.example` + `jest.config.cjs` + `.github/` returned empty across the whole range; `pnpm verify` was re-run unpiped at `0da3034` (exit 0, 38/180 core) and at `88d13c9` (exit 0, 42/201 core + 3/7 contracts); CI was observed green on all eight commits plus the interleaved docs commit.

---

## 3. Shipped interfaces

All under `apps/core/src/kernel/approvals/` unless noted. The engine is **shared kernel**, so later plans may import it freely. Signatures below are transcribed from the shipped source, not from the plan.

**Flow builder** (`flow.ts` — pure: zod + `defineWorkflow` only, no DB, no clock)
```ts
const APPROVAL_DEF_PREFIX = "approval_"          // defKey convention: discount_override ⇒ approval_discount_override
type EscalationRung = z.infer<typeof rungSchema>          // { afterMinutes: number; toRole: string }
type ApprovalFlowSpec = z.input<typeof specSchema>
approvalFlowDefinition(spec: ApprovalFlowSpec): WorkflowDefinition
```
Emits the canonical three-state flow — initial `pending` (SLA = `closureSlaMinutes`, `alerting: "active"`, optional ladder), terminal `granted` / `rejected`, both transitions restricted to `[approverRole]` — and returns it **through Plan 03's `defineWorkflow`**. Every fixture built by this function is valid by construction: an invalid spec throws `ZodError`, a builder bug throws `WorkflowValidationError`. `changeClass` defaults to `"C"`, so registering a type needs no approvals — no bootstrap circularity.

**Events** (`events.ts`) — **the plan's complete event surface: exactly three names, `module: "approvals"`**
```ts
approvalRequested = defineEvent("approval.requested", "approvals", …)
approvalGranted   = defineEvent("approval.granted",   "approvals", decisionPayload)
approvalRejected  = defineEvent("approval.rejected",  "approvals", decisionPayload)
```
`correlationId` = the backing workflow instance id on every emission (§10.5). **Type registration and instance starts mint nothing.** `sla.breached` / `escalation.triggered` for approval flows are emitted by Plan 03's shipped `runDueTimers` under `module: "workflow"` — not re-minted here.

**Registry + errors** (`types.ts`)
```ts
const URGENCY_CLASSES = ["routine", "urgent", "emergency"] as const
type UrgencyClass = (typeof URGENCY_CLASSES)[number]
type ApprovalErrorCode =
  | "unknown_type" | "duplicate_type" | "definition_not_active" | "definition_mismatch"
  | "user_actor_required" | "act_first_not_allowed" | "note_required" | "invalid_amount"
  | "amount_needs_target" | "invalid_cumulative_query" | "unknown_approval" | "not_pending"
class ApprovalError extends Error { constructor(readonly code: ApprovalErrorCode, message?: string) }
type ApprovalTypeRow = typeof approvalTypes.$inferSelect
type ApprovalTypeSpec = { typeKey: string; title: string; approverRole: string;
                          urgencyClass?: UrgencyClass; actFirstAllowed?: boolean }
registerApprovalType(db: Db, actor: Actor, spec: ApprovalTypeSpec): Promise<{ typeKey: string; defKey: string }>
getApprovalType(tx: Tx, typeKey: string): Promise<ApprovalTypeRow | null>
```
**`ApprovalError` is defined once** (`types.ts:27`, confirmed by repo-wide grep — exactly one hit) and mapped once by the controller, following Plan 03's `WorkflowError` convention. **E-18 is structurally enforced:** `registerApprovalType` refuses a type whose active definition lacks the engine's load-bearing shape — initial `pending` carrying an SLA, terminal `granted`/`rejected`, both transitions present, `approverRole` allowed on both — collecting *all* problems into one `definition_mismatch`. The insert is conditional (`onConflictDoNothing().returning()`), so a duplicate loses without read-then-write.

**Registration is deliberately a two-step operational flow** (owner decision Q1a): (1) activate the builder's definition through Plan 03's own `createDraft` → `activateDefinition` (Class C needs no approvals; drafter≠activator SoD still applies), (2) `registerApprovalType` points the type at it. **The registry never wraps Plan 03 governance.**

**C-12 aggregation** (`cumulative.ts` — report-only)
```ts
const IST_UTC_OFFSET_MINUTES = 330      // design-law constant: Asia/Kolkata is fixed UTC+05:30, no DST. NOT config.
istDayWindow(now: Date): { start: Date; end: Date }        // start inclusive, end exclusive
type CumulativeQuery = { typeKey: string; patientId?: string; payeeId?: string; window: { start: Date; end: Date } }
cumulativeAmount(tx: Tx, q: CumulativeQuery): Promise<number>
```
Sums `amount_paise` for one type over **exactly one** of patientId or payeeId (both or neither → `invalid_cumulative_query`), inside the window, counting **`pending` + `granted` and excluding `rejected`** (owner decision Q3). Returns a real `number` — SQL `sum()` arrives as text and is forced, pinned by test. **Nothing in this plan blocks on the value**; blocking thresholds are CA-configured data arriving with Plans 06/08.

**Requests** (`requests.ts`)
```ts
type ApprovalRequestInput = { typeKey: string; subject: { type: string; id: string };
  patientId?: string; encounterId?: string; payeeId?: string; amountPaise?: number;
  requestNote?: string; actFirst?: boolean }
requestApproval(tx: Tx, requester: Actor, input: ApprovalRequestInput): Promise<{ approvalId: string; instanceId: string }>
```
**`Tx`-first — runs on the caller's transaction**, never opening its own, so Plan 08's billing can file a request atomically with its own state change (the `appendEvent` / `startInstance` convention). Seven ordered rules, each separately tested: user-actor-only → `unknown_type` → act-first gating → money validation → SLA extraction → **request-time drift guard** → snapshots + instance + event.

**Note the input carries no urgency field** — `approverRole` and `urgencyClass` are snapshotted **from the type** (owner decision Q4: a requester cannot inflate urgency). C-12 snapshots are computed **before** the insert and **include this request's own amount**.

**Decisions** (`decisions.ts`)
```ts
const REQUESTER_APPROVER_PAIR = "requester_approver"      // Plan 02's seeded pair key
type DecisionInput = { approvalId: string; note: string }
approveRequest(db: Db, actor: Actor, input: DecisionInput): Promise<{ status: "granted" }>
rejectRequest(db: Db, actor: Actor, input: DecisionInput): Promise<{ status: "rejected" }>
// private, shared: async function decide<V extends "granted" | "rejected">(
//   db: Db, actor: Actor, input: DecisionInput, verdict: V): Promise<{ status: V }>
```
Both are **`Db`-first** (like Plan 03's `migrateInstance`/`abortInstance`) because the SoD check must ride its **own** transaction while the state move opens `withTx` itself. Five ordered rules: mandatory note enforced at runtime **before any DB read** → **user actors only** (a `system` actor would bypass `transition`'s role check — silent auto-approval of money items; `agent` is the Plan 12 seam) → row lookup fast-fail → `assertNotSodPair(db, REQUESTER_APPROVER_PAIR, { type: "user", id: row.requesterId }, actor)` with **`Actor` objects** → one `withTx` doing `transition` then a conditional UPDATE on `status = 'pending'` then the decision event.

**Arbitration is Plan 03's, not re-implemented:** approver-role enforcement (`role_denied`) and single-winner concurrency come from `transition`. The `approvals` row mirror rides the same transaction as its own conditional UPDATE. **No read-then-write state move exists anywhere in this engine.**

**No E-5 bypass exists** (roadmap trap): requester≠approver has no emergency override in the approvals engine. The emergency-governance precedence that supersedes an SoD pair is a *workflow-definition-change* concern, shipped in Plan 03's governance.

**Worklist** (`worklist.ts`)
```ts
rolesHeldBy(tx: Tx, userId: string): Promise<string[]>          // deduped, sorted; permanent at ANY scope + unexpired temp grants
type WorklistFilters = { status?: "pending" | "granted" | "rejected"; typeKey?: string;
  urgencyClass?: UrgencyClass; approverRole?: string; olderThanMinutes?: number;
  limit?: number; offset?: number }
type ApprovalRow = typeof approvals.$inferSelect
listApprovals(db: Db, actor: Actor, filters: WorklistFilters = {}): Promise<{ items: ApprovalRow[]; total: number }>
getApproval(db: Db, approvalId: string): Promise<ApprovalRow | null>
```
`rolesHeldBy` is written **inside `kernel/approvals/`**, mirroring the query shape of Plan 03's `kernel/workflow/roles.ts` rather than modifying or importing it — a deliberate duplication under the additive-only rule (owner decision Q2), **not** a refactoring opportunity.

**Scoping is the security property**, not a convenience: `listApprovals` returns only rows whose `approverRole` is among the caller's held roles; the `approverRole` filter **narrows within** that set and can never widen past it. A caller holding no roles returns `{ items: [], total: 0 }` **before any query** — `inArray` on an empty array is invalid SQL, so the guard is load-bearing. `status` defaults to `"pending"`; ordering is `emergency` → `urgent` → `routine`, then oldest `requestedAt` first; `limit` defaults 50, **capped at 200**; `total` counts the full filtered set (forced to `number` — `count(*)` also arrives as text).

**Schema** (`db/schema/approvals.ts`) — re-exported from `../db/schema`
```ts
approval_types:  type_key (PK) · title · def_key · approver_role · urgency_class (default 'routine')
                 · act_first_allowed (boolean, default false) · created_by · created_at
                 uniqueIndex("approval_types_def_key_ux").on(defKey)
approvals:       id (PK) · type_key → approval_types.type_key · instance_id → workflow_instances.id
                 · requester_id · approver_role · urgency_class · acted_first · subject_type · subject_id
                 · patient_id? · encounter_id? · payee_id?
                 · amount_paise, cumulative_patient_paise, cumulative_payee_paise
                     — all bigint(..., { mode: "number" }), integer PAISE
                 · request_note? · status (default 'pending') · decision_note? · decided_by? · decided_at?
                 · requested_at
                 uniqueIndex("approvals_instance_ux").on(instanceId)      // one approval per instance
                 index("approvals_worklist_idx").on(status, approverRole)
                 index("approvals_type_idx").on(typeKey)
                 index("approvals_patient_day_idx").on(patientId, requestedAt)
                 index("approvals_payee_day_idx").on(payeeId, requestedAt)
```
`requesterId` / `decidedBy` / `createdBy` are **plain text with no FK to `users`**, deliberately — Plan 12's agent actors must fit without a schema change (Plan 03's `draftedBy` convention). The bigint `mode: "number"` round-trip is pinned by test (`123_456_789_012` in, `typeof === "number"` out) — the Plan 01 `seq` string/number trap class.

**HTTP surface** (`manifest.ts`, `approvals.module.ts`, `approvals.controller.ts`)
```ts
approvalsManifest: ModuleManifest   // key "approvals", title "Approvals Engine", menu [], subscriptions []
// permissions — the engine keeps NO list of its own:
approvals.types.manage · approvals.requests.create · approvals.requests.read · approvals.requests.decide
```
Six routes on one controller, each `@RequirePermission(…, "hospital")`, **in this source declaration order** (Nest matches in declaration order; the literal segment must win):
`POST /approvals/types` (.types.manage) · `POST /approvals` (.create) · `GET /approvals` (.read) · `GET /approvals/:id` (.read) · `POST /approvals/:id/approve` (.decide) · `POST /approvals/:id/reject` (.decide).

The module is **controller-only** — it registers no guard; Plan 02's two global guards keep their load-bearing order (`AuthGuard` then `PermissionGuard`) and were not re-registered. **No boot-time DB call was added**: `syncPermissions` already runs in `AuthModule.onModuleInit` and simply mirrors the enlarged registry, so no e2e database-wiring audit was triggered (EXECUTION-LESSONS §3.6).

One shared error mapper, defined once:
```ts
function toHttp(e: unknown): never {
  if (e instanceof SodViolationError) throw new ForbiddenException(e.message);
  if (e instanceof ApprovalError) {
    if (e.code === "unknown_approval") throw new NotFoundException(e.message);
    if (e.code === "not_pending") throw new ConflictException(e.message);
    throw new BadRequestException(e.message);
  }
  if (e instanceof WorkflowError) throw new ConflictException(e.message);
  throw e;
}
```

**Enforcement is two-layer by design** (inherited from Plan 03): the route carries `@RequirePermission` metadata enforced by the global `PermissionGuard`, **and** the workflow definition separately enforces the transition's allowed roles.

**Three load-bearing semantics, each proven by execution:**
- **The ladder runs on Plan 03's shipped sweep, unmodified.** T8 backdates the closure-SLA timer 40 minutes and drives `runDueTimers` four times: `1, 1, 1, 0` — breach, rung 1, rung 2, quiet — with per-rung `resolvedUserIds` matching the real role holders and `fallback: false`. **This plan wrote zero timer, ladder, or scheduler code.**
- **Requests are instance-backed.** Every request starts an instance of the active `approval_<typeKey>` definition, so version pinning, SLA timers, escalation ladders, approver-role enforcement, and single-winner concurrency all come free from Plan 03.
- **Single-winner decisions under real concurrency.** T5's `Promise.allSettled` race asserts exactly one fulfilled, row status === instance state, and exactly one decision event (see §4.2 for the loser's error code).

---

## 4. Deviations from the plan text (all gate-ratified — do not "fix" these)

**4.1 — `decide()` is generic.** The plan declared `async function decide(…, verdict: "granted" | "rejected"): Promise<{ status: typeof verdict }>`. `typeof verdict` in return position resolves to the parameter's *declared* type — the full union — so it does not narrow per call site and both exported wrappers failed to compile with TS2322. Shipped as `decide<V extends "granted" | "rejected">(…, verdict: V): Promise<{ status: V }>`. Two lines changed; the exported signatures are exactly what the plan specifies, and every other line is verbatim. **This is a plan defect, recorded in §5.2.**

**4.2 — the race test accepts a third loser code.** The plan's single-winner test asserted the loser's code ∈ {`stale_transition`, `not_pending`}. Against Plan 03's **shipped** `transition`, which opens with a non-locking SELECT and throws `instance_not_active` when the instance is already `completed` (`instances.ts:82`), all three codes are legal and which one occurs is pure timing. T5 proved this rather than assuming it: the unmodified assertion passed 1 of 5 consecutive runs and failed with `instance_not_active` on the other 4. Shipped with `instance_not_active` added to the accepted set. **This strengthened the test** — on that path the assertion previously bailed early, so the four downstream assertions (one fulfilled, row status === instance state, instance completed, exactly one decision event) had never actually executed; they now do, and pass. The coder correctly did **not** re-implement arbitration to force a deterministic loser code. **Plan defect, recorded in §5.3.**

**4.3 — `truncateAll` gained two edits, not one.** See §5.1. The plan (and its acceptance criterion) predicted a one-line diff; Postgres required two.

**Inherited deviations, still not ours to fix** (from gate reports 01/02/03 §4): `MODULE_REGISTRY` in `tokens.ts`, static imports in e2e, `@Public` at method level, duplicate import lines in `definitions.ts`/`timers.ts`, argon2 under pnpm `ignoredBuilds`. All left untouched.

---

## 5. Defects found in the plan itself

Three, all caught by execution, all fixed minimally and disclosed rather than silently worked around. **All three are in the plan's own code blocks — two in test/helper code, one in an implementation signature.**

**5.1 — `truncateAll`: a new child table must be named in the FK group's own TRUNCATE statement.** *(T2)* The plan appended `truncate table approvals, approval_types` as a **separate statement placed before** the existing workflow-group statement, on the reasonable-sounding theory that emptying children first satisfies FK order. Postgres disagrees: `TRUNCATE` requires every table with an incoming FK to a target to be named in the **same command**, checking the constraint's *existence*, not row counts. Since `approvals.instance_id` references `workflow_instances.id`, the workflow-group statement failed with *cannot truncate a table referenced in a foreign key constraint* and all three schema tests died at setup. Fixed by adding `approvals` to the pre-existing workflow statement (idempotent — already empty by then). **Second-order damage worth noting:** the task's acceptance criterion said the diff would be "exactly one added line", written from the same wrong model, so the correct fix had to overrule a criterion. Recorded as EXECUTION-LESSONS §3.12.

**5.2 — `typeof verdict` does not narrow in return position.** *(T5)* See §4.1. The plan's intent was clear and correct; its TypeScript was not. This typechecked in the author's head and failed in the compiler — precisely the verify-by-execution class.

**5.3 — an incomplete loser-code set makes a concurrency assertion flaky by construction.** *(T5)* See §4.2. The plan enumerated two of the three error codes Plan 03's shipped arbiter can legitimately produce in a race, giving an assertion an ~80% observed failure rate that no implementation could fix. **This is the §3.11 class one level deeper:** not an assertion that can never pass, but one that passes *sometimes* — which is worse, because a single green run hides it. A plan that asserts on the error code of a *race loser* must enumerate every code the shipped arbiter can produce along each interleaving, or assert on the invariant (exactly one winner) rather than the loser's diagnosis.

**What did NOT go wrong, and was specifically checked:** the request-time drift guard (T4) was verified as genuinely exercised rather than accidentally green — the test activates a v2 with a different approver role that still carries a 45-minute SLA, so the rule-5 SLA branch cannot be what raises `definition_mismatch`. T8's ladder arithmetic (40-minute backdate against rungs at +10/+20 anchored on `dueAt`, not wall-clock) was hand-checked against Plan 03's anchoring semantics *before* the test was written, and execution confirmed it. Every definition fixture in the plan is produced by `approvalFlowDefinition` and therefore funnels through `defineWorkflow` — the §3.10 derived-fixture defense held with zero incidents.

---

## 6. Process failures — what they cost

**Zero process failures cost a retry. Zero infrastructure failures occurred** — no API 529, no dead agent, nothing skipped, across 16 subagents.

| Item | Class | Cost |
|---|---|---|
| T3 read `VERIFY_EXIT=1` off `pnpm verify \| head -30` — a SIGPIPE artifact, not a failure — and had to re-run unpiped to establish the truth | **Prevention debt → new tripwire 16.** The recorded direction is harmless; the dangerous one is the silent false PASS, since `\| tail` exits 0 when verify fails | 0 tokens, no retry |
| T7's first attempt to patch `app.module.ts` via a Python heredoc nested in an ssh command was mangled by the shell (exit 127) | Self-corrected in-task; never reached the repo (`git status` confirmed untouched), re-applied via an scp'd script | negligible |

**Tripwire 16 was landed in EXECUTION-LESSONS and pushed (`d2abe26`) BEFORE pipeline B was compiled**, so B's eight briefs carried it — and both B coders that ran `pnpm verify` captured its true exit status explicitly. This is the "land the fix before compiling the next pipeline" rule from §5 of the ledger, applied for the second plan running.

**Costs.** Pipeline A: 607,273 subagent tokens, 8 agents, ~52 min. Pipeline B: 627,309 subagent tokens, 8 agents, ~55 min. Signature-scout for this report: 44,323. **Total 1,278,905 subagent tokens across 17 agents, ~1h47m of pipeline wall clock** — against the plan's ~1.3M calibration, which was accurate to within 2%.

**~0% of tokens were lost to process or infrastructure** — matching Plan 03 and improving on Plan 02's 22%. Unlike Plan 03, which spent two of ten tasks on genuine-defect retries, **Plan 04 spent none**: all three plan defects were caught and fixed *inside* the original attempt by coders who disclosed them, so the gate never had to reject anything.

---

## 7. Open items carried forward

- **`runDueTimers` remains UNSCHEDULED.** Inherited from Plan 03 (owner decision 2026-08-12, option b). Approval SLAs and escalation ladders are correct and proven, but nothing ticks them in production until **Plan 11** registers the pg-boss cron alongside `runDispatchCycle` and `sweepExpiredTempRoles`. This plan added **no fourth sweep**, as designed.
- **Both Plan 03 seams stay deferred to Plan 08** (owner decision Q2): definition-activation-through-approvals (§10.4) and approval-gated remediation. Nothing under `kernel/workflow/` was touched, so both seams remain exactly as Plan 03 marked them.
- **C-12 is report-only.** Snapshots are computed and stored on every money request, and `cumulativeAmount` is callable — but **nothing blocks**. Blocking thresholds are CA-configured data arriving with **Plans 06/08**.
- **Notification delivery does not exist.** `urgencyClass` rides the event payload as the "interrupting channel" for **Plan 10's** gateway; until then, events only.
- **Day-one consumers are types and fixtures, not wiring.** Discount overrides and refunds are registered as approval *types* in tests; their real wiring lands with billing in **Plan 08**.
- **Agent actors are refused at runtime** in both request and decision paths — the **Plan 12** seam, same as `PermissionGuard`.
- **`rolesHeldBy` duplicates the query shape of `kernel/workflow/roles.ts`** by owner decision. If a future plan unifies them, that is a deliberate refactor with an owner decision behind it — not a cleanup.
- **Roster resolution is static.** Escalation rungs resolve to static role holders with a duty-manager fallback, inherited from Plan 03; the roster substrate is Plan 11-adjacent.

---

## 8. What Plan 05 can rely on

Plan 05 (Patient Master & Registration) is the first UI plan and does not consume the approvals engine directly, but it inherits a kernel that now has three engines in it. What is now true and safe to build on:

- **The approvals engine is complete and callable.** `requestApproval` is `Tx`-first, so a module can file a request atomically with its own state change; `approveRequest`/`rejectRequest` are `Db`-first because SoD rides its own transaction. Merge-approval flows (§11.5, patient merge is approval-gated) can register a type and call these — **no engine work is needed for that, only a type registration and a consumer**.
- **Registering an approval type is a two-step data operation**, not code: build the definition with `approvalFlowDefinition`, activate it through Plan 03's `createDraft` → `activateDefinition` (Class C, no approvals needed), then `registerApprovalType`. Plan 05's merge approval is exactly this shape.
- **The permission-manifest pattern is now proven three times** (`authManifest`, `workflowManifest`, `approvalsManifest`). A new module declares permissions **only** in its manifest and installs it in `AppModule`'s `MODULE_REGISTRY` factory; `syncPermissions` mirrors them at boot with no new boot-time DB call.
- **The error grammar is settled:** one error class per engine, defined once, mapped once in that engine's controller via a `toHttp` following Plan 03's shape. Plan 05 should follow it rather than inventing per-controller exception handling.
- **Single-winner conditional UPDATE is the house pattern** for every state move, now proven in three engines. No read-then-write state moves exist anywhere in the kernel.
- **Money is integer paise in `bigint(..., { mode: "number" })`.** Plan 05 stores no money, but Plan 06 onward must match this — and the round-trip pin (`typeof === "number"`) is the test that catches the text/number trap.
- **IST is a design-law constant, not config** (`IST_UTC_OFFSET_MINUTES = 330`). Any later plan needing an IST calendar day should import `istDayWindow` rather than re-deriving it.
- **Migration numbering is at `0005_lame_makkari.sql`.** Plan 05's first schema task generates `0006_*` via `db:generate`, once, in exactly one task.
- **Test totals to beat: 45 suites / 208 tests, `pnpm verify` green at `88d13c9`.** `apps/core/test/helpers/db.ts` now truncates the approvals group — and per §5.1, **any new table that FKs into an existing group must be named in that group's own TRUNCATE statement**.
- **The additive-only discipline worked.** Eight tasks touched exactly two shipped files (`schema/index.ts`, `app.module.ts`) and nothing under `kernel/workflow|auth|events|modules`. A plan that declares files frozen and briefs agents to halt-and-report rather than "improve" them gets zero violations.
