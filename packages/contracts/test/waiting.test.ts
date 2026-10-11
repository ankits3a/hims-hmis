import { WAITING_KINDS, appTargetOf, waitingAge, waitingLines } from "../src/waiting";
import { WAITING_EXPECTED, WAITING_FIXTURE } from "../src/waiting-fixture";

describe("waiting — the one list both clients draw (E1.4, E1.5)", () => {
  it("sorts by the fixed kind order and drops zero counts and unknown kinds", () => {
    expect(waitingLines(WAITING_FIXTURE).map((l) => [l.kind, l.count])).toEqual(WAITING_EXPECTED);
  });

  it("an absent or malformed answer is an empty list, not a crash", () => {
    expect(waitingLines(null)).toEqual([]);
    expect(waitingLines({ items: "x" } as never)).toEqual([]);
  });

  it("every kind has a phone target; only the bell, reminders and duties leave the Open loops screen", () => {
    const outward = WAITING_KINDS.filter((k) => appTargetOf(k).type !== "loops");
    expect(outward).toEqual(["alerts.unanswered", "reminders.today", "roster.dutiesToday"]);
  });

  it("ages read short", () => {
    const now = Date.parse("2026-10-11T00:00:00.000Z");
    expect(waitingAge("2026-10-10T23:48:00.000Z", now)).toBe("12 m");
    expect(waitingAge("2026-10-10T21:00:00.000Z", now)).toBe("3 h");
    expect(waitingAge("2026-10-08T00:00:00.000Z", now)).toBe("3 d");
    expect(waitingAge(null, now)).toBeNull();
  });
});
