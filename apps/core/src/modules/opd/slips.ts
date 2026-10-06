import { and, asc, eq, inArray, ne } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { opdDepartments, opdDoctors, opdEncounters, opdQueueEntries, opdQueueSessions, resources } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { documentsForEncounters, getPatientSummaries, requestDocumentRetake, searchPatients } from "../patients";
import { OpdError } from "./errors";
import { istDate } from "./time";
import type { EncounterDocument, PatientSummary } from "../patients";
import type { EncounterRow } from "./encounters";
import type { Db } from "../../kernel/db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * UX-AUDIT 2026-09-28 · BOARD — THE SLIP DESK'S DAY, SERVER SIDE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The approved board (`docs/design/2026-09-28-ux-audit/slip-desk.html`) draws four things the
 * server did not return. This file is those four, and nothing that writes a slip — filing is still
 * `POST /patients/:id/documents`, one writer of `patient_documents`.
 *
 *   1. The read-back names the Doctor ID, the department and the room. DOCTOR ID ONLY: the owner's
 *      2026-09-06 ruling (render.ts departure 3) is that hospital paper and screens outside the
 *      doctor's own name the doctor by `opd_doctors.code`, and this read-back is shown to a desk.
 *   2. Today's slips: every consultation that has FINISHED today, as WAITING (nothing filed), RETAKE
 *      (the doctor asked for a clearer photo and nothing newer has landed) or FILED.
 *   3. The torn-QR path: today's visits found by name, UHID or mobile (owner ruling 28-Sep-2026 —
 *      "the desk may find today's visit by name or UHID and confirm the person"). The same read-back
 *      comes back, so the operator still checks the person before anything is photographed.
 *   4. The doctor's retake request, which marks one filed page.
 *
 * ═══ A MISSING SLIP IS SHOWN, NOT ESCALATED (owner ruling 28-Sep-2026) ═══
 *
 * *"a missing slip shows in the list and clocks and goes to MRD at day end."* So the day carries
 * each waiting slip's age and nothing here raises an alert, pages a supervisor or writes an
 * obligation while the day runs.
 */

export type SlipState = "waiting" | "retake" | "filed";

export type SlipReadback = {
  encounterId: string;
  patientId: string;
  visitNo: string;
  serviceDate: string;
  patient: PatientSummary;
  /** `opd_doctors.code` — the Doctor ID. Never the doctor's name (owner, 2026-09-06). */
  doctorCode: string | null;
  departmentName: string | null;
  roomName: string | null;
  /** What is already filed against this visit, oldest first — the desk says "this adds page 2". */
  filed: { id: string; kind: string; capturedAt: Date; retakeRequestedAt: Date | null }[];
};

export type SlipDayRow = {
  encounterId: string;
  patientId: string;
  visitNo: string;
  patient: PatientSummary;
  doctorCode: string | null;
  roomName: string | null;
  /** Owner 2026-10-06 — the token as the slip prints it (`<departmentCode>-<tokenNo>`); the desk may type that instead of the visit number. */
  tokenNo: number | null;
  departmentCode: string | null;
  state: SlipState;
  /** When the consultation finished — the waiting clock starts here. */
  consultDoneAt: Date | null;
  /** The newest page's time, for FILED; null otherwise. */
  filedAt: Date | null;
  pages: number;
  kinds: string[];
  retakeRequestedAt: Date | null;
  retakeReason: string | null;
};

export type SlipDay = {
  serviceDate: string;
  items: SlipDayRow[];
  counts: { waiting: number; retake: number; filed: number };
};

type Context = {
  doctorCode: Map<string, string>;
  departmentName: Map<string, string>;
  departmentCode: Map<string, string>;
  /** encounterId → room name, from the newest queue entry's session. */
  roomName: Map<string, string>;
  /** encounterId → the newest queue entry's status and done time. */
  entry: Map<string, { status: string; doneAt: Date | null; tokenNo: number }>;
};

/** The doctor, department and room for a set of encounters — one query per table, never per row. */
async function contextFor(db: Db, encounters: readonly EncounterRow[]): Promise<Context> {
  const doctorIds = [...new Set(encounters.map((e) => e.doctorId).filter((d): d is string => d !== null))];
  const departmentIds = [...new Set(encounters.map((e) => e.departmentId).filter((d): d is string => d !== null))];
  const encounterIds = encounters.map((e) => e.id);

  const doctors = doctorIds.length === 0 ? [] : await db
    .select({ id: opdDoctors.id, code: opdDoctors.code }).from(opdDoctors).where(inArray(opdDoctors.id, doctorIds));
  const departments = departmentIds.length === 0 ? [] : await db
    .select({ id: opdDepartments.id, name: opdDepartments.name, code: opdDepartments.code }).from(opdDepartments).where(inArray(opdDepartments.id, departmentIds));
  const entries = encounterIds.length === 0 ? [] : await db
    .select({
      encounterId: opdQueueEntries.encounterId, status: opdQueueEntries.status, doneAt: opdQueueEntries.doneAt, tokenNo: opdQueueEntries.tokenNo,
      roomName: resources.name,
    })
    .from(opdQueueEntries)
    .innerJoin(opdQueueSessions, eq(opdQueueSessions.id, opdQueueEntries.sessionId))
    .leftJoin(resources, eq(resources.id, opdQueueSessions.roomId))
    .where(inArray(opdQueueEntries.encounterId, encounterIds))
    .orderBy(asc(opdQueueEntries.seq));

  const entry = new Map<string, { status: string; doneAt: Date | null; tokenNo: number }>();
  const roomName = new Map<string, string>();
  for (const r of entries) { // ascending seq ⇒ the newest entry is the last write
    entry.set(r.encounterId, { status: r.status, doneAt: r.doneAt, tokenNo: r.tokenNo });
    if (r.roomName !== null) roomName.set(r.encounterId, r.roomName);
  }
  return {
    doctorCode: new Map(doctors.map((d) => [d.id, d.code])),
    departmentName: new Map(departments.map((d) => [d.id, d.name])),
    departmentCode: new Map(departments.map((d) => [d.id, d.code])),
    roomName,
    entry,
  };
}

function readbackOf(e: EncounterRow, patient: PatientSummary, ctx: Context, docs: readonly EncounterDocument[]): SlipReadback {
  return {
    encounterId: e.id, patientId: e.patientId, visitNo: e.visitNo, serviceDate: e.serviceDate, patient,
    doctorCode: e.doctorId === null ? null : ctx.doctorCode.get(e.doctorId) ?? null,
    departmentName: e.departmentId === null ? null : ctx.departmentName.get(e.departmentId) ?? null,
    roomName: ctx.roomName.get(e.id) ?? null,
    filed: docs.filter((d) => d.encounterId === e.id)
      .map((d) => ({ id: d.id, kind: d.kind, capturedAt: d.capturedAt, retakeRequestedAt: d.retakeRequestedAt })),
  };
}

/**
 * The read-back for one encounter. `null` when the caller may not see the patient — the caller
 * answers that exactly as "no such visit", so a visit number is never a way to learn a sealed
 * record exists (the rule `GET /opd/visits/by-number/:visitNo` already states).
 */
export async function slipReadback(db: Db, actor: Actor, encounter: EncounterRow): Promise<SlipReadback | null> {
  const [summary] = await getPatientSummaries(db, actor, [encounter.patientId]);
  if (summary === undefined) return null;
  const ctx = await contextFor(db, [encounter]);
  const docs = await documentsForEncounters(db, [encounter.id]);
  return readbackOf(encounter, summary, ctx, docs);
}

/** A consultation is finished when its newest token is `done`, or the visit itself has moved past the room. */
function finished(e: EncounterRow, ctx: Context): boolean {
  const entry = ctx.entry.get(e.id);
  return entry?.status === "done" || e.status === "completed" || e.status === "awaiting_results";
}

const DAY_CAP = 2000;

/**
 * Today's slips, in the board's order: WAITING oldest consultation first, then RETAKE oldest request
 * first, then FILED newest first. One unfiltered list — the board has no filter tabs.
 */
export async function slipDay(db: Db, actor: Actor, now: Date = new Date()): Promise<SlipDay> {
  const serviceDate = istDate(now);
  const encounters = await db.select().from(opdEncounters)
    .where(and(eq(opdEncounters.serviceDate, serviceDate), ne(opdEncounters.status, "abandoned")))
    .orderBy(asc(opdEncounters.openedAt)).limit(DAY_CAP);
  const ctx = await contextFor(db, encounters);
  const done = encounters.filter((e) => finished(e, ctx));
  const summaries = await getPatientSummaries(db, actor, done.map((e) => e.patientId));
  const byPatient = new Map(summaries.map((s) => [s.requestedId, s] as const));
  const docs = await documentsForEncounters(db, done.map((e) => e.id));

  const items: SlipDayRow[] = [];
  for (const e of done) {
    const patient = byPatient.get(e.patientId);
    if (patient === undefined) continue; // not the caller's to see — absent, not redacted
    const pages = docs.filter((d) => d.encounterId === e.id);
    const newest = pages.at(-1) ?? null;
    /* The newest request on any page, answered only by a page filed AFTER it. */
    const request = pages
      .filter((d) => d.retakeRequestedAt !== null)
      .sort((a, b) => b.retakeRequestedAt!.getTime() - a.retakeRequestedAt!.getTime())[0] ?? null;
    const answered = request !== null && pages.some((d) => d.capturedAt.getTime() > request.retakeRequestedAt!.getTime());
    const state: SlipState = pages.length === 0 ? "waiting" : request !== null && !answered ? "retake" : "filed";
    items.push({
      encounterId: e.id, patientId: e.patientId, visitNo: e.visitNo, patient,
      doctorCode: e.doctorId === null ? null : ctx.doctorCode.get(e.doctorId) ?? null,
      roomName: ctx.roomName.get(e.id) ?? null,
      tokenNo: ctx.entry.get(e.id)?.tokenNo ?? null,
      departmentCode: e.departmentId === null ? null : ctx.departmentCode.get(e.departmentId) ?? null,
      state,
      consultDoneAt: ctx.entry.get(e.id)?.doneAt ?? e.consultCompletedAt ?? null,
      filedAt: newest?.capturedAt ?? null,
      pages: pages.length,
      kinds: [...new Set(pages.map((d) => d.kind))],
      retakeRequestedAt: state === "retake" ? request!.retakeRequestedAt : null,
      retakeReason: state === "retake" ? request!.retakeReason : null,
    });
  }

  const t = (d: Date | null): number => d?.getTime() ?? 0;
  const rank: Record<SlipState, number> = { waiting: 0, retake: 1, filed: 2 };
  items.sort((a, b) => {
    if (a.state !== b.state) return rank[a.state] - rank[b.state];
    if (a.state === "waiting") return t(a.consultDoneAt) - t(b.consultDoneAt);
    if (a.state === "retake") return t(a.retakeRequestedAt) - t(b.retakeRequestedAt);
    return t(b.filedAt) - t(a.filedAt);
  });

  return {
    serviceDate,
    items,
    counts: {
      waiting: items.filter((i) => i.state === "waiting").length,
      retake: items.filter((i) => i.state === "retake").length,
      filed: items.filter((i) => i.state === "filed").length,
    },
  };
}

/**
 * THE TORN QR (owner ruling 28-Sep-2026): today's visits for the people a name, UHID or mobile
 * finds. `searchPatients` is the hospital's one patient search — it applies the seal, the merge
 * chain and the minimum query length — and this narrows its answer to visits of TODAY only, so the
 * path cannot be used to file a slip against last week's visit by typing a name.
 */
export async function findTodaysVisits(db: Db, actor: Actor, q: string, now: Date = new Date()): Promise<SlipReadback[]> {
  const people = await searchPatients(db, actor, q, 20);
  if (people.length === 0) return [];
  const encounters = await db.select().from(opdEncounters)
    .where(and(
      eq(opdEncounters.serviceDate, istDate(now)),
      ne(opdEncounters.status, "abandoned"),
      inArray(opdEncounters.patientId, people.map((p) => p.id)),
    ))
    .orderBy(asc(opdEncounters.openedAt)).limit(20);
  if (encounters.length === 0) return [];
  const summaries = await getPatientSummaries(db, actor, encounters.map((e) => e.patientId));
  const byPatient = new Map(summaries.map((s) => [s.requestedId, s] as const));
  const ctx = await contextFor(db, encounters);
  const docs = await documentsForEncounters(db, encounters.map((e) => e.id));
  return encounters.flatMap((e) => {
    const patient = byPatient.get(e.patientId);
    return patient === undefined ? [] : [readbackOf(e, patient, ctx, docs)];
  });
}

/**
 * The doctor asks for a clearer photograph of one page. The page must belong to an OPD visit — a
 * page with no visit is paper from outside, and there is no desk list for it to come back on.
 */
export async function requestSlipRetake(
  db: Db, actor: Actor, documentId: string, reason: string | null, now: Date = new Date(),
): Promise<{ documentId: string; encounterId: string; alreadyRequested: boolean }> {
  return withTx(db, async (tx) => {
    const result = await requestDocumentRetake(tx, actor, documentId, reason, now);
    /* Thrown INSIDE the transaction, so the mark it just wrote rolls back with it. */
    if (result.encounterId === null) {
      throw new OpdError("unknown_encounter", "this page was not filed against a visit, so no desk can retake it");
    }
    return { documentId: result.documentId, encounterId: result.encounterId, alreadyRequested: result.alreadyRequested };
  });
}
