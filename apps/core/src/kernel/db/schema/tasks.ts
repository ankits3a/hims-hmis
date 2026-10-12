import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { patients } from "./patients";
import { resources } from "./resources";

/**
 * E0.1 TASK ENGINE (issue #713, decision 0072) — one table of service work and its append-only
 * history. Read and written only by `modules/tasks`.
 *
 * `version` is the optimistic-concurrency counter AND the history's sequence: every change of a task
 * row bumps it by one in the same transaction that appends `task_events` with `seq = version`, so the
 * history has no gap and no row changes without one.
 */
export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    placeResourceId: text("place_resource_id").references(() => resources.id),
    patientId: text("patient_id").references(() => patients.id),
    priority: text("priority").notNull().default("routine"),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    skill: text("skill").notNull(),
    assigneeKind: text("assignee_kind"),
    /** A user id for a person; a team or machine id later. Plain text: not every assignee is a user. */
    assigneeId: text("assignee_id"),
    assignedAt: timestamp("assigned_at", { withTimezone: true }),
    /** When the assignee's rostered duty ends; null when they hold no rostered duty (never auto-returned). */
    shiftEndsAt: timestamp("shift_ends_at", { withTimezone: true }),
    proofNeeded: text("proof_needed").notNull().default("none"),
    proof: jsonb("proof").$type<Record<string, unknown>>(),
    verifyRequired: boolean("verify_required").notNull().default(false),
    state: text("state").notNull().default("created"),
    cancelReason: text("cancel_reason"),
    note: text("note"),
    mergedCount: integer("merged_count").notNull().default(0),
    /** The highest escalation rung already raised — a rung is raised once. */
    escalatedRung: integer("escalated_rung").notNull().default(0),
    doneBy: text("done_by"),
    doneAt: timestamp("done_at", { withTimezone: true }),
    verifiedBy: text("verified_by"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    requestedBy: text("requested_by").notNull(),
    source: text("source").notNull().default("person"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    index("tasks_open_idx").on(t.state, t.dueAt).where(sql`${t.state} in ('created', 'assigned', 'accepted', 'in_progress')`),
    index("tasks_assignee_idx").on(t.assigneeId).where(sql`${t.state} in ('assigned', 'accepted', 'in_progress')`),
    index("tasks_place_idx").on(t.kind, t.placeResourceId, t.createdAt),
    check("tasks_state_ck", sql`${t.state} in ('created', 'assigned', 'accepted', 'in_progress', 'done', 'verified', 'cancelled')`),
    check("tasks_priority_ck", sql`${t.priority} in ('routine', 'urgent', 'stat')`),
    check("tasks_proof_needed_ck", sql`${t.proofNeeded} in ('none', 'tap', 'photo', 'scan', 'weight')`),
    check("tasks_source_ck", sql`${t.source} in ('person', 'device', 'copilot_draft', 'agent', 'import')`),
    check("tasks_assignee_kind_ck", sql`${t.assigneeKind} is null or ${t.assigneeKind} in ('person', 'team', 'machine')`),
    check("tasks_assignee_pair_ck", sql`(${t.assigneeKind} is null) = (${t.assigneeId} is null)`),
    check("tasks_assignee_state_ck", sql`${t.state} not in ('assigned', 'accepted', 'in_progress') or ${t.assigneeId} is not null`),
    check("tasks_pool_unassigned_ck", sql`${t.state} <> 'created' or ${t.assigneeId} is null`),
    check("tasks_cancel_reason_ck", sql`${t.state} <> 'cancelled' or char_length(${t.cancelReason}) > 0`),
    check("tasks_note_ck", sql`${t.note} is null or char_length(${t.note}) <= 280`),
    check("tasks_counts_ck", sql`${t.mergedCount} >= 0 and ${t.escalatedRung} >= 0 and ${t.version} >= 1`),
  ],
);

/** Append-only (a trigger refuses UPDATE and DELETE). `seq` equals the task's `version` after the act. */
export const taskEvents = pgTable(
  "task_events",
  {
    taskId: text("task_id").notNull().references(() => tasks.id),
    seq: integer("seq").notNull(),
    act: text("act").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    source: text("source").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.seq] }),
    index("task_events_at_idx").on(t.at),
    check("task_events_act_ck", sql`${t.act} in ('raised', 'merged', 'assigned', 'redispatched', 'accepted', 'started', 'done', 'verified', 'cancelled', 'returned', 'escalated')`),
    check("task_events_source_ck", sql`${t.source} in ('person', 'device', 'copilot_draft', 'agent', 'import', 'system')`),
  ],
);
