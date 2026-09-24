import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { hasPermission } from "../../kernel/auth/permissions";
import { labAnalytes, labOrderables, labResults, orderItems, orders } from "../../kernel/db/schema";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { getPatient, listMergedLoserIds } from "../patients";
import { LabError } from "./errors";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

export type PatientResultRow = {
  orderableName: string;
  analyteName: string;
  value: string;
  unit: string | null;
  /** The bench's flag (`H`, `L`, `HH`, `LL`, `A` …), or null for a value inside its range. */
  flag: string | null;
  verifiedAt: string;
};

/** The brief shows a handful; this bounds the read, not the screen. */
export const PATIENT_RESULTS_LIMIT = 40;

/**
 * ═══ CONSULT V2 — "SINCE THEN · LAB AND RADIOLOGY" (01-CONSULT-ENGINE.md, the brief board) ═══
 *
 * The patient's most recent SIGNED lab values across the whole merge chain, newest first, for the
 * doctor's brief. The screen decides what "since the last visit" means from the date it already
 * holds; this read does not take a date, so the brief can say "none since" and still name the last
 * value on file.
 *
 * WHAT IS HELD BACK, AND BY WHICH RULE:
 *  · **Unverified values** — the same line `listResultsForEncounter` draws: an unsigned number is a
 *    working note, and the brief is read before a prescription is written. `= 'verified'` exactly,
 *    as that reader does (its note on `autoverified` applies here unchanged).
 *  · **Superseded values** — a verified row that a later row supersedes is the lab's working-out.
 *  · **Restricted tests** — the KERNEL's rule, DD11 (`kernel/orders/read.ts` `visibleItems`): shown
 *    to the ordering clinician or a holder of `orders.read.restricted`, and otherwise OMITTED, not
 *    counted — for an HIV test the existence of the test is the sensitive fact. This is a clinician
 *    browsing a patient's investigations, which is the reader DD11 was written for; the lab's own
 *    bench exemption (F45 in radiology) does not apply to it.
 *  · **A patient this reader may not see** — `getPatient`'s visibility, with break-glass. Refused
 *    as an unknown patient, so a sealed chart cannot be probed.
 *
 * Gated on `lab.results.read` at the route, which the doctor role holds. The read is logged as one
 * row per call under its own surface, sealed and break-glass carried through.
 */
export async function patientResultsForDoctor(
  db: Db, actor: Actor, patientId: string, now: Date = new Date(),
): Promise<PatientResultRow[]> {
  if (actor.type !== "user") throw new LabError("user_actor_required", "a patient's results are read by a person");
  const visible = await getPatient(db, actor, patientId);
  if (visible === null) throw new LabError("unknown_patient", `unknown patient ${patientId}`);
  const canonical = visible.patient.id;
  const chainIds = [canonical, ...(await listMergedLoserIds(db, canonical))];
  const canSeeRestricted = await hasPermission(db, actor.id, "orders.read.restricted", "hospital");

  const superseded = sql`exists (select 1 from lab_results s where s.supersedes_result_id = ${labResults.id})`;
  const rows = await db
    .select({
      orderableName: labOrderables.nameEn,
      analyteName: labAnalytes.nameEn,
      result: labResults,
      restricted: orderItems.restricted,
      orderingClinicianId: orders.orderingClinicianId,
    })
    .from(labResults)
    .innerJoin(orderItems, eq(orderItems.id, labResults.orderItemId))
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .innerJoin(labOrderables, eq(labOrderables.serviceId, orderItems.serviceId))
    .innerJoin(labAnalytes, eq(labAnalytes.id, labResults.analyteId))
    .where(and(
      inArray(orders.patientId, chainIds),
      eq(labResults.verificationStatus, "verified"),
      isNotNull(labResults.verifiedAt),
      sql`not ${superseded}`,
    ))
    .orderBy(desc(labResults.verifiedAt))
    .limit(PATIENT_RESULTS_LIMIT);

  await recordPhiAccess(db, {
    actor, patientId: canonical, surface: "lab.patient_results",
    sealed: visible.patient.isConfidential, reason: visible.breakGlass?.reason ?? null, now,
  });

  return rows
    .filter((r) => !r.restricted || canSeeRestricted || r.orderingClinicianId === actor.id)
    .map((r) => ({
      orderableName: r.orderableName,
      analyteName: r.analyteName,
      value: r.result.valueNumeric ?? r.result.valueText ?? r.result.valueCoded ?? "",
      unit: r.result.unit,
      flag: r.result.flag,
      verifiedAt: r.result.verifiedAt!.toISOString(),
    }));
}
