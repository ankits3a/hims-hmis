import { strongCue as S, weakCue as W } from "../../kernel/copilot/intents";
import type { CopilotIntentDecl, ModuleCopilotIntent } from "../../kernel/copilot/intents";

/**
 * #598 (plan E0.7) — THE ROSTER'S OWN COPILOT INTENTS, declared here rather than in the kernel's
 * phrasebook, chooser menu and model prompt. `roster.ask_cover` is the first intent to move through the
 * seam; its cues, menu lines and wording are exactly what the kernel held, so it routes and is offered
 * byte-for-byte as before (the frozen eval set's recordings are keyed by the chooser's request).
 * The roster's other intents still sit in the kernel's tables and move the same way, one at a time.
 */
export const rosterCopilotIntents: Readonly<Record<ModuleCopilotIntent, CopilotIntentDecl>> = {
  /**
   * "Saturday night koi le sakta hai kya?" — somebody to take MY duty. The tool only DRAFTS (the
   * person sends the request with their own tap). Bare `badal` is left out: "doctor badal do" at a
   * counter is about a patient's doctor, not a duty.
   */
  "roster.ask_cover": {
    cues: [
      S("le sakta"), S("le sakti"), S("le sakte"), S("le lega"), S("le legi"), S("koi le"), S("cover kar"), S("cover"), S("swap"),
      S("duty badal"), S("meri jagah"), S("take my"), S("anyone take"), S("someone take"), S("मेरी जगह"), S("ले सकता"), S("ले सकती"),
      /* #672 — "a swap FOR my night" was answered as the night itself (`my night`). */
      S("swap for"), S("swap my"), S("cover my"), S("cover for my"),
      W("koi"), W("कोई"),
    ],
    menu: {
      line: "the asker wants somebody to take or swap THEIR OWN duty: who could cover it",
      what: "the asker wants somebody to TAKE or swap THEIR OWN duty: who could cover it",
      not_for: "who is on duty now; a patient's appointment being moved",
      examples: ["Saturday night koi le sakta hai kya?", "can anyone take my Tuesday night"],
    },
    /* The ask's answers (`copilot-tools.ts`) and the confirm's (`copilot-acts.ts` coverAct). */
    answerKeys: [
      "copilot.answer.rosterCoverDraft", "copilot.answer.rosterCoverDraftDuty", "copilot.answer.rosterCoverAlready",
      "copilot.answer.rosterCoverNobody", "copilot.answer.rosterCoverNoDuty", "copilot.answer.rosterCoverNoDutyOn",
      "copilot.answer.coverAsked", "copilot.answer.swapAsked", "copilot.answer.coverRefused",
    ],
  },
};
