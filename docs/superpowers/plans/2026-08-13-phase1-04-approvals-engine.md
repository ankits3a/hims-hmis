# Phase 1 / Plan 04 — Approvals Engine v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the generic approvals engine (spec §8): approval request types as registered configuration backed by Plan 03 workflow definitions, `requestApproval` starting a workflow instance per request so SLA timers and escalation ladders come free (§8 + roadmap "timeout escalation via Plan 03 ladders"), approve/reject with a mandatory note as single-winner instance transitions gated by requester≠approver SoD (S10 §11), C-12 cumulative same-patient/same-payee/same-IST-day aggregation as a report-only helper with per-request snapshots, E-15 urgency classes with a per-type act-first-review-after path, an approver worklist auto-scoped to the caller's held roles, and exactly three catalog events — `approval.requested` / `approval.granted` / `approval.rejected`.

**Architecture:** The engine is **shared kernel** (spec §3 lists it there), living under `apps/core/src/kernel/approvals/` — additive-only: **no file under `src/kernel/workflow/`, `src/kernel/auth/`, `src/kernel/events/`, or `src/kernel/modules/` is modified** (owner decision 2026-08-13, design question Q2: both Plan 03 seams stay deferred). Every approval request is a workflow instance (owner decision 2026-08-13, Q1 option (a)): a pure builder `approvalFlowDefinition()` emits a three-state definition (`pending` → `granted` | `rejected`, both transitions restricted to the type's approver role, `pending` carrying the closure SLA and escalation ladder), which is activated through Plan 03's own draft→activate APIs (Class C by default, so registering a request type needs no approvals itself — no bootstrap circularity). The `approval_types` registry row (E-18: every request type names reviewer role + closure SLA) points at that definition; the `approvals` row carries the domain payload and mirrors terminal status for the worklist. **This plan writes zero timer, ladder, or scheduler code** — Plan 03's `runDueTimers` (unscheduled until Plan 11) already emits `sla.breached` and climbs ladders for these instances. `correlationId` = the backing instance id on every event (§10.5).

**Tech Stack:** Everything already shipped in Plans 01–03 (Node 22 · pnpm · TS strict · NestJS ^11 · Postgres 16 · drizzle-orm · zod ^4 · Jest ^29). **This plan adds zero new dependencies and zero new env vars** — `package.json`, `pnpm-lock.yaml`, `.env.example`, `jest.config.cjs`, and `.github/workflows/*` are untouched.

## Global Constraints (from spec v4.5 + roadmap standing rules + owner decisions 2026-08-13)

- TypeScript strict; no `any` in kernel code.
- **Catalog discipline:** exactly three event names minted — `approval.requested`, `approval.granted`, `approval.rejected` — all in §10.6's P7+kernel catalog, `module: "approvals"`, full §10.5 envelope via `defineEvent(...).make(...)` + `appendEvent`, `correlationId` = the backing workflow instance id. The `sla.breached` / `escalation.triggered` events for approval flows are emitted by Plan 03's shipped `runDueTimers` under `module: "workflow"` — this plan mints nothing for them. Registering an approval type emits **no** event (the definition lifecycle already emits `workflow.definition.updated`; the registry row is configuration, and no catalog name exists for it).
- **Additive-only over shipped code (owner decision, Q2):** no file under `src/kernel/workflow/`, `src/kernel/auth/`, `src/kernel/events/`, `src/kernel/modules/` is touched. The two Plan 03 seams — definition activation routed through the approvals engine (§10.4) and approval-gated remediation — stay **deferred**; the roadmap records Plan 08 as their wiring owner. The role-listing query this plan needs is written inside `kernel/approvals/` (T6 `rolesHeldBy`), mirroring `kernel/workflow/roles.ts` rather than modifying it.
- **Instance-backed requests (owner decision, Q1a):** every approval request starts an instance of the active `approval_<typeKey>` definition via Plan 03's `startInstance(tx, defKey, subject)`; approve/reject are `transition(tx, instanceId, "granted"|"rejected", actor, { note })` calls. **No scheduler of any kind** — no pg-boss, `setTimeout`, `setInterval`, or cron, and **no fourth unscheduled sweep**: timeout escalation is entirely Plan 03's DB-row timers + `runDueTimers` (registered as a pg-boss cron by Plan 11 alongside `runDispatchCycle` and `sweepExpiredTempRoles`).
- **The `events` table schema is not touched** (Plan 01 gate report; partitioning is Plan 11).
- **E-5 trap (roadmap, explicit):** the emergency-governance precedence that supersedes an SoD pair is a *workflow-definition-change* concern, shipped in Plan 03's governance (T5). The approvals engine has **no** emergency bypass of requester≠approver — do not conflate.
- **SoD:** requester≠approver runs through Plan 02's shipped `assertNotSodPair(db, "requester_approver", actorA, actorB)` — the pair key is seeded by `SOD_PAIR_SEED` (`kernel/auth/sod.ts:9`, "Requester vs approver of any approvals-engine item"), and the function takes **`Actor` objects, not id strings**. On violation it appends `sod.violation_blocked` in its **own** transaction (survives the caller's rollback) and throws `SodViolationError`.
- **C-12 semantics (owner decision):** the cumulative window is the **IST calendar day** (`Asia/Kolkata`, fixed UTC+05:30, no DST — a design-law constant, not config); `pending` + `granted` requests count toward the total, `rejected` are excluded; the helper and snapshots **report, never block** — threshold values are CA-configured data arriving with Plans 06/08. Money amounts are **integer paise** (`bigint` columns, `{ mode: "number" }`).
- **E-15 semantics (owner decision):** urgency classes are `routine | urgent | emergency`, **fixed per request type** on the registry row — a requester cannot inflate urgency. Act-first-review-after is allowed only when the type's `actFirstAllowed` is true AND the request carries `actFirst: true` with a non-empty justification note (runtime-checked); the `approval.requested` payload carries `actedFirst` loudly. The "interrupting channel" is payload data (`urgencyClass`) for Plan 10's gateway — **events only until then** (roadmap: "notification emission … until then, events only").
- **E-18 structurally enforced:** `registerApprovalType` refuses a type whose active definition does not carry the shape the engine depends on (initial `pending` with an SLA, terminal `granted`/`rejected`, approver role on both transitions).
- **Decisions are user-actors only** (runtime-checked): a `system` actor would bypass `transition`'s role check and silently enable auto-approval of money items; `agent` actors are the Plan 12 seam (denied, same as `PermissionGuard`). Requests are likewise user-only in v1.
- **Mandatory note enforced at runtime**, not merely by type: an empty or whitespace-only decision note is refused with `note_required` **before any DB read** (Plan 03 T8's gate lesson).
- **Single-winner concurrency (house pattern):** `transition()` — a conditional UPDATE discriminated on the instance's current state — is the arbiter of every decision; of two concurrent decisions exactly one applies and the loser throws `stale_transition`. The `approvals` row move rides the same transaction as its own conditional UPDATE discriminated on `status = 'pending'`. **No read-then-write state moves anywhere.**
- Permission strings live **only** in `approvalsManifest`, installed in `AppModule`'s `MODULE_REGISTRY` factory beside `authManifest` and `workflowManifest`. The engine never keeps its own list; `syncPermissions` (already running in `AuthModule.onModuleInit`) mirrors the additions — **this plan adds no new boot-time DB call** (EXECUTION-LESSONS §3.6: no e2e database-wiring audit is triggered; both new e2e suites copy the per-worker `DATABASE_URL` derivation from the shipped workflow e2es verbatim).
- No config fallbacks (Plan 02 rule); this plan needs no new config values.
- Append-only events; `approvals` rows are insert-plus-one-status-move (`pending` → `granted`|`rejected`); no update path touches any other business column after insert, and no delete path exists in code.
- Multi-process-safe: no in-memory state anywhere.
- **Fail-first discipline (EXECUTION-LESSONS §3.5):** every task's failing-test step comes first. T7's e2e is written before the controller exists — its first honest run fails at import/404 and that IS the fail-first evidence. **T8 adds tests over already-shipped code + docs and explicitly owes NO red run** (stated inside the task, with what evidence replaces it). Fail-first evidence is owed by the **original** attempt; a retry inherits it and must never manufacture red states against shipped code.
- **Static imports in tests** (TS2835 under nodenext — EXECUTION-LESSONS §3.7). No `await import(...)` anywhere.
- **No assertion on `JSON.stringify` of a response body** (EXECUTION-LESSONS §3.11) — every e2e asserts on the parsed structure directly.
- Build/test on the server per the roadmap's standing execution rules; `.github/workflows/*` is **not touched** (no new deps, no new env vars, no jest config change).

## File Structure (locked by this plan)

```
apps/core/
  src/kernel/approvals/flow.ts                # pure: approvalFlowDefinition builder → validated WorkflowDefinition JSON
  src/kernel/approvals/events.ts              # the three catalog event definitions (defineEvent + zod)
  src/kernel/approvals/types.ts               # ApprovalError + approval-type registry (registerApprovalType/getApprovalType)
  src/kernel/approvals/cumulative.ts          # istDayWindow + cumulativeAmount (C-12, report-only)
  src/kernel/approvals/requests.ts            # requestApproval (instance-backed)
  src/kernel/approvals/decisions.ts           # approveRequest / rejectRequest (SoD + single-winner)
  src/kernel/approvals/worklist.ts            # rolesHeldBy + listApprovals + getApproval
  src/kernel/approvals/manifest.ts            # approvals ModuleManifest (declares approvals.* permissions)
  src/kernel/approvals/approvals.module.ts    # Nest module: controller only (guards are global already)
  src/kernel/approvals/approvals.controller.ts # /approvals/* endpoints
  src/kernel/db/schema/approvals.ts           # approval_types + approvals tables (one schema file, one migration: 0005)
```

Modified (exact new contents shown in tasks): `apps/core/src/kernel/db/schema/index.ts` (T2), `apps/core/test/helpers/db.ts` (truncate list only — `setupTestDb` frozen; T2), `apps/core/src/app.module.ts` (imports `ApprovalsModule`, installs `approvalsManifest`; T7), `README.md` (T8). Generated: one drizzle migration `0005_*` (via `db:generate` — auto-named, never hand-written; T2).

**Not touched, deliberately:** `package.json` (root and core), `pnpm-lock.yaml`, `.env.example`, `jest.config.cjs`, **every file under `src/kernel/workflow/`** (Plan 03 shipped, byte-frozen for this plan), `src/kernel/auth/`, `src/kernel/events/`, `src/kernel/modules/`, `.github/workflows/*`.

**Sequencing:** Tasks strictly ordered 1→8 — T2+ consume T1's builder in fixtures; T3–T8 consume T2's schema; T4 consumes T3's registry/helper; T5's tests file requests via T4; T6's tests decide via T5; T7 wires everything; T8 exercises the whole. No parallel waves anywhere. Pipeline split: **A = T1–T4, B = T5–T8** (≤6 tasks per Workflow, per the roadmap's standing rules).

---

### Task 1: `approvalFlowDefinition` — approval flows as workflow-definition data

**Files:**
- Create: `apps/core/src/kernel/approvals/flow.ts`
- Test: `apps/core/src/kernel/approvals/flow.test.ts`

**Interfaces:**
- Consumes: `defineWorkflow`, `WorkflowDefinition`, `SlaSpec` from `../workflow/definition` (Plan 03 T1 — pure, no DB); `zod`.
- Produces (exact — T3/T4/T7/T8 and later consumer plans call these):
  - `const APPROVAL_DEF_PREFIX = "approval_"` — the defKey convention: type `discount_override` ⇒ defKey `approval_discount_override`.
  - `type EscalationRung = { afterMinutes: number; toRole: string }`
  - `type ApprovalFlowSpec = { typeKey: string; title: string; approverRole: string; closureSlaMinutes: number; escalation?: EscalationRung[]; changeClass?: "A" | "B" | "C" }` (zod-inferred input type; `changeClass` defaults to `"C"`).
  - `approvalFlowDefinition(spec: ApprovalFlowSpec): WorkflowDefinition` — emits the canonical three-state approval flow: initial `pending` (SLA = `closureSlaMinutes`, `alerting: "active"`, optional escalation ladder), terminal `granted` and `rejected`, transitions `pending→granted` and `pending→rejected` both restricted to `[approverRole]`. The spec is zod-validated (throws `ZodError` on a malformed spec), and the emitted JSON is returned **through `defineWorkflow`** — so a builder bug throws `WorkflowValidationError` with the full problem list, and every fixture built by this function is valid by construction (the §3.10 defense: fixtures pass through the plan's own validator before any test uses them).
- `alerting` is always `"active"` on `pending` — E-18's overdue escalation is the point of the closure SLA (a `record_only` state never climbs the ladder, per Plan 03's shipped `runDueTimers`); notification noise control is Plan 10's matrices, not this flag.
- Pure: no DB, no clock, no side effects.

- [ ] **Step 1: Write the failing tests**

`apps/core/src/kernel/approvals/flow.test.ts`:
```ts
import { ZodError } from "zod";
import { approvalFlowDefinition, APPROVAL_DEF_PREFIX } from "./flow";
import { WorkflowValidationError, parseDefinition } from "../workflow/definition";

describe("approvalFlowDefinition", () => {
  it("emits the canonical three-state flow with the approver role on both transitions", () => {
    const def = approvalFlowDefinition({
      typeKey: "discount_override",
      title: "Discount Override",
      approverRole: "billing_head",
      closureSlaMinutes: 45,
    });
    expect(def.key).toBe(`${APPROVAL_DEF_PREFIX}discount_override`);
    expect(def.title).toBe("Discount Override");
    expect(def.changeClass).toBe("C"); // default: registering a type needs no approvals itself
    expect(def.initialState).toBe("pending");
    expect(def.states).toHaveLength(3);
    const pending = def.states.find((s) => s.name === "pending");
    expect(pending?.sla).toEqual({ minutes: 45, alerting: "active" });
    expect(def.states.find((s) => s.name === "granted")?.terminal).toBe(true);
    expect(def.states.find((s) => s.name === "rejected")?.terminal).toBe(true);
    expect(def.transitions).toEqual([
      { from: "pending", to: "granted", roles: ["billing_head"] },
      { from: "pending", to: "rejected", roles: ["billing_head"] },
    ]);
  });

  it("passes an escalation ladder through to the pending state's SLA", () => {
    const def = approvalFlowDefinition({
      typeKey: "icu_admission",
      title: "ICU Admission",
      approverRole: "duty_doctor",
      closureSlaMinutes: 30,
      escalation: [
        { afterMinutes: 10, toRole: "supervisor" },
        { afterMinutes: 20, toRole: "department_head" },
      ],
    });
    const pending = def.states.find((s) => s.name === "pending");
    expect(pending?.sla?.escalation).toEqual([
      { afterMinutes: 10, toRole: "supervisor" },
      { afterMinutes: 20, toRole: "department_head" },
    ]);
  });

  it("honors an explicit changeClass override", () => {
    const def = approvalFlowDefinition({
      typeKey: "refund_large",
      title: "Large Refund",
      approverRole: "owner",
      closureSlaMinutes: 240,
      changeClass: "B",
    });
    expect(def.changeClass).toBe("B");
  });

  it("round-trips through JSON and parseDefinition (jsonb fidelity by construction)", () => {
    const def = approvalFlowDefinition({
      typeKey: "credit_extension",
      title: "Credit Extension",
      approverRole: "billing_head",
      closureSlaMinutes: 120,
      escalation: [{ afterMinutes: 60, toRole: "duty_manager" }],
    });
    const reparsed = parseDefinition(JSON.parse(JSON.stringify(def)));
    expect(reparsed).toEqual(def);
  });

  it("rejects a malformed spec via zod (bad typeKey, non-positive SLA)", () => {
    expect(() =>
      approvalFlowDefinition({
        typeKey: "Bad-Key",
        title: "Bad",
        approverRole: "r",
        closureSlaMinutes: 10,
      }),
    ).toThrow(ZodError);
    expect(() =>
      approvalFlowDefinition({
        typeKey: "ok_key",
        title: "Bad SLA",
        approverRole: "r",
        closureSlaMinutes: 0,
      }),
    ).toThrow(ZodError);
    expect(() =>
      approvalFlowDefinition({
        typeKey: "ok_key",
        title: "Bad rung",
        approverRole: "r",
        closureSlaMinutes: 10,
        escalation: [{ afterMinutes: 0, toRole: "duty_manager" }],
      }),
    ).toThrow(ZodError);
  });

  it("returns a definition defineWorkflow itself accepted (WorkflowValidationError is reachable, not routine)", () => {
    // The builder funnels its output through defineWorkflow; a valid spec can therefore
    // never produce an invalid definition. This test pins the funnel by checking the
    // error class hierarchy is what T3's registry and the controller expect.
    expect(WorkflowValidationError.prototype).toBeInstanceOf(Error);
    const def = approvalFlowDefinition({
      typeKey: "package_override",
      title: "Package Override",
      approverRole: "duty_manager",
      closureSlaMinutes: 60,
    });
    expect(def.states.filter((s) => s.terminal)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @hmis/core test -- --testPathPattern "approvals/flow"`
Expected: FAIL — `./flow` not found.

- [ ] **Step 3: Implement**

`apps/core/src/kernel/approvals/flow.ts`:
```ts
import { z } from "zod";
import { defineWorkflow } from "../workflow/definition";
import type { SlaSpec, WorkflowDefinition } from "../workflow/definition";

/**
 * Approval flows are workflow-definition DATA (owner decision 2026-08-13, Q1a): every
 * approval request runs as an instance of `approval_<typeKey>`, so SLA timers and
 * escalation ladders come from Plan 03's shipped engine — this plan writes no timer code.
 * The builder emits the one canonical shape; defineWorkflow validates it before return,
 * so every definition (and every test fixture) built here is valid by construction.
 */
export const APPROVAL_DEF_PREFIX = "approval_";

const rungSchema = z.object({
  afterMinutes: z.number().int().positive(),
  toRole: z.string().min(1),
});

const specSchema = z.object({
  typeKey: z.string().regex(/^[a-z][a-z0-9_]*$/, "typeKey must be lowercase snake_case"),
  title: z.string().min(1),
  approverRole: z.string().min(1),
  closureSlaMinutes: z.number().int().positive(), // E-18: every request type names a closure SLA
  escalation: z.array(rungSchema).optional(),
  changeClass: z.enum(["A", "B", "C"]).default("C"),
});

export type EscalationRung = z.infer<typeof rungSchema>;
export type ApprovalFlowSpec = z.input<typeof specSchema>;

export function approvalFlowDefinition(spec: ApprovalFlowSpec): WorkflowDefinition {
  const s = specSchema.parse(spec);
  // alerting is always "active": a record_only state never climbs the ladder (Plan 03
  // runDueTimers), and E-18's overdue escalation is the entire point of the closure SLA.
  // Notification noise control lives in Plan 10's matrices, not here.
  const sla: SlaSpec = { minutes: s.closureSlaMinutes, alerting: "active" };
  if (s.escalation && s.escalation.length > 0) {
    sla.escalation = s.escalation.map((r) => ({ afterMinutes: r.afterMinutes, toRole: r.toRole }));
  }
  return defineWorkflow({
    key: `${APPROVAL_DEF_PREFIX}${s.typeKey}`,
    title: s.title,
    changeClass: s.changeClass,
    initialState: "pending",
    states: [
      { name: "pending", sla },
      { name: "granted", terminal: true },
      { name: "rejected", terminal: true },
    ],
    transitions: [
      { from: "pending", to: "granted", roles: [s.approverRole] },
      { from: "pending", to: "rejected", roles: [s.approverRole] },
    ],
  });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @hmis/core test -- --testPathPattern "approvals/flow"`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/kernel/approvals
git commit -m "feat(approvals): approvalFlowDefinition builder — approval flows as workflow definition data"
```

---
### Task 2: Schema (migration 0005) + the three catalog event definitions

**Files:**
- Create: `apps/core/src/kernel/db/schema/approvals.ts`, `apps/core/src/kernel/approvals/events.ts`
- Modify: `apps/core/src/kernel/db/schema/index.ts`, `apps/core/test/helpers/db.ts` (truncate list only)
- Create: generated migration in `apps/core/drizzle/` (via `db:generate` — auto-named `0005_*`, do not hand-write it)
- Test: `apps/core/src/kernel/db/schema/approvals.test.ts`, `apps/core/src/kernel/approvals/events.test.ts`

**Interfaces:**
- Consumes: drizzle helpers (Plan 01); `defineEvent` from `@hmis/contracts`; `workflowInstances`, `workflowDefinitions` from `./workflow` (FK + test seeding only — Plan 03 files are NOT modified).
- Produces (exact drizzle exports later tasks import from `../db/schema`): `approvalTypes`, `approvals`.
- Produces (exact event defs later tasks import from `./events`): `approvalRequested`, `approvalGranted`, `approvalRejected` — **the plan's complete event surface; no other task mints a name.**
- **This task does not touch the `events` table.** `requesterId`/`decidedBy`/`createdBy` are plain text (no FK to `users`) deliberately: Plan 12's agent actors must fit without a schema change (same convention as Plan 03's `draftedBy`).
- Money columns are `bigint(..., { mode: "number" })` — integer **paise**. The pg driver returns bigint as text; drizzle's `mode: "number"` converts — the round-trip is pinned by test (verify-by-execution flag ①, the Plan 01 `seq` string/number trap class).

- [ ] **Step 1: Write the failing tests**

`apps/core/src/kernel/approvals/events.test.ts`:
```ts
import { approvalRequested, approvalGranted, approvalRejected } from "./events";

const actor = { type: "user", id: "01HREQUESTER0000000000000" } as const;

describe("approvals event definitions", () => {
  it("declares exactly the three catalog names under module approvals", () => {
    expect(approvalRequested.name).toBe("approval.requested");
    expect(approvalGranted.name).toBe("approval.granted");
    expect(approvalRejected.name).toBe("approval.rejected");
    for (const def of [approvalRequested, approvalGranted, approvalRejected]) {
      expect(def.module).toBe("approvals");
      expect(def.version).toBe(1);
    }
  });

  it("validates the requested payload via zod and carries correlationId through make()", () => {
    const input = approvalRequested.make({
      actor,
      correlationId: "01HINSTANCE00000000000000A",
      patientId: "01HPAT000000000000000000A",
      payload: {
        approvalId: "01HAPPROVAL000000000000000",
        typeKey: "discount_override",
        requesterId: actor.id,
        approverRole: "billing_head",
        urgencyClass: "routine",
        actedFirst: false,
        slaMinutes: 45,
        subjectType: "invoice",
        subjectId: "inv1",
        amountPaise: 50_000,
        cumulativePatientPaise: 50_000,
      },
    });
    expect(input.correlationId).toBe("01HINSTANCE00000000000000A");
    expect(input.patientId).toBe("01HPAT000000000000000000A");
    expect(() =>
      approvalRequested.make({ actor, payload: { approvalId: "x" } }),
    ).toThrow();
  });

  it("rejects an unknown urgency class and a missing note on decisions", () => {
    expect(() =>
      approvalRequested.make({
        actor,
        payload: {
          approvalId: "a", typeKey: "t", requesterId: "r", approverRole: "ar",
          urgencyClass: "critical", actedFirst: false, slaMinutes: 10,
          subjectType: "s", subjectId: "s1",
        },
      }),
    ).toThrow();
    expect(() =>
      approvalGranted.make({
        actor,
        payload: {
          approvalId: "a", typeKey: "t", requesterId: "r", decidedBy: "d",
          note: "", urgencyClass: "routine", actedFirst: false,
        },
      }),
    ).toThrow();
  });

  it("accepts a valid decision payload on both granted and rejected", () => {
    const payload = {
      approvalId: "01HAPPROVAL000000000000000",
      typeKey: "discount_override",
      requesterId: "01HREQUESTER0000000000000",
      decidedBy: "01HAPPROVER00000000000000",
      note: "senior-citizen discount verified",
      urgencyClass: "routine",
      actedFirst: false,
    } as const;
    expect(approvalGranted.make({ actor, correlationId: "c1", payload }).name).toBe("approval.granted");
    expect(approvalRejected.make({ actor, correlationId: "c1", payload }).name).toBe("approval.rejected");
  });
});
```

`apps/core/src/kernel/db/schema/approvals.test.ts`:
```ts
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { approvalTypes, approvals } from "./approvals";
import { workflowDefinitions, workflowInstances } from "./workflow";
import type { Db } from "../client";

const DEF_JSON = {
  key: "approval_discount_override",
  title: "Discount Override",
  changeClass: "C",
  initialState: "pending",
  states: [
    { name: "pending", sla: { minutes: 45, alerting: "active" } },
    { name: "granted", terminal: true },
    { name: "rejected", terminal: true },
  ],
  transitions: [
    { from: "pending", to: "granted", roles: ["billing_head"] },
    { from: "pending", to: "rejected", roles: ["billing_head"] },
  ],
};

describe("approvals tables", () => {
  let db: Db; let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  async function seedInstance(instanceId: string): Promise<void> {
    await db.insert(workflowDefinitions).values({
      id: "01HDEF000000000000000000A", defKey: "approval_discount_override", version: 1,
      title: "Discount Override", changeClass: "C", definition: DEF_JSON, draftedBy: "u1",
    }).onConflictDoNothing();
    await db.insert(workflowInstances).values({
      id: instanceId, definitionId: "01HDEF000000000000000000A",
      defKey: "approval_discount_override", currentState: "pending",
      subjectType: "invoice", subjectId: "inv1", stateEnteredAt: new Date(),
    });
  }

  it("applies defaults on approval_types and enforces its primary key", async () => {
    await db.insert(approvalTypes).values({
      typeKey: "discount_override", title: "Discount Override",
      defKey: "approval_discount_override", approverRole: "billing_head", createdBy: "u1",
    });
    const rows = await db.select().from(approvalTypes);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.urgencyClass).toBe("routine");
    expect(rows[0]!.actFirstAllowed).toBe(false);
    await expect(
      db.insert(approvalTypes).values({
        typeKey: "discount_override", title: "Again",
        defKey: "approval_discount_override_2", approverRole: "billing_head", createdBy: "u1",
      }),
    ).rejects.toThrow(); // PK
  });

  it("FK-checks approvals against approval_types and workflow_instances", async () => {
    await seedInstance("01HINST00000000000000000A");
    await expect(
      db.insert(approvals).values({
        id: "01HAP1", typeKey: "missing_type", instanceId: "01HINST00000000000000000A",
        requesterId: "u1", approverRole: "billing_head", urgencyClass: "routine",
        subjectType: "invoice", subjectId: "inv1",
      }),
    ).rejects.toThrow(); // FK to approval_types
    await db.insert(approvalTypes).values({
      typeKey: "discount_override", title: "Discount Override",
      defKey: "approval_discount_override", approverRole: "billing_head", createdBy: "u1",
    });
    await expect(
      db.insert(approvals).values({
        id: "01HAP2", typeKey: "discount_override", instanceId: "missing_instance",
        requesterId: "u1", approverRole: "billing_head", urgencyClass: "routine",
        subjectType: "invoice", subjectId: "inv1",
      }),
    ).rejects.toThrow(); // FK to workflow_instances
  });

  it("applies defaults, keeps one approval per instance, and round-trips bigint paise as numbers", async () => {
    await seedInstance("01HINST00000000000000000A");
    await db.insert(approvalTypes).values({
      typeKey: "discount_override", title: "Discount Override",
      defKey: "approval_discount_override", approverRole: "billing_head", createdBy: "u1",
    });
    await db.insert(approvals).values({
      id: "01HAP1", typeKey: "discount_override", instanceId: "01HINST00000000000000000A",
      requesterId: "u1", approverRole: "billing_head", urgencyClass: "routine",
      subjectType: "invoice", subjectId: "inv1", patientId: "01HPAT000000000000000000A",
      amountPaise: 123_456_789_012, cumulativePatientPaise: 123_456_789_012,
    });
    const rows = await db.select().from(approvals);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending");
    expect(rows[0]!.actedFirst).toBe(false);
    // bigint mode:"number" — pg returns bigint as text; drizzle must hand back a real number
    // (the Plan 01 seq string/number trap, pinned here).
    expect(typeof rows[0]!.amountPaise).toBe("number");
    expect(rows[0]!.amountPaise).toBe(123_456_789_012);
    expect(rows[0]!.cumulativePatientPaise).toBe(123_456_789_012);
    await expect(
      db.insert(approvals).values({
        id: "01HAP2", typeKey: "discount_override", instanceId: "01HINST00000000000000000A",
        requesterId: "u2", approverRole: "billing_head", urgencyClass: "routine",
        subjectType: "invoice", subjectId: "inv1",
      }),
    ).rejects.toThrow(); // unique: one approval per instance
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @hmis/core test -- --testPathPattern "approvals"`
Expected: FAIL — `./approvals` (schema) and `./events` not found.

- [ ] **Step 3: Implement the schema**

`apps/core/src/kernel/db/schema/approvals.ts`:
```ts
import {
  bigint, boolean, index, pgTable, text, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core";
import { workflowInstances } from "./workflow";

// Approval request types — the E-18 registry: every request type names a reviewer role
// and (via its workflow definition) a closure SLA. defKey points at the approval_<typeKey>
// workflow definition; behavioral validation happens in registerApprovalType (T3), not as
// an FK, because definitions are versioned rows and the type follows the ACTIVE version.
export const approvalTypes = pgTable(
  "approval_types",
  {
    typeKey: text("type_key").primaryKey(),
    title: text("title").notNull(),
    defKey: text("def_key").notNull(),
    approverRole: text("approver_role").notNull(),
    urgencyClass: text("urgency_class").notNull().default("routine"), // 'routine'|'urgent'|'emergency' (E-15, fixed per type)
    actFirstAllowed: boolean("act_first_allowed").notNull().default(false), // E-15 act-first-review-after
    createdBy: text("created_by").notNull(), // actor id, plain text: agent registrars arrive Plan 12
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("approval_types_def_key_ux").on(t.defKey)],
);

// Approval requests. State lives in TWO places by design (owner decision Q1a): the backing
// workflow instance is the arbiter (single-winner transitions, timers, escalation); this row
// mirrors terminal status for the worklist and carries the domain payload. Both move in one
// transaction (T5). Money is integer PAISE (bigint mode number — never floats).
export const approvals = pgTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    typeKey: text("type_key").notNull().references(() => approvalTypes.typeKey),
    instanceId: text("instance_id").notNull().references(() => workflowInstances.id),
    requesterId: text("requester_id").notNull(),
    approverRole: text("approver_role").notNull(), // snapshot from the type at request time (worklist filter)
    urgencyClass: text("urgency_class").notNull(), // snapshot (E-15)
    actedFirst: boolean("acted_first").notNull().default(false),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    patientId: text("patient_id"),
    encounterId: text("encounter_id"),
    payeeId: text("payee_id"),
    amountPaise: bigint("amount_paise", { mode: "number" }),
    cumulativePatientPaise: bigint("cumulative_patient_paise", { mode: "number" }), // C-12 snapshot incl. this request
    cumulativePayeePaise: bigint("cumulative_payee_paise", { mode: "number" }),     // C-12 snapshot incl. this request
    requestNote: text("request_note"),
    status: text("status").notNull().default("pending"), // 'pending'|'granted'|'rejected' — mirrors the instance state
    decisionNote: text("decision_note"),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("approvals_instance_ux").on(t.instanceId),
    index("approvals_worklist_idx").on(t.status, t.approverRole),
    index("approvals_type_idx").on(t.typeKey),
    index("approvals_patient_day_idx").on(t.patientId, t.requestedAt), // C-12 same-patient/same-day
    index("approvals_payee_day_idx").on(t.payeeId, t.requestedAt),     // C-12 same-payee/same-day
  ],
);
```

`apps/core/src/kernel/db/schema/index.ts` becomes:
```ts
export * from "./events";
export * from "./eventCursors";
export * from "./eventIdempotency";
export * from "./auth";
export * from "./workflow";
export * from "./approvals";
```

Run: `pnpm --filter @hmis/core db:generate && pnpm --filter @hmis/core db:migrate`
Expected: one new migration (`0005_*`) creating both tables with the FKs to `approval_types` and `workflow_instances` and the `approvals_instance_ux` unique index — open the generated SQL and confirm all three are present; `migrations applied`. Do NOT regenerate this migration in any later task.

- [ ] **Step 4: Extend `truncateAll`**

In `apps/core/test/helpers/db.ts`, `truncateAll` becomes (one new statement for the approvals FK group, placed **before** the workflow group because `approvals` references `workflow_instances`; everything else byte-identical — `setupTestDb` is frozen):
```ts
export async function truncateAll(db: Db): Promise<void> {
  await db.execute(sql`truncate table events restart identity`);
  await db.execute(sql`truncate table event_cursors`);
  await db.execute(sql`truncate table event_idempotency`);
  await db.execute(sql`truncate table approvals, approval_types`);
  await db.execute(
    sql`truncate table workflow_timers, workflow_transitions, workflow_instances,
        workflow_definition_approvals, workflow_definitions`,
  );
  await db.execute(
    sql`truncate table break_glass_grants, temp_role_grants, user_totp, auth_sessions,
        role_assignments, role_permissions, agents, sod_pairs, permissions, roles, users`,
  );
}
```

- [ ] **Step 5: Implement the event definitions**

`apps/core/src/kernel/approvals/events.ts`:
```ts
import { z } from "zod";
import { defineEvent } from "@hmis/contracts";

// The plan's complete event surface — three catalog names (§10.6 P7+kernel), module
// "approvals". correlationId on every emission = the backing workflow instance id (§10.5).
// sla.breached / escalation.triggered for approval flows are Plan 03's, module "workflow".

const urgency = z.enum(["routine", "urgent", "emergency"]); // E-15 classes (owner decision 2026-08-13)

export const approvalRequested = defineEvent(
  "approval.requested",
  "approvals",
  z.object({
    approvalId: z.string(),
    typeKey: z.string(),
    requesterId: z.string(),
    approverRole: z.string(),
    urgencyClass: urgency, // Plan 10's gateway routes the interrupting channel from this
    actedFirst: z.boolean(), // E-15 act-first-review-after, loud in the payload
    slaMinutes: z.number().int().positive(), // E-18 closure SLA, for Plan 10's matrices
    subjectType: z.string(),
    subjectId: z.string(),
    payeeId: z.string().optional(),
    amountPaise: z.number().int().positive().optional(),
    cumulativePatientPaise: z.number().int().positive().optional(), // C-12 snapshot incl. this request
    cumulativePayeePaise: z.number().int().positive().optional(),
  }),
);

const decisionPayload = z.object({
  approvalId: z.string(),
  typeKey: z.string(),
  requesterId: z.string(),
  decidedBy: z.string(),
  note: z.string().min(1), // §8: approve/reject with note — runtime-trimmed upstream (T5)
  urgencyClass: urgency,
  actedFirst: z.boolean(), // a rejected acted-first item is an after-the-fact rejection (consumer domain)
});

export const approvalGranted = defineEvent("approval.granted", "approvals", decisionPayload);
export const approvalRejected = defineEvent("approval.rejected", "approvals", decisionPayload);
```

- [ ] **Step 6: Run to verify pass, then the full suite**

Run: `pnpm --filter @hmis/core test -- --testPathPattern "approvals"`
Expected: PASS (flow 6, events 4, schema 3).

Run: `pnpm verify`
Expected: PASS — full suite green (the extended truncate list must not break any existing suite).

- [ ] **Step 7: Commit**

```bash
git add apps/core
git commit -m "feat(approvals): schema for approval types and requests (migration 0005) + three catalog event defs"
```

---
### Task 3: Type registry + `cumulativeAmount` — C-12 aggregation (report-only)

**Files:**
- Create: `apps/core/src/kernel/approvals/types.ts`, `apps/core/src/kernel/approvals/cumulative.ts`
- Test: `apps/core/src/kernel/approvals/types.test.ts`, `apps/core/src/kernel/approvals/cumulative.test.ts`

**Interfaces:**
- Consumes: `approvalTypes`, `approvals` schema (T2); `APPROVAL_DEF_PREFIX`, `approvalFlowDefinition` (T1); `getActiveDefinition` from `../workflow/definitions` (Plan 03 — signature `getActiveDefinition(tx, defKey): Promise<(DefinitionRow & { parsed: WorkflowDefinition }) | null>`); `createDraft`/`activateDefinition` (Plan 03, test fixtures only); `withTx`, `Db`, `Tx` (Plan 01); `Actor` from `@hmis/contracts`.
- Produces (exact — T4/T5/T6/T7 use these):
  - `const URGENCY_CLASSES = ["routine", "urgent", "emergency"] as const` · `type UrgencyClass = (typeof URGENCY_CLASSES)[number]`
  - `class ApprovalError extends Error { readonly code: ApprovalErrorCode }` with `type ApprovalErrorCode = "unknown_type" | "duplicate_type" | "definition_not_active" | "definition_mismatch" | "user_actor_required" | "act_first_not_allowed" | "note_required" | "invalid_amount" | "amount_needs_target" | "invalid_cumulative_query" | "unknown_approval" | "not_pending"` — **defined once, here**; T4/T5/T6 reuse it and T7's controller maps it once (the `WorkflowError` convention from Plan 03).
  - `type ApprovalTypeRow = typeof approvalTypes.$inferSelect`
  - `type ApprovalTypeSpec = { typeKey: string; title: string; approverRole: string; urgencyClass?: UrgencyClass; actFirstAllowed?: boolean }`
  - `registerApprovalType(db: Db, actor: Actor, spec: ApprovalTypeSpec): Promise<{ typeKey: string; defKey: string }>` — user actors only; requires an ACTIVE `approval_<typeKey>` definition and verifies it carries the engine's load-bearing shape (E-18 enforcement, see below); the insert is conditional (`onConflictDoNothing().returning()`), so a duplicate loses without read-then-write.
  - `getApprovalType(tx: Tx, typeKey: string): Promise<ApprovalTypeRow | null>`
  - `const IST_UTC_OFFSET_MINUTES = 330` — design-law constant (Asia/Kolkata is fixed UTC+05:30, no DST), not config.
  - `istDayWindow(now: Date): { start: Date; end: Date }` — the IST calendar day containing `now`, as UTC instants (start inclusive, end exclusive).
  - `type CumulativeQuery = { typeKey: string; patientId?: string; payeeId?: string; window: { start: Date; end: Date } }`
  - `cumulativeAmount(tx: Tx, q: CumulativeQuery): Promise<number>` — SUM of `amount_paise` over this type's requests for the given patient **or** payee (exactly one; both/neither throws `invalid_cumulative_query`) inside the window, counting `pending` + `granted` and excluding `rejected` (C-12 owner decision). Returns a real `number` (SQL `sum` arrives as text — forced, pinned by test). **Report-only: nothing in this plan blocks on the value** — thresholds are CA-configured data arriving with Plans 06/08.
- Registering a type emits **no event** (catalog discipline: the definition lifecycle already emitted `workflow.definition.updated`; no catalog name exists for type registration).
- Registration is a **two-step operational flow by design** (owner decision Q1a): (1) activate the builder's definition through Plan 03's own APIs (`createDraft` → `activateDefinition`; Class C needs no approvals, drafter≠activator SoD still applies), (2) `registerApprovalType` points the type at it. The registry never wraps Plan 03 governance.

**E-18 shape verification in `registerApprovalType`** (all problems collected, thrown as one `definition_mismatch`): initial state is `pending` and carries an SLA · `granted` and `rejected` exist and are terminal · transitions `pending→granted` and `pending→rejected` exist · `spec.approverRole` is allowed on both.

- [ ] **Step 1: Write the failing tests**

`apps/core/src/kernel/approvals/types.test.ts`:
```ts
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { registerApprovalType, getApprovalType, ApprovalError } from "./types";
import { approvalFlowDefinition } from "./flow";
import { createDraft, activateDefinition } from "../workflow/definitions";
import { createUser } from "../auth/identity";
import { seedSodPairs } from "../auth/sod";
import { withTx } from "../db/client";
import type { Db } from "../db/client";
import type { Actor } from "@hmis/contracts";

const DRAFTER: Actor = { type: "user", id: "01HDRAFTER000000000000000" };

describe("approval type registry", () => {
  let db: Db; let teardown: () => Promise<void>;
  let activator: Actor;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    await seedSodPairs(db);
    const { id } = await createUser(db, { username: "activator1", fullName: "A", password: "p1234567" });
    activator = { type: "user", id };
  });

  async function activateFlow(typeKey: string, approverRole: string): Promise<void> {
    const def = approvalFlowDefinition({
      typeKey, title: `Flow ${typeKey}`, approverRole, closureSlaMinutes: 45,
    });
    const { definitionId } = await createDraft(db, DRAFTER, def);
    await activateDefinition(db, activator, definitionId);
  }

  it("registers a type against its active definition and reads it back", async () => {
    await activateFlow("discount_override", "billing_head");
    const result = await registerApprovalType(db, activator, {
      typeKey: "discount_override", title: "Discount Override", approverRole: "billing_head",
    });
    expect(result).toEqual({ typeKey: "discount_override", defKey: "approval_discount_override" });
    await withTx(db, async (tx) => {
      const row = await getApprovalType(tx, "discount_override");
      expect(row).toMatchObject({
        typeKey: "discount_override",
        defKey: "approval_discount_override",
        approverRole: "billing_head",
        urgencyClass: "routine",
        actFirstAllowed: false,
        createdBy: activator.id,
      });
      expect(await getApprovalType(tx, "missing")).toBeNull();
    });
  });

  it("stores the E-15 fields when given", async () => {
    await activateFlow("icu_admission", "duty_doctor");
    await registerApprovalType(db, activator, {
      typeKey: "icu_admission", title: "ICU Admission", approverRole: "duty_doctor",
      urgencyClass: "emergency", actFirstAllowed: true,
    });
    await withTx(db, async (tx) => {
      const row = await getApprovalType(tx, "icu_admission");
      expect(row).toMatchObject({ urgencyClass: "emergency", actFirstAllowed: true });
    });
  });

  it("refuses a type with no active definition", async () => {
    await expect(
      registerApprovalType(db, activator, {
        typeKey: "unbacked", title: "Unbacked", approverRole: "r",
      }),
    ).rejects.toMatchObject({ code: "definition_not_active" });
  });

  it("refuses a definition whose shape the engine does not depend on (E-18)", async () => {
    // A REAL Plan 03 definition, but not the approval shape: approverRole differs.
    await activateFlow("mismatch_role", "billing_head");
    await expect(
      registerApprovalType(db, activator, {
        typeKey: "mismatch_role", title: "Wrong Role", approverRole: "someone_else",
      }),
    ).rejects.toMatchObject({ code: "definition_mismatch" });
  });

  it("refuses a duplicate type without read-then-write", async () => {
    await activateFlow("dup_type", "billing_head");
    await registerApprovalType(db, activator, {
      typeKey: "dup_type", title: "Dup", approverRole: "billing_head",
    });
    await expect(
      registerApprovalType(db, activator, {
        typeKey: "dup_type", title: "Dup again", approverRole: "billing_head",
      }),
    ).rejects.toMatchObject({ code: "duplicate_type" });
  });

  it("refuses non-user actors", async () => {
    await expect(
      registerApprovalType(db, { type: "agent", id: "a1" }, {
        typeKey: "x", title: "X", approverRole: "r",
      }),
    ).rejects.toMatchObject({ code: "user_actor_required" });
    expect(new ApprovalError("unknown_type").code).toBe("unknown_type");
  });
});
```

`apps/core/src/kernel/approvals/cumulative.test.ts`:
```ts
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { cumulativeAmount, istDayWindow, IST_UTC_OFFSET_MINUTES } from "./cumulative";
import { approvals, approvalTypes, workflowDefinitions, workflowInstances } from "../db/schema";
import { withTx } from "../db/client";
import type { Db } from "../db/client";

describe("istDayWindow (pure)", () => {
  it("is the fixed IST offset, not config", () => {
    expect(IST_UTC_OFFSET_MINUTES).toBe(330);
  });

  it("maps a UTC evening into the NEXT IST calendar day", () => {
    // 2026-08-13T19:45Z = 2026-08-14T01:15 IST → window = IST Aug 14
    const { start, end } = istDayWindow(new Date("2026-08-13T19:45:00.000Z"));
    expect(start.toISOString()).toBe("2026-08-13T18:30:00.000Z");
    expect(end.toISOString()).toBe("2026-08-14T18:30:00.000Z");
  });

  it("maps a UTC morning into the SAME IST calendar day", () => {
    // 2026-08-13T10:00Z = 2026-08-13T15:30 IST → window = IST Aug 13
    const { start, end } = istDayWindow(new Date("2026-08-13T10:00:00.000Z"));
    expect(start.toISOString()).toBe("2026-08-12T18:30:00.000Z");
    expect(end.toISOString()).toBe("2026-08-13T18:30:00.000Z");
  });

  it("treats IST midnight as the start of its own day", () => {
    const { start } = istDayWindow(new Date("2026-08-13T18:30:00.000Z")); // exactly 00:00 IST Aug 14
    expect(start.toISOString()).toBe("2026-08-13T18:30:00.000Z");
  });
});

describe("cumulativeAmount (C-12)", () => {
  let db: Db; let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  const DEF_JSON = {
    key: "approval_discount_override", title: "Discount Override", changeClass: "C",
    initialState: "pending",
    states: [
      { name: "pending", sla: { minutes: 45, alerting: "active" } },
      { name: "granted", terminal: true },
      { name: "rejected", terminal: true },
    ],
    transitions: [
      { from: "pending", to: "granted", roles: ["billing_head"] },
      { from: "pending", to: "rejected", roles: ["billing_head"] },
    ],
  };

  let seq = 0;
  async function seedApproval(row: {
    typeKey?: string; status?: string; patientId?: string; payeeId?: string;
    amountPaise: number; requestedAt: Date;
  }): Promise<void> {
    seq += 1;
    const typeKey = row.typeKey ?? "discount_override";
    const instanceId = `01HINST${String(seq).padStart(19, "0")}`;
    await db.insert(workflowDefinitions).values({
      id: "01HDEF000000000000000000A", defKey: "approval_discount_override", version: 1,
      title: "Discount Override", changeClass: "C", definition: DEF_JSON, draftedBy: "u1",
    }).onConflictDoNothing();
    await db.insert(approvalTypes).values({
      typeKey, title: typeKey, defKey: `approval_${typeKey}`,
      approverRole: "billing_head", createdBy: "u1",
    }).onConflictDoNothing();
    await db.insert(workflowInstances).values({
      id: instanceId, definitionId: "01HDEF000000000000000000A",
      defKey: "approval_discount_override", currentState: "pending",
      subjectType: "invoice", subjectId: `inv${seq}`, stateEnteredAt: new Date(),
    });
    await db.insert(approvals).values({
      id: `01HAP${String(seq).padStart(21, "0")}`, typeKey, instanceId,
      requesterId: "u1", approverRole: "billing_head", urgencyClass: "routine",
      subjectType: "invoice", subjectId: `inv${seq}`,
      patientId: row.patientId, payeeId: row.payeeId,
      amountPaise: row.amountPaise, status: row.status ?? "pending",
      requestedAt: row.requestedAt,
    });
  }

  const PAT = "01HPAT000000000000000000A";
  const OTHER_PAT = "01HPAT000000000000000000B";
  const PAYEE = "01HPAYEE00000000000000000";
  const IN = new Date("2026-08-13T10:00:00.000Z");     // inside the IST Aug 13 window
  const BEFORE = new Date("2026-08-12T17:00:00.000Z"); // IST Aug 12 — outside
  const WINDOW = istDayWindow(IN);

  it("sums pending + granted for the same patient, same type, same IST day — rejected excluded", async () => {
    await seedApproval({ patientId: PAT, amountPaise: 50_000, requestedAt: IN });
    await seedApproval({ patientId: PAT, amountPaise: 30_000, requestedAt: IN, status: "granted" });
    await seedApproval({ patientId: PAT, amountPaise: 999_999, requestedAt: IN, status: "rejected" });
    await seedApproval({ patientId: OTHER_PAT, amountPaise: 11_111, requestedAt: IN });
    await seedApproval({ patientId: PAT, amountPaise: 77_777, requestedAt: BEFORE });
    await seedApproval({ typeKey: "other_type", patientId: PAT, amountPaise: 44_444, requestedAt: IN });
    const total = await withTx(db, (tx) =>
      cumulativeAmount(tx, { typeKey: "discount_override", patientId: PAT, window: WINDOW }),
    );
    expect(typeof total).toBe("number"); // SUM arrives as text from pg — must be forced to number
    expect(total).toBe(80_000);
  });

  it("aggregates by payee independently of patient", async () => {
    await seedApproval({ payeeId: PAYEE, amountPaise: 20_000, requestedAt: IN });
    await seedApproval({ payeeId: PAYEE, amountPaise: 25_000, requestedAt: IN, status: "granted" });
    await seedApproval({ patientId: PAT, amountPaise: 90_000, requestedAt: IN });
    const total = await withTx(db, (tx) =>
      cumulativeAmount(tx, { typeKey: "discount_override", payeeId: PAYEE, window: WINDOW }),
    );
    expect(total).toBe(45_000);
  });

  it("window boundaries: start inclusive, end exclusive", async () => {
    await seedApproval({ patientId: PAT, amountPaise: 1_000, requestedAt: WINDOW.start });
    await seedApproval({ patientId: PAT, amountPaise: 2_000, requestedAt: WINDOW.end });
    const total = await withTx(db, (tx) =>
      cumulativeAmount(tx, { typeKey: "discount_override", patientId: PAT, window: WINDOW }),
    );
    expect(total).toBe(1_000);
  });

  it("returns 0 (a real number) when nothing matches", async () => {
    const total = await withTx(db, (tx) =>
      cumulativeAmount(tx, { typeKey: "discount_override", patientId: PAT, window: WINDOW }),
    );
    expect(total).toBe(0);
    expect(typeof total).toBe("number");
  });

  it("requires exactly one of patientId / payeeId", async () => {
    await expect(
      withTx(db, (tx) =>
        cumulativeAmount(tx, { typeKey: "discount_override", window: WINDOW }),
      ),
    ).rejects.toMatchObject({ code: "invalid_cumulative_query" });
    await expect(
      withTx(db, (tx) =>
        cumulativeAmount(tx, {
          typeKey: "discount_override", patientId: PAT, payeeId: PAYEE, window: WINDOW,
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_cumulative_query" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @hmis/core test -- --testPathPattern "approvals/(types|cumulative)"`
Expected: FAIL — `./types` and `./cumulative` not found.

- [ ] **Step 3: Implement the registry**

`apps/core/src/kernel/approvals/types.ts`:
```ts
import { eq } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { approvalTypes } from "../db/schema";
import { getActiveDefinition } from "../workflow/definitions";
import { withTx } from "../db/client";
import { APPROVAL_DEF_PREFIX } from "./flow";
import type { Db, Tx } from "../db/client";

export const URGENCY_CLASSES = ["routine", "urgent", "emergency"] as const; // E-15 (owner decision 2026-08-13)
export type UrgencyClass = (typeof URGENCY_CLASSES)[number];

export type ApprovalErrorCode =
  | "unknown_type"
  | "duplicate_type"
  | "definition_not_active"
  | "definition_mismatch"
  | "user_actor_required"
  | "act_first_not_allowed"
  | "note_required"
  | "invalid_amount"
  | "amount_needs_target"
  | "invalid_cumulative_query"
  | "unknown_approval"
  | "not_pending";

/** Defined once here; T4/T5/T6 reuse it and the controller maps it once (Plan 03's WorkflowError convention). */
export class ApprovalError extends Error {
  constructor(
    readonly code: ApprovalErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ApprovalError";
  }
}

export type ApprovalTypeRow = typeof approvalTypes.$inferSelect;

export type ApprovalTypeSpec = {
  typeKey: string;
  title: string;
  approverRole: string;
  urgencyClass?: UrgencyClass;
  actFirstAllowed?: boolean;
};

/**
 * The E-18 registry: every request type names a reviewer role + closure SLA, structurally.
 * Registration is step 2 of a two-step flow — the approval_<typeKey> definition must already
 * be ACTIVE (drafted + activated through Plan 03's own governance APIs; Class C by default).
 * The registry validates the active definition carries the engine's load-bearing shape and
 * refuses otherwise; it never wraps or re-implements Plan 03 governance. No event is minted:
 * the definition lifecycle already emitted workflow.definition.updated.
 */
export async function registerApprovalType(
  db: Db,
  actor: Actor,
  spec: ApprovalTypeSpec,
): Promise<{ typeKey: string; defKey: string }> {
  if (actor.type !== "user") {
    throw new ApprovalError("user_actor_required", "only user actors may register approval types (agents are the Plan 12 seam)");
  }
  const defKey = `${APPROVAL_DEF_PREFIX}${spec.typeKey}`;
  return withTx(db, async (tx) => {
    const active = await getActiveDefinition(tx, defKey);
    if (!active) {
      throw new ApprovalError("definition_not_active", `no active workflow definition ${defKey} — draft and activate it first (T1 builder + Plan 03 APIs)`);
    }
    const def = active.parsed;
    const problems: string[] = [];
    if (def.initialState !== "pending") problems.push(`initialState must be "pending", got "${def.initialState}"`);
    const pending = def.states.find((s) => s.name === "pending");
    if (!pending?.sla) problems.push('state "pending" must carry an SLA (E-18 closure SLA)');
    for (const to of ["granted", "rejected"] as const) {
      const state = def.states.find((s) => s.name === to);
      if (!state?.terminal) problems.push(`state "${to}" must exist and be terminal`);
      const t = def.transitions.find((x) => x.from === "pending" && x.to === to);
      if (!t) problems.push(`missing transition pending→${to}`);
      else if (!t.roles.includes(spec.approverRole)) {
        problems.push(`approverRole "${spec.approverRole}" is not allowed on pending→${to}`);
      }
    }
    if (problems.length > 0) throw new ApprovalError("definition_mismatch", problems.join("; "));
    const inserted = await tx
      .insert(approvalTypes)
      .values({
        typeKey: spec.typeKey,
        title: spec.title,
        defKey,
        approverRole: spec.approverRole,
        urgencyClass: spec.urgencyClass ?? "routine",
        actFirstAllowed: spec.actFirstAllowed ?? false,
        createdBy: actor.id,
      })
      .onConflictDoNothing()
      .returning({ typeKey: approvalTypes.typeKey });
    if (inserted.length === 0) {
      throw new ApprovalError("duplicate_type", `approval type ${spec.typeKey} already exists`);
    }
    return { typeKey: spec.typeKey, defKey };
  });
}

export async function getApprovalType(tx: Tx, typeKey: string): Promise<ApprovalTypeRow | null> {
  const rows = await tx.select().from(approvalTypes).where(eq(approvalTypes.typeKey, typeKey));
  return rows[0] ?? null;
}
```

- [ ] **Step 4: Implement the cumulative helper**

`apps/core/src/kernel/approvals/cumulative.ts`:
```ts
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { approvals } from "../db/schema";
import { ApprovalError } from "./types";
import type { Tx } from "../db/client";

/**
 * C-12 anti-structuring aggregation (owner decisions 2026-08-13): the window is the IST
 * CALENDAR DAY (spec text: "same-day"); pending + granted count, rejected is excluded
 * (a rejected-then-resubmitted request must not double-count); the helper REPORTS and
 * never blocks — threshold values are CA-configured data arriving with Plans 06/08.
 * IST is fixed UTC+05:30 with no DST — a design-law constant for this single-site Indian
 * hospital, deliberately not a config value (no-config-fallbacks rule).
 */
export const IST_UTC_OFFSET_MINUTES = 330;
const DAY_MS = 24 * 60 * 60_000;
const OFFSET_MS = IST_UTC_OFFSET_MINUTES * 60_000;

export function istDayWindow(now: Date): { start: Date; end: Date } {
  const istMs = now.getTime() + OFFSET_MS;
  const istDayStartMs = Math.floor(istMs / DAY_MS) * DAY_MS;
  const start = new Date(istDayStartMs - OFFSET_MS);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

export type CumulativeQuery = {
  typeKey: string;
  patientId?: string;
  payeeId?: string;
  window: { start: Date; end: Date };
};

export async function cumulativeAmount(tx: Tx, q: CumulativeQuery): Promise<number> {
  const byPatient = q.patientId !== undefined;
  const byPayee = q.payeeId !== undefined;
  if (byPatient === byPayee) {
    throw new ApprovalError("invalid_cumulative_query", "exactly one of patientId or payeeId is required");
  }
  const target = byPatient
    ? eq(approvals.patientId, q.patientId as string)
    : eq(approvals.payeeId, q.payeeId as string);
  const rows = await tx
    .select({ total: sql<string>`coalesce(sum(${approvals.amountPaise}), 0)` })
    .from(approvals)
    .where(
      and(
        eq(approvals.typeKey, q.typeKey),
        inArray(approvals.status, ["pending", "granted"]), // C-12: rejected excluded (owner decision)
        target,
        gte(approvals.requestedAt, q.window.start), // start inclusive
        lt(approvals.requestedAt, q.window.end),    // end exclusive
      ),
    );
  // SQL sum() arrives as text through the pg driver — force a real number (Plan 01 seq trap).
  return Number(rows[0]!.total);
}
```

- [ ] **Step 5: Run to verify pass, then the full suite**

Run: `pnpm --filter @hmis/core test -- --testPathPattern "approvals/(types|cumulative)"`
Expected: PASS (types 6, cumulative 9).

Run: `pnpm verify`
Expected: PASS — full suite green, zero lint problems.

- [ ] **Step 6: Commit**

```bash
git add apps/core/src/kernel/approvals
git commit -m "feat(approvals): type registry + C-12 cumulative same-day aggregation helper"
```

---
### Task 4: `requestApproval` — instance-backed requests

**Files:**
- Create: `apps/core/src/kernel/approvals/requests.ts`
- Test: `apps/core/src/kernel/approvals/requests.test.ts`

**Interfaces:**
- Consumes: `startInstance` from `../workflow/instances` (Plan 03 — `startInstance(tx, defKey, subject)`, schedules the initial state's SLA timer, throws `WorkflowError` `no_active_definition` on a missing active definition); `getActiveDefinition` (Plan 03); `getApprovalType`, `ApprovalError`, `UrgencyClass` (T3); `cumulativeAmount`, `istDayWindow` (T3); `approvals` schema (T2); `approvalRequested` (T2); `appendEvent` (Plan 01); `newId` from `@hmis/contracts`.
- Produces (exact — T5/T6/T7/T8 and later consumer plans call this; roadmap Produces line, with the requester made explicit because SoD needs the requester's identity):
  - `type ApprovalRequestInput = { typeKey: string; subject: { type: string; id: string }; patientId?: string; encounterId?: string; payeeId?: string; amountPaise?: number; requestNote?: string; actFirst?: boolean }`
  - `requestApproval(tx: Tx, requester: Actor, input: ApprovalRequestInput): Promise<{ approvalId: string; instanceId: string }>` — **runs on the caller's transaction** (Plan 08's billing files requests atomically with its own state change, exactly like `appendEvent`/`startInstance`).
- Semantics, in order (each rule tested):
  1. `requester.type === "user"` or `user_actor_required` (agents are the Plan 12 seam; a `system` requester has no SoD identity).
  2. Type must exist (`unknown_type`).
  3. E-15 act-first: `actFirst: true` needs `type.actFirstAllowed` (`act_first_not_allowed`) AND a non-empty trimmed `requestNote` (`note_required`) — runtime checks.
  4. Money: `amountPaise` must be a positive integer (`invalid_amount`) and needs `patientId` or `payeeId` for C-12 aggregation (`amount_needs_target`).
  5. The active definition is read for the pending state's `sla.minutes` (event payload `slaMinutes`, E-18); a definition without it is `definition_mismatch` (defense in depth — T3's registry already refuses such definitions).
  6. C-12 snapshots computed **before** the insert and stored **including this request's amount**: `cumulativePatientPaise` when `patientId` present, `cumulativePayeePaise` when `payeeId` present — visible to the approver in the worklist and in the event payload.
  7. `startInstance` pins the instance (state `pending`, SLA timer scheduled by Plan 03 — no timer code here); the `approvals` row inserts with `approverRole`/`urgencyClass` snapshots from the type; `approval.requested` appends on the same tx with `correlationId` = instance id.

- [ ] **Step 1: Write the failing tests**

`apps/core/src/kernel/approvals/requests.test.ts`:
```ts
import { and, eq, isNull } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { requestApproval } from "./requests";
import { registerApprovalType } from "./types";
import { approvalFlowDefinition } from "./flow";
import { createDraft, activateDefinition } from "../workflow/definitions";
import { createUser } from "../auth/identity";
import { seedSodPairs } from "../auth/sod";
import { approvals, events, workflowInstances, workflowTimers } from "../db/schema";
import { withTx } from "../db/client";
import type { Db } from "../db/client";
import type { Actor } from "@hmis/contracts";

const DRAFTER: Actor = { type: "user", id: "01HDRAFTER000000000000000" };
const PAT = "01HPAT000000000000000000A";

describe("requestApproval", () => {
  let db: Db; let teardown: () => Promise<void>;
  let activator: Actor; let requester: Actor;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    await seedSodPairs(db);
    const mk = async (username: string): Promise<Actor> => {
      const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
      return { type: "user", id };
    };
    activator = await mk("activator1");
    requester = await mk("requester1");
    const def = approvalFlowDefinition({
      typeKey: "discount_override", title: "Discount Override",
      approverRole: "billing_head", closureSlaMinutes: 45,
    });
    const { definitionId } = await createDraft(db, DRAFTER, def);
    await activateDefinition(db, activator, definitionId);
    await registerApprovalType(db, activator, {
      typeKey: "discount_override", title: "Discount Override", approverRole: "billing_head",
    });
  });

  async function registerActFirstType(): Promise<void> {
    const def = approvalFlowDefinition({
      typeKey: "icu_admission", title: "ICU Admission",
      approverRole: "duty_doctor", closureSlaMinutes: 30,
    });
    const { definitionId } = await createDraft(db, DRAFTER, def);
    await activateDefinition(db, activator, definitionId);
    await registerApprovalType(db, activator, {
      typeKey: "icu_admission", title: "ICU Admission", approverRole: "duty_doctor",
      urgencyClass: "emergency", actFirstAllowed: true,
    });
  }

  it("starts a pending instance, snapshots C-12, and appends approval.requested", async () => {
    const { approvalId, instanceId } = await withTx(db, (tx) =>
      requestApproval(tx, requester, {
        typeKey: "discount_override",
        subject: { type: "invoice", id: "inv1" },
        patientId: PAT,
        amountPaise: 50_000,
        requestNote: "20% senior-citizen discount",
      }),
    );
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(row).toMatchObject({
      typeKey: "discount_override",
      instanceId,
      requesterId: requester.id,
      approverRole: "billing_head", // snapshot from the type
      urgencyClass: "routine",      // snapshot from the type
      actedFirst: false,
      subjectType: "invoice",
      subjectId: "inv1",
      patientId: PAT,
      amountPaise: 50_000,
      cumulativePatientPaise: 50_000, // includes this request
      cumulativePayeePaise: null,     // no payee ref given
      status: "pending",
    });
    const [instance] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId));
    expect(instance).toMatchObject({ currentState: "pending", status: "active", patientId: PAT });
    // Plan 03 scheduled the SLA timer from the definition's closure SLA — no timer code here.
    const timers = await db.select().from(workflowTimers).where(
      and(eq(workflowTimers.instanceId, instanceId), isNull(workflowTimers.firedAt), isNull(workflowTimers.cancelledAt)),
    );
    expect(timers).toHaveLength(1);
    expect(timers[0]!).toMatchObject({ kind: "sla", state: "pending" });
    expect(timers[0]!.dueAt.getTime()).toBe(instance!.stateEnteredAt.getTime() + 45 * 60_000);
    const evts = await db.select().from(events).where(eq(events.name, "approval.requested"));
    expect(evts).toHaveLength(1);
    expect(evts[0]!.correlationId).toBe(instanceId);
    expect(evts[0]!.patientId).toBe(PAT);
    expect(evts[0]!.payload).toMatchObject({
      approvalId, typeKey: "discount_override", approverRole: "billing_head",
      urgencyClass: "routine", actedFirst: false, slaMinutes: 45,
      amountPaise: 50_000, cumulativePatientPaise: 50_000,
    });
  });

  it("accumulates the same-day cumulative across sequential requests (C-12)", async () => {
    await withTx(db, (tx) =>
      requestApproval(tx, requester, {
        typeKey: "discount_override", subject: { type: "invoice", id: "inv1" },
        patientId: PAT, amountPaise: 50_000,
      }),
    );
    const { approvalId } = await withTx(db, (tx) =>
      requestApproval(tx, requester, {
        typeKey: "discount_override", subject: { type: "invoice", id: "inv2" },
        patientId: PAT, amountPaise: 80_000,
      }),
    );
    const [second] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(second!.cumulativePatientPaise).toBe(130_000);
  });

  it("snapshots payee aggregation independently", async () => {
    const PAYEE = "01HPAYEE00000000000000000";
    await withTx(db, (tx) =>
      requestApproval(tx, requester, {
        typeKey: "discount_override", subject: { type: "payout", id: "p1" },
        payeeId: PAYEE, amountPaise: 20_000,
      }),
    );
    const { approvalId } = await withTx(db, (tx) =>
      requestApproval(tx, requester, {
        typeKey: "discount_override", subject: { type: "payout", id: "p2" },
        payeeId: PAYEE, amountPaise: 30_000,
      }),
    );
    const [second] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(second!.cumulativePayeePaise).toBe(50_000);
    expect(second!.cumulativePatientPaise).toBeNull();
  });

  it("act-first: allowed only where the type allows it, and only with a justification note", async () => {
    await expect(
      withTx(db, (tx) =>
        requestApproval(tx, requester, {
          typeKey: "discount_override", subject: { type: "invoice", id: "inv1" },
          actFirst: true, requestNote: "urgent",
        }),
      ),
    ).rejects.toMatchObject({ code: "act_first_not_allowed" });
    await registerActFirstType();
    await expect(
      withTx(db, (tx) =>
        requestApproval(tx, requester, {
          typeKey: "icu_admission", subject: { type: "encounter", id: "e1" },
          actFirst: true, requestNote: "   ",
        }),
      ),
    ).rejects.toMatchObject({ code: "note_required" });
    const { approvalId } = await withTx(db, (tx) =>
      requestApproval(tx, requester, {
        typeKey: "icu_admission", subject: { type: "encounter", id: "e1" },
        patientId: PAT, actFirst: true, requestNote: "patient unstable — admitted first (E-15)",
      }),
    );
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(row).toMatchObject({ actedFirst: true, urgencyClass: "emergency" });
    const evts = await db.select().from(events).where(eq(events.name, "approval.requested"));
    expect(evts[0]!.payload).toMatchObject({ actedFirst: true, urgencyClass: "emergency" });
  });

  it("validates money inputs (positive integer paise; needs a C-12 target)", async () => {
    await expect(
      withTx(db, (tx) =>
        requestApproval(tx, requester, {
          typeKey: "discount_override", subject: { type: "invoice", id: "inv1" },
          patientId: PAT, amountPaise: 0,
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_amount" });
    await expect(
      withTx(db, (tx) =>
        requestApproval(tx, requester, {
          typeKey: "discount_override", subject: { type: "invoice", id: "inv1" },
          patientId: PAT, amountPaise: 12.5,
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_amount" });
    await expect(
      withTx(db, (tx) =>
        requestApproval(tx, requester, {
          typeKey: "discount_override", subject: { type: "invoice", id: "inv1" },
          amountPaise: 1_000,
        }),
      ),
    ).rejects.toMatchObject({ code: "amount_needs_target" });
  });

  it("refuses unknown types and non-user actors", async () => {
    await expect(
      withTx(db, (tx) =>
        requestApproval(tx, requester, { typeKey: "nope", subject: { type: "t", id: "s" } }),
      ),
    ).rejects.toMatchObject({ code: "unknown_type" });
    await expect(
      withTx(db, (tx) =>
        requestApproval(tx, { type: "agent", id: "a1" }, {
          typeKey: "discount_override", subject: { type: "t", id: "s" },
        }),
      ),
    ).rejects.toMatchObject({ code: "user_actor_required" });
    await expect(
      withTx(db, (tx) =>
        requestApproval(tx, { type: "system", id: "sys" }, {
          typeKey: "discount_override", subject: { type: "t", id: "s" },
        }),
      ),
    ).rejects.toMatchObject({ code: "user_actor_required" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @hmis/core test -- --testPathPattern "approvals/requests"`
Expected: FAIL — `./requests` not found.

- [ ] **Step 3: Implement**

`apps/core/src/kernel/approvals/requests.ts`:
```ts
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { appendEvent } from "../events/append";
import { getActiveDefinition } from "../workflow/definitions";
import { startInstance } from "../workflow/instances";
import { approvals } from "../db/schema";
import { approvalRequested } from "./events";
import { cumulativeAmount, istDayWindow } from "./cumulative";
import { ApprovalError, getApprovalType } from "./types";
import type { UrgencyClass } from "./types";
import type { Tx } from "../db/client";

export type ApprovalRequestInput = {
  typeKey: string;
  subject: { type: string; id: string };
  patientId?: string;
  encounterId?: string;
  payeeId?: string;
  amountPaise?: number; // integer PAISE — never floats near money
  requestNote?: string;
  actFirst?: boolean; // E-15 act-first-review-after (needs type.actFirstAllowed + a note)
};

/**
 * Files an approval request as a workflow instance of approval_<typeKey> (owner decision
 * Q1a): Plan 03 schedules the closure-SLA timer and climbs the escalation ladder — this
 * function writes no timer code. Runs on the CALLER'S transaction so consumer plans
 * (billing, Plan 08) file requests atomically with their own state change.
 */
export async function requestApproval(
  tx: Tx,
  requester: Actor,
  input: ApprovalRequestInput,
): Promise<{ approvalId: string; instanceId: string }> {
  if (requester.type !== "user") {
    throw new ApprovalError("user_actor_required", "only user actors may request approvals (agent requesters are the Plan 12 seam; a system requester has no SoD identity)");
  }
  const type = await getApprovalType(tx, input.typeKey);
  if (!type) throw new ApprovalError("unknown_type", `unknown approval type ${input.typeKey}`);

  const actedFirst = input.actFirst === true;
  if (actedFirst && !type.actFirstAllowed) {
    throw new ApprovalError("act_first_not_allowed", `type ${type.typeKey} does not allow act-first (E-15: per-type capability)`);
  }
  if (actedFirst && (input.requestNote ?? "").trim() === "") {
    throw new ApprovalError("note_required", "an act-first request must carry a justification note (E-15)");
  }
  if (input.amountPaise !== undefined) {
    if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) {
      throw new ApprovalError("invalid_amount", "amountPaise must be a positive integer (paise)");
    }
    if (input.patientId === undefined && input.payeeId === undefined) {
      throw new ApprovalError("amount_needs_target", "a money request needs patientId or payeeId for C-12 aggregation");
    }
  }

  const active = await getActiveDefinition(tx, type.defKey);
  if (!active) throw new ApprovalError("definition_not_active", `no active workflow definition ${type.defKey}`);
  const slaMinutes = active.parsed.states.find((s) => s.name === "pending")?.sla?.minutes;
  if (slaMinutes === undefined) {
    // Defense in depth: T3's registry refuses such definitions at registration time.
    throw new ApprovalError("definition_mismatch", `definition ${type.defKey} carries no SLA on "pending"`);
  }

  // C-12 snapshots — today's cumulative INCLUDING this request (IST calendar day,
  // pending+granted). Report-only: thresholds are the consumer plans' CA-configured data.
  const window = istDayWindow(new Date());
  let cumulativePatientPaise: number | undefined;
  let cumulativePayeePaise: number | undefined;
  if (input.amountPaise !== undefined && input.patientId !== undefined) {
    cumulativePatientPaise =
      (await cumulativeAmount(tx, { typeKey: type.typeKey, patientId: input.patientId, window })) +
      input.amountPaise;
  }
  if (input.amountPaise !== undefined && input.payeeId !== undefined) {
    cumulativePayeePaise =
      (await cumulativeAmount(tx, { typeKey: type.typeKey, payeeId: input.payeeId, window })) +
      input.amountPaise;
  }

  const { instanceId } = await startInstance(tx, type.defKey, {
    type: input.subject.type,
    id: input.subject.id,
    ...(input.patientId !== undefined ? { patientId: input.patientId } : {}),
    ...(input.encounterId !== undefined ? { encounterId: input.encounterId } : {}),
  });

  const approvalId = newId();
  await tx.insert(approvals).values({
    id: approvalId,
    typeKey: type.typeKey,
    instanceId,
    requesterId: requester.id,
    approverRole: type.approverRole,
    urgencyClass: type.urgencyClass,
    actedFirst,
    subjectType: input.subject.type,
    subjectId: input.subject.id,
    patientId: input.patientId,
    encounterId: input.encounterId,
    payeeId: input.payeeId,
    amountPaise: input.amountPaise,
    cumulativePatientPaise,
    cumulativePayeePaise,
    requestNote: input.requestNote,
  });

  await appendEvent(
    tx,
    approvalRequested.make({
      actor: requester,
      correlationId: instanceId, // §10.5: correlation = the workflow instance
      ...(input.patientId !== undefined ? { patientId: input.patientId } : {}),
      ...(input.encounterId !== undefined ? { encounterId: input.encounterId } : {}),
      payload: {
        approvalId,
        typeKey: type.typeKey,
        requesterId: requester.id,
        approverRole: type.approverRole,
        // The column is plain text in the schema; the zod payload re-validates at runtime.
        urgencyClass: type.urgencyClass as UrgencyClass,
        actedFirst,
        slaMinutes,
        subjectType: input.subject.type,
        subjectId: input.subject.id,
        ...(input.payeeId !== undefined ? { payeeId: input.payeeId } : {}),
        ...(input.amountPaise !== undefined ? { amountPaise: input.amountPaise } : {}),
        ...(cumulativePatientPaise !== undefined ? { cumulativePatientPaise } : {}),
        ...(cumulativePayeePaise !== undefined ? { cumulativePayeePaise } : {}),
      },
    }),
  );

  return { approvalId, instanceId };
}
```

- [ ] **Step 4: Run to verify pass, then the full suite**

Run: `pnpm --filter @hmis/core test -- --testPathPattern "approvals/requests"`
Expected: PASS (6 tests).

Run: `pnpm verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/kernel/approvals
git commit -m "feat(approvals): requestApproval — instance-backed requests with urgency, act-first, cumulative snapshots"
```

---

### Task 5: Approve / reject — SoD, single-winner, mandatory note

**Files:**
- Create: `apps/core/src/kernel/approvals/decisions.ts`
- Test: `apps/core/src/kernel/approvals/decisions.test.ts`

**Interfaces:**
- Consumes: `transition` from `../workflow/instances` (Plan 03 — the single-winner arbiter: conditional UPDATE discriminated on current state; enforces the transition's allowed roles for user actors at any scope; cancels open timers; completes the instance on a terminal state; the loser of a race throws `stale_transition`); `assertNotSodPair` from `../auth/sod` (Plan 02 — `assertNotSodPair(db, pairKey, actorA, actorB)` with **`Actor` objects**; appends `sod.violation_blocked` in its OWN transaction on violation, so the audit event survives this decision's rollback); `approvals` schema (T2); `approvalGranted`/`approvalRejected` (T2); `ApprovalError` (T3); `requestApproval` (T4, fixtures only); `withTx`/`appendEvent` (Plan 01).
- Produces (exact — T6 fixtures, T7 controller, T8 e2e call these):
  - `const REQUESTER_APPROVER_PAIR = "requester_approver"` — Plan 02's seeded pair key (`kernel/auth/sod.ts:9`: "Requester vs approver of any approvals-engine item").
  - `type DecisionInput = { approvalId: string; note: string }`
  - `approveRequest(db: Db, actor: Actor, input: DecisionInput): Promise<{ status: "granted" }>`
  - `rejectRequest(db: Db, actor: Actor, input: DecisionInput): Promise<{ status: "rejected" }>`
- Both are **`Db`-first** (like Plan 03's `migrateInstance`/`abortInstance`) because the SoD check must ride its own transaction and the state move opens `withTx` itself.
- Semantics, in order (each rule tested):
  1. **Mandatory note at runtime, before any DB read** (Plan 03 T8's gate lesson): empty or whitespace-only → `note_required`.
  2. **User actors only** → `user_actor_required`. A `system` actor would bypass `transition`'s role check — that is silent auto-approval of money items; `agent` actors are the Plan 12 seam.
  3. Row lookup → `unknown_approval`; already-decided → `not_pending` (fast-fail; the authoritative arbiter is step 5).
  4. `assertNotSodPair(db, REQUESTER_APPROVER_PAIR, { type: "user", id: row.requesterId }, actor)` — throws `SodViolationError` on requester=approver, and the `sod.violation_blocked` event survives.
  5. Inside one `withTx`: `transition(tx, row.instanceId, verdict, actor, { note })` — approver-role enforcement (`role_denied`) and single-winner arbitration (`stale_transition`) are Plan 03's, not re-implemented; then the row mirror moves via a **conditional UPDATE discriminated on `status = 'pending'`** (0 rows → `not_pending` — belt and braces: row and instance move together or not at all); then `approval.granted`/`.rejected` appends with `correlationId` = instance id.
- **No E-5 bypass exists here** (roadmap trap): emergency-governance precedence over an SoD pair is the workflow-definition-change path, shipped in Plan 03's governance. Requester≠approver has no emergency override in the approvals engine.

- [ ] **Step 1: Write the failing tests**

`apps/core/src/kernel/approvals/decisions.test.ts`:
```ts
import { and, eq, isNull } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { approveRequest, rejectRequest, REQUESTER_APPROVER_PAIR } from "./decisions";
import { requestApproval } from "./requests";
import { registerApprovalType } from "./types";
import { approvalFlowDefinition } from "./flow";
import { createDraft, activateDefinition } from "../workflow/definitions";
import { createUser } from "../auth/identity";
import { createRole, assignRole } from "../auth/permissions";
import { seedSodPairs, SodViolationError } from "../auth/sod";
import { approvals, events, workflowInstances, workflowTimers } from "../db/schema";
import { withTx } from "../db/client";
import type { Db } from "../db/client";
import type { Actor } from "@hmis/contracts";

const DRAFTER: Actor = { type: "user", id: "01HDRAFTER000000000000000" };

describe("approval decisions", () => {
  let db: Db; let teardown: () => Promise<void>;
  let activator: Actor; let requester: Actor; let approverA: Actor; let approverB: Actor;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    await seedSodPairs(db);
    const mk = async (username: string): Promise<Actor> => {
      const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
      return { type: "user", id };
    };
    activator = await mk("activator1");
    requester = await mk("requester1");
    approverA = await mk("approver_a");
    approverB = await mk("approver_b");
    await createRole(db, "billing_head", "Billing Head");
    await assignRole(db, { userId: approverA.id, roleKey: "billing_head", scopeType: "hospital" });
    await assignRole(db, { userId: approverB.id, roleKey: "billing_head", scopeType: "hospital" });
    const def = approvalFlowDefinition({
      typeKey: "discount_override", title: "Discount Override",
      approverRole: "billing_head", closureSlaMinutes: 45,
    });
    const { definitionId } = await createDraft(db, DRAFTER, def);
    await activateDefinition(db, activator, definitionId);
    await registerApprovalType(db, activator, {
      typeKey: "discount_override", title: "Discount Override", approverRole: "billing_head",
    });
  });

  async function fileRequest(by: Actor = requester): Promise<{ approvalId: string; instanceId: string }> {
    return withTx(db, (tx) =>
      requestApproval(tx, by, {
        typeKey: "discount_override",
        subject: { type: "invoice", id: "inv1" },
        patientId: "01HPAT000000000000000000A",
        amountPaise: 50_000,
      }),
    );
  }

  it("grants: instance completes, row mirrors, timers cancel, approval.granted appends", async () => {
    const { approvalId, instanceId } = await fileRequest();
    const result = await approveRequest(db, approverA, { approvalId, note: "verified against policy" });
    expect(result).toEqual({ status: "granted" });
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(row).toMatchObject({
      status: "granted", decisionNote: "verified against policy", decidedBy: approverA.id,
    });
    expect(row!.decidedAt).not.toBeNull();
    const [instance] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId));
    expect(instance).toMatchObject({ currentState: "granted", status: "completed" });
    const open = await db.select().from(workflowTimers).where(
      and(eq(workflowTimers.instanceId, instanceId), isNull(workflowTimers.firedAt), isNull(workflowTimers.cancelledAt)),
    );
    expect(open).toHaveLength(0); // Plan 03 cancelled the closure-SLA timer on the terminal move
    const evts = await db.select().from(events).where(eq(events.name, "approval.granted"));
    expect(evts).toHaveLength(1);
    expect(evts[0]!.correlationId).toBe(instanceId);
    expect(evts[0]!.payload).toMatchObject({
      approvalId, decidedBy: approverA.id, note: "verified against policy", actedFirst: false,
    });
  });

  it("rejects: same mechanics, approval.rejected", async () => {
    const { approvalId, instanceId } = await fileRequest();
    const result = await rejectRequest(db, approverA, { approvalId, note: "policy cap exceeded" });
    expect(result).toEqual({ status: "rejected" });
    const [instance] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId));
    expect(instance).toMatchObject({ currentState: "rejected", status: "completed" });
    const evts = await db.select().from(events).where(eq(events.name, "approval.rejected"));
    expect(evts).toHaveLength(1);
  });

  it("enforces the mandatory note at runtime, BEFORE any DB read", async () => {
    // Unknown id + blank note: if the note check ran after the lookup this would be
    // unknown_approval — the code pins the order (Plan 03 T8's lesson, runtime not types).
    await expect(
      approveRequest(db, approverA, { approvalId: "01HNOSUCH0000000000000000", note: "   " }),
    ).rejects.toMatchObject({ code: "note_required" });
    await expect(
      rejectRequest(db, approverA, { approvalId: "01HNOSUCH0000000000000000", note: "" }),
    ).rejects.toMatchObject({ code: "note_required" });
  });

  it("blocks requester=approver via the seeded SoD pair; the violation event survives", async () => {
    // The requester also holds the approver role — permission is not the gate, SoD is.
    await assignRole(db, { userId: requester.id, roleKey: "billing_head", scopeType: "hospital" });
    const { approvalId } = await fileRequest();
    await expect(
      approveRequest(db, requester, { approvalId, note: "approving my own request" }),
    ).rejects.toBeInstanceOf(SodViolationError);
    expect(REQUESTER_APPROVER_PAIR).toBe("requester_approver");
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(row!.status).toBe("pending"); // nothing moved
    const sodEvents = await db.select().from(events).where(eq(events.name, "sod.violation_blocked"));
    expect(sodEvents).toHaveLength(1); // appended in its OWN tx — survives the refused decision
  });

  it("denies a user without the approver role (Plan 03 transition role check)", async () => {
    const { approvalId } = await fileRequest();
    await expect(
      approveRequest(db, activator, { approvalId, note: "not my call" }),
    ).rejects.toMatchObject({ code: "role_denied" });
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(row!.status).toBe("pending");
  });

  it("refuses agent and system actors", async () => {
    const { approvalId } = await fileRequest();
    await expect(
      approveRequest(db, { type: "agent", id: "a1" }, { approvalId, note: "agent decision" }),
    ).rejects.toMatchObject({ code: "user_actor_required" });
    await expect(
      approveRequest(db, { type: "system", id: "sys" }, { approvalId, note: "auto-approve" }),
    ).rejects.toMatchObject({ code: "user_actor_required" });
  });

  it("single-winner: of two concurrent opposite decisions exactly one applies", async () => {
    const { approvalId, instanceId } = await fileRequest();
    const results = await Promise.allSettled([
      approveRequest(db, approverA, { approvalId, note: "approve in race" }),
      rejectRequest(db, approverB, { approvalId, note: "reject in race" }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(["stale_transition", "not_pending"]).toContain(
      (rejected[0]!.reason as { code: string }).code,
    );
    // Row and instance moved together — the mirror never diverges from the arbiter.
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    const [instance] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId));
    expect(row!.status).toBe(instance!.currentState);
    expect(instance!.status).toBe("completed");
    const decisionEvents = await db.select().from(events).where(eq(events.name, `approval.${row!.status}`));
    expect(decisionEvents).toHaveLength(1); // the loser appended nothing
  });

  it("refuses a decision on an already-decided approval and on an unknown id", async () => {
    const { approvalId } = await fileRequest();
    await approveRequest(db, approverA, { approvalId, note: "first decision" });
    await expect(
      rejectRequest(db, approverB, { approvalId, note: "second decision" }),
    ).rejects.toMatchObject({ code: "not_pending" });
    await expect(
      approveRequest(db, approverA, { approvalId: "01HNOSUCH0000000000000000", note: "who dis" }),
    ).rejects.toMatchObject({ code: "unknown_approval" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @hmis/core test -- --testPathPattern "approvals/decisions"`
Expected: FAIL — `./decisions` not found.

- [ ] **Step 3: Implement**

`apps/core/src/kernel/approvals/decisions.ts`:
```ts
import { and, eq } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { appendEvent } from "../events/append";
import { assertNotSodPair } from "../auth/sod";
import { transition } from "../workflow/instances";
import { approvals } from "../db/schema";
import { withTx } from "../db/client";
import { approvalGranted, approvalRejected } from "./events";
import { ApprovalError } from "./types";
import type { UrgencyClass } from "./types";
import type { Db } from "../db/client";

/** Plan 02's seeded pair (kernel/auth/sod.ts:9): "Requester vs approver of any approvals-engine item". */
export const REQUESTER_APPROVER_PAIR = "requester_approver";

export type DecisionInput = { approvalId: string; note: string };

/**
 * A decision is a Plan 03 transition (owner decision Q1a): transition() is the single-winner
 * arbiter (conditional UPDATE on the instance's current state), enforces the approver role,
 * cancels the closure-SLA timer, and completes the instance. The approvals row mirrors the
 * terminal state in the SAME transaction via its own conditional UPDATE on status='pending' —
 * row and instance move together or not at all. Db-first (like migrateInstance): the SoD
 * check must ride its own transaction so sod.violation_blocked survives this rollback.
 *
 * There is deliberately NO emergency bypass of requester≠approver here — E-5 precedence
 * belongs to workflow-definition governance (Plan 03 T5), not the approvals engine.
 */
async function decide(
  db: Db,
  actor: Actor,
  input: DecisionInput,
  verdict: "granted" | "rejected",
): Promise<{ status: typeof verdict }> {
  // Mandatory note at RUNTIME, before any DB read (Plan 03 T8's gate lesson: an empty
  // string sails through a type-level requirement). typeof-guarded so an untyped caller
  // passing undefined gets note_required, not a TypeError.
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (note === "") {
    throw new ApprovalError("note_required", "a decision note is mandatory (§8: approve/reject with note)");
  }
  if (actor.type !== "user") {
    throw new ApprovalError("user_actor_required", "only user actors may decide approvals — a system actor would bypass the approver-role check (silent auto-approval); agents are the Plan 12 seam");
  }

  const rows = await db.select().from(approvals).where(eq(approvals.id, input.approvalId));
  const row = rows[0];
  if (!row) throw new ApprovalError("unknown_approval", `unknown approval ${input.approvalId}`);
  if (row.status !== "pending") {
    throw new ApprovalError("not_pending", `approval ${input.approvalId} is already ${row.status}`);
  }

  // Requester ≠ approver (S10 §11). Appends sod.violation_blocked in its OWN transaction
  // on violation, so the audit trail survives the refused decision.
  await assertNotSodPair(db, REQUESTER_APPROVER_PAIR, { type: "user", id: row.requesterId }, actor);

  return withTx(db, async (tx) => {
    await transition(tx, row.instanceId, verdict, actor, { note });
    const updated = await tx
      .update(approvals)
      .set({ status: verdict, decisionNote: note, decidedBy: actor.id, decidedAt: new Date() })
      .where(and(eq(approvals.id, row.id), eq(approvals.status, "pending")))
      .returning({ id: approvals.id });
    if (updated.length === 0) {
      // Belt and braces: unreachable when transition() won, but the mirror must never
      // move on its own terms — same single-winner grammar, no read-then-write.
      throw new ApprovalError("not_pending", `approval ${row.id} was decided concurrently`);
    }
    const def = verdict === "granted" ? approvalGranted : approvalRejected;
    await appendEvent(
      tx,
      def.make({
        actor,
        correlationId: row.instanceId,
        ...(row.patientId !== null ? { patientId: row.patientId } : {}),
        ...(row.encounterId !== null ? { encounterId: row.encounterId } : {}),
        payload: {
          approvalId: row.id,
          typeKey: row.typeKey,
          requesterId: row.requesterId,
          decidedBy: actor.id,
          note,
          urgencyClass: row.urgencyClass as UrgencyClass, // text column; zod re-validates
          actedFirst: row.actedFirst,
        },
      }),
    );
    return { status: verdict };
  });
}

export async function approveRequest(db: Db, actor: Actor, input: DecisionInput): Promise<{ status: "granted" }> {
  return decide(db, actor, input, "granted");
}

export async function rejectRequest(db: Db, actor: Actor, input: DecisionInput): Promise<{ status: "rejected" }> {
  return decide(db, actor, input, "rejected");
}
```

- [ ] **Step 4: Run to verify pass, then the full suite**

Run: `pnpm --filter @hmis/core test -- --testPathPattern "approvals/decisions"`
Expected: PASS (8 tests).

Run: `pnpm verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/kernel/approvals
git commit -m "feat(approvals): approve/reject — SoD requester≠approver, single-winner decision, mandatory note"
```

---
### Task 6: Approver worklist — role-scoped listing

**Files:**
- Create: `apps/core/src/kernel/approvals/worklist.ts`
- Test: `apps/core/src/kernel/approvals/worklist.test.ts`

**Interfaces:**
- Consumes: `approvals`, `roleAssignments`, `tempRoleGrants` schema; `ApprovalError`, `UrgencyClass` (T3); `requestApproval` (T4) + `approveRequest` (T5) + T1/T3 registration flow (fixtures); `withTx`/`Db`/`Tx` (Plan 01); `grantTempRole` + `loadConfig` (Plan 02, fixtures).
- Produces (exact — T7's controller calls these):
  - `rolesHeldBy(tx: Tx, userId: string): Promise<string[]>` — deduped, sorted role keys the user holds now: permanent assignments at **any** scope + unexpired temp grants. **Written here, not by editing Plan 03's `roles.ts`** (additive-only rule, owner decision Q2); mirrors that file's proven query shape and its marked seams (any-scope until org masters; static roster until Plan 11-adjacent).
  - `type WorklistFilters = { status?: "pending" | "granted" | "rejected"; typeKey?: string; urgencyClass?: UrgencyClass; approverRole?: string; olderThanMinutes?: number; limit?: number; offset?: number }`
  - `type ApprovalRow = typeof approvals.$inferSelect`
  - `listApprovals(db: Db, actor: Actor, filters?: WorklistFilters): Promise<{ items: ApprovalRow[]; total: number }>` — **auto-scoped to the caller's held roles** (owner decision Q5): only rows whose `approverRole` is among `rolesHeldBy(actor)`. `approverRole` filter **narrows within** the held set and can never widen past it. `status` defaults to `"pending"`. Ordering: `emergency` → `urgent` → `routine`, then oldest `requestedAt` first (E-15). `limit` default 50, capped at 200; `offset` default 0; `total` counts the full filtered set for pagination. User actors only (`user_actor_required`).
  - `getApproval(db: Db, approvalId: string): Promise<ApprovalRow | null>`
- **Empty-role guard is load-bearing:** `inArray` with an empty array is invalid SQL — a caller holding no roles returns `{ items: [], total: 0 }` before any query.

- [ ] **Step 1: Write the failing tests**

`apps/core/src/kernel/approvals/worklist.test.ts`:
```ts
import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { rolesHeldBy, listApprovals, getApproval } from "./worklist";
import { requestApproval } from "./requests";
import { approveRequest } from "./decisions";
import { registerApprovalType } from "./types";
import { approvalFlowDefinition } from "./flow";
import { createDraft, activateDefinition } from "../workflow/definitions";
import { createUser } from "../auth/identity";
import { createRole, assignRole } from "../auth/permissions";
import { grantTempRole } from "../auth/temp-roles";
import { seedSodPairs } from "../auth/sod";
import { loadConfig } from "../config";
import { approvals, tempRoleGrants } from "../db/schema";
import { withTx } from "../db/client";
import type { Db } from "../db/client";
import type { Actor } from "@hmis/contracts";

const DRAFTER: Actor = { type: "user", id: "01HDRAFTER000000000000000" };
const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });

describe("approver worklist", () => {
  let db: Db; let teardown: () => Promise<void>;
  let activator: Actor; let requester: Actor; let billingHead: Actor; let dutyDoctor: Actor;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    await seedSodPairs(db);
    const mk = async (username: string): Promise<Actor> => {
      const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
      return { type: "user", id };
    };
    activator = await mk("activator1");
    requester = await mk("requester1");
    billingHead = await mk("billing_head1");
    dutyDoctor = await mk("duty_doctor1");
    await createRole(db, "billing_head", "Billing Head");
    await createRole(db, "duty_doctor", "Duty Doctor");
    await assignRole(db, { userId: billingHead.id, roleKey: "billing_head", scopeType: "hospital" });
    await assignRole(db, { userId: dutyDoctor.id, roleKey: "duty_doctor", scopeType: "department", scopeId: "icu" });

    for (const [typeKey, approverRole, urgencyClass, actFirstAllowed] of [
      ["discount_override", "billing_head", "routine", false],
      ["icu_admission", "duty_doctor", "emergency", true],
    ] as const) {
      const def = approvalFlowDefinition({
        typeKey, title: typeKey, approverRole, closureSlaMinutes: 45,
      });
      const { definitionId } = await createDraft(db, DRAFTER, def);
      await activateDefinition(db, activator, definitionId);
      await registerApprovalType(db, activator, {
        typeKey, title: typeKey, approverRole, urgencyClass, actFirstAllowed,
      });
    }
  });

  async function file(typeKey: string, subjectId: string): Promise<string> {
    const { approvalId } = await withTx(db, (tx) =>
      requestApproval(tx, requester, {
        typeKey, subject: { type: "test", id: subjectId },
        ...(typeKey === "icu_admission"
          ? { actFirst: true, requestNote: "unstable — acted first" }
          : {}),
      }),
    );
    return approvalId;
  }

  it("rolesHeldBy: permanent any-scope + unexpired temp grants, deduped and sorted", async () => {
    await grantTempRole(db, cfg, activator, {
      userId: billingHead.id, roleKey: "duty_doctor", reason: "cover", ttlMinutes: 30,
    });
    await db.insert(tempRoleGrants).values({
      id: "01HGRANTLAPSED00000000000A", userId: billingHead.id, roleKey: "expired_role",
      grantedBy: activator.id, kind: "granted", reason: "lapsed",
      expiresAt: new Date(Date.now() - 60_000),
    });
    await withTx(db, async (tx) => {
      expect(await rolesHeldBy(tx, billingHead.id)).toEqual(["billing_head", "duty_doctor"]);
      expect(await rolesHeldBy(tx, requester.id)).toEqual([]);
    });
  });

  it("auto-scopes to the caller's held roles", async () => {
    const discountId = await file("discount_override", "s1");
    await file("icu_admission", "s2");
    const forBilling = await listApprovals(db, billingHead);
    expect(forBilling.total).toBe(1);
    expect(forBilling.items.map((i) => i.id)).toEqual([discountId]);
    const forRequester = await listApprovals(db, requester); // holds no approver role
    expect(forRequester).toEqual({ items: [], total: 0 });
  });

  it("orders emergency before routine, then oldest first", async () => {
    const routineOld = await file("discount_override", "s1");
    const routineNew = await file("discount_override", "s2");
    const emergency = await file("icu_admission", "s3");
    // Make s1 visibly older (requestedAt is a DB default; backdate directly).
    await db.update(approvals)
      .set({ requestedAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(approvals.id, routineOld));
    await assignRole(db, { userId: billingHead.id, roleKey: "duty_doctor", scopeType: "hospital" });
    const list = await listApprovals(db, billingHead);
    expect(list.items.map((i) => i.id)).toEqual([emergency, routineOld, routineNew]);
  });

  it("filters: typeKey, urgencyClass, approverRole (narrowing only), olderThanMinutes, status", async () => {
    const discountId = await file("discount_override", "s1");
    await file("icu_admission", "s2");
    await assignRole(db, { userId: billingHead.id, roleKey: "duty_doctor", scopeType: "hospital" });
    expect((await listApprovals(db, billingHead, { typeKey: "discount_override" })).items.map((i) => i.id)).toEqual([discountId]);
    expect((await listApprovals(db, billingHead, { urgencyClass: "emergency" })).total).toBe(1);
    expect((await listApprovals(db, billingHead, { approverRole: "billing_head" })).total).toBe(1);
    // Narrowing only: filtering on a role the caller does NOT hold returns nothing.
    expect(await listApprovals(db, requester, { approverRole: "billing_head" })).toEqual({ items: [], total: 0 });
    expect((await listApprovals(db, billingHead, { olderThanMinutes: 30 })).total).toBe(0);
    await db.update(approvals)
      .set({ requestedAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(approvals.id, discountId));
    expect((await listApprovals(db, billingHead, { olderThanMinutes: 30 })).total).toBe(1);
    // status defaults to pending; decided rows appear only when asked for.
    await approveRequest(db, billingHead, { approvalId: discountId, note: "fine" });
    expect((await listApprovals(db, billingHead, { typeKey: "discount_override" })).total).toBe(0);
    expect((await listApprovals(db, billingHead, { status: "granted" })).total).toBe(1);
  });

  it("paginates with a stable total", async () => {
    for (let i = 0; i < 5; i += 1) {
      await file("discount_override", `s${i}`);
    }
    const page1 = await listApprovals(db, billingHead, { limit: 2, offset: 0 });
    const page2 = await listApprovals(db, billingHead, { limit: 2, offset: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page2.items).toHaveLength(2);
    expect(page1.total).toBe(5);
    expect(typeof page1.total).toBe("number"); // count(*) arrives as text — must be forced
    expect(new Set([...page1.items, ...page2.items].map((i) => i.id)).size).toBe(4);
  });

  it("getApproval returns the row or null; non-user actors are refused a worklist", async () => {
    const id = await file("discount_override", "s1");
    expect((await getApproval(db, id))?.id).toBe(id);
    expect(await getApproval(db, "01HNOSUCH0000000000000000")).toBeNull();
    await expect(listApprovals(db, { type: "agent", id: "a1" })).rejects.toMatchObject({
      code: "user_actor_required",
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @hmis/core test -- --testPathPattern "approvals/worklist"`
Expected: FAIL — `./worklist` not found.

- [ ] **Step 3: Implement**

`apps/core/src/kernel/approvals/worklist.ts`:
```ts
import { and, asc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { approvals, roleAssignments, tempRoleGrants } from "../db/schema";
import { withTx } from "../db/client";
import { ApprovalError } from "./types";
import type { UrgencyClass } from "./types";
import type { Db, Tx } from "../db/client";

/**
 * Role keys the user holds now — permanent assignments at ANY scope + unexpired temp
 * grants. Deliberately written HERE rather than by editing Plan 03's kernel/workflow/roles.ts
 * (this plan is additive-only over shipped kernel files — owner decision 2026-08-13). Mirrors
 * that file's proven shape and inherits its marked seams: any-scope until org masters exist
 * (Plan 02 gate report §7.3), static holders until the roster substrate (Plan 11-adjacent).
 */
export async function rolesHeldBy(tx: Tx, userId: string): Promise<string[]> {
  const permanent = await tx
    .select({ roleKey: roleAssignments.roleKey })
    .from(roleAssignments)
    .where(eq(roleAssignments.userId, userId));
  const temp = await tx
    .select({ roleKey: tempRoleGrants.roleKey })
    .from(tempRoleGrants)
    .where(and(eq(tempRoleGrants.userId, userId), gt(tempRoleGrants.expiresAt, new Date())));
  return [...new Set([...permanent.map((r) => r.roleKey), ...temp.map((r) => r.roleKey)])].sort();
}

export type WorklistFilters = {
  status?: "pending" | "granted" | "rejected";
  typeKey?: string;
  urgencyClass?: UrgencyClass;
  approverRole?: string;
  olderThanMinutes?: number;
  limit?: number;
  offset?: number;
};

export type ApprovalRow = typeof approvals.$inferSelect;

/**
 * The approver worklist (owner decision Q5): auto-scoped to the caller's held roles —
 * a filter can narrow within that set, never widen past it. emergency → urgent → routine,
 * then oldest first (E-15 ordering).
 */
export async function listApprovals(
  db: Db,
  actor: Actor,
  filters: WorklistFilters = {},
): Promise<{ items: ApprovalRow[]; total: number }> {
  if (actor.type !== "user") {
    throw new ApprovalError("user_actor_required", "the worklist is scoped to a user's held roles");
  }
  return withTx(db, async (tx) => {
    let roles = await rolesHeldBy(tx, actor.id);
    if (filters.approverRole !== undefined) {
      roles = roles.filter((r) => r === filters.approverRole); // narrowing only
    }
    if (roles.length === 0) return { items: [], total: 0 }; // inArray([]) is invalid SQL — guard first
    const conditions = [
      eq(approvals.status, filters.status ?? "pending"),
      inArray(approvals.approverRole, roles),
    ];
    if (filters.typeKey !== undefined) conditions.push(eq(approvals.typeKey, filters.typeKey));
    if (filters.urgencyClass !== undefined) conditions.push(eq(approvals.urgencyClass, filters.urgencyClass));
    if (filters.olderThanMinutes !== undefined) {
      conditions.push(lte(approvals.requestedAt, new Date(Date.now() - filters.olderThanMinutes * 60_000)));
    }
    const where = and(...conditions);
    const limit = Math.min(filters.limit ?? 50, 200);
    const offset = filters.offset ?? 0;
    const urgencyRank = sql<number>`case ${approvals.urgencyClass} when 'emergency' then 0 when 'urgent' then 1 else 2 end`;
    const items = await tx
      .select()
      .from(approvals)
      .where(where)
      .orderBy(urgencyRank, asc(approvals.requestedAt))
      .limit(limit)
      .offset(offset);
    const counted = await tx.select({ n: sql<string>`count(*)` }).from(approvals).where(where);
    return { items, total: Number(counted[0]!.n) }; // count(*) arrives as text — force a real number
  });
}

export async function getApproval(db: Db, approvalId: string): Promise<ApprovalRow | null> {
  const rows = await db.select().from(approvals).where(eq(approvals.id, approvalId));
  return rows[0] ?? null;
}
```

- [ ] **Step 4: Run to verify pass, then the full suite**

Run: `pnpm --filter @hmis/core test -- --testPathPattern "approvals/worklist"`
Expected: PASS (6 tests).

Run: `pnpm verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/kernel/approvals
git commit -m "feat(approvals): approver worklist — role-scoped listing with urgency-first ordering"
```

---

### Task 7: Manifest, Nest module, routes, AppModule wiring + first e2e

**Files:**
- Create: `apps/core/src/kernel/approvals/manifest.ts`, `apps/core/src/kernel/approvals/approvals.module.ts`, `apps/core/src/kernel/approvals/approvals.controller.ts`
- Modify: `apps/core/src/app.module.ts`
- Test: `apps/core/test/approvals.e2e.test.ts`

**Interfaces:**
- Consumes: everything T1–T6 shipped; Plan 02's global guards (already registered by `AuthModule` — this module registers **no** guard), `@RequirePermission`/`@CurrentActor`, `syncPermissions` (already running in `AuthModule.onModuleInit` — installing the manifest is a pure registry change, **not** a new boot-time DB call, so no e2e database-wiring audit is triggered per EXECUTION-LESSONS §3.6); Plan 03's `/workflow/definitions` routes (the e2e drafts + activates the flow definition over HTTP).
- Produces (exact):
  - `approvalsManifest: ModuleManifest` — key `"approvals"`, permissions: `approvals.types.manage`, `approvals.requests.create`, `approvals.requests.read`, `approvals.requests.decide`. No menu entries (first UI is Plan 05), no subscriptions.
  - `ApprovalsModule` — controller only.
  - Routes, all `@RequirePermission(…, "hospital")`: `POST /approvals/types` (`.types.manage`) · `POST /approvals` (`.requests.create`) · `GET /approvals` (`.requests.read`) · `GET /approvals/:id` (`.requests.read`) · `POST /approvals/:id/approve` (`.requests.decide`) · `POST /approvals/:id/reject` (`.requests.decide`).
  - HTTP error mapping, defined once (Plan 03's `toHttp` convention): `SodViolationError` → 403 · `ApprovalError` `unknown_approval` → 404, `not_pending` → 409, every other code → 400 · `WorkflowError` → 409 (Plan 03's established mapping — includes `role_denied` and `stale_transition`). Anything else rethrows (500 = a genuine bug, loudly).
- Route order note: `@Post("types")` is declared **before** `@Post(":id/approve")`/`@Post(":id/reject")` and `@Get()` before `@Get(":id")` — Nest matches in declaration order and the literal segment must win.
- **No red run can be faked here and none needs to be:** the e2e is written first and its first honest run fails at import time (`../src/kernel/approvals/manifest` does not exist) — after `manifest.ts` alone existed it would fail with 404s on every `/approvals/*` route. Either red state is honest fail-first evidence; quote whichever you observed.

- [ ] **Step 1: Write the failing e2e FIRST**

`apps/core/test/approvals.e2e.test.ts`:
```ts
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { setupTestDb, truncateAll } from "./helpers/db";
import { createUser } from "../src/kernel/auth/identity";
import { createSession } from "../src/kernel/auth/sessions";
import { createRole, grantPermissionToRole, syncPermissions, assignRole } from "../src/kernel/auth/permissions";
import { seedSodPairs } from "../src/kernel/auth/sod";
import { authManifest } from "../src/kernel/auth/manifest";
import { workflowManifest } from "../src/kernel/workflow/manifest";
import { approvalsManifest } from "../src/kernel/approvals/manifest";
import { approvalFlowDefinition } from "../src/kernel/approvals/flow";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { loadConfig, requireEnv } from "../src/kernel/config";
import type { Db } from "../src/kernel/db/client";

const DISCOUNT_DEF = approvalFlowDefinition({
  typeKey: "discount_override",
  title: "Discount Override",
  approverRole: "billing_head",
  closureSlaMinutes: 45,
});

describe("approvals e2e", () => {
  let app: INestApplication;
  let db: Db; let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  registry.install(workflowManifest);
  registry.install(approvalsManifest);
  const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });

  let requesterToken: string;
  let approverToken: string;
  let randoToken: string;
  let requesterId: string;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterAll(async () => { await app.close(); await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    await seedSodPairs(db);
    await syncPermissions(db, registry);
    await createRole(db, "wf_admin", "Workflow Admin");
    for (const permission of workflowManifest.permissions) {
      await grantPermissionToRole(db, registry, "wf_admin", permission);
    }
    await createRole(db, "approvals_admin", "Approvals Admin");
    for (const permission of approvalsManifest.permissions) {
      await grantPermissionToRole(db, registry, "approvals_admin", permission);
    }
    await createRole(db, "billing_head", "Billing Head");

    const mk = async (username: string): Promise<{ id: string; token: string }> => {
      const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
      const { token } = await createSession(db, cfg, id);
      return { id, token };
    };
    const drafter = await mk("drafter");
    const activator = await mk("activator");
    const requester = await mk("requester");
    const approver = await mk("approver");
    const rando = await mk("rando");
    requesterToken = requester.token;
    approverToken = approver.token;
    randoToken = rando.token;
    requesterId = requester.id;
    await assignRole(db, { userId: drafter.id, roleKey: "wf_admin", scopeType: "hospital" });
    await assignRole(db, { userId: activator.id, roleKey: "wf_admin", scopeType: "hospital" });
    await assignRole(db, { userId: activator.id, roleKey: "approvals_admin", scopeType: "hospital" });
    await assignRole(db, { userId: requester.id, roleKey: "approvals_admin", scopeType: "hospital" });
    await assignRole(db, { userId: approver.id, roleKey: "approvals_admin", scopeType: "hospital" });
    await assignRole(db, { userId: approver.id, roleKey: "billing_head", scopeType: "hospital" });

    // The flow definition is authored over Plan 03's own HTTP surface — the two-step
    // registration flow, end to end.
    const draft = await request(app.getHttpServer())
      .post("/workflow/definitions").set("Authorization", `Bearer ${drafter.token}`)
      .send(DISCOUNT_DEF).expect(201);
    const { definitionId } = draft.body as { definitionId: string };
    await request(app.getHttpServer())
      .post(`/workflow/definitions/${definitionId}/activate`)
      .set("Authorization", `Bearer ${activator.token}`)
      .expect(201);
    await request(app.getHttpServer())
      .post("/approvals/types").set("Authorization", `Bearer ${activator.token}`)
      .send({ typeKey: "discount_override", title: "Discount Override", approverRole: "billing_head" })
      .expect(201);
  });

  it("guards every route: 401 unauthenticated, 403 without the permission", async () => {
    await request(app.getHttpServer()).post("/approvals").send({}).expect(401);
    await request(app.getHttpServer())
      .post("/approvals/types").set("Authorization", `Bearer ${randoToken}`)
      .send({ typeKey: "x", title: "X", approverRole: "r" }).expect(403);
    await request(app.getHttpServer())
      .post("/approvals").set("Authorization", `Bearer ${randoToken}`)
      .send({ typeKey: "discount_override", subject: { type: "invoice", id: "i1" } }).expect(403);
    await request(app.getHttpServer())
      .get("/approvals").set("Authorization", `Bearer ${randoToken}`).expect(403);
  });

  it("full lifecycle over HTTP: request → worklist → approve → decided", async () => {
    const created = await request(app.getHttpServer())
      .post("/approvals").set("Authorization", `Bearer ${requesterToken}`)
      .send({
        typeKey: "discount_override",
        subject: { type: "invoice", id: "inv1" },
        patientId: "01HPAT000000000000000000A",
        amountPaise: 50_000,
        requestNote: "20% senior-citizen discount",
      })
      .expect(201);
    const { approvalId, instanceId } = created.body as { approvalId: string; instanceId: string };
    expect(approvalId).toBeTruthy();
    expect(instanceId).toBeTruthy();

    // Worklist is role-scoped: the approver sees it, the requester does not.
    const approverList = await request(app.getHttpServer())
      .get("/approvals").set("Authorization", `Bearer ${approverToken}`).expect(200);
    expect(approverList.body.total).toBe(1);
    expect(approverList.body.items[0]).toMatchObject({
      id: approvalId, typeKey: "discount_override", urgencyClass: "routine",
      cumulativePatientPaise: 50_000,
    });
    const requesterList = await request(app.getHttpServer())
      .get("/approvals").set("Authorization", `Bearer ${requesterToken}`).expect(200);
    expect(requesterList.body).toEqual({ items: [], total: 0 });

    await request(app.getHttpServer())
      .post(`/approvals/${approvalId}/approve`).set("Authorization", `Bearer ${approverToken}`)
      .send({ note: "verified against policy" })
      .expect(201);
    const detail = await request(app.getHttpServer())
      .get(`/approvals/${approvalId}`).set("Authorization", `Bearer ${approverToken}`).expect(200);
    expect(detail.body.approval).toMatchObject({
      status: "granted", decisionNote: "verified against policy",
    });
    // A second decision conflicts.
    await request(app.getHttpServer())
      .post(`/approvals/${approvalId}/reject`).set("Authorization", `Bearer ${approverToken}`)
      .send({ note: "changed my mind" })
      .expect(409);
  });

  it("blocks requester=approver over HTTP with 403 (SoD), leaving the request pending", async () => {
    await assignRole(db, { userId: requesterId, roleKey: "billing_head", scopeType: "hospital" });
    const created = await request(app.getHttpServer())
      .post("/approvals").set("Authorization", `Bearer ${requesterToken}`)
      .send({ typeKey: "discount_override", subject: { type: "invoice", id: "inv1" } })
      .expect(201);
    const { approvalId } = created.body as { approvalId: string };
    await request(app.getHttpServer())
      .post(`/approvals/${approvalId}/approve`).set("Authorization", `Bearer ${requesterToken}`)
      .send({ note: "approving my own request" })
      .expect(403);
    const detail = await request(app.getHttpServer())
      .get(`/approvals/${approvalId}`).set("Authorization", `Bearer ${requesterToken}`).expect(200);
    expect(detail.body.approval.status).toBe("pending");
  });

  it("validates bodies and maps engine errors (400 zod, 400 note_required, 404 unknown, 400 duplicate type)", async () => {
    await request(app.getHttpServer())
      .post("/approvals").set("Authorization", `Bearer ${requesterToken}`)
      .send({ typeKey: "discount_override" }) // missing subject
      .expect(400);
    const created = await request(app.getHttpServer())
      .post("/approvals").set("Authorization", `Bearer ${requesterToken}`)
      .send({ typeKey: "discount_override", subject: { type: "invoice", id: "inv1" } })
      .expect(201);
    const { approvalId } = created.body as { approvalId: string };
    await request(app.getHttpServer())
      .post(`/approvals/${approvalId}/approve`).set("Authorization", `Bearer ${approverToken}`)
      .send({ note: "" }) // zod min(1)
      .expect(400);
    const whitespace = await request(app.getHttpServer())
      .post(`/approvals/${approvalId}/approve`).set("Authorization", `Bearer ${approverToken}`)
      .send({ note: "   " }) // passes zod, refused at runtime — note_required
      .expect(400);
    expect(whitespace.body.message).toContain("note"); // parsed body, never JSON.stringify (§3.11)
    await request(app.getHttpServer())
      .get("/approvals/01HNOSUCH0000000000000000")
      .set("Authorization", `Bearer ${approverToken}`)
      .expect(404);
    await request(app.getHttpServer())
      .post("/approvals/01HNOSUCH0000000000000000/approve")
      .set("Authorization", `Bearer ${approverToken}`)
      .send({ note: "who dis" })
      .expect(404);
    const dup = await request(app.getHttpServer())
      .post("/approvals/types").set("Authorization", `Bearer ${approverToken}`)
      .send({ typeKey: "discount_override", title: "Again", approverRole: "billing_head" })
      .expect(400);
    expect(dup.body.message).toContain("already exists");
  });
});
```

- [ ] **Step 2: Run to observe the honest red**

Run: `pnpm --filter @hmis/core test -- --testPathPattern "approvals.e2e"`
Expected: FAIL — `../src/kernel/approvals/manifest` module not found at import time. (After creating only `manifest.ts` it would fail with 404s on every `/approvals/*` route — either red state is honest fail-first evidence; quote whichever you observed.)

- [ ] **Step 3: Implement manifest and module**

`apps/core/src/kernel/approvals/manifest.ts`:
```ts
import type { ModuleManifest } from "../modules/manifest";

export const approvalsManifest: ModuleManifest = {
  key: "approvals",
  title: "Approvals Engine",
  menu: [], // first UI arrives in Plan 05
  permissions: [
    "approvals.types.manage",
    "approvals.requests.create",
    "approvals.requests.read",
    "approvals.requests.decide",
  ],
  subscriptions: [],
};
```

`apps/core/src/kernel/approvals/approvals.module.ts`:
```ts
import { Module } from "@nestjs/common";
import { ApprovalsController } from "./approvals.controller";

// Guards are NOT registered here — AuthGuard and PermissionGuard are global APP_GUARDs
// registered once by AuthModule (order load-bearing, Plan 02).
@Module({ controllers: [ApprovalsController] })
export class ApprovalsModule {}
```

- [ ] **Step 4: Implement the controller (routes + the shared error mapper)**

`apps/core/src/kernel/approvals/approvals.controller.ts`:
```ts
import {
  BadRequestException, Body, Controller, ConflictException, ForbiddenException, Get, Inject,
  NotFoundException, Param, Post, Query,
} from "@nestjs/common";
import { z } from "zod";
import type { Actor } from "@hmis/contracts";
import { DB } from "../tokens";
import { CurrentActor, RequirePermission } from "../auth/decorators";
import { SodViolationError } from "../auth/sod";
import { withTx } from "../db/client";
import { WorkflowError } from "../workflow/instances";
import { ApprovalError, registerApprovalType } from "./types";
import { requestApproval } from "./requests";
import { approveRequest, rejectRequest } from "./decisions";
import { listApprovals, getApproval } from "./worklist";
import type { ApprovalRow } from "./worklist";
import type { Db } from "../db/client";

/** Approvals errors → HTTP, defined once (Plan 03's toHttp convention). Anything unrecognized rethrows: a 500 is a genuine bug, loudly. */
function toHttp(e: unknown): never {
  if (e instanceof SodViolationError) throw new ForbiddenException(e.message);
  if (e instanceof ApprovalError) {
    if (e.code === "unknown_approval") throw new NotFoundException(e.message);
    if (e.code === "not_pending") throw new ConflictException(e.message);
    throw new BadRequestException(e.message);
  }
  // Plan 03's established mapping — covers role_denied and stale_transition from transition().
  if (e instanceof WorkflowError) throw new ConflictException(e.message);
  throw e;
}

const urgencyEnum = z.enum(["routine", "urgent", "emergency"]);

const typeBody = z.object({
  typeKey: z.string().min(1),
  title: z.string().min(1),
  approverRole: z.string().min(1),
  urgencyClass: urgencyEnum.optional(),
  actFirstAllowed: z.boolean().optional(),
});

const requestBody = z.object({
  typeKey: z.string().min(1),
  subject: z.object({ type: z.string().min(1), id: z.string().min(1) }),
  patientId: z.string().min(1).optional(),
  encounterId: z.string().min(1).optional(),
  payeeId: z.string().min(1).optional(),
  amountPaise: z.number().int().positive().optional(),
  requestNote: z.string().optional(),
  actFirst: z.boolean().optional(),
});

const decisionBody = z.object({ note: z.string().min(1) }); // whitespace-only still passes here — T5 refuses it at runtime

const worklistQuery = z.object({
  status: z.enum(["pending", "granted", "rejected"]).optional(),
  typeKey: z.string().optional(),
  urgencyClass: urgencyEnum.optional(),
  approverRole: z.string().optional(),
  olderThanMinutes: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

@Controller("approvals")
export class ApprovalsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  // Literal segment declared BEFORE the :id routes — Nest matches in declaration order.
  @RequirePermission("approvals.types.manage", "hospital")
  @Post("types")
  async registerType(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
  ): Promise<{ typeKey: string; defKey: string }> {
    const parsed = typeBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    try {
      return await registerApprovalType(this.db, actor, parsed.data);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("approvals.requests.create", "hospital")
  @Post()
  async create(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
  ): Promise<{ approvalId: string; instanceId: string }> {
    const parsed = requestBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    try {
      return await withTx(this.db, (tx) => requestApproval(tx, actor, parsed.data));
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("approvals.requests.read", "hospital")
  @Get()
  async list(
    @CurrentActor() actor: Actor,
    @Query() query: unknown,
  ): Promise<{ items: ApprovalRow[]; total: number }> {
    const parsed = worklistQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    try {
      return await listApprovals(this.db, actor, parsed.data);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("approvals.requests.read", "hospital")
  @Get(":id")
  async detail(@Param("id") id: string): Promise<{ approval: ApprovalRow }> {
    const approval = await getApproval(this.db, id);
    if (!approval) throw new NotFoundException(`unknown approval ${id}`);
    return { approval };
  }

  @RequirePermission("approvals.requests.decide", "hospital")
  @Post(":id/approve")
  async approve(
    @CurrentActor() actor: Actor,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<{ status: "granted" }> {
    const parsed = decisionBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    try {
      return await approveRequest(this.db, actor, { approvalId: id, note: parsed.data.note });
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("approvals.requests.decide", "hospital")
  @Post(":id/reject")
  async reject(
    @CurrentActor() actor: Actor,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<{ status: "rejected" }> {
    const parsed = decisionBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    try {
      return await rejectRequest(this.db, actor, { approvalId: id, note: parsed.data.note });
    } catch (e) {
      toHttp(e);
    }
  }
}
```

- [ ] **Step 5: Wire into AppModule**

`apps/core/src/app.module.ts` becomes (only three lines change from the current file — the two imports and the `imports:` array — plus the `registry.install(approvalsManifest)` line; everything else stays byte-identical):
```ts
import { Module, Global, Inject, OnModuleDestroy } from "@nestjs/common";
import type { Pool } from "pg";
import { createDb, Db } from "./kernel/db/client";
import { loadConfig, AppConfig } from "./kernel/config";
import { DB, DB_POOL, CONFIG, MODULE_REGISTRY } from "./kernel/tokens";
import { ModuleRegistry } from "./kernel/modules/loader";
import { authManifest } from "./kernel/auth/manifest";
import { workflowManifest } from "./kernel/workflow/manifest";
import { approvalsManifest } from "./kernel/approvals/manifest";
import { HealthController } from "./health/health.controller";
import { AuthModule } from "./kernel/auth/auth.module";
import { WorkflowModule } from "./kernel/workflow/workflow.module";
import { ApprovalsModule } from "./kernel/approvals/approvals.module";

export { DB, DB_POOL, CONFIG, MODULE_REGISTRY } from "./kernel/tokens";

type DbBundle = { db: Db; pool: Pool };
const DB_BUNDLE = Symbol("DB_BUNDLE");

@Global()
@Module({
  imports: [AuthModule, WorkflowModule, ApprovalsModule],
  controllers: [HealthController],
  providers: [
    { provide: CONFIG, useFactory: (): AppConfig => loadConfig() },
    {
      provide: DB_BUNDLE,
      useFactory: (cfg: AppConfig): DbBundle => createDb(cfg.databaseUrl),
      inject: [CONFIG],
    },
    { provide: DB, useFactory: (b: DbBundle): Db => b.db, inject: [DB_BUNDLE] },
    { provide: DB_POOL, useFactory: (b: DbBundle): Pool => b.pool, inject: [DB_BUNDLE] },
    {
      provide: MODULE_REGISTRY,
      useFactory: (): ModuleRegistry => {
        const registry = new ModuleRegistry();
        registry.install(authManifest);
        registry.install(workflowManifest);
        registry.install(approvalsManifest);
        // Later plans install their module manifests here.
        return registry;
      },
    },
  ],
  exports: [DB, DB_POOL, CONFIG, MODULE_REGISTRY],
})
export class AppModule implements OnModuleDestroy {
  private poolClosed = false;

  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async onModuleDestroy(): Promise<void> {
    // Own flag, not pg's pool.ended: that runtime property is missing from @types/pg
    // (typecheck failure), and a double app.close() must stay safe.
    if (this.poolClosed) return;
    this.poolClosed = true;
    await this.pool.end();
  }
}
```

- [ ] **Step 6: Run to verify pass, then the full suite**

Run: `pnpm --filter @hmis/core test -- --testPathPattern "approvals.e2e"`
Expected: PASS (4 tests).

Run: `pnpm verify`
Expected: PASS — including the pre-existing `health.e2e`, `rbac.e2e`, and both workflow e2e suites (this task adds no boot-time DB call; `syncPermissions` already ran at boot in those suites and merely gains rows from the enlarged registry).

- [ ] **Step 7: Commit**

```bash
git add apps/core
git commit -m "feat(approvals): manifest, module, routes; registry wiring in AppModule"
```

---
### Task 8: Full-lifecycle e2e — SLA breach → escalation ladder, act-first, C-12 over HTTP + docs

**Files:**
- Test: `apps/core/test/approvals-lifecycle.e2e.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything T1–T7 shipped; Plan 03's `runDueTimers` from `../src/kernel/workflow/timers` (called directly, exactly as Plan 03's own tests and Plan 11's future cron do) and its timer-backdating test pattern (`db.update(workflowTimers).set({ dueAt: past })` — the shipped `timers.test.ts` convention).
- Produces: the plan's capstone evidence — an approval request's closure SLA breaching through Plan 03's shipped sweep, the ladder climbing to real role holders, and the C-12 snapshots visible over HTTP. No implementation code.
- **No red run is owed by this task** (EXECUTION-LESSONS §3.5, stated explicitly): it adds tests over already-shipped code plus documentation. The evidence that replaces fail-first is the suite passing with the exact assertions below. **If any assertion fails, that is a genuine defect in T1–T7 or a plan defect — report it in your interpretations field; do not adjust an assertion to make it pass.**

- [ ] **Step 1: Write the e2e**

`apps/core/test/approvals-lifecycle.e2e.test.ts`:
```ts
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { asc, eq } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { setupTestDb, truncateAll } from "./helpers/db";
import { createUser } from "../src/kernel/auth/identity";
import { createSession } from "../src/kernel/auth/sessions";
import { createRole, grantPermissionToRole, syncPermissions, assignRole } from "../src/kernel/auth/permissions";
import { seedSodPairs } from "../src/kernel/auth/sod";
import { authManifest } from "../src/kernel/auth/manifest";
import { workflowManifest } from "../src/kernel/workflow/manifest";
import { approvalsManifest } from "../src/kernel/approvals/manifest";
import { approvalFlowDefinition } from "../src/kernel/approvals/flow";
import { runDueTimers } from "../src/kernel/workflow/timers";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { loadConfig, requireEnv } from "../src/kernel/config";
import { events, workflowInstances, workflowTimers } from "../src/kernel/db/schema";
import type { Db } from "../src/kernel/db/client";

const ICU_DEF = approvalFlowDefinition({
  typeKey: "icu_admission",
  title: "ICU Admission",
  approverRole: "duty_doctor",
  closureSlaMinutes: 30,
  escalation: [
    { afterMinutes: 10, toRole: "supervisor" },
    { afterMinutes: 20, toRole: "department_head" },
  ],
});
const DISCOUNT_DEF = approvalFlowDefinition({
  typeKey: "discount_override",
  title: "Discount Override",
  approverRole: "billing_head",
  closureSlaMinutes: 45,
});

describe("approvals full lifecycle e2e", () => {
  let app: INestApplication;
  let db: Db; let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  registry.install(workflowManifest);
  registry.install(approvalsManifest);
  const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });

  let requesterToken: string;
  let dutyDoctorToken: string;
  let dutyDoctorId: string;
  let billingHeadToken: string;
  let supervisorId: string;
  let departmentHeadId: string;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterAll(async () => { await app.close(); await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    await seedSodPairs(db);
    await syncPermissions(db, registry);
    await createRole(db, "wf_admin", "Workflow Admin");
    for (const permission of workflowManifest.permissions) {
      await grantPermissionToRole(db, registry, "wf_admin", permission);
    }
    await createRole(db, "approvals_admin", "Approvals Admin");
    for (const permission of approvalsManifest.permissions) {
      await grantPermissionToRole(db, registry, "approvals_admin", permission);
    }
    for (const role of ["duty_doctor", "billing_head", "supervisor", "department_head"]) {
      await createRole(db, role, role);
    }

    const mk = async (username: string): Promise<{ id: string; token: string }> => {
      const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
      const { token } = await createSession(db, cfg, id);
      return { id, token };
    };
    const drafter = await mk("drafter");
    const activator = await mk("activator");
    const requester = await mk("requester");
    const dutyDoctor = await mk("duty_doctor1");
    const billingHead = await mk("billing_head1");
    const supervisor = await mk("supervisor1");
    const departmentHead = await mk("dept_head1");
    requesterToken = requester.token;
    dutyDoctorToken = dutyDoctor.token;
    dutyDoctorId = dutyDoctor.id;
    billingHeadToken = billingHead.token;
    supervisorId = supervisor.id;
    departmentHeadId = departmentHead.id;
    await assignRole(db, { userId: drafter.id, roleKey: "wf_admin", scopeType: "hospital" });
    await assignRole(db, { userId: activator.id, roleKey: "wf_admin", scopeType: "hospital" });
    await assignRole(db, { userId: activator.id, roleKey: "approvals_admin", scopeType: "hospital" });
    await assignRole(db, { userId: requester.id, roleKey: "approvals_admin", scopeType: "hospital" });
    await assignRole(db, { userId: dutyDoctor.id, roleKey: "approvals_admin", scopeType: "hospital" });
    await assignRole(db, { userId: dutyDoctor.id, roleKey: "duty_doctor", scopeType: "hospital" });
    await assignRole(db, { userId: billingHead.id, roleKey: "approvals_admin", scopeType: "hospital" });
    await assignRole(db, { userId: billingHead.id, roleKey: "billing_head", scopeType: "hospital" });
    await assignRole(db, { userId: supervisor.id, roleKey: "supervisor", scopeType: "hospital" });
    await assignRole(db, { userId: departmentHead.id, roleKey: "department_head", scopeType: "hospital" });

    for (const [def, typeKey, approverRole, urgencyClass, actFirstAllowed] of [
      [ICU_DEF, "icu_admission", "duty_doctor", "emergency", true],
      [DISCOUNT_DEF, "discount_override", "billing_head", "routine", false],
    ] as const) {
      const draft = await request(app.getHttpServer())
        .post("/workflow/definitions").set("Authorization", `Bearer ${drafter.token}`)
        .send(def).expect(201);
      const { definitionId } = draft.body as { definitionId: string };
      await request(app.getHttpServer())
        .post(`/workflow/definitions/${definitionId}/activate`)
        .set("Authorization", `Bearer ${activator.token}`)
        .expect(201);
      await request(app.getHttpServer())
        .post("/approvals/types").set("Authorization", `Bearer ${activator.token}`)
        .send({ typeKey, title: typeKey, approverRole, urgencyClass, actFirstAllowed })
        .expect(201);
    }
  });

  it("breaches the closure SLA and climbs the ladder through Plan 03's shipped sweep", async () => {
    const created = await request(app.getHttpServer())
      .post("/approvals").set("Authorization", `Bearer ${requesterToken}`)
      .send({
        typeKey: "icu_admission",
        subject: { type: "encounter", id: "e1" },
        patientId: "01HPAT000000000000000000A",
        actFirst: true,
        requestNote: "patient unstable — admitted first (E-15)",
      })
      .expect(201);
    const { approvalId, instanceId } = created.body as { approvalId: string; instanceId: string };

    // Backdate the open closure-SLA timer 40 minutes (the shipped timers.test convention).
    // Ladder cadence anchors on each timer's dueAt, so with rungs at +10/+20 the whole
    // chain is already due: sweep 1 fires the SLA breach, 2 fires rung 0, 3 fires rung 1,
    // 4 finds nothing. One rung per chain per call — Plan 03's documented semantics.
    await db.update(workflowTimers)
      .set({ dueAt: new Date(Date.now() - 40 * 60_000) })
      .where(eq(workflowTimers.instanceId, instanceId));

    expect(await runDueTimers(db)).toBe(1); // sla.breached
    expect(await runDueTimers(db)).toBe(1); // escalation rung 0
    expect(await runDueTimers(db)).toBe(1); // escalation rung 1
    expect(await runDueTimers(db)).toBe(0); // ladder exhausted, nothing due

    const breaches = await db.select().from(events).where(eq(events.name, "sla.breached"));
    expect(breaches).toHaveLength(1);
    expect(breaches[0]!.correlationId).toBe(instanceId);
    expect(breaches[0]!.payload).toMatchObject({
      instanceId, state: "pending", slaMinutes: 30, alerting: "active",
    });

    const escalations = await db.select().from(events)
      .where(eq(events.name, "escalation.triggered")).orderBy(asc(events.seq));
    expect(escalations).toHaveLength(2);
    expect(escalations[0]!.payload).toMatchObject({
      rung: 0, role: "supervisor", resolvedUserIds: [supervisorId],
      fallback: false, fallbackExhausted: false,
    });
    expect(escalations[1]!.payload).toMatchObject({
      rung: 1, role: "department_head", resolvedUserIds: [departmentHeadId],
      fallback: false, fallbackExhausted: false,
    });

    // Escalated but undecided: the item is still pending and actionable.
    const list = await request(app.getHttpServer())
      .get("/approvals").set("Authorization", `Bearer ${dutyDoctorToken}`).expect(200);
    expect(list.body.items.map((i: { id: string }) => i.id)).toEqual([approvalId]);

    // The after-the-fact review closes it — here as a rejection; the consequences of a
    // rejected acted-first item belong to the consumer domain (Plan 08+), not this engine.
    await request(app.getHttpServer())
      .post(`/approvals/${approvalId}/reject`).set("Authorization", `Bearer ${dutyDoctorToken}`)
      .send({ note: "admission not clinically justified on review" })
      .expect(201);
    const [instance] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId));
    expect(instance).toMatchObject({ currentState: "rejected", status: "completed" });
    const rejections = await db.select().from(events).where(eq(events.name, "approval.rejected"));
    expect(rejections).toHaveLength(1);
    expect(rejections[0]!.payload).toMatchObject({ approvalId, actedFirst: true, urgencyClass: "emergency" });
  });

  it("exposes C-12 cumulative snapshots over HTTP (report-only)", async () => {
    const first = await request(app.getHttpServer())
      .post("/approvals").set("Authorization", `Bearer ${requesterToken}`)
      .send({
        typeKey: "discount_override", subject: { type: "invoice", id: "inv1" },
        patientId: "01HPAT000000000000000000A", amountPaise: 500_000,
      })
      .expect(201);
    const second = await request(app.getHttpServer())
      .post("/approvals").set("Authorization", `Bearer ${requesterToken}`)
      .send({
        typeKey: "discount_override", subject: { type: "invoice", id: "inv2" },
        patientId: "01HPAT000000000000000000A", amountPaise: 300_000,
      })
      .expect(201);
    const other = await request(app.getHttpServer())
      .post("/approvals").set("Authorization", `Bearer ${requesterToken}`)
      .send({
        typeKey: "discount_override", subject: { type: "invoice", id: "inv3" },
        patientId: "01HPAT000000000000000000B", amountPaise: 100_000,
      })
      .expect(201);

    const firstDetail = await request(app.getHttpServer())
      .get(`/approvals/${(first.body as { approvalId: string }).approvalId}`)
      .set("Authorization", `Bearer ${billingHeadToken}`).expect(200);
    expect(firstDetail.body.approval.cumulativePatientPaise).toBe(500_000);
    const secondDetail = await request(app.getHttpServer())
      .get(`/approvals/${(second.body as { approvalId: string }).approvalId}`)
      .set("Authorization", `Bearer ${billingHeadToken}`).expect(200);
    expect(secondDetail.body.approval.cumulativePatientPaise).toBe(800_000); // same patient, same IST day
    const otherDetail = await request(app.getHttpServer())
      .get(`/approvals/${(other.body as { approvalId: string }).approvalId}`)
      .set("Authorization", `Bearer ${billingHeadToken}`).expect(200);
    expect(otherDetail.body.approval.cumulativePatientPaise).toBe(100_000); // different patient
  });

  it("orders the worklist emergency-first for a multi-role approver", async () => {
    const discount = await request(app.getHttpServer())
      .post("/approvals").set("Authorization", `Bearer ${requesterToken}`)
      .send({ typeKey: "discount_override", subject: { type: "invoice", id: "inv1" } })
      .expect(201);
    const icu = await request(app.getHttpServer())
      .post("/approvals").set("Authorization", `Bearer ${requesterToken}`)
      .send({
        typeKey: "icu_admission", subject: { type: "encounter", id: "e1" },
        actFirst: true, requestNote: "unstable",
      })
      .expect(201);
    // dutyDoctor additionally picks up billing_head — sees both, emergency first
    // despite the discount item being filed earlier (older requestedAt).
    await assignRole(db, { userId: dutyDoctorId, roleKey: "billing_head", scopeType: "hospital" });
    const list = await request(app.getHttpServer())
      .get("/approvals").set("Authorization", `Bearer ${dutyDoctorToken}`).expect(200);
    expect(list.body.total).toBe(2);
    expect(list.body.items.map((i: { id: string }) => i.id)).toEqual([
      (icu.body as { approvalId: string }).approvalId,
      (discount.body as { approvalId: string }).approvalId,
    ]);
  });
});
```

- [ ] **Step 2: Run the suite**

Run: `pnpm --filter @hmis/core test -- --testPathPattern "approvals-lifecycle"`
Expected: PASS (3 tests). No red run is owed (this task ships no implementation); a failing assertion here is a defect in T1–T7 or in this plan — report it, do not adjust the assertion.

- [ ] **Step 3: Document**

Append to `README.md`:
```markdown
## Approvals engine
One generic mechanism (spec §8): request → approver role → approve/reject with a mandatory
note → event. Every request type is registered configuration backed by a workflow definition
(`approval_<typeKey>`, built by `approvalFlowDefinition`, activated through the workflow
engine's own draft→activate governance), so closure SLAs and escalation ladders run on the
workflow engine's DB-row timers — `runDueTimers()` remains UNSCHEDULED until Plan 11's
pg-boss cron. Requester≠approver is enforced through the seeded `requester_approver` SoD
pair; decisions are single-winner instance transitions. C-12 cumulative same-patient/
same-payee/same-IST-day totals are snapshotted on every money request (report-only —
thresholds arrive with CA configuration in Plans 06/08). Urgency classes
routine|urgent|emergency are fixed per type; act-first-review-after needs the type's
opt-in plus a justification note. Routes: POST /approvals/types · POST /approvals ·
GET /approvals (role-scoped worklist) · GET /approvals/:id · POST /approvals/:id/approve ·
POST /approvals/:id/reject.
```

- [ ] **Step 4: Full verify + commit**

Run: `pnpm verify`
Expected: PASS — full suite green, zero lint problems.

```bash
git add apps/core README.md
git commit -m "feat(approvals): full-lifecycle e2e — SLA breach to escalation, act-first, C-12 snapshots; docs"
```

---

## Self-Review Notes

- **Spec coverage (this plan's slice):** §8 request → approver role → approve/reject with note → event ✓ (T4 request + T5 decisions + T2 events; the mandatory note is runtime-enforced) · §8 approvers act only inside the HMIS, WhatsApp/SMS notify only ✓ (in-app routes T7; notification delivery is Plan 10's gateway consuming these events — none is sent here) · §8 day-one consumers are discount overrides and refunds ✓ (both are registered TYPES + fixtures here; their real wiring lands with billing, Plan 08, per the roadmap) · C-12 anti-structuring cumulative same-patient/same-payee/same-day ✓ (T3 helper + T4 snapshots; owner decisions: IST calendar day, pending+granted counted, rejected excluded, report-only until CA-configured thresholds arrive in Plans 06/08) · E-15 urgency classes ✓ (T2/T3: routine|urgent|emergency fixed per type; owner decision), interrupting channel ✓ as payload data for Plan 10 (events only until then, roadmap-stated), act-first-review-after ✓ (T3 per-type capability + T4 request path + T8 end-to-end with after-the-fact rejection) · E-18 every request type names reviewer role + closure SLA ✓ (T3 registry refuses definitions without them; T1 builder emits them), overdue escalation ✓ (builder sets `alerting: "active"`; T8 proves the ladder fires through Plan 03's sweep) · roadmap Produces line ✓ — `requestApproval` (requester made explicit: SoD needs the requester's identity — deviation noted), `approval.requested/.granted/.rejected`, table `approvals` (plus `approval_types`, needed for E-18/E-15), `cumulativeAmount` (Tx-first object signature carrying the same payeeOrPatientId/type/window information — deviation noted) · roadmap trap requester≠approver via Plan 02 `assertNotSodPair` ✓ (T5, exact seeded key `requester_approver`, `Actor`-object signature) · roadmap trap E-5 not conflated ✓ (no emergency bypass of the SoD pair exists anywhere in this plan; stated in T5) · timeout escalation via Plan 03 ladders ✓ (owner decision Q1a: instance-backed; zero timer code — T8's capstone proves it). Deliberately out of scope: blocking thresholds (Plans 06/08), notification delivery (Plan 10), the two Plan 03 seams — definition activation through approvals (§10.4) and approval-gated remediation — deferred to **Plan 08** (owner decision Q2, recorded in the roadmap), consumer wiring (Plan 08), agent requesters/deciders (Plan 12 seam, runtime-refused), roster-resolved escalation (Plan 11-adjacent, inherited from Plan 03).
- **Catalog discipline:** exactly three names minted — `approval.requested`, `approval.granted`, `approval.rejected` — all present in §10.6 (P7+kernel). `module: "approvals"`, `correlationId` = backing instance id on every emission. `sla.breached`/`escalation.triggered` for approval flows are emitted by Plan 03's shipped code under `module: "workflow"` — not re-minted. Type registration and instance starts emit nothing (no catalog names exist; `workflow.definition.updated` already covers the definition lifecycle).
- **Type consistency:** `ApprovalError` defined once in T3, reused by T4/T5/T6, mapped once in T7's `toHttp` (the Plan 03 `WorkflowError` convention) · `UrgencyClass` defined in T3, consumed by T4/T5/T6/T7; the two zod `urgency` enums (T2 events, T7 controller) carry the same three literals · `approvalFlowDefinition` (T1) output feeds T3's registry validation, T4's `slaMinutes` extraction, and both e2e fixtures — every fixture passes through `defineWorkflow` by construction · `requestApproval`/`listApprovals`/`getApproval`/decision signatures written in T4/T5/T6 are called verbatim in T7's controller and T8's e2e · consumed Plan 01–03 signatures verified against gate reports and the shipped `sod.ts` (scouted this session): `appendEvent(tx, def.make({ actor, payload, correlationId?, patientId?, encounterId? }))`, `newId()`, `startInstance(tx, defKey, subject)`, `transition(tx, instanceId, to, actor, { note })`, `getActiveDefinition(tx, defKey)`, `createDraft(db, actor, defJson)`, `activateDefinition(db, actor, definitionId)`, `runDueTimers(db, now?)`, `assertNotSodPair(db, pairKey, actorA, actorB)` with `Actor` objects and seeded key `requester_approver`, `setupTestDb`/`truncateAll` frozen (truncate list extended by one statement only, placed before the workflow group for FK order).
- **Placeholders:** none — every step carries runnable code or exact commands.
- **Verify-by-execution flags (prove by running, not reading — each names its owning task and the discharging assertion):** ① **bigint `mode: "number"` round-trip** — T2's schema test inserts `123_456_789_012` and asserts `typeof rows[0]!.amountPaise === "number"` plus exact equality (the Plan 01 `seq` string/number trap class). ② **SQL `sum()` returns text** — T3's cumulative test asserts `typeof total === "number"` and the exact `80_000` against seeded rows; same for `count(*)` in T6's pagination test (`typeof page1.total === "number"`). ③ **`istDayWindow` arithmetic** — T3's three pure tests pin both window edges as exact ISO strings for a UTC-evening instant (date rolls forward in IST), a UTC-morning instant, and the exact-midnight boundary. ④ **hand-written SQL CASE ordering fragment** — T6's ordering test asserts the exact item sequence `[emergency, routineOld, routineNew]`; T8 re-proves it over HTTP. ⑤ **single-winner decision under real concurrency** — T5's `Promise.allSettled` race asserts exactly one fulfilled, the loser's code ∈ {`stale_transition`, `not_pending`}, row status === instance state, and exactly one decision event. ⑥ **`onConflictDoNothing().returning()` as the duplicate-type claim** — T3's duplicate test asserts `duplicate_type` on the second registration. ⑦ **Nest route order and registry wiring** — T7's e2e (literal `types` route vs `:id` routes, 401/403 guards, full HTTP lifecycle). ⑧ **migration 0005 generation** — T2 runs `db:generate`, opens the generated SQL, and confirms both tables, both FKs, and `approvals_instance_ux`; later tasks must NOT regenerate; no CI change is expected — confirm by observing each push's CI run green. ⑨ **ladder data flows through shipped timers** — T8's `1,1,1,0` `runDueTimers` sequence with per-rung payload assertions (`rung`, `role`, `resolvedUserIds`, `fallback:false`) proves the builder's escalation JSON drives Plan 03's sweep unmodified. Derived-fixture check (§3.10): every definition fixture in this plan is produced by `approvalFlowDefinition`, which funnels through `defineWorkflow` — an invalid fixture throws at setup, not at assertion time; no fixture is built by spreading another.
- **Standing-rules audit (EXECUTION-LESSONS §3):** §3.1 every task's Files list names every file its steps touch, including `schema/index.ts` + `test/helpers/db.ts` in T2, `app.module.ts` in T7, and `README.md` in T8 · §3.3 no conditional instructions anywhere · §3.5 fail-first ordering holds for T1–T7 (T7's e2e precedes its implementation and its first honest run fails at import/404); T8 explicitly states no red run is owed and what evidence replaces it · §3.6 no task adds a boot-time DB call — T7 only enlarges the registry `syncPermissions` already mirrors; both e2e suites copy the shipped per-worker `DATABASE_URL` derivation verbatim · §3.7 all test imports are static — no `await import(...)` · §2.3 no acceptance criterion demands reproducing a red run on retry; fail-first evidence is owed by the original attempt and inherited · §3.9 every verify-by-execution flag above names its owning task and discharging assertion · §3.10 fixtures are validator-constructed (see flag ⑨ note); the one derived-data hand-check — T8's ladder arithmetic (backdate 40 min vs rungs at +10/+20 anchored on `dueAt`) — is worked out inside the task text against Plan 03's documented anchoring semantics · §3.11 no `JSON.stringify` assertion exists; every body assertion reads parsed fields.

## Pipeline notes (compile from these — execution session)

- Paste EXECUTION-LESSONS **§1 Tripwires verbatim at the TOP of every task brief**, above the goal.
- **Pipeline A = T1–T4, pipeline B = T5–T8, strictly sequential within each** (shared surfaces: `db/schema` consumers throughout; `types.ts` error class consumed by T4–T7; `app.module.ts` only in T7). Land any template/ledger fix between pipelines, then compile B.
- Migration `0005_*` is generated once, in T2 — later tasks must NOT run `db:generate` again (an empty or duplicate migration is a defect; if drizzle-kit emits one anyway, delete it and report).
- Existing deviations not to "fix": everything in gate reports 01/02/03 §4 (e.g., `MODULE_REGISTRY` in `tokens.ts`, static imports in e2e, `@Public` at method level, duplicate import lines in `definitions.ts`/`timers.ts`, argon2 under pnpm `ignoredBuilds`).
- **Plan 03's workflow files are byte-frozen for this plan** — a coder needing to "improve" `kernel/workflow/*` or `kernel/auth/*` must halt and report instead. The seams those files mark (approvals-gated activation/remediation) are deferred to Plan 08 by owner decision.
- This plan adds no dependency, env var, or CI change — if an agent believes one is needed, halt and report instead.
- Briefs point at the committed plan on the server (`git pull --rebase origin main` first) and reference tasks by heading; agents type the plan's exact blocks.
- **Recommended tier map (OWNER-ADJUSTABLE):** T1 sonnet · T2 sonnet · **T3 opus** (C-12 money aggregation — anti-fraud logic where a wrong window or status filter is silently wrong) · **T4 opus** (enforcement semantics: act-first gating, cumulative snapshots, instance coupling — the T8-of-Plan-03 shape: reuses shipped patterns but decides enforcement) · **T5 opus** (SoD + single-winner concurrency + runtime note enforcement + the user-actors-only rule — money decisions) · T6 sonnet · **T7 opus** (multi-file Nest wiring + first fail-first e2e — Plan 03 T9's shape, which was correctly opus) · T8 sonnet. **Opus gate on every task regardless of coder tier — never trade the gate away.** Deleting the four opus coder overrides and running every task on sonnet is a supported choice this plan does not depend on; the owner trades cost against risk at compile time without editing tasks.
- Cost calibration (Plan 03 actuals): ~165k subagent tokens per task including its gate; expect ~1.3M total across both pipelines, ~60–75 min per pipeline, and watch retries — only genuine code defects should consume them.

<!-- PLAN COMPLETE -->
