import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { items } from "./materials";
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
