import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { labReportDeliveries, labReports, opdDoctors, opdEncounters, orders } from "../../kernel/db/schema";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ #682 — THE TREATING DOCTOR'S READ, RECORDED WHERE IT HAPPENS ═══
 *
 * Imaging's rule (`radiology/read.ts`, 18-S RS9 T1), applied to the lab: the read that "lands" is
 * the TREATING doctor's — the order's responsible clinician (`orders.ordering_clinician_id`, DD6) or
 * the doctor of the OPD visit the order sits on — and never the signer's. The lab opening its own
 * work (the counter, the bench, the pathologist who signed) is not the doctor seeing the result.
 *
 * Stored as ONE `lab_report_deliveries` row on the `doctor_screen` channel per report VERSION: first
 * read only, who and when. An amendment is a new report row and so is unread again, as imaging's
 * re-issued version is. The register's own channels (print, whatsapp, in_person) are hand-overs;
 * this one is not, and the counter's readers leave it out (`reports.ts`).
 *
 * The table has no unique key on (report, channel), so "first only" is a per-report advisory lock
 * around an insert-if-absent: two simultaneous opens write one row. No migration.
 *
 * Called LAST by the doctor-facing readers (`getReport`, `listResultsForEncounter`), after their PHI
 * log, which it neither replaces nor touches.
 */
export const DOCTOR_SCREEN = "doctor_screen";

/** A report is current while it is the published or amended version — never a superseded one. */
const CURRENT = ["published", "amended"] as const;

export async function stampDoctorRead(
  db: Db, actor: Actor, orderIds: readonly string[], now: Date,
): Promise<string[]> {
  if (actor.type !== "user" || orderIds.length === 0) return [];
  const due = await db
    .selectDistinct({ id: labReports.id })
    .from(labReports)
    .innerJoin(orders, eq(orders.id, labReports.orderId))
    .leftJoin(opdEncounters, eq(opdEncounters.visitNo, orders.encounterNo))
    .leftJoin(opdDoctors, eq(opdDoctors.id, opdEncounters.doctorId))
    .where(and(
      inArray(labReports.orderId, [...orderIds]),
      inArray(labReports.status, [...CURRENT]),
      isNotNull(labReports.publishedAt),
      or(isNull(labReports.signedBy), ne(labReports.signedBy, actor.id)),
      or(eq(orders.orderingClinicianId, actor.id), eq(opdDoctors.userId, actor.id)),
      sql`not exists (select 1 from lab_report_deliveries d
        where d.report_id = ${labReports.id} and d.channel = ${DOCTOR_SCREEN})`,
    ));
  const stamped: string[] = [];
  for (const { id: reportId } of due) {
    const won = await withTx(db, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`lab.doctor_read:${reportId}`}))`);
      const seen = await tx.select({ id: labReportDeliveries.id }).from(labReportDeliveries)
        .where(and(eq(labReportDeliveries.reportId, reportId), eq(labReportDeliveries.channel, DOCTOR_SCREEN)))
        .limit(1);
      if (seen.length > 0) return false;
      await tx.insert(labReportDeliveries).values({
        id: newId(), reportId, channel: DOCTOR_SCREEN, deliveredBy: actor.id, at: now,
      });
      return true;
    });
    if (won) stamped.push(reportId);
  }
  return stamped;
}
