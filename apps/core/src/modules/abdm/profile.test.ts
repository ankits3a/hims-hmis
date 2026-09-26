import { classifyAbhaIdentifier } from "./abha-service";
import { compareWithPatient, mismatches, normaliseName, readAbdmProfile } from "./profile";

/**
 * ABDM S1 — one reader for ABDM's three spellings of a person, and the comparison that SHOWS a
 * difference without ever writing one.
 */
describe("readAbdmProfile — the three shapes ABDM sends", () => {
  it("reads a verified login's /profile/account answer (string birth fields, M/F/O)", () => {
    const p = readAbdmProfile({
      ABHANumber: "91-2345-6789-0123", preferredAbhaAddress: "sunita@sbx", name: "Sunita Sharma",
      yearOfBirth: "1986", monthOfBirth: "3", dayOfBirth: "14", gender: "F", mobile: "******3210",
      address: "12 Gandhi Nagar", districtName: "Jaipur", stateName: "RAJASTHAN", pincode: "302015", profilePhoto: "xxx",
    });
    expect(p).toEqual({
      abhaNumber: "91-2345-6789-0123", abhaAddress: "sunita@sbx", name: "Sunita Sharma", gender: "female",
      yearOfBirth: 1986, monthOfBirth: 3, dayOfBirth: 14, dob: "1986-03-14", mobile: "******3210",
      addressLine: "12 Gandhi Nagar", district: "Jaipur", stateName: "RAJASTHAN", pincode: "302015",
    });
  });

  it("reads an enrolment's ABHAProfile (DD-MM-YYYY dob, pinCode, phrAddress[], split name)", () => {
    const p = readAbdmProfile({
      firstName: "Kamla", middleName: "", lastName: "Devi", dob: "02-07-1979", gender: "F", mobile: "9812345678",
      phrAddress: ["kamla.d@sbx"], pinCode: "302001", ABHANumber: "91123456789012",
    });
    expect(p).toMatchObject({ name: "Kamla Devi", dob: "1979-07-02", abhaNumber: "91-1234-5678-9012", abhaAddress: "kamla.d@sbx", pincode: "302001" });
  });

  it("reads a scan-and-share patient (null number, nested address with `pincode`, phoneNumber)", () => {
    const p = readAbdmProfile({
      abhaNumber: null, abhaAddress: "ravi@sbx", name: "Ravi", gender: "M", yearOfBirth: "1990",
      address: { line: "Plot 4", district: "Ajmer", state: "RAJASTHAN", pincode: "305001" }, phoneNumber: "9876501234",
    });
    expect(p).toMatchObject({ abhaNumber: null, abhaAddress: "ravi@sbx", gender: "male", yearOfBirth: 1990, dob: null, addressLine: "Plot 4", district: "Ajmer", pincode: "305001", mobile: "9876501234" });
  });
});

describe("compareWithPatient — shown, never written", () => {
  const abdm = readAbdmProfile({ name: "Sunita Sharma", gender: "F", yearOfBirth: "1986", monthOfBirth: "3", dayOfBirth: "14", mobile: "******3210" });

  it("agrees across case, honorifics and a masked mobile's visible digits", () => {
    const c = compareWithPatient(abdm, { name: "Smt. SUNITA  sharma", dob: "1986-03-14", dobEstimated: false, gender: "female", phone: "9876543210" });
    expect(mismatches(c)).toEqual([]);
    expect(c.map((x) => x.result)).toEqual(["same", "same", "same", "same"]);
  });

  it("names each difference with both sides' values", () => {
    const c = compareWithPatient(abdm, { name: "Sunita Verma", dob: "1987-01-01", dobEstimated: false, gender: "male", phone: "9000000000" });
    expect(mismatches(c).map((x) => x.field)).toEqual(["name", "dob", "gender", "mobile"]);
    expect(c[0]).toEqual({ field: "name", abdm: "Sunita Sharma", hospital: "Sunita Verma", result: "differs" });
  });

  it("an estimated dob (the counter typed an age) is compared on the year, a year either way", () => {
    const c = compareWithPatient(abdm, { name: "Sunita Sharma", dob: "1987-09-25", dobEstimated: true, gender: "female", phone: null });
    expect(c.find((x) => x.field === "dob")).toMatchObject({ abdm: "1986", hospital: "1987", result: "same" });
    expect(c.find((x) => x.field === "mobile")?.result).toBe("unknown");
  });

  it("normaliseName drops what does not distinguish two people", () => {
    expect(normaliseName("Dr. Asha  DEVI.")).toBe("asha devi");
  });
});

describe("classifyAbhaIdentifier", () => {
  it("a fourteen-digit number, however typed, is an ABHA number in its dashed form", () => {
    expect(classifyAbhaIdentifier("91 2345 6789 0123", "sbx")).toEqual({ kind: "abha_number", identifier: "91-2345-6789-0123" });
    expect(classifyAbhaIdentifier("91234567890123", "sbx")).toEqual({ kind: "abha_number", identifier: "91-2345-6789-0123" });
  });

  it("an address keeps its suffix, and gets this deployment's when typed without one", () => {
    expect(classifyAbhaIdentifier("sunita.sharma@abdm", "sbx")).toEqual({ kind: "abha_address", identifier: "sunita.sharma@abdm" });
    expect(classifyAbhaIdentifier("sunita.sharma", "sbx")).toEqual({ kind: "abha_address", identifier: "sunita.sharma@sbx" });
    expect(classifyAbhaIdentifier("sunita.sharma", "abdm")).toEqual({ kind: "abha_address", identifier: "sunita.sharma@abdm" });
  });

  it("refuses what is neither — including a twelve-digit Aadhaar typed into the ABHA box", () => {
    expect(classifyAbhaIdentifier("1234 5678 9012", "sbx")).toBeNull();
    expect(classifyAbhaIdentifier("123456789012", "sbx")).toBeNull();
    expect(classifyAbhaIdentifier("9876543210@sbx", "sbx")).toEqual({ kind: "abha_address", identifier: "9876543210@sbx" });
    expect(classifyAbhaIdentifier("a@b@c", "sbx")).toBeNull();
    expect(classifyAbhaIdentifier("", "sbx")).toBeNull();
  });
});
