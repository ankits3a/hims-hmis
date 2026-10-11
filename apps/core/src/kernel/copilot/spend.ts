import type { ChooserProvider } from "../inference/openai-decisions";
import type { ChoiceClient, ChooseInput, CompleteInput, InferenceClient } from "../inference/types";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * E0.5 — THE COPILOT'S COST METER (decision 0064: ₹5,000 a day, then phrasebook-only till midnight IST)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Every chooser and chat-model call an ask makes is counted here, priced, and written onto that ask's
 * ledger row (`model_calls`, `cost_micro_inr`, `model_usage`). The cap check sums those rows for the
 * IST day (`gate.ts`). Spec: /opt/hmis-context/SPEC-copilot-halt-and-cap-2026-10-11.md.
 *
 * ═══ THE RUPEES ARE AN ESTIMATE, AND SAY SO ═══
 *
 * Tokens: the chat model's own `usage` when the provider sends it (it bills the reasoning tokens a
 * `gpt-oss` model spends before answering, which the reply text does not show); otherwise characters
 * ÷ 4. The choosers' wires carry no usage at all, so theirs is always characters ÷ 4. Prices: the
 * table below, in rupees per million tokens at an assumed ₹88 to the dollar, which the owner changes
 * with `COPILOT_PRICES_INR` without a release. A provider's invoice is the truth; this is the brake.
 *
 * A call that FAILED is still charged its input: a provider that timed out on us may well have
 * billed the request. Over-counting trips the brake a little early; under-counting would not trip it.
 */

/** Rupees per 1M tokens. */
export type Price = { in: number; out: number };

/**
 * DEFAULTS, 2026-10-11, all ESTIMATES (₹88 = $1):
 *   chat:openai/gpt-oss-120b — Groq's list price as we understood it, $0.15 in / $0.60 out per 1M.
 *   typesafe:*, openai:* (Jev, gpt-6-luna) — no published per-token price known to us; priced
 *     CONSERVATIVELY at $1.25 / $10 per 1M, the same as an unknown model, so the cap trips early.
 */
export const DEFAULT_PRICES: Readonly<Record<string, Price>> = {
  "chat:openai/gpt-oss-120b": { in: 13.2, out: 52.8 },
  "typesafe:*": { in: 110, out: 880 },
  "openai:*": { in: 110, out: 880 },
  "*": { in: 110, out: 880 },
};

export type MeterProvider = "chat" | ChooserProvider;

export type ModelCall = {
  provider: MeterProvider;
  model: string;
  /** `chooser` (a classifier) or `model` (the chat model) — the ledger's route names. */
  kind: "chooser" | "model";
  inTok: number;
  outTok: number;
  /** Estimated cost in micro-rupees (₹1 = 1,000,000). */
  microInr: number;
  ok: boolean;
  /** `usage` — the provider counted; `estimated` — characters ÷ 4. */
  tokens: "usage" | "estimated";
};

/** The price for one provider and model: exact row, then the provider's `*`, then the global `*`. */
export function priceFor(prices: Readonly<Record<string, Price>>, provider: MeterProvider, model: string): Price {
  return prices[`${provider}:${model}`] ?? prices[`${provider}:*`] ?? prices["*"] ?? DEFAULT_PRICES["*"]!;
}

/** Characters ÷ 4, rounded up — the usual rough count for mixed English/Hinglish text. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/** A chooser's answer is a key and a probability per question; ~10 tokens each. */
const CHOOSER_OUT_TOKENS_PER_QUESTION = 10;

/** One ask's meter. The controller makes one per ask and writes `calls` onto the ledger row. */
export class SpendMeter {
  readonly calls: ModelCall[] = [];
  private readonly prices: Readonly<Record<string, Price>>;

  constructor(overrides: Readonly<Record<string, Price>> = {}) {
    this.prices = { ...DEFAULT_PRICES, ...overrides };
  }

  record(c: Omit<ModelCall, "microInr">): void {
    const p = priceFor(this.prices, c.provider, c.model);
    // ₹ per 1M tokens × tokens = micro-rupees exactly; rounded up so a call is never free.
    const microInr = Math.ceil(c.inTok * p.in + c.outTok * p.out);
    this.calls.push({ ...c, microInr });
  }

  get count(): number { return this.calls.length; }
  get microInr(): number { return this.calls.reduce((n, c) => n + c.microInr, 0); }

  /** The chat model, metered. `null` in, `null` out. */
  complete(client: InferenceClient | null, model: string): InferenceClient | null {
    if (client === null) return null;
    return {
      complete: async (input: CompleteInput) => {
        const sent = estimateTokens(input.system) + estimateTokens(input.user);
        try {
          const out = await client.complete(input);
          if (out.usage !== undefined) {
            this.record({ provider: "chat", model, kind: "model", inTok: out.usage.inputTokens, outTok: out.usage.outputTokens, ok: true, tokens: "usage" });
          } else {
            this.record({ provider: "chat", model, kind: "model", inTok: sent, outTok: estimateTokens(out.text), ok: true, tokens: "estimated" });
          }
          return out;
        } catch (e) {
          this.record({ provider: "chat", model, kind: "model", inTok: sent, outTok: 0, ok: false, tokens: "estimated" });
          throw e;
        }
      },
    };
  }

  /** One chooser provider, metered — handed to `chooserFor({ wrap })` so each link of the chain counts. */
  chooser(provider: ChooserProvider, model: string, client: ChoiceClient): ChoiceClient {
    return {
      choose: async (input: ChooseInput) => {
        const inTok = estimateTokens(JSON.stringify(input));
        try {
          const out = await client.choose(input);
          this.record({
            provider, model: out.model, kind: "chooser", inTok,
            outTok: CHOOSER_OUT_TOKENS_PER_QUESTION * Object.keys(input.questions).length, ok: true, tokens: "estimated",
          });
          return out;
        } catch (e) {
          this.record({ provider, model, kind: "chooser", inTok, outTok: 0, ok: false, tokens: "estimated" });
          throw e;
        }
      },
    };
  }
}

/** Rupees → micro-rupees, for the cap. */
export const inrToMicro = (inr: number): number => Math.round(inr * 1_000_000);
