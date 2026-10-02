import { and, eq } from "drizzle-orm";
import { withTx } from "../../kernel/db/client";
import { appendEvent } from "../../kernel/events/append";
import { pharmacyDispenseLines } from "../../kernel/db/schema";
import { medicinesByIds, ndpsClassByMedicine } from "../formulary";
import { itemsByIds } from "../materials";
import {
  PHARMACY_VISIT_TYPE, getDoctor, getVisit, issuePharmacyPaperPrescription, listDepartments, listDoctors, listVisits, openPharmacyVisitInTx, runRxChecks,
} from "../opd";
import { captureDocument, getPatientSummaries, resolvePatientId } from "../patients";
import { claimDispense } from "./claim";
import { REGISTER_FLAGS, SCHEDULED_FLAGS, isIsoDate, istDateOf } from "./config";
import { controlOf } from "./controlled";
import { PharmacyError } from "./errors";
import { paperRxEntered, paperRxVisitOpened } from "./events";
import { enqueueDispense, getDispense } from "./queue";
import { requirePermission } from "./retail";
import { quickDeskOn } from "./settings";
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
 *
 * ═══ 2026-09-30 (owner) — PAPER PRESCRIPTION FOR ANYONE ═══
 *
 * *"let the patient buy medicine on physical prescription too, even if there's no record of prescribed
 * medicine in the system by the doctor, emergency, IPD but just using physical prescription."*
 *   - NO VISIT that day (or only visits that already carry a prescription): the desk opens a NO-FEE
 *     pharmacy visit itself (`openPharmacyVisitInTx`: `type = 'pharmacy'`, no doctor, no department,
 *     no queue, no token, no fee, on no OPD list or report), audited `paper_rx.visit_opened`. It is
 *     opened only AFTER every refusal below has been asked, so a refused paper leaves nothing behind.
 *   - an OUTSIDE doctor: the prescription row carries `outside_prescriber_*` with `doctor_id` null;
 *     name always, registration number AND address when any line is Schedule H/H1 (Rule 65(3) — the
 *     H1 register writes all three). An outside paper never lands on a hospital doctor's OPD visit.
 *   - NOBODY FOUND: the desk registers the person through `POST /patients` (`patients.register`,
 *     which the pharmacy role holds for P19) and opens this sheet on the new record.
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
  /** 2026-09-30 — an OUTSIDE doctor wrote the paper: name always; registration number and address for H/H1. */
  outside?: { name: string; registrationNo?: string | null | undefined; address?: string | null | undefined } | undefined;
  rxDate: string;
  photo?: { mimeType: string; bytes: Buffer } | undefined;
  lines: PaperRxLineInput[];
};

export type PaperRxContext = {
  patient: { id: string; uhid: string; name: string | null };
  rxDate: string;
  /** The patient's visits on `rxDate`; a paper attaches to one with no e-prescription. */
  /** `pharmacy`: the desk's own no-fee visit (2026-09-30), not a consultation. */
  visits: { encounterId: string; visitNo: string; doctorId: string | null; doctorName: string | null; hasPrescription: boolean; pharmacy: boolean }[];
  /** `departmentName`: the unit the doctor sits in — the sheet filters its doctor list by it (owner 2026-10-02). */
  doctors: { id: string; displayName: string; registrationNo: string | null; departmentId: string | null; departmentName: string | null }[];
};

type Visit = PaperRxContext["visits"][number];

async function visitsOn(db: Db, actor: Actor, patientId: string, rxDate: string): Promise<Visit[]> {
  const rows = await listVisits(db, { serviceDate: rxDate, patientId, type: "any" });
  const out: Visit[] = [];
  for (const row of rows) {
    const v = await getVisit(db, actor, row.id);
    if (v === null) continue;
    const doctor = row.doctorId === null ? null : await getDoctor(db, row.doctorId);
    out.push({
      encounterId: row.id, visitNo: row.visitNo, doctorId: row.doctorId, doctorName: doctor?.displayName ?? null,
      pharmacy: row.type === PHARMACY_VISIT_TYPE,
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
  const unit = new Map((await listDepartments(db)).map((d) => [d.id, d.name] as const));
  const doctors = (await listDoctors(db, { activeOnly: true })).map((d) => ({
    id: d.id, displayName: d.displayName, registrationNo: d.registrationNo,
    departmentId: d.departmentId ?? null, departmentName: d.departmentId == null ? null : unit.get(d.departmentId) ?? null,
  }));
  return { patient, rxDate, visits: await visitsOn(db, actor, patient.id, rxDate), doctors };
}

type Prescriber =
  | { kind: "hospital"; id: string; name: string; regNo: string | null }
  | { kind: "outside"; name: string; regNo: string | null; address: string | null };

const trimmed = (s: string | null | undefined): string | null => (s === undefined || s === null || s.trim() === "" ? null : s.trim());

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
  // Owner ruling 2026-10-02 — quick desk mode (`settings.ts`): the photo is not asked for.
  if (scheduled && input.photo === undefined && !(await quickDeskOn(db))) {
    throw new PharmacyError("prescription_required", "a Schedule H or H1 medicine needs the photo of the paper prescription");
  }

  // ── who wrote it: a hospital doctor, or an outside one ──
  const h1 = flags.some((f) => f !== null && (REGISTER_FLAGS as readonly string[]).includes(f));
  const outside = input.outside;
  if (outside !== undefined && input.doctorId !== undefined) {
    throw new PharmacyError("invalid_prescription", "a paper names a hospital doctor OR an outside doctor, not both");
  }
  let prescriber: Prescriber | null = null;
  if (outside !== undefined) {
    const name = trimmed(outside.name);
    if (name === null) throw new PharmacyError("invalid_prescription", "write the outside doctor's name as it is on the paper");
    const regNo = trimmed(outside.registrationNo);
    const address = trimmed(outside.address);
    if (scheduled && (regNo === null || address === null)) {
      throw new PharmacyError("invalid_prescription",
        "a Schedule H or H1 medicine on an outside doctor's paper needs the doctor's registration number and address, as written on it",
        { missing: [...(regNo === null ? ["registrationNo"] : []), ...(address === null ? ["address"] : [])] });
    }
    prescriber = { kind: "outside", name, regNo, address };
  }

  // ── the visit the paper was written at ──
  const visits = await visitsOn(db, actor, patient.id, input.rxDate);
  // An outside paper never lands on a hospital doctor's OPD visit: only a free pharmacy visit takes it.
  const free = visits.filter((v) => !v.hasPrescription && (outside === undefined || v.pharmacy));
  const visit: Visit | undefined = free.find((v) => input.doctorId !== undefined && v.doctorId === input.doctorId)
    ?? free.filter((v) => !v.pharmacy).at(-1) ?? free.at(-1);
  if (prescriber === null) {
    const doctorId = input.doctorId ?? visit?.doctorId ?? null;
    const doctor = doctorId === null ? null : await getDoctor(db, doctorId);
    if (doctor === null || !doctor.active) throw new PharmacyError("not_found", "choose the hospital doctor written on the prescription — or enter an outside doctor");
    if (h1 && (doctor.registrationNo ?? "").trim() === "") {
      throw new PharmacyError("invalid_prescription",
        `a Schedule H1 medicine needs the prescriber's registration number — ${doctor.displayName} has none on the doctor master`);
    }
    prescriber = { kind: "hospital", id: doctor.id, name: doctor.displayName, regNo: doctor.registrationNo };
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
  refuseOnChecks(await runRxChecks(db, patient.id, rxLines, now, visit === undefined ? {} : { excludeEncounterId: visit.encounterId }));

  // ── no free visit that day: the desk opens a NO-FEE pharmacy visit, after every refusal has been asked ──
  const encounterId = visit?.encounterId ?? await withTx(db, async (tx) => {
    const opened = await openPharmacyVisitInTx(tx, actor, { patientId: patient.id, serviceDate: input.rxDate }, now);
    await appendEvent(tx, paperRxVisitOpened.make({
      occurredAt: now, actor, patientId: patient.id, encounterId: opened.id, correlationId: opened.id,
      payload: { encounterId: opened.id, visitNo: opened.visitNo, patientId: patient.id, rxDate: input.rxDate, openedBy: actor.id },
    }));
    return opened.id;
  });
  const who = prescriber.kind === "hospital" ? prescriber.name : `${prescriber.name} (outside)`;

  // ── the photo, on the patient's record ──
  let documentId: string | null = null;
  if (input.photo !== undefined) {
    const photo = input.photo;
    documentId = (await withTx(db, (tx) => captureDocument(tx, documents, actor, patient.id, {
      encounterId: encounterId, kind: "consult_prescription", mimeType: photo.mimeType, bytes: photo.bytes,
      note: `paper prescription entered at the pharmacy: ${who}, ${input.rxDate}`,
    }, now))).documentId;
  }

  // ── the prescription, then the ticket ──
  const issued = await issuePharmacyPaperPrescription(db, actor, cfg, encounterId, prescriber.kind === "hospital"
    ? { lines: rxLines, doctorId: prescriber.id }
    : { lines: rxLines, outsidePrescriber: { name: prescriber.name, registrationNo: prescriber.regNo, address: prescriber.address } }, now);
  const dispenseId = await withTx(db, async (tx) => {
    const { dispenseId: id } = await enqueueDispense(tx, actor, {
      prescriptionId: issued.prescriptionId, prescriptionVersion: issued.version, patientId: patient.id, encounterId: encounterId, source: "paper",
    }, now);
    await appendEvent(tx, paperRxEntered.make({
      occurredAt: now, actor, patientId: patient.id, encounterId: encounterId, correlationId: id,
      payload: {
        dispenseId: id, prescriptionId: issued.prescriptionId, patientId: patient.id, encounterId: encounterId,
        source: "paper", enteredBy: actor.id, doctorId: prescriber.kind === "hospital" ? prescriber.id : null,
        outside: prescriber.kind === "outside", prescriberName: prescriber.name, prescriberRegNo: prescriber.regNo,
        prescriberAddress: prescriber.kind === "outside" ? prescriber.address : null, rxDate: input.rxDate, documentId,
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
