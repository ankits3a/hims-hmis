import { and, eq } from "drizzle-orm";
import { IPD_INTENTS, ipdIsInFuture, newId } from "@hmis/contracts";
import { raiseNoticeIn } from "../../kernel/alerts/notices";
import { withTx } from "../../kernel/db/client";
import { ipdConsults, ipdRounds } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { lockAdmission, onceIpd, provenanceOf, requireIpdPermission } from "./admission-core";
import { IPD_PLACED_STATES } from "./admission-place";
import { postConsultantVisit } from "./charges";
import { declareFitIn } from "./discharge";
import { IpdRefusal } from "./errors";
import { IPD_DISCHARGE_DECLARE, IPD_ROUND_SIGN } from "./permissions";
import { consultClosed, consultRequested, roundCosigned, roundSigned } from "./rounds-events";
import { isConsultant, mayCosign, onTeam, treatingTeamOf } from "./rounds-team";
import type { Actor, IpdIntentName } from "@hmis/contracts";
import type { z } from "zod";
import type { Db, Tx } from "../../kernel/db/client";
import type { AdmissionRow } from "./admission-core";

/**
 * E4.2 (#734) — THE ROUND (spec §4.5A, §4.9 E). Every act is one intent: parse → permission → idempotency → the
 * admission's lock → re-check state and team → write + event, in one transaction.
 *
 * - SIGN: a consultant's bedside round posts the day's visit through the charges seam `postConsultantVisit` — one
 *   chargeable visit per consultant per patient per IST day is THAT seam's rule (its unique index), not re-implemented
 *   here; a cross-consultant's visit is its `cross_visit`. A REMOTE review posts nothing (DECIDED: the tariff has no remote
 *   rate; spec "not a chargeable visit unless the owner's tariff says so"). A resident's or intern's round is a draft
 *   (`awaiting_cosign`) and posts nothing: only a consultant's own round is a consultant visit; co-signing is not a visit.
 * - FIT: "Fit for discharge" on the round runs `declareFitIn` in the round's own transaction — the treating consultant's
 *   only (a resident is refused `consultant_cosign_required`, any other consultant `not_treating_consultant`).
 * - The answers never say whether a visit was charged (decision 0058); `ipd_rounds.visit_outcome` keeps it for audit.
 */
type Input<N extends IpdIntentName> = z.infer<(typeof IPD_INTENTS)[N]["input"]>;
type Output<N extends IpdIntentName> = z.infer<(typeof IPD_INTENTS)[N]["output"]>;
type Opts = { now?: Date };

export function assertInBed(a: AdmissionRow): void {
  if (!(IPD_PLACED_STATES as readonly string[]).includes(a.state)) throw new IpdRefusal("admission_wrong_state", undefined, { state: a.state });
}

export async function signRound(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"sign_round">> {
  const input: Input<"sign_round"> = IPD_INTENTS.sign_round.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_ROUND_SIGN);
  if (input.fit !== undefined) await requireIpdPermission(db, actor, IPD_DISCHARGE_DECLARE);
  const at = opts.now ?? new Date();
  if (ipdIsInFuture(input.seenAt, at)) throw new IpdRefusal("time_in_future");
  const seenAt = new Date(input.seenAt);
  return onceIpd(db, actor, "sign_round", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const a = await lockAdmission(tx, input.admissionId);
    assertInBed(a);
    if (a.admittedAt !== null && seenAt.getTime() < a.admittedAt.getTime()) throw new IpdRefusal("admission_wrong_state", undefined, { state: a.state });
    const team = await treatingTeamOf(tx, a, seenAt);
    if (!onTeam(team, actor.id)) throw new IpdRefusal("not_treating_team");
    const consultant = actor.type === "user" && await isConsultant(tx, actor.id);
    if (input.fit !== undefined && !consultant) throw new IpdRefusal("consultant_cosign_required");

    let visitOutcome: string = "draft";
    if (consultant && input.mode === "remote_review") visitOutcome = "remote";
    else if (consultant) {
      visitOutcome = (await postConsultantVisit(tx, { admissionId: a.id, consultantUserId: actor.id, seenAt, source: "rounds_tap", actor })).outcome;
    }
    const roundId = newId();
    const status = consultant ? "signed" as const : "awaiting_cosign" as const;
    let fitDeclaredAt: string | null = null;
    let dischargeId: string | null = null;
    if (input.fit !== undefined) {
      const fit = await declareFitIn(tx, actor, a, { when: input.fit.when, disposition: input.fit.disposition }, at);
      fitDeclaredAt = fit.clockStartedAt;
      dischargeId = fit.declarationId;
    }
    await tx.insert(ipdRounds).values({
      id: roundId, admissionId: a.id, patientId: a.patientId, authorId: actor.id, authorKind: consultant ? "consultant" : "resident",
      mode: input.mode, seenAt, soap: input.soap, source: input.source ?? "typed", provenance: provenanceOf(actor), status,
      visitOutcome, dischargeId, createdAt: at,
    });
    await appendEvent(tx, roundSigned.make({
      payload: {
        roundId, admissionId: a.id, status, mode: input.mode, authorKind: consultant ? "consultant" : "resident",
        fitDeclared: fitDeclaredAt !== null, provenance: provenanceOf(actor),
      },
      actor, correlationId: a.id, patientId: a.patientId, encounterId: a.id, occurredAt: seenAt,
    }));
    return { roundId, status, signedBy: actor.id, seenAt: seenAt.toISOString(), mode: input.mode, fitDeclaredAt };
  }), at);
}

async function roundRow(db: Db | Tx, roundId: string) {
  const r = (await db.select().from(ipdRounds).where(eq(ipdRounds.id, roundId)))[0];
  if (r === undefined) throw new IpdRefusal("round_not_found");
  return r;
}

export async function cosignRound(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"cosign_round">> {
  const input: Input<"cosign_round"> = IPD_INTENTS.cosign_round.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_ROUND_SIGN);
  const at = opts.now ?? new Date();
  return onceIpd(db, actor, "cosign_round", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const first = await roundRow(tx, input.roundId);
    const a = await lockAdmission(tx, first.admissionId);
    const r = (await tx.select().from(ipdRounds).where(eq(ipdRounds.id, input.roundId)).for("update"))[0]!;
    if (r.status !== "awaiting_cosign") throw new IpdRefusal("round_not_awaiting_cosign", undefined, { status: r.status });
    const team = await treatingTeamOf(tx, a, at);
    const consultant = actor.type === "user" && await isConsultant(tx, actor.id);
    if (!mayCosign(team, actor.id, consultant)) throw new IpdRefusal("not_treating_consultant");
    await tx.update(ipdRounds).set({ status: "signed", cosignedBy: actor.id, cosignedAt: at, cosignNote: input.note ?? null })
      .where(eq(ipdRounds.id, r.id));
    await appendEvent(tx, roundCosigned.make({
      payload: { roundId: r.id, admissionId: a.id, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, encounterId: a.id, occurredAt: at,
    }));
    return { roundId: r.id, status: "signed" as const, cosignedBy: actor.id, cosignedAt: at.toISOString() };
  }), at);
}

export const IPD_CONSULT_NOTICE_KIND = "ipd_consult_requested";

export async function requestConsult(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"request_consult">> {
  const input: Input<"request_consult"> = IPD_INTENTS.request_consult.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_ROUND_SIGN);
  const at = opts.now ?? new Date();
  return onceIpd(db, actor, "request_consult", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const a = await lockAdmission(tx, input.admissionId);
    assertInBed(a);
    const team = await treatingTeamOf(tx, a, at);
    if (!onTeam(team, actor.id)) throw new IpdRefusal("not_treating_team");
    if (!(await isConsultant(tx, input.consultantId)) || input.consultantId === a.consultantId) {
      throw new IpdRefusal("consultant_not_found", undefined, { consultantId: input.consultantId });
    }
    const open = (await tx.select({ id: ipdConsults.id }).from(ipdConsults).where(and(
      eq(ipdConsults.admissionId, a.id), eq(ipdConsults.consultantId, input.consultantId), eq(ipdConsults.status, "open"),
    )))[0];
    if (open !== undefined) throw new IpdRefusal("consult_already_open", undefined, { consultId: open.id });
    const consultId = newId();
    await tx.insert(ipdConsults).values({
      id: consultId, admissionId: a.id, patientId: a.patientId, consultantId: input.consultantId, question: input.question,
      urgency: input.urgency, status: "open", requestedBy: actor.id, requestedAt: at,
    });
    await appendEvent(tx, consultRequested.make({
      payload: { consultId, admissionId: a.id, consultantId: input.consultantId, urgency: input.urgency, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, encounterId: a.id, occurredAt: at,
    }));
    // The asked consultant's bell: a few words, no patient name (GC6 / owner rule: one line on a phone).
    await raiseNoticeIn(tx, {
      userId: input.consultantId, kind: IPD_CONSULT_NOTICE_KIND, refType: "ipd_consult", refId: consultId,
      title: input.urgency === "urgent" ? "Urgent inpatient consult" : "Inpatient consult asked",
      body: "Open Rounds to see the patient.", sourceKey: `ipd-consult:${consultId}`, at,
    });
    return { consultId, status: "open" as const, requestedAt: at.toISOString() };
  }), at);
}

export async function closeConsult(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"close_consult">> {
  const input: Input<"close_consult"> = IPD_INTENTS.close_consult.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_ROUND_SIGN);
  const at = opts.now ?? new Date();
  return onceIpd(db, actor, "close_consult", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const first = (await tx.select().from(ipdConsults).where(eq(ipdConsults.id, input.consultId)))[0];
    if (first === undefined) throw new IpdRefusal("consult_not_found");
    const a = await lockAdmission(tx, first.admissionId);
    const c = (await tx.select().from(ipdConsults).where(eq(ipdConsults.id, input.consultId)).for("update"))[0]!;
    if (c.status !== "open") throw new IpdRefusal("consult_closed");
    const team = await treatingTeamOf(tx, a, at);
    if (!onTeam(team, actor.id)) throw new IpdRefusal("not_treating_team");
    await tx.update(ipdConsults).set({ status: "closed", closedBy: actor.id, closedAt: at, closeNote: input.note ?? null })
      .where(eq(ipdConsults.id, c.id));
    await appendEvent(tx, consultClosed.make({
      payload: { consultId: c.id, admissionId: a.id, consultantId: c.consultantId, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, encounterId: a.id, occurredAt: at,
    }));
    return { consultId: c.id, status: "closed" as const, closedAt: at.toISOString() };
  }), at);
}
