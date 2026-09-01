import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { hasPermission } from "../../kernel/auth/permissions";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { imagingReports, imagingStudies } from "../../kernel/db/schema/radiology";
import { orderItems, orders } from "../../kernel/db/schema/orders";
import { patients } from "../../kernel/db/schema/patients";
import { displayName } from "../patients";
import { RadiologyError } from "./errors";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * PLAN 18a T8 — **THE THREE READS, AND ALL THREE LOG.**
 *
 * ═══ DD11 — THE WORKLIST IS CONFIDENTIALITY-BEARING, AND A8 IS WHY ═══
 *
 * A radiology worklist is a list of people and what is being looked for inside them. Two separate
 * rules apply to it and they are NOT the same rule:
 *
 *   · **RESTRICTED** (the item's flag, set at placement by the PCPNDT rule and by phase 0's own
 *     lanes) — a row somebody may not see AT ALL. Held out entirely.
 *   · **CONFIDENTIAL** (the patient's flag) — a row everybody may see, under a NAME most people may
 *     not. Rendered through `displayName`.
 *
 * **A8's mutant conflates them**: *"show restricted rows with the alias"*. That is the natural
 * shortcut — one filter, one rendering, done — and it is a disclosure: the row itself says a named
 * ward has an obstetric ultrasound booked at 14:30, and an alias on top of it hides nothing that
 * matters. Phase 0's T5 A1 makes the same distinction one door over.
 *
 * The restricted rule is the KERNEL's, transcribed rather than reinvented (`orders/read.ts`'s
 * `visibleItems`): `orders.read.restricted`, **or** being the ordering clinician on that order.
 * Two readers of one rule would be one reader too many, and this one is a projection of the same
 * facts onto a department's day.
 *
 * ═══ EVERY READ WRITES A PHI ROW, AND THE THREE SURFACES ARE THREE NAMES ═══
 *
 * `imaging.worklist`, `imaging.study` and `imaging.report` — separate for the reason
 * `opd.rx_history` is not `opd.prescriptions`: a departmental queue, one patient's study, and a
 * signed report handed to a counter are materially different disclosures, and a log that could not
 * tell them apart would answer *"what did they actually see"* wrong, which is the only question it
 * exists for.
 */

const WORKLIST_READ = "radiology.worklist.read";
const REPORT_READ = "radiology.reports.read";

type Clearance = { canSeeRestricted: boolean; canSeeConfidential: boolean; userId: string };

async function clearanceOf(db: Db, actor: Actor): Promise<Clearance> {
  if (actor.type !== "user") {
    throw new RadiologyError(
      "unknown_study",
      `a ${actor.type} actor may not read a radiology worklist — it is a departmental queue and it is confidentiality-bearing (DD11)`,
    );
  }
  const [canSeeRestricted, canSeeConfidential] = await Promise.all([
    hasPermission(db, actor.id, "orders.read.restricted", "hospital"),
    hasPermission(db, actor.id, "patients.confidential.read", "hospital"),
  ]);
  return { canSeeRestricted, canSeeConfidential, userId: actor.id };
}

export type WorklistRow = {
  studyId: string;
  accessionNo: string;
  status: string;
  priority: string;
  studyTypeCode: string;
  scheduledAt: Date | null;
  deviceResourceId: string | null;
  encounterNo: string;
  patientId: string;
  /** Through `displayName` — a confidential patient shows their alias to a reader without clearance. */
  patientName: string;
  formFRequired: boolean;
  restricted: boolean;
};

/** The technologist's day and the radiologist's unread list, from one index (DD16). */
export const WORKLIST_VIEWS = {
  /** Everything the floor still has to do. */
  floor: ["scheduled", "checked_in", "ready", "in_acquisition"],
  /** DD16 — the radiologist's unread list. */
  unread: ["acquired", "reported"],
  all: ["scheduled", "checked_in", "ready", "in_acquisition", "acquired", "reported", "published"],
} as const;

export type WorklistView = keyof typeof WORKLIST_VIEWS;

export async function worklist(
  db: Db,
  actor: Actor,
  opts: { view?: WorklistView; deviceResourceId?: string; limit?: number } = {},
): Promise<WorklistRow[]> {
  if (!(await hasPermission(db, actor.id, WORKLIST_READ, "hospital"))) {
    throw new RadiologyError("unknown_study", `${actor.id} does not hold ${WORKLIST_READ}`);
  }
  const clearance = await clearanceOf(db, actor);
  const statuses = WORKLIST_VIEWS[opts.view ?? "floor"];

  const rows = await db
    .select({
      studyId: imagingStudies.id,
      accessionNo: imagingStudies.accessionNo,
      status: imagingStudies.status,
      priority: imagingStudies.priority,
      studyTypeCode: imagingStudies.studyTypeCode,
      scheduledAt: imagingStudies.scheduledAt,
      deviceResourceId: imagingStudies.deviceResourceId,
      encounterNo: imagingStudies.encounterNo,
      patientId: imagingStudies.patientId,
      formFRequired: imagingStudies.formFRequired,
      restricted: orderItems.restricted,
      orderingClinicianId: orders.orderingClinicianId,
      name: patients.name,
      alias: patients.alias,
      isConfidential: patients.isConfidential,
    })
    .from(imagingStudies)
    .innerJoin(orderItems, eq(orderItems.id, imagingStudies.orderItemId))
    .innerJoin(orders, eq(orders.id, imagingStudies.orderId))
    .innerJoin(patients, eq(patients.id, imagingStudies.patientId))
    .where(and(
      inArray(imagingStudies.status, [...statuses]),
      ...(opts.deviceResourceId === undefined
        ? [] : [eq(imagingStudies.deviceResourceId, opts.deviceResourceId)]),
    ))
    .orderBy(asc(imagingStudies.scheduledAt))
    .limit(opts.limit ?? 200);

  /**
   * A8 — the two rules, applied separately and in this order. The FILTER first: a row held out is
   * not rendered at all, and a row that is rendered has had its name decided independently.
   */
  const visible = rows.filter((r) =>
    !r.restricted || clearance.canSeeRestricted || r.orderingClinicianId === clearance.userId);

  await recordPhiAccess(db, {
    actor,
    patientId: visible[0]?.patientId ?? "worklist",
    surface: "imaging.worklist",
    reason: `radiology worklist (${opts.view ?? "floor"}), ${String(visible.length)} rows`,
  });

  return visible.map((r) => ({
    studyId: r.studyId, accessionNo: r.accessionNo, status: r.status, priority: r.priority,
    studyTypeCode: r.studyTypeCode, scheduledAt: r.scheduledAt,
    deviceResourceId: r.deviceResourceId, encounterNo: r.encounterNo, patientId: r.patientId,
    patientName: displayName(
      { name: r.name, alias: r.alias, isConfidential: r.isConfidential }, clearance.canSeeConfidential,
    ),
    formFRequired: r.formFRequired, restricted: r.restricted,
  }));
}

export type StudyView = WorklistRow & {
  ionising: boolean;
  contrastGiven: boolean;
  acquiredAt: Date | null;
  authorisedBy: string | null;
  reports: { id: string; version: number; status: string; publishedAt: Date | null }[];
};

/** One study, for the console. Same two rules; `imaging.study` is its own surface. */
export async function studyView(db: Db, actor: Actor, studyId: string): Promise<StudyView | null> {
  if (!(await hasPermission(db, actor.id, WORKLIST_READ, "hospital"))) {
    throw new RadiologyError("unknown_study", `${actor.id} does not hold ${WORKLIST_READ}`);
  }
  const clearance = await clearanceOf(db, actor);
  const rows = await db
    .select({
      study: imagingStudies, restricted: orderItems.restricted,
      orderingClinicianId: orders.orderingClinicianId,
      name: patients.name, alias: patients.alias, isConfidential: patients.isConfidential,
    })
    .from(imagingStudies)
    .innerJoin(orderItems, eq(orderItems.id, imagingStudies.orderItemId))
    .innerJoin(orders, eq(orders.id, imagingStudies.orderId))
    .innerJoin(patients, eq(patients.id, imagingStudies.patientId))
    .where(eq(imagingStudies.id, studyId));
  const row = rows[0];
  if (!row) return null;

  if (row.restricted && !clearance.canSeeRestricted && row.orderingClinicianId !== clearance.userId) {
    /** Held out ENTIRELY — the same answer an unknown study gets, which is the point of a hold-out. */
    return null;
  }

  await recordPhiAccess(db, {
    actor, patientId: row.study.patientId, surface: "imaging.study",
    encounterId: row.study.encounterNo, reason: `study ${row.study.accessionNo}`,
  });

  const reports = await db
    .select({
      id: imagingReports.id, version: imagingReports.version,
      status: imagingReports.status, publishedAt: imagingReports.publishedAt,
    })
    .from(imagingReports)
    .where(eq(imagingReports.studyId, studyId))
    .orderBy(desc(imagingReports.version));

  return {
    studyId: row.study.id, accessionNo: row.study.accessionNo, status: row.study.status,
    priority: row.study.priority, studyTypeCode: row.study.studyTypeCode,
    scheduledAt: row.study.scheduledAt, deviceResourceId: row.study.deviceResourceId,
    encounterNo: row.study.encounterNo, patientId: row.study.patientId,
    patientName: displayName(
      { name: row.name, alias: row.alias, isConfidential: row.isConfidential }, clearance.canSeeConfidential,
    ),
    formFRequired: row.study.formFRequired, restricted: row.restricted,
    ionising: row.study.ionising, contrastGiven: row.study.contrastGiven,
    acquiredAt: row.study.acquiredAt, authorisedBy: row.study.authorisedBy,
    reports,
  };
}

export type ReportView = {
  reportId: string;
  studyId: string;
  accessionNo: string;
  version: number;
  status: string;
  templateKey: string;
  body: unknown;
  impression: string | null;
  laterality: string | null;
  criticalCategory: string | null;
  signerId: string | null;
  signedAt: Date | null;
  publishedAt: Date | null;
  amendmentReason: string | null;
  supersedesId: string | null;
  patientName: string;
};

/**
 * The signed document. `radiology.reports.read` rather than the worklist permission, because DD16
 * splits them deliberately: the treating `doctor` reads the REPORT of a scan they ordered and does
 * NOT get the departmental queue.
 */
export async function reportView(db: Db, actor: Actor, reportId: string): Promise<ReportView | null> {
  if (!(await hasPermission(db, actor.id, REPORT_READ, "hospital"))) {
    throw new RadiologyError("unknown_study", `${actor.id} does not hold ${REPORT_READ}`);
  }
  const clearance = await clearanceOf(db, actor);
  const rows = await db
    .select({
      report: imagingReports, study: imagingStudies, restricted: orderItems.restricted,
      orderingClinicianId: orders.orderingClinicianId,
      name: patients.name, alias: patients.alias, isConfidential: patients.isConfidential,
    })
    .from(imagingReports)
    .innerJoin(imagingStudies, eq(imagingStudies.id, imagingReports.studyId))
    .innerJoin(orderItems, eq(orderItems.id, imagingStudies.orderItemId))
    .innerJoin(orders, eq(orders.id, imagingStudies.orderId))
    .innerJoin(patients, eq(patients.id, imagingStudies.patientId))
    .where(eq(imagingReports.id, reportId));
  const row = rows[0];
  if (!row) return null;
  if (row.restricted && !clearance.canSeeRestricted && row.orderingClinicianId !== clearance.userId) {
    return null;
  }

  await recordPhiAccess(db, {
    actor, patientId: row.study.patientId, surface: "imaging.report",
    encounterId: row.study.encounterNo,
    reason: `report v${String(row.report.version)} on ${row.study.accessionNo}`,
  });

  return {
    reportId: row.report.id, studyId: row.study.id, accessionNo: row.study.accessionNo,
    version: row.report.version, status: row.report.status, templateKey: row.report.templateKey,
    body: row.report.body, impression: row.report.impression, laterality: row.report.laterality,
    criticalCategory: row.report.criticalCategory, signerId: row.report.signerId,
    signedAt: row.report.signedAt, publishedAt: row.report.publishedAt,
    amendmentReason: row.report.amendmentReason, supersedesId: row.report.supersedesId,
    patientName: displayName(
      { name: row.name, alias: row.alias, isConfidential: row.isConfidential }, clearance.canSeeConfidential,
    ),
  };
}
