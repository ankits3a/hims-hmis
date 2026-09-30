import { and, eq } from "drizzle-orm";
import { withTx } from "../../kernel/db/client";
import { appendEvent } from "../../kernel/events/append";
import { pharmacyDispenseLines } from "../../kernel/db/schema";
import { medicinesByIds, ndpsClassByMedicine } from "../formulary";
import { itemsByIds } from "../materials";
import { getDoctor, getVisit, issuePharmacyPaperPrescription, listDoctors, listVisits, runRxChecks } from "../opd";
import { captureDocument, getPatientSummaries, resolvePatientId } from "../patients";
import { claimDispense } from "./claim";
import { REGISTER_FLAGS, SCHEDULED_FLAGS, isIsoDate, istDateOf } from "./config";
import { controlOf } from "./controlled";
import { PharmacyError } from "./errors";
import { paperRxEntered } from "./events";
import { enqueueDispense, getDispense } from "./queue";
import { requirePermission } from "./retail";
import type { Actor } from "@hmis/contracts";
import type { AppConfig } from "../../kernel/config";
import type { Db } from "../../kernel/db/client";
import type { DocumentStore } from "../../kernel/documents/store";
import type { RxCheckOutcome, RxLine } from "../opd";
import type { DispenseView } from "./queue";

/**
 * ═══ 2026-09-30 — DISPENSE FROM A PAPER PRESCRIPTION, AT THE DESK ═══
 *
 * Owner, at the live counter: *"If any registered patient comes to the counter then I am unable find
 * the patient and dispense any medicine … I should be able to find the patient and bill him after
 * looking at the physical prescription even if no other desk has uploaded prescription on behalf of
 * the doctor."* Plan: `docs/superpowers/plans/2026-09-28-pharmacy-gap-closure.md`, "Paper
 * prescription at the desk (2026-09-30)".
 *
 * THE MODEL (a): the paper becomes a REAL `opd_prescriptions` row on the patient's hospital visit,
 * transcribed by the pharmacist (`transcribedBy`), prescriber of record the hospital doctor written
 * on it — so the ticket that follows is an ordinary desk ticket and verify, FEFO pick, bill, labels,
 * the H1 register, returns and the controlled checks read it with no special case. The FD-31 slip
 * cross-confirm applies to it as to any transcription.
 *
 * WHAT THIS DOOR REFUSES, BEFORE ANYTHING IS WRITTEN:
 *   - a Schedule X or NDPS (narcotic/psychotropic) line — the two-key cabinet flow needs the
 *     doctor's own e-prescription (`paper_rx_controlled`);
 *   - a Schedule H/H1 line without the photo of the paper (`prescription_required`), and an H1 line
 *     whose prescriber has no registration number on the doctor master (`invalid_prescription`) —
 *     Rule 65(3) asks for it on the register;
 *   - an allergy, a severe interaction, a hard duplicate or a severe drug-disease hit — the desk would
 *     need the doctor's override, and a paper cannot give one (retail R-7's grammar);
 *   - a patient with no hospital visit on the prescription's date that is still free of an
 *     e-prescription (`paper_rx_no_visit`). An OUTSIDE doctor's prescription is a walk-in sale (P19 R-1).
 */
const PLACE = "pharmacy.dispense.place";

export type PaperRxLineInput = {
  itemId: string;
  qtyBase: number;
  dose?: string | undefined;
  frequency?: string | undefined;
  durationDays?: number | null | undefined;
  instructions?: string | null | undefined;
};

export type PaperRxInput = {
  patientId: string;
  /** The hospital doctor written on the paper; the visit's doctor when absent. */
  doctorId?: string | undefined;
  rxDate: string;
  photo?: { mimeType: string; bytes: Buffer } | undefined;
  lines: PaperRxLineInput[];
};

export type PaperRxContext = {
  patient: { id: string; uhid: string; name: string | null };
  rxDate: string;
  /** The patient's visits on `rxDate`; a paper attaches to one with no e-prescription. */
  visits: { encounterId: string; visitNo: string; doctorId: string | null; doctorName: string | null; hasPrescription: boolean }[];
  doctors: { id: string; displayName: string; registrationNo: string | null }[];
};

type Visit = PaperRxContext["visits"][number];

async function visitsOn(db: Db, actor: Actor, patientId: string, rxDate: string): Promise<Visit[]> {
  const rows = await listVisits(db, { serviceDate: rxDate, patientId });
  const out: Visit[] = [];
  for (const row of rows) {
    const v = await getVisit(db, actor, row.id);
    if (v === null) continue;
    const doctor = row.doctorId === null ? null : await getDoctor(db, row.doctorId);
    out.push({
      encounterId: row.id, visitNo: row.visitNo, doctorId: row.doctorId, doctorName: doctor?.displayName ?? null,
      hasPrescription: v.prescriptions.some((p) => p.status === "active"),
    });
  }
  return out;
}

function checkDate(rxDate: string, now: Date): void {
  if (!isIsoDate(rxDate) || rxDate > istDateOf(now)) {
    throw new PharmacyError("invalid_prescription", "the prescription's date is a real date, not in the future", { rxDate });
  }
}

async function canonicalPatient(db: Db, actor: Actor, patientId: string): Promise<{ id: string; uhid: string; name: string | null }> {
  const id = await resolvePatientId(db, patientId);
  const [summary] = id === null ? [] : await getPatientSummaries(db, actor, [id]);
  if (id === null || summary === undefined) throw new PharmacyError("not_found", `patient ${patientId} not found`);
  return { id, uhid: summary.uhid, name: summary.name };
}

/** What the sheet opens on: the patient's visits that day, and the hospital's doctors. Writes nothing. */
export async function paperRxContext(db: Db, actor: Actor, patientId: string, rxDate: string, now: Date): Promise<PaperRxContext> {
  await requirePermission(db, actor, PLACE, "entering a paper prescription");
  checkDate(rxDate, now);
  const patient = await canonicalPatient(db, actor, patientId);
  const doctors = (await listDoctors(db, { activeOnly: true })).map((d) => ({ id: d.id, displayName: d.displayName, registrationNo: d.registrationNo }));
  return { patient, rxDate, visits: await visitsOn(db, actor, patient.id, rxDate), doctors };
}

/** R-7's grammar: every hard warning refuses, because no prescriber is here to override it. */
function refuseOnChecks(outcome: RxCheckOutcome): void {
  if (outcome.allergyMatches.length > 0) {
    throw new PharmacyError("allergy_block",
      `the patient is recorded allergic to ${outcome.allergyMatches.map((m) => m.substance).join(", ")} — do not give it from a paper prescription; back to the doctor`,
      { hits: outcome.allergyMatches.map((m) => ({ lineIdx: m.lineIndex, substance: m.substance })) });
  }
  const severe = outcome.interactions.filter((h) => h.severity === "severe");
  if (severe.length > 0) {
    throw new PharmacyError("interaction_block", `a severe interaction: ${severe.map((h) => h.note).join("; ")} — back to the doctor`,
      { hits: severe.map((h) => ({ lineIdx: h.lineIndex, note: h.note })) });
  }
  const hard = outcome.duplicates.filter((h) => h.hard);
  if (hard.length > 0) throw new PharmacyError("duplicate_block", "two lines carry the same medicine — remove one", { count: hard.length });
  const disease = outcome.drugDisease.filter((h) => h.severity === "severe");
  if (disease.length > 0) throw new PharmacyError("drug_disease_block", "a diagnosis this patient carries rules a medicine out — back to the doctor", { count: disease.length });
}

const ORAL_FORMS = /tab|cap|syr|susp|drop|sachet|powder|granule|liquid|solution|elixir/i;

export async function enterPaperPrescription(
  db: Db, cfg: AppConfig, documents: DocumentStore, actor: Actor, input: PaperRxInput, now: Date,
): Promise<DispenseView> {
  await requirePermission(db, actor, PLACE, "entering a paper prescription");
  checkDate(input.rxDate, now);
  if (input.lines.length === 0) throw new PharmacyError("invalid_prescription", "a prescription needs at least one medicine");
  const patient = await canonicalPatient(db, actor, input.patientId);

  // ── the medicines, from the stocked items the pharmacist chose ──
  const items = await itemsByIds(db, input.lines.map((l) => l.itemId));
  const medicineIds = input.lines.map((l) => {
    const item = items.get(l.itemId);
    if (item === undefined || item.formularyMedicineId === null) {
      throw new PharmacyError("not_found", `item ${l.itemId} is not a stocked medicine`);
    }
    if (!Number.isSafeInteger(l.qtyBase) || l.qtyBase <= 0) throw new PharmacyError("qty_required", "every line needs a quantity");
    return item.formularyMedicineId;
  });
  const medicines = await medicinesByIds(db, medicineIds);
  const ndps = await ndpsClassByMedicine(db, medicineIds);
  const flags = medicineIds.map((m) => medicines.get(m)?.scheduleFlag ?? null);

  // ── controlled lines never come through a paper at this door ──
  const controlled = medicineIds.map((m, i) => ({ i, c: controlOf(flags[i], ndps.get(m) ?? null) })).filter((x) => x.c.controlled);
  if (controlled.length > 0) {
    const names = controlled.map((x) => medicines.get(medicineIds[x.i]!)?.brandName ?? "a line").join(", ");
    throw new PharmacyError("paper_rx_controlled",
      `${names}: Schedule X and narcotic/psychotropic medicines need the doctor's e-prescription — not a paper prescription`,
      { lineIdxs: controlled.map((x) => x.i) });
  }
  const scheduled = flags.some((f) => f !== null && (SCHEDULED_FLAGS as readonly string[]).includes(f));
  if (scheduled && input.photo === undefined) {
    throw new PharmacyError("prescription_required", "a Schedule H or H1 medicine needs the photo of the paper prescription");
  }

  // ── the visit the paper was written at ──
  const visits = await visitsOn(db, actor, patient.id, input.rxDate);
  const free = visits.filter((v) => !v.hasPrescription);
  const visit = free.find((v) => input.doctorId !== undefined && v.doctorId === input.doctorId) ?? free[free.length - 1];
  if (visit === undefined) {
    throw new PharmacyError("paper_rx_no_visit",
      visits.length === 0
        ? `no hospital visit for this patient on ${input.rxDate} — the front desk opens the visit; an outside doctor's prescription is a walk-in sale`
        : `this patient's visit on ${input.rxDate} already carries the doctor's e-prescription — find it by its QR or token`,
      { rxDate: input.rxDate, visits: visits.length });
  }
  const doctorId = input.doctorId ?? visit.doctorId;
  const doctor = doctorId === null ? null : await getDoctor(db, doctorId);
  if (doctor === null || !doctor.active) throw new PharmacyError("not_found", "choose the hospital doctor written on the prescription");
  const h1 = flags.some((f) => f !== null && (REGISTER_FLAGS as readonly string[]).includes(f));
  if (h1 && (doctor.registrationNo ?? "").trim() === "") {
    throw new PharmacyError("invalid_prescription",
      `a Schedule H1 medicine needs the prescriber's registration number — ${doctor.displayName} has none on the doctor master`);
  }

  // ── the lines as the doctor wrote them ──
  const rxLines: RxLine[] = input.lines.map((l, i) => {
    const m = medicines.get(medicineIds[i]!);
    const drug = m === undefined ? items.get(l.itemId)!.name : [m.brandName, m.strengthLabel].filter((x) => x !== null && x !== "").join(" ");
    const said = (s: string | undefined): string | null => (s === undefined || s.trim() === "" ? null : s.trim());
    return {
      drug, medicineId: medicineIds[i]!,
      dose: said(l.dose) ?? "as directed",
      route: m !== undefined && ORAL_FORMS.test(m.form) ? "oral" : "as directed",
      frequency: said(l.frequency) ?? "as directed",
      durationDays: l.durationDays ?? null,
      instructions: said(l.instructions ?? undefined),
      noSubstitution: false,
    };
  });
  refuseOnChecks(await runRxChecks(db, patient.id, rxLines, now, { excludeEncounterId: visit.encounterId }));

  // ── the photo, on the patient's record ──
  let documentId: string | null = null;
  if (input.photo !== undefined) {
    const photo = input.photo;
    documentId = (await withTx(db, (tx) => captureDocument(tx, documents, actor, patient.id, {
      encounterId: visit.encounterId, kind: "consult_prescription", mimeType: photo.mimeType, bytes: photo.bytes,
      note: `paper prescription entered at the pharmacy: ${doctor.displayName}, ${input.rxDate}`,
    }, now))).documentId;
  }

  // ── the prescription, then the ticket ──
  const issued = await issuePharmacyPaperPrescription(db, actor, cfg, visit.encounterId, { lines: rxLines, doctorId: doctor.id }, now);
  const dispenseId = await withTx(db, async (tx) => {
    const { dispenseId: id } = await enqueueDispense(tx, actor, {
      prescriptionId: issued.prescriptionId, prescriptionVersion: issued.version, patientId: patient.id, encounterId: visit.encounterId, source: "paper",
    }, now);
    await appendEvent(tx, paperRxEntered.make({
      occurredAt: now, actor, patientId: patient.id, encounterId: visit.encounterId, correlationId: id,
      payload: {
        dispenseId: id, prescriptionId: issued.prescriptionId, patientId: patient.id, encounterId: visit.encounterId,
        source: "paper", enteredBy: actor.id, doctorId: doctor.id, prescriberName: doctor.displayName,
        prescriberRegNo: doctor.registrationNo, rxDate: input.rxDate, documentId,
        lines: input.lines.map((l, i) => ({ lineIdx: i, itemId: l.itemId, medicineId: medicineIds[i]!, qtyBase: l.qtyBase, scheduleFlag: flags[i] ?? null })),
      },
    }));
    return id;
  });
  await claimDispense(db, actor, { dispenseId, door: "uhid" }, now);
  // The pharmacist chose the brand on the shelf and counted the quantity off the paper: the ticket carries both.
  await withTx(db, async (tx) => {
    for (const [i, l] of input.lines.entries()) {
      await tx.update(pharmacyDispenseLines).set({ itemId: l.itemId, qtyBase: l.qtyBase })
        .where(and(eq(pharmacyDispenseLines.dispenseId, dispenseId), eq(pharmacyDispenseLines.lineIdx, i), eq(pharmacyDispenseLines.status, "open")));
    }
  });
  return getDispense(db, actor, dispenseId, now);
}
