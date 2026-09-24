import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { hasPermission } from "../../kernel/auth/permissions";
import { imagingReports, imagingStudies, orderItems, orders, services } from "../../kernel/db/schema";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { getPatient, listMergedLoserIds } from "../patients";
import { RadiologyError } from "./errors";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

export type PatientImagingRow = {
  studyName: string;
  /** The radiologist's impression as signed; null when the report was signed without one. */
  impression: string | null;
  /** `red`/`amber` when the report carries a critical finding, else null. */
  criticalCategory: string | null;
  signedAt: string;
};

export const PATIENT_REPORTS_LIMIT = 20;

/**
 * ═══ CONSULT V2 — THE RADIOLOGY HALF OF "SINCE THEN · LAB AND RADIOLOGY" ═══
 *
 * The patient's SIGNED imaging reports across the merge chain, newest first. Only `signed`: one
 * report per study carries it (`imaging_reports_one_signed_ux`), so an amended report reads as its
 * current text and a draft or prelim never reaches the brief.
 *
 * THE RESTRICTED RULE IS THE KERNEL'S, NOT THE DEPARTMENT'S. `read.ts` treats `restricted` as a
 * label because its readers ARE the department performing the scan (F45). The doctor's brief is the
 * other reader — a clinician browsing a patient's investigations — so a PCPNDT-class ultrasound is
 * shown to the clinician who ordered it or a holder of `orders.read.restricted`, and otherwise
 * omitted without a trace (DD11: the existence of the scan is the sensitive fact).
 *
 * Visibility and break-glass through `getPatient`; one PHI row per call. Gated on
 * `radiology.reports.read` at the route, which the doctor role holds.
 */
export async function patientReportsForDoctor(
  db: Db, actor: Actor, patientId: string, now: Date = new Date(),
): Promise<PatientImagingRow[]> {
  if (actor.type !== "user") throw new RadiologyError("user_actor_required", "a patient's reports are read by a person");
  const visible = await getPatient(db, actor, patientId);
  if (visible === null) throw new RadiologyError("unknown_patient", `unknown patient ${patientId}`);
  const canonical = visible.patient.id;
  const chainIds = [canonical, ...(await listMergedLoserIds(db, canonical))];
  const canSeeRestricted = await hasPermission(db, actor.id, "orders.read.restricted", "hospital");

  const rows = await db
    .select({
      studyName: services.name,
      impression: imagingReports.impression,
      criticalCategory: imagingReports.criticalCategory,
      signedAt: imagingReports.signedAt,
      restricted: orderItems.restricted,
      orderingClinicianId: orders.orderingClinicianId,
    })
    .from(imagingReports)
    .innerJoin(imagingStudies, eq(imagingStudies.id, imagingReports.studyId))
    .innerJoin(orderItems, eq(orderItems.id, imagingStudies.orderItemId))
    .innerJoin(orders, eq(orders.id, imagingStudies.orderId))
    .innerJoin(services, eq(services.id, imagingStudies.serviceId))
    .where(and(
      inArray(imagingStudies.patientId, chainIds),
      eq(imagingReports.status, "signed"),
      isNotNull(imagingReports.signedAt),
    ))
    .orderBy(desc(imagingReports.signedAt))
    .limit(PATIENT_REPORTS_LIMIT);

  await recordPhiAccess(db, {
    actor, patientId: canonical, surface: "imaging.patient_reports",
    sealed: visible.patient.isConfidential, reason: visible.breakGlass?.reason ?? null, now,
  });

  return rows
    .filter((r) => !r.restricted || canSeeRestricted || r.orderingClinicianId === actor.id)
    .map((r) => ({
      studyName: r.studyName, impression: r.impression, criticalCategory: r.criticalCategory,
      signedAt: r.signedAt!.toISOString(),
    }));
}
