import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { enqueuePrintJob } from "../../kernel/printing/enqueue";
import {
  items, storesAwards, storesAwardSignatures, storesQuotes, storesRfqInvitees, storesRfqLines, storesRfqSteps, storesRfqs,
} from "../../kernel/db/schema";
import { STORES_BUYING_MANAGE, holds, recordAct } from "./access";
import { bandOfLines, requireGroup } from "./buy-groups";
import { byItem, centralStoreId, clean, ex, groupLines, nextNo, peopleNamed, requireCanQuote, rfqClock, vendorNames } from "./buying-common";
import { StoresError } from "./errors";
import { supplierKyc } from "./suppliers";
import type { StoresRfqChannel, StoresRfqStatus, WireRfq } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * STORES S5b (#1115, decision 6) — THE REQUEST FOR QUOTATION (`RFQ` + yymmdd + 4 digits).
 *
 * Made from one group: its lines summed by item, the band FROZEN on the RFQ (decision 2), the reply-by instant, the
 * delivery place (the central store) and date. Invitees must "can quote" (`cannot_quote`, with what is missing): a
 * blacklisted or suspended supplier and one without PAN are refused; one with no bank yet is invited. Bands B and C need
 * at least three (`three_quotes_needed`).
 *
 * SENDING IS A PERSON'S TAP (decision 6, D22): HMIS has no outbound mailer, so `sendRfq` records who sent it, when, how
 * (email from the hospital's purchase mailbox / print / by hand) and to whom, and queues ONE PDF PER INVITEE (`stores_rfq`)
 * for the buyer to attach or print. Nothing is recorded as sent without that call; a later invitee is sent on a later tap.
 * The reply-by may move once, before it passes, with a reason. "Closed / बंद" records that the others were told.
 */
export const RFQ_DOCUMENT = "stores_rfq";
type RfqRow = typeof storesRfqs.$inferSelect;

async function requireBuyer(db: Db | Tx, actor: Actor): Promise<void> {
  if (!(await holds(db, actor, STORES_BUYING_MANAGE))) throw new StoresError("not_permitted", "the buying desk is the buyer's", { permission: STORES_BUYING_MANAGE });
}

export async function requireRfq(db: Db | Tx, rfqId: string): Promise<RfqRow> {
  const [r] = await ex(db).select().from(storesRfqs).where(eq(storesRfqs.id, rfqId));
  if (r === undefined) throw new StoresError("unknown_rfq", `RFQ ${rfqId} not found`, { rfqId });
  return r;
}

export async function createRfq(
  db: Db, actor: Actor, input: { groupId: string; replyBy: Date; deliveryDate?: string | null; vendorIds?: string[] | null; note?: string | null }, now: Date = new Date(),
): Promise<WireRfq> {
  await requireBuyer(db, actor);
  await requireGroup(db, input.groupId);
  const [open] = await db.select({ id: storesRfqs.id }).from(storesRfqs).where(eq(storesRfqs.groupId, input.groupId));
  if (open !== undefined) throw new StoresError("group_locked", "this group already has an RFQ", { rfqId: open.id });
  const lines = await groupLines(db, input.groupId);
  if (lines.length === 0) throw new StoresError("item_required", "the group has no lines");
  if (!(input.replyBy.getTime() > now.getTime())) throw new StoresError("reply_by_passed", "the reply-by date is in the future");
  const vendorIds = [...new Set(input.vendorIds ?? [])];
  for (const v of vendorIds) await requireCanQuote(db, v, now);
  const { band } = await bandOfLines(db, lines, now);
  const asked = byItem(lines);
  const deliveryStoreId = await centralStoreId(db);
  const id = newId();
  await withTx(db, async (tx) => {
    const rfqNo = await nextNo(tx, "stores_rfq", "RFQ", now);
    await tx.insert(storesRfqs).values({
      id, rfqNo, groupId: input.groupId, band, equipment: asked.some((l) => l.equipment), replyBy: input.replyBy, deliveryStoreId,
      deliveryDate: input.deliveryDate ?? null, note: clean(input.note), createdBy: actor.id, createdAt: now,
    });
    await tx.insert(storesRfqLines).values(asked.map((l, i) => ({ id: newId(), rfqId: id, lineIdx: i, itemId: l.itemId, qtyBase: l.qtyBase })));
    if (vendorIds.length > 0) await tx.insert(storesRfqInvitees).values(vendorIds.map((v) => ({ id: newId(), rfqId: id, vendorId: v, addedBy: actor.id, at: now })));
    await recordAct(tx, actor, now, {
      act: "create_rfq", refId: id, after: { rfqNo, groupId: input.groupId, band, replyBy: input.replyBy.toISOString(), vendorIds },
      lines: asked.map((l) => ({ itemId: l.itemId, qtyBase: l.qtyBase })),
    });
  });
  return getRfq(db, id, now);
}

export async function inviteSuppliers(db: Db, actor: Actor, rfqId: string, vendorIds: readonly string[], now: Date = new Date()): Promise<WireRfq> {
  await requireBuyer(db, actor);
  const rfq = await requireRfq(db, rfqId);
  if ((await rfqClock(db, rfq)).closed) throw new StoresError("rfq_closed", "this RFQ is closed");
  const have = new Set((await db.select({ v: storesRfqInvitees.vendorId }).from(storesRfqInvitees).where(eq(storesRfqInvitees.rfqId, rfqId))).map((r) => r.v));
  const add = [...new Set(vendorIds)].filter((v) => !have.has(v));
  for (const v of add) await requireCanQuote(db, v, now);
  if (add.length === 0) return getRfq(db, rfqId, now);
  await withTx(db, async (tx) => {
    await tx.insert(storesRfqInvitees).values(add.map((v) => ({ id: newId(), rfqId, vendorId: v, addedBy: actor.id, at: now })));
    await recordAct(tx, actor, now, { act: "invite_suppliers", refId: rfqId, after: { vendorIds: add } });
  });
  return getRfq(db, rfqId, now);
}

/** The person's tap: records the send and queues one RFQ PDF per invitee not sent before. */
export async function sendRfq(db: Db, actor: Actor, rfqId: string, input: { channel: StoresRfqChannel }, now: Date = new Date()): Promise<WireRfq> {
  await requireBuyer(db, actor);
  if (actor.type !== "user") throw new StoresError("not_permitted", "a person sends an RFQ");
  if (!["email", "print", "hand"].includes(input.channel)) throw new StoresError("bad_quantity", "send by email, print or hand");
  const rfq = await requireRfq(db, rfqId);
  const clock = await rfqClock(db, rfq);
  if (clock.closed) throw new StoresError("rfq_closed", "this RFQ is closed");
  if (clock.replyBy.getTime() <= now.getTime()) throw new StoresError("reply_by_passed", "the reply-by date has passed: move it first");
  const invited = (await db.select({ v: storesRfqInvitees.vendorId }).from(storesRfqInvitees).where(eq(storesRfqInvitees.rfqId, rfqId))).map((r) => r.v);
  if (rfq.band !== "A" && invited.length < 3) throw new StoresError("three_quotes_needed", "three suppliers are needed", { invited: invited.length });
  const toSend = invited.filter((v) => !clock.sentTo.has(v));
  if (toSend.length === 0) throw new StoresError("already_sent", "every invitee has been sent this RFQ");
  for (const v of toSend) await requireCanQuote(db, v, now);
  await withTx(db, async (tx) => {
    await tx.insert(storesRfqSteps).values({ id: newId(), rfqId, kind: "sent", by: actor.id, at: now, channel: input.channel, vendorIds: toSend });
    for (const vendorId of toSend) {
      await enqueuePrintJob(tx, { document: RFQ_DOCUMENT, params: { rfqId, vendorId }, dedupeKey: `stores-rfq:${rfqId}:${vendorId}`, requestedBy: actor.id });
    }
    await recordAct(tx, actor, now, { act: "send_rfq", refId: rfqId, after: { channel: input.channel, vendorIds: toSend, sentBy: actor.id } });
  });
  return getRfq(db, rfqId, now);
}

export async function moveReplyBy(db: Db, actor: Actor, rfqId: string, replyBy: Date, reason: string, now: Date = new Date()): Promise<WireRfq> {
  await requireBuyer(db, actor);
  const why = clean(reason);
  if (why === null) throw new StoresError("reason_required", "say why the date moves");
  const rfq = await requireRfq(db, rfqId);
  const clock = await rfqClock(db, rfq);
  if (clock.moved) throw new StoresError("reply_by_moved_once", "the reply-by date moves once");
  if (clock.replyBy.getTime() <= now.getTime()) throw new StoresError("reply_by_passed", "the reply-by date has already passed");
  if (replyBy.getTime() <= now.getTime()) throw new StoresError("reply_by_passed", "the new date is in the future");
  await withTx(db, async (tx) => {
    await tx.insert(storesRfqSteps).values({ id: newId(), rfqId, kind: "reply_by_moved", by: actor.id, at: now, replyBy, reason: why });
    await recordAct(tx, actor, now, { act: "move_reply_by", refId: rfqId, before: clock.replyBy.toISOString(), after: replyBy.toISOString(), reason: why });
  });
  return getRfq(db, rfqId, now);
}

/** "Closed / बंद": the suppliers not chosen were told. HMIS sends them nothing. */
export async function closeRfq(db: Db, actor: Actor, rfqId: string, now: Date = new Date()): Promise<WireRfq> {
  await requireBuyer(db, actor);
  const rfq = await requireRfq(db, rfqId);
  if ((await rfqClock(db, rfq)).closed) throw new StoresError("rfq_closed", "this RFQ is already closed");
  await withTx(db, async (tx) => {
    await tx.insert(storesRfqSteps).values({ id: newId(), rfqId, kind: "closed", by: actor.id, at: now });
    await recordAct(tx, actor, now, { act: "close_rfq", refId: rfqId });
  });
  return getRfq(db, rfqId, now);
}

export async function getRfq(db: Db | Tx, rfqId: string, now: Date = new Date()): Promise<WireRfq> {
  return (await rfqViews(db, [await requireRfq(db, rfqId)], now))[0]!;
}

export async function listRfqs(db: Db, actor: Actor, now: Date = new Date()): Promise<WireRfq[]> {
  await requireBuyer(db, actor);
  const rows = await db.select().from(storesRfqs).orderBy(desc(storesRfqs.createdAt)).limit(100);
  return rfqViews(db, rows, now);
}

export async function rfqViews(db: Db | Tx, rows: readonly RfqRow[], now: Date): Promise<WireRfq[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const invitees = await ex(db).select().from(storesRfqInvitees).where(inArray(storesRfqInvitees.rfqId, ids)).orderBy(asc(storesRfqInvitees.at));
  const lines = await ex(db).select({ l: storesRfqLines, name: items.name, uom: items.baseUom }).from(storesRfqLines).innerJoin(items, eq(items.id, storesRfqLines.itemId))
    .where(inArray(storesRfqLines.rfqId, ids)).orderBy(asc(storesRfqLines.lineIdx));
  const quotes = await ex(db).selectDistinct({ rfqId: storesQuotes.rfqId, v: storesQuotes.vendorId }).from(storesQuotes).where(inArray(storesQuotes.rfqId, ids));
  const awards = await ex(db).select({ id: storesAwards.id, rfqId: storesAwards.rfqId }).from(storesAwards).where(inArray(storesAwards.rfqId, ids));
  const sigs = awards.length === 0 ? [] : await ex(db).select().from(storesAwardSignatures)
    .where(and(inArray(storesAwardSignatures.awardId, awards.map((a) => a.id)), ne(storesAwardSignatures.kind, "object")));
  const names = await vendorNames(db, invitees.map((i) => i.vendorId));
  const out: WireRfq[] = [];
  for (const r of rows) {
    const clock = await rfqClock(db, r);
    const person = await peopleNamed(db, [clock.sent?.by ?? null]);
    const inv = invitees.filter((i) => i.rfqId === r.id);
    const quoted = new Set(quotes.filter((q) => q.rfqId === r.id).map((q) => q.v));
    const sealed = now.getTime() < clock.replyBy.getTime() && quoted.size < inv.length;
    const awarded = awards.some((a) => a.rfqId === r.id && sigs.some((s) => s.awardId === a.id && (s.seat === "owner" || s.kind === "approve")));
    const status: StoresRfqStatus = clock.closed ? "closed" : awarded ? "awarded" : clock.sent === null ? "drafted" : !sealed && quoted.size > 0 ? "compared" : "sent";
    const kyc = new Map<string, WireRfq["invitees"][number]["kyc"]>();
    for (const i of inv) kyc.set(i.vendorId, (await supplierKyc(db, i.vendorId, now)).level);
    out.push({
      id: r.id, rfqNo: r.rfqNo, groupId: r.groupId, band: r.band as WireRfq["band"], equipment: r.equipment, status, replyBy: clock.replyBy.toISOString(),
      deliveryDate: r.deliveryDate,
      invitees: inv.map((i) => ({ vendorId: i.vendorId, name: names.get(i.vendorId)?.name ?? i.vendorId, kyc: kyc.get(i.vendorId) ?? "none", quoted: quoted.has(i.vendorId) })),
      lines: lines.filter((l) => l.l.rfqId === r.id).map((l) => ({ itemId: l.l.itemId, itemName: l.name, qtyBase: l.l.qtyBase, baseUom: l.uom })),
      sent: clock.sent === null ? null : {
        by: person(clock.sent.by), at: clock.sent.at.toISOString(), channel: clock.sent.channel as StoresRfqChannel, vendorIds: [...clock.sentTo],
      },
      received: quoted.size,
    });
  }
  return out;
}
