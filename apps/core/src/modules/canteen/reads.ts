import { and, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { canteenDayQuery, canteenMonthQuery } from "@hmis/contracts";
import {
  canteenBedClassMeals, canteenCostCentres, canteenFreeRules, canteenOutlets, canteenRentInvoices, canteenSaleLines, canteenSales, canteenStaffCards,
  canteenStaffCategories, canteenTillSessions, canteenTills,
} from "../../kernel/db/schema";
import { canteenAdmissionByNo } from "../ipd";
import { bedClassLeft } from "./bed-qr";
import { CanteenRefusal } from "./errors";
import { requireAny } from "./guard";
import { istDayBounds, istMonthBounds } from "./money";
import { CANTEEN_FINANCE, CANTEEN_MANAGE, CANTEEN_SELL, CANTEEN_VIEW } from "./names";
import { cashSalesOf, closeView } from "./sales";
import { parse, staffRuleAt } from "./setup";
import type {
  Actor, CanteenAdmissionLookup, CanteenDay, CanteenDeductionRow, CanteenMonthIncome, CanteenOutletKind, CanteenPayMode, CanteenSetupView, CanteenStaffGst, CanteenStaffPriceBasis,
  CanteenTillClose, CanteenTillDay,
} from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * THE READS. The day (D1, D7): every till's sessions opened on the IST day, cash expected against counted, takings by
 * mode; the hospital's takings are its in-house tills' alone — a caterer's till is shown for its own report and never
 * added in. The month (D5, D6, D7): in-house income net of tax (money modes only: cash, UPI, staff card, IPD bill),
 * caterer rent invoiced, and the finance-approved family meals with their menu value. The payroll list (D2).
 */
const INCOME_MODES: readonly CanteenPayMode[] = ["cash", "upi", "staff_card", "ipd_bill"];

export async function canteenDay(db: Db, actor: Actor, raw: unknown): Promise<CanteenDay> {
  await requireAny(db, actor, CANTEEN_VIEW, CANTEEN_MANAGE, CANTEEN_FINANCE);
  const { date } = parse(canteenDayQuery, raw);
  const { start, end } = istDayBounds(date);
  const tills = await db.select({ till: canteenTills, kind: canteenOutlets.kind }).from(canteenTills)
    .innerJoin(canteenOutlets, eq(canteenOutlets.id, canteenTills.outletId)).orderBy(canteenTills.code);
  const sessions = await db.select().from(canteenTillSessions)
    .where(and(gte(canteenTillSessions.openedAt, start), lt(canteenTillSessions.openedAt, end))).orderBy(canteenTillSessions.openedAt);
  const ids = sessions.map((s) => s.id);
  const byModeRows = ids.length === 0 ? [] : await db.select({
    sessionId: canteenSales.sessionId, mode: canteenSales.payMode, total: sql<number>`sum(${canteenSales.totalPaise})::bigint`,
  }).from(canteenSales).where(and(inArray(canteenSales.sessionId, ids), eq(canteenSales.state, "completed")))
    .groupBy(canteenSales.sessionId, canteenSales.payMode);

  const out: CanteenTillDay[] = [];
  const hospital: CanteenDay["hospital"] = { salesPaise: 0, byMode: {} };
  for (const { till, kind } of tills) {
    const own = sessions.filter((s) => s.tillId === till.id);
    if (own.length === 0) continue;
    const views = await Promise.all(own.map(async (s) => closeView(s, await cashSalesOf(db, s.id))));
    const byMode: CanteenTillDay["byMode"] = {};
    for (const r of byModeRows.filter((x) => own.some((s) => s.id === x.sessionId))) {
      const m = r.mode as CanteenPayMode;
      byMode[m] = (byMode[m] ?? 0) + Number(r.total);
    }
    out.push({
      tillId: till.id, tillCode: till.code, outletId: till.outletId, outletKind: kind as CanteenOutletKind, sessions: views,
      expectedCashPaise: views.reduce((t, v) => t + v.expectedCashPaise, 0),
      countedCashPaise: own.every((s) => s.countedCashPaise !== null) ? own.reduce((t, s) => t + s.countedCashPaise!, 0) : null,
      byMode,
    });
    if (kind === "in_house") {
      for (const [m, v] of Object.entries(byMode) as [CanteenPayMode, number][]) {
        hospital.byMode[m] = (hospital.byMode[m] ?? 0) + v;
        hospital.salesPaise += v;
      }
    }
  }
  return { date, tills: out, hospital };
}

export async function canteenMonthIncome(db: Db, actor: Actor, raw: unknown): Promise<CanteenMonthIncome> {
  await requireAny(db, actor, CANTEEN_FINANCE);
  const { month } = parse(canteenMonthQuery, raw);
  const { start, end } = istMonthBounds(month);
  const inMonth = and(eq(canteenSales.state, "completed"), gte(canteenSales.soldAt, start), lt(canteenSales.soldAt, end));
  const sales = await db.select({ t: sql<number>`coalesce(sum(${canteenSaleLines.taxablePaise}), 0)::bigint` }).from(canteenSaleLines)
    .innerJoin(canteenSales, eq(canteenSales.id, canteenSaleLines.saleId)).innerJoin(canteenOutlets, eq(canteenOutlets.id, canteenSales.outletId))
    .where(and(inMonth, eq(canteenOutlets.kind, "in_house"), inArray(canteenSales.payMode, [...INCOME_MODES])));
  const rent = await db.select({ t: sql<number>`coalesce(sum(${canteenRentInvoices.taxablePaise}), 0)::bigint` }).from(canteenRentInvoices)
    .where(eq(canteenRentInvoices.month, month));
  const charity = await db.select({ n: sql<number>`count(*)::int`, v: sql<number>`coalesce(sum(${canteenSales.menuValuePaise}), 0)::bigint` })
    .from(canteenSales).where(and(inMonth, isNotNull(canteenSales.grantId)));
  return {
    month, salesPaise: Number(sales[0]?.t ?? 0), rentPaise: Number(rent[0]?.t ?? 0),
    charity: { meals: charity[0]?.n ?? 0, valuePaise: Number(charity[0]?.v ?? 0) },
  };
}

/** D2 — the month's payroll deduction list, one row per person, keyed by staff code (payroll is bought: decision 0075). */
export async function staffDeductions(db: Db, actor: Actor, raw: unknown): Promise<CanteenDeductionRow[]> {
  await requireAny(db, actor, CANTEEN_FINANCE);
  const { month } = parse(canteenMonthQuery, raw);
  const { start, end } = istMonthBounds(month);
  const rows = await db.select({
    userId: canteenSales.staffUserId, staffCode: canteenStaffCards.staffCode, meals: sql<number>`count(*)::int`,
    amount: sql<number>`sum(${canteenSales.deductionPaise})::bigint`,
  }).from(canteenSales).innerJoin(canteenStaffCards, eq(canteenStaffCards.id, canteenSales.staffCardId))
    .where(and(eq(canteenSales.state, "completed"), gte(canteenSales.soldAt, start), lt(canteenSales.soldAt, end), sql`${canteenSales.deductionPaise} > 0`))
    .groupBy(canteenSales.staffUserId, canteenStaffCards.staffCode).orderBy(canteenStaffCards.staffCode);
  return rows.map((r) => ({ userId: r.userId!, staffCode: r.staffCode, meals: r.meals, amountPaise: Number(r.amount) }));
}

/** The deduction list as payroll takes it. */
export function deductionsCsv(rows: readonly CanteenDeductionRow[]): string {
  return ["staff_code,meals,amount_rupees", ...rows.map((r) => `${r.staffCode},${String(r.meals)},${(r.amountPaise / 100).toFixed(2)}`)].join("\n") + "\n";
}


/** The lists behind the setup and finance screens. */
export async function canteenSetup(db: Db, actor: Actor): Promise<CanteenSetupView> {
  await requireAny(db, actor, CANTEEN_VIEW, CANTEEN_MANAGE, CANTEEN_FINANCE, CANTEEN_SELL);
  const now = new Date();
  const [outlets, tills, centres, rules, classes, categories] = await Promise.all([
    db.select().from(canteenOutlets).orderBy(canteenOutlets.code), db.select().from(canteenTills).orderBy(canteenTills.code),
    db.select().from(canteenCostCentres).where(eq(canteenCostCentres.active, true)).orderBy(canteenCostCentres.code),
    db.select().from(canteenFreeRules).where(eq(canteenFreeRules.active, true)).orderBy(canteenFreeRules.code),
    db.select().from(canteenBedClassMeals).orderBy(canteenBedClassMeals.bedClass), db.select().from(canteenStaffCategories).orderBy(canteenStaffCategories.code),
  ]);
  return {
    outlets: outlets.map((o) => ({
      outletId: o.id, code: o.code, name: o.name, kind: o.kind as CanteenOutletKind, active: o.active, catererName: o.catererName, monthlyRentPaise: o.monthlyRentPaise,
      tills: tills.filter((t) => t.outletId === o.id).map((t) => ({ tillId: t.id, code: t.code, name: t.name, active: t.active })),
    })),
    costCentres: centres.map((c) => ({ costCentreId: c.id, code: c.code, name: c.name })),
    freeRules: rules.map((r) => ({ freeRuleId: r.id, code: r.code, name: r.name, perDay: r.perDay })),
    bedClassMeals: classes.map((c) => ({ bedClass: c.bedClass, mealsPerDay: c.mealsPerDay })),
    staffCategories: await Promise.all(categories.map(async (c) => {
      const r = await staffRuleAt(db, c.id, now);
      return {
        categoryId: c.id, code: c.code, name: c.name,
        rule: r === null ? null : {
          ruleId: r.id, priceBasis: r.priceBasis as CanteenStaffPriceBasis, dailyCap: r.dailyCap, nightMeal: r.nightMeal, salaryDeduction: r.salaryDeduction,
          gst: r.gst as CanteenStaffGst, effectiveFrom: r.effectiveFrom.toISOString(),
        },
      };
    })),
  };
}

/** The cashier's open till session, if any. */
export async function myOpenSession(db: Db, actor: Actor): Promise<CanteenTillClose | null> {
  await requireAny(db, actor, CANTEEN_SELL);
  const s = (await db.select().from(canteenTillSessions).where(and(eq(canteenTillSessions.cashierId, actor.id), eq(canteenTillSessions.state, "open"))))[0];
  return s === undefined ? null : closeView(s, await cashSalesOf(db, s.id));
}

/** The counter's lookup of an admission by IP number (D3, D4): bed, ward, billed class and the bed-class meals left today. */
export async function findAdmission(db: Db, actor: Actor, q: string, opts: { now?: Date } = {}): Promise<CanteenAdmissionLookup> {
  await requireAny(db, actor, CANTEEN_SELL);
  const a = await canteenAdmissionByNo(db, q);
  if (a === null) throw new CanteenRefusal("not_found", { q });
  return {
    admissionId: a.admissionId, admissionNo: a.admissionNo, bedCode: a.bedCode, wardName: a.wardName, billedClass: a.billedClass, closed: a.closed,
    bedClassMealsLeft: a.closed === null ? await bedClassLeft(db, a.admissionId, a.billedClass, opts.now ?? new Date()) : 0,
  };
}
