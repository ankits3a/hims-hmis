import { seatsFor } from "../src/seats";

const none = { hospital: [], scoped: { department: {}, floor: {} } };

describe("seatsFor", () => {
  it("offers nothing to an account with no phone permissions", () => {
    expect(seatsFor(none)).toEqual([]);
  });
  it("offers the vitals bay and the roster to a vitals nurse", () => {
    const keys = seatsFor({ ...none, hospital: ["opd.vitals.record", "roster.read"] }).map((s) => s.key);
    expect(keys).toEqual(["vitals", "onNow", "myDuties"]);
  });
  it("counts a department-scoped grant", () => {
    const keys = seatsFor({ hospital: [], scoped: { department: { d1: ["opd.consult"] }, floor: {} } }).map((s) => s.key);
    expect(keys).toEqual(["consult"]);
  });
});
