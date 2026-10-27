import { and, desc, eq, lte } from "drizzle-orm";
import {
  createCostCentreInput, createDishInput, createFreeRuleInput, createOutletInput, createStaffCategoryInput, createTillInput, issueStaffCardInput,
  newId, setBedClassMealsInput, setDishPriceInput, setStaffRuleInput,
} from "@hmis/contracts";
import {
  canteenBedClassMeals, canteenCostCentres, canteenDishes, canteenDishPrices, canteenFreeRules, canteenOutlets, canteenStaffCards,
  canteenStaffCategories, canteenStaffRules, canteenTills, users,
} from "../../kernel/db/schema";
import { CanteenRefusal } from "./errors";
import { requireAny } from "./guard";
import { CANTEEN_FINANCE, CANTEEN_MANAGE, CANTEEN_SELL, CANTEEN_VIEW } from "./names";
import type { Actor, CanteenAllergen, CanteenFoodType, CanteenMeal, CanteenPriceList } from "@hmis/contracts";
import type { z } from "zod";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * SETUP — the canteen manager's outlets, tills, menu and price lists, cost centres, free-meal rules and bed-class meals;
 * finance's staff categories, their meal rules and the meal cards. Prices and staff rules are APPEND-ONLY rows with an
 * `effective_from`: a new row changes the next sale, never a past one (D2). Every instant is the caller's `now`.
 */
export type Opts = { now?: Date };
type Exec = Db | Tx;

export function parse<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const r = schema.safeParse(raw);
  if (!r.success) throw new CanteenRefusal("bad_input", { issues: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
  return r.data;
}

/** A unique-index violation becomes `duplicate_code`. */
async function unique<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const code = (e as { code?: string; cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code;
    if (code === "23505") throw new CanteenRefusal("duplicate_code");
    throw e;
  }
}

export type OutletRow = typeof canteenOutlets.$inferSelect;
export type StaffRuleRow = typeof canteenStaffRules.$inferSelect;

export async function outletOf(exec: Exec, outletId: string): Promise<OutletRow> {
  const o = (await (exec as Db).select().from(canteenOutlets).where(eq(canteenOutlets.id, outletId)))[0];
  if (o === undefined) throw new CanteenRefusal("not_found", { outletId });
  return o;
}

export async function createOutlet(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ outletId: string }> {
  await requireAny(db, actor, CANTEEN_MANAGE);
  const input = parse(createOutletInput, raw);
  const outletId = newId();
  await unique(() => db.insert(canteenOutlets).values({
    id: outletId, code: input.code.toUpperCase(), name: input.name, kind: input.kind,
    catererName: input.kind === "caterer" ? input.catererName ?? null : null,
    catererGstin: input.kind === "caterer" ? input.catererGstin ?? null : null,
    monthlyRentPaise: input.kind === "caterer" ? input.monthlyRentPaise ?? null : null,
    createdBy: actor.id, createdAt: opts.now ?? new Date(),
  }));
  return { outletId };
}

export async function createTill(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ tillId: string }> {
  await requireAny(db, actor, CANTEEN_MANAGE);
  const input = parse(createTillInput, raw);
  await outletOf(db, input.outletId);
  const tillId = newId();
  await unique(() => db.insert(canteenTills).values({
    id: tillId, outletId: input.outletId, code: input.code.toUpperCase(), name: input.name, createdBy: actor.id, createdAt: opts.now ?? new Date(),
  }));
  return { tillId };
}

export async function createDish(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ dishId: string }> {
  await requireAny(db, actor, CANTEEN_MANAGE);
  const input = parse(createDishInput, raw);
  await outletOf(db, input.outletId);
  const dishId = newId();
  await unique(() => db.insert(canteenDishes).values({
    id: dishId, outletId: input.outletId, code: input.code.toUpperCase(), name: input.name, meal: input.meal, foodType: input.foodType,
    allergens: [...new Set(input.allergens)], createdBy: actor.id, createdAt: opts.now ?? new Date(),
  }));
  return { dishId };
}

export async function setDishPrice(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ priceId: string }> {
  await requireAny(db, actor, CANTEEN_MANAGE);
  const input = parse(setDishPriceInput, raw);
  const dish = (await db.select({ id: canteenDishes.id }).from(canteenDishes).where(eq(canteenDishes.id, input.dishId)))[0];
  if (dish === undefined) throw new CanteenRefusal("not_found", { dishId: input.dishId });
  const priceId = newId();
  // A price set "now" in a test or at the counter applies from that instant; the epoch floor lets a fixture's prices
  // (set before its first explicit instant) apply to every sale after.
  await db.insert(canteenDishPrices).values({
    id: priceId, dishId: input.dishId, list: input.list, pricePaise: input.pricePaise, effectiveFrom: opts.now ?? new Date(0), setBy: actor.id,
  });
  return { priceId };
}

/** A dish's price on one list at `at`: the newest row not after it, or null. */
export async function priceAt(exec: Exec, dishId: string, list: CanteenPriceList, at: Date): Promise<number | null> {
  const row = (await (exec as Db).select({ p: canteenDishPrices.pricePaise }).from(canteenDishPrices)
    .where(and(eq(canteenDishPrices.dishId, dishId), eq(canteenDishPrices.list, list), lte(canteenDishPrices.effectiveFrom, at)))
    .orderBy(desc(canteenDishPrices.effectiveFrom)).limit(1))[0];
  return row?.p ?? null;
}

export async function createCostCentre(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ costCentreId: string }> {
  await requireAny(db, actor, CANTEEN_MANAGE);
  const input = parse(createCostCentreInput, raw);
  const costCentreId = newId();
  await unique(() => db.insert(canteenCostCentres).values({
    id: costCentreId, code: input.code.toUpperCase(), name: input.name, createdBy: actor.id, createdAt: opts.now ?? new Date(),
  }));
  return { costCentreId };
}

export async function createFreeRule(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ freeRuleId: string }> {
  await requireAny(db, actor, CANTEEN_MANAGE);
  const input = parse(createFreeRuleInput, raw);
  const freeRuleId = newId();
  await unique(() => db.insert(canteenFreeRules).values({
    id: freeRuleId, code: input.code.toUpperCase(), name: input.name, perDay: input.perDay, createdBy: actor.id, createdAt: opts.now ?? new Date(),
  }));
  return { freeRuleId };
}

export async function setBedClassMeals(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ bedClass: string; mealsPerDay: number }> {
  await requireAny(db, actor, CANTEEN_MANAGE);
  const input = parse(setBedClassMealsInput, raw);
  const at = opts.now ?? new Date();
  await db.insert(canteenBedClassMeals).values({ bedClass: input.bedClass, mealsPerDay: input.mealsPerDay, setBy: actor.id, setAt: at })
    .onConflictDoUpdate({ target: canteenBedClassMeals.bedClass, set: { mealsPerDay: input.mealsPerDay, setBy: actor.id, setAt: at } });
  return input;
}

export async function bedClassMealsPerDay(exec: Exec, bedClass: string | null): Promise<number> {
  if (bedClass === null) return 0;
  return (await (exec as Db).select().from(canteenBedClassMeals).where(eq(canteenBedClassMeals.bedClass, bedClass)))[0]?.mealsPerDay ?? 0;
}

export async function createStaffCategory(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ categoryId: string }> {
  await requireAny(db, actor, CANTEEN_FINANCE);
  const input = parse(createStaffCategoryInput, raw);
  const categoryId = newId();
  await unique(() => db.insert(canteenStaffCategories).values({
    id: categoryId, code: input.code.toUpperCase(), name: input.name, createdBy: actor.id, createdAt: opts.now ?? new Date(),
  }));
  return { categoryId };
}

/** Finance's new rule for a category, from `now` (D2: the next sale follows it; past sales keep their copy). */
export async function setStaffRule(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ ruleId: string }> {
  await requireAny(db, actor, CANTEEN_FINANCE);
  const input = parse(setStaffRuleInput, raw);
  const cat = (await db.select({ id: canteenStaffCategories.id }).from(canteenStaffCategories).where(eq(canteenStaffCategories.id, input.categoryId)))[0];
  if (cat === undefined) throw new CanteenRefusal("not_found", { categoryId: input.categoryId });
  const ruleId = newId();
  await db.insert(canteenStaffRules).values({
    id: ruleId, categoryId: input.categoryId, priceBasis: input.priceBasis, dailyCap: input.dailyCap, nightMeal: input.nightMeal,
    salaryDeduction: input.salaryDeduction, gst: input.gst, effectiveFrom: opts.now ?? new Date(), setBy: actor.id,
  });
  return { ruleId };
}

/** A category's rule at `at`: the newest row not after it, or null. */
export async function staffRuleAt(exec: Exec, categoryId: string, at: Date): Promise<StaffRuleRow | null> {
  return (await (exec as Db).select().from(canteenStaffRules)
    .where(and(eq(canteenStaffRules.categoryId, categoryId), lte(canteenStaffRules.effectiveFrom, at)))
    .orderBy(desc(canteenStaffRules.effectiveFrom)).limit(1))[0] ?? null;
}

/** Issues (or reissues: new category, code or photo, version + 1 — older QRs die) a person's meal card. */
export async function issueStaffCard(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ cardId: string; version: number }> {
  await requireAny(db, actor, CANTEEN_FINANCE);
  const input = parse(issueStaffCardInput, raw);
  const cat = (await db.select({ id: canteenStaffCategories.id }).from(canteenStaffCategories).where(eq(canteenStaffCategories.id, input.categoryId)))[0];
  if (cat === undefined) throw new CanteenRefusal("not_found", { categoryId: input.categoryId });
  const at = opts.now ?? new Date();
  const userId = input.userId ?? (await db.select({ id: users.id }).from(users).where(eq(users.username, input.username!)))[0]?.id;
  if (userId === undefined) throw new CanteenRefusal("not_found", { username: input.username });
  const existing = (await db.select().from(canteenStaffCards).where(eq(canteenStaffCards.userId, userId)))[0];
  if (existing !== undefined) {
    const version = existing.version + 1;
    await unique(() => db.update(canteenStaffCards).set({
      categoryId: input.categoryId, staffCode: input.staffCode, photoDocumentId: input.photoDocumentId ?? existing.photoDocumentId, version, active: true,
      issuedBy: actor.id, issuedAt: at,
    }).where(eq(canteenStaffCards.id, existing.id)));
    return { cardId: existing.id, version };
  }
  const cardId = newId();
  await unique(() => db.insert(canteenStaffCards).values({
    id: cardId, userId, categoryId: input.categoryId, staffCode: input.staffCode, photoDocumentId: input.photoDocumentId ?? null,
    issuedBy: actor.id, issuedAt: at,
  }));
  return { cardId, version: 1 };
}

export type DishView = {
  dishId: string; code: string; name: string; meal: CanteenMeal; foodType: CanteenFoodType; allergens: CanteenAllergen[];
  prices: Partial<Record<CanteenPriceList, number>>;
};

/** An outlet's active menu with each list's price at `at`. */
export async function dishesOf(db: Db, actor: Actor, outletId: string, opts: Opts = {}): Promise<DishView[]> {
  await requireAny(db, actor, CANTEEN_VIEW, CANTEEN_SELL, CANTEEN_MANAGE);
  return menuAt(db, outletId, opts.now ?? new Date());
}

export async function menuAt(exec: Exec, outletId: string, at: Date): Promise<DishView[]> {
  const rows = await (exec as Db).select().from(canteenDishes)
    .where(and(eq(canteenDishes.outletId, outletId), eq(canteenDishes.active, true))).orderBy(canteenDishes.meal, canteenDishes.name);
  const out: DishView[] = [];
  for (const d of rows) {
    const prices: DishView["prices"] = {};
    for (const list of ["public", "staff", "subsidised"] as const) {
      const p = await priceAt(exec, d.id, list, at);
      if (p !== null) prices[list] = p;
    }
    out.push({
      dishId: d.id, code: d.code, name: d.name, meal: d.meal as CanteenMeal, foodType: d.foodType as CanteenFoodType,
      allergens: d.allergens as CanteenAllergen[], prices,
    });
  }
  return out;
}
