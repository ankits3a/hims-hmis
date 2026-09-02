import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import { appendEvent } from "../../kernel/events/append";
import { pharmacyDispenseLines, pharmacyDispenses, pharmacyRegH1 } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { advanceOrderItem } from "../../kernel/orders/advance";
import { transition } from "../../kernel/workflow/instances";
import { listMedicines } from "../formulary";
import { consumeReservation, effectiveRegulation, getBatch, itemUomRows, itemsByIds, materialConsumed } from "../materials";
import { getDoctor, getPrescription, getVisit } from "../opd";
import { getPatient } from "../patients";
import { REGISTER_FLAGS, SCHEDULED_FLAGS } from "./config";
import { dispenseHandedOver } from "./events";
import { PharmacyError } from "./errors";
import { priceForBatch } from "./price";
import { getDispense, getDispenseRow, linesOf } from "./queue";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { OrderKindDecl } from "../../kernel/orders/kinds";
import type { RxLine } from "../opd";
import type { DispenseView } from "./queue";

export type HandoverInput = {
  /** D7 — for a scheduled dispense: how the person at the window was confirmed. */
  identity?: { via: "token" | "phone_last4"; value: string };
};

/**
 * PLAN 16c T4 — HAND OVER: the drug leaves, and four things are true in one transaction.
 *
 *   1. D7 / the Pharmacy Act — a dispense carrying a Schedule H/H1 line completes only under
 *      `pharmacy.dispense.scheduled`, checked HERE against the database and not only at the route,
 *      and only after a second identity confirmation (today's token or the phone's last four).
 *   2. D2 — every line's reservation is CONSUMED: the ledger writes the `consume` row with the
 *      patient and encounter on it and debits the balance under its lock; the pharmacy copies the
 *      ledger id onto the line and emits `material.consumed` with the batch's price facts (S1
 *      answered: `consumeReservation` posts the movement and emits nothing; the OT's consumer skips
 *      our `caseRef.type`).
 *   3. The order items go to `completed` (DD4), which closes the envelope.
 *   4. R-4 — one `pharmacy_reg_h1` row per H1 line, Rule 65(3)'s fields COPIED at write time.
 */
export async function handOverDispense(
  db: Db,
  actor: Actor,
  decls: readonly OrderKindDecl[],
  dispenseId: string,
  input: HandoverInput,
  now: Date,
): Promise<DispenseView> {
  const d = await getDispenseRow(db, dispenseId);
  if (d.status !== "billed") throw new PharmacyError("dispense_not_in_state", `dispense ${d.id} is ${d.status}, not billed`, { status: d.status });
  const lines = (await linesOf(db, dispenseId)).filter((l) => l.status === "open");
  if (lines.length === 0) throw new PharmacyError("nothing_to_dispense", "no open line to hand over");
  const scheduled = d.scheduled || lines.some((l) => l.scheduleFlag !== null && (SCHEDULED_FLAGS as readonly string[]).includes(l.scheduleFlag));

  const visible = await getPatient(db, actor, d.patientId);
  if (visible === null) throw new PharmacyError("unknown_dispense", `dispense ${dispenseId} not found`);
  const patient = visible.patient;

  let identityConfirmedVia: "token" | "phone_last4" | null = null;
  if (scheduled) {
    if (actor.type !== "user" || !(await hasPermission(db, actor.id, "pharmacy.dispense.scheduled", "hospital"))) {
      throw new PharmacyError("scheduled_needs_pharmacist", "a Schedule H/H1 dispense is completed by a registered pharmacist (Pharmacy Act 1948 §42) — call one to the window");
    }
    if (input.identity === undefined || input.identity.value.trim() === "") {
      throw new PharmacyError("identity_confirmation_required", "confirm the person at the window: today's token, or the last four digits of the phone on the record");
    }
    const value = input.identity.value.trim();
    if (input.identity.via === "phone_last4") {
      const phone = (patient.phone ?? "").replace(/\D/g, "");
      if (value.length !== 4 || !phone.endsWith(value)) throw new PharmacyError("identity_mismatch", "those four digits do not end the phone on the record");
    } else {
      const visit = await getVisit(db, actor, d.encounterId);
      const token = visit?.queueEntries.at(-1)?.tokenNo ?? null;
      if (token === null || String(token) !== value.replace(/^t-?/i, "")) throw new PharmacyError("identity_mismatch", "that is not today's token for this visit");
    }
    identityConfirmedVia = input.identity.via;
  }

  const rx = await getPrescription(db, actor, d.prescriptionId);
  if (rx === null) throw new PharmacyError("unknown_prescription", `prescription ${d.prescriptionId} not found`);
  const doctor = await getDoctor(db, rx.doctorId);
  const medicines = new Map((await listMedicines(db)).map((m) => [m.id, m]));
  const items = await itemsByIds(db, lines.map((l) => l.itemId).filter((x): x is string => x !== null));

  const ledgerEntryIds: string[] = [];
  let h1Rows = 0;
  await withTx(db, async (tx) => {
    for (const line of lines) {
      if (line.reservationId === null || line.batchId === null || line.itemId === null || line.qtyBase === null) {
        throw new PharmacyError("dispense_not_in_state", `line ${String(line.lineIdx + 1)} holds no reservation`, { lineIdx: line.lineIdx });
      }
      const batch = await getBatch(tx, line.batchId);
      if (batch === undefined) throw new PharmacyError("batch_not_saleable", `batch ${line.batchId} not found`);
      const { ledgerEntryId } = await consumeReservation(tx, actor, line.reservationId, {
        reason: "consume", refType: "pharmacy_dispense", refId: d.id, patientId: d.patientId, encounterId: d.encounterId, occurredAt: now,
      });
      ledgerEntryIds.push(ledgerEntryId);
      const [uoms, regulation] = await Promise.all([itemUomRows(tx, line.itemId), effectiveRegulation(tx, line.itemId, now)]);
      let mrpPaisePerBase: number | null = null;
      let ceilingPaisePerBase: number | null = null;
      try {
        const price = priceForBatch({ uoms, batch: { mrpPaise: batch.mrpPaise, mrpUom: batch.mrpUom }, regulation: regulation === undefined ? null : { ceilingPaise: regulation.ceilingPaise, mrpUom: regulation.mrpUom } });
        mrpPaisePerBase = price.mrpPaisePerBase;
        ceilingPaisePerBase = price.ceilingPaisePerBase;
      } catch { /* an unsaleable batch was refused at the bill; the event carries nulls */ }
      await appendEvent(tx, materialConsumed.make({
        actor, patientId: d.patientId, encounterId: d.encounterId, correlationId: d.id,
        payload: {
          ledgerEntryId, itemId: line.itemId, batchId: line.batchId, ownership: batch.ownership as "owned" | "consignment" | "loaner" | "donated",
          vendorId: batch.vendorId, qtyBase: line.qtyBase, patientId: d.patientId, encounterId: d.encounterId,
          caseRef: { type: "pharmacy_dispense", id: d.id }, mrpPaise: batch.mrpPaise, mrpUom: batch.mrpUom,
          mrpPaisePerBase, ceilingPaisePerBase, occurredAt: now.toISOString(),
        },
      }));
      await tx.update(pharmacyDispenseLines).set({ ledgerEntryId }).where(eq(pharmacyDispenseLines.id, line.id));
      if (line.orderItemId !== null) await advanceOrderItem(tx, actor, decls, line.orderItemId, "completed", { at: now });

      if (line.scheduleFlag !== null && (REGISTER_FLAGS as readonly string[]).includes(line.scheduleFlag)) {
        const med = line.dispensedMedicineId === null ? undefined : medicines.get(line.dispensedMedicineId);
        const item = items.get(line.itemId);
        await tx.insert(pharmacyRegH1).values({
          id: newId(), dispenseLineId: line.id, dispensedAt: now, patientId: d.patientId,
          patientName: patient.name, patientAddress: patient.addressLine ?? null,
          prescriberName: doctor?.displayName ?? rx.doctorId, prescriberRegNo: doctor?.registrationNo ?? null,
          drugName: med === undefined ? (line.rxLine as RxLine).drug : `${med.brandName}${med.strengthLabel === null ? "" : ` ${med.strengthLabel}`} ${med.form}`,
          medicineId: line.dispensedMedicineId, batchNo: batch.batchNo, qtyBase: line.qtyBase, unit: item?.baseUom ?? "unit", recordedBy: actor.id,
        });
        h1Rows += 1;
      }
    }
    const won = await tx.update(pharmacyDispenses)
      .set({ status: "handed_over", handedOverBy: actor.id, handedOverAt: now, identityConfirmedVia, scheduled })
      .where(and(eq(pharmacyDispenses.id, d.id), eq(pharmacyDispenses.status, "billed")))
      .returning({ id: pharmacyDispenses.id });
    if (won.length === 0) throw new PharmacyError("dispense_not_in_state", `dispense ${d.id} moved while handing over`);
    if (d.workflowInstanceId !== null) await transition(tx, d.workflowInstanceId, "handed_over", actor);
    await appendEvent(tx, dispenseHandedOver.make({
      actor, patientId: d.patientId, encounterId: d.encounterId, correlationId: d.id,
      payload: {
        dispenseId: d.id, dispenseNo: d.dispenseNo ?? d.id, patientId: d.patientId, encounterId: d.encounterId, handedOverBy: actor.id,
        ledgerEntryIds, h1RegisterRows: h1Rows, identityConfirmedVia,
      },
    }));
  });
  return getDispense(db, actor, d.id);
}
