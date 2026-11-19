import { acceptSupplierBill, billDraftFromGrn, createSupplierBill, matchSupplierBill } from "../materials";
import { openHoldKinds } from "./holds";
import { billDraftFromSes } from "./service-entries";
import type { Actor, WirePayBookDraft, WirePayBooked } from "@hmis/contracts";
import type { BillLineInput } from "../materials";
import type { Db } from "../../kernel/db/client";

/**
 * STORES S6a (#1116, flow step 2) — "Book bill" from the desk: the accounts officer types only what is on the paper (the
 * supplier's number and date; a line's quantity or rate when the paper differs). Everything else is the prefill from the
 * GRN (materials `billDraftFromGrn`) or the SES (`billDraftFromSes`). The bill is entered, matched, and booked when it
 * matches; a difference stays "Difference" for the materials head (materials `acceptBillDifference`, unchanged).
 */
export async function bookDraft(db: Db, actor: Actor, kind: "grn" | "ses", id: string): Promise<WirePayBookDraft> {
  if (kind === "grn") {
    const d = await billDraftFromGrn(db, actor, id);
    return {
      kind, id, no: d.grnNo, vendorId: d.vendorId, vendorName: d.vendorName, poNo: d.poNo, vendorBillNo: d.vendorBillNo, billDate: d.billDate,
      lines: d.lines.map((l) => ({ itemId: l.itemId, itemName: l.itemName, uom: l.uom, qtyPacks: l.qtyPacks, ratePaise: l.ratePaise, gstRateBps: l.gstRateBps })),
      expectedTotalPaise: d.expectedTotalPaise,
    };
  }
  const d = await billDraftFromSes(db, actor, id);
  return {
    kind, id, no: d.sesNo, vendorId: d.vendorId, vendorName: d.vendorName, poNo: d.poNo, vendorBillNo: d.vendorBillNo, billDate: d.billDate,
    lines: d.lines.map((l) => ({ itemId: l.itemId, itemName: l.itemName, uom: l.uom, qtyPacks: l.qtyPacks, ratePaise: l.ratePaise, gstRateBps: l.gstRateBps })),
    expectedTotalPaise: d.expectedTotalPaise,
  };
}

export async function bookFromDesk(
  db: Db, actor: Actor, input: { kind: "grn" | "ses"; id: string; vendorBillNo: string; billDate: string; lines?: { itemId: string; qtyPacks: number; ratePaise: number }[] },
  now: Date = new Date(),
): Promise<WirePayBooked> {
  const draft = input.kind === "grn" ? await billDraftFromGrn(db, actor, input.id) : await billDraftFromSes(db, actor, input.id);
  const typed = new Map((input.lines ?? []).map((l) => [l.itemId, l] as const));
  const lines: BillLineInput[] = draft.lines.map((l) => {
    const t = typed.get(l.itemId);
    return {
      ...(input.kind === "grn" ? { grnId: input.id } : { sesId: input.id }), itemId: l.itemId, uom: l.uom,
      qtyPacks: t?.qtyPacks ?? l.qtyPacks, ratePaise: t?.ratePaise ?? l.ratePaise, gstRateBps: l.gstRateBps,
    };
  });
  const b = await createSupplierBill(db, actor, { vendorId: draft.vendorId, vendorBillNo: input.vendorBillNo, billDate: input.billDate, interState: draft.interState, lines }, { now });
  const m = await matchSupplierBill(db, actor, b.id, now);
  const done = m.status === "matched" ? await acceptSupplierBill(db, actor, b.id, now) : m;
  const kinds = await openHoldKinds(db, done.id, now);
  const status = kinds.length > 0 ? "on_hold" : done.status === "held_for_match" ? "difference" : done.status === "draft" ? "booked" : done.status === "matched" ? "matched" : "accepted";
  return { billId: done.id, billNo: done.billNo, status, totalPaise: done.totalPaise, holds: kinds };
}
