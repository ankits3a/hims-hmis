import { and, eq } from "drizzle-orm";
import { appendEvent } from "../../kernel/events/append";
import { formularyStaging } from "../../kernel/db/schema";
import { FormularyError } from "./errors";
import { stagingApproved, stagingRejected } from "./events";
import { addMedicine } from "./masters";
import { normalizeDrugName } from "./resolve";
import type { RouteClass } from "./masters";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

export type StagingRow = typeof formularyStaging.$inferSelect;

/**
 * PLAN 16a T7 — mined rows, and the one rule that governs all of them: **SEED IS NEVER AUTHORITY**
 * (spec D2). Nothing here reaches a live table without a pharmacist admitting it, one item at a
 * time, having looked at it.
 *
 * ═══ PULL-BASED, NOT A QUEUE (spec §1.1) ═══
 *
 * There is deliberately NO "list all pending rows" function, and the screen has no review-queue
 * view. The mined mass is potentially tens of thousands of rows — a lookup DICTIONARY, not a
 * backlog. A queue view would turn "we have a dictionary" into "somebody owes 40 000 reviews",
 * which is how a useful tool becomes a guilt-inducing one nobody opens. The pharmacist types a
 * name they are about to stock; `searchStaging` answers with what the crawl already knows.
 *
 * ═══ THIS SEARCH MAY MATCH GENEROUSLY, AND THAT IS NOT A DD2 EXCEPTION ═══
 *
 * DD2 says fuzzy suggests and exact resolves. `resolveDrugTexts` feeds SAFETY CHECKS with no human
 * in the loop and therefore resolves only exactly. This function feeds a HUMAN a list to choose
 * from, and a pharmacist who typed "amoxycillin" should still find the amoxicillin record. The
 * difference is not the strictness; it is whether anybody looks at the answer.
 *
 * ═══ ISOLATION ═══
 *
 * A pending row is invisible to every resolution path — `resolve.ts` reads `formulary_medicines`
 * and `formulary_salts` and never this table. `staging.test.ts` asserts that by fixture rather
 * than by inspection, because "the code does not query it" is a claim that rots the first time
 * somebody adds a convenience join.
 */

/** Pending rows whose name CONTAINS the normalized query. A human reads what this returns. */
export async function searchStaging(db: Db, q: string): Promise<StagingRow[]> {
  const key = normalizeDrugName(q);
  if (key === "") return [];
  const rows = await db.select().from(formularyStaging).where(eq(formularyStaging.status, "pending"));
  return rows
    .filter((row) => normalizeDrugName(row.name).includes(key))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 20);
}

export async function getStagingRow(db: Db, stagingId: string): Promise<StagingRow | null> {
  const rows = await db.select().from(formularyStaging).where(eq(formularyStaging.id, stagingId));
  return rows[0] ?? null;
}

/** The row must still be `pending`; anything else has already been decided by somebody. */
async function claimPending(tx: Tx, stagingId: string): Promise<StagingRow> {
  const rows = await tx
    .select()
    .from(formularyStaging)
    .where(and(eq(formularyStaging.id, stagingId), eq(formularyStaging.status, "pending")))
    .for("update");
  const row = rows[0];
  if (row === undefined) {
    throw new FormularyError(
      "staging_not_pending",
      `staging row ${stagingId} is not pending — it has been admitted or rejected already`,
    );
  }
  return row;
}

/**
 * Admit a mined row as a real medicine.
 *
 * THE COMPOSITION IS THE PHARMACIST'S INPUT, NOT THE PAYLOAD'S. The mined payload pre-fills the
 * form on screen; what lands in the formulary is what the human confirmed. That is the whole of
 * "seed never authority" in one parameter list — there is no code path here that reads
 * `row.payload` and writes it to a table.
 *
 * DD8's intra-FDC acknowledgement flows straight through to `addMedicine`, so an admitted FDC whose
 * own salts interact still needs the pharmacist to say so explicitly.
 */
export async function admitStaging(
  tx: Tx,
  actor: Actor,
  stagingId: string,
  input: {
    brandName: string; form: string; routeClass: RouteClass;
    strengthLabel?: string | null; scheduleFlag?: string | null;
    salts: { saltId: string; strength?: string | null }[];
    acknowledgeIntraFdc?: boolean;
  },
  now: Date = new Date(),
): Promise<{ medicineId: string }> {
  const row = await claimPending(tx, stagingId);
  const { medicineId } = await addMedicine(tx, actor, { ...input, stagingId });
  await tx
    .update(formularyStaging)
    .set({ status: "approved", reviewedBy: actor.id, reviewedAt: now, medicineId })
    .where(eq(formularyStaging.id, stagingId));
  await appendEvent(tx, stagingApproved.make({
    payload: { stagingId, medicineId, name: row.name, sourceUrl: row.sourceUrl },
    actor, correlationId: medicineId,
  }));
  return { medicineId };
}

/** The mirror. A rejected row keeps its payload — the record of what was refused is the point. */
export async function rejectStaging(
  tx: Tx,
  actor: Actor,
  stagingId: string,
  reason: string,
  now: Date = new Date(),
): Promise<void> {
  const row = await claimPending(tx, stagingId);
  await tx
    .update(formularyStaging)
    .set({ status: "rejected", reviewedBy: actor.id, reviewedAt: now })
    .where(eq(formularyStaging.id, stagingId));
  await appendEvent(tx, stagingRejected.make({
    payload: { stagingId, name: row.name, reason }, actor, correlationId: stagingId,
  }));
}
