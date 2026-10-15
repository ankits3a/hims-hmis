import { aadhaarHash, maskedAadhaar, normaliseAadhaar, verhoeffValid } from "./aadhaar";

/**
 * The guide's Aadhaar TEST VECTOR ("Aadhaar linking", dummy key and a made-up number): key = `0f`
 * repeated 32 times, Aadhaar `2345 6789 0124` →
 * `87072b92e7fe94e13084f46ab4fb7ad8c6690717859485131583ac86a6164905`.
 */
const KEY = "0f".repeat(32);
const VECTOR = "87072b92e7fe94e13084f46ab4fb7ad8c6690717859485131583ac86a6164905";

describe("the Aadhaar linking hash — bioattend's formula", () => {
  it("the guide's test vector", () => {
    expect(aadhaarHash("2345 6789 0124", KEY)).toBe(VECTOR);
  });

  it("spaces and hyphens are removed before hashing, exactly as bioattend does", () => {
    expect(aadhaarHash("2345 6789-0124", KEY)).toBe(VECTOR);
    expect(aadhaarHash("234567890124", KEY)).toBe(VECTOR);
    expect(aadhaarHash("  2345-6789-0124 ", KEY)).toBe(VECTOR);
  });

  it("one character of the key changed gives a different hash", () => {
    const other = aadhaarHash("2345 6789 0124", `1f${"0f".repeat(31)}`);
    expect(other).toMatch(/^[0-9a-f]{64}$/);
    expect(other).not.toBe(VECTOR);
  });

  it("one digit of the number changed has NO hash — the check digit catches it", () => {
    expect(aadhaarHash("2345 6789 0125", KEY)).toBeNull();
    expect(aadhaarHash("2345 6789 0224", KEY)).toBeNull();
  });

  it("the key is HEX-DECODED: a key that is not 64 hex characters is not a key", () => {
    expect(aadhaarHash("2345 6789 0124", "ab".repeat(31))).toBeNull();
    expect(aadhaarHash("2345 6789 0124", "zz".repeat(32))).toBeNull();
    expect(aadhaarHash("2345 6789 0124", "")).toBeNull();
  });

  it("twelve digits, first digit 2-9, valid Verhoeff — each rule named when it fails", () => {
    expect(normaliseAadhaar("2345 6789 0124")).toEqual({ ok: true, digits: "234567890124" });
    expect(normaliseAadhaar("2345 6789 012")).toEqual({ ok: false, problem: "not_twelve_digits" });
    expect(normaliseAadhaar("2345 6789 0124 5")).toEqual({ ok: false, problem: "not_twelve_digits" });
    expect(normaliseAadhaar("2345 6789 O124")).toEqual({ ok: false, problem: "not_twelve_digits" });
    expect(normaliseAadhaar("1345 6789 0124")).toEqual({ ok: false, problem: "bad_first_digit" });
    expect(normaliseAadhaar("0345 6789 0124")).toEqual({ ok: false, problem: "bad_first_digit" });
    expect(normaliseAadhaar("2345 6789 0123")).toEqual({ ok: false, problem: "bad_check_digit" });
  });

  it("Verhoeff: the check digit of a known number, and every single-digit slip of it refused", () => {
    expect(verhoeffValid("2363")).toBe(true); // the textbook example: 236 → check digit 3
    expect(verhoeffValid("234567890124")).toBe(true);
    for (let i = 0; i < 12; i++) {
      for (let d = 0; d <= 9; d++) {
        const slipped = `${"234567890124".slice(0, i)}${d}${"234567890124".slice(i + 1)}`;
        if (slipped !== "234567890124") expect(verhoeffValid(slipped)).toBe(false);
      }
    }
  });

  it("what a screen shows afterwards is the last four digits and nothing else", () => {
    expect(maskedAadhaar("0124")).toBe("XXXX XXXX 0124");
  });
});
