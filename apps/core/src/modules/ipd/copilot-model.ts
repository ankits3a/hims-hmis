import { Logger } from "@nestjs/common";
import { readCopilotGate, asksHalted } from "../../kernel/copilot/halt";
import { recordAsk } from "../../kernel/copilot/ledger";
import { IdentifierLeak, assertNoIdentifiers, maskQuestion } from "../../kernel/copilot/mask";
import { SpendMeter, estimateTokens, inrToMicro } from "../../kernel/copilot/spend";
import { openAiCompatibleClient } from "../../kernel/inference/openai-compatible";
import type { Price } from "../../kernel/copilot/spend";
import type { InferenceClient } from "../../kernel/inference/types";
import type { AppConfig } from "../../kernel/config";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * E5.3 (#740), E5.4 (#741) — THE ONE DOOR FROM THE IPD DRAFTERS TO A MODEL. It is the staff copilot's door, not a second
 * one: the same client (`kernel/inference` `openAiCompatibleClient`, the `COPILOT_*` config), the same mask and the same
 * last-line scrubber (`kernel/copilot/mask`), the same halt switch and daily ₹ cap (`readCopilotGate`, decision 0064), the
 * same cost meter and ledger (`SpendMeter`, `recordAsk` — a drafter's call is a `copilot_asks` row with no question text,
 * so the cap counts it).
 *
 * THE ORDER OF REFUSALS IS THE DESIGN — each one answers `null` text and a reason, and the caller renders its template:
 *   1. `sealed`           a sealed (sensitive-context) patient: NO model call at all, checked before anything is built.
 *   2. `model_off`        no model configured (a supported way to run the hospital).
 *   3. `halted`/`capped`  the owner's halt switch (global / read / draft) or the day's cap.
 *   4. `identifier_leak`  something identifier-shaped survived masking: refuse, never repair.
 *   5. `model_down` / `over_budget`  the provider failed, or did not answer inside the budget.
 * A draft never waits past its budget and a page never waits at all (the deterministic layer has already answered).
 */

export type FallbackReason = "sealed" | "model_off" | "halted" | "capped" | "identifier_leak" | "model_down" | "over_budget" | "rejected" | "no_text";

export type IpdModel = {
  /** The model's id as configured — what a draft is stamped with. */
  modelId: string;
  /** A client that gives up at `budgetMs`, or null when none is configured. */
  clientFor(budgetMs: number): InferenceClient | null;
  dailyCapInr: number;
  prices: Readonly<Record<string, Price>>;
};

/** The staff copilot's own model, from the same config block (`COPILOT_BASE_URL` / `_API_KEY` / `_MODEL`). */
export function ipdModelFrom(cfg: Pick<AppConfig, "copilot" | "copilotSpend">): IpdModel {
  return {
    modelId: cfg.copilot.model,
    clientFor: (budgetMs) => openAiCompatibleClient({ ...cfg.copilot, timeoutMs: Math.min(cfg.copilot.timeoutMs, budgetMs) }),
    dailyCapInr: cfg.copilotSpend.dailyCapInr,
    prices: cfg.copilotSpend.prices,
  };
}

export type ModelAsk = {
  /** The ledger's `intent` (`ipd.since_yesterday`, `ipd.sbar_draft`, `ipd.discharge_draft`). */
  intent: string;
  system: string;
  /** Already masked by the caller; scrubbed again here. */
  user: string;
  budgetMs: number;
  maxTokens: number;
  /** A draft tool also stops on the `draft` halt scope; a read (since yesterday) on `read` / `global` only. */
  kind: "read" | "draft";
};

export type ModelAnswer = { text: string; modelId: string; ms: number } | { text: null; reason: FallbackReason; ms: number };

const logger = new Logger("ipd-copilot");

export async function askIpdModel(db: Db, actor: Actor, model: IpdModel | null | undefined, sealed: boolean, ask: ModelAsk, now: Date): Promise<ModelAnswer> {
  if (sealed) return { text: null, reason: "sealed", ms: 0 };
  if (model === null || model === undefined) return { text: null, reason: "model_off", ms: 0 };
  const client = model.clientFor(ask.budgetMs);
  if (client === null) return { text: null, reason: "model_off", ms: 0 };
  const gate = await readCopilotGate(db, now);
  if (asksHalted(gate.halts) || (ask.kind === "draft" && gate.halts.has("draft"))) return { text: null, reason: "halted", ms: 0 };
  if (gate.spentMicroInr >= inrToMicro(model.dailyCapInr)) return { text: null, reason: "capped", ms: 0 };
  try {
    assertNoIdentifiers(ask.system);
    assertNoIdentifiers(ask.user);
  } catch (e) {
    if (!(e instanceof IdentifierLeak)) throw e;
    logger.warn(`${ask.intent}: ${e.message} — template only`);
    return { text: null, reason: "identifier_leak", ms: 0 };
  }

  const meter = new SpendMeter(model.prices);
  const metered = meter.complete(client, model.modelId)!;
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  let answer: ModelAnswer;
  try {
    const late = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), ask.budgetMs); });
    const call = metered.complete({ system: ask.system, user: ask.user, maxTokens: ask.maxTokens });
    // A call that loses the race is still in flight: its late failure must not become an unhandled rejection.
    call.catch(() => undefined);
    const won = await Promise.race([call, late]);
    const ms = Date.now() - started;
    if (won === "late") {
      // The provider may still bill a request we stopped waiting for: charge its input (`spend.ts`'s rule).
      meter.record({ provider: "chat", model: model.modelId, kind: "model", inTok: estimateTokens(ask.system) + estimateTokens(ask.user), outTok: 0, ok: false, tokens: "estimated" });
      answer = { text: null, reason: "over_budget", ms };
    } else {
      answer = won.text.trim() === "" ? { text: null, reason: "no_text", ms } : { text: won.text, modelId: model.modelId, ms };
    }
  } catch {
    answer = { text: null, reason: "model_down", ms: Date.now() - started };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  // The cap reads `copilot_asks`: the call is recorded whether or not its words are used. No question text is kept.
  await recordAsk(db, {
    actor, outcome: answer.text === null ? "failed" : "answered", route: "model", intent: ask.intent, answerKey: null, ms: answer.ms,
    maskedQuestion: null, screen: "ipd", modelCalls: meter.calls,
  });
  return answer;
}

/**
 * Free text on its way to a model: every name the screen knows (the patient's, the staff who wrote the notes), the UHID
 * and the admission number become placeholders, then every identifier-shaped run does (`maskQuestion`). The scrubber in
 * `askIpdModel` still runs on the result.
 */
export function maskForModel(text: string, names: readonly (string | null | undefined)[]): string {
  const whole = names.flatMap((n) => (typeof n === "string" && n.trim().length >= 2 ? [n.trim()] : []));
  const parts = whole.flatMap((n) => n.split(/\s+/)).filter((p) => p.length >= 3);
  return maskQuestion(text, [...new Set([...whole, ...parts])], { wholeWords: true }).masked;
}

/** The first JSON object in a model's reply (it may wrap it in a code fence or a sentence); null when there is none. */
export function jsonIn(reply: string): unknown {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(reply.slice(start, end + 1)) as unknown; } catch { return null; }
}
