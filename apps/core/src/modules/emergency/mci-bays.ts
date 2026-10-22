import { and, eq, isNull } from "drizzle-orm";
import { erMciEvents, erMciSurgeBeds } from "../../kernel/db/schema";
import type { Db, Tx } from "../../kernel/db/client";

/** ER lane 8 (#815) — the running Code Yellow (at most one), or undefined. */
export async function runningMci(db: Db | Tx): Promise<typeof erMciEvents.$inferSelect | undefined> {
  return (await (db as Db).select().from(erMciEvents).where(isNull(erMciEvents.stoodDownAt)).limit(1))[0];
}

/**
 * A surge bay: an overflow-class bed the duty manager or the MS opened to the ER for the RUNNING Code Yellow. After the
 * stand-down no new patient goes into one (those already in it stay until they leave).
 */
export async function isSurgeBay(db: Db | Tx, bedId: string): Promise<boolean> {
  const rows = await (db as Db).select({ id: erMciSurgeBeds.id }).from(erMciSurgeBeds)
    .innerJoin(erMciEvents, eq(erMciEvents.id, erMciSurgeBeds.mciId))
    .where(and(eq(erMciSurgeBeds.bedId, bedId), isNull(erMciEvents.stoodDownAt))).limit(1);
  return rows.length > 0;
}
