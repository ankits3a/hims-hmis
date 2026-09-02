import { DICOM_UID_MAX_LENGTH, isValidDicomUid, mintStudyInstanceUid } from "./uid";

describe("the Study Instance UID minter (18b T1/T2, D3)", () => {
  it("is a pure function of the study id — two calls, two studies, one answer each", () => {
    const a = mintStudyInstanceUid("01J6ZK8Q3W9X2Y4V5T6R7S8P9N");
    expect(mintStudyInstanceUid("01J6ZK8Q3W9X2Y4V5T6R7S8P9N")).toBe(a);
    expect(mintStudyInstanceUid("01J6ZK8Q3W9X2Y4V5T6R7S8P9M")).not.toBe(a);
  });

  it("is a valid DICOM UID under the 2.25 arc, at most 64 characters, for any id shape", () => {
    for (const id of ["01PATIENT0000000000000001", "x", "a-very-long-id-".repeat(10)]) {
      const uid = mintStudyInstanceUid(id);
      expect(uid.startsWith("2.25.")).toBe(true);
      expect(uid.length).toBeLessThanOrEqual(DICOM_UID_MAX_LENGTH);
      expect(isValidDicomUid(uid)).toBe(true);
    }
  });

  it("validates the shape PS3.5 §9.1 states and refuses the ones it forbids", () => {
    expect(isValidDicomUid("1.2.826.0.1.3680043.2.1125.1")).toBe(true);
    expect(isValidDicomUid("2.25.0")).toBe(true);
    expect(isValidDicomUid("1.2.3.abc")).toBe(false);
    expect(isValidDicomUid("1.2.03")).toBe(false); // a leading zero
    expect(isValidDicomUid("1..2")).toBe(false);
    expect(isValidDicomUid(".1.2")).toBe(false);
    expect(isValidDicomUid("")).toBe(false);
    expect(isValidDicomUid(`1.${"9".repeat(63)}`)).toBe(false); // 65 characters
  });
});
