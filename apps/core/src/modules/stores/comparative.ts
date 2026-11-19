import { asc, eq, inArray } from "drizzle-orm";
import { items, storesBuyGroupMoves, storesPurchaseRequests, storesQuoteAdmissions, storesQuoteLines, storesQuoteTechnical, storesQuotes, storesRfqInvitees, storesRfqLines } from "../../kernel/db/schema";
import { STORES_AWARD_SIGN, STORES_BUYING_MANAGE, STORES_INDENTS_APPROVE, STORES_MASTERS, holds } from "./access";
import { apportion, ex, holdsRole, latestByVendor, lineMoney, rfqClock, vendorNames } from "./buying-common";
import { StoresError } from "./errors";
import { requireRfq } from "./rfq";
import type { StoresBand, WireCmpLine, WireCmpSupplier, WireComparative } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * STORES S5b (#1115, decision 8) — THE COMPARATIVE STATEMENT, RECOMPUTED FROM QUOTE LINES ON EVERY READ, NEVER STORED.
 *
 * Sealed (decision 7) until the reply-by instant passes or every invitee has quoted: until then the read says only
 * "n of m received" and carries no supplier and no line. Unsealed, per supplier (its newest version) per line: rate,
 * discount, taxable (quantity × the net rate, the PO's own rounding), GST half up per line, freight and other charges
 * spread over its lines by value, landed = taxable + GST + freight + other. The landed total INCLUDES GST because Stores
 * input GST is not credited by default (ruling 0101 Q2); the total before GST is shown beside it.
 *
 * Ranks: L1/L2/L3 per line among the suppliers that quoted it, and on the whole among those that quoted every line. Out
 * of the ranks: a late quote not admitted by the materials head, and for equipment any supplier whose technical
 * compliance is not Yes from BOTH the user HOD and biomedical (a No needs a reason). Ties: fewer delivery days, then
 * the supplier code (edge case 3; the scorecard joins in S5c). Payment terms, delivery and warranty are shown, never
 * scored (DECIDED: humans judge).
 */
type RfqRow = Awaited<ReturnType<typeof requireRfq>>;
export type CmpFull = WireComparative & { codes: Map<string, string> };

export async function computeComparative(db: Db | Tx, rfq: RfqRow, now: Date): Promise<CmpFull> {
  const clock = await rfqClock(db, rfq);
  const invited = (await ex(db).select({ v: storesRfqInvitees.vendorId }).from(storesRfqInvitees).where(eq(storesRfqInvitees.rfqId, rfq.id))).map((r) => r.v);
  const quotes = await ex(db).select().from(storesQuotes).where(eq(storesQuotes.rfqId, rfq.id));
  const latest = latestByVendor(quotes);
  const received = latest.size;
  const sealed = now.getTime() < clock.replyBy.getTime() && received < invited.length;
  const base = {
    rfqId: rfq.id, rfqNo: rfq.rfqNo, band: rfq.band as StoresBand, equipment: rfq.equipment, sealed, received, invited: invited.length,
    replyBy: clock.replyBy.toISOString(), reinvite: false, suppliers: [] as WireCmpSupplier[], lines: [] as WireCmpLine[], codes: new Map<string, string>(),
  };
  if (sealed) return base;

  const rfqLines = await ex(db).select({ l: storesRfqLines, name: items.name, uom: items.baseUom }).from(storesRfqLines).innerJoin(items, eq(items.id, storesRfqLines.itemId))
    .where(eq(storesRfqLines.rfqId, rfq.id)).orderBy(asc(storesRfqLines.lineIdx));
  const chosen = [...latest.values()];
  const qLines = chosen.length === 0 ? [] : await ex(db).select().from(storesQuoteLines).where(inArray(storesQuoteLines.quoteId, chosen.map((q) => q.id)));
  const admitted = new Set(chosen.length === 0 ? [] : (await ex(db).select({ q: storesQuoteAdmissions.quoteId }).from(storesQuoteAdmissions)
    .where(inArray(storesQuoteAdmissions.quoteId, chosen.map((q) => q.id)))).map((r) => r.q));
  const marks = rfq.equipment ? await ex(db).select().from(storesQuoteTechnical).where(eq(storesQuoteTechnical.rfqId, rfq.id)) : [];
  const names = await vendorNames(db, chosen.map((q) => q.vendorId));

  type Cell = WireCmpLine["cells"][number];
  const cells = new Map<string, Map<string, Cell>>(); // itemId → vendorId → cell
  const suppliers: (WireCmpSupplier & { inRanks: boolean; quotedAll: boolean })[] = [];
  for (const q of chosen) {
    const mine = rfqLines.map((r) => ({ r, ql: qLines.find((x) => x.quoteId === q.id && x.itemId === r.l.itemId) })).filter((x) => x.ql !== undefined);
    const money = mine.map(({ r, ql }) => ({ itemId: r.l.itemId, ql: ql!, m: lineMoney(r.l.qtyBase, ql!.ratePaise, ql!.discountBps, ql!.gstRateBps) }));
    const fr = apportion(q.freightPaise, money.map((x) => x.m.taxablePaise));
    const ot = apportion(q.otherPaise, money.map((x) => x.m.taxablePaise));
    money.forEach((x, i) => {
      const cell: Cell = {
        vendorId: q.vendorId, ratePaise: x.ql.ratePaise, discountPaise: x.m.discountPaise, taxablePaise: x.m.taxablePaise, gstPaise: x.m.gstPaise,
        freightPaise: fr[i]!, otherPaise: ot[i]!, landedPaise: x.m.taxablePaise + x.m.gstPaise + fr[i]! + ot[i]!, rank: null,
      };
      if (!cells.has(x.itemId)) cells.set(x.itemId, new Map());
      cells.get(x.itemId)!.set(q.vendorId, cell);
    });
    const sum = (f: (m: (typeof money)[number]["m"]) => number): number => money.reduce((a, x) => a + f(x.m), 0);
    const taxable = sum((m) => m.taxablePaise);
    const gst = sum((m) => m.gstPaise);
    let technical: WireCmpSupplier["technical"] = null;
    if (rfq.equipment) {
      const mk = marks.filter((m) => m.vendorId === q.vendorId);
      technical = mk.some((m) => !m.compliant) ? "no" : mk.some((m) => m.role === "hod") && mk.some((m) => m.role === "biomedical") ? "yes" : "pending";
    }
    const lateOut = q.late && !admitted.has(q.id);
    suppliers.push({
      vendorId: q.vendorId, name: names.get(q.vendorId)?.name ?? q.vendorId, quoteId: q.id, version: q.version, kind: q.kind as WireCmpSupplier["kind"],
      late: q.late, admitted: admitted.has(q.id), technical, wholeRank: null, paymentTermsDays: q.paymentTermsDays, deliveryDays: q.deliveryDays,
      warrantyMonths: q.warrantyMonths,
      totals: {
        grossPaise: sum((m) => m.grossPaise), discountPaise: sum((m) => m.discountPaise), taxablePaise: taxable, gstPaise: gst,
        freightPaise: q.freightPaise, otherPaise: q.otherPaise, beforeGstPaise: taxable + q.freightPaise + q.otherPaise,
        landedPaise: taxable + gst + q.freightPaise + q.otherPaise,
      },
      inRanks: !lateOut && (technical === null || technical === "yes"), quotedAll: money.length === rfqLines.length,
    });
  }
  const codes = await vendorNames(db, suppliers.map((s) => s.vendorId));
  const tie = (a: { vendorId: string; deliveryDays: number | null }, b: { vendorId: string; deliveryDays: number | null }): number =>
    (a.deliveryDays ?? 9_999) - (b.deliveryDays ?? 9_999) || (codes.get(a.vendorId)?.code ?? a.vendorId).localeCompare(codes.get(b.vendorId)?.code ?? b.vendorId);
  const ranked = suppliers.filter((s) => s.inRanks);
  ranked.filter((s) => s.quotedAll).sort((a, b) => a.totals.landedPaise - b.totals.landedPaise || tie(a, b)).forEach((s, i) => { s.wholeRank = i + 1; });
  const lines: WireCmpLine[] = rfqLines.map((r) => {
    const row = cells.get(r.l.itemId) ?? new Map<string, Cell>();
    const order = ranked.filter((s) => row.has(s.vendorId)).sort((a, b) => row.get(a.vendorId)!.landedPaise - row.get(b.vendorId)!.landedPaise || tie(a, b));
    order.forEach((s, i) => { row.get(s.vendorId)!.rank = i + 1; });
    return { itemId: r.l.itemId, itemName: r.name, baseUom: r.uom, qtyBase: r.l.qtyBase, cells: suppliers.map((s) => row.get(s.vendorId)).filter((c): c is Cell => c !== undefined) };
  });
  const order = (s: { wholeRank: number | null; totals: { landedPaise: number } }): number => (s.wholeRank ?? 1_000) * 1e13 + s.totals.landedPaise;
  return {
    ...base, reinvite: rfq.band !== "A" && ranked.length < 3, codes: new Map([...codes].map(([k, v]) => [k, v.code])),
    suppliers: suppliers.sort((a, b) => order(a) - order(b)).map((s): WireCmpSupplier => ({
      vendorId: s.vendorId, name: s.name, quoteId: s.quoteId, version: s.version, kind: s.kind, late: s.late, admitted: s.admitted, technical: s.technical,
      wholeRank: s.wholeRank, paymentTermsDays: s.paymentTermsDays, deliveryDays: s.deliveryDays, warrantyMonths: s.warrantyMonths, totals: s.totals,
    })), lines,
  };
}

/** Who reads a comparative: the buyer, the materials head, a committee member, the owner, the user HOD of the group. */
export async function requireBuyingReader(db: Db | Tx, actor: Actor, groupId: string | null): Promise<void> {
  if (await holds(db, actor, STORES_BUYING_MANAGE) || await holds(db, actor, STORES_MASTERS) || await holds(db, actor, STORES_AWARD_SIGN)
    || await holdsRole(db, actor, "owner")) return;
  if (groupId !== null) {
    const depts = await ex(db).selectDistinct({ d: storesPurchaseRequests.departmentId }).from(storesBuyGroupMoves)
      .innerJoin(storesPurchaseRequests, eq(storesPurchaseRequests.id, storesBuyGroupMoves.prId)).where(eq(storesBuyGroupMoves.groupId, groupId));
    for (const { d } of depts) if (d !== null && (await holds(db, actor, STORES_INDENTS_APPROVE, d) || await holds(db, actor, STORES_AWARD_SIGN, d))) return;
  }
  throw new StoresError("not_permitted", "the comparative is the buyer's, the materials head's and the committee's", { permission: STORES_BUYING_MANAGE });
}

export async function comparativeStatement(db: Db, actor: Actor, rfqId: string, now: Date = new Date()): Promise<WireComparative> {
  const rfq = await requireRfq(db, rfqId);
  await requireBuyingReader(db, actor, rfq.groupId);
  const full: Partial<CmpFull> = await computeComparative(db, rfq, now);
  delete full.codes;
  return full as WireComparative;
}
