import { eq, inArray } from "drizzle-orm";
import { itemCategories, items, vendors } from "../../kernel/db/schema";
import { acceptSupplierBill, billDraftFromGrn, createSupplierBill, matchSupplierBill } from "../materials";
import { openHoldKinds } from "./holds";
import { billDraftFromSes } from "./service-entries";
import { proposeCredit, signedTaxTable } from "./tax-on-bill";
import type { Actor, WireGstCreditRule, WirePayBookDraft, WirePayBooked } from "@hmis/contracts";
import type { BillLineInput } from "../materials";
import type { Db } from "../../kernel/db/client";

/**
 * STORES S6a (#1116, flow step 2) — "Book bill" from the desk: the accounts officer types only what is on the paper (the
 * supplier's number and date; a line's quantity or rate when the paper differs). Everything else is the prefill from the
 * GRN (materials `billDraftFromGrn`) or the SES (`billDraftFromSes`). The bill is entered, matched, and booked when it
 * matches; a difference stays "Difference" for the materials head (materials `acceptBillDifference`, unchanged).
 *
 * S6b (#1116, decision 4): per Stores or service line HMIS proposes the GST credit mark (the signed table's, else "Not
 * available") and reverse charge; the officer confirms or changes them and types the IRN when the paper carries one.
 */
async function proposals(db: Db, vendorId: string, itemIds: readonly string[], ses: boolean): Promise<{
  marks: Map<string, { storesLine: boolean; gstCredit: WirePayBookDraft["lines"][number]["gstCredit"]; reverseCharge: boolean }>; einvoiceApplicable: boolean; tdsChecked: boolean;
}> {
  const [v] = await db.select({ gstin: vendors.gstin, einvoice: vendors.einvoiceApplicable }).from(vendors).where(eq(vendors.id, vendorId));
  const rows = itemIds.length === 0 ? [] : await db.select({ id: items.id, klass: items.class, trackMode: items.trackMode, catCode: itemCategories.code, catParent: itemCategories.parentId })
    .from(items).leftJoin(itemCategories, eq(itemCategories.id, items.categoryId)).where(inArray(items.id, [...itemIds]));
  const parents = [...new Set(rows.map((r) => r.catParent).filter((x): x is string => x !== null))];
  const tops = new Map(parents.length === 0 ? [] : (await db.select({ id: itemCategories.id, code: itemCategories.code }).from(itemCategories).where(inArray(itemCategories.id, parents))).map((c) => [c.id, c.code] as const));
  const table = await signedTaxTable(db, "gst_credit");
  const marks = new Map(rows.map((r) => {
    const storesLine = ses || (r.trackMode !== null && r.klass !== "drug");
    const p = storesLine ? proposeCredit(table?.rules as WireGstCreditRule[] | null, { catCode: r.catCode, topCode: r.catParent === null ? r.catCode : tops.get(r.catParent) ?? r.catCode }, (v?.gstin ?? null) !== null) : null;
    return [r.id, { storesLine, gstCredit: p?.credit ?? null, reverseCharge: p?.reverseCharge ?? false }] as const;
  }));
  return { marks, einvoiceApplicable: v?.einvoice === true, tdsChecked: (await signedTaxTable(db, "tds")) !== null };
}

export async function bookDraft(db: Db, actor: Actor, kind: "grn" | "ses", id: string): Promise<WirePayBookDraft> {
  const d = kind === "grn" ? await billDraftFromGrn(db, actor, id) : await billDraftFromSes(db, actor, id);
  const p = await proposals(db, d.vendorId, d.lines.map((l) => l.itemId), kind === "ses");
  const no = "grnNo" in d ? d.grnNo : d.sesNo;
  return {
    kind, id, no, vendorId: d.vendorId, vendorName: d.vendorName, poNo: d.poNo, vendorBillNo: d.vendorBillNo, billDate: d.billDate,
    lines: d.lines.map((l) => ({
      itemId: l.itemId, itemName: l.itemName, uom: l.uom, qtyPacks: l.qtyPacks, ratePaise: l.ratePaise, gstRateBps: l.gstRateBps,
      ...(p.marks.get(l.itemId) ?? { storesLine: false, gstCredit: null, reverseCharge: false }),
    })),
    expectedTotalPaise: d.expectedTotalPaise, einvoiceApplicable: p.einvoiceApplicable, tdsChecked: p.tdsChecked,
  };
}

export async function bookFromDesk(
  db: Db, actor: Actor,
  input: {
    kind: "grn" | "ses"; id: string; vendorBillNo: string; billDate: string; irn?: string | null;
    lines?: { itemId: string; qtyPacks: number; ratePaise: number; gstCredit?: BillLineInput["gstCredit"]; reverseCharge?: boolean | null }[];
  },
  now: Date = new Date(),
): Promise<WirePayBooked> {
  const draft = input.kind === "grn" ? await billDraftFromGrn(db, actor, input.id) : await billDraftFromSes(db, actor, input.id);
  const p = await proposals(db, draft.vendorId, draft.lines.map((l) => l.itemId), input.kind === "ses");
  const typed = new Map((input.lines ?? []).map((l) => [l.itemId, l] as const));
  const lines: BillLineInput[] = draft.lines.map((l) => {
    const t = typed.get(l.itemId);
    const m = p.marks.get(l.itemId);
    const marks = m?.storesLine === true
      ? { gstCredit: t?.gstCredit ?? m.gstCredit, ...((t?.reverseCharge ?? m.reverseCharge) ? { reverseCharge: true } : {}) }
      : {};
    return {
      ...(input.kind === "grn" ? { grnId: input.id } : { sesId: input.id }), itemId: l.itemId, uom: l.uom,
      qtyPacks: t?.qtyPacks ?? l.qtyPacks, ratePaise: t?.ratePaise ?? l.ratePaise, gstRateBps: l.gstRateBps, ...marks,
    };
  });
  const b = await createSupplierBill(db, actor, {
    vendorId: draft.vendorId, vendorBillNo: input.vendorBillNo, billDate: input.billDate, interState: draft.interState, lines,
    ...(input.irn === undefined || input.irn === null ? {} : { irn: input.irn }),
  }, { now });
  const m = await matchSupplierBill(db, actor, b.id, now);
  const done = m.status === "matched" ? await acceptSupplierBill(db, actor, b.id, now) : m;
  const kinds = await openHoldKinds(db, done.id, now);
  const status = kinds.length > 0 ? "on_hold" : done.status === "held_for_match" ? "difference" : done.status === "draft" ? "booked" : done.status === "matched" ? "matched" : "accepted";
  return { billId: done.id, billNo: done.billNo, status, totalPaise: done.totalPaise, holds: kinds };
}
