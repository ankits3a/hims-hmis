import { DELAY_HIGHLIGHT_MINUTES, proposeWalkIn } from "./walk-in-routing";
import type { WireContinuityAnchor } from "./walk-in-routing";
import type { WireDoctorSummary } from "./opd-api";

/**
 * ═══ FD-7 T2 — THE ORDER OF THE THREE RULES IS THE THING UNDER TEST ═══
 *
 * Every one of these can be killed by a single-line change to `proposeWalkIn`, which is why the
 * rules live in a pure function at all: an ordering expressed in JSX can only be asserted through a
 * rendered screen, and RC-3's lesson is that a component proves nothing about the screen that mounts
 * it. Here the ordering is asserted directly, and the seat's own test then proves the screen renders
 * what this returns.
 */
const GM = "dept-gm";

function doc(over: {
  id: string; name?: string; departmentId?: string; waitingCount?: number; avgConsultMinutes?: number;
  scheduledToday?: boolean; active?: boolean; onLeaveToday?: boolean;
}): WireDoctorSummary {
  return {
    doctor: {
      id: over.id, userId: `u-${over.id}`, displayName: over.name ?? `Dr ${over.id}`, registrationNo: null,
      departmentId: over.departmentId ?? GM, specialty: null, active: over.active ?? true,
      createdBy: "s", createdAt: "", updatedBy: "s", updatedAt: "",
    },
    sessionId: "s-1", status: "in", waitingCount: over.waitingCount ?? 1, waitingVitalsCount: 0,
    nowServing: 1, scheduledToday: over.scheduledToday ?? true, roomCode: "12",
    avgConsultMinutes: over.avgConsultMinutes ?? 10, onLeaveToday: over.onLeaveToday ?? false,
  };
}

/*
  FD-17 widened the anchor with the visit-type projection. `proposeWalkIn` does not read any of the
  three — routing is about WHO and WHEN, not about what the visit will be charged as — so they are
  filled in once here and never asserted on. `satisfies` keeps them honest against the wire type.
*/
const ANCHOR = {
  doctorId: "d-long", doctorName: "Dr Long", seenOn: "2026-07-12",
  followUpDays: 7, windowEndsOn: "2026-07-19", wouldBe: "revisit",
} satisfies WireContinuityAnchor;
const ANCHOR_LONG = ANCHOR;

describe("walk-in routing (FD-7 T2)", () => {
  /** RULE 1, and the hard part of it: the familiar doctor wins even though his line is LONGER. */
  it("continuity beats the shorter line", () => {
    const p = proposeWalkIn(GM, [
      doc({ id: "d-long", waitingCount: 6 }),   // 60 minutes
      doc({ id: "d-quick", waitingCount: 1 }),  // 10 minutes
    ], ANCHOR);
    expect(p.rule).toBe("continuity");
    expect(p.doctor!.doctor.id).toBe("d-long");
    expect(p.waitMinutes).toBe(60);
    expect(p.anchor).toEqual(ANCHOR);
  });

  /** RULE 2 — only when nobody here has seen them. */
  it("with no anchor it takes the shortest line", () => {
    const p = proposeWalkIn(GM, [
      doc({ id: "d-long", waitingCount: 6 }),
      doc({ id: "d-quick", waitingCount: 1 }),
    ], null);
    expect(p.rule).toBe("shortest_wait");
    expect(p.doctor!.doctor.id).toBe("d-quick");
    expect(p.waitMinutes).toBe(10);
  });

  /** RULE 3 — it names NOBODY rather than inventing a doctor from another department. */
  it("with nobody sitting in this department it proposes the department queue", () => {
    const p = proposeWalkIn(GM, [doc({ id: "d-ortho", departmentId: "dept-ortho", waitingCount: 1 })], null);
    expect(p.rule).toBe("department_queue");
    expect(p.doctor).toBeNull();
    expect(p.waitMinutes).toBeNull();
  });

  /**
   * "A doctor on leave or fully booked drops out to rule 2" — DECIDED in the phase doc, and it needs
   * no leave lookup: `scheduledToday` is the board's own answer to "is this doctor sitting today".
   */
  it("an anchor doctor who is not on today's board drops out to the shortest line, and says so", () => {
    const p = proposeWalkIn(GM, [
      doc({ id: "d-long", waitingCount: 6, scheduledToday: false }),
      doc({ id: "d-quick", waitingCount: 1 }),
    ], ANCHOR);
    expect(p.rule).toBe("shortest_wait");
    expect(p.doctor!.doctor.id).toBe("d-quick");
    expect(p.anchorUnavailable).toBe(true);
    expect(p.anchor).toEqual(ANCHOR);      // still carried — the card can say WHY it moved on
  });

  /**
   * ═══ FD-7 T8 / OWNER RULING 2026-09-03 — THE EDGE CASE, AND WHY IT IS THE DANGEROUS ONE ═══
   *
   *   > "the system would automatically assign the patient to the doctor which has least waiting
   *   >  time (with some edge case exception like, what will happen if the doctor goes on leave in
   *   >  between his duty)"
   *
   * A doctor on leave has an empty queue, and **an empty queue is the shortest queue**. So under the
   * auto-assign rule the absent doctor wins every comparison — the router would send every arriving
   * patient to the one person guaranteed not to see them. The guard is server-side (`summaryByDoctor`
   * now reads `opd_doctor_leaves`, which it never did before T8) and it arrives here as
   * `scheduledToday: false`; this row is what stops the filter being dropped from this end.
   */
  it("a doctor on leave is never auto-assigned, even with the emptiest queue in the department", () => {
    const p = proposeWalkIn(GM, [
      doc({ id: "d-away", waitingCount: 0, scheduledToday: false, onLeaveToday: true }), // 0 minutes!
      doc({ id: "d-here", waitingCount: 4 }),                                            // 40 minutes
    ], null);
    expect(p.rule).toBe("shortest_wait");
    expect(p.doctor!.doctor.id).toBe("d-here");   // THE KILL
    expect(p.waitMinutes).toBe(40);
  });

  it("and is never named as the quicker ALTERNATIVE either", () => {
    const p = proposeWalkIn(GM, [
      doc({ id: "d-away", waitingCount: 0, scheduledToday: false, onLeaveToday: true }),
      doc({ id: "d-long", waitingCount: 6 }),
    ], ANCHOR_LONG);
    expect(p.delayed).toBe(true);                 // 60 minutes, over the threshold
    expect(p.alternative).toBeNull();             // THE KILL — the empty queue must not be offered
  });

  /** The clerk has to say the true thing out loud to a patient who asked for that doctor by name. */
  it("an anchor doctor on leave is reported AS on leave, not merely as unavailable", () => {
    const p = proposeWalkIn(GM, [
      doc({ id: "d-long", waitingCount: 0, scheduledToday: false, onLeaveToday: true }),
      doc({ id: "d-quick", waitingCount: 1 }),
    ], ANCHOR_LONG);
    expect({ unavailable: p.anchorUnavailable, onLeave: p.anchorOnLeave })
      .toEqual({ unavailable: true, onLeave: true });
  });

  it("an anchor doctor merely off the roster is unavailable but NOT on leave", () => {
    const p = proposeWalkIn(GM, [
      doc({ id: "d-long", waitingCount: 0, scheduledToday: false, onLeaveToday: false }),
      doc({ id: "d-quick", waitingCount: 1 }),
    ], ANCHOR_LONG);
    expect({ unavailable: p.anchorUnavailable, onLeave: p.anchorOnLeave })
      .toEqual({ unavailable: true, onLeave: false });
  });

  it("an inactive doctor is not a candidate", () => {
    const p = proposeWalkIn(GM, [doc({ id: "d-off", active: false, waitingCount: 0 })], null);
    expect(p.rule).toBe("department_queue");
  });

  /* ── the owner's 20-minute rule ─────────────────────────────────────────────────────────── */

  it(`a wait over ${String(DELAY_HIGHLIGHT_MINUTES)} minutes is flagged, and a quicker doctor is NAMED`, () => {
    const p = proposeWalkIn(GM, [
      doc({ id: "d-long", waitingCount: 6 }),   // 60
      doc({ id: "d-quick", waitingCount: 1 }),  // 10
    ], ANCHOR);
    expect(p.delayed).toBe(true);
    expect(p.alternative!.doctor.id).toBe("d-quick");
    expect(p.alternativeWaitMinutes).toBe(10);
    // AND IT DOES NOT RE-ROUTE: the proposal is still the doctor who knows them.
    expect(p.doctor!.doctor.id).toBe("d-long");
    expect(p.rule).toBe("continuity");
  });

  it("exactly 20 minutes is not a delay — the rule is 'exceeds'", () => {
    const p = proposeWalkIn(GM, [doc({ id: "d-1", waitingCount: 2, avgConsultMinutes: 10 })], null);
    expect(p.waitMinutes).toBe(DELAY_HIGHLIGHT_MINUTES);
    expect(p.delayed).toBe(false);
    expect(p.alternative).toBeNull();
  });

  it("21 minutes is", () => {
    const p = proposeWalkIn(GM, [doc({ id: "d-1", waitingCount: 3, avgConsultMinutes: 7 })], null);
    expect(p.waitMinutes).toBe(21);
    expect(p.delayed).toBe(true);
  });

  /** The delay is still shown when there is nobody quicker — a highlight with no alternative. */
  it("a long wait with nobody quicker is flagged and names no alternative", () => {
    const p = proposeWalkIn(GM, [doc({ id: "d-only", waitingCount: 6 })], null);
    expect(p.delayed).toBe(true);
    expect(p.alternative).toBeNull();
    expect(p.alternativeWaitMinutes).toBeNull();
  });

  /** The proposal must never offer ITSELF as the quicker option. */
  it("the shortest-wait proposal never names itself as the alternative", () => {
    const p = proposeWalkIn(GM, [
      doc({ id: "d-a", waitingCount: 6 }),
      doc({ id: "d-b", waitingCount: 9 }),
    ], null);
    expect(p.doctor!.doctor.id).toBe("d-a");
    expect(p.delayed).toBe(true);
    expect(p.alternative).toBeNull();
  });

  /** Two identical queues must propose the SAME doctor on every render, or the card moves under the clerk. */
  it("a tie is broken by name, stably", () => {
    const a = doc({ id: "d-2", name: "Dr Bose", waitingCount: 2, avgConsultMinutes: 5 });
    const b = doc({ id: "d-1", name: "Dr Ali", waitingCount: 2, avgConsultMinutes: 5 });
    expect(proposeWalkIn(GM, [a, b], null).doctor!.doctor.displayName).toBe("Dr Ali");
    expect(proposeWalkIn(GM, [b, a], null).doctor!.doctor.displayName).toBe("Dr Ali");
  });

  it("proposing does not mutate the summaries it was handed", () => {
    const list = [doc({ id: "d-b", waitingCount: 9 }), doc({ id: "d-a", waitingCount: 1 })];
    proposeWalkIn(GM, list, null);
    expect(list.map((s) => s.doctor.id)).toEqual(["d-b", "d-a"]);
  });
});
