import { IST_UTC_OFFSET_MINUTES } from "../../kernel/approvals/cumulative";
import { PASS_KINDS, PASS_SCAN_RESULTS, PASS_STATES } from "@hmis/contracts";
import { PASS_KIND_VALUES, PASS_SCAN_RESULT_VALUES, PASS_STATE_VALUES } from "../../kernel/db/schema";
import { ENTITLEMENT_KINDS, TIMED_PASS_KINDS, entitlementFor, inVisitingHours, istMinuteOfDay, scanResult } from "./policy";
import type { ScanFacts } from "./policy";

/** E1.3 (#720) — the pure pass rules. Instants are built from IST clock times on an arbitrary day; nothing reads a clock. */
const at = (h: number, m = 0): Date => new Date(Date.UTC(2030, 0, 15, h, m) - IST_UTC_OFFSET_MINUTES * 60_000);

describe("passes policy", () => {
  it("the schema's literal lists equal the contract's", () => {
    expect([...PASS_KIND_VALUES]).toEqual([...PASS_KINDS]);
    expect([...PASS_STATE_VALUES]).toEqual([...PASS_STATES]);
    expect([...PASS_SCAN_RESULT_VALUES]).toEqual([...PASS_SCAN_RESULTS]);
  });

  it.each([
    ["general", 40, "attendant", 1], ["semi_private", 40, "attendant", 1], ["private", 40, "attendant", 2],
    ["deluxe", 40, "attendant", 2], ["suite", 40, "attendant", 2], ["ldr", 28, "attendant", 1], ["overflow", 40, "attendant", 1],
    ["hdu", 40, "lounge", 1], ["icu", 40, "lounge", 1], ["nicu", 0, "lounge", 1], ["picu", 6, "lounge", 1],
    ["general", 8, "parent_stay", 1], ["private", 8, "parent_stay", 2],
  ] as const)("%s bed, age %d: %s × %d", (bedClass, ageYears, kind, max) => {
    expect(entitlementFor({ bedClass, ageYears, policeCustody: false })).toMatchObject({ kind, max });
  });

  it("no entitlement kind is timed: the entitlement count may ignore valid_to (DECIDED, review of #755)", () => {
    expect(ENTITLEMENT_KINDS.filter((k) => TIMED_PASS_KINDS.includes(k))).toEqual([]);
    expect(TIMED_PASS_KINDS).toEqual(["visitor"]);
  });

  it("police custody overrides the class: two police guard passes", () => {
    expect(entitlementFor({ bedClass: "private", ageYears: 30, policeCustody: true })).toMatchObject({ kind: "police_guard", max: 2 });
  });

  it("visiting hours are 16:00 to 19:00 IST, end exclusive", () => {
    expect(istMinuteOfDay(at(16, 0))).toBe(960);
    expect([at(15, 59), at(16, 0), at(18, 59), at(19, 0)].map(inVisitingHours)).toEqual([false, true, true, false]);
  });

  it("a scan gives the strongest no first: revoked, expired, paused, wrong ward, outside hours", () => {
    const base: ScanFacts = { state: "active", kind: "visitor", validTo: at(23, 59), wardId: "W1", admissionEnded: false };
    expect(scanResult({ ...base, state: "revoked" }, at(20), "W2")).toBe("revoked");
    expect(scanResult({ ...base, admissionEnded: true }, at(17), "W1")).toBe("expired");
    expect(scanResult(base, at(23, 59), "W1")).toBe("expired");
    expect(scanResult({ ...base, state: "paused" }, at(20), "W2")).toBe("paused");
    expect(scanResult(base, at(20), "W2")).toBe("wrong_ward");
    expect(scanResult(base, at(20), "W1")).toBe("outside_hours");
    expect(scanResult(base, at(17), undefined)).toBe("valid");
    expect(scanResult({ ...base, kind: "attendant", validTo: null }, at(3), "W1")).toBe("valid");
  });
});
