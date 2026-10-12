import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { askCopilot, confirmCopilot } from "./copilot-api";
import { checkCopilotNotice } from "./copilot-notice";
import type { CopilotDayReport, CopilotProposal, CopilotReply } from "./copilot-api";
import type { CopilotApptPick, CopilotCoverPick, CopilotLeavePick } from "@hmis/contracts";

/** E2.1 / E2.2 — what an act's answer offers to pick and confirm: an appointment, a leave, a cover or swap. */
export type CopilotActPick = CopilotApptPick | CopilotLeavePick | CopilotCoverPick;

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
  /** E2.1 — an appointment to pick (patient, then a time) and confirm. Null when the last answer offered none. */
  pick: { pick: CopilotActPick; proposals: CopilotProposal[] } | null;
  /** The confirm tap: the server re-checks and writes, and its answer replaces the pick. */
  confirm: (proposal: CopilotProposal) => Promise<void>;
  clearPick: () => void;
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
  /** E2.1 — a confirmed act wrote something: the screen refreshes what it shows. */
  onActed?: () => void;
} = {}): CopilotState {
  const { t, i18n } = useTranslation();
  const [answer, setAnswer] = useState<string | null>(null);
  const [report, setReport] = useState<CopilotDayReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [payload, setPayload] = useState<unknown>(null);
  const [pick, setPick] = useState<CopilotState["pick"]>(null);

  const { terms, fallback, onNote, date, onActed } = opts;

  /*
    E0.1 — THE STAFF NOTICE (owner ruling 2026-10-10: notice first). Checked when the ask box first
    appears, so the one-line notice is up before the first question; `lib/copilot-notice.ts`.
  */
  useEffect(() => { checkCopilotNotice(); }, []);

  const ask = useCallback((question: string): void => {
    const q = question.trim();
    if (q === "") return;

    const local = (): string | null => fallback?.(q) ?? null;

    setBusy(true);
    setReport(null);
    setPayload(null);
    setPick(null);
    checkCopilotNotice();
    askCopilot(q, terms?.() ?? [], date, screenSlug())
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
        } else if (isActPick(reply.answer.payload) && reply.proposals !== undefined) {
          setPick({ pick: reply.answer.payload, proposals: reply.proposals });
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

  const confirm = useCallback(async (proposal: CopilotProposal): Promise<void> => {
    setBusy(true);
    try {
      const res = await confirmCopilot(proposal);
      setAnswer(t(res.answer.key, sayParams(res.answer.key, res.answer.params, t, i18n.language)));
      setPick(null);
      if (res.outcome === "done") onActed?.();
    } catch {
      setAnswer(t("copilot.answer.failed"));
    } finally { setBusy(false); }
  }, [t, i18n.language, onActed]);

  return {
    answer, report, busy, ask, dismissReport: useCallback(() => { setReport(null); }, []),
    payload, clearPayload: useCallback(() => { setPayload(null); }, []),
    pick, confirm, clearPick: useCallback(() => { setPick(null); }, []),
  };
}

export function isApptPick(p: unknown): p is CopilotApptPick {
  return typeof p === "object" && p !== null && (p as { kind?: unknown }).kind === "apptPick";
}
export function isActPick(p: unknown): p is CopilotActPick {
  const kind = typeof p === "object" && p !== null ? (p as { kind?: unknown }).kind : undefined;
  return kind === "apptPick" || kind === "leavePick" || kind === "coverPick";
}

/* ═══ 20-U U9 — THE ROSTER'S ANSWERS IN THE BOARDS' VOICE ═══
 *
 * The roster tools send a day as its IST date and an instant as ISO; this says them as the boards do,
 * in the reader's language — "Saturday 10 Oct", "on Saturday 10 Oct at 22:00", "right now" — and an
 * empty name list as "nobody". Applied to the roster's keys and the appointment acts' (E2.1) only:
 * another tool's `2028-01-31` (a batch's expiry) means a date with a year and is left as it came.
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
  // #676 — the abilities the server found this asker may use, said as a list in the asker's language.
  if (key === "copilot.answer.notUnderstoodCan") {
    const can = String(params.can ?? "").split(",").filter((c) => c !== "").map((c) => t(`copilot.can.${c}`, { defaultValue: c }));
    const or = lang.startsWith("hi") ? " या " : " or ";
    return { can: can.length < 2 ? can.join("") : `${can.slice(0, -1).join(", ")}${or}${can[can.length - 1]!}` };
  }
  if (!key.startsWith("copilot.answer.roster") && !key.startsWith("copilot.answer.appt") && !key.startsWith("copilot.answer.leave")) return params;
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v !== "string") { out[k] = v; continue; }
    // E2.2 — a leave's kind is a code (CL, comp_off); say it as My leave does. A refusal's reason is the decider's own words.
    if (k === "kind" && key.startsWith("copilot.answer.leave")) { out[k] = t(`myLeave.kind.${v}`, { defaultValue: v }); continue; }
    if (k === "why") { out[k] = v; continue; }
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

/**
 * E0.1 — the asking screen, for the ledger: the route's FIRST path segment only (`opd`, `pharmacy`,
 * `my-day`), never the full path, which can carry a patient's or a visit's id.
 */
export function screenSlug(pathname: string = typeof window === "undefined" ? "/" : window.location.pathname): string {
  const first = (pathname.split("/")[1] ?? "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40);
  return /^[a-z0-9]/.test(first) ? first : "home";
}
