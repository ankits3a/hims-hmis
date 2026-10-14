import { admissionForTransport } from "../ipd";
import type { Db, Tx } from "../../kernel/db/client";

export type TransportRisk = { highRisk: boolean; why: "critical_care_bed" | null };

/**
 * THE SEAM the nursing lane fills. Spec §6: "critical patients (score high, on infusions, ICU) need a nurse or doctor
 * escort". DECIDED until nursing early-warning scores (NEWS2 / MEOWS / PEWS) and infusion records exist: a patient in
 * an ICU, HDU, NICU or PICU bed is high-risk here; the requester's own flag is the other half (recorded on the
 * request). The nursing lane adds "latest score in the high band" and "infusion running" to this function — every
 * caller (the request and the start check) picks it up with no other change.
 */
export async function isHighRiskForTransport(exec: Db | Tx, admissionId: string): Promise<TransportRisk> {
  const facts = await admissionForTransport(exec, admissionId);
  if (facts === null) return { highRisk: false, why: null };
  if (facts.criticalCareBed) return { highRisk: true, why: "critical_care_bed" };
  return { highRisk: false, why: null };
}
