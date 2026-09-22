import { and, eq, sql } from "drizzle-orm";
import { rosterDelegations } from "../../kernel/db/schema/roster";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * PHASE R (R3) — the delegation READ, split from `delegations.ts` on purpose.
 *
 * `access.ts` needs this read, and `delegations.ts` needs `access.ts` for its own permission check.
 * In one file that is a cycle — one that happens to work under the CommonJS ts-jest emits, because
 * both bindings are only touched at call time, and that would stop being true the day this module
 * is loaded any other way. A ten-line file makes the dependency a DAG instead of a bet.
 */

export type RosterDelegationRow = typeof rosterDelegations.$inferSelect;

/**
 * The delegations in force for this person at this instant. Read by `requireRosterAct` AFTER the
 * ordinary permission check fails, so the common path costs nothing and the delegation is what it
 * should be: an exception with a name and an end date on it.
 */
export async function delegationsInForce(
  exec: Db | Tx, delegateUserId: string, at: Date,
): Promise<RosterDelegationRow[]> {
  return (exec as Db).select().from(rosterDelegations).where(and(
    eq(rosterDelegations.delegateUserId, delegateUserId),
    sql`${rosterDelegations.startsAt} <= ${at}`,
    sql`${rosterDelegations.endsAt} > ${at}`,
  ));
}
