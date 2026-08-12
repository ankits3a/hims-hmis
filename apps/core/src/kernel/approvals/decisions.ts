import { and, eq } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { appendEvent } from "../events/append";
import { assertNotSodPair } from "../auth/sod";
import { transition } from "../workflow/instances";
import { approvals } from "../db/schema";
import { withTx } from "../db/client";
import { approvalGranted, approvalRejected } from "./events";
import { ApprovalError } from "./types";
import type { UrgencyClass } from "./types";
import type { Db } from "../db/client";

/** Plan 02's seeded pair (kernel/auth/sod.ts:9): "Requester vs approver of any approvals-engine item". */
export const REQUESTER_APPROVER_PAIR = "requester_approver";

export type DecisionInput = { approvalId: string; note: string };

/**
 * A decision is a Plan 03 transition (owner decision Q1a): transition() is the single-winner
 * arbiter (conditional UPDATE on the instance's current state), enforces the approver role,
 * cancels the closure-SLA timer, and completes the instance. The approvals row mirrors the
 * terminal state in the SAME transaction via its own conditional UPDATE on status='pending' —
 * row and instance move together or not at all. Db-first (like migrateInstance): the SoD
 * check must ride its own transaction so sod.violation_blocked survives this rollback.
 *
 * There is deliberately NO emergency bypass of requester≠approver here — E-5 precedence
 * belongs to workflow-definition governance (Plan 03 T5), not the approvals engine.
 */
async function decide<V extends "granted" | "rejected">(
  db: Db,
  actor: Actor,
  input: DecisionInput,
  verdict: V,
): Promise<{ status: V }> {
  // Mandatory note at RUNTIME, before any DB read (Plan 03 T8's gate lesson: an empty
  // string sails through a type-level requirement). typeof-guarded so an untyped caller
  // passing undefined gets note_required, not a TypeError.
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (note === "") {
    throw new ApprovalError("note_required", "a decision note is mandatory (§8: approve/reject with note)");
  }
  if (actor.type !== "user") {
    throw new ApprovalError("user_actor_required", "only user actors may decide approvals — a system actor would bypass the approver-role check (silent auto-approval); agents are the Plan 12 seam");
  }

  const rows = await db.select().from(approvals).where(eq(approvals.id, input.approvalId));
  const row = rows[0];
  if (!row) throw new ApprovalError("unknown_approval", `unknown approval ${input.approvalId}`);
  if (row.status !== "pending") {
    throw new ApprovalError("not_pending", `approval ${input.approvalId} is already ${row.status}`);
  }

  // Requester ≠ approver (S10 §11). Appends sod.violation_blocked in its OWN transaction
  // on violation, so the audit trail survives the refused decision.
  await assertNotSodPair(db, REQUESTER_APPROVER_PAIR, { type: "user", id: row.requesterId }, actor);

  return withTx(db, async (tx) => {
    await transition(tx, row.instanceId, verdict, actor, { note });
    const updated = await tx
      .update(approvals)
      .set({ status: verdict, decisionNote: note, decidedBy: actor.id, decidedAt: new Date() })
      .where(and(eq(approvals.id, row.id), eq(approvals.status, "pending")))
      .returning({ id: approvals.id });
    if (updated.length === 0) {
      // Belt and braces: unreachable when transition() won, but the mirror must never
      // move on its own terms — same single-winner grammar, no read-then-write.
      throw new ApprovalError("not_pending", `approval ${row.id} was decided concurrently`);
    }
    const def = verdict === "granted" ? approvalGranted : approvalRejected;
    await appendEvent(
      tx,
      def.make({
        actor,
        correlationId: row.instanceId,
        ...(row.patientId !== null ? { patientId: row.patientId } : {}),
        ...(row.encounterId !== null ? { encounterId: row.encounterId } : {}),
        payload: {
          approvalId: row.id,
          typeKey: row.typeKey,
          requesterId: row.requesterId,
          decidedBy: actor.id,
          note,
          urgencyClass: row.urgencyClass as UrgencyClass, // text column; zod re-validates
          actedFirst: row.actedFirst,
        },
      }),
    );
    return { status: verdict };
  });
}

export async function approveRequest(db: Db, actor: Actor, input: DecisionInput): Promise<{ status: "granted" }> {
  return decide(db, actor, input, "granted");
}

export async function rejectRequest(db: Db, actor: Actor, input: DecisionInput): Promise<{ status: "rejected" }> {
  return decide(db, actor, input, "rejected");
}
