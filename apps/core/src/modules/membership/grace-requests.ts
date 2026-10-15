import { and, asc, desc, eq, gte, inArray, or } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { requestApproval } from "../../kernel/approvals/requests";
import { istDayWindow } from "../../kernel/approvals/cumulative";
import { withTx } from "../../kernel/db/client";
import { approvals, membershipInstances, membershipPlans } from "../../kernel/db/schema";
import { getPatientSummaries, PatientError } from "../patients";
import { MembershipError } from "./errors";
import { GRACE_HONOR_APPROVAL_TYPE, GRACE_HONOR_SUBJECT_TYPE } from "./recognition";
import type { Db } from "../../kernel/db/client";

/**
 * #658 — THE COUNTER'S HALF OF GRACE HONOUR (board: docs/design/2026-09-28-ux-audit/card-recognition).
 *
 * `POST /membership/grace-honor` EXECUTES a grace honour and needs a GRANTED approval. Until now the
 * counter had no way to ASK for one: `POST /approvals` is guarded by `approvals.requests.create`,
 * which the front office does not hold (owner ruled it onto `lab_reception` only). The desk's own
 * string for asking is `membership.grace_honor.request`, so the asking lives here, behind it, and
 * files exactly one kind of request — `membership_grace_honor` about one card for one patient. The
 * approvals engine, its SLA, its approver role and its requester ≠ approver rule are untouched;
 * nothing applies to any bill before `graceHonor` checks the granted approval on execute.
 */

export type GraceRequestInput = { cardCode: string; patientId: string; planId: string; reason: string };

export type GraceRequestRow = {
  approvalId: string;
  cardCode: string;
  patientId: string | null;
  status: "pending" | "granted" | "rejected";
  requestedAt: Date;
  decidedAt: Date | null;
  /** The note the counter wrote, which names the plan for the approver. */
  note: string | null;
  /** A grace card with this code now exists: the granted request has been used. */
  honoured: boolean;
  holder: { name: string | null; alias: string | null; restricted: boolean; uhid: string } | null;
};

export type GracePlanOption = { id: string; code: string; title: string };

/** The plans a counter can name on a grace request: active ones, by title. No benefit, no money. */
export async function gracePlanOptions(db: Db): Promise<GracePlanOption[]> {
  return db
    .select({ id: membershipPlans.id, code: membershipPlans.code, title: membershipPlans.title })
    .from(membershipPlans)
    .where(eq(membershipPlans.status, "active"))
    .orderBy(asc(membershipPlans.title));
}

/**
 * Files the approval. A second ask for the same card and patient while one is still pending
 * returns the pending one instead of filing a duplicate the approver would have to decide twice.
 */
export async function requestGraceHonor(
  db: Db,
  actor: Actor,
  input: GraceRequestInput,
): Promise<{ approvalId: string; status: "pending"; alreadyAsked: boolean }> {
  const cardCode = input.cardCode.trim();
  const reason = input.reason.trim();
  if (cardCode === "") throw new MembershipError("unknown_instrument", "a grace request needs the card code as presented");
  const plan = (await db
    .select({ id: membershipPlans.id, title: membershipPlans.title })
    .from(membershipPlans)
    .where(and(eq(membershipPlans.id, input.planId), eq(membershipPlans.status, "active"))))[0];
  if (plan === undefined) throw new MembershipError("unknown_plan", `unknown plan ${input.planId}`);
  const [summary] = await getPatientSummaries(db, actor, [input.patientId]);
  if (summary === undefined) throw new PatientError("patient_not_found", `unknown patient ${input.patientId}`);

  const pending = (await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(
      eq(approvals.typeKey, GRACE_HONOR_APPROVAL_TYPE),
      eq(approvals.subjectType, GRACE_HONOR_SUBJECT_TYPE),
      eq(approvals.subjectId, cardCode),
      eq(approvals.patientId, input.patientId),
      eq(approvals.status, "pending"),
    )))[0];
  if (pending !== undefined) return { approvalId: pending.id, status: "pending", alreadyAsked: true };

  const { approvalId } = await withTx(db, (tx) =>
    requestApproval(tx, actor, {
      typeKey: GRACE_HONOR_APPROVAL_TYPE,
      subject: { type: GRACE_HONOR_SUBJECT_TYPE, id: cardCode },
      patientId: input.patientId,
      requestNote: `${plan.title}: ${reason}`,
    }));
  return { approvalId, status: "pending", alreadyAsked: false };
}

const LIMIT = 50;

/**
 * THIS COUNTER'S OWN GRACE REQUESTS: every one still pending, and those decided since IST midnight,
 * newest first. The holder is named through `getPatientSummaries`, the same sealed gate as
 * recognition.
 */
export async function myGraceRequests(db: Db, actor: Actor, now: Date): Promise<GraceRequestRow[]> {
  const { start } = istDayWindow(now);
  const rows = await db
    .select()
    .from(approvals)
    .where(and(
      eq(approvals.typeKey, GRACE_HONOR_APPROVAL_TYPE),
      eq(approvals.requesterId, actor.id),
      or(eq(approvals.status, "pending"), gte(approvals.decidedAt, start)),
    ))
    .orderBy(desc(approvals.requestedAt))
    .limit(LIMIT);
  const codes = [...new Set(rows.map((r) => r.subjectId))];
  const honoured = codes.length === 0
    ? []
    : await db
      .select({ cardCode: membershipInstances.cardCode, patientId: membershipInstances.patientId })
      .from(membershipInstances)
      .where(and(inArray(membershipInstances.cardCode, codes), eq(membershipInstances.origin, "grace")));
  const used = new Set(honoured.map((h) => `${h.cardCode}\u0000${h.patientId ?? ""}`));
  const patientIds = [...new Set(rows.map((r) => r.patientId).filter((p): p is string => p !== null))];
  const summaryOf = new Map((await getPatientSummaries(db, actor, patientIds)).map((s) => [s.requestedId, s] as const));
  return rows.map((r): GraceRequestRow => {
    const s = r.patientId === null ? undefined : summaryOf.get(r.patientId);
    return {
      approvalId: r.id,
      cardCode: r.subjectId,
      patientId: r.patientId,
      status: r.status as GraceRequestRow["status"],
      requestedAt: r.requestedAt,
      decidedAt: r.decidedAt,
      note: r.requestNote,
      honoured: used.has(`${r.subjectId}\u0000${r.patientId ?? ""}`),
      holder: s === undefined ? null : { name: s.name, alias: s.alias, restricted: s.restricted, uhid: s.uhid },
    };
  });
}
