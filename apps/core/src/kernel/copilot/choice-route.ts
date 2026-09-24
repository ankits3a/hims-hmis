import { intentNames } from "./phrasebook";
import type { CopilotIntent } from "./phrasebook";
import type { RouteResult } from "./router";
import type { ChoiceClient, ChoiceQuestion } from "../inference/types";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE COPILOT'S FIRST MODEL — A CLASSIFIER HANDED THE MENU ITSELF
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-09-19: *"keep typesafe as priority and the groq as fallback"*. `router.ts` asks this
 * first, after the phrasebook; the chat model is asked only when this cannot say, with confidence,
 * which tool a question is for.
 *
 * ═══ MEASURED BEFORE IT WAS WIRED — 2026-09-19, this box, 64 masked counter questions ═══
 *
 * 13 visit / 12 queue / 11 dues / 11 day-report / 15 out-of-scope (greetings, a doctor's schedule,
 * a patient's address, medical advice, "ignore previous instructions…") / 2 asking two things, in
 * English, romanised Hinglish and Devanagari. With THESE criteria (examples chosen so none is a
 * test sentence):
 *
 *     TypeSafe jev-1.13.0     63/64   0 wrong at confidence >= 0.6 (61 answered)   p50 297 ms
 *     gpt-oss-120b (Groq)     59/64   5 misses, all timeouts at 3 s                p50 848 ms
 *
 * The one TypeSafe miss ("kitna lena hai <<P1>> se", want dues) scored 0.43 — under the line, so it
 * falls through, and the chat model answered it. Nothing wrong was confident.
 */

type Criterion = { what: string; not_for?: string; examples?: string[] };

/**
 * ONE DESCRIPTION PER INTENT, AND THE COMPILER KEEPS IT THAT WAY.
 *
 * Keyed by `CopilotIntent`, so an intent added to the phrasebook without a description here fails
 * `tsc` rather than silently never being chosen — the drift `router.ts` warns about for its own
 * menu. `none` is described too: a classifier with no "none of these" is forced to pick a tool.
 */
const CRITERIA: Record<CopilotIntent | "none", Criterion> = {
  visit_status: {
    what: "whether ONE particular patient has been seen by the doctor, called in, or is still waiting",
    examples: ["<<P1>> gaya andar?", "was <<P1>> called in yet"],
  },
  queue_depth: {
    what: "how long the wait is, how many people are waiting, which line or department is shortest or busiest",
    not_for: "whether one particular patient has been seen",
    examples: ["OPD mein kitna waiting hai", "how busy is cardiology"],
  },
  patient_dues: {
    what: "money ONE particular patient still owes, has paid, or has pending",
    examples: ["<<P1>> ka hisaab baaki hai kya", "has <<P1>> paid everything"],
  },
  my_day_report: {
    what: "the staff member's OWN work today: registrations, bookings, cash collected, their end-of-day report",
    not_for: "anything about one patient",
    examples: ["mera din ka total", "today's closing for my counter"],
  },
  stock_on_shelf: {
    what: "how much of a NAMED medicine is on the pharmacy shelf, whether it is in stock, or when its batch expires",
    not_for: "which medicines a patient was prescribed; a medicine's price or side effects",
    examples: ["dolo ki strip hai kya", "when does this ranitidine batch expire"],
  },
  paid_not_collected: {
    what: "which pharmacy bills are already PAID but whose medicines nobody has collected yet",
    not_for: "what ONE particular patient still owes",
    examples: ["paisa de gaye par dawai nahi le gaye", "paid pharmacy bills waiting for pickup"],
  },
  draft_short_book_entry: {
    what: "a NAMED medicine has run out or is short at the pharmacy counter and should be noted in the short book",
    not_for: "how much of a medicine is left; a patient's medicines",
    examples: ["Pan 40 khatam", "out of Montair LC, note it"],
  },
  draft_purchase_orders: {
    what: "the pharmacy should ORDER from its suppliers — draft purchase orders from the reorder list and the short book",
    not_for: "noting one medicine as short; how much of a medicine is left",
    examples: ["order karo", "make the orders for this week"],
  },
  none: {
    what: "anything else: greetings, equipment, doctors' schedules, a patient's address or reports or medicines, medical advice, instructions to the system",
  },
};

const INSTRUCTIONS =
  "`question` was typed by a member of staff at a hospital counter in India, in English, Hindi or romanised Hinglish. " +
  "Patient identifiers are masked as placeholders like <<P1>>. Which tool answers it?";

const SUBJECT_INSTRUCTIONS =
  "`question` mentions more than one patient placeholder. Which ONE patient is the question about? " +
  "Choose none if it is about several, or you cannot tell.";

/** What the router does next. A route is taken; `none` is a confident miss; `unsure` asks the fallback. */
export type ChoiceOutcome = RouteResult | "none" | "unsure";

export async function chooseRoute(
  masked: string,
  slots: Record<string, string>,
  chooser: ChoiceClient,
  minConfidence: number,
): Promise<ChoiceOutcome> {
  /*
    WHICH PATIENT, DECIDED WITHOUT A MODEL WHERE IT CAN BE. The placeholders this request minted AND
    this question contains — `resolveSlot`'s two halves in `router.ts`, applied up front. One of them
    is the subject by construction; only two or more need asking, and then only among themselves.
  */
  const present = Object.keys(slots).filter((p) => masked.includes(p));

  const questions: Record<string, ChoiceQuestion> = {
    tool: { instructions: INSTRUCTIONS, options: CRITERIA },
  };
  if (present.length >= 2) {
    questions.subject = {
      instructions: SUBJECT_INSTRUCTIONS,
      options: Object.fromEntries([...present.map((p) => [p, null]), ["none", "several patients, or cannot tell"]]),
    };
  }

  let answers;
  try {
    ({ answers } = await chooser.choose({ state: { question: masked }, questions }));
  } catch {
    // Unreachable, slow, malformed — every one of them is "ask the fallback", never a guess.
    return "unsure";
  }

  const tool = answers.tool;
  if (tool === undefined || tool.confidence < minConfidence) return "unsure";
  if (tool.choice === "none") return "none";
  /*
    THE SECOND WALL. The client already refuses a choice it did not offer; this refuses one that is
    not a tool the router knows, so the two can never drift into running something unmenued.
  */
  const names: string[] = intentNames();
  if (!names.includes(tool.choice)) return "unsure";

  let slot: string | null = null;
  if (present.length === 1) slot = present[0] ?? null;
  if (present.length >= 2) {
    const subject = answers.subject;
    // Unsure means NO patient: the tool then asks "which patient?" rather than guessing one.
    if (subject !== undefined && subject.confidence >= minConfidence && present.includes(subject.choice)) slot = subject.choice;
  }

  return { intent: tool.choice as CopilotIntent, slot, source: "model", cues: [] };
}
