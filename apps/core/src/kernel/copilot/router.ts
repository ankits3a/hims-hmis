import { assertNoIdentifiers } from "./mask";
import { intentNames, matchIntent } from "./phrasebook";
import type { CopilotIntent } from "./phrasebook";
import type { InferenceClient } from "../inference/types";

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
 */

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
    "You route ONE question from a hospital front-desk clerk to ONE tool.",
    `Reply with ONLY this JSON and nothing else: {"tool":"<${menu} | none>","slot":"<placeholder or empty>"}`,
    "",
    "Tools:",
    "visit_status   — has this patient been seen by the doctor yet, are they still waiting, has their token been called",
    "queue_depth    — how long is the wait, which line is shortest, how busy is it",
    "patient_dues   — what money does this patient still owe",
    "my_day_report  — the clerk's OWN figures for the day: what they registered, booked, collected",
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

  if (model === null) return null;

  /*
    THE LAST GATE BEFORE THE WIRE. `mask.ts` explains why this is a separate function from the
    masker rather than part of it: a masker cannot be its own witness.
  */
  assertNoIdentifiers(masked);

  let reply: string;
  try {
    const out = await model.complete({ system: buildSystemPrompt(), user: masked, maxTokens: 64 });
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
