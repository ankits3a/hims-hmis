import { chooseRoute } from "./choice-route";
import { assertNoIdentifiers } from "./mask";
import { intentNames, matchIntent } from "./phrasebook";
import type { CopilotIntent } from "./phrasebook";
import type { ChoiceClient, InferenceClient } from "../inference/types";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-COPILOT — ROUTING A QUESTION TO ONE TOOL
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Floor first, model second, and the model is asked which TOOL — never what the answer is. It sees
 * a masked question and a closed menu; it replies with a member of that menu or it is ignored. The
 * property is `modules/opd/triage.ts`'s, whose model is handed department INDEXES so a hallucinated
 * department cannot reach a screen. The copilot needs it more, not less: a wrong route here does
 * not mis-suggest, it runs a tool against a patient.
 *
 * ═══ WHAT THE MODEL IS NEVER ASKED TO DO ═══
 *
 * Not to answer. Not to write the sentence the clerk reads. Not to decide whether the clerk may see
 * something. The answer is composed by deterministic code from a real read, in the operator's own
 * language, and permission is the server's guard doing what it does for every other request. A
 * model that vanished mid-shift would cost the desk the long tail of phrasings and nothing else.
 *
 * ═══ TWO MODELS, IN ORDER (owner, 2026-09-19: "typesafe as priority and the groq as fallback") ═══
 *
 * After the floor, `choice-route.ts` asks a CLASSIFIER — handed the menu itself, it can only return
 * a member of it, with a confidence. Sure of a tool: routed. Sure of "none": a miss. Unsure,
 * unreachable or malformed: the chat model below is asked exactly as it always was. Either model
 * may be absent; both absent is the phrasebook alone, which is how this ran before either existed.
 */

/**
 * ROOM FOR A REASONING MODEL TO THINK BEFORE IT ANSWERS.
 *
 * This was 64, sized for "a dozen tokens" of JSON. `gpt-oss-120b` spends 62-74 tokens REASONING
 * first (measured against the live gateway, 2026-09-19), so at 64 the reply came back
 * `finish_reason: "length"` with EMPTY content on the owner's own sentence — a miss, reported to the
 * clerk as "I did not understand", with nothing anywhere saying why. 8 of 64 counter questions got
 * through at 64; 59 at 512. Still a runaway guard: a well-behaved answer is ~100 tokens.
 */
const ROUTE_MAX_TOKENS = 512;

/**
 * The classifier's line, when the caller names none: 0.6, measured — every one of 61 answers at or
 * above it was right on the 64-question set, and the three below it included the only wrong one.
 */
const DEFAULT_MIN_CONFIDENCE = 0.6;

export type RouteResult = {
  intent: CopilotIntent;
  slot: string | null;
  /** `triage.ts`'s rule: the seat SAYS where the routing came from, because a hidden origin is trusted too much. */
  source: "phrasebook" | "model";
  cues: string[];
};

/** Reply shape. `none` is how the model says it recognised nothing, and it is a miss like any other. */
const REPLY_RE = /\{[\s\S]*?\}/;
const PLACEHOLDER_RE = /^<<P\d+>>$/;

/**
 * The menu, built from the phrasebook's own table so the two halves cannot drift. A hand-kept menu
 * would go stale the first time a tool was added and the failure would be silent — the model would
 * simply never route to the new tool.
 */
function buildSystemPrompt(): string {
  const menu = intentNames().join(" | ");
  return [
    "You route ONE question from hospital counter staff (front desk, billing or pharmacy) to ONE tool.",
    `Reply with ONLY this JSON and nothing else: {"tool":"<${menu} | none>","slot":"<placeholder or empty>"}`,
    "",
    "Tools:",
    "visit_status   — has this patient been seen by the doctor yet, are they still waiting, has their token been called",
    "queue_depth    — how long is the wait, which line is shortest, how busy is it",
    "patient_dues   — what money does this patient still owe",
    "my_day_report  — the clerk's OWN figures for the day: what they registered, booked, collected",
    "stock_on_shelf — how much of a NAMED medicine is on the pharmacy shelf, or when its batch expires",
    "paid_not_collected — which pharmacy bills are paid but the medicines not yet collected",
    "draft_short_book_entry — a NAMED medicine has run out at the pharmacy and should be noted as short",
    "draft_purchase_orders — the pharmacy should order from its suppliers: draft purchase orders to review",
    "draft_payment_run — the hospital should pay its suppliers: draft a payment run of the bills falling due",
    "none           — anything else at all, including anything you are unsure about",
    "",
    "The question may be English, Hindi, or romanised Hinglish.",
    "Patient identifiers are already masked as placeholders like <<P1>>. If the question is about a",
    "particular patient, copy that placeholder into \"slot\" EXACTLY as it appears. Never invent one,",
    "and never write a name or a number of your own into \"slot\".",
    "Prefer \"none\" over a guess: a wrong tool runs against a real patient.",
  ].join("\n");
}

/**
 * Route a MASKED question. Returns null for "I did not understand", which is an answer the desk can
 * say honestly.
 *
 * Throws `IdentifierLeak` if the question still carries an identifier when the model is about to be
 * reached. That is deliberately a throw and not a silent skip: a router that quietly declined to
 * route would look, from the desk, exactly like one that worked, and the masker bug behind it would
 * live forever. The caller turns it into an ordinary refusal for the clerk and an alert for whoever
 * owns the masker.
 */
export async function routeQuestion(
  masked: string,
  slots: Record<string, string>,
  model: InferenceClient | null,
  chooser: ChoiceClient | null = null,
  minConfidence: number = DEFAULT_MIN_CONFIDENCE,
): Promise<RouteResult | null> {
  /*
    THE FLOOR RUNS FIRST, AND THAT ORDERING IS THE COST MODEL.
    Almost every question a counter asks is one of a dozen sentences. Answering those here means
    spend is proportional to NOVELTY rather than to traffic, and a busy day costs no more than a
    quiet one. It is also why nothing is sent, and nothing is even scrubbed, on the common path.
  */
  const floor = matchIntent(masked);
  if (floor !== null) {
    return { intent: floor.intent, slot: floor.slot, source: "phrasebook", cues: floor.cues };
  }

  if (model === null && chooser === null) return null;

  /*
    THE LAST GATE BEFORE THE WIRE — either wire. `mask.ts` explains why this is a separate function
    from the masker rather than part of it: a masker cannot be its own witness.
  */
  assertNoIdentifiers(masked);

  if (chooser !== null) {
    const picked = await chooseRoute(masked, slots, chooser, minConfidence);
    if (picked === "none") return null;
    if (picked !== "unsure") return picked;
  }

  if (model === null) return null;

  let reply: string;
  try {
    const out = await model.complete({ system: buildSystemPrompt(), user: masked, maxTokens: ROUTE_MAX_TOKENS });
    reply = out.text;
  } catch {
    /*
      A TIMEOUT IS AN ORDINARY OUTCOME, and `triage.ts` says so in the same words. The floor has
      already missed, so the desk says it did not understand — which is true, costs nothing, and is
      a better counter experience than a spinner. An `InferenceClient` failure is a report, never a
      blocked human flow (Plan 12a, Traps).
    */
    return null;
  }

  return parseReply(reply, masked, slots);
}

/** Every way the model can be wrong ends here, and every one of them is a miss rather than a guess. */
function parseReply(reply: string, masked: string, slots: Record<string, string>): RouteResult | null {
  // Models wrap JSON in prose and code fences however firmly they are told not to.
  const block = REPLY_RE.exec(reply);
  if (block === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(block[0]);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const { tool, slot } = parsed as { tool?: unknown; slot?: unknown };
  if (typeof tool !== "string") return null;

  /*
    THE CLOSED MENU. `intentNames()` is the phrasebook's own key set, so a tool that is not a real
    tool — invented, renamed, or the model's `none` — cannot pass. This is the single check that
    makes a hallucination harmless rather than dangerous.
  */
  const names: string[] = intentNames();
  if (!names.includes(tool)) return null;

  return {
    intent: tool as CopilotIntent,
    slot: resolveSlot(slot, masked, slots),
    source: "model",
    cues: [],
  };
}

/**
 * A slot is kept only if it is a placeholder WE issued AND it actually appears in the question.
 *
 * Both halves are needed and they fail differently. A placeholder from another question would
 * resolve to a real patient nobody asked about; a placeholder from no question at all is an
 * invention. Dropping to null means the tool runs with no patient and refuses for a reason the
 * clerk can read — which is the correct outcome, and never the wrong patient's record.
 */
function resolveSlot(slot: unknown, masked: string, slots: Record<string, string>): string | null {
  if (typeof slot !== "string") return null;
  const trimmed = slot.trim();
  if (!PLACEHOLDER_RE.test(trimmed)) return null;
  if (!masked.includes(trimmed)) return null;
  if (!(trimmed in slots)) return null;
  return trimmed;
}
