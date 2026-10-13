import { and, eq, isNull } from "drizzle-orm";
import { ipdBedProposals } from "../../kernel/db/schema";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * E5.2 (#739) — BED FLOW's outcome log, written by the ACTS (spec §4.8; plan E5.2 "acceptance and override rates logged
 * per week"). Kept apart from `bed-flow.ts` because the bed intents call it and `bed-flow.ts` imports the bed intents'
 * file: one direction only.
 *
 * - `settleBedProposalIn` — a bed act placed or held this admission (reserve_bed, assign_bed, admit, the emergency lane,
 *   the downtime back-fill). The open proposal ends `accepted` when the bed is the proposed one, `overridden` otherwise.
 * - `withdrawBedProposalIn` — the admission left the waiting list without a bed (cancelled), or the read found the
 *   proposal stale (bed taken, blocked, no longer rule-valid).
 *
 * Both run in the caller's transaction, so the outcome commits with the act or not at all. With no open proposal they
 * do nothing (Bed Flow never showed one).
 */

export type BedFlowWithdrawReason =
  | "bed_taken" | "bed_blocked" | "bed_not_valid" | "bed_given_to_earlier_request" | "admission_cancelled" | "admission_left_waiting";

export async function settleBedProposalIn(tx: Tx | Db, admissionId: string, bedId: string, at: Date): Promise<"accepted" | "overridden" | null> {
  const open = (await tx.select().from(ipdBedProposals)
    .where(and(eq(ipdBedProposals.admissionId, admissionId), isNull(ipdBedProposals.endedAt))))[0];
  if (open === undefined) return null;
  const outcome = open.bedId === bedId ? "accepted" : "overridden";
  await tx.update(ipdBedProposals).set({ endedAt: at, outcome, outcomeBedId: bedId })
    .where(and(eq(ipdBedProposals.id, open.id), isNull(ipdBedProposals.endedAt)));
  return outcome;
}

export async function withdrawBedProposalIn(tx: Tx | Db, admissionId: string, reason: BedFlowWithdrawReason, at: Date): Promise<boolean> {
  const done = await tx.update(ipdBedProposals).set({ endedAt: at, outcome: "withdrawn", withdrawReason: reason })
    .where(and(eq(ipdBedProposals.admissionId, admissionId), isNull(ipdBedProposals.endedAt)))
    .returning({ id: ipdBedProposals.id });
  return done.length > 0;
}
