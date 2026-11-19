import { asc, desc, eq, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { raiseNotice } from "../../kernel/alerts/notices";
import { withTx } from "../../kernel/db/client";
import { storesAwards, storesBuyExceptionSteps, storesBuyExceptions } from "../../kernel/db/schema";
import { STORES_BUYING_MANAGE, STORES_INDENTS_APPROVE, STORES_MASTERS, holds, recordAct } from "./access";
import { requireGroup } from "./buy-groups";
import { clean, ex, groupLines, holdsRole, peopleNamed, requireCanQuote, usersWithRole, vendorNames } from "./buying-common";
import { BAND_B_MAX_PAISE, bandFor } from "./bands";
import { StoresError } from "./errors";
import { holdersOf } from "./tickets";
import type { Actor, StoresBuyExceptionKind, StoresBuyExceptionStatus, WireBuyException } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * STORES S5c (#1115, edge cases 1 and 9; ruling 0101 Q4) — BUYING OUTSIDE THE QUOTE BANDS, WITH A STAMP FIRST
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * SINGLE SOURCE (a proprietary spare: only one maker supplies it). The buyer names the group, the one supplier and the
 * reason. The user HOD certifies that only one maker supplies it (a central-store group: the materials head, whose store
 * it is — DECIDED). Then the materials head approves up to ₹5 lakh, the owner above (and the owner for a central group,
 * so nobody both certifies and approves, and for medical equipment, which is committee territory — DECIDED). The raiser never certifies or approves; the certifier never approves.
 *
 * EMERGENCY (a part for a failed ventilator at night). Every request in the group is an emergency one. The medical
 * superintendent approves buying on one quote; the owner confirms within 72 hours ("Owner to confirm" until then; past
 * it, `overdue` and red on the owner's sheet). The purchase does not wait for the owner's confirmation.
 *
 * Once approved, the group is bought as band A is (`makePoFromGroup`): the named supplier's one quote, the buyer's award
 * (its only seat is the buyer's), and the PO's own tier approval unchanged — no tier is skipped. A single-source award
 * whose total lands above ₹5 lakh when only the materials head approved is refused (`band_changed`).
 */
export const EXCEPTION_WORDS = {
  certify: ["Single source to certify", "एकल स्रोत प्रमाणित करें"],
  approve: ["Single source to approve", "एकल स्रोत मंज़ूरी बाकी"],
  emergency: ["Emergency buy to approve", "आपात खरीद मंज़ूरी बाकी"],
  confirm: ["Emergency buy to confirm", "आपात खरीद की पुष्टि"],
} as const;
export const EMERGENCY_CONFIRM_MS = 72 * 60 * 60 * 1000;

type ExRow = typeof storesBuyExceptions.$inferSelect;

async function requireBuyer(db: Db | Tx, actor: Actor): Promise<void> {
  if (!(await holds(db, actor, STORES_BUYING_MANAGE))) throw new StoresError("not_permitted", "the buying desk is the buyer's", { permission: STORES_BUYING_MANAGE });
}
type StepRow = typeof storesBuyExceptionSteps.$inferSelect;

async function stepsOf(db: Db | Tx, ids: readonly string[]): Promise<StepRow[]> {
  if (ids.length === 0) return [];
  return ex(db).select().from(storesBuyExceptionSteps).where(inArray(storesBuyExceptionSteps.exceptionId, [...ids])).orderBy(asc(storesBuyExceptionSteps.at));
}

function statusOf(e: ExRow, steps: readonly StepRow[], now: Date): StoresBuyExceptionStatus {
  const has = (k: string): StepRow | undefined => steps.find((s) => s.exceptionId === e.id && s.kind === k);
  if (has("refused") !== undefined) return "refused";
  if (e.kind === "single_source") {
    if (has("certified") === undefined) return "waiting_certificate";
    return has("approved") === undefined ? "waiting_approval" : "approved";
  }
  const approved = has("approved");
  if (approved === undefined) return "waiting_approval";
  if (has("confirmed") !== undefined) return "confirmed";
  return now.getTime() > approved.at.getTime() + EMERGENCY_CONFIRM_MS ? "overdue" : "approved";
}

async function groupDepartments(db: Db | Tx, groupId: string): Promise<string[]> {
  return [...new Set((await groupLines(db, groupId)).filter((l) => l.source === "department").map((l) => l.departmentId).filter((d): d is string => d !== null))];
}

/** What this person may do on the exception now, else null. */
async function capacity(db: Db | Tx, actor: Actor, e: ExRow, steps: readonly StepRow[], now: Date): Promise<{ act: "certify" | "approve" | "confirm"; asRole: string } | null> {
  if (actor.type !== "user" || actor.id === e.raisedBy) return null;
  const status = statusOf(e, steps, now);
  const depts = await groupDepartments(db, e.groupId);
  if (e.kind === "single_source") {
    if (status === "waiting_certificate") {
      if (depts.length === 0) return (await holds(db, actor, STORES_MASTERS)) ? { act: "certify", asRole: "materials_head" } : null;
      for (const d of depts) if (await holds(db, actor, STORES_INDENTS_APPROVE, d)) return { act: "certify", asRole: "hod" };
      return null;
    }
    if (status === "waiting_approval") {
      const certifier = steps.find((s) => s.exceptionId === e.id && s.kind === "certified")?.by;
      if (actor.id === certifier) return null;
      if (e.needsOwner || depts.length === 0) return (await holdsRole(db, actor, "owner")) ? { act: "approve", asRole: "owner" } : null;
      return (await holds(db, actor, STORES_MASTERS)) ? { act: "approve", asRole: "materials_head" } : null;
    }
    return null;
  }
  if (status === "waiting_approval") return (await holdsRole(db, actor, "medical_superintendent")) ? { act: "approve", asRole: "medical_superintendent" } : null;
  if (status === "approved" || status === "overdue") return (await holdsRole(db, actor, "owner")) ? { act: "confirm", asRole: "owner" } : null;
  return null;
}

async function tell(tx: Tx, users: readonly string[], words: readonly [string, string], e: { id: string }, key: string, skip: string | null, now: Date): Promise<void> {
  for (const u of new Set(users)) {
    if (u === skip) continue;
    await raiseNotice(tx as unknown as Db, {
      userId: u, kind: "stores.purchase", title: words[0], body: words[1], refType: "stores_exception", refId: e.id,
      sourceKey: `stores-exception:${e.id}:${key}:${u}`, at: now,
    });
  }
}

export async function requestBuyException(
  db: Db, actor: Actor, input: { kind: StoresBuyExceptionKind; groupId: string; vendorId: string; reason: string }, now: Date = new Date(),
): Promise<WireBuyException> {
  await requireBuyer(db, actor);
  const why = clean(input.reason);
  if (why === null) throw new StoresError("reason_required", "say why one supplier");
  if (input.kind !== "single_source" && input.kind !== "emergency") throw new StoresError("exception_not_needed", "single source or emergency");
  await requireGroup(db, input.groupId);
  const lines = await groupLines(db, input.groupId);
  if (lines.length === 0) throw new StoresError("item_required", "the group has no lines");
  const value = lines.filter((l) => !l.onContract).reduce((a, l) => a + l.qtyBase * l.unitEstimatePaise, 0);
  if (input.kind === "emergency" && lines.some((l) => l.priority !== "emergency")) throw new StoresError("not_emergency", "only emergency requests are bought on one quote this way");
  if (input.kind === "single_source" && bandFor(value, { equipment: lines.some((l) => l.equipment) }) === "A") {
    throw new StoresError("exception_not_needed", "band A is bought on one quote already");
  }
  await requireCanQuote(db, input.vendorId, now);
  const live = await db.select().from(storesBuyExceptions).where(eq(storesBuyExceptions.groupId, input.groupId));
  const liveSteps = await stepsOf(db, live.map((l) => l.id));
  if (live.some((l) => statusOf(l, liveSteps, now) !== "refused")) throw new StoresError("already_requested", "this group already has one");
  const [awarded] = await db.select({ id: storesAwards.id }).from(storesAwards).where(eq(storesAwards.groupId, input.groupId)).limit(1);
  if (awarded !== undefined) throw new StoresError("already_ordered", "this group is already awarded");
  const depts = await groupDepartments(db, input.groupId);
  // Medical equipment is committee territory (decision 2): its single source goes to the owner whatever the value (DECIDED).
  const needsOwner = input.kind === "emergency" ? true : value > BAND_B_MAX_PAISE || lines.some((l) => l.equipment);
  const id = newId();
  await withTx(db, async (tx) => {
    await tx.insert(storesBuyExceptions).values({ id, kind: input.kind, groupId: input.groupId, vendorId: input.vendorId, reason: why, valuePaise: value, needsOwner, raisedBy: actor.id, raisedAt: now });
    await recordAct(tx, actor, now, { act: "request_exception", refId: id, reason: why, after: { kind: input.kind, groupId: input.groupId, vendorId: input.vendorId, valuePaise: value, needsOwner } });
    if (input.kind === "emergency") await tell(tx, await usersWithRole(tx, "medical_superintendent"), EXCEPTION_WORDS.emergency, { id }, "approve", actor.id, now);
    else if (depts.length === 0) await tell(tx, await holdersOf(tx, STORES_MASTERS, "hospital"), EXCEPTION_WORDS.certify, { id }, "certify", actor.id, now);
    else for (const d of depts) await tell(tx, await holdersOf(tx, STORES_INDENTS_APPROVE, { departmentId: d }), EXCEPTION_WORDS.certify, { id }, "certify", actor.id, now);
  });
  return getBuyException(db, id, now, actor);
}

/** The one tap of whoever holds the next step: certify, approve or confirm. */
export async function advanceBuyException(db: Db, actor: Actor, id: string, now: Date = new Date()): Promise<WireBuyException> {
  await withTx(db, async (tx) => {
    const [e] = await tx.select().from(storesBuyExceptions).where(eq(storesBuyExceptions.id, id)).for("update");
    if (e === undefined) throw new StoresError("unknown_exception", "no such request", { id });
    const steps = await stepsOf(tx, [id]);
    const st = statusOf(e, steps, now);
    if (st === "refused" || st === "confirmed") throw new StoresError("exception_closed", "this is already closed");
    if (actor.type === "user" && actor.id === e.raisedBy) throw new StoresError("own_proposal", "you asked for this");
    const cap = await capacity(tx, actor, e, steps, now);
    if (cap === null) throw new StoresError("not_your_seat", "this step is not yours", { status: st });
    const kind = cap.act === "certify" ? "certified" : cap.act === "approve" ? "approved" : "confirmed";
    await tx.insert(storesBuyExceptionSteps).values({ id: newId(), exceptionId: id, kind, asRole: cap.asRole, by: actor.id, at: now });
    await recordAct(tx, actor, now, { act: `${cap.act}_exception` as "certify_exception" | "approve_exception" | "confirm_exception", refId: id, after: { kind: e.kind, asRole: cap.asRole } });
    if (e.kind === "single_source" && kind === "certified") {
      const depts = await groupDepartments(tx, e.groupId);
      const who = e.needsOwner || depts.length === 0 ? await usersWithRole(tx, "owner") : await holdersOf(tx, STORES_MASTERS, "hospital");
      await tell(tx, who.filter((u) => u !== actor.id), EXCEPTION_WORDS.approve, e, "approve", e.raisedBy, now);
    }
    if (e.kind === "emergency" && kind === "approved") await tell(tx, await usersWithRole(tx, "owner"), EXCEPTION_WORDS.confirm, e, "confirm", null, now);
  });
  return getBuyException(db, id, now, actor);
}

/** "Refuse / मना करें" with a reason, by whoever holds the next step. Ends it; the group goes back to quotes. */
export async function refuseBuyException(db: Db, actor: Actor, id: string, reason: string, now: Date = new Date()): Promise<WireBuyException> {
  const why = clean(reason);
  if (why === null) throw new StoresError("reason_required", "say why");
  await withTx(db, async (tx) => {
    const [e] = await tx.select().from(storesBuyExceptions).where(eq(storesBuyExceptions.id, id)).for("update");
    if (e === undefined) throw new StoresError("unknown_exception", "no such request", { id });
    const steps = await stepsOf(tx, [id]);
    const st = statusOf(e, steps, now);
    if (st !== "waiting_certificate" && st !== "waiting_approval") throw new StoresError("exception_closed", "this is past refusing");
    const cap = await capacity(tx, actor, e, steps, now);
    if (cap === null) throw new StoresError("not_your_seat", "this step is not yours", { status: st });
    await tx.insert(storesBuyExceptionSteps).values({ id: newId(), exceptionId: id, kind: "refused", asRole: cap.asRole, reason: why, by: actor.id, at: now });
    await recordAct(tx, actor, now, { act: "refuse_exception", refId: id, reason: why, after: { kind: e.kind, asRole: cap.asRole } });
  });
  return getBuyException(db, id, now, actor);
}

/**
 * The exception a group is bought under, when it is approved (an emergency counts from the superintendent's approval,
 * confirmed or not). `makePoFromGroup` and `enterQuote` ask this.
 */
export async function approvedExceptionFor(db: Db | Tx, groupId: string, now: Date): Promise<ExRow | null> {
  const rows = await ex(db).select().from(storesBuyExceptions).where(eq(storesBuyExceptions.groupId, groupId)).orderBy(desc(storesBuyExceptions.raisedAt));
  const steps = await stepsOf(db, rows.map((r) => r.id));
  return rows.find((r) => ["approved", "confirmed", "overdue"].includes(statusOf(r, steps, now))) ?? null;
}

export async function getBuyException(db: Db | Tx, id: string, now: Date = new Date(), reader?: Actor): Promise<WireBuyException> {
  const [e] = await ex(db).select().from(storesBuyExceptions).where(eq(storesBuyExceptions.id, id));
  if (e === undefined) throw new StoresError("unknown_exception", "no such request", { id });
  return (await exceptionViews(db, [e], now, reader))[0]!;
}

export async function exceptionViews(db: Db | Tx, rows: readonly ExRow[], now: Date, reader?: Actor): Promise<WireBuyException[]> {
  if (rows.length === 0) return [];
  const steps = await stepsOf(db, rows.map((r) => r.id));
  const person = await peopleNamed(db, [...rows.map((r) => r.raisedBy), ...steps.map((s) => s.by)]);
  const names = await vendorNames(db, rows.map((r) => r.vendorId));
  const out: WireBuyException[] = [];
  for (const e of rows) {
    const mine = steps.filter((s) => s.exceptionId === e.id);
    const approved = mine.find((s) => s.kind === "approved");
    const cap = reader === undefined ? null : await capacity(db, reader, e, mine, now);
    out.push({
      id: e.id, kind: e.kind as StoresBuyExceptionKind, groupId: e.groupId, vendorId: e.vendorId, vendorName: names.get(e.vendorId)?.name ?? e.vendorId,
      reason: e.reason, valuePaise: e.valuePaise, needsOwner: e.needsOwner, status: statusOf(e, mine, now), raisedBy: person(e.raisedBy), raisedAt: e.raisedAt.toISOString(),
      steps: mine.map((s) => ({ kind: s.kind as WireBuyException["steps"][number]["kind"], asRole: s.asRole, by: person(s.by), at: s.at.toISOString(), reason: s.reason })),
      confirmBy: e.kind === "emergency" && approved !== undefined ? new Date(approved.at.getTime() + EMERGENCY_CONFIRM_MS).toISOString() : null,
      mine: cap?.act ?? null,
    });
  }
  return out;
}

/** The desk's list (newest first) and, for anyone else, the ones waiting on them. */
export async function listBuyExceptions(db: Db, actor: Actor, now: Date = new Date()): Promise<WireBuyException[]> {
  const rows = await db.select().from(storesBuyExceptions).orderBy(desc(storesBuyExceptions.raisedAt)).limit(100);
  const views = await exceptionViews(db, rows, now, actor);
  try { await requireBuyer(db, actor); return views; } catch { return views.filter((v) => v.mine !== null); }
}
