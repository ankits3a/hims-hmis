import { and, eq, inArray, isNull } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { requestApproval } from "../../kernel/approvals/requests";
import { getApproval } from "../../kernel/approvals/worklist";
import { patientAllergies, patientGuardians, patientMergeRequests, patients } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { patientMerged, patientUnmerged } from "./events";
import { PatientError } from "./uhid";
import type { Db, Tx } from "../../kernel/db/client";

/** Registered as DATA at go-live (runbook, T10 docs); tests register them inline. No engine work — Plan 04 gate report §8. */
export const MERGE_APPROVAL_TYPE = "patient_merge";
export const UNMERGE_APPROVAL_TYPE = "patient_unmerge";

export type MergeRequestRow = typeof patientMergeRequests.$inferSelect;
type MovedRows = { allergyIds: string[]; guardianIds: string[] };

export async function createMergeRequest(
  tx: Tx,
  actor: Actor,
  input: { winnerId: string; loserId: string; note: string },
): Promise<{ mergeRequestId: string; approvalId: string; instanceId: string }> {
  if (actor.type !== "user") throw new PatientError("user_actor_required");
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (note === "") throw new PatientError("reason_required", "a merge request needs a reason (§11.5 review)");
  if (input.winnerId === input.loserId) throw new PatientError("merge_same_patient");

  const rows = await tx.select().from(patients).where(inArray(patients.id, [input.winnerId, input.loserId]));
  const winner = rows.find((r) => r.id === input.winnerId);
  const loser = rows.find((r) => r.id === input.loserId);
  if (!winner || !loser) throw new PatientError("patient_not_found");
  if (winner.status !== "active" || loser.status !== "active") {
    throw new PatientError("patient_not_active", "both records must be active to merge");
  }

  const mergeRequestId = newId();
  // Tx-first requestApproval (Plan 04): the approval, its workflow instance, and this row
  // commit together or not at all. A duplicate-pending conflict below rolls ALL of it back.
  const { approvalId, instanceId } = await requestApproval(tx, actor, {
    typeKey: MERGE_APPROVAL_TYPE,
    subject: { type: "patient_merge_request", id: mergeRequestId },
    patientId: input.loserId,
    requestNote: note,
  });

  const inserted = await tx
    .insert(patientMergeRequests)
    .values({
      id: mergeRequestId,
      winnerId: input.winnerId,
      loserId: input.loserId,
      approvalId,
      requestNote: note,
      snapshot: { winnerBefore: winner, loserBefore: loser },
      requestedBy: actor.id,
    })
    .onConflictDoNothing()
    .returning({ id: patientMergeRequests.id });
  if (inserted.length === 0) {
    // Lost the partial-unique race (one pending request per loser) — unwind everything.
    throw new PatientError("merge_already_requested", "a pending merge request already exists for this record");
  }
  return { mergeRequestId, approvalId, instanceId };
}

/** Embeds approval statuses so the review UI needs no approvals-engine read permission. */
export async function getMergeRequest(
  db: Db,
  mergeRequestId: string,
): Promise<{ request: MergeRequestRow; approvalStatus: string | null; unmergeApprovalStatus: string | null } | null> {
  const rows = await db.select().from(patientMergeRequests).where(eq(patientMergeRequests.id, mergeRequestId));
  const request = rows[0];
  if (!request) return null;
  const approval = await getApproval(db, request.approvalId);
  const unmergeApproval = request.unmergeApprovalId !== null ? await getApproval(db, request.unmergeApprovalId) : null;
  return {
    request,
    approvalStatus: approval?.status ?? null,
    unmergeApprovalStatus: unmergeApproval?.status ?? null,
  };
}

/**
 * Check-on-execute (owner decision Q3), and this STAYS check-on-execute BY DESIGN even though
 * Plan 08.5 puts runDispatchCycle on a clock: the gate is verified against the approvals row at
 * execution time, never via an event consumer, because a merge is a synchronous admin action a
 * human is waiting on at the screen — trading that for the dispatcher's at-least-once, polled
 * delivery would buy nothing (Global Constraint 1, roadmap trap 1). The worker existing does not
 * change this file's shape.
 */
export async function executeMerge(
  db: Db,
  actor: Actor,
  mergeRequestId: string,
): Promise<{ winnerId: string; loserId: string }> {
  if (actor.type !== "user") throw new PatientError("user_actor_required");
  const reqRows = await db.select().from(patientMergeRequests).where(eq(patientMergeRequests.id, mergeRequestId));
  const req = reqRows[0];
  if (!req) throw new PatientError("unknown_merge_request");
  const approval = await getApproval(db, req.approvalId);
  if (!approval || approval.status !== "granted") {
    throw new PatientError("approval_not_granted", "the merge approval must be granted first (§11.5)");
  }

  return withTx(db, async (tx) => {
    // Single-winner claim FIRST — everything after runs at most once per request.
    const claimed = await tx
      .update(patientMergeRequests)
      .set({ status: "executed", executedBy: actor.id, executedAt: new Date() })
      .where(and(eq(patientMergeRequests.id, mergeRequestId), eq(patientMergeRequests.status, "requested")))
      .returning({ id: patientMergeRequests.id });
    if (claimed.length === 0) throw new PatientError("merge_not_requested", "already executed or unmade");

    const movedAllergies = await tx
      .update(patientAllergies)
      .set({ patientId: req.winnerId })
      .where(eq(patientAllergies.patientId, req.loserId))
      .returning({ id: patientAllergies.id });
    const movedGuardians = await tx
      .update(patientGuardians)
      .set({ patientId: req.winnerId })
      .where(eq(patientGuardians.patientId, req.loserId))
      .returning({ id: patientGuardians.id });
    // Photos deliberately NEVER move: the loser's photo stays on the frozen row (intact for
    // unmerge, hidden behind chain resolution); the winner's own photo — or absence — stands.

    const frozen = await tx
      .update(patients)
      .set({ status: "merged", mergedIntoPatientId: req.winnerId, updatedBy: actor.id, updatedAt: new Date() })
      .where(and(eq(patients.id, req.loserId), eq(patients.status, "active")))
      .returning({ uhid: patients.uhid });
    if (frozen.length === 0) throw new PatientError("patient_not_active", "loser record changed concurrently");

    const moved: MovedRows = {
      allergyIds: movedAllergies.map((r) => r.id),
      guardianIds: movedGuardians.map((r) => r.id),
    };
    await tx.update(patientMergeRequests).set({ movedRows: moved }).where(eq(patientMergeRequests.id, mergeRequestId));

    const winnerRows = await tx.select({ uhid: patients.uhid }).from(patients).where(eq(patients.id, req.winnerId));
    await appendEvent(
      tx,
      patientMerged.make({
        actor,
        patientId: req.winnerId,
        correlationId: approval.instanceId, // §10.5: correlation = the backing workflow instance
        payload: {
          winnerPatientId: req.winnerId,
          loserPatientId: req.loserId,
          winnerUhid: winnerRows[0]!.uhid,
          loserUhid: frozen[0]!.uhid,
          mergeRequestId,
        },
      }),
    );
    return { winnerId: req.winnerId, loserId: req.loserId };
  });
}

export async function requestUnmerge(
  tx: Tx,
  actor: Actor,
  input: { mergeRequestId: string; note: string; actFirst?: boolean },
): Promise<{ approvalId: string; instanceId: string }> {
  if (actor.type !== "user") throw new PatientError("user_actor_required");
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (note === "") throw new PatientError("reason_required", "an unmerge request needs a reason");
  const rows = await tx.select().from(patientMergeRequests).where(eq(patientMergeRequests.id, input.mergeRequestId));
  const req = rows[0];
  if (!req) throw new PatientError("unknown_merge_request");
  if (req.status !== "executed") throw new PatientError("merge_not_executed", "only an executed merge can be unmade");

  const { approvalId, instanceId } = await requestApproval(tx, actor, {
    typeKey: UNMERGE_APPROVAL_TYPE,
    subject: { type: "patient_merge_request", id: input.mergeRequestId },
    patientId: req.loserId,
    requestNote: note,
    ...(input.actFirst === true ? { actFirst: true } : {}),
  });
  // Claim the ONE unmerge slot (conditional on null) — a lost race unwinds the approval too.
  const claimed = await tx
    .update(patientMergeRequests)
    .set({ unmergeApprovalId: approvalId })
    .where(and(eq(patientMergeRequests.id, input.mergeRequestId), isNull(patientMergeRequests.unmergeApprovalId)))
    .returning({ id: patientMergeRequests.id });
  if (claimed.length === 0) {
    throw new PatientError("unmerge_already_requested", "an unmerge request already exists (a rejected one needs the manual path — v1)");
  }
  return { approvalId, instanceId };
}

export async function executeUnmerge(db: Db, actor: Actor, mergeRequestId: string): Promise<void> {
  if (actor.type !== "user") throw new PatientError("user_actor_required");
  const rows = await db.select().from(patientMergeRequests).where(eq(patientMergeRequests.id, mergeRequestId));
  const req = rows[0];
  if (!req) throw new PatientError("unknown_merge_request");
  if (req.status !== "executed") throw new PatientError("merge_not_executed");
  if (req.unmergeApprovalId === null) throw new PatientError("unmerge_not_requested");

  const approval = await getApproval(db, req.unmergeApprovalId);
  // E-15 act-first-review-after: an acted-first request executes while its review is pending.
  // Direct null-check (not a boolean variable) so TS narrows `approval` for the closure below.
  if (approval === null || !(approval.status === "granted" || (approval.actedFirst && approval.status === "pending"))) {
    throw new PatientError("approval_not_granted", "unmerge needs a grant, or an act-first request");
  }

  await withTx(db, async (tx) => {
    const claimed = await tx
      .update(patientMergeRequests)
      .set({ status: "unmerged", unmergedBy: actor.id, unmergedAt: new Date() })
      .where(and(eq(patientMergeRequests.id, mergeRequestId), eq(patientMergeRequests.status, "executed")))
      .returning({ id: patientMergeRequests.id });
    if (claimed.length === 0) throw new PatientError("merge_not_executed", "already unmade");

    const moved = (req.movedRows ?? { allergyIds: [], guardianIds: [] }) as MovedRows;
    if (moved.allergyIds.length > 0) {
      await tx.update(patientAllergies).set({ patientId: req.loserId }).where(inArray(patientAllergies.id, moved.allergyIds));
    }
    if (moved.guardianIds.length > 0) {
      await tx.update(patientGuardians).set({ patientId: req.loserId }).where(inArray(patientGuardians.id, moved.guardianIds));
    }
    const unfrozen = await tx
      .update(patients)
      .set({ status: "active", mergedIntoPatientId: null, updatedBy: actor.id, updatedAt: new Date() })
      .where(and(eq(patients.id, req.loserId), eq(patients.status, "merged")))
      .returning({ id: patients.id });
    if (unfrozen.length === 0) throw new PatientError("patient_not_active", "loser record changed concurrently");

    await appendEvent(
      tx,
      patientUnmerged.make({
        actor,
        patientId: req.loserId,
        correlationId: approval.instanceId,
        payload: { winnerPatientId: req.winnerId, loserPatientId: req.loserId, mergeRequestId },
      }),
    );
  });
}
