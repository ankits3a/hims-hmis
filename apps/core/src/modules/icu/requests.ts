import { and, desc, eq, inArray } from "drizzle-orm";
import { ICU_HOLD_REVIEW_MINUTES, icuDecisionInput, icuRequestInput, newId } from "@hmis/contracts";
import { approveRequest, rejectRequest } from "../../kernel/approvals/decisions";
import { icuRequestEvents, icuRequests, ipdAdmissions, ipdVitals, patients } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { requestIpdApproval } from "../ipd";
import { holdsAnyRole, inTx, iso, parse, patientWords, requirePermission } from "./common";
import { IcuError } from "./errors";
import { icuRequestDecided, icuRequestRaised } from "./events";
import { ICU_DECIDE, ICU_REQUEST, ICU_VIEW } from "./permissions";
import type { Actor, IcuRequestView, IcuTriage } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ICU IC-1 (#984, D1) — THE ICU REQUEST. From the ER, a ward or OT, with a priority class (1–4, the SCCM classes) and
 * triage scores. The request asks the `ipd_icu_admission` approval at once (requester = the requesting doctor), so the
 * existing admit gate (`requireIcuApproval`) is the one place an ICU bed is refused: the admit desk passes the request's
 * approval, and it is GRANTED only by the intensivist's "approve" here. A refusal and a hold need a reason and are logged
 * with the decider's name (`icu_request_events`); a hold carries the monitoring asked for and a review clock.
 *
 * DECIDED (standard practice; no money): the scores a requester leaves out are pre-filled from the open admission's latest
 * vitals set — NEWS2 as the ward scored it, and qSOFA (RR ≥ 22, systolic ≤ 100, not alert). Lab-derived scores (lactate,
 * SOFA) are what the requester types; the lab pre-fill waits for the lab's result read seam.
 */

/** Who may decide: the `intensivist` role (the approval type's second decider) — the MS decides in the approvals inbox. */
export const ICU_DECIDER_ROLES = ["intensivist"] as const;

type Row = typeof icuRequests.$inferSelect;

async function viewOf(db: Db | Tx, r: Row): Promise<IcuRequestView> {
  const p = await patientWords(db, r.patientId);
  return {
    id: r.id, patientId: r.patientId, patientName: p.name, uhid: p.uhid, admissionId: r.admissionId,
    source: r.source as IcuRequestView["source"], priorityClass: r.priorityClass, triage: r.triage as IcuTriage, reason: r.reason,
    state: r.state as IcuRequestView["state"], requestedBy: r.requestedBy, requestedAt: r.requestedAt.toISOString(),
    approvalId: r.approvalId, decidedBy: r.decidedBy, decidedAt: iso(r.decidedAt), decisionReason: r.decisionReason,
    reviewAt: iso(r.reviewAt), monitoring: r.monitoring,
  };
}

/** NEWS2 and qSOFA from the open admission's latest vitals set (never overriding what the requester typed). */
async function prefillTriage(db: Db, admissionId: string | undefined, typed: IcuTriage): Promise<IcuTriage> {
  if (admissionId === undefined) return typed;
  const v = (await db.select().from(ipdVitals).where(and(eq(ipdVitals.admissionId, admissionId), eq(ipdVitals.refused, false)))
    .orderBy(desc(ipdVitals.observedAt)).limit(1))[0];
  if (v === undefined) return typed;
  const out: IcuTriage = { ...typed };
  if (out.news2 === undefined && v.scoreKind === "news2" && v.scoreValue !== null) out.news2 = v.scoreValue;
  if (out.qsofa === undefined && (v.respRate !== null || v.systolic !== null || v.consciousness !== null)) {
    out.qsofa = (v.respRate !== null && v.respRate >= 22 ? 1 : 0) + (v.systolic !== null && v.systolic <= 100 ? 1 : 0)
      + (v.consciousness !== null && v.consciousness !== "alert" ? 1 : 0);
  }
  return out;
}

export async function requestIcu(db: Db, actor: Actor, raw: unknown, now: Date = new Date()): Promise<IcuRequestView> {
  const input = parse(icuRequestInput, raw);
  await requirePermission(db, actor, ICU_REQUEST);
  const patient = (await db.select({ id: patients.id }).from(patients).where(eq(patients.id, input.patientId)))[0];
  if (patient === undefined) throw new IcuError("unknown_patient");
  if (input.admissionId !== undefined) {
    const a = (await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, input.admissionId)))[0];
    if (a === undefined || a.patientId !== input.patientId) throw new IcuError("unknown_admission");
  }
  const open = (await db.select().from(icuRequests)
    .where(and(eq(icuRequests.patientId, input.patientId), inArray(icuRequests.state, ["pending", "on_hold"]))))[0];
  if (open !== undefined) throw new IcuError("request_open", { requestId: open.id });
  const triage = await prefillTriage(db, input.admissionId, input.triage);
  const id = newId();
  const row = await inTx(db, async (tx) => {
    // The approval names the admission when the patient is already admitted (a step-up), else the patient (the ER / OT /
    // downtime lanes check the patient's id before the admission exists — `backfillDowntime`'s subject rule).
    const { approvalId } = await requestIpdApproval(tx, actor, {
      kind: "icu", subjectId: input.admissionId ?? input.patientId, patientId: input.patientId,
      note: `ICU request (${input.source}, priority ${String(input.priorityClass)}): ${input.reason}`,
    });
    const r = (await tx.insert(icuRequests).values({
      id, patientId: input.patientId, admissionId: input.admissionId ?? null, source: input.source, priorityClass: input.priorityClass,
      triage, reason: input.reason, state: "pending", approvalId, requestedBy: actor.id, requestedAt: now,
    }).returning())[0]!;
    await tx.insert(icuRequestEvents).values({ id: newId(), requestId: id, act: "raised", actorId: actor.id, reason: input.reason, at: now });
    await appendEvent(tx, icuRequestRaised.make({
      payload: { requestId: id, patientId: input.patientId, source: input.source, priorityClass: input.priorityClass },
      actor, correlationId: id, patientId: input.patientId, occurredAt: now,
    }));
    return r;
  });
  return viewOf(db, row);
}

export async function decideIcuRequest(db: Db, actor: Actor, raw: unknown, now: Date = new Date()): Promise<IcuRequestView> {
  const input = parse(icuDecisionInput, raw);
  if (actor.type !== "user") throw new IcuError("intensivist_only");
  await requirePermission(db, actor, ICU_DECIDE).catch(() => { throw new IcuError("intensivist_only"); });
  if (!(await holdsAnyRole(db, actor.id, ICU_DECIDER_ROLES))) throw new IcuError("intensivist_only");
  const r = (await db.select().from(icuRequests).where(eq(icuRequests.id, input.requestId)))[0];
  if (r === undefined) throw new IcuError("unknown_request");
  if (r.state !== "pending" && r.state !== "on_hold") throw new IcuError("request_closed", { state: r.state });
  if (r.requestedBy === actor.id) throw new IcuError("own_request");

  // The approval engine first (its own transaction: the role check, requester ≠ approver, the workflow step).
  if (input.decision !== "hold" && r.approvalId !== null) {
    if (input.decision === "approve") await approveRequest(db, actor, { approvalId: r.approvalId, note: input.reason });
    else await rejectRequest(db, actor, { approvalId: r.approvalId, note: input.reason });
  }
  const state = input.decision === "approve" ? "approved" : input.decision === "refuse" ? "refused" : "on_hold";
  const reviewAt = input.decision === "hold"
    ? (input.reviewAt !== undefined ? new Date(input.reviewAt) : new Date(now.getTime() + ICU_HOLD_REVIEW_MINUTES * 60_000))
    : null;
  const row = await inTx(db, async (tx) => {
    const u = (await tx.update(icuRequests).set({
      state, decidedBy: actor.id, decidedAt: now, decisionReason: input.reason, reviewAt,
      monitoring: input.decision === "hold" ? input.monitoring ?? null : r.monitoring,
    }).where(and(eq(icuRequests.id, r.id), inArray(icuRequests.state, ["pending", "on_hold"]))).returning())[0];
    if (u === undefined) throw new IcuError("request_closed");
    const act = input.decision === "approve" ? "approved" : input.decision === "refuse" ? "refused" : "held";
    await tx.insert(icuRequestEvents).values({ id: newId(), requestId: r.id, act, actorId: actor.id, reason: input.reason, at: now });
    await appendEvent(tx, icuRequestDecided.make({
      payload: { requestId: r.id, decision: input.decision, approvalId: r.approvalId },
      actor, correlationId: r.id, patientId: r.patientId, occurredAt: now,
    }));
    return u;
  });
  return viewOf(db, row);
}

/** The open requests first (oldest first), then the last day's decided ones. */
export async function listIcuRequests(db: Db, actor: Actor, now: Date = new Date()): Promise<IcuRequestView[]> {
  await requirePermission(db, actor, ICU_VIEW);
  const rows = await db.select().from(icuRequests).orderBy(desc(icuRequests.requestedAt)).limit(200);
  const since = now.getTime() - 24 * 3_600_000;
  const keep = rows.filter((r) => r.state === "pending" || r.state === "on_hold" || (r.decidedAt !== null && r.decidedAt.getTime() >= since));
  keep.sort((a, b) => {
    const open = (x: Row) => (x.state === "pending" || x.state === "on_hold" ? 0 : 1);
    return open(a) - open(b) || a.priorityClass - b.priorityClass || a.requestedAt.getTime() - b.requestedAt.getTime();
  });
  return Promise.all(keep.map((r) => viewOf(db, r)));
}
