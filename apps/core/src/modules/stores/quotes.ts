import { and, asc, eq, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import {
  items, roleAssignments, storesBuyGroupMoves, storesPurchaseRequests, storesQuoteAdmissions, storesQuoteLines, storesQuoteTechnical, storesQuotes,
  storesRfqInvitees, storesRfqLines,
} from "../../kernel/db/schema";
import { STORES_BUYING_MANAGE, STORES_INDENTS_APPROVE, STORES_MASTERS, holds, recordAct } from "./access";
import { bandOfLines, requireGroup } from "./buy-groups";
import { byItem, clean, ex, groupLines, latestByVendor, lineMoney, requireCanQuote, rfqClock } from "./buying-common";
import { computeComparative } from "./comparative";
import { StoresError } from "./errors";
import { requireRfq } from "./rfq";
import type { WireQuote } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * STORES S5b (#1115, decision 7) — QUOTES, APPEND-ONLY.
 *
 * Typed by hand line by line (each line confirmed by the person who typed it: `confirmed_by`), for an RFQ's invitee or,
 * in band A, the group's one quote (a quote row too, checked against the last price when the PO is made). A revision is
 * a new version, the old one kept: `revised` while sealed; after unsealing only L1 may revise, and only downward, as
 * `negotiated` (`only_l1_negotiates`, `negotiation_upward`; DECIDED, public-purchase practice). A quote entered after
 * the reply-by instant is `late` and stays out of the ranks until the materials head admits it with a reason. While
 * sealed, the person who typed a quote may open that quote only, and each open is an act. The user HOD and biomedical
 * mark an equipment offer's technical compliance (Yes, or No with a reason).
 */
type QuoteLineInput = { itemId: string; qtyBase?: number | null; ratePaise: number; discountBps?: number | null; gstRateBps?: number | null };
export type EnterQuoteInput = {
  groupId?: string | null; rfqId?: string | null; vendorId: string; supplierRef?: string | null; lines: QuoteLineInput[];
  freightPaise?: number | null; otherPaise?: number | null; paymentTermsDays?: number | null; deliveryDays?: number | null; warrantyMonths?: number | null;
  documentKey?: string | null;
};
type QuoteRow = typeof storesQuotes.$inferSelect;

async function requireBuyer(db: Db | Tx, actor: Actor): Promise<void> {
  if (!(await holds(db, actor, STORES_BUYING_MANAGE))) throw new StoresError("not_permitted", "quotes are entered at the buying desk", { permission: STORES_BUYING_MANAGE });
}

export async function enterQuote(db: Db, actor: Actor, input: EnterQuoteInput, now: Date = new Date()): Promise<WireQuote> {
  await requireBuyer(db, actor);
  if (input.lines.length === 0) throw new StoresError("item_required", "a quote has at least one line");
  let groupId: string;
  let rfq: Awaited<ReturnType<typeof requireRfq>> | null = null;
  let asked: Map<string, number>;
  let late = false;
  if (input.rfqId != null) {
    rfq = await requireRfq(db, input.rfqId);
    groupId = rfq.groupId;
    const clock = await rfqClock(db, rfq);
    if (clock.closed) throw new StoresError("rfq_closed", "this RFQ is closed");
    if (!clock.sentTo.has(input.vendorId)) {
      const [inv] = await db.select({ id: storesRfqInvitees.id }).from(storesRfqInvitees).where(and(eq(storesRfqInvitees.rfqId, rfq.id), eq(storesRfqInvitees.vendorId, input.vendorId)));
      throw inv === undefined ? new StoresError("not_invited", "this supplier was not invited") : new StoresError("rfq_not_sent", "this supplier has not been sent the RFQ");
    }
    late = now.getTime() > clock.replyBy.getTime();
    asked = new Map((await db.select().from(storesRfqLines).where(eq(storesRfqLines.rfqId, rfq.id))).map((l) => [l.itemId, l.qtyBase] as const));
  } else {
    if (input.groupId == null) throw new StoresError("unknown_group", "name the group or the RFQ");
    groupId = (await requireGroup(db, input.groupId)).id;
    const lines = await groupLines(db, groupId);
    if ((await bandOfLines(db, lines, now)).band !== "A") throw new StoresError("rfq_needed", "three quotes are needed: make an RFQ");
    asked = new Map(byItem(lines.filter((l) => !l.onContract)).map((l) => [l.itemId, l.qtyBase] as const));
  }
  await requireCanQuote(db, input.vendorId, now);
  const itemRows = await db.select({ id: items.id, gst: items.gstRateBps }).from(items).where(inArray(items.id, input.lines.map((l) => l.itemId)));
  const gstOf = new Map(itemRows.map((i) => [i.id, i.gst ?? 0] as const));
  const seen = new Set<string>();
  const lines = input.lines.map((l) => {
    const qty = asked.get(l.itemId);
    if (qty === undefined) throw new StoresError("not_in_group", "this item is not asked for here", { itemId: l.itemId });
    if (seen.has(l.itemId)) throw new StoresError("bad_quantity", "an item appears twice in one quote", { itemId: l.itemId });
    seen.add(l.itemId);
    const okInt = (n: number, lo: number, hi: number): boolean => Number.isSafeInteger(n) && n >= lo && n <= hi;
    const discountBps = l.discountBps ?? 0;
    const gstRateBps = l.gstRateBps ?? gstOf.get(l.itemId) ?? 0;
    if (!okInt(l.ratePaise, 0, 1_000_000_000) || !okInt(discountBps, 0, 10_000) || !okInt(gstRateBps, 0, 2_800)) {
      throw new StoresError("bad_quantity", "rate, discount or GST is out of range", { itemId: l.itemId });
    }
    // An RFQ's quote is compared on the RFQ's quantity; band A's on the group's.
    return { itemId: l.itemId, qtyBase: rfq !== null ? qty : (l.qtyBase ?? qty), ratePaise: l.ratePaise, discountBps, gstRateBps };
  });
  const freight = input.freightPaise ?? 0;
  const other = input.otherPaise ?? 0;

  // A revision: sealed (or band A) → revised; unsealed → negotiation, L1 only and downward.
  const before = await db.select().from(storesQuotes).where(and(eq(storesQuotes.groupId, groupId), eq(storesQuotes.vendorId, input.vendorId)));
  const prev = latestByVendor(before).get(input.vendorId);
  let kind: "quote" | "revised" | "negotiated" = prev === undefined ? "quote" : "revised";
  if (prev !== undefined && rfq !== null) {
    const cmp = await computeComparative(db, rfq, now);
    if (!cmp.sealed) {
      const me = cmp.suppliers.find((s) => s.vendorId === input.vendorId);
      if (me?.wholeRank !== 1) throw new StoresError("only_l1_negotiates", "after the quotes are opened only L1 may revise");
      const landed = lines.reduce((a, l) => { const m = lineMoney(l.qtyBase, l.ratePaise, l.discountBps, l.gstRateBps); return a + m.taxablePaise + m.gstPaise; }, 0) + freight + other;
      if (landed >= me.totals.landedPaise) throw new StoresError("negotiation_upward", "a negotiated quote only comes down", { landedPaise: me.totals.landedPaise });
      kind = "negotiated";
    }
  }
  const id = newId();
  const version = (prev?.version ?? 0) + 1;
  await withTx(db, async (tx) => {
    await tx.insert(storesQuotes).values({
      id, groupId, rfqId: rfq?.id ?? null, vendorId: input.vendorId, version, kind, supplierRef: clean(input.supplierRef), freightPaise: freight, otherPaise: other,
      paymentTermsDays: input.paymentTermsDays ?? null, deliveryDays: input.deliveryDays ?? null, warrantyMonths: input.warrantyMonths ?? null,
      documentKey: clean(input.documentKey), late, enteredBy: actor.id, enteredAt: now,
    });
    await tx.insert(storesQuoteLines).values(lines.map((l) => ({ id: newId(), quoteId: id, ...l, confirmedBy: actor.id, confirmedAt: now })));
    await recordAct(tx, actor, now, {
      act: "enter_quote", refId: id, after: { groupId, rfqId: rfq?.id ?? null, vendorId: input.vendorId, version, kind, late },
      lines: lines.map((l) => ({ itemId: l.itemId, qtyBase: l.qtyBase, ratePaise: l.ratePaise, discountBps: l.discountBps, gstRateBps: l.gstRateBps })),
    });
  });
  return getQuote(db, id);
}

export async function getQuote(db: Db | Tx, quoteId: string): Promise<WireQuote> {
  const [q] = await ex(db).select().from(storesQuotes).where(eq(storesQuotes.id, quoteId));
  if (q === undefined) throw new StoresError("unknown_quote", `quote ${quoteId} not found`, { quoteId });
  return quoteView(db, q);
}

async function quoteView(db: Db | Tx, q: QuoteRow): Promise<WireQuote> {
  const lines = await ex(db).select().from(storesQuoteLines).where(eq(storesQuoteLines.quoteId, q.id)).orderBy(asc(storesQuoteLines.itemId));
  return {
    id: q.id, groupId: q.groupId, rfqId: q.rfqId, vendorId: q.vendorId, version: q.version, kind: q.kind as WireQuote["kind"], late: q.late,
    enteredAt: q.enteredAt.toISOString(), supplierRef: q.supplierRef, freightPaise: q.freightPaise, otherPaise: q.otherPaise,
    lines: lines.map((l) => ({ itemId: l.itemId, qtyBase: l.qtyBase, ratePaise: l.ratePaise, discountBps: l.discountBps, gstRateBps: l.gstRateBps })),
  };
}

/** Decision 7: while sealed only the person who typed it opens a quote; every open is an act. */
export async function openQuote(db: Db, actor: Actor, quoteId: string, now: Date = new Date()): Promise<WireQuote> {
  await requireBuyer(db, actor);
  const [q] = await db.select().from(storesQuotes).where(eq(storesQuotes.id, quoteId));
  if (q === undefined) throw new StoresError("unknown_quote", `quote ${quoteId} not found`, { quoteId });
  if (q.rfqId !== null) {
    const cmp = await computeComparative(db, await requireRfq(db, q.rfqId), now);
    if (cmp.sealed && q.enteredBy !== actor.id) throw new StoresError("sealed", "quotes stay sealed until the reply-by date", { received: cmp.received, invited: cmp.invited });
  }
  await withTx(db, (tx) => recordAct(tx, actor, now, { act: "open_quote", refId: quoteId }));
  return quoteView(db, q);
}

/** The materials head lets a late quote into the ranks, with a reason. */
export async function admitLateQuote(db: Db, actor: Actor, quoteId: string, reason: string, now: Date = new Date()): Promise<WireQuote> {
  if (!(await holds(db, actor, STORES_MASTERS))) throw new StoresError("not_permitted", "a late quote is admitted by the materials head", { permission: STORES_MASTERS });
  const why = clean(reason);
  if (why === null) throw new StoresError("reason_required", "say why the late quote is admitted");
  const [q] = await db.select().from(storesQuotes).where(eq(storesQuotes.id, quoteId));
  if (q === undefined) throw new StoresError("unknown_quote", `quote ${quoteId} not found`, { quoteId });
  if (!q.late) throw new StoresError("not_late", "this quote came in time");
  const [had] = await db.select({ id: storesQuoteAdmissions.id }).from(storesQuoteAdmissions).where(eq(storesQuoteAdmissions.quoteId, quoteId));
  if (had !== undefined) throw new StoresError("already_admitted", "this quote is already admitted");
  await withTx(db, async (tx) => {
    await tx.insert(storesQuoteAdmissions).values({ id: newId(), quoteId, by: actor.id, at: now, reason: why });
    await recordAct(tx, actor, now, { act: "admit_late_quote", refId: quoteId, reason: why });
  });
  return quoteView(db, q);
}

/** Flow 7: the user HOD and biomedical mark an equipment offer Yes / No (No with a reason) before ranking counts. */
export async function markTechnical(
  db: Db, actor: Actor, input: { rfqId: string; vendorId: string; compliant: boolean; reason?: string | null }, now: Date = new Date(),
): Promise<void> {
  const rfq = await requireRfq(db, input.rfqId);
  const why = clean(input.reason);
  if (!input.compliant && why === null) throw new StoresError("reason_required", "a No says why");
  let role: "hod" | "biomedical" | null = null;
  if (actor.type === "user") {
    const [bme] = await db.select({ u: roleAssignments.userId }).from(roleAssignments)
      .where(and(eq(roleAssignments.userId, actor.id), eq(roleAssignments.roleKey, "biomedical_engineer"))).limit(1);
    if (bme !== undefined) role = "biomedical";
    else {
      const depts = await db.selectDistinct({ d: storesPurchaseRequests.departmentId }).from(storesBuyGroupMoves)
        .innerJoin(storesPurchaseRequests, eq(storesPurchaseRequests.id, storesBuyGroupMoves.prId)).where(eq(storesBuyGroupMoves.groupId, rfq.groupId));
      for (const { d } of depts) if (d !== null && (await holds(db, actor, STORES_INDENTS_APPROVE, d))) role = "hod";
    }
  }
  if (role === null) throw new StoresError("not_permitted", "technical compliance is marked by the user HOD and biomedical", { permission: STORES_INDENTS_APPROVE });
  const [inv] = await db.select({ id: storesRfqInvitees.id }).from(storesRfqInvitees).where(and(eq(storesRfqInvitees.rfqId, rfq.id), eq(storesRfqInvitees.vendorId, input.vendorId)));
  if (inv === undefined) throw new StoresError("not_invited", "this supplier was not invited");
  const [had] = await db.select({ id: storesQuoteTechnical.id }).from(storesQuoteTechnical)
    .where(and(eq(storesQuoteTechnical.rfqId, rfq.id), eq(storesQuoteTechnical.vendorId, input.vendorId), eq(storesQuoteTechnical.role, role)));
  if (had !== undefined) throw new StoresError("already_signed", "already marked");
  await withTx(db, async (tx) => {
    await tx.insert(storesQuoteTechnical).values({ id: newId(), rfqId: rfq.id, vendorId: input.vendorId, role: role!, compliant: input.compliant, reason: why, by: actor.id, at: now });
    await recordAct(tx, actor, now, { act: "mark_technical", refId: rfq.id, after: { vendorId: input.vendorId, role, compliant: input.compliant }, reason: why });
  });
}

/** Band A's quotes for a group (newest version per supplier). */
export async function groupQuotes(db: Db | Tx, groupId: string): Promise<{ quote: QuoteRow; lines: (typeof storesQuoteLines.$inferSelect)[] }[]> {
  const rows = await ex(db).select().from(storesQuotes).where(eq(storesQuotes.groupId, groupId));
  const latest = [...latestByVendor(rows.filter((r) => r.rfqId === null)).values()].sort((a, b) => b.enteredAt.getTime() - a.enteredAt.getTime());
  if (latest.length === 0) return [];
  const lines = await ex(db).select().from(storesQuoteLines).where(inArray(storesQuoteLines.quoteId, latest.map((q) => q.id)));
  return latest.map((quote) => ({ quote, lines: lines.filter((l) => l.quoteId === quote.id) }));
}
