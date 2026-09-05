import { and, eq } from "drizzle-orm";
import { appendEvent } from "../../kernel/events/append";
import { pharmacyDispenseLines, pharmacyDispenses } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { advanceOrderItem } from "../../kernel/orders/advance";
import { placeOrder } from "../../kernel/orders/place";
import { transition } from "../../kernel/workflow/instances";
import { listMedicines, resolveMedicines } from "../formulary";
import { availableQty, listItems, releaseReservation } from "../materials";
import { getEncounter, getPrescription, runRxChecks } from "../opd";
import { PHARMACY_SUBSTITUTION_ENABLED, REFUSED_FLAGS, SCHEDULED_FLAGS, istDateOf } from "./config";
import { dispenseCancelled, dispenseLineDeclined, dispenseVerified, substitutionRecorded } from "./events";
import { PharmacyError } from "./errors";
import { getDispense, getDispenseRow, linesOf } from "./queue";
import { getSaleItem } from "./sale-items";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { OrderKindDecl } from "../../kernel/orders/kinds";
import type { AllergyOverride, RxLine, RxOverride } from "../opd";
import type { DispenseView } from "./queue";

export type Alternative = { medicineId: string; brandName: string; strengthLabel: string | null; form: string; itemId: string; itemCode: string; available: number };

/**
 * D6 — the generic equivalents of a line's medicine that this counter can actually sell: same salt
 * set, strength, form and route; a drug item bridged to an ACTIVE sale item; stock at the store.
 * The same equality `verifyDispense` enforces, so what the screen offers is what verify accepts.
 */
export async function alternativesFor(db: Db, dispenseId: string, lineIdx: number): Promise<Alternative[]> {
  const d = await getDispenseRow(db, dispenseId);
  const line = (await linesOf(db, dispenseId)).find((l) => l.lineIdx === lineIdx);
  if (line === undefined) throw new PharmacyError("unknown_line", `line ${String(lineIdx)} not found`);
  if (line.dispensedMedicineId === null || (line.rxLine as RxLine).noSubstitution || !PHARMACY_SUBSTITUTION_ENABLED) return [];
  const all = await listMedicines(db, { activeOnly: true });
  const from = all.find((m) => m.id === line.dispensedMedicineId);
  if (from === undefined) return [];
  const resolvedAll = await resolveMedicines(db, all.map((m) => m.id));
  const saltSet = (id: string): string => (resolvedAll.get(id)?.salts ?? []).map((s) => s.saltId).sort().join("|");
  const wanted = saltSet(from.id);
  if (wanted === "") return [];
  const drugItems = await listItems(db, { class: "drug", active: true });
  const itemByMedicine = new Map(drugItems.filter((i) => i.formularyMedicineId !== null).map((i) => [i.formularyMedicineId as string, i]));
  const out: Alternative[] = [];
  for (const m of all) {
    if (m.id === from.id) continue;
    if (saltSet(m.id) !== wanted || (m.strengthLabel ?? "") !== (from.strengthLabel ?? "") || m.form !== from.form || m.routeClass !== from.routeClass) continue;
    // R-3 — what this counter may not dispense, it may not offer either (close review, §8.5 pass 1)
    if (m.scheduleFlag !== null && (REFUSED_FLAGS as readonly string[]).includes(m.scheduleFlag)) continue;
    const item = itemByMedicine.get(m.id);
    if (item === undefined) continue;
    const sale = await getSaleItem(db, item.id);
    if (sale === undefined || !sale.active) continue;
    // What the substitution dropdown PROMISES must be what the pick can deliver: a generic offered
    // as "50 available" whose fifty are expired sends the pharmacist down a path that ends in
    // `short_stock` after the substitution is already recorded. One definition, `availableQty`.
    const available = d.storeResourceId === null ? 0 : await availableQty(db, d.storeResourceId, item.id);
    out.push({ medicineId: m.id, brandName: m.brandName, strengthLabel: m.strengthLabel, form: m.form, itemId: item.id, itemCode: item.code, available });
  }
  return out;
}

export type VerifyLineInput = {
  lineIdx: number;
  qtyBase: number;
  /** D6 — a generic substitution: a different formulary medicine, same salts, strength and route. */
  dispensedMedicineId?: string;
  patientConsent?: boolean;
};

export type VerifyInput = { lines: VerifyLineInput[] };

/**
 * PLAN 16c T3 — VERIFY: every open line is settled, the checks re-run on what will actually be
 * handed over, and the `medication` order is placed (D1 as executed; the order needs a service per
 * line, and a service is known only once resolution, substitution and decline are done).
 *
 * ═══ D9 — THE RE-CHECK IS ON THE DISPENSED MEDICINE, NOT THE PRESCRIBED TEXT ═══
 *
 * `runRxChecks` takes `RxLine[]` and resolves id-first, so the lines it sees here carry the
 * DISPENSED medicine id. An allergy or a severe interaction that the prescriber did not override
 * at issue time blocks the verify by code; one the prescriber did override is shown and passes —
 * the counter re-runs the doctor's decision, it does not re-make it.
 *
 * ═══ D6 — GENERIC SUBSTITUTION IS A SET EQUALITY, NOT A JUDGEMENT ═══
 *
 * Same salt-id set, same strength label, same form, same route class, `noSubstitution` false,
 * consent captured. Anything else is `substitution_not_allowed` and the pharmacist declines the
 * line instead — a different moiety is a new prescription (doc 16 §3.1a), which is the doctor's.
 */
export async function verifyDispense(
  db: Db,
  actor: Actor,
  decls: readonly OrderKindDecl[],
  dispenseId: string,
  input: VerifyInput,
  now: Date,
): Promise<DispenseView> {
  const d = await getDispenseRow(db, dispenseId);
  if (d.status !== "claimed") throw new PharmacyError("dispense_not_in_state", `dispense ${d.id} is ${d.status}, not claimed`, { status: d.status });
  const rx = await getPrescription(db, actor, d.prescriptionId);
  if (rx === null) throw new PharmacyError("unknown_prescription", `prescription ${d.prescriptionId} not found`);
  if (rx.status !== "active") throw new PharmacyError("prescription_superseded", `prescription ${rx.id} v${String(rx.version)} is ${rx.status}`);
  const encounter = await getEncounter(db, d.encounterId);
  if (encounter === null) throw new PharmacyError("not_found", `encounter ${d.encounterId} not found`);
  if (d.storeResourceId === null) throw new PharmacyError("store_missing", "the claim named no store");

  const lines = await linesOf(db, dispenseId);
  const byIdx = new Map(input.lines.map((l) => [l.lineIdx, l]));
  const medicines = new Map((await listMedicines(db)).map((m) => [m.id, m]));
  const drugItems = await listItems(db, { class: "drug", active: true });
  const itemByMedicine = new Map(drugItems.filter((i) => i.formularyMedicineId !== null).map((i) => [i.formularyMedicineId as string, i]));

  type Settled = {
    line: (typeof lines)[number]; qtyBase: number; dispensedMedicineId: string; itemId: string; serviceId: string;
    substitution: { from: string; to: string } | null; scheduleFlag: string | null;
  };
  const settled: Settled[] = [];
  let substitutions = 0;
  for (const line of lines) {
    if (line.status !== "open") continue;
    const edit = byIdx.get(line.lineIdx);
    const rxLine = line.rxLine as RxLine;
    const qtyBase = edit?.qtyBase ?? line.qtyBase;
    if (qtyBase === null || !Number.isSafeInteger(qtyBase) || qtyBase <= 0) {
      throw new PharmacyError("qty_required", `line ${String(line.lineIdx + 1)} (${rxLine.drug}) has no quantity`, { lineIdx: line.lineIdx });
    }
    let dispensedMedicineId = line.dispensedMedicineId;
    let substitution: { from: string; to: string } | null = null;
    const wanted = edit?.dispensedMedicineId;
    if (wanted !== undefined && wanted !== dispensedMedicineId) {
      if (!PHARMACY_SUBSTITUTION_ENABLED) throw new PharmacyError("substitution_not_allowed", "substitution is switched off", { lineIdx: line.lineIdx });
      if (rxLine.noSubstitution) throw new PharmacyError("substitution_not_allowed", `line ${String(line.lineIdx + 1)} is marked no-substitution by the prescriber`, { lineIdx: line.lineIdx });
      if (dispensedMedicineId === null) throw new PharmacyError("unresolved_medicine", `line ${String(line.lineIdx + 1)} (${rxLine.drug}) did not resolve to a medicine; a substitute needs a resolved original`, { lineIdx: line.lineIdx });
      const from = medicines.get(dispensedMedicineId);
      const to = medicines.get(wanted);
      if (from === undefined || to === undefined) throw new PharmacyError("unresolved_medicine", `unknown medicine on line ${String(line.lineIdx + 1)}`, { lineIdx: line.lineIdx });
      const resolvedPair = await resolveMedicines(db, [from.id, to.id]);
      const saltSet = (id: string): string => (resolvedPair.get(id)?.salts ?? []).map((s) => s.saltId).sort().join("|");
      const same = saltSet(from.id) !== "" && saltSet(from.id) === saltSet(to.id)
        && (from.strengthLabel ?? "") === (to.strengthLabel ?? "") && from.form === to.form && from.routeClass === to.routeClass;
      if (!same) {
        throw new PharmacyError(
          "substitution_not_allowed",
          `${to.brandName} is not a generic equivalent of ${from.brandName} (same salts, strength, form and route) — a different medicine is a new prescription`,
          { lineIdx: line.lineIdx, from: from.id, to: to.id },
        );
      }
      if (edit?.patientConsent !== true) throw new PharmacyError("consent_required", `line ${String(line.lineIdx + 1)}: the patient's consent to the substitute must be captured`, { lineIdx: line.lineIdx });
      substitution = { from: from.id, to: to.id };
      dispensedMedicineId = to.id;
      substitutions += 1;
    }
    if (dispensedMedicineId === null) {
      throw new PharmacyError("unresolved_medicine", `line ${String(line.lineIdx + 1)} (${rxLine.drug}) resolves to no formulary medicine — resolve it or decline it`, { lineIdx: line.lineIdx });
    }
    const item = itemByMedicine.get(dispensedMedicineId);
    const sale = item === undefined ? undefined : await getSaleItem(db, item.id);
    if (item === undefined || sale === undefined || !sale.active) {
      throw new PharmacyError("unknown_sale_item", `line ${String(line.lineIdx + 1)} (${rxLine.drug}) is not a stocked sale item — substitute or decline it`, { lineIdx: line.lineIdx });
    }
    const med = medicines.get(dispensedMedicineId);
    const scheduleFlag = med?.scheduleFlag ?? null;
    /**
     * R-3, AT THE SECOND GATE TOO (close review, 16c §8.5 pass 1). `claimDispense` refuses a
     * Schedule X line before any line is written — but it judges the medicine the PRESCRIPTION
     * named, and this function is allowed to change it: a substitution swaps in a different
     * medicine, and the equality it must satisfy (salts, strength, form, route) says nothing about
     * schedule. A controlled brand sharing a salt set with an uncontrolled one — or one row whose
     * `schedule_flag` was typed wrong — walked past the claim's guard and out of the window, with
     * no double custody and no register. The law is asked at every gate that can name a medicine.
     */
    if (scheduleFlag !== null && (REFUSED_FLAGS as readonly string[]).includes(scheduleFlag)) {
      throw new PharmacyError(
        "schedule_x_not_dispensed_here",
        `line ${String(line.lineIdx + 1)} would dispense ${med?.brandName ?? rxLine.drug}, Schedule ${scheduleFlag} — not dispensed at the OPD counter until double custody (16d)`,
        { lineIdx: line.lineIdx, scheduleFlag },
      );
    }
    settled.push({ line, qtyBase, dispensedMedicineId, itemId: item.id, serviceId: sale.serviceId, substitution, scheduleFlag });
  }
  if (settled.length === 0) throw new PharmacyError("nothing_to_dispense", "every line is declined — cancel the dispense instead");

  // ── D9: the re-check, on what will be handed over ──
  const checkLines: RxLine[] = settled.map((s) => ({ ...(s.line.rxLine as RxLine), medicineId: s.dispensedMedicineId, drug: medicines.get(s.dispensedMedicineId)?.brandName ?? (s.line.rxLine as RxLine).drug }));
  const outcome = await runRxChecks(db, d.patientId, checkLines, now, { excludeEncounterId: d.encounterId });
  const allergyOverrides = (rx.allergyOverrides ?? []) as AllergyOverride[];
  const interactionOverrides = (rx.interactionOverrides ?? []) as RxOverride[];
  const origIdx = (checkIdx: number): number => settled[checkIdx]!.line.lineIdx;
  const allergyBlocks = outcome.allergyMatches.filter((m) => !allergyOverrides.some((o) => o.lineIndex === origIdx(m.lineIndex) && o.substance === m.substance));
  if (allergyBlocks.length > 0) {
    throw new PharmacyError(
      "allergy_block",
      `the patient is recorded allergic to ${allergyBlocks.map((m) => m.substance).join(", ")} and the prescriber did not override it — back to the doctor`,
      { hits: allergyBlocks.map((m) => ({ lineIdx: origIdx(m.lineIndex), substance: m.substance })) },
    );
  }
  const samePair = (a: readonly [string, string], b: readonly [string, string]): boolean => (a[0] === b[0] && a[1] === b[1]) || (a[0] === b[1] && a[1] === b[0]);
  const severe = outcome.interactions.filter((h) => h.severity === "severe");
  const interactionBlocks = severe.filter((h) => !interactionOverrides.some((o) => o.lineIndex === origIdx(h.lineIndex) && o.saltPair !== undefined && samePair(o.saltPair, h.saltPair)));
  if (interactionBlocks.length > 0) {
    throw new PharmacyError(
      "interaction_block",
      `a severe interaction the prescriber did not override: ${interactionBlocks.map((h) => h.note).join("; ")} — back to the doctor`,
      { hits: interactionBlocks.map((h) => ({ lineIdx: origIdx(h.lineIndex), saltPair: h.saltPair, note: h.note })) },
    );
  }
  const scheduled = settled.some((s) => s.scheduleFlag !== null && (SCHEDULED_FLAGS as readonly string[]).includes(s.scheduleFlag));
  const declinedCount = lines.filter((l) => l.status === "declined").length;

  await withTx(db, async (tx) => {
    const placed = await placeOrder(tx, actor, decls, {
      kind: "medication", patientId: d.patientId, encounterNo: encounter.visitNo, serviceDate: istDateOf(now),
      orderingClinicianId: rx.doctorId, priority: "routine", placedAt: now,
      items: settled.map((s) => ({ serviceId: s.serviceId })),
    });
    for (const [i, s] of settled.entries()) {
      await tx.update(pharmacyDispenseLines).set({
        qtyBase: s.qtyBase, dispensedMedicineId: s.dispensedMedicineId, itemId: s.itemId, orderItemId: placed.itemIds[i]!,
        scheduleFlag: s.scheduleFlag,
        ...(s.substitution === null ? {} : { substitutionType: "generic", consentBy: actor.id, consentAt: now }),
      }).where(eq(pharmacyDispenseLines.id, s.line.id));
      if (s.substitution !== null) {
        await appendEvent(tx, substitutionRecorded.make({
          actor, patientId: d.patientId, encounterId: d.encounterId, correlationId: d.id,
          payload: { dispenseId: d.id, lineIdx: s.line.lineIdx, patientId: d.patientId, doctorId: rx.doctorId, orderedMedicineId: s.substitution.from, dispensedMedicineId: s.substitution.to, consentBy: actor.id },
        }));
      }
    }
    const won = await tx.update(pharmacyDispenses)
      .set({ status: "verified", verifiedBy: actor.id, verifiedAt: now, orderId: placed.orderId, dispenseNo: placed.orderNo, scheduled })
      .where(and(eq(pharmacyDispenses.id, d.id), eq(pharmacyDispenses.status, "claimed")))
      .returning({ id: pharmacyDispenses.id });
    if (won.length === 0) throw new PharmacyError("dispense_not_in_state", `dispense ${d.id} moved while verifying`);
    if (d.workflowInstanceId !== null) await transition(tx, d.workflowInstanceId, "verified", actor);
    await appendEvent(tx, dispenseVerified.make({
      actor, patientId: d.patientId, encounterId: d.encounterId, correlationId: d.id,
      payload: {
        dispenseId: d.id, dispenseNo: placed.orderNo, orderId: placed.orderId, patientId: d.patientId, encounterId: d.encounterId,
        lineCount: settled.length, declinedCount, scheduled,
        allergyHits: outcome.allergyMatches.length, interactionHits: outcome.interactions.length, substitutions,
      },
    }));
  });
  return getDispense(db, actor, d.id, now);
}

/** A line the counter cannot fill: declined with a reason, its order item cancelled if one was placed. */
export async function declineLine(
  db: Db,
  actor: Actor,
  decls: readonly OrderKindDecl[],
  dispenseId: string,
  lineIdx: number,
  reason: string,
  now: Date,
): Promise<DispenseView> {
  const d = await getDispenseRow(db, dispenseId);
  if (d.status !== "claimed" && d.status !== "verified") throw new PharmacyError("dispense_not_in_state", `dispense ${d.id} is ${d.status}`, { status: d.status });
  const line = (await linesOf(db, dispenseId)).find((l) => l.lineIdx === lineIdx);
  if (line === undefined) throw new PharmacyError("unknown_line", `line ${String(lineIdx)} not found`);
  if (line.status !== "open") throw new PharmacyError("line_not_open", `line ${String(lineIdx + 1)} is already ${line.status}`);
  const trimmed = reason.trim();
  if (trimmed === "") throw new PharmacyError("qty_required", "a declined line needs a reason");
  await withTx(db, async (tx) => {
    await tx.update(pharmacyDispenseLines)
      .set({ status: "declined", declinedReason: trimmed, declinedBy: actor.id, declinedAt: now })
      .where(eq(pharmacyDispenseLines.id, line.id));
    if (line.orderItemId !== null) await advanceOrderItem(tx, actor, decls, line.orderItemId, "cancelled", { reason: trimmed, at: now });
    if (line.reservationId !== null) await releaseReservation(tx, actor, line.reservationId);
    await appendEvent(tx, dispenseLineDeclined.make({
      actor, patientId: d.patientId, encounterId: d.encounterId, correlationId: d.id,
      payload: { dispenseId: d.id, lineIdx, patientId: d.patientId, reason: trimmed },
    }));
  });
  return getDispense(db, actor, d.id, now);
}

/** Cancel before hand-over: order items cancelled, reservations released, the instance closed. Never after money or stock moved (T4 owns those). */
export async function cancelDispense(
  db: Db,
  actor: Actor,
  decls: readonly OrderKindDecl[],
  dispenseId: string,
  reason: string,
  now: Date,
): Promise<DispenseView> {
  const d = await getDispenseRow(db, dispenseId);
  if (!["queued", "claimed", "verified", "picked"].includes(d.status)) {
    throw new PharmacyError("dispense_not_in_state", `dispense ${d.id} is ${d.status} and cannot be cancelled here`, { status: d.status });
  }
  const trimmed = reason.trim();
  if (trimmed === "") throw new PharmacyError("qty_required", "a cancelled dispense needs a reason");
  const lines = await linesOf(db, dispenseId);
  let released = 0;
  await withTx(db, async (tx) => {
    /**
     * ═══ THE CAS COMES FIRST, AND THAT ORDERING IS THE GUARD (16c close review, pass 2) ═══
     *
     * This conditional UPDATE used to sit AFTER the per-line loop, and the sweep in `expiry.ts`
     * documented itself as relying on it: "the counter got there first — that is the conditional
     * UPDATE inside `cancelDispense` doing its job". It was not doing its job, because nothing
     * reached it. A pharmacist cancelling the same abandoned dispense the sweep had just SELECTed
     * made `advanceOrderItem` — the first statement in the loop — lose its own CAS and raise
     * `OrderError("stale_state")`, and `releaseReservation` would have raised
     * `MaterialsError("already_received")` a line later. Neither is a `PharmacyError`, so the
     * sweep's catch rethrew, the tick aborted, and every remaining expired pick in that batch went
     * unswept until the next minute.
     *
     * Taking the dispense row's lock FIRST makes the documented behaviour the real one: a second
     * canceller blocks here, finds the status moved, and gets `dispense_not_in_state` — one error,
     * from the module that owns the decision, before any child row has been touched. The loop then
     * runs only for the winner. Atomicity is unchanged: this is a re-ordering INSIDE one
     * transaction, so every effect still commits or rolls back together.
     */
    const won = await tx.update(pharmacyDispenses)
      .set({ status: "cancelled", cancelledBy: actor.id, cancelledAt: now, cancelReason: trimmed })
      .where(and(eq(pharmacyDispenses.id, d.id), eq(pharmacyDispenses.status, d.status)))
      .returning({ id: pharmacyDispenses.id });
    if (won.length === 0) throw new PharmacyError("dispense_not_in_state", `dispense ${d.id} moved while cancelling`);
    for (const line of lines) {
      if (line.status !== "open") continue;
      if (line.orderItemId !== null) await advanceOrderItem(tx, actor, decls, line.orderItemId, "cancelled", { reason: trimmed, at: now });
      if (line.reservationId !== null) { await releaseReservation(tx, actor, line.reservationId); released += 1; }
    }
    if (d.workflowInstanceId !== null) await transition(tx, d.workflowInstanceId, "cancelled", actor);
    await appendEvent(tx, dispenseCancelled.make({
      actor, patientId: d.patientId, encounterId: d.encounterId, correlationId: d.id,
      payload: { dispenseId: d.id, patientId: d.patientId, fromStatus: d.status, reason: trimmed, reservationsReleased: released },
    }));
  });
  return getDispense(db, actor, d.id, now);
}
