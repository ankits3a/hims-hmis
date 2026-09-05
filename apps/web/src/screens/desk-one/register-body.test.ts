import { describe, expect, it } from "vitest";
import { EMPTY_FORM, registerBodyOf } from "./session";
import type { Form } from "./session";

/**
 * ═══ FD-25 — THE REGISTRATION BODY, AND THE TWO THINGS IT WAS GETTING WRONG IN PRODUCTION ═══
 *
 * `registerBodyOf` is the pure function that turns what a clerk typed into what `POST /patients`
 * receives. It was extracted out of `desk-one.tsx` because three front-desk seats now register
 * patients and a mapping that exists in three places is a mapping that will disagree.
 *
 * The extraction was not a refactor. It exposed two defects that were LIVE on the deployed counter,
 * and each has a named test below. Both were invisible to the 537 tests this lane already had,
 * because every one of them asserts what the SCREEN does and neither defect is on the screen: one
 * is a field the client could not send, and the other is four fields the client never sent.
 */
const form = (over: Partial<Form>): Form => ({ ...EMPTY_FORM, name: "Farida Khatoon", sex: "female", ...over });

describe("registerBodyOf — the confidential registration that always 400ed", () => {
  /**
   * THE DEFECT: `desk-one.tsx` sent `...(f.isConfidential ? { isConfidential: true } : {})` and
   * never sent `alias`. `registration.ts` throws `alias_required` on exactly that body. So ticking
   * "confidential record" at the counter was a guaranteed refusal, for every clerk, since FD-12.
   *
   * `WireRegisterBody` did not declare `alias` either, so no compiler could point at the omission —
   * which is why it survived a close review. The type and the mapping are both fixed; this asserts
   * the pair travels together, because either one alone is a different bug.
   */
  it("sends the alias with the flag — the server refuses the flag alone", () => {
    const body = registerBodyOf(form({ isConfidential: true, alias: "Patient 44" }));
    expect(body.isConfidential).toBe(true);
    expect(body.alias).toBe("Patient 44");
  });

  it("records the sensitive context beside the seal when the clerk sets one", () => {
    const body = registerBodyOf(form({ isConfidential: true, alias: "Patient 44", sensitiveContext: true }));
    expect(body.sensitiveContext).toBe(true);
  });

  /**
   * The opposite error, and it is a real one rather than symmetry for its own sake: an alias
   * recorded against a record that is NOT sealed is a public name for a patient nobody asked to
   * hide. The alias is meaningless without the flag, so it does not travel without it.
   */
  it("sends neither when the record is ordinary, even if an alias was typed and then unticked", () => {
    const body = registerBodyOf(form({ isConfidential: false, alias: "Patient 44" }));
    expect(body.isConfidential).toBeUndefined();
    expect(body.alias).toBeUndefined();
  });
});

describe("registerBodyOf — the guardian authorities nobody had ever sent", () => {
  /**
   * THE DEFECT: the server has accepted and stored `authorityMessages` / `authorityConsents` /
   * `authorityDsr` / `authorityBills` since the guardians table existed. `grep` finds no caller that
   * has ever supplied one. So every guardian row in the database holds the COLUMN DEFAULTS.
   *
   * That would be tolerable if the defaults matched the design. They do not: the column defaults
   * `consents` to TRUE and `dsr` to FALSE, while the signed-off artboard puts messages and bills ON
   * and consents and records OFF. A guardian who was never asked about consent has been recorded as
   * holding it — which is a DPDP §9 authority decided by a column default.
   *
   * The pinned expectation is therefore the ARTBOARD's, and all four travel explicitly on every
   * registration so that no future column default can quietly answer the question again.
   */
  it("sends all four explicitly, and the defaults are the artboard's, not the column's", () => {
    const body = registerBodyOf(form({ guardianName: "Imran Khatoon", guardianRelationship: "mother" }));
    expect(body.guardian).toMatchObject({
      name: "Imran Khatoon",
      relationship: "mother",
      authorityMessages: true,
      authorityBills: true,
      authorityConsents: false,
      authorityDsr: false,
    });
  });

  it("carries a clerk's changes to the four, including turning one off", () => {
    const body = registerBodyOf(form({
      guardianName: "Imran Khatoon",
      guardianRelationship: "father",
      guardianAuthorityBills: false,
      guardianAuthorityConsents: true,
    }));
    expect(body.guardian?.authorityBills).toBe(false);
    expect(body.guardian?.authorityConsents).toBe(true);
  });

  /**
   * `false` IS A VALUE AND MUST SURVIVE THE WIRE. This is the assertion that would catch the
   * obvious "fix" — folding the four into the `opt()`-style omit-when-empty spread that every other
   * optional field uses. Omitting `authorityBills: false` does not mean "no opinion"; it means the
   * column default TRUE applies, which is the opposite of what the clerk just said.
   */
  it("sends a withheld authority as false rather than omitting it", () => {
    const body = registerBodyOf(form({
      guardianName: "Imran Khatoon",
      guardianRelationship: "other",
      guardianAuthorityMessages: false,
      guardianAuthorityBills: false,
    }));
    expect(body.guardian).toHaveProperty("authorityMessages", false);
    expect(body.guardian).toHaveProperty("authorityBills", false);
  });

  /** No guardian named is no guardian sent — an adult's registration carries no empty block. */
  it("omits the guardian entirely when none was named", () => {
    expect(registerBodyOf(form({})).guardian).toBeUndefined();
  });
});

describe("registerBodyOf — the rules the extraction had to carry across unchanged", () => {
  /**
   * FD-12's discipline, and the reason it is asserted here rather than trusted: posting `""` is a
   * DIFFERENT CLAIM from saying nothing. zod's `.max()` accepts an empty string, the column holds
   * it, and "the clerk left this blank" stops being distinguishable from "the clerk answered
   * nothing" in the master forever after.
   */
  it("omits a blank optional field rather than sending an empty string", () => {
    const body = registerBodyOf(form({ address: "   ", occupation: "", district: "  " }));
    expect(body).not.toHaveProperty("addressLine");
    expect(body).not.toHaveProperty("occupation");
    expect(body).not.toHaveProperty("district");
  });

  /** The server refuses `dob_or_age` outright, so the clerk's toggle decides which one travels. */
  it("sends the age when the clerk is entering an age, and never both", () => {
    const body = registerBodyOf(form({ ageMode: "age", age: "51", dob: "1975-03-02" }));
    expect(body.ageYears).toBe(51);
    expect(body).not.toHaveProperty("dob");
  });

  it("sends the date of birth when the clerk is entering one, and never both", () => {
    const body = registerBodyOf(form({ ageMode: "dob", dob: "1975-03-02", age: "51" }));
    expect(body.dob).toBe("1975-03-02");
    expect(body).not.toHaveProperty("ageYears");
  });

  /**
   * Only ABDM answering may say `verified`, and this hospital is not connected to ABDM. A screen
   * that could set it would be recording a verification that never happened.
   */
  it("records an ABHA as self-declared and nothing stronger", () => {
    const body = registerBodyOf(form({ abhaAddress: "farida.khatoon@abdm" }));
    expect(body.abhaVerificationStatus).toBe("self_declared");
  });

  it("sends no ABHA verification status at all when no ABHA was given", () => {
    expect(registerBodyOf(form({})).abhaVerificationStatus).toBeUndefined();
  });

  /** An untouched blank coverage row is not an entitlement, and must not become one. */
  it("drops coverage rows the clerk never filled in", () => {
    const body = registerBodyOf(form({
      coverages: [
        { kind: "corporate", payerName: "", tpaName: "", policyNumber: "", cardNumber: "", beneficiaryId: "", employeeId: "", planClass: "", validFrom: "", validTo: "", verificationStatus: "self_declared" },
        { kind: "corporate", payerName: "East Central Railway", tpaName: "", policyNumber: "", cardNumber: "", beneficiaryId: "", employeeId: "41129", planClass: "", validFrom: "", validTo: "", verificationStatus: "card_seen" },
      ],
    }));
    expect(body.coverages).toHaveLength(1);
    expect(body.coverages?.[0]).toMatchObject({ payerName: "East Central Railway", employeeId: "41129" });
  });

  /** The clerk types what is printed on the card; only the last four digits are ever sent. */
  it("truncates a guardian's id to its last four digits before it leaves the browser", () => {
    const body = registerBodyOf(form({
      guardianName: "Imran Khatoon",
      guardianRelationship: "father",
      guardianIdType: "aadhaar",
      guardianIdNumber: "2345 6789 0123",
    }));
    expect(body.guardian?.idNumberMasked).toBe("0123");
  });
});
