import { and, asc, gte, inArray, lt } from "drizzle-orm";
import { hasPermission } from "../../kernel/auth/permissions";
import { istDayWindow } from "../../kernel/approvals/cumulative";
import { patients, pharmacyRegH1 } from "../../kernel/db/schema";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { displayName, resolvePatientId } from "../patients";
import { isIsoDate } from "./config";
import { PharmacyError } from "./errors";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PHARMACY P9 — THE SCHEDULE H1 REGISTER, READ ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-16-phase-pharmacy-p9-h1-register.md`. Drugs and
 * Cosmetics Rules 1945 r.65(3A) requires a separate register of every Schedule H1 supply, with the
 * prescriber, the patient, the drug and the quantity, kept for three years and produced to an
 * inspector. `handOverDispense` has written `pharmacy_reg_h1` since 16c and nothing read it: the
 * go-live runbook's answer to an inspector was `psql`.
 *
 *   - **A period of at most 31 IST days**, inclusive. A register is reviewed and printed a month at
 *     a time, and a bounded read cannot become an export of three years.
 *   - **Oldest first**, in the order the entries were written (`seq`), as a paper register reads.
 *   - **A sealed patient stays sealed.** The row stores the name as it stood at hand-over, but a
 *     reader without `pharmacy.register.read_sealed` (P17) or `patients.confidential.read` sees the
 *     alias and no address, and the row says it is `restricted`: the `aerb.dose_register` rule.
 *     Printing an inspector's unredacted copy is a named grant: the pharmacist in charge, the
 *     medical superintendent and the owner (P17), and every such read is logged as sealed.
 *   - **Every patient shown is one `phi_access_log` row** (surface `pharmacy.h1_register`, sealed
 *     where the patient is), filed under the surviving id if the patient was merged.
 */
export type H1RegisterRow = {
  entryNo: number;
  dispensedAt: string;
  patientId: string;
  patientName: string;
  patientAddress: string | null;
  restricted: boolean;
  prescriberName: string;
  prescriberRegNo: string | null;
  drugName: string;
  batchNo: string;
  qtyBase: number;
  unit: string;
  pharmacistRegNo: string | null;
};

export type H1Register = { period: { from: string; to: string }; rows: H1RegisterRow[] };

export const H1_REGISTER_MAX_DAYS = 31;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function h1Register(db: Db, actor: Actor, period: { from: string; to: string }): Promise<H1Register> {
  if (actor.type !== "user" || !(await hasPermission(db, actor.id, "pharmacy.register.read", "hospital"))) {
    throw new PharmacyError("permission_denied", "reading the H1 register needs pharmacy.register.read");
  }
  const { from, to } = period;
  if (!isIsoDate(from) || !isIsoDate(to)) {
    throw new PharmacyError("invalid_range", `the period must be two dates (YYYY-MM-DD), not "${from}" to "${to}"`);
  }
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS + 1;
  if (days < 1 || days > H1_REGISTER_MAX_DAYS) {
    throw new PharmacyError("invalid_range", `the period runs from ${from} to ${to}: it must run forwards and cover at most ${String(H1_REGISTER_MAX_DAYS)} days`, { days });
  }
  const { start } = istDayWindow(new Date(`${from}T12:00:00+05:30`));
  const { end } = istDayWindow(new Date(`${to}T12:00:00+05:30`));

  const rows = await db.select().from(pharmacyRegH1)
    .where(and(gte(pharmacyRegH1.dispensedAt, start), lt(pharmacyRegH1.dispensedAt, end)))
    .orderBy(asc(pharmacyRegH1.seq));
  const ids = [...new Set(rows.map((r) => r.patientId))];
  const people = ids.length === 0 ? [] : await db.select({ id: patients.id, name: patients.name, alias: patients.alias, isConfidential: patients.isConfidential })
    .from(patients).where(inArray(patients.id, ids));
  const person = new Map(people.map((p) => [p.id, p] as const));
  // P17 — the statutory copy: the register's own sealed-read grant, or the hospital-wide one.
  const canSeeConfidential = await hasPermission(db, actor.id, "pharmacy.register.read_sealed", "hospital")
    || await hasPermission(db, actor.id, "patients.confidential.read", "hospital");

  const out = rows.map((r): H1RegisterRow => {
    const p = person.get(r.patientId);
    const withheld = p !== undefined && p.isConfidential && !canSeeConfidential;
    return {
      entryNo: r.seq,
      dispensedAt: r.dispensedAt.toISOString(),
      patientId: r.patientId,
      patientName: withheld ? displayName({ name: r.patientName, alias: p.alias, isConfidential: true }, false) : r.patientName,
      patientAddress: withheld ? null : r.patientAddress,
      restricted: withheld,
      prescriberName: r.prescriberName,
      prescriberRegNo: r.prescriberRegNo,
      drugName: r.drugName,
      batchNo: r.batchNo,
      qtyBase: r.qtyBase,
      unit: r.unit,
      pharmacistRegNo: r.pharmacistRegNo,
    };
  });

  const reason = `Schedule H1 register ${from} to ${to}, ${String(out.length)} entries`;
  for (const id of ids) {
    await recordPhiAccess(db, {
      actor, patientId: (await resolvePatientId(db, id)) ?? id, surface: "pharmacy.h1_register", reason,
      sealed: person.get(id)?.isConfidential ?? false,
    });
  }
  return { period: { from, to }, rows: out };
}
