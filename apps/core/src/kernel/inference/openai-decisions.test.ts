import { chooserChain, chooserFor, openAiDecisionsClient } from "./openai-decisions";
import { InferenceUnavailable } from "./types";
import type { ChoiceClient, ChooseInput, ChooseResult } from "./types";

/**
 * THE OPENAI DECISIONS CLIENT — what goes on the wire, every way the reply can be unusable, and the
 * chain that puts two choosers in a configured order. Same property as `typesafe.test.ts`: nothing
 * the provider sends back can become a choice we did not offer. Hand-rolled recorders, no `jest.fn`.
 */
const CONFIG = { baseUrl: "https://api.openai.example/v1/", model: "gpt-6-luna", timeoutMs: 1000 };
const KEY = (): string | null => "k-test";

const INPUT: ChooseInput = {
  state: { complaint: "gala kharab hai" },
  questions: {
    department: {
      instructions: "Which department?",
      options: { ENT: "ear, nose, throat", "General Medicine": null, tool: { what: "a thing", examples: ["a", "b"] }, "none of these": "not a health complaint" },
    },
  },
};

type Sent = { url: string; init: RequestInit };
function answering(status: number, body: unknown): { fetchImpl: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

const choice = (over: Record<string, unknown> = {}) => ({
  type: "choice", name: "department", choice: "ENT", confidence: 0.93,
  probabilities: [
    { value: "ENT", probability: 0.95 }, { value: "General Medicine", probability: 0.03 },
    { value: "tool", probability: 0 }, { value: "none of these", probability: 0.02 },
  ],
  ...over,
});
const GOOD = { model: "gpt-6-luna", answers: [choice()], usage: { input_tokens: 300 } };

async function reason(p: Promise<unknown> | undefined): Promise<string> {
  try {
    await p;
    return "resolved";
  } catch (e) {
    return e instanceof InferenceUnavailable ? e.reason : `other: ${String(e)}`;
  }
}

describe("openAiDecisionsClient", () => {
  it("is null with no key — an unconfigured provider is a supported way to run", () => {
    expect(openAiDecisionsClient(CONFIG, () => null)).toBeNull();
  });

  it("sends the pinned model, the state by name and each question as a choice over the offered options", async () => {
    const { fetchImpl, sent } = answering(200, GOOD);
    const out = await openAiDecisionsClient(CONFIG, KEY, fetchImpl)?.choose(INPUT);
    expect(out).toEqual({
      answers: { department: { choice: "ENT", confidence: 0.93, probabilities: { ENT: 0.95, "General Medicine": 0.03, tool: 0, "none of these": 0.02 } } },
      model: "gpt-6-luna",
    });
    expect(sent[0]?.url).toBe("https://api.openai.example/v1/decisions");
    expect((sent[0]?.init.headers as Record<string, string>).Authorization).toBe("Bearer k-test");
    expect(JSON.parse(String(sent[0]?.init.body))).toEqual({
      model: "gpt-6-luna",
      input: "complaint: gala kharab hai",
      questions: [{
        type: "choice", name: "department", instructions: "Which department?",
        choices: [
          { value: "ENT", description: "ear, nose, throat" },
          { value: "General Medicine" },
          { value: "tool", description: "what: a thing; examples: a | b" },
          { value: "none of these", description: "not a health complaint" },
        ],
      }],
    });
  });

  it("reads the key on every call, so a rotated key needs no restart — and a key that vanished is not_configured", async () => {
    const { fetchImpl, sent } = answering(200, GOOD);
    let key: string | null = "k-one";
    const client = openAiDecisionsClient(CONFIG, () => key, fetchImpl);
    await client?.choose(INPUT);
    key = "k-two";
    await client?.choose(INPUT);
    expect(sent.map((s) => (s.init.headers as Record<string, string>).Authorization)).toEqual(["Bearer k-one", "Bearer k-two"]);
    key = null;
    expect(await reason(client?.choose(INPUT))).toBe("not_configured");
  });

  it.each([
    ["a non-2xx", 429, GOOD],
    ["a refusal in place of an answer", 200, { answers: [{ type: "refusal", name: "department" }] }],
    ["a missing answer", 200, { answers: [] }],
    ["a choice we did not offer", 200, { answers: [choice({ choice: "Cardiology" })] }],
    ["a confidence that is not a probability", 200, { answers: [choice({ confidence: 1.4 })] }],
    ["a distribution naming an option we did not offer", 200, { answers: [choice({ probabilities: [{ value: "Cardiology", probability: 1 }] })] }],
    ["a distribution that is not a list", 200, { answers: [choice({ probabilities: { ENT: 1 } })] }],
    ["a body that is not the shape", 200, { nope: true }],
  ])("refuses %s as provider_failed — never partly trusted", async (_name, status, body) => {
    const { fetchImpl } = answering(status, body);
    expect(await reason(openAiDecisionsClient(CONFIG, KEY, fetchImpl)?.choose(INPUT))).toBe("provider_failed");
  });

  it("says timeout when the provider is slower than the budget", async () => {
    const fetchImpl = ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => { reject(Object.assign(new Error("aborted"), { name: "AbortError" })); });
    })) as unknown as typeof fetch;
    expect(await reason(openAiDecisionsClient({ ...CONFIG, timeoutMs: 5 }, KEY, fetchImpl)?.choose(INPUT))).toBe("timeout");
  });

  it("predicate() returns the probability a condition is true, and refuses anything that is not one", async () => {
    const ok = answering(200, { answers: [{ type: "predicate", name: "p", probability: 0.92 }] });
    const client = openAiDecisionsClient(CONFIG, KEY, ok.fetchImpl);
    expect(await client?.predicate({ state: { term: "pan forty" }, instructions: "Does `term` mean Pantoprazole 40 mg tablet?" })).toEqual({ probability: 0.92, model: "gpt-6-luna" });
    expect(JSON.parse(String(ok.sent[0]?.init.body))).toEqual({
      model: "gpt-6-luna", input: "term: pan forty",
      questions: [{ type: "predicate", name: "p", instructions: "Does `term` mean Pantoprazole 40 mg tablet?" }],
    });
    for (const body of [{ answers: [{ type: "refusal", name: "p" }] }, { answers: [{ type: "predicate", name: "p", probability: 2 }] }]) {
      const bad = answering(200, body);
      expect(await reason(openAiDecisionsClient(CONFIG, KEY, bad.fetchImpl)?.predicate({ state: {}, instructions: "x" }))).toBe("provider_failed");
    }
  });
});

describe("chooserChain — two choosers in a configured order", () => {
  const result = (choiceKey: string, confidence: number, model: string): ChooseResult => ({
    answers: { department: { choice: choiceKey, confidence, probabilities: { [choiceKey]: confidence } } }, model,
  });
  const fixed = (r: ChooseResult | "throw", calls: string[], name: string): ChoiceClient => ({
    choose: async () => {
      calls.push(name);
      if (r === "throw") throw new InferenceUnavailable("provider_failed");
      return r;
    },
  });

  it("is null with nobody configured, and the lone client itself with one", () => {
    expect(chooserChain([null, null], 0.6)).toBeNull();
    const only = fixed(result("ENT", 0.9, "a"), [], "a");
    expect(chooserChain([null, only], 0.6)).toBe(only);
  });

  it("takes the first chooser's answer when it is sure, and never calls the second", async () => {
    const calls: string[] = [];
    const chain = chooserChain([fixed(result("ENT", 0.9, "a"), calls, "a"), fixed(result("Eye", 0.99, "b"), calls, "b")], 0.6);
    expect((await chain?.choose(INPUT))?.model).toBe("a");
    expect(calls).toEqual(["a"]);
  });

  it("asks the second when the first is unsure on the FIRST question, or failed", async () => {
    for (const first of [result("ENT", 0.4, "a"), "throw" as const]) {
      const calls: string[] = [];
      const chain = chooserChain([fixed(first, calls, "a"), fixed(result("Eye", 0.8, "b"), calls, "b")], 0.6);
      expect((await chain?.choose(INPUT))?.model).toBe("b");
      expect(calls).toEqual(["a", "b"]);
    }
  });

  it("hands back the LAST answer when nobody is sure — the caller's own line then says unsure", async () => {
    const chain = chooserChain([fixed(result("ENT", 0.4, "a"), [], "a"), fixed(result("Eye", 0.5, "b"), [], "b")], 0.6);
    expect((await chain?.choose(INPUT))?.answers.department?.confidence).toBe(0.5);
  });

  it("throws only when every chooser failed", async () => {
    const chain = chooserChain([fixed("throw", [], "a"), fixed("throw", [], "b")], 0.6);
    expect(await reason(chain?.choose(INPUT))).toBe("provider_failed");
  });
});

describe("chooserFor — the one place a job's choosers are wired", () => {
  const typesafe = { baseUrl: "https://t.example/v1", apiKey: null, model: "jev-1.13.0", timeoutMs: 1000 };
  const decisions = { baseUrl: "https://o.example/v1", model: "gpt-6-luna", timeoutMs: 2500 };

  it("is null when no provider in the order has a key — the job then runs on its chat model alone, as before", () => {
    expect(chooserFor({ order: ["typesafe"], typesafe, decisions, openaiKeyFile: null, minConfidence: 0.6 })).toBeNull();
    expect(chooserFor({ order: ["typesafe", "openai"], typesafe, decisions, openaiKeyFile: "/no/such/key/file", minConfidence: 0.6 })).toBeNull();
  });

  it("with the default order and a TypeSafe key, OpenAI is never built even if its key exists", () => {
    const client = chooserFor({ order: ["typesafe"], typesafe: { ...typesafe, apiKey: "k" }, decisions, openaiKeyFile: "/no/such/key/file", minConfidence: 0.6 });
    expect(client).not.toBeNull();
    expect(client).not.toHaveProperty("predicate"); // the lone TypeSafe client, not a chain and not OpenAI's
  });
});
