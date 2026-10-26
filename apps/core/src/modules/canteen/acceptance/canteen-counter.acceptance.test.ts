import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { ist, istDay, mkCanteenWorld } from "../../../../test/helpers/canteen";
import { withTx } from "../../../kernel/db/client";
import { approveRequest } from "../../../kernel/approvals/decisions";
import { ipdAdmissions } from "../../../kernel/db/schema";
import { liftNpo, startNpo } from "../../diet";
import { composeFinalBill, readInterimBill } from "../../ipd";
import { addAllergy } from "../../patients";
import {
  bedMenu, canteenDay, canteenMonthIncome, closeTill, confirmBedOrder, getSale, issueBedQr, issueRentInvoice, placeBedOrder, requestCharity, sell,
  setBedClassMeals, setStaffRule, staffCardQr, staffDeductions,
} from "../index";
import type { CanteenPayment, CanteenSale } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";
import type { CanteenWorld, OutletFixture } from "../../../../test/helpers/canteen";

/**
 * SPEC #977 — CANTEEN CN-1: COUNTER, MENU, STAFF MEAL CARD, ATTENDANT MEALS, CHARITY (docs/specs/977-canteen-counter.md).
 * One block per "Done means" id, D1–D7. Every check calls the canteen's intents (and the real diet, ipd and approvals
 * acts) — never a screen. Every instant is explicit; menu prices are GST-inclusive paise. All people and patients are
 * synthetic.
 */
jest.setTimeout(120_000);

const AT = ist("2026-11-02T12:30");
const LATER = (min: number): Date => new Date(AT.getTime() + min * 60_000);

/** The in-house canteen's menu: thali ₹84 (₹63 staff, ₹42 subsidised), tea ₹10, peanut chikki ₹21, paneer roll ₹105. */
const MENU = [
  { code: "THALI", name: "Veg thali", meal: "lunch" as const, allergens: ["gluten" as const, "milk" as const], publicPaise: 8_400, staffPaise: 6_300, subsidisedPaise: 4_200 },
  { code: "TEA", name: "Tea", publicPaise: 1_000, staffPaise: 800, subsidisedPaise: 500 },
  { code: "CHIKKI", name: "Peanut chikki", allergens: ["peanut" as const], publicPaise: 2_100 },
  { code: "ROLL", name: "Paneer roll", allergens: ["gluten" as const, "milk" as const], publicPaise: 10_500 },
];

describe("spec #977 — canteen counter", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: CanteenWorld;
  let house: OutletFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    w = await mkCanteenWorld(db);
    house = await w.outlet("in_house", "MAIN", MENU);
  });

  const line = (dishId: string, qty = 1) => ({ dishId, qty });
  const sale = (sessionId: string, lines: { dishId: string; qty: number }[], pay: CanteenPayment, at: Date, extra: { forPatientOf?: string } = {}) =>
    sell(db, w.cashier, { sessionId, idempotencyKey: randomUUID(), lines, pay, ...extra }, { now: at });
  /** GST split out of an inclusive price at `bps`: taxable value and the tax. */
  const split = (inclusive: number, bps: number) => {
    const taxable = Math.round((inclusive * 10_000) / (10_000 + bps));
    return { taxable, tax: inclusive - taxable };
  };

  it("spec #977 D1 — no sale without a payment mode; the day close shows cash expected against counted, per till", async () => {
    const till2 = (await w.outlet("in_house", "SIDE", [{ code: "SAMOSA", name: "Samosa", publicPaise: 1_500 }]));
    const s1 = await w.open(w.cashier, house.tillId, 50_000, AT);
    const s2 = await w.open(w.cashier2, till2.tillId, 20_000, AT);

    // No payment mode: refused with the rule and the fix, and nothing is recorded.
    await expect(sell(db, w.cashier, { sessionId: s1, idempotencyKey: randomUUID(), lines: [line(house.dish.THALI!)] }, { now: AT }))
      .rejects.toMatchObject({ code: "payment_mode_required", fix: "Pick how the meal is paid." });
    await expect(sell(db, w.cashier, { sessionId: s1, idempotencyKey: randomUUID(), lines: [line(house.dish.THALI!)], pay: { mode: "" } }, { now: AT }))
      .rejects.toMatchObject({ code: "payment_mode_required" });

    await sale(s1, [line(house.dish.THALI!, 2)], { mode: "cash" }, LATER(1));
    await sale(s1, [line(house.dish.TEA!)], { mode: "upi", reference: "UPI4471200981" }, LATER(2));
    await sale(s1, [line(house.dish.TEA!, 3)], { mode: "cash", tenderedPaise: 5_000 }, LATER(3));
    await sell(db, w.cashier2, { sessionId: s2, idempotencyKey: randomUUID(), lines: [line(till2.dish.SAMOSA!, 4)], pay: { mode: "cash" } }, { now: LATER(4) });

    // Till 1 is ₹10 short; till 2 is exact.
    const c1 = await closeTill(db, w.cashier, { sessionId: s1, countedCashPaise: 50_000 + 16_800 + 3_000 - 1_000 }, { now: LATER(60) });
    expect(c1).toMatchObject({ openingCashPaise: 50_000, cashSalesPaise: 19_800, expectedCashPaise: 69_800, countedCashPaise: 68_800, variancePaise: -1_000 });
    const c2 = await closeTill(db, w.cashier2, { sessionId: s2, countedCashPaise: 26_000 }, { now: LATER(61) });
    expect(c2).toMatchObject({ expectedCashPaise: 26_000, countedCashPaise: 26_000, variancePaise: 0, state: "closed" });

    const day = await canteenDay(db, w.manager, { date: istDay(AT) });
    const t1 = day.tills.find((t) => t.tillId === house.tillId)!;
    const t2 = day.tills.find((t) => t.tillId === till2.tillId)!;
    expect(t1).toMatchObject({ expectedCashPaise: 69_800, countedCashPaise: 68_800 });
    expect(t1.byMode).toMatchObject({ cash: 19_800, upi: 1_000 });
    expect(t2).toMatchObject({ expectedCashPaise: 26_000, countedCashPaise: 26_000 });
  });

  it("spec #977 D2 — a staff card takes price, daily cap, night meal and deduction from its category's row; a new row changes the next sale only", async () => {
    const s = await w.open(w.cashier, house.tillId, 0, AT);
    const nurse = await w.staff("NURSE", { priceBasis: "staff", dailyCap: 2, nightMeal: true, salaryDeduction: true, gst: "not_supply" }, LATER(-60));
    const card = async (at: Date): Promise<CanteenPayment> => ({ mode: "staff_card", qr: (await staffCardQr(db, nurse.user, { now: at })).token });

    const first: CanteenSale = await sale(s, [line(house.dish.THALI!)], await card(LATER(1)), LATER(1));
    expect(first.lines[0]).toMatchObject({ unitPaise: 6_300, netPaise: 6_300 });
    expect(first).toMatchObject({ payMode: "staff_card", deductionPaise: 6_300, nightMeal: false });
    expect(first.staffRule).toMatchObject({ priceBasis: "staff", salaryDeduction: true, nightMeal: true, gst: "not_supply" });

    await sale(s, [line(house.dish.TEA!)], await card(LATER(2)), LATER(2));
    // The cap of 2 a day is the row's: the third is refused.
    await expect(sale(s, [line(house.dish.TEA!)], await card(LATER(3)), LATER(3))).rejects.toMatchObject({ code: "staff_cap_reached" });
    // A QR older than its life is refused.
    const stale = await card(LATER(4));
    await expect(sale(s, [line(house.dish.TEA!)], stale, LATER(4 + 2))).rejects.toMatchObject({ code: "staff_card_expired" });

    // On a roster slot at 23:00 IST the night meal is free and outside the cap.
    const night = ist("2026-11-02T23:00");
    await w.rosterSlot(nurse.user.id, ist("2026-11-02T20:00"), ist("2026-11-03T08:00"));
    const nightOutlet = await w.outlet("in_house", "NIGHT", MENU);
    const s2 = await w.open(w.cashier2, nightOutlet.tillId, 0, night);
    const meal = await sell(db, w.cashier2, { sessionId: s2, idempotencyKey: randomUUID(), lines: [line(nightOutlet.dish.THALI!)], pay: await card(night) }, { now: night });
    expect(meal).toMatchObject({ nightMeal: true, totalPaise: 0, deductionPaise: 0 });

    // Finance changes the row: subsidised list, no deduction. The next sale follows it; the past sale keeps its own.
    await setStaffRule(db, w.finance, { categoryId: nurse.categoryId, priceBasis: "subsidised", dailyCap: 3, nightMeal: false, salaryDeduction: false, gst: "not_supply" }, { now: ist("2026-11-03T09:00") });
    await closeTill(db, w.cashier, { sessionId: s, countedCashPaise: 0 }, { now: ist("2026-11-03T11:59") });
    const s3 = await w.open(w.cashier, house.tillId, 0, ist("2026-11-03T12:00"));
    const next = await sale(s3, [line(house.dish.THALI!)], await card(ist("2026-11-03T12:01")), ist("2026-11-03T12:01"));
    expect(next).toMatchObject({ totalPaise: 4_200, deductionPaise: 0 });
    expect(next.staffRule).toMatchObject({ priceBasis: "subsidised", salaryDeduction: false });
    expect(next.staffRule!.ruleId).not.toBe(first.staffRule!.ruleId);
    const past = await getSale(db, w.manager, first.saleId);
    expect(past).toMatchObject({ totalPaise: 6_300, deductionPaise: 6_300 });
    expect(past.staffRule).toMatchObject({ ruleId: first.staffRule!.ruleId, priceBasis: "staff" });

    // The month's payroll list: the two deducted meals of the 2nd only.
    const rows = await staffDeductions(db, w.finance, { month: "2026-11" });
    expect(rows).toEqual([expect.objectContaining({ userId: nurse.user.id, meals: 2, amountPaise: 6_300 + 800 })]);
  });

  it("spec #977 D3 — a bed QR orders only while the admission is open: UPI, IPD bill or bed class; an IPD-bill meal shows on the final bill", async () => {
    await setBedClassMeals(db, w.manager, { bedClass: "private", mealsPerDay: 1 });
    const { admissionId } = await w.admitAt("private", ist("2026-11-01T10:00"));
    const bedId = await w.bedOf(admissionId);
    const { token } = await issueBedQr(db, w.manager, { bedId, outletId: house.outletId });
    const s = await w.open(w.cashier, house.tillId, 0, AT);

    const menu = await bedMenu(db, token, { now: AT });
    expect(menu.dishes.map((d) => d.name)).toContain("Veg thali");
    expect(menu.bedClassMealsLeft).toBe(1);
    // The public page never shows a patient's name or allergy.
    expect(JSON.stringify(menu)).not.toMatch(/patient|allerg/i);

    // Bed class: the first meal of the day is covered; the second is not.
    const covered = await placeBedOrder(db, token, { idempotencyKey: randomUUID(), lines: [line(house.dish.THALI!)], pay: "bed_class" }, { now: LATER(1) });
    expect(covered).toMatchObject({ payMode: "bed_class", totalPaise: 8_400 });
    await expect(placeBedOrder(db, token, { idempotencyKey: randomUUID(), lines: [line(house.dish.TEA!)], pay: "bed_class" }, { now: LATER(2) }))
      .rejects.toMatchObject({ code: "not_covered_by_bed_class" });

    // UPI waits for the counter to see the reference; then it is the till's.
    const upi = await placeBedOrder(db, token, { idempotencyKey: randomUUID(), lines: [line(house.dish.TEA!)], pay: "upi", upiReference: "UPI8800112233" }, { now: LATER(3) });
    expect(upi.state).toBe("awaiting_confirmation");
    await expect(confirmBedOrder(db, w.cashier, { orderId: upi.saleId, sessionId: s }, { now: LATER(4) })).resolves.toMatchObject({ state: "completed" });

    // The IPD bill from a photographed QR needs the family's OTP login; at the counter it is confirmed in person.
    await expect(placeBedOrder(db, token, { idempotencyKey: randomUUID(), lines: [line(house.dish.ROLL!)], pay: "ipd_bill" }, { now: LATER(5) }))
      .rejects.toMatchObject({ code: "needs_family_otp" });
    const billed = await sale(s, [line(house.dish.ROLL!)], { mode: "ipd_bill", admissionId }, LATER(6));
    expect(billed).toMatchObject({ payMode: "ipd_bill", totalPaise: 10_500 });

    const interim = await readInterimBill(db, w.billDesk, admissionId);
    expect(JSON.stringify(interim)).toContain("canteen");
    const a = (await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, admissionId)))[0]!;
    const final = await composeFinalBill(db, a);
    const canteenLines = final.lines.filter((l) => l.component === "canteen");
    expect(canteenLines).toHaveLength(1);
    expect(canteenLines[0]).toMatchObject({ netPaise: 10_500, source: "ipd.canteen" });

    // Discharged: the bed's QR orders nothing.
    await w.discharge(admissionId, LATER(120));
    await expect(bedMenu(db, token, { now: LATER(121) })).rejects.toMatchObject({ code: "admission_closed" });
    await expect(placeBedOrder(db, token, { idempotencyKey: randomUUID(), lines: [line(house.dish.TEA!)], pay: "upi", upiReference: "UPI0000000001" }, { now: LATER(122) }))
      .rejects.toMatchObject({ code: "admission_closed" });
    await expect(sale(s, [line(house.dish.TEA!)], { mode: "ipd_bill", admissionId }, LATER(123))).rejects.toMatchObject({ code: "admission_closed" });
  });

  it("spec #977 D4 — food for the patient is refused while NPO and for a dish with the patient's recorded allergen", async () => {
    const { admissionId, patientId } = await w.admitAt("general", ist("2026-11-01T10:00"));
    await withTx(db, (tx) => addAllergy(tx, w.dietDoctor, patientId, { substance: "Groundnut", source: "registration" }));
    const s = await w.open(w.cashier, house.tillId, 0, AT);

    await expect(sale(s, [line(house.dish.CHIKKI!)], { mode: "cash" }, LATER(1), { forPatientOf: admissionId }))
      .rejects.toMatchObject({ code: "patient_allergen" });
    // The same dish for the attendant is a plain sale.
    await expect(sale(s, [line(house.dish.CHIKKI!)], { mode: "cash" }, LATER(2))).resolves.toMatchObject({ state: "completed" });
    await expect(sale(s, [line(house.dish.TEA!)], { mode: "cash" }, LATER(3), { forPatientOf: admissionId })).resolves.toMatchObject({ state: "completed" });

    const npoId = await startNpo(db, w.dietDoctor, { admissionId, startsAt: LATER(4).toISOString(), reason: "Synthetic: before a procedure" }, LATER(4));
    await expect(sale(s, [line(house.dish.TEA!)], { mode: "cash" }, LATER(5), { forPatientOf: admissionId })).rejects.toMatchObject({ code: "patient_npo" });
    const { token } = await issueBedQr(db, w.manager, { bedId: await w.bedOf(admissionId), outletId: house.outletId });
    await expect(placeBedOrder(db, token, { idempotencyKey: randomUUID(), lines: [line(house.dish.TEA!)], pay: "upi", upiReference: "UPI1234567890", forPatient: true }, { now: LATER(6) }))
      .rejects.toMatchObject({ code: "patient_npo" });

    await liftNpo(db, w.dietDoctor, { npoId, reason: "Synthetic: procedure done" }, LATER(7));
    await expect(sale(s, [line(house.dish.TEA!)], { mode: "cash" }, LATER(8), { forPatientOf: admissionId })).resolves.toMatchObject({ state: "completed" });
  });

  it("spec #977 D5 — a free or subsidised family meal needs a finance approval on record before it is served", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-11-01T10:00"));
    const s = await w.open(w.cashier, house.tillId, 0, AT);
    const free = await requestCharity(db, w.cashier, { admissionId, kind: "free", meals: 2, mealLimitPaise: 9_000, validUntil: "2026-11-05", note: "Synthetic: family cannot pay" }, { now: AT });
    const sub = await requestCharity(db, w.cashier, { admissionId, kind: "subsidised", meals: 1, mealLimitPaise: 9_000, validUntil: "2026-11-05", note: "Synthetic: part payment" }, { now: AT });

    // Before finance decides: nothing is served on either grant.
    await expect(sale(s, [line(house.dish.THALI!)], { mode: "charity", grantId: free.grantId }, LATER(1))).rejects.toMatchObject({ code: "charity_not_approved" });
    await expect(sale(s, [line(house.dish.THALI!)], { mode: "cash", grantId: sub.grantId }, LATER(1))).rejects.toMatchObject({ code: "charity_not_approved" });
    // The cashier who asked cannot approve it.
    await expect(approveRequest(db, w.cashier, { approvalId: free.approvalId, note: "self" })).rejects.toBeTruthy();

    await approveRequest(db, w.finance, { approvalId: free.approvalId, note: "Synthetic approval" });
    await approveRequest(db, w.finance, { approvalId: sub.approvalId, note: "Synthetic approval" });

    await expect(sale(s, [line(house.dish.ROLL!)], { mode: "charity", grantId: free.grantId }, LATER(2))).rejects.toMatchObject({ code: "charity_meal_over_limit" });
    await expect(sale(s, [line(house.dish.THALI!)], { mode: "charity", grantId: free.grantId }, LATER(3))).resolves.toMatchObject({ payMode: "charity" });
    await sale(s, [line(house.dish.THALI!)], { mode: "charity", grantId: free.grantId }, LATER(4));
    await expect(sale(s, [line(house.dish.THALI!)], { mode: "charity", grantId: free.grantId }, LATER(5))).rejects.toMatchObject({ code: "charity_used_up" });
    // Subsidised: the family pays the subsidised price.
    await expect(sale(s, [line(house.dish.THALI!)], { mode: "cash", grantId: sub.grantId }, LATER(6))).resolves.toMatchObject({ totalPaise: 4_200 });

    const month = await canteenMonthIncome(db, w.finance, { month: "2026-11" });
    expect(month.charity).toEqual({ meals: 3, valuePaise: 8_400 * 3 });
  });

  it("spec #977 D6 — each sale carries its GST treatment; a caterer's monthly rent invoice carries 18%", async () => {
    const s = await w.open(w.cashier, house.tillId, 0, AT);

    // A canteen sale (attendant, visitor): 5% out of the inclusive price.
    const attendant = await sale(s, [line(house.dish.THALI!)], { mode: "cash" }, LATER(1));
    const five = split(8_400, 500);
    expect(attendant.lines[0]).toMatchObject({ gstTreatment: "taxable", gstCategory: "canteen_food", gstRateBps: 500, taxablePaise: five.taxable });
    expect(attendant.lines[0]!.cgstPaise + attendant.lines[0]!.sgstPaise).toBe(five.tax);

    // Food to the in-patient as part of the stay: exempt.
    await setBedClassMeals(db, w.manager, { bedClass: "general", mealsPerDay: 3 });
    const { admissionId } = await w.admitAt("general", ist("2026-11-01T10:00"));
    const patientMeal = await sale(s, [line(house.dish.THALI!)], { mode: "bed_class", admissionId }, LATER(2), { forPatientOf: admissionId });
    expect(patientMeal.lines[0]).toMatchObject({ gstTreatment: "exempt", gstCategory: "inpatient_diet", cgstPaise: 0, sgstPaise: 0, taxablePaise: 8_400 });

    // Staff recovery as finance sets it: not a supply for one category; taxed for another, and only once finance sets the rate.
    const perm = await w.staff("PERM", { priceBasis: "staff", dailyCap: 2, nightMeal: false, salaryDeduction: true, gst: "not_supply" }, LATER(-10));
    const permSale = await sale(s, [line(house.dish.THALI!)], { mode: "staff_card", qr: (await staffCardQr(db, perm.user, { now: LATER(3) })).token }, LATER(3));
    expect(permSale.lines[0]).toMatchObject({ gstTreatment: "not_supply", cgstPaise: 0, sgstPaise: 0 });
    const contract = await w.staff("CONTRACT", { priceBasis: "staff", dailyCap: 2, nightMeal: false, salaryDeduction: true, gst: "taxable" }, LATER(-10));
    await expect(sale(s, [line(house.dish.THALI!)], { mode: "staff_card", qr: (await staffCardQr(db, contract.user, { now: LATER(4) })).token }, LATER(4)))
      .rejects.toMatchObject({ code: "gst_config_missing" });
    await w.gst("canteen_staff_recovery", 500);
    const contractSale = await sale(s, [line(house.dish.THALI!)], { mode: "staff_card", qr: (await staffCardQr(db, contract.user, { now: LATER(5) })).token }, LATER(5));
    expect(contractSale.lines[0]).toMatchObject({ gstTreatment: "taxable", gstCategory: "canteen_staff_recovery", gstRateBps: 500, taxablePaise: split(6_300, 500).taxable });

    // The caterer's rent: 18% on the month's rent, split CGST + SGST.
    const caterer = await w.outlet("caterer", "CATR", [{ code: "DOSA", name: "Dosa", publicPaise: 6_000 }]);
    const rent = await issueRentInvoice(db, w.finance, { outletId: caterer.outletId, month: "2026-11" }, { now: ist("2026-11-01T10:00") });
    expect(rent).toMatchObject({ taxablePaise: 5_000_000, gstRateBps: 1_800, cgstPaise: 450_000, sgstPaise: 450_000, totalPaise: 5_900_000 });
    await expect(issueRentInvoice(db, w.finance, { outletId: caterer.outletId, month: "2026-11" }, { now: ist("2026-11-01T10:05") }))
      .rejects.toMatchObject({ code: "rent_already_issued" });
  });

  it("spec #977 D7 — a caterer outlet's sales never post to the hospital's till totals; only its rent does", async () => {
    const caterer = await w.outlet("caterer", "CATR", [{ code: "DOSA", name: "Dosa", publicPaise: 6_000 }]);
    const sh = await w.open(w.cashier, house.tillId, 0, AT);
    const sc = await w.open(w.cashier2, caterer.tillId, 0, AT);
    await sale(sh, [line(house.dish.THALI!)], { mode: "cash" }, LATER(1));
    const dosa = await sell(db, w.cashier2, { sessionId: sc, idempotencyKey: randomUUID(), lines: [line(caterer.dish.DOSA!, 3)], pay: { mode: "cash" } }, { now: LATER(2) });
    expect(dosa.lines[0]).toMatchObject({ gstTreatment: "caterer" });

    const day = await canteenDay(db, w.manager, { date: istDay(AT) });
    // The caterer's own till is there for its own report …
    expect(day.tills.find((t) => t.tillId === caterer.tillId)).toMatchObject({ outletKind: "caterer", byMode: { cash: 18_000 } });
    // … but the hospital's takings are the in-house till's alone.
    expect(day.hospital.salesPaise).toBe(8_400);
    expect(day.hospital.byMode).toEqual({ cash: 8_400 });

    await issueRentInvoice(db, w.finance, { outletId: caterer.outletId, month: "2026-11" }, { now: ist("2026-11-01T10:00") });
    const month = await canteenMonthIncome(db, w.finance, { month: "2026-11" });
    expect(month.salesPaise).toBe(split(8_400, 500).taxable);
    expect(month.rentPaise).toBe(5_000_000);
  });
});
