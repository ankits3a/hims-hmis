import { and, eq, isNull } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { otCaseImplants, otCases } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { consignmentDeployed } from "../materials";
import { OtError } from "./errors";
import { implantExplanted } from "./events";
import { caseState } from "./booking";
import type { Tx } from "../../kernel/db/client";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 15 T5 / DD9 — **THE IMPLANT SCAN: one transaction, state-guarded, and asynchronous on the
 * other side.**
 *
 * ═══ THE ROW IS INSERTED BEFORE THE EVENT IS APPENDED, AND THAT ORDER IS A17 ═══
 *
 * `ot_case_implants_case_serial_ux` is the duplicate-scan guard, and it works only because the
 * INSERT happens first. The materials consumer's idempotency is by EVENT ID
 * (`consumption.ts`), so a SECOND `consignment.deployed` for the same serial is a different event
 * and would be handled: the lot decremented twice, the ledger carrying two rows for one plate, the
 * patient billed twice. **The unique index refuses the second scan before any event exists**, which
 * is why this function does not reach for an in-memory "have I seen this serial" check.
 *
 * Both writes are in ONE transaction (the caller's), so a failed insert leaves no event — A16's
 * second half, and the reason `deployImplant` takes a `Tx` rather than a `Db`.
 *
 * ═══ N6 — THE STATE GUARD, AND WHY IT IS NOT `signed_in` ═══
 *
 * A nurse opening an implant before the patient is on the table is the commonest way a consignment
 * item is wasted: the pack is opened, the case is cancelled, and the vendor bills for it. So a
 * deployment is legal only in `timed_out | incision | closing` — AFTER the WHO time-out has
 * confirmed the patient, the site and the procedure, and before the case is signed out.
 * `signed_in` is deliberately excluded: the patient is on the table but the time-out has not
 * happened, which is exactly the window N6 describes.
 *
 * ═══ F5 — AN EXPLANT REVERSES NOTHING IN MATERIALS, AND THIS FILE SAYS SO ═══
 *
 * Plan 14 has no consignment return writer: `consignment_lots.qty_returned` is written by nobody
 * and `stock_ledger`'s `return` reason has no author. So `explantImplant` records the clinical fact
 * and emits `implant.explanted` — **and `qty_deployed` stays incremented and the vendor liability
 * stands** until 14c's reconciliation nets it against this event. What it DOES do immediately is
 * keep the row off the patient's bill (D8: one patient charge), which is the composer's filter.
 * Pretending to reverse it here would be a stock movement with no ledger row behind it.
 *
 * ═══ F24c — `patient_supplied` EMITS NOTHING AND BILLS ZERO ═══
 *
 * A plate bought outside on a prescription is common in Indian orthopaedics. It has a sticker and a
 * serial worth recording and no lot, no vendor and no money. The CHECK
 * `(source = 'consignment') = (lot_id IS NOT NULL)` makes the two shapes structurally distinct.
 */

export type ImplantRow = typeof otCaseImplants.$inferSelect;

/** N6 — the only states in which a consignment item may be opened. */
export const IMPLANTABLE_STATES = ["timed_out", "incision", "closing"] as const;

export type DeployImplantInput = {
  caseId: string;
  itemId: string;
  serviceCode: string;
  qtyBase: number;
  source?: "consignment" | "patient_supplied";
  batchId?: string;
  lotId?: string;
  storeResourceId?: string;
  serial?: string;
  stickerRef?: string;
  /** H3 — a MANUALLY typed UDI needs a second actor. Absent when the barcode was scanned. */
  verifiedBy?: string;
};

export async function deployImplant(
  tx: Tx, actor: Actor, input: DeployImplantInput, occurredAt: Date = new Date(),
): Promise<{ implantId: string; state: string }> {
  const kase = (await tx.select().from(otCases).where(eq(otCases.id, input.caseId)))[0];
  if (!kase) throw new OtError("unknown_case", `unknown case ${input.caseId}`);

  const state = await caseState(tx, input.caseId);
  if (!(IMPLANTABLE_STATES as readonly string[]).includes(state)) {
    throw new OtError(
      "implant_state",
      `a case in "${state}" cannot take an implant — a consignment pack is opened only between the time-out and sign-out (N6)`,
      { state, allowed: IMPLANTABLE_STATES },
    );
  }

  const source = input.source ?? "consignment";
  if (source === "consignment") {
    if (input.lotId === undefined || input.batchId === undefined || input.storeResourceId === undefined) {
      throw new OtError("implant_state", "a consignment deployment needs its lot, batch and store (DD13's payload)");
    }
  } else if (input.lotId !== undefined) {
    throw new OtError("implant_state", "a patient-supplied implant has no consignment lot (F24c)");
  }

  const implantId = newId();
  /**
   * INSERT FIRST. The unique index is the guard, and it can only guard what is written before the
   * event. A duplicate serial raises here, the transaction rolls back, and no event was appended.
   */
  try {
    await tx.insert(otCaseImplants).values({
      id: implantId, caseId: input.caseId, encounterId: kase.encounterId,
      itemId: input.itemId, batchId: input.batchId ?? null, lotId: input.lotId ?? null,
      serial: input.serial ?? null, stickerRef: input.stickerRef ?? null,
      serviceCode: input.serviceCode, qtyBase: input.qtyBase, source,
      // `patient_supplied` never reaches the materials consumer, so it is CONFIRMED on arrival:
      // there is no ledger fact coming for it and `signOut` must not wait for one.
      state: source === "consignment" ? "deploying" : "confirmed",
      deployedBy: actor.id, verifiedBy: input.verifiedBy ?? null, deployedAt: occurredAt,
    });
  } catch (error) {
    if (String(error).includes("ot_case_implants_case_serial_ux")
      || String(error).includes("ot_case_implants_case_lot_sticker_ux")) {
      throw new OtError(
        "duplicate_scan",
        `this implant is already recorded on the case (serial ${String(input.serial)}) — scanning it twice would decrement the lot twice (A17/H10)`,
        { serial: input.serial ?? null },
      );
    }
    throw error;
  }

  if (source === "consignment") {
    await appendEvent(tx, consignmentDeployed.make({
      actor, patientId: kase.patientId, encounterId: kase.encounterId, occurredAt,
      payload: {
        lotId: input.lotId!, batchId: input.batchId!, itemId: input.itemId,
        storeResourceId: input.storeResourceId!, qtyBase: input.qtyBase,
        patientId: kase.patientId, encounterId: kase.encounterId,
        caseRef: { type: "ot_case", id: input.caseId },
        ...(input.stickerRef !== undefined ? { stickerRef: input.stickerRef } : {}),
        occurredAt: occurredAt.toISOString(),
      },
    }));
  }
  return { implantId, state: source === "consignment" ? "deploying" : "confirmed" };
}

/** F5 — records the clinical fact, keeps the row off the bill, and reverses nothing in materials. */
export async function explantImplant(
  tx: Tx, actor: Actor, input: { implantId: string; reason: string },
): Promise<void> {
  if (input.reason.trim() === "") throw new OtError("implant_state", "an explant must carry a reason");
  const row = (await tx.select().from(otCaseImplants).where(eq(otCaseImplants.id, input.implantId)))[0];
  if (!row) throw new OtError("unknown_case", `unknown implant ${input.implantId}`);
  if (row.explantedAt !== null) throw new OtError("implant_state", "this implant is already explanted");

  const kase = (await tx.select().from(otCases).where(eq(otCases.id, row.caseId)))[0]!;
  await tx.update(otCaseImplants)
    .set({ explantedAt: new Date(), explantReason: input.reason, state: "explanted" })
    .where(eq(otCaseImplants.id, input.implantId));
  await appendEvent(tx, implantExplanted.make({
    actor, patientId: kase.patientId, encounterId: kase.encounterId,
    payload: {
      caseId: row.caseId, encounterId: row.encounterId, implantId: input.implantId,
      lotId: row.lotId, serial: row.serial, reason: input.reason,
    },
  }));
}

/** Every implant row of one case. */
export async function implantsFor(exec: Db | Tx, caseId: string): Promise<ImplantRow[]> {
  return exec.select().from(otCaseImplants).where(eq(otCaseImplants.caseId, caseId));
}

/**
 * A18 — **the rows that are still waiting for their ledger fact.**
 *
 * `signOut` is refused while any of these exist. The materials consumer is ASYNCHRONOUS: the scan
 * appends `consignment.deployed`, the worker picks it up, decrements the lot, writes the `consume`
 * ledger row and emits `material.consumed`, and only then does this module stamp the row
 * `confirmed`. Between those two moments the theatre believes an implant is in the patient and the
 * stores ledger does not know it left the shelf — and a `lot_exhausted` refusal on the consumer
 * side is DEAD-LETTERED, silently, minutes after the nurse has moved on.
 *
 * The mutant gates on `explanted_at IS NULL` alone, which is a different question entirely and
 * signs the case out with an unconfirmed ledger fact.
 */
export async function deployingImplants(exec: Db | Tx, caseId: string): Promise<ImplantRow[]> {
  return exec.select().from(otCaseImplants).where(and(
    eq(otCaseImplants.caseId, caseId),
    eq(otCaseImplants.state, "deploying"),
    isNull(otCaseImplants.explantedAt),
  ));
}
