import { asc, eq } from "drizzle-orm";
import { patientCoverages } from "../../kernel/db/schema";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { resolvePatientId } from "./registration";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-25 — READING BACK WHAT REGISTRATION HAS BEEN WRITING SINCE FD-12
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `patient_coverages` HAS BEEN WRITE-ONLY. `registration.ts` inserts a row for every entitlement a
 * patient produces at the desk — PM-JAY, a retail policy, a TPA, an employer scheme — in the same
 * transaction as the patient. `grep -rn "patientCoverages" apps/core/src` returned the schema, that
 * insert, and one test. Nothing read it back. Ever.
 *
 * So a clerk asked a patient for their policy number, typed it in, and the product could not show
 * it to anybody afterwards. That is the server-built-never-wired class this lane's memory records
 * three times over, and it is the one that costs most: the data collection has already happened, at
 * a counter, from a person, and the only thing missing is the twenty lines that hand it back.
 *
 * It surfaced because the billing artboard draws "East Central Railway · employee 41129" on its
 * Corporate/TPA card, and the build spec concluded the data did not exist. It does — `payerName`
 * and `employeeId`, field for field, written at registration.
 *
 * ═══ WHY THIS IS A PHI READ AND IS LOGGED AS ONE ═══
 *
 * A coverage row is not clinical, and the temptation is to treat it as billing metadata. It is not:
 * it says who this person's employer is, which government scheme they qualify for, and what their
 * insurer thinks they are worth. `pmjay` on a record is a statement about household income;
 * `corporate` names where somebody works. Disclosed together with a name, that is a profile.
 *
 * `patient.coverage` rather than a reuse of `patient.detail`, for the reason every other surface
 * here is its own name: "a clerk opened the record" and "the counter read this person's payer
 * arrangements" are different disclosures with different reasons, and the reason is the only thing
 * the log is ever asked about.
 */
export type CoverageRow = {
  id: string;
  kind: string;
  payerName: string | null;
  tpaName: string | null;
  policyNumber: string | null;
  cardNumber: string | null;
  beneficiaryId: string | null;
  employeeId: string | null;
  planClass: string | null;
  sumInsuredPaise: number | null;
  validFrom: string | null;
  validTo: string | null;
  verificationStatus: string;
};

const isoDate = (d: Date | null): string | null => (d === null ? null : d.toISOString().slice(0, 10));

export async function listPatientCoverages(
  db: Db,
  actor: Actor,
  patientId: string,
  opts: { reason?: string } = {},
): Promise<CoverageRow[]> {
  /*
    THROUGH THE MERGE CHAIN, like every other patient read in this module. A coverage recorded
    against a record that was later merged away is still this person's entitlement — and a cashier
    who was told "the panel is on file" and shown nothing would go and re-collect it from a patient
    who has already given it once.
  */
  const resolved = (await resolvePatientId(db, patientId)) ?? patientId;

  const rows = await db
    .select()
    .from(patientCoverages)
    .where(eq(patientCoverages.patientId, resolved))
    .orderBy(asc(patientCoverages.createdAt));

  if (rows.length > 0) {
    await recordPhiAccess(db, {
      actor,
      patientId: resolved,
      surface: "patient.coverage",
      reason: opts.reason ?? `read ${String(rows.length)} coverage record(s)`,
    });
  }

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    payerName: r.payerName,
    tpaName: r.tpaName,
    policyNumber: r.policyNumber,
    cardNumber: r.cardNumber,
    beneficiaryId: r.beneficiaryId,
    employeeId: r.employeeId,
    planClass: r.planClass,
    sumInsuredPaise: r.sumInsuredPaise,
    validFrom: isoDate(r.validFrom),
    validTo: isoDate(r.validTo),
    verificationStatus: r.verificationStatus,
  }));
}
