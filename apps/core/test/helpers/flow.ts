import { newId } from "@hmis/contracts";
import { opdEncounters, opdQueueEntries, opdQueueSessions, opdVitals } from "../../src/kernel/db/schema";
import type { Db } from "../../src/kernel/db/client";

/**
 * HOW LONG PATIENTS WAIT — visits written straight to the tables with the instants a test chooses. The
 * real roads (`openVisit`, `recordVitals`, `startConsultation`) stamp `now`; the waits are measured
 * between those stamps, so a fixture has to set them itself.
 */
export type FixtureVisit = {
  departmentId: string | null;
  serviceDate: string;
  openedAt: Date;
  /** Minutes from the desk to the first vitals save; null — no vitals yet. */
  a?: number | null;
  /** Minutes from that save to the consult start; null — not started. */
  b?: number | null;
  /** Minutes from the consult start to Complete (default 5) — also when a paper filing stamps both. */
  c?: number;
  /** A second (amended) vitals row this many minutes after the first — it must not move leg A. */
  amendAfter?: number;
  guardian?: boolean;
  abandoned?: boolean;
  leftLine?: boolean;
  reEntry?: boolean;
  /** Closed from paper; `realStart` false means the start on record IS the filing instant. */
  paper?: { realStart: boolean };
  type?: string;
  visitType?: string;
};

const plus = (d: Date, min: number): Date => new Date(d.getTime() + min * 60_000);
let seq = 0;

export async function insertVisits(db: Db, ctx: { patientId: string; doctorId: string; by: string }, visits: readonly FixtureVisit[]): Promise<string[]> {
  const ids: string[] = [];
  const encounters: (typeof opdEncounters.$inferInsert)[] = [];
  const vitals: (typeof opdVitals.$inferInsert)[] = [];
  const entries: (typeof opdQueueEntries.$inferInsert)[] = [];
  const sessions = new Map<string, string>();
  for (const v of visits) {
    seq += 1;
    const id = newId();
    ids.push(id);
    const vitalsAt = v.a === null || v.a === undefined ? null : plus(v.openedAt, v.a);
    const startedAt = vitalsAt === null || v.b === null || v.b === undefined ? null : plus(vitalsAt, v.b);
    const filed = startedAt === null ? null : plus(startedAt, v.c ?? 5);
    encounters.push({
      id, visitNo: `VF${String(seq).padStart(9, "0")}`, patientId: ctx.patientId, workflowInstanceId: `wf-${id}`,
      type: v.type ?? "opd", status: v.abandoned === true ? "abandoned" : startedAt !== null ? "completed" : "waiting",
      departmentId: v.departmentId, doctorId: ctx.doctorId, serviceDate: v.serviceDate, visitType: v.visitType ?? "new",
      openedAt: v.openedAt, openedBy: ctx.by, updatedBy: ctx.by,
      consultStartedAt: v.paper !== undefined && !v.paper.realStart ? filed : startedAt,
      consultCompletedAt: filed,
      ...(v.paper !== undefined ? { completedVia: "paper", paperCompletedBy: ctx.by, paperCompletedAt: filed } : {}),
      ...(v.guardian === true ? { patientAbsentBy: ctx.by, patientAbsentAt: v.openedAt, patientAbsentRelation: "son" } : {}),
      ...(v.abandoned === true ? { abandonedAt: plus(v.openedAt, 30), abandonReason: "left" } : {}),
    });
    if (vitalsAt !== null) {
      const first = newId();
      vitals.push({ id: first, encounterId: id, patientId: ctx.patientId, band: "adult", dangerFlags: [], recordedBy: ctx.by, recordedAt: vitalsAt, status: v.amendAfter === undefined ? "active" : "superseded" });
      if (v.amendAfter !== undefined) {
        vitals.push({ id: newId(), encounterId: id, patientId: ctx.patientId, band: "adult", dangerFlags: [], recordedBy: ctx.by, recordedAt: plus(vitalsAt, v.amendAfter), supersedesVitalsId: first, amendmentReason: "typo" });
      }
    }
    if (v.leftLine === true || v.reEntry === true) {
      let sessionId = sessions.get(v.serviceDate);
      if (sessionId === undefined) {
        sessionId = newId();
        await db.insert(opdQueueSessions).values({ id: sessionId, doctorId: ctx.doctorId, serviceDate: v.serviceDate });
        sessions.set(v.serviceDate, sessionId);
      }
      entries.push({ id: newId(), sessionId, encounterId: id, tokenNo: seq, kind: "walk_in", status: v.leftLine === true ? "left" : "done", reEntry: v.reEntry === true });
    }
  }
  for (let i = 0; i < encounters.length; i += 300) await db.insert(opdEncounters).values(encounters.slice(i, i + 300));
  for (let i = 0; i < vitals.length; i += 300) await db.insert(opdVitals).values(vitals.slice(i, i + 300));
  if (entries.length > 0) await db.insert(opdQueueEntries).values(entries);
  return ids;
}
