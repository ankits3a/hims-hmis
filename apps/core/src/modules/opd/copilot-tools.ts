import { recordPhiAccess } from "../../kernel/phi/audit";
import { isValidUhid, searchPatients } from "../patients";
import { counterState, listVisits } from "./encounters";
import { summaryByDoctor } from "./queue";
import type { CopilotAnswer, CopilotToolCtx, CopilotToolDecl } from "../../kernel/copilot/types";
import type { CopilotAnswerKey } from "@hmis/contracts";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-COPILOT — WHAT THE DESK COPILOT MAY ASK THE OPD
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-09-17: *"if the user asks 'has U00110012 seen by doctor?' or 'kya U00110012 ko doctor
 * ne dekh liya?' the desk agent as a copilot must answer."* These two tools are that answer.
 *
 * They are declared HERE, in the module that owns the data, and collected by the kernel at boot —
 * the same seam `search`, `desk` and `orderKinds` already use. The kernel knows nothing about
 * visits, tokens or queues, which is what makes a copilot over a whole hospital tractable: the lab
 * adds "is this specimen back?" by shipping it with the lab.
 */

/** Which of the six visit states counts as "the doctor has seen them". */
const ANSWER_FOR_STATUS: Record<string, CopilotAnswerKey> = {
  completed: "copilot.answer.visitSeen",
  in_consultation: "copilot.answer.visitInConsult",
  awaiting_results: "copilot.answer.visitAwaitingResults",
  waiting: "copilot.answer.visitWaiting",
  registered: "copilot.answer.visitRegistered",
  abandoned: "copilot.answer.visitAbandoned",
};

/**
 * Turn what the clerk typed into an encounter id.
 *
 * TWO SHAPES ARRIVE HERE and the clerk does not distinguish them, so neither may we: a UHID off a
 * card (`U00110012`) and a visit number off the slip in the patient's hand (`V2609150001`). The
 * visit number is the easy one — `getEncounter` already routes it, inside `counterState`. The UHID
 * has to become a patient and then that patient's visit for the day.
 *
 * `searchPatients` is the resolver rather than anything cheaper, and deliberately: it applies the
 * ASKING USER's confidentiality clearance, so a clerk without `patients.confidential.read` gets
 * "no such patient" for a sealed record — the same answer the patient picker gives them, rather
 * than a copilot that is quietly more powerful than the screens.
 */
/**
 * THE SHAPE OF A UHID, WHICH IS NOT THE SAME QUESTION AS WHETHER IT IS VALID.
 *
 * `<prefix><7-digit serial><check digit>` — mirrors `UHID_FULL_RE` in `patients/search.ts`. Kept
 * separate from `isValidUhid` because the two answer different things and collapsing them is the
 * defect below.
 */
const UHID_SHAPE_RE = /^[A-Za-z]{1,5}\d{8}$/;

async function encounterIdFor(ctx: CopilotToolCtx): Promise<
  { kind: "encounter"; encounterId: string; patientId: string | null }
  | { kind: "unknown_patient" }
  | { kind: "bad_uhid"; typed: string }
  | { kind: "no_visit_today"; patientId: string }
> {
  /*
    UPPERCASED, because `isValidUhid` matches `[A-Z]` only and a clerk types in whatever case the
    keyboard was left in. `searchPatients` already uppercases before its exact lane; doing it here
    too means the check digit and the lookup agree about what was typed.
  */
  const subject = (ctx.subject ?? "").trim().toUpperCase();

  /*
    ═══ SHAPE FIRST, THEN THE CHECK DIGIT — AND THE ORDER IS THE BUG THE E2E FOUND ═══

    The first version asked `isValidUhid` alone and sent everything it rejected down the visit-number
    path. But `isValidUhid` is shape AND a Verhoeff check digit, so a MISTYPED UHID — the single
    commonest error at a counter, and the exact thing the check digit exists to catch — was silently
    treated as a visit number and answered "I could not find that visit", about a patient. The e2e
    suite caught it by asking about an invented UHID; no unit test could, because every unit fixture
    used a UHID that was real.

    Three outcomes now, because there are three cases:
      - not UHID-shaped        → it is a visit number; pass it straight through
      - UHID-shaped, bad digit → say so. The number is wrong and we can prove it.
      - UHID-shaped, valid     → look the patient up
  */
  if (!UHID_SHAPE_RE.test(subject)) {
    /*
      A VISIT NUMBER IS PASSED STRAIGHT THROUGH. `counterState` accepts one (it calls `getEncounter`,
      which routes on `VISIT_NO_RE`), and that path reads no patient record at all — the cheapest and
      least disclosing way to answer, which is why it is tried first.
    */
    return { kind: "encounter", encounterId: subject, patientId: null };
  }
  if (!isValidUhid(subject)) {
    return { kind: "bad_uhid", typed: subject };
  }

  const hits = await searchPatients(ctx.db, ctx.actor, subject, 1);
  const patient = hits[0];
  if (patient === undefined) return { kind: "unknown_patient" };

  const visits = await listVisits(ctx.db, { serviceDate: ctx.serviceDate, patientId: patient.id }, 20);
  /*
    THE LATEST VISIT OF THE DAY, not the first. A patient sent back to a second department has two,
    and "have they been seen" is a question about where they are NOW. `listVisits` orders by
    `openedAt` ascending, so the answer is the last element.
  */
  const latest = visits[visits.length - 1];
  if (latest === undefined) return { kind: "no_visit_today", patientId: patient.id };
  return { kind: "encounter", encounterId: latest.id, patientId: patient.id };
}

export const opdCopilotTools: readonly CopilotToolDecl[] = [
  {
    intent: "visit_status",
    /*
      The gate the equivalent screen uses. `GET /opd/visits` is `opd.visits.read` — held by front
      office, its supervisor, the vitals bay and the doctor — and the copilot must be neither more
      nor less reachable than the screen that answers the same question.
    */
    permission: "opd.visits.read",
    needsSubject: true,
    async run(ctx): Promise<CopilotAnswer> {
      const found = await encounterIdFor(ctx);
      if (found.kind === "unknown_patient") {
        return { key: "copilot.answer.visitUnknownPatient", params: {} };
      }
      if (found.kind === "bad_uhid") {
        /*
          Echoing what they typed is safe and useful: it came from this clerk's own keyboard a
          moment ago, and seeing it back is how somebody spots a transposed pair of digits.
        */
        return { key: "copilot.answer.uhidCheckFailed", params: { uhid: found.typed } };
      }
      if (found.kind === "no_visit_today") {
        await recordVisitLookup(ctx, found.patientId, null);
        return { key: "copilot.answer.visitNoneToday", params: { date: ctx.serviceDate } };
      }

      const state = await counterState(ctx.db, found.encounterId);
      if (state === null) return { key: "copilot.answer.visitUnknown", params: {} };

      /*
        THE DISCLOSURE, LOGGED. "Is this named person in the hospital today, and have they seen a
        doctor" is a statement about a patient's care, and `phi/audit.ts` exists to answer *who
        looked at this patient* after the fact. `counterState` itself reads no patient record and
        writes no row — correct for a screen polling it every few seconds, and not enough here,
        where a person deliberately asked about somebody by name.
      */
      await recordVisitLookup(ctx, found.patientId, found.encounterId);

      return {
        key: ANSWER_FOR_STATUS[state.status] ?? "copilot.answer.visitUnknown",
        params: {
          /*
            A TOKEN IS ONLY MEANINGFUL WITH ITS DEPARTMENT — "MED-4", never "4", because every
            department mints its own series and a bare number sends a clerk to the wrong door.
          */
          token: state.tokenNo === null ? "—"
            : state.departmentCode === null ? String(state.tokenNo)
            : `${state.departmentCode}-${String(state.tokenNo)}`,
          date: state.serviceDate,
        },
      };
    },
  },
  {
    intent: "queue_depth",
    permission: "opd.queue.read",
    needsSubject: false,
    async run(ctx): Promise<CopilotAnswer> {
      const summaries = await summaryByDoctor(ctx.db, undefined, ctx.serviceDate);
      /*
        ONLY LINES SOMEBODY IS ACTUALLY SITTING IN. A doctor who is not working today, or on leave,
        has a waiting count of zero — which would make them the "shortest line" and send a patient
        to an empty room. `scheduledToday` is leave-aware (FD-7 T8) and it is the whole filter.
      */
      const open = summaries.filter((s) => s.scheduledToday && !s.onLeaveToday);
      if (open.length === 0) return { key: "copilot.answer.queueNoneOpen", params: {} };

      const shortest = open.reduce((a, b) => (b.waitingCount < a.waitingCount ? b : a));
      return {
        key: "copilot.answer.queueShortest",
        params: {
          doctor: shortest.doctor.displayName,
          waiting: shortest.waitingCount,
          /*
            THE SAME ARITHMETIC THE BOARD USES (`queue.ts` RC-1 T5/D7): waiting × the department's
            average consult minutes. Reused rather than re-derived, because a copilot that quotes a
            different wait from the screen beside it is worse than one that says nothing.
          */
          minutes: shortest.waitingCount * shortest.avgConsultMinutes,
        },
      };
    },
  },
];

/** Best-effort, like every other `recordPhiAccess` caller — the read is the priority. */
async function recordVisitLookup(
  ctx: CopilotToolCtx,
  patientId: string | null,
  encounterId: string | null,
): Promise<void> {
  if (patientId === null) return;
  await recordPhiAccess(ctx.db, {
    actor: ctx.actor,
    patientId,
    surface: "copilot.visit_status",
    encounterId,
    reason: "desk copilot asked whether this patient has been seen",
  });
}
