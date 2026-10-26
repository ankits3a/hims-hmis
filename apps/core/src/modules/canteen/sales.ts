import { and, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import {
  CANTEEN_GST_CATEGORIES, CANTEEN_NIGHT_FROM_MINUTE, CANTEEN_NIGHT_TO_MINUTE, CANTEEN_PAY_MODES, allergensInText, approveVarianceInput,
  canteenSaleInput, closeTillInput, newId, openTillInput,
} from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import {
  approvals, canteenCharityGrants, canteenDishes, canteenFreeRules, canteenCostCentres, canteenSaleLines, canteenSales, canteenTillSessions,
  canteenTills,
} from "../../kernel/db/schema";
import { npoCovering } from "../diet";
import { canteenAdmissionFacts, postCanteenChargeIn } from "../ipd";
import { listAllergies } from "../patients";
import { publishedAsKnownAt } from "../roster";
import { CanteenRefusal } from "./errors";
import { requireAny } from "./guard";
import { fyShort, gstRow, istDate, istDayBounds, istMinute, nextNo, splitInclusive } from "./money";
import { CANTEEN_FINANCE, CANTEEN_MANAGE, CANTEEN_SELL, CANTEEN_VIEW } from "./names";
import { bedClassMealsPerDay, outletOf, parse, priceAt, staffRuleAt } from "./setup";
import { cardOfQr } from "./staff-card";
import type {
  Actor, CanteenFoodType, CanteenGstTreatment, CanteenPayMode, CanteenPayment, CanteenPriceList, CanteenSale, CanteenSaleChannel, CanteenSaleLine,
  CanteenSaleState, CanteenStaffGst, CanteenStaffPriceBasis, CanteenTillClose,
} from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { CanteenAdmissionFacts } from "../ipd";
import type { Opts, OutletRow } from "./setup";

/**
 * ═══ THE SALE ═══
 *
 * One function prices every sale, from the counter or a bed's QR (`draftSale`), and one writes it (`writeSale`), in the
 * caller's transaction. The rules, in order:
 *
 * - A PAYMENT MODE OR NOTHING (D1). A sale without one is refused before anything else is read.
 * - A CATERER OUTLET takes cash or UPI only (DECIDED until the owner rules on collecting for the caterer), and its lines
 *   are `caterer`: the caterer is the seller and owes its own GST; its sales never reach the hospital's totals (D7).
 * - FOR THE PATIENT (D4): refused while the patient is NPO (diet's `npoCovering`) and for a dish carrying an FSSAI allergen
 *   the patient's recorded allergy names (`allergensInText` over every active allergy). No diagnosis is read or shown.
 * - THE PRICE LIST: public; the staff card's rule (free, staff, subsidised or public); subsidised under an approved
 *   subsidised family grant. A dish with no price on the list needed refuses the sale.
 * - STAFF CARD (D2): the category's rule at the sale is COPIED onto it. The night-duty meal (rule allows it, 22:00–06:00
 *   IST, on a published roster slot at that instant, one a night) is free and outside the daily cap; otherwise the cap
 *   counts the IST day's card meals. A rule with salary deduction puts the whole amount on the payroll list.
 * - GST (D6): `caterer`; `exempt` (`inpatient_diet`) for food to the patient as part of the stay (bed class or IPD bill);
 *   `not_supply` for a cost centre, a free rule, a free family meal, a free staff meal and staff recovery finance marked
 *   so; otherwise `taxable` at the `gst_config` row (`canteen_food`, or `canteen_staff_recovery`, which must exist).
 *   The tax comes out of the inclusive price (CGST = SGST).
 * - IPD BILL: each line posts one `ipd.canteen` line through ipd's door; the sale line takes the engine's figures so the
 *   final bill's invoice equals the stay's line to the paisa.
 * - BED CLASS: the class's meals a day, counted per IST day per admission.
 */

type Line = { dishId: string; qty: number };
type DishRow = typeof canteenDishes.$inferSelect;
export type SaleRow = typeof canteenSales.$inferSelect;
type SessionRow = typeof canteenTillSessions.$inferSelect;
export type StaffRuleCopy = { ruleId: string; priceBasis: CanteenStaffPriceBasis; dailyCap: number; nightMeal: boolean; salaryDeduction: boolean; gst: CanteenStaffGst };

const TAKES_MONEY_AT_CATERER: readonly CanteenPayMode[] = ["cash", "upi"];
const NIGHT_LOOKBACK_MS = 12 * 3_600_000;

/** Refuses a raw sale whose `pay` is missing or names no mode this canteen knows (D1), before any parse. */
export function requirePayMode(raw: unknown): void {
  const pay = (raw as { pay?: { mode?: unknown } } | null)?.pay;
  if (pay === undefined || pay === null || typeof pay.mode !== "string" || !(CANTEEN_PAY_MODES as readonly string[]).includes(pay.mode)) {
    throw new CanteenRefusal("payment_mode_required");
  }
}

export type SaleDraft = {
  outlet: OutletRow;
  channel: CanteenSaleChannel;
  state: CanteenSaleState;
  pay: CanteenPayment;
  lines: { dish: DishRow; qty: number; unitPaise: number; valuePaise: number }[];
  treatment: { kind: CanteenGstTreatment; category: string | null; rateBps: number };
  admission: CanteenAdmissionFacts | null;
  forPatient: boolean;
  staff: { cardId: string; userId: string; rule: StaffRuleCopy; night: boolean } | null;
  grantId: string | null;
  upiReference: string | null;
};

async function admissionOrRefuse(tx: Tx, admissionId: string): Promise<CanteenAdmissionFacts> {
  const a = await canteenAdmissionFacts(tx, admissionId);
  if (a === null) throw new CanteenRefusal("not_found", { admissionId });
  if (a.closed !== null) throw new CanteenRefusal(a.closed, { admissionId });
  return a;
}

/** D4 — NPO and the patient's recorded allergens against the dishes. */
export async function checkPatientFood(tx: Tx, a: CanteenAdmissionFacts, dishes: readonly DishRow[], at: Date): Promise<void> {
  if ((await npoCovering(tx, a.patientId, at)) !== null) throw new CanteenRefusal("patient_npo", { admissionId: a.admissionId });
  const allergies = (await listAllergies(tx as unknown as Db, a.patientId)).filter((x) => x.status === "active");
  const named = new Set(allergies.flatMap((x) => allergensInText(`${x.substance} ${x.allergenClass ?? ""}`)));
  for (const d of dishes) {
    const hit = d.allergens.filter((x) => named.has(x as never));
    if (hit.length > 0) throw new CanteenRefusal("patient_allergen", { dishId: d.id, dishName: d.name, allergens: hit });
  }
}

async function dishesFor(tx: Tx, outletId: string, lines: readonly Line[]): Promise<Map<string, DishRow>> {
  const ids = [...new Set(lines.map((l) => l.dishId))];
  const rows = await tx.select().from(canteenDishes).where(inArray(canteenDishes.id, ids));
  const map = new Map(rows.map((d) => [d.id, d] as const));
  for (const id of ids) {
    const d = map.get(id);
    if (d === undefined || d.outletId !== outletId || !d.active) throw new CanteenRefusal("dish_not_on_outlet", { dishId: id });
  }
  return map;
}

/** The IST day's completed-or-waiting sales matching `where`. */
async function countToday(tx: Tx, at: Date, ...where: ReturnType<typeof eq>[]): Promise<number> {
  const { start, end } = istDayBounds(istDate(at));
  const r = await tx.select({ n: sql<number>`count(*)::int` }).from(canteenSales)
    .where(and(...where, ne(canteenSales.state, "cancelled"), gte(canteenSales.soldAt, start), lt(canteenSales.soldAt, end)));
  return r[0]?.n ?? 0;
}

/** On a published roster slot at `at` (any roster, as known then). */
async function onRosterSlot(tx: Tx, userId: string, at: Date): Promise<boolean> {
  const rows = await publishedAsKnownAt(tx, at, at, new Date(at.getTime() + 1));
  return rows.some((r) => r.assignment.userId === userId && r.assignment.startsAt <= at && r.assignment.endsAt > at && r.assignment.mode !== null);
}

const inNightWindow = (at: Date): boolean => {
  const m = istMinute(at);
  return m >= CANTEEN_NIGHT_FROM_MINUTE || m < CANTEEN_NIGHT_TO_MINUTE;
};

type GrantCheck = { kind: "free" | "subsidised"; mealLimitPaise: number };

/** D5 — the grant is granted by finance, alive and not used up. */
async function grantOrRefuse(tx: Tx, grantId: string, admissionId: string | null, at: Date): Promise<GrantCheck & { admissionId: string }> {
  const g = (await tx.select().from(canteenCharityGrants).where(eq(canteenCharityGrants.id, grantId)))[0];
  if (g === undefined || (admissionId !== null && g.admissionId !== admissionId)) throw new CanteenRefusal("not_found", { grantId });
  const appr = (await tx.select({ status: approvals.status }).from(approvals).where(eq(approvals.id, g.approvalId)))[0];
  if (appr?.status !== "granted") throw new CanteenRefusal("charity_not_approved", { grantId, status: appr?.status ?? null });
  if (istDate(at) > g.validUntil) throw new CanteenRefusal("charity_used_up", { grantId, validUntil: g.validUntil });
  const used = (await tx.select({ n: sql<number>`count(*)::int` }).from(canteenSales)
    .where(and(eq(canteenSales.grantId, grantId), ne(canteenSales.state, "cancelled"))))[0]?.n ?? 0;
  if (used >= g.meals) throw new CanteenRefusal("charity_used_up", { grantId, meals: g.meals });
  return { kind: g.kind as "free" | "subsidised", mealLimitPaise: g.mealLimitPaise, admissionId: g.admissionId };
}

/**
 * Prices a sale. `forPatientOf` names the admission whose PATIENT eats it. Refuses with the rule and the fix; writes
 * nothing.
 */
export async function draftSale(tx: Tx, args: {
  outlet: OutletRow; channel: CanteenSaleChannel; pay: CanteenPayment; lines: readonly Line[]; forPatientOf: string | null; at: Date;
  upiReference?: string;
}): Promise<SaleDraft> {
  const { outlet, pay, at } = args;
  if (!outlet.active) throw new CanteenRefusal("outlet_inactive", { outletId: outlet.id });
  if (outlet.kind === "caterer" && !TAKES_MONEY_AT_CATERER.includes(pay.mode)) throw new CanteenRefusal("mode_not_at_caterer", { mode: pay.mode });
  const dishes = await dishesFor(tx, outlet.id, args.lines);

  // The admission this sale is about: the IPD bill's, the bed class's, the grant's, or the patient's.
  let admission: CanteenAdmissionFacts | null = null;
  const admissionId = pay.mode === "ipd_bill" || pay.mode === "bed_class" ? pay.admissionId : args.forPatientOf;
  if (admissionId !== null) admission = await admissionOrRefuse(tx, admissionId);
  if (args.forPatientOf !== null && admission !== null && args.forPatientOf !== admission.admissionId) {
    throw new CanteenRefusal("bad_input", { reason: "the patient's admission and the paying admission differ" });
  }
  const forPatient = args.forPatientOf !== null;
  if (forPatient) await checkPatientFood(tx, admission!, [...dishes.values()], at);

  let list: CanteenPriceList | "free" = "public";
  let staff: SaleDraft["staff"] = null;
  let grantId: string | null = null;
  let grant: GrantCheck | null = null;
  if (pay.mode === "staff_card") {
    const card = await cardOfQr(tx, pay.qr, at);
    const rule = await staffRuleAt(tx, card.categoryId, at);
    if (rule === null) throw new CanteenRefusal("staff_rule_missing", { categoryId: card.categoryId });
    const copy: StaffRuleCopy = {
      ruleId: rule.id, priceBasis: rule.priceBasis as CanteenStaffPriceBasis, dailyCap: rule.dailyCap, nightMeal: rule.nightMeal,
      salaryDeduction: rule.salaryDeduction, gst: rule.gst as CanteenStaffGst,
    };
    let night = false;
    if (copy.nightMeal && inNightWindow(at) && await onRosterSlot(tx, card.userId, at)) {
      const since = new Date(at.getTime() - NIGHT_LOOKBACK_MS);
      const had = (await tx.select({ n: sql<number>`count(*)::int` }).from(canteenSales).where(and(
        eq(canteenSales.staffUserId, card.userId), eq(canteenSales.nightMeal, true), ne(canteenSales.state, "cancelled"), gte(canteenSales.soldAt, since),
      )))[0]?.n ?? 0;
      night = had === 0;
    }
    if (!night) {
      const today = await countToday(tx, at, eq(canteenSales.staffUserId, card.userId), eq(canteenSales.nightMeal, false));
      if (today >= copy.dailyCap) throw new CanteenRefusal("staff_cap_reached", { dailyCap: copy.dailyCap });
    }
    staff = { cardId: card.id, userId: card.userId, rule: copy, night };
    list = night || copy.priceBasis === "free" ? "free" : copy.priceBasis;
  } else if ((pay.mode === "cash" || pay.mode === "upi") && pay.grantId !== undefined) {
    grant = await grantOrRefuse(tx, pay.grantId, null, at);
    if (grant.kind !== "subsidised") throw new CanteenRefusal("charity_kind_mismatch", { grantId: pay.grantId });
    grantId = pay.grantId;
    list = "subsidised";
  } else if (pay.mode === "charity") {
    grant = await grantOrRefuse(tx, pay.grantId, null, at);
    if (grant.kind !== "free") throw new CanteenRefusal("charity_kind_mismatch", { grantId: pay.grantId });
    grantId = pay.grantId;
  } else if (pay.mode === "bed_class") {
    const perDay = await bedClassMealsPerDay(tx, admission!.billedClass);
    const used = await countToday(tx, at, eq(canteenSales.admissionId, admission!.admissionId), eq(canteenSales.payMode, "bed_class"));
    if (used >= perDay) throw new CanteenRefusal("not_covered_by_bed_class", { bedClass: admission!.billedClass, mealsPerDay: perDay });
  } else if (pay.mode === "cost_centre") {
    const cc = (await tx.select().from(canteenCostCentres).where(eq(canteenCostCentres.id, pay.costCentreId)))[0];
    if (cc === undefined || !cc.active) throw new CanteenRefusal("not_found", { costCentreId: pay.costCentreId });
  } else if (pay.mode === "free_rule") {
    const rule = (await tx.select().from(canteenFreeRules).where(eq(canteenFreeRules.id, pay.freeRuleId)))[0];
    if (rule === undefined || !rule.active) throw new CanteenRefusal("not_found", { freeRuleId: pay.freeRuleId });
    if (await countToday(tx, at, eq(canteenSales.freeRuleId, rule.id)) >= rule.perDay) throw new CanteenRefusal("free_rule_used_up", { perDay: rule.perDay });
  }

  const lines: SaleDraft["lines"] = [];
  for (const l of args.lines) {
    const dish = dishes.get(l.dishId)!;
    const value = await priceAt(tx, dish.id, "public", at);
    if (value === null) throw new CanteenRefusal("price_missing", { dishId: dish.id, list: "public" });
    let unit = value;
    if (list === "free") unit = 0;
    else if (list !== "public") {
      const p = await priceAt(tx, dish.id, list, at);
      if (p === null) throw new CanteenRefusal("price_missing", { dishId: dish.id, list });
      unit = p;
    }
    lines.push({ dish, qty: l.qty, unitPaise: unit, valuePaise: value });
  }
  if (grant !== null) {
    const meal = lines.reduce((t, l) => t + l.valuePaise * l.qty, 0);
    if (meal > grant.mealLimitPaise) throw new CanteenRefusal("charity_meal_over_limit", { mealPaise: meal, limitPaise: grant.mealLimitPaise });
  }

  let treatment: SaleDraft["treatment"];
  const notSupply = { kind: "not_supply" as const, category: null, rateBps: 0 };
  if (outlet.kind === "caterer") treatment = { kind: "caterer", category: null, rateBps: 0 };
  else if (forPatient && (pay.mode === "bed_class" || pay.mode === "ipd_bill")) {
    const row = await gstRow(tx, CANTEEN_GST_CATEGORIES.inpatientDiet);
    treatment = { kind: "exempt", category: row.category, rateBps: 0 };
  } else if (pay.mode === "cost_centre" || pay.mode === "free_rule" || pay.mode === "charity") treatment = notSupply;
  else if (staff !== null && (list === "free" || staff.rule.gst === "not_supply")) treatment = notSupply;
  else {
    const row = await gstRow(tx, staff !== null ? CANTEEN_GST_CATEGORIES.staffRecovery : CANTEEN_GST_CATEGORIES.food);
    treatment = row.exempt ? { kind: "exempt", category: row.category, rateBps: 0 } : { kind: "taxable", category: row.category, rateBps: row.rateBps };
  }

  return {
    outlet, channel: args.channel, state: "completed", pay, lines, treatment, admission, forPatient, staff, grantId,
    upiReference: args.upiReference ?? (pay.mode === "upi" ? pay.reference : null),
  };
}

/** Writes a priced sale (and its IPD lines) in the caller's transaction. */
export async function writeSale(tx: Tx, actor: Actor, d: SaleDraft, meta: {
  sessionId: string | null; idempotencyKey: string; at: Date; bedQrId?: string; soldBy?: string;
}): Promise<string> {
  const saleId = newId();
  const fy = fyShort(meta.at);
  const saleNo = `CNT/${fy}/${String(await nextNo(tx, "sale", fy)).padStart(6, "0")}`;
  const token = await nextNo(tx, `token:${d.outlet.id}`, istDate(meta.at));
  const lineRows = d.lines.map((l) => {
    const net = l.unitPaise * l.qty;
    const s = d.treatment.kind === "taxable" ? splitInclusive(net, d.treatment.rateBps) : { netPaise: net, taxablePaise: net, cgstPaise: 0, sgstPaise: 0 };
    return {
      id: newId(), saleId, dishId: l.dish.id, dishName: l.dish.name, foodType: l.dish.foodType, qty: l.qty, unitPaise: l.unitPaise,
      ...s, gstTreatment: d.treatment.kind, gstCategory: d.treatment.category, gstRateBps: d.treatment.rateBps,
    };
  });
  // The IPD bill: each line through ipd's door; the sale line keeps the engine's figures (the final bill's invoice).
  if (d.pay.mode === "ipd_bill") {
    for (const r of lineRows) {
      const unitTaxable = d.treatment.kind === "taxable" ? splitInclusive(r.unitPaise, r.gstRateBps).taxablePaise : r.unitPaise;
      const posted = await postCanteenChargeIn(tx, actor, d.pay.admissionId, {
        saleLineId: r.id, serviceDate: istDate(meta.at), qty: r.qty, taxableUnitPaise: unitTaxable, inpatientDiet: d.treatment.kind === "exempt",
      }, meta.at);
      if (!posted.ok) {
        if (posted.reason === "admission_closed" || posted.reason === "ipd_bill_settled") throw new CanteenRefusal(posted.reason);
        // No tariff item for the canteen service yet (a go-live tariff revision, approved by the owner) or no tariff at all.
        throw new CanteenRefusal("ipd_bill_not_ready", { reason: posted.reason, detail: posted.detail ?? null });
      }
      Object.assign(r, { netPaise: posted.netPaise, taxablePaise: posted.taxablePaise, cgstPaise: posted.cgstPaise, sgstPaise: posted.sgstPaise });
    }
  }
  const total = lineRows.reduce((t, r) => t + r.netPaise, 0);
  const pay = d.pay;
  await tx.insert(canteenSales).values({
    id: saleId, saleNo, token, outletId: d.outlet.id, sessionId: meta.sessionId, channel: d.channel, state: d.state, payMode: pay.mode,
    upiReference: d.upiReference, admissionId: d.admission?.admissionId ?? null, patientId: d.admission?.patientId ?? null, forPatient: d.forPatient,
    staffCardId: d.staff?.cardId ?? null, staffUserId: d.staff?.userId ?? null, staffRuleId: d.staff?.rule.ruleId ?? null, staffRule: d.staff?.rule ?? null,
    nightMeal: d.staff?.night ?? false, deductionPaise: d.staff?.rule.salaryDeduction === true ? total : 0,
    costCentreId: pay.mode === "cost_centre" ? pay.costCentreId : null, freeRuleId: pay.mode === "free_rule" ? pay.freeRuleId : null,
    freeNote: pay.mode === "free_rule" ? pay.note : null, grantId: d.grantId, bedQrId: meta.bedQrId ?? null,
    totalPaise: total, menuValuePaise: d.lines.reduce((t, l) => t + l.valuePaise * l.qty, 0),
    tenderedPaise: pay.mode === "cash" ? pay.tenderedPaise ?? null : null,
    idempotencyKey: meta.idempotencyKey, soldBy: meta.soldBy ?? actor.id, soldAt: meta.at,
  });
  await tx.insert(canteenSaleLines).values(lineRows);
  return saleId;
}

/** The sale as the wire carries it. */
export async function saleView(exec: Db | Tx, saleId: string): Promise<CanteenSale> {
  const s = (await (exec as Db).select().from(canteenSales).where(eq(canteenSales.id, saleId)))[0];
  if (s === undefined) throw new CanteenRefusal("not_found", { saleId });
  const lines = await (exec as Db).select().from(canteenSaleLines).where(eq(canteenSaleLines.saleId, saleId)).orderBy(canteenSaleLines.id);
  const rule = s.staffRule as StaffRuleCopy | null;
  return {
    saleId: s.id, saleNo: s.saleNo, token: s.token, state: s.state as CanteenSaleState, channel: s.channel as CanteenSaleChannel, outletId: s.outletId,
    payMode: s.payMode as CanteenPayMode, totalPaise: s.totalPaise, deductionPaise: s.deductionPaise, nightMeal: s.nightMeal,
    staffRule: rule === null ? null : { ruleId: rule.ruleId, priceBasis: rule.priceBasis, nightMeal: rule.nightMeal, salaryDeduction: rule.salaryDeduction, gst: rule.gst },
    lines: lines.map((l): CanteenSaleLine => ({
      dishId: l.dishId, dishName: l.dishName, foodType: l.foodType as CanteenFoodType, qty: l.qty, unitPaise: l.unitPaise, netPaise: l.netPaise,
      taxablePaise: l.taxablePaise, cgstPaise: l.cgstPaise, sgstPaise: l.sgstPaise, gstTreatment: l.gstTreatment as CanteenGstTreatment,
      gstCategory: l.gstCategory, gstRateBps: l.gstRateBps,
    })),
  };
}

export async function getSale(db: Db, actor: Actor, saleId: string): Promise<CanteenSale> {
  await requireAny(db, actor, CANTEEN_VIEW, CANTEEN_SELL, CANTEEN_FINANCE, CANTEEN_MANAGE);
  return saleView(db, saleId);
}

/** The session, locked, open and the actor's own. */
export async function ownOpenSession(tx: Tx, actor: Actor, sessionId: string): Promise<SessionRow> {
  const s = (await tx.select().from(canteenTillSessions).where(eq(canteenTillSessions.id, sessionId)).for("update"))[0];
  if (s === undefined) throw new CanteenRefusal("not_found", { sessionId });
  if (s.state !== "open") throw new CanteenRefusal("session_closed", { sessionId });
  if (s.cashierId !== actor.id) throw new CanteenRefusal("not_your_session", { sessionId });
  return s;
}

async function outletOfTill(exec: Db | Tx, tillId: string): Promise<{ till: typeof canteenTills.$inferSelect; outlet: OutletRow }> {
  const till = (await (exec as Db).select().from(canteenTills).where(eq(canteenTills.id, tillId)))[0];
  if (till === undefined) throw new CanteenRefusal("not_found", { tillId });
  return { till, outlet: await outletOf(exec, till.outletId) };
}

/** THE COUNTER SALE (D1–D7). Idempotent on its key: a retried sale returns the first. */
export async function sell(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<CanteenSale> {
  requirePayMode(raw);
  const input = parse(canteenSaleInput, raw);
  await requireAny(db, actor, CANTEEN_SELL);
  const at = opts.now ?? new Date();
  const saleId = await withTx(db, async (tx) => {
    const done = (await tx.select({ id: canteenSales.id }).from(canteenSales).where(eq(canteenSales.idempotencyKey, input.idempotencyKey)))[0];
    if (done !== undefined) return done.id;
    const session = await ownOpenSession(tx, actor, input.sessionId);
    const { outlet } = await outletOfTill(tx, session.tillId);
    const draft = await draftSale(tx, { outlet, channel: "counter", pay: input.pay, lines: input.lines, forPatientOf: input.forPatientOf ?? null, at });
    return writeSale(tx, actor, draft, { sessionId: session.id, idempotencyKey: input.idempotencyKey, at });
  });
  return saleView(db, saleId);
}

export async function openTill(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ sessionId: string }> {
  await requireAny(db, actor, CANTEEN_SELL);
  const input = parse(openTillInput, raw);
  const { till, outlet } = await outletOfTill(db, input.tillId);
  if (!till.active || !outlet.active) throw new CanteenRefusal("outlet_inactive", { tillId: till.id });
  const sessionId = newId();
  try {
    await db.insert(canteenTillSessions).values({
      id: sessionId, tillId: till.id, cashierId: actor.id, state: "open", openingCashPaise: input.openingCashPaise, openedAt: opts.now ?? new Date(),
    });
  } catch (e) {
    const code = (e as { code?: string; cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code;
    if (code === "23505") throw new CanteenRefusal("till_busy", { tillId: till.id });
    throw e;
  }
  return { sessionId };
}

/** Cash taken in a session: completed cash sales. */
export async function cashSalesOf(exec: Db | Tx, sessionId: string): Promise<number> {
  const r = await (exec as Db).select({ t: sql<number>`coalesce(sum(${canteenSales.totalPaise}), 0)::bigint` }).from(canteenSales)
    .where(and(eq(canteenSales.sessionId, sessionId), eq(canteenSales.payMode, "cash"), eq(canteenSales.state, "completed")));
  return Number(r[0]?.t ?? 0);
}

export function closeView(s: SessionRow, cashSalesPaise: number): CanteenTillClose {
  const expected = s.expectedCashPaise ?? s.openingCashPaise + cashSalesPaise;
  const counted = s.countedCashPaise ?? 0;
  return {
    sessionId: s.id, tillId: s.tillId, state: s.state as CanteenTillClose["state"], openingCashPaise: s.openingCashPaise, cashSalesPaise,
    expectedCashPaise: expected, countedCashPaise: counted, variancePaise: s.countedCashPaise === null ? 0 : counted - expected,
  };
}

/** THE DAY CLOSE of one till session (D1): cash expected against cash counted; a variance waits for the billing manager. */
export async function closeTill(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<CanteenTillClose> {
  await requireAny(db, actor, CANTEEN_SELL);
  const input = parse(closeTillInput, raw);
  const at = opts.now ?? new Date();
  return withTx(db, async (tx) => {
    const s = await ownOpenSession(tx, actor, input.sessionId);
    const cash = await cashSalesOf(tx, s.id);
    const expected = s.openingCashPaise + cash;
    const state = input.countedCashPaise === expected ? "closed" : "variance_pending";
    const [row] = await tx.update(canteenTillSessions).set({
      state, closedAt: at, expectedCashPaise: expected, countedCashPaise: input.countedCashPaise, closeNote: input.note ?? null,
    }).where(eq(canteenTillSessions.id, s.id)).returning();
    return closeView(row!, cash);
  });
}

/** The billing manager accepts a till's variance (never the cashier who closed it). */
export async function approveVariance(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<CanteenTillClose> {
  await requireAny(db, actor, CANTEEN_FINANCE);
  const input = parse(approveVarianceInput, raw);
  return withTx(db, async (tx) => {
    const s = (await tx.select().from(canteenTillSessions).where(eq(canteenTillSessions.id, input.sessionId)).for("update"))[0];
    if (s === undefined) throw new CanteenRefusal("not_found", { sessionId: input.sessionId });
    if (s.state !== "variance_pending") throw new CanteenRefusal("variance_not_pending");
    if (s.cashierId === actor.id) throw new CanteenRefusal("approver_is_cashier");
    const [row] = await tx.update(canteenTillSessions).set({
      state: "closed", varianceApprovedBy: actor.id, varianceApprovedAt: opts.now ?? new Date(), varianceNote: input.note,
    }).where(eq(canteenTillSessions.id, s.id)).returning();
    return closeView(row!, await cashSalesOf(tx, s.id));
  });
}

