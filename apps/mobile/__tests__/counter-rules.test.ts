import { readFileSync } from "fs";
import { join } from "path";
import {
  EMPTY_SHORT_REGISTRATION, SAMAJ_SEVA_AMOUNT, billOf, deptQueues, firstFreeDoctor, laneOf, moveCollectPaise, moveFee, moveMoneyBlocks, moveMoneyLine,
  openVisitsToday, paperState, parseAgeOrDob, rs, shortFormGaps, shortRegisterBody, shouldJoinNow, tokenLabel, tokenStateOf,
} from "../src/counter/rules";
import type { MoveMoney } from "../src/counter/rules";

const read = (rel: string): string => readFileSync(join(__dirname, rel), "utf8");
const TODAY = new Date(2026, 9, 6); // 6 Oct 2026, local

describe("the counter's rules — one file for the counter PC and the phone", () => {
  it("the web's Desk One reads the SAME file: its model re-exports the moved rules and defines none of them", () => {
    const model = read("../../web/src/screens/desk-one/model.ts");
    expect(model).toContain('from "../../../../../packages/contracts/src/desk-counter"');
    expect(model).not.toMatch(/export function (laneOf|tokenStateOf|openVisitsToday|shouldJoinNow|rs|billOf|invoiceLinesOf|deptQueues|firstFreeDoctor|tokenLabel|ageOf|sexLetter)\b/);
    const session = read("../../web/src/screens/desk-one/session.ts");
    expect(session).not.toMatch(/export function parseAgeOrDob/);
    const move = read("../../web/src/screens/desk-one/move-department.tsx");
    expect(move).toContain("moveMoneyLine(");
    expect(move).not.toMatch(/function moneyBlocks/);
    expect(read("../../web/src/lib/print-api.ts")).toContain("paperState(jobs)");
    // …and the phone grows no second copy either.
    expect(read("../src/counter/rules.ts")).not.toMatch(/export (function|const)/);
  });

  it("the long-line mark is the web's own 20 minutes", () => {
    expect(read("../../web/src/lib/walk-in-routing.ts")).toContain("DELAY_HIGHLIGHT_MINUTES = 20");
    expect(read("../src/screens/desk-one.tsx")).toContain("DELAY_HIGHLIGHT_MINUTES = 20");
  });

  it("the guardian relationships and the majority age are the server's own", () => {
    const controller = read("../../core/src/modules/patients/patients.controller.ts");
    for (const rel of ["father", "mother", "spouse", "sibling", "legal_guardian", "other"]) expect(controller).toContain(`"${rel}"`);
    expect(read("../../core/src/modules/patients/types.ts")).toContain("MAJORITY_AGE_YEARS = 18");
    expect(controller).toContain("/^[6-9]\\d{9}$/");
  });

  it("folds the server's two columns onto three lanes, and the lane decides when the slip leaves the printer", () => {
    expect(laneOf({ counterSequence: "queue_first", tokenLane: "token_first" })).toBe("F1");
    expect(laneOf({ counterSequence: "queue_first", tokenLane: "token_on_payment" })).toBe("F2");
    expect(laneOf({ counterSequence: "bill_first", tokenLane: "token_first" })).toBe("F3");
    expect(tokenStateOf("F1", { tokenNo: 4 }, false)).toEqual({ kind: "out", tokenNo: 4, paid: false });
    expect(tokenStateOf("F2", { tokenNo: 4 }, false)).toEqual({ kind: "held", position: 4 });
    expect(tokenStateOf("F2", { tokenNo: 4 }, true)).toEqual({ kind: "out", tokenNo: 4, paid: true });
    expect(tokenStateOf("F3", { tokenNo: null }, false)).toEqual({ kind: "held", position: null });
    // Bill-first joins the queue once, and only once the money is in.
    expect(shouldJoinNow("F3", { encounterId: "e", tokenNo: null, joining: false }, true)).toBe(true);
    expect(shouldJoinNow("F3", { encounterId: "e", tokenNo: null, joining: false }, false)).toBe(false);
    expect(shouldJoinNow("F3", { encounterId: "e", tokenNo: null, joining: true }, true)).toBe(false);
    expect(shouldJoinNow("F1", { encounterId: "e", tokenNo: null, joining: false }, true)).toBe(false);
    expect(tokenLabel("MED", 4)).toBe("MED-4");
    expect(tokenLabel(null, 4)).toBe("T-4");
  });

  it("reads the bill off the server's quote — and a switched-off fee is the Hindi line, whatever the language", () => {
    expect(SAMAJ_SEVA_AMOUNT).toBe("₹0 (समाज सेवा छूट)");
    const free = billOf({ free: true, feesOff: true, draft: null, freeReason: null });
    expect(free).toMatchObject({ free: true, totalPaise: 0 });
    expect(free.lines[0]?.label).toContain(SAMAJ_SEVA_AMOUNT);
    const paid = billOf({
      free: false, freeReason: null,
      draft: {
        lines: [{ lineId: "l1", serviceId: "s1", serviceName: "OPD consultation — new", qty: 1, grossPaise: 30000, discountPaise: 5000, winner: { reason: "member plan" } }],
        totals: { cgstPaise: 0, sgstPaise: 0, roundingPaise: 0, netPayablePaise: 25000 },
      },
    });
    expect(paid.totalPaise).toBe(25000);
    expect(paid.lines.map((l) => [l.label, l.paise])).toEqual([["OPD consultation — new", 30000], ["member plan", -5000]]);
    expect(rs(25000)).toBe("₹250");
    expect(rs(123450)).toBe("₹1,234.50");
  });

  it("finds today's open visit and names a referral's source", () => {
    const items = [
      { encounterId: "e1", visitNo: "V1", serviceDate: "2026-10-06", status: "waiting", visitType: "new", doctorId: "d1", doctorName: "Dr A", departmentId: "med", departmentName: "General Medicine" },
      { encounterId: "e2", visitNo: "V2", serviceDate: "2026-10-06", status: "registered", visitType: "revisit", doctorId: "d2", doctorName: "Dr B", departmentId: "eye", departmentName: "Ophthalmology", referredFromEncounterId: "e1" },
      { encounterId: "e3", visitNo: "V3", serviceDate: "2026-10-06", status: "abandoned", visitType: "new", doctorId: "d1", doctorName: "Dr A", departmentId: "med", departmentName: "General Medicine" },
      { encounterId: "e0", visitNo: "V0", serviceDate: "2026-10-01", status: "waiting", visitType: "new", doctorId: "d1", doctorName: "Dr A", departmentId: "med", departmentName: "General Medicine" },
    ];
    const open = openVisitsToday(items, "2026-10-06");
    expect(open.map((o) => o.encounterId)).toEqual(["e1", "e2"]);
    expect(open[1]?.referral).toEqual({ fromEncounterId: "e1", fromDepartmentName: "General Medicine", fromDoctorName: "Dr A" });
  });

  it("offers the shortest open line in a department, and never a doctor who is not sitting today", () => {
    const doc = (id: string, waiting: number, over: Record<string, unknown> = {}) => ({
      doctor: { id, departmentId: "med", active: true }, waitingCount: waiting, waitingVitalsCount: 0, scheduledToday: true, avgConsultMinutes: 6, ...over,
    });
    const [q] = deptQueues([doc("a", 5), doc("b", 2), doc("c", 0, { scheduledToday: false })], [{ id: "med", name: "General Medicine" }, { id: "ent", name: "ENT" }]);
    expect(q?.departmentName).toBe("General Medicine");
    expect(q?.poolWaitMinutes).toBe(12);
    expect(firstFreeDoctor(q!)?.doctor.id).toBe("b");
  });

  it("reads the one age-or-date-of-birth box as India writes it", () => {
    expect(parseAgeOrDob("34", TODAY)).toEqual({ kind: "age", years: 34 });
    expect(parseAgeOrDob("14/03/1986", TODAY)).toEqual({ kind: "dob", iso: "1986-03-14" });
    expect(parseAgeOrDob("14031986", TODAY)).toEqual({ kind: "dob", iso: "1986-03-14" });
    expect(parseAgeOrDob("31/02/1986", TODAY)).toBeNull();
    expect(parseAgeOrDob("14/03/2031", TODAY)).toBeNull();
    expect(parseAgeOrDob("14/03", TODAY)).toBeNull();
  });

  it("the short form: a blank box is an omitted key, one of dob/age, and a known minor needs a guardian", () => {
    const adult = { ...EMPTY_SHORT_REGISTRATION, name: " Sita Devi ", sex: "female" as const, ageOrDob: "34", phone: "98765 43210" };
    expect(shortFormGaps(adult, TODAY)).toEqual([]);
    expect(shortRegisterBody(adult, {}, TODAY)).toEqual({ name: "Sita Devi", sex: "female", phone: "9876543210", ageYears: 34 });
    expect(shortRegisterBody({ ...adult, ageOrDob: "14/03/1986", address: "Ward 12, Sitamarhi" }, { acknowledgeDuplicates: true }, TODAY)).toEqual({
      name: "Sita Devi", sex: "female", phone: "9876543210", dob: "1986-03-14", addressLine: "Ward 12, Sitamarhi", acknowledgedDuplicates: true,
    });
    expect(shortFormGaps({ ...EMPTY_SHORT_REGISTRATION }, TODAY)).toEqual(["name", "sex", "age"]);
    expect(shortFormGaps({ ...adult, phone: "12345" }, TODAY)).toEqual(["phone"]);
    const child = { ...adult, name: "Ravi", sex: "male" as const, ageOrDob: "8", phone: "" };
    expect(shortFormGaps(child, TODAY)).toEqual(["guardian"]);
    const withGuardian = { ...child, guardianName: "Mohan Kumar", guardianRelationship: "father" as const };
    expect(shortFormGaps(withGuardian, TODAY)).toEqual([]);
    // The four authorities ALWAYS travel: messages and bills on, consents and records off.
    expect(shortRegisterBody(withGuardian, {}, TODAY)).toEqual({
      name: "Ravi", sex: "male", ageYears: 8,
      guardian: { name: "Mohan Kumar", relationship: "father", authorityMessages: true, authorityBills: true, authorityConsents: false, authorityDsr: false },
    });
  });

  it("a department move: the server's amount wins, and the four money rules say what happens", () => {
    const terms = { consultFeeOff: false, paise: { new: 30000, renewal: 15000, revisit: null } };
    expect(moveFee("new", terms, 50000)).toEqual({ kind: "amount", paise: 50000 });
    expect(moveFee("revisit", terms)).toEqual({ kind: "free" });
    expect(moveFee("new", { ...terms, consultFeeOff: true }, 0)).toEqual({ kind: "feesOff" });
    expect(moveFee("new", undefined)).toBeNull();
    const money = (over: Partial<MoveMoney>): MoveMoney => ({ kind: "none", invoiceId: null, invoiceNo: "INV/1", paidPaise: 30000, newFeePaise: 30000, differencePaise: 0, billingOfficeReason: null, ...over });
    expect(moveMoneyLine(money({ kind: "none" }), false)).toBeNull();
    expect(moveMoneyLine(money({ kind: "transfer" }), false)).toMatchObject({ key: "registrationCounter.move.money.transfer", tone: "ok", vars: { paid: "₹300", no: "INV/1" } });
    const higher = money({ kind: "difference", newFeePaise: 50000, differencePaise: 20000 });
    expect(moveMoneyLine(higher, true)).toMatchObject({ key: "registrationCounter.move.money.higher", vars: { diff: "₹200" } });
    expect(moveCollectPaise(higher, true)).toBe(20000);
    // A desk that may not settle a difference is stopped, and collects nothing.
    expect(moveMoneyLine(higher, false)).toMatchObject({ key: "registrationCounter.move.money.differsDesk", tone: "stop" });
    expect(moveMoneyBlocks(higher, false)).toBe(true);
    expect(moveCollectPaise(higher, false)).toBe(0);
    const lower = money({ kind: "difference", newFeePaise: 0, differencePaise: -30000 });
    expect(moveMoneyLine(lower, true)).toMatchObject({ key: "registrationCounter.move.money.lower", vars: { left: "₹300" } });
    expect(moveCollectPaise(lower, true)).toBe(0);
    expect(moveMoneyBlocks(money({ kind: "billing_office", billingOfficeReason: "part_paid" }), true)).toBe(true);
    expect(moveMoneyLine(money({ kind: "billing_office", billingOfficeReason: "part_paid" }), true)?.key).toBe("registrationCounter.move.money.office.part_paid");
  });

  it("a visit's paper has one current state per document — a good reprint clears a failed slip", () => {
    const job = (id: string, document: string, status: string, createdAt: string) => ({ id, document, status, createdAt });
    expect(paperState([]).state).toBe("none");
    expect(paperState([job("1", "opd_token_slip", "failed", "2026-10-06T05:00:00Z")]).state).toBe("failed");
    const recovered = paperState([job("1", "opd_token_slip", "failed", "2026-10-06T05:00:00Z"), job("2", "opd_token_slip", "printed", "2026-10-06T05:01:00Z"), job("3", "opd_prescription", "queued", "2026-10-06T05:00:00Z")]);
    expect(recovered.state).toBe("waiting");
    expect(recovered.current.map((j) => j.id).sort()).toEqual(["2", "3"]);
    expect(paperState([job("2", "opd_token_slip", "printed", "2026-10-06T05:01:00Z")]).state).toBe("printed");
  });
});
