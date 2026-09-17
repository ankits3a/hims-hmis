import { recordPhiAccess } from "../../kernel/phi/audit";
import { isValidUhid, searchPatients } from "../patients";
import { counterState, listVisits } from "./encounters";
import { summaryByDoctor } from "./queue";
import type { CopilotAnswer, CopilotToolCtx, CopilotToolDecl } from "../../kernel/copilot/types";

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
const ANSWER_FOR_STATUS: Record<string, string> = {
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
async function encounterIdFor(ctx: CopilotToolCtx): Promise<
  { kind: "encounter"; encounterId: string; patientId: string | null }
  | { kind: "unknown_patient" }
  | { kind: "no_visit_today"; patientId: string }
> {
  const subject = (ctx.subject ?? "").trim();

  /*
    A VISIT NUMBER IS PASSED STRAIGHT THROUGH. `counterState` accepts one (it calls `getEncounter`,
    which routes on `VISIT_NO_RE`), and that path reads no patient record at all — the cheapest and
    least disclosing way to answer, which is why it is tried first.
  */
  if (!isValidUhid(subject)) {
    return { kind: "encounter", encounterId: subject, patientId: null };
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
