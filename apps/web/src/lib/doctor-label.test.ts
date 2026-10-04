import { describe, expect, it } from "vitest";
import { besideName, shortDesignation } from "./doctor-label";

describe("doctor label (2026-10-04)", () => {
  it("shortens a designation and leaves Guest Faculty as the owner writes it", () => {
    expect(shortDesignation("Guest Faculty")).toBe("Guest Faculty");
    expect(shortDesignation("Assistant Professor & Deputy Superintendent")).toBe("Asst. Prof. & Dy. Supdt.");
    expect(shortDesignation("Senior Resident")).toBe("Sr. Resident");
    expect(shortDesignation("  ")).toBeNull();
    expect(shortDesignation(undefined)).toBeNull();
  });
  it("puts the unit first, then the designation; nothing at all for neither", () => {
    expect(besideName({ unit: "Unit I", designation: "Assistant Professor" })).toBe("Unit I · Asst. Prof.");
    expect(besideName({ designation: "Guest Faculty" })).toBe("Guest Faculty");
    expect(besideName({ unit: "Unit I" })).toBe("Unit I");
    expect(besideName({})).toBeNull();
  });
});
