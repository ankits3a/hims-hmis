import { describe, expect, it } from "vitest";
import {
  expandSnippet, keywordEndingAt, keywordProblem, PLACEHOLDERS, unknownTokensIn,
} from "./snippets";
import type { SnippetContext } from "./snippets";

/**
 * ═══ SNIPPETS — THE ENGINE ═══
 *
 * The rule that shapes most of these: an unresolvable placeholder becomes a BLANK the doctor is
 * taken to, never an empty string. A sentence that closes over a missing weight prints, and nobody
 * reads it twice.
 */
const FULL: SnippetContext = {
  patient: { name: "Asha Devi", uhid: "HMS0000000020", ageYears: 34, sex: "female" },
  vitals: { weightKg: 62, heightCm: 165, sbp: 118, dbp: 76, pulse: 72, spo2: 98, tempC: 36.8 },
  note: { complaint: "fever · cough", diagnosis: "Acute upper respiratory infection, unspecified" },
  doctor: { name: "Dr A Desai" },
  now: new Date("2026-09-14T06:00:00.000Z"),
};
const EMPTY: SnippetContext = {
  patient: null, vitals: null,
  note: { complaint: "", diagnosis: "" },
  doctor: { name: null },
  now: new Date("2026-09-14T06:00:00.000Z"),
};

describe("expandSnippet", () => {
  it("S1: fills from the patient in the chair", () => {
    const { text } = expandSnippet("For {name} ({age}{sex}), {weight} kg, BP {bp}.", FULL);
    expect(text).toBe("For Asha Devi (34female), 62 kg, BP 118/76.");
  });

  it("S2: an UNCHARTED value becomes a blank, never an empty hole", () => {
    /* The sentence that must never print: "Take 500 mg for  kg body weight". */
    const { text, stops } = expandSnippet("Take 500 mg for {weight} kg body weight", EMPTY);
    expect(text).toBe("Take 500 mg for  kg body weight");
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ label: "weight", start: 16, end: 16 });
    // The caret lands exactly where the number belongs, so the doctor is stopped by the gap.
    expect(text.slice(0, stops[0]!.start)).toBe("Take 500 mg for ");
  });

  it("S3: half a blood pressure is not a reading", () => {
    const ctx = { ...FULL, vitals: { ...FULL.vitals!, dbp: null } };
    const { text, stops } = expandSnippet("BP {bp}", ctx);
    // "118/" on a slip is worse than a blank: it reads as a whole number that was never taken.
    expect(text).toBe("BP ");
    expect(stops.map((s) => s.label)).toEqual(["bp"]);
  });

  it("S4: {?} is a blank and {?text} is a default to type over", () => {
    const { text, stops } = expandSnippet("Take {?one tablet} {?} after food", FULL);
    expect(text).toBe("Take one tablet  after food");
    expect(stops).toHaveLength(2);
    // The first is SELECTED on landing, which is what lets typing replace it.
    expect(text.slice(stops[0]!.start, stops[0]!.end)).toBe("one tablet");
    expect(stops[1]!.start).toBe(stops[1]!.end);
  });

  it("S5: dates do arithmetic, which is the follow-up line every slip carries", () => {
    expect(expandSnippet("Review on {date+7}.", FULL).text).toBe("Review on 21 Sep 2026.");
    expect(expandSnippet("Since {date-3}.", FULL).text).toBe("Since 11 Sep 2026.");
    expect(expandSnippet("{today}", FULL).text).toBe("14 Sep 2026");
  });

  it("S6: stops come back in SOURCE order, so Tab reads the snippet top to bottom", () => {
    const { stops } = expandSnippet("{?a} then {?b} then {?c}", FULL);
    expect(stops.map((s) => s.label)).toEqual(["a", "b", "c"]);
    expect(stops.map((s) => s.start)).toEqual([...stops.map((s) => s.start)].sort((x, y) => x - y));
  });

  it("S7: an UNKNOWN token degrades to a blank and never prints its own braces", () => {
    /* A typo saved once is a typo printed on fifty slips. It must not reach paper. */
    const { text, stops } = expandSnippet("for {wieght} kg", FULL);
    expect(text).toBe("for  kg");
    expect(text).not.toContain("{");
    expect(stops.map((s) => s.label)).toEqual(["wieght"]);
  });

  it("S8: {{ is the escape, for the rare snippet that needs a literal brace", () => {
    expect(expandSnippet("dose {{x}} and {name}", FULL).text).toBe("dose {x} and Asha Devi");
  });

  it("S9: works in Devanagari, because the field the patient reads is bilingual", () => {
    const { text } = expandSnippet("{name} जी, {date+7} को दोबारा दिखाएँ।", FULL);
    expect(text).toBe("Asha Devi जी, 21 Sep 2026 को दोबारा दिखाएँ।");
  });

  it("S11: the date is IST and its spelling does not depend on the runtime", () => {
    /*
      A consultation at 23:40 in Delhi is still THAT day's consultation. Read in UTC it is already
      tomorrow, and every evening clinic would print its follow-up a day out. This board has been
      bitten by an IST midnight straddle before (lab-reports D9).

      The spelling matters for the same reason the timezone does: `toLocaleDateString("en-IN", {
      month: "short" })` renders "Sept" on Node 22 with full ICU — measured — and "Sep" elsewhere.
      The browser, the print relay and CI are three different builds and this string reaches paper.
    */
    const lateEvening = new Date("2026-09-14T18:10:00.000Z"); // 23:40 IST on the 14th
    expect(expandSnippet("{today}", { ...FULL, now: lateEvening }).text).toBe("14 Sep 2026");
    expect(expandSnippet("{date+7}", { ...FULL, now: lateEvening }).text).toBe("21 Sep 2026");

    const justPastIstMidnight = new Date("2026-09-14T18:40:00.000Z"); // 00:10 IST on the 15th
    expect(expandSnippet("{today}", { ...FULL, now: justPastIstMidnight }).text).toBe("15 Sep 2026");

    // Every month, spelled the way a slip spells it, whatever ICU the runtime shipped with.
    const months = Array.from({ length: 12 }, (_, i) =>
      expandSnippet("{today}", { ...FULL, now: new Date(Date.UTC(2026, i, 10, 6, 0, 0)) }).text.split(" ")[1]);
    expect(months).toEqual(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]);
  });

  it("S10: every documented placeholder resolves against a full record", () => {
    /* The reference panel renders PLACEHOLDERS; this is what stops it documenting a token the
       resolver does not implement, which is the drift a hand-written list always develops. */
    for (const p of PLACEHOLDERS) {
      expect(p.resolve(FULL), `${p.token} resolved null against a full record`).not.toBeNull();
      expect(p.describe.length).toBeGreaterThan(3);
    }
  });
});

describe("unknownTokensIn", () => {
  it("U1: names a typo at SAVE time, when a human is still looking at it", () => {
    expect(unknownTokensIn("for {wieght} kg on {date+7} for {name}")).toEqual(["wieght"]);
  });
  it("U2: says nothing about the legal forms", () => {
    expect(unknownTokensIn("{name} {date+7} {date-2} {?} {?hint} {{literal}}")).toEqual([]);
  });
});

describe("keywordProblem", () => {
  it("K1: a keyword must not start inside a word — auto-expansion fires while typing", () => {
    /* `rest` would detonate inside "rest and fluids", "arrest" and "restrict". */
    expect(keywordProblem("rest")).toBe("lead");
    expect(keywordProblem(";rest")).toBeNull();
    expect(keywordProblem("/rest")).toBeNull();
  });
  it("K2: refuses a bare lead character and any keyword with a space in it", () => {
    expect(keywordProblem(";")).toBe("short");
    expect(keywordProblem(";two words")).toBe("space");
  });
  it("K3: no keyword at all is legal — that snippet is tapped rather than typed", () => {
    expect(keywordProblem("")).toBeNull();
    expect(keywordProblem("   ")).toBeNull();
  });
});

describe("keywordEndingAt", () => {
  const keys = [";uri", ";uri2", ";rest"];
  it("M1: matches only where the keyword ENDS at the caret", () => {
    expect(keywordEndingAt("take ;rest", 10, keys)).toEqual({ keyword: ";rest", start: 5 });
    expect(keywordEndingAt("take ;rest now", 14, keys)).toBeNull();
  });
  it("M2: the LONGEST match wins, or the longer keyword could never be typed", () => {
    // With `;uri` winning, a doctor typing `;uri2` would have it expand at the fourth character.
    expect(keywordEndingAt(";uri2", 5, keys)).toEqual({ keyword: ";uri2", start: 0 });
  });
  it("M3: nothing matches an empty keyword", () => {
    expect(keywordEndingAt("anything", 8, [""])).toBeNull();
  });
});
