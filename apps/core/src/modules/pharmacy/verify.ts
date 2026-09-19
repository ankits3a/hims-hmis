import { and, eq } from "drizzle-orm";
import { appendEvent } from "../../kernel/events/append";
import { pharmacyDispenseLines, pharmacyDispenses } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { advanceOrderItem } from "../../kernel/orders/advance";
import { placeOrder } from "../../kernel/orders/place";
import { transition } from "../../kernel/workflow/instances";
import { equivalentMedicines, isEquivalentMedicine, medicinesByIds } from "../formulary";
import { availableQtyByItem, listItems, releaseReservation } from "../materials";
import { getEncounter, getPrescription, runRxChecks } from "../opd";
import { PHARMACY_SUBSTITUTION_ENABLED, REFUSED_FLAGS, SCHEDULED_FLAGS, istDateOf } from "./config";
import { dispenseCancelled, dispenseLineDeclined, dispenseVerified, lineResolved, substitutionRecorded } from "./events";
import { PharmacyError } from "./errors";
import { requireRegisteredPharmacist } from "./pharmacists";
import { refusalsOf, refusalsOn } from "./refusals";
import type { Refusals } from "./refusals";
import { getDispense, getDispenseRow, linesOf } from "./queue";
import { searchShelfAt } from "./retail";
import { getSaleItem } from "./sale-items";
import { shelfByMedicine } from "./shelf";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { OrderKindDecl } from "../../kernel/orders/kinds";
import type { RxLine } from "../opd";
import type { DispenseView } from "./queue";
import type { RetailShelfEntry } from "./retail";

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
  /**
   * THE SHELF IS THE UNIVERSE. This used to read every medicine in the catalogue and resolve every
   * one of their compositions, then loop the result in JS. At the national catalogue's 103,383 rows
   * that read does not merely cost a heap — it THROWS `08P01` on the wire, because drizzle emits
   * one bind parameter per id and the protocol counts them in an Int16 (`kernel/db/any-of.ts`).
   * What the counter can offer was never more than what it stocks, so that is what it asks about.
   */
  const shelf = await shelfByMedicine(db);
  const candidates = await equivalentMedicines(db, line.dispensedMedicineId, { among: [...shelf.keys()] });
  // R-3 — what this counter may not dispense, it may not offer either (close review, §8.5 pass 1).
  const offered = candidates.filter((m) => m.scheduleFlag === null || !(REFUSED_FLAGS as readonly string[]).includes(m.scheduleFlag));
  if (offered.length === 0) return [];
  // Every candidate came FROM the shelf, so its entry is present by construction.
  const entries = offered.map((m) => ({ m, e: shelf.get(m.id) as NonNullable<ReturnType<typeof shelf.get>> }));
  /**
   * What the substitution dropdown PROMISES must be what the pick can deliver: a generic offered as
   * "50 available" whose fifty are expired sends the pharmacist down a path that ends in
   * `short_stock` after the substitution is already recorded. One definition, and it is now asked
   * once for the whole list rather than once per candidate.
   */
  const available = d.storeResourceId === null
    ? new Map<string, number>()
    : await availableQtyByItem(db, d.storeResourceId, entries.map((x) => x.e.item.id));
  return entries.map(({ m, e }) => ({
    medicineId: m.id, brandName: m.brandName, strengthLabel: m.strengthLabel, form: m.form,
    itemId: e.item.id, itemCode: e.item.code, available: available.get(e.item.id) ?? 0,
  }));
}

/**
 * ═══ PD-7 C3 — THE EQUIVALENTS, EACH ALREADY PUT TO THIS PATIENT'S CHECK ═══
 *
 * Every alternative is run through `runRxChecks` for THIS patient with the line swapped to it, and
 * judged by `refusalsOf` — the function `verifyDispense` refuses with — so "blocked" on the sheet is
 * exactly what the check will refuse, named by book. `not_checked` is a line the books could see
 * only in part (PD-D13: never drawn as clear).
 *
 * MEASURED: an equivalent has the same salt set by construction, so its verdict is almost always the
 * original line's. The run is still per alternative because the allergy book also matches brand
 * names, and because that sameness is `isEquivalentMedicine`'s to keep, not this function's to
 * assume. The price difference the phase doc asked for is NOT here: the bill's price is billing's
 * `min(batch MRP, ceiling, contract)`, decided at the bill, and this desk does no price arithmetic
 * (DEFERRED to C7, which can ask billing's preview).
 */
export type AlternativeBlock = { book: "allergy" | "interaction" | "duplicate" | "drug_disease"; about: string };

/** A line's refusals as the sheet and the line say them: which book, about what. */
function blocksOf(r: Refusals): AlternativeBlock[] {
  return [
    ...r.allergy.map((x) => ({ book: "allergy" as const, about: x.substance })),
    ...r.interaction.map((x) => ({ book: "interaction" as const, about: x.note })),
    ...r.duplicate.map((x) => ({ book: "duplicate" as const, about: x.moiety })),
    ...r.drugDisease.map((x) => ({ book: "drug_disease" as const, about: x.icd10Title })),
  ];
}
export type CheckedAlternative = Alternative & { check: { verdict: "clear" | "not_checked" | "blocked"; blocks: AlternativeBlock[] } };

export async function checkedAlternativesFor(db: Db, actor: Actor, dispenseId: string, lineIdx: number, now: Date): Promise<CheckedAlternative[]> {
  const alternatives = await alternativesFor(db, dispenseId, lineIdx);
  if (alternatives.length === 0) return [];
  const d = await getDispenseRow(db, dispenseId);
  const rx = await getPrescription(db, actor, d.prescriptionId);
  if (rx === null) {
    throw new PharmacyError("permission_denied", "this ticket is a sealed record — its checks are read by a pharmacist who may read it", { reason: "patient_restricted" });
  }
  const open = (await linesOf(db, dispenseId)).filter((l) => l.status === "open");
  const target = open.findIndex((l) => l.lineIdx === lineIdx);
  const medicines = await medicinesByIds(db, [
    ...open.map((l) => l.dispensedMedicineId), ...alternatives.map((a) => a.medicineId),
  ].filter((x): x is string => x !== null));
  const out: CheckedAlternative[] = [];
  for (const alt of alternatives) {
    const checkLines: RxLine[] = open.map((l) => {
      const rxLine = l.rxLine as RxLine;
      const id = l.lineIdx === lineIdx ? alt.medicineId : l.dispensedMedicineId;
      return id === null ? rxLine : { ...rxLine, medicineId: id, drug: medicines.get(id)?.brandName ?? rxLine.drug };
    });
    const outcome = await runRxChecks(db, d.patientId, checkLines, now, { excludeEncounterId: d.encounterId });
    const blocks = blocksOf(refusalsOn(refusalsOf(outcome, (i) => open[i]!.lineIdx, rx, new Set()), lineIdx));
    const partly = outcome.unreviewedLineIndexes.includes(target) || outcome.unresolvedLineIndexes.includes(target);
    out.push({ ...alt, check: { verdict: blocks.length > 0 ? "blocked" : partly ? "not_checked" : "clear", blocks } });
  }
  return out;
}

/**
 * ═══ C3b — THE TICKET'S OWN LINES, PUT TO THE SAME CHECK AT THE CLAIM ═══
 *
 * Found walking C3: an allergy recorded after the issue sat silent on its line until the last tick
 * fired verify — after the strips were in hand. This asks `refusalsOf` about the lines as they
 * stand, so the line can say "the check will stop this" before anyone walks to the shelf. Only a
 * CLAIMED ticket is asked: after verify the check has spoken, and a declined line is not handed
 * over. A line nobody placed is `unplaced` — its reading is judged at the check (PD-5b), not here.
 */
export type LinePrecheck = { lineIdx: number; verdict: "clear" | "not_checked" | "blocked" | "unplaced"; blocks: AlternativeBlock[] };

export async function precheckTicket(db: Db, actor: Actor, dispenseId: string, now: Date): Promise<{ lines: LinePrecheck[] }> {
  const d = await getDispenseRow(db, dispenseId);
  if (d.status !== "claimed") return { lines: [] };
  const rx = await getPrescription(db, actor, d.prescriptionId);
  if (rx === null) {
    throw new PharmacyError("permission_denied", "this ticket is a sealed record — its checks are read by a pharmacist who may read it", { reason: "patient_restricted" });
  }
  const open = (await linesOf(db, dispenseId)).filter((l) => l.status === "open");
  if (open.length === 0) return { lines: [] };
  const medicines = await medicinesByIds(db, open.map((l) => l.dispensedMedicineId).filter((x): x is string => x !== null));
  const checkLines: RxLine[] = open.map((l) => {
    const rxLine = l.rxLine as RxLine;
    return l.dispensedMedicineId === null ? rxLine : { ...rxLine, medicineId: l.dispensedMedicineId, drug: medicines.get(l.dispensedMedicineId)?.brandName ?? rxLine.drug };
  });
  const outcome = await runRxChecks(db, d.patientId, checkLines, now, { excludeEncounterId: d.encounterId });
  const refused = refusalsOf(outcome, (i) => open[i]!.lineIdx, rx, new Set());
  return {
    lines: open.map((l, i): LinePrecheck => {
      if (l.dispensedMedicineId === null) return { lineIdx: l.lineIdx, verdict: "unplaced", blocks: [] };
      const blocks = blocksOf(refusalsOn(refused, l.lineIdx));
      const partly = outcome.unreviewedLineIndexes.includes(i) || outcome.unresolvedLineIndexes.includes(i);
      return { lineIdx: l.lineIdx, verdict: blocks.length > 0 ? "blocked" : partly ? "not_checked" : "clear", blocks };
    }),
  };
}

/**
 * PD-5b — what a line the catalogue could not place may be read as: this ticket's own shelf,
 * searched by name, code or a scanned pack, Schedule X never offered (R-3, `searchShelfAt`). Only
 * for such a line — a line the doctor named, or the catalogue placed from the words, has a medicine
 * already, and anything else in its place is a substitution (`alternativesFor`, with consent).
 */
export async function placementsFor(db: Db, dispenseId: string, lineIdx: number, q: string, now: Date): Promise<RetailShelfEntry[]> {
  const d = await getDispenseRow(db, dispenseId);
  const line = (await linesOf(db, dispenseId)).find((l) => l.lineIdx === lineIdx);
  if (line === undefined) throw new PharmacyError("unknown_line", `line ${String(lineIdx)} not found`);
  if (line.status !== "open" || line.dispensedMedicineId !== null || d.storeResourceId === null) return [];
  return searchShelfAt(db, d.storeResourceId, q, now);
}

export type VerifyLineInput = {
  lineIdx: number;
  qtyBase: number;
  /**
   * D6 — a generic substitution: a different formulary medicine, same salts, strength and route.
   * PD-5b — on a line the catalogue could not place, the medicine the pharmacist reads it as.
   */
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
 * the counter re-runs the doctor's decision, it does not re-make it. PD-5b added the other two
 * books issue gates — a hard duplicate and a severe drug×disease hit — for the cases where the
 * decision could not have been made at issue (see the block below the interaction refusal).
 *
 * ═══ D6 — GENERIC SUBSTITUTION IS A SET EQUALITY, NOT A JUDGEMENT ═══
 *
 * Same salt-id set, same strength label, same form, same route class, `noSubstitution` false,
 * consent captured. Anything else is `substitution_not_allowed` and the pharmacist declines the
 * line instead — a different moiety is a new prescription (doc 16 §3.1a), which is the doctor's.
 *
 * ═══ PD-5b — A LINE NOBODY PLACED IS RESOLVED, NOT SUBSTITUTED ═══
 *
 * A line whose words the catalogue could not match (no `dispensedMedicineId` after the claim) has no
 * medicine to substitute FOR. Naming one is reading the doctor's words, which is the pharmacist's
 * act: no equivalence to prove and no consent to capture, and `noSubstitution` does not forbid it —
 * "only what I wrote" is what a resolution tries to honour. It is NOT a lighter gate: the medicine
 * chosen is judged below exactly as a prescribed one is (stocked, sellable, Schedule X refused) and
 * the books re-run on it (D9), so an allergy the prescriber never saw stops it here. The line records
 * `resolved` and `dispense.line_resolved` names who read it. Whether a line is "unplaced" is decided
 * by the claim's own resolution — never by the shape of this body.
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
  /**
   * The medicines THIS dispense names — the lines' own, plus any substitute the edit asks for. The
   * only reads of this map are `.get(dispensedMedicineId)` and `.get(wanted)`, so the set is
   * provably complete, and it is bounded by the prescription rather than by the catalogue.
   */
  const medicines = await medicinesByIds(db, [
    ...lines.map((l) => l.dispensedMedicineId),
    ...input.lines.map((l) => l.dispensedMedicineId ?? null),
  ].filter((x): x is string => x !== null));
  const drugItems = await listItems(db, { class: "drug", active: true });
  const itemByMedicine = new Map(drugItems.filter((i) => i.formularyMedicineId !== null).map((i) => [i.formularyMedicineId as string, i]));

  type Settled = {
    line: (typeof lines)[number]; qtyBase: number; dispensedMedicineId: string; itemId: string; serviceId: string;
    substitution: { from: string; to: string } | null; resolvedHere: boolean; scheduleFlag: string | null;
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
    let resolvedHere = false;
    const wanted = edit?.dispensedMedicineId;
    if (wanted !== undefined && dispensedMedicineId === null) {
      if (!medicines.has(wanted)) throw new PharmacyError("unresolved_medicine", `unknown medicine on line ${String(line.lineIdx + 1)}`, { lineIdx: line.lineIdx });
      dispensedMedicineId = wanted;
      resolvedHere = true;
    } else if (wanted !== undefined && dispensedMedicineId !== null && wanted !== dispensedMedicineId) {
      if (!PHARMACY_SUBSTITUTION_ENABLED) throw new PharmacyError("substitution_not_allowed", "substitution is switched off", { lineIdx: line.lineIdx });
      if (rxLine.noSubstitution) throw new PharmacyError("substitution_not_allowed", `line ${String(line.lineIdx + 1)} is marked no-substitution by the prescriber`, { lineIdx: line.lineIdx });
      const from = medicines.get(dispensedMedicineId);
      const to = medicines.get(wanted);
      if (from === undefined || to === undefined) throw new PharmacyError("unresolved_medicine", `unknown medicine on line ${String(line.lineIdx + 1)}`, { lineIdx: line.lineIdx });
      /**
       * THE SAME PREDICATE THE DROPDOWN OFFERS FROM. This was a hand-written JS conjunction and
       * `alternativesFor` was another, and nothing asserted that the two agreed — so a counter
       * could be offered a substitution this gate then refused. One definition, asked twice.
       */
      if (!await isEquivalentMedicine(db, from.id, to.id)) {
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
    settled.push({ line, qtyBase, dispensedMedicineId, itemId: item.id, serviceId: sale.serviceId, substitution, resolvedHere, scheduleFlag });
  }
  if (settled.length === 0) throw new PharmacyError("nothing_to_dispense", "every line is declined — cancel the dispense instead");

  // ── D9: the re-check, on what will be handed over ──
  const checkLines: RxLine[] = settled.map((s) => ({ ...(s.line.rxLine as RxLine), medicineId: s.dispensedMedicineId, drug: medicines.get(s.dispensedMedicineId)?.brandName ?? (s.line.rxLine as RxLine).drug }));
  const outcome = await runRxChecks(db, d.patientId, checkLines, now, { excludeEncounterId: d.encounterId });
  const origIdx = (checkIdx: number): number => settled[checkIdx]!.line.lineIdx;
  /**
   * The four books' refusals, in `refusalsOf`'s one definition (PD-7 C3 asks the same function
   * before a substitute is chosen). A reading here (PD-5b) is the only way a NEW hard duplicate can
   * reach this check, and a reading's moieties or a diagnosis coded after the issue are the ways a
   * severe drug×disease hit can arrive unruled-on — see `refusals.ts` (E35–E37).
   */
  const readHere = new Set(settled.filter((s) => s.resolvedHere).map((s) => s.line.lineIdx));
  const refused = refusalsOf(outcome, origIdx, rx, readHere);
  if (refused.allergy.length > 0) {
    throw new PharmacyError(
      "allergy_block",
      `the patient is recorded allergic to ${refused.allergy.map((m) => m.substance).join(", ")} and the prescriber did not override it — back to the doctor`,
      { hits: refused.allergy },
    );
  }
  if (refused.interaction.length > 0) {
    throw new PharmacyError(
      "interaction_block",
      `a severe interaction the prescriber did not override: ${refused.interaction.map((h) => h.note).join("; ")} — back to the doctor`,
      { hits: refused.interaction.map(({ lineIdx, saltPair, note }) => ({ lineIdx, saltPair, note })) },
    );
  }
  if (refused.duplicate.length > 0) {
    throw new PharmacyError(
      "duplicate_block",
      `${[...new Set(refused.duplicate.map((h) => h.moiety))].join(", ")} is already on this prescription — the doctor's words cannot be read as a second one; choose another or decline the line`,
      { hits: refused.duplicate },
    );
  }
  if (refused.drugDisease.length > 0) {
    throw new PharmacyError(
      "drug_disease_block",
      `${refused.drugDisease.map((h) => `${h.moiety} with ${h.icd10Title}`).join("; ")}: contraindicated by a diagnosis this patient carries, and no prescriber has ruled on it — back to the doctor, or decline the line`,
      { hits: refused.drugDisease },
    );
  }
  const scheduled = settled.some((s) => s.scheduleFlag !== null && (SCHEDULED_FLAGS as readonly string[]).includes(s.scheduleFlag));
  const declinedCount = lines.filter((l) => l.status === "declined").length;

  await withTx(db, async (tx) => {
    const placed = await placeOrder(tx, actor, decls, {
      kind: "medication", patientId: d.patientId, encounterNo: encounter.visitNo, serviceDate: istDateOf(now),
      orderingClinicianId: rx.doctorId, priority: "routine", placedAt: now,
      /* PD-2 — the number the ticket was queued with; a ticket queued before PD-2 has none and is numbered here. */
      ...(d.dispenseNo === null ? {} : { preallocatedOrderNo: d.dispenseNo }),
      items: settled.map((s) => ({ serviceId: s.serviceId })),
    });
    /*
      P2 — THE PHARMACY ACT'S QUALIFICATION, after the permission. `placeOrder` has just asserted
      the permission to place the order (a login that may not is refused there, as before); this
      asks whether the person holds a current state council registration. A refusal rolls the
      order back with everything else in this transaction.
    */
    const registration = await requireRegisteredPharmacist(tx, actor, now);
    for (const [i, s] of settled.entries()) {
      await tx.update(pharmacyDispenseLines).set({
        qtyBase: s.qtyBase, dispensedMedicineId: s.dispensedMedicineId, itemId: s.itemId, orderItemId: placed.itemIds[i]!,
        scheduleFlag: s.scheduleFlag,
        ...(s.substitution === null ? {} : { substitutionType: "generic", consentBy: actor.id, consentAt: now }),
        ...(s.resolvedHere ? { substitutionType: "resolved" } : {}),
      }).where(eq(pharmacyDispenseLines.id, s.line.id));
      if (s.resolvedHere) {
        await appendEvent(tx, lineResolved.make({
          occurredAt: now, actor, patientId: d.patientId, encounterId: d.encounterId, correlationId: d.id,
          payload: { dispenseId: d.id, lineIdx: s.line.lineIdx, patientId: d.patientId, doctorId: rx.doctorId, dispensedMedicineId: s.dispensedMedicineId, resolvedBy: actor.id },
        }));
      }
      if (s.substitution !== null) {
        await appendEvent(tx, substitutionRecorded.make({
          occurredAt: now, actor, patientId: d.patientId, encounterId: d.encounterId, correlationId: d.id,
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
      occurredAt: now, actor, patientId: d.patientId, encounterId: d.encounterId, correlationId: d.id,
      payload: {
        dispenseId: d.id, dispenseNo: placed.orderNo, orderId: placed.orderId, patientId: d.patientId, encounterId: d.encounterId,
        lineCount: settled.length, declinedCount, scheduled,
        allergyHits: outcome.allergyMatches.length, interactionHits: outcome.interactions.length, substitutions,
        // P3: "0 hits" is only as good as what the checks could see.
        partlyCheckedLineIdxs: outcome.unreviewedLineIndexes.map(origIdx),
        pharmacistRegNo: registration.registrationNo,
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
      occurredAt: now, actor, patientId: d.patientId, encounterId: d.encounterId, correlationId: d.id,
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
      occurredAt: now, actor, patientId: d.patientId, encounterId: d.encounterId, correlationId: d.id,
      payload: { dispenseId: d.id, patientId: d.patientId, fromStatus: d.status, reason: trimmed, reservationsReleased: released },
    }));
  });
  return getDispense(db, actor, d.id, now);
}



