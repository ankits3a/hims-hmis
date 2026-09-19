import { IdentifierLeak } from "./mask";
import { intentNames } from "./phrasebook";
import { routeQuestion } from "./router";
import type { ChoiceAnswer, ChoiceClient, ChooseInput, CompleteInput, InferenceClient } from "../inference/types";

/**
 * FD-COPILOT T3 — THE ROUTER, AND THE FOUR WAYS A MODEL CAN BE WRONG.
 *
 * `modules/opd/triage.ts` set the precedent this follows: the model is handed a CLOSED menu and
 * replies with a member of it, so a department it invented cannot reach a screen. The copilot wants
 * the same property one step further out, because a wrong route here does not merely mis-suggest —
 * it runs a tool against a patient. So every answer from the model is checked against the menu the
 * floor itself is built from, and anything else is a miss.
 *
 * The fakes below are hand-rolled rather than `jest.fn`, following `triage.test.ts`'s injected
 * `fetchImpl`: this package has no `jest.fn` anywhere and a recorder says more plainly what is
 * being asserted — that a call did or did not happen, and exactly what was on the wire.
 */
type Recorder = { client: InferenceClient; calls: CompleteInput[] };

const say = (text: string): Recorder => {
  const calls: CompleteInput[] = [];
  return {
    calls,
    client: {
      complete: (input: CompleteInput) => {
        calls.push(input);
        return Promise.resolve({ text });
      },
    },
  };
};

const dead = (): Recorder => {
  const calls: CompleteInput[] = [];
  return {
    calls,
    client: {
      complete: (input: CompleteInput) => {
        calls.push(input);
        return Promise.reject(new Error("timeout"));
      },
    },
  };
};

/**
 * What a real masking pass would have issued for these questions. Passing `{}` here would be a
 * lighter test and a dishonest one: `resolveSlot` requires the placeholder to be one THIS question
 * actually minted, and a fixture that skipped that would not exercise the check.
 */
const ISSUED: Record<string, string> = { "<<P1>>": "U00110012" };

describe("routeQuestion — the floor answers first and for free", () => {
  it("does not call the model when the phrasebook matched", async () => {
    const model = say('{"tool":"queue_depth","slot":""}');
    const out = await routeQuestion("kitna wait hai", {}, model.client);
    expect(out?.intent).toBe("queue_depth");
    expect(out?.source).toBe("phrasebook");
    expect(model.calls).toHaveLength(0);
  });

  it("names its source, because advice whose origin is hidden is trusted too much", async () => {
    const out = await routeQuestion("has <<P1>> been seen by doctor?", ISSUED, say("{}").client);
    expect(out?.source).toBe("phrasebook");
  });
});

describe("routeQuestion — the model covers the tail", () => {
  it("routes a phrasing the floor has never seen", async () => {
    const model = say('{"tool":"visit_status","slot":"<<P1>>"}');
    // No cue in the table fires on this sentence; it is exactly what the model is for.
    const out = await routeQuestion("<<P1>> — any news from upstairs yet?", ISSUED, model.client);
    expect(out).toEqual({ intent: "visit_status", slot: "<<P1>>", source: "model", cues: [] });
    expect(model.calls).toHaveLength(1);
  });

  it("tolerates a model that wraps its JSON in prose or a code fence", async () => {
    const model = say('Sure!\n```json\n{"tool":"queue_depth","slot":""}\n```');
    const out = await routeQuestion("how are things upstairs", {}, model.client);
    expect(out?.intent).toBe("queue_depth");
  });
});

describe("routeQuestion — every way the model can be wrong is a miss, never a guess", () => {
  it("refuses a tool that is not on the menu", async () => {
    // The closed-menu property, and the reason it exists: an invented tool would otherwise run.
    const out = await routeQuestion("do the thing", {}, say('{"tool":"delete_patient","slot":""}').client);
    expect(out).toBeNull();
  });

  it("refuses the model's own way of saying it recognised nothing", async () => {
    const out = await routeQuestion("what is the weather", {}, say('{"tool":"none","slot":""}').client);
    expect(out).toBeNull();
  });

  it("refuses malformed JSON", async () => {
    expect(await routeQuestion("do the thing", {}, say("I think you want the queue?").client)).toBeNull();
  });

  it("drops a placeholder the question never contained", async () => {
    /*
      THE HALLUCINATED SLOT. The model may reply `<<P2>>` for a question carrying only `<<P1>>`.
      `rehydrate` would refuse it later, but dropping it here means the tool is asked to run with no
      patient rather than with a wrong one, and refuses for a reason a clerk can read.
    */
    const model = say('{"tool":"visit_status","slot":"<<P2>>"}');
    const out = await routeQuestion("<<P1>> — any news?", ISSUED, model.client);
    expect(out?.slot).toBeNull();
  });

  it("returns a miss when the provider is unreachable", async () => {
    // A timeout is an ORDINARY outcome (triage.ts's rule). The desk says it did not understand.
    expect(await routeQuestion("something novel here", {}, dead().client)).toBeNull();
  });

  it("returns a miss when no provider is configured at all", async () => {
    // The whole copilot must work with the model switched off — phrasebook only.
    expect(await routeQuestion("something novel here", {}, null)).toBeNull();
  });
});

/**
 * ═══ THE TEST THIS ENTIRE MODULE EXISTS FOR ═══
 *
 * Plan 12a, scope item 3, verbatim: *"per-job data minimisation is the caller's contract
 * (de-identified, minimum-necessary context), asserted by tests that the request body contains no
 * identifier fields."* This is that assertion. It is a THROW rather than a silent skip because a
 * router that quietly declined to route would look, from the desk, exactly like one that worked —
 * and the masker bug behind it would live forever.
 */
describe("routeQuestion — an unmasked question never reaches the provider", () => {
  it("refuses to send a question still carrying a UHID", async () => {
    const model = say('{"tool":"visit_status","slot":""}');
    await expect(routeQuestion("has U00110012 popped up anywhere", {}, model.client))
      .rejects.toBeInstanceOf(IdentifierLeak);
    expect(model.calls).toHaveLength(0);
  });

  it("refuses to send a question still carrying a phone number", async () => {
    const model = say('{"tool":"visit_status","slot":""}');
    await expect(routeQuestion("anything on 9876543210 yet", {}, model.client))
      .rejects.toBeInstanceOf(IdentifierLeak);
    expect(model.calls).toHaveLength(0);
  });

  it("never names the identifier it caught, not even in the exception", () => {
    // An exception ends up in a log. A scrubber that printed what it caught would BE the leak.
    try {
      throw new IdentifierLeak("U00110012");
    } catch (e) {
      expect((e as Error).message).not.toContain("U00110012");
    }
  });

  it("does not even check when the floor already answered — nothing is sent at all", async () => {
    const model = say("{}");
    expect((await routeQuestion("kitna wait hai", {}, model.client))?.source).toBe("phrasebook");
    expect(model.calls).toHaveLength(0);
  });

  it("sends the masked question and a closed menu, and nothing else", async () => {
    const model = say('{"tool":"visit_status","slot":"<<P1>>"}');
    await routeQuestion("<<P1>> — any news?", ISSUED, model.client);
    const sent = model.calls[0];
    expect(sent?.user).toBe("<<P1>> — any news?");
    // The menu is derived from the floor's own table, so the two halves cannot disagree.
    expect(sent?.system).toContain("visit_status");
    expect(sent?.system).toContain("my_day_report");
    // Nothing identifier-shaped is in the prompt this module writes, either.
    expect(sent?.system).not.toMatch(/\d{5,}/);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * 2026-09-19 — TYPESAFE FIRST, THE CHAT MODEL BEHIND IT
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner: *"keep typesafe as priority and the groq as fallback"*. TypeSafe answers a CLOSED choice —
 * the menu is the API's own answer space, not a regex over prose — and says how sure it is. So the
 * order after the floor is: a confident choice routes; a confident "none" is a miss; anything else
 * (unsure, unreachable, malformed) is handed to the chat model exactly as before.
 *
 * Measured on this box over 64 counter questions (English, Hinglish, Devanagari, 15 out-of-scope):
 * TypeSafe 63/64 with ZERO wrong at confidence >= 0.6; the one miss scored 0.43, below the line, so
 * it falls through — and the chat model answered it.
 */
type Chooser = { client: ChoiceClient; calls: ChooseInput[] };

/** The router reads only the choice and its confidence; the distribution is filled in to match. */
const picks = (given: Record<string, Omit<ChoiceAnswer, "probabilities">>): Chooser => {
  const calls: ChooseInput[] = [];
  const answers: Record<string, ChoiceAnswer> = Object.fromEntries(
    Object.entries(given).map(([id, a]) => [id, { ...a, probabilities: { [a.choice]: a.confidence } }]),
  );
  return {
    calls,
    client: {
      choose: (input: ChooseInput) => {
        calls.push(input);
        return Promise.resolve({ answers, model: "jev-1.13.0" });
      },
    },
  };
};

const unreachable = (): Chooser => {
  const calls: ChooseInput[] = [];
  return {
    calls,
    client: {
      choose: (input: ChooseInput) => {
        calls.push(input);
        return Promise.reject(new Error("timeout"));
      },
    },
  };
};

/** A tail phrasing the phrasebook does not score — so every test below reaches the models. */
const TAIL = "<<P1>> abhi tak andar gaye ya nahi";

describe("routeQuestion — TypeSafe first", () => {
  it("routes on a confident choice, and the chat model is never asked", async () => {
    const chooser = picks({ tool: { choice: "visit_status", confidence: 0.99 } });
    const model = say('{"tool":"queue_depth","slot":""}');
    const out = await routeQuestion(TAIL, ISSUED, model.client, chooser.client);
    expect(out).toEqual({ intent: "visit_status", slot: "<<P1>>", source: "model", cues: [] });
    expect(model.calls).toHaveLength(0);
  });

  it("a confident 'none' is a miss — the chat model is not asked to overrule it", async () => {
    const chooser = picks({ tool: { choice: "none", confidence: 0.97 } });
    const model = say('{"tool":"visit_status","slot":"<<P1>>"}');
    expect(await routeQuestion("canteen kab khulega", {}, model.client, chooser.client)).toBeNull();
    expect(model.calls).toHaveLength(0);
  });

  it("below the confidence line the chat model is asked, and its answer is used", async () => {
    const chooser = picks({ tool: { choice: "none", confidence: 0.43 } });
    const model = say('{"tool":"patient_dues","slot":"<<P1>>"}');
    const out = await routeQuestion("kitna lena hai <<P1>> se", ISSUED, model.client, chooser.client);
    expect(out?.intent).toBe("patient_dues");
    expect(model.calls).toHaveLength(1);
  });

  it("the line is the caller's: the same answer routes at 0.5 and falls through at 0.9", async () => {
    const at = (line: number) => routeQuestion(TAIL, ISSUED, null, picks({ tool: { choice: "visit_status", confidence: 0.7 } }).client, line);
    expect((await at(0.5))?.intent).toBe("visit_status");
    expect(await at(0.9)).toBeNull();
  });

  it("an unreachable TypeSafe costs nothing but the fallback", async () => {
    const chooser = unreachable();
    const model = say('{"tool":"visit_status","slot":"<<P1>>"}');
    const out = await routeQuestion(TAIL, ISSUED, model.client, chooser.client);
    expect(out?.intent).toBe("visit_status");
    expect(chooser.calls).toHaveLength(1);
    expect(model.calls).toHaveLength(1);
  });

  it("a choice that is not on the menu is treated as unsure, never trusted", async () => {
    const chooser = picks({ tool: { choice: "delete_patient", confidence: 1 } });
    const model = say('{"tool":"none","slot":""}');
    expect(await routeQuestion(TAIL, ISSUED, model.client, chooser.client)).toBeNull();
    expect(model.calls).toHaveLength(1);
  });

  it("with TypeSafe alone, an unsure answer is an honest miss", async () => {
    const chooser = picks({ tool: { choice: "visit_status", confidence: 0.3 } });
    expect(await routeQuestion(TAIL, ISSUED, null, chooser.client)).toBeNull();
  });

  it("the scrubber runs before TypeSafe too — an unmasked question never reaches it", async () => {
    const chooser = picks({ tool: { choice: "visit_status", confidence: 1 } });
    await expect(routeQuestion("U00110012 abhi tak andar gaye ya nahi", {}, null, chooser.client)).rejects.toBeInstanceOf(IdentifierLeak);
    expect(chooser.calls).toHaveLength(0);
  });

  it("sends the masked question and every tool on the menu plus 'none' — and nothing else", async () => {
    const chooser = picks({ tool: { choice: "none", confidence: 1 } });
    await routeQuestion(TAIL, ISSUED, null, chooser.client);
    const sent = chooser.calls[0];
    expect(sent?.state).toEqual({ question: TAIL });
    expect(Object.keys(sent?.questions ?? {})).toEqual(["tool"]);
    expect(Object.keys(sent?.questions.tool?.options ?? {}).sort()).toEqual([...intentNames(), "none"].sort());
    expect(JSON.stringify(sent)).not.toContain("U00110012");
  });
});

describe("routeQuestion — which patient, when TypeSafe routes", () => {
  it("one placeholder in the question IS the subject; nobody is asked", async () => {
    const chooser = picks({ tool: { choice: "visit_status", confidence: 0.99 } });
    const out = await routeQuestion(TAIL, ISSUED, null, chooser.client);
    expect(out?.slot).toBe("<<P1>>");
    expect(Object.keys(chooser.calls[0]?.questions ?? {})).toEqual(["tool"]);
  });

  it("no placeholder, no subject", async () => {
    const chooser = picks({ tool: { choice: "queue_depth", confidence: 0.99 } });
    expect((await routeQuestion("naye patient ko kitna rukna padega", {}, null, chooser.client))?.slot).toBeNull();
  });

  /*
    TWO PATIENTS IN ONE QUESTION. Asked in the SAME request (TypeSafe evaluates every question
    against one state in parallel), over the placeholders this question minted and "none" — so a
    subject can only ever be somebody the clerk typed. Unsure means no subject, and the tool then
    says "which patient?" rather than guessing one.
  */
  it("two placeholders: the subject is a second choice over exactly those two", async () => {
    const two = { "<<P1>>": "U00110012", "<<P2>>": "U00110020" };
    const q = "<<P1>> ya <<P2>>, kaun andar gaya";
    const chooser = picks({ tool: { choice: "visit_status", confidence: 0.95 }, subject: { choice: "<<P2>>", confidence: 0.9 } });
    const out = await routeQuestion(q, two, null, chooser.client);
    expect(Object.keys(chooser.calls[0]?.questions.subject?.options ?? {}).sort()).toEqual(["<<P1>>", "<<P2>>", "none"]);
    expect(out?.slot).toBe("<<P2>>");
  });

  it("an unsure subject is no subject", async () => {
    const two = { "<<P1>>": "U00110012", "<<P2>>": "U00110020" };
    const chooser = picks({ tool: { choice: "visit_status", confidence: 0.95 }, subject: { choice: "<<P1>>", confidence: 0.5 } });
    expect((await routeQuestion("<<P1>> ya <<P2>>, kaun andar gaya", two, null, chooser.client))?.slot).toBeNull();
  });
});

/*
  ═══ THE FALLBACK HAD NEVER HAD ROOM TO ANSWER ═══

  Measured 2026-09-19 against the live gateway: `openai/gpt-oss-120b` is a REASONING model and spends
  62-74 tokens thinking before it writes the JSON. At `max_tokens: 64` the reply came back
  `finish_reason: "length"` with EMPTY content on the owner's own sentence ("kya <<P1>> ko doctor ne
  dekh liya?") — and an empty reply is a miss, so the desk said "I did not understand" and nothing
  anywhere said why. 8 of 64 counter questions got through; at 512, 59 did.
*/
it("the chat model is given room to think before it answers", async () => {
  const model = say('{"tool":"visit_status","slot":"<<P1>>"}');
  await routeQuestion(TAIL, ISSUED, model.client);
  expect(model.calls[0]?.maxTokens).toBeGreaterThanOrEqual(256);
});
