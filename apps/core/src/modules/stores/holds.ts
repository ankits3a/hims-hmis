import { and, asc, desc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { istDayString } from "../../kernel/approvals/cumulative";
import { raiseNotice } from "../../kernel/alerts/notices";
import { hasPermission } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import {
  grns, items, purchaseOrders, storesBillHoldSteps, storesBillHolds, supplierBillLines, supplierBills, supplierPaymentRunLines, supplierPaymentRuns, vendors,
} from "../../kernel/db/schema";
import { matchTolerancePaise, registerBillHoldHooks } from "../materials";
import { STORES_HOLDS_RELEASE, holds, recordAct } from "./access";
import { payTermsOf } from "./advances";
import { clean, ex, holdsRole, peopleNamed, usersWithRole } from "./buying-common";
import { StoresError } from "./errors";
import { payingSettings } from "./paying-settings";
import { supplierKyc } from "./suppliers";
import type { Exec } from "./buying-common";
import type { Actor, WireHoldsDryRun, WirePayHold, WirePayHoldKind, WirePayHoldRefusal, WirePayingSettings } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * STORES S6a (#1116, decisions 7–8; ruling 0101 Q6) — PAYMENT HOLDS AND THEIR RELEASE.
 *
 * Holds place themselves, by rule (never by the agent), when a bill is booked (accepted) and again when a run is drafted
 * or submitted (materials' `registerBillHoldHooks`, registered below at import). Each names its rule and cites the rows
 * behind it. A kind already open on the bill is not placed again, and a kind a person released is not placed again. "Open" is derived: placed, no `released` step, and
 * for `bank_cooling_off` before its `ends_at` (it ends by time; nobody releases it). An open hold keeps its bill out of
 * every run draft, refuses a run's submit (`line_on_hold`) and the payment.
 *
 * Scope (decision 7): a bill with at least one Stores item line or one service line. A pharmacy-only bill is never
 * held until the owner switches `holds_cover_pharmacy` on after the dry run (`holdsDryRun`, writes nothing).
 *
 * Release (ruling 0101 Q6): `stores.holds.release`, a typed reason; up to ₹50,000 (the bill's total) the materials head,
 * above that only the owner; never the bill's booker, never the person who approved its PO, never the authoriser of a
 * run that carries it. Keep: a reason and a review date at most 30 days on; the hold stays open (an MSME clock does not
 * stop for a hold).
 */
export const HOLD_RELEASE_LIMIT_PAISE = 5_000_000;
const KEEP_MAX_DAYS = 30;
const DUPLICATE_WINDOW_DAYS = 7;
const PATTERN_WINDOW_DAYS = 365;
const PAYABLE = ["accepted", "part_paid"];
const READERS = ["materials.bills.manage", "materials.payments.prepare", "materials.payments.record", STORES_HOLDS_RELEASE, "approvals.requests.decide"];
export const HOLD_WORDS = { toClear: ["Holds to clear", "रोक हटानी है"] } as const;

type Evidence = { type: string; id: string; no: string };
type Found = { kind: WirePayHoldKind; evidence: Evidence[]; endsAt: Date | null };
type BillRow = typeof supplierBills.$inferSelect;
type HoldRow = typeof storesBillHolds.$inferSelect;
type StepRow = typeof storesBillHoldSteps.$inferSelect;

const dayOffset = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export async function requirePayingReader(db: Exec, actor: Actor): Promise<void> {
  if (actor.type === "user") for (const p of READERS) if (await hasPermission(ex(db), actor.id, p, "hospital")) return;
  throw new StoresError("not_permitted", "the paying desk is read by whoever books, prepares, records, releases or authorises", { permission: READERS.join(", ") });
}

/** A bill with a Stores item line or a service line (decision 7's scope). */
async function isStoresBill(db: Exec, billId: string): Promise<boolean> {
  const rows = await ex(db).select({ sesId: supplierBillLines.sesId, trackMode: items.trackMode, klass: items.class }).from(supplierBillLines)
    .innerJoin(items, eq(items.id, supplierBillLines.itemId)).where(eq(supplierBillLines.billId, billId));
  return rows.some((r) => r.sesId !== null || (r.trackMode !== null && r.klass !== "drug"));
}

/** The 90th percentile, nearest rank. */
function p90(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(0.9 * s.length) - 1)]!;
}

/** What the rules find on one bill now (writes nothing). `settings` lets the dry run ask "as if switched on". */
async function evaluate(db: Exec, b: BillRow, now: Date, settings: WirePayingSettings): Promise<Found[]> {
  if (!(await isStoresBill(db, b.id)) && !settings.holdsCoverPharmacy) return [];
  const found: Found[] = [];
  const [v] = await ex(db).select().from(vendors).where(eq(vendors.id, b.vendorId));
  const self: Evidence = { type: "bill", id: b.id, no: b.billNo };

  // duplicate_like: same supplier and total, bill dates within 7 days, a different number (the same number is refused).
  const near = await ex(db).select({ id: supplierBills.id, billNo: supplierBills.billNo, key: supplierBills.vendorBillKey }).from(supplierBills)
    .where(and(
      eq(supplierBills.vendorId, b.vendorId), eq(supplierBills.totalPaise, b.totalPaise), ne(supplierBills.id, b.id), ne(supplierBills.status, "cancelled"),
      gte(supplierBills.billDate, dayOffset(b.billDate, -DUPLICATE_WINDOW_DAYS)), lte(supplierBills.billDate, dayOffset(b.billDate, DUPLICATE_WINDOW_DAYS)),
    )).orderBy(asc(supplierBills.billNo));
  const twins = near.filter((x) => x.key !== b.vendorBillKey);
  if (twins.length > 0) found.push({ kind: "duplicate_like", evidence: [self, ...twins.map((x) => ({ type: "bill", id: x.id, no: x.billNo }))], endsAt: null });

  // out_of_pattern: above 2 × the 90th percentile of the supplier's bills in 12 months, or a first bill above ₹1,00,000.
  const prior = await ex(db).select({ id: supplierBills.id, billNo: supplierBills.billNo, total: supplierBills.totalPaise }).from(supplierBills)
    .where(and(
      eq(supplierBills.vendorId, b.vendorId), ne(supplierBills.id, b.id), inArray(supplierBills.status, ["accepted", "part_paid", "paid"]),
      gte(supplierBills.billDate, dayOffset(b.billDate, -PATTERN_WINDOW_DAYS)), lte(supplierBills.billDate, b.billDate),
    )).orderBy(desc(supplierBills.billDate)).limit(500);
  if (prior.length === 0) {
    if (b.totalPaise > settings.firstBillLimitPaise) found.push({ kind: "out_of_pattern", evidence: [self], endsAt: null });
  } else if (b.totalPaise * 10_000 > p90(prior.map((x) => x.total)) * settings.outOfPatternMultipleBps) {
    found.push({ kind: "out_of_pattern", evidence: [self, ...prior.slice(0, 20).map((x) => ({ type: "bill", id: x.id, no: x.billNo }))], endsAt: null });
  }

  // bank_cooling_off: the supplier's bank changed and the first payment is not yet allowed (ends by itself).
  if (v!.firstPaymentAllowedAt !== null && v!.firstPaymentAllowedAt > now) {
    found.push({ kind: "bank_cooling_off", evidence: [{ type: "vendor", id: v!.id, no: v!.code }], endsAt: v!.firstPaymentAllowedAt });
  }

  // kyc_incomplete: S5a's "KYC complete" rule.
  if ((await supplierKyc(db, b.vendorId, now)).level !== "complete") found.push({ kind: "kyc_incomplete", evidence: [{ type: "vendor", id: v!.id, no: v!.code }], endsAt: null });

  // above_po: every live bill on the PO, this one included, above the PO's value beyond the match tolerance.
  const lines = await ex(db).select({ grnId: supplierBillLines.grnId, sesId: supplierBillLines.sesId, mismatch: supplierBillLines.mismatch, grnNo: grns.grnNo })
    .from(supplierBillLines).leftJoin(grns, eq(grns.id, supplierBillLines.grnId)).where(eq(supplierBillLines.billId, b.id));
  if (b.purchaseOrderId !== null) {
    const [po] = await ex(db).select().from(purchaseOrders).where(eq(purchaseOrders.id, b.purchaseOrderId));
    const [sum] = await ex(db).select({ n: sql<string>`coalesce(sum(${supplierBills.totalPaise}), 0)` }).from(supplierBills)
      .where(and(eq(supplierBills.purchaseOrderId, b.purchaseOrderId), ne(supplierBills.status, "cancelled")));
    if (po !== undefined && Number(sum?.n ?? 0) > po.totalPaise + matchTolerancePaise(po.totalPaise)) {
      found.push({ kind: "above_po", evidence: [self, { type: "po", id: po.id, no: po.poNo }], endsAt: null });
    }
  }

  // pay_after_grn: billed for more than was received (or for what was not) on a pay-after-GRN order (ruling 0101 Q7).
  const early = lines.filter((l) => (l.mismatch ?? "").split(",").some((m) => m === "not_received" || m === "qty_over"));
  if (early.length > 0) {
    const terms = b.purchaseOrderId === null ? { kind: "after_grn" as const } : await payTermsOf(db, b.purchaseOrderId);
    if (terms.kind === "after_grn") {
      const docs = new Map<string, Evidence>();
      for (const l of early) {
        if (l.grnId !== null) docs.set(l.grnId, { type: "grn", id: l.grnId, no: l.grnNo ?? "" });
        else if (l.sesId !== null) docs.set(l.sesId, { type: "ses", id: l.sesId, no: "" });
      }
      found.push({ kind: "pay_after_grn", evidence: [self, ...docs.values()], endsAt: null });
    }
  }

  // irn_missing (S6b, decision 4): a supplier declared for e-invoicing, a line claiming credit (eligible or shared), no IRN.
  if (v!.einvoiceApplicable === true && (b.irn ?? null) === null) {
    const marks = await ex(db).select({ credit: supplierBillLines.gstCredit }).from(supplierBillLines).where(eq(supplierBillLines.billId, b.id));
    if (marks.some((m) => m.credit === "eligible" || m.credit === "shared")) found.push({ kind: "irn_missing", evidence: [self, { type: "vendor", id: v!.id, no: v!.code }], endsAt: null });
  }
  return found;
}

async function stepsOf(db: Exec, holdIds: readonly string[]): Promise<StepRow[]> {
  if (holdIds.length === 0) return [];
  return ex(db).select().from(storesBillHoldSteps).where(inArray(storesBillHoldSteps.holdId, [...holdIds])).orderBy(asc(storesBillHoldSteps.at), asc(storesBillHoldSteps.id));
}

function statusOf(h: HoldRow, steps: readonly StepRow[], now: Date): WirePayHold["status"] {
  const mine = steps.filter((s) => s.holdId === h.id);
  if (mine.some((s) => s.step === "released")) return "released";
  if (h.endsAt !== null && h.endsAt <= now) return "ended";
  return mine.some((s) => s.step === "kept") ? "kept" : "open";
}

/** Open (or kept) holds by bill — what keeps a bill out of a run. */
async function openHoldRows(db: Exec, billIds: readonly string[], now: Date): Promise<HoldRow[]> {
  if (billIds.length === 0) return [];
  const rows = await ex(db).select().from(storesBillHolds).where(inArray(storesBillHolds.billId, [...billIds]));
  const steps = await stepsOf(db, rows.map((r) => r.id));
  return rows.filter((h) => { const s = statusOf(h, steps, now); return s === "open" || s === "kept"; });
}

/** Run the rules over one bill and place what is not already open. Only a payable bill is held. Returns the new holds. */
async function placeHolds(tx: Tx, actor: Actor, billId: string, now: Date, trigger: "booked" | "recheck"): Promise<string[]> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stores-hold:${billId}`}))`);
  const [b] = await tx.select().from(supplierBills).where(eq(supplierBills.id, billId));
  if (b === undefined || !PAYABLE.includes(b.status)) return [];
  const found = await evaluate(tx, b, now, await payingSettings(tx));
  if (found.length === 0) return [];
  const open = new Set((await openHoldRows(tx, [billId], now)).map((h) => h.kind));
  // A released hold is a person's decision: its rule is not placed on the bill again. A cooling-off hold that ended by
  // time comes back only for a NEW cooling-off (another bank change, another end).
  const all = await tx.select().from(storesBillHolds).where(eq(storesBillHolds.billId, billId));
  const steps = await stepsOf(tx, all.map((h) => h.id));
  const released = new Set(all.filter((h) => statusOf(h, steps, now) === "released").map((h) => h.kind));
  const coolEnds = new Set(all.filter((h) => h.kind === "bank_cooling_off").map((h) => h.endsAt?.getTime()));
  const placed: string[] = [];
  for (const f of found) {
    if (open.has(f.kind)) continue;
    if (f.kind === "bank_cooling_off" ? coolEnds.has(f.endsAt?.getTime()) : released.has(f.kind)) continue;
    const id = newId();
    await tx.insert(storesBillHolds).values({ id, billId, kind: f.kind, evidence: f.evidence, endsAt: f.endsAt, trigger, placedBy: actor.id, placedAt: now });
    await recordAct(tx, actor, now, {
      act: "hold_placed", refId: id, after: { billId, billNo: b.billNo, kind: f.kind, evidence: f.evidence, endsAt: f.endsAt?.toISOString() ?? null, trigger },
    });
    placed.push(id);
  }
  if (placed.length > 0) {
    // "Holds to clear" — a few words, no supplier and no amount (Screens: notices).
    const to = new Set([...(await usersWithRole(tx, "materials_head")), ...(await usersWithRole(tx, "owner"))]);
    for (const u of to) {
      await raiseNotice(tx as unknown as Db, {
        userId: u, kind: "stores.purchase", title: HOLD_WORDS.toClear[0], body: `${HOLD_WORDS.toClear[1]} · ${b.billNo}`, refType: "stores_pay_hold", refId: billId,
        sourceKey: `stores-hold:${billId}:${placed[0]!}:${u}`, at: now,
      });
    }
  }
  return placed;
}

/** Run the rules again over one bill (booking it twice places nothing new). */
export async function recheckBillHolds(db: Db, actor: Actor, billId: string, now: Date = new Date()): Promise<string[]> {
  return withTx(db, (tx) => placeHolds(tx, actor, billId, now, "recheck"));
}

async function holdViews(db: Exec, actor: Actor, rows: readonly HoldRow[], now: Date): Promise<WirePayHold[]> {
  if (rows.length === 0) return [];
  const steps = await stepsOf(db, rows.map((r) => r.id));
  const bills = await ex(db).select({ b: supplierBills, legal: vendors.legalName, trade: vendors.tradeName }).from(supplierBills)
    .innerJoin(vendors, eq(vendors.id, supplierBills.vendorId)).where(inArray(supplierBills.id, [...new Set(rows.map((r) => r.billId))]));
  const person = await peopleNamed(db, steps.map((s) => s.by));
  const out: WirePayHold[] = [];
  for (const h of rows) {
    const bill = bills.find((x) => x.b.id === h.billId)!;
    const mine = steps.filter((s) => s.holdId === h.id);
    const kept = [...mine].reverse().find((s) => s.step === "kept");
    const released = mine.find((s) => s.step === "released");
    const status = statusOf(h, steps, now);
    const refusal = status === "open" || status === "kept" ? await releaseRefusal(db, actor, h, bill.b) : null;
    out.push({
      id: h.id, billId: h.billId, billNo: bill.b.billNo, vendorName: bill.trade ?? bill.legal, totalPaise: bill.b.totalPaise, msme: bill.b.msme, dueDate: bill.b.dueDate,
      kind: h.kind as WirePayHoldKind, evidence: h.evidence as Evidence[], placedAt: h.placedAt.toISOString(), endsAt: h.endsAt?.toISOString() ?? null, status,
      kept: kept === undefined ? null : { reason: kept.reason, reviewOn: kept.reviewOn ?? "", by: person(kept.by) },
      released: released === undefined ? null : { reason: released.reason, at: released.at.toISOString(), by: person(released.by) },
      canRelease: (status === "open" || status === "kept") && refusal === null, refusal,
    });
  }
  return out;
}

/** Every hold on one bill (open, kept, released, ended), oldest first. */
export async function holdsForBill(db: Db, actor: Actor, billId: string, now: Date = new Date()): Promise<WirePayHold[]> {
  await requirePayingReader(db, actor);
  const rows = await db.select().from(storesBillHolds).where(eq(storesBillHolds.billId, billId)).orderBy(asc(storesBillHolds.placedAt), asc(storesBillHolds.id));
  return holdViews(db, actor, rows, now);
}

/** "Holds to clear": every open or kept hold, oldest first. */
export async function holdsToClear(db: Db, actor: Actor, now: Date = new Date()): Promise<WirePayHold[]> {
  await requirePayingReader(db, actor);
  const rows = await db.select().from(storesBillHolds).orderBy(asc(storesBillHolds.placedAt), asc(storesBillHolds.id)).limit(2000);
  const steps = await stepsOf(db, rows.map((r) => r.id));
  return holdViews(db, actor, rows.filter((h) => { const s = statusOf(h, steps, now); return s === "open" || s === "kept"; }), now);
}

/** Why this person may not release this hold, or null. The order is the screen's: time, permission, booker, PO approver, run, limit. */
async function releaseRefusal(db: Exec, actor: Actor, h: HoldRow, b: BillRow): Promise<WirePayHold["refusal"]> {
  const no = (code: WirePayHoldRefusal, ask: string | null = null, on: string | null = null): WirePayHold["refusal"] => ({ code, ask, on });
  if (h.kind === "bank_cooling_off") return no("ends_by_itself", null, h.endsAt?.toISOString() ?? null);
  if (!(await holds(db, actor, STORES_HOLDS_RELEASE))) return no("not_permitted");
  const owner = await holdsRole(db, actor, "owner");
  const askOwner = async (): Promise<string | null> => {
    const [o] = await usersWithRole(db, "owner");
    return o === undefined ? null : (await peopleNamed(db, [o]))(o).name;
  };
  if (b.createdBy === actor.id) return no("own_bill", await askOwner());
  const pos = await purchaseOrdersOf(db, b);
  if (pos.some((p) => p.approvedBy === actor.id)) return no("po_approver", await askOwner());
  const runs = await ex(db).select({ by: supplierPaymentRuns.authorisedBy }).from(supplierPaymentRunLines)
    .innerJoin(supplierPaymentRuns, eq(supplierPaymentRuns.id, supplierPaymentRunLines.runId))
    .where(and(eq(supplierPaymentRunLines.billId, b.id), ne(supplierPaymentRuns.status, "cancelled")));
  if (runs.some((r) => r.by === actor.id)) return no("run_authoriser", await askOwner());
  if (!owner && b.totalPaise > HOLD_RELEASE_LIMIT_PAISE) return no("above_limit", await askOwner());
  return null;
}

/** The PO the bill names, and the POs of its GRNs. */
async function purchaseOrdersOf(db: Exec, b: BillRow): Promise<(typeof purchaseOrders.$inferSelect)[]> {
  const viaGrn = await ex(db).selectDistinct({ id: grns.purchaseOrderId }).from(supplierBillLines).innerJoin(grns, eq(grns.id, supplierBillLines.grnId))
    .where(eq(supplierBillLines.billId, b.id));
  const ids = [...new Set([b.purchaseOrderId, ...viaGrn.map((r) => r.id)].filter((x): x is string => x !== null))];
  return ids.length === 0 ? [] : ex(db).select().from(purchaseOrders).where(inArray(purchaseOrders.id, ids));
}

const REFUSAL_WORDS: Record<WirePayHoldRefusal, string> = {
  ends_by_itself: "a bank change's cooling-off ends by itself; nobody releases it",
  not_permitted: "releasing a hold needs stores.holds.release",
  own_bill: "you booked this bill; somebody else releases its hold",
  po_approver: "you approved this bill's PO; somebody else releases its hold",
  run_authoriser: "you authorised a run that carries this bill; somebody else releases its hold",
  above_limit: "above ₹50,000 the owner releases a hold",
};

async function lockHold(tx: Tx, holdId: string): Promise<{ h: HoldRow; b: BillRow; steps: StepRow[] }> {
  const [h] = await tx.select().from(storesBillHolds).where(eq(storesBillHolds.id, holdId)).for("update");
  if (h === undefined) throw new StoresError("unknown_hold", `hold ${holdId} not found`);
  const [b] = await tx.select().from(supplierBills).where(eq(supplierBills.id, h.billId));
  return { h, b: b!, steps: await stepsOf(tx, [holdId]) };
}

async function asRoleOf(db: Exec, actor: Actor): Promise<string> {
  if (await holdsRole(db, actor, "owner")) return "owner";
  if (await holdsRole(db, actor, "materials_head")) return "materials_head";
  return "other";
}

export async function releaseHold(db: Db, actor: Actor, holdId: string, reason: string, now: Date = new Date()): Promise<WirePayHold> {
  const why = clean(reason);
  await withTx(db, async (tx) => {
    const { h, b, steps } = await lockHold(tx, holdId);
    const status = statusOf(h, steps, now);
    if (status === "released" || status === "ended") throw new StoresError("hold_closed", `the hold is ${status}`);
    if (h.kind === "bank_cooling_off") throw new StoresError("ends_by_itself", REFUSAL_WORDS.ends_by_itself, { endsAt: h.endsAt?.toISOString() ?? null });
    if (!(await holds(tx, actor, STORES_HOLDS_RELEASE))) throw new StoresError("not_permitted", REFUSAL_WORDS.not_permitted, { permission: STORES_HOLDS_RELEASE });
    if (why === null) throw new StoresError("reason_required", "say why the hold is released");
    const refusal = await releaseRefusal(tx, actor, h, b);
    if (refusal !== null) throw new StoresError(refusal.code, REFUSAL_WORDS[refusal.code], { ask: refusal.ask });
    await tx.insert(storesBillHoldSteps).values({ id: newId(), holdId, step: "released", reason: why.slice(0, 300), reviewOn: null, asRole: await asRoleOf(tx, actor), by: actor.id, at: now });
    await recordAct(tx, actor, now, {
      act: "hold_release", refId: holdId, reason: why.slice(0, 300), before: { status }, after: { status: "released", billId: b.id, billNo: b.billNo, kind: h.kind, totalPaise: b.totalPaise },
    });
  });
  return (await holdViews(db, actor, await db.select().from(storesBillHolds).where(eq(storesBillHolds.id, holdId)), now))[0]!;
}

export async function keepHold(db: Db, actor: Actor, holdId: string, input: { reason: string; reviewOn: string }, now: Date = new Date()): Promise<WirePayHold> {
  const why = clean(input.reason);
  await withTx(db, async (tx) => {
    const { h, b, steps } = await lockHold(tx, holdId);
    const status = statusOf(h, steps, now);
    if (status === "released" || status === "ended") throw new StoresError("hold_closed", `the hold is ${status}`);
    if (!(await holds(tx, actor, STORES_HOLDS_RELEASE))) throw new StoresError("not_permitted", REFUSAL_WORDS.not_permitted, { permission: STORES_HOLDS_RELEASE });
    if (why === null) throw new StoresError("reason_required", "say why the hold is kept");
    const today = istDayString(now);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.reviewOn) || input.reviewOn < today || input.reviewOn > dayOffset(today, KEEP_MAX_DAYS)) {
      throw new StoresError("review_too_far", `the review date is between today and ${String(KEEP_MAX_DAYS)} days on`);
    }
    await tx.insert(storesBillHoldSteps).values({ id: newId(), holdId, step: "kept", reason: why.slice(0, 300), reviewOn: input.reviewOn, asRole: await asRoleOf(tx, actor), by: actor.id, at: now });
    await recordAct(tx, actor, now, {
      act: "hold_keep", refId: holdId, reason: why.slice(0, 300), before: { status }, after: { status: "kept", reviewOn: input.reviewOn, billId: b.id, billNo: b.billNo, kind: h.kind },
    });
  });
  return (await holdViews(db, actor, await db.select().from(storesBillHolds).where(eq(storesBillHolds.id, holdId)), now))[0]!;
}

/**
 * Decision 13 — "See what changes" before "Holds on pharmacy bills" is switched on: every payable pharmacy-only bill the
 * rules would hold, and which rules. The owner's. Writes nothing.
 */
export async function holdsDryRun(db: Db, actor: Actor, now: Date = new Date()): Promise<WireHoldsDryRun> {
  if (!(await holdsRole(db, actor, "owner"))) throw new StoresError("not_permitted", "the paying switches and their dry runs are the owner's");
  const settings = { ...(await payingSettings(db)), holdsCoverPharmacy: true };
  const bills = await db.select({ b: supplierBills, legal: vendors.legalName, trade: vendors.tradeName }).from(supplierBills)
    .innerJoin(vendors, eq(vendors.id, supplierBills.vendorId)).where(inArray(supplierBills.status, PAYABLE)).orderBy(asc(supplierBills.billNo)).limit(5000);
  const out: WireHoldsDryRun["bills"] = [];
  for (const { b, legal, trade } of bills) {
    if (await isStoresBill(db, b.id)) continue;
    const open = new Set((await openHoldRows(db, [b.id], now)).map((h) => h.kind));
    const kinds = (await evaluate(db, b, now, settings)).map((f) => f.kind).filter((k) => !open.has(k));
    if (kinds.length > 0) out.push({ billId: b.id, billNo: b.billNo, vendorName: trade ?? legal, totalPaise: b.totalPaise, kinds });
  }
  return { at: now.toISOString(), bills: out };
}

/** Bills due within `billIds` that carry an open hold (the run's "k held out"). */
export async function heldBillIds(db: Exec, billIds: readonly string[], now: Date): Promise<Set<string>> {
  return new Set((await openHoldRows(db, billIds, now)).map((h) => h.billId));
}

/** The kinds of the open (or kept) holds on one bill. */
export async function openHoldKinds(db: Exec, billId: string, now: Date): Promise<WirePayHoldKind[]> {
  return [...new Set((await openHoldRows(db, [billId], now)).map((h) => h.kind as WirePayHoldKind))];
}

registerBillHoldHooks({
  onBooked: async (tx, actor, billId, now) => { await placeHolds(tx, actor, billId, now, "booked"); },
  recheck: async (db, actor, billIds, now) => {
    await withTx(db, async (tx) => { for (const id of billIds) await placeHolds(tx, actor, id, now, "recheck"); });
  },
  openHolds: (db, billIds, now) => heldBillIds(db, billIds, now),
});
