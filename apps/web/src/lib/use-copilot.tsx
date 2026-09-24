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
  const { t } = useTranslation();
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
          setAnswer(local() ?? t(reply.answer.key, reply.answer.params));
          return;
        }
        setAnswer(t(reply.answer.key, reply.answer.params));
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
  }, [t, terms, fallback, onNote, date]);

  return {
    answer, report, busy, ask, dismissReport: useCallback(() => { setReport(null); }, []),
    payload, clearPayload: useCallback(() => { setPayload(null); }, []),
  };
}
