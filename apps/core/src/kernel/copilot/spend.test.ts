import { chooserChain, chooserFor } from "../inference/openai-decisions";
import { openAiCompatibleClient } from "../inference/openai-compatible";
import { DEFAULT_PRICES, SpendMeter, estimateTokens, priceFor } from "./spend";
import type { ChoiceClient, ChooseInput, InferenceClient } from "../inference/types";

/** E0.5 done-means 6 — every model and chooser call of an ask is counted with tokens and an estimated ₹. */
describe("E0.5 — the copilot's cost meter", () => {
  const sure: ChoiceClient = {
    choose: async () => ({ model: "jev-1.13.0", answers: { tool: { choice: "queue_depth", confidence: 0.9, probabilities: {} } } }),
  };
  const input: ChooseInput = { state: { question: "kitna wait hai" }, questions: { tool: { instructions: "which", options: { a: null } } } };

  it("prices the chat model from the provider's own usage, rupees per 1M tokens → micro-rupees", async () => {
    const meter = new SpendMeter();
    const model: InferenceClient = { complete: async () => ({ text: "{}", usage: { inputTokens: 1000, outputTokens: 200 } }) };
    await meter.complete(model, "openai/gpt-oss-120b")!.complete({ system: "s", user: "u" });
    // 1000 × ₹13.2/1M + 200 × ₹52.8/1M = ₹0.02376 = 23,760 µ₹
    expect(meter.calls).toEqual([{
      provider: "chat", model: "openai/gpt-oss-120b", kind: "model", inTok: 1000, outTok: 200, microInr: 23_760, ok: true, tokens: "usage",
    }]);
  });

  it("estimates characters ÷ 4 when the provider sends no usage, and charges a FAILED call its input", async () => {
    const meter = new SpendMeter({ "chat:*": { in: 1_000_000, out: 1_000_000 } }); // ₹1 a token: easy arithmetic
    const ok: InferenceClient = { complete: async () => ({ text: "12345678" }) };
    const down: InferenceClient = { complete: async () => { throw new Error("timeout"); } };
    await meter.complete(ok, "x")!.complete({ system: "abcd", user: "efgh" });
    await expect(meter.complete(down, "x")!.complete({ system: "abcd", user: "" })).rejects.toThrow("timeout");
    expect(meter.calls.map((c) => [c.inTok, c.outTok, c.ok, c.tokens])).toEqual([[2, 2, true, "estimated"], [1, 0, false, "estimated"]]);
    expect(meter.microInr).toBe(4_000_000 + 1_000_000);
    expect(meter.complete(null, "x")).toBeNull();
  });

  it("meters EACH link of a chooser chain — two providers asked is two calls", async () => {
    const meter = new SpendMeter();
    const unsure: ChoiceClient = {
      choose: async () => ({ model: "gpt-6-luna", answers: { tool: { choice: "queue_depth", confidence: 0.1, probabilities: {} } } }),
    };
    const chain = chooserChain([meter.chooser("openai", "gpt-6-luna", unsure), meter.chooser("typesafe", "jev-1.13.0", sure)], 0.6)!;
    await chain.choose(input);
    expect(meter.calls.map((c) => [c.provider, c.model, c.kind])).toEqual([["openai", "gpt-6-luna", "chooser"], ["typesafe", "jev-1.13.0", "chooser"]]);
    expect(meter.calls[0]!.inTok).toBe(estimateTokens(JSON.stringify(input)));
    expect(meter.calls[0]!.outTok).toBe(10);
  });

  it("chooserFor hands each BUILT provider to `wrap` with its configured model (a keyless one is skipped)", async () => {
    const seen: string[] = [];
    const chooser = chooserFor({
      order: ["openai", "typesafe"],
      typesafe: { baseUrl: "http://t", apiKey: "k", model: "jev-1.13.0", timeoutMs: 1 },
      decisions: { baseUrl: "http://o", model: "gpt-6-luna", timeoutMs: 1 },
      openaiKeyFile: null,
      minConfidence: 0.6,
      wrap: (provider, model) => { seen.push(`${provider}:${model}`); return sure; },
    });
    expect(seen).toEqual(["typesafe:jev-1.13.0"]);
    expect((await chooser!.choose(input)).model).toBe("jev-1.13.0");
  });

  it("an unknown model is priced at the conservative default; the owner's env row wins", () => {
    expect(priceFor(DEFAULT_PRICES, "chat", "some/new-model")).toEqual(DEFAULT_PRICES["*"]);
    expect(priceFor({ ...DEFAULT_PRICES, "typesafe:jev-2": { in: 1, out: 2 } }, "typesafe", "jev-2")).toEqual({ in: 1, out: 2 });
  });

  it("the OpenAI-compatible client hands the provider's usage back as two integers", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: "{\"tool\":\"none\"}" } }], usage: { prompt_tokens: 812, completion_tokens: 74 },
    }), { status: 200 })) as unknown as typeof fetch;
    const client = openAiCompatibleClient({ baseUrl: "http://x", apiKey: "k", model: "m", timeoutMs: 1000 }, fetchImpl)!;
    expect(await client.complete({ system: "s", user: "u" })).toEqual({ text: "{\"tool\":\"none\"}", usage: { inputTokens: 812, outputTokens: 74 } });
  });
});
