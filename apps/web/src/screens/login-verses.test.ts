import { DESK_LINES, pickLine } from "./login-verses";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE THING THIS FILE GUARDS IS NOT A RENDER — IT IS AN ATTRIBUTION
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Every other test in this repository asks whether the screen did what it said. These ask whether
 * what the screen SAYS is true, because the failure this table can produce is not a broken layout:
 * it is a hospital printing `गीता 5.25` next to a line that is not 5.25, or printing a chapter and
 * verse beside a proverb that has neither. Both are silent. Both survive a green suite and a
 * screenshot. Neither is recoverable once the whole staff has read it every morning for a month.
 */
describe("the lines on the sign-in panel", () => {
  it("never attributes a chapter and verse to anything that is not scripture", () => {
    for (const line of DESK_LINES) {
      if (line.source === "proverb") {
        expect(line.cite, `${line.id} is a proverb and must carry no citation`).toBeNull();
      } else {
        expect(line.cite, `${line.id} claims scripture and must carry a citation`).toMatch(/^\d{1,2}\.\d{1,2}$/);
      }
    }
  });

  /*
    `सेवा ही परम धर्म है` is the line the owner asked for by name and it is the one entry here that
    is NOT from the Gita. Pinned by id rather than left to the loop above, because the loop would
    still pass if somebody "corrected" this row by giving it a citation — which is exactly the
    mistake, not the fix.
  */
  it("keeps the seva line marked as a proverb", () => {
    const seva = DESK_LINES.find((l) => l.id === "seva");
    expect(seva?.source).toBe("proverb");
    expect(seva?.cite).toBeNull();
  });

  it("carries the eight verses the owner approved, and each one exactly once", () => {
    const cites = DESK_LINES.filter((l) => l.source === "gita").map((l) => l.cite);
    expect(cites).toEqual(["18.46", "5.25", "6.32", "12.13", "2.47", "2.50", "3.19", "17.20"]);
    expect(new Set(DESK_LINES.map((l) => l.id)).size).toBe(DESK_LINES.length);
  });

  /*
    The Sanskrit is Devanagari in every UI language, so it is the one string on the screen that can
    never be Latin. A line pasted back in transliteration would render in a Latin face under
    `.shloka`'s Devanagari stack and look merely ugly rather than wrong.
  */
  it("prints every line in Devanagari", () => {
    for (const line of DESK_LINES) {
      expect(line.shloka, line.id).toMatch(/[ऀ-ॿ]/);
      expect(line.shloka, `${line.id} must not be transliterated`).not.toMatch(/[A-Za-z]/);
    }
  });

  it("pins a line by index, so a screen test can assert on a known verse", () => {
    expect(pickLine(0).cite).toBe("18.46");
    expect(pickLine(3).cite).toBe("12.13");
    expect(pickLine(DESK_LINES.length - 1).id).toBe("seva");
  });

  it("reaches every line and stays in range for any index", () => {
    const reached = new Set(DESK_LINES.map((_, i) => pickLine(i).id));
    expect(reached.size).toBe(DESK_LINES.length);
    // Out-of-range and negative indices wrap rather than returning undefined.
    expect(pickLine(DESK_LINES.length)).toBe(DESK_LINES[0]);
    expect(pickLine(-1)).toBe(DESK_LINES[DESK_LINES.length - 1]);
  });

  it("picks from the table when nothing is pinned", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.999999);
    expect(DESK_LINES).toContain(pickLine());
    expect(pickLine().id).toBe("seva");
    random.mockReturnValue(0);
    expect(pickLine().id).toBe("g1846");
    random.mockRestore();
  });
});
