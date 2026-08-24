import {
  COMMON_PASSWORDS, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, checkPassword, checkPin,
  passwordIsAcceptable, pinIsAcceptable,
} from "./password-policy";

/**
 * PLAN 11e T2 — the policy's own unit. Every leg here is one clause of the owner's 2026-08-23
 * ruling, executed. The per-CALL-SITE coverage (R4's real point — that the SIX paths which set a
 * credential all reach this module; five from 11e D3, plus `seed:admin`'s `ADMIN_PASSWORD` from
 * 11f D1) lives in `test/user-admin.e2e.test.ts`, `test/seed-staff.test.ts`,
 * `test/credential-lifecycle.e2e.test.ts` and `test/seed-admin.test.ts`: a policy nobody calls
 * would pass this file entirely.
 */
describe("password policy (11e D3, owner ruled 2026-08-23)", () => {
  const ctx = { username: "asha" };

  it("R4 — the floor is TEN: nine is refused, ten is accepted, and the boundary is asserted from both sides", () => {
    const nine = "abcdefghi";
    const ten = "abcdefghij";
    expect(nine).toHaveLength(9);
    expect(ten).toHaveLength(PASSWORD_MIN_LENGTH);

    expect(checkPassword(nine, ctx).map((p) => p.code)).toEqual(["password_too_short"]);
    expect(checkPassword(ten, ctx)).toEqual([]);
    expect(passwordIsAcceptable(nine, ctx)).toBe(false);
    expect(passwordIsAcceptable(ten, ctx)).toBe(true);
  });

  it("no composition rules exist — a ten-character password of one repeated lowercase letter is ACCEPTED", () => {
    // This is the ruling's actual content, and it is worth an executed assertion rather than a
    // comment: "length beats composition rules people work around" means exactly that nothing
    // here demands an uppercase letter, a digit or a symbol. A future reviewer who adds one
    // breaks this test, which is the point.
    expect(checkPassword("aaaaaaaaaa", ctx)).toEqual([]);
    expect(checkPassword("P@ss1", ctx).map((p) => p.code)).toEqual(["password_too_short"]);
  });

  it("R6 — the USERNAME is refused case-insensitively, even at length ≥ 10", () => {
    const long = { username: "receptionist" }; // twelve characters: the length floor cannot do this
    expect(checkPassword("receptionist", long).map((p) => p.code)).toEqual(["password_is_username"]);
    expect(checkPassword("RecePTionIST", long).map((p) => p.code)).toEqual(["password_is_username"]);
    // …and a password that merely CONTAINS the username is fine: the ruling says "is", not
    // "contains", and a containment rule would refuse half of every passphrase a person invents.
    expect(checkPassword("receptionist-monday", long)).toEqual([]);
  });

  it("R6 — a top-20 entry is refused case-insensitively, even at length ≥ 10", () => {
    expect("1234567890").toHaveLength(10); // long enough to clear the floor
    expect(checkPassword("1234567890", ctx).map((p) => p.code)).toEqual(["password_is_common"]);

    // Case-insensitivity, on the one entry that has letters AND clears nothing but the check
    // itself — `PASSWORD1` is nine characters, so BOTH problems must be reported, in order.
    expect(checkPassword("PASSWORD1", ctx).map((p) => p.code)).toEqual([
      "password_too_short", "password_is_common",
    ]);
  });

  it("the list is exactly twenty, and NINETEEN of them are already refused by length alone", () => {
    // §2.49's census, and it is also the honest measurement the module header states: the common
    // list buys one entry beyond what the floor already refuses. If either number moves, the
    // header is wrong and this fails.
    expect(COMMON_PASSWORDS).toHaveLength(20);
    expect(new Set(COMMON_PASSWORDS).size).toBe(20); // no duplicates padding the count
    const shorterThanFloor = COMMON_PASSWORDS.filter((p) => p.length < PASSWORD_MIN_LENGTH);
    expect(shorterThanFloor).toHaveLength(19);
    expect(COMMON_PASSWORDS.filter((p) => p.length >= PASSWORD_MIN_LENGTH)).toEqual(["1234567890"]);
  });

  it("the ceiling is 256, and it is the argon2 input bound rather than a security claim", () => {
    expect(checkPassword("x".repeat(PASSWORD_MAX_LENGTH), ctx)).toEqual([]);
    expect(checkPassword("x".repeat(PASSWORD_MAX_LENGTH + 1), ctx).map((p) => p.code)).toEqual([
      "password_too_long",
    ]);
  });

  it("every problem message names the RULE and never the value (GC3)", () => {
    const secret = "hunter2xyz";
    for (const problem of checkPassword("short", { username: "short" })) {
      expect(problem.message).not.toContain("short");
    }
    // A password that breaks nothing produces no message at all — nothing to leak.
    expect(checkPassword(secret, ctx)).toEqual([]);
    for (const problem of checkPin("12ab")) expect(problem.message).not.toContain("12ab");
  });

  it("a PIN is 4-6 DIGITS, exactly — the three ways that can fail, and the two that cannot", () => {
    expect(checkPin("1234")).toEqual([]);
    expect(checkPin("123456")).toEqual([]);
    expect(pinIsAcceptable("482913")).toBe(true);

    expect(checkPin("123").map((p) => p.code)).toEqual(["pin_wrong_length"]);
    expect(checkPin("1234567").map((p) => p.code)).toEqual(["pin_wrong_length"]);
    expect(checkPin("12ab").map((p) => p.code)).toEqual(["pin_not_digits"]);
    expect(checkPin("").map((p) => p.code)).toEqual(["pin_not_digits", "pin_wrong_length"]);
    expect(pinIsAcceptable("abcd")).toBe(false);
  });
});
