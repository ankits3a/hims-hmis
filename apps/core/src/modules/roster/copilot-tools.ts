import { requireRosterAct } from "./access";
import { onNowBoard } from "./board";
import { addIstDays, backupUnit, istDateOfInstant, istMidnightUtc, istWeekday, unitOnTake } from "./calendar";
import { rosterUnits } from "./month";
import { shortUnitName } from "./opd-units";
import { coverOptions, myDutyRows, positionLabels, rosterTeamNames, toDutyRef } from "./swaps";
import { ROSTER_READ } from "./policy";
import type { CopilotAnswer, CopilotToolCtx, CopilotToolDecl } from "../../kernel/copilot/types";
import type { DutyRef } from "./swaps";

/**
 * ═══ 20-U U9 — THE ROSTER'S FOUR QUESTIONS, ANSWERED BY LOOKUP ═══
 *
 * "ortho mein abhi on call kaun hai?", "kal raat surgery ka unit kaun sa hai?", "mera agla night kab
 * hai?" and "Saturday night koi le sakta hai kya?" — routed by the kernel's phrasebook (or, for the
 * tail, by a model that only ever picks a tool name) and answered HERE from the roster's own reads:
 * the who-is-on board (`onNowBoard`), the unit calendar (`unitOnTake`), the reader's own duties
 * (`myDutyRows`) and "who can take it" (`coverOptions`). The model never sees an answer and never
 * writes one; each answer is a key and display-ready parameters the web renders in the reader's
 * language.
 *
 * Every tool is gated on `roster.read` — the screens' own door (U5a: doctors, front office, vitals,
 * OPD admin, duty manager) — and asks the act matrix as the COPILOT (`via: "copilot"`), so a cell the
 * matrix closes to the copilot stays closed whatever the person holds.
 *
 * ═══ `roster.ask_cover` DRAFTS AND NEVER ASKS ═══
 *
 * `request_cover` is `never` for the copilot (policy.ts), and this file keeps it so by construction:
 * it imports no writer. The answer's `payload` is a DRAFT — the duty and the people who can take it —
 * and the person sends the request with their own tap, through `POST /roster/covers`, exactly as from
 * My duties. Nothing is asked of anybody until a human presses a button.
 */

/** How far ahead "my next duty" and "can anyone take it" look. A published month and a bit. */
export const DUTY_LOOKAHEAD_DAYS = 28;
const DAY_MS = 86_400_000;
const MAX_NAMED = 3;
const MAX_DRAFTED = 5;

/* ═══════════════════════════════ reading the question ═══════════════════════════════ */

const wordsOf = (question: string): string[] =>
  question.replace(/<<P\d+>>/g, " ").normalize("NFC").toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u).filter((w) => w !== "");

const NIGHT = new Set(["raat", "rat", "night", "nights", "tonight", "रात"]);
const MORNING = new Set(["subah", "morning", "सुबह"]);
const AFTERNOON = new Set(["dopahar", "afternoon", "दोपहर"]);
const EVENING = new Set(["shaam", "sham", "evening", "शाम"]);
const PAST = new Set(["tha", "thi", "was", "were", "था", "थी", "थे"]);
const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0, ravivar: 0, itwar: 0, इतवार: 0, रविवार: 0,
  monday: 1, mon: 1, somvar: 1, सोमवार: 1,
  tuesday: 2, tue: 2, mangalvar: 2, मंगलवार: 2,
  wednesday: 3, wed: 3, budhvar: 3, बुधवार: 3,
  thursday: 4, thu: 4, guruvar: 4, brihaspativar: 4, गुरुवार: 4, बृहस्पतिवार: 4,
  friday: 5, fri: 5, shukravar: 5, शुक्रवार: 5,
  saturday: 6, sat: 6, shanivar: 6, शनिवार: 6,
};

export type AskedWhen = {
  /** The instant the question is about. `now` unless a day or a time of day was named. */
  at: Date;
  /** The IST day named ("kal", "Saturday", "aaj"), or null when none was. */
  day: string | null;
  /** A night was named ("raat", "night", "tonight"). */
  night: boolean;
};

/**
 * WHEN the question is about, from its own words. "kal" is tomorrow unless the sentence is in the
 * past ("kal raat kaun tha" → yesterday) — DECIDED (20-U U9): Hindi uses one word for both, and the
 * tense is the only thing that tells them apart. A weekday is the next one (today if it is today).
 * A night is 22:00 of that day, because a take or a night duty is what is meant; a day named with no
 * time of day is 10:00, inside its working hours. Nothing named is NOW.
 */
export function whenOf(question: string, now: Date): AskedWhen {
  const ws = wordsOf(question);
  const today = istDateOfInstant(now);
  let offset: number | null = null;
  if (ws.includes("parso") || ws.includes("परसों")) offset = 2;
  if (ws.includes("kal") || ws.includes("कल")) offset = ws.some((w) => PAST.has(w)) ? -1 : 1;
  if (ws.includes("tomorrow")) offset = 1;
  if (ws.includes("yesterday")) offset = -1;
  if (ws.includes("aaj") || ws.includes("today") || ws.includes("tonight") || ws.includes("आज")) offset = 0;
  const weekday = ws.map((w) => WEEKDAYS[w]).find((d) => d !== undefined);
  if (weekday !== undefined) offset = (weekday - istWeekday(today) + 7) % 7;

  const night = ws.some((w) => NIGHT.has(w));
  const minute = night ? 22 * 60
    : ws.some((w) => MORNING.has(w)) ? 9 * 60
      : ws.some((w) => AFTERNOON.has(w)) ? 14 * 60
        : ws.some((w) => EVENING.has(w)) ? 18 * 60 : null;

  if (offset === null && minute === null) return { at: now, day: null, night: false };
  // A time of day with no day ("raat ko kaun hai", "mera agla night") is TODAY's for the instant and
  // names no day — "my next night" is not "tonight".
  const day = addIstDays(today, offset ?? 0);
  if (minute === null && day === today) return { at: now, day, night: false };
  return { at: new Date(istMidnightUtc(day).getTime() + (minute ?? 10 * 60) * 60_000), day: offset === null ? null : day, night };
}

/**
 * The words a department is called at a counter that its name does not start with. Matched whole.
 * DECIDED (20-U U9): bare "medicine" is General Medicine — what the hospital means by it — not
 * Respiratory Medicine, which is asked for as "chest" or "TB".
 */
const ALIASES: Record<string, string> = {
  medicine: "MED", med: "MED", मेडिसिन: "MED",
  surgery: "SUR", surgical: "SUR", सर्जरी: "SUR",
  ortho: "ORT", haddi: "ORT", हड्डी: "ORT", ऑर्थो: "ORT",
  gynae: "OBG", gyne: "OBG", gyn: "OBG", obs: "OBG", obg: "OBG", labour: "OBG", स्त्री: "OBG",
  paeds: "PED", peds: "PED", paed: "PED", child: "PED", children: "PED", bachche: "PED", बच्चे: "PED", बच्चों: "PED",
  eye: "OPH", eyes: "OPH", aankh: "OPH", आंख: "OPH", आँख: "OPH",
  ent: "ENT", naak: "ENT", kaan: "ENT", नाक: "ENT", कान: "ENT",
  skin: "DER", चर्म: "DER", त्वचा: "DER",
  psych: "PSY", psychiatry: "PSY",
  chest: "RESP", tb: "RESP", pulmo: "RESP", pulmonary: "RESP", respiratory: "RESP",
  heart: "CAR", cardio: "CAR", cardiac: "CAR",
};

/** Words that carry the question and never a department or a post. */
const STOP = new Set([
  "on", "call", "duty", "the", "who", "whom", "is", "are", "was", "kaun", "kon", "hai", "hain", "abhi", "now", "mein", "me", "ka", "ki",
  "ke", "ko", "se", "unit", "take", "pe", "par", "kal", "aaj", "raat", "night", "today", "tonight", "tomorrow", "sa", "si", "kya",
  "general", "and", "of", "in", "at", "which", "what", "konsa", "kaunsa", "for", "doctor", "dr", "officer", "medical",
]);

type Named = { departmentId: string; code: string; name: string };

/** The department a question names: an alias, then a code, then a unique prefix of a name word. */
export function departmentOf<T extends Named>(question: string, departments: readonly T[]): T | null {
  const ws = wordsOf(question).filter((w) => !STOP.has(w));
  for (const w of ws) {
    const code = ALIASES[w];
    const hit = code === undefined ? undefined : departments.find((d) => d.code === code);
    if (hit !== undefined) return hit;
  }
  const byCode = departments.find((d) => ws.includes(d.code.toLowerCase()));
  if (byCode !== undefined) return byCode;
  const hits = departments.filter((d) => wordsOf(d.name).some((n) => n.length >= 3 && !STOP.has(n)
    && ws.some((w) => w.length >= 3 && (n.startsWith(w) || w.startsWith(n)))));
  return hits.length === 1 ? hits[0]! : null;
}

/* ═══════════════════════════════ saying it ═══════════════════════════════ */

/*
  WORDS ARE THE WEB'S. A day travels as its IST date (`2026-10-10`) and an instant as ISO, and the web
  says them in the reader's language in the boards' voice ("Saturday 10 Oct", "on Saturday 10 Oct at
  22:00", "right now") — a server-made "10-10-2026 22:00" read like a log line (coordinator review,
  2026-10-04). Only a clock face is said here, because "20:00" is the same in both languages.
*/
const ist = (at: Date): Date => new Date(at.getTime() + 330 * 60_000);
const two = (n: number): string => String(n).padStart(2, "0");
/** `22:00` — 24-hour, IST. */
const clock = (at: Date): string => `${two(ist(at).getUTCHours())}:${two(ist(at).getUTCMinutes())}`;
/** `when`: "now" when the question named no time, else the instant asked about. */
const whenParam = (when: AskedWhen, now: Date): string => (when.at.getTime() === now.getTime() ? "now" : when.at.toISOString());
const GRADE: Record<string, string> = { intern: "Int", junior_resident: "JR", senior_resident: "SR" };

/* ═══════════════════════════════ the reader's own duties ═══════════════════════════════ */

async function ownDuties(ctx: CopilotToolCtx, now: Date): Promise<DutyRef[]> {
  const rows = (await myDutyRows(ctx.db, ctx.actor, now, new Date(now.getTime() + DUTY_LOOKAHEAD_DAYS * DAY_MS)))
    .filter((r) => r.kind !== "off" && r.liveTo === null);
  const positions = await positionLabels(ctx.db);
  const teams = await rosterTeamNames(ctx.db);
  return rows.map((r) => toDutyRef(r, positions, teams));
}

/** The duties a question points at: on the day it names, nights if it says night; else all, in order. */
function pointedAt(duties: readonly DutyRef[], when: AskedWhen): DutyRef[] {
  return duties.filter((d) => (when.day === null || d.istDate === when.day) && (!when.night || d.night));
}

/** A duty as the sentence wants it: its IST day and its two clock faces ("20:00", "08:00"). */
const dutyWhen = (d: DutyRef): { day: string; from: string; till: string } => ({ day: d.istDate, from: clock(d.startsAt), till: clock(d.endsAt) });
const unitOf = (d: DutyRef): string => d.teamName ?? "";

/* ═══════════════════════════════ the tools ═══════════════════════════════ */

export type RosterToolOptions = { now?: () => Date; env?: NodeJS.ProcessEnv };

export function rosterCopilotTools(opts: RosterToolOptions = {}): readonly CopilotToolDecl[] {
  const nowOf = opts.now ?? (() => new Date());
  const env = opts.env ?? process.env;
  /** The matrix asked AS THE COPILOT — the person's grant is the runner's check, this is the kind. */
  const asCopilot = (ctx: CopilotToolCtx): Promise<void> => requireRosterAct(ctx.db, ctx.actor, "read", {}, "copilot");

  return [
    {
      /** "ortho mein abhi on call kaun hai?" — the who-is-on board, for one department or one service. */
      intent: "roster.who_is_on",
      permission: ROSTER_READ,
      needsSubject: false,
      async run(ctx): Promise<CopilotAnswer> {
        await asCopilot(ctx);
        const now = nowOf();
        const when = whenOf(ctx.question, now);
        const board = await onNowBoard(ctx.db, when.at, env);
        const at = whenParam(when, now);
        const dept = departmentOf(ctx.question, board.departments);
        if (dept !== null) {
          if (dept.source !== "published") return { key: "copilot.answer.rosterWhoUnpublished", params: { dept: dept.name, when: at } };
          const here = dept.inTheBuilding.map((p) => `${GRADE[p.cadre] ?? p.positionLabel} ${p.name}`).join(", ");
          // "" is said as "nobody" by the web; a vacant rung is nobody too.
          const fac = dept.facultyOnCall.flatMap((r) => (r.name === null ? [] : [r.name])).join(", ");
          return dept.unitOnTake === null
            ? { key: "copilot.answer.rosterWhoNoTake", params: { dept: dept.name, when: at, here, fac } }
            : {
              key: "copilot.answer.rosterWhoIsOn",
              params: { dept: dept.name, when: at, unit: shortUnitName(dept.unitOnTake.name, dept.name), till: dept.unitOnTake.endsAt.toISOString(), here, fac },
            };
        }
        const asked = wordsOf(ctx.question).filter((w) => w.length >= 4 && !STOP.has(w));
        const service = board.services.find((s) => wordsOf(s.positionLabel).some((n) => !STOP.has(n) && asked.some((w) => n.startsWith(w) || w.startsWith(n))));
        if (service !== undefined) {
          if (service.source !== "published") return { key: "copilot.answer.rosterWhoServiceUnpublished", params: { role: service.positionLabel } };
          return service.people.length === 0
            ? { key: "copilot.answer.rosterWhoServiceNobody", params: { role: service.positionLabel, when: at } }
            : { key: "copilot.answer.rosterWhoService", params: { role: service.positionLabel, when: at, who: service.people.map((p) => p.name).join(", ") } };
        }
        return { key: "copilot.answer.rosterNeedDept", params: {} };
      },
    },
    {
      /** "kal raat surgery ka unit kaun sa hai?" — the unit calendar's take, at the instant named. */
      intent: "roster.unit_on_take",
      permission: ROSTER_READ,
      needsSubject: false,
      async run(ctx): Promise<CopilotAnswer> {
        await asCopilot(ctx);
        const now = nowOf();
        const when = whenOf(ctx.question, now);
        const dept = departmentOf(ctx.question, (await rosterUnits(ctx.db)).filter((d) => d.units.length > 0));
        if (dept === null) return { key: "copilot.answer.rosterNeedDept", params: {} };
        const take = await unitOnTake(ctx.db, dept.departmentId, when.at);
        if (take.teamId === null || take.startsAt === null || take.endsAt === null) {
          return { key: "copilot.answer.rosterNoTake", params: { dept: dept.name, when: whenParam(when, now) } };
        }
        const names = await rosterTeamNames(ctx.db);
        const backup = await backupUnit(ctx.db, dept.departmentId, when.at);
        const unitName = (id: string): string => shortUnitName(names.get(id) ?? "", dept.name);
        const params = {
          dept: dept.name, when: whenParam(when, now), unit: unitName(take.teamId),
          from: take.startsAt.toISOString(), till: take.endsAt.toISOString(),
        };
        return backup.teamId === null
          ? { key: "copilot.answer.rosterUnitOnTakeNoBackup", params }
          : { key: "copilot.answer.rosterUnitOnTake", params: { ...params, backup: unitName(backup.teamId) } };
      },
    },
    {
      /** "mera agla night kab hai?" — the reader's own published duties, and nobody else's. */
      intent: "roster.my_duties",
      permission: ROSTER_READ,
      needsSubject: false,
      async run(ctx): Promise<CopilotAnswer> {
        await asCopilot(ctx);
        const now = nowOf();
        const when = whenOf(ctx.question, now);
        const duties = await ownDuties(ctx, now);
        const pointed = pointedAt(duties, when);
        if (when.day !== null) {
          return pointed.length === 0
            ? { key: "copilot.answer.rosterMyNoneOnDay", params: { day: when.day } }
            : {
              key: "copilot.answer.rosterMyOnDay",
              params: { day: when.day, duties: pointed.map((d) => `${d.positionLabel}${unitOf(d) === "" ? "" : `, ${unitOf(d)}`} (${clock(d.startsAt)}–${clock(d.endsAt)})`).join("; ") },
            };
        }
        const next = pointed[0];
        if (next === undefined) {
          return { key: when.night ? "copilot.answer.rosterMyNoNight" : "copilot.answer.rosterMyNone", params: { days: DUTY_LOOKAHEAD_DAYS } };
        }
        return {
          key: when.night ? "copilot.answer.rosterMyNextNight" : "copilot.answer.rosterMyNext",
          params: { post: next.positionLabel, unit: unitOf(next), ...dutyWhen(next) },
        };
      },
    },
    {
      /**
       * "Saturday night koi le sakta hai kya?" — WHO CAN TAKE my duty, as a DRAFT. Reads
       * `coverOptions` (the same "who can take it" My duties shows, validator and all) and writes
       * nothing: the payload is what the person picks from, and their tap sends the request.
       */
      intent: "roster.ask_cover",
      permission: ROSTER_READ,
      needsSubject: false,
      async run(ctx): Promise<CopilotAnswer> {
        await asCopilot(ctx);
        const now = nowOf();
        const when = whenOf(ctx.question, now);
        const duty = pointedAt(await ownDuties(ctx, now), when)[0];
        if (duty === undefined) {
          return when.day === null
            ? { key: "copilot.answer.rosterCoverNoDuty", params: { days: DUTY_LOOKAHEAD_DAYS } }
            : { key: "copilot.answer.rosterCoverNoDutyOn", params: { day: when.day } };
        }
        const options = await coverOptions(ctx.db, ctx.actor, duty.assignmentId);
        const params = dutyWhen(duty);
        if (options.openRequestId !== null) return { key: "copilot.answer.rosterCoverAlready", params };
        if (options.canTake.length === 0) return { key: "copilot.answer.rosterCoverNobody", params: { ...params, n: options.cannot.length } };
        const payload = {
          kind: "roster_cover_draft", assignmentId: duty.assignmentId, post: duty.positionLabel, unit: unitOf(duty),
          startsAt: duty.startsAt.toISOString(), endsAt: duty.endsAt.toISOString(), night: duty.night,
          canTake: options.canTake.slice(0, MAX_DRAFTED).map((c) => ({
            userId: c.userId, name: c.name, grade: c.grade, teamName: c.teamName, crossUnit: c.crossUnit,
          })),
          more: Math.max(0, options.canTake.length - MAX_DRAFTED),
          cannot: options.cannot.length,
        };
        return {
          // A night and a day duty are said differently ("Your night on …" / "Your duty on …").
          key: duty.night ? "copilot.answer.rosterCoverDraft" : "copilot.answer.rosterCoverDraftDuty",
          params: { ...params, n: options.canTake.length, names: options.canTake.slice(0, MAX_NAMED).map((c) => c.name).join(", ") },
          payload,
        };
      },
    },
  ];
}
