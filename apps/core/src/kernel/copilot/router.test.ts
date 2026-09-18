import { IdentifierLeak } from "./mask";
import { routeQuestion } from "./router";
import type { CompleteInput, InferenceClient } from "../inference/types";

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
