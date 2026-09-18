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
): Promise<CopilotReply> {
  return api<CopilotReply>("POST", "/copilot/ask", { question, terms, date });
}
