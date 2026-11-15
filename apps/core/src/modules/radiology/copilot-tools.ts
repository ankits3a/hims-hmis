import { and, desc, eq, gte, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { imagingReports, imagingStudies } from "../../kernel/db/schema/radiology";
import { patients } from "../../kernel/db/schema/patients";
import { withTx } from "../../kernel/db/client";
import { hasPermission } from "../../kernel/auth/permissions";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { istDayString } from "../../kernel/approvals/cumulative";
import { asciiDigits } from "../../kernel/copilot/mask";
import { worklist } from "./read";
import { readingWorklist } from "./reading";
import { prepBayList, isRoomGate } from "./prep-bay";
import { readiness } from "./gates";
import { proposeSlot } from "./desk";
import { criticalCallBoard } from "./critical-ladder";
import { releaseRegister } from "./release";
import { imagingDevices } from "./devices";
import { northStar } from "./north-star";
import { doctorFollowups, followupBoard } from "./followups";
import { proposeDraft } from "./report-authoring";
import { activeStudyTypes } from "./study-types";
import { rupees } from "./held";
import type { CopilotAnswer, CopilotToolDecl } from "../../kernel/copilot/types";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor, CopilotAnswerKey, CopilotImagingList, CopilotImagingRow } from "@hmis/contracts";
import type { ReadingRow } from "./reading";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * #1082 (IM5) — THE IMAGING COPILOT'S READS (and its one draft), declared for the boot collector
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Ten tools that ANSWER, each wrapping the module's own function for the same screen and gated on that
 * screen's permission, so the copilot reaches exactly what the asker could open and no more. The four
 * that WRITE are in `copilot-acts.ts`, behind propose → confirm. The words that route to all fourteen
 * are `copilot-intents.ts`; no model is on the path (spec #1082: cue-routed only).
 *
 * Every answer is a key and parameters: counts and times come from the module's functions, never from
 * a model. No patient's name is a parameter — a question names a study by its accession, and the
 * answer says the accession back.
 *
 * ═══ THE SUBJECT, AND WHERE IT COMES FROM ═══
 *
 * The ask route carries no "patient in hand" from the screen (`copilot.controller.ts` reads the subject
 * only from a placeholder in the question). So a question names its study the way the desk already
 * does: by the accession on the label (the masker knows its shape, #1082), the UHID or the visit
 * number. An accession is one study; a UHID or a visit number is that patient's studies of the last
 * 30 days, and when several fit, a read answers with the list and an act offers one option per study.
 *
 * ═══ NEVER A TOOL ═══
 *
 * Order, sign, co-sign, amend, any gate act, a critical's flag or acknowledgement, hand-over, an unpaid
 * release, taking money (18-S plan, "Rules every phase keeps"). Nothing here or in the acts reaches one.
 */

const say = (key: CopilotAnswerKey, params: Record<string, string | number> = {}): CopilotAnswer => ({ key, params });

/** `X` + `YYMMDD` + a four-digit serial, as `kernel/episodes/series.ts` mints it. */
const ACCESSION_RE = /^X\d{10}$/;

/** The accession a typed subject spells, however it was typed (`x-261114-0001`, Devanagari digits), or null. */
export function accessionOf(subject: string): string | null {
  const s = asciiDigits(subject).replace(/[\s-]/g, "").toUpperCase();
  return ACCESSION_RE.test(s) ? s : null;
}

/** A UHID's or a visit number's lookup reaches this far back. An accession is found whatever its age. */
export const SUBJECT_WINDOW_DAYS = 30;
/** At most this many studies are listed or offered for one patient. */
export const SUBJECT_MAX_STUDIES = 5;

export type SubjectStudy = {
  id: string; accessionNo: string; status: string; studyTypeCode: string; patientId: string; encounterNo: string;
  scheduledAt: Date | null; deviceResourceId: string | null; durationMin: number;
};

/**
 * The studies a question's subject names, newest first, kept to `statuses` when given. One PHI row per
 * patient under the study surface the console's own read uses — the copilot read a named patient's
 * study, and the log says so.
 */
export async function studiesForSubject(
  db: Db | Tx, actor: Actor, subject: string, statuses?: readonly string[],
): Promise<SubjectStudy[]> {
  const accession = accessionOf(subject);
  const key = asciiDigits(subject).replace(/\s/g, "").toUpperCase();
  const since = new Date(Date.now() - SUBJECT_WINDOW_DAYS * 86_400_000);
  const who = accession !== null
    ? eq(imagingStudies.accessionNo, accession)
    : and(or(eq(patients.uhid, key), eq(imagingStudies.encounterNo, key)), gte(imagingStudies.createdAt, since));
  const rows = await (db as Db)
    .select({
      id: imagingStudies.id, accessionNo: imagingStudies.accessionNo, status: imagingStudies.status,
      studyTypeCode: imagingStudies.studyTypeCode, patientId: imagingStudies.patientId, encounterNo: imagingStudies.encounterNo,
      scheduledAt: imagingStudies.scheduledAt, deviceResourceId: imagingStudies.deviceResourceId, durationMin: imagingStudies.durationMin,
    })
    .from(imagingStudies)
    .innerJoin(patients, eq(patients.id, imagingStudies.patientId))
    .where(statuses === undefined ? who : and(who, inArray(imagingStudies.status, [...statuses])))
    .orderBy(desc(imagingStudies.createdAt))
    .limit(SUBJECT_MAX_STUDIES);
  for (const patientId of new Set(rows.map((r) => r.patientId))) {
    await recordPhiAccess(db as Db, {
      actor, patientId, surface: "imaging.study", encounterId: rows.find((r) => r.patientId === patientId)?.encounterNo ?? null,
      reason: "imaging copilot: the studies a question named",
    });
  }
  return rows;
}

/** Is anything the subject names a study at all? Tells "nothing here" from "nothing in that state". */
async function anyStudy(db: Db, actor: Actor, subject: string): Promise<boolean> {
  return (await studiesForSubject(db, actor, subject)).length > 0;
}

/** The study type's name, for a list row; the code when the book does not name it. */
export async function studyNames(db: Db | Tx): Promise<(code: string) => string> {
  const types = await activeStudyTypes(db);
  const by = new Map(types.map((t) => [t.code, t.name]));
  return (code) => by.get(code) ?? code;
}

/** Several studies fit: say how many and hand over the list (accession, study, state). */
async function listAnswer(db: Db, studies: readonly SubjectStudy[]): Promise<CopilotAnswer> {
  const name = await studyNames(db);
  const rows: CopilotImagingRow[] = studies.map((s) => ({ accessionNo: s.accessionNo, study: name(s.studyTypeCode), state: s.status }));
  return { ...say("copilot.answer.radStudies", { count: studies.length }), payload: { kind: "imagingList", rows } satisfies CopilotImagingList };
}

/**
 * THE PERSON'S OWN WORDS: what they typed after a colon, the subject taken out. A reason or an acted-upon
 * note is never composed and never read out of a sentence's other words — the colon is where the person
 * says "this part is mine" (`X2611140001 no show: phone switched off`). Null when there is none.
 */
export function ownWords(typed: string, subject: string | null, max = 500): string | null {
  const text = subject === null ? typed : typed.split(subject).join(" ");
  const at = text.search(/[:：—]/);
  if (at < 0) return null;
  const words = text.slice(at + 1).replace(/\s+/g, " ").trim();
  return words === "" ? null : words.slice(0, max);
}

/** The seat that clears a gate: the console's two at the room, Form F at the USG room, the rest at the prep bay. */
export function seatFor(gateKind: string): "room" | "usg" | "prep" {
  if (isRoomGate(gateKind)) return "room";
  return gateKind === "form_f" ? "usg" : "prep";
}

/** The reading list's rows past their target at `now` — the reading room's own "over" (`dueAt` passed). */
export function overdueReads(rows: readonly Pick<ReadingRow, "dueAt">[], now: Date): number {
  return rows.filter((r) => r.dueAt !== null && r.dueAt.getTime() < now.getTime()).length;
}

const can = (db: Db, actor: Actor, permission: string): Promise<boolean> => hasPermission(db, actor.id, permission, "hospital");

/* ═══════════════════════════════════ the ten tools ═══════════════════════════════════ */

const myList: CopilotToolDecl = {
  intent: "radiology.my_list",
  permission: "radiology.worklist.read",
  alsoAdmits: ["radiology.reports.write"],
  needsSubject: false,
  kind: "read",
  /** The asker's seat decides the list: a reader's reading list (#1081 "mine"), the bay's prep list, else the floor's worklist. */
  async run(ctx) {
    const now = new Date();
    if (await can(ctx.db, ctx.actor, "radiology.reports.write")) {
      const rows = await readingWorklist(ctx.db, ctx.actor, now, { view: "mine" });
      return say("copilot.answer.radMyListRead", { count: rows.length, overdue: overdueReads(rows, now) });
    }
    if (await can(ctx.db, ctx.actor, "radiology.gates.satisfy")) {
      return say("copilot.answer.radMyListPrep", { count: (await prepBayList(ctx.db, ctx.actor, now)).length });
    }
    return say("copilot.answer.radMyListFloor", { count: (await worklist(ctx.db, ctx.actor, { view: "floor", now })).length });
  },
};

const studyStatus: CopilotToolDecl = {
  intent: "radiology.study_status",
  permission: "radiology.worklist.read",
  needsSubject: true,
  kind: "read",
  /** `readiness` (the console's read): an open gate names itself and the seat that clears it; otherwise the study's state. */
  async run(ctx) {
    const studies = await studiesForSubject(ctx.db, ctx.actor, ctx.subject!);
    if (studies.length === 0) return say("copilot.answer.radNoStudy");
    if (studies.length > 1) return await listAnswer(ctx.db, studies);
    const s = studies[0]!;
    const r = await readiness(ctx.db, ctx.actor, s.id);
    if (r.open.length > 0) {
      const gate = r.open.find((k) => seatFor(k) === "prep") ?? r.open[0]!;
      return say("copilot.answer.radStudyHeld", { accession: s.accessionNo, gate, seat: seatFor(gate), more: r.open.length - 1 });
    }
    return say("copilot.answer.radStudyState", { accession: s.accessionNo, state: r.state });
  },
};

/** A study waiting to be booked: on `scheduled` with no slot yet (`SCHEDULABLE_FROM`, `schedule.ts`). */
export const waitingToBook = (s: Pick<SubjectStudy, "status" | "scheduledAt">): boolean => s.status === "scheduled" && s.scheduledAt === null;

const nextSlot: CopilotToolDecl = {
  intent: "radiology.next_slot",
  permission: "radiology.schedule",
  needsSubject: true,
  kind: "read",
  /** `proposeSlot` (IM2) per study: the first free quarter hour on a machine of the study's modality. Books nothing. */
  async run(ctx) {
    const studies = (await studiesForSubject(ctx.db, ctx.actor, ctx.subject!, ["scheduled"])).filter(waitingToBook);
    if (studies.length === 0) {
      return say(await anyStudy(ctx.db, ctx.actor, ctx.subject!) ? "copilot.answer.radNothingToBook" : "copilot.answer.radNoStudy");
    }
    if (studies.length > 1) return await listAnswer(ctx.db, studies);
    const s = studies[0]!;
    const slot = await proposeSlot(ctx.db, ctx.actor, { studyId: s.id, now: new Date() });
    if (slot === null) return say("copilot.answer.radNextSlotNone", { accession: s.accessionNo });
    return say("copilot.answer.radNextSlot", { accession: s.accessionNo, machine: slot.code, when: slot.scheduledAt.toISOString() });
  },
};

const overdueReadsTool: CopilotToolDecl = {
  intent: "radiology.overdue_reads",
  permission: "radiology.reports.write",
  needsSubject: false,
  kind: "read",
  /** The reading list (#1081 "mine") past target — the same rows the reading room counts as over. */
  async run(ctx) {
    const now = new Date();
    const count = overdueReads(await readingWorklist(ctx.db, ctx.actor, now, { view: "mine" }), now);
    return count === 0 ? say("copilot.answer.radOverdueNone") : say("copilot.answer.radOverdue", { count });
  },
};

const openCriticals: CopilotToolDecl = {
  intent: "radiology.open_criticals",
  permission: "radiology.criticals.ack",
  needsSubject: false,
  kind: "read",
  /** The critical call board's open calls, and how long the oldest has waited. Reads only: no call, no acknowledgement. */
  async run(ctx) {
    const now = new Date();
    const { open } = await criticalCallBoard(ctx.db, ctx.actor, now);
    if (open.length === 0) return say("copilot.answer.radCriticalsNone");
    const oldest = Math.min(...open.map((c) => c.flaggedAt.getTime()));
    return say("copilot.answer.radCriticals", { count: open.length, minutes: Math.max(0, Math.round((now.getTime() - oldest) / 60_000)) });
  },
};

const reportReady: CopilotToolDecl = {
  intent: "radiology.report_ready",
  permission: "radiology.schedule",
  needsSubject: true,
  kind: "read",
  /**
   * The release register (RS9) for the study: not signed yet, ready to hand over, held for dues (the
   * patient's copy, with the amount), or already handed over. Says the hold; never releases past it.
   */
  async run(ctx) {
    const studies = await studiesForSubject(ctx.db, ctx.actor, ctx.subject!);
    if (studies.length === 0) return say("copilot.answer.radNoStudy");
    if (studies.length > 1) return await listAnswer(ctx.db, studies);
    const s = studies[0]!;
    const row = (await releaseRegister(ctx.db, ctx.actor, new Date(), { q: s.accessionNo })).find((r) => r.studyId === s.id);
    if (row === undefined) return say("copilot.answer.radReportNotReady", { accession: s.accessionNo });
    if (row.handovers.length > 0) return say("copilot.answer.radReportHanded", { accession: s.accessionNo });
    /* The owner's granted release (RS9b) lets the patient's copy go; anything short of it is still held. */
    if (row.hold !== null && row.hold.release.state !== "granted") {
      return say("copilot.answer.radReportHeld", { accession: s.accessionNo, amount: rupees(row.hold.outstandingPaise) });
    }
    return say("copilot.answer.radReportReady", { accession: s.accessionNo });
  },
};

/** A machine that cannot take a patient now. */
const DOWN_STATUSES = new Set(["down", "maintenance", "qa_blocked"]);
/** Words that name a modality, for "is the CT down". Never bare "ct" (it is inside "doctor"). */
const MODALITY_WORDS: readonly [string, RegExp][] = [
  ["ct", /\bct\b|सीटी/i], ["mri", /\bmri\b|एमआरआई/i], ["xray", /x[\s-]?ray|एक्स[\s-]?रे/i],
  ["usg", /\busg\b|ultrasound|sonograph|अल्ट्रासाउंड|सोनोग्राफी/i], ["mammo", /mammo|मैमो/i],
];
export function modalityIn(text: string): string | null {
  return MODALITY_WORDS.find(([, re]) => re.test(text))?.[0] ?? null;
}

const machineStatus: CopilotToolDecl = {
  intent: "radiology.machine_status",
  permission: "radiology.worklist.read",
  needsSubject: false,
  kind: "read",
  /** The device list (RS4), retired machines left out; a modality named in the question narrows it. */
  async run(ctx) {
    const modality = modalityIn(ctx.typed ?? ctx.question);
    const rows = (await imagingDevices(ctx.db, istDayString(new Date()))).filter((d) => modality === null || d.modality === modality);
    if (rows.length === 0) return say("copilot.answer.radMachinesNone");
    const down = rows.filter((d) => DOWN_STATUSES.has(d.status));
    const up = rows.length - down.length;
    if (down.length === 0) return say("copilot.answer.radMachines", { up });
    return say("copilot.answer.radMachinesDown", { up, down: down.length, names: down.map((d) => d.code).join(", ") });
  },
};

const numbers: CopilotToolDecl = {
  intent: "radiology.numbers",
  permission: "radiology.metrics.read",
  needsSubject: false,
  kind: "read",
  /** The north star for the asked day (`serviceDate`, today unless the screen says otherwise), its totals row. */
  async run(ctx) {
    const ns = await northStar(ctx.db, { from: ctx.serviceDate, to: ctx.serviceDate, now: new Date() });
    const median = ns.total.orderToSigned.medianMin;
    return say("copilot.answer.radNumbers", {
      ordered: ns.total.ordered, median: median === null ? "—" : median,
      unread: ns.total.signedUnreadOver24h, notActed: ns.total.publishedNotActedOver72h,
    });
  },
};

const followupsDue: CopilotToolDecl = {
  intent: "radiology.followups_due",
  permission: "radiology.reports.write",
  alsoAdmits: ["radiology.reports.read"],
  needsSubject: false,
  kind: "read",
  /** The reading room's follow-up board for a reader; for a doctor, their own patients' follow-ups still to book. */
  async run(ctx) {
    const now = new Date();
    if (await can(ctx.db, ctx.actor, "radiology.reports.write")) {
      const { tiles } = await followupBoard(ctx.db, ctx.actor, now);
      return tiles.open === 0 ? say("copilot.answer.radFollowupsNone") : say("copilot.answer.radFollowups", { open: tiles.open, overdue: tiles.overdue });
    }
    const rows = await doctorFollowups(ctx.db, ctx.actor, now);
    return rows.length === 0
      ? say("copilot.answer.radFollowupsNone")
      : say("copilot.answer.radFollowups", { open: rows.length, overdue: rows.filter((r) => r.overdue).length });
  },
};

const REPORTABLE = ["acquired", "reported"] as const;

const draftReportTool: CopilotToolDecl = {
  intent: "radiology.draft_report",
  permission: "radiology.reports.write",
  needsSubject: true,
  kind: "draft",
  /**
   * `proposeDraft` (IM4): a `draft` version with its sources, which the reader then reviews in the reading
   * room — never signed here. Answers "draft ready" with the study to open (`imagingLink`).
   */
  async run(ctx) {
    const studies = await studiesForSubject(ctx.db, ctx.actor, ctx.subject!);
    if (studies.length === 0) return say("copilot.answer.radNoStudy");
    const open = studies.filter((s) => (REPORTABLE as readonly string[]).includes(s.status));
    if (open.length > 1) return await listAnswer(ctx.db, open);
    const s = open[0];
    if (s === undefined) return say("copilot.answer.radNotReportable", { accession: studies[0]!.accessionNo });
    await withTx(ctx.db, (tx) => proposeDraft(tx, ctx.actor, { studyId: s.id, now: new Date() }));
    return { ...say("copilot.answer.radDraftReady", { accession: s.accessionNo }), payload: { kind: "imagingLink", studyId: s.id } };
  },
};

export const radiologyCopilotReadTools: readonly CopilotToolDecl[] = [
  myList, studyStatus, nextSlot, overdueReadsTool, openCriticals, reportReady, machineStatus, numbers, followupsDue, draftReportTool,
];

/* ═══════════════════════════════ shared with the acts ═══════════════════════════════ */

/** The live bookings a slot can clash with (`schedule.ts` LIVE_SLOT_STATUSES). */
const LIVE_SLOT = ["scheduled", "checked_in", "ready", "in_acquisition"] as const;

/**
 * Is `[at, at + minutes)` still free on the machine, for `studyId`? The same overlap `assertSlotFree`
 * tests, read so the confirm can SAY "taken"; `scheduleStudy`'s own check under the machine's lock stays
 * the guarantee against a race.
 */
export async function slotStillFree(exec: Db | Tx, input: { studyId: string; deviceResourceId: string; at: Date; minutes: number }): Promise<boolean> {
  const end = new Date(input.at.getTime() + input.minutes * 60_000);
  const clash = await (exec as Db).select({ id: imagingStudies.id }).from(imagingStudies).where(and(
    eq(imagingStudies.deviceResourceId, input.deviceResourceId),
    inArray(imagingStudies.status, [...LIVE_SLOT]),
    ne(imagingStudies.id, input.studyId),
    isNotNull(imagingStudies.scheduledAt),
    sql`${imagingStudies.scheduledAt} < ${end.toISOString()}`,
    sql`${imagingStudies.scheduledAt} + make_interval(mins => ${imagingStudies.durationMin}) > ${input.at.toISOString()}`,
  )).limit(1);
  return clash.length === 0;
}

/** The study type's length in minutes, as a booking snapshots it. */
export async function durationOf(exec: Db | Tx, studyTypeCode: string): Promise<number> {
  return (await activeStudyTypes(exec)).find((t) => t.code === studyTypeCode)?.duration_min ?? 15;
}

/** The released report of a study: its current signed version, published. Null while there is none. */
export async function releasedReportOf(exec: Db | Tx, studyId: string): Promise<{ id: string; version: number } | null> {
  const [r] = await (exec as Db).select({ id: imagingReports.id, version: imagingReports.version }).from(imagingReports)
    .where(and(eq(imagingReports.studyId, studyId), eq(imagingReports.status, "signed"), isNotNull(imagingReports.publishedAt)))
    .orderBy(desc(imagingReports.version)).limit(1);
  return r ?? null;
}

