import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toBase64 } from "../src/consult/recorder";
import {
  adviceOf, applySet, changeLine, changedChars, emptyDraft, isEmptyDraft, lineComplete, noteBody, overridesOf, parseDraft, repeatLast, setBodyOf,
  unanswered, warningsOf, wireLine,
} from "../src/consult/rules";
import type { ConsultDraft, ConsultLine, WirePrecheck } from "../src/consult/rules";

const food = { before: "before food", after: "after food" };
const days = (n: number): string => `${String(n)} days`;
const review = (n: number): string => `Review after ${String(n)} days`;
const line = (over: Partial<ConsultLine> = {}): ConsultLine => ({ drug: "Paracetamol 500 mg Tablet", dose: "1 tab", frequency: "TDS", durationDays: 5, food: "after", instructions: "", route: "oral", medicineId: "m1", mark: null, was: null, ...over });
const draft = (over: Partial<ConsultDraft> = {}): ConsultDraft => ({ ...emptyDraft("e1", 1), ...over });
const NONE: WirePrecheck = { allergyMatches: [], interactions: [], duplicates: [], drugDisease: [] };

describe("phone consult — the reading rules (one file, shared; packages/contracts/src/phone-consult.ts)", () => {
  it("the phone holds no copy of the rules: its rules module is a re-export of the shared file", () => {
    const src = readFileSync(join(__dirname, "..", "src", "consult", "rules.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").trim();
    expect(src).toBe('export * from "../../../../packages/contracts/src/phone-consult";');
    // …and the shared file imports nothing, so the phone (outside the workspace) can read it by path.
    expect(readFileSync(join(__dirname, "..", "..", "..", "packages", "contracts", "src", "phone-consult.ts"), "utf8")).not.toMatch(/^\s*import\s/m);
  });

  it("a line goes on the wire as the issue route takes it — food and instructions as one sentence, the route defaulted", () => {
    expect(wireLine(line({ instructions: "with water" }), food)).toEqual({
      drug: "Paracetamol 500 mg Tablet", dose: "1 tab", route: "oral", frequency: "TDS", durationDays: 5, instructions: "after food · with water", noSubstitution: false, medicineId: "m1",
    });
    expect(wireLine(line({ food: null, route: "", medicineId: null }), food)).toEqual({ drug: "Paracetamol 500 mg Tablet", dose: "1 tab", route: "oral", frequency: "TDS", durationDays: 5, instructions: null, noSubstitution: false });
    expect(lineComplete(line({ dose: "" }))).toBe(false);
  });

  it("the note names the draft's fate: rows while unissued, NULL once issued — and diagnosis may be absent", () => {
    const d = draft({ complaints: ["Fever", "Cough"], notes: " chest clear ", lines: [line()], adviceChips: ["Rest"], adviceText: "Plenty of fluids", reviewDays: 5 });
    const open = noteBody(d, review, food, "draft");
    expect(open).toMatchObject({ chiefComplaint: "Fever, Cough", doctorNote: "chest clear", diagnoses: null, advice: "Rest. Plenty of fluids. Review after 5 days.", advisedTests: null });
    expect((open.rxDraft as unknown[]).length).toBe(1);
    expect(noteBody(d, review, food, "issued").rxDraft).toBeNull();
    expect(adviceOf(draft(), review)).toBeNull();
    expect(isEmptyDraft(draft())).toBe(true);
    expect(isEmptyDraft(d)).toBe(false);
  });

  it("a hard warning is unanswered until a reason of three letters is typed, and the reason rides the right override array", () => {
    const lines = [line({ drug: "Amoxicillin 500 mg" }), line({ drug: "Azithromycin 500 mg" })];
    const p: WirePrecheck = {
      allergyMatches: [{ lineIndex: 0, substance: "Penicillin" }],
      interactions: [{ severity: "severe", lineIndex: 1, saltPair: ["azithromycin", "ondansetron"], note: "QT", against: { scope: "in_rx", lineIndex: 0 } }, { severity: "moderate", lineIndex: 1, saltPair: ["a", "b"], note: "mild", against: { scope: "in_rx" } }],
      duplicates: [{ moiety: "paracetamol", lineIndex: 0, hard: true }],
      drugDisease: [{ severity: "severe", lineIndex: 1, moiety: "azithromycin", icd10Prefix: "I45", icd10Title: "Conduction disorder", diagnosis: { text: "x" } }],
    };
    const ws = warningsOf(p, lines);
    expect(ws.map((w) => [w.kind, w.hard, w.lineIndex])).toEqual([["allergy", true, 0], ["interaction", true, 1], ["interaction", false, 1], ["duplicate", true, 0], ["disease", true, 1]]);
    expect(unanswered(ws, {})).toHaveLength(4);
    const reasons: Record<string, string> = {};
    for (const w of ws.filter((x) => x.hard)) reasons[w.key] = "ok";
    expect(unanswered(ws, reasons)).toHaveLength(4); // two letters is not a reason
    for (const w of ws.filter((x) => x.hard)) reasons[w.key] = "tolerated before";
    expect(unanswered(ws, reasons)).toEqual([]);
    expect(overridesOf(ws, reasons)).toEqual({
      overrides: [{ lineIndex: 0, substance: "Penicillin", reason: "tolerated before" }],
      interactionOverrides: [{ lineIndex: 1, reason: "tolerated before", saltPair: ["azithromycin", "ondansetron"] }],
      duplicateOverrides: [{ lineIndex: 0, reason: "tolerated before", moiety: "paracetamol" }],
      drugDiseaseOverrides: [{ lineIndex: 1, reason: "tolerated before", moiety: "azithromycin", icd10Prefix: "I45" }],
    });
    // A reason belongs to the DRUG it was typed for: remove that line and the reason answers nothing.
    expect(unanswered(warningsOf({ ...NONE, allergyMatches: [{ lineIndex: 0, substance: "Penicillin" }] }, [line({ drug: "Ampicillin 250 mg" })]), reasons)).toHaveLength(1);
    expect(warningsOf(null, lines)).toEqual([]);
  });

  it("Repeat last and a set fill the visit; a changed line remembers what it was; a set never adds a drug twice", () => {
    const repeated = repeatLast(draft(), { serviceDate: "2026-09-12", lines: [{ drug: "Metformin 500 mg", dose: "1 tab", route: "oral", frequency: "BD", durationDays: 30, instructions: "after food" }] }, 5);
    expect(repeated.from).toBe("repeat:2026-09-12");
    expect(repeated.lines[0]).toMatchObject({ drug: "Metformin 500 mg", food: "after", instructions: "" });
    const changed = changeLine(repeated, 0, { ...repeated.lines[0]!, durationDays: 15 }, days, 6);
    expect(changed.lines[0]).toMatchObject({ mark: "changed", was: "Metformin 500 mg · 1 tab · BD · 30 days" });

    const set = { lines: [{ drug: "Metformin 500 mg", dose: "1 tab", route: "oral", frequency: "BD", durationDays: 30, instructions: null }, { drug: "Cetirizine 10 mg", dose: "1 tab", route: "oral", frequency: "HS", durationDays: 5, instructions: null }], tests: [{ serviceId: "s1", code: "CBC", name: "CBC" }], advice: "Rest", reviewDays: 5 };
    const filled = applySet(changed, "Viral fever", set, () => 25000, 7);
    expect(filled.lines.map((l) => l.drug)).toEqual(["Metformin 500 mg", "Cetirizine 10 mg"]);
    expect(filled.tests).toEqual([{ serviceId: "s1", code: "CBC", name: "CBC", pricePaise: 25000 }]);
    expect(filled).toMatchObject({ adviceText: "Rest", reviewDays: 5, from: "Viral fever" });
    // "Save as a set" carries lines, tests, advice, review — and nothing about the patient.
    expect(Object.keys(setBodyOf(filled, food)).sort()).toEqual(["advice", "lines", "reviewDays", "tests"]);
  });

  it("a stored draft is this visit's or it is nothing", () => {
    const d = draft({ lines: [line()] });
    expect(parseDraft(JSON.stringify(d), "e1")?.lines).toHaveLength(1);
    expect(parseDraft(JSON.stringify(d), "e2")).toBeNull();
    expect(parseDraft("{not json", "e1")).toBeNull();
    expect(parseDraft(null, "e1")).toBeNull();
  });

  it("the voice meter counts changed characters, never words", () => {
    expect(changedChars("bukhar teen din se", "bukhar teen din se")).toBe(0);
    expect(changedChars("pan forty", "Pan 40")).toBe(6);
    expect(changedChars("", "abc")).toBe(3);
  });

  it("a clip becomes base64 without a Buffer", () => {
    expect(toBase64(new Uint8Array([65, 66, 67]))).toBe("QUJD");
    expect(toBase64(new Uint8Array([65, 66]))).toBe("QUI=");
    expect(toBase64(new Uint8Array([65]))).toBe("QQ==");
  });
});
