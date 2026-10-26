import { and, eq, isNull } from "drizzle-orm";
import { CANTEEN_MEAL_SERVICE_CODE, newId } from "@hmis/contracts";
import { grantPermissionToRole, syncPermissions } from "../../src/kernel/auth/permissions";
import { authManifest } from "../../src/kernel/auth/manifest";
import { gstConfig, ipdBedStays, orgDepartments, rosterAssignments, rosterPeriods } from "../../src/kernel/db/schema";
import { ModuleRegistry } from "../../src/kernel/modules/loader";
import {
  CANTEEN_FINANCE, CANTEEN_MANAGE, CANTEEN_SELL, CANTEEN_VIEW, canteenManifest, createDish, createOutlet, createStaffCategory, createTill,
  issueStaffCard, openTill, registerCanteenApprovalTypes, seedCanteenBasics, setDishPrice, setStaffRule,
} from "../../src/modules/canteen";
import { approveRequest } from "../../src/kernel/approvals/decisions";
import { withTx } from "../../src/kernel/db/client";
import { CANTEEN_DIET_SERVICE_CODE, ipdManifest } from "../../src/modules/ipd";
import { activateVersion, createDraftVersion, listServices, resolveActiveTariffVersion, setTariffItem, submitVersion } from "../../src/modules/tariff";
import { patientsManifest } from "../../src/modules/patients";
import { seedOrgDepartments, seedRosterPositions } from "../../src/modules/roster";
import { ensureRole, mkUser } from "./opd";
import { ist, mkDietWorld } from "./diet";
import type { Actor, CanteenAllergen, CanteenFoodType, CanteenMeal, CanteenOutletKind, SetStaffRuleInput } from "@hmis/contracts";
import type { Db } from "../../src/kernel/db/client";
import type { DietWorld } from "./diet";

export { ist };

/**
 * CN-1 CANTEEN (#977) — the diet world (wards, real admissions, NPO, the IPD bill desk) plus the canteen people, each
 * holding exactly the strings `scripts/seed-roles.ts` gives the role: `cashier` and `cashier2` (canteen_cashier: sell,
 * view), `manager` (canteen_manager: manage, sell, view) and `finance` (billing_manager: canteen.finance, view; it also
 * decides the charity approval). `seedCanteenBasics` puts the canteen's `gst_config` rows and the CANTEEN_MEAL service
 * in, as the deploy's seed does. Every act passes an explicit instant; no code under test reads the real clock.
 */
export type CanteenWorld = DietWorld & {
  cashier: Actor; cashier2: Actor; manager: Actor; finance: Actor;
  /** An outlet with one till and a menu, each dish priced on the public list (and the staff / subsidised lists given). */
  outlet(kind: CanteenOutletKind, code: string, dishes: DishSpec[]): Promise<OutletFixture>;
  /** Opens a till session for `who` with `openingCashPaise` in the drawer. */
  open(who: Actor, tillId: string, openingCashPaise: number, at: Date): Promise<string>;
  /** A staff category with its finance rule, and a meal card for a fresh staff user. */
  staff(categoryCode: string, rule: Omit<SetStaffRuleInput, "categoryId">, at: Date): Promise<StaffFixture>;
  /** A published hospital roster slot for `userId` over [from, to). */
  rosterSlot(userId: string, from: Date, to: Date): Promise<void>;
  /** The open stay's bed of an admission. */
  bedOf(admissionId: string): Promise<string>;
  /** Sets (or replaces) a `gst_config` row. */
  gst(category: string, rateBps: number, exempt?: boolean): Promise<void>;
};

export type DishSpec = {
  code: string; name: string; meal?: CanteenMeal; foodType?: CanteenFoodType; allergens?: CanteenAllergen[];
  publicPaise: number; staffPaise?: number; subsidisedPaise?: number;
};
export type OutletFixture = { outletId: string; tillId: string; dish: Record<string, string> };
export type StaffFixture = { categoryId: string; user: Actor; cardId: string };

export async function mkCanteenWorld(db: Db): Promise<CanteenWorld> {
  const w = await mkDietWorld(db);
  const registry = new ModuleRegistry();
  for (const m of [authManifest, patientsManifest, ipdManifest, canteenManifest]) registry.install(m);
  await syncPermissions(db, registry);
  const grants: Record<string, readonly string[]> = {
    canteen_cashier: [CANTEEN_SELL, CANTEEN_VIEW],
    canteen_manager: [CANTEEN_MANAGE, CANTEEN_SELL, CANTEEN_VIEW],
    billing_manager: [CANTEEN_FINANCE, CANTEEN_VIEW],
  };
  for (const [role, perms] of Object.entries(grants)) {
    await ensureRole(db, role);
    for (const p of perms) await grantPermissionToRole(db, registry, role, p);
  }
  await seedCanteenBasics(db);
  // The go-live tariff revision: CANTEEN_MEAL and CANTEEN_DIET on the tariff (the canteen's own price is always the
  // prepaid quote; the item only lets the engine price the line). Activated before any admission the suites make.
  const known = new Map((await listServices(db)).map((s) => [s.code, s.id] as const));
  const current = await resolveActiveTariffVersion(db, new Date("2026-01-03T12:00:00Z"));
  const version = await withTx(db, async (tx) => {
    const d = await createDraftVersion(tx, w.tariffDrafter, { copyFromVersionId: current!.versionId });
    for (const code of [CANTEEN_MEAL_SERVICE_CODE, CANTEEN_DIET_SERVICE_CODE]) await setTariffItem(tx, w.tariffDrafter, d.versionId, known.get(code)!, 0);
    return d;
  });
  const submitted = await withTx(db, (tx) => submitVersion(tx, w.tariffDrafter, version.versionId));
  await approveRequest(db, w.owner, { approvalId: submitted.approvalId, note: "canteen fixture tariff" });
  await activateVersion(db, w.tariffActivator, version.versionId, new Date("2026-01-04T00:00:00Z"));
  await registerCanteenApprovalTypes(db, w.tariffActivator);
  const cashier = (await mkUser(db, "cnt.cashier", ["canteen_cashier"])).actor;
  const cashier2 = (await mkUser(db, "cnt.cashier2", ["canteen_cashier"])).actor;
  const manager = (await mkUser(db, "cnt.manager", ["canteen_manager"])).actor;
  const finance = w.billingManager;
  let staffN = 0;
  let deptId: string | null = null;

  return {
    ...w, cashier, cashier2, manager, finance,
    outlet: async (kind, code, dishes) => {
      const { outletId } = await createOutlet(db, manager, kind === "in_house"
        ? { code, name: `Outlet ${code}`, kind }
        : { code, name: `Outlet ${code}`, kind, catererName: "Synthetic Caterers", catererGstin: "10AAAAA0000A1Z5", monthlyRentPaise: 5_000_000 });
      const { tillId } = await createTill(db, manager, { outletId, code: `${code}-T1`, name: `${code} till 1` });
      const dish: Record<string, string> = {};
      for (const d of dishes) {
        const { dishId } = await createDish(db, manager, {
          outletId, code: d.code, name: d.name, meal: d.meal ?? "all_day", foodType: d.foodType ?? "veg", allergens: d.allergens ?? [],
        });
        dish[d.code] = dishId;
        await setDishPrice(db, manager, { dishId, list: "public", pricePaise: d.publicPaise });
        if (d.staffPaise !== undefined) await setDishPrice(db, manager, { dishId, list: "staff", pricePaise: d.staffPaise });
        if (d.subsidisedPaise !== undefined) await setDishPrice(db, manager, { dishId, list: "subsidised", pricePaise: d.subsidisedPaise });
      }
      return { outletId, tillId, dish };
    },
    open: async (who, tillId, openingCashPaise, at) => (await openTill(db, who, { tillId, openingCashPaise }, { now: at })).sessionId,
    staff: async (categoryCode, rule, at) => {
      const { categoryId } = await createStaffCategory(db, finance, { code: categoryCode, name: `Category ${categoryCode}` });
      await setStaffRule(db, finance, { categoryId, ...rule }, { now: at });
      staffN += 1;
      const user = (await mkUser(db, `cnt.staff${String(staffN)}`, ["support_staff"])).actor;
      const { cardId } = await issueStaffCard(db, finance, { userId: user.id, categoryId, staffCode: `S-${String(staffN)}` }, { now: at });
      return { categoryId, user, cardId };
    },
    rosterSlot: async (userId, from, to) => {
      if (deptId === null) {
        // The roster's positions name these roles (seed-roles makes them in a real database).
        for (const role of ["radiologist", "pathologist", "anaesthetist", "pharmacy"]) await ensureRole(db, role);
        await seedOrgDepartments(db);
        await seedRosterPositions(db);
        deptId = (await db.select({ id: orgDepartments.id }).from(orgDepartments).limit(1))[0]!.id;
      }
      const period = newId();
      const before = new Date(from.getTime() - 86_400_000);
      await db.insert(rosterPeriods).values({
        id: period, scopeType: "hospital", scopeId: null, title: "Synthetic nights", version: 1, status: "published",
        startsAt: before, endsAt: new Date(to.getTime() + 86_400_000), coversPositions: ["casualty_mo"],
        publishedAt: before, publishedBy: "t", contentHash: "h", createdBy: "t", updatedBy: "t",
      });
      await db.insert(rosterAssignments).values({
        id: newId(), periodId: period, userId, positionKey: "casualty_mo", startsAt: from, endsAt: to,
        departmentId: deptId, coverScope: "hospital", effective: true, lineageId: newId(), proposedByActorId: "t", createdBy: "t", updatedBy: "t",
      });
    },
    bedOf: async (admissionId) =>
      (await db.select({ bedId: ipdBedStays.bedId }).from(ipdBedStays).where(and(eq(ipdBedStays.admissionId, admissionId), isNull(ipdBedStays.endedAt))))[0]!.bedId,
    gst: async (category, rateBps, exempt = false) => {
      await db.insert(gstConfig).values({ category, sacCode: "996331", exempt, rateBps, updatedBy: "t" })
        .onConflictDoUpdate({ target: gstConfig.category, set: { rateBps, exempt } });
    },
  };
}

/** The IST calendar day of an instant, `YYYY-MM-DD`. */
export function istDay(at: Date): string {
  return new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}
