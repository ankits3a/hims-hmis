import { asc, eq } from "drizzle-orm";
import { patientCoverages } from "../../kernel/db/schema";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { getPatient } from "./registration";
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
    ═══ CLOSE PASS 1, CRITICAL — THROUGH `getPatient`, NOT `resolvePatientId` ═══

    This read `resolvePatientId`, which is documented as "id mapping only — no demographics, no
    gate", and then selected straight from the table. It was the ONLY `patients.read` route in this
    controller that did not resolve through `getPatient`: `:id`, `:id/photo`, `:id/allergies`,
    `:id/guardians` and `:id/qr` all do, and all 404 on null.

    `getPatient` returns null for a §14 confidential patient to any actor without
    `patients.confidential.read` — a permission ZERO roles hold. So the seal was open here, and the
    road was short: `GET /billing/worklist` returns the id and `isConfidential: true` for every
    patient who owes money (deliberately — a sealed patient must still be billable), and a cashier
    holds `patients.read` as of the 2026-09-04 ruling. Read the worklist, take the id, call this
    route, receive the PM-JAY beneficiary id and the employer of a patient whose NAME the same
    actor cannot see.

    The header above argued at length that this data is "a statement about household income" and
    "a profile", and then did not gate it. That is the prose promising what the code did not keep.

    `getPatient` does BOTH jobs — it follows the merge chain and it enforces the seal — so the
    canonical id comes from the row it returns rather than from a second lookup that could disagree
    with it (`recordPhiAccess` documents `patientId` as "the CANONICAL patient id").
  */
  const found = await getPatient(db, actor, patientId);
  /*
    AN EMPTY LIST, NOT A THROW, AND NO AUDIT ROW. A refusal is not a disclosure: writing a
    `patient.coverage` row for a read that returned nothing would put a sealed patient's id in the
    access log every time somebody probed it, turning the audit trail into the enumeration oracle
    the seal exists to prevent. The caller cannot tell "sealed" from "no coverages on file", which
    is the same shape `getPatient` itself uses — null is indistinguishable from not-found.
  */
  if (found === null) return [];
  const resolved = found.patient.id;

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
      /*
        CLOSE PASS 1 — `sealed` DEFAULTS TO FALSE, so a confidential patient's coverages were being
        logged as an ordinary read. The whole point of the flag is that an enquiry can ask "who read
        SEALED records"; without it this surface answered no, for every one of them.
      */
      sealed: found.patient.isConfidential,
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
