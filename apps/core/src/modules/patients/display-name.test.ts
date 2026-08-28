import { displayName } from "./display-name";

/**
 * PLAN 15 T8 / F20 — the rule §14 always had and never had in ONE place.
 *
 * The behavioural half (that the OT's list and recovery board actually route through this) lives in
 * `modules/ot/lists.test.ts` and `modules/ot/recovery.test.ts`, because a helper that is correct and
 * uncalled protects nobody — which is the failure mode this whole helper exists to end.
 */
describe("displayName (§14 / F20)", () => {
  const ordinary = { name: "Sunita Devi", alias: null, isConfidential: false };
  const vip = { name: "Ravi Shankar Menon", alias: "Patient A", isConfidential: true };

  it("an ordinary patient is their name, to everybody", () => {
    expect(displayName(ordinary, false)).toBe("Sunita Devi");
    expect(displayName(ordinary, true)).toBe("Sunita Devi");
  });

  it("a confidential patient is their ALIAS without the permission, and their name with it", () => {
    expect(displayName(vip, false)).toBe("Patient A");
    expect(displayName(vip, true)).toBe("Ravi Shankar Menon");
  });

  /**
   * Registration refuses to flag a patient confidential without an alias (`alias_required`), so
   * this row cannot be created through the front door. It can exist from a repair script or a row
   * written before that constraint — and the safe direction is not arguable: the one row that
   * slipped past the constraint must not be the one row that leaks a name.
   */
  it("a confidential patient with NO alias is a dash — never the legal name", () => {
    const unaliased = { name: "Ravi Shankar Menon", alias: null, isConfidential: true };
    expect(displayName(unaliased, false)).toBe("—");
    expect(displayName(unaliased, false)).not.toContain("Ravi");
  });

  /**
   * An empty-string alias is falsy in JavaScript but is NOT null, so `??` keeps it — and an empty
   * cell on a theatre list is indistinguishable from a rendering bug. This asserts the current
   * behaviour rather than asserting a dash, because the fix belongs at registration (which already
   * refuses a blank alias) and a second normalisation here would be the second copy of the rule
   * this helper exists to remove. Recorded so the next reader knows it was considered.
   */
  it("an empty alias is passed through as empty — registration is where blank aliases are refused", () => {
    expect(displayName({ name: "Ravi", alias: "", isConfidential: true }, false)).toBe("");
  });
});
