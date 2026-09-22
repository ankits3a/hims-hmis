import {
  check, pgTable, text, integer, boolean, timestamp, jsonb, index, uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * PHASE O T1 — the vocabulary the `kind` column has always had and never declared. `respond` is
 * the new one: silence, as opposed to `sla`'s lateness and `escalation`'s climb.
 */
export const WORKFLOW_TIMER_KINDS = ["sla", "escalation", "respond"] as const;
export type WorkflowTimerKind = (typeof WORKFLOW_TIMER_KINDS)[number];

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
    /**
     * PHASE O T1 — a PER-INSTANCE override of `sla.minutes`, and the only thing a percent ladder
     * is a percentage OF. Null means "use the definition's minutes", which is every instance
     * that shipped before this column existed and every instance nobody has re-budgeted.
     *
     * Written only by `rescheduleBudget`, deliberately: a budget change has to cancel and
     * re-schedule the whole ladder in the same transaction, and a caller that set the column
     * directly would leave timers pointing at a budget that no longer exists.
     */
    budgetMinutes: integer("budget_minutes"),
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
    kind: text("kind").notNull(), // 'sla' | 'escalation' | 'respond'
    rung: integer("rung"), // null for kind='sla'; 0-based ladder index for 'escalation'
    /**
     * PHASE O T1 — set on `kind='escalation'` rows that came from a percent LADDER, null on the
     * rows that came from the shipped `escalation` CHAIN. The two kinds of rung are stored in
     * one column and told apart by this field, and its null-ness is read at the consumer: a
     * delay record is filed at `percent >= 100`, so a chain rung must not look like a 0 % one.
     */
    percent: integer("percent"),
    /**
     * C4 — THE WORKER WAS DOWN AND EVERY RUNG CAME DUE AT ONCE. The highest rung emits; the
     * lower ones are recorded as fired and point here, at the rung that spoke instead. Without
     * it, three hours of downtime becomes three messages to three people about one silence, and
     * the ledger cannot tell that from three real climbs.
     */
    supersededBy: text("superseded_by").references((): AnyPgColumn => workflowTimers.id),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    firedAt: timestamp("fired_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("workflow_timers_due_idx").on(t.dueAt),
    index("workflow_timers_instance_idx").on(t.instanceId),
    /**
     * The column has carried a two-word vocabulary since Plan 03 with nothing enforcing it.
     * T1 adds a third word and the constraint at the same time: a typo'd kind is a timer that
     * `runDueTimers` claims, matches no branch, and fires into silence.
     */
    check(
      "workflow_timers_kind_ck",
      sql`${t.kind} in ('sla', 'escalation', 'respond')`,
    ),
  ],
);
