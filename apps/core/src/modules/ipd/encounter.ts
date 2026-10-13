import { eq } from "drizzle-orm";
import { registerEncounterResolver } from "../../kernel/episodes/encounter-resolvers";
import { ipdAdmissions } from "../../kernel/db/schema";

/**
 * E4.2 (#734) — THE INPATIENT EPISODE FOR THE ORDERING DOOR (decision 0067: "an IPD or Emergency module registers its
 * series letter and calls it"). An admission's number is `IP26-000123` (`mintAdmissionNo`), so IPD claims the prefix
 * `IP` in the kernel's encounter-resolver registry: `placeOrder` resolves a lab or imaging order's episode to the
 * admission's patient, and billing's resolver gets the intended payer. `IP` collides with no episode letter (`V A L S R
 * P D X` and the multi-letter `GRN` / `MPO`; the match is longest-prefix-first and a `P…` dispense number never starts
 * with `IP`).
 *
 * The payer bucket is billing's four (`self`, `tpa`, `corporate`, `pmjay`), from the admission's payer kind.
 */
export const IPD_ADMISSION_PREFIX = "IP";

export function intendedPayerOfAdmission(payerKind: string | null): string {
  switch (payerKind) {
    case "insurance_cashless": case "insurance_reimbursement": return "tpa";
    case "corporate": return "corporate";
    case "pmjay": case "state_scheme": return "pmjay";
    default: return "self";
  }
}

/** Registered by `IpdModule` (API); exported so a suite may register it without booting Nest. */
export function registerIpdEncounterResolver(): () => void {
  return registerEncounterResolver(IPD_ADMISSION_PREFIX, async (db, encounterNo) => {
    const a = (await db.select({ patientId: ipdAdmissions.patientId, payerKind: ipdAdmissions.payerKind })
      .from(ipdAdmissions).where(eq(ipdAdmissions.admissionNo, encounterNo)))[0];
    if (a === undefined) return null;
    return { patientId: a.patientId, intendedPayer: intendedPayerOfAdmission(a.payerKind) };
  });
}
