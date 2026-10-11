import { IdentifierLeak, maskQuestion } from "./mask";
import {
  assertNoNames, buildNameIndex, findNameSpans, foldName, maskForAsk, nameDays, nameIndexFor, NAME_CAP,
} from "./names";
import { routeQuestion } from "./router";
import type { ChoiceAnswer, ChoiceClient, ChooseInput, CompleteInput, InferenceClient } from "../inference/types";
import type { CopilotNameSource } from "./names";

/**
 * E0.6 — NAME-AWARE MASKING (spec /opt/hmis-context/SPEC-copilot-name-mask-2026-10-11.md).
 *
 * A UHID has a shape; a name does not. The phone sends no screen `terms`, so the server supplies the
 * names of the patients in the hospital today and masks them before the chooser or the chat model
 * could see the question. Recorders, not `jest.fn`, as `router.test.ts` does: what is asserted is
 * whether a call happened and exactly what was on the wire.
 */
type Model = { client: InferenceClient; calls: CompleteInput[] };
type Chooser = { client: ChoiceClient; calls: ChooseInput[] };

const model = (text: string): Model => {
  const calls: CompleteInput[] = [];
  return { calls, client: { complete: (input) => { calls.push(input); return Promise.resolve({ text }); } } };
};
const chooser = (given: Record<string, Omit<ChoiceAnswer, "probabilities">>): Chooser => {
  const calls: ChooseInput[] = [];
  const answers: Record<string, ChoiceAnswer> = Object.fromEntries(
    Object.entries(given).map(([id, a]) => [id, { ...a, probabilities: { [a.choice]: a.confidence } }]),
  );
  return { calls, client: { choose: (input) => { calls.push(input); return Promise.resolve({ answers, model: "rec-1" }); } } };
};

/** The day's list: an ordinary patient, a Devanagari registration, a confidential one, a kin name. */
const TODAY = ["Ramesh Kumar", "आशा देवी", "Farida Khatoon", "Sunil Verma", "Kal Singh"];
const index = buildNameIndex(TODAY);

/** A tail the phrasebook does not score, so every question below reaches the models. */
const TAIL = "abhi tak andar gaye ya nahi";

async function askThrough(question: string, terms: string[] = []) {
  const m = model('{"tool":"visit_status","slot":"<<P1>>"}');
  const c = chooser({ tool: { choice: "visit_status", confidence: 0.99 } });
  const mask = maskForAsk(question, terms, index);
  let leaked: unknown = null;
  try {
    await routeQuestion(mask.masked, mask.slots, m.client, c.client, 0.6, { names: mask.names, phrasebookOnly: mask.phrasebookOnly });
  } catch (e) { leaked = e; }
  const wire = JSON.stringify([...m.calls, ...c.calls]);
  return { mask, m, c, wire, leaked };
}

describe("E0.6 done-means 1 — an unmasked name never reaches a model", () => {
  it("with name masking switched off, a patient registered today makes zero chooser and zero model calls", async () => {
    const m = model('{"tool":"visit_status","slot":""}');
    const c = chooser({ tool: { choice: "visit_status", confidence: 0.99 } });
    // Masking OFF: the old path — identifier shapes only, no server names.
    const { masked, slots } = maskQuestion(`Ramesh ${TAIL}`, []);
    await expect(routeQuestion(masked, slots, m.client, c.client, 0.6, { names: index })).rejects.toBeInstanceOf(IdentifierLeak);
    expect(c.calls).toHaveLength(0);
    expect(m.calls).toHaveLength(0);
  });

  it("the witness names no text in its message", () => {
    expect(() => { assertNoNames(`Ramesh ${TAIL}`, index); }).toThrow(IdentifierLeak);
    try { assertNoNames(`Ramesh ${TAIL}`, index); } catch (e) { expect(String((e as Error).message)).not.toMatch(/ramesh/i); }
  });
});

describe("E0.6 done-means 2 — with masking, the wire carries <<Pn>> and never the name", () => {
  it.each([
    ["roman", `Ramesh ${TAIL}`, /ramesh/i],
    ["full name, any case", `ramesh KUMAR ${TAIL}`, /ramesh|kumar/i],
    ["Devanagari typed for a Devanagari registration", `आशा ${TAIL}`, /आशा/],
    ["roman typed for a Devanagari registration", `Asha ${TAIL}`, /asha/i],
    ["a spelling variant", `Aasha ${TAIL}`, /aasha/i],
    ["Devanagari typed for a roman registration", `रमेश ${TAIL}`, /रमेश/],
    ["the honorific", `Rameshji ${TAIL}`, /ramesh/i],
  ])("%s", async (_label, question, name) => {
    const { mask, wire, leaked, c } = await askThrough(question);
    expect(leaked).toBeNull();
    expect(mask.masked).toMatch(/<<P1>>/);
    expect(c.calls).toHaveLength(1);
    expect(wire).toMatch(/<<P1>>/);
    expect(wire).not.toMatch(name);
  });

  it("a confidential patient's real name and alias are both masked", async () => {
    const conf = buildNameIndex(["Farida Khatoon", "Patient Rose"]);
    for (const q of [`Farida ${TAIL}`, `Rose ${TAIL}`]) {
      const mask = maskForAsk(q, [], conf);
      expect(mask.masked).toBe(`<<P1>> ${TAIL}`);
    }
  });
});

describe("E0.6 done-means 3 — the web path's `terms` are unchanged", () => {
  it("with terms and no server-name hit, masked text and slots are byte-identical to maskQuestion", () => {
    for (const [q, terms] of [
      ["has Zubair Ansari been seen", ["Zubair Ansari"]],
      ["Pooja ka bill U12345013", ["Pooja"]],
      ["kitna wait hai", []],
    ] as const) {
      const before = maskQuestion(q, terms);
      const after = maskForAsk(q, terms, index);
      expect(after.masked).toBe(before.masked);
      expect(after.slots).toEqual(before.slots);
    }
  });

  it("a web term placeholder still rehydrates for a tool; a server-name placeholder never does", () => {
    const web = maskForAsk("Zubair ka bill", ["Zubair"], index);
    expect(web.nameSlots).toEqual([]);
    const phone = maskForAsk("Ramesh ka bill", [], index);
    expect(phone.nameSlots).toEqual(["<<P1>>"]);
  });

  it("terms run first, server names second, identifiers last, on one numbering", () => {
    const out = maskForAsk("Zubair aur Ramesh U12345013", ["Zubair"], index);
    expect(out.masked).toBe("<<P1>> aur <<P2>> <<P3>>");
    expect(out.slots).toEqual({ "<<P1>>": "Zubair", "<<P2>>": "Ramesh", "<<P3>>": "U12345013" });
  });
});

describe("E0.6 done-means 5 — near-spellings and a failed name source go phrasebook-only", () => {
  it("a near-match is masked and the ask makes zero model calls", async () => {
    const { mask, m, c } = await askThrough(`Rameshh ${TAIL}`);
    expect(mask.phrasebookOnly).toBe(true);
    expect(mask.masked).not.toMatch(/rameshh/i);
    expect(m.calls).toHaveLength(0);
    expect(c.calls).toHaveLength(0);
  });

  it("phrasebook-only still answers what the floor knows", async () => {
    const mask = maskForAsk("Rameshh ka kitna paisa baaki hai", [], index);
    expect(mask.phrasebookOnly).toBe(true);
    const out = await routeQuestion(mask.masked, mask.slots, model("{}").client, null, 0.6, { phrasebookOnly: true });
    expect(out?.via).toBe("phrasebook");
  });

  it("no name list at all (source failed) is phrasebook-only", () => {
    expect(maskForAsk(`Ramesh ${TAIL}`, [], null).phrasebookOnly).toBe(true);
  });

  it("a source that throws, hangs or overflows the cap yields no index", async () => {
    const throws: CopilotNameSource = () => Promise.reject(new Error("db down"));
    const hangs: CopilotNameSource = () => new Promise(() => undefined);
    const huge: CopilotNameSource = () => Promise.resolve(Array.from({ length: NAME_CAP + 1 }, (_, i) => `Name${String(i)}`));
    const days = nameDays(new Date(), "2026-01-01");
    for (const s of [throws, hangs, huge]) expect(await nameIndexFor(s, null as never, days, { timeoutMs: 20 })).toBeNull();
    const fine: CopilotNameSource = () => Promise.resolve(["Ramesh Kumar"]);
    expect(await nameIndexFor(fine, null as never, days)).not.toBeNull();
  });
});

describe("E0.6 done-means 6 — ordinary words stay words", () => {
  const tricky = buildNameIndex(["Ram Prasad", "Kal Singh", "Bill Gupta", "Rekha Rani"]);
  it.each([
    "aaram se baitho, kitna wait hai",
    "kal aana, kitna wait hai",
    "bill kitna hai",
    "doctor ne dekha kya",
  ])("%s", (q) => {
    const out = maskForAsk(q, [], tricky);
    expect(out.masked).toBe(q);
    expect(out.phrasebookOnly).toBe(false);
  });

  it("a stopword part is still masked inside the full name", () => {
    expect(maskForAsk("Kal Singh kitna wait hai", [], tricky).masked).toBe("<<P1>> kitna wait hai");
  });

  it("initials and two-letter parts never match", () => {
    const idx = buildNameIndex(["R K Om Sharma"]);
    expect(findNameSpans("R K om aaye", idx).spans).toEqual([]);
  });
});

describe("folding", () => {
  it("meets Asha, Aasha and आशा on one form", () => {
    expect(foldName("Aasha")).toBe(foldName("Asha"));
    expect(foldName("आशा")).toBe(foldName("Asha"));
    expect(foldName("रमेश")).toBe(foldName("Ramesh"));
  });
});

describe("nameDays", () => {
  it("visits today and yesterday (IST) plus the asked date; appointments today plus the asked date", () => {
    const d = nameDays(new Date("2026-10-11T02:00:00+05:30"), "2026-10-05");
    expect(d.visits.sort()).toEqual(["2026-10-05", "2026-10-10", "2026-10-11"]);
    expect(d.appointments.sort()).toEqual(["2026-10-05", "2026-10-11"]);
    expect(d.registeredSince.toISOString()).toBe("2026-10-10T18:30:00.000Z");
  });
});
