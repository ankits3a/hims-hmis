import { and, desc, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { enqueueNotification } from "../../kernel/notify/enqueue";
import { advanceOrderItem } from "../../kernel/orders/advance";
import { secondFactorFresh } from "../../kernel/auth/totp";
import { transition } from "../../kernel/workflow/instances";
import {
  imagingCriticalFindings, imagingReports, imagingStudies,
} from "../../kernel/db/schema/radiology";
import { orderItems, orders } from "../../kernel/db/schema/orders";
import { invoiceLines } from "../../kernel/db/schema/billing";
import { invoiceSettlement } from "../billing";
import { findLockoutHits } from "../pcpndt";
import { RadiologyError } from "./errors";
import {
  imagingCriticalAcknowledged, imagingCriticalFlagged, imagingReportPublished,
} from "./events";
import { requireStudyType } from "./study-types";
import { templateKeyFor } from "./templates";
import type { ImagingCriticalCategory } from "../../kernel/db/schema/radiology";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";
import type { OrderKindDecl } from "../../kernel/orders/kinds";

/**
 * PLAN 18a T8 — **THE REPORT: versioned, signed under a fresh second factor, and never overwritten.**
 *
 * ═══ EVERY ACT INSERTS A VERSION. NOTHING IS EDITED. ═══
 *
 * `imaging_reports_immutable` permits `status` and `published_at` to change and NOTHING else, so
 * there is no such thing as "editing a report" in this system. A draft saved twice is two rows; a
 * signature is its own row; an amendment is v(n+1) with v(n) flipped to `superseded`. **This is the
 * table a courtroom reads**, and the property it has to have is that the document somebody signed
 * is byte-for-byte the document that is still there.
 *
 * A2's mutant is *"amend by UPDATE of v1"*, and the consequence it names is the whole point: *"the
 * courtroom has one version"* — the amended text, with the original gone and no way to show what
 * was communicated at 02:00 and acted on.
 *
 * ═══ THREE THINGS ARE CHECKED AT SIGN, AND ALL THREE ARE CHECKED BEFORE THE INSERT ═══
 *
 *   · **the second factor is FRESH** (A1) — §11.19-D-27. A signature is an identity claim, and one
 *     made on a session that authenticated this morning is a claim about the morning.
 *   · **the lockout** (A3) — on EVERY report, not only the PCPNDT-applicable ones. A3's mutant
 *     applies it only when `form_f_required`, and N9 is what slips through: the pregnant trauma
 *     patient's CT, which is not an obstetric scan and can still disclose a foetal sex.
 *   · **the laterality** (A4) — against the ORDER ITEM's, on types where a side exists at all.
 */

/**
 * §11.19-D-27's window, as a FALLBACK only.
 *
 * ═══ THE COMPARISON IS THE KERNEL'S, AND §6.8 SAYS SO ═══
 *
 * The contract promises downstream plans that *"the second factor is the kernel's
 * `secondFactorFresh`"*, and the first draft of this file re-implemented the arithmetic instead —
 * two owners of one rule, with this module's constant free to drift from
 * `cfg.secondFactorWindowMinutes`, which is what `AuthGuard` compares against on the very same
 * request. A signature could then be refused by the route and accepted by the function, or the
 * reverse. Caught by T9's §6 confirmation pass.
 *
 * The controller passes the CONFIG's window; this constant is what an internal caller with no
 * config gets, and it matches the shipped default.
 */
export const SECOND_FACTOR_WINDOW_MINUTES = 15;

export type ReportRow = typeof imagingReports.$inferSelect;

async function loadStudy(exec: Db | Tx, studyId: string) {
  const rows = await (exec as Db).select().from(imagingStudies).where(eq(imagingStudies.id, studyId));
  const study = rows[0];
  if (!study) throw new RadiologyError("unknown_study", `no study ${studyId}`, { studyId });
  return study;
}

async function nextVersion(exec: Db | Tx, studyId: string): Promise<number> {
  const rows = await (exec as Db)
    .select({ version: imagingReports.version })
    .from(imagingReports)
    .where(eq(imagingReports.studyId, studyId))
    .orderBy(desc(imagingReports.version))
    .limit(1);
  return (rows[0]?.version ?? 0) + 1;
}

export async function latestSigned(exec: Db | Tx, studyId: string): Promise<ReportRow | undefined> {
  const rows = await (exec as Db).select().from(imagingReports)
    .where(and(eq(imagingReports.studyId, studyId), eq(imagingReports.status, "signed")))
    .limit(1);
  return rows[0];
}

export type ReportContent = {
  templateKey?: string;
  body: Record<string, unknown>;
  impression?: string | null;
  laterality?: string | null;
};

/** The default skeleton for a study, when the caller does not name one. */
async function defaultTemplateKey(exec: Db | Tx, studyTypeCode: string): Promise<string> {
  const type = await requireStudyType(exec, studyTypeCode);
  return templateKeyFor(type.modality, type.body_part);
}

async function insertVersion(
  tx: Tx,
  study: { id: string; studyTypeCode: string },
  status: "draft" | "prelim" | "signed",
  content: ReportContent,
  signer?: { actorId: string; signedAt: Date; secondFactorAt: Date; amendmentReason?: string | null; supersedesId?: string | null },
  criticalCategory?: ImagingCriticalCategory | null,
): Promise<{ reportId: string; version: number }> {
  const version = await nextVersion(tx, study.id);
  const templateKey = content.templateKey ?? await defaultTemplateKey(tx, study.studyTypeCode);
  const reportId = newId();
  await tx.insert(imagingReports).values({
    id: reportId,
    studyId: study.id,
    version,
    status,
    templateKey,
    body: content.body,
    impression: content.impression ?? null,
    laterality: content.laterality ?? null,
    criticalCategory: criticalCategory ?? null,
    signerId: signer?.actorId ?? null,
    signedAt: signer?.signedAt ?? null,
    secondFactorAt: signer?.secondFactorAt ?? null,
    amendmentReason: signer?.amendmentReason ?? null,
    supersedesId: signer?.supersedesId ?? null,
  });
  return { reportId, version };
}

/** A working draft. Nothing is visible to anybody outside the department until it is published. */
export async function draftReport(
  tx: Tx, actor: Actor, input: { studyId: string } & ReportContent,
): Promise<{ reportId: string; version: number }> {
  const study = await loadStudy(tx, input.studyId);
  assertReportable(study.status, input.studyId);
  return await insertVersion(tx, study, "draft", input);
}

/**
 * O-11's UNVERIFIED read. A prelim is a real, quotable document — the night registrar's opinion,
 * available to the ward — and it is deliberately NOT publishable (A6): a patient must never be
 * handed a report nobody has signed.
 */
export async function savePrelim(
  tx: Tx, actor: Actor, input: { studyId: string } & ReportContent,
): Promise<{ reportId: string; version: number }> {
  const study = await loadStudy(tx, input.studyId);
  assertReportable(study.status, input.studyId);
  return await insertVersion(tx, study, "prelim", input);
}

function assertReportable(status: string, studyId: string): void {
  if (!["acquired", "reported", "published"].includes(status)) {
    throw new RadiologyError(
      "report_not_signed",
      `study ${studyId} is ${status} — a report is written about images that exist`,
      { studyId, status },
    );
  }
}

/**
 * ═══ A1/A3/A4 — THE SIGNATURE ═══
 *
 * `secondFactorAt` is the SESSION's, carried by the controller rather than typed by the caller: a
 * signature that could name its own freshness is not a second factor at all.
 */
export async function signReport(
  tx: Tx,
  actor: Actor,
  input: {
    studyId: string;
    /** The draft or prelim being signed. Its content is copied forward into the signed version. */
    reportId: string;
    secondFactorAt: Date | null;
    /** `cfg.secondFactorWindowMinutes`, supplied by the controller. Falls back to the constant. */
    windowMinutes?: number;
    criticalCategory?: ImagingCriticalCategory | null;
    now?: Date;
  },
): Promise<{ reportId: string; version: number }> {
  const now = input.now ?? new Date();
  const study = await loadStudy(tx, input.studyId);

  /** A1 — §11.19-D-27. Checked FIRST: nothing about the content matters if the signer is not fresh. */
  const windowMinutes = input.windowMinutes ?? SECOND_FACTOR_WINDOW_MINUTES;
  const factorAt = input.secondFactorAt;
  /** The null check is separate so the type narrows; `secondFactorFresh` owns the ARITHMETIC. */
  if (factorAt === null || !secondFactorFresh({ secondFactorAt: factorAt }, windowMinutes, now)) {
    throw new RadiologyError(
      "second_factor_required",
      `signing a report needs a second factor no older than ${String(windowMinutes)} `
      + "minutes — a signature made on a session that authenticated this morning is a claim about the morning",
      { studyId: input.studyId, windowMinutes },
    );
  }

  const rows = await (tx as unknown as Db).select().from(imagingReports)
    .where(eq(imagingReports.id, input.reportId));
  const source = rows[0];
  if (!source || source.studyId !== study.id) {
    throw new RadiologyError("unknown_study", `no report ${input.reportId} on study ${study.id}`);
  }
  if (!["draft", "prelim"].includes(source.status)) {
    throw new RadiologyError(
      "already_signed", `report ${input.reportId} is ${source.status}`, { status: source.status },
    );
  }

  await assertSignable(tx, study, source, input.criticalCategory ?? source.criticalCategory);

  try {
    return await insertVersion(
      tx, study, "signed",
      {
        templateKey: source.templateKey, body: source.body as Record<string, unknown>,
        impression: source.impression, laterality: source.laterality,
      },
      { actorId: actor.id, signedAt: now, secondFactorAt: factorAt },
      (input.criticalCategory ?? source.criticalCategory) as ImagingCriticalCategory | null,
    );
  } catch (e) {
    throw asAlreadySigned(e, study.id);
  }
}

/** B10 — `imaging_reports_one_signed_ux`. A second signature is the DATABASE's refusal, not ours. */
function asAlreadySigned(e: unknown, studyId: string): unknown {
  const constraint = String((e as { constraint?: unknown })?.constraint ?? "");
  if (constraint.includes("imaging_reports_one_signed_ux")) {
    return new RadiologyError(
      "already_signed",
      `study ${studyId} already has a signed report — amend it rather than signing a second (B10)`,
      { studyId },
    );
  }
  return e;
}

/** A3 and A4, in the order a reader would check them: the statute, then the side. */
async function assertSignable(
  tx: Tx,
  study: typeof imagingStudies.$inferSelect,
  content: { body: unknown; impression?: string | null; laterality?: string | null },
  criticalCategory: string | null,
): Promise<void> {
  /**
   * ═══ A3 — THE LOCKOUT RUNS ON EVERY REPORT, NOT ONLY THE PCPNDT ONES ═══
   *
   * A3's mutant applies it only when `form_f_required`, and N9 names what slips: **the pregnant
   * trauma patient's CT abdomen.** That scan is not obstetric, carries no Form F, and can disclose a
   * foetal sex as easily as any anomaly scan. §5(2) is about the COMMUNICATION, not about the
   * examination code.
   */
  const text = `${JSON.stringify(content.body)} ${content.impression ?? ""}`;
  const hits = findLockoutHits(text);
  if (hits.length > 0) {
    throw new RadiologyError(
      "lexical_lockout",
      `this report cannot be signed: it contains ${hits.map((h) => `"${h.term}"`).join(", ")} — `
      + "§5(2) of the PCPNDT Act forbids communicating the sex of a foetus in any manner. Rephrase, "
      + "or if this is a false positive, say so to the medical superintendent",
      { terms: hits.map((h) => h.term), count: hits.length },
    );
  }

  /** A4 — the side the radiologist typed against the side the order carries. */
  const type = await requireStudyType(tx, study.studyTypeCode);
  if (type.laterality_applicable) {
    if (content.laterality === null || content.laterality === undefined) {
      throw new RadiologyError(
        "laterality_mismatch",
        `${study.studyTypeCode} is a lateralised examination and the report names no side`,
        { studyTypeCode: study.studyTypeCode, ordered: study.laterality },
      );
    }
    if (content.laterality !== study.laterality) {
      throw new RadiologyError(
        "laterality_mismatch",
        `the report says ${content.laterality} and the order says ${study.laterality} — a report on `
        + "the wrong side is a wrong-site finding with a signature on it",
        { reported: content.laterality, ordered: study.laterality },
      );
    }
  }

  if (criticalCategory !== null && !["red", "orange", "yellow"].includes(criticalCategory)) {
    throw new RadiologyError("evidence_invalid", `unknown criticality tier "${criticalCategory}"`);
  }
}

/**
 * ═══ A2 — THE AMENDMENT: v(n+1) SIGNED, v(n) SUPERSEDED, ONE TRANSACTION ═══
 *
 * Two concurrent amends produce exactly ONE v2, and the mechanism is the same partial unique that
 * refuses a second signature: both insert `status = 'signed'`, and `imaging_reports_one_signed_ux`
 * lets one through. The loser's whole transaction rolls back, so the superseded flip goes with it.
 */
export async function amendReport(
  tx: Tx,
  actor: Actor,
  input: {
    studyId: string; secondFactorAt: Date | null; reason: string; windowMinutes?: number;
    criticalCategory?: ImagingCriticalCategory | null; now?: Date;
  } & ReportContent,
): Promise<{ reportId: string; version: number; supersededId: string }> {
  const now = input.now ?? new Date();
  const study = await loadStudy(tx, input.studyId);

  if (input.reason.trim() === "") {
    throw new RadiologyError("reason_required", "an amendment carries a reason — what changed and why");
  }
  const amendFactorAt = input.secondFactorAt;
  if (amendFactorAt === null || !secondFactorFresh(
    { secondFactorAt: amendFactorAt }, input.windowMinutes ?? SECOND_FACTOR_WINDOW_MINUTES, now,
  )) {
    throw new RadiologyError(
      "second_factor_required",
      "amending a report needs a fresh second factor, exactly as signing one does",
    );
  }

  const previous = await latestSigned(tx, study.id);
  if (!previous) {
    throw new RadiologyError(
      "report_not_signed", `study ${study.id} has no signed report to amend`, { studyId: study.id },
    );
  }
  await assertSignable(tx, study, input, input.criticalCategory ?? null);

  /**
   * THE FLIP COMES FIRST, and it has to: `imaging_reports_one_signed_ux` is a partial unique on
   * `status = 'signed'`, so inserting v2 while v1 is still signed collides with the constraint that
   * exists to stop exactly that. Superseding first, in the same transaction, is what makes the pair
   * atomic — a reader between the two statements is impossible.
   */
  await tx.update(imagingReports).set({ status: "superseded" })
    .where(eq(imagingReports.id, previous.id));

  const created = await insertVersion(
    tx, study, "signed", input,
    {
      actorId: actor.id, signedAt: now, secondFactorAt: amendFactorAt,
      amendmentReason: input.reason.trim(), supersedesId: previous.id,
    },
    input.criticalCategory ?? null,
  );
  return { ...created, supersededId: previous.id };
}

/**
 * ═══ A6/A7 — PUBLICATION, AND MONEY GATES THE MESSAGE AND NEVER THE REPORT ═══
 *
 * A6's mutant gates publication itself on payment, and D5's inversion is what it produces: **the
 * critical finding waits for the cashier.** So `publishReport` always publishes — the report becomes
 * visible in the app and the envelope closes — and settlement decides only whether the *"your report
 * is ready"* MESSAGE goes out (O-2/D5). A `red` critical sends regardless: somebody has to be told
 * about the bleed whether or not the bill is paid.
 */
export async function publishReport(
  tx: Tx,
  actor: Actor,
  decls: readonly OrderKindDecl[],
  input: { studyId: string; now?: Date },
): Promise<{ reportId: string; version: number; notified: boolean }> {
  const now = input.now ?? new Date();
  const study = await loadStudy(tx, input.studyId);
  const signed = await latestSigned(tx, study.id);
  if (!signed) {
    /** A6 — a prelim is a real document and is deliberately not publishable. */
    const anyPrelim = await (tx as unknown as Db).select({ id: imagingReports.id })
      .from(imagingReports)
      .where(and(eq(imagingReports.studyId, study.id), eq(imagingReports.status, "prelim")));
    if (anyPrelim.length > 0) {
      throw new RadiologyError(
        "prelim_not_publishable",
        `study ${study.id} has only a PRELIM report — a patient must never be handed a report nobody has signed (O-11)`,
        { studyId: study.id },
      );
    }
    throw new RadiologyError("report_not_signed", `study ${study.id} has no signed report`, { studyId: study.id });
  }
  if (signed.publishedAt !== null) {
    throw new RadiologyError("already_signed", `report ${signed.id} is already published`, { reportId: signed.id });
  }

  await tx.update(imagingReports).set({ publishedAt: now }).where(eq(imagingReports.id, signed.id));

  /** DD4 — `published` is where the envelope item reaches `completed` and the order may close. */
  if (study.status !== "published") {
    if (study.status === "acquired") {
      await transition(tx, study.workflowInstanceId, "reported", actor);
    }
    await transition(tx, study.workflowInstanceId, "published", actor);
    await tx.update(imagingStudies).set({ status: "published" }).where(eq(imagingStudies.id, study.id));
  }
  const itemRows = await (tx as unknown as Db).select({ status: orderItems.status })
    .from(orderItems).where(eq(orderItems.id, study.orderItemId));
  if (itemRows[0]?.status === "in_progress") {
    await advanceOrderItem(tx, actor, decls, study.orderItemId, "completed", {});
  }

  await appendEvent(tx, imagingReportPublished.make({
    actor, patientId: study.patientId, encounterId: study.encounterNo,
    payload: {
      studyId: study.id, reportId: signed.id, version: signed.version,
      patientId: study.patientId, encounterNo: study.encounterNo,
      criticalCategory: signed.criticalCategory,
    },
  }));

  const notified = await notifyIfDue(tx, study, signed, now);
  return { reportId: signed.id, version: signed.version, notified };
}

/**
 * A6's settlement rule and A7's swallow, in one place.
 *
 * **A7 — `enqueueNotification` throwing must not fail the publish.** S7's case is a patient with no
 * channel at all, and C7 is the consequence of getting it wrong: a report signed at 02:00 sits
 * unpublished because a phone number is missing. The report is the clinical artefact; the message is
 * a courtesy.
 */
async function notifyIfDue(
  tx: Tx,
  study: typeof imagingStudies.$inferSelect,
  signed: ReportRow,
  now: Date,
): Promise<boolean> {
  const isRedCritical = signed.criticalCategory === "red";
  if (!isRedCritical && !(await invoiceIsSettled(tx, study.invoiceLineId))) return false;

  try {
    const orderRows = await (tx as unknown as Db).select({ orderNo: orders.orderNo })
      .from(orders).where(eq(orders.id, study.orderId));
    await enqueueNotification(tx, {
      templateKey: "imaging_report_ready",
      params: { orderNo: orderRows[0]?.orderNo ?? study.accessionNo },
      dedupeKey: `imaging_report_ready:${signed.id}`,
      occurredAt: now,
      patientId: study.patientId,
    });
    return true;
  } catch {
    /** A7 — deliberately swallowed. See the header; the read is the priority, not the message. */
    return false;
  }
}

/** O-2/D5 — no line at all is UNSETTLED, which is the strict direction for a courtesy message. */
async function invoiceIsSettled(exec: Db | Tx, invoiceLineId: string | null): Promise<boolean> {
  if (invoiceLineId === null) return false;
  const rows = await (exec as Db).select({ invoiceId: invoiceLines.invoiceId })
    .from(invoiceLines).where(eq(invoiceLines.id, invoiceLineId));
  const invoiceId = rows[0]?.invoiceId;
  if (invoiceId === undefined) return false;
  const settlement = await invoiceSettlement(exec, invoiceId);
  return settlement.state === "settled";
}

/* ═══════════════════════════ DD15 — the criticals ═══════════════════════════ */

/**
 * A `red` finding pages a human. 18a-iii's Critical Chaser is the consumer that will not let it
 * rest; this phase records the fact and the clock so that ladder has history to tune against.
 */
export async function flagCritical(
  tx: Tx,
  actor: Actor,
  input: { reportId: string; category: ImagingCriticalCategory; communicatedTo?: string | null; now?: Date },
): Promise<{ criticalId: string }> {
  const rows = await (tx as unknown as Db).select().from(imagingReports)
    .where(eq(imagingReports.id, input.reportId));
  const report = rows[0];
  if (!report) throw new RadiologyError("unknown_study", `no report ${input.reportId}`);

  const criticalId = newId();
  await tx.insert(imagingCriticalFindings).values({
    id: criticalId,
    reportId: report.id,
    category: input.category,
    communicatedTo: input.communicatedTo ?? null,
    communicatedAt: input.communicatedTo === undefined || input.communicatedTo === null
      ? null : (input.now ?? new Date()),
  });
  await appendEvent(tx, imagingCriticalFlagged.make({
    actor,
    payload: {
      reportId: report.id, studyId: report.studyId, category: input.category,
      communicatedTo: input.communicatedTo ?? null,
    },
  }));
  return { criticalId };
}

export async function acknowledgeCritical(
  tx: Tx, actor: Actor, input: { criticalId: string; readBack?: string | null; now?: Date },
): Promise<{ criticalId: string; acknowledgedAt: Date }> {
  const rows = await (tx as unknown as Db).select().from(imagingCriticalFindings)
    .where(eq(imagingCriticalFindings.id, input.criticalId));
  const critical = rows[0];
  if (!critical) throw new RadiologyError("unknown_study", `no critical finding ${input.criticalId}`);
  if (critical.acknowledgedAt !== null) {
    throw new RadiologyError("already_signed", `critical ${input.criticalId} is already acknowledged`);
  }
  /** DD15 — `red` demands a READ-BACK; the other two are satisfied by an acknowledgement. */
  if (critical.category === "red" && (input.readBack === undefined || input.readBack === null || input.readBack.trim() === "")) {
    throw new RadiologyError(
      "reason_required",
      "a RED critical is acknowledged with a read-back — the clinician repeats the finding in their own words",
      { criticalId: input.criticalId },
    );
  }
  const acknowledgedAt = input.now ?? new Date();
  await tx.update(imagingCriticalFindings)
    .set({ acknowledgedBy: actor.id, acknowledgedAt, readBackText: input.readBack ?? null })
    .where(eq(imagingCriticalFindings.id, input.criticalId));
  /** The table hangs off the REPORT; the study comes from it, which keeps one owner for the link. */
  const reportRows = await (tx as unknown as Db).select({ studyId: imagingReports.studyId })
    .from(imagingReports).where(eq(imagingReports.id, critical.reportId));
  await appendEvent(tx, imagingCriticalAcknowledged.make({
    actor,
    payload: {
      reportId: critical.reportId, studyId: reportRows[0]!.studyId,
      category: critical.category, acknowledgedBy: actor.id,
    },
  }));
  return { criticalId: input.criticalId, acknowledgedAt };
}
