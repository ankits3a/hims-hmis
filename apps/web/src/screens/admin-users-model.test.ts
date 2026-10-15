import { areaOf, inChip, initials, makePassword, maskMobile, matchesQuery, roleGroups, shortAadhaar, shortTitle, suggestUsername } from "./admin-users-model";

/** The Users screen's pure arithmetic (owner 2026-10-09 rework). Suggestions only — the server judges. */
const U = { id: "u1", username: "neha.sharma", fullName: "Dr. Neha Sharma", staffCode: "S-0012", active: true, hasPin: true, mustChangePassword: false, roles: [] };

describe("admin-users-model", () => {
  it("a first password is word-word-four digits, at least twelve long, from getRandomValues", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const p = makePassword();
      expect(p).toMatch(/^[A-Z][a-z]+-[A-Z][a-z]+-\d{4}$/);
      expect(p.length).toBeGreaterThanOrEqual(12);
      const [a, b] = p.split("-");
      expect(a).not.toBe(b);
      seen.add(p);
    }
    expect(seen.size).toBeGreaterThan(150);
    // The source of randomness is the one passed in — never Math.random.
    const math = vi.spyOn(Math, "random");
    expect(makePassword((arr) => arr.fill(0))).toBe("Amber-Basil-0000");
    expect(math).not.toHaveBeenCalled();
    math.mockRestore();
  });

  it("a username is made from a name as first.last, titles and punctuation dropped", () => {
    expect(suggestUsername("Rekha Gupta")).toBe("rekha.gupta");
    expect(suggestUsername("Dr. Neha  Sharma")).toBe("neha.sharma");
    expect(suggestUsername("Asha Kumari Verma")).toBe("asha.verma");
    expect(suggestUsername("Prakash")).toBe("prakash");
    expect(suggestUsername("  ")).toBe("");
    expect(suggestUsername("O'Brien Dsouza")).toBe("o.dsouza");
  });

  it("search matches name, username, staff code, and a mobile by its digits", () => {
    expect(matchesQuery(U, "neha", null)).toBe(true);
    expect(matchesQuery(U, "SHARMA", null)).toBe(true);
    expect(matchesQuery(U, "s-0012", null)).toBe(true);
    expect(matchesQuery(U, "98765", "9876501234")).toBe(true);
    expect(matchesQuery(U, "98 765", "9876501234")).toBe(true);
    expect(matchesQuery(U, "98765", null)).toBe(false);
    expect(matchesQuery(U, "12", "9876501234")).toBe(true); // via staff code S-0012
    expect(matchesQuery(U, "pooja", "9876501234")).toBe(false);
    expect(matchesQuery(U, "", null)).toBe(true);
  });

  it("chips: notLinked counts nobody without the identity list", () => {
    expect(inChip("notLinked", U, undefined)).toBe(false);
    expect(inChip("notLinked", U, null)).toBe(true);
    expect(inChip("notLinked", U, { userId: "u1", mobile: null, aadhaar: null, attendance: "linked" })).toBe(false);
    expect(inChip("noRole", U, undefined)).toBe(true);
  });

  it("names, titles, areas and masks", () => {
    expect(initials("Dr. Neha Sharma")).toBe("NS");
    expect(initials("admin")).toBe("AD");
    expect(shortTitle("Doctor (OPD consultant)")).toBe("Doctor");
    expect(areaOf({ permissions: ["opd.a", "opd.b", "patients.read"] })).toBe("opd");
    expect(areaOf({ permissions: [] })).toBe("other");
    expect(maskMobile("9876543210")).toBe("98•••••210");
    expect(shortAadhaar("XXXX XXXX 4417")).toBe("•••• 4417");
    const groups = roleGroups([
      { key: "pharmacy", title: "Pharmacy (verification)", permissions: ["pharmacy.x"], holders: 0, grantsAccessAuthority: false },
      { key: "cashier", title: "Cashier", permissions: ["billing.x"], holders: 0, grantsAccessAuthority: false },
    ], "pha");
    expect(groups).toEqual([{ area: "pharmacy", roles: [expect.objectContaining({ key: "pharmacy" })] }]);
  });
});
