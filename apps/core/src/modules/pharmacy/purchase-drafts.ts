import {
  contractRatesFor, createPurchaseOrder, findStoreByCode, getVendor, itemsByIds, lastPurchaseByItem, lineGstPaise, uomsByItems, vendorRates,
} from "../materials";
import { OPD_PHARMACY_STORE_CODE, PURCHASE_DEFAULT_LEAD_DAYS, istDateOf } from "./config";
import { PharmacyError } from "./errors";
import { reorderAdvice } from "./replenishment";
import { listOpenShortBook } from "./short-book";
import type { PoView, VendorRateView } from "../materials";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PARITY P2 — THE AGENT DRAFTS THE ORDERS; A PERSON SENDS THEM ═══
 *
 * Plan `docs/superpowers/plans/2026-09-24-pharmacy-healthray-parity.md` P2: "the agent drafts a PO per
 * vendor from reorder + short book, priced at the last PTR". Two halves, and only the second writes:
 *
 *   - `planPurchaseDrafts` READS: the reorder list's `orderBase` (levels, or cover when no store can
 *     send it) and the open short book, grouped by the vendor who last supplied each item, priced at
 *     that receipt's rate. An item nobody has supplied, or whose last supplier is no longer active,
 *     goes to `unassigned` for a person to give a vendor. A short-book row with no item is `unmatched`:
 *     it names a drug the stores do not carry yet. An item already on a draft or awaiting approval is
 *     `alreadyDrafted` and not drafted twice. The copilot's `draft_purchase_orders` tool calls this
 *     and nothing else.
 *   - `draftPurchaseOrders` WRITES DRAFTS ONLY, when a person presses the button: one draft per vendor,
 *     `source = 'agent'`, through materials' own `createPurchaseOrder` (which checks the person's
 *     `materials.po.raise`). Every draft still needs a submit, an approval by somebody else, and a send.
 */
export type DraftReason = "reorder" | "short_book";

export type DraftLine = {
  itemId: string;
  code: string;
  name: string;
  baseUom: string;
  uom: string;
  multiplier: number;
  needBase: number;
  qtyPacks: number;
  ratePaise: number;
  gstRateBps: number;
  mrpPaise: number | null;
  lineTotalPaise: number;
  reasons: DraftReason[];
  shortBookIds: string[];
  /** The receipt the rate came from, when there is one. */
  lastGrnNo: string | null;
  /**
   * Owner 2026-10-04 — where the rate came from: a vendor's rate CONTRACT in force (the cheapest per base unit
   * among active vendors — it also chooses the vendor), else the LAST paid receipt, else nothing.
   */
  rateSource: "contract" | "last" | "none";
};

export type DraftGroup = {
  vendorId: string;
  vendorCode: string;
  vendorName: string;
  lines: DraftLine[];
  subtotalPaise: number;
  gstPaise: number;
  totalPaise: number;
};

export type UnassignedLine = DraftLine & { why: "no_history" | "vendor_inactive" };

export type PurchasePlan = {
  storeResourceId: string;
  storeCode: string;
  expectedDate: string;
  groups: DraftGroup[];
  unassigned: UnassignedLine[];
  unmatched: { shortBookId: string; drugName: string }[];
  alreadyDrafted: { itemId: string; code: string; name: string; inDraftBase: number }[];
};

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function planPurchaseDrafts(db: Db, now: Date = new Date()): Promise<PurchasePlan> {
  const store = await findStoreByCode(db, OPD_PHARMACY_STORE_CODE);
  if (store === undefined) throw new PharmacyError("store_missing", `the OPD pharmacy store ${OPD_PHARMACY_STORE_CODE} does not exist — run seed:pharmacy`);
  const [advice, shortRows] = await Promise.all([reorderAdvice(db, now), listOpenShortBook(db)]);
  const byItem = new Map(advice.items.map((l) => [l.itemId, l]));

  // What each item needs, and why. The reorder list first; the short book adds its rows.
  const need = new Map<string, { needBase: number; reasons: Set<DraftReason>; shortBookIds: string[] }>();
  const alreadyDrafted = new Map<string, number>();
  for (const l of advice.items) {
    if (l.inDraftBase > 0) { alreadyDrafted.set(l.itemId, l.inDraftBase); continue; }
    if (l.orderBase > 0) need.set(l.itemId, { needBase: l.orderBase, reasons: new Set(["reorder"]), shortBookIds: [] });
  }
  const unmatched: PurchasePlan["unmatched"] = [];
  for (const row of shortRows) {
    if (row.itemId === null) { unmatched.push({ shortBookId: row.id, drugName: row.drugName }); continue; }
    if (alreadyDrafted.has(row.itemId) || (byItem.get(row.itemId)?.inDraftBase ?? 0) > 0) {
      alreadyDrafted.set(row.itemId, byItem.get(row.itemId)?.inDraftBase ?? alreadyDrafted.get(row.itemId) ?? 0);
      continue;
    }
    const cur = need.get(row.itemId) ?? { needBase: 0, reasons: new Set<DraftReason>(), shortBookIds: [] };
    cur.reasons.add("short_book");
    cur.shortBookIds.push(row.id);
    // `qty_wanted` is what the pharmacist said, in base units; nothing said means one pack (below).
    cur.needBase = Math.max(cur.needBase, row.qtyWanted ?? 0);
    need.set(row.itemId, cur);
  }

  const ids = [...need.keys()];
  const [items, packs, last, contracts] = await Promise.all([
    itemsByIds(db, [...ids, ...alreadyDrafted.keys()]), uomsByItems(db, ids), lastPurchaseByItem(db, ids), contractRatesFor(db, ids, now),
  ]);

  const groups = new Map<string, DraftLine[]>();
  const unassigned: UnassignedLine[] = [];
  for (const [itemId, n] of need) {
    const item = items.get(itemId);
    if (item === undefined || !item.active) continue;
    const bought = last.get(itemId);
    const contract = contracts.get(itemId)?.[0];
    const largest = [...(packs.get(itemId) ?? [])].sort((a, b) => b.toBaseMultiplier - a.toBaseMultiplier)[0];
    const uom = contract?.uom ?? bought?.uom ?? largest?.uom ?? item.baseUom;
    const multiplier = contract?.multiplier ?? bought?.multiplier ?? largest?.toBaseMultiplier ?? 1;
    const qtyPacks = Math.max(1, Math.ceil(n.needBase / multiplier));
    const ratePaise = contract?.ratePaise ?? bought?.ratePaise ?? 0;
    const gstRateBps = contract?.gstRateBps ?? item.gstRateBps ?? 0;
    const line: DraftLine = {
      itemId, code: item.code, name: item.name, baseUom: item.baseUom, uom, multiplier,
      needBase: n.needBase === 0 ? multiplier : n.needBase, qtyPacks, ratePaise, gstRateBps,
      mrpPaise: contract?.mrpPaise ?? bought?.mrpPaise ?? null, lineTotalPaise: qtyPacks * ratePaise,
      reasons: [...n.reasons].sort(), shortBookIds: n.shortBookIds, lastGrnNo: bought?.grnNo ?? null,
      rateSource: contract !== undefined ? "contract" : bought !== undefined ? "last" : "none",
    };
    // A rate contract in force chooses the vendor (only active vendors' rates are in force at all).
    if (contract !== undefined) groups.set(contract.vendorId, [...(groups.get(contract.vendorId) ?? []), line]);
    else if (bought === undefined) unassigned.push({ ...line, why: "no_history" });
    else if (!bought.vendorActive) unassigned.push({ ...line, why: "vendor_inactive" });
    else groups.set(bought.vendorId, [...(groups.get(bought.vendorId) ?? []), line]);
  }

  const out: DraftGroup[] = [];
  for (const [vendorId, lines] of groups) {
    const v = await getVendor(db, vendorId);
    lines.sort((a, b) => a.name.localeCompare(b.name));
    const subtotalPaise = lines.reduce((s, l) => s + l.lineTotalPaise, 0);
    const gstPaise = lines.reduce((s, l) => s + lineGstPaise(l.lineTotalPaise, l.gstRateBps), 0);
    out.push({
      vendorId, vendorCode: v?.code ?? "", vendorName: v?.tradeName ?? v?.legalName ?? vendorId,
      lines, subtotalPaise, gstPaise, totalPaise: subtotalPaise + gstPaise,
    });
  }
  out.sort((a, b) => b.totalPaise - a.totalPaise || a.vendorName.localeCompare(b.vendorName));
  unassigned.sort((a, b) => a.name.localeCompare(b.name));

  return {
    storeResourceId: store.id, storeCode: store.code,
    expectedDate: addDays(istDateOf(now), PURCHASE_DEFAULT_LEAD_DAYS),
    groups: out, unassigned, unmatched,
    alreadyDrafted: [...alreadyDrafted].map(([itemId, inDraftBase]) => {
      const item = items.get(itemId);
      return { itemId, code: item?.code ?? "", name: item?.name ?? itemId, inDraftBase };
    }).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * The person's "make the drafts". `assign` gives an unassigned item a vendor (and, since it has no
 * last rate, optionally a rate per pack); an unassigned item left out stays off every draft.
 * Returns the drafts written — none when the plan is empty.
 */
export async function draftPurchaseOrders(
  db: Db, actor: Actor, now: Date = new Date(),
  assign: readonly { itemId: string; vendorId: string; ratePaise?: number }[] = [],
): Promise<PoView[]> {
  const plan = await planPurchaseDrafts(db, now);
  const byVendor = new Map<string, DraftLine[]>(plan.groups.map((g) => [g.vendorId, [...g.lines]]));
  for (const a of assign) {
    const line = plan.unassigned.find((u) => u.itemId === a.itemId);
    if (line === undefined) continue;
    const ratePaise = a.ratePaise ?? line.ratePaise;
    byVendor.set(a.vendorId, [...(byVendor.get(a.vendorId) ?? []), { ...line, ratePaise, lineTotalPaise: line.qtyPacks * ratePaise }]);
  }
  const drafts: PoView[] = [];
  for (const [vendorId, lines] of byVendor) {
    if (lines.length === 0) continue;
    drafts.push(await createPurchaseOrder(db, actor, {
      vendorId, storeResourceId: plan.storeResourceId, expectedDate: plan.expectedDate,
      note: "Drafted by the pharmacy agent from the reorder list and the short book — check quantities and rates before submitting.",
      lines: lines.map((l) => ({
        itemId: l.itemId, uom: l.uom, qtyPacks: l.qtyPacks, ratePaise: l.ratePaise, gstRateBps: l.gstRateBps, mrpPaise: l.mrpPaise,
      })),
    }, { source: "agent", now }));
  }
  return drafts;
}

// ═══════════════════ OWNER 2026-10-04 — AN ORDER FROM A VENDOR'S RATE CONTRACT ═══════════════════

export type RateSheetLine = VendorRateView & {
  /** The last PAID receipt's rate per this pack, from any vendor — to see the contract against what was paid. */
  lastPaidPaise: number | null;
  lastVendorId: string | null;
};

/** A vendor's contracted items as the office orders from them: the rate, and what was last paid. */
export async function vendorRateSheet(db: Db, actor: Actor, vendorId: string): Promise<RateSheetLine[]> {
  const rates = await vendorRates(db, actor, vendorId);
  const last = await lastPurchaseByItem(db, rates.map((r) => r.itemId));
  return rates.map((r) => {
    const b = last.get(r.itemId);
    const paid = b === undefined ? null : Math.round((b.ratePaise * r.multiplier) / b.multiplier);
    return { ...r, lastPaidPaise: paid, lastVendorId: b?.vendorId ?? null };
  });
}

/**
 * "Order these from this vendor at its contracted rates." A DRAFT order — every line priced by the server
 * from the contract in force today, never by the screen — through materials' own `createPurchaseOrder` (its
 * `materials.po.raise`, its approval tiers). An item without a rate in force from this vendor is refused,
 * named. `freePacks` is the vendor's scheme or a free first supply: received on the GRN as free goods.
 */
export async function orderFromRates(
  db: Db, actor: Actor, vendorId: string, lines: readonly { itemId: string; qtyPacks: number; freePacks?: number }[], now: Date = new Date(),
): Promise<PoView> {
  if (lines.length === 0) throw new PharmacyError("nothing_to_dispense", "no quantities were entered");
  const store = await findStoreByCode(db, OPD_PHARMACY_STORE_CODE);
  if (store === undefined) throw new PharmacyError("store_missing", `the OPD pharmacy store ${OPD_PHARMACY_STORE_CODE} does not exist — run seed:pharmacy`);
  const contracts = await contractRatesFor(db, lines.map((l) => l.itemId), now);
  const priced = lines.map((l) => ({ l, c: (contracts.get(l.itemId) ?? []).find((x) => x.vendorId === vendorId) }));
  const missing = priced.filter((x) => x.c === undefined).map((x) => x.l.itemId);
  if (missing.length > 0) {
    const names = await itemsByIds(db, missing);
    throw new PharmacyError("invalid_range", `no rate in force from this vendor for ${missing.map((id) => names.get(id)?.name ?? id).join(", ")} — record the rate first`, { itemIds: missing });
  }
  const v = await getVendor(db, vendorId);
  return createPurchaseOrder(db, actor, {
    vendorId, storeResourceId: store.id, expectedDate: addDays(istDateOf(now), PURCHASE_DEFAULT_LEAD_DAYS),
    note: `Ordered at ${v?.tradeName ?? v?.legalName ?? "the vendor"}'s contracted rates.`,
    lines: priced.map(({ l, c }) => ({
      itemId: l.itemId, uom: c!.uom, qtyPacks: l.qtyPacks, freePacks: l.freePacks ?? 0, ratePaise: c!.ratePaise, gstRateBps: c!.gstRateBps, mrpPaise: c!.mrpPaise,
    })),
  }, { source: "manual", now });
}
