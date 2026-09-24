import { and, asc, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { pharmacyDispenseLines, pharmacyDispenses } from "../../kernel/db/schema";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { getPatient, listMergedLoserIds } from "../patients";
import { PharmacyError } from "./errors";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

export type PatientDispenseLine = { drug: string; durationDays: number | null; qtyBase: number | null };
export type PatientDispense = {
  prescriptionId: string;
  handedOverAt: string;
  lines: PatientDispenseLine[];
};

export const PATIENT_DISPENSES_LIMIT = 10;

/**
 * ═══ CONSULT V2 — THE REFILL RECORD ON THE BRIEF ("Pharmacy: 30 days bought on 12 Aug · none since") ═══
 *
 * What this hospital's pharmacy HANDED OVER to the patient against a prescription, newest first,
 * across the merge chain. Handed over is the only state that means the patient left with the
 * medicine: a billed-but-uncollected dispense bought nothing, and a cancelled one never happened.
 * Declined lines are dropped — the pharmacist refused them, so they were not bought.
 *
 * Each line carries the prescribed `durationDays` from the Rx line the dispense was made against,
 * so the screen can say how many days the purchase covered and when it runs out. Walk-in retail
 * sales are not here: they carry no prescription and no patient link to hang a refill on.
 *
 * Gated on `opd.consult` at the route (the doctor holds no pharmacy permission, the stock read's
 * precedent). Visibility and break-glass through `getPatient`; one PHI row per call.
 */
export async function patientDispensesForDoctor(
  db: Db, actor: Actor, patientId: string, now: Date = new Date(),
): Promise<PatientDispense[]> {
  const visible = await getPatient(db, actor, patientId);
  if (visible === null) throw new PharmacyError("not_found", `unknown patient ${patientId}`);
  const canonical = visible.patient.id;
  const chainIds = [canonical, ...(await listMergedLoserIds(db, canonical))];

  const heads = await db
    .select({ id: pharmacyDispenses.id, prescriptionId: pharmacyDispenses.prescriptionId, handedOverAt: pharmacyDispenses.handedOverAt })
    .from(pharmacyDispenses)
    .where(and(
      inArray(pharmacyDispenses.patientId, chainIds),
      eq(pharmacyDispenses.status, "handed_over"),
      isNotNull(pharmacyDispenses.handedOverAt),
    ))
    .orderBy(desc(pharmacyDispenses.handedOverAt))
    .limit(PATIENT_DISPENSES_LIMIT);

  await recordPhiAccess(db, {
    actor, patientId: canonical, surface: "pharmacy.patient_dispenses",
    sealed: visible.patient.isConfidential, reason: visible.breakGlass?.reason ?? null, now,
  });
  if (heads.length === 0) return [];

  const lines = await db
    .select({ dispenseId: pharmacyDispenseLines.dispenseId, rxLine: pharmacyDispenseLines.rxLine, qtyBase: pharmacyDispenseLines.qtyBase })
    .from(pharmacyDispenseLines)
    .where(and(inArray(pharmacyDispenseLines.dispenseId, heads.map((h) => h.id)), ne(pharmacyDispenseLines.status, "declined")))
    .orderBy(asc(pharmacyDispenseLines.lineIdx));
  const byDispense = new Map<string, PatientDispenseLine[]>();
  for (const l of lines) {
    const rx = l.rxLine as { drug?: unknown; durationDays?: unknown };
    const list = byDispense.get(l.dispenseId) ?? [];
    list.push({
      drug: typeof rx.drug === "string" ? rx.drug : "",
      durationDays: typeof rx.durationDays === "number" ? rx.durationDays : null,
      qtyBase: l.qtyBase,
    });
    byDispense.set(l.dispenseId, list);
  }
  return heads.map((h) => ({
    prescriptionId: h.prescriptionId, handedOverAt: h.handedOverAt!.toISOString(), lines: byDispense.get(h.id) ?? [],
  }));
}
