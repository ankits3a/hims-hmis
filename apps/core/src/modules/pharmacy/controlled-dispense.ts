import { withTx } from "../../kernel/db/client";
import { invoiceHeadsByIds } from "../billing";
import { captureDocument, getPatient, listDocuments } from "../patients";
import { controlledLicenceStates, controlOf, isEndPrescriber, LICENCE_NAMES, requireCustodian, requirePerson, verifyWitness } from "./controlled";
import { getDispenseRow } from "./queue";
import { istDateOf } from "./config";
import { PharmacyError } from "./errors";
import { prefillQtyBase } from "./qty";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { DocumentStore } from "../../kernel/documents/store";
import type { Custody } from "../materials";
import type { RxLine } from "../opd";
import type { ControlledLicenceKind, WitnessInput } from "./controlled";

/**
 * ═══ PHARMACY P6 — HANDING OVER A CONTROLLED LINE (brief 2026-09-26, §3 item 4) ═══
 *
 * What the law asks of the prescription (NDPS Rules r.52G; D&C Rules r.65(9)–(11)) and of the hand-over,
 * in ONE place, read two ways:
 *
 *   - `controlledChecklist` — the desk's agent card: each thing the law asks, ok or not, BEFORE the
 *     pharmacist asks for the witness. It never refuses; it is what the counter agent "flags".
 *   - `prepareControlledHandover` — the hand-over itself asks the same things and refuses the first that
 *     fails, then proves the witness (username + PIN) and returns the particulars each line's register
 *     row copies (`Custody`).
 *
 * The checks: the licence the line's class needs is current; the prescription carries the prescriber's
 * registration number, the patient's address and a quantity the counter can compute (dose × frequency ×
 * days) that the line does not exceed; a narcotic line's prescriber is on the r.2(ib) list; the pharmacy
 * keeps a copy of the prescription (Schedule X: the duplicate, r.65(9)(a)); a Schedule X prescription is
 * endorsed with the seller's name, address and date (r.65(11)(c)); who took the drug and the identity they
 * showed is written down; and a second person witnesses the hand-over.
 */
export type ControlledLineFacts = {
  lineIdx: number; drug: string; scheduleFlag: string | null; ndpsClass: string | null; qtyBase: number | null; rxLine: RxLine; status: string;
};

export type ControlledCheck = {
  key: "licence_schedule_x" | "licence_ndps_rmi" | "prescriber_reg_no" | "trained_prescriber" | "patient_address" | "quantity"
    | "retained_prescription" | "endorsement" | "collected_by" | "witness";
  ok: boolean;
  /** Display-ready particulars (a licence number and its end, a line and its quantities, a doctor's name). */
  detail: string;
  /** Asked at the hand-over itself (the pharmacist supplies it there), rather than read from the record. */
  atHandover: boolean;
};

export type ControlledChecklist = {
  lines: { lineIdx: number; drug: string; scheduleX: boolean; ndpsClass: string | null; prescribedQty: number | null; qtyBase: number | null }[];
  checks: ControlledCheck[];
  /** The record-side checks that fail now: these stop the hand-over whatever the pharmacist supplies. */
  blocking: ControlledCheck["key"][];
};

type Prescriber = { id: string; displayName: string; registrationNo: string | null } | null;

export async function controlledChecklist(
  db: Db, input: { lines: readonly ControlledLineFacts[]; prescriber: Prescriber; patientAddress: string | null }, now: Date,
): Promise<ControlledChecklist | null> {
  const lines = input.lines.filter((l) => l.status === "open" && controlOf(l.scheduleFlag, l.ndpsClass).controlled);
  if (lines.length === 0) return null;
  const controls = lines.map((l) => controlOf(l.scheduleFlag, l.ndpsClass));
  const anyX = controls.some((c) => c.scheduleX);
  const anyNarcotic = controls.some((c) => c.ndpsClass === "narcotic");
  const states = await controlledLicenceStates(db, now);
  const checks: ControlledCheck[] = [];
  const licence = (kind: ControlledLicenceKind, key: ControlledCheck["key"]): void => {
    const s = states[kind];
    checks.push({
      key, ok: s.state === "current", atHandover: false,
      detail: s.licence === null ? `no ${LICENCE_NAMES[kind]} on file` : `${s.licence.form} ${s.licence.licenceNo} · valid until ${s.licence.validUntil}`,
    });
  };
  if (anyX) licence("schedule_x", "licence_schedule_x");
  if (anyNarcotic) licence("ndps_rmi", "licence_ndps_rmi");
  const regNo = input.prescriber?.registrationNo?.trim() ?? "";
  checks.push({ key: "prescriber_reg_no", ok: regNo !== "", atHandover: false, detail: `${input.prescriber?.displayName ?? "the prescriber"}${regNo === "" ? " — no registration number on the doctor's record" : ` · ${regNo}`}` });
  if (anyNarcotic) {
    const trained = input.prescriber !== null && (await isEndPrescriber(db, input.prescriber.id));
    checks.push({ key: "trained_prescriber", ok: trained, atHandover: false, detail: input.prescriber?.displayName ?? "the prescriber" });
  }
  const address = input.patientAddress?.trim() ?? "";
  checks.push({ key: "patient_address", ok: address !== "", atHandover: false, detail: address === "" ? "no address on the patient's record" : address });
  const lineFacts = lines.map((l, i) => {
    const prescribed = prefillQtyBase(l.rxLine);
    const ok = prescribed !== null && l.qtyBase !== null && l.qtyBase <= prescribed;
    checks.push({
      key: "quantity", ok, atHandover: false,
      detail: `line ${String(l.lineIdx + 1)} ${l.drug}: ${l.qtyBase === null ? "—" : String(l.qtyBase)} of ${prescribed === null ? "no stated quantity" : String(prescribed)} prescribed`,
    });
    return { lineIdx: l.lineIdx, drug: l.drug, scheduleX: controls[i]!.scheduleX, ndpsClass: controls[i]!.ndpsClass, prescribedQty: prescribed, qtyBase: l.qtyBase };
  });
  checks.push({ key: "retained_prescription", ok: false, atHandover: true, detail: anyX ? "the duplicate, kept two years (r.65(9)(a))" : "a copy kept with the register" });
  if (anyX) checks.push({ key: "endorsement", ok: false, atHandover: true, detail: "the seller's name, address and date written on the prescription (r.65(11)(c))" });
  checks.push({ key: "collected_by", ok: false, atHandover: true, detail: "the patient or attendant, the relation, and the identity shown" });
  checks.push({ key: "witness", ok: false, atHandover: true, detail: "a second person with pharmacy.ndps.witness, by username and PIN" });
  return { lines: lineFacts, checks, blocking: checks.filter((c) => !c.atHandover && !c.ok).map((c) => c.key) };
}

export type ControlledHandoverInput = {
  witness: WitnessInput;
  collectedBy: { name: string; relation: string; idProof: string };
  /** A `patient_documents` row of this patient: the pharmacy's copy of the prescription. */
  retainedDocumentId: string;
  /** Schedule X: the pharmacist endorsed the prescription (r.65(11)(c)). */
  endorsed?: boolean;
};

const REFUSAL: Record<ControlledCheck["key"], "schedule_x_not_dispensed_here" | "ndps_not_dispensed_here" | "controlled_prescription_incomplete" | "end_prescriber_not_trained" | "controlled_qty_exceeds_prescribed" | "retained_prescription_required" | "endorsement_required" | "collected_by_required" | "witness_not_confirmed"> = {
  licence_schedule_x: "schedule_x_not_dispensed_here",
  licence_ndps_rmi: "ndps_not_dispensed_here",
  prescriber_reg_no: "controlled_prescription_incomplete",
  trained_prescriber: "end_prescriber_not_trained",
  patient_address: "controlled_prescription_incomplete",
  quantity: "controlled_qty_exceeds_prescribed",
  retained_prescription: "retained_prescription_required",
  endorsement: "endorsement_required",
  collected_by: "collected_by_required",
  witness: "witness_not_confirmed",
};

const SENTENCE: Record<ControlledCheck["key"], string> = {
  licence_schedule_x: "Schedule X is dispensed only under a current Form 20F licence (D&C Rules r.61(3))",
  licence_ndps_rmi: "a narcotic drug is dispensed only by a Recognised Medical Institution (NDPS Rules r.52-O)",
  prescriber_reg_no: "the prescription must carry the prescriber's registration number (NDPS Rules r.52G, D&C Rules r.65(10)) — add it to the doctor's record",
  trained_prescriber: "only a doctor trained in pain relief and palliative care or opioid substitution therapy prescribes a narcotic drug here (NDPS Rules r.2(ib)) — the pharmacist in charge records the training",
  patient_address: "the prescription must carry the patient's address (NDPS Rules r.52G, D&C Rules r.65(10)) — record it on the patient",
  quantity: "a controlled drug is given only up to the quantity the prescription states (dose × frequency × days) — ask the prescriber to state it",
  retained_prescription: "the pharmacy keeps a copy of the prescription (Schedule X: the duplicate, D&C Rules r.65(9)(a)) — capture it",
  endorsement: "write the seller's name, address and today's date on the Schedule X prescription (D&C Rules r.65(11)(c)) and confirm it",
  collected_by: "record who takes the drug — the patient or an attendant, the relation, and the identity document shown",
  witness: "a second person witnesses the hand-over with their username and PIN",
};

/**
 * The hand-over's own asking: the record-side checks, then what the pharmacist supplies, then the witness.
 * Returns the particulars every controlled line's register row copies, keyed by line index.
 */
export async function prepareControlledHandover(
  db: Db, actor: Actor,
  ctx: {
    lines: readonly ControlledLineFacts[]; prescriber: Prescriber; patientId: string; patientName: string; patientAddress: string | null;
    dispenseNo: string; invoiceId: string; prescriptionId: string; prescriptionVersion: number; pharmacistRegNo: string | null;
  },
  input: ControlledHandoverInput | undefined, now: Date,
): Promise<{ custody: Map<number, Custody>; witnessId: string } | null> {
  const list = await controlledChecklist(db, { lines: ctx.lines, prescriber: ctx.prescriber, patientAddress: ctx.patientAddress }, now);
  if (list === null) return null;
  await requireCustodian(db, actor, "handing over a narcotic, psychotropic or Schedule X drug");
  const failed = list.checks.find((c) => !c.atHandover && !c.ok);
  if (failed !== undefined) {
    throw new PharmacyError(REFUSAL[failed.key], `${SENTENCE[failed.key]} — ${failed.detail}`, { check: failed.key });
  }
  const anyX = list.lines.some((l) => l.scheduleX);
  if (input === undefined || input.retainedDocumentId.trim() === "") {
    throw new PharmacyError("retained_prescription_required", SENTENCE.retained_prescription, { check: "retained_prescription" });
  }
  const kept = await listDocuments(db, actor, ctx.patientId);
  if (!kept.some((doc) => doc.id === input.retainedDocumentId)) {
    throw new PharmacyError("retained_prescription_required", `${SENTENCE.retained_prescription} — document ${input.retainedDocumentId} is not on this patient's record`, { check: "retained_prescription" });
  }
  if (anyX && input.endorsed !== true) throw new PharmacyError("endorsement_required", SENTENCE.endorsement, { check: "endorsement" });
  const collected = { name: input.collectedBy.name.trim(), relation: input.collectedBy.relation.trim(), idProof: input.collectedBy.idProof.trim() };
  if (collected.name === "" || collected.relation === "" || collected.idProof === "") {
    throw new PharmacyError("collected_by_required", SENTENCE.collected_by, { check: "collected_by" });
  }
  const witness = await verifyWitness(db, actor, input.witness, now);
  const [invoice] = await invoiceHeadsByIds(db, [ctx.invoiceId]);
  const custody = new Map<number, Custody>();
  for (const l of list.lines) {
    custody.set(l.lineIdx, {
      witnessId: witness.userId,
      holderRegNo: ctx.pharmacistRegNo,
      counterparty: ctx.patientName,
      counterpartyAddress: ctx.patientAddress,
      documentRef: invoice?.invoiceNo ?? ctx.dispenseNo,
      documentDate: invoice?.serviceDay ?? istDateOf(now),
      rxRef: `${ctx.dispenseNo} · Rx ${ctx.prescriptionId} v${String(ctx.prescriptionVersion)}`,
      patientId: ctx.patientId,
      prescriberName: ctx.prescriber?.displayName ?? null,
      prescriberRegNo: ctx.prescriber?.registrationNo ?? null,
      retainedDocumentId: input.retainedDocumentId,
      collectedBy: `${collected.name} (${collected.relation})`,
      collectedIdProof: collected.idProof,
      note: l.scheduleX && input.endorsed === true ? "prescription endorsed by the seller (r.65(11)(c))" : null,
    });
  }
  return { custody, witnessId: witness.userId };
}

/**
 * The pharmacy's copy of a controlled prescription, filed on the patient's record against this visit (a
 * `consult_prescription` document, through the patients module's one writer). For Schedule X it is the
 * duplicate the licensee keeps two years (D&C Rules r.65(9)(a)); for a narcotic drug it is the copy the
 * register refers to. Its id is what the hand-over names.
 */
export async function captureRetainedPrescription(
  db: Db, documents: DocumentStore, actor: Actor, dispenseId: string, photo: { mimeType: string; bytes: Buffer }, now: Date,
): Promise<{ documentId: string }> {
  requirePerson(actor, "keeping the prescription");
  const d = await getDispenseRow(db, dispenseId);
  if (d.status === "handed_over" || d.status === "cancelled") {
    throw new PharmacyError("dispense_not_in_state", `dispense ${d.id} is ${d.status}`, { status: d.status });
  }
  if ((await getPatient(db, actor, d.patientId)) === null) throw new PharmacyError("unknown_dispense", `dispense ${dispenseId} not found`);
  return withTx(db, (tx) => captureDocument(tx, documents, actor, d.patientId, {
    encounterId: d.encounterId, kind: "consult_prescription", mimeType: photo.mimeType, bytes: photo.bytes,
    note: `retained by the pharmacy — ${d.dispenseNo ?? d.id} (controlled drug)`,
  }, now));
}
