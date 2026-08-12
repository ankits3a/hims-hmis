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
