> Measured 2026-09-20 on `main` @ 21fe8912 by a read-only subagent for the obligation-spine implementation plan. Line numbers are from that commit; re-measure any line a task cites before editing it.

# HMIS workflow kernel — SLA / escalation dossier (read-only, /opt/hmis @ main)

All paths absolute. Nothing was modified. Line numbers are from the shipped files as of this read.

---

## 1. `/opt/hmis/apps/core/src/kernel/workflow/definition.ts` (146 lines)

### 1a. `SlaSpec` — the shipped type

`SlaSpec` is **not** a hand-written TS type; it is inferred from a zod schema. Verbatim, lines 7–13 and 36:

```ts
const slaSchema = z.object({
  minutes: z.number().int().positive(),
  alerting: z.enum(["active", "record_only"]),
  escalation: z
    .array(z.object({ afterMinutes: z.number().int().positive(), toRole: z.string().min(1) }))
    .optional(),
});
```
```ts
export type SlaSpec = z.infer<typeof slaSchema>;
```

Structurally that resolves to:
```ts
{ minutes: number; alerting: "active" | "record_only";
  escalation?: { afterMinutes: number; toRole: string }[] | undefined }
```

Surrounding types, verbatim (lines 15–39):
```ts
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
```

Also `definition.ts:3`: `export type ChangeClass = "A" | "B" | "C";` and `definition.ts:5`: `const KEY_RE = /^[a-z][a-z0-9_]*$/;`

### 1b. `EscalationRung`-like named type — **ABSENT in the workflow kernel**

Grep run:
```
grep -rn "EscalationRung" --include=*.ts apps/ packages/ | grep -v node_modules | grep -v "/dist/"
→ apps/core/src/kernel/approvals/flow.ts:28:export type EscalationRung = z.infer<typeof rungSchema>;
```
The only named rung type in the repo lives in **approvals**, not workflow. In `definition.ts` the rung is an anonymous inline object inside `slaSchema.escalation`.

### 1c. How `parseDefinition` validates `sla` / `escalation`

`parseDefinition` is a one-line delegate (lines 143–146):
```ts
/** Re-parses a definition previously stored as jsonb. Throws if the stored row is corrupt. */
export function parseDefinition(stored: unknown): WorkflowDefinition {
  return defineWorkflow(stored);
}
```

`defineWorkflow(defJson: unknown): WorkflowDefinition` (line 53) does zod-parse first, then graph rules.

**Field requirements / ranges for SLA (all from `slaSchema`):**
- `minutes` — **required**, `z.number().int().positive()` → integer, **> 0** (0 rejected).
- `alerting` — **required**, exactly `"active" | "record_only"`.
- `escalation` — **optional**. If present it is an array (no `.min(1)`, so `[]` is accepted by zod); each rung requires `afterMinutes` (int, **> 0**) and `toRole` (string, min length 1).
- There is **no** monotonicity / ordering check on `afterMinutes` across rungs, **no** max-rung count, and **no** relationship asserted between `afterMinutes` and `minutes`. Grep to confirm absence of sorting/ordering logic in the file: nothing matches `sort|monoton|ascending` in definition.ts.

**SLA-specific structural rules** (lines 76–83, verbatim):
```ts
  for (const s of def.states) {
    if (s.terminal === true && s.sla !== undefined) {
      problems.push(`terminal state "${s.name}" must not carry an SLA`);
    }
    if (s.terminal !== true && s.sla === undefined) {
      problems.push(`non-terminal state "${s.name}" must carry an SLA (spec §10.3: structure everywhere)`);
    }
  }
```

Zod failures are converted to problem strings at lines 54–59:
```ts
  const parsed = definitionSchema.safeParse(defJson);
  if (!parsed.success) {
    throw new WorkflowValidationError(
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    );
  }
```
Note: zod failure short-circuits — the graph checks never run on a shape-invalid definition, and the graph checks themselves are additionally gated on `if (problems.length === 0)` (line 98).

### 1d. `WorkflowValidationError` codes — **ABSENT (no code enum exists)**

Verbatim (lines 41–46):
```ts
export class WorkflowValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid workflow definition:\n- ${problems.join("\n- ")}`);
    this.name = "WorkflowValidationError";
  }
}
```
It carries **`problems: string[]` only — there is no `code` field and no exported code constants.** Grep:
```
grep -n "code" apps/core/src/kernel/workflow/definition.ts   → (no matches)
```
The SLA-relevant *problem strings* (the closest thing to codes, and what tests assert on) are exactly:
- `` `terminal state "${s.name}" must not carry an SLA` ``
- `` `non-terminal state "${s.name}" must carry an SLA (spec §10.3: structure everywhere)` ``

A separate, unrelated class `WorkflowError` **does** have a code union — it lives in `instances.ts:13–31` (see §2) and contains no SLA/escalation codes.

---

## 2. `/opt/hmis/apps/core/src/kernel/workflow/instances.ts` (169 lines)

### 2a. Exact signatures

`instances.ts:38–42`:
```ts
export async function startInstance(
  tx: Tx,
  defKey: string,
  subject: WorkflowSubject,
): Promise<{ instanceId: string; state: string }> {
```

`instances.ts:72–78` (this is the state-advancing function; there is no other):
```ts
export async function transition(
  tx: Tx,
  instanceId: string,
  to: string,
  actor: Actor,
  opts: { note?: string } = {},
): Promise<{ state: string; completed: boolean }> {
```

Supporting exports:
- `instances.ts:11` — `export type WorkflowSubject = { type: string; id: string; patientId?: string; encounterId?: string };`
- `instances.ts:13–31` — `export class WorkflowError extends Error` with `readonly code: "unknown_instance" | "instance_not_active" | "no_active_definition" | "unknown_transition" | "role_denied" | "already_on_active_version" | "mapping_incomplete" | "mapping_unknown_state" | "stale_transition" | "reason_required"`. **No SLA or timer code in that union.**

### 2b. Initial SLA timer scheduling — there is no separate scheduler function here; `startInstance` calls into `timers.ts` directly

`instances.ts:59–62`, verbatim:
```ts
  // initialState is never terminal (defineWorkflow rule), so it always carries an SLA.
  const initialSpec = active.parsed.states.find((s) => s.name === initial)!;
  await scheduleSlaTimer(tx, { instanceId, state: initial, sla: initialSpec.sla!, enteredAt: now });
  return { instanceId, state: initial };
```

### 2c. Lines writing `state_entered_at`

`startInstance`, `instances.ts:46` and `:48–58` (the insert):
```ts
  const now = new Date();
```
```ts
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
```

`transition`, `instances.ts:127` and `:135–150` (the single-winner conditional UPDATE):
```ts
  const now = new Date();
```
```ts
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
```

Full repo census of `stateEnteredAt` **writes** in kernel source: `instances.ts:57`, `instances.ts:139`, `remediation.ts:57`. (Reads: `modules/lab/sweeps.ts:99,275,286,296`.)

### 2d. Lines calling into timers

`instances.ts:8` — `import { scheduleSlaTimer, cancelOpenTimers } from "./timers";`
`instances.ts:61` — `await scheduleSlaTimer(tx, { instanceId, state: initial, sla: initialSpec.sla!, enteredAt: now });`
`instances.ts:155` — `await cancelOpenTimers(tx, instanceId);`
`instances.ts:165–167`:
```ts
  if (!completed && target.sla) {
    await scheduleSlaTimer(tx, { instanceId, state: to, sla: target.sla, enteredAt: now });
  }
```

Write order inside `transition`: (1) conditional UPDATE of `workflow_instances` (L135) → (2) `cancelOpenTimers` (L155) → (3) insert `workflow_transitions` history row (L156–164) → (4) `scheduleSlaTimer` for the new state (L166). All on the **caller's** `tx`.

---

## 3. `/opt/hmis/apps/core/src/kernel/workflow/timers.ts` (188 lines)

### 3a. Exported surface, verbatim signatures

```ts
// timers.ts:21-24
export async function scheduleSlaTimer(
  tx: Tx,
  input: { instanceId: string; state: string; sla: SlaSpec; enteredAt: Date },
): Promise<{ timerId: string; dueAt: Date }> {
```
```ts
// timers.ts:37-40
export async function scheduleEscalationTimer(
  tx: Tx,
  input: { instanceId: string; state: string; rung: number; afterMinutes: number; from: Date },
): Promise<{ timerId: string; dueAt: Date }> {
```
```ts
// timers.ts:54-55
/** Cancels every open (unfired, uncancelled) timer of an instance. Returns the count. */
export async function cancelOpenTimers(tx: Tx, instanceId: string): Promise<number> {
```
```ts
// timers.ts:70-71
/** §11.19-C fix 11: a ladder never dead-ends silently — duty manager catches empty rungs. */
export const DUTY_MANAGER_ROLE = "duty_manager";
```
```ts
// timers.ts:86
export async function runDueTimers(db: Db, now: Date = new Date()): Promise<number> {
```

Module-private (line 73): `const TIMER_ACTOR: Actor = { type: "system", id: "workflow-timer" };`

There is **no separate `claim` helper** — the claim is inline in `runDueTimers`. Grep: `grep -n "claim" apps/core/src/kernel/workflow/timers.ts` → only `timers.ts:102` comment (`// cancelled or claimed by another process since the scan`) and the local `const claimed`.

### 3b. Timer KINDS and their anchors

Two kinds only, both written as string literals (schema comment at `db/schema/workflow.ts:88` says `// 'sla' | 'escalation'`; there is no TS enum).

**`"sla"`** — anchored on `enteredAt` (i.e. `state_entered_at`). `timers.ts:25–33`:
```ts
  const timerId = newId();
  const dueAt = new Date(input.enteredAt.getTime() + input.sla.minutes * 60_000);
  await tx.insert(workflowTimers).values({
    id: timerId,
    instanceId: input.instanceId,
    state: input.state,
    kind: "sla",
    dueAt,
  });
```
`rung` is not set → NULL.

**`"escalation"`** — anchored on whatever `from` the caller passes. `timers.ts:41–50`:
```ts
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
```

**Both call sites pass `timer.dueAt` as `from` — the ladder is a CHAIN OF dueAt HOPS, not offsets from a single breach anchor and not from `stateEnteredAt`.**

Rung 0, scheduled when an SLA timer fires (`timers.ts:136–144`):
```ts
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
```
So rung 0 `dueAt` = `slaTimer.dueAt + ladder[0].afterMinutes` = `stateEnteredAt + sla.minutes + ladder[0].afterMinutes`.

### 3c. How rung N+1 is scheduled after rung N fires

`timers.ts:172–181`, verbatim:
```ts
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
```
`from` is the **firing rung's own `dueAt`**, so rung N+1 `dueAt` = rung N `dueAt` + `ladder[N+1].afterMinutes`. The rungs therefore **accumulate**: rung k fires at `stateEnteredAt + sla.minutes + Σ(afterMinutes[0..k])`. `afterMinutes` is an **inter-rung delta**, not an offset from the breach. (This is the anchoring semantics your ladder change would be altering, and it is pinned by tests — see §8.)

Only one rung is scheduled per fire, so **one `runDueTimers` call advances a chain by exactly one rung** (docstring `timers.ts:83–84`).

### 3d. Claim-and-fire discipline

`timers.ts:86–103`, verbatim:
```ts
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
```

Discipline, in order:
1. **Scan outside any transaction**, on `db` (not `tx`), selecting only `id`, ordered `asc(dueAt)`. Predicate: `dueAt <= now AND fired_at IS NULL AND cancelled_at IS NULL`.
2. **One `withTx` per timer.** Claim = conditional `UPDATE … SET fired_at = now WHERE id = ? AND fired_at IS NULL AND cancelled_at IS NULL RETURNING *`. `fired_at` is set to the **passed `now`**, not `new Date()` — so a fake-clock caller stamps the fake instant.
3. Claim first, **then** read instance + definition, **then** `appendEvent`, **then** schedule the next timer. Losing the claim returns `false` and emits nothing.
4. `fired` counts only successful claims.

**`FOR UPDATE SKIP LOCKED` — ABSENT from the workflow timer path.** Grep run:
```
grep -rn "SKIP LOCKED\|skip locked\|FOR UPDATE\|forUpdate" --include=*.ts apps/core/src/kernel/ | grep -v "/dist/"
```
→ no hit in `kernel/workflow/*`. Hits exist only in `kernel/printing/claim.ts:100`, `kernel/notify/pump.ts:482`, `kernel/orders/advance.ts`, and schema comments. The timer claim is a **conditional-UPDATE claim**, deliberately (docstring `timers.ts:78–82`).

Columns updated at claim: **`fired_at` only.** `cancelled_at` is never written by `runDueTimers`.

### 3e. Cancellation on state change

`timers.ts:55–68`, verbatim:
```ts
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
Note: it is **instance-wide**, not state-scoped — every open timer of the instance (SLA *and* every pending escalation rung) is cancelled in one statement, and it uses **wall-clock `new Date()`**, not a threaded `now`.

Call sites (full census, `grep -rn "cancelOpenTimers"`):
- `instances.ts:155` — in `transition`, after the state UPDATE.
- `remediation.ts:72` — in the migration path, after the migrate UPDATE.
- `remediation.ts:123` — in `abortInstance`.

### 3f. State re-entry

There is no re-entry special case anywhere. Re-entering a state goes through `transition`, which does `cancelOpenTimers` (kills the old SLA timer **and any pending escalation rungs**) then `scheduleSlaTimer(..., enteredAt: now)` — so **the SLA restarts from zero and the ladder restarts at rung 0** on the next breach. There is no "resume at rung N" state; `rung` lives only on the timer row.

Self-transition (`from === to`) is **not rejected** by `defineWorkflow`. Grep:
```
grep -n "t.from === t.to\|from === to" apps/core/src/kernel/workflow/definition.ts apps/core/src/kernel/workflow/definitions.ts
→ (no output)
```
Only duplicate `from→to` pairs and terminal-outgoing edges are rejected (`definition.ts:87–94`).

### 3g. Events appended and payload construction

Shared envelope, `timers.ts:112–117`:
```ts
      const envelope = {
        actor: TIMER_ACTOR,
        correlationId: instance.id,
        patientId: instance.patientId ?? undefined,
        encounterId: instance.encounterId ?? undefined,
      };
```

**`sla.breached`**, `timers.ts:119–134`:
```ts
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
```

**`escalation.triggered`** plus the fallback logic, `timers.ts:145–171`:
```ts
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
```

Semantics as shipped: `role` in the payload is **always the rung's declared `toRole`**, even when the resolved users came from `duty_manager`. `fallback` means "rung role resolved to nobody"; `fallbackExhausted` means "duty_manager also resolved to nobody" — and in that case `resolvedUserIds` is `[]`. The alerts consumer then re-resolves to `OWNER_ROLE` (see §10).

**`usersHoldingRole` call sites inside timers.ts, with line numbers:**
- `timers.ts:12` — `import { usersHoldingRole } from "./roles";`
- **`timers.ts:148`** — `let resolvedUserIds = await usersHoldingRole(tx, rungSpec.toRole);`
- **`timers.ts:153`** — `resolvedUserIds = await usersHoldingRole(tx, DUTY_MANAGER_ROLE);`

Those are the only two in the file. Repo-wide non-test call sites of `usersHoldingRole`: `alerts/consumer.ts:197,247,284,318,340,377,381,385`; `notify/consumer.ts:230`; `desk/staff.controller.ts:226`; `modules/materials/counts.ts:170`; `modules/materials/transfers.ts:270`; `scripts/seed-ops.ts:95,161,162`; `scripts/seed-roles.ts:1839`.

Also read but not written by the fire path: the definition is re-parsed per timer (`timers.ts:106–111`) and `sla` is taken from the **pinned** definition version:
```ts
      const def = parseDefinition(defRow.definition);
      const state = def.states.find((s) => s.name === timer.state)!;
      const sla = state.sla!; // timers only exist for SLA-carrying states
      const ladder = sla.escalation ?? [];
```
Note the non-null assertions: a timer whose `state` no longer exists in the pinned definition, or a ladder shorter than `timer.rung`, would throw (`ladder[rung]!`, `timers.ts:147`).

---

## 4. `/opt/hmis/apps/core/src/kernel/workflow/events.ts` (74 lines) — all five workflow events, verbatim

```ts
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

Note asymmetry worth planning around: **`sla.breached` carries `definitionVersion`; `escalation.triggered` does NOT.** Also `escalation.triggered` carries no `dueAt` / no timer id.

`events.test.ts` (50 lines) pins: all five names, `module === "workflow"`, `version === 1` for each (`it("declares exactly the five catalog names under module workflow")`), payload validation through `.make()`, and rejection of an unknown `action`.

---

## 5. `/opt/hmis/apps/core/src/kernel/workflow/roles.ts` (81 lines)

Verbatim signatures:
```ts
// roles.ts:11
export async function actorHoldsAnyRole(tx: Tx, userId: string, roleKeys: string[]): Promise<boolean> {
```
```ts
// roles.ts:53-55
export async function usersHoldingRoleAtScope(
  tx: Tx, roleKey: string, scopeType: "hospital" | "floor" | "department", scopeId?: string,
): Promise<string[]> {
```
```ts
// roles.ts:71
export async function usersHoldingRole(tx: Tx, roleKey: string): Promise<string[]> {
```

**Tables read** — `roles.ts:2`: `import { roleAssignments, tempRoleGrants } from "../db/schema";` (i.e. `role_assignments` and `temp_role_grants`). All three functions read **both**:

- `actorHoldsAnyRole` (L12–28): `roleAssignments` where `userId = ? AND roleKey IN (...)`; short-circuits `true`; else `tempRoleGrants` where `userId = ? AND roleKey IN (...) AND expiresAt > new Date()`. Returns `false` immediately if `roleKeys.length === 0`. **No scope filter** (documented seam, L5–10).
- `usersHoldingRoleAtScope` (L56–68): `roleAssignments` filtered by `roleKey` + `scopeType`, and additionally by `scopeId` **unless** `scopeType === "hospital"` or `scopeId === undefined`; temp grants are included **only when `scopeType === "hospital"`** (`const temp = scopeType !== "hospital" ? [] : …`). Returns deduped + `.sort()`ed.
- `usersHoldingRole` (L72–80): `roleAssignments` where `roleKey = ?` (any scope), union `tempRoleGrants` where `roleKey = ? AND expiresAt > new Date()`. Deduped via `Set`, `.sort()`ed — the docstring at L33–35 says this is so escalation event payloads are deterministic.

---

## 6. Schema: `/opt/hmis/apps/core/src/kernel/db/schema/workflow.ts` (99 lines)

Exported via `/opt/hmis/apps/core/src/kernel/db/schema/index.ts:5` — `export * from "./workflow";`

**Five tables**: `workflow_definitions`, `workflow_definition_approvals`, `workflow_instances`, `workflow_transitions`, `workflow_timers`. Header import, L1–4:
```ts
import {
  pgTable, text, integer, boolean, timestamp, jsonb, index, uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
```

### `workflow_definitions` (L6–28), verbatim
```ts
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
```
Nullable: `activated_by`, `activated_at`, `retired_at`. Defaults: `status='draft'`, `created_at=now()`.

### `workflow_definition_approvals` (L30–42), verbatim
```ts
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
```
Nullable: none. Defaults: `emergency=false`, `created_at=now()`.

### `workflow_instances` (L44–65), verbatim
```ts
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
```
Nullable: `patient_id`, `encounter_id`, `ended_at`. Defaults: `status='active'`, `started_at=now()`. **`state_entered_at` is NOT NULL with no default** — it is always written explicitly by the code (§2c).

### `workflow_transitions` (L67–80), verbatim
```ts
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
```
Nullable: `note`. Defaults: `at=now()`.

### `workflow_timers` (L82–99), verbatim — the table your change will touch
```ts
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
Nullable: `rung`, `fired_at`, `cancelled_at`. Defaults: `created_at=now()`. **No unique constraint of any kind** — nothing stops two open timers for the same `(instanceId, state, kind, rung)`. **No CHECK constraint on `kind`** and no enum. **No partial index on the open-timer predicate** (`fired_at IS NULL AND cancelled_at IS NULL`) — the scan in `runDueTimers` rides `workflow_timers_due_idx` alone.

### Migration of record
`/opt/hmis/apps/core/drizzle/0004_white_hydra.sql` creates all five tables (lines 1, 11, 26, 41, 53), four FKs (lines 64–67) all `ON DELETE no action ON UPDATE no action`, and the indexes (lines 68–77), including:
```
CREATE UNIQUE INDEX "workflow_definitions_one_active_ux" ON "workflow_definitions" USING btree ("def_key") WHERE "workflow_definitions"."status" = 'active';
CREATE INDEX "workflow_timers_due_idx" ON "workflow_timers" USING btree ("due_at");
CREATE INDEX "workflow_timers_instance_idx" ON "workflow_timers" USING btree ("instance_id");
```
Later migrations that mention "workflow" (`0005`, `0010`, `0035`, `0047_radiology_core`, `0056_pharmacy_dispense`, `0061_aerb_qa_records`) do so via other tables' `workflow_instance_id` columns; **no migration alters `workflow_timers` after 0004.**

### Which `*.test.ts` schema census pins these columns

**A column-by-column `information_schema` census for the workflow tables is ABSENT.** Greps run:
```
grep -rln "information_schema" --include=*.test.ts apps/core/src/ apps/core/test/
→ orders.test.ts, formulary.test.ts, materials.test.ts, ot.test.ts,
  patient-identity.test.ts, radiology.test.ts, resources.test.ts, migrate-watermark.test.ts
```
and then, for each of those, `grep -i workflow`:
```
HIT: apps/core/src/kernel/db/schema/ot.test.ts       (only the column "workflow_instance_id" on ot_cases/ot_case_gates)
HIT: apps/core/src/kernel/db/schema/radiology.test.ts (only workflowInstanceId fixture values)
```
Neither censuses a `workflow_*` table.

What **does** pin the workflow schema is `/opt/hmis/apps/core/src/kernel/db/schema/workflow.test.ts` (85 lines), a **behavioural** pin, not a column census. Its titles:
- L25 `it("round-trips a definition with jsonb intact and defaults applied")` — pins `status` default `"draft"` and jsonb fidelity.
- L36 `it("enforces (defKey, version) uniqueness")`
- L42 `it("allows only ONE active version per defKey (partial unique index)")`
- L53 `it("approvals are unique per (definitionId, approverId) and FK-checked")`
- L72 `it("instances and timers FK back to their parents")` — the only timer assertion; it inserts `{ id, instanceId, state, kind: "sla", dueAt }` and expects an FK rejection.

Ancillary pins that touch the same columns: `/opt/hmis/apps/core/src/kernel/db/schema/approvals.test.ts:36,57,76` (FK to `workflow_instances`), `/opt/hmis/apps/core/src/kernel/approvals/requests.test.ts:90` (`timers[0]!.dueAt === instance.stateEnteredAt + 45*60_000`), `/opt/hmis/apps/core/src/kernel/workflow/remediation.test.ts:82`.

---

## 7. Worker

**Job name:** `"runDueTimers"`. Registered in `/opt/hmis/apps/core/src/kernel/worker/jobs.ts:203–207`, verbatim:
```ts
  scheduler.register({
    name: "runDueTimers",
    every: intervals.workerTimersIntervalMs,
    run: async (now) => { await runDueTimers(db, now); },
  });
```
Import at `jobs.ts:6` — `import { runDueTimers } from "../workflow/timers";`. It is the **second** registration, immediately after `runDispatchCycle`. `now` is threaded through, so the scheduler's clock is the one that stamps `fired_at`.

**Cadence:** `intervals.workerTimersIntervalMs`, keyed in the `JobIntervals` `Pick` at `jobs.ts:120` (`| "workerTimersIntervalMs"`). Source of the value: `/opt/hmis/apps/core/src/kernel/config.ts:66`:
```ts
  WORKER_TIMERS_INTERVAL_MS: z.coerce.number().int().positive().default(20000),
```
mapped at `config.ts:405` (`workerTimersIntervalMs: parsed.WORKER_TIMERS_INTERVAL_MS`) and typed at `config.ts:339`. **Default cadence: 20 000 ms (20 s).**

Registration signature, `jobs.ts:190–196`:
```ts
export function registerAllJobs(
  scheduler: Scheduler,
  db: Db,
  registry: ModuleRegistry,
  consumers: Record<string, Handler>,
  intervals: JobIntervals,
): void {
```

**Scheduler censuses that pin the job count — there are FOUR, all currently at 18:**

| File | Pin | Line |
|---|---|---|
| `/opt/hmis/apps/core/src/kernel/worker/jobs.test.ts` | `expect(specs).toHaveLength(18);` | **355** |
| `/opt/hmis/apps/core/src/kernel/worker/scheduler.test.ts` | `const THE_EIGHTEEN = [ … "runDueTimers" … ]` (18 names, registration order) asserted `expect(scheduler.jobs()).toEqual(THE_EIGHTEEN);` | array **332**, assertion **667**, set-equality **714** |
| `/opt/hmis/apps/core/test/worker-runtime.e2e.test.ts` | `const THE_EIGHTEEN = [ … "runDueTimers" … ]` | array **100**, `"runDueTimers"` at **102** |
| `/opt/hmis/apps/core/test/alerts-parity.test.ts` | `expect(registered).toHaveLength(18);` and `expect(new Set(registered).size).toBe(18);` (name list includes `"runDueTimers"` at L117) | **160, 161** |

Also: `scheduler.test.ts:618` puts `CENSUS_INTERVALS.workerTimersIntervalMs` in `INTERVAL_CADENCES_MS` (the "real `every` cadences that can cause an invocation" list), and `scheduler.test.ts:466` sets it to `6 * 60 * 60 * 1000` for the census; `jobs.test.ts:136` uses `20_000`, `jobs.test.ts:297` uses `NINE_HOURS_MS`. `scheduler.test.ts:219–221` spies on `timersMod.runDueTimers`. Heartbeat row key `"runDueTimers"` is pinned in `/opt/hmis/apps/core/src/kernel/db/schema/worker.test.ts:28,30` and `/opt/hmis/apps/core/test/health.e2e.test.ts:90`.

---

## 8. Tests — titles, and the anchoring pins

### `/opt/hmis/apps/core/src/kernel/workflow/timers.test.ts` (172 lines)
- L43 `describe("runDueTimers")`
  - L78 `it("fires a due SLA timer once: sla.breached with the full envelope, then idempotent")`
  - L91 `it("schedules escalation rung 0 after an active-alerting breach, anchored on dueAt")`
  - L103 `it("a record_only breach emits the event but never escalates (§10.3)")`
  - L115 `it("escalation resolves static role holders; ladder climbs rung by rung across calls")`
  - L144 `it("falls back to duty_manager holders when a rung's role is empty (fix 11)")`
  - L161 `it("cancelled timers never fire; a manually-claimed timer is skipped (claim semantics)")`

Fixture at L14–39 uses `sla: { minutes: 30, alerting: "active", escalation: [{ afterMinutes: 10, toRole: "supervisor" }, { afterMinutes: 20, toRole: "department_head" }] }`.

### `/opt/hmis/apps/core/src/kernel/workflow/instances.test.ts` (188 lines)
- L29 `describe("workflow instances")`
  - L59 `it("starts an instance pinned to the active version with the initial SLA timer")`
  - L73 `it("throws no_active_definition for an unknown key")`
  - L79 `it("transitions with an allowed role: history row, timer swap, state move")`
  - L95 `it("denies a user without an allowed role, an agent, and an undeclared transition")`
  - L108 `it("a system actor bypasses the role check (automated moves)")`
  - L116 `it("terminal transition completes the instance, cancels timers, schedules nothing")`
  - L133 `it("an in-flight instance keeps running on its pinned version after a new version activates (§10.2)")`
  - L158 `it("rolls back atomically with the caller's transaction")`
  - L170 `it("exactly one of two concurrent transitions of the same instance applies (single-winner)")`

### `/opt/hmis/apps/core/src/kernel/workflow/definition.test.ts` (190 lines)
- L33 `describe("defineWorkflow")`
  - L34 `it("accepts a valid definition and returns it typed")`
  - L41 `it("round-trips through JSON (parseDefinition on stored jsonb)")`
  - L46 `it("rejects a malformed shape via zod (bad key, empty roles)")`
  - L56 `it("rejects an unknown initialState")`
  - L62 `it("rejects a terminal initialState")`
  - L74 `it("requires at least one terminal state")`
  - L92 `it("requires an SLA on every non-terminal state and forbids it on terminals")`
  - L111 `it("rejects transitions referencing unknown states and duplicates")`
  - L126 `it("rejects outgoing transitions from a terminal state")`
  - L134 `it("rejects duplicate state names")`
  - L142 `it("rejects states unreachable from the initial state")`
  - L161 `it("rejects dangling paths — a reachable state that cannot reach any terminal (spec §18)")`
  - L182 `it("collects every problem into one error")`

### Tests that pin "escalation is scheduled at dueAt + afterMinutes" — the ones a ladder-anchoring change breaks

**(1) `/opt/hmis/apps/core/src/kernel/workflow/timers.test.ts:91–101` — the direct arithmetic pin:**
```ts
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
```

**(2) `/opt/hmis/apps/core/test/worker-runtime.e2e.test.ts:695–709` — the wall-clock pin on the ladder anchor** (45-min SLA, rung 0 at +15):
```ts
    // ——— the breach. 46 minutes in, the 45-minute SLA timer is due.
    expect(await runDueTimers(db, at(T, 46))).toBe(1);
```
```ts
    // ——— the escalation. The ladder anchors on the SLA's dueAt (T+45), so rung 0 is due at T+60.
    expect(await runDueTimers(db, at(T, 61))).toBe(1);
```
If the anchor moves (e.g. to `stateEnteredAt` or to "wall clock at fire"), the `at(T, 61)` instant stops being correct and this goes red. The rest of the test then asserts the rung-0 payload (`rung: 0, role: T6_SUPERVISOR_ROLE, resolvedUserIds: [supervisor.id], fallback: false, fallbackExhausted: false`) and the `alerts` row that follows.

**(3) `/opt/hmis/apps/core/test/approvals-lifecycle.e2e.test.ts:143–153` — pins "one rung per call" *and* the accumulating anchor** (backdate 40 min, rungs at +10/+20, whole chain already due):
```ts
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
```

**(4) `/opt/hmis/apps/core/test/worker-runtime.e2e.test.ts:775–787` — the "drain" test**, which depends on one-rung-per-pass:
```ts
    expect(await runDueTimers(db, at(T, 62))).toBe(3);
    expect(await eventsNamed("sla.breached")).toHaveLength(3);
    expect(await runDueTimers(db, at(T, 62))).toBe(3);
    expect(await eventsNamed("escalation.triggered")).toHaveLength(3);
```

**(5) Adjacent pins on the SLA anchor itself** (`stateEnteredAt + minutes`), which a kernel change to the anchoring would also touch:
- `/opt/hmis/apps/core/src/kernel/workflow/instances.test.ts:69–70`:
  ```ts
    // dueAt = stateEnteredAt + 30 min
    expect(timers[0]!.dueAt.getTime()).toBe(instance!.stateEnteredAt.getTime() + 30 * 60_000);
  ```
- `/opt/hmis/apps/core/src/kernel/approvals/requests.test.ts:90` — `expect(timers[0]!.dueAt.getTime()).toBe(instance!.stateEnteredAt.getTime() + 45 * 60_000);`
- `/opt/hmis/apps/core/src/kernel/workflow/remediation.test.ts:82` — `expect(open[0]!.dueAt.getTime()).toBe(instance!.stateEnteredAt.getTime() + 10 * 60_000); // v2's 10-min SLA`

**(6) `/opt/hmis/apps/core/test/workflow-instances.e2e.test.ts:129–148`** — start → breach → escalate → transition → complete, backdating both the SLA and the escalation timer (so it is anchor-agnostic, but it pins `resolvedUserIds: [dmId]`, i.e. the duty-manager fallback).

---

## 9. `/opt/hmis/apps/core/src/kernel/approvals/flow.ts` (55 lines)

Verbatim, the whole builder plus its schemas (L12–55):
```ts
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

**`closureSlaMinutes` → `sla.minutes` on the `pending` state, one-to-one, with `alerting` hard-coded `"active"`** (L36). The `escalation` key is set **only** when the caller supplies a non-empty array (L37–39); an empty array leaves `sla.escalation` `undefined`.

**Is any `escalation` array actually set in shipped code? — NO, not by any approval-type registrar.** Every production caller omits it. Grep of the registrars:
```
grep -rn "escalation" apps/core/src/modules/*/approval-types.ts apps/core/src/kernel/approvals/
→ only kernel/approvals/flow.ts (the definition), kernel/approvals/requests.ts:26 (a comment),
  kernel/approvals/events.ts:6 (a comment), and kernel/approvals/flow.test.ts (tests)
```
Representative call site, `/opt/hmis/apps/core/src/modules/billing/approval-types.ts:66–71`:
```ts
    const def = approvalFlowDefinition({
      typeKey: typeSpec.typeKey,
      title: typeSpec.title,
      approverRole: typeSpec.approverRole,
      closureSlaMinutes,
    });
```
Identical shape in `modules/patients/approval-types.ts:96–101`, `modules/radiology/approval-types.ts:75–80`, `modules/materials/approval-types.ts:115–120`. **So every approval flow ships with an SLA and an EMPTY ladder** — `runDueTimers` emits `sla.breached` for them and schedules nothing (the `ladder.length > 0` guard at `timers.ts:136`). Escalation ladders *are* set, but only on hand-written module definitions: `modules/opd/workflow-def.ts:21`, `modules/lab/workflow-def.ts:90,93,95,96,99,159,160,161`, `modules/ot/workflow-def.ts:80`.

Downstream consumption of the SLA number: `/opt/hmis/apps/core/src/kernel/approvals/requests.ts:59–60` reads it back off the parsed pinned definition —
```ts
  const slaMinutes = active.parsed.states.find((s) => s.name === "pending")?.sla?.minutes;
```
— and puts it on the `approval.requested` payload (`requests.ts:136`); `startInstance` is called at `requests.ts:94`.

`/opt/hmis/apps/core/src/kernel/approvals/flow.test.ts` titles: `it("emits the canonical three-state flow with the approver role on both transitions")` (L6, asserts `pending?.sla` **toEqual** `{ minutes: 45, alerting: "active" }` — i.e. pins that `escalation` is *absent* when unsupplied), `it("passes an escalation ladder through to the pending state's SLA")` (L28), `it("honors an explicit changeClass override")` (L46), `it("round-trips through JSON and parseDefinition (jsonb fidelity by construction)")` (L57), `it("rejects a malformed spec via zod (bad typeKey, non-positive SLA)")` (L69 — includes `escalation: [{ afterMinutes: 0, toRole: "duty_manager" }]` → `ZodError`), `it("returns a definition defineWorkflow itself accepted …")` (L97).

---

## 10. `OWNER` / `DUTY_MANAGER` role constants — workflow vs alerts

**In the workflow kernel — exactly one constant, and there is no `OWNER_ROLE`:**
- `/opt/hmis/apps/core/src/kernel/workflow/timers.ts:70–71`, verbatim:
  ```ts
  /** §11.19-C fix 11: a ladder never dead-ends silently — duty manager catches empty rungs. */
  export const DUTY_MANAGER_ROLE = "duty_manager";
  ```
- **`OWNER_ROLE` is ABSENT from `apps/core/src/kernel/workflow/`.** Grep:
  ```
  grep -rn "DUTY_MANAGER\|OWNER_ROLE" --include=*.ts apps/core/src/kernel/workflow/
  → timers.ts:71 (the export), timers.ts:153 (the use),
    timers.test.ts:3,146,147 (import + fixture)
  ```
  The literal `"owner"` appears in workflow only as a *governance approval role* in `definitions.ts:92` — `requiredRoles: ["owner", "medical_superintendent"]` — and in `governance.test.ts` fixtures (L39, 42, 74, …). Not a role constant.

**In alerts — both, and they are separate declarations (not re-exports of the workflow one):**
- `/opt/hmis/apps/core/src/kernel/alerts/consumer.ts:20–24`, verbatim:
  ```ts
  /**
   * `fallbackExhausted` means the ladder rung resolved to nobody AND duty_manager resolved to
   * nobody (§11.19-C fix 11). The last rung is the owner — every holder of this role. The
   * owner-SMS half of fix 11 is Plan 10's and lives in `kernel/notify/consumer.ts`.
   */
  export const OWNER_ROLE = "owner";
  ```
- `/opt/hmis/apps/core/src/kernel/alerts/consumer.ts:26–31`, verbatim:
  ```ts
  /**
   * Plan 10 D6: who picks up the phone when the gateway could not reach a patient. No
   * registration/front-desk role is seeded today (measured at plan time), so the desk task lands
   * with the duty managers; when a front-desk role exists this constant is the one line to change.
   */
  export const DUTY_MANAGER_ROLE = "duty_manager";
  ```
  **`alerts/consumer.ts:DUTY_MANAGER_ROLE` is a DUPLICATE STRING of `timers.ts:DUTY_MANAGER_ROLE`, declared independently** — `consumer.ts` imports only `usersHoldingRole` and `escalationTriggered` from workflow (`consumer.ts:8,11`), not the constant. Two sources of truth for `"duty_manager"`.

**Where the ladder's third rung actually lives** — `/opt/hmis/apps/core/src/kernel/alerts/consumer.ts:192–211`, verbatim:
```ts
async function handleEscalationTriggered(db: Db, e: DispatchedEvent): Promise<void> {
  const payload = escalationTriggered.payloadSchema.parse(e.payload);

  // Resolved in its own read transaction because `usersHoldingRole` is Tx-typed.
  const recipients = payload.fallbackExhausted
    ? await withTx(db, (tx) => usersHoldingRole(tx, OWNER_ROLE))
    : payload.resolvedUserIds;

  const title = `Escalation: ${payload.defKey} · ${payload.state} · rung ${payload.rung}`;
  const body = payload.fallbackExhausted
    ? `Escalation ladder exhausted at role ${payload.role} — routed to the ${OWNER_ROLE} role.`
    : `Escalated to role ${payload.role}.`;

  await raiseAlerts(db, e, recipients, {
    kind: ALERT_KIND_ESCALATION,
    title,
    body,
    refType: ALERT_REF_TYPE,
    refId: payload.instanceId,
  });
}
```
So the effective ladder is **three tiers, split across two modules**: `toRole` → `duty_manager` (both in `timers.ts`), then `owner` (only in `alerts/consumer.ts`, at delivery time, keyed off `fallbackExhausted`). The owner tier is *not* a timer rung and never produces an `escalation.triggered` event of its own. Related constants: `ALERT_KIND_ESCALATION = "escalation"` (`consumer.ts:32`), `ALERT_REF_TYPE = "workflow_instance"` (`consumer.ts:33`). The SMS half is `/opt/hmis/apps/core/src/kernel/notify/consumer.ts:230` — `for (const userId of await usersHoldingRole(tx, OWNER_ROLE))`.

---

## Things that do not exist (with the greps)

| Asked for | Verdict | Grep |
|---|---|---|
| Named `EscalationRung` type in workflow | **absent** (exists only in `approvals/flow.ts:28`) | `grep -rn "EscalationRung" --include=*.ts apps/ packages/` |
| `WorkflowValidationError` error *codes* | **absent** — the class carries `problems: string[]`, no `code` | `grep -n "code" apps/core/src/kernel/workflow/definition.ts` → no matches |
| `FOR UPDATE SKIP LOCKED` in the timer claim | **absent** — conditional `UPDATE … RETURNING` instead | `grep -rn "SKIP LOCKED\|FOR UPDATE\|forUpdate" --include=*.ts apps/core/src/kernel/` → no `kernel/workflow/*` hit |
| A dedicated `claim` helper in `timers.ts` | **absent** — inlined in `runDueTimers` | `grep -n "claim" apps/core/src/kernel/workflow/timers.ts` |
| `information_schema` column census of `workflow_*` tables | **absent** | `grep -rln "information_schema" --include=*.test.ts apps/core/src apps/core/test` then `grep -i workflow` on each — only `ot.test.ts` / `radiology.test.ts`, and only for their own `workflow_instance_id` columns |
| Unique constraint / CHECK on `workflow_timers` | **absent** — two btree indexes only (`due_at`, `instance_id`) | `db/schema/workflow.ts:95–98` and `drizzle/0004_white_hydra.sql:75–76` |
| Ordering/monotonicity validation of `afterMinutes` across rungs | **absent** | no sorting or comparison logic anywhere in `definition.ts` |
| Self-transition (`from === to`) rejection | **absent** | `grep -n "t.from === t.to\|from === to" definition.ts definitions.ts` → no output |
| `OWNER_ROLE` in `kernel/workflow/` | **absent** | `grep -rn "OWNER_ROLE" --include=*.ts apps/core/src/kernel/workflow/` → no matches |
| A migration altering `workflow_timers` after 0004 | **absent** | `grep -rln "workflow" apps/core/drizzle/*.sql` → later files reference only other tables' `workflow_instance_id` |

## Planning notes worth flagging for a ladder-anchoring change

1. **The anchor is a chain, not a fan-out.** `from: timer.dueAt` at both `timers.ts:142` and `timers.ts:179` makes `afterMinutes` an inter-rung delta. Changing it to "offset from breach" changes rung k from `Σ afterMinutes[0..k]` to `afterMinutes[k]` — silently re-times every shipped ladder in `modules/lab/workflow-def.ts`, `modules/opd/workflow-def.ts`, `modules/ot/workflow-def.ts`.
2. **Rung state lives only on the timer row.** `cancelOpenTimers` is instance-wide and unconditional, so any transition (including a self-transition) resets the ladder to rung 0. There is no `workflow_instances` column recording ladder progress.
3. **The fire path uses non-null assertions on the pinned definition** (`timers.ts:109,110,147`). A change that lengthens/shortens ladders while timers are open on a migrated instance can throw at `ladder[rung]!`.
4. **Four job censuses pin 18** (§7) — a ladder change that does not register a job leaves them alone, but any new worker job touches all four plus `alerts.yml`.
5. **The `"duty_manager"` string is declared twice** (`timers.ts:71`, `alerts/consumer.ts:31`), and the `owner` tier is enforced at *delivery*, not in the kernel ladder.