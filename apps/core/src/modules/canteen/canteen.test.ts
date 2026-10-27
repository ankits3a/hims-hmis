import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ist, mkCanteenWorld } from "../../../test/helpers/canteen";
import { canteenSales, ipdAdmissions } from "../../kernel/db/schema";
import { findAdmission } from "./reads";
import {
  approveVariance, cancelStaleBedOrders, closeTill, createCostCentre, createFreeRule, issueBedQr, issueStaffCard, placeBedOrder, sell, staffCardQr,
} from "./index";
import type { CanteenPayment } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { CanteenWorld, OutletFixture } from "../../../test/helpers/canteen";

/** CN-1 (#977) — the refusals and edges the done-means checks do not walk. Synthetic people only; explicit instants. */
jest.setTimeout(120_000);

const AT = ist("2026-11-04T13:00");
const at = (min: number): Date => new Date(AT.getTime() + min * 60_000);

describe("canteen — till, cards, rules and the bed QR", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: CanteenWorld;
  let house: OutletFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    w = await mkCanteenWorld(db);
    house = await w.outlet("in_house", "MAIN", [{ code: "TEA", name: "Tea", publicPaise: 1_000 }, { code: "MEAL", name: "Meal", publicPaise: 9_000 }]);
  });

  const sale = (sessionId: string, pay: CanteenPayment, when: Date, dish = house.dish.TEA!) =>
    sell(db, w.cashier, { sessionId, idempotencyKey: randomUUID(), lines: [{ dishId: dish, qty: 1 }], pay }, { now: when });

  it("one open session per till; a cashier sells only on their own session; a retried sale is the first", async () => {
    const s = await w.open(w.cashier, house.tillId, 0, AT);
    await expect(w.open(w.cashier2, house.tillId, 0, AT)).rejects.toMatchObject({ code: "till_busy" });
    await expect(sell(db, w.cashier2, { sessionId: s, idempotencyKey: randomUUID(), lines: [{ dishId: house.dish.TEA!, qty: 1 }], pay: { mode: "cash" } }, { now: at(1) }))
      .rejects.toMatchObject({ code: "not_your_session" });
    const key = randomUUID();
    const raw = { sessionId: s, idempotencyKey: key, lines: [{ dishId: house.dish.TEA!, qty: 2 }], pay: { mode: "cash" } };
    const first = await sell(db, w.cashier, raw, { now: at(2) });
    const again = await sell(db, w.cashier, raw, { now: at(3) });
    expect(again.saleId).toBe(first.saleId);
    expect(await db.select().from(canteenSales).where(eq(canteenSales.sessionId, s))).toHaveLength(1);
  });

  it("a till variance waits for the billing manager, never the cashier who closed it", async () => {
    const s = await w.open(w.cashier, house.tillId, 1_000, AT);
    await sale(s, { mode: "cash" }, at(1));
    const closed = await closeTill(db, w.cashier, { sessionId: s, countedCashPaise: 1_500 }, { now: at(30) });
    expect(closed).toMatchObject({ state: "variance_pending", variancePaise: -500 });
    await expect(sale(s, { mode: "cash" }, at(31))).rejects.toMatchObject({ code: "session_closed" });
    await expect(approveVariance(db, w.cashier, { sessionId: s, note: "self" })).rejects.toMatchObject({ code: "not_permitted" });
    await expect(approveVariance(db, w.finance, { sessionId: s, note: "Counted twice, ₹5 short" }, { now: at(40) })).resolves.toMatchObject({ state: "closed" });
    await expect(approveVariance(db, w.finance, { sessionId: s, note: "again" })).rejects.toMatchObject({ code: "variance_not_pending" });
  });

  it("a caterer outlet takes only cash or UPI (until the owner rules on collecting for it)", async () => {
    const cat = await w.outlet("caterer", "CATR", [{ code: "DOSA", name: "Dosa", publicPaise: 6_000 }]);
    const s = await w.open(w.cashier, cat.tillId, 0, AT);
    const { admissionId } = await w.admitAt("general", ist("2026-11-03T10:00"));
    await expect(sale(s, { mode: "ipd_bill", admissionId }, at(1), cat.dish.DOSA!)).rejects.toMatchObject({ code: "mode_not_at_caterer" });
    await expect(sale(s, { mode: "upi", reference: "UPI99887766" }, at(2), cat.dish.DOSA!)).resolves.toMatchObject({ payMode: "upi" });
  });

  it("a dish from another outlet, a cost centre and a free rule's daily cap", async () => {
    const other = await w.outlet("in_house", "SIDE", [{ code: "BUN", name: "Bun", publicPaise: 500 }]);
    const s = await w.open(w.cashier, house.tillId, 0, AT);
    await expect(sale(s, { mode: "cash" }, at(1), other.dish.BUN!)).rejects.toMatchObject({ code: "dish_not_on_outlet" });
    const { costCentreId } = await createCostCentre(db, w.manager, { code: "BOARD", name: "Board meeting" });
    const cc = await sale(s, { mode: "cost_centre", costCentreId }, at(2));
    expect(cc.lines[0]).toMatchObject({ gstTreatment: "not_supply", cgstPaise: 0 });
    const { freeRuleId } = await createFreeRule(db, w.manager, { code: "DONOR", name: "Blood donor", perDay: 1 });
    await sale(s, { mode: "free_rule", freeRuleId, note: "Synthetic donor" }, at(3));
    await expect(sale(s, { mode: "free_rule", freeRuleId, note: "Synthetic donor" }, at(4))).rejects.toMatchObject({ code: "free_rule_used_up" });
  });

  it("a forged QR, and a reissued card's older QR, are refused; a category without a rule refuses", async () => {
    const s = await w.open(w.cashier, house.tillId, 0, AT);
    const st = await w.staff("WARD", { priceBasis: "public", dailyCap: 5, nightMeal: false, salaryDeduction: false, gst: "not_supply" }, at(-60));
    const { token } = await staffCardQr(db, st.user, { now: at(1) });
    const forged = `${token.slice(0, -2)}xx`;
    await expect(sale(s, { mode: "staff_card", qr: forged }, at(1))).rejects.toMatchObject({ code: "staff_card_invalid" });
    await issueStaffCard(db, w.finance, { userId: st.user.id, categoryId: st.categoryId, staffCode: "S-NEW" }, { now: at(2) });
    await expect(sale(s, { mode: "staff_card", qr: token }, at(2))).rejects.toMatchObject({ code: "staff_card_invalid" });
    const fresh = (await staffCardQr(db, st.user, { now: at(3) })).token;
    await expect(sale(s, { mode: "staff_card", qr: fresh }, at(3))).resolves.toMatchObject({ payMode: "staff_card", totalPaise: 1_000 });
    // A category finance has not ruled on yet (its first rule starts later).
    const late = await w.staff("LATE", { priceBasis: "free", dailyCap: 1, nightMeal: false, salaryDeduction: false, gst: "not_supply" }, at(60));
    await expect(sale(s, { mode: "staff_card", qr: (await staffCardQr(db, late.user, { now: at(4) })).token }, at(4)))
      .rejects.toMatchObject({ code: "staff_rule_missing" });
  });

  it("a bed QR: six orders an hour; a reissued QR kills the old one; an unconfirmed UPI order is cancelled after 30 minutes", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-11-03T10:00"));
    const bedId = await w.bedOf(admissionId);
    const { token } = await issueBedQr(db, w.manager, { bedId, outletId: house.outletId });
    const order = (n: number) => placeBedOrder(db, token, {
      idempotencyKey: randomUUID(), lines: [{ dishId: house.dish.TEA!, qty: 1 }], pay: "upi", upiReference: `UPI00000000${String(n)}`,
    }, { now: at(n) });
    for (let n = 1; n <= 6; n += 1) await order(n);
    await expect(order(7)).rejects.toMatchObject({ code: "bed_qr_throttled" });
    expect(await cancelStaleBedOrders(db, at(20))).toBe(0);
    expect(await cancelStaleBedOrders(db, at(40))).toBe(6);
    await issueBedQr(db, w.manager, { bedId, outletId: house.outletId });
    await expect(order(70)).rejects.toMatchObject({ code: "bed_qr_invalid" });
  });

  it("the counter finds an admission by IP number: bed, ward and class, never a name", async () => {
    const { admissionId, patientId } = await w.admitAt("general", ist("2026-11-03T10:00"));
    const no = (await db.select({ no: ipdAdmissions.admissionNo }).from(ipdAdmissions).where(eq(ipdAdmissions.id, admissionId)))[0]!.no!;
    const found = await findAdmission(db, w.cashier, no.replace("-0", "-"), { now: AT });
    expect(found).toMatchObject({ admissionId, admissionNo: no, closed: null, billedClass: "general" });
    expect(JSON.stringify(found)).not.toContain(patientId);
    await expect(findAdmission(db, w.cashier, "IP99-999999")).rejects.toMatchObject({ code: "not_found" });
    await expect(findAdmission(db, w.finance, no)).rejects.toMatchObject({ code: "not_permitted" });
  });
});
