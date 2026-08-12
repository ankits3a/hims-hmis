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
