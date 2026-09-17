import { InferenceUnavailable } from "./types";
import type { CompleteInput, CompleteResult, InferenceClient } from "./types";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE `complete()` PROVIDER — OpenAI-SHAPED, WHICH IS THE ONLY REASON IT IS PORTABLE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Groq, NVIDIA, vLLM, Ollama, Together and an on-prem box behind a reverse proxy all speak
 * `POST /chat/completions` with a bearer token. So the locus decision the DPIA still owes an answer
 * to — cloud today, hospital basement later — is a change of `baseUrl`, not a change of code. That
 * is the whole reason this is written to the shape rather than to a vendor SDK.
 *
 * Every hard-won detail below came out of `modules/opd/triage.ts`, which paid for them in
 * production. They are repeated here rather than referenced because a comment pointing at another
 * file is not read at three in the morning.
 */
export type CompleteConfig = {
  baseUrl: string | null;
  apiKey: string | null;
  model: string;
  timeoutMs: number;
};

type ChatCompletionResponse = {
  choices?: { message?: { content?: unknown } }[];
};

/**
 * Build a client, or `null` when nothing is configured.
 *
 * Null rather than a throwing stub, because "no model configured" is a supported way to run this
 * hospital — the copilot's phrasebook answers on its own and the desk never learns the difference
 * except in the long tail. A constructor that threw would make an optional dependency mandatory.
 */
export function openAiCompatibleClient(
  config: CompleteConfig,
  fetchImpl: typeof fetch = fetch,
): InferenceClient | null {
  const { baseUrl, apiKey } = config;
  if (baseUrl === null || apiKey === null) return null;

  return {
    async complete(input: CompleteInput): Promise<CompleteResult> {
      /*
        THE TIMEOUT IS A BUDGET, NOT A GUILLOTINE, and the number is measured rather than chosen.
        A clerk with a queue cannot wait, so a slow answer is worth less than no answer: the caller
        treats a timeout as an ordinary miss and the phrasebook has already had its turn.
      */
      const controller = new AbortController();
      const timer = setTimeout(() => { controller.abort(); }, config.timeoutMs);
      try {
        const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          signal: controller.signal,
          body: JSON.stringify({
            model: config.model,
            /*
              `stream: false` IS LOAD-BEARING, and triage.ts measured why. The Omniroute gateway
              answered `text/event-stream` — `data: {...}` chunks — even when streaming was never
              requested, so `res.json()` threw and every single call fell back silently. A default
              that is only correct on well-behaved providers is not a default.
            */
            stream: false,
            /*
              Zero, because this is a CLASSIFIER wearing a chat API's clothes. The same question
              twice must route the same way twice: a clerk who gets two different answers to one
              sentence stops trusting the box, and nothing about picking a tool name benefits from
              sampling.
            */
            temperature: 0,
            max_tokens: input.maxTokens ?? 64,
            messages: [
              { role: "system", content: input.system },
              { role: "user", content: input.user },
            ],
          }),
        });

        if (!res.ok) throw new InferenceUnavailable("provider_failed");

        const body = (await res.json()) as ChatCompletionResponse;
        const content = body.choices?.[0]?.message?.content;
        if (typeof content !== "string" || content.trim() === "") {
          throw new InferenceUnavailable("provider_failed");
        }
        return { text: content };
      } catch (e) {
        if (e instanceof InferenceUnavailable) throw e;
        /*
          An abort and a DNS failure are the same event to the caller — the model did not answer —
          but they are told apart here because the two have different fixes and somebody reading an
          alert at 09:00 needs to know which one happened.
        */
        throw new InferenceUnavailable(
          e instanceof Error && e.name === "AbortError" ? "timeout" : "provider_failed",
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
