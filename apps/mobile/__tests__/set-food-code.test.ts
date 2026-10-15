import { emptyDraft, linesFrom, setBodyOf } from "../src/consult/rules";
import type { ConsultDraft, ConsultLine } from "../src/consult/rules";

/**
 * A set's food timing is a CODE ("before" / "after"), the way the visit line keeps it, and is put
 * into words only when shown. A set saved while the phone was in Hindi used to store "खाने के बाद"
 * as its instructions; an English reader then saw Hindi. Sets saved before the code existed (English
 * or Hindi words) still read back as their code.
 */
const line = (over: Partial<ConsultLine>): ConsultLine => ({
  drug: "Paracetamol 500 mg Tablet", dose: "1 tab", frequency: "TDS", durationDays: 5, food: null, instructions: "", route: "oral", medicineId: "m-para", ...over,
});
const draftWith = (lines: ConsultLine[]): ConsultDraft => ({ ...emptyDraft("e1", 0), lines });

describe("a set's food timing is a language-neutral code", () => {
  it("setBodyOf stores the code and no food words, whatever language the screen is in", () => {
    const body = setBodyOf(draftWith([line({ food: "after" }), line({ drug: "Pantoprazole 40 mg Tablet", food: "before", instructions: "with water" }), line({ drug: "Cetirizine 10 mg Tablet" })]));
    expect(body.lines.map((l) => [l.food, l.instructions])).toEqual([["after", null], ["before", "with water"], [null, null]]);
    for (const l of body.lines) expect(l.instructions ?? "").not.toMatch(/खाने|before food|after food/i);
  });

  it("a coded set line reads back as its code", () => {
    const back = linesFrom([{ drug: "A", dose: "1", route: "oral", frequency: "OD", durationDays: 1, instructions: "with water", food: "before" }]);
    expect([back[0]!.food, back[0]!.instructions]).toEqual(["before", "with water"]);
  });

  it("an older set saved as English or Hindi words maps back to the code", () => {
    const back = linesFrom([
      { drug: "A", dose: "1", route: "oral", frequency: "OD", durationDays: 1, instructions: "after food" },
      { drug: "B", dose: "1", route: "oral", frequency: "OD", durationDays: 1, instructions: "खाने के बाद" },
      { drug: "C", dose: "1", route: "oral", frequency: "OD", durationDays: 1, instructions: "खाने से पहले · गुनगुने पानी से" },
      { drug: "D", dose: "1", route: "oral", frequency: "OD", durationDays: 1, instructions: "before food" },
    ]);
    expect(back.map((l) => [l.food, l.instructions])).toEqual([["after", ""], ["after", ""], ["before", "गुनगुने पानी से"], ["before", ""]]);
  });

  it("a round trip through a set keeps the code", () => {
    const back = linesFrom(setBodyOf(draftWith([line({ food: "after", instructions: "with milk" })])).lines);
    expect([back[0]!.food, back[0]!.instructions]).toEqual(["after", "with milk"]);
  });
});
