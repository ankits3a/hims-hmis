import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./auth";

// In-app alerts — the one consumer's output (D6). The uniqueness unit is the
// (source_event_id, user_id) PAIR, not source_event_id alone: one escalation.triggered fans
// to every id in resolvedUserIds, so a per-row unique would cap one escalation at ONE
// recipient. Corrected deliberately from the roadmap's shorthand.
//
// NO PATIENT IDENTITY IN ANY COLUMN (Global Constraint 6): title/body are built from
// defKey · state · rung only, and the recipient reaches the patient through
// permission-checked routes. user_id is the only foreign key this plan adds anywhere, and it
// points OUTWARD, into users.
export const alerts = pgTable(
  "alerts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    refType: text("ref_type"),
    refId: text("ref_id"),
    sourceEventId: text("source_event_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("alerts_source_event_user_ux").on(t.sourceEventId, t.userId),
    index("alerts_user_read_idx").on(t.userId, t.readAt),
  ],
);
