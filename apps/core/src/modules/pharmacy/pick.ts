import { and, eq } from "drizzle-orm";
import { appendEvent } from "../../kernel/events/append";
import { pharmacyDispenseLines, pharmacyDispenses } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { advanceOrderItem } from "../../kernel/orders/advance";
import { transition } from "../../kernel/workflow/instances";
import { balances, fefoPick, getBatch, reserveStock } from "../materials";
import { PICK_RESERVATION_MINUTES, istDateOf } from "./config";
import { dispensePicked } from "./events";
import { PharmacyError } from "./errors";
import { getDispense, getDispenseRow, linesOf } from "./queue";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { OrderKindDecl } from "../../kernel/orders/kinds";
import type { DispenseView } from "./queue";

export type PickLineInput = {
  lineIdx: number;
  /** D8 — short stock: the pharmacist dispenses LESS than verified, with a reason the line keeps. */
  qtyBase?: number;
  pickNote?: string;
  /** A later batch than FEFO offered (the patient asks for the longer-dated strip). Named, evented. */
  batchId?: string;
};
export type PickInput = { lines?: PickLineInput[] };

/**
 * PLAN 16c T4 / D2 — THE PICK IS A RESERVATION THE LEDGER HOLDS. ONE BATCH PER LINE.
 *
 * For every open line: FEFO offers the earliest-expiring batch at the counter's store
 * (`fefoPick`), and the line takes ONE batch — a strip is one batch, and a line that spans two
 * batches is two labels and two register rows for one prescription line, which this phase does
 * not do. When the first FEFO batch cannot cover the quantity the pharmacist chooses: a PARTIAL
 * dispense (a smaller `qtyBase` with a `pickNote`) or a later batch that can (`batchId`, an
 * override that is recorded, never silent). Neither choice is made for them.
 *
 * ═══ A1 (T4) — THE LAST TEN TABLETS ═══
 *
 * Two dispenses picking the last ten of one batch race on `reserveStock`, which takes the ledger's
 * balance lock and refuses the second with `insufficient_stock` (Plan 14 T5's A8, applied to
 * reservations). Nothing here reads a balance and then writes one; the ledger does both under
 * its lock, which is why the pharmacy never writes stock itself.
 */
export async function pickDispense(
  db: Db,
  actor: Actor,
  decls: readonly OrderKindDecl[],
  dispenseId: string,
  input: PickInput,
  now: Date,
): Promise<DispenseView> {
  const d = await getDispenseRow(db, dispenseId);
  if (d.status !== "verified") throw new PharmacyError("dispense_not_in_state", `dispense ${d.id} is ${d.status}, not verified`, { status: d.status });
  if (d.storeResourceId === null) throw new PharmacyError("store_missing", "the claim named no store");
  const store = d.storeResourceId;
  const lines = await linesOf(db, dispenseId);
  const edits = new Map((input.lines ?? []).map((l) => [l.lineIdx, l]));

  type Plan = { lineId: string; lineIdx: number; itemId: string; batchId: string; qtyBase: number; fefoOverride: boolean; pickNote: string | null };
  const plan: Plan[] = [];
  for (const line of lines) {
    if (line.status !== "open") continue;
    if (line.itemId === null || line.qtyBase === null) throw new PharmacyError("qty_required", `line ${String(line.lineIdx + 1)} has no item or quantity`);
    const edit = edits.get(line.lineIdx);
    const qty = edit?.qtyBase ?? line.qtyBase;
    if (!Number.isSafeInteger(qty) || qty <= 0 || qty > line.qtyBase) {
      throw new PharmacyError("qty_required", `line ${String(line.lineIdx + 1)}: a pick is a positive quantity no larger than the verified ${String(line.qtyBase)}`, { lineIdx: line.lineIdx });
    }
    const partial = qty < line.qtyBase;
    const note = edit?.pickNote?.trim() ?? "";
    if (partial && note === "") throw new PharmacyError("qty_required", `line ${String(line.lineIdx + 1)}: a partial dispense needs a reason`, { lineIdx: line.lineIdx });

    if (edit?.batchId !== undefined) {
      const rows = await balances(db, { resourceId: store, batchId: edit.batchId });
      const batch = await getBatch(db, edit.batchId);
      const available = rows.reduce((n, b) => n + b.qtyOnHand - b.qtyReserved - b.qtyFrozen, 0);
      /**
       * A NAMED batch is told WHY (close review, second contract sweep). `fefoPick` now excludes an
       * expired batch silently, which is right for an automatic choice; but when the pharmacist
       * names one — the patient asked for the longer-dated strip and read the wrong carton — the
       * counter says what is wrong with it rather than "cannot cover 20".
       */
      if (batch !== undefined && batch.expiryDate !== null && batch.expiryDate < istDateOf(now)) {
        throw new PharmacyError(
          "batch_expired",
          `line ${String(line.lineIdx + 1)}: batch ${batch.batchNo} expired on ${batch.expiryDate} — it cannot be dispensed`,
          { lineIdx: line.lineIdx, batchId: edit.batchId, expiryDate: batch.expiryDate },
        );
      }
      if (batch === undefined || batch.itemId !== line.itemId || batch.recallStatus !== "none" || available < qty) {
        throw new PharmacyError("fefo_override_unavailable", `line ${String(line.lineIdx + 1)}: batch ${edit.batchId} cannot cover ${String(qty)} at this store`, { lineIdx: line.lineIdx, available });
      }
      const offered = await fefoPick(db, store, line.itemId, qty, now);
      plan.push({ lineId: line.id, lineIdx: line.lineIdx, itemId: line.itemId, batchId: edit.batchId, qtyBase: qty, fefoOverride: offered[0]?.batchId !== edit.batchId, pickNote: partial ? note : null });
      continue;
    }
    const offered = await fefoPick(db, store, line.itemId, qty, now);
    const first = offered[0];
    if (first === undefined || first.qty < qty) {
      const all = await balances(db, { resourceId: store, itemId: line.itemId });
      const available = all.reduce((n, b) => n + b.qtyOnHand - b.qtyReserved - b.qtyFrozen, 0);
      throw new PharmacyError(
        "short_stock",
        `line ${String(line.lineIdx + 1)}: the earliest batch holds ${String(first?.qty ?? 0)} of ${String(qty)} (${String(available)} across batches) — dispense a partial quantity with a reason, or choose a batch that covers it`,
        { lineIdx: line.lineIdx, offered, available },
      );
    }
    plan.push({ lineId: line.id, lineIdx: line.lineIdx, itemId: line.itemId, batchId: first.batchId, qtyBase: qty, fefoOverride: false, pickNote: partial ? note : null });
  }
  if (plan.length === 0) throw new PharmacyError("nothing_to_dispense", "no open line to pick");

  await withTx(db, async (tx) => {
    const expiresAt = new Date(now.getTime() + PICK_RESERVATION_MINUTES * 60_000);
    for (const p of plan) {
      const { reservationId } = await reserveStock(tx, actor, { resourceId: store, batchId: p.batchId, qty: p.qtyBase, refType: "pharmacy_dispense", refId: p.lineId, expiresAt });
      await tx.update(pharmacyDispenseLines)
        .set({ batchId: p.batchId, reservationId, qtyBase: p.qtyBase, fefoOverride: p.fefoOverride, pickNote: p.pickNote })
        .where(eq(pharmacyDispenseLines.id, p.lineId));
      const line = lines.find((l) => l.id === p.lineId)!;
      if (line.orderItemId !== null) await advanceOrderItem(tx, actor, decls, line.orderItemId, "in_progress", { at: now });
    }
    const won = await tx.update(pharmacyDispenses)
      .set({ status: "picked", pickedBy: actor.id, pickedAt: now })
      .where(and(eq(pharmacyDispenses.id, d.id), eq(pharmacyDispenses.status, "verified")))
      .returning({ id: pharmacyDispenses.id });
    if (won.length === 0) throw new PharmacyError("dispense_not_in_state", `dispense ${d.id} moved while picking`);
    if (d.workflowInstanceId !== null) await transition(tx, d.workflowInstanceId, "picked", actor);
    await appendEvent(tx, dispensePicked.make({
      actor, patientId: d.patientId, encounterId: d.encounterId, correlationId: d.id,
      payload: { dispenseId: d.id, patientId: d.patientId, lines: plan.map((p) => ({ lineIdx: p.lineIdx, batchId: p.batchId, qtyBase: p.qtyBase, fefoOverride: p.fefoOverride })) },
    }));
  });
  return getDispense(db, actor, d.id);
}
