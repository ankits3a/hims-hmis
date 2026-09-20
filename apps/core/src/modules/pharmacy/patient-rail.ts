import { and, eq } from "drizzle-orm";
import { opdPrescriptions } from "../../kernel/db/schema";
import { isCurrentDose, patientTimeline } from "../opd";
import { patientBalance } from "../billing";
import { recogniseForActor } from "../membership";
import { getPatient } from "../patients";
import { istDateOf } from "./config";
import { PharmacyError } from "./errors";
import { getDispenseRow } from "./queue";
import type { RxLine } from "../opd";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ WHO IS AT THE WINDOW — the approved Desk board's left rail ═══
 *
 * The board's rail is not a name and a number: it carries the patient's age and sex, their last
 * visits (when, which department, which doctor), and WHAT THEY ARE ALREADY TAKING. A pharmacist
 * handing over a fifth medicine needs to see the other four; the shipped rail showed a name, a UHID
 * and one allergy pill.
 *
 * ITS OWN ENDPOINT, NOT THE TICKET'S. `getDispense` is polled every fifteen seconds, and
 * `patientTimeline` writes a PHI-access row on every successful read — the audit trail would have
 * filled with one row per poll. This is read once when the ticket is opened.
 *
 * NOT SHOWN, deliberately, against the board: the masked phone (`98•••••210`). The hand-over asks
 * the person collecting for the last four digits, and a screen that prints them answers its own
 * check. Flagged to the owner rather than decided quietly.
 */
export type RailVisit = {
  encounterId: string; serviceDate: string; departmentName: string | null; doctorName: string | null;
  status: string; prescriptionLineCount: number;
};
export type RailMedicine = { drug: string; sig: string; since: string };
/** A card the patient holds, as the counter may honour it. SHOWN, never applied: C7 says the desk asks. */
export type RailBenefit = { planTitle: string; cardCode: string; usable: boolean; validTo: string };
export type PatientRail = {
  ageYears: number | null;
  sex: string | null;
  visits: RailVisit[];
  /** Live lines from the patient's OTHER active prescriptions — what they are on, beside this ticket. */
  alreadyTaking: RailMedicine[];
  /** The board's "benefits & links": what they hold. The bill still asks the pharmacist to apply it. */
  benefits: RailBenefit[];
  /** The board's "on their account": what the hospital is owed, and what it holds for them. */
  account: { outstandingPaise: number; advancePaise: number };
};

const VISITS = 3;
const TAKING = 6;

function sigOf(line: RxLine): string {
  const days = line.durationDays === null || line.durationDays === undefined ? "" : ` × ${String(line.durationDays)}d`;
  return `${line.frequency}${days}`;
}

export async function patientRail(db: Db, actor: Actor, dispenseId: string, now: Date = new Date()): Promise<PatientRail> {
  const d = await getDispenseRow(db, dispenseId);
  /* `patientTimeline` existence-hides a sealed patient and records the read; the refusal it throws is
     the same "not found" an absent id produces, so this cannot confirm anybody exists. */
  const seen = await getPatient(db, actor, d.patientId);
  if (seen === null) throw new PharmacyError("unknown_dispense", `dispense ${dispenseId} not found`);
  const timeline = await patientTimeline(db, actor, d.patientId, VISITS + 5);

  const rows = await db
    .select({ encounterId: opdPrescriptions.encounterId, issuedAt: opdPrescriptions.issuedAt, lines: opdPrescriptions.lines })
    .from(opdPrescriptions)
    .where(and(eq(opdPrescriptions.patientId, d.patientId), eq(opdPrescriptions.status, "active")));

  const taking: RailMedicine[] = [];
  const seenDrug = new Set<string>();
  for (const row of rows.filter((r) => r.encounterId !== d.encounterId).sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime())) {
    for (const line of row.lines as RxLine[]) {
      /* The same rule the doctor's duplicate check uses: a course that has run out is not current. */
      if (!isCurrentDose(line.durationDays ?? null, row.issuedAt, now).current) continue;
      const key = line.drug.trim().toLowerCase();
      if (key === "" || seenDrug.has(key)) continue;
      seenDrug.add(key);
      taking.push({ drug: line.drug, sig: sigOf(line), since: istDateOf(row.issuedAt) });
      if (taking.length >= TAKING) break;
    }
    if (taking.length >= TAKING) break;
  }

  const dob = seen.patient.dob;
  const [recognised, balance] = await Promise.all([
    recogniseForActor(db, actor, { patientId: d.patientId, at: now }),
    patientBalance(db, actor, d.patientId),
  ]);

  return {
    benefits: recognised.memberships.map((m) => ({
      planTitle: m.planTitle, cardCode: m.cardCode, usable: m.usable, validTo: istDateOf(m.validTo),
    })),
    account: { outstandingPaise: balance.outstandingPaise, advancePaise: balance.advancePaise },
    ageYears: dob === null ? null : Math.max(0, Math.floor((now.getTime() - dob.getTime()) / (365.2425 * 24 * 60 * 60_000))),
    sex: seen.patient.sex,
    visits: timeline
      .filter((v) => v.encounterId !== d.encounterId)
      .slice(0, VISITS)
      .map((v) => ({
        encounterId: v.encounterId, serviceDate: v.serviceDate, departmentName: v.departmentName,
        doctorName: v.doctorName, status: v.status, prescriptionLineCount: v.prescriptionLineCount,
      })),
    alreadyTaking: taking,
  };
}
