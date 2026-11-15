import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { imagingMediaRequests, imagingReportDelivery, imagingStudies, IMAGING_ACTED_OUTCOMES } from "../../kernel/db/schema/radiology";
import { resources } from "../../kernel/db/schema/resources";
import { defineAct } from "../../kernel/copilot/types";
import { markNoShow, rescheduleStudy, scheduleStudy } from "./schedule";
import { proposeSlot } from "./desk";
import { isTreatingDoctor, markActedUpon, ACTED_NOTE_MIN } from "./closed-loop";
import { requestMedia } from "./release";
import {
  durationOf, ownWords, releasedReportOf, slotStillFree, studiesForSubject, studyNames, waitingToBook,
} from "./copilot-tools";
import type { SubjectStudy } from "./copilot-tools";
import type { CopilotActCtx, CopilotAnswer, CopilotToolCtx, CopilotToolDecl } from "../../kernel/copilot/types";
import type { Db, Tx } from "../../kernel/db/client";
import type { CopilotAnswerKey, CopilotImagingPick } from "@hmis/contracts";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * #1082 (IM5) — THE IMAGING COPILOT'S FOUR ACTS, behind propose → confirm (spec 580, E0.2)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Exactly four, and each is the screen's own act called as the confirming person:
 *
 *   radiology.book_slot        `scheduleStudy`                 the desk's Slot step
 *   radiology.move_or_no_show  `rescheduleStudy`, `markNoShow`  the desk's Move / No-show, with the person's reason
 *   radiology.mark_acted       `markActedUpon`                  the treating doctor's "what the report changed"
 *   radiology.request_film_cd  `requestMedia`                   film or CD on request (ruling 1)
 *
 * The ask WRITES NOTHING: it reads the study (one option per study when the subject names several),
 * and hands back a signed proposal per option. Only `POST /copilot/confirm` writes, and there
 * `recheck` re-reads the slot, the study's state or the report's version; `apply` calls the act; and
 * `verify` reads the row back — all in one transaction with the `copilot_acts` row, so a refusal or a
 * failed read-back leaves neither.
 *
 * Words a person typed (a no-show's reason, an acted-upon note) are taken only from after a colon
 * (`ownWords`) and are never composed. The module's own guards stay the guarantee: `markActedUpon`
 * refuses a doctor who does not treat the patient whatever `recheck` said, `scheduleStudy` refuses a
 * taken slot under the machine's lock.
 */

const say = (key: CopilotAnswerKey, params: Record<string, string | number> = {}): CopilotAnswer => ({ key, params });
const isoInstant = z.string().datetime();
const id = z.string().min(1).max(64);

/** A subject that names nothing at all, told apart from one that names studies in another state. */
async function nothingAnswer(ctx: CopilotToolCtx, none: CopilotAnswerKey): Promise<CopilotAnswer> {
  return say((await studiesForSubject(ctx.db, ctx.actor, ctx.subject!)).length === 0 ? "copilot.answer.radNoStudy" : none);
}

/** The pick the web shows, and the proposals in the same order. */
function picked(
  key: CopilotAnswerKey, act: CopilotImagingPick["act"],
  options: { args: unknown; option: Omit<CopilotImagingPick["options"][number], "proposal"> }[], subject: string | null,
): CopilotAnswer {
  const pick: CopilotImagingPick = { kind: "imagingPick", act, options: options.map((o, proposal) => ({ ...o.option, proposal })) };
  return { ...say(key, { count: options.length }), payload: pick, proposeMany: options.map((o) => ({ args: o.args, subject })) };
}

async function studyRow(exec: Db | Tx, studyId: string) {
  return (await (exec as Db).select().from(imagingStudies).where(eq(imagingStudies.id, studyId)))[0];
}

async function machineCode(exec: Db | Tx, deviceResourceId: string): Promise<string> {
  return (await (exec as Db).select({ code: resources.code }).from(resources).where(eq(resources.id, deviceResourceId)))[0]?.code ?? "";
}

/* ═══════════════════════════════════ book a slot ═══════════════════════════════════ */

const bookArgs = z.object({ studyId: id, deviceResourceId: id, scheduledAt: isoInstant }).strict();
type BookArgs = z.infer<typeof bookArgs>;

/** Re-read at confirm: the study still waits for a slot, and the slot is still free and ahead. */
async function slotRecheck(tx: Tx, a: { studyId: string; deviceResourceId: string; scheduledAt: string }, waiting: (s: SubjectStudy) => boolean): Promise<CopilotAnswerKey | null> {
  const s = await studyRow(tx, a.studyId);
  if (s === undefined || !waiting(s)) return "copilot.answer.radStudyChanged";
  const at = new Date(a.scheduledAt);
  if (at.getTime() <= Date.now()) return "copilot.answer.radSlotTaken";
  const minutes = await durationOf(tx, s.studyTypeCode);
  return (await slotStillFree(tx, { studyId: s.id, deviceResourceId: a.deviceResourceId, at, minutes })) ? null : "copilot.answer.radSlotTaken";
}

export const bookSlotTool: CopilotToolDecl = {
  intent: "radiology.book_slot",
  permission: "radiology.schedule",
  needsSubject: true,
  kind: "act",
  /** One option per study waiting to book: the slot `proposeSlot` (IM2) would prefill at the desk. */
  async run(ctx) {
    const studies = (await studiesForSubject(ctx.db, ctx.actor, ctx.subject!, ["scheduled"])).filter(waitingToBook);
    if (studies.length === 0) return await nothingAnswer(ctx, "copilot.answer.radNothingToBook");
    const name = await studyNames(ctx.db);
    const options: { args: BookArgs; option: Omit<CopilotImagingPick["options"][number], "proposal"> }[] = [];
    for (const s of studies) {
      const slot = await proposeSlot(ctx.db, ctx.actor, { studyId: s.id, now: new Date() });
      if (slot === null) continue;
      options.push({
        args: { studyId: s.id, deviceResourceId: slot.deviceResourceId, scheduledAt: slot.scheduledAt.toISOString() },
        option: { accessionNo: s.accessionNo, study: name(s.studyTypeCode), machine: slot.code, at: slot.scheduledAt.toISOString() },
      });
    }
    if (options.length === 0) return say("copilot.answer.radNextSlotNone", { accession: studies[0]!.accessionNo });
    return picked("copilot.answer.radBookPick", "book", options, ctx.subject);
  },
  act: defineAct<BookArgs>({
    args: bookArgs,
    recheck: (tx, a) => slotRecheck(tx, a, waitingToBook),
    async apply(tx, a, ctx: CopilotActCtx) {
      const booked = await scheduleStudy(tx, ctx.actor, { studyId: a.studyId, deviceResourceId: a.deviceResourceId, scheduledAt: new Date(a.scheduledAt) });
      const s = (await studyRow(tx, a.studyId))!;
      return {
        answer: say("copilot.answer.radBooked", { accession: booked.accessionNo, machine: await machineCode(tx, a.deviceResourceId), when: booked.scheduledAt.toISOString() }),
        module: "radiology", rowId: a.studyId, subjectPatientId: s.patientId,
      };
    },
    verify: {
      /** The study as written: booked, on that machine, at that time. */
      async readBack(tx, a) {
        const s = await studyRow(tx, a.studyId);
        return s !== undefined && s.status === "scheduled" && s.deviceResourceId === a.deviceResourceId
          && s.scheduledAt?.getTime() === new Date(a.scheduledAt).getTime();
      },
    },
  }),
};

/* ═══════════════════════════════ move, or a no-show ═══════════════════════════════ */

/** Words that say the patient did not come. Anything else asked of this tool is a move. */
const NO_SHOW_RE = /no[\s-]?show|did\s*n[o']?t\s+come|nahi?n?\s+aay?[ae]|aaya\s+nahi|नहीं\s+आ|नो\s+शो/i;
export const asksNoShow = (typed: string): boolean => NO_SHOW_RE.test(typed);

const moveArgs = z.discriminatedUnion("op", [
  z.object({ op: z.literal("no_show"), studyId: id, reason: z.string().min(3).max(500) }).strict(),
  z.object({ op: z.literal("move"), studyId: id, deviceResourceId: id, scheduledAt: isoInstant, reason: z.string().min(3).max(500) }).strict(),
]);
type MoveArgs = z.infer<typeof moveArgs>;

/** A booking that can move or be a no-show: booked (with a slot) or checked in (`schedule.ts`). */
const movable = (s: Pick<SubjectStudy, "status" | "scheduledAt">): boolean =>
  (s.status === "scheduled" && s.scheduledAt !== null) || s.status === "checked_in";

export const moveOrNoShowTool: CopilotToolDecl = {
  intent: "radiology.move_or_no_show",
  permission: "radiology.schedule",
  needsSubject: true,
  kind: "act",
  /**
   * The desk's Move or No-show, reason required by both (18-S RS3): the person's words after a colon.
   * A move offers the next free slot after the booked one (`proposeSlot` from there).
   */
  async run(ctx) {
    const typed = ctx.typed ?? ctx.question;
    const studies = (await studiesForSubject(ctx.db, ctx.actor, ctx.subject!, ["scheduled", "checked_in"])).filter(movable);
    if (studies.length === 0) return await nothingAnswer(ctx, "copilot.answer.radNothingToMove");
    const reason = ownWords(typed, ctx.subject);
    if (reason === null || reason.length < 3) return say("copilot.answer.radNeedReason");
    const name = await studyNames(ctx.db);
    if (asksNoShow(typed)) {
      return picked("copilot.answer.radNoShowPick", "no_show", studies.map((s) => ({
        args: { op: "no_show", studyId: s.id, reason } satisfies MoveArgs,
        option: { accessionNo: s.accessionNo, study: name(s.studyTypeCode), reason },
      })), ctx.subject);
    }
    const options: { args: MoveArgs; option: Omit<CopilotImagingPick["options"][number], "proposal"> }[] = [];
    for (const s of studies) {
      const after = s.scheduledAt === null ? Date.now() : Math.max(Date.now(), s.scheduledAt.getTime() + s.durationMin * 60_000);
      const slot = await proposeSlot(ctx.db, ctx.actor, { studyId: s.id, now: new Date(after) });
      if (slot === null) continue;
      options.push({
        args: { op: "move", studyId: s.id, deviceResourceId: slot.deviceResourceId, scheduledAt: slot.scheduledAt.toISOString(), reason },
        option: { accessionNo: s.accessionNo, study: name(s.studyTypeCode), machine: slot.code, at: slot.scheduledAt.toISOString(), reason },
      });
    }
    if (options.length === 0) return say("copilot.answer.radNextSlotNone", { accession: studies[0]!.accessionNo });
    return picked("copilot.answer.radMovePick", "move", options, ctx.subject);
  },
  act: defineAct<MoveArgs>({
    args: moveArgs,
    async recheck(tx, a) {
      if (a.op === "move") return await slotRecheck(tx, a, movable);
      const s = await studyRow(tx, a.studyId);
      return s !== undefined && movable(s) ? null : "copilot.answer.radStudyChanged";
    },
    async apply(tx, a, ctx: CopilotActCtx) {
      const s = (await studyRow(tx, a.studyId))!;
      if (a.op === "no_show") {
        await markNoShow(tx, ctx.actor, a.studyId, a.reason);
        return { answer: say("copilot.answer.radNoShowDone", { accession: s.accessionNo }), module: "radiology", rowId: a.studyId, subjectPatientId: s.patientId };
      }
      const moved = await rescheduleStudy(tx, ctx.actor, { studyId: a.studyId, deviceResourceId: a.deviceResourceId, scheduledAt: new Date(a.scheduledAt), reason: a.reason });
      return {
        answer: say("copilot.answer.radMoved", { accession: moved.accessionNo, machine: await machineCode(tx, a.deviceResourceId), when: moved.scheduledAt.toISOString() }),
        module: "radiology", rowId: a.studyId, subjectPatientId: s.patientId,
      };
    },
    verify: {
      /** A no-show is `no_show`; a move sits on the new machine at the new time. */
      async readBack(tx, a) {
        const s = await studyRow(tx, a.studyId);
        if (s === undefined) return false;
        if (a.op === "no_show") return s.status === "no_show";
        return s.deviceResourceId === a.deviceResourceId && s.scheduledAt?.getTime() === new Date(a.scheduledAt).getTime();
      },
    },
  }),
};

/* ═══════════════════════════ what the report changed ═══════════════════════════ */

/** An outcome the doctor's words name, or null (then each outcome is offered and the doctor taps one). */
const OUTCOME_WORDS: readonly [(typeof IMAGING_ACTED_OUTCOMES)[number], RegExp][] = [
  ["no_change", /no change|koi badlav nahi|badlav nahi|कोई बदलाव नहीं/i],
  ["referred", /\brefer|रेफर/i],
  ["followup_booked", /follow[\s-]?up (booked|book)|फॉलो अप बुक/i],
  ["discussed_with_patient", /discussed|explained|samjhaya|batāya|समझाया|बताया/i],
  ["changed_treatment", /changed treatment|treatment (changed|badal)|started|stopped|dawa badal|दवा बदल|इलाज बदल/i],
];
export function outcomeOf(note: string): (typeof IMAGING_ACTED_OUTCOMES)[number] | null {
  return OUTCOME_WORDS.find(([, re]) => re.test(note))?.[0] ?? null;
}

const actedArgs = z.object({
  studyId: id, reportId: id, version: z.number().int().positive(),
  outcome: z.enum(IMAGING_ACTED_OUTCOMES), note: z.string().min(ACTED_NOTE_MIN).max(500),
}).strict();
type ActedArgs = z.infer<typeof actedArgs>;

async function deliveryOf(exec: Db | Tx, reportId: string) {
  return (await (exec as Db).select().from(imagingReportDelivery).where(eq(imagingReportDelivery.reportId, reportId)))[0];
}

export const markActedTool: CopilotToolDecl = {
  intent: "radiology.mark_acted",
  permission: "radiology.reports.read",
  needsSubject: true,
  kind: "act",
  /** The treating doctor only (`isTreatingDoctor`), on a released report, with their own note after a colon. */
  async run(ctx) {
    const studies = await studiesForSubject(ctx.db, ctx.actor, ctx.subject!, ["published"]);
    if (studies.length === 0) return await nothingAnswer(ctx, "copilot.answer.radActedNothing");
    const mine: { s: SubjectStudy; report: { id: string; version: number } }[] = [];
    let released = 0;
    for (const s of studies) {
      const report = await releasedReportOf(ctx.db, s.id);
      if (report === null) continue;
      released += 1;
      if (await isTreatingDoctor(ctx.db, ctx.actor, s.id)) mine.push({ s, report });
    }
    if (released === 0) return say("copilot.answer.radActedNothing");
    if (mine.length === 0) return say("copilot.answer.radActedNotYours");
    const note = ownWords(ctx.typed ?? ctx.question, ctx.subject);
    if (note === null || note.length < ACTED_NOTE_MIN) return say("copilot.answer.radActedNeedNote");
    const open: typeof mine = [];
    for (const m of mine) if ((await deliveryOf(ctx.db, m.report.id))?.actedAt == null) open.push(m);
    if (open.length === 0) return say("copilot.answer.radActedAlready");
    const said = outcomeOf(note);
    const outcomes = said === null ? [...IMAGING_ACTED_OUTCOMES] : [said];
    const name = await studyNames(ctx.db);
    return picked("copilot.answer.radActedPick", "acted", open.slice(0, 3).flatMap(({ s, report }) => outcomes.map((outcome) => ({
      args: { studyId: s.id, reportId: report.id, version: report.version, outcome, note } satisfies ActedArgs,
      option: { accessionNo: s.accessionNo, study: name(s.studyTypeCode), outcome },
    }))), ctx.subject);
  },
  act: defineAct<ActedArgs>({
    args: actedArgs,
    /** Still the treating doctor, still the released version asked about, and nothing recorded on it yet. */
    async recheck(tx, a, ctx) {
      if (!(await isTreatingDoctor(tx, ctx.actor, a.studyId))) return "copilot.answer.radActedNotYours";
      const current = await releasedReportOf(tx, a.studyId);
      if (current === null || current.id !== a.reportId || current.version !== a.version) return "copilot.answer.radStudyChanged";
      return (await deliveryOf(tx, a.reportId))?.actedAt == null ? null : "copilot.answer.radActedAlready";
    },
    async apply(tx, a, ctx) {
      await markActedUpon(tx, ctx.actor, { reportId: a.reportId, outcome: a.outcome, note: a.note });
      const s = (await studyRow(tx, a.studyId))!;
      return { answer: say("copilot.answer.radActedDone", { accession: s.accessionNo }), module: "radiology", rowId: a.reportId, subjectPatientId: s.patientId };
    },
    verify: {
      /** The delivery row as stamped: by this doctor, this outcome, these words. */
      async readBack(tx, a, _result, ctx) {
        const d = await deliveryOf(tx, a.reportId);
        return d !== undefined && d.actedBy === ctx.actor.id && d.actedOutcome === a.outcome && d.actedNote === a.note.trim();
      },
    },
  }),
};

/* ═══════════════════════════════ film or CD ═══════════════════════════════ */

const mediaArgs = z.object({ studyId: id, kind: z.enum(["film", "cd"]), quantity: z.number().int().min(1).max(20) }).strict();
type MediaArgs = z.infer<typeof mediaArgs>;

const CD_RE = /\bcd\b|सीडी/i;
const FILM_RE = /film|फ़?फिल्म|फ़िल्म/i;
/** "2 film", "3 sheets": a whole number before film or sheet, 1 to 20; else one. */
function sheetsOf(typed: string): number {
  const n = /(\d{1,2})\s*(?:film|sheet|फिल्म|शीट)/i.exec(typed)?.[1];
  const q = n === undefined ? 1 : Number(n);
  return q >= 1 && q <= 20 ? q : 1;
}

export const requestFilmCdTool: CopilotToolDecl = {
  intent: "radiology.request_film_cd",
  permission: "radiology.schedule",
  needsSubject: true,
  kind: "act",
  /** Film or CD on request for a released report (ruling 1). Says nothing of money: billing's own path charges it. */
  async run(ctx) {
    const typed = ctx.typed ?? ctx.question;
    const studies = await studiesForSubject(ctx.db, ctx.actor, ctx.subject!, ["published"]);
    if (studies.length === 0) {
      const any = await studiesForSubject(ctx.db, ctx.actor, ctx.subject!);
      return any.length === 0 ? say("copilot.answer.radNoStudy") : say("copilot.answer.radMediaNotReleased", { accession: any[0]!.accessionNo });
    }
    const cd = CD_RE.test(typed);
    const film = FILM_RE.test(typed.replace(CD_RE, " "));
    const kinds: ("film" | "cd")[] = cd === film ? ["film", "cd"] : cd ? ["cd"] : ["film"];
    const name = await studyNames(ctx.db);
    const options: { args: MediaArgs; option: Omit<CopilotImagingPick["options"][number], "proposal"> }[] = [];
    for (const s of studies) {
      if ((await releasedReportOf(ctx.db, s.id)) === null) continue;
      for (const kind of kinds) {
        options.push({
          args: { studyId: s.id, kind, quantity: kind === "cd" ? 1 : sheetsOf(typed) },
          option: { accessionNo: s.accessionNo, study: name(s.studyTypeCode), kind },
        });
      }
    }
    if (options.length === 0) return say("copilot.answer.radMediaNotReleased", { accession: studies[0]!.accessionNo });
    return picked("copilot.answer.radMediaPick", "media", options, ctx.subject);
  },
  act: defineAct<MediaArgs>({
    args: mediaArgs,
    async recheck(tx, a) {
      return (await releasedReportOf(tx, a.studyId)) === null ? "copilot.answer.radMediaNotReleased" : null;
    },
    async apply(tx, a, ctx) {
      const { requestIds } = await requestMedia(tx, ctx.actor, { studyId: a.studyId, kind: a.kind, quantity: a.quantity });
      const s = (await studyRow(tx, a.studyId))!;
      return {
        answer: say("copilot.answer.radMediaDone", { accession: s.accessionNo, kind: a.kind }),
        module: "radiology", rowId: requestIds[0]!, subjectPatientId: s.patientId,
      };
    },
    verify: {
      /** The request as written: this study, this kind, asked for by this person. */
      async readBack(tx, a, result, ctx) {
        const rows = await (tx as unknown as Db).select().from(imagingMediaRequests)
          .where(and(eq(imagingMediaRequests.id, result.rowId), eq(imagingMediaRequests.studyId, a.studyId)));
        return rows.length === 1 && rows[0]!.kind === a.kind && rows[0]!.requestedBy === ctx.actor.id;
      },
    },
  }),
};

export const radiologyCopilotActs: readonly CopilotToolDecl[] = [bookSlotTool, moveOrNoShowTool, markActedTool, requestFilmCdTool];
