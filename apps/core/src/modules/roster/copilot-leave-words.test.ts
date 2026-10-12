import { leaveDaysOf, leaveKindOf } from "./copilot-leave-words";
import { matchIntent } from "../../kernel/copilot/phrasebook";

/** E2.2 — the kind and the days of a leave, read from the words by rules. `today` is passed in; no clock. */
describe("leave words (E2.2)", () => {
  const TODAY = "2026-10-20"; // a Tuesday

  it("reads the kind, and none when none is said", () => {
    expect(leaveKindOf("kal CL chahiye")).toBe("CL");
    expect(leaveKindOf("20 oct earned leave")).toBe("EL");
    expect(leaveKindOf("bimar hoon, kal ki chhutti")).toBe("ML");
    expect(leaveKindOf("comp off chahiye shaniwar")).toBe("comp_off");
    expect(leaveKindOf("clinic mein kal chhutti")).toBeNull();
  });

  it("reads one day, a range, a day and a count", () => {
    expect(leaveDaysOf("kal CL chahiye", TODAY)).toEqual({ from: "2026-10-21", to: "2026-10-21" });
    expect(leaveDaysOf("parso se 3 din ki chhutti", TODAY)).toEqual({ from: "2026-10-22", to: "2026-10-24" });
    expect(leaveDaysOf("20 se 22 nov EL", TODAY)).toEqual({ from: "2026-11-20", to: "2026-11-22" });
    expect(leaveDaysOf("20-22 nov leave", TODAY)).toEqual({ from: "2026-11-20", to: "2026-11-22" });
    expect(leaveDaysOf("25/10 to 27/10 CL", TODAY)).toEqual({ from: "2026-10-25", to: "2026-10-27" });
    expect(leaveDaysOf("Monday ko chhutti", TODAY)).toEqual({ from: "2026-10-26", to: "2026-10-26" });
    expect(leaveDaysOf("kal se parso tak leave", TODAY)).toEqual({ from: "2026-10-21", to: "2026-10-22" });
    expect(leaveDaysOf("28 dec se 2 jan leave", TODAY)).toEqual({ from: "2026-12-28", to: "2027-01-02" });
  });

  it("names no day for a bare number or nothing at all", () => {
    expect(leaveDaysOf("leave chahiye", TODAY)).toBeNull();
    expect(leaveDaysOf("2 CL chahiye", TODAY)).toBeNull();
  });

  it("the phrasebook routes asking for leave and asking about it apart, and leaves somebody else's leave alone", () => {
    expect(matchIntent("kal CL chahiye")?.intent).toBe("roster.leave_apply");
    expect(matchIntent("20 se 22 nov chhutti chahiye")?.intent).toBe("roster.leave_apply");
    expect(matchIntent("family function hai, kal leave chahiye")?.intent).toBe("roster.leave_apply");
    expect(matchIntent("meri leave ka kya hua")?.intent).toBe("roster.leave_status");
    expect(matchIntent("meri chhutti mili kya")?.intent).toBe("roster.leave_status");
    expect(matchIntent("Dr Sharma aaj leave par hain kya")?.intent).not.toBe("roster.leave_apply");
    expect(matchIntent("Dr Sharma aaj leave par hain kya")?.intent).not.toBe("roster.leave_status");
    expect(matchIntent("Saturday night koi le sakta hai kya?")?.intent).toBe("roster.ask_cover");
  });
});
