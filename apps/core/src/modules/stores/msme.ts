import { and, asc, eq, inArray, isNull, lte, or, gte } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import {
  grns, storesMsmeObjectionCloses, storesMsmeObjections, storesServiceEntries, supplierBillLines, supplierBills, vendorDocuments, vendors,
} from "../../kernel/db/schema";
import { addDays, dueDateFor } from "../materials";
import { STORES_TAX_MANAGE, holds, recordAct } from "./access";
import { clean, ex } from "./buying-common";
import { StoresError } from "./errors";
import { requirePayingReader } from "./holds";
import { payingSettings } from "./paying-settings";
import type { Exec } from "./buying-common";
import type { Actor, WireMsmeDryRun } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * STORES S6b (#1116, decision 6; ruling 0101 Q1) — THE MSME CLOCK OF THE ACT, as a rule the CA signs, behind the
 * owner's switch (`msme_rule`: `as_today` at merge; `act` after `msmeDryRun`). HMIS computes the date; it computes no
 * interest and gives no legal advice.
 *
 * With `act`:
 *   - on the clock: a supplier classed micro or small (a medium enterprise follows its ordinary terms: the bill date +
 *     terms, default 30). A micro or small TRADER is on the clock unless the CA's line in the settings says otherwise
 *     (`msme_traders_on_clock`, default on — the cautious side);
 *   - the start: the day of acceptance — the delivery (the GRN's posting day) or the service (the SES's day), as
 *     materials already finds it — moved to the day a written objection raised inside 15 days of it was CLOSED
 *     (`recordMsmeObjection` / `closeMsmeObjection`: a QC rejection, a "Short"). An objection still open when the bill
 *     is booked moves nothing (the earlier date is the cautious one). Waiting does not move it;
 *   - due: 15 days after the start with no written agreement; with one (a `payment_terms_agreement` vendor document
 *     valid on the start day), the supplier's agreed terms, never more than 45.
 * Applied when a bill is booked (accepted); a due date already written never changes.
 */
export const MSME_ACT_DAYS = 15;
export const MSME_ACT_MAX_DAYS = 45;
const OBJECTION_WINDOW_DAYS = 15;
const OPEN = ["accepted", "part_paid"];

type VendorRow = typeof vendors.$inferSelect;

/** Whether the Act's clock runs for this supplier (micro or small; a trader per the CA's line). */
export const onTheClock = (v: Pick<VendorRow, "msmeClass" | "msmeActivity">, tradersOnClock: boolean): boolean => {
  const c = (v.msmeClass ?? "").trim().toLowerCase();
  if (c !== "micro" && c !== "small") return false;
  return v.msmeActivity !== "trader" || tradersOnClock;
};

/** The start of the clock: the day of acceptance, or the latest close of an objection raised within 15 days of it. */
async function clockStart(db: Exec, billId: string, delivered: string): Promise<string> {
  const docs = await ex(db).select({ grnId: supplierBillLines.grnId, sesId: supplierBillLines.sesId }).from(supplierBillLines).where(eq(supplierBillLines.billId, billId));
  const grnIds = [...new Set(docs.map((d) => d.grnId).filter((x): x is string => x !== null))];
  const sesIds = [...new Set(docs.map((d) => d.sesId).filter((x): x is string => x !== null))];
  if (grnIds.length === 0 && sesIds.length === 0) return delivered;
  const rows = await ex(db).select({ raisedOn: storesMsmeObjections.raisedOn, closedOn: storesMsmeObjectionCloses.closedOn }).from(storesMsmeObjections)
    .innerJoin(storesMsmeObjectionCloses, eq(storesMsmeObjectionCloses.objectionId, storesMsmeObjections.id))
    .where(or(
      ...(grnIds.length === 0 ? [] : [inArray(storesMsmeObjections.grnId, grnIds)]),
      ...(sesIds.length === 0 ? [] : [inArray(storesMsmeObjections.sesId, sesIds)]),
    ));
  const limit = addDays(delivered, OBJECTION_WINDOW_DAYS);
  const closes = rows.filter((r) => r.raisedOn >= delivered && r.raisedOn <= limit && r.closedOn > delivered).map((r) => r.closedOn).sort();
  return closes[closes.length - 1] ?? delivered;
}

async function hasAgreement(db: Exec, vendorId: string, day: string): Promise<boolean> {
  const [d] = await ex(db).select({ id: vendorDocuments.id }).from(vendorDocuments).where(and(
    eq(vendorDocuments.vendorId, vendorId), eq(vendorDocuments.type, "payment_terms_agreement"),
    or(isNull(vendorDocuments.validFrom), lte(vendorDocuments.validFrom, day)), or(isNull(vendorDocuments.validTo), gte(vendorDocuments.validTo, day)),
  )).limit(1);
  return d !== undefined;
}

/** The Act's due date for one bill (writes nothing). */
export async function actDueDate(
  db: Exec, input: { billId: string; vendorId: string; billDate: string; acceptanceDate: string; termsDays: number | null }, tradersOnClock: boolean,
): Promise<{ dueDate: string; msme: boolean; acceptanceDate: string }> {
  const [v] = await ex(db).select().from(vendors).where(eq(vendors.id, input.vendorId));
  if (v === undefined || !onTheClock(v, tradersOnClock)) {
    return { msme: false, acceptanceDate: input.acceptanceDate, dueDate: dueDateFor({ msme: false, termsDays: input.termsDays, billDate: input.billDate, acceptanceDate: input.acceptanceDate }) };
  }
  const start = await clockStart(db, input.billId, input.acceptanceDate);
  const agreed = input.termsDays !== null && (await hasAgreement(db, input.vendorId, start));
  const days = agreed ? Math.min(input.termsDays!, MSME_ACT_MAX_DAYS) : MSME_ACT_DAYS;
  return { msme: true, acceptanceDate: start, dueDate: addDays(start, days) };
}

/** Materials' hook (registered with the tax hooks in `tax-on-bill.ts`): the Act's date when switched on, else null (as today). */
export async function msmeDueDate(tx: Tx, input: { billId: string; vendorId: string; billDate: string; acceptanceDate: string; termsDays: number | null }): Promise<{ dueDate: string; msme: boolean; acceptanceDate: string } | null> {
  const s = await payingSettings(tx);
  if (s.msmeRule !== "act") return null;
  return actDueDate(tx, input, s.msmeTradersOnClock !== false);
}

/** The dry run (writes nothing): each open bill whose due date the Act's clock would set otherwise. Booked dates never move. */
export async function msmeDryRun(db: Db, actor: Actor, now: Date = new Date()): Promise<WireMsmeDryRun> {
  await requirePayingReader(db, actor);
  const s = await payingSettings(db);
  const rows = await db.select({ b: supplierBills, legal: vendors.legalName, trade: vendors.tradeName }).from(supplierBills)
    .innerJoin(vendors, eq(vendors.id, supplierBills.vendorId)).where(inArray(supplierBills.status, OPEN)).orderBy(asc(supplierBills.dueDate), asc(supplierBills.billNo)).limit(1000);
  const out: WireMsmeDryRun["bills"] = [];
  for (const { b, legal, trade } of rows) {
    if (b.acceptanceDate === null || b.dueDate === null) continue;
    const act = await actDueDate(db, { billId: b.id, vendorId: b.vendorId, billDate: b.billDate, acceptanceDate: b.acceptanceDate, termsDays: b.termsDays }, s.msmeTradersOnClock !== false);
    if (act.dueDate !== b.dueDate) out.push({ billId: b.id, billNo: b.billNo, vendorName: trade ?? legal, dueDate: b.dueDate, actDueDate: act.dueDate });
  }
  return { at: now.toISOString(), bills: out };
}

/* ─────────────────────────────── written objections ─────────────────────────────── */

async function requireObjector(db: Exec, actor: Actor): Promise<void> {
  for (const p of ["materials.bills.manage", "materials.grn.qc", STORES_TAX_MANAGE]) if (await holds(db, actor, p)) return;
  throw new StoresError("not_permitted", "an objection is written by whoever runs QC or books the bill", { permission: "materials.grn.qc" });
}

/** A written objection to a delivery or a service (a QC rejection, a "Short"), on the day it was raised. */
export async function recordMsmeObjection(
  db: Db, actor: Actor, input: { grnId?: string | null; sesId?: string | null; kind: "qc_rejection" | "short"; raisedOn: string; reason: string }, now: Date = new Date(),
): Promise<{ id: string }> {
  await requireObjector(db, actor);
  const why = clean(input.reason);
  if (why === null) throw new StoresError("reason_required", "say what the objection is");
  const grnId = clean(input.grnId);
  const sesId = clean(input.sesId);
  if ((grnId === null) === (sesId === null)) throw new StoresError("bad_quantity", "an objection names the GRN or the service entry sheet");
  let vendorId: string | undefined;
  if (grnId !== null) vendorId = (await db.select({ v: grns.vendorId }).from(grns).where(eq(grns.id, grnId)))[0]?.v;
  else vendorId = (await db.select({ v: storesServiceEntries.vendorId }).from(storesServiceEntries).where(eq(storesServiceEntries.id, sesId!)))[0]?.v;
  if (vendorId === undefined) throw new StoresError(grnId !== null ? "unknown_grn" : "unknown_ses", "the delivery objected to is not on file");
  const id = newId();
  await withTx(db, async (tx) => {
    await tx.insert(storesMsmeObjections).values({ id, vendorId: vendorId!, grnId, sesId, kind: input.kind, raisedOn: input.raisedOn, reason: why.slice(0, 300), raisedBy: actor.id, raisedAt: now });
    await recordAct(tx, actor, now, { act: "msme_objection", refId: id, reason: why.slice(0, 300), after: { grnId, sesId, kind: input.kind, raisedOn: input.raisedOn } });
  });
  return { id };
}

/** The objection is closed (replaced, accepted after all) on a day: the MSME clock starts again from it. */
export async function closeMsmeObjection(db: Db, actor: Actor, objectionId: string, input: { closedOn: string; note: string }, now: Date = new Date()): Promise<{ id: string }> {
  await requireObjector(db, actor);
  const note = clean(input.note);
  if (note === null) throw new StoresError("reason_required", "say how it was closed");
  await withTx(db, async (tx) => {
    const [o] = await tx.select().from(storesMsmeObjections).where(eq(storesMsmeObjections.id, objectionId));
    if (o === undefined) throw new StoresError("unknown_objection", `objection ${objectionId} not found`);
    const [c] = await tx.select({ id: storesMsmeObjectionCloses.id }).from(storesMsmeObjectionCloses).where(eq(storesMsmeObjectionCloses.objectionId, objectionId));
    if (c !== undefined) throw new StoresError("objection_closed", "this objection is already closed");
    if (input.closedOn < o.raisedOn) throw new StoresError("bad_window", "an objection closes on or after the day it was raised");
    await tx.insert(storesMsmeObjectionCloses).values({ id: newId(), objectionId, closedOn: input.closedOn, note: note.slice(0, 300), closedBy: actor.id, closedAt: now });
    await recordAct(tx, actor, now, { act: "msme_objection_close", refId: objectionId, reason: note.slice(0, 300), after: { closedOn: input.closedOn } });
  });
  return { id: objectionId };
}
