import { Logger } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { ipdAdmissions, patients } from "../../kernel/db/schema";
import { readCopilotGate, asksHalted } from "../../kernel/copilot/halt";
import { recordAsk } from "../../kernel/copilot/ledger";
import { IdentifierLeak, asciiDigits, assertNoIdentifiers, maskQuestion } from "../../kernel/copilot/mask";
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
 *   1. `sealed`           a sealed, confidential or medico-legal patient: NO model call at all (`modelBarred`, read here).
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

/**
 * WHOSE RECORD MAY NEVER REACH A MODEL (review of 1f7cc591): a sealed patient (`sensitive_context`), a confidential one
 * (`is_confidential` — staff-as-patient, VIP) and a medico-legal admission (`mlc`). Read HERE, from the admission, on
 * every ask — never taken from a caller's flag. An admission that cannot be read is barred.
 */
export async function modelBarred(db: Db, admissionId: string): Promise<"sealed" | "confidential" | "mlc" | "unknown" | null> {
  const row = (await db.select({ mlc: ipdAdmissions.mlc, sealed: patients.sensitiveContext, confidential: patients.isConfidential })
    .from(ipdAdmissions).innerJoin(patients, eq(patients.id, ipdAdmissions.patientId)).where(eq(ipdAdmissions.id, admissionId)))[0];
  if (row === undefined) return "unknown";
  return row.sealed ? "sealed" : row.confidential ? "confidential" : row.mlc ? "mlc" : null;
}

/**
 * Never throws: the gate, the ledger or the provider failing is a fallback, and the caller renders its template (a page
 * built on this never answers 500 because a model, or the model's bookkeeping, is down).
 *
 * SPEND IS RESERVED BEFORE THE CALL: `copilot_asks` is append-only, so the row written first carries the worst case (the
 * input as estimated plus `maxTokens` of output, `answer_key = reserved`). If that row cannot be written, no call is
 * made. A call that answers adds a second row with no cost (`answered`, its wait in `ms`); the cap therefore counts a
 * little high, never low.
 */
export async function askIpdModel(db: Db, actor: Actor, model: IpdModel | null | undefined, admissionId: string, ask: ModelAsk, now: Date): Promise<ModelAnswer> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const barred = await modelBarred(db, admissionId);
    if (barred !== null) return { text: null, reason: "sealed", ms: 0 };
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

    const reserve = new SpendMeter(model.prices);
    reserve.record({ provider: "chat", model: model.modelId, kind: "model", inTok: estimateTokens(ask.system) + estimateTokens(ask.user), outTok: ask.maxTokens, ok: false, tokens: "estimated" });
    await recordAsk(db, { actor, outcome: "failed", route: "model", intent: ask.intent, answerKey: "reserved", ms: 0, maskedQuestion: null, screen: "ipd", modelCalls: reserve.calls });

    const late = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), ask.budgetMs); });
    const call = client.complete({ system: ask.system, user: ask.user, maxTokens: ask.maxTokens });
    // A call that loses the race is still in flight: its late failure must not become an unhandled rejection.
    call.catch(() => undefined);
    const won = await Promise.race([call, late]);
    const ms = Date.now() - started;
    if (won === "late") return { text: null, reason: "over_budget", ms };
    if (won.text.trim() === "") return { text: null, reason: "no_text", ms };
    await recordAsk(db, { actor, outcome: "answered", route: "model", intent: ask.intent, answerKey: null, ms, maskedQuestion: null, screen: "ipd" });
    return { text: won.text, modelId: model.modelId, ms };
  } catch (e) {
    logger.warn(`${ask.intent}: ${e instanceof Error ? e.name : "error"} — template only`);
    return { text: null, reason: "model_down", ms: Date.now() - started };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const KIN = "wife|husband|son|daughter|mother|father|brother|sister|uncle|aunt|nephew|niece|cousin|grandson|granddaughter|grandfather|grandmother|attendant|relative|guardian|friend|neighbour|neighbor|w\\/o|s\\/o|d\\/o|c\\/o|mr|mrs|ms|miss|shri|smt|sri|dr|sister-in-law|brother-in-law|mother-in-law|father-in-law|son-in-law|daughter-in-law";
/** "wife Sunita Devi", "s/o Ram Kumar", "Mr Verma": the name after a kinship word or a title, whoever it is. */
const KIN_NAME_RE = new RegExp(`\\b(${KIN})\\.?\\s+((?:[A-Z][\\p{L}'.-]+)(?:\\s+[A-Z][\\p{L}'.-]+){0,2})`, "gu");
/** "bed 12", "Bed No. F05-B01", "ward 5A", "room 204", "cabin 3": where the patient lies. */
const anyCase = (w: string): string => [...w].map((c) => `[${c.toLowerCase()}${c.toUpperCase()}]`).join("");
// The place word is whole ("units" is a dose word, not a place) and what follows holds a digit, or is one CAPITAL letter.
const PLACE_RE = new RegExp(`\\b(${["bed", "ward", "room", "cabin", "cubicle"].map(anyCase).join("|")})\\b\\s*(?:[Nn][Oo]\\.?|[Nn]umber|#)?\\s*[:-]?\\s*([A-Za-z]{0,4}[-/]?\\d[\\w/-]*|[A-Z]\\b)`, "g");
/** A telephone number of any usual shape (the masker's own shapes catch mobiles and long digit runs; this is the rest). */
const PHONE_RE = /(?<![\w.])\+?\d[\d\s()-]{6,}\d(?![\w.])/g;
const HIDDEN = "<<P0>>";

/**
 * Free text on its way to a model. `names`: every person the record knows around this patient — the patient, the staff
 * who wrote the notes, guardians, pass holders, the registered attendant, the deposit's payer — and the UHID and
 * admission number; `places`: the bed and ward as recorded. Then, by SHAPE (a note can name anybody): the name after a
 * kinship word or a title, any bed / ward / room token, any telephone number. Then the kernel masker's identifier
 * shapes (`maskQuestion`, digits of every script). The scrubber in `askIpdModel` still runs on the result.
 */
export function maskForModel(text: string, names: readonly (string | null | undefined)[], places: readonly (string | null | undefined)[] = []): string {
  const clean = (xs: readonly (string | null | undefined)[], min: number): string[] => xs.flatMap((n) => (typeof n === "string" && n.trim().length >= min ? [n.trim()] : []));
  const whole = clean(names, 2);
  const parts = whole.flatMap((n) => n.split(/\s+/)).filter((p) => p.length >= 3);
  const shaped = asciiDigits(text).replace(KIN_NAME_RE, (_m, kin: string) => `${kin} ${HIDDEN}`).replace(PLACE_RE, (_m, word: string) => `${word} ${HIDDEN}`).replace(PHONE_RE, (m) => ((m.match(/\d/g) ?? []).length >= 8 ? HIDDEN : m));
  return maskQuestion(shaped, [...new Set([...whole, ...parts, ...clean(places, 2)])], { wholeWords: true }).masked;
}

/** The first JSON object in a model's reply (it may wrap it in a code fence or a sentence); null when there is none. */
export function jsonIn(reply: string): unknown {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(reply.slice(start, end + 1)) as unknown; } catch { return null; }
}
