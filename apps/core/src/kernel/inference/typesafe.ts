import { InferenceUnavailable } from "./types";
import type { ChoiceAnswer, ChoiceClient, ChooseInput, ChooseResult } from "./types";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE `choose()` PROVIDER — TypeSafe's System One API (`POST /v1/systemone`, model Jev)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-09-19: *"keep typesafe as priority and the groq as fallback"*. TypeSafe does not
 * generate text: it is handed a state and a set of options and returns one of the options with a
 * calibrated confidence. That is exactly the copilot router's job, which until now was done by
 * asking a chat model for JSON and parsing a tool name out of whatever came back.
 *
 * Plain `fetch`, not the vendor SDK, for three measured reasons: the SDK was eight days old with a
 * breaking release already behind it; it logs request BODIES unredacted at debug level; and its
 * defaults (10 s per attempt, 2 retries) are wrong for a clerk watching an empty answer box — a
 * slow answer here is worth less than the fallback's. `openai-compatible.ts` made the same choice
 * for the same kind of reason.
 *
 * Measured from this box, 2026-09-19, 64 counter questions: p50 ~290 ms, p90 ~350 ms on a reused
 * connection; a cold connection adds ~170 ms of TLS. Not the ~100 ms the vendor quotes — the
 * provider is far from here — but ahead of the chat model's 848 ms p50 on the same set.
 */
export type ChoiceConfig = {
  baseUrl: string;
  apiKey: string | null;
  /**
   * A VERSIONED id, never an alias. `jev-latest` moves when a release ships, "so the answers behind
   * it can change without a change on your side" (vendor's words) — and the router's confidence
   * line was measured against one version. Moving is a config change taken on purpose.
   */
  model: string;
  timeoutMs: number;
};

type WireAnswer = { choice?: unknown; confidence?: unknown };
type WireBody = { model?: unknown; answers?: Record<string, WireAnswer | undefined> };

/** Build a client, or `null` when no key is configured — see `openAiCompatibleClient` for why null. */
export function typesafeClient(config: ChoiceConfig, fetchImpl: typeof fetch = fetch): ChoiceClient | null {
  const { apiKey } = config;
  if (apiKey === null) return null;

  return {
    async choose(input: ChooseInput): Promise<ChooseResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => { controller.abort(); }, config.timeoutMs);
      try {
        const questions = Object.fromEntries(
          Object.entries(input.questions).map(([id, q]) => [id, { type: "choice", instructions: q.instructions, criteria: q.options }]),
        );
        const res = await fetchImpl(`${config.baseUrl.replace(/\/$/, "")}/systemone`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          signal: controller.signal,
          body: JSON.stringify({ model: config.model, state: input.state, questions }),
        });
        /*
          Every non-2xx is the same event to the caller — the model did not answer — and the router
          hands the question to the fallback. 429 and 529 ("temporarily overloaded") are documented
          as ordinary; there is no retry here because the fallback IS the retry, and it is faster
          than waiting out a `retry-after`.
        */
        if (!res.ok) throw new InferenceUnavailable("provider_failed");

        const body = (await res.json()) as WireBody;
        const answers: Record<string, ChoiceAnswer> = {};
        for (const [id, q] of Object.entries(input.questions)) {
          const a = body.answers?.[id];
          /*
            THE CLOSED MENU, ENFORCED WHERE THE BYTES ARRIVE. A choice that is not one of the keys we
            offered, or a confidence that is not a probability, makes the whole reply unusable —
            never partly trusted. The router's own menu check stays as a second wall.
          */
          if (a === undefined || typeof a.choice !== "string" || !Object.hasOwn(q.options, a.choice)) {
            throw new InferenceUnavailable("provider_failed");
          }
          if (typeof a.confidence !== "number" || !(a.confidence >= 0 && a.confidence <= 1)) {
            throw new InferenceUnavailable("provider_failed");
          }
          answers[id] = { choice: a.choice, confidence: a.confidence };
        }
        return { answers, model: typeof body.model === "string" ? body.model : config.model };
      } catch (e) {
        if (e instanceof InferenceUnavailable) throw e;
        throw new InferenceUnavailable(
          e instanceof Error && e.name === "AbortError" ? "timeout" : "provider_failed",
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
