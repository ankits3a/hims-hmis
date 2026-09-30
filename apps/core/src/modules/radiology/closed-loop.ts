import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { hasPermission } from "../../kernel/auth/permissions";
import { recordPhiAccess } from "../../kernel/phi/audit";
import {
  IMAGING_ACTED_OUTCOMES, imagingCriticalFindings, imagingReportDelivery, imagingReports, imagingStudies,
} from "../../kernel/db/schema/radiology";
import { orderItems, orders } from "../../kernel/db/schema/orders";
import { opdDoctors, opdEncounters } from "../../kernel/db/schema/opd";
import { patients } from "../../kernel/db/schema/patients";
import { services } from "../../kernel/db/schema/tariff";
import { users } from "../../kernel/db/schema/auth";
import { displayName } from "../patients";
import { RadiologyError } from "./errors";
import { imagingReportActedUpon } from "./events";
import { acknowledgeCritical } from "./reports";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ PLAN 18-S RS9 — THE CLOSED LOOP: WHO THE TREATING DOCTOR IS, AND WHAT THEY DID ═══
 *
 * The department's north star is *order → report ACTED UPON* (plan Gap 6). A signed report that
 * nobody reads is a silent gap, and "read" is not the end either: the clock stops when the treating
 * doctor records what the report changed. This file owns three things:
 *
 *   · **who the treating doctor is** — the ORDERING CLINICIAN (`orders.ordering_clinician_id`, DD6's
 *     responsible doctor, never the login that typed it) or the doctor of the visit the study
 *     belongs to (`opd_encounters.doctor_id` → `opd_doctors.user_id`, the OPD's own D5 rule). A study
 *     placed on an outside prescription or by the patient has NO in-house treating doctor.
 *   · **acted upon** — `POST /radiology/reports/:id/acted`, the treating doctor only, with an outcome
 *     and one line.
 *   · **the doctor's inbox** — criticals first, then unread, then read-not-acted, then acted.
 *
 * The north-star read model is in `north-star.ts`; the release desk is in `release.ts`.
 */

export type TreatingDoctors = {
  /** users.id of every doctor who may act on this study's report; empty for an outside study. */
  userIds: string[];
  orderingClinicianId: string | null;
  authority: string;
};

/**
 * The treating doctors of ONE study. Plain joins over kernel schema (no module import): the order
 * envelope, and the OPD visit the study's `encounter_no` names.
 */
export async function treatingDoctorsOf(exec: Db | Tx, studyId: string): Promise<TreatingDoctors | null> {
  const rows = await (exec as Db)
    .select({
      orderingClinicianId: orders.orderingClinicianId,
      authority: orders.authority,
      visitDoctorUserId: opdDoctors.userId,
    })
    .from(imagingStudies)
    .innerJoin(orders, eq(orders.id, imagingStudies.orderId))
    .leftJoin(opdEncounters, eq(opdEncounters.visitNo, imagingStudies.encounterNo))
    .leftJoin(opdDoctors, eq(opdDoctors.id, opdEncounters.doctorId))
    .where(eq(imagingStudies.id, studyId));
  if (rows.length === 0) return null;
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.orderingClinicianId !== null) ids.add(r.orderingClinicianId);
    if (r.visitDoctorUserId !== null) ids.add(r.visitDoctorUserId);
  }
  return { userIds: [...ids], orderingClinicianId: rows[0]!.orderingClinicianId, authority: rows[0]!.authority };
}

/** Is this actor one of the study's treating doctors? */
export async function isTreatingDoctor(exec: Db | Tx, actor: Actor, studyId: string): Promise<boolean> {
  if (actor.type !== "user") return false;
  const t = await treatingDoctorsOf(exec, studyId);
  return t !== null && t.userIds.includes(actor.id);
}

/**
 * The refusal names the doctor who CAN act (a person, never an id — #138), so the reader knows whom
 * to tell. Falls back to "the doctor who ordered it" when the ordering clinician is not a user row.
 */
async function refuseNotTreating(exec: Db | Tx, studyId: string, accessionNo: string): Promise<never> {
  const t = await treatingDoctorsOf(exec, studyId);
  let who = "the doctor who ordered it or the visit's doctor";
  if (t !== null && t.userIds.length > 0) {
    const named = await (exec as Db).select({ fullName: users.fullName }).from(users).where(inArray(users.id, t.userIds));
    if (named.length > 0) who = named.map((n) => n.fullName).join(" or ");
  } else if (t !== null) {
    who = "nobody in the hospital — it was ordered on an outside prescription";
  }
  throw new RadiologyError(
    "not_treating_doctor",
    `Only the treating doctor records what the ${accessionNo} report changed: ${who}.`,
    { studyId, accessionNo },
  );
}

type LoadedReport = {
  report: typeof imagingReports.$inferSelect;
  study: typeof imagingStudies.$inferSelect;
};

async function loadReport(exec: Db | Tx, reportId: string): Promise<LoadedReport> {
  const rows = await (exec as Db)
    .select({ report: imagingReports, study: imagingStudies })
    .from(imagingReports)
    .innerJoin(imagingStudies, eq(imagingStudies.id, imagingReports.studyId))
    .where(eq(imagingReports.id, reportId));
  const row = rows[0];
  if (!row) throw new RadiologyError("unknown_study", `no report ${reportId}`);
  return row;
}

/**
 * The CURRENT released version or a refusal that says why not. Shared by acted-upon and the desk:
 * nothing is acted on, handed over or printed from a superseded or unreleased version.
 */
export async function requireReleased(exec: Db | Tx, reportId: string): Promise<LoadedReport> {
  const loaded = await loadReport(exec, reportId);
  const { report, study } = loaded;
  if (report.status === "superseded") {
    const current = await (exec as Db).select({ id: imagingReports.id, version: imagingReports.version })
      .from(imagingReports)
      .where(and(eq(imagingReports.studyId, study.id), eq(imagingReports.status, "signed")));
    throw new RadiologyError(
      "report_superseded",
      `Version ${String(report.version)} of the ${study.accessionNo} report was amended`
      + (current[0] ? ` — version ${String(current[0].version)} is the report now; open that one.` : "."),
      { reportId, currentReportId: current[0]?.id ?? null },
    );
  }
  if (report.status !== "signed") {
    throw new RadiologyError("report_not_signed", `The ${study.accessionNo} report is not signed yet.`, { reportId });
  }
  if (report.publishedAt === null) {
    throw new RadiologyError(
      "report_not_published",
      `The ${study.accessionNo} report is signed but not released yet — the reading room releases it.`,
      { reportId },
    );
  }
  return loaded;
}

/**
 * First read, FIRST only, and never the signer — the column's own rules (18a-iii T5). Idempotent and
 * race-free without a transaction of its own: the conflict arm's `setWhere` matches no row once the
 * read is stamped.
 */
export async function stampFirstRead(exec: Db | Tx, reportId: string, readerId: string, at: Date): Promise<void> {
  await (exec as Db)
    .insert(imagingReportDelivery)
    .values({ id: newId(), reportId, firstReadAt: at, firstReadBy: readerId })
    .onConflictDoUpdate({
      target: imagingReportDelivery.reportId,
      set: { firstReadAt: at, firstReadBy: readerId },
      setWhere: isNull(imagingReportDelivery.firstReadAt),
    });
}

export const ACTED_NOTE_MIN = 4;
export const ACTED_NOTE_MAX = 500;
export type ActedOutcome = (typeof IMAGING_ACTED_OUTCOMES)[number];

/**
 * ═══ T1 — THE LOOP CLOSES ═══
 *
 * The treating doctor says what the report changed. An act implies a read, so the first read is
 * stamped too if it was empty. One act per report VERSION (`already_resolved` on a second): an
 * amendment is a new version with its own delivery row, so the act on v1 does not count for v2 and
 * the loop re-opens (DECIDED).
 */
export async function markActedUpon(
  tx: Tx,
  actor: Actor,
  input: { reportId: string; outcome: string; note: string; now?: Date },
): Promise<{ reportId: string; actedAt: Date; outcome: ActedOutcome }> {
  if (actor.type !== "user") throw new RadiologyError("user_actor_required", "acting on a report is a doctor's act");
  const now = input.now ?? new Date();
  const { report, study } = await requireReleased(tx, input.reportId);
  if (!(await isTreatingDoctor(tx, actor, study.id))) await refuseNotTreating(tx, study.id, study.accessionNo);

  if (!(IMAGING_ACTED_OUTCOMES as readonly string[]).includes(input.outcome)) {
    throw new RadiologyError(
      "evidence_invalid",
      "Choose what the report changed: changed treatment, referred, follow-up booked, discussed with the patient, or no change needed.",
      { outcome: input.outcome },
    );
  }
  const note = (input.note ?? "").trim();
  if (note.length < ACTED_NOTE_MIN || note.length > ACTED_NOTE_MAX) {
    throw new RadiologyError(
      "acted_note_required",
      `Say in one line what the report changed (at least ${String(ACTED_NOTE_MIN)} characters).`,
      { min: ACTED_NOTE_MIN, max: ACTED_NOTE_MAX },
    );
  }
  const outcome = input.outcome as ActedOutcome;

  await stampFirstRead(tx, report.id, actor.id, now);
  const acted = await tx.update(imagingReportDelivery)
    .set({ actedAt: now, actedBy: actor.id, actedOutcome: outcome, actedNote: note })
    .where(and(eq(imagingReportDelivery.reportId, report.id), isNull(imagingReportDelivery.actedAt)))
    .returning({ id: imagingReportDelivery.id });
  if (acted.length === 0) {
    throw new RadiologyError(
      "already_resolved",
      `What the ${study.accessionNo} report changed is already recorded.`,
      { reportId: report.id },
    );
  }
  await appendEvent(tx, imagingReportActedUpon.make({
    actor, patientId: study.patientId, encounterId: study.encounterNo,
    payload: { reportId: report.id, studyId: study.id, version: report.version, outcome },
  }));
  return { reportId: report.id, actedAt: now, outcome };
}

/**
 * ═══ T3 — THE DOCTOR'S READ-BACK, ON THE SAME CRITICAL ROW ═══
 *
 * `POST /radiology/criticals/:id/acknowledge` is gated on `radiology.criticals.ack`, which only the
 * radiologist holds: it is where the reading room RECORDS a read-back taken on the telephone. The
 * doctor's own read-back from the inbox goes through this door instead — the treating doctor only,
 * with the doctor as the clinician who read it back — and calls the SAME `acknowledgeCritical`, so
 * there is one row, one event and one set of rules (red needs the read-back text; the signer can
 * never read back to themselves). DECIDED: no grant widened; a doctor cannot acknowledge a critical
 * on a patient who is not theirs.
 */
export async function doctorReadBack(
  tx: Tx,
  actor: Actor,
  input: { reportId: string; readBack?: string | null; now?: Date },
): Promise<{ criticalId: string; acknowledgedAt: Date }> {
  if (actor.type !== "user") throw new RadiologyError("user_actor_required", "a read-back is a doctor's act");
  const now = input.now ?? new Date();
  const { report, study } = await requireReleased(tx, input.reportId);
  if (!(await isTreatingDoctor(tx, actor, study.id))) await refuseNotTreating(tx, study.id, study.accessionNo);
  const crit = await (tx as unknown as Db).select({ id: imagingCriticalFindings.id })
    .from(imagingCriticalFindings).where(eq(imagingCriticalFindings.reportId, report.id));
  if (!crit[0]) {
    throw new RadiologyError("unknown_study", `The ${study.accessionNo} report carries no critical finding.`, { reportId: report.id });
  }
  const done = await acknowledgeCritical(tx, actor, {
    criticalId: crit[0].id, acknowledgedByClinicianId: actor.id, readBack: input.readBack ?? null, now,
  });
  await stampFirstRead(tx, report.id, actor.id, now);
  return done;
}

/* ═══════════════════════════ T3 — THE DOCTOR'S RESULTS INBOX ═══════════════════════════ */

export type InboxState = "unread" | "read" | "acted";

export type InboxRow = {
  reportId: string;
  studyId: string;
  accessionNo: string;
  studyName: string;
  studyTypeCode: string;
  patientId: string;
  patientName: string;
  uhid: string;
  version: number;
  amended: boolean;
  signedAt: string;
  publishedAt: string;
  signerName: string | null;
  impression: string | null;
  criticalCategory: string | null;
  critical: {
    criticalId: string; category: string; raisedAt: string;
    acknowledgedAt: string | null; readBack: string | null;
  } | null;
  state: InboxState;
  firstReadAt: string | null;
  chasedAt: string | null;
  acted: { at: string; outcome: string; note: string } | null;
  /** The ordering clinician is this doctor (else: the visit's doctor). */
  orderedByMe: boolean;
};

/** Acted reports stay in the inbox this long, so the doctor sees what they closed this fortnight. */
export const INBOX_ACTED_DAYS = 14;
export const INBOX_LIMIT = 200;
const RANK: Record<InboxState, number> = { unread: 0, read: 1, acted: 2 };

/**
 * The logged-in doctor's imaging results: every CURRENT released version of a study they treat,
 * open criticals first (not yet read back), then unread, then read-not-acted, then acted within
 * `INBOX_ACTED_DAYS`; newest first inside each band. A restricted (PCPNDT-class) study is shown only
 * to its ordering clinician or a holder of `orders.read.restricted` (patient-reports' rule).
 */
export async function doctorResultsInbox(db: Db, actor: Actor, now: Date = new Date()): Promise<InboxRow[]> {
  if (actor.type !== "user") throw new RadiologyError("user_actor_required", "an inbox is a person's");
  const canSeeConfidential = await hasPermission(db, actor.id, "patients.confidential.read", "hospital");
  const canSeeRestricted = await hasPermission(db, actor.id, "orders.read.restricted", "hospital");
  const actedSince = new Date(now.getTime() - INBOX_ACTED_DAYS * 86_400_000);

  const rows = await db
    .select({
      report: imagingReports,
      study: imagingStudies,
      orderingClinicianId: orders.orderingClinicianId,
      restricted: orderItems.restricted,
      studyName: services.name,
      name: patients.name, alias: patients.alias, isConfidential: patients.isConfidential, uhid: patients.uhid,
      delivery: imagingReportDelivery,
      signerName: users.fullName,
    })
    .from(imagingReports)
    .innerJoin(imagingStudies, eq(imagingStudies.id, imagingReports.studyId))
    .innerJoin(orders, eq(orders.id, imagingStudies.orderId))
    .innerJoin(orderItems, eq(orderItems.id, imagingStudies.orderItemId))
    .innerJoin(services, eq(services.id, imagingStudies.serviceId))
    .innerJoin(patients, eq(patients.id, imagingStudies.patientId))
    .leftJoin(opdEncounters, eq(opdEncounters.visitNo, imagingStudies.encounterNo))
    .leftJoin(opdDoctors, eq(opdDoctors.id, opdEncounters.doctorId))
    .leftJoin(imagingReportDelivery, eq(imagingReportDelivery.reportId, imagingReports.id))
    .leftJoin(users, eq(users.id, imagingReports.signerId))
    .where(and(
      eq(imagingReports.status, "signed"),
      isNotNull(imagingReports.publishedAt),
      or(eq(orders.orderingClinicianId, actor.id), eq(opdDoctors.userId, actor.id)),
      or(isNull(imagingReportDelivery.actedAt), sql`${imagingReportDelivery.actedAt} >= ${actedSince}`),
    ))
    .orderBy(desc(imagingReports.publishedAt))
    .limit(INBOX_LIMIT);

  const visible = rows.filter((r) => !r.restricted || canSeeRestricted || r.orderingClinicianId === actor.id);
  const reportIds = visible.map((r) => r.report.id);
  const crits = reportIds.length === 0 ? [] : await db.select().from(imagingCriticalFindings)
    .where(inArray(imagingCriticalFindings.reportId, reportIds));
  const critBy = new Map(crits.map((c) => [c.reportId, c]));

  const seen = new Set<string>();
  for (const r of visible) {
    if (seen.has(r.study.patientId)) continue;
    seen.add(r.study.patientId);
    await recordPhiAccess(db, {
      actor, patientId: r.study.patientId, surface: "imaging.report",
      reason: "the treating doctor's imaging results", now,
    });
  }

  const out: InboxRow[] = visible.map((r) => {
    const d = r.delivery;
    const c = critBy.get(r.report.id);
    const state: InboxState = d?.actedAt ? "acted" : d?.firstReadAt ? "read" : "unread";
    return {
      reportId: r.report.id, studyId: r.study.id, accessionNo: r.study.accessionNo,
      studyName: r.studyName, studyTypeCode: r.study.studyTypeCode,
      patientId: r.study.patientId,
      patientName: displayName({ name: r.name, alias: r.alias, isConfidential: r.isConfidential }, canSeeConfidential),
      uhid: r.uhid,
      version: r.report.version, amended: r.report.supersedesId !== null,
      signedAt: r.report.signedAt!.toISOString(), publishedAt: r.report.publishedAt!.toISOString(),
      signerName: r.signerName ?? null,
      impression: r.report.impression, criticalCategory: r.report.criticalCategory,
      critical: c ? {
        criticalId: c.id, category: c.category, raisedAt: c.createdAt.toISOString(),
        acknowledgedAt: c.acknowledgedAt?.toISOString() ?? null, readBack: c.readBackText ?? null,
      } : null,
      state,
      firstReadAt: d?.firstReadAt?.toISOString() ?? null,
      chasedAt: d?.unreadChasedAt?.toISOString() ?? null,
      acted: d?.actedAt && d.actedOutcome && d.actedNote
        ? { at: d.actedAt.toISOString(), outcome: d.actedOutcome, note: d.actedNote } : null,
      orderedByMe: r.orderingClinicianId === actor.id,
    };
  });

  const openCrit = (x: InboxRow): number => (x.critical !== null && x.critical.acknowledgedAt === null ? 0 : 1);
  return out.sort((a, b) =>
    openCrit(a) - openCrit(b)
    || RANK[a.state] - RANK[b.state]
    || b.publishedAt.localeCompare(a.publishedAt));
}
