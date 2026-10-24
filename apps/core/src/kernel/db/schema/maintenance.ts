import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, primaryKey, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { ipdBedBlocks } from "./ipd";
import { resources } from "./resources";
import { tasks } from "./tasks";

/**
 * E1.5 MAINTENANCE (issue #722, decision 0072) — repair tickets and their append-only history. Written only by
 * `modules/maintenance`; `modules/ipd` READS `maintenance_tickets` for one rule (a bed blocked for repair is not
 * unblocked by hand while its ticket is open).
 *
 * The stored state is the module's own part of the road: open → fixed (the repair task done) → closed (a nurse
 * confirmed: the repair task verified) | cancelled. Whether a technician holds the work is the task's state, read
 * through `task_id`, never copied here.
 */
export const maintenanceTickets = pgTable(
  "maintenance_tickets",
  {
    id: text("id").primaryKey(),
    /** The number people say: "repair #123". */
    number: serial("number").notNull(),
    placeResourceId: text("place_resource_id").notNull().references(() => resources.id),
    itemKind: text("item_kind").notNull(),
    /** A free-text asset tag until the asset register exists. */
    itemTag: text("item_tag"),
    category: text("category").notNull(),
    urgency: text("urgency").notNull(),
    description: text("description").notNull(),
    raisedBy: text("raised_by").notNull(),
    source: text("source").notNull(),
    bedBlockId: text("bed_block_id").references(() => ipdBedBlocks.id),
    taskId: text("task_id").references(() => tasks.id),
    state: text("state").notNull().default("open"),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    fixedBy: text("fixed_by"),
    fixedAt: timestamp("fixed_at", { withTimezone: true }),
    closedBy: text("closed_by"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    replacementFlag: boolean("replacement_flag").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    uniqueIndex("maintenance_tickets_number_ux").on(t.number),
    index("maintenance_tickets_open_idx").on(t.state, t.dueAt).where(sql`${t.state} in ('open', 'fixed')`),
    index("maintenance_tickets_place_idx").on(t.placeResourceId, t.itemKind, t.createdAt),
    index("maintenance_tickets_tag_idx").on(t.itemTag, t.createdAt).where(sql`${t.itemTag} is not null`),
    index("maintenance_tickets_block_idx").on(t.bedBlockId).where(sql`${t.bedBlockId} is not null`),
    index("maintenance_tickets_task_idx").on(t.taskId),
    check("maintenance_tickets_state_ck", sql`${t.state} in ('open', 'fixed', 'closed', 'cancelled')`),
    check(
      "maintenance_tickets_item_ck",
      sql`${t.itemKind} in ('bed', 'oxygen_point', 'suction', 'monitor', 'fixture', 'electrical', 'plumbing', 'ac', 'other')`,
    ),
    check("maintenance_tickets_category_ck", sql`${t.category} in ('general', 'biomedical')`),
    check("maintenance_tickets_urgency_ck", sql`${t.urgency} in ('routine', 'urgent', 'critical')`),
    check("maintenance_tickets_source_ck", sql`${t.source} in ('person', 'device', 'block')`),
    check("maintenance_tickets_description_ck", sql`char_length(${t.description}) between 1 and 500`),
    check("maintenance_tickets_fixed_ck", sql`${t.state} not in ('fixed', 'closed') or ${t.fixedAt} is not null`),
    check("maintenance_tickets_closed_ck", sql`${t.state} <> 'closed' or (${t.closedAt} is not null and ${t.closedBy} is not null)`),
    check("maintenance_tickets_cancel_ck", sql`${t.state} <> 'cancelled' or char_length(${t.cancelReason}) > 0`),
  ],
);

/** A ticket's history: one row per change, `seq` = the ticket's new `version`. Append-only (trigger). */
export const maintenanceTicketEvents = pgTable(
  "maintenance_ticket_events",
  {
    ticketId: text("ticket_id").notNull().references(() => maintenanceTickets.id),
    seq: integer("seq").notNull(),
    act: text("act").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    primaryKey({ columns: [t.ticketId, t.seq] }),
    check(
      "maintenance_ticket_events_act_ck",
      sql`${t.act} in ('raised', 'reported_again', 'dispatched', 'fixed', 'closed', 'cancelled')`,
    ),
  ],
);
