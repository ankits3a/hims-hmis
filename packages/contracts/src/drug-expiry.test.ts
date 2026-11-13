import { expiryFromLabel, monthEndOf, sameExpiryMonth } from "./drug-expiry";

describe("a medicine's expiry is a month", () => {
  it("reads the label's MM/YY or MM/YYYY as the last day of that month", () => {
    expect(expiryFromLabel("08/2027")).toBe("2027-08-31");
    expect(expiryFromLabel("6/28")).toBe("2028-06-30");
    expect(expiryFromLabel(" 02 - 28 ")).toBe("2028-02-29");
    expect(expiryFromLabel("02/27")).toBe("2027-02-28");
    for (const bad of ["13/2027", "00/27", "2027-08-31", "08/2", "", "aug 27"]) expect(expiryFromLabel(bad)).toBeNull();
  });

  it("turns any day of a month into that month's last day, and refuses what is not a date", () => {
    expect(monthEndOf("2028-02-10")).toBe("2028-02-29");
    expect(monthEndOf("2027-12-31")).toBe("2027-12-31");
    expect(monthEndOf("2027-04-01")).toBe("2027-04-30");
    for (const bad of ["2027-13-01", "2027-4-01", "04/27", ""]) expect(monthEndOf(bad)).toBeNull();
  });

  it("two expiries are the same when they fall in the same year and month", () => {
    expect(sameExpiryMonth("2028-06-15", "2028-06-30")).toBe(true);
    expect(sameExpiryMonth("2028-06-30", "2028-07-01")).toBe(false);
    expect(sameExpiryMonth("2027-06-30", "2028-06-30")).toBe(false);
    expect(sameExpiryMonth(null, null)).toBe(true);
    expect(sameExpiryMonth(null, "2028-06-30")).toBe(false);
  });
});
