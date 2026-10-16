import { strongCue as S, weakCue as W } from "../../kernel/copilot/intents";
import { doctorDayLines } from "../opd";
import { deskScope } from "./scope";
import { waitingOn } from "./waiting-on";
import { owedByUnit } from "./owed";
import type { WireAttentionRow } from "@hmis/contracts";
import type { CopilotIntentDecl, ModuleCopilotIntent } from "../../kernel/copilot/intents";
import type { CopilotAnswer, CopilotToolDecl } from "../../kernel/copilot/types";
import type { DoctorDayLine } from "../opd";
import type { OwedRowInternal } from "./owed";

/**
 * DOCTOR DESK DD-0.10 (#890, plan §3.1) — THE DOCTOR'S THREE ASK-BAR QUESTIONS, declared through the open
 * intent seam (#865). The plan names them `doctor_desk.*`; the seam requires `<module key>.`, and the key is
 * `doctor-desk`, so they are `doctor-desk.*` (DECIDED — no kernel edit to widen the namespace rule).
 *
 * FLOOR-ONLY (DECIDED, as ER lane 9): no `menu` and no `help`, so the chat model's system prompt and the
 * chooser's request stay byte-identical (the frozen eval set and `intents.test.ts` pin them); the phrasebook
 * alone routes these. Adding menu lines is owed with an eval re-recording.
 *
 * READS ANSWERED BY LOOKUP, counts only: no patient, no test name, no money (0058). The model never sees an
 * answer. Each runs as the asking doctor (`ctx.actor`) on the Desk's own door, `opd.consult`.
 *
 *   doctor-desk.waiting_on_me  "mere liye kya baaki hai?" — criticals, unread reports, deltas, open visits
 *   doctor-desk.unit_owes      "unit ka kya baaki hai?"   — Clocks Running: open, and past their time
 *   doctor-desk.my_day         "meri OPD kaisi hai?"       — today's OPD line: booked, seen, waiting, longest wait
 */
const DOOR = "opd.consult";

export const doctorDeskCopilotIntents: Readonly<Record<ModuleCopilotIntent, CopilotIntentDecl>> = {
  "doctor-desk.waiting_on_me": {
    cues: [
      S("waiting on me"), S("waiting for me to"), S("needs my attention"), S("need my attention"), S("pending on me"),
      S("mujhse kya baaki"), S("mere liye kya baaki"), S("mera kya baaki"), S("mera kya pending"),
      S("मेरे लिए क्या बाकी"), S("मुझसे क्या बाकी"), S("मेरा क्या बाकी"),
      /* "baaki" alone is the dues question's strong cue (3); these keep "mere liye kya baaki" two clear of it. */
      W("on me"), W("mere liye"), W("mujhse"), W("मेरे लिए"), W("मुझसे"),
    ],
    notCues: ["unit"],
    answerKeys: ["copilot.answer.ddWaitingOnMe", "copilot.answer.ddWaitingOnMeNone"],
  },
  "doctor-desk.unit_owes": {
    cues: [
      S("my unit owe"), S("unit owes"), S("unit owe"), S("clocks running"), S("unit pending"),
      S("unit ka kya baaki"), S("unit ka baaki"), S("unit mein kya baaki"), S("unit mein kya pending"), S("unit ka pending"),
      S("यूनिट का क्या बाकी"), S("यूनिट का बाकी"), S("यूनिट में क्या बाकी"),
      W("unit ka"), W("unit mein"), W("यूनिट का"), W("यूनिट में"),
    ],
    answerKeys: ["copilot.answer.ddUnitOwes", "copilot.answer.ddUnitOwesNone", "copilot.answer.ddNoUnit"],
  },
  "doctor-desk.my_day": {
    cues: [
      S("my opd"), S("meri opd"), S("mera opd"), S("opd kaisi"), S("opd kaisa"),
      S("मेरी ओपीडी"), S("मेरा ओपीडी"), S("ओपीडी कैसी"),
    ],
    answerKeys: ["copilot.answer.ddMyDay", "copilot.answer.ddMyDayNoOpd"],
  },
};

const CRITICAL = new Set<WireAttentionRow["kind"]>(["lab_critical", "imaging_critical"]);

export function waitingOnMeAnswer(rows: readonly Pick<WireAttentionRow, "kind">[]): CopilotAnswer {
  if (rows.length === 0) return { key: "copilot.answer.ddWaitingOnMeNone", params: {} };
  const count = (f: (k: WireAttentionRow["kind"]) => boolean): number => rows.filter((r) => f(r.kind)).length;
  return {
    key: "copilot.answer.ddWaitingOnMe",
    params: {
      critical: count((k) => CRITICAL.has(k)), unread: count((k) => k === "imaging_unread"),
      deltas: count((k) => k === "lab_delta"), openVisits: count((k) => k === "visit_open"),
    },
  };
}

/** `unit` is the unit's name (a team label, not a person), or null for a doctor in no unit. */
export function unitOwesAnswer(unit: string | null, rows: readonly Pick<OwedRowInternal, "dueAt">[], at: Date): CopilotAnswer {
  if (unit === null) return { key: "copilot.answer.ddNoUnit", params: {} };
  if (rows.length === 0) return { key: "copilot.answer.ddUnitOwesNone", params: { unit } };
  const overdue = rows.filter((r) => new Date(r.dueAt).getTime() < at.getTime()).length;
  return { key: "copilot.answer.ddUnitOwes", params: { unit, open: rows.length, overdue } };
}

/** Absent, not zero: no OPD session today is its own answer (the Tower's rule). */
export function myDayAnswer(line: Pick<DoctorDayLine, "session" | "booked" | "seen" | "waiting" | "longestWaitMinutes"> | null): CopilotAnswer {
  if (line === null || line.session === "none") return { key: "copilot.answer.ddMyDayNoOpd", params: {} };
  return {
    key: "copilot.answer.ddMyDay",
    params: { booked: line.booked, seen: line.seen, waiting: line.waiting, longestWait: line.longestWaitMinutes ?? 0 },
  };
}

export const doctorDeskCopilotTools: readonly CopilotToolDecl[] = [
  {
    intent: "doctor-desk.waiting_on_me",
    permission: DOOR,
    needsSubject: false,
    kind: "read",
    async run(ctx): Promise<CopilotAnswer> {
      const at = new Date();
      const scope = await deskScope(ctx.db, ctx.actor, at);
      return waitingOnMeAnswer(await waitingOn(ctx.db, ctx.actor, at, scope.istDate));
    },
  },
  {
    intent: "doctor-desk.unit_owes",
    permission: DOOR,
    needsSubject: false,
    kind: "read",
    async run(ctx): Promise<CopilotAnswer> {
      const at = new Date();
      const scope = await deskScope(ctx.db, ctx.actor, at);
      if (scope.unit === null) return unitOwesAnswer(null, [], at);
      return unitOwesAnswer(scope.unit.unitName, await owedByUnit(ctx.db, scope.members, at), at);
    },
  },
  {
    intent: "doctor-desk.my_day",
    permission: DOOR,
    needsSubject: false,
    kind: "read",
    async run(ctx): Promise<CopilotAnswer> {
      const at = new Date();
      const scope = await deskScope(ctx.db, ctx.actor, at);
      const lines = await doctorDayLines(ctx.db, [ctx.actor.id], scope.istDate, at);
      return myDayAnswer(lines.find((l) => l.userId === ctx.actor.id) ?? null);
    },
  },
];
