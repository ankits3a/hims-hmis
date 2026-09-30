import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { approvals } from "../../kernel/db/schema";
import { imagingReportHandovers, imagingStudies } from "../../kernel/db/schema/radiology";
import { invoiceLines, invoices } from "../../kernel/db/schema/billing";
import { EPISODE_SERIES } from "../../kernel/episodes/series";
import { requestApproval } from "../../kernel/approvals/requests";
import { invoiceSettlement } from "../billing";
import { IMAGING_RELEASE_UNPAID_APPROVAL_TYPE } from "./approval-types";
import { RadiologyError } from "./errors";
import { encounterPayer } from "./money";
import { requireReleased } from "./closed-loop";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ PLAN 18-S RS9b T1 — THE PATIENT'S COPY IS HELD FOR DUES; THE DOCTOR'S NEVER IS ═══
 *
 * DECIDED under the owner's delegation (the lab's 17-F ruling 12, as superseded 28 Sep):
 *
 *   · **The doctor's copy is never held for money.** Nothing here is called from the doctor's
 *     inbox, the full report read, the consult brief, the read-back or the reading room. Only the
 *     patient's copy is gated: the hand-over at the window and the film/CD that rides along with it
 *     (the "report ready" message already waits for settlement in `publishReport`).
 *   · **Only self-pay with an unsettled invoice line holds** — `money.ts`'s `authorisationOf`
 *     read for the desk. A day-care or bedside (IPD) study composes into a running bill; a
 *     TPA / corporate / PMJAY patient's payer is billed later; an ER/STAT scan runs first and the
 *     bill follows (ruling 8). None of those is "unpaid dues at the desk". A study with NO line is
 *     not held either: `acquired_unbilled` on the counter's bill-decision queue owns it, and a hold
 *     with no amount to name would be a refusal nobody at billing could clear.
 *   · **Released unpaid only by the OWNER** (credit ruling 28 Sep: a document leaving without the
 *     money is credit). The desk asks with a reason (`imaging_release_unpaid_owner`, subject = the
 *     study); the owner decides in the approvals inbox; the one hand-over that follows spends the
 *     grant. The dues stay on the account — nothing here writes to billing.
 */

export type HoldRelease =
  | { state: "none" }
  | { state: "pending"; approvalId: string; askedAt: string }
  | { state: "granted"; approvalId: string; decidedAt: string | null }
  | { state: "refused"; approvalId: string; decidedAt: string | null; note: string | null };

export type PatientCopyHold =
  | { held: false; why: "settled" | "stat" | "payer" | "ipd" | "no_bill" }
  | { held: true; outstandingPaise: number; invoiceId: string; invoiceNo: string; release: HoldRelease };

type StudyFacts = Pick<typeof imagingStudies.$inferSelect,
  "id" | "encounterNo" | "priority" | "bedsideLocation" | "invoiceLineId">;

/** ₹ in the Indian grouping, paise shown only when there are some. */
export function rupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: paise % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/**
 * The latest owner-release request about this study that the hand-over register has not spent.
 * A spent grant is history, not a release: a second hand-over needs a second decision.
 */
async function unspentRelease(exec: Db | Tx, studyId: string): Promise<HoldRelease> {
  const rows = await (exec as Db)
    .select({
      id: approvals.id, status: approvals.status, requestedAt: approvals.requestedAt,
      decidedAt: approvals.decidedAt, decisionNote: approvals.decisionNote,
    })
    .from(approvals)
    .where(and(
      eq(approvals.typeKey, IMAGING_RELEASE_UNPAID_APPROVAL_TYPE),
      eq(approvals.subjectType, RELEASE_SUBJECT),
      eq(approvals.subjectId, studyId),
    ))
    .orderBy(desc(approvals.requestedAt));
  if (rows.length === 0) return { state: "none" };
  const spent = await (exec as Db).select({ id: imagingReportHandovers.releaseApprovalId })
    .from(imagingReportHandovers)
    .where(and(isNotNull(imagingReportHandovers.releaseApprovalId),
      inArray(imagingReportHandovers.releaseApprovalId, rows.map((r) => r.id))));
  const used = new Set(spent.map((s) => s.id));
  const live = rows.find((r) => !used.has(r.id));
  if (live === undefined) return { state: "none" };
  if (live.status === "granted") return { state: "granted", approvalId: live.id, decidedAt: live.decidedAt?.toISOString() ?? null };
  if (live.status === "pending") return { state: "pending", approvalId: live.id, askedAt: live.requestedAt.toISOString() };
  return { state: "refused", approvalId: live.id, decidedAt: live.decidedAt?.toISOString() ?? null, note: live.decisionNote ?? null };
}

export const RELEASE_SUBJECT = "imaging_study";

/**
 * Whether the PATIENT's copy of this study's report is held for dues. The cheap facts first (no
 * query), then the payer, then the ledger — the register calls this per row.
 */
export async function patientCopyHold(exec: Db | Tx, study: StudyFacts): Promise<PatientCopyHold> {
  if (study.encounterNo.startsWith(EPISODE_SERIES.daycare) || study.bedsideLocation !== null) return { held: false, why: "ipd" };
  if (study.priority === "stat") return { held: false, why: "stat" };
  if (study.invoiceLineId === null) return { held: false, why: "no_bill" };
  const payer = await encounterPayer(exec, study.encounterNo);
  if (payer.intendedPayer !== "self") return { held: false, why: "payer" };
  const line = (await (exec as Db)
    .select({ invoiceId: invoiceLines.invoiceId, invoiceNo: invoices.invoiceNo })
    .from(invoiceLines).innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .where(eq(invoiceLines.id, study.invoiceLineId)))[0];
  if (line === undefined) return { held: false, why: "no_bill" };
  const settlement = await invoiceSettlement(exec, line.invoiceId);
  if (settlement.state === "settled") return { held: false, why: "settled" };
  return {
    held: true, outstandingPaise: settlement.outstandingPaise, invoiceId: line.invoiceId, invoiceNo: line.invoiceNo,
    release: await unspentRelease(exec, study.id),
  };
}

/**
 * The gate `handOverReport` runs. Returns the approval id the hand-over SPENDS when the copy is
 * held and the owner released it; `null` when nothing holds it. Otherwise refuses in plain words:
 * the amount and the bill, and who clears it.
 */
export async function assertPatientCopyReleasable(
  exec: Db | Tx, study: StudyFacts & { accessionNo: string },
): Promise<{ releaseApprovalId: string | null; outstandingPaise: number }> {
  const hold = await patientCopyHold(exec, study);
  if (!hold.held) return { releaseApprovalId: null, outstandingPaise: 0 };
  const due = rupees(hold.outstandingPaise);
  const details = { outstandingPaise: hold.outstandingPaise, invoiceNo: hold.invoiceNo, studyId: study.id };
  if (hold.release.state === "granted") return { releaseApprovalId: hold.release.approvalId, outstandingPaise: hold.outstandingPaise };
  if (hold.release.state === "pending") {
    throw new RadiologyError(
      "release_not_authorised",
      `The owner has not answered yet: ${due} is still due on bill ${hold.invoiceNo}. Collect it at billing, `
      + "or wait for the owner's release — the doctor already has the report.",
      { ...details, approvalId: hold.release.approvalId },
    );
  }
  if (hold.release.state === "refused") {
    throw new RadiologyError(
      "release_not_authorised",
      `The owner did not release this report unpaid${hold.release.note ? ` ("${hold.release.note}")` : ""}. `
      + `${due} is due on bill ${hold.invoiceNo} — collect it at billing.`,
      { ...details, approvalId: hold.release.approvalId },
    );
  }
  throw new RadiologyError(
    "report_held_for_dues",
    `${due} is due on bill ${hold.invoiceNo} for ${study.accessionNo}. The patient's copy is handed over once `
    + "it is paid at billing. If the patient cannot pay today, ask the owner to release it unpaid. "
    + "The doctor's copy is not held.",
    details,
  );
}

/**
 * The desk ASKS the owner to release a held copy unpaid, with a reason. Idempotent while a request
 * is pending (the same approval comes back). Refuses a report nothing holds (`release_not_needed`).
 */
export async function requestUnpaidRelease(
  tx: Tx, actor: Actor, input: { reportId: string; reason: string },
): Promise<{ approvalId: string; status: "pending" | "granted"; outstandingPaise: number }> {
  if (actor.type !== "user") throw new RadiologyError("user_actor_required", "a release is asked for by a person");
  const reason = input.reason.trim();
  if (reason.length < 4) {
    throw new RadiologyError("reason_required", "Say why the patient cannot pay today — the owner decides from what you write.");
  }
  const { study } = await requireReleased(tx, input.reportId);
  const hold = await patientCopyHold(tx, study);
  if (!hold.held) {
    throw new RadiologyError(
      "release_not_needed",
      `Nothing holds the ${study.accessionNo} report — hand it over.`,
      { why: hold.why },
    );
  }
  if (hold.release.state === "pending" || hold.release.state === "granted") {
    return { approvalId: hold.release.approvalId, status: hold.release.state, outstandingPaise: hold.outstandingPaise };
  }
  const { approvalId } = await requestApproval(tx, actor, {
    typeKey: IMAGING_RELEASE_UNPAID_APPROVAL_TYPE,
    subject: { type: RELEASE_SUBJECT, id: study.id },
    patientId: study.patientId,
    encounterId: study.encounterNo,
    amountPaise: hold.outstandingPaise,
    requestNote: `${study.accessionNo} · bill ${hold.invoiceNo} · ${rupees(hold.outstandingPaise)} due — ${reason}`,
  });
  return { approvalId, status: "pending", outstandingPaise: hold.outstandingPaise };
}
