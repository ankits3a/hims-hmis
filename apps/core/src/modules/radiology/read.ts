import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { hasPermission } from "../../kernel/auth/permissions";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { imagingReports, imagingStudies } from "../../kernel/db/schema/radiology";
import { orderItems } from "../../kernel/db/schema/orders";
import { patients } from "../../kernel/db/schema/patients";
import { displayName } from "../patients";
import { RadiologyError } from "./errors";
import { mintStudyInstanceUid } from "./uid";
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
 *     lanes) — a row a reader OUTSIDE the performing department may not see at all.
 *   · **CONFIDENTIAL** (the patient's flag) — a row everybody may see, under a NAME most people may
 *     not. Rendered through `displayName`.
 *
 * **A8's mutant conflates them**: *"show restricted rows with the alias"*. That is the natural
 * shortcut — one filter, one rendering, done — and it is a disclosure to a reader who should not
 * have the row at all. Phase 0's T5 A1 makes the same distinction one door over.
 *
 * ═══ FINDING F45 (CLOSE REVIEW, OWNER RULING 2026-09-01) — THE HOLD-OUT IS NOT THE DEPARTMENT'S ═══
 *
 * The first version transcribed the KERNEL's restricted rule (`orders/read.ts`'s `visibleItems`):
 * `orders.read.restricted`, or being the ordering clinician. **That was the wrong rule for this
 * surface, and it made the module unable to do its own job.**
 *
 * `orders.read.restricted` is granted to NO role — `seed-roles.ts` parks it in `NOT_YET_MODELLED`
 * as a Class-A grant for the owner, and its reason names *"the PCPNDT-class USG"* explicitly. The
 * PCPNDT applicability rule sets `restricted` on every covered scan. The seeded book marks three
 * study types covered. So **every obstetric ultrasound in the hospital was held out of the only
 * list that yields a study id** — from the receptionist who must book it, the radiographer who must
 * scan it and the radiologist who must report it alike. The ordering clinician's exemption could
 * not save it either: `doctor` does not hold `radiology.worklist.read`, so the permission check
 * above throws first. The reception screen renders an empty list and no error.
 *
 * **THE RULING: `radiology.worklist.read` IS the departmental clearance.** It is held by exactly
 * three roles — radiographer, radiologist, radiology_receptionist — and holding it means you are
 * the department that performs the scan. A hold-out against the people performing the examination
 * protects nobody and stops the examination.
 *
 * **What still holds the row out, and it is the surface that was always meant to:** the KERNEL's
 * `listOrdersForPatient` is unchanged, so a WARD's pending list still omits the PCPNDT-class USG
 * for a reader without the clearance. DD11's actual concern was a ward clerk browsing a patient's
 * investigations; that is a different reader on a different route, and it is still refused. This is
 * the lab's precedent applied here — *"the lab's own worklists read the lab's own tables"*, and the
 * bench never applied the kernel hold-out to itself.
 *
 * The `restricted` flag is still RETURNED on every row, so a screen can badge it and a reader can
 * see that the row is one the Act covers. It is a label here, not a filter.
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

type Clearance = { canSeeConfidential: boolean; userId: string };

async function clearanceOf(db: Db, actor: Actor): Promise<Clearance> {
  if (actor.type !== "user") {
    throw new RadiologyError(
      "forbidden",
      `a ${actor.type} actor may not read a radiology worklist — it is a departmental queue and it is confidentiality-bearing (DD11)`,
    );
  }
  /**
   * F45 — only the CONFIDENTIAL rule is a clearance on this surface now. The restricted rule is the
   * kernel's, on the kernel's own reader, for readers outside this department (see the header).
   */
  const canSeeConfidential = await hasPermission(db, actor.id, "patients.confidential.read", "hospital");
  return { canSeeConfidential, userId: actor.id };
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
    throw new RadiologyError("forbidden", `${actor.id} does not hold ${WORKLIST_READ}`);
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
      name: patients.name,
      alias: patients.alias,
      isConfidential: patients.isConfidential,
    })
    .from(imagingStudies)
    .innerJoin(orderItems, eq(orderItems.id, imagingStudies.orderItemId))
    .innerJoin(patients, eq(patients.id, imagingStudies.patientId))
    .where(and(
      inArray(imagingStudies.status, [...statuses]),
      ...(opts.deviceResourceId === undefined
        ? [] : [eq(imagingStudies.deviceResourceId, opts.deviceResourceId)]),
    ))
    /**
     * ═══ `stat` FIRST IN SQL, BECAUSE THE CAP TRUNCATES BEFORE THE CLIENT SORTS (F43) ═══
     *
     * The first draft ordered by slot alone and left the priority sort to the screen. With a cap of
     * 200 that is a clinical defect rather than a cosmetic one: in a busy department a STAT scan
     * slotted late in the day falls outside the window, and the client then sorts stat-first over
     * the rows that survived — so the one row that had to be seen is the one that was dropped.
     *
     * Ordering by priority HERE means truncation can only ever drop routine work.
     * **Pagination is still owed** and is named rather than implied: a department with more than
     * 200 live studies loses the tail of the list, and the honest fix is a cursor, which is a
     * screen this slice does not have (§1.3).
     */
    .orderBy(sql`case when ${imagingStudies.priority} = 'stat' then 0 when ${imagingStudies.priority} = 'urgent' then 1 else 2 end`, asc(imagingStudies.scheduledAt))
    .limit(opts.limit ?? 200);

  /**
   * F45 — THERE IS NO FILTER HERE ANY MORE, and F75 dissolved with it.
   *
   * The close review found that the hold-out ran AFTER the SQL `LIMIT`, so a held-out row consumed
   * a slot in a deterministically ordered window: the response length was a function of the hidden
   * rows, and routine work was pushed out of a window F43 had already narrowed. Both problems are
   * gone rather than fixed, because the department is not a reader this surface holds rows from.
   * `restricted` is still selected and still returned — as a LABEL for the screen, not a filter.
   */
  const visible = rows;

  /**
   * ═══ ONE ROW PER PATIENT DISCLOSED, NOT ONE ROW PER READ (F42) ═══
   *
   * The first draft logged a single row carrying `visible[0].patientId` — so a technologist opening
   * a twenty-row list left ONE audit row, and *"who looked at patient P7's record"* returned nothing
   * for nineteen of them. **A partial access log is worse than none, because it looks complete.**
   * (It also wrote the literal string `"worklist"` when the list was empty, which the column accepts
   * because `phi_access_log.patient_id` carries no foreign key.)
   *
   * DD11 declared `imaging.worklist` a PHI surface precisely so this read is answerable, and the
   * only shape that answers it is one row per distinct patient. `recordPhiAccess` never throws (its
   * own header) and the table is pruned at `PHI_ACCESS_RETAIN_DAYS`, so the volume is bounded.
   */
  const reason = `radiology worklist (${opts.view ?? "floor"}), ${String(visible.length)} rows`;
  for (const patientId of new Set(visible.map((r) => r.patientId))) {
    await recordPhiAccess(db, { actor, patientId, surface: "imaging.worklist", reason });
  }

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
  /**
   * F59/F73 — the side, which the `laterality_confirm` gate records at check-in. The console needs
   * it to render, and the report screen needs it because `assertSignable` refuses a report on a
   * lateralised type that names no side and the radiologist must not be retyping which knee.
   */
  laterality: string;
  ionising: boolean;
  contrastGiven: boolean;
  acquiredAt: Date | null;
  authorisedBy: string | null;
  /** 18b T2 — null until acquisition; the console shows `mintedStudyInstanceUid` before that. */
  studyInstanceUid: string | null;
  imageSource: string | null;
  /** 18b T2 / D3 — what the worklist export carried and what `pacs` acquisition writes by default. */
  mintedStudyInstanceUid: string;
  reports: { id: string; version: number; status: string; publishedAt: Date | null }[];
};

/** One study, for the console. Same two rules; `imaging.study` is its own surface. */
export async function studyView(db: Db, actor: Actor, studyId: string): Promise<StudyView | null> {
  if (!(await hasPermission(db, actor.id, WORKLIST_READ, "hospital"))) {
    throw new RadiologyError("forbidden", `${actor.id} does not hold ${WORKLIST_READ}`);
  }
  const clearance = await clearanceOf(db, actor);
  const rows = await db
    .select({
      study: imagingStudies, restricted: orderItems.restricted,
      name: patients.name, alias: patients.alias, isConfidential: patients.isConfidential,
    })
    .from(imagingStudies)
    .innerJoin(orderItems, eq(orderItems.id, imagingStudies.orderItemId))
    .innerJoin(patients, eq(patients.id, imagingStudies.patientId))
    .where(eq(imagingStudies.id, studyId));
  const row = rows[0];
  if (!row) return null;

  /**
   * F45 — the hold-out is gone from this reader too. It answered `null` for exactly the studies the
   * console has to open, so the study screen printed "unknown study" for every obstetric scan while
   * the readiness route underneath it rendered the gate list in full.
   */

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
    laterality: row.study.laterality,
    ionising: row.study.ionising, contrastGiven: row.study.contrastGiven,
    acquiredAt: row.study.acquiredAt, authorisedBy: row.study.authorisedBy,
    studyInstanceUid: row.study.studyInstanceUid, imageSource: row.study.imageSource,
    mintedStudyInstanceUid: mintStudyInstanceUid(row.study.id),
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
    throw new RadiologyError("forbidden", `${actor.id} does not hold ${REPORT_READ}`);
  }
  const clearance = await clearanceOf(db, actor);
  const rows = await db
    .select({
      report: imagingReports, study: imagingStudies, restricted: orderItems.restricted,
      name: patients.name, alias: patients.alias, isConfidential: patients.isConfidential,
    })
    .from(imagingReports)
    .innerJoin(imagingStudies, eq(imagingStudies.id, imagingReports.studyId))
    .innerJoin(orderItems, eq(orderItems.id, imagingStudies.orderItemId))
    .innerJoin(patients, eq(patients.id, imagingStudies.patientId))
    .where(eq(imagingReports.id, reportId));
  const row = rows[0];
  if (!row) return null;
  /**
   * ═══ F45, SECOND PASS — THIS READER IS NOT THE DEPARTMENT, AND IT WAS SERVING DRAFTS ═══
   *
   * The first fix removed the hold-out here with the comment *"a signed report is readable by the
   * department that produced it"*. **That comment was wrong about its own reader.** This route is
   * gated on `radiology.reports.read`, which DD16 deliberately grants to the seeded `doctor` role
   * as well — that is the whole point of splitting it from the worklist permission. So the readers
   * who lost the hold-out are every doctor in the hospital, which is a defensible ruling for a
   * SIGNED report (the treating clinician reads the report of the scan they ordered) and is not
   * one at all for a DRAFT.
   *
   * And this reader applied no status filter: `draft`, `prelim`, `signed` and `superseded` alike.
   * F68 excluded drafts from the lockout on the ground that *"nothing outside the department can
   * read one"* — and this function disproved that in the same commit. A night registrar's unchecked
   * scratch text was readable by any holder of `radiology.reports.read`.
   *
   * **A draft is not a document.** It is served only to a reader who also holds the worklist
   * permission — the department — and everyone else gets the same `null` an unknown id gets.
   */
  if (["draft"].includes(row.report.status)
    && !(await hasPermission(db, actor.id, WORKLIST_READ, "hospital"))) {
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
