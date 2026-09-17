import { describe, expect, it } from "@jest/globals";
import { assertNoIdentifiers, maskQuestion, rehydrate } from "./mask";

/**
 * FD-COPILOT T1 — THE TEST THAT IS THE WHOLE GUARANTEE.
 *
 * The desk copilot may reach a language model. The plan series makes the rule design law in as many
 * words — *"identified PHI never enters an inference request — any stage, any locus, ever"* — and a
 * rule of that shape is worth exactly as much as the test that fails when it is broken. So this
 * file is written before `mask.ts` exists, and every case below is a sentence a clerk could really
 * type at a counter.
 */
describe("maskQuestion", () => {
  it("masks a UHID and leaves the rest of the sentence alone", () => {
    const m = maskQuestion("has U00110012 been seen by doctor?");
    expect(m.masked).toBe("has <<P1>> been seen by doctor?");
    expect(m.slots["<<P1>>"]).toBe("U00110012");
  });

  it("masks a UHID inside a Hinglish sentence", () => {
    const m = maskQuestion("kya U00110012 ko doctor ne dekh liya?");
    expect(m.masked).toBe("kya <<P1>> ko doctor ne dekh liya?");
  });

  it("masks a visit number", () => {
    const m = maskQuestion("V2609150001 ka bill ban gaya?");
    expect(m.masked).toBe("<<P1>> ka bill ban gaya?");
    expect(m.slots["<<P1>>"]).toBe("V2609150001");
  });

  it("masks a ten-digit mobile number", () => {
    const m = maskQuestion("9876543210 wale patient ka status");
    expect(m.masked).toBe("<<P1>> wale patient ka status");
  });

  it("masks a bare digit run long enough to be an identifier", () => {
    // An identifier we do not recognise is still an identifier. The masker is deliberately
    // over-eager: a masked token costs a little routing accuracy, an unmasked one costs a patient.
    expect(maskQuestion("token 40012 kab aayega").masked).toBe("token <<P1>> kab aayega");
  });

  it("leaves short numbers alone — they are quantities, not identities", () => {
    // "4 baje", "10 minute", "2 line" are the language of a counter and carry nothing.
    expect(maskQuestion("4 baje wala appointment cancel karo").masked)
      .toBe("4 baje wala appointment cancel karo");
  });

  it("gives one identifier one placeholder however often it appears", () => {
    const m = maskQuestion("U00110012 ka bill, aur U00110012 ka token bhi");
    expect(m.masked).toBe("<<P1>> ka bill, aur <<P1>> ka token bhi");
    expect(Object.keys(m.slots)).toHaveLength(1);
  });

  it("numbers distinct identifiers in the order they appear", () => {
    const m = maskQuestion("U00110012 aur U00110099 dono ko dekh liya?");
    expect(m.masked).toBe("<<P1>> aur <<P2>> dono ko dekh liya?");
    expect(m.slots["<<P2>>"]).toBe("U00110099");
  });

  /**
   * ═══ THE CASE THE SHAPE-MATCHERS CANNOT REACH, AND WHY THE CALLER SUPPLIES IT ═══
   *
   * A UHID has a shape. A NAME does not — "has Farida been seen?" carries a patient's identity in a
   * token no regular expression can tell from an English word. The screen, however, always knows:
   * the clerk is looking at a row it just fetched. So the caller passes the names it is displaying
   * and they are masked by value rather than by shape. This is the one part of the guarantee that
   * the server cannot enforce alone, and naming it here is the point.
   */
  it("masks caller-supplied terms — the names the screen knows it is showing", () => {
    const m = maskQuestion("has Farida Khatoon been seen?", ["Farida Khatoon"]);
    expect(m.masked).toBe("has <<P1>> been seen?");
  });

  it("masks a caller-supplied term whatever case the clerk typed it in", () => {
    const m = maskQuestion("farida ko doctor ne dekha?", ["Farida"]);
    expect(m.masked).toBe("<<P1>> ko doctor ne dekha?");
  });

  it("masks a Devanagari name the screen supplied", () => {
    const m = maskQuestion("क्या फरीदा को डॉक्टर ने देख लिया?", ["फरीदा"]);
    expect(m.masked).toBe("क्या <<P1>> को डॉक्टर ने देख लिया?");
  });

  it("keeps Devanagari that is not an identifier", () => {
    expect(maskQuestion("कितना इंतज़ार है?").masked).toBe("कितना इंतज़ार है?");
  });
});

describe("rehydrate", () => {
  it("turns a placeholder back into the identifier the clerk typed", () => {
    const m = maskQuestion("has U00110012 been seen?");
    expect(rehydrate("<<P1>>", m.slots)).toBe("U00110012");
  });

  it("returns null for a placeholder that was never issued", () => {
    // The model is free to invent `<<P9>>`. Inventing one must not resolve to somebody else.
    const m = maskQuestion("has U00110012 been seen?");
    expect(rehydrate("<<P9>>", m.slots)).toBeNull();
  });

  it("returns null when the model echoes a literal identifier instead of the placeholder", () => {
    // If this ever happens the identifier did not come from us — it came from the model's own
    // guess. Resolving it would make a hallucinated UHID into a real patient's record.
    const m = maskQuestion("has U00110012 been seen?");
    expect(rehydrate("U00110012", m.slots)).toBeNull();
  });
});

/**
 * ═══ THE SCRUBBER: THE LAST THING THAT RUNS BEFORE THE BODY GOES ON THE WIRE ═══
 *
 * `maskQuestion` is the intention and this is the enforcement. They are separate because the
 * failure that matters is a masker bug, and a masker cannot be its own witness. Anything
 * identifier-shaped still standing here means the request does not leave the building.
 */
describe("assertNoIdentifiers", () => {
  it("passes a properly masked question", () => {
    expect(() => { assertNoIdentifiers("has <<P1>> been seen by doctor?"); }).not.toThrow();
  });

  it("refuses a UHID", () => {
    expect(() => { assertNoIdentifiers("has U00110012 been seen?"); }).toThrow(/identifier/i);
  });

  it("refuses a mobile number", () => {
    expect(() => { assertNoIdentifiers("call 9876543210"); }).toThrow(/identifier/i);
  });

  it("refuses a long digit run", () => {
    expect(() => { assertNoIdentifiers("token 40012"); }).toThrow(/identifier/i);
  });

  it("allows the small numbers a counter actually says", () => {
    expect(() => { assertNoIdentifiers("4 baje wala slot"); }).not.toThrow();
  });
});
