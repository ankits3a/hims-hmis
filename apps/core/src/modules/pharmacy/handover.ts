import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import { appendEvent } from "../../kernel/events/append";
import { pharmacyDispenseLines, pharmacyDispenses, pharmacyRegH1 } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { advanceOrderItem } from "../../kernel/orders/advance";
import { transition } from "../../kernel/workflow/instances";
import { invoiceSettlement } from "../billing";
import { listMedicines } from "../formulary";
import { consumeReservation, effectiveRegulation, getBatch, itemUomRows, itemsByIds, materialConsumed } from "../materials";
import { getDoctor, getPrescription, getVisit } from "../opd";
import { getPatient } from "../patients";
import { REFUSED_FLAGS, REGISTER_FLAGS, SCHEDULED_FLAGS, istDateOf } from "./config";
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

  /**
   * ═══ D8, READ AS AN AMOUNT AND NOT AS A STATE (close review, 16c §8.5 pass 1) ═══
   *
   * `billed` is a column; "paid" is a sum, and the two stop agreeing the moment anyone touches the
   * money after the bill. `issueInvoice` refuses to leave a remainder unsettled, so the dispense
   * cannot reach `billed` unpaid — but settlement is DERIVED (`settlement.ts`: no status column
   * exists on `invoices`, which is what keeps the immutability triggers total), and it is derived
   * from allocations and credit notes that other desks can still write:
   *
   *   grep -rn "reverseAllocation\|issueCreditNote" apps/core/src --include=*.ts | grep -v test
   *     → billing/receipts.ts, billing/credit-notes.ts, both exported on `billing/index.ts`,
   *       both reachable from the billing desk's own routes while the patient is still at
   *       our window (a receipt voided as taken on the wrong invoice; a credit note raised
   *       against the pharmacy bill).
   *
   * So the guard is not "unreachable by construction" (§5A.4's amendment) — the road is built from
   * another module in one call, and the suite below builds it. The drug leaves against money that
   * is still there, re-read at the irreversible act.
   */
  if (d.invoiceId === null) throw new PharmacyError("invoice_not_settled", "this dispense carries no invoice", { dispenseId: d.id });
  const invoiceId = d.invoiceId;

  const lines = (await linesOf(db, dispenseId)).filter((l) => l.status === "open");
  if (lines.length === 0) throw new PharmacyError("nothing_to_dispense", "no open line to hand over");
  const scheduled = d.scheduled || lines.some((l) => l.scheduleFlag !== null && (SCHEDULED_FLAGS as readonly string[]).includes(l.scheduleFlag));
  // R-3 at the LAST gate as well (pass 2 on the verify fix): claim and verify each judge a medicine
  // that the next step may still change, so the schedule this counter may not dispense is refused
  // wherever a line carrying it can be found — including one written before the guard above existed.
  const refused = lines.find((l) => l.scheduleFlag !== null && (REFUSED_FLAGS as readonly string[]).includes(l.scheduleFlag));
  if (refused !== undefined) {
    throw new PharmacyError(
      "schedule_x_not_dispensed_here",
      `line ${String(refused.lineIdx + 1)} is Schedule ${String(refused.scheduleFlag)} — not handed over at the OPD counter until double custody (16d)`,
      { lineIdx: refused.lineIdx, scheduleFlag: refused.scheduleFlag },
    );
  }

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
    /**
     * PASS 2 ON THIS FIX — the read belongs INSIDE the transaction that moves the stock. Checked
     * before `withTx`, it is a report about the past: a reversal landing in the gap between the
     * check and the `consumeReservation` below would still hand the drug over, which is the very
     * defect the guard was written for, only narrower. Read here, it is serialised against the
     * money the same way the ledger's own writes are.
     */
    const settlement = await invoiceSettlement(tx, invoiceId);
    if (settlement.state !== "settled") {
      throw new PharmacyError(
        "invoice_not_settled",
        `₹${(settlement.outstandingPaise / 100).toFixed(2)} is outstanding on this bill — the medicine stays at the counter until it is paid or the bill is corrected`,
        { invoiceId, outstandingPaise: settlement.outstandingPaise, state: settlement.state },
      );
    }
    for (const line of lines) {
      if (line.reservationId === null || line.batchId === null || line.itemId === null || line.qtyBase === null) {
        throw new PharmacyError("dispense_not_in_state", `line ${String(line.lineIdx + 1)} holds no reservation`, { lineIdx: line.lineIdx });
      }
      const batch = await getBatch(tx, line.batchId);
      if (batch === undefined) throw new PharmacyError("batch_not_saleable", `batch ${line.batchId} not found`);
      /**
       * EXPIRY IS ASKED AGAIN HERE, BECAUSE THIS IS THE ACT — the settlement guard twenty lines up
       * learned the same lesson about money and this line applies it to the medicine.
       *
       * Until this clause, expiry was tested exactly twice on the outbound path and both were at
       * the OFFER: `sellableBatchRows` excludes an already-expired batch from FEFO (materials/
       * ledger.ts:397) and `pick.ts:83` refuses one the pharmacist NAMES. `ledger.ts:390` states
       * the doctrine as "a batch that must not reach a patient must not be OFFERED to the person
       * handing it over" — and the code stopped at the word OFFERED. Nothing asked again between
       * the offer and the irreversible `consume` below: `consumeReservation` checks the
       * reservation's status, and `postMovements` guards recall-freeze and net quantity, neither
       * of them a date (that is why DD14's recall never needed a pharmacy-layer check and expiry
       * always did).
       *
       * THE WINDOW IS THE OVERNIGHT ONE, AND MONEY IS WHAT HOLDS IT OPEN. A pick that is abandoned
       * self-cancels after 30 minutes — but `sweepExpiredPicks` filters `status = 'picked'`
       * (expiry.ts:68), so once the patient has PAID the dispense is deliberately never swept and
       * the stock stays held for them. Bill at 21:00 on the last day the batch may be used, return
       * for it the next morning, and the batch that was legitimately in date at the pick is expired
       * at the counter. FEFO makes that likelier rather than rarer: it selects the earliest
       * still-in-date batch, which is the one nearest the boundary.
       *
       * IT IS DELIBERATELY NOT IN `postMovements`. `transfers.ts` moves expired stock to quarantine
       * BY NAMING THE BATCH, which is the disposal path and must keep working; a ledger-level date
       * guard would refuse the very movement that gets expired medicine off the shelf.
       *
       * WHAT THIS LEAVES BEHIND, SAID OUT LOUD BECAUSE THE PR MUST CARRY IT: the patient has paid
       * and now cannot collect, and `cancelDispense` refuses a `billed` dispense (verify.ts:288)
       * while the sweep skips it — so there is no exit in the shipped UI. That is still the right
       * trade (a stuck payment beats an expired drug in a patient) but it is a REFUND, and refunds
       * are 16d's. Until 16d lands, the counter's answer is the billing desk's credit note.
       */
      if (batch.expiryDate !== null && batch.expiryDate < istDateOf(now)) {
        throw new PharmacyError(
          "batch_expired_before_collection",
          `line ${String(line.lineIdx + 1)}: batch ${batch.batchNo} expired on ${batch.expiryDate} and cannot be handed over — it was in date when it was picked. Quarantine the strip and send the patient to the billing desk; the bill is already paid and needs a credit note.`,
          { lineIdx: line.lineIdx, batchId: line.batchId, batchNo: batch.batchNo, expiryDate: batch.expiryDate, asOf: istDateOf(now) },
        );
      }
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
  return getDispense(db, actor, d.id, now);
}
