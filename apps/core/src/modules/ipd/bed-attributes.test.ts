import { IpdBedAttributesSchema, IpdWardAttributesSchema, canonicalEquipment } from "./index";

const OK = {
  class: "icu", genderRule: "any", isolation: "none", negativePressure: false, icu: true,
  equipment: ["monitor", "ventilator_ready"], daycare: false, overflow: false,
} as const;

function messages(input: unknown): string[] {
  const r = IpdBedAttributesSchema.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => i.message);
}

describe("IpdBedAttributesSchema", () => {
  it("accepts a well-formed bed", () => {
    expect(IpdBedAttributesSchema.parse(OK)).toEqual(OK);
  });

  it("refuses a class outside the contracts list, and a missing class", () => {
    expect(IpdBedAttributesSchema.safeParse({ ...OK, class: "platinum" }).success).toBe(false);
    const { class: _omit, ...noClass } = OK;
    expect(IpdBedAttributesSchema.safeParse(noClass).success).toBe(false);
  });

  it("refuses an unknown gender rule, isolation type or equipment tag", () => {
    expect(IpdBedAttributesSchema.safeParse({ ...OK, genderRule: "mixed" }).success).toBe(false);
    expect(IpdBedAttributesSchema.safeParse({ ...OK, isolation: "reverse" }).success).toBe(false);
    expect(IpdBedAttributesSchema.safeParse({ ...OK, equipment: ["defibrillator"] }).success).toBe(false);
  });

  it("airborne isolation requires negative pressure", () => {
    expect(messages({ ...OK, isolation: "airborne", negativePressure: false }))
      .toEqual(["airborne_needs_negative_pressure: airborne isolation needs a negative-pressure room"]);
    expect(messages({ ...OK, isolation: "airborne", negativePressure: true })).toEqual([]);
    // Negative pressure without airborne isolation is a room capability, not a contradiction.
    expect(messages({ ...OK, isolation: "contact", negativePressure: true })).toEqual([]);
  });

  it("class overflow and the overflow flag agree, both ways", () => {
    expect(messages({ ...OK, class: "overflow", icu: false, overflow: false })[0]).toMatch(/^overflow_mismatch:/);
    expect(messages({ ...OK, class: "general", overflow: true })[0]).toMatch(/^overflow_mismatch:/);
    expect(messages({ ...OK, class: "overflow", overflow: true })).toEqual([]);
  });

  it("class daycare and the daycare flag agree, both ways", () => {
    expect(messages({ ...OK, class: "daycare", daycare: false })[0]).toMatch(/^daycare_mismatch:/);
    expect(messages({ ...OK, class: "general", daycare: true })[0]).toMatch(/^daycare_mismatch:/);
    expect(messages({ ...OK, class: "daycare", daycare: true })).toEqual([]);
  });

  it("refuses an equipment tag listed twice; canonicalEquipment fixes the order", () => {
    expect(messages({ ...OK, equipment: ["monitor", "monitor"] })[0]).toMatch(/^duplicate_equipment:/);
    expect(canonicalEquipment(["suction", "monitor"])).toEqual(["monitor", "suction"]);
  });
});

describe("IpdWardAttributesSchema", () => {
  it("accepts a department code, a unit type and a ward type", () => {
    expect(IpdWardAttributesSchema.parse({ department: "MED", unitType: "MICU", wardType: "ward" }))
      .toEqual({ department: "MED", unitType: "MICU", wardType: "ward" });
  });

  it("refuses an unknown unit type, a ward type other than ward or hall, and a lowercase department", () => {
    expect(IpdWardAttributesSchema.safeParse({ department: "MED", unitType: "SPA", wardType: "ward" }).success).toBe(false);
    expect(IpdWardAttributesSchema.safeParse({ department: "MED", unitType: "WARD", wardType: "room" }).success).toBe(false);
    expect(IpdWardAttributesSchema.safeParse({ department: "med", unitType: "WARD", wardType: "hall" }).success).toBe(false);
  });
});
