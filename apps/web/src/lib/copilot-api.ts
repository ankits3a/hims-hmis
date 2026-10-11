import { api } from "./api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-COPILOT — THE DESK COPILOT, FROM THE BROWSER
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * One call, through `api()` and therefore through the `/api` prefix and the caller's own bearer
 * token. There is NO provider credential in this bundle and there never will be: FD-8 rejected a
 * browser-side key in as many words — *"a browser-side key would put a gateway credential in a
 * bundle every user of the hospital can read"* — and the server holds the only one.
 */
export type CopilotAnswer = {
  key: string;
  params: Record<string, string | number>;
  payload?: unknown;
};

export type CopilotReply = {
  answer: CopilotAnswer;
  /** Where the routing came from. Shown to the clerk — `triage.ts`'s rule about hidden origins. */
  source: "phrasebook" | "model" | "none";
  intent: string | null;
};

/** The day report's payload, when `intent` is `my_day_report`. Mirrors `kernel/desk`'s own shape. */
export type CopilotDayReport = {
  date: string;
  provisional: boolean;
  sections: { key: string; titleKey: string; columnKeys: string[]; rows: string[][]; totals?: string[] }[];
};

export function askCopilot(
  question: string,
  /**
   * The names currently ON the screen, so the server can mask them by value before anything could
   * reach a model. A UHID has a shape a regular expression finds; a name does not, and this screen
   * is the only thing that knows which people it is displaying. See `kernel/copilot/mask.ts`.
   */
  terms: string[],
  date?: string,
  /** E0.1 — the asking screen for the ledger: the route's first path segment, never a full path. */
  screen?: string,
): Promise<CopilotReply> {
  return api<CopilotReply>("POST", "/copilot/ask", { question, terms, date, screen });
}

/** E0.1 — has this user dismissed the staff notice (owner ruling 2026-10-10: notice first)? */
export function getCopilotNotice(): Promise<{ seen: boolean }> {
  return api<{ seen: boolean }>("GET", "/copilot/notice");
}

export function dismissCopilotNotice(): Promise<void> {
  return api<void>("POST", "/copilot/notice");
}

export type CopilotRouteTimings = { asks: number; p50Ms: number | null; p95Ms: number | null };

/** `GET /copilot/health` — one IST day's totals. Aggregate only: it names nobody. */
export type CopilotHealth = {
  date: string;
  asks: number;
  askers: number;
  byOutcome: Record<string, number>;
  byRoute: Record<"phrasebook" | "chooser" | "model" | "none", CopilotRouteTimings>;
  notUnderstoodShare: number | null;
  acts: number;
  /** E0.5 — chooser + model calls that day and their ESTIMATED cost in rupees. */
  modelCalls: number;
  spendInr: number;
  cappedAsks: number;
  /** E0.5 — the daily cap (decision 0064) and whether today has reached it. */
  capInr: number;
  capped: boolean;
  /** E0.3 — the halted scopes now. */
  halts: { scope: CopilotHaltScope; haltedAt: string; reason: string | null }[];
};

export const COPILOT_HALT_SCOPES = ["read", "act", "draft", "global"] as const;
export type CopilotHaltScope = (typeof COPILOT_HALT_SCOPES)[number];

/** E0.3 — `POST /copilot/halt` (`copilot.halt.set`). */
export function haltCopilot(scope: CopilotHaltScope, reason?: string): Promise<unknown> {
  return api("POST", "/copilot/halt", reason === undefined ? { scope } : { scope, reason });
}

/** E0.3 — `POST /copilot/halt/clear` (`copilot.halt.clear`; global needs `copilot.halt.clear_global`). */
export function clearCopilotHalt(scope: CopilotHaltScope): Promise<unknown> {
  return api("POST", "/copilot/halt/clear", { scope });
}

export function getCopilotHealth(date?: string): Promise<CopilotHealth> {
  return api<CopilotHealth>("GET", date === undefined ? "/copilot/health" : `/copilot/health?date=${encodeURIComponent(date)}`);
}
