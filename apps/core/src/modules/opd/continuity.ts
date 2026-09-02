import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { opdDoctors, opdEncounters } from "../../kernel/db/schema";
import { getPatient, listMergedLoserIds } from "../patients";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { istDate } from "./time";
import { OpdError } from "./errors";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * ═══ FD-7 T2 — THE CONTINUITY WINDOW, AND WHY IT IS A SERVER CONSTANT ═══
 *
 * DECIDED (phase doc §3, not escalated): **six months**. It is the standard follow-up horizon for
 * an Indian corporate OPD — past it the episode is a new complaint and the shortest line serves the
 * patient better than the familiar face.
 *
 * It lives HERE, not in a query parameter, for the reason every routing rule in this phase is
 * server-side: a window a client can widen is a window that gets widened, and "Dr Sharma saw you"
 * carries a promise the desk then has to keep. One number, one place, one test.
 */
export const CONTINUITY_WINDOW_MONTHS = 6;

export type ContinuityAnchor = {
  doctorId: string;
  doctorName: string;
  /** The IST calendar date of that consultation — what the clerk reads out. */
  seenOn: string;
};

function windowStart(now: Date): Date {
  const start = new Date(now);
  start.setMonth(start.getMonth() - CONTINUITY_WINDOW_MONTHS);
  return start;
}

/**
 * RULE 1 OF THE WALK-IN, ANSWERED SERVER-SIDE: **has this patient been seen in THIS department
 * recently, and by whom?**
 *
 * The shape is deliberately narrow, and the narrowness is the privacy design. The clerk names the
 * department — they are already routing the patient there — and the server answers about THAT
 * department only. It never enumerates the departments a patient has attended, which is the read
 * that would turn a routing helper into a diagnosis leak: "she has been to Psychiatry" is a
 * clinical fact, and 07a/07b were spent closing exactly that class of hole on four routes.
 *
 * The query is `reviewAnchorFor`'s (`encounters.ts:241`) with the revisit gate removed and a window
 * put on: same table, same merge-chain handling, same `status = 'completed'` meaning of "seen".
 * `doctorId` may be null on an old row, so it is required in the WHERE rather than filtered after —
 * an anchor with no doctor cannot route anybody and would otherwise mask a usable one behind it.
 */
export async function continuityDoctorFor(
  db: Db,
  actor: Actor,
  input: { patientId: string; departmentId: string },
  now: Date = new Date(),
): Promise<ContinuityAnchor | null> {
  const visible = await getPatient(db, actor, input.patientId);
  if (visible === null) throw new OpdError("patient_not_found", `unknown patient ${input.patientId}`);
  const canonical = visible.patient.id;

  // The read happened; record who made it. Same order as `encounters.ts:612` — the log follows a
  // SUCCESSFUL visibility check, so a refusal writes nothing and cannot be used to probe.
  await recordPhiAccess(db, {
    actor, patientId: canonical, surface: "opd.continuity",
    sealed: visible.patient.isConfidential, reason: visible.breakGlass?.reason ?? null,
  });

  const chainIds = [canonical, ...(await listMergedLoserIds(db, canonical))];
  const row = (await db
    .select({
      doctorId: opdEncounters.doctorId,
      consultCompletedAt: opdEncounters.consultCompletedAt,
      displayName: opdDoctors.displayName,
    })
    .from(opdEncounters)
    .innerJoin(opdDoctors, eq(opdDoctors.id, opdEncounters.doctorId))
    .where(and(
      inArray(opdEncounters.patientId, chainIds),
      eq(opdEncounters.departmentId, input.departmentId),
      /*
       * `status = 'completed'` IS BELT-AND-BRACES, AND THIS COMMENT IS THE MEASUREMENT, NOT A CLAIM.
       *
       * Four mutants were run against this query. Dropping the window, dropping the department
       * filter and disabling the PHI write each turned exactly one test red. **Dropping this clause
       * turned nothing red, in either arrangement of the two null-sensitive filters** — because
       * `gte(consultCompletedAt, …)` is itself null-excluding, and `completeConsultation` stamps the
       * timestamp and the status in one write (`consultation.ts:227`) while `ABANDONABLE` excludes a
       * completed encounter and nothing transitions out of `completed`. So no REACHABLE row can tell
       * the two apart, and no honest test can be written that does.
       *
       * It stays because it is what "seen" MEANS, and because `reviewAnchorFor` (`encounters.ts:241`)
       * and `openVisitInTx` both carry it — a third query that silently disagreed with them about
       * the definition would be the drift. It is documented as untested rather than counted as
       * covered.
       *
       * The DESC ordering is safe for the same reason: within `completed` the timestamp is never
       * null, so there is no NULLS-FIRST row to land in front of the real anchor.
       */
      eq(opdEncounters.status, "completed"),
      gte(opdEncounters.consultCompletedAt, windowStart(now)),
    ))
    .orderBy(desc(opdEncounters.consultCompletedAt))
    .limit(1))[0];

  if (row === undefined || row.doctorId === null || row.consultCompletedAt === null) return null;
  return { doctorId: row.doctorId, doctorName: row.displayName, seenOn: istDate(row.consultCompletedAt) };
}
