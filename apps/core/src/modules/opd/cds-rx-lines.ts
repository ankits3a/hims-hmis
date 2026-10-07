import { and, asc, desc, eq, isNotNull } from "drizzle-orm";
import { bandOf, dxKeyOf, frequencyOf, fromSuggestion, parseDose } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import { cdsRxLines, opdEncounterDiagnoses, opdEncounters, opdPrescriptions, opdVitals, patients } from "../../kernel/db/schema";
import { medicinesByIds, saltsByIds } from "../formulary";
import { recognisedComplaintConcepts } from "./complaints";
import type { RxLine } from "./fhir";
import { ageYearsAt } from "./time";

/**
 * ═══ THE COUNTABLE COPY OF AN ISSUED PRESCRIPTION (decision 0050, phase P0) ═══
 *
 * Owner, 2026-10-07: "start the groundwork (P0) now. implement self-improving system plan."
 *
 * Learning counts what a doctor ISSUED, not what was tapped. The issued document keeps the doctor's
 * words exactly ("1 Tab", "1-0-1 after food"); this module writes, in the SAME transaction, one row
 * per line in the shape arithmetic needs: the closed frequency, the dose as an amount and a unit,
 * the diagnosis as a key, the adult/child band, where the line came from and whether a safety
 * override stood against it. The document is never rewritten and no reader of a prescription reads
 * this table.
 *
 *   - One prescription stands per visit, so a re-issue REPLACES the visit's rows (a superseded
 *     version must not be counted twice).
 *   - A prescription with no hospital doctor (the pharmacy's outside-prescriber road) writes nothing.
 *   - A scribe's transcription is the doctor's line (`transcribed`), source `paper`.
 *   - There is an encounter id here and no patient id.
 */

type Override = { lineIndex?: number | null };
export type CdsRxWrite = {
  prescriptionId: string;
  encounterId: string;
  doctorId: string | null;
  lines: readonly RxLine[];
  overrides: readonly Override[];
  transcribed: boolean;
  issuedAt: Date;
};

const drugKeyOf = (drug: string): string => drug.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 200);

export async function writeCdsRxLines(tx: Db | Tx, w: CdsRxWrite): Promise<number> {
  await tx.delete(cdsRxLines).where(eq(cdsRxLines.encounterId, w.encounterId));
  if (w.doctorId === null || w.lines.length === 0) return 0;

  const [enc] = await tx.select({
    departmentId: opdEncounters.departmentId, serviceDate: opdEncounters.serviceDate, patientId: opdEncounters.patientId,
    chiefComplaint: opdEncounters.chiefComplaint, deskComplaint: opdEncounters.deskComplaint,
    diagnosis: opdEncounters.diagnosis, icd10Code: opdEncounters.icd10Code,
  }).from(opdEncounters).where(eq(opdEncounters.id, w.encounterId));
  if (enc === undefined) return 0;

  /* The primary diagnosis is `seq` 0 of the committed rows; the encounter's own columns stand in for a visit that has none. */
  const [primary] = await tx.select({ text: opdEncounterDiagnoses.text, icd10Code: opdEncounterDiagnoses.icd10Code })
    .from(opdEncounterDiagnoses).where(eq(opdEncounterDiagnoses.encounterId, w.encounterId)).orderBy(asc(opdEncounterDiagnoses.seq)).limit(1);
  const dxKey = primary !== undefined ? dxKeyOf(primary.icd10Code, primary.text) : dxKeyOf(enc.icd10Code, enc.diagnosis);

  const complaint = (enc.chiefComplaint ?? "").trim() !== "" ? enc.chiefComplaint! : (enc.deskComplaint ?? "");
  const concepts = complaint.trim() === "" ? [] : [...new Set((await recognisedComplaintConcepts(tx as Db, complaint)).map((c) => c.conceptKey))].sort();

  const [weight] = await tx.select({ weightKg: opdVitals.weightKg }).from(opdVitals)
    .where(and(eq(opdVitals.encounterId, w.encounterId), isNotNull(opdVitals.weightKg))).orderBy(desc(opdVitals.recordedAt)).limit(1);
  const [person] = await tx.select({ dob: patients.dob }).from(patients).where(eq(patients.id, enc.patientId));
  const ageYears = person?.dob == null ? null : ageYearsAt(new Date(person.dob), w.issuedAt);
  /* `bandOf` is `cds/regimen.ts` `bandFor` restated in the shared file; a test holds the two together. */
  const band = bandOf({ ageYears, weightKg: weight?.weightKg ?? null });

  /* The catalogue is the formulary module's: asked through its bounded reads, never queried here. */
  const ids = [...new Set(w.lines.map((l) => l.medicineId ?? null).filter((x): x is string => x !== null))];
  const medById = await medicinesByIds(tx, ids);
  const saltById = await saltsByIds(tx, [...new Set([...medById.values()].flatMap((m) => m.salts.map((x) => x.saltId)))]);
  const overridden = new Set(w.overrides.map((o) => o.lineIndex).filter((i): i is number => typeof i === "number"));

  const rows = w.lines.map((l, lineIndex) => {
    const med = l.medicineId == null ? undefined : medById.get(l.medicineId);
    const mine = med === undefined ? [] : med.salts.map((x) => x.saltId);
    const dose = parseDose(l.dose);
    const source = w.transcribed ? "paper" : (l.source ?? null);
    return {
      prescriptionId: w.prescriptionId, lineIndex, encounterId: w.encounterId, doctorId: w.doctorId!, departmentId: enc.departmentId,
      serviceDate: enc.serviceDate, issuedAt: w.issuedAt, dxKey, complaintConcepts: concepts, band,
      medicineId: med === undefined ? null : med.id, drugKey: drugKeyOf(l.drug),
      moietySet: mine.length === 0 ? null : [...new Set(mine)].sort().join("+"),
      doseRaw: l.dose.trim(), doseAmount: dose?.amount ?? null, doseUnit: dose?.unit ?? null,
      frequencyRaw: l.frequency.trim(), frequency: frequencyOf(l.frequency), durationDays: l.durationDays, route: l.route.trim(),
      source, fromSuggestion: fromSuggestion(source), hadOverride: overridden.has(lineIndex), transcribed: w.transcribed,
      awareCategory: med?.awareCategory ?? null, scheduleFlag: med?.scheduleFlag ?? null, antimicrobialRestricted: med?.antimicrobialRestricted ?? false,
      ndps: mine.some((id) => (saltById.get(id)?.ndpsClass ?? null) !== null),
    };
  });
  await tx.insert(cdsRxLines).values(rows);
  return rows.length;
}

export type BackfillReport = { prescriptions: number; lines: number; doseParsed: number; doseUnparsed: number; frequencyOther: number; unparsedDoses: { dose: string; times: number }[] };

/**
 * THE BACKFILL. Every visit's STANDING prescription that has a hospital doctor is (re)written into
 * `cds_rx_lines` from the stored lines. Idempotent: a second run rewrites the same rows and reports
 * the same numbers. The report is what phase P0 asks for — how much of the history did not parse.
 */
export async function backfillCdsRxLines(db: Db): Promise<BackfillReport> {
  const rxs = await db.select({
    id: opdPrescriptions.id, encounterId: opdPrescriptions.encounterId, doctorId: opdPrescriptions.doctorId, lines: opdPrescriptions.lines,
    issuedAt: opdPrescriptions.issuedAt, transcribedBy: opdPrescriptions.transcribedBy,
    a: opdPrescriptions.allergyOverrides, i: opdPrescriptions.interactionOverrides, d: opdPrescriptions.duplicateOverrides, dd: opdPrescriptions.drugDiseaseOverrides,
  }).from(opdPrescriptions).where(and(eq(opdPrescriptions.status, "active"), isNotNull(opdPrescriptions.doctorId))).orderBy(asc(opdPrescriptions.issuedAt));

  const report: BackfillReport = { prescriptions: 0, lines: 0, doseParsed: 0, doseUnparsed: 0, frequencyOther: 0, unparsedDoses: [] };
  const unparsed = new Map<string, number>();
  for (const rx of rxs) {
    const lines = (rx.lines ?? []) as RxLine[];
    const overrides = [rx.a, rx.i, rx.d, rx.dd].flatMap((x) => (Array.isArray(x) ? (x as Override[]) : []));
    const n = await writeCdsRxLines(db, {
      prescriptionId: rx.id, encounterId: rx.encounterId, doctorId: rx.doctorId, lines, overrides,
      transcribed: rx.transcribedBy !== null, issuedAt: rx.issuedAt,
    });
    if (n === 0) continue;
    report.prescriptions += 1;
    report.lines += n;
    for (const l of lines) {
      if (parseDose(l.dose) === null) {
        report.doseUnparsed += 1;
        const k = l.dose.trim().toLowerCase().slice(0, 60);
        unparsed.set(k, (unparsed.get(k) ?? 0) + 1);
      } else report.doseParsed += 1;
      if (frequencyOf(l.frequency) === "other") report.frequencyOther += 1;
    }
  }
  report.unparsedDoses = [...unparsed.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, 25).map(([dose, times]) => ({ dose, times }));
  return report;
}
