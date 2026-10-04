import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { askCopilot } from "./copilot-api";
import type { CopilotDayReport, CopilotReply } from "./copilot-api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-COPILOT — ONE BRAIN FOR TEN ASK BOXES
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Ten screens each grew their own `question.toLowerCase()` + `if/else` chain — no shared vocabulary,
 * no intent list, and no test of the matching anywhere. This hook is what they call instead.
 *
 * ═══ THE LOCAL CHAIN IS NOT DELETED. IT BECOMES THE THING IT IS ACTUALLY GOOD AT ═══
 *
 * A screen's own answerer knows things the server cannot: which filters are set, what is in an
 * unsaved form, which tender lane is armed, what the fee quote on this screen says. The server
 * knows things the screen cannot: whether a patient three departments away has been seen, what the
 * queues look like, the clerk's whole day.
 *
 * So `fallback` is the screen's existing chain, and it runs when the SERVER says it did not
 * understand — which is exactly the set of questions that are about this screen rather than about
 * the hospital. Nothing that worked before stops working, and the screens get everything the
 * catalog can answer without each of them learning how.
 *
 * ═══ AND IT NEVER BLOCKS THE DESK ═══
 *
 * The server is reached over the network and the model behind it may be slow or absent. If the call
 * fails for any reason at all, the screen's own chain answers, instantly, exactly as it does today.
 * An `InferenceClient` failure is a report, never a blocked human flow (Plan 12a, Traps) — and at a
 * counter the strongest form of that rule is that the old behaviour is the floor.
 */
export type CopilotState = {
  answer: string | null;
  /** The day report, when the last answer produced one. The dock renders it. */
  report: CopilotDayReport | null;
  busy: boolean;
  ask: (question: string) => void;
  /** Clears a rendered report without clearing the answer that announced it. */
  dismissReport: () => void;
  /**
   * PARITY P1 — the last answer's `payload`, when a tool handed one over that is not the day report:
   * a DRAFT the screen shows for a person to confirm (the pharmacy's `draft_short_book_entry`). The
   * hook does not interpret it; the screen that knows the draft's kind does.
   */
  payload: unknown;
  clearPayload: () => void;
};

export function useCopilot(opts: {
  /**
   * The names this screen is displaying. Masked by VALUE on the server before anything could reach
   * a model, because a name has no shape a pattern can find.
   */
  terms?: () => string[];
  /** The screen's own answerer — what it knows that the hospital does not. */
  fallback?: (question: string) => string | null;
  /** Every answer lands in the dock's log, as the screens already do for server outcomes. */
  onNote?: (text: string) => void;
  date?: string;
} = {}): CopilotState {
  const { t, i18n } = useTranslation();
  const [answer, setAnswer] = useState<string | null>(null);
  const [report, setReport] = useState<CopilotDayReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [payload, setPayload] = useState<unknown>(null);

  const { terms, fallback, onNote, date } = opts;

  const ask = useCallback((question: string): void => {
    const q = question.trim();
    if (q === "") return;

    const local = (): string | null => fallback?.(q) ?? null;

    setBusy(true);
    setReport(null);
    setPayload(null);
    askCopilot(q, terms?.() ?? [], date)
      .then((reply: CopilotReply) => {
        /*
          THE SERVER DID NOT UNDERSTAND, SO THE SCREEN GETS ITS TURN. This is the seam that keeps
          every existing answer working: "which doctor's book am I looking at" is a question about
          this screen, the catalog has no tool for it, and the chain that always answered it still
          does.
        */
        if (reply.source === "none") {
          setAnswer(local() ?? t(reply.answer.key, sayParams(reply.answer.key, reply.answer.params, t, i18n.language)));
          return;
        }
        setAnswer(t(reply.answer.key, sayParams(reply.answer.key, reply.answer.params, t, i18n.language)));
        if (reply.intent === "my_day_report" && reply.answer.payload !== undefined) {
          setReport(reply.answer.payload as CopilotDayReport);
        } else if (reply.answer.payload !== undefined) {
          setPayload(reply.answer.payload);
        }
        onNote?.(q);
      })
      .catch(() => {
        /*
          NETWORK DOWN, SESSION EXPIRED, SERVER RESTARTING. The desk keeps working on what it can
          see, which is what it did before this hook existed.
        */
        setAnswer(local() ?? t("copilot.answer.notUnderstood"));
      })
      .finally(() => { setBusy(false); });
  }, [t, i18n.language, terms, fallback, onNote, date]);

  return {
    answer, report, busy, ask, dismissReport: useCallback(() => { setReport(null); }, []),
    payload, clearPayload: useCallback(() => { setPayload(null); }, []),
  };
}

/* ═══ 20-U U9 — THE ROSTER'S ANSWERS IN THE BOARDS' VOICE ═══
 *
 * The roster tools send a day as its IST date and an instant as ISO; this says them as the boards do,
 * in the reader's language — "Saturday 10 Oct", "on Saturday 10 Oct at 22:00", "right now" — and an
 * empty name list as "nobody". Applied to the roster's keys only: another tool's `2028-01-31` (a
 * batch's expiry) means a date with a year and is left exactly as it came.
 */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/;
type Tr = (key: string, opts?: Record<string, unknown>) => string;

export function dayWords(at: Date, lang: string): string {
  return new Intl.DateTimeFormat(lang.startsWith("hi") ? "hi-IN" : "en-IN", {
    weekday: "long", day: "numeric", month: "short", timeZone: "Asia/Kolkata",
  }).format(at).replace(",", "");
}
function clockWords(at: Date): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }).format(at);
}

export function sayParams(
  key: string, params: Record<string, string | number>, t: Tr, lang: string,
): Record<string, string | number> {
  if (!key.startsWith("copilot.answer.roster")) return params;
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v !== "string") { out[k] = v; continue; }
    if (v === "") out[k] = t("copilot.when.nobody");
    else if (k === "when" && v === "now") out[k] = t("copilot.when.now");
    else if (ISO_DAY.test(v)) out[k] = dayWords(new Date(`${v}T12:00:00+05:30`), lang);
    else if (ISO_INSTANT.test(v)) {
      const at = new Date(v);
      out[k] = t(k === "when" ? "copilot.when.at" : "copilot.when.stamp", { day: dayWords(at, lang), time: clockWords(at) });
    } else out[k] = v;
  }
  return out;
}
