import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { raiseNotice } from "../../kernel/alerts/notices";
import { withTx } from "../../kernel/db/client";
import {
  items, purchaseOrders, storesAwardLines, storesAwardSignatures, storesAwards, storesCommitteeSeats, storesPurchaseRequests, storesQuoteLines, storesQuotes,
  storesRfqs,
} from "../../kernel/db/schema";
import {
  contractRatesFor, createPurchaseOrder, decidePurchaseOrder, getPurchaseOrder, judgePrice, purchaseHistoryByItem, registerAwardPoGuard, sendPurchaseOrder,
  submitPurchaseOrder,
} from "../materials";
import { STORES_AWARD_SIGN, STORES_BUYING_MANAGE, STORES_INDENTS_APPROVE, STORES_MASTERS, holds, recordAct } from "./access";
import { bulkApprovePurchaseRequests } from "./purchase-requests";
import { BAND_B_MAX_PAISE, bandFor, higherBand } from "./bands";
import { advanceOfPo, payTermsOf } from "./advances";
import { approvedExceptionFor } from "./buy-exceptions";
import { bandOfLines, requireGroup } from "./buy-groups";
import {
  byItem, centralStoreId, clean, ex, groupLines, holdsRole, latestByVendor, lineMoney, peopleNamed, requireKycComplete, rfqClock, usersWithRole, vendorNames,
} from "./buying-common";
import { computeComparative } from "./comparative";
import { seatDelegationFor, seatHolderAt } from "./delegations";
import { StoresError } from "./errors";
import { groupQuotes } from "./quotes";
import { requireRfq } from "./rfq";
import { holdersOf } from "./tickets";
import type { GroupLine } from "./buying-common";
import type { AwardPoGuard, PoView } from "../materials";
import type { StoresAwardStatus, StoresBand, StoresSeat, WireAward } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * STORES S5b (#1115, decisions 4, 9, 10, 11; ruling 0101 Q3) — THE AWARD, THE COMMITTEE, AND THE PO MADE FROM AN AWARD.
 *
 * Band A: `makePoFromGroup` — every line on a live rate contract orders against it with no quote; every other line
 * needs the group's one quote (`quote_needed`), judged against the last price by materials' own `judgePrice` (more than
 * 2 % above: a typed reason, `reason_required`, kept on the award and the PO). The buyer's tap is the award (band A: the
 * buyer awards) and the PO is made from it in the same call.
 *
 * Bands B and C: `proposeAward` (whole or split by line) from an UNSEALED comparative. Not L1 needs a reason; every
 * awarded supplier must be "KYC complete" (`kyc_incomplete`); a total that lands in a higher band than the RFQ's is
 * refused (`band_changed`) and quoted again. Band B: a materials head (`stores.masters.manage` + `stores.award.sign`)
 * approves. Band C and all medical equipment: the seats are FROZEN on the proposal — materials head, accounts head,
 * medical superintendent (rows set by the owner or the materials head), the user HOD (the department's HODs, any one
 * of them; DECIDED: one seat however many departments the group serves) and biomedical for equipment; an empty seat
 * refuses the proposal (`committee_seat_empty`, naming it). Every seat signs (in person or through a dated delegate),
 * then the owner. The proposer never signs it (`own_proposal`). Any seat may object with a reason: the award is "Sent
 * back" and a fresh proposal is a new row naming it. Status is derived from the signature rows, never stored.
 *
 * PO from award: `createPurchaseOrder` with the award's supplier, items and rates copied (`purchase_orders.award_id`),
 * "Pay after GRN" in its terms. The award check registered with materials refuses a PO that differs (supplier, item,
 * rate, more quantity) at submit (`po_differs_from_award`) and sends only once the award is approved
 * (`award_not_approved`). `approveAwardAndPo`: one tap, two stamps, no tier skipped. Bulk: POs and requests, never awards.
 */
export const AWARD_WORDS = {
  toSign: ["Award to sign", "आवंटन पर हस्ताक्षर"],
  sentBack: ["Award sent back", "आवंटन वापस"],
  poToApprove: ["PO to approve", "PO मंज़ूरी बाकी"],
  ordered: ["Ordered", "ऑर्डर हुआ"],
} as const;
export const PAY_AFTER_GRN = "Pay after GRN / GRN के बाद भुगतान";
const COMMITTEE_ORDER: StoresSeat[] = ["materials_head", "accounts_head", "medical_superintendent", "user_hod", "biomedical"];
type AwardRow = typeof storesAwards.$inferSelect;
type SigRow = typeof storesAwardSignatures.$inferSelect;
type Seat = { seat: string; userIds: string[] };

async function requireBuyer(db: Db | Tx, actor: Actor): Promise<void> {
  if (!(await holds(db, actor, STORES_BUYING_MANAGE))) throw new StoresError("not_permitted", "awards are proposed at the buying desk", { permission: STORES_BUYING_MANAGE });
}

export async function requireAward(db: Db | Tx, awardId: string): Promise<AwardRow> {
  const [a] = await ex(db).select().from(storesAwards).where(eq(storesAwards.id, awardId));
  if (a === undefined) throw new StoresError("unknown_award", `award ${awardId} not found`, { awardId });
  return a;
}

function statusOf(a: AwardRow, sigs: readonly SigRow[]): StoresAwardStatus {
  const mine = sigs.filter((s) => s.awardId === a.id);
  if (mine.some((s) => s.kind === "object")) return "sent_back";
  // Band A, and (S5c) a single-source or emergency purchase approved beforehand: the award's only seat is the buyer's.
  if (a.band === "A" || (a.seats.length === 1 && a.seats[0]!.seat === "buyer")) return mine.some((s) => s.seat === "buyer") ? "approved" : "proposed";
  if (a.band === "B") return mine.some((s) => s.seat === "materials_head" && s.kind === "approve") ? "approved" : "proposed";
  return a.seats.every((s) => mine.some((g) => g.seat === s.seat)) && mine.some((s) => s.seat === "owner") ? "approved" : "proposed";
}

async function sigsOf(db: Db | Tx, awardIds: readonly string[]): Promise<SigRow[]> {
  if (awardIds.length === 0) return [];
  return ex(db).select().from(storesAwardSignatures).where(inArray(storesAwardSignatures.awardId, [...awardIds])).orderBy(asc(storesAwardSignatures.at));
}

export async function awardStatus(db: Db | Tx, awardId: string): Promise<StoresAwardStatus> {
  const a = await requireAward(db, awardId);
  return statusOf(a, await sigsOf(db, [a.id]));
}

// ═══════════════════════════════ the committee's seats ═══════════════════════════════

/** Ruling 0101 Q3: the owner or the materials head sets who sits in a seat, from when (to when). Every change a row and an act. */
export async function setCommitteeSeat(
  db: Db, actor: Actor, input: { seat: string; userId: string; from: Date; to?: Date | null }, now: Date = new Date(),
): Promise<void> {
  if (!(await holds(db, actor, STORES_MASTERS)) && !(await holdsRole(db, actor, "owner"))) {
    throw new StoresError("not_permitted", "committee seats are set by the owner or the materials head", { permission: STORES_MASTERS });
  }
  if (!["materials_head", "accounts_head", "medical_superintendent", "biomedical"].includes(input.seat)) throw new StoresError("not_a_seat", "no such seat", { seat: input.seat });
  if (input.to != null && input.to.getTime() <= input.from.getTime()) throw new StoresError("bad_window", "a seat ends after it starts");
  const id = newId();
  await withTx(db, async (tx) => {
    await tx.insert(storesCommitteeSeats).values({ id, seat: input.seat, userId: input.userId, fromAt: input.from, toAt: input.to ?? null, setBy: actor.id, at: now });
    await recordAct(tx, actor, now, { act: "set_committee_seat", refId: id, after: { seat: input.seat, userId: input.userId, from: input.from.toISOString(), to: input.to?.toISOString() ?? null } });
  });
}

export async function committeeSeats(db: Db | Tx, now: Date = new Date()): Promise<{ seat: string; userId: string | null }[]> {
  const out: { seat: string; userId: string | null }[] = [];
  for (const seat of ["materials_head", "accounts_head", "medical_superintendent", "biomedical"]) out.push({ seat, userId: await seatHolderAt(db, seat, now) });
  return out;
}

/** The seats frozen on a band C proposal; an empty one refuses it, naming the seat. */
async function freezeSeats(db: Db | Tx, lines: readonly GroupLine[], equipment: boolean, now: Date): Promise<Seat[]> {
  const out: Seat[] = [];
  for (const seat of COMMITTEE_ORDER) {
    if (seat === "biomedical" && !equipment) continue;
    if (seat === "user_hod") {
      const depts = [...new Set(lines.map((l) => (l.source === "department" ? l.departmentId : null)).filter((d): d is string => d !== null))];
      if (depts.length === 0) continue;
      const hods = new Set<string>();
      for (const d of depts) for (const u of await holdersOf(db, STORES_INDENTS_APPROVE, { departmentId: d })) hods.add(u);
      if (hods.size === 0) throw new StoresError("committee_seat_empty", "the user HOD's seat is empty", { seat });
      out.push({ seat, userIds: [...hods].sort() });
      continue;
    }
    const holder = await seatHolderAt(db, seat, now);
    if (holder === null) throw new StoresError("committee_seat_empty", `the ${seat.replace(/_/g, " ")} seat is empty`, { seat });
    out.push({ seat, userIds: [holder] });
  }
  return out;
}

// ═══════════════════════════════ propose ═══════════════════════════════

type AwardLineDraft = {
  itemId: string; vendorId: string; quoteId: string | null; rateId: string | null; qtyBase: number; ratePaise: number; discountBps: number; gstRateBps: number;
  rank: number | null; landedPaise: number; categoryId: string | null;
};

async function tellSeats(tx: Tx, a: { id: string; band: string; proposedBy: string }, seats: readonly Seat[], now: Date): Promise<void> {
  const users = a.band === "B" ? await holdersOf(tx, STORES_MASTERS, "hospital") : seats.flatMap((s) => s.userIds);
  for (const u of new Set(users)) {
    if (u === a.proposedBy) continue;
    await notifyAward(tx, u, AWARD_WORDS.toSign, a.id, "to-sign", now);
  }
}

async function notifyAward(tx: Tx, userId: string, words: readonly [string, string], awardId: string, key: string, now: Date): Promise<void> {
  await raiseNotice(tx as unknown as Db, {
    userId, kind: "stores.purchase", title: words[0], body: words[1], refType: "stores_award", refId: awardId, sourceKey: `stores-award:${awardId}:${key}:${userId}`, at: now,
  });
}

export async function proposeAward(
  db: Db, actor: Actor, input: { rfqId: string; vendorId?: string | null; lines?: { itemId: string; vendorId: string }[] | null; reason?: string | null },
  now: Date = new Date(),
): Promise<WireAward> {
  await requireBuyer(db, actor);
  const rfq = await requireRfq(db, input.rfqId);
  if ((await rfqClock(db, rfq)).closed) throw new StoresError("rfq_closed", "this RFQ is closed");
  const cmp = await computeComparative(db, rfq, now);
  if (cmp.sealed) throw new StoresError("sealed", `${String(cmp.received)} of ${String(cmp.invited)} received`, { received: cmp.received, invited: cmp.invited });
  const prior = await db.select().from(storesAwards).where(eq(storesAwards.rfqId, rfq.id)).orderBy(desc(storesAwards.proposedAt));
  const priorSigs = await sigsOf(db, prior.map((p) => p.id));
  if (prior.some((p) => statusOf(p, priorSigs) !== "sent_back")) throw new StoresError("already_proposed", "this RFQ already has an award");

  const glines = await groupLines(db, rfq.groupId);
  const cats = new Map(byItem(glines).map((l) => [l.itemId, l.categoryId] as const));
  const picks = input.lines != null && input.lines.length > 0
    ? input.lines
    : cmp.lines.map((l) => ({ itemId: l.itemId, vendorId: input.vendorId ?? "" }));
  if (picks.some((p) => p.vendorId === "")) throw new StoresError("unknown_vendor", "name the supplier");
  const drafts: AwardLineDraft[] = [];
  const quoteIds = new Map(cmp.suppliers.map((s) => [s.vendorId, s.quoteId] as const));
  for (const line of cmp.lines) {
    const pick = picks.find((p) => p.itemId === line.itemId);
    if (pick === undefined) continue;
    const cell = line.cells.find((c) => c.vendorId === pick.vendorId);
    if (cell === undefined || cell.rank === null) throw new StoresError("quote_needed", "this supplier has no quote in the ranks for this line", { itemId: line.itemId, vendorId: pick.vendorId });
    drafts.push({
      itemId: line.itemId, vendorId: pick.vendorId, quoteId: quoteIds.get(pick.vendorId)!, rateId: null, qtyBase: line.qtyBase, ratePaise: cell.ratePaise,
      discountBps: 0, gstRateBps: 0, rank: cell.rank, landedPaise: cell.landedPaise, categoryId: cats.get(line.itemId) ?? null,
    });
  }
  if (drafts.length === 0) throw new StoresError("item_required", "an award names at least one line");
  // The discount and GST rate come from the quote line itself (the comparative shows money, the award keeps the terms).
  const qls = await quoteLinesOf(db, [...new Set(drafts.map((d) => d.quoteId!))]);
  for (const d of drafts) {
    const ql = qls.find((x) => x.quoteId === d.quoteId && x.itemId === d.itemId)!;
    d.discountBps = ql.discountBps;
    d.gstRateBps = ql.gstRateBps;
  }
  for (const v of new Set(drafts.map((d) => d.vendorId))) await requireKycComplete(db, v, drafts.filter((d) => d.vendorId === v).map((d) => d.categoryId), now);
  const whole = input.lines == null || input.lines.length === 0;
  const notL1 = whole ? cmp.suppliers.find((s) => s.vendorId === input.vendorId)?.wholeRank !== 1 : drafts.some((d) => d.rank !== 1);
  const reason = clean(input.reason);
  if (notL1 && reason === null) throw new StoresError("reason_required", "an award that is not L1 says why");
  const total = drafts.reduce((a, d) => a + d.landedPaise, 0);
  const band = rfq.band as StoresBand;
  if (higherBand(bandFor(total, { equipment: rfq.equipment }), band) !== band) {
    throw new StoresError("band_changed", "the award lands in a higher band: quote again", { band, totalPaise: total });
  }
  const seats: Seat[] = band === "C" ? await freezeSeats(db, glines, rfq.equipment, now) : band === "B" ? [{ seat: "materials_head", userIds: [] }] : [{ seat: "buyer", userIds: [actor.id] }];
  const replaces = prior.find((p) => statusOf(p, priorSigs) === "sent_back")?.id ?? null;
  const id = newId();
  await withTx(db, async (tx) => {
    await writeAward(tx, actor, { id, groupId: rfq.groupId, rfqId: rfq.id, band, equipment: rfq.equipment, reason, total, seats, replaces, drafts }, now);
    if (band === "A") await tx.insert(storesAwardSignatures).values({ id: newId(), awardId: id, seat: "buyer", kind: "approve", by: actor.id, at: now });
    await tellSeats(tx, { id, band, proposedBy: actor.id }, seats, now);
  });
  return getAward(db, id, now, actor);
}

async function quoteLinesOf(db: Db | Tx, quoteIds: readonly string[]): Promise<(typeof storesQuoteLines.$inferSelect)[]> {
  if (quoteIds.length === 0) return [];
  return ex(db).select().from(storesQuoteLines).where(inArray(storesQuoteLines.quoteId, [...quoteIds]));
}

async function writeAward(
  tx: Tx, actor: Actor,
  a: { id: string; groupId: string; rfqId: string | null; band: StoresBand; equipment: boolean; reason: string | null; total: number; seats: Seat[]; replaces: string | null; drafts: AwardLineDraft[] },
  now: Date,
): Promise<void> {
  await tx.insert(storesAwards).values({
    id: a.id, groupId: a.groupId, rfqId: a.rfqId, band: a.band, equipment: a.equipment, reason: a.reason, totalPaise: a.total, seats: a.seats,
    replacesId: a.replaces, proposedBy: actor.id, proposedAt: now,
  });
  await tx.insert(storesAwardLines).values(a.drafts.map((d) => ({
    id: newId(), awardId: a.id, itemId: d.itemId, vendorId: d.vendorId, quoteId: d.quoteId, rateId: d.rateId, qtyBase: d.qtyBase, ratePaise: d.ratePaise,
    discountBps: d.discountBps, gstRateBps: d.gstRateBps, rank: d.rank,
  })));
  await recordAct(tx, actor, now, {
    act: "propose_award", refId: a.id, reason: a.reason,
    after: { groupId: a.groupId, rfqId: a.rfqId, band: a.band, totalPaise: a.total, seats: a.seats.map((s) => s.seat), replaces: a.replaces },
    lines: a.drafts.map((d) => ({ itemId: d.itemId, vendorId: d.vendorId, qtyBase: d.qtyBase, ratePaise: d.ratePaise, rank: d.rank })),
  });
}

// ═══════════════════════════════ sign, approve, object ═══════════════════════════════

type Capacity = { seat: StoresSeat; onBehalfOf: string | null; delegationId: string | null };

/** In which seat this person acts on this award now (in person, or through a live delegation), else null. */
async function capacityOn(db: Db | Tx, actor: Actor, a: AwardRow, sigs: readonly SigRow[], now: Date): Promise<Capacity | null> {
  if (actor.type !== "user") return null;
  if (a.band === "B") {
    return (await holds(db, actor, STORES_MASTERS)) && (await holds(db, actor, STORES_AWARD_SIGN)) ? { seat: "materials_head", onBehalfOf: null, delegationId: null } : null;
  }
  if (a.band !== "C") return null;
  const signed = new Set(sigs.filter((s) => s.awardId === a.id).map((s) => s.seat));
  for (const s of a.seats) {
    if (signed.has(s.seat) || !s.userIds.includes(actor.id)) continue;
    return { seat: s.seat as StoresSeat, onBehalfOf: null, delegationId: null };
  }
  for (const s of a.seats) {
    if (signed.has(s.seat) || s.seat === "user_hod") continue;
    const d = await seatDelegationFor(db, actor.id, s.seat, now);
    if (d.live !== null && s.userIds.includes(d.live.fromUserId)) return { seat: s.seat as StoresSeat, onBehalfOf: d.live.fromUserId, delegationId: d.live.id };
  }
  if (await holdsRole(db, actor, "owner")) return { seat: "owner", onBehalfOf: null, delegationId: null };
  return null;
}

/** A seat's signature (band C), the materials head's approval (band B), the owner's last signature (band C). */
export async function approveAward(db: Db, actor: Actor, awardId: string, now: Date = new Date()): Promise<WireAward> {
  await withTx(db, (tx) => approveAwardInTx(tx, actor, awardId, now));
  return getAward(db, awardId, now, actor);
}
export const signAward = approveAward;

async function approveAwardInTx(tx: Tx, actor: Actor, awardId: string, now: Date): Promise<void> {
  const [a] = await tx.select().from(storesAwards).where(eq(storesAwards.id, awardId)).for("update");
  if (a === undefined) throw new StoresError("unknown_award", `award ${awardId} not found`, { awardId });
  const sigs = await sigsOf(tx, [a.id]);
  if (statusOf(a, sigs) !== "proposed") throw new StoresError("award_not_open", "this award is not waiting for a signature");
  if (actor.type === "user" && a.proposedBy === actor.id) throw new StoresError("own_proposal", "you proposed this award");
  const cap = await capacityOn(tx, actor, a, sigs, now);
  if (cap === null) throw new StoresError("not_your_seat", "you hold no seat on this award", { permission: STORES_AWARD_SIGN });
  if (cap.seat === "owner" && !a.seats.every((s) => sigs.some((g) => g.seat === s.seat))) {
    throw new StoresError("awaiting_seats", "every seat signs before the owner", { waiting: a.seats.filter((s) => !sigs.some((g) => g.seat === s.seat)).map((s) => s.seat) });
  }
  if (cap.seat !== "owner" && cap.onBehalfOf === null && a.band === "C") {
    const depts = cap.seat === "user_hod" ? await groupDepartments(tx, a.groupId) : [];
    const may = (await holds(tx, actor, STORES_AWARD_SIGN)) || (await anyAt(tx, actor, STORES_AWARD_SIGN, depts));
    if (!may) throw new StoresError("not_permitted", "a seat's signature needs stores.award.sign", { permission: STORES_AWARD_SIGN });
  }
  const kind = a.band === "B" ? "approve" : "sign";
  await tx.insert(storesAwardSignatures).values({
    id: newId(), awardId, seat: cap.seat, kind, by: actor.id, onBehalfOf: cap.onBehalfOf, delegationId: cap.delegationId, at: now,
  });
  const final = a.band === "B" || cap.seat === "owner";
  await recordAct(tx, actor, now, {
    act: final ? "approve_award" : "sign_award", refId: awardId, after: { seat: cap.seat, onBehalfOf: cap.onBehalfOf, band: a.band },
  });
  if (a.band === "C" && cap.seat !== "owner") {
    const after = [...sigs, { seat: cap.seat } as SigRow];
    if (a.seats.every((s) => after.some((g) => g.seat === s.seat))) for (const u of await usersWithRole(tx, "owner")) await notifyAward(tx, u, AWARD_WORDS.toSign, awardId, "owner", now);
  }
}

async function groupDepartments(db: Db | Tx, groupId: string): Promise<string[]> {
  return [...new Set((await groupLines(db, groupId)).map((l) => l.departmentId).filter((d): d is string => d !== null))];
}
async function anyAt(db: Db | Tx, actor: Actor, permission: string, depts: readonly string[]): Promise<boolean> {
  for (const d of depts) if (await holds(db, actor, permission, d)) return true;
  return false;
}

/** "Object / आपत्ति" with a reason: the award goes back to the buyer as "Sent back". One row. */
export async function objectAward(db: Db, actor: Actor, awardId: string, reason: string, now: Date = new Date()): Promise<WireAward> {
  const why = clean(reason);
  if (why === null) throw new StoresError("reason_required", "an objection says why");
  await withTx(db, async (tx) => {
    const [a] = await tx.select().from(storesAwards).where(eq(storesAwards.id, awardId)).for("update");
    if (a === undefined) throw new StoresError("unknown_award", `award ${awardId} not found`, { awardId });
    const sigs = await sigsOf(tx, [a.id]);
    if (statusOf(a, sigs) !== "proposed") throw new StoresError("award_not_open", "this award is not waiting for a signature");
    if (actor.type === "user" && a.proposedBy === actor.id) throw new StoresError("own_proposal", "you proposed this award");
    const cap = await capacityOn(tx, actor, a, sigs, now);
    if (cap === null) throw new StoresError("not_your_seat", "you hold no seat on this award");
    await tx.insert(storesAwardSignatures).values({
      id: newId(), awardId, seat: cap.seat, kind: "object", by: actor.id, onBehalfOf: cap.onBehalfOf, delegationId: cap.delegationId, reason: why, at: now,
    });
    await recordAct(tx, actor, now, { act: "object_award", refId: awardId, reason: why, after: { seat: cap.seat } });
    await notifyAward(tx, a.proposedBy, AWARD_WORDS.sentBack, awardId, "sent-back", now);
  });
  return getAward(db, awardId, now, actor);
}

// ═══════════════════════════════ reads ═══════════════════════════════

export async function getAward(db: Db | Tx, awardId: string, now: Date = new Date(), reader?: Actor): Promise<WireAward> {
  return (await awardViews(db, [await requireAward(db, awardId)], now, reader))[0]!;
}

export async function awardViews(db: Db | Tx, rows: readonly AwardRow[], now: Date, reader?: Actor): Promise<WireAward[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const sigs = await sigsOf(db, ids);
  const lines = await ex(db).select({ l: storesAwardLines, name: items.name }).from(storesAwardLines).innerJoin(items, eq(items.id, storesAwardLines.itemId))
    .where(inArray(storesAwardLines.awardId, ids));
  const rfqIds = rows.map((r) => r.rfqId).filter((x): x is string => x !== null);
  const rfqs = new Map(rfqIds.length === 0 ? [] : (await ex(db).select({ id: storesRfqs.id, no: storesRfqs.rfqNo }).from(storesRfqs).where(inArray(storesRfqs.id, rfqIds))).map((r) => [r.id, r.no] as const));
  const pos = await ex(db).select({ id: purchaseOrders.id, awardId: purchaseOrders.awardId }).from(purchaseOrders)
    .where(and(inArray(purchaseOrders.awardId, ids), ne(purchaseOrders.status, "cancelled")));
  const vnames = await vendorNames(db, lines.map((l) => l.l.vendorId));
  const person = await peopleNamed(db, [...rows.flatMap((r) => [r.proposedBy, ...r.seats.flatMap((s) => s.userIds)]), ...sigs.flatMap((s) => [s.by, s.onBehalfOf])]);
  const out: WireAward[] = [];
  for (const a of rows) {
    const mine = sigs.filter((s) => s.awardId === a.id);
    const status = statusOf(a, mine);
    const seatList = [...a.seats.map((s) => s.seat), ...(a.band === "C" ? ["owner"] : [])];
    let me: WireAward["mine"] = null;
    if (reader !== undefined && status === "proposed" && !(reader.type === "user" && reader.id === a.proposedBy)) {
      const cap = await capacityOn(db, reader, a, mine, now);
      if (cap !== null) me = { seat: cap.seat, canSign: cap.seat !== "owner" || a.seats.every((s) => mine.some((g) => g.seat === s.seat)) };
    }
    out.push({
      id: a.id, rfqId: a.rfqId, rfqNo: a.rfqId === null ? null : (rfqs.get(a.rfqId) ?? null), groupId: a.groupId, band: a.band as StoresBand, equipment: a.equipment,
      status, reason: a.reason, proposedBy: person(a.proposedBy), proposedAt: a.proposedAt.toISOString(), totalPaise: a.totalPaise,
      lines: lines.filter((l) => l.l.awardId === a.id).map(({ l, name }) => {
        const m = lineMoney(l.qtyBase, l.ratePaise, l.discountBps, l.gstRateBps);
        return { itemId: l.itemId, itemName: name, qtyBase: l.qtyBase, vendorId: l.vendorId, vendorName: vnames.get(l.vendorId)?.name ?? l.vendorId, ratePaise: l.ratePaise, landedPaise: m.taxablePaise + m.gstPaise, rank: l.rank };
      }),
      seats: seatList.map((seat) => {
        const sig = mine.find((s) => s.seat === seat);
        return {
          seat: seat as StoresSeat, holders: (a.seats.find((s) => s.seat === seat)?.userIds ?? []).map(person),
          signedBy: sig === undefined ? null : person(sig.by), onBehalfOf: sig?.onBehalfOf == null ? null : person(sig.onBehalfOf),
          at: sig?.at.toISOString() ?? null, kind: (sig?.kind as "approve" | "sign" | "object" | undefined) ?? null,
        };
      }),
      ownerSigned: mine.some((s) => s.seat === "owner"), mine: me, poIds: pos.filter((p) => p.awardId === a.id).map((p) => p.id),
    });
  }
  return out;
}

/** The awards on the desk (newest first) and the ones waiting for this reader's seat. */
export async function listAwards(db: Db, actor: Actor, now: Date = new Date()): Promise<WireAward[]> {
  const rows = await db.select().from(storesAwards).orderBy(desc(storesAwards.proposedAt)).limit(100);
  const views = await awardViews(db, rows, now, actor);
  if (await holds(db, actor, STORES_BUYING_MANAGE)) return views;
  return views.filter((v) => v.mine !== null);
}

// ═══════════════════════════════ band A: Make PO from a group ═══════════════════════════════

/**
 * Band A's Make PO. S5c (#1115, ruling 0101 Q4): also a group of any band bought under an APPROVED single-source or
 * emergency exception (`buy-exceptions.ts`) — the named supplier's one quote (typed or through its RFQ), the buyer's award,
 * and a single-source total above ₹5 lakh that only the materials head approved refused (`band_changed`). `source:
 * "agent"` when the buyer confirms the agent's PO draft.
 */
export async function makePoFromGroup(
  db: Db, actor: Actor, groupId: string, input: { reason?: string | null; source?: "manual" | "agent" } = {}, now: Date = new Date(),
): Promise<{ award: WireAward; pos: PoView[] }> {
  await requireBuyer(db, actor);
  await requireGroup(db, groupId);
  const exc = await approvedExceptionFor(db, groupId, now);
  const [rfq] = await db.select({ id: storesRfqs.id }).from(storesRfqs).where(eq(storesRfqs.groupId, groupId));
  if (rfq !== undefined && exc === null) throw new StoresError("rfq_needed", "this group is quoted through its RFQ", { rfqId: rfq.id });
  const prior = await db.select().from(storesAwards).where(eq(storesAwards.groupId, groupId));
  const priorSigs = await sigsOf(db, prior.map((p) => p.id));
  if (prior.some((p) => statusOf(p, priorSigs) !== "sent_back")) throw new StoresError("already_ordered", "this group is already awarded");
  const glines = await groupLines(db, groupId);
  if (glines.length === 0) throw new StoresError("item_required", "the group has no lines");
  const { band } = await bandOfLines(db, glines, now);
  if (band !== "A" && exc === null) throw new StoresError("rfq_needed", "three quotes are needed: make an RFQ", { band });
  const asked = byItem(glines);
  const contracts = await contractRatesFor(db, asked.map((l) => l.itemId), now);
  const quotes = exc === null ? await groupQuotes(db, groupId) : await exceptionQuote(db, groupId, exc.vendorId);
  const history = await purchaseHistoryByItem(db, asked.map((l) => l.itemId), 3);
  const reason = clean(input.reason);
  const drafts: AwardLineDraft[] = [];
  let needsReason = false;
  for (const l of asked) {
    const c = contracts.get(l.itemId)?.[0];
    if (c !== undefined) {
      const rate = Math.round(c.ratePaise / c.multiplier);
      const m = lineMoney(l.qtyBase, rate, 0, c.gstRateBps);
      drafts.push({ itemId: l.itemId, vendorId: c.vendorId, quoteId: null, rateId: c.rateId, qtyBase: l.qtyBase, ratePaise: rate, discountBps: 0, gstRateBps: c.gstRateBps, rank: null, landedPaise: m.taxablePaise + m.gstPaise, categoryId: l.categoryId });
      continue;
    }
    const q = quotes.find((x) => x.lines.some((ql) => ql.itemId === l.itemId));
    if (q === undefined) throw new StoresError("quote_needed", `a quote is needed for ${l.itemName}`, { itemId: l.itemId });
    const ql = q.lines.find((x) => x.itemId === l.itemId)!;
    const m = lineMoney(l.qtyBase, ql.ratePaise, ql.discountBps, ql.gstRateBps);
    if (judgePrice(m.netUnitPaise, history.get(l.itemId) ?? [], null, []).status === "amber") needsReason = true;
    drafts.push({ itemId: l.itemId, vendorId: q.quote.vendorId, quoteId: q.quote.id, rateId: null, qtyBase: l.qtyBase, ratePaise: ql.ratePaise, discountBps: ql.discountBps, gstRateBps: ql.gstRateBps, rank: 1, landedPaise: m.taxablePaise + m.gstPaise + q.quote.freightPaise + q.quote.otherPaise, categoryId: l.categoryId });
  }
  if (needsReason && reason === null) throw new StoresError("reason_required", "the quote is more than 2 % above the last price: say why");
  for (const v of new Set(drafts.map((d) => d.vendorId))) await requireKycComplete(db, v, drafts.filter((d) => d.vendorId === v).map((d) => d.categoryId), now);
  const total = drafts.reduce((a, d) => a + d.landedPaise, 0);
  const equipment = asked.some((l) => l.equipment);
  if (exc === null && bandFor(total, { equipment }) !== "A") throw new StoresError("band_changed", "the quote lands above band A: make an RFQ", { totalPaise: total });
  if (exc !== null && exc.kind === "single_source" && !exc.needsOwner && total > BAND_B_MAX_PAISE) {
    throw new StoresError("band_changed", "the quote lands above ₹5 lakh: the owner approves this single source", { totalPaise: total });
  }
  const awardBand: StoresBand = exc === null ? "A" : higherBand(band, bandFor(total, { equipment }));
  const awardReason = exc === null ? reason : [`${exc.kind === "emergency" ? "Emergency" : "Single source"}: ${exc.reason}`, reason].filter((x) => x !== null).join(" · ");
  const id = newId();
  await withTx(db, async (tx) => {
    await writeAward(tx, actor, {
      id, groupId, rfqId: null, band: awardBand, equipment: exc === null ? false : equipment, reason: awardReason, total, seats: [{ seat: "buyer", userIds: [actor.id] }],
      replaces: null, drafts,
    }, now);
    await tx.insert(storesAwardSignatures).values({ id: newId(), awardId: id, seat: "buyer", kind: "approve", by: actor.id, at: now });
  });
  const { pos } = await makePoFromAward(db, actor, id, { source: input.source ?? "manual" }, now);
  return { award: await getAward(db, id, now, actor), pos };
}

/** The exception's supplier's newest quote on the group (typed, or through the group's RFQ). */
async function exceptionQuote(db: Db | Tx, groupId: string, vendorId: string): Promise<Awaited<ReturnType<typeof groupQuotes>>> {
  const rows = await ex(db).select().from(storesQuotes).where(and(eq(storesQuotes.groupId, groupId), eq(storesQuotes.vendorId, vendorId)));
  const q = latestByVendor(rows).get(vendorId);
  if (q === undefined) return [];
  return [{ quote: q, lines: await quoteLinesOf(db, [q.id]) }];
}

// ═══════════════════════════════ PO from award ═══════════════════════════════

export async function makePoFromAward(db: Db, actor: Actor, awardId: string, opts: { source?: "manual" | "agent" } = {}, now: Date = new Date()): Promise<{ pos: PoView[] }> {
  await requireBuyer(db, actor);
  const a = await requireAward(db, awardId);
  if (statusOf(a, await sigsOf(db, [a.id])) === "sent_back") throw new StoresError("award_not_open", "this award was sent back");
  const [had] = await db.select({ id: purchaseOrders.id }).from(purchaseOrders).where(and(eq(purchaseOrders.awardId, awardId), ne(purchaseOrders.status, "cancelled"))).limit(1);
  if (had !== undefined) throw new StoresError("already_ordered", "this award already has its PO", { poId: had.id });
  const lines = await db.select({ l: storesAwardLines, categoryId: items.categoryId, uom: items.baseUom }).from(storesAwardLines).innerJoin(items, eq(items.id, storesAwardLines.itemId))
    .where(eq(storesAwardLines.awardId, awardId));
  const vendors = [...new Set(lines.map((l) => l.l.vendorId))];
  for (const v of vendors) await requireKycComplete(db, v, lines.filter((l) => l.l.vendorId === v).map((l) => l.categoryId), now);
  let store = await centralStoreId(db);
  let expectedDate: string | null = null;
  if (a.rfqId !== null) { const r = await requireRfq(db, a.rfqId); store = r.deliveryStoreId; expectedDate = r.deliveryDate; }
  const pos: PoView[] = [];
  for (const v of vendors) {
    const mine = lines.filter((l) => l.l.vendorId === v);
    pos.push(await createPurchaseOrder(db, actor, {
      vendorId: v, storeResourceId: store, expectedDate, terms: PAY_AFTER_GRN, note: a.reason === null ? null : `Award reason: ${a.reason}`,
      lines: mine.map(({ l, uom }) => ({ itemId: l.itemId, uom, qtyPacks: l.qtyBase, ratePaise: l.ratePaise, discountBps: l.discountBps, gstRateBps: l.gstRateBps })),
    }, { source: opts.source ?? "manual", now, awardId }));
  }
  await withTx(db, (tx) => recordAct(tx, actor, now, { act: "po_from_award", refId: awardId, after: { poIds: pos.map((p) => p.id), band: a.band } }));
  return { pos };
}

/** The award check materials asks for a PO made from an award (registered when this module loads). */
const guard: AwardPoGuard = {
  async onSubmit(tx, po, lines) {
    const a = await requireAward(tx, po.awardId);
    if (statusOf(a, await sigsOf(tx, [a.id])) === "sent_back") throw new StoresError("award_not_open", "this award was sent back");
    const awarded = await tx.select().from(storesAwardLines).where(and(eq(storesAwardLines.awardId, a.id), eq(storesAwardLines.vendorId, po.vendorId)));
    if (awarded.length === 0) throw new StoresError("po_differs_from_award", "this supplier was not awarded", { vendorId: po.vendorId });
    for (const l of lines) {
      const w = awarded.find((x) => x.itemId === l.itemId);
      const rate = (l.listRatePaise ?? l.ratePaise);
      if (w === undefined || l.multiplier !== 1 || rate !== w.ratePaise || l.discountBps !== w.discountBps || l.qtyPacks * l.multiplier > w.qtyBase) {
        throw new StoresError("po_differs_from_award", "the PO differs from its award (supplier, item, rate or quantity)", { itemId: l.itemId });
      }
    }
  },
  async onSend(tx, po) {
    const a = await requireAward(tx, po.awardId);
    if (statusOf(a, await sigsOf(tx, [a.id])) !== "approved") throw new StoresError("award_not_approved", "the award is not approved yet");
  },
};
registerAwardPoGuard(guard);

async function poAward(db: Db | Tx, poId: string): Promise<{ awardId: string | null; createdBy: string }> {
  const [p] = await ex(db).select({ awardId: purchaseOrders.awardId, createdBy: purchaseOrders.createdBy }).from(purchaseOrders).where(eq(purchaseOrders.id, poId));
  if (p === undefined) throw new StoresError("unknown_po", `purchase order ${poId} not found`, { poId });
  return p;
}

/** Submit a Stores PO (the materials submit, its tier unchanged) and tell its approvers "PO to approve". */
export async function submitStoresPo(db: Db, actor: Actor, poId: string, now: Date = new Date()): Promise<PoView> {
  await requireBuyer(db, actor);
  await poAward(db, poId);
  const po = await submitPurchaseOrder(db, actor, poId, now);
  await withTx(db, async (tx) => {
    await recordAct(tx, actor, now, { act: "submit_po", refId: poId, after: { tier: po.approvalTier, totalPaise: po.totalPaise } });
    const tell = po.approvalTier === "owner" ? await usersWithRole(tx, "owner") : await usersWithRole(tx, "materials_head");
    for (const u of tell) {
      if (u === po.createdBy) continue;
      await raiseNotice(tx as unknown as Db, {
        userId: u, kind: "stores.purchase", title: AWARD_WORDS.poToApprove[0], body: `${AWARD_WORDS.poToApprove[1]} · ${po.poNo}`,
        refType: "stores_po", refId: poId, sourceKey: `stores-po:${poId}:to-approve:${u}`, at: now,
      });
    }
  });
  return po;
}

/** "Send PO / PO भेजें" — a person's tap; the requesters of the award's department requests hear "Ordered". */
export async function sendStoresPo(db: Db, actor: Actor, poId: string, now: Date = new Date()): Promise<PoView> {
  await requireBuyer(db, actor);
  const { awardId } = await poAward(db, poId);
  const po = await sendPurchaseOrder(db, actor, poId, now);
  await withTx(db, async (tx) => {
    await recordAct(tx, actor, now, { act: "send_po", refId: poId, after: { awardId } });
    if (awardId === null) return;
    const a = await requireAward(tx, awardId);
    const prs = [...new Set((await groupLines(tx, a.groupId)).filter((l) => l.source === "department").map((l) => l.prId))];
    if (prs.length === 0) return;
    const rows = await tx.select().from(storesPurchaseRequests).where(inArray(storesPurchaseRequests.id, prs));
    for (const pr of rows) {
      await raiseNotice(tx as unknown as Db, {
        userId: pr.raisedBy, kind: "stores.purchase", title: AWARD_WORDS.ordered[0], body: `${AWARD_WORDS.ordered[1]} · ${pr.prNo}`,
        refType: "stores_purchase_request", refId: pr.id, sourceKey: `stores-pr:${pr.id}:ordered:${poId}`, at: now,
      });
    }
  });
  return po;
}

/** May this person decide this PO's tier (materials head ≤ ₹50,000, the owner above)? Never its drafter. */
async function holdsTier(db: Db | Tx, actor: Actor, po: PoView): Promise<boolean> {
  if (actor.type !== "user" || po.status !== "pending_approval" || po.createdBy === actor.id) return false;
  return holdsRole(db, actor, po.approvalTier === "owner" ? "owner" : "materials_head");
}

async function approvePo(db: Db, actor: Actor, poId: string, note: string, now: Date): Promise<PoView> {
  const po = await decidePurchaseOrder(db, actor, poId, "approve", note, now);
  await withTx(db, (tx) => recordAct(tx, actor, now, { act: "approve_po", refId: poId, after: { tier: po.approvalTier, status: po.status } }));
  return po;
}

/** One sheet, two stamps: the award's approval and, when this person holds the PO's tier, the PO's. No tier is skipped. */
export async function approveAwardAndPo(db: Db, actor: Actor, input: { awardId: string; poId: string }, now: Date = new Date()): Promise<{ award: WireAward; po: PoView }> {
  const { awardId } = await poAward(db, input.poId);
  if (awardId !== input.awardId) throw new StoresError("po_differs_from_award", "this PO was not made from this award");
  const before = await getPurchaseOrder(db, actor, input.poId);
  if (before.status !== "pending_approval") throw new StoresError("not_approved", "submit the PO first");
  const award = await approveAward(db, actor, input.awardId, now);
  let po = before;
  if (award.status === "approved" && (await holdsTier(db, actor, before))) po = await approvePo(db, actor, input.poId, "Approved with its award", now);
  return { award, po: po === before ? await getPurchaseOrder(db, actor, input.poId) : po };
}

/** Decision 11: the owner and the materials head approve several POs or requests in one tap. Never awards or signatures. */
export async function bulkApprove(db: Db, actor: Actor, input: { kind: "po" | "pr" | "award"; ids: readonly string[] }, now: Date = new Date()): Promise<PoView[]> {
  if (input.kind === "award") throw new StoresError("bulk_not_allowed", "awards and committee signatures are signed one by one");
  if (!(await holds(db, actor, STORES_MASTERS)) && !(await holdsRole(db, actor, "owner"))) {
    throw new StoresError("not_permitted", "bulk approval is the materials head's and the owner's", { permission: STORES_MASTERS });
  }
  if (input.kind === "pr") { await bulkApprovePurchaseRequests(db, actor, input.ids, now); return []; }
  const out: PoView[] = [];
  for (const id of [...new Set(input.ids)]) out.push(await approvePo(db, actor, id, "Approved in bulk", now));
  return out;
}

/** The PO approval sheet on the phone: value, band, supplier, L-rank, the reason when not L1. */
export async function poSheet(db: Db, actor: Actor, poId: string, now: Date = new Date()) {
  const po = await getPurchaseOrder(db, actor, poId);
  const { awardId } = await poAward(db, poId);
  let band: StoresBand | null = null; let rank: number | null = null; let reason: string | null = null; let awardSt: StoresAwardStatus | null = null; let both = false;
  if (awardId !== null) {
    const a = await getAward(db, awardId, now, actor);
    band = a.band; reason = a.reason; awardSt = a.status;
    rank = a.lines.filter((l) => l.vendorId === po.vendorId).reduce<number | null>((m, l) => (l.rank === null ? m : Math.max(m ?? 0, l.rank)), null);
    both = a.status === "proposed" && a.mine !== null && a.mine.canSign && a.band !== "C";
  }
  const can = await holdsTier(db, actor, po);
  return {
    poId: po.id, poNo: po.poNo, status: po.status, tier: po.approvalTier, totalPaise: po.totalPaise, vendorName: po.vendorName, band, rank, reason, awardId,
    awardStatus: awardSt, canApprove: can, canApproveBoth: can && both,
    // S5c (decision 11): "Pay after GRN", or the owner-approved equipment advance; the advance row when there is one.
    payTerms: await payTermsOf(db, po.id), advance: await advanceOfPo(db, po.id),
  };
}

/** The sheet's one tap: both stamps when the reader holds both, else the PO's tier alone. */
export async function approvePoFromSheet(db: Db, actor: Actor, poId: string, now: Date = new Date()) {
  const sheet = await poSheet(db, actor, poId, now);
  if (sheet.canApproveBoth && sheet.awardId !== null) await approveAwardAndPo(db, actor, { awardId: sheet.awardId, poId }, now);
  else if (sheet.canApprove) await approvePo(db, actor, poId, "Approved", now);
  else throw new StoresError("not_permitted", "this PO's tier is not yours");
  return poSheet(db, actor, poId, now);
}
