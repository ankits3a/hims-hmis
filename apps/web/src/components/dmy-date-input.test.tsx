import { dmyToIso, isoToDmy } from "./dmy-date-input";

/* UX-AUDIT 2026-09-29 · BOARD — Indian order in, the ISO calendar day out, and only for a real day. */
describe("DD-MM-YYYY date text", () => {
  it("reads a calendar date in Indian order", () => {
    expect(isoToDmy("1955-03-12")).toBe("12-03-1955");
    expect(isoToDmy("1955-03-12T00:00:00.000Z")).toBe("12-03-1955");
  });
  it("takes DD-MM-YYYY with -, / or . and pads single digits", () => {
    expect(dmyToIso("12-03-1955")).toBe("1955-03-12");
    expect(dmyToIso("2/3/1955")).toBe("1955-03-02");
    expect(dmyToIso("02.03.1955")).toBe("1955-03-02");
  });
  it("refuses what is not a real day, and US order where the month would be 13+", () => {
    expect(dmyToIso("31-02-2026")).toBeNull();
    expect(dmyToIso("03-13-2026")).toBeNull();
    expect(dmyToIso("1955-03-12")).toBeNull();
    expect(dmyToIso("12-03-55")).toBeNull();
  });
});
