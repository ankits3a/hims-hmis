import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { z } from "zod";
import { rosterCoverRequests, staffAbsences } from "../../kernel/db/schema/roster";
import { users } from "../../kernel/db/schema/auth";
import { defineAct } from "../../kernel/copilot/types";
import { RosterError } from "./errors";
import { SELF_LEAVE_KINDS, checkLeave, fileOwnLeave } from "./leave";
import { coverOptions, requestCover } from "./swaps";
import { istDateOfInstant } from "./calendar";
import { leaveDaysOf, leaveKindOf } from "./copilot-leave-words";
import type { CopilotActSpec, CopilotAnswer, CopilotToolDecl } from "../../kernel/copilot/types";
import type { Tx } from "../../kernel/db/client";
import type { CopilotAnswerKey, CopilotLeavePick } from "@hmis/contracts";

/**
 * ═══ E2.2 — LEAVE, AND HANDING ON A DUTY, FROM THE COPILOT CHAT (decision 0069) ═══
 * (spec /opt/hmis-context/SPEC-copilot-leave-swap-2026-10-11.md)
 *
 * The ask WRITES NOTHING. It reads the kind and the days from the words by rules, checks them the way
 * My leave's form is checked (`checkLeave`), and hands back a signed proposal per kind. The person taps
 * one and then Confirm; only `POST /copilot/confirm` files it — through `fileOwnLeave`, the screen's
 * own door, as the person (`via: "direct"`: the confirm is their tap; the matrix keeps the copilot
 * ITSELF at `never`). The proposal carries no reason, and the ledger keeps no question text for these
 * tools (`privateQuestion`), because what a person types beside "CL chahiye" may be why.
 */

const say = (key: CopilotAnswerKey, params: Record<string, string | number> = {}): CopilotAnswer => ({ key, params });
const istToday = (now: Date): string => istDateOfInstant(now);

/** A `checkLeave` refusal, as the sentence the chat says. Anything else is not ours to word. */
function leaveRefusal(e: unknown): CopilotAnswerKey {
  if (!(e instanceof RosterError)) throw e;
  if (e.code === "leave_in_past") return "copilot.answer.leaveInPast";
  if (e.code === "leave_overlaps") return "copilot.answer.leaveOverlaps";
  if (e.code === "unknown_absence_kind") return "copilot.answer.leaveKindNotHere";
  if (e.code === "invalid_window") return e.message.includes("at most") ? "copilot.answer.leaveTooLong" : "copilot.answer.leaveWhichDays";
  throw e;
}

const dayDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** STRICT, and with no reason field: a proposal cannot carry one, whatever a client sends. */
const leaveArgs = z.object({ kind: z.enum(SELF_LEAVE_KINDS), from: dayDate, to: dayDate }).strict();
type LeaveArgs = z.infer<typeof leaveArgs>;

export const leaveApplyTool: CopilotToolDecl = {
  intent: "roster.leave_apply",
  /* Everybody may ask for their own leave holding nothing (`request_absence: open`); the tool reads and files the asker's own only. */
  permission: null,
  needsSubject: false,
  kind: "act",
  privateQuestion: true,
  async run(ctx): Promise<CopilotAnswer> {
    if (ctx.actor.type !== "user") return say("copilot.answer.notPermitted");
    const typed = ctx.typed ?? ctx.question;
    const days = leaveDaysOf(typed, istToday(new Date()));
    if (days === null) return say("copilot.answer.leaveWhichDays");
    const named = leaveKindOf(typed);
    const kinds = named === null ? [...SELF_LEAVE_KINDS] : [named];
    let n = 0;
    try { n = (await checkLeave(ctx.db, ctx.actor.id, { kind: kinds[0]!, ...days })).days; } catch (e) { return say(leaveRefusal(e)); }
    const pick: CopilotLeavePick = { kind: "leavePick", from: days.from, to: days.to, days: n, options: kinds.map((leave, proposal) => ({ leave, proposal })) };
    const params = { from: days.from, to: days.to, count: n };
    const one = days.from === days.to;
    return {
      ...(named === null
        ? say(one ? "copilot.answer.leavePickKindDay" : "copilot.answer.leavePickKind", params)
        : say(one ? "copilot.answer.leavePickDay" : "copilot.answer.leavePick", { ...params, kind: named })),
      payload: pick,
      proposeMany: kinds.map((kind) => ({ args: { kind, from: days.from, to: days.to } satisfies LeaveArgs, subject: null })),
    };
  },
  act: defineAct<LeaveArgs>({
    args: leaveArgs,
    async recheck(tx, a, ctx) {
      try { await checkLeave(tx, ctx.actor.id, a); return null; } catch (e) { return leaveRefusal(e); }
    },
    async apply(tx, a, ctx) {
      const { absenceId } = await fileOwnLeave(tx, ctx.actor, a);
      return { answer: say("copilot.answer.leaveFiled", { kind: a.kind, from: a.from, to: a.to }), module: "roster", rowId: absenceId, subjectPatientId: null };
    },
    verify: {
      /* The row as written: the asker's own, waiting, those days, that kind — and no reason. */
      async readBack(tx, a, result, ctx) {
        const [row] = await tx.select().from(staffAbsences).where(eq(staffAbsences.id, result.rowId));
        return row !== undefined && row.userId === ctx.actor.id && row.requestedBy === ctx.actor.id && row.status === "requested"
          && row.kind === a.kind && row.reason === null && istDateOfInstant(row.startsAt) === a.from
          && istDateOfInstant(new Date(row.endsAt.getTime() - 1)) === a.to;
      },
    },
  }),
};

/**
 * "Meri leave ka kya hua?" — the asker's newest leave still ahead (else the newest decided in the last
 * fortnight): waiting, approved, taken back, or refused WITH the decider's reason. The reason is the
 * person's own to read (decision 0069); it goes to their screen in the answer and is not kept anywhere
 * by the copilot (the ledger keeps the answer's key only).
 */
export const leaveStatusTool: CopilotToolDecl = {
  intent: "roster.leave_status",
  permission: null,
  needsSubject: false,
  privateQuestion: true,
  async run(ctx): Promise<CopilotAnswer> {
    if (ctx.actor.type !== "user") return say("copilot.answer.notPermitted");
    const since = new Date(Date.now() - 14 * 86_400_000);
    const [row] = await ctx.db.select().from(staffAbsences)
      .where(and(eq(staffAbsences.userId, ctx.actor.id), gt(staffAbsences.endsAt, since), inArray(staffAbsences.source, ["manual"])))
      .orderBy(desc(staffAbsences.updatedAt)).limit(1);
    if (row === undefined) return say("copilot.answer.leaveNone");
    const params = { kind: row.kind, from: istDateOfInstant(row.startsAt), to: istDateOfInstant(new Date(row.endsAt.getTime() - 1)) };
    const who = row.approvedBy === null ? ""
      : (await ctx.db.select({ name: users.fullName }).from(users).where(eq(users.id, row.approvedBy)))[0]?.name ?? "";
    if (row.status === "approved") return say("copilot.answer.leaveStatusApproved", { ...params, who });
    if (row.status === "rejected") return say("copilot.answer.leaveStatusRefused", { ...params, who, why: row.decisionNote ?? "" });
    if (row.status === "cancelled") return say("copilot.answer.leaveStatusCancelled", params);
    return say("copilot.answer.leaveStatusRequested", params);
  },
};

/* ═══ A COVER OR A SWAP, CONFIRMED ═══ */

const coverArgs = z.object({
  assignmentId: z.string().min(1).max(64),
  counterpartId: z.string().min(1).max(64),
  counterpartAssignmentId: z.string().min(1).max(64).nullable(),
}).strict();
export type CoverArgs = z.infer<typeof coverArgs>;

/**
 * `roster.ask_cover`'s write: the same `requestCover` My duties' "Ask" calls, as the person. At
 * confirm "who can take it" is read again: a person who can no longer take it (a duty moved, a rule
 * now breaks) or a swap no longer offered is refused in a sentence, and nothing is asked of anybody.
 */
export const coverAct: CopilotActSpec = defineAct<CoverArgs>({
  args: coverArgs,
  async recheck(tx, a, ctx) {
    let options;
    try { options = await coverOptions(tx, ctx.actor, a.assignmentId); } catch (e) {
      if (e instanceof RosterError) return "copilot.answer.coverRefused";
      throw e;
    }
    if (options.openRequestId !== null) return "copilot.answer.rosterCoverAlready";
    const can = options.canTake.find((c) => c.userId === a.counterpartId);
    if (can === undefined) return "copilot.answer.coverRefused";
    if (a.counterpartAssignmentId !== null && !can.swaps.some((s) => s.assignmentId === a.counterpartAssignmentId)) return "copilot.answer.coverRefused";
    return null;
  },
  async apply(tx: Tx, a, ctx) {
    const { requestId } = await requestCover(tx, ctx.actor, {
      assignmentId: a.assignmentId, counterpartId: a.counterpartId,
      ...(a.counterpartAssignmentId === null ? {} : { counterpartAssignmentId: a.counterpartAssignmentId }), note: null,
    });
    const [who] = await tx.select({ name: users.fullName }).from(users).where(eq(users.id, a.counterpartId));
    return {
      answer: say(a.counterpartAssignmentId === null ? "copilot.answer.coverAsked" : "copilot.answer.swapAsked", { name: who?.name ?? "" }),
      module: "roster", rowId: requestId, subjectPatientId: null,
    };
  },
  verify: {
    /* The request as written: asked, of that person, for that duty (and that one back), by the asker. */
    async readBack(tx, a, result, ctx) {
      const [r] = await tx.select().from(rosterCoverRequests).where(eq(rosterCoverRequests.id, result.rowId));
      return r !== undefined && r.status === "asked" && r.requestedBy === ctx.actor.id && r.assignmentId === a.assignmentId
        && r.counterpartId === a.counterpartId && r.counterpartAssignmentId === a.counterpartAssignmentId;
    },
  },
});

export const rosterLeaveCopilotTools: readonly CopilotToolDecl[] = [leaveApplyTool, leaveStatusTool];
