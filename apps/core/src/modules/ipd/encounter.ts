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
/**
 * Review of 72f10b68: the resolver answers ONLY the admission-number grammar (`mintAdmissionNo`: `IP` + 2-digit year + `-` +
 * 6-digit serial). Any other `IP…` string resolves to nothing (the door refuses `unknown_encounter`), so the prefix can never
 * swallow a future episode series. The episode grammar (`<PREFIX><YYMMDD><4 digits>`) has no `I` series, and its readers
 * that take "the leading letters" as the prefix (lab interlock) read `IP` from this grammar too (tested).
 */
export const IPD_ADMISSION_NO_RE = /^IP\d{2}-\d{6}$/;

export function intendedPayerOfAdmission(payerKind: string | null): string {
  switch (payerKind) {
    // Review of 72f10b68 (DECIDED): reimbursement — the patient pays and claims later — is `self`; cashless is `tpa`.
    case "insurance_cashless": return "tpa";
    case "corporate": return "corporate";
    case "pmjay": case "state_scheme": return "pmjay";
    default: return "self";
  }
}

/** Registered by `IpdModule` (API); exported so a suite may register it without booting Nest. */
export function registerIpdEncounterResolver(): () => void {
  return registerEncounterResolver(IPD_ADMISSION_PREFIX, async (db, encounterNo) => {
    if (!IPD_ADMISSION_NO_RE.test(encounterNo)) return null;
    const a = (await db.select({ patientId: ipdAdmissions.patientId, payerKind: ipdAdmissions.payerKind })
      .from(ipdAdmissions).where(eq(ipdAdmissions.admissionNo, encounterNo)))[0];
    if (a === undefined) return null;
    return { patientId: a.patientId, intendedPayer: intendedPayerOfAdmission(a.payerKind) };
  });
}
