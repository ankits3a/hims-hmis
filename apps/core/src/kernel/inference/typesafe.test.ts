import { typesafeClient } from "./typesafe";
import { InferenceUnavailable } from "./types";
import type { ChooseInput } from "./types";

/**
 * THE TYPESAFE CLIENT — what goes on the wire, and every way the reply can be unusable.
 *
 * The router treats any `InferenceUnavailable` as "ask the fallback", so the property that matters
 * here is that nothing the provider sends back can become a choice we did not offer. Hand-rolled
 * recorders rather than `jest.fn`, as `router.test.ts` explains.
 */
const CONFIG = { baseUrl: "https://api.typesafe.example/v1/", apiKey: "k-test", model: "jev-1.13.0", timeoutMs: 1000 };

const INPUT: ChooseInput = {
  state: { question: "<<P1>> abhi tak andar gaye ya nahi" },
  questions: { tool: { instructions: "Which tool?", options: { visit_status: "seen yet?", none: "anything else" } } },
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

const GOOD = {
  model: "jev-1.13.0",
  answers: { tool: { type: "choice", choice: "visit_status", confidence: 0.99, probabilities: { visit_status: 0.99, none: 0.01 } } },
  usage: { input_tokens: 300, output_tokens: 40 },
};

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "resolved";
  } catch (e) {
    return e instanceof InferenceUnavailable ? e.reason : `other: ${String(e)}`;
  }
}

describe("typesafeClient", () => {
  it("is null with no key — an unconfigured provider is a supported way to run", () => {
    expect(typesafeClient({ ...CONFIG, apiKey: null })).toBeNull();
  });

  it("sends the pinned model, the state and each question as a choice over the offered options", async () => {
    const { fetchImpl, sent } = answering(200, GOOD);
    const out = await typesafeClient(CONFIG, fetchImpl)?.choose(INPUT);
    expect(out).toEqual({
      answers: { tool: { choice: "visit_status", confidence: 0.99, probabilities: { visit_status: 0.99, none: 0.01 } } },
      model: "jev-1.13.0",
    });

    expect(sent[0]?.url).toBe("https://api.typesafe.example/v1/systemone");
    expect((sent[0]?.init.headers as Record<string, string>).Authorization).toBe("Bearer k-test");
    expect(JSON.parse(String(sent[0]?.init.body))).toEqual({
      model: "jev-1.13.0",
      state: { question: "<<P1>> abhi tak andar gaye ya nahi" },
      questions: { tool: { type: "choice", instructions: "Which tool?", criteria: { visit_status: "seen yet?", none: "anything else" } } },
    });
  });

  it("refuses a choice it did not offer — the closed menu is enforced here, not trusted", async () => {
    const bad = { ...GOOD, answers: { tool: { ...GOOD.answers.tool, choice: "delete_patient" } } };
    expect(await reason(typesafeClient(CONFIG, answering(200, bad).fetchImpl)!.choose(INPUT))).toBe("provider_failed");
  });

  it("refuses a confidence that is not a number between 0 and 1", async () => {
    for (const confidence of [1.5, -0.1, "high", null]) {
      const bad = { ...GOOD, answers: { tool: { ...GOOD.answers.tool, confidence } } };
      expect(await reason(typesafeClient(CONFIG, answering(200, bad).fetchImpl)!.choose(INPUT))).toBe("provider_failed");
    }
  });

  /*
    Triage ranks up to three departments, so the whole distribution comes back — and it is held to
    the same closed menu as the choice: a probability for an option we never offered is refused.
  */
  it("refuses probabilities that name an option it did not offer, or are not probabilities", async () => {
    for (const probabilities of [{ visit_status: 0.9, delete_patient: 0.1 }, { visit_status: 1.2, none: 0 }, null]) {
      const bad = { ...GOOD, answers: { tool: { ...GOOD.answers.tool, probabilities } } };
      expect(await reason(typesafeClient(CONFIG, answering(200, bad).fetchImpl)!.choose(INPUT))).toBe("provider_failed");
    }
  });

  it("refuses a reply that is missing a question it was asked", async () => {
    expect(await reason(typesafeClient(CONFIG, answering(200, { ...GOOD, answers: {} }).fetchImpl)!.choose(INPUT))).toBe("provider_failed");
  });

  it("a non-2xx is provider_failed — a 429 and a 529 are ordinary days", async () => {
    for (const status of [401, 422, 429, 500, 529]) {
      expect(await reason(typesafeClient(CONFIG, answering(status, {}).fetchImpl)!.choose(INPUT))).toBe("provider_failed");
    }
  });

  it("a slow provider is a timeout, told apart from a broken one", async () => {
    const hangs = ((_u: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => { reject(Object.assign(new Error("aborted"), { name: "AbortError" })); });
      })) as unknown as typeof fetch;
    expect(await reason(typesafeClient({ ...CONFIG, timeoutMs: 20 }, hangs)!.choose(INPUT))).toBe("timeout");

    const broken = (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
    expect(await reason(typesafeClient(CONFIG, broken)!.choose(INPUT))).toBe("provider_failed");
  });
});
