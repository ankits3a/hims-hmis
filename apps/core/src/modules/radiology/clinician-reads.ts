import { and, asc, eq, isNotNull, isNull, or } from "drizzle-orm";
import { hasPermission } from "../../kernel/auth/permissions";
import { imagingCriticalFindings, imagingReportDelivery, imagingReports, imagingStudies } from "../../kernel/db/schema/radiology";
import { orderItems, orders } from "../../kernel/db/schema/orders";
import { opdDoctors, opdEncounters } from "../../kernel/db/schema/opd";
import { services } from "../../kernel/db/schema/tariff";
import type { SQL } from "drizzle-orm";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * DOCTOR DESK DD-0.2 (#626, plan §4.4) — IMAGING'S ROWS FOR THE TREATING DOCTOR, as rows.
 *
 * The same two bands `waiting.ts` counts and the results inbox lists (`closed-loop.ts`): released
 * reports nobody but the signer has opened, and critical findings not yet acknowledged. "Treating" is
 * that file's rule — the ordering clinician or the doctor of the visit — and a restricted study is a
 * row only for whoever the inbox would show it to (for a restricted study the existence of the study
 * is the sensitive fact). A report drops off the moment its first read is stamped (`stampFirstRead`).
 */
export type ClinicianImagingRow = {
  reportId: string;
  studyId: string;
  patientId: string;
  encounterNo: string;
  study: string;
  /** True for an unacknowledged critical finding on the report; false for "released, unread". */
  critical: boolean;
  /** When the report was released (unread) or the finding was raised (critical). */
  at: Date;
};

async function treatedBy(exec: Db | Tx, userId: string): Promise<SQL> {
  const canSeeRestricted = await hasPermission(exec as Db, userId, "orders.read.restricted", "hospital");
  const treating = or(eq(orders.orderingClinicianId, userId), eq(opdDoctors.userId, userId))!;
  return canSeeRestricted ? treating
    : and(treating, or(eq(orderItems.restricted, false), eq(orders.orderingClinicianId, userId)))!;
}

export async function unreadReportsForClinician(exec: Db | Tx, userId: string): Promise<ClinicianImagingRow[]> {
  const mine = await treatedBy(exec, userId);
  const released = and(eq(imagingReports.status, "signed"), isNotNull(imagingReports.publishedAt));
  const base = {
    reportId: imagingReports.id, studyId: imagingStudies.id, patientId: imagingStudies.patientId,
    encounterNo: imagingStudies.encounterNo, study: services.name,
  };
  const unread = await (exec as Db)
    .selectDistinct({ ...base, at: imagingReports.publishedAt })
    .from(imagingReports)
    .innerJoin(imagingStudies, eq(imagingStudies.id, imagingReports.studyId))
    .innerJoin(services, eq(services.id, imagingStudies.serviceId))
    .innerJoin(orders, eq(orders.id, imagingStudies.orderId))
    .innerJoin(orderItems, eq(orderItems.id, imagingStudies.orderItemId))
    .leftJoin(opdEncounters, eq(opdEncounters.visitNo, imagingStudies.encounterNo))
    .leftJoin(opdDoctors, eq(opdDoctors.id, opdEncounters.doctorId))
    .leftJoin(imagingReportDelivery, eq(imagingReportDelivery.reportId, imagingReports.id))
    .where(and(released, mine, isNull(imagingReportDelivery.firstReadAt)))
    .orderBy(asc(imagingReports.publishedAt));
  const crit = await (exec as Db)
    .selectDistinct({ ...base, at: imagingCriticalFindings.createdAt })
    .from(imagingCriticalFindings)
    .innerJoin(imagingReports, eq(imagingReports.id, imagingCriticalFindings.reportId))
    .innerJoin(imagingStudies, eq(imagingStudies.id, imagingReports.studyId))
    .innerJoin(services, eq(services.id, imagingStudies.serviceId))
    .innerJoin(orders, eq(orders.id, imagingStudies.orderId))
    .innerJoin(orderItems, eq(orderItems.id, imagingStudies.orderItemId))
    .leftJoin(opdEncounters, eq(opdEncounters.visitNo, imagingStudies.encounterNo))
    .leftJoin(opdDoctors, eq(opdDoctors.id, opdEncounters.doctorId))
    .where(and(released, mine, isNull(imagingCriticalFindings.acknowledgedAt)))
    .orderBy(asc(imagingCriticalFindings.createdAt));
  const critIds = new Set(crit.map((c) => c.reportId));
  return [
    ...crit.map((r) => ({ ...r, critical: true })),
    // A report with an open critical is one row (the critical), not two.
    ...unread.filter((r) => r.at !== null && !critIds.has(r.reportId)).map((r) => ({ ...r, at: r.at!, critical: false })),
  ];
}
