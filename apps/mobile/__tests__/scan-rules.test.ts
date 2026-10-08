import { SWIPE_FIRE, SWIPE_REVEAL, isSwipeRight, swipeFires } from "../src/scan/gestures";
import { missView, reachable, readingsOf, scanPlan, stripWords, tokenOf } from "../src/scan/model";
import type { ScanAction, ScanVisit } from "../src/scan/model";

jest.mock("expo-secure-store", () => ({ getItemAsync: jest.fn(async () => null), setItemAsync: jest.fn(async () => undefined), deleteItemAsync: jest.fn(async () => undefined) }));

/**
 * QUICK SCAN — the rules behind the card (owner 2026-10-08; board `2026-10-08-scan-vitals`).
 * Ram Pravesh Yadav, token MED-9, is scanned by four people. What each is offered is this file.
 */
const visit = (over: Partial<ScanVisit> = {}): ScanVisit => ({
  encounterId: "e9", patientId: "p9", visitNo: "V2610080009", serviceDate: "2026-10-08", tokenNo: 9, departmentCode: "MED", departmentName: "General Medicine",
  stage: "vitals", vitalsDone: false, slip: "none", feeUnpaid: false, mine: false,
  patient: { id: "p9", uhid: "U00110009", name: "Ram Pravesh Yadav", alias: null, restricted: false, administrativeGender: "male", dob: "1972-01-10T00:00:00.000Z" },
  ...over,
});
const NURSE: ScanAction[] = ["vitals"];
const DESK: ScanAction[] = ["collect", "visit", "move", "book", "newVisit"];
const DOCTOR: ScanAction[] = ["vitals", "slip", "consult", "brief", "paper"];
const keys = (xs: { labelKey: string }[]): string[] => xs.map((x) => x.labelKey.replace("mobile.scan.act.", ""));

describe("what a scan offers", () => {
  it("a vitals nurse and a patient waiting for vitals: the form opens, no card", () => {
    const p = scanPlan(visit(), NURSE, { cashOpen: false });
    expect(p.jump).toBe("vitals");
    expect(p.next?.action).toBe("vitals");
  });

  it("the front desk and the same patient: a card — the unpaid fee on top with a cash session open, the visit without one; vitals greyed with its reason", () => {
    const open = scanPlan(visit({ feeUnpaid: true }), DESK, { cashOpen: true });
    expect(open.jump).toBeNull();
    expect(open.next).toMatchObject({ action: "collect", labelKey: "mobile.scan.act.collect" });
    expect(keys(open.others)).toEqual(["visit", "move", "book"]);
    expect(open.greyed).toEqual([{ action: "vitals", labelKey: "mobile.scan.act.vitals", reasonKey: "mobile.scan.notYourJob" }]);

    const shut = scanPlan(visit({ feeUnpaid: true }), DESK, { cashOpen: false });
    expect(shut.jump).toBeNull();
    expect(shut.next?.action).toBe("visit");
    // The fee is still theirs to take — after a session is opened — so it stays offered, never the large button.
    expect(keys(shut.others)).toEqual(["collect", "move", "book"]);
  });

  it("the board's frame D: vitals done, fee not paid — collect, today's visit, move, book", () => {
    const p = scanPlan(visit({ stage: "waiting", vitalsDone: true, feeUnpaid: true }), DESK, { cashOpen: true });
    expect([p.next!, ...p.others].map((o) => o.action)).toEqual(["collect", "visit", "move", "book"]);
  });

  it("the doctor and their own waiting patient: it opens; the card a hold shows reads start, brief, paper", () => {
    const p = scanPlan(visit({ stage: "waiting", vitalsDone: true, mine: true }), DOCTOR, { cashOpen: false });
    expect(p.jump).toBe("consult");
    expect(keys([p.next!, ...p.others]).slice(0, 3)).toEqual(["consult", "brief", "paper"]);
  });

  it("another doctor's patient: the server sent no consult and no paper, so neither is offered or greyed — and the strip says whose it is not", () => {
    const v = visit({ stage: "waiting", vitalsDone: true, mine: false });
    const permitted: ScanAction[] = ["vitals", "slip", "brief"];
    const p = scanPlan(v, permitted, { cashOpen: false });
    expect(p.jump).toBeNull();
    expect([p.next!, ...p.others].map((o) => o.action)).not.toContain("consult");
    expect(p.greyed.map((g) => g.action)).not.toContain("consult");
    expect(p.next?.action).toBe("brief");
    expect(stripWords(v, permitted, Date.parse("2026-10-08T06:00:00Z")).map((w) => w.key)).toContain("mobile.scan.state.otherDoctor");
  });

  it("nothing permitted: no next, no others, and nothing greyed — no dead buttons", () => {
    expect(scanPlan(visit({ feeUnpaid: true }), [], { cashOpen: false })).toEqual({ jump: null, next: null, others: [], greyed: [] });
  });

  it("never more than two greyed lines", () => {
    for (const stage of ["registered", "vitals", "waiting", "called", "consult", "done"] as const) {
      expect(scanPlan(visit({ stage, feeUnpaid: true }), ["book"], { cashOpen: true }).greyed.length).toBeLessThanOrEqual(2);
    }
  });

  it("the fee and the slip open directly only for a person with nothing else to do for this patient", () => {
    expect(scanPlan(visit({ stage: "waiting", vitalsDone: true, feeUnpaid: true }), ["collect"], { cashOpen: true }).jump).toBe("collect");
    expect(scanPlan(visit({ stage: "waiting", vitalsDone: true, feeUnpaid: true }), ["collect"], { cashOpen: false }).jump).toBeNull();
    expect(scanPlan(visit({ stage: "done" }), ["slip"], { cashOpen: false }).jump).toBe("slip");
    expect(scanPlan(visit({ stage: "done" }), ["slip", "book", "newVisit"], { cashOpen: false }).jump).toBeNull();
    expect(scanPlan(visit({ stage: "done", slip: "filed" }), ["slip"], { cashOpen: false })).toMatchObject({ jump: null, next: null });
  });

  it("a jump is never to money for the desk, and never to anything that completes, cancels or moves", () => {
    for (const stage of ["registered", "vitals", "waiting", "called", "consult", "done"] as const) {
      for (const mine of [true, false]) {
        const j = scanPlan(visit({ stage, mine, feeUnpaid: true, vitalsDone: stage !== "vitals" }), [...DESK, ...DOCTOR], { cashOpen: true }).jump;
        expect([null, "vitals", "consult"]).toContain(j);
      }
    }
  });

  it("an action whose screen this login does not have is not offered", () => {
    expect(reachable(["vitals", "collect", "visit", "brief"], ["vitals"])).toEqual(["vitals"]);
    expect(reachable(["vitals", "collect", "visit", "brief"], ["counter", "consult"])).toEqual(["collect", "visit", "brief"]);
  });
});

describe("what was typed or scanned", () => {
  it("uses the app's one reader: a token, a visit number, an e-prescription, a UHID, a card", () => {
    expect(readingsOf("med-9")).toMatchObject({ queries: [{ by: "token", value: "9", departmentCode: "MED" }, { by: "uhid", value: "MED-9" }] });
    expect(readingsOf("#9")).toMatchObject({ queries: [{ by: "token", value: "9" }, { by: "uhid", value: "#9" }] });
    expect(readingsOf(" v2610080009 ")).toMatchObject({ queries: [{ by: "visit", value: "V2610080009" }, { by: "uhid", value: "V2610080009" }] });
    expect(readingsOf("rx1.r1.e9.1.sig")).toMatchObject({ queries: [{ by: "encounter", value: "e9" }] });
    expect(readingsOf("q1.p9.U1.1.sig")).toEqual({ card: "q1.p9.U1.1.sig" });
    expect(readingsOf("   ")).toEqual({ queries: [], first: null });
  });
  it("says the token as the slip prints it", () => {
    expect(tokenOf(visit())).toBe("MED-9");
    expect(tokenOf(visit({ tokenNo: null }))).toBe("V2610080009");
  });
});

describe("a miss says why", () => {
  it("an old slip: its date, how the visit ended, and a new visit only for a desk that may open one", () => {
    const base = { outcome: "miss" as const, reason: "other_day" as const, visitNo: "V2610060021", serviceDate: "2026-10-06", status: "completed", patient: visit().patient };
    const desk = missView({ ...base, permitted: ["book", "newVisit"] }, null);
    expect(desk.title).toEqual({ key: "mobile.scan.miss.otherDay", vars: { date: "06-Oct-2026" } });
    expect(desk.body).toEqual({ key: "mobile.scan.miss.otherDayCompleted", vars: { visitNo: "V2610060021" } });
    expect(desk.mayOpenVisit).toBe(true);
    expect(missView({ ...base, permitted: [] }, null).mayOpenVisit).toBe(false);
  });
  it("a token nobody holds today names the token; an unreadable code says so", () => {
    expect(missView({ outcome: "miss", reason: "unknown", permitted: [] }, { kind: "token", tokenNo: 9, departmentCode: "MED" }).body).toEqual({ key: "mobile.scan.miss.token", vars: { token: "MED-9" } });
    expect(missView({ outcome: "unreadable" }, null).title.key).toBe("mobile.scan.miss.unreadable");
    expect(missView({ outcome: "unreadable", card: "invalid_signature" }, null).body?.key).toBe("vitalsBay.identify.scanFailed.invalid_signature");
  });
});

describe("a swipe", () => {
  it("is a drag to the right, not a scroll, and fires only past the mark", () => {
    expect(isSwipeRight(30, 4)).toBe(true);
    expect(isSwipeRight(30, 40)).toBe(false);
    expect(isSwipeRight(-30, 0)).toBe(false);
    expect(isSwipeRight(8, 0)).toBe(false);
    expect(swipeFires(SWIPE_FIRE - 1)).toBe(false);
    expect(swipeFires(SWIPE_FIRE)).toBe(true);
    // The strip is fully uncovered before the action can fire: a person reads what a swipe will do before it does it.
    expect(SWIPE_REVEAL).toBeGreaterThan(SWIPE_FIRE);
  });
});
