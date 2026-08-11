import { pgTable, text, bigint, timestamp } from "drizzle-orm/pg-core";

export const eventCursors = pgTable("event_cursors", {
  consumer: text("consumer").primaryKey(),
  lastSeq: bigint("last_seq", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
