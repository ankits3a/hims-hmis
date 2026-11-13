import { and, eq } from "drizzle-orm";
import { newId, strengthShown } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { pharmacyDispenseLines, pharmacyDispenses } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { medicinesByIds, ndpsClassByMedicine } from "../formulary";
import { itemsByIds, reserveStock } from "../materials";
import { getPrescription, runRxChecks } from "../opd";
import { captureDocument } from "../patients";
import { assertStewardApprovals, prescriberUserOf } from "./antimicrobial";
import { PICK_RESERVATION_MINUTES, REGISTER_FLAGS, SCHEDULED_FLAGS } from "./config";
import { controlOf } from "./controlled";
import { lineAdded } from "./events";
import { PharmacyError } from "./errors";
import { ORAL_FORMS } from "./paper-rx";
import { personName, requireRegisteredPharmacist } from "./pharmacists";
import { fefoParts } from "./pick";
import { getDispense, getDispenseRow, linesOf } from "./queue";
import { authorisedKeysFor } from "./authorisation-reads";
import { refusalsOf, refusalsOn } from "./refusals";
import { getSaleItem } from "./sale-items";
import { quickDeskOn } from "./settings";
import { assertNoRefusals } from "./verify";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { DocumentStore } from "../../kernel/documents/store";
import type { OrderKindDecl } from "../../kernel/orders/kinds";
import type { RxLine } from "../opd";
import type { DispenseView } from "./queue";

/**
 * ═══ SPEC #1055, RULING 0094 — A MEDICINE ADDED TO THE TICKET BY HAND, AT THE COUNTER ═══
 *
 * Owner 2026-11-13: *"allow manual addition of drugs to the list even if the drug is not prescribed by the doctor or
 * doctor has written on paper but is not fed in the system."* Asked which medicines may be added with no prescription,
 * the owner chose ANY SCHEDULE EXCEPT X AND NARCOTICS (0094, a law ruling made knowingly — do not "fix" it).
 *
 * Two reasons, recorded on the line with who and when:
 *   - `not_prescribed` — any schedule except Schedule X and every NDPS class. An H1 line is still written to the H1
 *     register at the hand-over, with "no prescription — added at the counter" where the prescriber goes.
 *   - `paper` — the doctor wrote it on the slip in the patient's hand. The paper-prescription rules hold
 *     (`paper-rx.ts`): a Schedule H/H1 line needs the slip's photo unless quick desk mode is on (0022), and an H1 line
 *     the prescriber's name and registration number (Rule 65(3), the register writes them).
 *
 * The line then runs the books `verifyDispense` runs — allergy, severe interaction, hard duplicate (an added line is the
 * counter's reading, so a duplicate against it is refused), severe drug×disease — by `refusalsOf`, and the steward gate.
 *
 * ═══ THE STATE IT ARRIVES IN ═══
 *
 * Allowed while the ticket is claimed, verified or picked; never after billed (a bill is a document — a return is the
 * only door then). CLAIMED: the line waits for the check like any other and the check gives it an order item. VERIFIED
 * or PICKED: the check has spoken, so this act IS the check for the new line — the books, the steward, the registered
 * pharmacist (unless quick desk) — and the ticket keeps its state: on a picked ticket the line is held FEFO at once
 * (`fefoParts`, `pickDispense`'s own rule) until the ticket's hold ends, and the bill re-totals. The kernel's medication
 * order cannot take an item once placed (`kernel/orders` has no add-item), so a line added after the check has no
 * order item; every step after it (`pick`, `handover`, `refund`, `declineLine`) already reads `orderItemId` as optional.
 */
export type AddLineInput = {
  itemId: string;
  reason: "not_prescribed" | "paper";
  qtyBase: number;
  dose?: string | undefined;
  frequency?: string | undefined;
  durationDays?: number | null | undefined;
  instructions?: string | null | undefined;
  /** `paper` — the slip's photo, required for Schedule H/H1 unless quick desk mode is on. */
  photo?: { mimeType: string; bytes: Buffer } | undefined;
  /** `paper` — the prescriber as written on the slip; name and registration number required for H1. */
  prescriber?: { name?: string | null | undefined; registrationNo?: string | null | undefined } | undefined;
};

const ADDABLE = new Set(["claimed", "verified", "picked"]);
const said = (s: string | null | undefined): string | null => (s === undefined || s === null || s.trim() === "" ? null : s.trim());

export async function addDispenseLine(
  db: Db, documents: DocumentStore, actor: Actor, decls: readonly OrderKindDecl[], dispenseId: string, input: AddLineInput, now: Date,
): Promise<DispenseView> {
  void decls; // the act places no order item (see above); the parameter keeps the dispense acts' one shape.
  if (actor.type !== "user") throw new PharmacyError("permission_denied", "a medicine is added to a ticket by a person at the counter");
  const d = await getDispenseRow(db, dispenseId);
  if (!ADDABLE.has(d.status)) {
    throw new PharmacyError("dispense_not_in_state", d.status === "billed" || d.status === "handed_over"
      ? `dispense ${d.id} is ${d.status} — after the bill a medicine is a new ticket, not a line on this one`
      : `dispense ${d.id} is ${d.status}`, { status: d.status });
  }
  if (d.claimedBy !== null && d.claimedBy !== actor.id) {
    throw new PharmacyError("dispense_not_in_state", `dispense ${d.id} is held by another pharmacist — take it over first`, {
      status: d.status, claimedByName: await personName(db, d.claimedBy),
    });
  }
  if (d.storeResourceId === null) throw new PharmacyError("store_missing", "the claim named no store");
  if (!Number.isSafeInteger(input.qtyBase) || input.qtyBase <= 0) throw new PharmacyError("qty_required", "a medicine added to the ticket needs a quantity");

  // ── the medicine, from the stocked item chosen off the shelf ──
  const item = (await itemsByIds(db, [input.itemId])).get(input.itemId);
  if (item === undefined || item.formularyMedicineId === null) throw new PharmacyError("not_found", `item ${input.itemId} is not a stocked medicine`);
  const sale = await getSaleItem(db, item.id);
  if (sale === undefined || !sale.active) throw new PharmacyError("unknown_sale_item", `${item.name} is not on sale at this counter`);
  const medicineId = item.formularyMedicineId;
  const medicine = (await medicinesByIds(db, [medicineId])).get(medicineId);
  if (medicine === undefined) throw new PharmacyError("not_found", `item ${input.itemId} is not a stocked medicine`);
  const scheduleFlag = medicine.scheduleFlag ?? null;
  const ndpsClass = (await ndpsClassByMedicine(db, [medicineId])).get(medicineId) ?? null;

  // ── the law first: never Schedule X or a narcotic/psychotropic, for either reason (0094) ──
  if (controlOf(scheduleFlag, ndpsClass).controlled) {
    throw new PharmacyError("paper_rx_controlled",
      `${medicine.brandName}: Schedule X and narcotic/psychotropic medicines are never added by hand — they need the doctor's e-prescription`,
      { itemId: item.id, scheduleFlag, ndpsClass });
  }
  const scheduled = scheduleFlag !== null && (SCHEDULED_FLAGS as readonly string[]).includes(scheduleFlag);
  const h1 = scheduleFlag !== null && (REGISTER_FLAGS as readonly string[]).includes(scheduleFlag);
  const paper = input.reason === "paper";
  const prescriberName = paper ? said(input.prescriber?.name) : null;
  const prescriberRegNo = paper ? said(input.prescriber?.registrationNo) : null;
  if (paper && scheduled && input.photo === undefined && !(await quickDeskOn(db))) {
    throw new PharmacyError("prescription_required", "a Schedule H or H1 medicine written on paper needs the photo of the slip");
  }
  if (paper && h1 && (prescriberName === null || prescriberRegNo === null)) {
    throw new PharmacyError("invalid_prescription",
      "a Schedule H1 medicine written on paper needs the prescriber's name and registration number, as written on it",
      { missing: [...(prescriberName === null ? ["name"] : []), ...(prescriberRegNo === null ? ["registrationNo"] : [])] });
  }

  // ── the books, on the ticket as it would stand with this line ──
  const rx = await getPrescription(db, actor, d.prescriptionId);
  if (rx === null) {
    throw new PharmacyError("permission_denied", "this ticket is a sealed record — its checks are read by a pharmacist who may read it", { reason: "patient_restricted" });
  }
  const lines = await linesOf(db, d.id);
  /* Past every line on the ticket AND every line of the prescription, so no prescriber's override can name it. */
  const lineIdx = Math.max(-1, ...lines.map((l) => l.lineIdx), (rx.lines as RxLine[]).length - 1) + 1;
  const rxLine: RxLine = {
    drug: [medicine.brandName, strengthShown(medicine.strengthLabel)].filter((x) => x !== null && x !== "").join(" "),
    medicineId,
    dose: said(input.dose) ?? "as directed",
    route: ORAL_FORMS.test(medicine.form) ? "oral" : "as directed",
    frequency: said(input.frequency) ?? "as directed",
    durationDays: input.durationDays ?? null,
    instructions: said(input.instructions),
    noSubstitution: false,
  };
  const open = lines.filter((l) => l.status === "open");
  const others = await medicinesByIds(db, open.map((l) => l.dispensedMedicineId).filter((x): x is string => x !== null));
  const checkLines: RxLine[] = [
    ...open.map((l) => {
      const was = l.rxLine as RxLine;
      return l.dispensedMedicineId === null ? was : { ...was, medicineId: l.dispensedMedicineId, drug: others.get(l.dispensedMedicineId)?.brandName ?? was.drug };
    }),
    { ...rxLine, drug: medicine.brandName },
  ];
  const idxOf = [...open.map((l) => l.lineIdx), lineIdx];
  const outcome = await runRxChecks(db, d.patientId, checkLines, now, { excludeEncounterId: d.encounterId });
  const readHere = new Set([...open.filter((l) => l.addedReason !== null || l.substitutionType === "resolved").map((l) => l.lineIdx), lineIdx]);
  assertNoRefusals(refusalsOn(refusalsOf(outcome, (i) => idxOf[i]!, rx, readHere, await authorisedKeysFor(db, d.id)), lineIdx));

  const checked = d.status !== "claimed";
  if (checked) {
    // After the check this act is the check for the new line: the steward's grant, and the Act's registered pharmacist.
    await assertStewardApprovals(db, { id: d.id, patientId: d.patientId }, await prescriberUserOf(db, rx.doctorId), [{ lineIdx, drug: medicine.brandName, medicine }]);
    if (!(await quickDeskOn(db))) await requireRegisteredPharmacist(db, actor, now);
  }
  /* A collected ticket holds the new line's stock at once, FEFO, until the ticket's own hold ends. */
  const parts = d.status === "picked" ? await fefoParts(db, d.storeResourceId, lineIdx, item.id, input.qtyBase, d.storeResourceId, now) : [];
  const holdEnds = d.pickedAt === null || d.pickedAt.getTime() + PICK_RESERVATION_MINUTES * 60_000 <= now.getTime()
    ? new Date(now.getTime() + PICK_RESERVATION_MINUTES * 60_000)
    : new Date(d.pickedAt.getTime() + PICK_RESERVATION_MINUTES * 60_000);
  const addedByName = (await personName(db, actor.id)) ?? actor.id;

  await withTx(db, async (tx) => {
    /* The dispense row first (a no-op compare-and-set on its state): a bill or a check landing now either goes first
       (this is refused) or sees the line. */
    const held = await tx.update(pharmacyDispenses).set({ status: d.status, ...(scheduled ? { scheduled: true } : {}) })
      .where(and(eq(pharmacyDispenses.id, d.id), eq(pharmacyDispenses.status, d.status)))
      .returning({ id: pharmacyDispenses.id });
    if (held.length === 0) throw new PharmacyError("dispense_not_in_state", `dispense ${d.id} moved while a medicine was being added`);
    let documentId: string | null = null;
    if (paper && input.photo !== undefined) {
      documentId = (await captureDocument(tx, documents, actor, d.patientId, {
        encounterId: d.encounterId, kind: "consult_prescription", mimeType: input.photo.mimeType, bytes: input.photo.bytes,
        note: `paper prescription seen at the pharmacy counter: ${medicine.brandName}${prescriberName === null ? "" : `, ${prescriberName}`}`,
      }, now)).documentId;
    }
    const lineId = newId();
    const row = {
      id: lineId, dispenseId: d.id, lineIdx, rxLine, orderedMedicineId: medicineId, dispensedMedicineId: medicineId,
      itemId: item.id, qtyBase: input.qtyBase, scheduleFlag, ndpsClass,
      addedReason: input.reason, addedBy: actor.id, addedAt: now, addedDocumentId: documentId,
      addedPrescriberName: prescriberName, addedPrescriberRegNo: prescriberRegNo,
    };
    await tx.insert(pharmacyDispenseLines).values(row);
    let nextIdx = lineIdx + 1;
    for (const [k, part] of parts.entries()) {
      const id = k === 0 ? lineId : newId();
      if (k > 0) {
        /* A further batch is the same added line, split FEFO as the pick splits (`pickDispense`). */
        await tx.insert(pharmacyDispenseLines).values({ ...row, id, lineIdx: nextIdx++, splitFromLineIdx: lineIdx });
      }
      const { reservationId } = await reserveStock(tx, actor, { resourceId: part.store, batchId: part.batchId, qty: part.qty, refType: "pharmacy_dispense", refId: id, expiresAt: holdEnds });
      await tx.update(pharmacyDispenseLines).set({ batchId: part.batchId, reservationId, qtyBase: part.qty }).where(eq(pharmacyDispenseLines.id, id));
    }
    await appendEvent(tx, lineAdded.make({
      occurredAt: now, actor, patientId: d.patientId, encounterId: d.encounterId, correlationId: d.id,
      payload: {
        dispenseId: d.id, lineIdx, patientId: d.patientId, reason: input.reason, medicineId, itemId: item.id, qtyBase: input.qtyBase,
        scheduleFlag, addedBy: actor.id, addedByName, dispenseStatus: d.status as "claimed" | "verified" | "picked",
        documentId, prescriberName, prescriberRegNo, reserved: parts.length > 0,
      },
    }));
  });
  return getDispense(db, actor, d.id, now);
}
