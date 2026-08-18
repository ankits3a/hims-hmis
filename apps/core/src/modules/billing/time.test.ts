import { fyOf, istDay } from "./time";

describe("billing FY / IST day (pure, fixed +05:30, no DST)", () => {
  it("Mar 31 23:59:59 IST is still FY 2025-26", () => {
    // 2026-03-31T18:29:59Z is IST Mar 31 23:59:59 — the last instant of the old fiscal year.
    expect(fyOf(new Date("2026-03-31T18:29:59.000Z")).fy).toBe("2025-26");
  });

  it("Apr 1 00:00 IST opens FY 2026-27 — the boundary is IST midnight, not UTC midnight", () => {
    // 2026-03-31T18:30:00Z is IST Apr 1 00:00:00, still Mar 31 by the UTC calendar.
    expect(fyOf(new Date("2026-03-31T18:30:00.000Z")).fy).toBe("2026-27");
  });

  it("fyShort is the two-digit pair the 16-char GST serial needs", () => {
    expect(fyOf(new Date("2026-03-31T18:30:00.000Z")).fyShort).toBe("26-27");
    expect(fyOf(new Date("2026-03-31T18:29:59.000Z")).fyShort).toBe("25-26");
    expect(`INV/${fyOf(new Date("2026-03-31T18:30:00.000Z")).fyShort}/000001`).toHaveLength(16);
  });

  it("istDay flips at 18:30 UTC", () => {
    expect(istDay(new Date("2026-08-31T18:30:00.000Z"))).toBe("2026-09-01");
    expect(istDay(new Date("2026-08-31T18:29:59.000Z"))).toBe("2026-08-31");
  });
});
