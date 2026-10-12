import { eq } from "drizzle-orm";
import { z } from "zod";
import { REMINDER_MAX_ACTIVE, REMINDER_MIN_LEAD_MS, REMINDER_REPEATS, REMINDER_TEXT_MAX, firstDue } from "@hmis/contracts";
import { userReminders } from "../db/schema";
import { defineAct } from "../copilot/types";
import { activeReminderCount, createReminderIn } from "./reminders";
import { readReminder } from "./copilot-words";
import type { CopilotAnswer, CopilotToolDecl } from "../copilot/types";
import type { CopilotAnswerKey, CopilotReminderPick } from "@hmis/contracts";

/**
 * ═══ E2.3 — A REMINDER FROM THE COPILOT CHAT (#593) ═══
 * (spec /opt/hmis-context/SPEC-copilot-reminders-2026-10-12.md, owner yes 2026-10-12)
 *
 * "remind me at 4 to see bed 12". The ask WRITES NOTHING: the time, the repeat and the words are read
 * by rules (`copilot-words.ts`), and one signed proposal comes back for a card the person sees whole.
 * Only `POST /copilot/confirm` sets it — through `createReminderIn`, the Reminders screen's own
 * function, inside the confirm's transaction, as the person.
 *
 * PRIVATE: the reminder's words are the person's own and may name a patient. The intent is floor-only
 * (no model ever sees the question), the tool is `privateQuestion` (the ledger keeps no question
 * text) and `copilot_acts` keeps the args' hash, never the args. The words travel only in the signed
 * proposal back to the person who typed them.
 */

const say = (key: CopilotAnswerKey, params: Record<string, string | number> = {}): CopilotAnswer => ({ key, params });

const WHY: Record<"noTime" | "past" | "noText" | "tooLong", CopilotAnswerKey> = {
  noTime: "copilot.answer.reminderWhatTime",
  past: "copilot.answer.reminderPast",
  noText: "copilot.answer.reminderWhat",
  tooLong: "copilot.answer.reminderTooLong",
};

const reminderArgs = z.object({
  text: z.string().trim().min(1).max(REMINDER_TEXT_MAX),
  at: z.string().datetime({ offset: true }),
  repeat: z.enum(REMINDER_REPEATS),
}).strict();
type ReminderArgs = z.infer<typeof reminderArgs>;

export const reminderCreateTool: CopilotToolDecl = {
  intent: "reminders.create",
  /* A person's own reminder, as on the Reminders screen: no permission, and it can name nobody else. */
  permission: null,
  needsSubject: false,
  kind: "act",
  privateQuestion: true,
  async run(ctx): Promise<CopilotAnswer> {
    if (ctx.actor.type !== "user") return say("copilot.answer.notPermitted");
    const read = readReminder(ctx.typed ?? ctx.question, new Date());
    if (!read.ok) return say(WHY[read.why]);
    if ((await activeReminderCount(ctx.db, ctx.actor.id)) >= REMINDER_MAX_ACTIVE) return say("copilot.answer.reminderLimit");
    const at = firstDue(read.repeat, read.at).toISOString();
    const pick: CopilotReminderPick = { kind: "reminderPick", text: read.text, at, repeat: read.repeat, proposal: 0 };
    return {
      ...say("copilot.answer.reminderPick", { when: at }),
      payload: pick,
      proposeMany: [{ args: { text: read.text, at, repeat: read.repeat } satisfies ReminderArgs, subject: null }],
    };
  },
  act: defineAct<ReminderArgs>({
    args: reminderArgs,
    async recheck(tx, a, ctx) {
      if (ctx.actor.type !== "user") return "copilot.answer.notPermitted";
      if (Date.parse(a.at) < Date.now() + REMINDER_MIN_LEAD_MS) return "copilot.answer.reminderPast";
      if ((await activeReminderCount(tx, ctx.actor.id)) >= REMINDER_MAX_ACTIVE) return "copilot.answer.reminderLimit";
      return null;
    },
    async apply(tx, a, ctx) {
      const row = await createReminderIn(tx, ctx.actor, a);
      return { answer: say("copilot.answer.reminderSet", { when: row.dueAt }), module: "reminders", rowId: row.id, subjectPatientId: null };
    },
    verify: {
      /* The row as written: the asker's own, those words, that time and that repeat, not yet fired. */
      async readBack(tx, a, result, ctx) {
        const [row] = await tx.select().from(userReminders).where(eq(userReminders.id, result.rowId));
        return row !== undefined && row.userId === ctx.actor.id && row.text === a.text.trim() && row.repeat === a.repeat
          && row.dueAt.getTime() === firstDue(a.repeat, new Date(a.at)).getTime() && row.firedAt === null && row.cancelledAt === null;
      },
    },
  }),
};
