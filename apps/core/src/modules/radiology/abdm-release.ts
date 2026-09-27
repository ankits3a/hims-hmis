import { and, asc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { imagingReports, imagingStudies, orderItems, services } from "../../kernel/db/schema";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ ABDM S2 — WHAT RADIOLOGY RELEASES TO THE NATIONAL NETWORK, READ BY RADIOLOGY ═══
 *
 * The SIGNED report of each study of the named visits — `imaging_reports_one_signed_ux` makes it one
 * per study, so an amended report reads as its current text and a draft or prelim never leaves.
 *
 * THE RESTRICTED RULE IS THE KERNEL'S (DD11), as `patient-reports.ts` applies it to the doctor's
 * brief: a PCPNDT-class study is shown to the clinician who ordered it or a holder of
 * `orders.read.restricted`. An HIU is neither, so it is OMITTED without a trace — the existence of
 * the scan is the sensitive fact. Cancelled items are omitted too. No actor and no PHI row here; the
 * connector audits the disclosure against the patient.
 */
export type ImagingReleaseReport = {
  reportId: string;
  studyId: string;
  accessionNo: string;
  encounterNo: string;
  patientId: string;
  studyName: string;
  signedAt: Date;
  /** The report's sections in the order they were written (`technique`, `findings`, …), text only. */
  sections: { name: string; text: string }[];
  impression: string | null;
};

function sectionsOf(body: unknown): { name: string; text: string }[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return [];
  return Object.entries(body as Record<string, unknown>)
    .filter((e): e is [string, string] => typeof e[1] === "string" && e[1].trim() !== "")
    .filter(([k]) => k !== "impression") // carried on its own column
    .map(([name, text]) => ({ name, text: text.trim() }));
}

export async function signedImagingReportsForRelease(db: Db | Tx, encounterNos: readonly string[]): Promise<ImagingReleaseReport[]> {
  const nos = [...new Set(encounterNos)];
  if (nos.length === 0) return [];
  const rows = await db
    .select({ study: imagingStudies, report: imagingReports, studyName: services.name })
    .from(imagingReports)
    .innerJoin(imagingStudies, eq(imagingStudies.id, imagingReports.studyId))
    .innerJoin(orderItems, eq(orderItems.id, imagingStudies.orderItemId))
    .innerJoin(services, eq(services.id, imagingStudies.serviceId))
    .where(and(
      inArray(imagingStudies.encounterNo, nos),
      eq(imagingReports.status, "signed"),
      isNotNull(imagingReports.signedAt),
      eq(orderItems.restricted, false),
      ne(orderItems.status, "cancelled"),
    ))
    .orderBy(asc(imagingReports.signedAt));
  return rows.map(({ study, report, studyName }) => ({
    reportId: report.id,
    studyId: study.id,
    accessionNo: study.accessionNo,
    encounterNo: study.encounterNo,
    patientId: study.patientId,
    studyName,
    signedAt: report.signedAt!,
    sections: sectionsOf(report.body),
    impression: report.impression === null || report.impression.trim() === "" ? null : report.impression.trim(),
  }));
}
