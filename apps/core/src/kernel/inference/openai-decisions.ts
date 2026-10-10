import { InferenceUnavailable } from "./types";
import { openAiKeyFromFile } from "./openai-speech";
import { typesafeClient } from "./typesafe";
import type { ChoiceConfig } from "./typesafe";
import type { ChoiceAnswer, ChoiceClient, ChooseInput, ChooseResult, PredicateClient, PredicateInput, PredicateResult } from "./types";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * A SECOND `choose()` PROVIDER — OpenAI's Decisions API (`POST /v1/decisions`)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-10-07: *"let's try OpenAI Decision API"*. Like TypeSafe's Jev it does not write text:
 * it is handed an input and a closed set of choices and returns one of them, a probability for
 * each, and a confidence. So it sits behind the SAME `ChoiceClient` and nothing above this file
 * knows which of the two answered. Which goes first is a setting (`chooserChain` below), and the
 * default leaves TypeSafe first — merging this file changes no answer anywhere.
 *
 * What is sent, and it is the whole of it: the pinned model, `input` (the caller's de-identified
 * state, one `name: value` line each — the instructions refer to the state by those names), and the
 * questions. No user id, no metadata, no storage flag. Plain `fetch`, for `typesafe.ts`'s reasons.
 *
 * Per OpenAI's docs on 2026-10-07 the endpoint is in public beta and `gpt-6-luna` is its only
 * model; a beta moves, so it is never the only chooser and the model id is config.
 *
 * `docs/superpowers/plans/2026-10-07-chooser-evaluation.md` holds the measurement against Jev.
 */
export type DecisionsConfig = {
  baseUrl: string;
  model: string;
  timeoutMs: number;
};

type WireAnswer = { type?: unknown; name?: unknown; choice?: unknown; confidence?: unknown; probabilities?: unknown; probability?: unknown };
type WireBody = { model?: unknown; answers?: unknown };

const isProbability = (x: unknown): x is number => typeof x === "number" && x >= 0 && x <= 1;

/** `name: value` per line — the instructions say "`complaint` is what …", so the name must travel. */
function inputOf(state: Record<string, string>): string {
  return Object.entries(state).map(([name, value]) => `${name}: ${value}`).join("\n");
}

/**
 * An option's meaning as one line of text. TypeSafe takes an object as it is; this endpoint takes a
 * `description` string, so `{ what, not_for, examples }` becomes `what: …; not_for: …; examples: a | b`.
 * `null` (a department nobody has described) sends no description at all rather than an empty one.
 */
function descriptionOf(meaning: unknown): string | null {
  if (meaning === null || meaning === undefined) return null;
  if (typeof meaning === "string") return meaning;
  if (typeof meaning !== "object") return String(meaning as number | boolean);
  return Object.entries(meaning as Record<string, unknown>)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.map(String).join(" | ") : String(v)}`)
    .join("; ");
}

async function ask(config: DecisionsConfig, key: string, body: unknown, fetchImpl: typeof fetch): Promise<{ answers: WireAnswer[]; model: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, config.timeoutMs);
  try {
    const res = await fetchImpl(`${config.baseUrl.replace(/\/$/, "")}/decisions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      signal: controller.signal,
      body: JSON.stringify(body),
    });
    // Every non-2xx is the same event to the caller: this chooser did not answer; ask the next.
    if (!res.ok) throw new InferenceUnavailable("provider_failed");
    const wire = (await res.json()) as WireBody;
    if (!Array.isArray(wire.answers)) throw new InferenceUnavailable("provider_failed");
    return { answers: wire.answers as WireAnswer[], model: typeof wire.model === "string" ? wire.model : config.model };
  } catch (e) {
    if (e instanceof InferenceUnavailable) throw e;
    throw new InferenceUnavailable(e instanceof Error && e.name === "AbortError" ? "timeout" : "provider_failed");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build a client, or `null` when no key can be read. `readKey` is asked on EVERY call (it is
 * `openAiKeyFromFile`, which caches for 30 s and re-reads a changed file), so a key that is rotated
 * needs no restart — and one that disappears turns this chooser off, not the process.
 */
export function openAiDecisionsClient(
  config: DecisionsConfig,
  readKey: () => string | null,
  fetchImpl: typeof fetch = fetch,
): (ChoiceClient & PredicateClient) | null {
  if (readKey() === null) return null;
  const keyNow = (): string => {
    const key = readKey();
    if (key === null) throw new InferenceUnavailable("not_configured");
    return key;
  };

  return {
    async choose(input: ChooseInput): Promise<ChooseResult> {
      const key = keyNow();
      const questions = Object.entries(input.questions).map(([name, q]) => ({
        type: "choice",
        name,
        instructions: q.instructions,
        choices: Object.entries(q.options).map(([value, meaning]) => {
          const description = descriptionOf(meaning);
          return description === null ? { value } : { value, description };
        }),
      }));
      const { answers: wire, model } = await ask(config, key, { model: config.model, input: inputOf(input.state), questions }, fetchImpl);

      const answers: Record<string, ChoiceAnswer> = {};
      for (const [name, q] of Object.entries(input.questions)) {
        const a = wire.find((x) => x.name === name);
        /*
          THE CLOSED MENU, ENFORCED WHERE THE BYTES ARRIVE — `typesafe.ts`'s wall, the same height.
          A `refusal` answer has no `choice`, so it falls here and the caller hears "did not answer".
        */
        if (a === undefined || a.type !== "choice" || typeof a.choice !== "string" || !Object.hasOwn(q.options, a.choice)) {
          throw new InferenceUnavailable("provider_failed");
        }
        if (!isProbability(a.confidence) || !Array.isArray(a.probabilities)) throw new InferenceUnavailable("provider_failed");
        const probabilities: Record<string, number> = {};
        for (const row of a.probabilities as { value?: unknown; probability?: unknown }[]) {
          if (typeof row.value !== "string" || !Object.hasOwn(q.options, row.value) || !isProbability(row.probability)) {
            throw new InferenceUnavailable("provider_failed");
          }
          probabilities[row.value] = row.probability;
        }
        answers[name] = { choice: a.choice, confidence: a.confidence, probabilities };
      }
      return { answers, model };
    },

    async predicate(input: PredicateInput): Promise<PredicateResult> {
      const key = keyNow();
      const { answers, model } = await ask(config, key, {
        model: config.model,
        input: inputOf(input.state),
        questions: [{ type: "predicate", name: "p", instructions: input.instructions }],
      }, fetchImpl);
      const a = answers.find((x) => x.name === "p");
      if (a === undefined || a.type !== "predicate" || !isProbability(a.probability)) throw new InferenceUnavailable("provider_failed");
      return { probability: a.probability, model };
    },
  };
}

/**
 * ═══ TWO CHOOSERS, IN A CONFIGURED ORDER ═══
 *
 * The callers (`chooseRoute`, `chooseDepartments`) take ONE `ChoiceClient` and one confidence line,
 * and stay that way. This makes several choosers look like one: ask the first; if it failed, or is
 * below the line on the FIRST question asked (the tool, the department — a second question such as
 * "which patient" never decides who answers), ask the next. When nobody is sure the LAST answer is
 * handed back, and the caller's own line then says "unsure" and goes to the chat model as before.
 *
 * `null`s are choosers with no key; with none left this is `null`, and with one it is that one.
 */
export function chooserChain(clients: (ChoiceClient | null)[], minConfidence: number): ChoiceClient | null {
  const live = clients.filter((c): c is ChoiceClient => c !== null);
  if (live.length === 0) return null;
  if (live.length === 1) return live[0] ?? null;
  return {
    async choose(input: ChooseInput): Promise<ChooseResult> {
      const first = Object.keys(input.questions)[0];
      let last: ChooseResult | null = null;
      let failure: unknown = null;
      for (const client of live) {
        try {
          const out = await client.choose(input);
          last = out;
          const lead = first === undefined ? undefined : out.answers[first];
          if (lead !== undefined && lead.confidence >= minConfidence) return out;
        } catch (e) {
          failure = e;
        }
      }
      if (last !== null) return last;
      throw failure instanceof InferenceUnavailable ? failure : new InferenceUnavailable("provider_failed");
    },
  };
}

export const CHOOSER_PROVIDERS = ["typesafe", "openai"] as const;
export type ChooserProvider = (typeof CHOOSER_PROVIDERS)[number];

/**
 * The chooser a job runs with: its providers in the configured order, each built from its own
 * config, the keyless skipped. One place, so triage and the copilot cannot wire it differently.
 */
export function chooserFor(input: {
  order: ChooserProvider[];
  typesafe: ChoiceConfig;
  decisions: DecisionsConfig;
  openaiKeyFile: string | null;
  minConfidence: number;
  /**
   * E0.5 — wraps EACH provider before it joins the chain, so a caller can meter every call the chain
   * makes (a chain that asks Jev and then OpenAI made two billable calls, not one). Identity when absent.
   */
  wrap?: (provider: ChooserProvider, model: string, client: ChoiceClient) => ChoiceClient;
}): ChoiceClient | null {
  const build: Record<ChooserProvider, () => ChoiceClient | null> = {
    typesafe: () => typesafeClient(input.typesafe),
    openai: () => openAiDecisionsClient(input.decisions, () => openAiKeyFromFile(input.openaiKeyFile)),
  };
  const modelOf: Record<ChooserProvider, string> = { typesafe: input.typesafe.model, openai: input.decisions.model };
  const wrap = input.wrap;
  return chooserChain(input.order.map((name) => {
    const client = build[name]();
    return client === null || wrap === undefined ? client : wrap(name, modelOf[name], client);
  }), input.minConfidence);
}
