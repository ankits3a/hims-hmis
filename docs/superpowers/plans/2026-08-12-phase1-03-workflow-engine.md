# Phase 1 / Plan 03 — Workflow Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the kernel its generic workflow engine (spec §10.2–§10.4): definitions as versioned, immutable-once-active data validated by a pure `defineWorkflow()` (every branch reaches a terminal state — the §18 no-dangling-paths rule as a library check), change-class A/B/C governance with owner+MS two-key activation and drafter/activator SoD, instances pinned to their definition version, a transition API enforcing per-transition allowed roles, DB-persisted SLA timers whose `runDueTimers()` emits `sla.breached` and climbs escalation ladders to static role holders with a duty-manager fallback, and approval-gated in-flight remediation (`instance.migrated` / `instance.aborted`).

**Architecture:** The engine is **shared kernel** (spec §3 lists it there), living under `apps/core/src/kernel/workflow/` — the module-isolation lint rule targets `src/modules/**` and is untouched, so the engine may import kernel auth freely. Definitions are validated JSON stored in `jsonb`, versioned per `defKey`, with a **partial unique index guaranteeing one active version per key**; instances carry a `definitionId` pin so in-flight work completes on the version it started on (§10.2). Enforcement is two-layer: the route carries `@RequirePermission("workflow.…", "hospital")` (Plan 02's global guards), and the engine itself checks the definition's per-transition allowed roles against the actor's live role holdings. Timers are rows, not processes: **`runDueTimers(db)` is deliberately unscheduled** — the owner chose option (b) on 2026-08-12 (matching `runDispatchCycle` and `sweepExpiredTempRoles`); Plan 11 registers all three as pg-boss crons in the worker process it builds. The five catalog events this plan owns (`workflow.definition.updated`, `sla.breached`, `escalation.triggered`, `instance.migrated`, `instance.aborted`) go through `appendEvent` with `correlationId` = instance id (§10.5: correlation_id is the workflow instance).

**Tech Stack:** Everything already shipped in Plans 01–02 (Node 22 · pnpm · TS strict · NestJS ^11 · Postgres 16 · drizzle-orm · zod ^4 · Jest ^29). **This plan adds zero new dependencies and zero new env vars** — `package.json`, `pnpm-lock.yaml`, and `.env.example` are untouched.

## Global Constraints (from spec v4.5 + roadmap standing rules + owner decisions)

- TypeScript strict; no `any` in kernel code.
- **Catalog discipline:** exactly five event names minted — `workflow.definition.updated`, `sla.breached`, `escalation.triggered`, `instance.migrated`, `instance.aborted` — all in §10.6's catalog, `module: "workflow"`, full §10.5 envelope via `defineEvent(...).make(...)` + `appendEvent`. Instance starts and transitions mint **no** event names (no such catalog entries): the `workflow_transitions` table is their audit record, and domain modules attach their own catalog events (with `correlationId` = instance id) when they author flows in later plans.
- **The `events` table schema is not touched** (Plan 01 gate report; partitioning is Plan 11).
- **No scheduler of any kind** — no pg-boss, `setTimeout`, `setInterval`, or cron appears anywhere in this plan (owner decision 2026-08-12, option (b), recorded in the roadmap). `runDueTimers()` is invoked by tests now and by Plan 11's pg-boss cron later. Timers survive restarts because they are rows; correctness never depends on the ticker.
- **The engine is generic.** No OPD, billing, or any domain flow appears here — flows are data authored in later plans. Test fixtures use synthetic keys (`test_flow`), synthetic roles (`nurse`, `doctor`), and synthetic subjects.
- Permission strings live **only** in `workflowManifest`, installed in `AppModule`'s `MODULE_REGISTRY` factory (Plan 02 rule). The engine never keeps its own permission list; `syncPermissions` (already running in `AuthModule.onModuleInit`) mirrors the additions — **this plan adds no new boot-time DB call**.
- **Definitions are immutable once active:** no code path updates a definition's `definition` jsonb after activation; every change is a new version (`createDraft`). The one-active-per-key invariant is a **database partial unique index**, not a convention.
- Change-class governance (D-15): Class A = `owner` + `medical_superintendent` two-key; Class B = `department_head` + `duty_manager`; Class C = zero approvals (automated with sampled audit). Role keys are governance conventions in `CHANGE_CLASS_POLICY` — the roles themselves are deployment data; tests create them explicitly. Drafter≠activator is enforced via Plan 02's `assertNotSodPair(db, "workflow_drafter_activator", …)`; the **emergency two-key path (duty manager + MS) supersedes that SoD pair by declared precedence (E-5)** and is loudly flagged in the activation event.
- Escalation ladders resolve to **static role holders** (`role_assignments` + live `temp_role_grants`, any scope) — the roster substrate is Plan 11-adjacent; this seam is marked in code comments and in `usersHoldingRole`'s doc. Dead-end fallback per §11.19-C fix 11: an empty rung resolves to `duty_manager` holders with `fallback: true`; an empty fallback sets `fallbackExhausted: true` (the owner-SMS half arrives with Plan 10's gateway).
- Transition role semantics (documented seam): a `user` actor must hold one of the transition's allowed roles — **any scope satisfies** until org masters exist (Plan 02 gate report §7.3: scope ids are opaque; no hierarchy may be assumed). A `system` actor (the application's own automated moves) bypasses the role check. An `agent` actor is denied — agent grants are the declared Plan 12 seam, same as `PermissionGuard`.
- Remediation (D-11) is gated by `workflow.instances.remediate` + a mandatory reason; routing it through the approvals engine is a **marked Plan 04 seam**.
- Multi-process-safe: no in-memory state anywhere; `runDueTimers` claims each timer with a row-level conditional `UPDATE … RETURNING` before firing, and every instance state move (`transition`, `migrateInstance`, `abortInstance`) is a **conditional single-winner UPDATE** — two concurrent moves of one instance cannot both apply (spec §11.19-B pass-5 engineering note: optimistic locking).
- No config fallbacks (Plan 02 rule); this plan needs no new config values.
- Append-only events; `workflow_transitions` is insert-only (no update/delete path in code).
- **Fail-first discipline (EXECUTION-LESSONS §3.5):** every task's failing-test step comes first, including e2e tasks (T9/T10 write the e2e before the controller code). Fail-first evidence is owed by the **original** attempt; a retry inherits it and must never manufacture red states against shipped code.
- **Static imports in tests** (TS2835 under nodenext — EXECUTION-LESSONS §3.7). No `await import(...)` anywhere.
- Build/test on the server per the roadmap's standing execution rules; `.github/workflows/*` is **not touched** (no CI change is needed: no new deps, no new env vars, no new jest config).

## File Structure (locked by this plan)

```
apps/core/
  src/kernel/workflow/definition.ts      # pure: types, defineWorkflow validation, parseDefinition
  src/kernel/workflow/events.ts          # the five catalog event definitions (defineEvent + zod)
  src/kernel/workflow/roles.ts           # actorHoldsAnyRole / usersHoldingRole (static roster seam)
  src/kernel/workflow/definitions.ts     # drafts, versioning, CHANGE_CLASS_POLICY, approvals, activation
  src/kernel/workflow/instances.ts       # startInstance / transition, WorkflowError
  src/kernel/workflow/timers.ts          # timer rows: schedule/cancel primitives + runDueTimers
  src/kernel/workflow/remediation.ts     # migrateInstance / abortInstance (D-11)
  src/kernel/workflow/manifest.ts        # workflow ModuleManifest (declares workflow.* permissions)
  src/kernel/workflow/workflow.module.ts # Nest module: controller only (guards are global already)
  src/kernel/workflow/workflow.controller.ts  # /workflow/* endpoints
  src/kernel/db/schema/workflow.ts       # all Plan-03 tables (one schema file, one migration: 0004)
```

Modified (exact new contents shown in tasks): `apps/core/src/kernel/db/schema/index.ts`, `apps/core/test/helpers/db.ts` (truncate list only — `setupTestDb` frozen), `apps/core/src/app.module.ts` (imports `WorkflowModule`, installs `workflowManifest`), `README.md` (T10). Generated: one drizzle migration `0004_*` (via `db:generate` — auto-named, never hand-written).

**Not touched, deliberately:** `package.json` (root and core), `pnpm-lock.yaml`, `.env.example`, `jest.config.cjs`, every file under `src/kernel/auth/`, `src/kernel/events/`, `src/kernel/modules/`, `.github/workflows/*`.

**Sequencing:** Tasks strictly ordered 1→10. T2+ share `db/schema/workflow.ts` consumers; T6/T7 share `timers.ts`; T9/T10 share `workflow.controller.ts` — no parallel waves anywhere. Pipeline split: **A = T1–T5, B = T6–T10** (≤6 tasks per Workflow, per the roadmap's standing rules).

---

### Task 1: `defineWorkflow` — the pure validation library

**Files:**
- Create: `apps/core/src/kernel/workflow/definition.ts`
- Test: `apps/core/src/kernel/workflow/definition.test.ts`

**Interfaces:**
- Consumes: `zod` (already a dependency). No DB, no clock — pure.
- Produces (exact, every later task uses these):
  - `type ChangeClass = "A" | "B" | "C"`
  - `type SlaSpec = { minutes: number; alerting: "active" | "record_only"; escalation?: { afterMinutes: number; toRole: string }[] }`
  - `type StateSpec = { name: string; terminal?: boolean; sla?: SlaSpec }`
  - `type TransitionSpec = { from: string; to: string; roles: string[] }`
  - `type WorkflowDefinition = { key: string; title: string; changeClass: ChangeClass; initialState: string; states: StateSpec[]; transitions: TransitionSpec[] }`
  - `class WorkflowValidationError extends Error { readonly problems: string[] }`
  - `defineWorkflow(defJson: unknown): WorkflowDefinition` — zod shape + graph validation; collects **all** problems into one throw.
  - `parseDefinition(stored: unknown): WorkflowDefinition` — re-parses a jsonb-stored definition (same checks).

- [ ] **Step 1: Write the failing tests**

`apps/core/src/kernel/workflow/definition.test.ts`:
```ts
import { defineWorkflow, parseDefinition, WorkflowValidationError } from "./definition";

const VALID = {
  key: "test_flow",
  title: "Test Flow",
  changeClass: "C",
  initialState: "open",
  states: [
    {
      name: "open",
      sla: { minutes: 30, alerting: "active", escalation: [{ afterMinutes: 10, toRole: "duty_manager" }] },
    },
    { name: "in_progress", sla: { minutes: 60, alerting: "record_only" } },
    { name: "done", terminal: true },
  ],
  transitions: [
    { from: "open", to: "in_progress", roles: ["nurse"] },
    { from: "in_progress", to: "done", roles: ["nurse", "doctor"] },
    { from: "in_progress", to: "open", roles: ["doctor"] },
  ],
};

function problemsOf(def: unknown): string[] {
  try {
    defineWorkflow(def);
    return [];
  } catch (e) {
    if (e instanceof WorkflowValidationError) return e.problems;
    throw e;
  }
}

describe("defineWorkflow", () => {
  it("accepts a valid definition and returns it typed", () => {
    const def = defineWorkflow(VALID);
    expect(def.key).toBe("test_flow");
    expect(def.states).toHaveLength(3);
    expect(def.transitions).toHaveLength(3);
  });

  it("round-trips through JSON (parseDefinition on stored jsonb)", () => {
    const def = parseDefinition(JSON.parse(JSON.stringify(VALID)));
    expect(def.initialState).toBe("open");
  });

  it("rejects a malformed shape via zod (bad key, empty roles)", () => {
    expect(problemsOf({ ...VALID, key: "Bad-Key" }).join(" ")).toMatch(/key/);
    expect(
      problemsOf({
        ...VALID,
        transitions: [{ from: "open", to: "done", roles: [] }],
      }).join(" "),
    ).toMatch(/roles/);
  });

  it("rejects an unknown initialState", () => {
    expect(problemsOf({ ...VALID, initialState: "nowhere" })).toContain(
      'initialState "nowhere" is not a declared state',
    );
  });

  it("rejects a terminal initialState", () => {
    const def = {
      key: "degenerate",
      title: "Degenerate",
      changeClass: "C",
      initialState: "done",
      states: [{ name: "done", terminal: true }],
      transitions: [],
    };
    expect(problemsOf(def)).toContain('initialState "done" must not be a terminal state');
  });

  it("requires at least one terminal state", () => {
    const def = {
      key: "loop",
      title: "Loop",
      changeClass: "C",
      initialState: "a",
      states: [
        { name: "a", sla: { minutes: 5, alerting: "record_only" } },
        { name: "b", sla: { minutes: 5, alerting: "record_only" } },
      ],
      transitions: [
        { from: "a", to: "b", roles: ["r"] },
        { from: "b", to: "a", roles: ["r"] },
      ],
    };
    expect(problemsOf(def)).toContain("at least one state must be terminal");
  });

  it("requires an SLA on every non-terminal state and forbids it on terminals", () => {
    const def = {
      key: "sla_rules",
      title: "SLA Rules",
      changeClass: "C",
      initialState: "a",
      states: [
        { name: "a" },
        { name: "z", terminal: true, sla: { minutes: 5, alerting: "record_only" } },
      ],
      transitions: [{ from: "a", to: "z", roles: ["r"] }],
    };
    const problems = problemsOf(def);
    expect(problems).toContain(
      'non-terminal state "a" must carry an SLA (spec §10.3: structure everywhere)',
    );
    expect(problems).toContain('terminal state "z" must not carry an SLA');
  });

  it("rejects transitions referencing unknown states and duplicates", () => {
    const def = {
      ...VALID,
      transitions: [
        { from: "open", to: "gone", roles: ["r"] },
        { from: "open", to: "in_progress", roles: ["r"] },
        { from: "open", to: "in_progress", roles: ["r"] },
        { from: "in_progress", to: "done", roles: ["r"] },
      ],
    };
    const problems = problemsOf(def);
    expect(problems).toContain('transition to unknown state "gone"');
    expect(problems).toContain("duplicate transition open→in_progress");
  });

  it("rejects outgoing transitions from a terminal state", () => {
    const def = {
      ...VALID,
      transitions: [...VALID.transitions, { from: "done", to: "open", roles: ["r"] }],
    };
    expect(problemsOf(def)).toContain('terminal state "done" must have no outgoing transitions');
  });

  it("rejects duplicate state names", () => {
    const def = {
      ...VALID,
      states: [...VALID.states, { name: "open", sla: { minutes: 1, alerting: "record_only" } }],
    };
    expect(problemsOf(def)).toContain("state names must be unique");
  });

  it("rejects states unreachable from the initial state", () => {
    const def = {
      key: "orphan",
      title: "Orphan",
      changeClass: "C",
      initialState: "a",
      states: [
        { name: "a", sla: { minutes: 5, alerting: "record_only" } },
        { name: "b", sla: { minutes: 5, alerting: "record_only" } },
        { name: "z", terminal: true },
      ],
      transitions: [
        { from: "a", to: "z", roles: ["r"] },
        { from: "b", to: "z", roles: ["r"] },
      ],
    };
    expect(problemsOf(def)).toContain('state "b" is unreachable from "a"');
  });

  it("rejects dangling paths — a reachable state that cannot reach any terminal (spec §18)", () => {
    const def = {
      key: "dangling",
      title: "Dangling",
      changeClass: "C",
      initialState: "a",
      states: [
        { name: "a", sla: { minutes: 5, alerting: "record_only" } },
        { name: "trap", sla: { minutes: 5, alerting: "record_only" } },
        { name: "z", terminal: true },
      ],
      transitions: [
        { from: "a", to: "z", roles: ["r"] },
        { from: "a", to: "trap", roles: ["r"] },
      ],
    };
    expect(problemsOf(def)).toContain(
      'state "trap" cannot reach any terminal state (dangling path, spec §18)',
    );
  });

  it("collects every problem into one error", () => {
    const def = {
      ...VALID,
      initialState: "nowhere",
      states: [...VALID.states, { name: "open", sla: { minutes: 1, alerting: "record_only" } }],
    };
    expect(problemsOf(def).length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @hmis/core test -- --testPathPattern "workflow/definition"`
Expected: FAIL — `./definition` not found.

- [ ] **Step 3: Implement**

`apps/core/src/kernel/workflow/definition.ts`:
```ts
import { z } from "zod";

export type ChangeClass = "A" | "B" | "C";

const KEY_RE = /^[a-z][a-z0-9_]*$/;

const slaSchema = z.object({
  minutes: z.number().int().positive(),
  alerting: z.enum(["active", "record_only"]),
  escalation: z
    .array(z.object({ afterMinutes: z.number().int().positive(), toRole: z.string().min(1) }))
    .optional(),
});

const stateSchema = z.object({
  name: z.string().min(1),
  terminal: z.boolean().optional(),
  sla: slaSchema.optional(),
});

const transitionSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  roles: z.array(z.string().min(1)).min(1),
});

const definitionSchema = z.object({
  key: z.string().regex(KEY_RE, "definition key must be lowercase snake_case"),
  title: z.string().min(1),
  changeClass: z.enum(["A", "B", "C"]),
  initialState: z.string().min(1),
  states: z.array(stateSchema).min(1),
  transitions: z.array(transitionSchema),
});

export type SlaSpec = z.infer<typeof slaSchema>;
export type StateSpec = z.infer<typeof stateSchema>;
export type TransitionSpec = z.infer<typeof transitionSchema>;
export type WorkflowDefinition = z.infer<typeof definitionSchema>;

export class WorkflowValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid workflow definition:\n- ${problems.join("\n- ")}`);
    this.name = "WorkflowValidationError";
  }
}

/**
 * Validates a workflow definition (spec §10.2/§10.3 + the §18 no-dangling-paths rule).
 * Pure — no DB, no clock. Collects every problem into a single throw so an author
 * fixes a definition in one pass, not one error at a time.
 */
export function defineWorkflow(defJson: unknown): WorkflowDefinition {
  const parsed = definitionSchema.safeParse(defJson);
  if (!parsed.success) {
    throw new WorkflowValidationError(
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    );
  }
  const def = parsed.data;
  const problems: string[] = [];

  const names = def.states.map((s) => s.name);
  const nameSet = new Set(names);
  if (nameSet.size !== names.length) problems.push("state names must be unique");

  const terminals = def.states.filter((s) => s.terminal === true).map((s) => s.name);
  if (terminals.length === 0) problems.push("at least one state must be terminal");

  if (!nameSet.has(def.initialState)) {
    problems.push(`initialState "${def.initialState}" is not a declared state`);
  } else if (def.states.find((s) => s.name === def.initialState)?.terminal === true) {
    problems.push(`initialState "${def.initialState}" must not be a terminal state`);
  }

  for (const s of def.states) {
    if (s.terminal === true && s.sla !== undefined) {
      problems.push(`terminal state "${s.name}" must not carry an SLA`);
    }
    if (s.terminal !== true && s.sla === undefined) {
      problems.push(`non-terminal state "${s.name}" must carry an SLA (spec §10.3: structure everywhere)`);
    }
  }

  const terminalSet = new Set(terminals);
  const seenPairs = new Set<string>();
  for (const t of def.transitions) {
    if (!nameSet.has(t.from)) problems.push(`transition from unknown state "${t.from}"`);
    if (!nameSet.has(t.to)) problems.push(`transition to unknown state "${t.to}"`);
    if (terminalSet.has(t.from)) problems.push(`terminal state "${t.from}" must have no outgoing transitions`);
    const pair = `${t.from}→${t.to}`;
    if (seenPairs.has(pair)) problems.push(`duplicate transition ${pair}`);
    seenPairs.add(pair);
  }

  // Graph checks only run over a structurally sound definition — otherwise they'd
  // report noise derived from problems already listed above.
  if (problems.length === 0) {
    const out = new Map<string, string[]>(names.map((n) => [n, []]));
    const into = new Map<string, string[]>(names.map((n) => [n, []]));
    for (const t of def.transitions) {
      out.get(t.from)!.push(t.to);
      into.get(t.to)!.push(t.from);
    }

    const reachable = new Set<string>([def.initialState]);
    const queue = [def.initialState];
    while (queue.length > 0) {
      for (const next of out.get(queue.shift()!)!) {
        if (!reachable.has(next)) {
          reachable.add(next);
          queue.push(next);
        }
      }
    }
    for (const n of names) {
      if (!reachable.has(n)) problems.push(`state "${n}" is unreachable from "${def.initialState}"`);
    }

    // Reverse reachability from the terminals: every reachable state must be able
    // to finish (spec §18 — "every branch reaches a terminal state").
    const reachesTerminal = new Set<string>(terminals);
    const rqueue = [...terminals];
    while (rqueue.length > 0) {
      for (const prev of into.get(rqueue.shift()!)!) {
        if (!reachesTerminal.has(prev)) {
          reachesTerminal.add(prev);
          rqueue.push(prev);
        }
      }
    }
    for (const n of reachable) {
      if (!reachesTerminal.has(n)) {
        problems.push(`state "${n}" cannot reach any terminal state (dangling path, spec §18)`);
      }
    }
  }

  if (problems.length > 0) throw new WorkflowValidationError(problems);
  return def;
}

/** Re-parses a definition previously stored as jsonb. Throws if the stored row is corrupt. */
export function parseDefinition(stored: unknown): WorkflowDefinition {
  return defineWorkflow(stored);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @hmis/core test -- --testPathPattern "workflow/definition"`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/kernel/workflow
git commit -m "feat(workflow): defineWorkflow validation library — no dangling paths (spec §18)"
```

---

### Task 2: Schema (migration 0004) + the five catalog event definitions

**Files:**
- Create: `apps/core/src/kernel/db/schema/workflow.ts`, `apps/core/src/kernel/workflow/events.ts`
- Modify: `apps/core/src/kernel/db/schema/index.ts`, `apps/core/test/helpers/db.ts` (truncate list only)
- Create: generated migration in `apps/core/drizzle/` (via `db:generate` — auto-named `0004_*`, do not hand-write it)
- Test: `apps/core/src/kernel/db/schema/workflow.test.ts`, `apps/core/src/kernel/workflow/events.test.ts`

**Interfaces:**
- Consumes: drizzle helpers (Plan 01); `defineEvent` from `@hmis/contracts`; `WorkflowDefinition` types (Task 1, for doc comments only — schema stores plain jsonb).
- Produces (exact drizzle exports later tasks import from `../db/schema`): `workflowDefinitions`, `workflowDefinitionApprovals`, `workflowInstances`, `workflowTransitions`, `workflowTimers`.
- Produces (exact event defs later tasks import from `./events`): `workflowDefinitionUpdated`, `slaBreached`, `escalationTriggered`, `instanceMigrated`, `instanceAborted` — **the plan's complete event surface; no other task mints a name.**
- **This task does not touch the `events` table.** `draftedBy`/`approverId`/actor columns are plain text (no FK to `users`) deliberately: Plan 12's agent actors (Workflow Tuner drafts definitions) must fit without a schema change.

- [ ] **Step 1: Write the failing tests**

`apps/core/src/kernel/workflow/events.test.ts`:
```ts
import {
  workflowDefinitionUpdated, slaBreached, escalationTriggered, instanceMigrated, instanceAborted,
} from "./events";

const actor = { type: "system", id: "test" } as const;

describe("workflow event definitions", () => {
  it("declares exactly the five catalog names under module workflow", () => {
    expect(workflowDefinitionUpdated.name).toBe("workflow.definition.updated");
    expect(slaBreached.name).toBe("sla.breached");
    expect(escalationTriggered.name).toBe("escalation.triggered");
    expect(instanceMigrated.name).toBe("instance.migrated");
    expect(instanceAborted.name).toBe("instance.aborted");
    for (const def of [workflowDefinitionUpdated, slaBreached, escalationTriggered, instanceMigrated, instanceAborted]) {
      expect(def.module).toBe("workflow");
      expect(def.version).toBe(1);
    }
  });

  it("validates payloads via zod and carries correlationId through make()", () => {
    const input = slaBreached.make({
      actor,
      correlationId: "01HINSTANCE00000000000000A",
      payload: {
        instanceId: "01HINSTANCE00000000000000A",
        defKey: "test_flow",
        definitionVersion: 1,
        state: "open",
        slaMinutes: 30,
        alerting: "active",
        dueAt: new Date(0).toISOString(),
      },
    });
    expect(input.correlationId).toBe("01HINSTANCE00000000000000A");
    expect(() =>
      slaBreached.make({ actor, payload: { instanceId: "x" } }),
    ).toThrow();
  });

  it("rejects an unknown action on workflow.definition.updated", () => {
    expect(() =>
      workflowDefinitionUpdated.make({
        actor,
        payload: {
          definitionId: "d", defKey: "k", version: 1, changeClass: "A", action: "deleted",
        },
      }),
    ).toThrow();
  });
});
```

`apps/core/src/kernel/db/schema/workflow.test.ts`:
```ts
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import {
  workflowDefinitions, workflowDefinitionApprovals, workflowInstances, workflowTimers,
} from "./workflow";
import type { Db } from "../client";

const DEF_JSON = {
  key: "test_flow",
  title: "Test Flow",
  changeClass: "C",
  initialState: "open",
  states: [
    { name: "open", sla: { minutes: 30, alerting: "active" } },
    { name: "done", terminal: true },
  ],
  transitions: [{ from: "open", to: "done", roles: ["nurse"] }],
};

describe("workflow tables", () => {
  let db: Db; let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  it("round-trips a definition with jsonb intact and defaults applied", async () => {
    await db.insert(workflowDefinitions).values({
      id: "01HDEF000000000000000000A", defKey: "test_flow", version: 1,
      title: "Test Flow", changeClass: "C", definition: DEF_JSON, draftedBy: "u1",
    });
    const rows = await db.select().from(workflowDefinitions);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("draft");
    expect(rows[0]!.definition).toEqual(DEF_JSON);
  });

  it("enforces (defKey, version) uniqueness", async () => {
    const base = { defKey: "test_flow", version: 1, title: "T", changeClass: "C", definition: DEF_JSON, draftedBy: "u1" };
    await db.insert(workflowDefinitions).values({ ...base, id: "01A" });
    await expect(db.insert(workflowDefinitions).values({ ...base, id: "01B" })).rejects.toThrow();
  });

  it("allows only ONE active version per defKey (partial unique index)", async () => {
    const base = { defKey: "test_flow", title: "T", changeClass: "C", definition: DEF_JSON, draftedBy: "u1" };
    await db.insert(workflowDefinitions).values({ ...base, id: "01A", version: 1, status: "active" });
    await expect(
      db.insert(workflowDefinitions).values({ ...base, id: "01B", version: 2, status: "active" }),
    ).rejects.toThrow();
    // retired + draft rows of the same key coexist freely:
    await db.insert(workflowDefinitions).values({ ...base, id: "01C", version: 2, status: "retired" });
    await db.insert(workflowDefinitions).values({ ...base, id: "01D", version: 3 });
  });

  it("approvals are unique per (definitionId, approverId) and FK-checked", async () => {
    await expect(
      db.insert(workflowDefinitionApprovals).values({
        id: "01AP1", definitionId: "missing", approverId: "u2", roleKey: "owner", note: "ok",
      }),
    ).rejects.toThrow(); // FK
    await db.insert(workflowDefinitions).values({
      id: "01HDEF000000000000000000A", defKey: "test_flow", version: 1,
      title: "T", changeClass: "A", definition: DEF_JSON, draftedBy: "u1",
    });
    const approval = {
      definitionId: "01HDEF000000000000000000A", approverId: "u2", roleKey: "owner", note: "ok",
    };
    await db.insert(workflowDefinitionApprovals).values({ ...approval, id: "01AP2" });
    await expect(
      db.insert(workflowDefinitionApprovals).values({ ...approval, id: "01AP3" }),
    ).rejects.toThrow(); // unique (definitionId, approverId)
  });

  it("instances and timers FK back to their parents", async () => {
    await expect(
      db.insert(workflowInstances).values({
        id: "01INST1", definitionId: "missing", defKey: "test_flow", currentState: "open",
        subjectType: "test", subjectId: "s1", stateEnteredAt: new Date(),
      }),
    ).rejects.toThrow(); // FK to definitions
    await expect(
      db.insert(workflowTimers).values({
        id: "01TMR1", instanceId: "missing", state: "open", kind: "sla", dueAt: new Date(),
      }),
    ).rejects.toThrow(); // FK to instances
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @hmis/core test -- --testPathPattern "workflow"`
Expected: FAIL — `./events` and `./workflow` (schema) not found.

- [ ] **Step 3: Implement the schema**

`apps/core/src/kernel/db/schema/workflow.ts`:
```ts
import {
  pgTable, text, integer, boolean, timestamp, jsonb, index, uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const workflowDefinitions = pgTable(
  "workflow_definitions",
  {
    id: text("id").primaryKey(),
    defKey: text("def_key").notNull(),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    changeClass: text("change_class").notNull(), // 'A' | 'B' | 'C' (D-15)
    definition: jsonb("definition").notNull(), // validated WorkflowDefinition JSON — immutable once active
    status: text("status").notNull().default("draft"), // 'draft' | 'active' | 'retired'
    draftedBy: text("drafted_by").notNull(), // actor id, plain text: agent drafters arrive Plan 12
    activatedBy: text("activated_by"),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("workflow_definitions_key_version_ux").on(t.defKey, t.version),
    // One active version per key — a database invariant, not a convention.
    uniqueIndex("workflow_definitions_one_active_ux").on(t.defKey).where(sql`${t.status} = 'active'`),
    index("workflow_definitions_key_idx").on(t.defKey),
  ],
);

export const workflowDefinitionApprovals = pgTable(
  "workflow_definition_approvals",
  {
    id: text("id").primaryKey(),
    definitionId: text("definition_id").notNull().references(() => workflowDefinitions.id),
    approverId: text("approver_id").notNull(),
    roleKey: text("role_key").notNull(), // the governance role the approval was given under
    emergency: boolean("emergency").notNull().default(false), // E-5 emergency two-key path
    note: text("note").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("workflow_def_approvals_ux").on(t.definitionId, t.approverId)],
);

export const workflowInstances = pgTable(
  "workflow_instances",
  {
    id: text("id").primaryKey(),
    definitionId: text("definition_id").notNull().references(() => workflowDefinitions.id), // version pin (§10.2)
    defKey: text("def_key").notNull(),
    currentState: text("current_state").notNull(),
    status: text("status").notNull().default("active"), // 'active' | 'completed' | 'aborted'
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    patientId: text("patient_id"),
    encounterId: text("encounter_id"),
    stateEnteredAt: timestamp("state_entered_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    index("workflow_instances_key_idx").on(t.defKey),
    index("workflow_instances_patient_idx").on(t.patientId),
    index("workflow_instances_status_idx").on(t.status),
  ],
);

export const workflowTransitions = pgTable(
  "workflow_transitions",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id").notNull().references(() => workflowInstances.id),
    fromState: text("from_state").notNull(),
    toState: text("to_state").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    note: text("note"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("workflow_transitions_instance_idx").on(t.instanceId)],
);

export const workflowTimers = pgTable(
  "workflow_timers",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id").notNull().references(() => workflowInstances.id),
    state: text("state").notNull(),
    kind: text("kind").notNull(), // 'sla' | 'escalation'
    rung: integer("rung"), // null for kind='sla'; 0-based ladder index for 'escalation'
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    firedAt: timestamp("fired_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("workflow_timers_due_idx").on(t.dueAt),
    index("workflow_timers_instance_idx").on(t.instanceId),
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
```

Run: `pnpm --filter @hmis/core db:generate && pnpm --filter @hmis/core db:migrate`
Expected: one new migration (`0004_*`) creating all five tables (including the partial unique index `workflow_definitions_one_active_ux … WHERE "status" = 'active'` — open the generated SQL and confirm the `WHERE` clause is present); `migrations applied`.

- [ ] **Step 4: Extend `truncateAll`**

In `apps/core/test/helpers/db.ts`, `truncateAll` becomes (one new statement for the FK-linked workflow tables; everything else byte-identical — `setupTestDb` is frozen):
```ts
export async function truncateAll(db: Db): Promise<void> {
  await db.execute(sql`truncate table events restart identity`);
  await db.execute(sql`truncate table event_cursors`);
  await db.execute(sql`truncate table event_idempotency`);
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

`apps/core/src/kernel/workflow/events.ts`:
```ts
import { z } from "zod";
import { defineEvent } from "@hmis/contracts";

// The plan's complete event surface — five catalog names (§10.6), module "workflow".

export const workflowDefinitionUpdated = defineEvent(
  "workflow.definition.updated",
  "workflow",
  z.object({
    definitionId: z.string(),
    defKey: z.string(),
    version: z.number().int(),
    changeClass: z.enum(["A", "B", "C"]),
    action: z.enum(["drafted", "approved", "activated"]),
    emergency: z.boolean().optional(), // set on E-5 emergency-path approvals/activations
    retiredVersion: z.number().int().optional(), // set when activation retires a previous version
  }),
);

export const slaBreached = defineEvent(
  "sla.breached",
  "workflow",
  z.object({
    instanceId: z.string(),
    defKey: z.string(),
    definitionVersion: z.number().int(),
    state: z.string(),
    slaMinutes: z.number().int(),
    alerting: z.enum(["active", "record_only"]), // §10.3: structure everywhere, alerts selective
    dueAt: z.string(), // ISO timestamp
  }),
);

export const escalationTriggered = defineEvent(
  "escalation.triggered",
  "workflow",
  z.object({
    instanceId: z.string(),
    defKey: z.string(),
    state: z.string(),
    rung: z.number().int(),
    role: z.string(),
    resolvedUserIds: z.array(z.string()), // static role holders — roster substrate is the Plan 11 seam
    fallback: z.boolean(), // rung role resolved to nobody; duty_manager took over (fix 11)
    fallbackExhausted: z.boolean(), // even duty_manager empty — owner SMS is Plan 10's half of fix 11
  }),
);

export const instanceMigrated = defineEvent(
  "instance.migrated",
  "workflow",
  z.object({
    instanceId: z.string(),
    defKey: z.string(),
    fromDefinitionId: z.string(),
    toDefinitionId: z.string(),
    fromVersion: z.number().int(),
    toVersion: z.number().int(),
    fromState: z.string(),
    toState: z.string(),
    reason: z.string(),
  }),
);

export const instanceAborted = defineEvent(
  "instance.aborted",
  "workflow",
  z.object({
    instanceId: z.string(),
    defKey: z.string(),
    state: z.string(),
    reason: z.string(),
  }),
);
```

- [ ] **Step 6: Run to verify pass, then the full suite**

Run: `pnpm --filter @hmis/core test -- --testPathPattern "workflow"`
Expected: PASS (definition 13, events 3, schema 5).

Run: `pnpm verify`
Expected: PASS — full suite green (the extended truncate list must not break any existing suite).

- [ ] **Step 7: Commit**

```bash
git add apps/core
git commit -m "feat(workflow): schema for definitions, instances, transitions, timers + five catalog event defs"
```

---

### Task 3: Role-holding helpers — the static roster seam

**Files:**
- Create: `apps/core/src/kernel/workflow/roles.ts`
- Test: `apps/core/src/kernel/workflow/roles.test.ts`

**Interfaces:**
- Consumes: `roleAssignments`, `tempRoleGrants` schema (Plan 02); `withTx`, `Tx` (Plan 01).
- Produces (exact — T5/T6/T7 call these):
  - `actorHoldsAnyRole(tx: Tx, userId: string, roleKeys: string[]): Promise<boolean>` — true when the user holds ANY of the roles via a permanent assignment (any scope) or an unexpired temp grant. Empty `roleKeys` returns false.
  - `usersHoldingRole(tx: Tx, roleKey: string): Promise<string[]>` — deduped, **sorted** user ids holding the role now (permanent any-scope + unexpired temp grants).
- Both are `Tx`-typed because every caller runs inside `withTx`. **Scope is deliberately ignored** (any-scope satisfies): scoped enforcement needs org masters (Plan 02 gate report §7.3 — no hierarchy may be assumed); this is the marked seam, restated in the doc comment.

- [ ] **Step 1: Write the failing tests**

`apps/core/src/kernel/workflow/roles.test.ts`:
```ts
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { actorHoldsAnyRole, usersHoldingRole } from "./roles";
import { createUser } from "../auth/identity";
import { createRole, assignRole } from "../auth/permissions";
import { grantTempRole } from "../auth/temp-roles";
import { tempRoleGrants } from "../db/schema";
import { withTx } from "../db/client";
import { loadConfig } from "../config";
import type { Db } from "../db/client";

const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });

describe("workflow role helpers", () => {
  let db: Db; let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  it("sees permanent assignments at any scope", async () => {
    const { id } = await createUser(db, { username: "n1", fullName: "N", password: "p1234567" });
    await createRole(db, "nurse", "Nurse");
    await assignRole(db, { userId: id, roleKey: "nurse", scopeType: "department", scopeId: "opd" });
    await withTx(db, async (tx) => {
      expect(await actorHoldsAnyRole(tx, id, ["nurse", "doctor"])).toBe(true);
      expect(await actorHoldsAnyRole(tx, id, ["doctor"])).toBe(false);
      expect(await actorHoldsAnyRole(tx, id, [])).toBe(false);
    });
  });

  it("sees unexpired temp grants and ignores expired ones", async () => {
    const { id: grantor } = await createUser(db, { username: "g1", fullName: "G", password: "p1234567" });
    const { id: user } = await createUser(db, { username: "n2", fullName: "N", password: "p1234567" });
    const { id: lapsed } = await createUser(db, { username: "n3", fullName: "L", password: "p1234567" });
    await createRole(db, "duty_manager", "Duty Manager");
    await grantTempRole(db, cfg, { type: "user", id: grantor }, {
      userId: user, roleKey: "duty_manager", reason: "cover", ttlMinutes: 30,
    });
    await db.insert(tempRoleGrants).values({
      id: "01HGRANTLAPSED00000000000A", userId: lapsed, roleKey: "duty_manager",
      grantedBy: grantor, kind: "granted", reason: "lapsed", expiresAt: new Date(Date.now() - 60_000),
    });
    await withTx(db, async (tx) => {
      expect(await actorHoldsAnyRole(tx, user, ["duty_manager"])).toBe(true);
      expect(await actorHoldsAnyRole(tx, lapsed, ["duty_manager"])).toBe(false);
      expect(await usersHoldingRole(tx, "duty_manager")).toEqual([user]);
    });
  });

  it("resolves holders deduped and sorted across permanent + temp holdings", async () => {
    const { id: a } = await createUser(db, { username: "a", fullName: "A", password: "p1234567" });
    const { id: b } = await createUser(db, { username: "b", fullName: "B", password: "p1234567" });
    const { id: g } = await createUser(db, { username: "g", fullName: "G", password: "p1234567" });
    await createRole(db, "reviewer", "Reviewer");
    await assignRole(db, { userId: a, roleKey: "reviewer", scopeType: "hospital" });
    await assignRole(db, { userId: b, roleKey: "reviewer", scopeType: "floor", scopeId: "f1" });
    await grantTempRole(db, cfg, { type: "user", id: g }, {
      userId: a, roleKey: "reviewer", reason: "double-holding must dedupe", ttlMinutes: 30,
    });
    await withTx(db, async (tx) => {
      expect(await usersHoldingRole(tx, "reviewer")).toEqual([a, b].sort());
      expect(await usersHoldingRole(tx, "nobody_role")).toEqual([]);
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @hmis/core test -- --testPathPattern "workflow/roles"`
Expected: FAIL — `./roles` not found.

- [ ] **Step 3: Implement**

`apps/core/src/kernel/workflow/roles.ts`:
```ts
import { and, eq, gt, inArray } from "drizzle-orm";
import { roleAssignments, tempRoleGrants } from "../db/schema";
import type { Tx } from "../db/client";

/**
 * Role-holding checks for workflow enforcement (spec §10.2: allowed roles per transition,
 * escalation to role holders). ANY-scope holdings satisfy: scope ids are opaque until org
 * masters exist (Plan 02 gate report §7.3), so scoped enforcement is a marked SEAM — when
 * org masters land, tighten here, in one place. Tx-typed: every caller runs inside withTx.
 */
export async function actorHoldsAnyRole(tx: Tx, userId: string, roleKeys: string[]): Promise<boolean> {
  if (roleKeys.length === 0) return false;
  const permanent = await tx
    .select({ roleKey: roleAssignments.roleKey })
    .from(roleAssignments)
    .where(and(eq(roleAssignments.userId, userId), inArray(roleAssignments.roleKey, roleKeys)));
  if (permanent.length > 0) return true;
  const temp = await tx
    .select({ roleKey: tempRoleGrants.roleKey })
    .from(tempRoleGrants)
    .where(
      and(
        eq(tempRoleGrants.userId, userId),
        inArray(tempRoleGrants.roleKey, roleKeys),
        gt(tempRoleGrants.expiresAt, new Date()),
      ),
    );
  return temp.length > 0;
}

/**
 * Static role-holder resolution — the roster substrate is Plan 11-adjacent (roadmap);
 * until it lands, escalation resolves to everyone currently holding the role.
 * Deduped and sorted so event payloads are deterministic.
 */
export async function usersHoldingRole(tx: Tx, roleKey: string): Promise<string[]> {
  const permanent = await tx
    .select({ userId: roleAssignments.userId })
    .from(roleAssignments)
    .where(eq(roleAssignments.roleKey, roleKey));
  const temp = await tx
    .select({ userId: tempRoleGrants.userId })
    .from(tempRoleGrants)
    .where(and(eq(tempRoleGrants.roleKey, roleKey), gt(tempRoleGrants.expiresAt, new Date())));
  return [...new Set([...permanent.map((r) => r.userId), ...temp.map((r) => r.userId)])].sort();
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @hmis/core test -- --testPathPattern "workflow/roles"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/kernel/workflow
git commit -m "feat(workflow): role-holding helpers — any-scope check + static holder resolution (roster seam)"
```

---

### Task 4: Definition drafts — versioning, immutability, `getActiveDefinition`

**Files:**
- Create: `apps/core/src/kernel/workflow/definitions.ts`
- Test: `apps/core/src/kernel/workflow/definitions.test.ts`

**Interfaces:**
- Consumes: `defineWorkflow`/`parseDefinition` (T1), `workflowDefinitions` (T2), `workflowDefinitionUpdated` (T2), `appendEvent`/`withTx`/`newId` (Plans 01–02).
- Produces (exact — T5/T6/T8/T9 consume these):
  - `type DefinitionRow = typeof workflowDefinitions.$inferSelect`
  - `createDraft(db: Db, actor: Actor, defJson: unknown): Promise<{ definitionId: string; defKey: string; version: number }>` — validates via `defineWorkflow` (throws `WorkflowValidationError`), allocates `version` = max(defKey)+1, inserts a `draft` row, emits `workflow.definition.updated` (`action: "drafted"`) in the same transaction.
  - `getActiveDefinition(tx: Tx, defKey: string): Promise<(DefinitionRow & { parsed: WorkflowDefinition }) | null>`
  - `listDefinitions(db: Db, defKey: string): Promise<DefinitionRow[]>` — newest version first.
- **Immutability is structural:** this module exposes no function that updates a row's `definition` jsonb — a change is always a new draft version. Concurrent drafts of the same key can race to the same version number; the `(defKey, version)` unique index rejects the loser loudly (acceptable: definition authoring is a rare governance act, not a hot path).

- [ ] **Step 1: Write the failing tests**

`apps/core/src/kernel/workflow/definitions.test.ts`:
```ts
import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { createDraft, getActiveDefinition, listDefinitions } from "./definitions";
import { WorkflowValidationError } from "./definition";
import { workflowDefinitions, events } from "../db/schema";
import { withTx } from "../db/client";
import type { Db } from "../db/client";

const actor = { type: "user", id: "01HUSER00000000000000000A" } as const;

const DEF_JSON = {
  key: "test_flow",
  title: "Test Flow",
  changeClass: "C",
  initialState: "open",
  states: [
    { name: "open", sla: { minutes: 30, alerting: "active" } },
    { name: "done", terminal: true },
  ],
  transitions: [{ from: "open", to: "done", roles: ["nurse"] }],
};

describe("workflow definition drafts", () => {
  let db: Db; let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  it("creates version 1 as a draft and emits workflow.definition.updated", async () => {
    const { definitionId, defKey, version } = await createDraft(db, actor, DEF_JSON);
    expect(defKey).toBe("test_flow");
    expect(version).toBe(1);
    const rows = await db.select().from(workflowDefinitions);
    expect(rows[0]!.id).toBe(definitionId);
    expect(rows[0]!.status).toBe("draft");
    expect(rows[0]!.draftedBy).toBe(actor.id);
    const emitted = await db.select().from(events).where(eq(events.name, "workflow.definition.updated"));
    expect(emitted).toHaveLength(1);
    expect((emitted[0]!.payload as { action: string }).action).toBe("drafted");
  });

  it("allocates the next version per defKey", async () => {
    await createDraft(db, actor, DEF_JSON);
    const second = await createDraft(db, actor, DEF_JSON);
    expect(second.version).toBe(2);
  });

  it("rejects an invalid definition without writing anything", async () => {
    await expect(createDraft(db, actor, { ...DEF_JSON, initialState: "nowhere" })).rejects.toThrow(
      WorkflowValidationError,
    );
    expect(await db.select().from(workflowDefinitions)).toHaveLength(0);
    expect(await db.select().from(events)).toHaveLength(0);
  });

  it("getActiveDefinition returns null until a version is active, then the parsed row", async () => {
    const { definitionId } = await createDraft(db, actor, DEF_JSON);
    await withTx(db, async (tx) => {
      expect(await getActiveDefinition(tx, "test_flow")).toBeNull();
    });
    await db.update(workflowDefinitions)
      .set({ status: "active" })
      .where(eq(workflowDefinitions.id, definitionId)); // direct write: activation itself is Task 5
    await withTx(db, async (tx) => {
      const active = await getActiveDefinition(tx, "test_flow");
      expect(active!.id).toBe(definitionId);
      expect(active!.parsed.initialState).toBe("open");
    });
  });

  it("lists versions newest first", async () => {
    await createDraft(db, actor, DEF_JSON);
    await createDraft(db, actor, DEF_JSON);
    const list = await listDefinitions(db, "test_flow");
    expect(list.map((d) => d.version)).toEqual([2, 1]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @hmis/core test -- --testPathPattern "workflow/definitions"`
Expected: FAIL — `./definitions` not found.

- [ ] **Step 3: Implement**

`apps/core/src/kernel/workflow/definitions.ts`:
```ts
import { and, desc, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { workflowDefinitions } from "../db/schema";
import { appendEvent } from "../events/append";
import { withTx } from "../db/client";
import { defineWorkflow, parseDefinition } from "./definition";
import type { ChangeClass, WorkflowDefinition } from "./definition";
import { workflowDefinitionUpdated } from "./events";
import type { Db, Tx } from "../db/client";

export type DefinitionRow = typeof workflowDefinitions.$inferSelect;

export async function createDraft(
  db: Db,
  actor: Actor,
  defJson: unknown,
): Promise<{ definitionId: string; defKey: string; version: number }> {
  const def = defineWorkflow(defJson); // throws WorkflowValidationError before any write
  const definitionId = newId();
  const version = await withTx(db, async (tx) => {
    const latest = await tx
      .select({ version: workflowDefinitions.version })
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.defKey, def.key))
      .orderBy(desc(workflowDefinitions.version))
      .limit(1);
    const nextVersion = (latest[0]?.version ?? 0) + 1;
    await tx.insert(workflowDefinitions).values({
      id: definitionId,
      defKey: def.key,
      version: nextVersion,
      title: def.title,
      changeClass: def.changeClass,
      definition: def,
      draftedBy: actor.id,
    });
    await appendEvent(
      tx,
      workflowDefinitionUpdated.make({
        actor,
        payload: {
          definitionId,
          defKey: def.key,
          version: nextVersion,
          changeClass: def.changeClass as ChangeClass,
          action: "drafted",
        },
      }),
    );
    return nextVersion;
  });
  return { definitionId, defKey: def.key, version };
}

export async function getActiveDefinition(
  tx: Tx,
  defKey: string,
): Promise<(DefinitionRow & { parsed: WorkflowDefinition }) | null> {
  const rows = await tx
    .select()
    .from(workflowDefinitions)
    .where(and(eq(workflowDefinitions.defKey, defKey), eq(workflowDefinitions.status, "active")));
  const row = rows[0];
  if (!row) return null;
  return { ...row, parsed: parseDefinition(row.definition) };
}

export async function listDefinitions(db: Db, defKey: string): Promise<DefinitionRow[]> {
  return db
    .select()
    .from(workflowDefinitions)
    .where(eq(workflowDefinitions.defKey, defKey))
    .orderBy(desc(workflowDefinitions.version));
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @hmis/core test -- --testPathPattern "workflow/definitions"`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/kernel/workflow
git commit -m "feat(workflow): versioned definition drafts, immutable jsonb, active-version lookup"
```

---

### Task 5: Change-class approvals + two-key activation (D-15, E-5, drafter/activator SoD)

**Files:**
- Modify: `apps/core/src/kernel/workflow/definitions.ts` (extend — everything from Task 4 stays byte-identical)
- Test: `apps/core/src/kernel/workflow/governance.test.ts`

**Interfaces:**
- Consumes: T3 `actorHoldsAnyRole`, T4 exports, Plan 02 `assertNotSodPair` + `SodViolationError` (pair key `workflow_drafter_activator` is already seeded by `AuthModule.onModuleInit` in production and by `seedSodPairs(db)` in tests), `workflowDefinitionApprovals` (T2).
- Produces (exact — T9's controller and Plan 04's seam consume these):
  - `type ChangeClassPolicy = { requiredRoles: string[]; emergencyRoles: string[] | null }`
  - `const CHANGE_CLASS_POLICY: Record<ChangeClass, ChangeClassPolicy>` — A: `["owner","medical_superintendent"]` with emergency `["duty_manager","medical_superintendent"]` (D-10/E-5); B: `["department_head","duty_manager"]`, no emergency set; C: `[]` (automated with sampled audit).
  - `class GovernanceError extends Error { readonly code: "actor_not_user" | "unknown_definition" | "not_draft" | "role_not_in_policy" | "approver_lacks_role" | "duplicate_approval" | "approvals_missing" }`
  - `approveDefinition(db: Db, actor: Actor, input: { definitionId: string; roleKey: string; note: string; emergency?: boolean }): Promise<void>` — approver must be a user, must currently hold `roleKey`, and `roleKey` must belong to the class's required (or, with `emergency: true`, emergency) set; one approval per user per definition; emits `workflow.definition.updated` (`action: "approved"`).
  - `activateDefinition(db: Db, actor: Actor, definitionId: string): Promise<{ retiredVersion: number | null }>` — requires the policy satisfied (normal set of non-emergency approvals, OR the emergency set of emergency approvals); enforces drafter≠activator via `assertNotSodPair` **except when activating on the emergency path (E-5 declared precedence)**; retires the currently-active version of the same key; emits `action: "activated"` with `emergency` and `retiredVersion` when applicable.
- **Plan 04 seam (stated):** when the approvals engine ships, definition activation routes through it (§10.4); these inline approval records are the interim mechanism and remain the storage the engine will drive.

- [ ] **Step 1: Write the failing tests**

`apps/core/src/kernel/workflow/governance.test.ts`:
```ts
import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { createDraft, approveDefinition, activateDefinition, GovernanceError } from "./definitions";
import { createUser } from "../auth/identity";
import { createRole, assignRole } from "../auth/permissions";
import { seedSodPairs, SodViolationError } from "../auth/sod";
import { workflowDefinitions, events } from "../db/schema";
import type { Db } from "../db/client";
import type { Actor } from "@hmis/contracts";

const DEF_A = {
  key: "class_a_flow",
  title: "Class A Flow",
  changeClass: "A",
  initialState: "open",
  states: [
    { name: "open", sla: { minutes: 30, alerting: "record_only" } },
    { name: "done", terminal: true },
  ],
  transitions: [{ from: "open", to: "done", roles: ["nurse"] }],
};
const DEF_C = { ...DEF_A, key: "class_c_flow", title: "Class C Flow", changeClass: "C" };

describe("workflow governance", () => {
  let db: Db; let teardown: () => Promise<void>;
  let drafter: Actor; let owner: Actor; let ms: Actor; let dm: Actor;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    await seedSodPairs(db);
    const mk = async (username: string): Promise<Actor> => {
      const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
      return { type: "user", id };
    };
    drafter = await mk("drafter"); owner = await mk("owner1"); ms = await mk("ms1"); dm = await mk("dm1");
    await createRole(db, "owner", "Owner");
    await createRole(db, "medical_superintendent", "Medical Superintendent");
    await createRole(db, "duty_manager", "Duty Manager");
    await assignRole(db, { userId: owner.id, roleKey: "owner", scopeType: "hospital" });
    await assignRole(db, { userId: ms.id, roleKey: "medical_superintendent", scopeType: "hospital" });
    await assignRole(db, { userId: dm.id, roleKey: "duty_manager", scopeType: "hospital" });
  });

  it("class C activates with zero approvals and retires the previous active version", async () => {
    const v1 = await createDraft(db, drafter, DEF_C);
    const first = await activateDefinition(db, owner, v1.definitionId);
    expect(first.retiredVersion).toBeNull();
    const v2 = await createDraft(db, drafter, DEF_C);
    const second = await activateDefinition(db, owner, v2.definitionId);
    expect(second.retiredVersion).toBe(1);
    const rows = await db.select().from(workflowDefinitions);
    expect(rows.find((r) => r.version === 1)!.status).toBe("retired");
    expect(rows.find((r) => r.version === 2)!.status).toBe("active");
    expect(rows.find((r) => r.version === 2)!.activatedBy).toBe(owner.id);
  });

  it("blocks the drafter from activating their own definition (SoD) and events the block", async () => {
    const { definitionId } = await createDraft(db, drafter, DEF_C);
    await expect(activateDefinition(db, drafter, definitionId)).rejects.toThrow(SodViolationError);
    const blocked = await db.select().from(events).where(eq(events.name, "sod.violation_blocked"));
    expect(blocked).toHaveLength(1);
    const row = await db.select().from(workflowDefinitions);
    expect(row[0]!.status).toBe("draft"); // activation rolled back; the block event survived
  });

  it("class A refuses activation until owner AND medical_superintendent both approve", async () => {
    const { definitionId } = await createDraft(db, drafter, DEF_A);
    await expect(activateDefinition(db, owner, definitionId)).rejects.toMatchObject({
      code: "approvals_missing",
    });
    await approveDefinition(db, owner, { definitionId, roleKey: "owner", note: "reviewed" });
    await expect(activateDefinition(db, owner, definitionId)).rejects.toMatchObject({
      code: "approvals_missing",
    });
    await approveDefinition(db, ms, { definitionId, roleKey: "medical_superintendent", note: "reviewed" });
    const { retiredVersion } = await activateDefinition(db, owner, definitionId);
    expect(retiredVersion).toBeNull();
    const emitted = await db.select().from(events).where(eq(events.name, "workflow.definition.updated"));
    // drafted + 2×approved + activated
    expect(emitted).toHaveLength(4);
  });

  it("rejects approvals from users who do not hold the role, or roles outside the class policy", async () => {
    const { definitionId } = await createDraft(db, drafter, DEF_A);
    await expect(
      approveDefinition(db, dm, { definitionId, roleKey: "owner", note: "not mine" }),
    ).rejects.toMatchObject({ code: "approver_lacks_role" });
    await expect(
      approveDefinition(db, dm, { definitionId, roleKey: "duty_manager", note: "wrong class role" }),
    ).rejects.toMatchObject({ code: "role_not_in_policy" });
    await expect(
      approveDefinition(db, { type: "agent", id: "a1" }, { definitionId, roleKey: "owner", note: "no" }),
    ).rejects.toMatchObject({ code: "actor_not_user" });
  });

  it("rejects a second approval by the same user", async () => {
    const { definitionId } = await createDraft(db, drafter, DEF_A);
    await approveDefinition(db, owner, { definitionId, roleKey: "owner", note: "one" });
    await expect(
      approveDefinition(db, owner, { definitionId, roleKey: "owner", note: "two" }),
    ).rejects.toMatchObject({ code: "duplicate_approval" });
  });

  it("emergency path: duty_manager + MS emergency approvals activate AND supersede the drafter SoD (E-5)", async () => {
    const { definitionId } = await createDraft(db, ms, DEF_A); // the MS drafted it themselves
    await approveDefinition(db, dm, { definitionId, roleKey: "duty_manager", note: "owner unreachable", emergency: true });
    await approveDefinition(db, ms, { definitionId, roleKey: "medical_superintendent", note: "owner unreachable", emergency: true });
    // drafter (ms) activates: allowed, because activation proceeds on the emergency set (declared precedence)
    const { retiredVersion } = await activateDefinition(db, ms, definitionId);
    expect(retiredVersion).toBeNull();
    const emitted = await db.select().from(events).where(eq(events.name, "workflow.definition.updated"));
    const activated = emitted.map((e) => e.payload as { action: string; emergency?: boolean }).find((p) => p.action === "activated");
    expect(activated!.emergency).toBe(true);
  });

  it("normal-path approvals do not satisfy the emergency set and vice versa", async () => {
    const { definitionId } = await createDraft(db, drafter, DEF_A);
    await approveDefinition(db, dm, { definitionId, roleKey: "duty_manager", note: "e", emergency: true });
    await approveDefinition(db, owner, { definitionId, roleKey: "owner", note: "n" });
    // one emergency (dm) + one normal (owner): neither set is complete
    await expect(activateDefinition(db, owner, definitionId)).rejects.toMatchObject({
      code: "approvals_missing",
    });
  });

  it("refuses approval and activation on non-draft definitions", async () => {
    const { definitionId } = await createDraft(db, drafter, DEF_C);
    await activateDefinition(db, owner, definitionId);
    await expect(
      approveDefinition(db, owner, { definitionId, roleKey: "owner", note: "late" }),
    ).rejects.toMatchObject({ code: "not_draft" });
    await expect(activateDefinition(db, owner, definitionId)).rejects.toMatchObject({ code: "not_draft" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @hmis/core test -- --testPathPattern "workflow/governance"`
Expected: FAIL — `approveDefinition`, `activateDefinition`, `GovernanceError` not exported.

- [ ] **Step 3: Implement (extend `definitions.ts`)**

Add to the imports of `apps/core/src/kernel/workflow/definitions.ts`:
```ts
import { workflowDefinitionApprovals } from "../db/schema";
import { assertNotSodPair } from "../auth/sod";
import { actorHoldsAnyRole } from "./roles";
```

Append to `apps/core/src/kernel/workflow/definitions.ts`:
```ts
export type ChangeClassPolicy = { requiredRoles: string[]; emergencyRoles: string[] | null };

/**
 * D-15 change classes. Role keys are governance conventions — the roles themselves are
 * deployment data (created via createRole/assignRole); tests create them explicitly.
 * Class A: clinical-safety/money/statutory config — owner + MS two-key; the E-5 emergency
 * path (owner unreachable, D-10) is duty manager + MS, loudly flagged.
 * Class B: operational thresholds within pre-approved bands — department head + duty manager.
 * Class C: routine master-data — automated with sampled audit (zero approvals).
 */
export const CHANGE_CLASS_POLICY: Record<ChangeClass, ChangeClassPolicy> = {
  A: {
    requiredRoles: ["owner", "medical_superintendent"],
    emergencyRoles: ["duty_manager", "medical_superintendent"],
  },
  B: { requiredRoles: ["department_head", "duty_manager"], emergencyRoles: null },
  C: { requiredRoles: [], emergencyRoles: null },
};

export class GovernanceError extends Error {
  constructor(
    readonly code:
      | "actor_not_user"
      | "unknown_definition"
      | "not_draft"
      | "role_not_in_policy"
      | "approver_lacks_role"
      | "duplicate_approval"
      | "approvals_missing",
    message?: string,
  ) {
    super(message ?? `workflow governance refused: ${code}`);
    this.name = "GovernanceError";
  }
}

async function loadDraft(db: Db, definitionId: string): Promise<DefinitionRow> {
  const rows = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, definitionId));
  const row = rows[0];
  if (!row) throw new GovernanceError("unknown_definition");
  if (row.status !== "draft") throw new GovernanceError("not_draft");
  return row;
}

export async function approveDefinition(
  db: Db,
  actor: Actor,
  input: { definitionId: string; roleKey: string; note: string; emergency?: boolean },
): Promise<void> {
  if (actor.type !== "user") throw new GovernanceError("actor_not_user");
  const row = await loadDraft(db, input.definitionId);
  const policy = CHANGE_CLASS_POLICY[row.changeClass as ChangeClass];
  const allowedRoles = input.emergency === true ? policy.emergencyRoles : policy.requiredRoles;
  if (allowedRoles === null || !allowedRoles.includes(input.roleKey)) {
    throw new GovernanceError("role_not_in_policy");
  }
  await withTx(db, async (tx) => {
    if (!(await actorHoldsAnyRole(tx, actor.id, [input.roleKey]))) {
      throw new GovernanceError("approver_lacks_role");
    }
    const existing = await tx
      .select({ id: workflowDefinitionApprovals.id })
      .from(workflowDefinitionApprovals)
      .where(
        and(
          eq(workflowDefinitionApprovals.definitionId, input.definitionId),
          eq(workflowDefinitionApprovals.approverId, actor.id),
        ),
      );
    if (existing.length > 0) throw new GovernanceError("duplicate_approval");
    await tx.insert(workflowDefinitionApprovals).values({
      id: newId(),
      definitionId: input.definitionId,
      approverId: actor.id,
      roleKey: input.roleKey,
      emergency: input.emergency === true,
      note: input.note,
    });
    await appendEvent(
      tx,
      workflowDefinitionUpdated.make({
        actor,
        payload: {
          definitionId: row.id,
          defKey: row.defKey,
          version: row.version,
          changeClass: row.changeClass as ChangeClass,
          action: "approved",
          emergency: input.emergency === true ? true : undefined,
        },
      }),
    );
  });
}

export async function activateDefinition(
  db: Db,
  actor: Actor,
  definitionId: string,
): Promise<{ retiredVersion: number | null }> {
  if (actor.type !== "user") throw new GovernanceError("actor_not_user");
  const row = await loadDraft(db, definitionId);
  const policy = CHANGE_CLASS_POLICY[row.changeClass as ChangeClass];

  const approvals = await db
    .select()
    .from(workflowDefinitionApprovals)
    .where(eq(workflowDefinitionApprovals.definitionId, definitionId));
  const normalRoles = new Set(approvals.filter((a) => !a.emergency).map((a) => a.roleKey));
  const emergencyRoles = new Set(approvals.filter((a) => a.emergency).map((a) => a.roleKey));
  const normalSatisfied = policy.requiredRoles.every((r) => normalRoles.has(r));
  const emergencySatisfied =
    policy.emergencyRoles !== null && policy.emergencyRoles.every((r) => emergencyRoles.has(r));
  if (!normalSatisfied && !emergencySatisfied) {
    const missing = policy.requiredRoles.filter((r) => !normalRoles.has(r));
    throw new GovernanceError("approvals_missing", `missing approvals: ${missing.join(", ")}`);
  }
  const viaEmergency = !normalSatisfied && emergencySatisfied;

  // Drafter ≠ activator (S10 §11 pair, seeded in Plan 02) — EXCEPT on the emergency
  // two-key path, which supersedes this pair by declared precedence (E-5). The drafter
  // actor is reconstructed as a user: agent drafters are the Plan 12 seam.
  if (!viaEmergency) {
    await assertNotSodPair(db, "workflow_drafter_activator", { type: "user", id: row.draftedBy }, actor);
  }

  return withTx(db, async (tx) => {
    const retired = await tx
      .update(workflowDefinitions)
      .set({ status: "retired", retiredAt: new Date() })
      .where(and(eq(workflowDefinitions.defKey, row.defKey), eq(workflowDefinitions.status, "active")))
      .returning({ version: workflowDefinitions.version });
    const retiredVersion = retired[0]?.version ?? null;
    await tx
      .update(workflowDefinitions)
      .set({ status: "active", activatedBy: actor.id, activatedAt: new Date() })
      .where(eq(workflowDefinitions.id, definitionId));
    await appendEvent(
      tx,
      workflowDefinitionUpdated.make({
        actor,
        payload: {
          definitionId: row.id,
          defKey: row.defKey,
          version: row.version,
          changeClass: row.changeClass as ChangeClass,
          action: "activated",
          emergency: viaEmergency ? true : undefined,
          retiredVersion: retiredVersion ?? undefined,
        },
      }),
    );
    return { retiredVersion };
  });
}
```

Note: in-flight instances are untouched by activation — they carry `definitionId` pins (§10.2); proven in Task 6.

- [ ] **Step 4: Run to verify pass, then the full suite**

Run: `pnpm --filter @hmis/core test -- --testPathPattern "workflow/governance"`
Expected: PASS (8 tests).

Run: `pnpm verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/kernel/workflow
git commit -m "feat(workflow): change-class approvals, two-key activation, drafter/activator SoD (D-15, E-5)"
```

---

### Task 6: Instance lifecycle — `startInstance` / `transition` with SLA timers

**Files:**
- Create: `apps/core/src/kernel/workflow/instances.ts`, `apps/core/src/kernel/workflow/timers.ts`
- Test: `apps/core/src/kernel/workflow/instances.test.ts`

**Interfaces:**
- Consumes: T1–T5 exports; `withTx`/`Tx` (Plan 01).
- Produces (exact — T7/T8/T10 and every later domain plan consume these):
  - `type WorkflowSubject = { type: string; id: string; patientId?: string; encounterId?: string }`
  - `class WorkflowError extends Error { readonly code: "unknown_instance" | "instance_not_active" | "no_active_definition" | "unknown_transition" | "role_denied" | "already_on_active_version" | "mapping_incomplete" | "mapping_unknown_state" | "stale_transition" }` (the mapping codes are used by Task 8; `stale_transition` is the loser of a concurrent state move)
  - `startInstance(tx: Tx, defKey: string, subject: WorkflowSubject): Promise<{ instanceId: string; state: string }>` — **runs on the caller's transaction** (domain modules start instances atomically with their own state change, exactly like `appendEvent`); pins the instance to the active definition version; schedules the initial state's SLA timer.
  - `transition(tx: Tx, instanceId: string, to: string, actor: Actor, opts?: { note?: string }): Promise<{ state: string; completed: boolean }>` — validates the transition against the **pinned** definition version; `user` actors must hold an allowed role (T3, any scope); `system` actors bypass; `agent` actors are denied (Plan 12 seam); cancels the instance's open timers, records a `workflow_transitions` history row, schedules the new state's SLA timer, completes the instance on a terminal state. The state move itself is a **conditional single-winner UPDATE** (`status = 'active' AND current_state = <the validated state>` … RETURNING): of two concurrent transitions, exactly one applies — the loser throws `stale_transition`.
  - From `timers.ts`: `scheduleSlaTimer(tx, input: { instanceId: string; state: string; sla: SlaSpec; enteredAt: Date }): Promise<{ timerId: string; dueAt: Date }>` · `scheduleEscalationTimer(tx, input: { instanceId: string; state: string; rung: number; afterMinutes: number; from: Date }): Promise<{ timerId: string; dueAt: Date }>` · `cancelOpenTimers(tx: Tx, instanceId: string): Promise<number>`.
- No event is emitted by start/transition (Global Constraints: no catalog names exist for them; the history table + later domain events with `correlationId` are the record).

- [ ] **Step 1: Write the failing tests**

`apps/core/src/kernel/workflow/instances.test.ts`:
```ts
import { and, eq, isNull } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { startInstance, transition, WorkflowError } from "./instances";
import { createDraft, activateDefinition } from "./definitions";
import { createUser } from "../auth/identity";
import { createRole, assignRole } from "../auth/permissions";
import { seedSodPairs } from "../auth/sod";
import { workflowInstances, workflowTransitions, workflowTimers } from "../db/schema";
import { withTx } from "../db/client";
import type { Db } from "../db/client";
import type { Actor } from "@hmis/contracts";

const DEF_V1 = {
  key: "test_flow",
  title: "Test Flow v1",
  changeClass: "C",
  initialState: "open",
  states: [
    { name: "open", sla: { minutes: 30, alerting: "active", escalation: [{ afterMinutes: 10, toRole: "duty_manager" }] } },
    { name: "in_progress", sla: { minutes: 60, alerting: "record_only" } },
    { name: "done", terminal: true },
  ],
  transitions: [
    { from: "open", to: "in_progress", roles: ["nurse"] },
    { from: "in_progress", to: "done", roles: ["doctor"] },
  ],
};

describe("workflow instances", () => {
  let db: Db; let teardown: () => Promise<void>;
  let admin: Actor; let nurse: Actor; let doctor: Actor;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    await seedSodPairs(db);
    const mk = async (username: string): Promise<Actor> => {
      const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
      return { type: "user", id };
    };
    admin = await mk("admin1"); nurse = await mk("nurse1"); doctor = await mk("doc1");
    await createRole(db, "nurse", "Nurse");
    await createRole(db, "doctor", "Doctor");
    await assignRole(db, { userId: nurse.id, roleKey: "nurse", scopeType: "department", scopeId: "opd" });
    await assignRole(db, { userId: doctor.id, roleKey: "doctor", scopeType: "hospital" });
    const { definitionId } = await createDraft(db, { type: "user", id: "01HDRAFTER000000000000000" }, DEF_V1);
    await activateDefinition(db, admin, definitionId);
  });

  async function start(): Promise<string> {
    const { instanceId, state } = await withTx(db, (tx) =>
      startInstance(tx, "test_flow", { type: "test_subject", id: "s1", patientId: "01HPAT000000000000000000A" }),
    );
    expect(state).toBe("open");
    return instanceId;
  }

  it("starts an instance pinned to the active version with the initial SLA timer", async () => {
    const instanceId = await start();
    const [instance] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId));
    expect(instance!.currentState).toBe("open");
    expect(instance!.status).toBe("active");
    expect(instance!.patientId).toBe("01HPAT000000000000000000A");
    const timers = await db.select().from(workflowTimers).where(eq(workflowTimers.instanceId, instanceId));
    expect(timers).toHaveLength(1);
    expect(timers[0]!.kind).toBe("sla");
    expect(timers[0]!.state).toBe("open");
    // dueAt = stateEnteredAt + 30 min
    expect(timers[0]!.dueAt.getTime()).toBe(instance!.stateEnteredAt.getTime() + 30 * 60_000);
  });

  it("throws no_active_definition for an unknown key", async () => {
    await expect(
      withTx(db, (tx) => startInstance(tx, "missing_flow", { type: "t", id: "s" })),
    ).rejects.toMatchObject({ code: "no_active_definition" });
  });

  it("transitions with an allowed role: history row, timer swap, state move", async () => {
    const instanceId = await start();
    const result = await withTx(db, (tx) => transition(tx, instanceId, "in_progress", nurse));
    expect(result).toEqual({ state: "in_progress", completed: false });
    const [instance] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId));
    expect(instance!.currentState).toBe("in_progress");
    const history = await db.select().from(workflowTransitions).where(eq(workflowTransitions.instanceId, instanceId));
    expect(history).toHaveLength(1);
    expect(history[0]!).toMatchObject({ fromState: "open", toState: "in_progress", actorType: "user", actorId: nurse.id });
    const open = await db.select().from(workflowTimers).where(
      and(eq(workflowTimers.instanceId, instanceId), isNull(workflowTimers.firedAt), isNull(workflowTimers.cancelledAt)),
    );
    expect(open).toHaveLength(1); // old timer cancelled, exactly one new SLA timer
    expect(open[0]!.state).toBe("in_progress");
  });

  it("denies a user without an allowed role, an agent, and an undeclared transition", async () => {
    const instanceId = await start();
    await expect(
      withTx(db, (tx) => transition(tx, instanceId, "in_progress", doctor)),
    ).rejects.toMatchObject({ code: "role_denied" });
    await expect(
      withTx(db, (tx) => transition(tx, instanceId, "in_progress", { type: "agent", id: "a1" })),
    ).rejects.toMatchObject({ code: "role_denied" });
    await expect(
      withTx(db, (tx) => transition(tx, instanceId, "done", nurse)), // open→done is not declared
    ).rejects.toMatchObject({ code: "unknown_transition" });
  });

  it("a system actor bypasses the role check (automated moves)", async () => {
    const instanceId = await start();
    const result = await withTx(db, (tx) =>
      transition(tx, instanceId, "in_progress", { type: "system", id: "test-automation" }),
    );
    expect(result.state).toBe("in_progress");
  });

  it("terminal transition completes the instance, cancels timers, schedules nothing", async () => {
    const instanceId = await start();
    await withTx(db, (tx) => transition(tx, instanceId, "in_progress", nurse));
    const result = await withTx(db, (tx) => transition(tx, instanceId, "done", doctor));
    expect(result).toEqual({ state: "done", completed: true });
    const [instance] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId));
    expect(instance!.status).toBe("completed");
    expect(instance!.endedAt).not.toBeNull();
    const open = await db.select().from(workflowTimers).where(
      and(eq(workflowTimers.instanceId, instanceId), isNull(workflowTimers.firedAt), isNull(workflowTimers.cancelledAt)),
    );
    expect(open).toHaveLength(0);
    await expect(
      withTx(db, (tx) => transition(tx, instanceId, "in_progress", nurse)),
    ).rejects.toMatchObject({ code: "instance_not_active" });
  });

  it("an in-flight instance keeps running on its pinned version after a new version activates (§10.2)", async () => {
    const instanceId = await start();
    // v2 renames the middle state — an instance on v1 must still follow v1's transitions
    const V2 = {
      ...DEF_V1,
      title: "Test Flow v2",
      states: [
        { name: "open", sla: { minutes: 5, alerting: "record_only" } },
        { name: "triaged", sla: { minutes: 5, alerting: "record_only" } },
        { name: "done", terminal: true },
      ],
      transitions: [
        { from: "open", to: "triaged", roles: ["nurse"] },
        { from: "triaged", to: "done", roles: ["doctor"] },
      ],
    };
    const { definitionId } = await createDraft(db, { type: "user", id: "01HDRAFTER000000000000000" }, V2);
    await activateDefinition(db, admin, definitionId);
    const result = await withTx(db, (tx) => transition(tx, instanceId, "in_progress", nurse));
    expect(result.state).toBe("in_progress"); // v1 transition still valid for this instance
    await expect(
      withTx(db, (tx) => transition(tx, instanceId, "triaged", nurse)), // v2 state — unknown to v1
    ).rejects.toMatchObject({ code: "unknown_transition" });
  });

  it("rolls back atomically with the caller's transaction", async () => {
    const before = await db.select().from(workflowInstances);
    await expect(
      withTx(db, async (tx) => {
        await startInstance(tx, "test_flow", { type: "t", id: "s2" });
        throw new Error("caller rollback");
      }),
    ).rejects.toThrow("caller rollback");
    const after = await db.select().from(workflowInstances);
    expect(after).toHaveLength(before.length); // no instance, and (by FK) no timer survived
  });

  it("exactly one of two concurrent transitions of the same instance applies (single-winner)", async () => {
    const instanceId = await start();
    const attempt = (): Promise<{ state: string; completed: boolean }> =>
      withTx(db, (tx) => transition(tx, instanceId, "in_progress", nurse));
    const results = await Promise.allSettled([attempt(), attempt()]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // The loser fails as stale_transition (raced the conditional UPDATE) or
    // unknown_transition (its read ran after the winner committed) — both are
    // WorkflowError, and the assertions below prove only ONE move applied either way.
    expect(rejected[0]!.reason).toBeInstanceOf(WorkflowError);
    const history = await db.select().from(workflowTransitions).where(eq(workflowTransitions.instanceId, instanceId));
    expect(history).toHaveLength(1);
    const [instance] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId));
    expect(instance!.currentState).toBe("in_progress");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @hmis/core test -- --testPathPattern "workflow/instances"`
Expected: FAIL — `./instances` not found.

- [ ] **Step 3: Implement the timer primitives**

`apps/core/src/kernel/workflow/timers.ts`:
```ts
import { and, eq, isNull } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { workflowTimers } from "../db/schema";
import type { SlaSpec } from "./definition";
import type { Tx } from "../db/client";

// Timers are ROWS, never processes (roadmap trap: survive restarts; no setTimeout).
// Nothing here schedules execution — runDueTimers (Task 7) is invoked by tests now
// and by Plan 11's pg-boss cron later.

export async function scheduleSlaTimer(
  tx: Tx,
  input: { instanceId: string; state: string; sla: SlaSpec; enteredAt: Date },
): Promise<{ timerId: string; dueAt: Date }> {
  const timerId = newId();
  const dueAt = new Date(input.enteredAt.getTime() + input.sla.minutes * 60_000);
  await tx.insert(workflowTimers).values({
    id: timerId,
    instanceId: input.instanceId,
    state: input.state,
    kind: "sla",
    dueAt,
  });
  return { timerId, dueAt };
}

export async function scheduleEscalationTimer(
  tx: Tx,
  input: { instanceId: string; state: string; rung: number; afterMinutes: number; from: Date },
): Promise<{ timerId: string; dueAt: Date }> {
  const timerId = newId();
  const dueAt = new Date(input.from.getTime() + input.afterMinutes * 60_000);
  await tx.insert(workflowTimers).values({
    id: timerId,
    instanceId: input.instanceId,
    state: input.state,
    kind: "escalation",
    rung: input.rung,
    dueAt,
  });
  return { timerId, dueAt };
}

/** Cancels every open (unfired, uncancelled) timer of an instance. Returns the count. */
export async function cancelOpenTimers(tx: Tx, instanceId: string): Promise<number> {
  const rows = await tx
    .update(workflowTimers)
    .set({ cancelledAt: new Date() })
    .where(
      and(
        eq(workflowTimers.instanceId, instanceId),
        isNull(workflowTimers.firedAt),
        isNull(workflowTimers.cancelledAt),
      ),
    )
    .returning({ id: workflowTimers.id });
  return rows.length;
}
```

- [ ] **Step 4: Implement the instance lifecycle**

`apps/core/src/kernel/workflow/instances.ts`:
```ts
import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { workflowDefinitions, workflowInstances, workflowTransitions } from "../db/schema";
import { getActiveDefinition } from "./definitions";
import { parseDefinition } from "./definition";
import { actorHoldsAnyRole } from "./roles";
import { scheduleSlaTimer, cancelOpenTimers } from "./timers";
import type { Tx } from "../db/client";

export type WorkflowSubject = { type: string; id: string; patientId?: string; encounterId?: string };

export class WorkflowError extends Error {
  constructor(
    readonly code:
      | "unknown_instance"
      | "instance_not_active"
      | "no_active_definition"
      | "unknown_transition"
      | "role_denied"
      | "already_on_active_version"
      | "mapping_incomplete"
      | "mapping_unknown_state"
      | "stale_transition",
    message?: string,
  ) {
    super(message ?? `workflow engine refused: ${code}`);
    this.name = "WorkflowError";
  }
}

/**
 * Starts an instance of the ACTIVE definition version on the CALLER's transaction —
 * domain modules start workflows atomically with their own state change, the same
 * pattern as appendEvent. The instance is pinned to the definition version (§10.2).
 */
export async function startInstance(
  tx: Tx,
  defKey: string,
  subject: WorkflowSubject,
): Promise<{ instanceId: string; state: string }> {
  const active = await getActiveDefinition(tx, defKey);
  if (!active) throw new WorkflowError("no_active_definition", `no active definition for "${defKey}"`);
  const instanceId = newId();
  const now = new Date();
  const initial = active.parsed.initialState;
  await tx.insert(workflowInstances).values({
    id: instanceId,
    definitionId: active.id,
    defKey,
    currentState: initial,
    subjectType: subject.type,
    subjectId: subject.id,
    patientId: subject.patientId,
    encounterId: subject.encounterId,
    stateEnteredAt: now,
  });
  // initialState is never terminal (defineWorkflow rule), so it always carries an SLA.
  const initialSpec = active.parsed.states.find((s) => s.name === initial)!;
  await scheduleSlaTimer(tx, { instanceId, state: initial, sla: initialSpec.sla!, enteredAt: now });
  return { instanceId, state: initial };
}

/**
 * Moves an instance along a declared transition of its PINNED definition version.
 * §10.2: humans and agents run the same definitions — user actors must hold one of the
 * transition's allowed roles (any scope; org-master scoping is the marked seam);
 * system actors are the application's own automated moves and bypass the role check;
 * agent actors are denied until Plan 12's agent grants (same seam as PermissionGuard).
 */
export async function transition(
  tx: Tx,
  instanceId: string,
  to: string,
  actor: Actor,
  opts: { note?: string } = {},
): Promise<{ state: string; completed: boolean }> {
  const rows = await tx.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId));
  const instance = rows[0];
  if (!instance) throw new WorkflowError("unknown_instance");
  if (instance.status !== "active") throw new WorkflowError("instance_not_active");

  const defRows = await tx
    .select()
    .from(workflowDefinitions)
    .where(eq(workflowDefinitions.id, instance.definitionId));
  const def = parseDefinition(defRows[0]!.definition); // pinned version — never the newest

  const declared = def.transitions.find((t) => t.from === instance.currentState && t.to === to);
  if (!declared) {
    throw new WorkflowError("unknown_transition", `no transition ${instance.currentState}→${to} in ${instance.defKey} (pinned version)`);
  }

  if (actor.type === "user") {
    if (!(await actorHoldsAnyRole(tx, actor.id, declared.roles))) {
      throw new WorkflowError("role_denied", `transition ${instance.currentState}→${to} allows roles: ${declared.roles.join(", ")}`);
    }
  } else if (actor.type === "agent") {
    throw new WorkflowError("role_denied", "agent transitions arrive with Plan 12's agent grants");
  }

  const now = new Date();
  const target = def.states.find((s) => s.name === to)!;
  const completed = target.terminal === true;

  // Single-winner state move: conditional on the exact state we validated against, so
  // two concurrent transitions cannot both apply (multi-process-safe, no optimistic-
  // locking column needed). The UPDATE comes before any other write so the loser fails
  // fast and rolls back nothing.
  const updated = await tx
    .update(workflowInstances)
    .set({
      currentState: to,
      stateEnteredAt: now,
      status: completed ? "completed" : "active",
      endedAt: completed ? now : null,
    })
    .where(
      and(
        eq(workflowInstances.id, instanceId),
        eq(workflowInstances.status, "active"),
        eq(workflowInstances.currentState, instance.currentState),
      ),
    )
    .returning({ id: workflowInstances.id });
  if (updated.length === 0) {
    throw new WorkflowError("stale_transition", `instance ${instanceId} was moved concurrently`);
  }

  await cancelOpenTimers(tx, instanceId);
  await tx.insert(workflowTransitions).values({
    id: newId(),
    instanceId,
    fromState: instance.currentState,
    toState: to,
    actorType: actor.type,
    actorId: actor.id,
    note: opts.note,
  });
  if (!completed && target.sla) {
    await scheduleSlaTimer(tx, { instanceId, state: to, sla: target.sla, enteredAt: now });
  }
  return { state: to, completed };
}
```

- [ ] **Step 5: Run to verify pass, then the full suite**

Run: `pnpm --filter @hmis/core test -- --testPathPattern "workflow/instances"`
Expected: PASS (9 tests).

Run: `pnpm verify`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/core/src/kernel/workflow
git commit -m "feat(workflow): instance lifecycle — startInstance/transition with SLA timer swap, version pinning"
```

---

### Task 7: `runDueTimers` — `sla.breached` + escalation ladder with duty-manager fallback

**Files:**
- Modify: `apps/core/src/kernel/workflow/timers.ts` (extend — Task 6's primitives stay byte-identical)
- Test: `apps/core/src/kernel/workflow/timers.test.ts`

**Interfaces:**
- Consumes: T2 events, T3 `usersHoldingRole`, T6 primitives + tables, `appendEvent`/`withTx`.
- Produces (exact — Plan 11 registers this as a pg-boss cron; tests and T10's e2e call it directly):
  - `const DUTY_MANAGER_ROLE = "duty_manager"` — the fix-11 fallback role key.
  - `runDueTimers(db: Db, now?: Date): Promise<number>` — fires every due, unfired, uncancelled timer; returns the count fired. **Idempotent** (a fired timer never fires again) and **multi-process-safe**: each timer is claimed with a conditional `UPDATE … RETURNING` in its own transaction before any event is emitted.
- Semantics (documented in code):
  - An `sla` timer firing emits `sla.breached` (envelope: `correlationId` = instance id, `patientId`/`encounterId` from the instance, actor `{ type: "system", id: "workflow-timer" }`). If `alerting === "active"` and the state declares a ladder, rung 0 is scheduled at `dueAt + ladder[0].afterMinutes`.
  - An `escalation` timer firing resolves its rung's `toRole` to static holders (T3). Empty → resolve `duty_manager` with `fallback: true`; still empty → `fallbackExhausted: true` (owner SMS is Plan 10's half of fix 11). Emits `escalation.triggered`, then schedules rung n+1 (if any) at **this rung's `dueAt` + next `afterMinutes`** — anchoring on `dueAt`, not wall clock, keeps the ladder cadence correct even when the ticker runs late.
  - One call fires one rung per chain; repeated calls drain a backlog (the e2e and Plan 11's cron both call repeatedly).
  - `record_only` states breach loudly in the log but never escalate (§10.3: structure everywhere, alerts selective).

- [ ] **Step 1: Write the failing tests**

`apps/core/src/kernel/workflow/timers.test.ts` — note that `transition` is a **static** top-level import; a dynamic `await import("./instances")` would pass jest and fail `pnpm typecheck` with TS2835 (EXECUTION-LESSONS §3.7):

```ts
import { and, eq, isNull } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { runDueTimers, DUTY_MANAGER_ROLE } from "./timers";
import { startInstance, transition } from "./instances";
import { createDraft, activateDefinition } from "./definitions";
import { createUser } from "../auth/identity";
import { createRole, assignRole } from "../auth/permissions";
import { seedSodPairs } from "../auth/sod";
import { events, workflowTimers } from "../db/schema";
import { withTx } from "../db/client";
import type { Db } from "../db/client";
import type { Actor } from "@hmis/contracts";

const DEF = {
  key: "timer_flow",
  title: "Timer Flow",
  changeClass: "C",
  initialState: "waiting",
  states: [
    {
      name: "waiting",
      sla: {
        minutes: 30,
        alerting: "active",
        escalation: [
          { afterMinutes: 10, toRole: "supervisor" },
          { afterMinutes: 20, toRole: "department_head" },
        ],
      },
    },
    { name: "quiet", sla: { minutes: 15, alerting: "record_only" } },
    { name: "done", terminal: true },
  ],
  transitions: [
    { from: "waiting", to: "quiet", roles: ["nurse"] },
    { from: "waiting", to: "done", roles: ["nurse"] },
    { from: "quiet", to: "done", roles: ["nurse"] },
  ],
};

const SYSTEM: Actor = { type: "system", id: "test-automation" };

describe("runDueTimers", () => {
  let db: Db; let teardown: () => Promise<void>;
  let admin: Actor;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    await seedSodPairs(db);
    const { id } = await createUser(db, { username: "admin1", fullName: "A", password: "p1234567" });
    admin = { type: "user", id };
    const { definitionId } = await createDraft(db, { type: "user", id: "01HDRAFTER000000000000000" }, DEF);
    await activateDefinition(db, admin, definitionId);
  });

  async function startBreached(): Promise<string> {
    const { instanceId } = await withTx(db, (tx) =>
      startInstance(tx, "timer_flow", { type: "t", id: "s1", patientId: "01HPAT000000000000000000A" }),
    );
    await db.update(workflowTimers)
      .set({ dueAt: new Date(Date.now() - 60_000) })
      .where(eq(workflowTimers.instanceId, instanceId));
    return instanceId;
  }

  async function openTimersOf(instanceId: string) {
    return db.select().from(workflowTimers).where(
      and(
        eq(workflowTimers.instanceId, instanceId),
        isNull(workflowTimers.firedAt),
        isNull(workflowTimers.cancelledAt),
      ),
    );
  }

  it("fires a due SLA timer once: sla.breached with the full envelope, then idempotent", async () => {
    const instanceId = await startBreached();
    expect(await runDueTimers(db)).toBe(1);
    expect(await runDueTimers(db)).toBe(0); // idempotent
    const breached = await db.select().from(events).where(eq(events.name, "sla.breached"));
    expect(breached).toHaveLength(1);
    expect(breached[0]!.correlationId).toBe(instanceId);
    expect(breached[0]!.patientId).toBe("01HPAT000000000000000000A");
    expect(breached[0]!.actorType).toBe("system");
    const payload = breached[0]!.payload as { state: string; alerting: string; slaMinutes: number };
    expect(payload).toMatchObject({ state: "waiting", alerting: "active", slaMinutes: 30 });
  });

  it("schedules escalation rung 0 after an active-alerting breach, anchored on dueAt", async () => {
    const instanceId = await startBreached();
    const [slaTimer] = await db.select().from(workflowTimers).where(eq(workflowTimers.instanceId, instanceId));
    await runDueTimers(db);
    const escalations = await db.select().from(workflowTimers).where(
      and(eq(workflowTimers.instanceId, instanceId), eq(workflowTimers.kind, "escalation")),
    );
    expect(escalations).toHaveLength(1);
    expect(escalations[0]!.rung).toBe(0);
    expect(escalations[0]!.dueAt.getTime()).toBe(slaTimer!.dueAt.getTime() + 10 * 60_000);
  });

  it("a record_only breach emits the event but never escalates (§10.3)", async () => {
    const { instanceId } = await withTx(db, (tx) => startInstance(tx, "timer_flow", { type: "t", id: "s2" }));
    await withTx(db, (tx) => transition(tx, instanceId, "quiet", SYSTEM));
    await db.update(workflowTimers)
      .set({ dueAt: new Date(Date.now() - 60_000) })
      .where(and(eq(workflowTimers.instanceId, instanceId), isNull(workflowTimers.cancelledAt)));
    expect(await runDueTimers(db)).toBe(1);
    const breached = await db.select().from(events).where(eq(events.name, "sla.breached"));
    expect(breached).toHaveLength(1);
    expect(await openTimersOf(instanceId)).toHaveLength(0); // no escalation scheduled
  });

  it("escalation resolves static role holders; ladder climbs rung by rung across calls", async () => {
    const { id: sup } = await createUser(db, { username: "sup1", fullName: "S", password: "p1234567" });
    await createRole(db, "supervisor", "Supervisor");
    await createRole(db, "department_head", "Department Head");
    await assignRole(db, { userId: sup, roleKey: "supervisor", scopeType: "hospital" });
    const instanceId = await startBreached();
    await runDueTimers(db); // fires SLA breach, schedules rung 0
    await db.update(workflowTimers)
      .set({ dueAt: new Date(Date.now() - 1000) })
      .where(and(eq(workflowTimers.instanceId, instanceId), eq(workflowTimers.kind, "escalation")));
    expect(await runDueTimers(db)).toBe(1); // fires rung 0, schedules rung 1
    let escalated = await db.select().from(events).where(eq(events.name, "escalation.triggered"));
    expect(escalated).toHaveLength(1);
    expect(escalated[0]!.payload as object).toMatchObject({
      rung: 0, role: "supervisor", resolvedUserIds: [sup], fallback: false, fallbackExhausted: false,
    });
    await db.update(workflowTimers)
      .set({ dueAt: new Date(Date.now() - 1000) })
      .where(and(eq(workflowTimers.instanceId, instanceId), eq(workflowTimers.kind, "escalation"), isNull(workflowTimers.firedAt)));
    expect(await runDueTimers(db)).toBe(1); // fires rung 1 (department_head — empty role)
    escalated = await db.select().from(events).where(eq(events.name, "escalation.triggered"));
    expect(escalated).toHaveLength(2);
    // rung 1: department_head has no holders and duty_manager doesn't exist either → exhausted
    expect(escalated[1]!.payload as object).toMatchObject({
      rung: 1, role: "department_head", resolvedUserIds: [], fallback: true, fallbackExhausted: true,
    });
    expect(await openTimersOf(instanceId)).toHaveLength(0); // ladder exhausted, nothing further
  });

  it("falls back to duty_manager holders when a rung's role is empty (fix 11)", async () => {
    const { id: dm } = await createUser(db, { username: "dm1", fullName: "D", password: "p1234567" });
    await createRole(db, DUTY_MANAGER_ROLE, "Duty Manager");
    await assignRole(db, { userId: dm, roleKey: DUTY_MANAGER_ROLE, scopeType: "hospital" });
    // 'supervisor' role never created — rung 0 resolves empty and falls back
    const instanceId = await startBreached();
    await runDueTimers(db);
    await db.update(workflowTimers)
      .set({ dueAt: new Date(Date.now() - 1000) })
      .where(and(eq(workflowTimers.instanceId, instanceId), eq(workflowTimers.kind, "escalation")));
    await runDueTimers(db);
    const escalated = await db.select().from(events).where(eq(events.name, "escalation.triggered"));
    expect(escalated[0]!.payload as object).toMatchObject({
      role: "supervisor", resolvedUserIds: [dm], fallback: true, fallbackExhausted: false,
    });
  });

  it("cancelled timers never fire; a manually-claimed timer is skipped (claim semantics)", async () => {
    const instanceId = await startBreached();
    await withTx(db, (tx) => transition(tx, instanceId, "done", SYSTEM)); // cancels the backdated timer
    expect(await runDueTimers(db)).toBe(0);
    const instanceId2 = await startBreached();
    await db.update(workflowTimers)
      .set({ firedAt: new Date() }) // simulate another process having claimed it
      .where(eq(workflowTimers.instanceId, instanceId2));
    expect(await runDueTimers(db)).toBe(0);
    expect(await db.select().from(events).where(eq(events.name, "sla.breached"))).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @hmis/core test -- --testPathPattern "workflow/timers"`
Expected: FAIL — `runDueTimers` and `DUTY_MANAGER_ROLE` not exported.

- [ ] **Step 3: Implement (extend `timers.ts`)**

Add to the imports of `apps/core/src/kernel/workflow/timers.ts`:
```ts
import { asc, lte } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { workflowDefinitions, workflowInstances } from "../db/schema";
import { appendEvent } from "../events/append";
import { withTx } from "../db/client";
import { parseDefinition } from "./definition";
import { usersHoldingRole } from "./roles";
import { slaBreached, escalationTriggered } from "./events";
import type { Db } from "../db/client";
```

Append to `apps/core/src/kernel/workflow/timers.ts`:
```ts
/** §11.19-C fix 11: a ladder never dead-ends silently — duty manager catches empty rungs. */
export const DUTY_MANAGER_ROLE = "duty_manager";

const TIMER_ACTOR: Actor = { type: "system", id: "workflow-timer" };

/**
 * Fires every due, unfired, uncancelled timer. Deliberately UNSCHEDULED (owner decision
 * 2026-08-12, option (b)) — Plan 11 registers this as a pg-boss cron in the worker
 * process, alongside runDispatchCycle and sweepExpiredTempRoles. Idempotent and
 * multi-process-safe: each timer is claimed with a conditional UPDATE…RETURNING in its
 * own transaction before anything is emitted; two concurrent callers cannot double-fire.
 * One call fires one rung per escalation chain; repeated calls drain a backlog.
 */
export async function runDueTimers(db: Db, now: Date = new Date()): Promise<number> {
  const due = await db
    .select({ id: workflowTimers.id })
    .from(workflowTimers)
    .where(and(lte(workflowTimers.dueAt, now), isNull(workflowTimers.firedAt), isNull(workflowTimers.cancelledAt)))
    .orderBy(asc(workflowTimers.dueAt));

  let fired = 0;
  for (const { id } of due) {
    const didFire = await withTx(db, async (tx) => {
      const claimed = await tx
        .update(workflowTimers)
        .set({ firedAt: now })
        .where(and(eq(workflowTimers.id, id), isNull(workflowTimers.firedAt), isNull(workflowTimers.cancelledAt)))
        .returning();
      const timer = claimed[0];
      if (!timer) return false; // cancelled or claimed by another process since the scan

      const instRows = await tx.select().from(workflowInstances).where(eq(workflowInstances.id, timer.instanceId));
      const instance = instRows[0]!;
      const defRows = await tx.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, instance.definitionId));
      const defRow = defRows[0]!;
      const def = parseDefinition(defRow.definition);
      const state = def.states.find((s) => s.name === timer.state)!;
      const sla = state.sla!; // timers only exist for SLA-carrying states
      const ladder = sla.escalation ?? [];
      const envelope = {
        actor: TIMER_ACTOR,
        correlationId: instance.id,
        patientId: instance.patientId ?? undefined,
        encounterId: instance.encounterId ?? undefined,
      };

      if (timer.kind === "sla") {
        await appendEvent(
          tx,
          slaBreached.make({
            ...envelope,
            payload: {
              instanceId: instance.id,
              defKey: instance.defKey,
              definitionVersion: defRow.version,
              state: timer.state,
              slaMinutes: sla.minutes,
              alerting: sla.alerting,
              dueAt: timer.dueAt.toISOString(),
            },
          }),
        );
        // §10.3: every breach is recorded; only active-alerting states escalate.
        if (sla.alerting === "active" && ladder.length > 0) {
          await scheduleEscalationTimer(tx, {
            instanceId: instance.id,
            state: timer.state,
            rung: 0,
            afterMinutes: ladder[0]!.afterMinutes,
            from: timer.dueAt, // anchor on dueAt, not wall clock: late ticks don't skew the ladder
          });
        }
      } else {
        const rung = timer.rung!;
        const rungSpec = ladder[rung]!;
        let resolvedUserIds = await usersHoldingRole(tx, rungSpec.toRole);
        let fallback = false;
        let fallbackExhausted = false;
        if (resolvedUserIds.length === 0) {
          fallback = true;
          resolvedUserIds = await usersHoldingRole(tx, DUTY_MANAGER_ROLE);
          fallbackExhausted = resolvedUserIds.length === 0; // owner SMS: Plan 10's half of fix 11
        }
        await appendEvent(
          tx,
          escalationTriggered.make({
            ...envelope,
            payload: {
              instanceId: instance.id,
              defKey: instance.defKey,
              state: timer.state,
              rung,
              role: rungSpec.toRole,
              resolvedUserIds,
              fallback,
              fallbackExhausted,
            },
          }),
        );
        const next = ladder[rung + 1];
        if (next) {
          await scheduleEscalationTimer(tx, {
            instanceId: instance.id,
            state: timer.state,
            rung: rung + 1,
            afterMinutes: next.afterMinutes,
            from: timer.dueAt,
          });
        }
      }
      return true;
    });
    if (didFire) fired += 1;
  }
  return fired;
}
```

- [ ] **Step 4: Run to verify pass, then the full suite**

Run: `pnpm --filter @hmis/core test -- --testPathPattern "workflow/timers"`
Expected: PASS (6 tests).

Run: `pnpm verify`
Expected: PASS.

Run: `grep -rn "setTimeout\|setInterval\|pgboss\|node-cron" apps/core/src/kernel/workflow || echo CLEAN`
Expected: `CLEAN`. (Comments deliberately say "pg-boss cron" to document the Plan 11 seam — this grep does not match them; it matches scheduling *code*, and zero scheduling code is the acceptance point.)

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/kernel/workflow
git commit -m "feat(workflow): runDueTimers — sla.breached + escalation ladder with duty-manager fallback (fix 11)"
```

---

### Task 8: In-flight remediation — `migrateInstance` / `abortInstance` (D-11)

**Files:**
- Create: `apps/core/src/kernel/workflow/remediation.ts`
- Test: `apps/core/src/kernel/workflow/remediation.test.ts`

**Interfaces:**
- Consumes: T2 events/tables, T4 `getActiveDefinition`, T6 `WorkflowError` + timer primitives, `appendEvent`/`withTx`.
- Produces (exact — T10's controller consumes these):
  - `migrateInstance(db: Db, actor: Actor, input: { instanceId: string; stateMapping: Record<string, string>; reason: string }): Promise<{ toDefinitionId: string; toVersion: number; state: string }>` — moves an **active** instance from its pinned version to the **currently-active** version of the same `defKey`, at the state `stateMapping[currentState]`; every mapping target must exist in the target version; open timers are cancelled and the mapped state's SLA timer is scheduled (a terminal mapping completes the instance); emits `instance.migrated`.
  - `abortInstance(db: Db, actor: Actor, input: { instanceId: string; reason: string }): Promise<void>` — active → `aborted`, `endedAt` set, open timers cancelled; emits `instance.aborted`.
- **Approval gating (D-11) in this plan** = the `workflow.instances.remediate` permission at the route (T10) + the mandatory `reason` recorded in the event. Routing remediation through the approvals engine is the **marked Plan 04 seam** — stated here so the gate does not fail the task for "missing approvals."
- Both ops apply their instance update as a **conditional single-winner UPDATE** (same guarantee as T6's `transition`): a concurrently-moved instance loses with `stale_transition` (migrate, whose mapping depends on the current state) or `instance_not_active` (abort) instead of silently overwriting.

- [ ] **Step 1: Write the failing tests**

`apps/core/src/kernel/workflow/remediation.test.ts`:
```ts
import { and, eq, isNull } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { migrateInstance, abortInstance } from "./remediation";
import { startInstance } from "./instances";
import { createDraft, activateDefinition } from "./definitions";
import { createUser } from "../auth/identity";
import { seedSodPairs } from "../auth/sod";
import { events, workflowInstances, workflowTimers } from "../db/schema";
import { withTx } from "../db/client";
import type { Db } from "../db/client";
import type { Actor } from "@hmis/contracts";

const V1 = {
  key: "mig_flow",
  title: "Mig Flow v1",
  changeClass: "C",
  initialState: "open",
  states: [
    { name: "open", sla: { minutes: 30, alerting: "record_only" } },
    { name: "done", terminal: true },
  ],
  transitions: [{ from: "open", to: "done", roles: ["nurse"] }],
};
const V2 = {
  ...V1,
  title: "Mig Flow v2",
  states: [
    { name: "received", sla: { minutes: 10, alerting: "record_only" } },
    { name: "done", terminal: true },
  ],
  transitions: [{ from: "received", to: "done", roles: ["nurse"] }],
};

describe("workflow remediation", () => {
  let db: Db; let teardown: () => Promise<void>;
  let admin: Actor; let remediator: Actor;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    await seedSodPairs(db);
    const mk = async (username: string): Promise<Actor> => {
      const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
      return { type: "user", id };
    };
    admin = await mk("admin1");
    remediator = await mk("rem1");
    const v1 = await createDraft(db, { type: "user", id: "01HDRAFTER000000000000000" }, V1);
    await activateDefinition(db, admin, v1.definitionId);
  });

  async function startOnV1(): Promise<string> {
    const { instanceId } = await withTx(db, (tx) =>
      startInstance(tx, "mig_flow", { type: "t", id: "s1", patientId: "01HPAT000000000000000000A" }),
    );
    return instanceId;
  }

  async function activateV2(): Promise<void> {
    const v2 = await createDraft(db, { type: "user", id: "01HDRAFTER000000000000000" }, V2);
    await activateDefinition(db, admin, v2.definitionId);
  }

  it("migrates an active instance to the active version at the mapped state, with fresh timers", async () => {
    const instanceId = await startOnV1();
    await activateV2();
    const result = await migrateInstance(db, remediator, {
      instanceId, stateMapping: { open: "received" }, reason: "definition fix",
    });
    expect(result.toVersion).toBe(2);
    expect(result.state).toBe("received");
    const [instance] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId));
    expect(instance!.definitionId).toBe(result.toDefinitionId);
    expect(instance!.currentState).toBe("received");
    const open = await db.select().from(workflowTimers).where(
      and(eq(workflowTimers.instanceId, instanceId), isNull(workflowTimers.firedAt), isNull(workflowTimers.cancelledAt)),
    );
    expect(open).toHaveLength(1);
    expect(open[0]!.state).toBe("received");
    expect(open[0]!.dueAt.getTime()).toBe(instance!.stateEnteredAt.getTime() + 10 * 60_000); // v2's 10-min SLA
    const migrated = await db.select().from(events).where(eq(events.name, "instance.migrated"));
    expect(migrated).toHaveLength(1);
    expect(migrated[0]!.correlationId).toBe(instanceId);
    expect(migrated[0]!.payload as object).toMatchObject({
      fromVersion: 1, toVersion: 2, fromState: "open", toState: "received", reason: "definition fix",
    });
  });

  it("refuses migration when already on the active version, or when the mapping is unusable", async () => {
    const instanceId = await startOnV1();
    await expect(
      migrateInstance(db, remediator, { instanceId, stateMapping: { open: "open" }, reason: "r" }),
    ).rejects.toMatchObject({ code: "already_on_active_version" });
    await activateV2();
    await expect(
      migrateInstance(db, remediator, { instanceId, stateMapping: { other: "received" }, reason: "r" }),
    ).rejects.toMatchObject({ code: "mapping_incomplete" }); // current state 'open' not covered
    await expect(
      migrateInstance(db, remediator, { instanceId, stateMapping: { open: "nowhere" }, reason: "r" }),
    ).rejects.toMatchObject({ code: "mapping_unknown_state" });
  });

  it("a terminal mapping completes the instance during migration", async () => {
    const instanceId = await startOnV1();
    await activateV2();
    const result = await migrateInstance(db, remediator, {
      instanceId, stateMapping: { open: "done" }, reason: "already finished on paper",
    });
    expect(result.state).toBe("done");
    const [instance] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId));
    expect(instance!.status).toBe("completed");
    expect(instance!.endedAt).not.toBeNull();
    const open = await db.select().from(workflowTimers).where(
      and(eq(workflowTimers.instanceId, instanceId), isNull(workflowTimers.firedAt), isNull(workflowTimers.cancelledAt)),
    );
    expect(open).toHaveLength(0);
  });

  it("aborts an active instance: status, endedAt, cancelled timers, instance.aborted event", async () => {
    const instanceId = await startOnV1();
    await abortInstance(db, remediator, { instanceId, reason: "started in error" });
    const [instance] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId));
    expect(instance!.status).toBe("aborted");
    expect(instance!.endedAt).not.toBeNull();
    const open = await db.select().from(workflowTimers).where(
      and(eq(workflowTimers.instanceId, instanceId), isNull(workflowTimers.firedAt), isNull(workflowTimers.cancelledAt)),
    );
    expect(open).toHaveLength(0);
    const aborted = await db.select().from(events).where(eq(events.name, "instance.aborted"));
    expect(aborted).toHaveLength(1);
    expect(aborted[0]!.correlationId).toBe(instanceId);
    expect(aborted[0]!.payload as object).toMatchObject({ state: "open", reason: "started in error" });
    await expect(
      abortInstance(db, remediator, { instanceId, reason: "twice" }),
    ).rejects.toMatchObject({ code: "instance_not_active" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @hmis/core test -- --testPathPattern "workflow/remediation"`
Expected: FAIL — `./remediation` not found.

- [ ] **Step 3: Implement**

`apps/core/src/kernel/workflow/remediation.ts`:
```ts
import { and, eq } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { workflowDefinitions, workflowInstances } from "../db/schema";
import { appendEvent } from "../events/append";
import { withTx } from "../db/client";
import { getActiveDefinition } from "./definitions";
import { WorkflowError } from "./instances";
import { scheduleSlaTimer, cancelOpenTimers } from "./timers";
import { instanceMigrated, instanceAborted } from "./events";
import type { Db } from "../db/client";

// D-11 in-flight remediation. Gating in this plan = the workflow.instances.remediate
// permission at the route + the mandatory reason in the event. Routing these two ops
// through the approvals engine is the declared Plan 04 SEAM.

export async function migrateInstance(
  db: Db,
  actor: Actor,
  input: { instanceId: string; stateMapping: Record<string, string>; reason: string },
): Promise<{ toDefinitionId: string; toVersion: number; state: string }> {
  return withTx(db, async (tx) => {
    const rows = await tx.select().from(workflowInstances).where(eq(workflowInstances.id, input.instanceId));
    const instance = rows[0];
    if (!instance) throw new WorkflowError("unknown_instance");
    if (instance.status !== "active") throw new WorkflowError("instance_not_active");

    const target = await getActiveDefinition(tx, instance.defKey);
    if (!target) throw new WorkflowError("no_active_definition");
    if (target.id === instance.definitionId) throw new WorkflowError("already_on_active_version");

    const mapped = input.stateMapping[instance.currentState];
    if (mapped === undefined) {
      throw new WorkflowError("mapping_incomplete", `stateMapping does not cover current state "${instance.currentState}"`);
    }
    for (const [from, to] of Object.entries(input.stateMapping)) {
      if (!target.parsed.states.some((s) => s.name === to)) {
        throw new WorkflowError("mapping_unknown_state", `mapped state "${to}" (from "${from}") is not in the target version`);
      }
    }
    const targetState = target.parsed.states.find((s) => s.name === mapped)!;

    const fromRows = await tx.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, instance.definitionId));
    const fromRow = fromRows[0]!;
    const now = new Date();
    const completed = targetState.terminal === true;

    // Single-winner, like transition(): the mapping was validated against
    // instance.currentState, so the move is conditional on it.
    const updated = await tx
      .update(workflowInstances)
      .set({
        definitionId: target.id,
        currentState: mapped,
        stateEnteredAt: now,
        status: completed ? "completed" : "active",
        endedAt: completed ? now : null,
      })
      .where(
        and(
          eq(workflowInstances.id, instance.id),
          eq(workflowInstances.status, "active"),
          eq(workflowInstances.currentState, instance.currentState),
        ),
      )
      .returning({ id: workflowInstances.id });
    if (updated.length === 0) {
      throw new WorkflowError("stale_transition", `instance ${instance.id} was moved concurrently`);
    }
    await cancelOpenTimers(tx, instance.id);
    if (!completed && targetState.sla) {
      await scheduleSlaTimer(tx, { instanceId: instance.id, state: mapped, sla: targetState.sla, enteredAt: now });
    }
    await appendEvent(
      tx,
      instanceMigrated.make({
        actor,
        correlationId: instance.id,
        patientId: instance.patientId ?? undefined,
        encounterId: instance.encounterId ?? undefined,
        payload: {
          instanceId: instance.id,
          defKey: instance.defKey,
          fromDefinitionId: instance.definitionId,
          toDefinitionId: target.id,
          fromVersion: fromRow.version,
          toVersion: target.version,
          fromState: instance.currentState,
          toState: mapped,
          reason: input.reason,
        },
      }),
    );
    return { toDefinitionId: target.id, toVersion: target.version, state: mapped };
  });
}

export async function abortInstance(
  db: Db,
  actor: Actor,
  input: { instanceId: string; reason: string },
): Promise<void> {
  await withTx(db, async (tx) => {
    const rows = await tx.select().from(workflowInstances).where(eq(workflowInstances.id, input.instanceId));
    const instance = rows[0];
    if (!instance) throw new WorkflowError("unknown_instance");
    if (instance.status !== "active") throw new WorkflowError("instance_not_active");

    const now = new Date();
    // Conditional on status so a concurrent completion/abort loses cleanly; RETURNING
    // gives the state as of the locked row, which the event must record.
    const updated = await tx
      .update(workflowInstances)
      .set({ status: "aborted", endedAt: now })
      .where(and(eq(workflowInstances.id, instance.id), eq(workflowInstances.status, "active")))
      .returning({ currentState: workflowInstances.currentState });
    if (updated.length === 0) throw new WorkflowError("instance_not_active");
    await cancelOpenTimers(tx, instance.id);
    await appendEvent(
      tx,
      instanceAborted.make({
        actor,
        correlationId: instance.id,
        patientId: instance.patientId ?? undefined,
        encounterId: instance.encounterId ?? undefined,
        payload: {
          instanceId: instance.id,
          defKey: instance.defKey,
          state: updated[0]!.currentState,
          reason: input.reason,
        },
      }),
    );
  });
}
```

- [ ] **Step 4: Run to verify pass, then the full suite**

Run: `pnpm --filter @hmis/core test -- --testPathPattern "workflow/remediation"`
Expected: PASS (4 tests).

Run: `pnpm verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/kernel/workflow
git commit -m "feat(workflow): in-flight remediation — migrateInstance/abortInstance with fresh timers (D-11)"
```

---

### Task 9: Manifest, Nest module, definition routes, AppModule wiring

**Files:**
- Create: `apps/core/src/kernel/workflow/manifest.ts`, `apps/core/src/kernel/workflow/workflow.module.ts`, `apps/core/src/kernel/workflow/workflow.controller.ts`
- Modify: `apps/core/src/app.module.ts`
- Test: `apps/core/test/workflow-definitions.e2e.test.ts`

**Interfaces:**
- Consumes: everything T1–T8 shipped; Plan 02's global guards (already registered by `AuthModule` — this module registers **no** guard), `@RequirePermission`/`@CurrentActor`, `syncPermissions` (already running in `AuthModule.onModuleInit` — installing the manifest is a pure registry change, **not** a new boot-time DB call).
- Produces (exact):
  - `workflowManifest: ModuleManifest` — key `"workflow"`, permissions: `workflow.definitions.draft`, `workflow.definitions.approve`, `workflow.definitions.activate`, `workflow.definitions.read`, `workflow.instances.start`, `workflow.instances.transition`, `workflow.instances.read`, `workflow.instances.remediate`. No menu entries (first UI is Plan 05), no subscriptions.
  - `WorkflowModule` — controllers only.
  - Routes (this task): `POST /workflow/definitions` (draft) · `POST /workflow/definitions/:id/approve` · `POST /workflow/definitions/:id/activate` · `GET /workflow/definitions?key=…`. All `@RequirePermission(…, "hospital")`.
  - HTTP error mapping (shared with T10, defined once here): `WorkflowValidationError` → 400 (body carries `problems`) · `GovernanceError` → 409 · `WorkflowError` → 409 · `SodViolationError` → 403. Anything else rethrows (500 = a genuine bug, loudly).
- **No red run can be faked here and none needs to be:** the e2e is written first and its first honest run fails with 404s (routes don't exist yet) — that IS the fail-first evidence.

- [ ] **Step 1: Write the failing e2e FIRST**

`apps/core/test/workflow-definitions.e2e.test.ts`:
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
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { loadConfig, requireEnv } from "../src/kernel/config";
import type { Db } from "../src/kernel/db/client";

const DEF_C = {
  key: "e2e_flow",
  title: "E2E Flow",
  changeClass: "C",
  initialState: "open",
  states: [
    { name: "open", sla: { minutes: 30, alerting: "record_only" } },
    { name: "done", terminal: true },
  ],
  transitions: [{ from: "open", to: "done", roles: ["nurse"] }],
};
const DEF_A = { ...DEF_C, key: "e2e_class_a", changeClass: "A" };

describe("workflow definitions e2e", () => {
  let app: INestApplication;
  let db: Db; let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  registry.install(workflowManifest);
  const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });

  let drafterToken: string;
  let activatorToken: string;
  let randoToken: string;
  let activatorId: string;
  let msId: string;

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
    await createRole(db, "owner", "Owner");
    await createRole(db, "medical_superintendent", "Medical Superintendent");

    const mk = async (username: string): Promise<{ id: string; token: string }> => {
      const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
      const { token } = await createSession(db, cfg, id);
      return { id, token };
    };
    const drafter = await mk("drafter");
    const activator = await mk("activator");
    const ms = await mk("ms1");
    const rando = await mk("rando");
    drafterToken = drafter.token;
    activatorToken = activator.token;
    randoToken = rando.token;
    activatorId = activator.id;
    msId = ms.id;
    await assignRole(db, { userId: drafter.id, roleKey: "wf_admin", scopeType: "hospital" });
    await assignRole(db, { userId: activator.id, roleKey: "wf_admin", scopeType: "hospital" });
    await assignRole(db, { userId: activator.id, roleKey: "owner", scopeType: "hospital" });
    await assignRole(db, { userId: ms.id, roleKey: "wf_admin", scopeType: "hospital" });
    await assignRole(db, { userId: ms.id, roleKey: "medical_superintendent", scopeType: "hospital" });
  });

  it("guards every definition route: 401 unauthenticated, 403 without the permission", async () => {
    await request(app.getHttpServer()).post("/workflow/definitions").send(DEF_C).expect(401);
    await request(app.getHttpServer())
      .post("/workflow/definitions").set("Authorization", `Bearer ${randoToken}`)
      .send(DEF_C).expect(403);
    await request(app.getHttpServer())
      .get("/workflow/definitions?key=e2e_flow").set("Authorization", `Bearer ${randoToken}`)
      .expect(403);
  });

  it("rejects an invalid definition with 400 and the problems list", async () => {
    const res = await request(app.getHttpServer())
      .post("/workflow/definitions").set("Authorization", `Bearer ${drafterToken}`)
      .send({ ...DEF_C, initialState: "nowhere" })
      .expect(400);
    expect(JSON.stringify(res.body.message)).toContain('initialState "nowhere" is not a declared state');
  });

  it("class C lifecycle over HTTP: draft → drafter self-activation 403 (SoD) → activate → list", async () => {
    const draft = await request(app.getHttpServer())
      .post("/workflow/definitions").set("Authorization", `Bearer ${drafterToken}`)
      .send(DEF_C).expect(201);
    const { definitionId } = draft.body as { definitionId: string };

    await request(app.getHttpServer())
      .post(`/workflow/definitions/${definitionId}/activate`)
      .set("Authorization", `Bearer ${drafterToken}`)
      .expect(403); // drafter ≠ activator (SoD pair, evented)

    const activated = await request(app.getHttpServer())
      .post(`/workflow/definitions/${definitionId}/activate`)
      .set("Authorization", `Bearer ${activatorToken}`)
      .expect(201);
    expect(activated.body).toEqual({ retiredVersion: null });

    const list = await request(app.getHttpServer())
      .get("/workflow/definitions?key=e2e_flow").set("Authorization", `Bearer ${drafterToken}`)
      .expect(200);
    expect(list.body.definitions).toHaveLength(1);
    expect(list.body.definitions[0]).toMatchObject({ version: 1, status: "active" });
  });

  it("class A over HTTP: activation 409 until owner AND MS approve", async () => {
    const draft = await request(app.getHttpServer())
      .post("/workflow/definitions").set("Authorization", `Bearer ${drafterToken}`)
      .send(DEF_A).expect(201);
    const { definitionId } = draft.body as { definitionId: string };

    await request(app.getHttpServer())
      .post(`/workflow/definitions/${definitionId}/activate`)
      .set("Authorization", `Bearer ${activatorToken}`)
      .expect(409); // approvals_missing

    await request(app.getHttpServer())
      .post(`/workflow/definitions/${definitionId}/approve`)
      .set("Authorization", `Bearer ${activatorToken}`)
      .send({ roleKey: "owner", note: "reviewed and safe" })
      .expect(201);
    const msSession = await createSession(db, cfg, msId);
    await request(app.getHttpServer())
      .post(`/workflow/definitions/${definitionId}/approve`)
      .set("Authorization", `Bearer ${msSession.token}`)
      .send({ roleKey: "medical_superintendent", note: "clinically reviewed" })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/workflow/definitions/${definitionId}/activate`)
      .set("Authorization", `Bearer ${activatorToken}`)
      .expect(201);
    expect(activatorId).toBeTruthy(); // activator drove the flow end to end
  });
});
```

- [ ] **Step 2: Run to observe the honest red**

Run: `pnpm --filter @hmis/core test -- --testPathPattern "workflow-definitions"`
Expected: FAIL — `workflowManifest` module not found at import time. (After creating only `manifest.ts` it would fail with 404s on every `/workflow/*` route — either red state is honest fail-first evidence; quote whichever you observed.)

- [ ] **Step 3: Implement manifest and module**

`apps/core/src/kernel/workflow/manifest.ts`:
```ts
import type { ModuleManifest } from "../modules/manifest";

export const workflowManifest: ModuleManifest = {
  key: "workflow",
  title: "Workflow Engine",
  menu: [], // first UI arrives in Plan 05
  permissions: [
    "workflow.definitions.draft",
    "workflow.definitions.approve",
    "workflow.definitions.activate",
    "workflow.definitions.read",
    "workflow.instances.start",
    "workflow.instances.transition",
    "workflow.instances.read",
    "workflow.instances.remediate",
  ],
  subscriptions: [],
};
```

`apps/core/src/kernel/workflow/workflow.module.ts`:
```ts
import { Module } from "@nestjs/common";
import { WorkflowController } from "./workflow.controller";

// Guards are NOT registered here — AuthGuard and PermissionGuard are global APP_GUARDs
// registered once by AuthModule (order load-bearing, Plan 02).
@Module({ controllers: [WorkflowController] })
export class WorkflowModule {}
```

- [ ] **Step 4: Implement the controller (definition routes + the shared error mapper)**

`apps/core/src/kernel/workflow/workflow.controller.ts`:
```ts
import {
  BadRequestException, Body, Controller, ConflictException, ForbiddenException, Get, Inject,
  Param, Post, Query,
} from "@nestjs/common";
import { z } from "zod";
import type { Actor } from "@hmis/contracts";
import { DB } from "../tokens";
import { CurrentActor, RequirePermission } from "../auth/decorators";
import { SodViolationError } from "../auth/sod";
import { WorkflowValidationError } from "./definition";
import {
  createDraft, approveDefinition, activateDefinition, listDefinitions, GovernanceError,
} from "./definitions";
import { WorkflowError } from "./instances";
import type { DefinitionRow } from "./definitions";
import type { Db } from "../db/client";

/** Engine errors → HTTP. Anything unrecognized rethrows: a 500 is a genuine bug, loudly. */
function toHttp(e: unknown): never {
  if (e instanceof WorkflowValidationError) throw new BadRequestException(e.problems);
  if (e instanceof SodViolationError) throw new ForbiddenException(e.message);
  if (e instanceof GovernanceError) throw new ConflictException(e.message);
  if (e instanceof WorkflowError) throw new ConflictException(e.message);
  throw e;
}

@Controller("workflow")
export class WorkflowController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @RequirePermission("workflow.definitions.draft", "hospital")
  @Post("definitions")
  async draft(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
  ): Promise<{ definitionId: string; defKey: string; version: number }> {
    try {
      return await createDraft(this.db, actor, body);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("workflow.definitions.approve", "hospital")
  @Post("definitions/:id/approve")
  async approve(
    @CurrentActor() actor: Actor,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const parsed = z
      .object({ roleKey: z.string().min(1), note: z.string().min(3), emergency: z.boolean().optional() })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    try {
      await approveDefinition(this.db, actor, { definitionId: id, ...parsed.data });
      return { ok: true };
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("workflow.definitions.activate", "hospital")
  @Post("definitions/:id/activate")
  async activate(
    @CurrentActor() actor: Actor,
    @Param("id") id: string,
  ): Promise<{ retiredVersion: number | null }> {
    try {
      return await activateDefinition(this.db, actor, id);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("workflow.definitions.read", "hospital")
  @Get("definitions")
  async list(@Query("key") key: string | undefined): Promise<{ definitions: DefinitionRow[] }> {
    if (typeof key !== "string" || key === "") throw new BadRequestException("query param key is required");
    return { definitions: await listDefinitions(this.db, key) };
  }
}
```

- [ ] **Step 5: Wire into AppModule**

`apps/core/src/app.module.ts` becomes (only three lines change from the current file — the two imports and the `imports:` array — plus the `registry.install(workflowManifest)` line; everything else stays byte-identical):
```ts
import { Module, Global, Inject, OnModuleDestroy } from "@nestjs/common";
import type { Pool } from "pg";
import { createDb, Db } from "./kernel/db/client";
import { loadConfig, AppConfig } from "./kernel/config";
import { DB, DB_POOL, CONFIG, MODULE_REGISTRY } from "./kernel/tokens";
import { ModuleRegistry } from "./kernel/modules/loader";
import { authManifest } from "./kernel/auth/manifest";
import { workflowManifest } from "./kernel/workflow/manifest";
import { HealthController } from "./health/health.controller";
import { AuthModule } from "./kernel/auth/auth.module";
import { WorkflowModule } from "./kernel/workflow/workflow.module";

export { DB, DB_POOL, CONFIG, MODULE_REGISTRY } from "./kernel/tokens";

type DbBundle = { db: Db; pool: Pool };
const DB_BUNDLE = Symbol("DB_BUNDLE");

@Global()
@Module({
  imports: [AuthModule, WorkflowModule],
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

Run: `pnpm --filter @hmis/core test -- --testPathPattern "workflow-definitions"`
Expected: PASS (4 tests).

Run: `pnpm verify`
Expected: PASS — including the pre-existing `health.e2e` and `rbac.e2e` suites (this task adds no boot-time DB call; `syncPermissions` already ran at boot in those suites and merely gains rows from the enlarged registry).

- [ ] **Step 7: Commit**

```bash
git add apps/core
git commit -m "feat(workflow): manifest, module, definition routes; registry wiring in AppModule"
```

---

### Task 10: Instance routes + full-lifecycle e2e + docs

**Files:**
- Modify: `apps/core/src/kernel/workflow/workflow.controller.ts` (extend — Task 9's routes stay byte-identical), `README.md`
- Test: `apps/core/test/workflow-instances.e2e.test.ts`

**Interfaces:**
- Consumes: T6/T7/T8 exports; T9's controller + `toHttp`.
- Produces (exact routes):
  - `POST /workflow/instances` — body `{ defKey, subject: { type, id, patientId?, encounterId? } }` → `{ instanceId, state }` — `workflow.instances.start`
  - `POST /workflow/instances/:id/transition` — body `{ to, note? }` → `{ state, completed }` — `workflow.instances.transition`
  - `GET /workflow/instances/:id` → `{ instance, transitions, openTimers }` — `workflow.instances.read`
  - `POST /workflow/instances/:id/migrate` — body `{ stateMapping, reason }` → `{ toDefinitionId, toVersion, state }` — `workflow.instances.remediate`
  - `POST /workflow/instances/:id/abort` — body `{ reason }` → `{ ok: true }` — `workflow.instances.remediate`
- The e2e drives the whole engine end to end over HTTP: activate a definition, start an instance, breach its SLA (backdated timer + direct `runDueTimers(db)` call — the test IS the scheduler until Plan 11), observe `sla.breached` + `escalation.triggered` in the log, transition with the right role, migrate to v2, abort.
- **Fail-first:** the e2e is written first; its first honest run 404s on every `/workflow/instances*` route.

- [ ] **Step 1: Write the failing e2e FIRST**

`apps/core/test/workflow-instances.e2e.test.ts`:
```ts
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { and, eq, isNull } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { setupTestDb, truncateAll } from "./helpers/db";
import { createUser } from "../src/kernel/auth/identity";
import { createSession } from "../src/kernel/auth/sessions";
import { createRole, grantPermissionToRole, syncPermissions, assignRole } from "../src/kernel/auth/permissions";
import { seedSodPairs } from "../src/kernel/auth/sod";
import { authManifest } from "../src/kernel/auth/manifest";
import { workflowManifest } from "../src/kernel/workflow/manifest";
import { runDueTimers } from "../src/kernel/workflow/timers";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { events, workflowTimers } from "../src/kernel/db/schema";
import { loadConfig, requireEnv } from "../src/kernel/config";
import type { Db } from "../src/kernel/db/client";

const DEF_V1 = {
  key: "e2e_lifecycle",
  title: "Lifecycle v1",
  changeClass: "C",
  initialState: "open",
  states: [
    {
      name: "open",
      sla: { minutes: 30, alerting: "active", escalation: [{ afterMinutes: 10, toRole: "duty_manager" }] },
    },
    { name: "in_progress", sla: { minutes: 60, alerting: "record_only" } },
    { name: "done", terminal: true },
  ],
  transitions: [
    { from: "open", to: "in_progress", roles: ["nurse"] },
    { from: "in_progress", to: "done", roles: ["nurse"] },
  ],
};
const DEF_V2 = {
  ...DEF_V1,
  title: "Lifecycle v2",
  states: [
    { name: "received", sla: { minutes: 5, alerting: "record_only" } },
    { name: "done", terminal: true },
  ],
  transitions: [{ from: "received", to: "done", roles: ["nurse"] }],
};

describe("workflow instances e2e", () => {
  let app: INestApplication;
  let db: Db; let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  registry.install(workflowManifest);
  const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });

  let adminToken: string;   // wf_admin: every workflow permission
  let nurseToken: string;   // nurse role + instances.transition permission
  let nurseId: string;
  let dmId: string;

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
    await createRole(db, "wf_operator", "Workflow Operator");
    await grantPermissionToRole(db, registry, "wf_operator", "workflow.instances.transition");
    await createRole(db, "nurse", "Nurse");
    await createRole(db, "duty_manager", "Duty Manager");

    const mk = async (username: string): Promise<{ id: string; token: string }> => {
      const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
      const { token } = await createSession(db, cfg, id);
      return { id, token };
    };
    const admin = await mk("admin1");
    const nurse = await mk("nurse1");
    const dm = await mk("dm1");
    adminToken = admin.token;
    nurseToken = nurse.token;
    nurseId = nurse.id;
    dmId = dm.id;
    await assignRole(db, { userId: admin.id, roleKey: "wf_admin", scopeType: "hospital" });
    await assignRole(db, { userId: nurse.id, roleKey: "wf_operator", scopeType: "hospital" });
    await assignRole(db, { userId: nurse.id, roleKey: "nurse", scopeType: "hospital" });
    await assignRole(db, { userId: dm.id, roleKey: "duty_manager", scopeType: "hospital" });

    // an activator distinct from the drafter (SoD): admin drafts, second admin activates
    const activator = await mk("activator");
    await assignRole(db, { userId: activator.id, roleKey: "wf_admin", scopeType: "hospital" });
    const draft = await request(app.getHttpServer())
      .post("/workflow/definitions").set("Authorization", `Bearer ${adminToken}`)
      .send(DEF_V1).expect(201);
    await request(app.getHttpServer())
      .post(`/workflow/definitions/${(draft.body as { definitionId: string }).definitionId}/activate`)
      .set("Authorization", `Bearer ${activator.token}`)
      .expect(201);
  });

  async function startInstanceViaApi(): Promise<string> {
    const res = await request(app.getHttpServer())
      .post("/workflow/instances").set("Authorization", `Bearer ${adminToken}`)
      .send({ defKey: "e2e_lifecycle", subject: { type: "test", id: "s1", patientId: "01HPAT000000000000000000A" } })
      .expect(201);
    expect(res.body.state).toBe("open");
    return (res.body as { instanceId: string }).instanceId;
  }

  it("start → breach (runDueTimers) → escalate → transition → complete, end to end", async () => {
    const instanceId = await startInstanceViaApi();

    // Breach: backdate the SLA timer, then run the (unscheduled) ticker — the test IS
    // the scheduler until Plan 11 wires pg-boss.
    await db.update(workflowTimers)
      .set({ dueAt: new Date(Date.now() - 60_000) })
      .where(eq(workflowTimers.instanceId, instanceId));
    expect(await runDueTimers(db)).toBe(1);
    await db.update(workflowTimers)
      .set({ dueAt: new Date(Date.now() - 1000) })
      .where(and(eq(workflowTimers.instanceId, instanceId), eq(workflowTimers.kind, "escalation")));
    expect(await runDueTimers(db)).toBe(1);
    const breached = await db.select().from(events).where(eq(events.name, "sla.breached"));
    expect(breached).toHaveLength(1);
    const escalated = await db.select().from(events).where(eq(events.name, "escalation.triggered"));
    expect(escalated).toHaveLength(1);
    expect((escalated[0]!.payload as { resolvedUserIds: string[] }).resolvedUserIds).toEqual([dmId]);

    // Transition with the allowed role; a permissioned user without the nurse role is denied 409.
    await request(app.getHttpServer())
      .post(`/workflow/instances/${instanceId}/transition`).set("Authorization", `Bearer ${adminToken}`)
      .send({ to: "in_progress" }).expect(409); // admin holds no 'nurse' role → role_denied
    const moved = await request(app.getHttpServer())
      .post(`/workflow/instances/${instanceId}/transition`).set("Authorization", `Bearer ${nurseToken}`)
      .send({ to: "in_progress", note: "picked up" }).expect(201);
    expect(moved.body).toEqual({ state: "in_progress", completed: false });

    const done = await request(app.getHttpServer())
      .post(`/workflow/instances/${instanceId}/transition`).set("Authorization", `Bearer ${nurseToken}`)
      .send({ to: "done" }).expect(201);
    expect(done.body).toEqual({ state: "done", completed: true });

    const detail = await request(app.getHttpServer())
      .get(`/workflow/instances/${instanceId}`).set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(detail.body.instance).toMatchObject({ status: "completed", currentState: "done" });
    expect(detail.body.transitions).toHaveLength(2);
    expect(detail.body.transitions[0].actorId).toBe(nurseId);
    expect(detail.body.openTimers).toHaveLength(0);
  });

  it("migrate to v2 and abort, both permission-gated and evented", async () => {
    const instanceId = await startInstanceViaApi();
    // activate v2 (admin drafts, activator activates — SoD)
    const activator2 = await createUser(db, { username: "activator2", fullName: "A2", password: "p1234567" });
    await assignRole(db, { userId: activator2.id, roleKey: "wf_admin", scopeType: "hospital" });
    const activator2Session = await createSession(db, cfg, activator2.id);
    const draft2 = await request(app.getHttpServer())
      .post("/workflow/definitions").set("Authorization", `Bearer ${adminToken}`)
      .send(DEF_V2).expect(201);
    await request(app.getHttpServer())
      .post(`/workflow/definitions/${(draft2.body as { definitionId: string }).definitionId}/activate`)
      .set("Authorization", `Bearer ${activator2Session.token}`)
      .expect(201);

    await request(app.getHttpServer())
      .post(`/workflow/instances/${instanceId}/migrate`).set("Authorization", `Bearer ${nurseToken}`)
      .send({ stateMapping: { open: "received" }, reason: "def fix" })
      .expect(403); // nurse lacks workflow.instances.remediate

    const migrated = await request(app.getHttpServer())
      .post(`/workflow/instances/${instanceId}/migrate`).set("Authorization", `Bearer ${adminToken}`)
      .send({ stateMapping: { open: "received" }, reason: "def fix" })
      .expect(201);
    expect(migrated.body).toMatchObject({ toVersion: 2, state: "received" });

    await request(app.getHttpServer())
      .post(`/workflow/instances/${instanceId}/abort`).set("Authorization", `Bearer ${adminToken}`)
      .send({ reason: "test cleanup" })
      .expect(201);
    const aborted = await db.select().from(events).where(eq(events.name, "instance.aborted"));
    expect(aborted).toHaveLength(1);
    const migratedEvents = await db.select().from(events).where(eq(events.name, "instance.migrated"));
    expect(migratedEvents).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to observe the honest red**

Run: `pnpm --filter @hmis/core test -- --testPathPattern "workflow-instances"`
Expected: FAIL — 404 on `POST /workflow/instances` (routes don't exist yet).

- [ ] **Step 3: Implement the instance routes**

Add to the imports of `apps/core/src/kernel/workflow/workflow.controller.ts`:
```ts
import { and, eq, isNull } from "drizzle-orm";
import { withTx } from "../db/client";
import { startInstance, transition } from "./instances";
import { migrateInstance, abortInstance } from "./remediation";
import { workflowInstances, workflowTransitions, workflowTimers } from "../db/schema";
```

Append inside the `WorkflowController` class:
```ts
  @RequirePermission("workflow.instances.start", "hospital")
  @Post("instances")
  async start(@Body() body: unknown): Promise<{ instanceId: string; state: string }> {
    const parsed = z
      .object({
        defKey: z.string().min(1),
        subject: z.object({
          type: z.string().min(1),
          id: z.string().min(1),
          patientId: z.string().optional(),
          encounterId: z.string().optional(),
        }),
      })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    try {
      return await withTx(this.db, (tx) => startInstance(tx, parsed.data.defKey, parsed.data.subject));
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("workflow.instances.transition", "hospital")
  @Post("instances/:id/transition")
  async doTransition(
    @CurrentActor() actor: Actor,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<{ state: string; completed: boolean }> {
    const parsed = z.object({ to: z.string().min(1), note: z.string().optional() }).safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    try {
      return await withTx(this.db, (tx) =>
        transition(tx, id, parsed.data.to, actor, { note: parsed.data.note }),
      );
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("workflow.instances.read", "hospital")
  @Get("instances/:id")
  async instanceDetail(@Param("id") id: string): Promise<{
    instance: typeof workflowInstances.$inferSelect;
    transitions: (typeof workflowTransitions.$inferSelect)[];
    openTimers: (typeof workflowTimers.$inferSelect)[];
  }> {
    const rows = await this.db.select().from(workflowInstances).where(eq(workflowInstances.id, id));
    const instance = rows[0];
    if (!instance) throw new BadRequestException(`unknown instance ${id}`);
    const transitions = await this.db
      .select()
      .from(workflowTransitions)
      .where(eq(workflowTransitions.instanceId, id))
      .orderBy(workflowTransitions.at);
    const openTimers = await this.db
      .select()
      .from(workflowTimers)
      .where(and(eq(workflowTimers.instanceId, id), isNull(workflowTimers.firedAt), isNull(workflowTimers.cancelledAt)));
    return { instance, transitions, openTimers };
  }

  @RequirePermission("workflow.instances.remediate", "hospital")
  @Post("instances/:id/migrate")
  async migrate(
    @CurrentActor() actor: Actor,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<{ toDefinitionId: string; toVersion: number; state: string }> {
    const parsed = z
      .object({ stateMapping: z.record(z.string(), z.string()), reason: z.string().min(3) })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    try {
      return await migrateInstance(this.db, actor, { instanceId: id, ...parsed.data });
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("workflow.instances.remediate", "hospital")
  @Post("instances/:id/abort")
  async abort(
    @CurrentActor() actor: Actor,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const parsed = z.object({ reason: z.string().min(3) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    try {
      await abortInstance(this.db, actor, { instanceId: id, ...parsed.data });
      return { ok: true };
    } catch (e) {
      toHttp(e);
    }
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @hmis/core test -- --testPathPattern "workflow-instances"`
Expected: PASS (2 tests).

- [ ] **Step 5: Document**

Append to `README.md`:
```markdown
## Workflow engine
Definitions are versioned data (draft → approve per change class → activate; immutable once
active; one active version per key). Instances pin their definition version; transitions
enforce the definition's allowed roles. SLA timers are DB rows: `runDueTimers()` emits
`sla.breached` and climbs escalation ladders — it is UNSCHEDULED until Plan 11 registers it
as a pg-boss cron (owner decision 2026-08-12), same as `runDispatchCycle` and
`sweepExpiredTempRoles`. Authoring flows: POST /workflow/definitions with
`{ key, title, changeClass, initialState, states, transitions }` — every branch must reach
a terminal state or the draft is rejected with the full problem list.
```

- [ ] **Step 6: Full verify + commit**

Run: `pnpm verify`
Expected: PASS — full suite green, zero lint problems.

```bash
git add apps/core README.md
git commit -m "feat(workflow): instance routes, full-lifecycle e2e, workflow docs"
```

---

## Self-Review Notes

- **Spec coverage (this plan's slice):** §10.2 definitions as versioned DB data (states, transitions, allowed roles, per-state SLA, escalation ladder) ✓ (T1, T2, T4) · §10.2 in-flight instances complete on their starting version ✓ (T6 pinning test) · §10.2 every change emits `workflow.definition.updated` ✓ (T4 drafted, T5 approved/activated) · §10.3 every state carries an SLA, every breach recorded, alerting selective per state (`active`/`record_only`) ✓ (T1 validation rule, T7) · §10.4 + D-15 change classes with owner/MS two-key for Class A ✓ (T5) · E-5 emergency-activation precedence over drafter/activator SoD ✓ (T5, tested with the MS-drafts-and-activates case) · D-11 in-flight migrate/abort, evented per instance ✓ (T8) · §11.19-C fix 11 escalation dead-end fallback to duty manager ✓ (T7; owner-SMS half is Plan 10, stated) · §18 no-dangling-paths as a library check ✓ (T1) · §11.19-B pass-5 engineering note (optimistic locking for concurrent writes) honored in the engine: every instance state move is a conditional single-winner update ✓ (T6 concurrent test, T8) · E-35 analog (publish-with-deviation) ✓ — the emergency activation path is the engine's instance of the pattern: a loudly-evented, two-key deviation from the normal governance gate (T5) · roadmap "Produces" line — `defineWorkflow`, `startInstance(tx, defKey, subject)`, `transition(tx, instanceId, to, actor)`, tables `workflow_definitions`/`workflow_instances`/`workflow_timers` ✓ (plus `workflow_definition_approvals` and `workflow_transitions`, needed for governance and audit) · roadmap trap "timers survive restart, no setTimeout" ✓ (rows only; owner decision (b) recorded). Deliberately out of scope: approvals-engine routing of activation and remediation (Plan 04 seam, stated in T5/T8), roster-resolved on-duty holders (Plan 11-adjacent seam in T3), pg-boss scheduling (Plan 11), agent transitions (Plan 12 seam in T6), org-scoped role enforcement (org-masters seam in T3), domain flows as data (Plans 07+).
- **Catalog discipline:** exactly five names minted — `workflow.definition.updated`, `sla.breached`, `escalation.triggered`, `instance.migrated`, `instance.aborted` — all present in §10.6. Instance starts/transitions are deliberately un-evented (no catalog names exist; `workflow_transitions` + later domain events carrying `correlationId` are the record).
- **Type consistency:** `WorkflowDefinition`/`SlaSpec` (T1) flow into T4's `parsed`, T6's timer scheduling, T7's ladder · `WorkflowError` defined once in T6, reused by T8's remediation codes, mapped once in T9's `toHttp` · `GovernanceError` (T5) mapped in the same helper · `startInstance`/`transition` are `Tx`-first exactly as the roadmap's Produces line specifies; `appendEvent(tx, def.make({...}))` matches Plan 01's shipped `MakeArgs` (verified against source: `actor`, `payload`, plus optional `correlationId`/`patientId`/`encounterId` — all used here) · `assertNotSodPair(db, "workflow_drafter_activator", actorA, actorB)` matches Plan 02's shipped signature and seeded pair key (verified against `sod.ts` source) · `setupTestDb`/`truncateAll` keep their frozen signatures (truncate list extended by one statement only).
- **Placeholders:** none — every step carries runnable code or exact commands.
- **Verify-by-execution flags (prove by running, not reading):** ① **drizzle partial unique index** — `uniqueIndex(...).on(t.defKey).where(sql\`${t.status} = 'active'\`)` must survive `db:generate` (inspect the generated SQL for the `WHERE` clause) and is proven at runtime by T2's one-active-per-key test; if drizzle-kit fails to emit the partial index, hand-write it in the generated migration file and note the deviation. ② **conditional `UPDATE … RETURNING` as claim / single-winner move** (T5 retire, T6 transition, T7 timer claim, T8 remediation) — proven against the live DB by T5's retire test, T6's concurrent double-transition test, and T7's claim-skip test. ③ **zod v4 `z.record(z.string(), z.string())`** in T10's migrate route — proven in the e2e red→green cycle. ④ **jsonb round-trip fidelity** of the definition (plain JSON, no Dates inside) — proven by T2's `toEqual(DEF_JSON)` and every `parseDefinition` call in T6–T8. ⑤ **multi-table `truncate`** with the workflow FK group — proven by the full suite after T2. ⑥ **Nest route paths** (`definitions/:id/approve` vs `instances/:id/transition` on one controller) — proven by both e2e suites. ⑦ **no CI edit needed** — no new deps, no new env vars, no jest changes; confirm by observing the first push's CI run green.
- **Standing-rules audit (EXECUTION-LESSONS §3):** every task's Files list names every file its steps touch, including the two `index.ts`/`db.ts` modifications in T2 and `app.module.ts` in T9 (§3.1) · no task adds a boot-time DB call — `AuthModule.onModuleInit` already runs `syncPermissions`/`seedSodPairs`, and T9 only enlarges the registry it reads, so no e2e DB-wiring audit is triggered; both new e2e suites copy `temp-roles.e2e`'s per-worker `DATABASE_URL` derivation verbatim (§3.6) · all test imports are static (§3.7) · fail-first ordering holds for all ten tasks including both e2e tasks, whose first honest runs 404 (§3.5) · no acceptance criterion demands re-producing a red run on retry — fail-first evidence is owed by the original attempt and inherited (§2.3) · no conditional instructions (§3.3).
- **Pipeline notes (copy into briefs at compile time):** paste EXECUTION-LESSONS §1 Tripwires verbatim at the top of every brief · pipeline A = T1–T5, pipeline B = T6–T10, strictly sequential (shared files: `definitions.ts` T4→T5, `timers.ts` T6→T7, `workflow.controller.ts` T9→T10, `db/schema` consumers throughout) · migration `0004_*` is generated in T2 — later tasks must NOT regenerate it (`db:generate` again would emit an empty or duplicate migration; if drizzle-kit emits one anyway, delete it and report) · existing deviations not to "fix": everything in gate reports 01/02 §4 (e.g., `MODULE_REGISTRY` in `tokens.ts`, static imports in e2e, `@Public` at method level, argon2 under pnpm `ignoredBuilds`) · this plan adds no dependency — if an agent believes one is needed, halt and report instead.

<!-- PLAN COMPLETE -->
