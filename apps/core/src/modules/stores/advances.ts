import { asc, desc, eq, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { istDayString } from "../../kernel/approvals/cumulative";
import { raiseNotice } from "../../kernel/alerts/notices";
import { withTx } from "../../kernel/db/client";
import { items, purchaseOrderLines, purchaseOrders, storesAwards, storesPoAdvanceSteps, storesPoAdvances } from "../../kernel/db/schema";
import { STORES_BUYING_MANAGE, holds, recordAct } from "./access";
import { categoryRules } from "./asset-rules";
import { clean, ex, holdsRole, peopleNamed, usersWithRole } from "./buying-common";
import { StoresError } from "./errors";
import type { Actor, StoresAdvanceStatus, WirePayTerms, WirePoAdvance } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * STORES S5c (#1115, decision 11; ruling 0101 Q7) — "PAY AFTER GRN", AND THE ONE EXCEPTION: AN ADVANCE ON EQUIPMENT
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Every Stores PO (one made from an award) is pay after GRN — DERIVED, never stored (`payTermsOf`). The only exception:
 * a PO for equipment (any line of a "Medical equipment" item, or an equipment award), where the buyer asks for an
 * advance of at most 30 % against the supplier's bank guarantee (number, bank, valid-to date, amount at least the
 * advance) and the OWNER approves or refuses it. Paying the advance, and holding the bill against it, are S6's (#1116):
 * this row is what S6 reads. A pharmacy PO (no award) never has an advance here (`not_stores_po`).
 *
 * A yearly contract billed at the start by its own terms (AMC, a licence, insurance) is NOT an advance: S6 pays it when
 * the department confirms the term has started (ruling 0101 Q7), so nothing here applies to it.
 */
export const ADVANCE_MAX_BPS = 3_000;
export const ADVANCE_WORDS = { toApprove: ["Advance to approve", "अग्रिम मंज़ूरी बाकी"] } as const;

type AdvRow = typeof storesPoAdvances.$inferSelect;
type StepRow = typeof storesPoAdvanceSteps.$inferSelect;

async function stepsOf(db: Db | Tx, ids: readonly string[]): Promise<StepRow[]> {
  if (ids.length === 0) return [];
  return ex(db).select().from(storesPoAdvanceSteps).where(inArray(storesPoAdvanceSteps.advanceId, [...ids])).orderBy(asc(storesPoAdvanceSteps.at));
}
const statusOf = (a: AdvRow, steps: readonly StepRow[]): StoresAdvanceStatus =>
  (steps.find((s) => s.advanceId === a.id)?.kind as StoresAdvanceStatus | undefined) ?? "requested";

/** Is this PO for equipment: an equipment award, or a line whose item's category is "Medical equipment" (tag rule always)? */
async function isEquipmentPo(db: Db | Tx, po: { id: string; awardId: string | null }): Promise<boolean> {
  if (po.awardId !== null) {
    const [a] = await ex(db).select({ equipment: storesAwards.equipment }).from(storesAwards).where(eq(storesAwards.id, po.awardId));
    if (a?.equipment === true) return true;
  }
  const lines = await ex(db).select({ categoryId: items.categoryId }).from(purchaseOrderLines).innerJoin(items, eq(items.id, purchaseOrderLines.itemId))
    .where(eq(purchaseOrderLines.purchaseOrderId, po.id));
  for (const l of lines) if ((await categoryRules(db, l.categoryId)).tagRule === "always") return true;
  return false;
}

export async function requestPoAdvance(
  db: Db, actor: Actor, poId: string,
  input: { pctBps: number; guaranteeNo: string; guaranteeBank: string; guaranteeValidTo: string; guaranteePaise: number }, now: Date = new Date(),
): Promise<WirePoAdvance> {
  if (!(await holds(db, actor, STORES_BUYING_MANAGE))) throw new StoresError("not_permitted", "an advance is asked for at the buying desk", { permission: STORES_BUYING_MANAGE });
  const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId));
  if (po === undefined) throw new StoresError("unknown_po", "no such PO", { poId });
  if (po.awardId === null) throw new StoresError("not_stores_po", "advances are for Stores POs only");
  if (["cancelled", "received"].includes(po.status)) throw new StoresError("advance_not_allowed", "this PO is closed");
  if (!(await isEquipmentPo(db, po))) throw new StoresError("advance_not_allowed", "no advances, except for equipment (ruling 0101 Q7)");
  if (!Number.isInteger(input.pctBps) || input.pctBps <= 0 || input.pctBps > ADVANCE_MAX_BPS) throw new StoresError("advance_over_limit", "at most 30 % of the PO", { maxBps: ADVANCE_MAX_BPS });
  const amount = Math.round((po.totalPaise * input.pctBps) / 10_000);
  if (!Number.isSafeInteger(input.guaranteePaise) || input.guaranteePaise < amount) throw new StoresError("guarantee_short", "the bank guarantee covers less than the advance", { amountPaise: amount });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.guaranteeValidTo) || input.guaranteeValidTo <= istDayString(now)) throw new StoresError("guarantee_expired", "the bank guarantee must still be valid");
  const no = clean(input.guaranteeNo);
  const bank = clean(input.guaranteeBank);
  if (no === null || bank === null) throw new StoresError("reason_required", "name the guarantee's number and bank");
  const had = await db.select().from(storesPoAdvances).where(eq(storesPoAdvances.poId, poId));
  const hadSteps = await stepsOf(db, had.map((h) => h.id));
  if (had.some((h) => statusOf(h, hadSteps) !== "refused")) throw new StoresError("already_requested", "this PO already has an advance");
  const id = newId();
  await withTx(db, async (tx) => {
    await tx.insert(storesPoAdvances).values({
      id, poId, pctBps: input.pctBps, amountPaise: amount, guaranteeNo: no, guaranteeBank: bank, guaranteeValidTo: input.guaranteeValidTo,
      guaranteePaise: input.guaranteePaise, requestedBy: actor.id, requestedAt: now,
    });
    await recordAct(tx, actor, now, { act: "request_advance", refId: id, after: { poId, pctBps: input.pctBps, amountPaise: amount, guaranteeValidTo: input.guaranteeValidTo } });
    for (const u of await usersWithRole(tx, "owner")) {
      await raiseNotice(tx as unknown as Db, {
        userId: u, kind: "stores.purchase", title: ADVANCE_WORDS.toApprove[0], body: `${ADVANCE_WORDS.toApprove[1]} · ${po.poNo}`,
        refType: "stores_po", refId: poId, sourceKey: `stores-advance:${id}:${u}`, at: now,
      });
    }
  });
  return getPoAdvance(db, id);
}

/** The owner's approval or refusal (a refusal says why). One step, written once. */
export async function decidePoAdvance(db: Db, actor: Actor, advanceId: string, input: { approve: boolean; reason?: string | null }, now: Date = new Date()): Promise<WirePoAdvance> {
  if (!(await holdsRole(db, actor, "owner"))) throw new StoresError("not_your_seat", "the owner approves an advance");
  const why = clean(input.reason);
  if (!input.approve && why === null) throw new StoresError("reason_required", "say why the advance is refused");
  await withTx(db, async (tx) => {
    const [a] = await tx.select().from(storesPoAdvances).where(eq(storesPoAdvances.id, advanceId)).for("update");
    if (a === undefined) throw new StoresError("unknown_advance", "no such advance", { advanceId });
    if (statusOf(a, await stepsOf(tx, [a.id])) !== "requested") throw new StoresError("exception_closed", "already decided");
    if (actor.type === "user" && actor.id === a.requestedBy) throw new StoresError("own_proposal", "you asked for this advance");
    await tx.insert(storesPoAdvanceSteps).values({ id: newId(), advanceId, kind: input.approve ? "approved" : "refused", reason: why, by: actor.id, at: now });
    await recordAct(tx, actor, now, { act: "decide_advance", refId: advanceId, reason: why, after: { poId: a.poId, approved: input.approve } });
  });
  return getPoAdvance(db, advanceId);
}

export async function getPoAdvance(db: Db | Tx, advanceId: string): Promise<WirePoAdvance> {
  const [a] = await ex(db).select().from(storesPoAdvances).where(eq(storesPoAdvances.id, advanceId));
  if (a === undefined) throw new StoresError("unknown_advance", "no such advance", { advanceId });
  return (await advanceViews(db, [a]))[0]!;
}

async function advanceViews(db: Db | Tx, rows: readonly AdvRow[]): Promise<WirePoAdvance[]> {
  const steps = await stepsOf(db, rows.map((r) => r.id));
  const person = await peopleNamed(db, [...rows.map((r) => r.requestedBy), ...steps.map((s) => s.by)]);
  return rows.map((a) => {
    const s = steps.find((x) => x.advanceId === a.id);
    return {
      id: a.id, poId: a.poId, pctBps: a.pctBps, amountPaise: a.amountPaise, guaranteeNo: a.guaranteeNo, guaranteeBank: a.guaranteeBank,
      guaranteeValidTo: a.guaranteeValidTo, guaranteePaise: a.guaranteePaise, status: statusOf(a, steps), requestedBy: person(a.requestedBy),
      requestedAt: a.requestedAt.toISOString(), decidedBy: s === undefined ? null : person(s.by), decidedAt: s?.at.toISOString() ?? null, reason: s?.reason ?? null,
    };
  });
}

/** The PO's newest advance (any status), for the sheet. */
export async function advanceOfPo(db: Db | Tx, poId: string): Promise<WirePoAdvance | null> {
  const rows = await ex(db).select().from(storesPoAdvances).where(eq(storesPoAdvances.poId, poId)).orderBy(desc(storesPoAdvances.requestedAt)).limit(1);
  return rows.length === 0 ? null : (await advanceViews(db, rows))[0]!;
}

/** Decision 11, derived: "Pay after GRN" unless an owner-APPROVED advance names the PO. */
export async function payTermsOf(db: Db | Tx, poId: string): Promise<WirePayTerms> {
  const rows = await ex(db).select().from(storesPoAdvances).where(eq(storesPoAdvances.poId, poId));
  const steps = await stepsOf(db, rows.map((r) => r.id));
  const ok = rows.find((r) => statusOf(r, steps) === "approved");
  return ok === undefined ? { kind: "after_grn" } : { kind: "advance", pctBps: ok.pctBps, amountPaise: ok.amountPaise, advanceId: ok.id };
}

/** Advances waiting on the owner (the PO sheet and the owner's list). */
export async function advancesToDecide(db: Db, actor: Actor): Promise<WirePoAdvance[]> {
  if (!(await holdsRole(db, actor, "owner"))) return [];
  const rows = await db.select().from(storesPoAdvances).orderBy(asc(storesPoAdvances.requestedAt)).limit(100);
  return (await advanceViews(db, rows)).filter((a) => a.status === "requested");
}
