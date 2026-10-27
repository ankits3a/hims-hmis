import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { alerts, events, ipdChargeLines, ipdEmarLabels, ipdNursingAlerts, ipdRestraints, ipdWardIncidents, storeIndentLines, storeIndents } from "../../../kernel/db/schema";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkWardSafetyWorld } from "../../../../test/helpers/ipd";
import { balances } from "../../materials";
import { admissionPlace } from "../admission-place";
import {
  acceptShiftHandover, acknowledgeEwsAlert, administerDose, applyRestraint, giveShiftHandover, publishShiftMap, recordVitals, saveShiftMap, checkCrashCart, endRestraint, insertIpdLine, issueMed, orderRestraint, placeIpOrder, raiseWardIndent,
  readMyShift, readRestraintRegister, readRoundPatient, readWardCockpit, readWardQuality, readWardSafety, readWardStock, recordCareCheck,
  recordNarcoticCount, recordNursingAssessment, recordRestraintCheck, recordRestraintFamilyTold, recordRiskScore, recordSafetyEvent,
  recordWardStockUse, registerCrashCart, removeIpdLine, reviewIpdLine, reviewRestraint, secondCheck, setWardPar, sweepWardSafety,
  takeNarcoticKeys, useCrashCart, verifyOrder,
} from "../index";
import { IpdError, IpdRefusal } from "../errors";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";
import type { WardSafetyWorld } from "../../../../test/helpers/ipd";

/**
 * SPEC #983 — WARD WM-2: SAFETY ROUND, RESTRAINTS, LINES, CRASH CART, WARD STOCK, WARD QUALITY
 * (docs/specs/983-ward-wm2.md; rulings decisions 0089 and 0091). One block per "Done means" id, D1–D8. Every act and read
 * takes an EXPLICIT instant in IST; nothing here reads the real clock. Every name is made up.
 */

jest.setTimeout(300_000);

const ist = (s: string): Date => new Date(`${s}+05:30`);
const on = (day: number, hhmm: string): Date => ist(`2026-03-${String(day).padStart(2, "0")}T${hhmm}:00`);
const key = (): string => randomUUID();
const TICKS = { allergy: true, interaction: true, dose: true, duplicate: true };

async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { if (e instanceof IpdRefusal || e instanceof IpdError) return e.code; throw e; }
  throw new Error("expected a refusal, the act succeeded");
}

describe("spec #983 WM-2 ward safety, stock and quality — acceptance", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: WardSafetyWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    w = await mkWardSafetyWorld(db);
  });

  const assess = (admissionId: string, at: Date, morse: number, braden: number) => recordNursingAssessment(db, w.nurse, {
    idempotencyKey: key(), admissionId, happenedAt: at.toISOString(), source: "person", morse, braden, nutrition: "no_risk",
    allergyChecked: true, allergies: [], homeMedicines: [], painScore: 1, pressureInjuriesOnAdmission: [],
  }, { now: at });
  const wardOf = async (admissionId: string): Promise<string> => (await admissionPlace(db, admissionId))!.wardId!;

  describe("spec #983 D1 — Morse 45+ or Braden 12- gives a care plan whose missed check shows on My shift and Needs you", () => {
    it("the admission score starts a fall plan; a late check lists until done; the daily score moves the plans", async () => {
      const { admissionId } = await w.admitMed(on(10, "10:00"));
      const wardId = await wardOf(admissionId);
      await assess(admissionId, on(10, "10:30"), 50, 18);

      let safety = await readWardSafety(db, w.incharge, { wardId, now: on(10, "10:31") });
      expect(safety.carePlans.map((p) => [p.admissionId, p.kind])).toEqual([[admissionId, "fall"]]);
      const plan = safety.carePlans[0]!;
      expect(plan.nextDueAt).toBe(on(10, "14:30").toISOString());

      // Not yet due: nothing in Needs you. Past its time: on My shift (overdue) and in Needs you, until done.
      expect((await readWardCockpit(db, w.incharge, { wardId, now: on(10, "12:00") })).needsYou.filter((n) => n.kind === "care_check")).toHaveLength(0);
      const shift = await readMyShift(db, w.nurse, { wardId, now: on(10, "14:45") });
      expect(shift.now.filter((i) => i.kind === "care_check")).toMatchObject([{ admissionId, overdue: true, refId: plan.planId }]);
      expect((await readWardCockpit(db, w.incharge, { wardId, now: on(10, "14:45") })).needsYou.filter((n) => n.kind === "care_check")).toHaveLength(1);
      expect((await readWardCockpit(db, w.incharge, { wardId, now: on(10, "17:00") })).needsYou.filter((n) => n.kind === "care_check")).toHaveLength(1);

      await recordCareCheck(db, w.nurse, { idempotencyKey: key(), planId: plan.planId }, { now: on(10, "17:05") });
      expect((await readMyShift(db, w.nurse, { wardId, now: on(10, "17:10") })).now.filter((i) => i.kind === "care_check")).toHaveLength(0);
      expect((await readWardCockpit(db, w.incharge, { wardId, now: on(10, "17:10") })).needsYou.filter((n) => n.kind === "care_check")).toHaveLength(0);

      // The daily safety round: Morse down ends the fall plan; Braden 10 starts a 2-hourly turn plan.
      const next = await recordRiskScore(db, w.nurse, { idempotencyKey: key(), admissionId, morse: 30, braden: 10 }, { now: on(11, "09:00") });
      expect(next.plans.map((p) => [p.kind, p.change]).sort()).toEqual([["fall", "ended"], ["pressure", "started"]]);
      safety = await readWardSafety(db, w.incharge, { wardId, now: on(11, "09:01") });
      expect(safety.carePlans.map((p) => p.kind)).toEqual(["pressure"]);
      expect(safety.carePlans[0]!.nextDueAt).toBe(on(11, "11:00").toISOString());
    });

    it("a low-risk patient has no care plan", async () => {
      const { admissionId } = await w.admitMed(on(10, "10:00"));
      await assess(admissionId, on(10, "10:30"), 20, 20);
      expect((await readWardSafety(db, w.incharge, { wardId: await wardOf(admissionId), now: on(10, "11:00") })).carePlans).toHaveLength(0);
    });
  });

  describe("spec #983 D2 — restraint only on a doctor's order; a missed 2-hour check alerts; the order lapses at 24 h; the register lists it", () => {
    it("refuses a nurse's order and a start without an order; alerts once per missed check; lapses; lists with the family told", async () => {
      const { admissionId } = await w.admitMed(on(10, "08:00"));
      const wardId = await wardOf(admissionId);
      expect(await codeOf(orderRestraint(db, w.nurse, { idempotencyKey: key(), admissionId, kind: "physical", reason: "Pulling lines" }, { now: on(10, "09:55") }))).toBe("ipd_forbidden");
      expect(await codeOf(applyRestraint(db, w.nurse, { idempotencyKey: key(), restraintId: newId() }, { now: on(10, "09:56") }))).toBe("restraint_not_found");

      const o = await orderRestraint(db, w.consultant, { idempotencyKey: key(), admissionId, kind: "physical", reason: "Pulling lines, delirium" }, { now: on(10, "10:00") });
      expect(o.reviewDueAt).toBe(on(11, "10:00").toISOString());
      await applyRestraint(db, w.nurse, { idempotencyKey: key(), restraintId: o.restraintId }, { now: on(10, "10:05") });
      await recordRestraintCheck(db, w.nurse, {
        idempotencyKey: key(), restraintId: o.restraintId, circulation: true, skin: true, hydration: true, toileting: true,
      }, { now: on(10, "12:00") });
      await recordRestraintFamilyTold(db, w.nurse, {
        idempotencyKey: key(), restraintId: o.restraintId, toldName: "Ramesh Kumar", relation: "Son", toldAt: on(10, "10:30").toISOString(),
      }, { now: on(10, "10:35") });

      // Next check due 14:00: nothing before; one alert after; never twice for the same check.
      expect((await sweepWardSafety(db, on(10, "13:59"))).restraintChecksMissed).toBe(0);
      expect((await sweepWardSafety(db, on(10, "14:01"))).restraintChecksMissed).toBe(1);
      expect((await sweepWardSafety(db, on(10, "14:30"))).restraintChecksMissed).toBe(0);
      expect(await db.select().from(alerts).where(and(eq(alerts.kind, "ipd.restraint_check_missed"), eq(alerts.userId, w.supervisor.id)))).toHaveLength(1);

      // No doctor's review by 24 hours: lapsed; nothing more can be done on it.
      expect((await sweepWardSafety(db, on(11, "10:01"))).restraintsLapsed).toBe(1);
      expect((await db.select().from(ipdRestraints).where(eq(ipdRestraints.id, o.restraintId)))[0]!.status).toBe("lapsed");
      expect(await codeOf(reviewRestraint(db, w.consultant, { idempotencyKey: key(), restraintId: o.restraintId, decision: "continue" }, { now: on(11, "10:05") }))).toBe("restraint_lapsed");
      expect(await codeOf(recordRestraintCheck(db, w.nurse, {
        idempotencyKey: key(), restraintId: o.restraintId, circulation: true, skin: true, hydration: true, toileting: true,
      }, { now: on(11, "10:06") }))).toBe("restraint_lapsed");
      expect(await db.select().from(events).where(eq(events.name, "ipd.restraint.lapsed"))).toHaveLength(1);

      // A reviewed order does not lapse; a second episode ends normally. Both list in the month's register.
      const o2 = await orderRestraint(db, w.consultant, { idempotencyKey: key(), admissionId, kind: "physical", reason: "Agitation" }, { now: on(12, "08:00") });
      await applyRestraint(db, w.nurse, { idempotencyKey: key(), restraintId: o2.restraintId }, { now: on(12, "08:05") });
      const reviewed = await reviewRestraint(db, w.consultant, { idempotencyKey: key(), restraintId: o2.restraintId, decision: "continue" }, { now: on(13, "07:00") });
      expect(reviewed.reviewDueAt).toBe(on(14, "07:00").toISOString());
      await sweepWardSafety(db, on(13, "08:30"));
      expect((await db.select().from(ipdRestraints).where(eq(ipdRestraints.id, o2.restraintId)))[0]!.status).toBe("active");
      await endRestraint(db, w.nurse, { idempotencyKey: key(), restraintId: o2.restraintId, reason: "Calm" }, { now: on(13, "09:00") });

      const register = await readRestraintRegister(db, w.incharge, { month: "2026-03", wardId });
      expect(register.episodes.map((e) => [e.restraintId, e.status])).toEqual([[o.restraintId, "lapsed"], [o2.restraintId, "ended"]]);
      expect(register.episodes[0]).toMatchObject({ familyTold: { name: "Ramesh Kumar", relation: "Son" }, checks: 1 });
      expect(register.episodes[0]!.missedChecks).toBeGreaterThanOrEqual(1);
    });
  });

  describe("spec #983 D3 — each line has insertion and due-removal; the round asks 'still needed?' daily; line-days add up", () => {
    it("dates each line, asks the doctor once a day, and sums the ward's line-days", async () => {
      const { admissionId } = await w.admitMed(on(10, "08:00"));
      const wardId = await wardOf(admissionId);
      const cannula = await insertIpdLine(db, w.nurse, { idempotencyKey: key(), admissionId, kind: "cannula", site: "Left forearm", insertedAt: on(10, "10:00").toISOString() }, { now: on(10, "10:05") });
      const cath = await insertIpdLine(db, w.nurse, { idempotencyKey: key(), admissionId, kind: "urinary_catheter", site: "Urethral", insertedAt: on(10, "12:00").toISOString() }, { now: on(10, "12:05") });
      expect(cannula.dueRemovalAt).toBe(on(13, "10:00").toISOString());
      expect(cath.dueRemovalAt).toBe(on(11, "12:00").toISOString());

      let page = await readRoundPatient(db, w.consultant, admissionId, on(11, "09:00"));
      expect(page.lines?.map((l) => [l.kind, l.stillNeededAsked]).sort()).toEqual([["cannula", true], ["urinary_catheter", true]]);
      await reviewIpdLine(db, w.consultant, { idempotencyKey: key(), lineId: cath.lineId, decision: "keep" }, { now: on(11, "09:10") });
      page = await readRoundPatient(db, w.consultant, admissionId, on(11, "09:20"));
      expect(page.lines?.find((l) => l.lineId === cath.lineId)?.stillNeededAsked).toBe(false);
      expect(page.lines?.find((l) => l.lineId === cannula.lineId)?.stillNeededAsked).toBe(true);
      page = await readRoundPatient(db, w.consultant, admissionId, on(12, "09:00"));
      expect(page.lines?.find((l) => l.lineId === cath.lineId)?.stillNeededAsked).toBe(true);

      await removeIpdLine(db, w.nurse, { idempotencyKey: key(), lineId: cath.lineId, removedAt: on(12, "08:00").toISOString(), reason: "Voiding" }, { now: on(12, "08:05") });
      await removeIpdLine(db, w.nurse, { idempotencyKey: key(), lineId: cannula.lineId, removedAt: on(13, "09:00").toISOString(), reason: "Oral now" }, { now: on(13, "09:05") });
      // In on 10, 11, 12 (catheter: 3 days) and 10, 11, 12, 13 (cannula: 4 days) = 7 line-days.
      const q = await readWardQuality(db, w.incharge, { wardId, month: "2026-03", now: on(20, "10:00") });
      expect(q.lineDays).toBe(7);
      expect(q.indicators.lineInfections.over).toBe(7);
    });
  });

  describe("spec #983 D4 — a changed seal forces a full recount and one incident; a used cart needs restock until resealed", () => {
    it("checks against the seal and the contents", async () => {
      const cart = await registerCrashCart(db, w.incharge, {
        idempotencyKey: key(), wardId: w.wardId, code: "CC-1", sealNo: "S-100", contents: [{ item: "Adrenaline 1 mg/ml amp", qty: 10 }, { item: "Atropine 0.6 mg amp", qty: 5 }],
      }, { now: on(10, "08:00") });
      const full = [{ item: "Adrenaline 1 mg/ml amp", qty: 10 }, { item: "Atropine 0.6 mg amp", qty: 5 }];
      expect(await checkCrashCart(db, w.nurse, { idempotencyKey: key(), cartId: cart.cartId, sealNo: "S-100" }, { now: on(10, "08:30") })).toMatchObject({ incidentId: null, status: "ready" });

      expect(await codeOf(checkCrashCart(db, w.nurse, { idempotencyKey: key(), cartId: cart.cartId, sealNo: "S-101" }, { now: on(10, "14:30") }))).toBe("crash_cart_recount_required");
      expect(await codeOf(checkCrashCart(db, w.nurse, { idempotencyKey: key(), cartId: cart.cartId, sealNo: "S-101", recount: [full[0]!] }, { now: on(10, "14:31") }))).toBe("crash_cart_recount_required");
      const changed = await checkCrashCart(db, w.nurse, { idempotencyKey: key(), cartId: cart.cartId, sealNo: "S-101", recount: full }, { now: on(10, "14:32") });
      expect(changed.incidentId).not.toBeNull();
      expect(await db.select().from(ipdWardIncidents)).toHaveLength(1);
      expect(await db.select().from(alerts).where(and(eq(alerts.kind, "ipd.ward_incident"), eq(alerts.userId, w.superintendent.id)))).toHaveLength(1);

      await useCrashCart(db, w.nurse, { idempotencyKey: key(), cartId: cart.cartId, note: "Code blue bed 4" }, { now: on(10, "16:00") });
      expect((await readWardSafety(db, w.incharge, { wardId: w.wardId, now: on(10, "16:05") })).carts[0]).toMatchObject({ status: "needs_restock" });
      expect(await codeOf(checkCrashCart(db, w.nurse, { idempotencyKey: key(), cartId: cart.cartId, sealNo: "S-101" }, { now: on(10, "16:30") }))).toBe("crash_cart_restock_required");
      const restocked = await checkCrashCart(db, w.nurse, { idempotencyKey: key(), cartId: cart.cartId, sealNo: "S-102", recount: full }, { now: on(10, "17:00") });
      expect(restocked).toMatchObject({ status: "ready", incidentId: null });
      expect(await db.select().from(ipdWardIncidents)).toHaveLength(1);
      expect((await readWardSafety(db, w.incharge, { wardId: w.wardId, now: on(10, "17:05") })).carts[0]).toMatchObject({ status: "ready", sealNo: "S-102" });
    });
  });

  describe("spec #983 D5 — the ward indent proposes each shortfall to par as one materials indent; lots expiring in 30 days are listed", () => {
    it("raises one indent on the supply store and lists the near-expiry lots", async () => {
      const gloves = await w.wardItem("Gloves pair");
      const syringe = await w.wardItem("Syringe 5 ml");
      const par = await setWardPar(db, w.incharge, {
        idempotencyKey: key(), wardId: w.wardId, supplyStoreId: w.centralStoreId, items: [{ itemId: gloves.itemId, par: 10 }, { itemId: syringe.itemId, par: 5 }],
      }, { now: on(10, "08:00") });
      await w.lot(gloves.itemId, par.storeId, 3, "2026-04-01");
      await w.lot(syringe.itemId, par.storeId, 5, "2027-01-01");

      const stock = await readWardStock(db, w.incharge, { wardId: w.wardId, now: on(10, "09:00") });
      expect(stock.items.map((i) => [i.itemId, i.shortfall]).sort()).toEqual([[gloves.itemId, 7], [syringe.itemId, 0]].sort());
      expect(stock.expiring.map((l) => l.itemId)).toEqual([gloves.itemId]);

      const raised = await raiseWardIndent(db, w.incharge, { idempotencyKey: key(), wardId: w.wardId }, { now: on(10, "09:05") });
      const indents = await db.select().from(storeIndents);
      expect(indents).toHaveLength(1);
      expect(indents[0]).toMatchObject({ id: raised.indentId, fromResourceId: par.storeId, toResourceId: w.centralStoreId, status: "requested" });
      const lines = await db.select().from(storeIndentLines).where(eq(storeIndentLines.indentId, raised.indentId));
      expect(lines.map((l) => [l.itemId, l.qtyBase])).toEqual([[gloves.itemId, 7]]);
    });
  });

  describe("spec #983 D6 — ward stock charges follow 0089 / 0091", () => {
    it("charges used, issued and reasoned wastage; never refused-unopened, staff error, a waiver or an expired lot", async () => {
      const { admissionId } = await w.admitMed(on(10, "08:00"));
      const dressing = await w.wardItem("Dressing pad");
      const par = await setWardPar(db, w.incharge, { idempotencyKey: key(), wardId: await wardOf(admissionId), supplyStoreId: w.centralStoreId, items: [{ itemId: dressing.itemId, par: 20 }] }, { now: on(10, "08:30") });
      const good = await w.lot(dressing.itemId, par.storeId, 20, "2027-06-30");
      const old = await w.lot(dressing.itemId, par.storeId, 5, "2026-02-28");
      const use = (actor: Actor, body: Record<string, unknown>, at: Date) =>
        recordWardStockUse(db, actor, { idempotencyKey: key(), admissionId, itemId: dressing.itemId, batchId: good, qty: 1, ...body }, { now: at });
      const linesOf = async (useId: string) => db.select().from(ipdChargeLines).where(eq(ipdChargeLines.issueId, useId));

      const used = await use(w.nurse, { outcome: "used", qty: 2 }, on(10, "09:00"));
      expect(used.charged).toBe(true);
      expect((await linesOf(used.useId)).map((l) => l.qty)).toEqual([2]);
      const issued = await use(w.nurse, { outcome: "issued" }, on(10, "09:10"));
      expect(issued.charged).toBe(true);
      expect(await linesOf(issued.useId)).toHaveLength(1);

      expect(await codeOf(use(w.nurse, { outcome: "wasted" }, on(10, "09:20")))).toBe("waste_reason_required");
      const wasted = await use(w.nurse, { outcome: "wasted", reason: "Dropped on the floor after opening" }, on(10, "09:21"));
      expect(wasted.charged).toBe(true);
      const staffError = await use(w.nurse, { outcome: "wasted", reason: "Wrong size opened", staffError: true }, on(10, "09:22"));
      expect(staffError.charged).toBe(false);
      expect(await linesOf(staffError.useId)).toHaveLength(0);
      expect(await codeOf(use(w.nurse, { outcome: "wasted", reason: "Contaminated", waive: { reason: "Family poor" } }, on(10, "09:23")))).toBe("waive_needs_incharge");
      const waived = await use(w.incharge, { outcome: "wasted", reason: "Contaminated", waive: { reason: "Family poor" } }, on(10, "09:24"));
      expect(waived.charged).toBe(false);

      const before = (await balances(db, { resourceId: par.storeId, batchId: good }))[0]!.qtyOnHand;
      const refused = await use(w.nurse, { outcome: "refused" }, on(10, "09:30"));
      expect(refused.charged).toBe(false);
      expect(await linesOf(refused.useId)).toHaveLength(0);
      expect((await balances(db, { resourceId: par.storeId, batchId: good }))[0]!.qtyOnHand).toBe(before);

      expect(await codeOf(use(w.nurse, { outcome: "used", batchId: old }, on(10, "09:40")))).toBe("ward_stock_lot_expired");
      const allLines = await db.select().from(ipdChargeLines).where(eq(ipdChargeLines.admissionId, admissionId));
      expect(allLines.filter((l) => l.batchId === old)).toHaveLength(0);
      expect(allLines.filter((l) => l.batchId === good).length).toBe(3);
    });
  });

  describe("spec #983 D7 — a student never signs a high-alert or narcotic dose alone; an agency nurse has no narcotic keys or count", () => {
    it("holds the student and the agency nurse to their limits", async () => {
      const { admissionId } = await w.admitMed(on(10, "10:00"));
      const med = await w.stocked("Morphine 10 mg/ml inj", { narcotic: true, form: "injection", strength: "10 mg/ml", baseUom: "ampoule" });
      const placed = await placeIpOrder(db, w.consultant, {
        idempotencyKey: key(), admissionId, kind: "drug",
        drug: { itemId: med.medicineId, dose: { value: 5, unit: "mg" }, route: "iv", frequency: "BD", startAt: on(11, "07:00").toISOString(), antibiotic: false, durationDays: 5 },
      }, { now: on(11, "07:00") });
      await verifyOrder(db, w.pharmacist, { idempotencyKey: key(), orderId: placed.orderId, decision: "verified", checks: TICKS, note: "checked" }, { now: on(11, "07:30") });
      const issued = await issueMed(db, w.pharmacist, { idempotencyKey: key(), orderId: placed.orderId, units: 4, ownMedicine: false }, { now: on(11, "07:40") });
      const labelCode = (await db.select().from(ipdEmarLabels).where(eq(ipdEmarLabels.issueId, issued.issueId)))[0]!.code;
      const band = await w.band(admissionId);
      const give = (actor: Actor, secondNurse?: { userId: string; pinProof: string }) => administerDose(db, actor, {
        idempotencyKey: key(), orderId: placed.orderId, doseDueAt: on(11, "09:00").toISOString(), givenAt: on(11, "09:00").toISOString(),
        patientCheck: { kind: "scan", wristbandCode: band }, labelCode, ...(secondNurse === undefined ? {} : { secondNurse }),
      }, { now: on(11, "09:00") });

      // The student alone: refused. A second student is no registered nurse. A registered nurse's PIN: given.
      expect(await codeOf(give(w.student))).toBe("second_nurse_required");
      expect(await codeOf(secondCheck(db, w.nurse, {
        idempotencyKey: key(), purpose: "high_alert_dose", orderId: placed.orderId, username: w.studentPin.username, pin: w.studentPin.pin, doseDueAt: on(11, "09:00").toISOString(),
      }, { now: on(11, "09:00") }))).toBe("second_nurse_not_nurse");
      const rn = await secondCheck(db, w.student, {
        idempotencyKey: key(), purpose: "high_alert_dose", orderId: placed.orderId, username: w.pins.nurse.username, pin: w.pins.nurse.pin, doseDueAt: on(11, "09:00").toISOString(),
      }, { now: on(11, "09:00") });
      expect(await give(w.student, { userId: rn.userId, pinProof: rn.pinProof })).toMatchObject({ late: false });

      // The agency nurse: no keys, no count (neither counting nor as the second nurse). A staff nurse may.
      const wardId = await wardOf(admissionId);
      expect(await codeOf(takeNarcoticKeys(db, w.agency, { idempotencyKey: key(), wardId }, { now: on(11, "14:00") }))).toBe("agency_no_narcotic_keys");
      expect(await codeOf(takeNarcoticKeys(db, w.student, { idempotencyKey: key(), wardId }, { now: on(11, "14:00") }))).toBe("student_no_narcotic_keys");
      expect(await takeNarcoticKeys(db, w.nurse, { idempotencyKey: key(), wardId }, { now: on(11, "14:01") })).toMatchObject({ wardId });
      const lines = [{ medicineId: med.medicineId, unit: "ampoule", counted: 3.5 }];
      expect(await codeOf(recordNarcoticCount(db, w.agency, { idempotencyKey: key(), wardId, lines, secondNurse: { username: w.pins.nurse.username, pin: w.pins.nurse.pin } }, { now: on(11, "14:05") })))
        .toBe("agency_no_narcotic_count");
      expect(await codeOf(recordNarcoticCount(db, w.nurse, { idempotencyKey: key(), wardId, lines, secondNurse: w.agencyPin }, { now: on(11, "14:06") })))
        .toBe("agency_no_narcotic_count");
      expect(await recordNarcoticCount(db, w.nurse, { idempotencyKey: key(), wardId, lines, secondNurse: { username: w.pins.nurse2.username, pin: w.pins.nurse2.pin } }, { now: on(11, "14:07") }))
        .toMatchObject({ mismatches: 0 });
    });
  });

  describe("spec #983 D8 — the ward's monthly quality read: seven indicators, each traceable, present-on-admission excluded", () => {
    it("returns the seven indicators with their source rows", async () => {
      const a = await w.admitMed(on(10, "10:00"));
      const b = await w.admitMed(on(10, "10:00"));
      const wardId = await wardOf(a.admissionId);
      const ev = (admissionId: string, kind: "fall" | "pressure_injury" | "medication_error" | "line_infection", extra: Record<string, unknown> = {}) =>
        recordSafetyEvent(db, w.nurse, { idempotencyKey: key(), admissionId, kind, occurredAt: on(12, "10:00").toISOString(), ...extra }, { now: on(12, "10:05") });
      const fall = await ev(a.admissionId, "fall");
      const poaFall = await ev(b.admissionId, "fall", { presentOnAdmission: true });
      const pi = await ev(a.admissionId, "pressure_injury");
      const poaPi = await ev(b.admissionId, "pressure_injury", { presentOnAdmission: true });
      const medErr = await ev(b.admissionId, "medication_error");
      const line = await insertIpdLine(db, w.nurse, { idempotencyKey: key(), admissionId: a.admissionId, kind: "central_line", site: "Right IJ", insertedAt: on(11, "10:00").toISOString() }, { now: on(11, "10:00") });
      const clabsi = await ev(a.admissionId, "line_infection", { lineId: line.lineId });

      // An early-warning alert a doctor answered in 5 minutes; a handover accepted in 15; one published shift with its ratio kept.
      const vit = await recordVitals(db, w.nurse, {
        idempotencyKey: key(), admissionId: a.admissionId, observedAt: on(12, "11:00").toISOString(), source: "person",
        values: { temperatureC: 39, pulse: 131, respRate: 26, systolic: 92, diastolic: 60, spo2: 90, onOxygen: false, consciousness: "alert" },
      }, { now: on(12, "11:00") });
      const alert = (await db.select().from(ipdNursingAlerts).where(and(eq(ipdNursingAlerts.admissionId, a.admissionId), eq(ipdNursingAlerts.kind, "ews"))))[0]!;
      expect(vit).toBeDefined();
      await acknowledgeEwsAlert(db, w.consultant, { idempotencyKey: key(), alertId: alert.id }, { now: on(12, "11:05") });
      const SBAR = { situation: "Stable", background: "Pneumonia", assessment: "Vitals in range", recommendation: "Routine observations" };
      const handover = await giveShiftHandover(db, w.nurse, { idempotencyKey: key(), admissionId: a.admissionId, sbar: SBAR }, { now: on(12, "19:50") });
      await acceptShiftHandover(db, w.nurse2, { idempotencyKey: key(), handoverId: handover.handoverId }, { now: on(12, "20:05") });
      const bedA = (await admissionPlace(db, a.admissionId))!.bedId!;
      const bedB = (await admissionPlace(db, b.admissionId))!.bedId!;
      const map = await saveShiftMap(db, w.incharge, {
        idempotencyKey: key(), wardId, shiftDate: "2026-03-13", shift: "morning", staff: [{ userId: w.nurse.id, kind: "rn" }],
        beds: [{ bedId: bedA, nurseId: w.nurse.id }, { bedId: bedB, nurseId: w.nurse.id }],
      }, { now: on(13, "07:00") });
      await publishShiftMap(db, w.incharge, { idempotencyKey: key(), mapId: map.mapId }, { now: on(13, "07:10") });

      // Two patients for 10 days each (10th 10:00 → 20th 10:00) = 20 bed-days.
      const q = await readWardQuality(db, w.incharge, { wardId, month: "2026-03", now: on(20, "10:00") });
      expect(q.bedDays).toBe(20);
      expect(q.indicators.falls).toMatchObject({ count: 1, over: 20, value: 50, unit: "per_1000_bed_days", sources: [fall.eventId] });
      expect(q.indicators.pressureInjuries).toMatchObject({ count: 1, sources: [pi.eventId] });
      expect(q.indicators.medicationErrors).toMatchObject({ count: 1, sources: [medErr.eventId] });
      // The central line: 11th → 20th = 10 line-days; one infection → 100 per 1,000 line-days.
      expect(q.indicators.lineInfections).toMatchObject({ count: 1, over: 10, value: 100, unit: "per_1000_line_days", sources: [clabsi.eventId] });
      expect(q.presentOnAdmission.sort()).toEqual([poaFall.eventId, poaPi.eventId].sort());
      expect(q.indicators.ewsAnsweredInTime).toMatchObject({ count: 1, over: 1, value: 100, unit: "percent", sources: [alert.id] });
      expect(q.indicators.handoversOnTime).toMatchObject({ count: 1, over: 1, value: 100, unit: "percent", sources: [handover.handoverId] });
      expect(q.indicators.shiftsRatioKept).toMatchObject({ count: 1, over: 1, value: 100, unit: "percent", sources: [map.mapId] });
      expect(Object.keys(q.indicators).sort()).toEqual([
        "ewsAnsweredInTime", "falls", "handoversOnTime", "lineInfections", "medicationErrors", "pressureInjuries", "shiftsRatioKept",
      ]);
    });
  });
});
