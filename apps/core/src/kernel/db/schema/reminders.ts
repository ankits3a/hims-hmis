import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./auth";

/**
 * E1.2 — PERSONAL REMINDERS (decision 0064; spec /opt/hmis-context/SPEC-reminders-2026-10-11.md).
 *
 * A staff member's own reminder. NOT a `workflow_timers` row: that table's `instance_id` is NOT NULL
 * (a timer belongs to a workflow instance), and a reminder belongs to a person. No patient column,
 * deliberately: the text is the person's own words and is shown only to them.
 *
 * `due_at` is the NEXT firing. A one-off is spent by `fired_at`; a repeating one never gets a
 * `fired_at` — each firing moves `due_at` on (`nextOccurrence`, contracts/reminders.ts), claimed by a
 * conditional UPDATE on the old `due_at` so two workers cannot both move it.
 */
export const userReminders = pgTable(
  "user_reminders",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    text: text("text").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    repeat: text("repeat").notNull(),
    firedAt: timestamp("fired_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("user_reminders_due_idx").on(t.dueAt).where(sql`${t.firedAt} is null and ${t.cancelledAt} is null`),
    index("user_reminders_user_idx").on(t.userId),
    check("user_reminders_repeat_ck", sql`${t.repeat} in ('none', 'daily', 'mon_sat', 'weekly')`),
    check("user_reminders_text_ck", sql`char_length(${t.text}) between 1 and 80`),
  ],
);
