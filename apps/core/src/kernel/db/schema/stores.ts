import { sql } from "drizzle-orm";
import { boolean, check, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { items, storeIndents } from "./materials";
import { resources } from "./resources";

/**
 * STORES S1 (#1111, decision 0099) — the non-drug Stores module's own table.
 *
 * Stores owns NO stock quantity: every quantity is a `stock_ledger` row posted through materials, and
 * every item is an `items` row (the one-ledger rule, `docs/specs/stores-programme.md` §3). What it
 * owns here is the one thing materials has no home for: a person's "Not in the list" request, which
 * the materials head resolves by creating the item or pointing to an existing one.
 *
 * `status` is `open` until resolved; `created` and `use_existing` both name the item the requester
 * should use (`resolved_item_id`), and the requester is sent exactly one notice either way.
 */
export const STORES_ITEM_REQUEST_STATUS_VALUES = ["open", "created", "use_existing"] as const;

export const storesItemRequests = pgTable(
  "stores_item_requests",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    note: text("note"),
    requestedBy: text("requested_by").notNull(),
    shelfId: text("shelf_id").references(() => resources.id),
    departmentId: text("department_id"),
    status: text("status").notNull().default("open"),
    resolvedItemId: text("resolved_item_id").references(() => items.id),
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("stores_item_requests_status_idx").on(t.status, t.createdAt),
    check("stores_item_requests_status_ck", sql`${t.status} in ('open', 'created', 'use_existing')`),
    check(
      "stores_item_requests_resolution_ck",
      sql`(${t.status} = 'open') = (${t.resolvedItemId} is null and ${t.resolvedAt} is null)`,
    ),
  ],
);

/**
 * STORES S2a (#1112, decisions 1, 2, 5) — WHAT A STORES TICKET ADDS TO THE MATERIALS INDENT. The ticket IS the
 * indent (one requisition paper for the house); this row carries what pharmacy's indent has no use for: the
 * department and shelf it was raised for, the priority and its reason, needed-by, deliver-to, the channel, the
 * night-store routing, and the link to the ticket it re-raises or re-asks, whose first raise time is the clock
 * (`clock_from`). Written once at raise; nothing updates it (a re-raise is a NEW ticket that names the first).
 */
export const STORES_TICKET_PRIORITY_VALUES = ["routine", "urgent", "emergency"] as const;
export const STORES_TICKET_CHANNEL_VALUES = ["phone", "web", "copilot", "agent"] as const;

export const storesTicketDetails = pgTable(
  "stores_ticket_details",
  {
    indentId: text("indent_id").primaryKey().references(() => storeIndents.id),
    departmentId: text("department_id").notNull(),
    shelfId: text("shelf_id").notNull().references(() => resources.id),
    priority: text("priority").notNull(),
    channel: text("channel").notNull().default("web"),
    neededBy: timestamp("needed_by", { withTimezone: true }),
    deliverTo: text("deliver_to"),
    emergencyReason: text("emergency_reason"),
    night: boolean("night").notNull().default(false),
    originIndentId: text("origin_indent_id").references(() => storeIndents.id),
    originKind: text("origin_kind"),
    clockFrom: timestamp("clock_from", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("stores_ticket_details_dept_idx").on(t.departmentId),
    index("stores_ticket_details_shelf_idx").on(t.shelfId),
    uniqueIndex("stores_ticket_details_reraise_ux").on(t.originIndentId).where(sql`${t.originKind} = 're_raise'`),
    check("stores_ticket_details_priority_ck", sql`${t.priority} in ('routine', 'urgent', 'emergency')`),
    check("stores_ticket_details_channel_ck", sql`${t.channel} in ('phone', 'web', 'copilot', 'agent')`),
    check("stores_ticket_details_emergency_ck", sql`${t.priority} <> 'emergency' or ${t.emergencyReason} is not null`),
    check("stores_ticket_details_origin_ck", sql`(${t.originIndentId} is null) = (${t.originKind} is null) and (${t.originKind} is null or ${t.originKind} in ('re_raise', 're_ask'))`),
  ],
);

/**
 * STORES S2a (#1112, decision 6) — THE PICKING CLAIM: one picker per ticket. Each claim is a row (insert only);
 * the live claim is the newest, and it lapses 30 minutes after it was taken (`tickets.ts` `CLAIM_IDLE_MS`). The
 * timeline reads every claim as a step.
 */
export const storesPickingClaims = pgTable(
  "stores_picking_claims",
  {
    id: text("id").primaryKey(),
    indentId: text("indent_id").notNull().references(() => storeIndents.id),
    claimedBy: text("claimed_by").notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("stores_picking_claims_indent_idx").on(t.indentId, t.claimedAt)],
);
