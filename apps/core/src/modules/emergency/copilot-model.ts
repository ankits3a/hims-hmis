import { Logger } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { erEpisodes, erMlcs, patients } from "../../kernel/db/schema";
import { asksHalted, readCopilotGate } from "../../kernel/copilot/halt";
import { recordAsk } from "../../kernel/copilot/ledger";
import { IdentifierLeak, assertNoIdentifiers } from "../../kernel/copilot/mask";
import { SpendMeter, estimateTokens, inrToMicro } from "../../kernel/copilot/spend";
import { ipdModelFrom } from "../ipd";
import type { IpdModel } from "../ipd";
import type { AppConfig } from "../../kernel/config";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * ER lane 9 (#816) — THE ONE DOOR FROM THE ER DRAFTERS TO A MODEL. The staff copilot's door, as IPD's (`askIpdModel`):
 * the same client and `COPILOT_*` config (`ipdModelFrom`), the same last-line identifier scrubber, the same halt switch
 * and daily ₹ cap (decision 0064), the same ledger (`copilot_asks`, no question text, spend reserved before the call).
 *
 * THE ORDER OF REFUSALS IS THE DESIGN — each answers `null` text and a reason, and the caller keeps its template:
 *   1. `barred`     an MLC episode, a sealed or a confidential patient: NO model call at all. Read HERE from the record on
 *                   every ask (an MLC opened a minute ago bars the next ask), never from a caller's flag; an episode that
 *                   cannot be read is barred (fail closed).
 *   2. `model_off`  no model configured — a supported way to run the hospital.
 *   3. `halted` / `capped`  the owner's halt switch (global, read or draft) or the day's cap.
 *   4. `identifier_leak`  something identifier-shaped survived the caller's masking: refuse, never repair.
 *   5. `model_down` / `over_budget` / `no_text`.
 */
export type ErModel = IpdModel;
export type ErFallback = "barred" | "model_off" | "halted" | "capped" | "identifier_leak" | "model_down" | "over_budget" | "no_text";
export type ErModelAnswer = { text: string; modelId: string; ms: number } | { text: null; reason: ErFallback; ms: number };
export type ErModelAsk = { intent: string; system: string; user: string; budgetMs: number; maxTokens: number };

export const erModelFrom = (cfg: Pick<AppConfig, "copilot" | "copilotSpend">): ErModel => ipdModelFrom(cfg);

const logger = new Logger("er-copilot");

/** Whose ER record may never reach a model: an MLC episode, a sealed or a confidential patient; unknown = barred. */
export async function erModelBarred(db: Db, episodeId: string): Promise<"mlc" | "sealed" | "confidential" | "unknown" | null> {
  const row = (await db.select({ sealed: patients.sensitiveContext, confidential: patients.isConfidential }).from(erEpisodes)
    .innerJoin(patients, eq(patients.id, erEpisodes.patientId)).where(eq(erEpisodes.id, episodeId)))[0];
  if (row === undefined) return "unknown";
  const mlc = (await db.select({ id: erMlcs.id }).from(erMlcs).where(eq(erMlcs.episodeId, episodeId)))[0];
  return mlc !== undefined ? "mlc" : row.sealed ? "sealed" : row.confidential ? "confidential" : null;
}

/** Never throws: a gate, ledger or provider failure is a fallback, and the page keeps its template. */
export async function askErModel(db: Db, actor: Actor, model: ErModel | null | undefined, episodeId: string, ask: ErModelAsk, now: Date): Promise<ErModelAnswer> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    if ((await erModelBarred(db, episodeId)) !== null) return { text: null, reason: "barred", ms: 0 };
    if (model === null || model === undefined) return { text: null, reason: "model_off", ms: 0 };
    const client = model.clientFor(ask.budgetMs);
    if (client === null) return { text: null, reason: "model_off", ms: 0 };
    const gate = await readCopilotGate(db, now);
    if (asksHalted(gate.halts) || gate.halts.has("draft")) return { text: null, reason: "halted", ms: 0 };
    if (gate.spentMicroInr >= inrToMicro(model.dailyCapInr)) return { text: null, reason: "capped", ms: 0 };
    try {
      assertNoIdentifiers(ask.system);
      assertNoIdentifiers(ask.user);
    } catch (e) {
      if (!(e instanceof IdentifierLeak)) throw e;
      logger.warn(`${ask.intent}: ${e.message} — template only`);
      return { text: null, reason: "identifier_leak", ms: 0 };
    }
    const reserve = new SpendMeter(model.prices);
    reserve.record({ provider: "chat", model: model.modelId, kind: "model", inTok: estimateTokens(ask.system) + estimateTokens(ask.user), outTok: ask.maxTokens, ok: false, tokens: "estimated" });
    await recordAsk(db, { actor, outcome: "failed", route: "model", intent: ask.intent, answerKey: "reserved", ms: 0, maskedQuestion: null, screen: "er", modelCalls: reserve.calls });

    const late = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), ask.budgetMs); });
    const call = client.complete({ system: ask.system, user: ask.user, maxTokens: ask.maxTokens });
    call.catch(() => undefined);
    const won = await Promise.race([call, late]);
    const ms = Date.now() - started;
    if (won === "late") return { text: null, reason: "over_budget", ms };
    if (won.text.trim() === "") return { text: null, reason: "no_text", ms };
    await recordAsk(db, { actor, outcome: "answered", route: "model", intent: ask.intent, answerKey: null, ms, maskedQuestion: null, screen: "er" });
    return { text: won.text, modelId: model.modelId, ms };
  } catch (e) {
    logger.warn(`${ask.intent}: ${e instanceof Error ? e.name : "error"} — template only`);
    return { text: null, reason: "model_down", ms: Date.now() - started };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
