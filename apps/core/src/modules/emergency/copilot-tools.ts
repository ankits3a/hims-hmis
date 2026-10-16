import { isNull } from "drizzle-orm";
import { erMlcObligations } from "../../kernel/db/schema";
import { strongCue as S, weakCue as W } from "../../kernel/copilot/intents";
import { readErBoard } from "./board";
import { ER_BOARD_VIEW, ER_MLC } from "./names";
import type { CopilotIntentDecl, ModuleCopilotIntent } from "../../kernel/copilot/intents";
import type { CopilotAnswer, CopilotToolDecl } from "../../kernel/copilot/types";

/**
 * ER lane 9 (#816) — THE ER's COPILOT QUESTIONS, declared through the open intent seam (#865: a module ships its own
 * cues, menu lines and answer keys; the kernel's mask, halt, cap, permission check and ledger run on them unchanged).
 * FLOOR-ONLY (DECIDED, lane 9): no `menu` and no `help`, so the chooser's request and the chat model's system prompt
 * stay byte-identical (the frozen eval set and `intents.test.ts` pin them); the phrasebook alone routes these. Adding
 * the menu lines is owed with an eval re-recording.
 * Both are READS answered by lookup — counts only, no patient, no name, no money (0058); the model never sees an answer.
 *
 *   emergency.casualty_now  (Doctor Desk seam E10) "casualty mein abhi kitne patient?" — in the department, waiting for
 *                           triage and the longest wait, boarding, expected — `er.board.view`
 *   emergency.mlc_due       "MLC intimation kitne baaki?" — police intimations and countersigns owed, and how many are
 *                           past due — `er.mlc`
 */

export const emergencyCopilotIntents: Readonly<Record<ModuleCopilotIntent, CopilotIntentDecl>> = {
  "emergency.casualty_now": {
    // Cues match as SUBSTRINGS of the question: "er mein" would fire on "counter mein", so only whole ER words are cues.
    cues: [S("casualty"), S("emergency mein"), S("emergency ward"), S("emergency department"), S("कैजुअल्टी"), S("इमरजेंसी")],
    notCues: ["mlc"],
    answerKeys: ["copilot.answer.erCasualtyNow", "copilot.answer.erCasualtyQuiet"],
  },
  "emergency.mlc_due": {
    cues: [S("mlc"), S("mlc intimation"), S("mlc countersign"), S("mlc pending"), S("mlc baaki"), S("medico legal"), S("medico-legal"), S("police intimation"), S("countersign"), S("एमएलसी"), W("intimation")],
    answerKeys: ["copilot.answer.erMlcDue", "copilot.answer.erMlcNoneDue"],
  },
};

export const emergencyCopilotTools: readonly CopilotToolDecl[] = [
  {
    intent: "emergency.casualty_now",
    permission: ER_BOARD_VIEW,
    needsSubject: false,
    kind: "read",
    async run(ctx): Promise<CopilotAnswer> {
      const b = await readErBoard(ctx.db, ctx.actor);
      if (b.stats.inDepartment === 0 && b.stats.expected === 0) return { key: "copilot.answer.erCasualtyQuiet", params: {} };
      return {
        key: "copilot.answer.erCasualtyNow",
        params: {
          inDepartment: b.stats.inDepartment, waitingTriage: b.stats.waitingTriage, longestWait: b.stats.longestTriageWaitMinutes ?? 0,
          boarding: b.stats.boarding, expected: b.stats.expected,
        },
      };
    },
  },
  {
    intent: "emergency.mlc_due",
    permission: ER_MLC,
    needsSubject: false,
    kind: "read",
    async run(ctx): Promise<CopilotAnswer> {
      const now = new Date();
      const owed = await ctx.db.select({ kind: erMlcObligations.kind, dueAt: erMlcObligations.dueAt }).from(erMlcObligations)
        .where(isNull(erMlcObligations.metAt));
      if (owed.length === 0) return { key: "copilot.answer.erMlcNoneDue", params: {} };
      const intimations = owed.filter((o) => o.kind === "police_intimation").length;
      const countersigns = owed.filter((o) => o.kind === "faculty_countersign").length;
      const overdue = owed.filter((o) => o.dueAt <= now).length;
      return { key: "copilot.answer.erMlcDue", params: { intimations, countersigns, overdue } };
    },
  },
];
