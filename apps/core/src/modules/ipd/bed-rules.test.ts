import { ageInYears, checkBedRules, placementGender } from "./bed-rules";
import type { IpdBedAttributes } from "./bed-attributes";
import type { BedRuleContext, BedRulePatient } from "./bed-rules";
import type { IpdBedNeed } from "@hmis/contracts";

const BED: IpdBedAttributes = {
  class: "general", genderRule: "any", isolation: "none", negativePressure: false, icu: false, equipment: [], daycare: false, overflow: false,
};
const NEED: IpdBedNeed = { requestedClass: "general", isolation: "none", icu: false };
const ADULT_F: BedRulePatient = { gender: "female", ageYears: 40 };
const CTX: BedRuleContext = { roomGender: null, mayUseOverflow: false };
const check = (bed: Partial<IpdBedAttributes>, need: Partial<IpdBedNeed> = {}, p: BedRulePatient = ADULT_F, ctx: BedRuleContext = CTX, change?: "upgrade" | "downgrade") =>
  checkBedRules({ code: "B1", attributes: { ...BED, ...bed } }, p, { ...NEED, ...need }, change, ctx);

describe("bed rules (E1.1, spec §4.1)", () => {
  it("a plain general bed takes an adult who asked for general", () => {
    expect(check({})).toBeNull();
  });
  it("class: a different ward class needs the flag in the right direction; ICU-type classes never swap", () => {
    expect(check({ class: "private" })).toEqual({ code: "bed_class_mismatch", bedRule: "Private room bed" });
    expect(check({ class: "private" }, {}, ADULT_F, CTX, "upgrade")).toBeNull();
    expect(check({ class: "private" }, {}, ADULT_F, CTX, "downgrade")?.code).toBe("bed_class_mismatch");
    expect(check({ class: "general" }, { requestedClass: "private" }, ADULT_F, CTX, "downgrade")).toBeNull();
    expect(check({ class: "hdu" }, {}, ADULT_F, CTX, "upgrade")?.code).toBe("bed_class_mismatch");
  });
  it("gender: bed rules and the twin-share room's fixed gender; other/unknown places by stated preference", () => {
    expect(check({ genderRule: "male" })).toEqual({ code: "bed_gender_mismatch", bedRule: "Male-only bed" });
    expect(check({}, {}, ADULT_F, { roomGender: "male", mayUseOverflow: false })).toEqual({ code: "bed_gender_mismatch", bedRule: "Shared room is male" });
    const other = { gender: "other" as const, ageYears: 30 };
    expect(check({ genderRule: "female" }, {}, other)?.code).toBe("bed_gender_mismatch");
    expect(check({ genderRule: "female" }, { placeAs: "female" }, other)).toBeNull();
    expect(placementGender(other, NEED)).toBeNull();
  });
  it("age: paediatric beds refuse adults; adult ICU and segregated adult ward beds refuse children; unknown age passes", () => {
    const child = { gender: "male" as const, ageYears: 6 };
    expect(check({ genderRule: "paediatric" })?.bedRule).toBe("Paediatric bed");
    expect(check({ class: "icu", icu: true }, { requestedClass: "icu", icu: true }, child)?.bedRule).toBe("Adult ICU bed");
    expect(check({ genderRule: "male" }, {}, child)?.bedRule).toBe("Adult ward bed");
    expect(check({ class: "private" }, { requestedClass: "private" }, child)).toBeNull();
    expect(check({ genderRule: "paediatric" }, {}, { gender: "female", ageYears: null })).toBeNull();
  });
  it("isolation: the bed must support at least the need; airborne needs negative pressure", () => {
    expect(check({}, { isolation: "contact" })).toEqual({ code: "bed_isolation_mismatch", bedRule: "No isolation" });
    expect(check({ isolation: "droplet" }, { isolation: "contact" })).toBeNull();
    expect(check({ isolation: "airborne", negativePressure: true }, { isolation: "airborne" })).toBeNull();
  });
  it("ICU flag both ways, and overflow needs the duty manager before anything else", () => {
    expect(check({ icu: true })?.bedRule).toBe("ICU bed");
    expect(check({}, { icu: true })?.bedRule).toBe("Not an ICU bed");
    expect(check({ class: "overflow", overflow: true, genderRule: "male" })).toEqual({ code: "overflow_needs_duty_manager", bedRule: "Overflow bed" });
    expect(check({ class: "overflow", overflow: true }, {}, ADULT_F, { roomGender: null, mayUseOverflow: true })).toBeNull();
  });
  it("ageInYears counts birthdays, not calendar years", () => {
    expect(ageInYears("2012-06-15", new Date("2026-06-14T12:00:00Z"))).toBe(13);
    expect(ageInYears("2012-06-15", new Date("2026-06-15T12:00:00Z"))).toBe(14);
    expect(ageInYears(null, new Date("2026-06-15T12:00:00Z"))).toBeNull();
  });
});
