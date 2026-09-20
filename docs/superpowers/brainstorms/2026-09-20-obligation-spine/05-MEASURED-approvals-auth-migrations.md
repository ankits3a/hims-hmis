> Measured 2026-09-20 on `main` @ 21fe8912 by a read-only subagent for the obligation-spine implementation plan. Line numbers are from that commit; re-measure any line a task cites before editing it.

# HMIS MEASUREMENT DOSSIER — read-only, `/opt/hmis`, branch `main` @ `21fe8912` (nothing edited)

Working tree clean except one untracked docs dir (`docs/superpowers/brainstorms/2026-09-01-hermes-ops-copilot/`).

---

## 1. `apps/core/src/kernel/db/schema/approvals.ts`

**The file holds exactly TWO tables** (`approval_types`, `approvals`) and nothing else. Full file is 61 lines. Verbatim:

`/opt/hmis/apps/core/src/kernel/db/schema/approvals.ts:1-3` (imports)
```ts
import {
  bigint, boolean, index, pgTable, text, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core";
import { workflowInstances } from "./workflow";
```

`/opt/hmis/apps/core/src/kernel/db/schema/approvals.ts:10-23`
```ts
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
```

`/opt/hmis/apps/core/src/kernel/db/schema/approvals.ts:29-61`
```ts
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

Note: **no CHECK constraints at all** on either table — `status` and `urgencyClass` are bare `text` with a comment enumerating values.

### The census test that pins them
`/opt/hmis/apps/core/src/kernel/db/schema/approvals.test.ts` (108 lines, 3 tests). Header:
```ts
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { approvalTypes, approvals } from "./approvals";
import { workflowDefinitions, workflowInstances } from "./workflow";
import type { Db } from "../client";
```
Three `it(...)` blocks, lines 40 / 57 / 79:
- `"applies defaults on approval_types and enforces its primary key"` — pins `urgencyClass === "routine"`, `actFirstAllowed === false`, PK rejection.
- `"FK-checks approvals against approval_types and workflow_instances"`.
- `"applies defaults, keeps one approval per instance, and round-trips bigint paise as numbers"` — pins `status === "pending"`, `actedFirst === false`, `typeof amountPaise === "number"`, `123_456_789_012` round-trip, and the `approvals_instance_ux` rejection.

The test seeds a workflow definition + instance first (`seedInstance`, lines 28-38) using `DEF_JSON` (lines 6-20) with states `pending`/`granted`/`rejected` and `sla: { minutes: 45, alerting: "active" }`.

---

## 2. `apps/core/src/kernel/approvals/` — shipped signatures

Files (line counts): `approvals.controller.ts` 160, `approvals.module.ts` 7, `cumulative.ts` 70, `decisions.ts` 98, `events.ts` 41, `flow.ts` 55, `manifest.ts` 14, `people.ts` 93, `requests.ts` 148, `types.ts` 107, `worklist.ts` 96 (+ matching `.test.ts` for each).

### 2a. `decisions.ts` — exports `approveRequest` / `rejectRequest`, NOT `decideApproval`

`/opt/hmis/apps/core/src/kernel/approvals/decisions.ts:14-16`
```ts
export const REQUESTER_APPROVER_PAIR = "requester_approver";

export type DecisionInput = { approvalId: string; note: string };
```

`/opt/hmis/apps/core/src/kernel/approvals/decisions.ts:92-98`
```ts
export async function approveRequest(db: Db, actor: Actor, input: DecisionInput): Promise<{ status: "granted" }> {
  return decide(db, actor, input, "granted");
}

export async function rejectRequest(db: Db, actor: Actor, input: DecisionInput): Promise<{ status: "rejected" }> {
  return decide(db, actor, input, "rejected");
}
```

The private worker, `/opt/hmis/apps/core/src/kernel/approvals/decisions.ts:29-90` (verbatim, this is the SoD + single-winner core):
```ts
async function decide<V extends "granted" | "rejected">(
  db: Db,
  actor: Actor,
  input: DecisionInput,
  verdict: V,
): Promise<{ status: V }> {
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
```

Docstring at lines 18-28 states, verbatim: *"A decision is a Plan 03 transition (owner decision Q1a): transition() is the single-winner arbiter (conditional UPDATE on the instance's current state) … There is deliberately NO emergency bypass of requester≠approver here."*

**The SoD helper it calls** — `/opt/hmis/apps/core/src/kernel/auth/sod.ts:36-68`:
```ts
export class SodViolationError extends Error {
  constructor(readonly pairKey: string) {
    super(`segregation-of-duties violation: ${pairKey}`);
    this.name = "SodViolationError";
  }
}

export async function assertNotSodPair(
  db: Db,
  pairKey: string,
  actorA: Actor,
  actorB: Actor,
): Promise<void> {
  const known = await db.select({ pairKey: sodPairs.pairKey }).from(sodPairs).where(eq(sodPairs.pairKey, pairKey));
  if (known.length === 0) throw new Error(`unknown SoD pair key: ${pairKey}`);
  if (actorA.type !== actorB.type || actorA.id !== actorB.id) return;
  // Own transaction on `db`, never the caller's tx: the block must survive the caller's rollback.
  await withTx(db, (tx) => appendEvent(tx, sodViolationBlocked.make({ … })));
```
(it then throws `SodViolationError`). **Note for sequential dual control: the check is identity-only — `actorA.id === actorB.id`. There is no "two distinct approvers in sequence" machinery anywhere.**

### 2b. `worklist.ts` — exports

`/opt/hmis/apps/core/src/kernel/approvals/worklist.ts:16` — `export async function rolesHeldBy(tx: Tx, userId: string): Promise<string[]>` (permanent `roleAssignments` at ANY scope ∪ unexpired `tempRoleGrants`, deduped and `.sort()`ed).

`/opt/hmis/apps/core/src/kernel/approvals/worklist.ts:28-38`
```ts
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
```

`/opt/hmis/apps/core/src/kernel/approvals/worklist.ts:51-91` (the list query, verbatim body):
```ts
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
    const order = (filters.status ?? "pending") === "pending"
      ? [urgencyRank, asc(approvals.requestedAt)]
      : [desc(approvals.decidedAt), desc(approvals.id)];
    const items = await tx
      .select()
      .from(approvals)
      .where(where)
      .orderBy(...order)
      .limit(limit)
      .offset(offset);
    const counted = await tx.select({ n: sql<string>`count(*)` }).from(approvals).where(where);
    return { items, total: Number(counted[0]!.n) }; // count(*) arrives as text — force a real number
  });
}
```

**THE ORDERING CLAUSE, isolated (this is the line your derived-priority columns would displace):**
```ts
const urgencyRank = sql<number>`case ${approvals.urgencyClass} when 'emergency' then 0 when 'urgent' then 1 else 2 end`;
const order = (filters.status ?? "pending") === "pending"
  ? [urgencyRank, asc(approvals.requestedAt)]
  : [desc(approvals.decidedAt), desc(approvals.id)];
```

`/opt/hmis/apps/core/src/kernel/approvals/worklist.ts:93-96`
```ts
export async function getApproval(db: Db, approvalId: string): Promise<ApprovalRow | null> {
  const rows = await db.select().from(approvals).where(eq(approvals.id, approvalId));
  return rows[0] ?? null;
}
```
`getApproval` has 14 cross-module importers (billing invoices/refunds/credit-notes/sessions, patients/merge, radiology/definitions, materials adjustments/vendors/grn, tariff/versions, membership/recognition, ot deposit/definitions).

**`worklist.ts` writes NO PHI audit.** The audit surface name `approvals.worklist` is written in `people.ts` only (see 2c) and declared in `phi/audit.ts:226`.

### 2c. `people.ts` — exports

`/opt/hmis/apps/core/src/kernel/approvals/people.ts:23-37`
```ts
export type ApprovalPatient = {
  id: string;
  uhid: string;
  name: string | null;
  alias: string | null;
  restricted: boolean;
};

export type ApprovalListItem = ApprovalRow & {
  /** `users.full_name` of the requester; null only for an id no user row answers to. */
  requesterName: string | null;
  decidedByName: string | null;
  /** Null when the request names no patient, or names an id the patients table does not hold. */
  patient: ApprovalPatient | null;
};
```

`/opt/hmis/apps/core/src/kernel/approvals/people.ts:51-56` (signature) and `:76-79` (the PHI write):
```ts
export async function withPeople(
  db: Db,
  actor: Actor,
  rows: readonly ApprovalRow[],
  reason: string,
): Promise<ApprovalListItem[]> {
```
```ts
      await recordPhiAccess(db, {
        actor, patientId, surface: "approvals.worklist", reason, sealed: sealedOf.get(patientId) ?? false,
      });
```
One row per **distinct canonical** patient (`canonical = [...new Set(summaries.map((s) => s.id))]`, line 67); `sealed` read separately from `patients.isConfidential` (lines 70-74). Names come from `getPatientSummaries(db, actor, patientIds)` imported from `../../modules/patients` (line 11).

Pins: `/opt/hmis/apps/core/src/kernel/approvals/people.test.ts:86-94` (`"logs one approvals.worklist row per distinct patient, sealed where the record is"`) and `:96-105` (merged record resolves to survivor; unknown id logs nothing). E2E pin at `/opt/hmis/apps/core/test/approvals.e2e.test.ts:195-196`:
```ts
const logged = await db.select().from(phiAccessLog).where(eq(phiAccessLog.surface, "approvals.worklist"));
expect(logged.map((r) => [r.patientId, r.sealed]).sort()).toEqual([[PLAIN, false], [SEALED, true]].sort());
```

### 2d. `approvals.controller.ts` — routes verbatim

`@Controller("approvals")`, `/opt/hmis/apps/core/src/kernel/approvals/approvals.controller.ts:67-69`. Zod bodies at lines 34-65. Error map `toHttp` at lines 22-32: `SodViolationError`→403, `ApprovalError` `unknown_approval`→404 / `not_pending`→409 / else 400, `WorkflowError`→409.

| line | decorators | handler | response |
|---|---|---|---|
| 72-73 | `@RequirePermission("approvals.types.manage", "hospital")` `@Post("types")` | `registerType(@CurrentActor() actor, @Body() body)` | `Promise<{ typeKey: string; defKey: string }>` |
| 87-88 | `@RequirePermission("approvals.requests.create", "hospital")` `@Post()` | `create(@CurrentActor() actor, @Body() body)` | `Promise<{ approvalId: string; instanceId: string }>` |
| 102-103 | `@RequirePermission("approvals.requests.read", "hospital")` `@Get()` | `list(@CurrentActor() actor, @Query() query)` | `Promise<{ items: ApprovalListItem[]; total: number }>` |
| 121-122 | `@RequirePermission("approvals.requests.read", "hospital")` `@Get(":id")` | `detail(@Param("id") id)` | `Promise<{ approval: ApprovalRow }>` |
| 129-130 | `@RequirePermission("approvals.requests.decide", "hospital")` `@Post(":id/approve")` | `approve(actor, id, body)` | `Promise<{ status: "granted" }>` |
| 145-146 | `@RequirePermission("approvals.requests.decide", "hospital")` `@Post(":id/reject")` | `reject(actor, id, body)` | `Promise<{ status: "rejected" }>` |

Comment at line 71 verbatim: `// Literal segment declared BEFORE the :id routes — Nest matches in declaration order.`

The `list` body, lines 108-118 (this is where `withPeople` and the reason string are wired):
```ts
    const parsed = worklistQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    try {
      const listed = await listApprovals(this.db, actor, parsed.data);
      const reason = `approvals worklist (${parsed.data.status ?? "pending"}), ${String(listed.items.length)} rows`;
      return { items: await withPeople(this.db, actor, listed.items, reason), total: listed.total };
```
Query schema (lines 57-65) — note `@Get(":id")` `detail` returns the bare `ApprovalRow` with **no** `withPeople` enrichment and no PHI log.

### 2e. `manifest.ts` — verbatim, whole file (14 lines)

`/opt/hmis/apps/core/src/kernel/approvals/manifest.ts`
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
(Menu is empty here; the inbox nav entry lives in the web router — see §4.)

### 2f. Other exports in the folder (for completeness)
- `types.ts`: `URGENCY_CLASSES = ["routine","urgent","emergency"] as const` (:9), `UrgencyClass` (:10), `ApprovalErrorCode` (:12), `class ApprovalError` (:27), `ApprovalTypeRow` (:37), `ApprovalTypeSpec` (:39), `registerApprovalType(...)` (:55), `getApprovalType(tx, typeKey)` (:104).
- `requests.ts`: `ApprovalRequestInput` (:13), `requestApproval(...)` (:30).
- `cumulative.ts`: `IST_UTC_OFFSET_MINUTES = 330` (:14), `istDayString(at)` (:29), `istDayWindow(now)` (:33), `CumulativeQuery` (:40), `cumulativeAmount(tx, q)` (:47).
- `flow.ts`: `APPROVAL_DEF_PREFIX = "approval_"` (:12), `EscalationRung` (:28), `ApprovalFlowSpec` (:29), `approvalFlowDefinition(spec)` (:31).
- `events.ts`: `approvalRequested` (:10), `approvalGranted = defineEvent("approval.granted", "approvals", decisionPayload)` (:40), `approvalRejected = defineEvent("approval.rejected", …)` (:41).

---

## 3. Standing policy / auto-grant — **ABSENT**

Greps run (from `/opt/hmis`):
```
grep -rnE "auto_grant|autoGrant" apps/core/src --include=*.ts            →  0 hits
grep -rniE "approval_polic|approvalPolic|standing_approval|standingApproval" apps/core/src --include=*.ts  →  0 hits
grep -rniE "delay_ledger|delayLedger|approval_delays" apps/core/src --include=*.ts  →  0 hits
grep -rniE "policy|auto.?grant|standing|delegat" apps/core/src/kernel/approvals/
```
The last one's ONLY hits are four test *strings* in `decisions.test.ts` (lines 62, 66, 79, 85: `"verified against policy"`, `"policy cap exceeded"`).

Elsewhere `standing` appears only as `standingRuleSource` in `modules/tariff` (a pricing discount source, unrelated), and `policy` as `kernel/auth/password-policy.ts`. **There is no approvals policy table, no auto-grant code, and no delay ledger anywhere in `apps/core/src`.**

---

## 4. Web approvals

### 4a. `apps/web/src/lib/approvals-api.ts` — **ABSENT**
```
find apps/web -name "*approval*" -not -path "*/node_modules/*"
  → apps/web/src/screens/approval-kinds.ts
  → apps/web/src/screens/approvals-inbox.test.tsx
  → apps/web/src/screens/approvals-inbox.tsx
```
There is **no approvals API module**. The inbox calls the generic `api` helper from `../lib/api` directly. The only wire type is declared inside the screen, `/opt/hmis/apps/web/src/screens/approvals-inbox.tsx:42-63`:
```ts
type ApprovalItem = {
  id: string;
  typeKey: string;
  requesterId: string;
  requesterName: string | null;
  urgencyClass: "routine" | "urgent" | "emergency";
  patientId: string | null;
  payeeId: string | null;
  patient: ApprovalPatient | null;
  amountPaise: number | null;
  cumulativePatientPaise: number | null;
  cumulativePayeePaise: number | null;
  requestNote: string | null;
  status: "pending" | "granted" | "rejected";
  decisionNote: string | null;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  requestedAt: string;
};

type ApprovalList = { items: ApprovalItem[]; total: number };
```
(Other modules DO have `lib/<module>-api.ts` — e.g. `lib/materials-api.ts:197` `requestNearExpiry`, `lib/lab-api.ts:481-491` which POSTs `/approvals` directly. So both precedents exist; approvals itself has none.)

### 4b. `apps/web/src/screens/approvals-inbox.tsx` (531 lines) — structure

Imports (lines 1-14): `useQuery, useQueryClient` from `@tanstack/react-query`, `useNavigate` from `@tanstack/react-router`, `useTranslation`, `lucide-react` icons, `api` from `../lib/api`, `useAuth` from `../lib/auth`, `fmtRupees` from `../lib/format`, `PaperScreen, ScreenTitle` from `../components/paper-screen`, shadcn `Dialog…`/`Tabs…`, and `APPROVAL_KINDS, ageOf, decisionErrorKey, isKnownKind, patientName` from `./approval-kinds`.

Components / functions, in file order:
| line | symbol | role |
|---|---|---|
| 70 | `async function fetchList(path: string): Promise<ApprovalList>` | `api<ApprovalList>("GET", path)` + null-coalesces the three name fields |
| 84 | `const DECIDED_PAGE = 25` | |
| 86-87 | `APPROVE_PRESETS = ["asRequested","oneTime","checked"]`, `REJECT_PRESETS = ["tooHigh","unclear","talkFirst","policy","duplicate"]` | |
| 92 | `headline(item, t)` | picks `inbox.kinds.<typeKey>.ask` or falls back to `.label` when a `needs` value is missing |
| 103 / 107 | `kindLabel` / `kindExplain` | |
| 111 | `age(iso, t)` | |
| 122 | `sameDayLine(item, t)` | C-12 line from `cumulative*Paise − amountPaise` |
| 134 | `UrgencyPill` | renders nothing for `routine` |
| 144 | `ApprovalCard` | `<article className="box" data-approval-id={item.id} aria-label={headline(...)}>` |
| 246 | `DecidedFooter` | |
| 270 | `DecisionDialog` | the one confirm step |
| 401 | `tabStyle(active)` | |
| 405 | **`export function ApprovalsInbox(): React.ReactElement`** | the screen |
| 511 | `ListBody` | error / loading / empty / list |

**API calls (exactly three paths):**
- `/opt/hmis/apps/web/src/screens/approvals-inbox.tsx:412-415` — pending query: `queryKey: ["approvals","pending"], queryFn: () => fetchList("/approvals")`
- `:421-433` — decided query (`enabled: tab === "decided"`), TWO parallel fetches then merged client-side:
```ts
      const [granted, rejected] = await Promise.all([
        fetchList(`/approvals?status=granted&limit=${String(DECIDED_PAGE)}`),
        fetchList(`/approvals?status=rejected&limit=${String(DECIDED_PAGE)}`),
      ]);
      return [...granted.items, ...rejected.items]
        .sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? ""))
        .slice(0, DECIDED_PAGE);
```
- `:294-295` — the decision POST, inside `DecisionDialog.submit`:
```ts
      await api("POST", `/approvals/${item.id}/${verdict}`, { note: note.trim() });
      await queryClient.invalidateQueries({ queryKey: ["approvals"] });
```

**Where the decision buttons are:** `ApprovalCard`, lines 160-173. Gating is three-way:
```ts
  const actions = decided || canDecide === null ? null : isOwn ? (
    <p role="note" …>{t("inbox.ownRequest")}</p>
  ) : !canDecide ? (
    <p role="note" …>{t("inbox.cannotDecide")}</p>
  ) : (
    <>
      <button type="button" className="sec" … onClick={() => onDecide?.("reject")}>{t("inbox.reject")}</button>
      <button type="button" className="pri" … onClick={() => onDecide?.("approve")}>{t("inbox.approve")}</button>
    </>
  );
```
with `const canDecide = ready ? can("approvals.requests.decide") : null;` (line 435) and `isOwn={actor !== null && actor.id === item.requesterId}` (line 480). Clicking sets `deciding` state → renders `DecisionDialog` (lines 495-506, keyed `${id}-${verdict}`).

Router wiring: `/opt/hmis/apps/web/src/router.tsx:30` import, `:162` nav entry `{ to: "/approvals", label: "nav.approvals", permission: "approvals.requests.read", group: "admin" }`, `:808-811` `createRoute({ path: "/approvals", component: ApprovalsInbox })`, `:1278` in the children array.

### 4c. `approval-kinds.ts` — path and record shape

**Path: `/opt/hmis/apps/web/src/screens/approval-kinds.ts`** (94 lines; it is a *screens* file, not a lib file).

The map is `typeKey → readonly Need[]` — lines 23-48 verbatim:
```ts
export type Need = "amount" | "patient";

export const APPROVAL_KINDS = {
  billing_discount: ["amount", "patient"],
  billing_clearance_discount: ["amount", "patient"],
  billing_credit_extension: ["patient"],
  billing_refund: ["amount", "patient"],
  billing_variance: [],
  lab_release_unpaid: ["amount", "patient"],
  patient_merge: ["patient"],
  patient_unmerge: ["patient"],
  materials_stock_adjustment: [],
  materials_near_expiry_acceptance: [],
  materials_vendor_bank_change: [],
  imaging_definition_publish: [],
  ot_definition_publish: [],
  ot_deposit_exception: ["amount", "patient"],
  tariff_revision: [],
  membership_grace_honor: ["patient"],
} as const satisfies Record<string, readonly Need[]>;

export type KnownKind = keyof typeof APPROVAL_KINDS;

export function isKnownKind(typeKey: string): typeKey is KnownKind {
  return Object.prototype.hasOwnProperty.call(APPROVAL_KINDS, typeKey);
}
```
(16 kinds.) Its header comment (lines 10-21) records the measurement command verbatim: `` grep -rn 'typeKey' apps/core/src/modules/*\/approval-types.ts `` (measured 2026-09-19), and states each kind needs three strings under `inbox.kinds.<typeKey>`: `label` / `ask` / `explain`.

**The record shape for ONE kind** is split across two files. Map entry: `billing_refund: ["amount", "patient"],`. Locale record, `/opt/hmis/apps/web/src/locales/en.json` under `inbox.kinds.billing_refund` (also present in `hi.json`):
```json
"billing_refund": {
  "label": "Refund",
  "ask": "Refund {{amount}} to {{patient}}",
  "explain": "Money goes back to the patient."
}
```
`inbox.kinds` has 16 entries; the fallback is `inbox.unknownKind` = `{"label":"Approval request","explain":"This kind of request has no description on this screen yet."}`.

Also exported from `approval-kinds.ts`: `ApprovalPatient` type (:51-57), `patientName(p)` (:64), `ageOf(iso, now?): { key: string; count: number }` (:70), `decisionErrorKey(e): string` (:85 — 403/409/404/400 → `inbox.errors.*`).

---

## 5. Permissions recipe

### 5a. `apps/core/scripts/seed-roles.ts` (2038 lines) — structure

Imports at :1-12 (`createRole, grantPermissionToRole, syncPermissions` from `../src/kernel/auth/permissions`; `ModuleRegistry`; `ALL_MANIFESTS`; `OPD_ROLE_KEYS` from `../src/modules/opd/config`).

Types (:65-68):
```ts
/** One role and every permission the model grants it. */
export type RoleGrants = { roleKey: string; permissions: readonly string[] };

/** A declared permission no role holds yet, with the reason no grant was invented for it. */
export type NotYetModelled = { permission: string; reason: string };
```

**A permission is declared** on a module manifest (`permissions: [...]`), never here — the header says so at :49-52 verbatim: *"IT FOLLOWS THE MANIFESTS, NOT THE README. `grantPermissionToRole` refuses any string `registry.allPermissions()` does not contain."*

**A role gets it** by appending the string (with a doc-comment giving the ruling) to that role's entry in `export const ROLE_MODEL: readonly RoleGrants[] = [ … ]` (starts around :166). The script then (per header :38-46): installs `ALL_MANIFESTS` + `syncPermissions` (catalog first, because `role_permissions.permission` FKs `permissions.permission`), `ensureRole`s each model role, grants each permission skipping existing rows, checks the reachability invariant (declared = held + `NOT_YET_MODELLED`), counts holders, prints a verdict. Exports consumed by the test: `GRANTED_BY_OTHER_SEEDS, LOCAL_ROLE_TITLES, NOT_YET_MODELLED, ROLE_MODEL, heldInDatabase, heldPermissions, modelPermissions, formatReport, roleTitle, seedRoles`.

### 5b. `apps/core/test/seed-roles.test.ts` (2078 lines) — pinned numbers, current main, verbatim

The five legs are named in the header (:26-52): V1 declared, V2 reachability, V3 README parity both directions, V5 idempotence, plus the §2.49 vacuity guards.

```ts
:1038  expect(installedRegistry().allPermissions()).toHaveLength(175); // OPD day report: +1, opd.reports.read; P20: +1, pharmacy.downtime.enter; …
:1267  expect(modelPairs()).toHaveLength(355); // OPD day report: +3 (opd.reports.read to front_office_supervisor, owner, medical_superintendent); …
:1285  expect(modelPermissions()).toHaveLength(155); // OPD day report: +1, opd.reports.read; …
:1296  expect(installedRegistry().allPermissions()).toHaveLength(175); // (the reachability test's own re-pin)
:1356  expect(heldPermissions()).toHaveLength(161); // OPD day report: +1, granted where it is declared; …
:1359  expect(NOT_YET_MODELLED).toHaveLength(14); // 17c owner ruling: approvals.requests.create is held now
:1360  expect(heldPermissions().length + NOT_YET_MODELLED.length).toBe(175);
:1754  expect(NON_TABLE_PAIRS).toHaveLength(169); // OPD day report: +3, OPD_DAY_REPORT_PAIRS; …
:1895  expect(first.declared).toBe(175);
:1904  expect(first.held).toBe(155);
:1905  expect(first.held).toBe(modelPermissions().length);
:1906  expect(heldPermissions()).toHaveLength(161);
```
Test titles that carry stale prose worth knowing about: `:1293` reads `it("the reachability census closes: 161 declared = 147 held + 14 not yet modelled", …)` and `:944` reads `it("ALL_MANIFESTS declares one hundred and thirty-four permissions, by module", …)` — both sentences lag their assertions.

The per-module manifest census (`:945-1037`) is an `expect(Object.fromEntries(byKey)).toEqual({ auth: 7, workflow: 8, approvals: 4, patients: 7, tariff: 5, opd: 20, billing: 14, alerts: 0, ops: 3, membership: 8, partners: 7, formulary: 3, resources: 1, lab: 19, materials: 13, … })`. **`approvals: 4` is the number your new approvals permissions move.**

Table-shape pins (`it("the README carries exactly four permission tables, of the measured shapes")` — the title says four, the assertion says seven):
```ts
expect(tables).toHaveLength(7);
expect(opdTable.rowCount).toBe(16);  expect(opdTable.cells.size).toBe(16);  expect(tablePairs(opdTable)).toHaveLength(33);
expect(billingTable.roles).toEqual(["cashier", "billing_manager"]);
expect(billingTable.rowCount).toBe(15);  expect(billingTable.cells.size).toBe(16);
expect(billingTable.cells.get("approvals.requests.read")).toEqual(["billing_manager"]);
expect(billingTable.cells.get("approvals.requests.decide")).toEqual(["billing_manager"]);
expect(tablePairs(billingTable)).toHaveLength(17);
expect(tablePairs(otTable)).toHaveLength(32);
expect(tablePairs(labTable)).toHaveLength(30);
```
Two bare-integer per-role arrays (the ones the file warns *"nothing names it and no grep finds it"*), at `:1893` (`first.roles.map(r => r.granted.length)`) and `:1933` (`second.roles.map(r => r.already.length)`), both currently:
```ts
[13, 18, 6, 21, 15, 8, 1, 28, 14, 20, 16, 15, 1, 3, 3, 3, 5, 1, 13, 7, 15, 9, 4, 4, 3, 6, 17, 9, 4, 17, 15, 10, 13, 4, 3, 1, 2, 5, 3]
```
Per-role pins (a subset, `:1121`+): `front_office_supervisor: 18`, `vitals_desk: 6`, `owner: 16`, `medical_superintendent: 15`, `duty_manager: 1`, `staff_auditor: 3`.

### 5c. How README prose is parsed — which section and format

**Two mechanisms, both in the test file, both over the whole `README.md` read once at `:885`: `const readme = readFileSync(README, "utf8");`** where `README = resolve(REPO_ROOT, "README.md")` (`:57-58`).

**(i) The markdown TABLES.** `permissionTables(source, label)` at `:796-861` scans every line for `/^\|\s*Permission\s*\|/`, requires the next line to match `SEPARATOR_RE = /^\|(?:\s*:?-{2,}:?\s*\|)+$/` with matching column count, then reads rows until a non-`|` line. Cells must be exactly `"✓"` or `""` — anything else throws `"neither a tick nor blank — this parser is stale"`. Permission cells must match
```ts
const PERMISSION_RE = /^`([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)`$/;
const SHORTHAND_RE  = /^`([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)`\s*\/\s*`(\.[a-z][a-z0-9_]*)`$/;
```
The shorthand `` `a.b.c` / `.d` `` is EXPANDED into two permissions (`expandPermissionCell`, `:773-792`) — the approvals row in the billing table is exactly this. Every parser branch throws rather than returning `[]`; `permissionTables` throws if it finds zero tables. Tables are identified by their **first role column**, `:886-931`: `opdTable` ← `front_office`, `billingTable` ← `cashier`, `materialsTable` ← `materials_head`, `otTable` ← `ot_incharge`, `labTable` ← `pathologist`, `radiologyTable` ← `radiologist`, `pharmacyTable` ← `pharmacy`. So the README sections are *"Permissions (14) and the recommended grants"* (OPD) and *"Recommended permission grants"* (billing) plus five later module tables — named in `seed-roles.ts`'s own header `:72-75`.

**(ii) The PROSE lines, for grants that appear in NO table.** Each ruling declares a named `*_README_PROSE` constant holding a **verbatim substring** of the README paragraph, plus a `*_PAIRS: readonly string[]` array of `"role/permission"` strings that is spread into `NON_TABLE_PAIRS` (`:744-751`). The assertion is a plain `expect(readme).toContain(<CONST>)` inside the test at `~:1800-1810`. There are ~20 such constants (`RULING_7_README_PROSE`, `WORKFLOW_RULING_README_PROSE`, `PLAN_09_README_PROSE`, `GROUP_A/B/C`, `MERGE_LANE`, `FORMULARY`, `RESOURCES`, `OT`, `CASHIER_SEAT`, `PHARMACY`, `PHARMACY_REFUND`, `H1_SEALED`, `RETAIL`, `LAB_RELEASE_REQUEST`, `HISTORY_HORIZON`, `OPD_DAY_REPORT`, …). **This is the exact recipe your new approvals/roster/tasks permissions must follow.**

### 5d. `git show 775a85da --stat` (the `opd.reports.read` precedent)

```
commit 775a85da5248acddeffda4696474341c2f8eba3b
Author: ankits3a <ankit.s3a@gmail.com>
Date:   Sun Sep 20 03:19:54 2026 +0530

    The OPD day report: the hospital's day by department on the letterhead, PDF and CSV, from the dashboard (#257)

 README.md                                          |  12 +
 apps/core/scripts/seed-roles.ts                    |  17 +
 apps/core/src/modules/opd/day-report-render.ts     | 249 +++++++++++++++
 apps/core/src/modules/opd/day-report.test.ts       | 223 +++++++++++++
 apps/core/src/modules/opd/day-report.ts            | 350 +++++++++++++++++++++
 apps/core/src/modules/opd/events.ts                |  15 +
 apps/core/src/modules/opd/manifest.ts              |   7 +
 .../core/src/modules/opd/opd-reports.controller.ts | 102 ++++++
 apps/core/src/modules/opd/opd.module.ts            |   3 +-
 apps/core/test/caddyfile-parity.test.ts            |   5 +-
 apps/core/test/opd-day-report.e2e.test.ts          | 120 +++++++
 apps/core/test/seed-roles.test.ts                  |  50 ++-
 apps/web/src/components/opd-day-report-panel.tsx   | 177 +++++++++++
 apps/web/src/lib/opd-reports-api.ts                | 105 +++++++
 apps/web/src/locales/en.json                       |  56 +++-
 apps/web/src/locales/hi.json                       |  56 +++-
 apps/web/src/router.tsx                            |  21 +-
 apps/web/src/screens/desk.tsx                      |   9 +-
 apps/web/src/screens/opd-day-report.css            |  98 ++++++
 apps/web/src/screens/opd-day-report.test.tsx       | 202 ++++++++++++
 apps/web/src/screens/opd-day-report.tsx            | 213 +++++++++++++
 .../superpowers/plans/2026-09-19-opd-day-report.md |  38 +++
 22 files changed, 2106 insertions(+), 22 deletions(-)
```
(22 files, not four — but the **four permission files** are `README.md`, `apps/core/scripts/seed-roles.ts`, `apps/core/src/modules/opd/manifest.ts`, `apps/core/test/seed-roles.test.ts`. That four-file set IS the permission recipe.)

**Hunk 1 — `apps/core/src/modules/opd/manifest.ts`** (the DECLARATION), `@@ -97,6 +97,13 @@`:
```ts
     "opd.prescription.transcribe",
+    /**
+     * THE OPD DAY REPORT — owner request 2026-09-19. The hospital's day, department by department,
+     * and each department's patient list, as a screen, a spreadsheet and a printable letterhead.
+     * Held by the front-office supervisor, the medical superintendent and the owner. It carries
+     * patient names, so every department read is logged (`day_report.patients_listed`).
+     */
+    "opd.reports.read",
   ],
```

**Hunk 2 — `apps/core/scripts/seed-roles.ts`** (the GRANTS — three hunks, one per role), verbatim:
```diff
@@ -166,6 +166,11 @@ export const ROLE_MODEL: readonly RoleGrants[] = [
        * months of history cannot be asked.
        */
       "staff.reports.history.year",
+      /**
+       * THE OPD DAY REPORT — owner request and ruling 2026-09-19: the person who runs the counter
+       * closes the day with it. Every department read is logged (`day_report.patients_listed`).
+       */
+      "opd.reports.read",
     ],
   },
   {
@@ -739,6 +744,12 @@ export const ROLE_MODEL: readonly RoleGrants[] = [
        */
       "staff.reports.read",
       "staff.reports.history.full",
+      /**
+       * THE OPD DAY REPORT — owner request and ruling 2026-09-19: the day by department, and each
+       * department's patient list, on the letterhead and as a spreadsheet. Every department read is
+       * logged (`day_report.patients_listed`).
+       */
+      "opd.reports.read",
       // PHARMACY P17 — the Schedule H1 register, and its unredacted copy for an inspector: the
       // licensee answers for the register.
       "pharmacy.register.read",
@@ -781,6 +792,12 @@ export const ROLE_MODEL: readonly RoleGrants[] = [
       "staff.reports.read",
       /** OWNER RULING 2026-09-14 — hospital-level governance is not a one-year question. */
       "staff.reports.history.full",
+      /**
+       * THE OPD DAY REPORT — owner request and ruling 2026-09-19: the day by department, and each
+       * department's patient list, on the letterhead and as a spreadsheet. Every department read is
+       * logged (`day_report.patients_listed`).
+       */
+      "opd.reports.read",
       "auth.elevation.review",
```

**Hunk 3 — `README.md`** (the PROSE), `@@ -1381,6 +1381,18 @@`, verbatim:
```diff
 both is harmless: they are a lattice, not a switch, because roles combine and a role-to-horizon
 table would need a `max()` across a person's holdings that nobody writes the first time.
 
+**The OPD day report (owner request and ruling,
+2026-09-19).** `front_office_supervisor`, `medical_superintendent` and `owner` gain
+`opd.reports.read`: the hospital's day department by department — appointments booked,
+consultations completed, and each consultation counted as New (first time at the hospital), Revisit
+or Renewal — and, per department, the list of patients consulted with name, age, sex, a short
+address and the patient type, as a screen, a spreadsheet and a printable letterhead. The owner asked
+for the patient list by name, so unlike `staff.reports.drill` this string DOES carry patient rows —
+the difference being that it lists a DEPARTMENT's register for a day, not the patients behind one
+colleague's shift. Confidential patients are aliased against the reader's own clearance, and every
+department read writes `day_report.patients_listed` naming the reader, the day, the department, the
+format and the row count before the rows leave.
+
 **Two approval types, registered by `seed:ot` in the deploy path.** `ot_definition_publish`
```
Note the **hard line-break inside the bold prose** — the pinned constant reproduces it exactly:
```ts
const OPD_DAY_REPORT_README_PROSE =
  "The OPD day report (owner request and ruling,\n2026-09-19)";
```

**Hunk 4 — `apps/core/test/seed-roles.test.ts`** (the PINS). It added, at `@@ -665,6 +665,21 @@`:
```ts
/** The README prose line authorising the 2026-09-19 OPD day report. Quoted, not paraphrased. */
const OPD_DAY_REPORT_README_PROSE =
  "The OPD day report (owner request and ruling,\n2026-09-19)";

/**
 * THE OPD DAY REPORT — the three pairs the owner's 2026-09-19 ruling added: the person who runs the
 * counter, the medical superintendent and the owner may pull the day by department and each
 * department's patient list. One string across three pre-existing roles is a sentence, not a grid.
 */
const OPD_DAY_REPORT_PAIRS: readonly string[] = [
  "front_office_supervisor/opd.reports.read",
  "medical_superintendent/opd.reports.read",
  "owner/opd.reports.read",
];
```
spread into `NON_TABLE_PAIRS` (`+  ...OPD_DAY_REPORT_PAIRS,`), added `expect(readme).toContain(OPD_DAY_REPORT_README_PROSE);`, and moved **twelve** numbers: `opd: 19→20`; `allPermissions 174→175` (×2 sites); `front_office_supervisor 17→18`; `owner 15→16`; `medical_superintendent 14→15`; `modelPairs 352→355`; `modelPermissions 154→155`; `heldPermissions 160→161` (×2 sites); `held+NOT_YET_MODELLED 174→175`; `NON_TABLE_PAIRS 166→169`; `first.declared 174→175`; `first.held 154→155`; and BOTH bare-integer arrays at index 1/10/11. `NOT_YET_MODELLED` stayed at 14 (granted in the same commit that declares it).

**Cost model for your plan: ONE new permission string = 1 manifest line + N seed-roles lines + 1 README paragraph + 1 prose constant + 1 pairs array + ~12 numeric pins including two unsearchable integer arrays.**

---

## 6. Manifests

### 6a. `apps/core/src/kernel/modules/manifests.ts` (179 lines)

`export const ALL_MANIFESTS: readonly ModuleManifest[] = [ … ]` at `:62`, in install order with a prose comment per addition. The 22 entries in order:
```
authManifest, workflowManifest, approvalsManifest, patientsManifest, tariffManifest,
opdManifest, billingManifest, alertsManifest, opsManifest,
membershipManifest, partnersManifest, formularyManifest, resourcesManifest,
materialsManifest, otManifest, deskManifest, ordersManifest, labManifest,
pcpndtManifest, aerbManifest, radiologyManifest, pharmacyManifest
```
Header (`:45-48`) verbatim: *"THE ORDER IS THE ORDER `app.module.ts` INSTALLED THEM IN, and it is preserved deliberately … a diff that reorders this list would look like a functional change to every future reviewer."* **Your leaf module is appended at the end, with a comment saying "appended so the twenty-two above keep the order they were installed in."**

### 6b. `manifests.test.ts` — the count pin, verbatim

`/opt/hmis/apps/core/src/kernel/modules/manifests.test.ts`, inside `it("declares exactly twenty manifests, by key, in app.module.ts's original install order", …)` (title says twenty; array has 22):
```ts
    expect(ALL_MANIFESTS).toHaveLength(22); // PLAN 16c T1: 20 -> 21, the pharmacy; PLAN 18c T1: 22, the AERB registers
    // Installable as a set: `ModuleRegistry.install` throws on a duplicate key, so this also
    // pins that no manifest appears twice.
    const registry = new ModuleRegistry();
    for (const manifest of ALL_MANIFESTS) registry.install(manifest);
    expect(registry.all()).toHaveLength(22);
```
preceded by `expect(ALL_MANIFESTS.map((m) => m.key)).toEqual([ "auth", "workflow", "approvals", "patients", "tariff", "opd", "billing", "alerts", "ops", "membership", "partners", "formulary", "resources", "materials", "ot", "desk", "orders", "lab", "pcpndt", "aerb", "radiology", "pharmacy" ]);` (interleaved with per-addition comments).

**The "app-only" set and its pinned word** — inside `it("the worker's registry differs from ALL_MANIFESTS in exactly seven enumerated, intentional ways", …)`:
```ts
    const appOnly = allKeys.filter((k) => !workerKeys.includes(k));
    expect(appOnly).toEqual(["ops", "membership", "formulary", "resources", "desk", "orders", "aerb"]);
```
and the word is checked against the test's own title by reading the file's own source:
```ts
    const titleCount = /it\("the worker's registry differs from ALL_MANIFESTS in exactly (\w+) enumerated/
      .exec(readFileSync(SELF, "utf8"))?.[1];
    const spelled = NUMBER_WORDS[appOnly.length];
    expect(spelled).not.toBeUndefined();
    expect(titleCount).toBe(spelled);
```
with `const SELF = resolve(SRC_ROOT, "kernel", "modules", "manifests.test.ts");` and `NUMBER_WORDS = ["zero","one",…,"twenty"]`. **So an app-only leaf module forces you to edit the test's own title string from `"seven"` to `"eight"`.**

Worker-side pins in the same test:
```ts
    expect(workerKeys.filter((k) => !allKeys.includes(k))).toEqual(["notify"]);
    expect(workerKeys.filter((k) => allKeys.includes(k))).toEqual([
      "auth","workflow","approvals","patients","tariff","opd","billing","alerts",
      "partners","materials","ot","lab","pcpndt","radiology","pharmacy",
    ]);
    expect(workerKeys).toHaveLength(16);
```
Plus a deliberate-friction map `MANIFEST_BY_IDENTIFIER` (19 entries) — an identifier absent from it makes `manifestKeys` **throw**, not skip. And `installArguments` / `allManifestsLoopVariable` both throw on an unrecognised shape.

### 6c. `ModuleManifest` type verbatim

`/opt/hmis/apps/core/src/kernel/modules/manifest.ts:7-89` (doc-comments elided for length; the five optional fields each carry a long "same seam a Nth time" docstring):
```ts
export type ModuleManifest = {
  key: string;
  title: string;
  menu: { label: string; path: string; permission: string }[];
  permissions: string[];
  subscriptions: { event: string; consumer: string }[];
  search?: SearchProvider[];
  resourceKinds?: readonly ResourceKindDecl[];
  desk?: DeskProvider[];
  orderKinds?: readonly OrderKindDecl[];
  copilotTools?: readonly CopilotToolDecl[];
};
```
Imports at `:1-5`: `OrderKindDecl` from `../orders/kinds`, `ResourceKindDecl` from `../resources/kinds`, `SearchProvider` from `../search/types`, `DeskProvider` from `../desk/types`, `CopilotToolDecl` from `../copilot/types`. Note `search` and `desk` are mutable arrays; `resourceKinds`, `orderKinds`, `copilotTools` are `readonly` **by design** (the docstring: *"a mutable field would let a consumer push a kind onto a manifest's declaration list at runtime — which is a way to claim a kind that no boot-time collector would ever see refuse"*).

### 6d. Registering a leaf module — the `aerb` precedent

**`app.module.ts` does NOT install manifests one by one.** `/opt/hmis/apps/core/src/app.module.ts:86`:
```ts
        for (const manifest of ALL_MANIFESTS) registry.install(manifest);
```
preceded by the capitalised warning at `:73-85` ending *"A LATER PLAN ADDS ITS MANIFEST TO THAT LIST, NEVER TO THIS FILE."*

What `app.module.ts` DOES carry is the **Nest module**: `/opt/hmis/apps/core/src/app.module.ts:35`
```ts
import { AerbModule } from "./modules/aerb/aerb.module";
```
and `:48` — one enormous single-line `imports:` array:
```ts
  imports: [AuthModule, WorkflowModule, ApprovalsModule, PatientsModule, TariffModule, RealtimeModule, OpdModule, BillingModule, AlertsModule, OpsModule, SearchModule, DeskModule, InferenceModule, CopilotModule, MembershipModule, PartnersModule, FormularyModule, ResourcesModule, MaterialsModule, OtModule, LabModule, RadiologyModule, PcpndtModule, AerbModule, PharmacyModule, PrintingModule], // ← CopilotModule (…) // ← AerbModule (Plan 18c T1 — the AERB registers' routes. Its OWN module rather than part of radiology (D1) so the cath lab (63) and radiation oncology (64) file a licence and write a dose row without installing a department; the `pcpndt` precedent, one statute over); …
```
(the trailing `//` comment on that line explains every entry in reverse-chronological order).

The Nest module file itself, `/opt/hmis/apps/core/src/modules/aerb/aerb.module.ts` (whole file):
```ts
import { Module } from "@nestjs/common";
import { AerbController } from "./aerb.controller";

/**
 * PLAN 18c T1 — the AERB register's Nest wiring.
 *
 * It registers no encounter resolver, owns no episode letter and subscribes to nothing: this module
 * holds tables and rules, and the one thing near it that could have been asynchronous is not —
 * radiology's `startAcquisition` calls `assertDeviceLicensed` synchronously, inside its own
 * transaction, on an HTTP path.
 *
 * **It is therefore installed in `app.module.ts` and NOT in `worker.module.ts`** — the `desk` shape
 * rather than the `pcpndt` one, and the difference is worth stating because the two modules
 * otherwise look alike. `pcpndt` is in the worker because radiology's `order.placed` consumer runs
 * there and asks `hasPermission` about a `pcpndt.*` string; nothing in that process asks about an
 * `aerb.*` one. `manifests.test.ts` pins that difference rather than trusting this paragraph.
 */
@Module({
  controllers: [AerbController],
})
export class AerbModule {}
```
Plus `export { aerbManifest } from "./manifest";` at `/opt/hmis/apps/core/src/modules/aerb/index.ts:9`.

**`worker.module.ts` installs BY HAND, one call per manifest.** `/opt/hmis/apps/core/src/kernel/worker/worker.module.ts:28` imports `pcpndtManifest`; `:170-171`:
```ts
        registry.install(pcpndtManifest);
        registry.install(radiologyManifest);
```
preceded by a ~16-line docstring (`:153-169`) explaining they are installed *"for `hasPermission`"* and not for any job or subscription — verbatim excerpt:
> *"They are here for `hasPermission`. T3's `order.placed` consumer runs in THIS process and evaluates DD14's applicability rule … so the worker's registry must carry the twenty `radiology.*`/`pcpndt.*` permissions for that question to have an answer at all. A registry that does not know a permission does not deny it loudly; it denies it as though the permission were a typo."*

`aerb` is deliberately NOT in the worker (hence the app-only array). Both `collectResourceKinds(registry)` and `collectOrderKinds(registry)` are called in both processes.

### 6e. `scripts/standup-check.ts` DEPARTMENTS / NOT_DEPARTMENTS

**They are not in the script — they are in `/opt/hmis/apps/core/test/standup-check.test.ts`** (`grep -rniE "DEPARTMENTS|NOT_DEPARTMENT" apps/core/scripts/standup-check.ts` → no hits; the script only has `listDepartments`, `LAB_DEPARTMENT_CODE`).

`/opt/hmis/apps/core/test/standup-check.test.ts:75-91`:
```ts
const DEPARTMENTS: Record<string, string> = {
  /** manifest key -> the census module key. They differ once, and the census's name wins. */
  opd: "front-desk",
  lab: "lab",
  pharmacy: "pharmacy",
  radiology: "radiology",
  ot: "ot",
  /**
   * RULED A DEPARTMENT 2026-09-07. It meets every test the other five did — master data no deploy
   * supplies, human acts no seed may perform — and it was the only one where **nothing anywhere
   * checked that any of it existed** …
   */
  pcpndt: "pcpndt",
};
```
`:108-131`:
```ts
const NOT_DEPARTMENTS: Record<string, string> = {
  // ── kernel machinery: no clinical day, nothing to commission ──
  auth: "kernel — identity and sessions",
  workflow: "kernel — the definition engine departments are commissioned THROUGH",
  approvals: "kernel — the approval engine",
  alerts: "kernel — alert routing",
  ops: "kernel — operating mode, interfaces, downtime kits",
  resources: "kernel — the registry the departments' theatres and benches live in",
  orders: "kernel — the order envelope; claimed by lab and radiology, owned by neither",
  desk: "cross-cutting — the front-desk shell; its commissioning IS `front-desk`'s",
  notify: "worker-only, and not in ALL_MANIFESTS at all — listed so its absence is not a puzzle",

  // ── cross-cutting hospital data, exercised by every department ──
  patients: "cross-cutting — `registration_config` is a `hospital` row and is checked there",
  tariff: "cross-cutting — priced per department; each department's rows check its own prices",
  formulary: "cross-cutting reference data — `seed:formulary` supplies it; nothing human is owed",
  partners: "cross-cutting — the partner book is the owner's file, not a department's stand-up",

  // ── OPEN QUESTION: master data no deploy can supply, but no runbook today ──
  billing: "OPEN — `billing_config` is checked under `hospital`; a cashier's go-live may still be one",
  materials: "OPEN — vendors, items and opening stock are master data no seed supplies",
  membership: "OPEN — the holder book is loaded from the owner's own files (Plan 09 DD3)",
  aerb: "RULED not a department 2026-09-07 — a statutory layer OVER radiology; `radiology_devices_licensed` and `radiology_rso_appointed` already check its acts, and a row set of its own would demand a second check of the same certificates",
};
```
The enforcing test, `:290-313`:
```ts
  it("every manifest is classified as a department or not — the population is ALL_MANIFESTS, not what the census already knows", () => {
    const manifestKeys = ALL_MANIFESTS.map((m) => m.key).sort();
    expect(manifestKeys.length).toBeGreaterThanOrEqual(20); // non-vacuous: the list was really read
    const classified: Record<string, string> = { ...DEPARTMENTS, ...NOT_DEPARTMENTS };
    expect(manifestKeys.filter((k) => classified[k] === undefined)).toEqual([]);
    expect(Object.keys(DEPARTMENTS).filter((k) => NOT_DEPARTMENTS[k] !== undefined)).toEqual([]);
    const WORKER_ONLY = ["notify"];
    expect(Object.keys(classified).filter((k) => !manifestKeys.includes(k) && !WORKER_ONLY.includes(k)))
      .toEqual([]);
  });
```
plus `it("every declared DEPARTMENT has both halves — a row set and a runbook", …)` (`:316-330`) which requires `STANDUP_ROWS[censusKey]` to be non-empty AND a `docs/runbooks/<x>-go-live.md` mapped by `RUNBOOK_MODULE`. **A new leaf module must be added to exactly one of the two maps or this suite goes red.**

---

## 7. Migrations

- **Newest serial on main: `0107_pharmacy_authorisations.sql`** (`apps/core/drizzle/0107_pharmacy_authorisations.sql`). Directory holds `0000`–`0107` + `meta/`.
- **`meta/_journal.json` last entry, verbatim:**
```json
    {
      "idx": 107,
      "version": "7",
      "when": 1789826618273,
      "tag": "0107_pharmacy_authorisations",
      "breakpoints": true
    }
  ]
}
```
(file ends with no trailing newline after `}`).
- **drizzle-kit generate command, `/opt/hmis/apps/core/package.json`:** `"db:generate": "drizzle-kit generate"` (run as `pnpm --filter @hmis/core db:generate`). Siblings: `"db:migrate": "tsx scripts/migrate.ts"`, `"db:migrate:prod": "node dist/scripts/migrate.js"`, `"db:check": "tsx scripts/db-check.ts"`.
- **`/opt/hmis/apps/core/drizzle.config.ts`** (whole file):
```ts
import { defineConfig } from "drizzle-kit";
import { requireEnv } from "./src/kernel/config";

export default defineConfig({
  schema: "./src/kernel/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: requireEnv("DATABASE_URL") },
});
```
A new schema file must be `export * from "./<name>";`-ed into `/opt/hmis/apps/core/src/kernel/db/schema/index.ts` (which is annotated with dependency-order comments) or drizzle-kit will not see it.

### Hand-written migration adding an index — `/opt/hmis/apps/core/drizzle/0065_aerb_licence_sequence.sql` (whole file)
```sql
-- PLAN 18c CLOSE REVIEW PASS 2, CRITICAL — "one active licence per device" was the wrong invariant,
-- and the renewal built on top of it stopped the machine it was written to keep running.
--
-- Pass 1 fixed "the register cannot record a renewal at all" by surrendering the outgoing
-- certificate the instant the incoming one was filed. Pass 2 measured what that does: filing the
-- 2027 licence in November left `activeLicenceFor` returning NULL for 20 November, so the CT
-- refused every ionising study from the day the paperwork arrived until 1 January — and
-- `surrendered` is terminal, so there was no way back. Worse than the defect it replaced.
--
-- What a hospital actually has is a SEQUENCE of certificates with non-overlapping validity, and
-- "which licence is in force" is a function of the DATE. `activeLicenceFor` has always asked the
-- date question; only this index disagreed with it. A device may now carry the 2026 and the 2027
-- licence at once and neither is ambiguous on any given day.
--
-- What remains unique is what is really true: a device cannot hold two certificates that START on
-- the same day. Overlap itself is refused in `fileLicence`, under a FOR UPDATE lock on the device
-- row — the one row that always exists for a device, so two concurrent files serialise on it and
-- the check is race-free in a way no partial index could express.

DROP INDEX "aerb_licences_device_active_ux";--> statement-breakpoint
CREATE UNIQUE INDEX "aerb_licences_device_from_ux" ON "aerb_licences" USING btree ("device_resource_id","valid_from") WHERE "aerb_licences"."status" <> 'surrendered';
```

**CHECK-constraint form (generated, but this is the shape a new table uses)** — `/opt/hmis/apps/core/drizzle/0107_pharmacy_authorisations.sql`, note the fully-qualified `"table"."column"` spelling drizzle emits and that `--> statement-breakpoint` separates statements:
```sql
CREATE TABLE "pharmacy_authorisations" (
	"id" text PRIMARY KEY NOT NULL,
	"dispense_id" text NOT NULL,
	"line_idx" integer NOT NULL,
	"book" text NOT NULL,
	"about" text NOT NULL,
	"prescriber_user_id" text NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"request_note" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	CONSTRAINT "pharmacy_authorisations_book_ck" CHECK ("pharmacy_authorisations"."book" in ('allergy', 'interaction', 'duplicate', 'drug_disease')),
	CONSTRAINT "pharmacy_authorisations_status_ck" CHECK ("pharmacy_authorisations"."status" in ('pending', 'authorised', 'declined')),
	CONSTRAINT "pharmacy_authorisations_decided_ck" CHECK (("pharmacy_authorisations"."status" = 'pending') = ("pharmacy_authorisations"."decided_by" is null and "pharmacy_authorisations"."decided_at" is null and "pharmacy_authorisations"."decision_reason" is null)),
	CONSTRAINT "pharmacy_authorisations_reason_ck" CHECK ("pharmacy_authorisations"."decision_reason" is null or length(btrim("pharmacy_authorisations"."decision_reason")) >= 3),
	CONSTRAINT "pharmacy_authorisations_same_actor_ck" CHECK ("pharmacy_authorisations"."decided_by" is null or "pharmacy_authorisations"."decided_by" <> "pharmacy_authorisations"."requested_by")
);
--> statement-breakpoint
ALTER TABLE "pharmacy_authorisations" ADD CONSTRAINT "pharmacy_authorisations_dispense_id_pharmacy_dispenses_id_fk" FOREIGN KEY ("dispense_id") REFERENCES "public"."pharmacy_dispenses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pharmacy_authorisations_prescriber_idx" ON "pharmacy_authorisations" USING btree ("prescriber_user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "pharmacy_authorisations_one_open_ux" ON "pharmacy_authorisations" USING btree ("dispense_id","line_idx","book","about") WHERE "pharmacy_authorisations"."status" = 'pending';
```
**`pharmacy_authorisations_same_actor_ck` is the shipped database-level dual-control precedent** (`decided_by <> requested_by`) — the only one in the tree; approvals itself enforces this in TypeScript only.

**Two migrations carry explicit "DO NOT REGENERATE" headers** and are the hand-written precedent: `0096_backfill_encounter_refs.sql` (*"WHY THIS IS HAND-WRITTEN AND MUST NEVER BE REGENERATED — `drizzle-kit generate` reproduces a SCHEMA diff. There is no schema change here at all … so regenerating this file produces an EMPTY migration and silently deletes the repair. The same trap `0043_patient_identity_spine.sql` carries at its head."*) and `0093_front_desk_fd25.sql` (*"ONE migration for one PR (CLAUDE.md) … The two NOT NULL columns are NOT the bare adds `drizzle-kit generate` emits … Add it nullable, give every existing row a number, and only then make it required."*). **CLAUDE.md rule, quoted inside 0093: ONE migration file per PR.**

### The `schema/<module>.test.ts` census pattern — one whole small test, transcribable

Smallest schema census tests by line count: `auth.test.ts` 43, `events.test.ts` 45, `alerts.test.ts` 59, `retention.test.ts` 68, `tariff.test.ts` 71. (There is **no `schema/aerb.test.ts`** — `schema/aerb.ts` is 524 lines with no sibling test; `membership.test.ts` is 319.)

Here is `/opt/hmis/apps/core/src/kernel/db/schema/retention.test.ts` **in full** (68 lines) as the template:
```ts
import { isNull } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { retentionLegalHolds } from "./retention";
import { patients } from "./patients";
import type { Db } from "../client";

const PATIENT = "01HRETENTIONPATIENT00001";

const hold = (id: string, over: Partial<typeof retentionLegalHolds.$inferInsert> = {}) => ({
  id, reason: "W.P. 1174/2026 — preserve all records", createdBy: "u1", ...over,
});

describe("retention_legal_holds table", () => {
  let db: Db; let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(patients).values({
      id: PATIENT, uhid: "HMS-00000009-1", name: "Asha Devi", sex: "female", administrativeGender: "female",
      createdBy: "u1", updatedBy: "u1",
    });
  });
  afterAll(async () => { await teardown(); });

  it("round-trips a GLOBAL hold — a null patient_id is the hold that covers everyone", async () => {
    await db.insert(retentionLegalHolds).values(hold("01HHOLD0000000000000GLOBAL"));
    const rows = await db.select().from(retentionLegalHolds);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.patientId).toBeNull(); // null = global, not "missing"
    expect(rows[0]!.releasedAt).toBeNull(); // null = ACTIVE
    expect(rows[0]!.createdAt).toBeInstanceOf(Date);
  });

  it("round-trips a PATIENT-scoped hold", async () => {
    await db.insert(retentionLegalHolds).values(hold("01HHOLD000000000000PATIENT", { patientId: PATIENT }));
    const rows = await db.select().from(retentionLegalHolds);
    expect(rows[0]!.patientId).toBe(PATIENT);
  });

  it("refuses a hold naming a patient who does not exist", async () => {
    // The FK is the reason `null` can mean GLOBAL: without it a typo'd id would be a hold that
    // silently protects nobody, and nothing would ever say so.
    await expect(
      db.insert(retentionLegalHolds).values(hold("01HHOLD00000000000000BAD1", { patientId: "01HNOSUCHPATIENT00000001" })),
    ).rejects.toThrow();
  });

  it("refuses a hold with no reason — a hold nobody can explain is not a hold", async () => {
    await expect(
      db.insert(retentionLegalHolds).values({ id: "01HHOLD00000000000000BAD2", createdBy: "u1" } as typeof retentionLegalHolds.$inferInsert),
    ).rejects.toThrow();
  });

  it("distinguishes ACTIVE from RELEASED by released_at, and a release deletes nothing", async () => {
    const RELEASED_AT = new Date("2026-08-20T10:00:00.000Z");
    await db.insert(retentionLegalHolds).values([
      hold("01HHOLD0000000000000ACTIVE"),
      hold("01HHOLD00000000000RELEASED", { patientId: PATIENT, releasedAt: RELEASED_AT }),
    ]);

    // The query T5's sweep makes: an ACTIVE hold is one whose released_at is still null.
    const active = await db.select().from(retentionLegalHolds).where(isNull(retentionLegalHolds.releasedAt));
    expect(active.map((h) => h.id)).toEqual(["01HHOLD0000000000000ACTIVE"]);
    // And the released one is still on the record — the row survives its own release.
    expect(await db.select().from(retentionLegalHolds)).toHaveLength(2);
  });
});
```
**Pattern:** `setupTestDb`/`truncateAll` from `../../../../test/helpers/db`, a `let db: Db; let teardown: () => Promise<void>;` pair, `beforeAll`/`beforeEach`/`afterAll`, ULID-shaped literal ids, a `Partial<typeof table.$inferInsert>` row factory, and one `it` per invariant: defaults, FK refusals, NOT NULL refusals, unique-index refusals (`.rejects.toThrow()`), and the semantic query the module will actually run.

---

## 8. Department hours / counter hours — **ABSENT**

`opd_departments` has **no hours columns**. Verbatim, `/opt/hmis/apps/core/src/kernel/db/schema/opd.ts:42-58`:
```ts
export const opdDepartments = pgTable(
  "opd_departments",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull(), // short stable code, e.g. 'MED', 'PED' — printed on token slips
    name: text("name").notNull(),
    // RC-1 T2 / D7 — wait v0 is `waitingCount × avgConsultMinutes`, minutes AND a clock time on
    // the seat. A future pace model replaces THIS COLUMN'S READ, not the wire shape.
    avgConsultMinutes: integer("avg_consult_minutes").notNull().default(6),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("opd_departments_code_ux").on(t.code)],
);
```

`opd_doctor_schedules` is the ONLY time-of-day structure in the tree — `/opt/hmis/apps/core/src/kernel/db/schema/opd.ts:113-133`:
```ts
/** Weekly availability template. Times are IST 'HH:MM'. Slots are derived, never materialised (slots.ts). */
export const opdDoctorSchedules = pgTable(
  "opd_doctor_schedules",
  {
    id: text("id").primaryKey(),
    doctorId: text("doctor_id").notNull().references(() => opdDoctors.id),
    weekday: integer("weekday").notNull(), // 0 = Sunday … 6 = Saturday (IST calendar)
    startTime: text("start_time").notNull(), // 'HH:MM'
    endTime: text("end_time").notNull(), // 'HH:MM', exclusive
    // PLAN 13 T6 — REPOINTED at the registry. The value is UNCHANGED: room ids are ULIDs, so
    // `0032` preserved every one of them and only this foreign key's TARGET moved.
    roomId: text("room_id").notNull().references(() => resources.id),
    slotMinutes: integer("slot_minutes"), // null ⇒ opd_config.slot_minutes
    validFrom: date("valid_from", { mode: "string" }).notNull(),
    validTo: date("valid_to", { mode: "string" }), // null = open-ended
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("opd_doctor_schedules_doctor_idx").on(t.doctorId)],
);
```
Adjacent: `opdDoctorLeaves` (`:136-151`) — `doctorId`, `fromDate`, `toDate` (inclusive), `reason`, `status 'scheduled'|'cancelled'`, cancel audit — **per-doctor leave, not a hospital calendar.**

`opd_config` (`:21-40`) is the single-row hospital config and holds **no hours**: `slotMinutes` (default 10), `followUpDefaultDays`, `followUpExtensionDays`, `extensionCapPerDoctorPerMonth`, `maxSkipsBeforeLeft`, `perkEveryNth`, `dangerRanges`, `letterhead`, `counterSequence` (`'queue_first'`), `tokenLane` (`'token_first'`), `updatedBy/At`.

Greps run:
```
grep -rniE "closes_at|opens_at|closesAt|opensAt|working_|workingDays|\"hours\"|hours\(" apps/core/src/kernel/db/schema/   → 0 hits
grep -rniE "start_time|end_time|open|close|shift|window" apps/core/src/kernel/db/schema/*.ts (non-test, column decls only)
```
The second returns only: `opd.ts:120-121` (the two above), plus `openedAt`/`closedAt`/`status 'open'` **session/shift-lifecycle timestamps** in `billing.ts:297-306, 345` (cashier sessions), `lab.ts:666-671, 991-996, 1071-1084`, `materials.ts:493, 788-790`, `orders.ts:141-148`, `pharmacy.ts:170`, `partners.ts:106, 353`. **None of these is an opening/closing-hours declaration.** A hospital calendar with department hours is **absent**; you are building it from nothing.

---

## 9. Holidays — **ABSENT from all code**

```
grep -rni "holiday" --include=*.ts --include=*.tsx --include=*.sql --include=*.json . | grep -v node_modules | grep -v "^./docs"
  → (no output)
```
Zero hits in `apps/core/src`, `apps/web/src`, `packages/`, `apps/core/drizzle/`, and all `package.json`/locale JSON.

It exists **only in planning prose**:
```
docs/superpowers/2026-09-06-HANDOFF-commissioning-lane-11i.md
docs/superpowers/brainstorms/2026-09-20-obligation-spine/02-EDGE-CASES.md
docs/superpowers/brainstorms/2026-08-27-patient-self-service/05-S4-SETTLEMENT.md
docs/superpowers/brainstorms/2026-09-20-roster-units/00-BRAINSTORM.md
docs/superpowers/brainstorms/2026-09-20-roster-units/01-STRESS-TEST.md
docs/superpowers/brainstorms/2026-08-27-department-series/21-service-lines-maternity-cathlab-onco-dialysis-endo.md
docs/superpowers/brainstorms/2026-08-27-department-series/08-housekeeping-laundry-bmw.md
docs/superpowers/plans/2026-09-20-phase1-20u-roster-unit-system.md
docs/superpowers/plans/2026-09-20-roster-backbone-IMPLEMENTATION-PLAN.md
```
(The last two are the roster lane's own docs — worth reading before you design the calendar, since the roster brainstorm already touched holidays.)

---

## 10. Events catalogue

**`defineEvent` signature, verbatim** — `/opt/hmis/packages/contracts/src/envelope.ts:66-106`:
```ts
export type EventDef<S extends z.ZodTypeAny = z.ZodTypeAny> = {
  name: string;
  module: string;
  version: number;
  payloadSchema: S;
  make: (args: MakeArgs) => EventInput;
};

export function defineEvent<S extends z.ZodTypeAny>(
  name: string,
  module: string,
  payloadSchema: S,
  version = 1,
): EventDef<S> {
  if (!NAME_RE.test(name)) {
    throw new Error(`event name "${name}" must be lowercase entity.verb_past`);
  }
  return {
    name,
    module,
    version,
    payloadSchema,
    make(args: MakeArgs): EventInput {
      const payload = payloadSchema.parse(args.payload);
      return {
        name,
        module,
        version,
        payload,
        actor: args.actor,
        occurredAt: args.occurredAt ?? new Date(),
        patientId: args.patientId,
        encounterId: args.encounterId,
        correlationId: args.correlationId,
        causationId: args.causationId,
        siteId: args.siteId ?? "main",
        idempotencyKey: args.idempotencyKey,
      };
    },
  };
}
```
with `const NAME_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;` (`:64`), and `EventInput` (`:36-50`) / `MakeArgs` (`:52-62`) / `Actor = { type: "user" | "agent" | "system" | "patient"; id: string }` (`:34`) above it.

**There is NO central event catalogue and NO test pinning a catalogue count.** `EventRegistry` (`/opt/hmis/packages/contracts/src/registry.ts`, 20 lines, whole file):
```ts
import type { EventDef } from "./envelope";

export class EventRegistry {
  private defs = new Map<string, EventDef>();

  register(def: EventDef): void {
    if (this.defs.has(def.name)) {
      throw new Error(`duplicate event registration: ${def.name}`);
    }
    this.defs.set(def.name, def);
  }

  get(name: string): EventDef | undefined {
    return this.defs.get(name);
  }

  names(): string[] {
    return [...this.defs.keys()];
  }
}
```
Its only test is `/opt/hmis/packages/contracts/test/registry.test.ts` (16 lines, two cases: register+list, duplicate throws) — it pins **no** production catalogue. `grep -rn "EventRegistry" apps/core/src` → **zero hits**: `apps/core` never instantiates it. The `names()` in `kernel/realtime/gateway.ts:87` is a *different* `names()` (`[...new Set(this.routers.flatMap((r) => r.names))]`, realtime channel routers), consumed by `EventTail` at `gateway.ts:97`.

Event definitions are **per-module module-level constants**, one `events.ts` per module: `kernel/{approvals,orders,auth,resources,ops,alerts,desk,worker,search,report}/events.ts` plus each `modules/<x>/events.ts`. `grep -rn "defineEvent(" apps/core/src --include=*.ts | wc -l` → **269**. The approvals ones:
```ts
apps/core/src/kernel/approvals/events.ts:10  export const approvalRequested = defineEvent(
apps/core/src/kernel/approvals/events.ts:40  export const approvalGranted  = defineEvent("approval.granted",  "approvals", decisionPayload);
apps/core/src/kernel/approvals/events.ts:41  export const approvalRejected = defineEvent("approval.rejected", "approvals", decisionPayload);
```
So a new event needs no catalogue edit and moves no count. (The only event-adjacent census that moves is `manifest.subscriptions` + `workerConsumers`, pinned by `manifests.test.ts`.)

---

## 11. PHI audit — registering a new read surface

Two edits, both in `/opt/hmis/apps/core/src/kernel/phi/audit.ts`:

**(1) Append to the `PhiSurface` union** (`:15`, a large discriminated string union where **every member carries its own multi-paragraph docstring arguing why it is not a reuse of an existing surface**). The approvals member, `:218-226`, verbatim:
```ts
  /**
   * APPROVALS-UX — **THE APPROVER'S INBOX, and it is an APPEND to a union and nothing else.**
   *
   * `GET /approvals` now names the patient each request is about (display name under the reader's
   * clearance, and the UHID), because a refund or a discount cannot be decided on an id. That makes
   * it a list-of-patients read of the `billing.collection_worklist` shape, logged one row per
   * distinct patient for the same reason. Its own name: an approver reading their queue is a
   * different disclosure from opening a record, and an enquiry must be able to tell them apart.
   */
  | "approvals.worklist";
```
(It is the LAST member — the union is terminated by this line's `;`.) Sibling precedents in the same union: `"aerb.dose_register"`, `"billing.collection_worklist"`, `"patient.linked"`, `"pharmacy.h1_register"`, `"opd.rx_history" | "opd.vitals_history"`, `"opd.continuity"`, `"patient.documents" | "patient.document.image"`.

**(2) Call the recorder.** Helper signature, `/opt/hmis/apps/core/src/kernel/phi/audit.ts:280-325`:
```ts
export type RecordPhiAccessInput = {
  actor: Actor;
  /** The CANONICAL patient id — callers resolve the merge chain before writing. */
  patientId: string;
  surface: PhiSurface;
  encounterId?: string | null;
  /** Omit to let the registered providers answer — which is what every call site should do. */
  context?: CareContext;
  sealed?: boolean;
  reason?: string | null;
  now?: Date;
};

export async function recordPhiAccess(db: Db, input: RecordPhiAccessInput): Promise<void> {
  const now = input.now ?? new Date();
  try {
    const context = input.context ?? await resolveCareContext(db, input.actor, input.patientId, now);
    await db.insert(phiAccessLog).values({
      id: newId(),
      actorId: input.actor.id,
      actorType: input.actor.type,
      patientId: input.patientId,
      surface: input.surface,
      encounterId: input.encounterId ?? null,
      context,
      sealed: input.sealed ?? false,
      reason: input.reason ?? null,
      at: now,
    });
  } catch {
    // Deliberately swallowed — see the header. The read is the priority.
  }
}
```
Its docstring (`:293-305`) verbatim: *"═══ A LOGGING FAILURE MUST NEVER FAIL THE READ ═══ This function does not throw. Ever."*

**One call, verbatim** — `/opt/hmis/apps/core/src/kernel/approvals/people.ts:75-79`:
```ts
    for (const patientId of canonical) {
      await recordPhiAccess(db, {
        actor, patientId, surface: "approvals.worklist", reason, sealed: sealedOf.get(patientId) ?? false,
      });
    }
```

Related registration seam (you may need it for a tasks module): `export type CareContextProvider = (db, actor, patientId, now) => Promise<CareContext>` and `export function registerCareContextProvider(key: string, provider: CareContextProvider): () => void` — a **keyed** `Map` so re-registering under the same key REPLACES (the docstring says Jest shares one worker and an array would double-register). `CareContext = "treating" | "serving" | "none"`, `CONTEXT_RANK = { none: 0, serving: 1, treating: 2 }`, strongest answer wins.

Storage: `phiAccessLog` at `/opt/hmis/apps/core/src/kernel/db/schema/phi-access.ts:41-…` — `id` text PK, `seq` bigserial, `actorId`, `actorType`, `patientId`, **`surface: text("surface").notNull()` — a FREE STRING with no CHECK**, `encounterId`, `context`, `sealed`, `reason`, `at`. Comment at `:51-56` verbatim: *"A free string rather than an enum because every later module adds its own, and a CHECK constraint would make a read log the reason for a migration."* **So a new surface is a pure TypeScript change — no migration.** Retention: `PHI_ACCESS_RETAIN_DAYS = 1095` (`:328`), and the prune IS legal-hold clamped (`:330`+).

---

## 12. `apps/core/src/kernel/db/schema/roster.ts` — **DOES NOT EXIST ON MAIN**

```
ls apps/core/src/kernel/db/schema/roster.ts  → No such file or directory
git merge-base --is-ancestor 29f5159d main    → NOT ON MAIN
```
It lives on branch `lane/roster` (local + `remotes/origin/lane/roster`), commit `29f5159d feat(roster): Plan 20 T1 - roster periods, duty windows and the publication gate`.

`gh pr view 264` → `{"number":264, "state":"OPEN", "headRefName":"lane/roster", "baseRefName":"main", "title":"feat(roster): Plan 20 T1 — roster periods, duty windows and the publication gate"}` — **unmerged, as you suspected.**

`git diff --stat main...lane/roster` (20 files, +31,816):
```
 apps/core/drizzle/0108_roster_periods.sql      |    74 +
 apps/core/drizzle/meta/0108_snapshot.json      | 30450 +++++++++++
 apps/core/drizzle/meta/_journal.json           |     7 +
 apps/core/scripts/seed-roles.ts                |    16 +
 apps/core/src/app.module.ts                    |     3 +-
 apps/core/src/kernel/db/schema/index.ts        |     4 +
 apps/core/src/kernel/db/schema/roster.test.ts  |   154 +
 apps/core/src/kernel/db/schema/roster.ts       |   167 +
 apps/core/src/kernel/modules/manifests.test.ts |    17 +-
 apps/core/src/kernel/modules/manifests.ts      |     5 +
 apps/core/src/modules/roster/access.ts         |    24 +
 apps/core/src/modules/roster/errors.ts         |    56 +
 apps/core/src/modules/roster/events.ts         |    33 +
 apps/core/src/modules/roster/index.ts          |    13 +
 apps/core/src/modules/roster/manifest.ts       |    37 +
 apps/core/src/modules/roster/periods.test.ts   |   260 +
 apps/core/src/modules/roster/periods.ts        |   447 +
 apps/core/src/modules/roster/roster.module.ts  |   10 +
 apps/core/test/seed-roles.test.ts              |    48 +-
```
**That 20-file diff is a live, complete worked example of the "new leaf module" recipe** (schema + census test + migration + journal + manifests.ts + manifests.test.ts + seed-roles.ts + seed-roles.test.ts + app.module.ts + module dir). On that branch, `roster.ts` declares:
```
:65 ROSTER_PERIOD_STATUSES    = ["draft", "published", "superseded"]
:69 ROSTER_SCOPE_TYPES        = ["hospital", "department", "unit", "role_family"]
:72 ROSTER_ASSIGNMENT_MODES   = ["presence", "call"]
:75 ROSTER_ASSIGNMENT_KINDS   = ["duty", "teaching"]
:78 ROSTER_ASSIGNMENT_SOURCES = ["manual", "import", "proposer", "academic"]
:88  export const rosterPeriods     = pgTable(…)
:130 export const rosterAssignments = pgTable(…)
```
**Also note it takes migration serial `0108` and journal idx 108 — your plan will collide if it does the same.**

---

## 13. `apps/core/src/modules/opd/config.ts` — the 12 department codes

`/opt/hmis/apps/core/src/modules/opd/config.ts:166-171`, verbatim:
```ts
export const DEFAULT_DEPARTMENTS: { code: string; name: string }[] = [
  { code: "MED", name: "General Medicine" }, { code: "SUR", name: "General Surgery" }, { code: "PED", name: "Paediatrics" },
  { code: "OBG", name: "Obstetrics & Gynaecology" }, { code: "ORT", name: "Orthopaedics" }, { code: "ENT", name: "ENT" },
  { code: "OPH", name: "Ophthalmology" }, { code: "DER", name: "Dermatology" }, { code: "PSY", name: "Psychiatry" },
  { code: "CAR", name: "Cardiology" }, { code: "DEN", name: "Dental" }, { code: "PHY", name: "Physiotherapy" },
];
```
The twelve codes: **MED, SUR, PED, OBG, ORT, ENT, OPH, DER, PSY, CAR, DEN, PHY.**

The same file also exports `OPD_ROLE_KEYS` (imported by both `scripts/seed-roles.ts:11` and `test/seed-roles.test.ts:7`) and `LAB_DEPARTMENT_CODE` is re-exported from `modules/opd` (read by `scripts/standup-check.ts:9,126,329`, where a missing `LAB` department is a RED row with the fix string `` `§2: create the department code ${LAB_DEPARTMENT_CODE}, name Laboratory, active = true` ``).

---

# Things that will bite your plan (measured, not inferred)

1. **No `decideApproval`.** Two exported entry points, `approveRequest` / `rejectRequest`, both delegating to a private generic `decide<V>`. Sequential dual control has to thread through `decide` and through `transition()` (which is the single-winner arbiter over `workflow_instances`, not over `approvals`).
2. **`approvals` mirrors the workflow instance and `approvals_instance_ux` enforces one approval per instance.** A second approver step cannot be a second `approvals` row against the same instance.
3. **SoD is identity-equality only** (`actorA.id === actorB.id`). There is no "already decided by" ledger for a second signature. The only DB-level dual-control precedent in the tree is `pharmacy_authorisations_same_actor_ck`.
4. **The worklist ORDER BY is built in TypeScript from a `sql` template**, not from a column. Derived priority columns mean editing `worklist.ts:77-80` and its pins in `worklist.test.ts` (177 lines).
5. **`GET /approvals/:id` (`detail`) bypasses `withPeople`** — it returns the raw `ApprovalRow` and writes no PHI row. If your new columns carry anything patient-identifying, that route is a hole.
6. **The web has no `approvals-api.ts`** — you either create one (the `lib/<module>-api.ts` precedent, e.g. `opd-reports-api.ts` added by 775a85da) or keep extending the inline `ApprovalItem` type in the screen.
7. **`approvals: 4`** is pinned per-module in `seed-roles.test.ts:947`; any new `approvals.*` permission moves that plus ~11 other numbers plus two unsearchable bare-integer arrays.
8. **A new leaf module forces `manifests.test.ts`'s own `it(...)` TITLE to change** (`"seven"` → `"eight"`) if it is app-only, because the test regex-reads its own source. It also forces a line in `standup-check.test.ts`'s `DEPARTMENTS` or `NOT_DEPARTMENTS`, and `MANIFEST_BY_IDENTIFIER`.
9. **Nothing exists for calendars, holidays, department hours, standing policy, auto-grant, or a delay ledger.** All six are greenfield; the roster lane (PR #264, unmerged) is the nearest neighbour and already claims migration `0108`.
