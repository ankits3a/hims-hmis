import { describe, expect, it } from "vitest";
import {
  ageOf, billOf, bookableToday, deptQueues, firstFreeDoctor, flowOf, inHall, laneOf,
  rs, shortestLine, shouldJoinNow, stepIndex, tokenStateOf, vitalsAhead, waitMinutes,
} from "./model";
import type { WireDoctorSummary } from "../../lib/opd-api";
import type { WireFeeQuote } from "../../lib/billing-api";

/**
 * ═══ DESK ONE'S DECISIONS, TESTED WHERE THEY LIVE ═══
 *
 * RC-3's close review is the reason this file exists in the shape it does: thirteen mutants died
 * against that phase's COMPONENTS while all three CRITICALs sat in the ASSEMBLY, because the
 * assembly's decisions were JSX conditions no test could name. Every branch below is a decision the
 * desk makes about money, a token, or who is next — expressed as a function, so it can be asserted
 * without a render and so a mutant can be applied to it alone.
 */

const doc = (over: Partial<WireDoctorSummary> & { id: string; departmentId: string }): WireDoctorSummary => ({
  doctor: {
    id: over.id, userId: `u-${over.id}`, displayName: `Dr. ${over.id}`, registrationNo: null,
    departmentId: over.departmentId, specialty: null, active: over.doctor?.active ?? true,
    createdBy: "x", createdAt: "", updatedBy: "x", updatedAt: "",
  },
  sessionId: "s1", status: "in",
  waitingCount: over.waitingCount ?? 0,
  waitingVitalsCount: over.waitingVitalsCount ?? 0,
  nowServing: null,
  scheduledToday: over.scheduledToday ?? true,
  roomCode: over.roomCode ?? "OPD-1",
  avgConsultMinutes: over.avgConsultMinutes ?? 6,
  onLeaveToday: over.onLeaveToday ?? false,
});

describe("the counter lane — three names for two server columns", () => {
  it("maps each lane to the pair the server stores, and back", () => {
    expect(laneOf(flowOf("F1"))).toBe("F1");
    expect(laneOf(flowOf("F2"))).toBe("F2");
    expect(laneOf(flowOf("F3"))).toBe("F3");
    expect(flowOf("F1")).toEqual({ counterSequence: "queue_first", tokenLane: "token_first" });
    expect(flowOf("F2")).toEqual({ counterSequence: "queue_first", tokenLane: "token_on_payment" });
  });

  /**
   * `opd_config` carries two INDEPENDENT columns, so there is a fourth combination the artifact
   * never names: `bill_first` + `token_first`. It is incoherent — a token cannot precede a bill in
   * a lane whose definition is that the bill comes first — and a supervisor CAN set it through the
   * config editor. Folding it onto F3 is the safe read: they asked for bill-first, they get
   * bill-first. Throwing, or reading it as F1, would put a token on the board before the money.
   */
  it("the fourth, incoherent combination reads as bill-first and never as token-first", () => {
    expect(laneOf({ counterSequence: "bill_first", tokenLane: "token_first" })).toBe("F3");
  });
});

describe("the token's stamp — derived, never stored, and the lane decides when the slip leaves", () => {
  it("F1: the number is out at assignment, UNPAID, and the money flips the stamp", () => {
    expect(tokenStateOf("F1", { tokenNo: 7 }, false)).toEqual({ kind: "out", tokenNo: 7, paid: false });
    expect(tokenStateOf("F1", { tokenNo: 7 }, true)).toEqual({ kind: "out", tokenNo: 7, paid: true });
  });

  /**
   * F2 IS WHY THE LANE HAS TO BE AN ARGUMENT. The server joined the queue, so `tokenNo` is NOT
   * null — the position is taken and arrival order is respected — but the SLIP is held until the
   * bill settles. A "held" state inferred from a null token would print F2's slip early, which is
   * the one thing the lane exists to prevent.
   */
  it("F2: the position is taken and the slip is HELD until the money is in", () => {
    expect(tokenStateOf("F2", { tokenNo: 7 }, false)).toEqual({ kind: "held", position: 7 });
    expect(tokenStateOf("F2", { tokenNo: 7 }, true)).toEqual({ kind: "out", tokenNo: 7, paid: true });
  });

  it("F3: nothing is allocated at all until the money is in, and then it is PAID", () => {
    expect(tokenStateOf("F3", { tokenNo: null }, false)).toEqual({ kind: "held", position: null });
    expect(tokenStateOf("F3", { tokenNo: 12 }, true)).toEqual({ kind: "out", tokenNo: 12, paid: true });
  });

  it("no visit, no token", () => {
    expect(tokenStateOf("F1", null, true)).toEqual({ kind: "none" });
  });
});

describe("the deferred join — after the money and only then", () => {
  const visit = { encounterId: "e1", tokenNo: null, joining: false };

  it("F3 joins once the money is taken", () => {
    expect(shouldJoinNow("F3", visit, true)).toBe(true);
  });

  /** The whole point of the lane: an unpaid bill-first visit must never reach the board. */
  it("F3 does NOT join before the money", () => {
    expect(shouldJoinNow("F3", visit, false)).toBe(false);
  });

  it("F1 and F2 never join here — the walk-in already did it", () => {
    expect(shouldJoinNow("F1", visit, true)).toBe(false);
    expect(shouldJoinNow("F2", visit, true)).toBe(false);
  });

  it("never twice: a token already allocated, or a join in flight, is not re-fired", () => {
    expect(shouldJoinNow("F3", { ...visit, tokenNo: 4 }, true)).toBe(false);
    expect(shouldJoinNow("F3", { ...visit, joining: true }, true)).toBe(false);
    expect(shouldJoinNow("F3", null, true)).toBe(false);
  });
});

describe("the live bill — read off the server's draft, never re-added here", () => {
  const draftQuote = (over: Partial<WireFeeQuote> = {}): WireFeeQuote => ({
    encounterId: "e1", visitType: "new", free: false, feeServiceId: "svc-1",
    freeReason: null, attributionCode: null, intendedPayer: "self",
    draft: {
      tariffVersionId: "t1", intendedPayer: "self",
      lines: [{
        lineId: "fee", serviceId: "svc-1", serviceName: "OPD Consultation (New)", category: "consult",
        qty: 1, unitPaise: 30000, grossPaise: 30000, regulatedClamp: null,
        candidates: [], winner: null, discountPaise: 0, taxableBasePaise: 30000,
        gst: { sacCode: "9993", rateBps: 0, exempt: true, exemptReason: "healthcare", cgstPaise: 0, sgstPaise: 0 },
        netPaise: 30000,
      }],
      totals: {
        grossPaise: 30000, discountPaise: 0, taxableBasePaise: 30000, cgstPaise: 0, sgstPaise: 0,
        taxableTurnoverPaise: 0, exemptTurnoverPaise: 30000, taxSummary: [],
        rawTotalPaise: 30000, netPayablePaise: 30000, roundingPaise: 0,
      },
    },
    ...over,
  });

  it("with no visit yet it says so, and quotes nothing", () => {
    const bill = billOf(null);
    expect(bill.totalPaise).toBe(0);
    expect(bill.free).toBe(false);
    expect(bill.lines[0]?.label).toContain("priced on assignment");
  });

  it("a plain consult is one line at the engine's own net payable", () => {
    const bill = billOf(draftQuote());
    expect(bill.totalPaise).toBe(30000);
    expect(rs(bill.totalPaise)).toBe("₹300");
    expect(bill.lines.map((l) => l.label)).toEqual(["OPD Consultation (New)"]);
  });

  it("a discount the engine applied is shown as its own credit line, with the engine's own reason", () => {
    const q = draftQuote();
    q.draft!.lines[0]!.winner = {
      sourceKey: "membership", ruleKey: "m1", kind: "percent_bps", discountCategory: "scheme",
      amountPaise: 6000, reason: "ANNUAL+ membership · 20%", requiresApproval: false, rejected: null,
    };
    q.draft!.lines[0]!.discountPaise = 6000;
    q.draft!.totals.netPayablePaise = 24000;
    const bill = billOf(q);
    expect(bill.totalPaise).toBe(24000);
    expect(bill.lines.map((l) => [l.label, l.paise, l.credit])).toEqual([
      ["OPD Consultation (New)", 30000, false],
      ["ANNUAL+ membership · 20%", -6000, true],
    ]);
  });

  /**
   * ═══ FD-7's CRITICAL, GUARDED FROM THE OTHER SIDE — AND THE FIRST VERSION OF THIS TEST DID NOT ═══
   *
   * The lesson was: *"On money changes assert the AMOUNT, never the intermediate field."* The test
   * above looks like it does that and does not: its fixture has the lines summing to exactly
   * `netPayablePaise`, so a `billOf` that re-added the lines would answer 24000 and pass. A mutant
   * that replaced the engine's fold with `lines.reduce(...)` SURVIVED it, which is the whole reason
   * this second case exists.
   *
   * Here the two DISAGREE on purpose, and the shape is real: a value-counter package draws down
   * only what is left on it (FD-7 T6's case — a 15 000p wallet against a 30 000p consult), and the
   * engine's `netPayablePaise` is the authority on what that leaves to collect. Whatever the line
   * list shows, the amount is the server's. A client that re-adds gets a different number and the
   * counter quotes one figure while the invoice carries another.
   */
  it("the TOTAL is the engine's netPayable even when the rendered lines do not add up to it", () => {
    const q = draftQuote();
    q.draft!.lines[0]!.winner = {
      sourceKey: "package", ruleKey: "wallet", kind: "flat_paise", discountCategory: "scheme",
      amountPaise: 15000, reason: "Mother & Child wallet — balance drawn down", requiresApproval: false, rejected: null,
    };
    q.draft!.lines[0]!.discountPaise = 15000;
    // The lines read 30000 − 15000 = 15000; the ENGINE says 16000 is payable. The engine wins.
    q.draft!.totals.netPayablePaise = 16000;
    const bill = billOf(q);
    expect(bill.totalPaise).toBe(16000);
    expect(bill.lines.reduce((a, l) => a + l.paise, 0)).toBe(15000); // and the naive sum is NOT it
  });

  /**
   * The review branch is a NULL DRAFT, not a zero one — `feeServiceFor` returns null for a revisit,
   * so there is nothing to issue. The screen must read that as "free" and name the window, because
   * confirming ₹0 releases a token and a clerk has to be able to say why nothing was collected.
   */
  it("a review visit is free, names its window, and carries no charge", () => {
    const bill = billOf(draftQuote({
      free: true, draft: null, feeServiceId: null,
      freeReason: { kind: "review_window", doctorName: "Dr. Nishant Rao", seenOn: "2026-08-26", windowEndsOn: "2026-09-09" },
    }));
    expect(bill.free).toBe(true);
    expect(bill.totalPaise).toBe(0);
    expect(bill.lines[0]?.label).toContain("2026-09-09");
    expect(bill.lines[0]?.label).toContain("Dr. Nishant Rao");
  });
});

describe("the board — two queues per doctor, and they are never added together", () => {
  const departments = [{ id: "d-med", name: "General Medicine" }, { id: "d-ortho", name: "Orthopaedics" }];

  it("the doctor wait is the doctor's own queue; the vitals bay is its own figure", () => {
    const d = doc({ id: "a", departmentId: "d-med", waitingCount: 3, waitingVitalsCount: 5, avgConsultMinutes: 6 });
    expect(waitMinutes(d)).toBe(18);   // 3 × 6, matching `lib/walk-in-routing.ts`'s shipped rail
    expect(vitalsAhead(d)).toBe(5);
    expect(inHall(d)).toBe(8);
  });

  it("groups by department, ordering doctors by the shortest line", () => {
    const qs = deptQueues([
      doc({ id: "slow", departmentId: "d-med", waitingCount: 8 }),
      doc({ id: "quick", departmentId: "d-med", waitingCount: 1 }),
      doc({ id: "ortho", departmentId: "d-ortho", waitingCount: 4 }),
    ], departments);
    expect(qs.map((q) => q.departmentName)).toEqual(["General Medicine", "Orthopaedics"]);
    expect(qs[0]?.doctors.map((x) => x.doctor.id)).toEqual(["quick", "slow"]);
    expect(qs[0]?.poolWaitMinutes).toBe(6);
    expect(shortestLine(qs)?.departmentName).toBe("General Medicine");
  });

  /**
   * A department with nobody on today's board is still LISTED — the clerk asked for it by name and
   * "not scheduled today" is a sentence they can say — but it must never be the agent's pick and
   * `firstFreeDoctor` must refuse it rather than seat a patient with an absent doctor.
   */
  it("a department whose doctors are all away is listed, never picked, and seats nobody", () => {
    const qs = deptQueues([
      doc({ id: "away", departmentId: "d-med", scheduledToday: false, onLeaveToday: true }),
      doc({ id: "here", departmentId: "d-ortho", waitingCount: 9 }),
    ], departments);
    const med = qs.find((q) => q.departmentId === "d-med")!;
    expect(med.doctors).toHaveLength(1);
    expect(bookableToday(med.doctors[0]!)).toBe(false);
    expect(Number.isFinite(med.poolWaitMinutes)).toBe(false);
    expect(firstFreeDoctor(med)).toBeNull();
    expect(shortestLine(qs)?.departmentId).toBe("d-ortho");
  });

  it("an inactive doctor is off the board entirely", () => {
    const inactive = doc({ id: "gone", departmentId: "d-med" });
    inactive.doctor.active = false;
    expect(deptQueues([inactive], departments)).toEqual([]);
  });
});

describe("small truths a counter shows a hundred times a day", () => {
  /**
   * MEASURED against the running server: `GET /patients/search` returns the `date` column as a full
   * ISO TIMESTAMP, not the `YYYY-MM-DD` the OPD wire convention describes. Appending `T00:00:00Z`
   * to that gives `Invalid Date`, and every search row rendered an em dash where its age should be.
   */
  it("age parses both the calendar date and the full timestamp the search route actually sends", () => {
    const born = new Date();
    born.setUTCFullYear(born.getUTCFullYear() - 34);
    const iso = born.toISOString();
    expect(ageOf(iso.slice(0, 10))).toBe("34");
    expect(ageOf(iso)).toBe("34");
  });

  it("an unknown date of birth is BLANK, never a dash beside the sex letter", () => {
    expect(ageOf(null)).toBe("");
    expect(ageOf("")).toBe("");
    expect(ageOf("not-a-date")).toBe("");
  });

  it("money is grouped the Indian way and whole rupees carry no paise", () => {
    expect(rs(372000)).toBe("₹3,720");
    expect(rs(0)).toBe("₹0");
    expect(rs(12345)).toBe("₹123.45");
    expect(rs(10000000)).toBe("₹1,00,000");
  });

  it("the stage breadcrumb ticks forward and ends complete", () => {
    expect(stepIndex("find")).toBe(0);
    expect(stepIndex("register")).toBe(0);
    expect(stepIndex("appointment")).toBe(1);
    expect(stepIndex("bill")).toBe(2);
    expect(stepIndex("done")).toBe(3);
  });
});
