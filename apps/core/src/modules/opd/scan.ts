import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import { opdDepartments, opdEncounters, opdQueueEntries, opdQueueSessions, opdVitals, patients } from "../../kernel/db/schema";
import { documentsForEncounters, getPatientSummaries } from "../patients";
import { normalizeVisitNo } from "./bench";
import { doctorForUser } from "./masters";
import { feeMarksFor } from "./prestage";
import { istDate } from "./time";
import type { PatientSummary } from "../patients";
import type { EncounterRow } from "./encounters";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ THE PHONE'S QUICK SCAN — ONE READ, NO WRITE (owner 2026-10-08) ═══
 *
 * *"add a quick scan icon … so that any staff can scan the patient barcode/QR and perform actions
 * immediately based on permission authorisation."*
 *
 * Every other door a code goes through belongs to ONE desk: the bench (`bench.ts`) knows who is
 * waiting for vitals, the slip desk (`slips.ts`) who has finished, the doctor's line its own
 * doctor's tokens. A scan from the app's header is made by anybody, about anybody, so it needs the
 * one answer none of them gives: WHERE THIS VISIT STANDS today, and WHICH of the closed list of
 * phone actions this caller holds the permission for.
 *
 * WHAT THIS IS NOT. It grants nothing: `permitted` only decides what the phone OFFERS, and every
 * action route keeps its own `@RequirePermission` and its own guards (`requireTreatingDoctor`, the
 * fee gate, the cash session). It writes nothing — no row, no event. And it names a patient only
 * through `getPatientSummaries`, the same summary the bench, the slip desk and the doctor's line
 * already show this caller: a sealed record comes back as its alias, and a record the caller may
 * not see at all answers exactly as a code that names nobody.
 *
 * The code is READ on the phone (`resolveDoor`'s `doorsOf` in packages/contracts/src/vitals-entry.ts
 * — one reader for both apps); this route takes the reading, never the raw text.
 */

export const SCAN_ACTIONS = ["vitals", "slip", "consult", "brief", "paper", "collect", "visit", "move", "book", "newVisit"] as const;
export type ScanAction = (typeof SCAN_ACTIONS)[number];

/** The permission each action's OWN route already demands — read off the controllers, not invented here. */
const ACTION_PERMISSION: Record<ScanAction, string> = {
  vitals: "opd.vitals.record",        // POST /opd/visits/:id/vitals
  slip: "patients.update",            // POST /patients/:id/documents
  consult: "opd.consult",             // POST /opd/visits/:id/consult/start
  brief: "opd.consult",               // the doctor's reads of the visit
  paper: "opd.consult",               // POST /opd/visits/:id/consult/complete
  collect: "billing.invoice.issue",   // POST /billing/invoices
  visit: "opd.visits.open",           // Desk One
  move: "opd.visits.open",            // POST /opd/visits/:id/move-department
  book: "opd.appointments.manage",    // POST /opd/appointments
  newVisit: "opd.visits.open",        // POST /opd/walk-in
};
/** Acts on a consultation are the treating doctor's alone (`requireTreatingDoctor`); a permission is not enough. */
const TREATING_ONLY: ReadonlySet<ScanAction> = new Set<ScanAction>(["consult", "paper"]);

export type ScanQuery =
  | { by: "visit"; visitNo: string }
  | { by: "encounter"; encounterId: string }
  | { by: "token"; tokenNo: number; departmentCode?: string }
  | { by: "uhid"; uhid: string }
  | { by: "patient"; patientId: string };

/** Where the visit stands, in the order a patient walks it. */
export type ScanStage = "registered" | "vitals" | "waiting" | "called" | "consult" | "done";

export type ScanVisit = {
  encounterId: string; patientId: string; visitNo: string; serviceDate: string;
  tokenNo: number | null; departmentCode: string | null; departmentName: string | null;
  stage: ScanStage;
  vitalsDone: boolean;
  /** What is filed against the visit: nothing, a page, or a page the doctor asked to be photographed again. */
  slip: "none" | "filed" | "retake";
  feeUnpaid: boolean;
  /** The caller is this visit's own doctor. */
  mine: boolean;
  patient: PatientSummary;
};

export type ScanMissReason = "unknown" | "other_day" | "abandoned" | "no_visit_today";
export type ScanResult =
  | { outcome: "visit"; visit: ScanVisit; permitted: ScanAction[] }
  /** Several of today's visits answer the reading (a bare token two doctors both hold): listed, never guessed. */
  | { outcome: "ambiguous"; candidates: Pick<ScanVisit, "encounterId" | "visitNo" | "tokenNo" | "departmentCode" | "departmentName" | "patient">[] }
  | {
    outcome: "miss"; reason: ScanMissReason;
    /** `other_day`: the visit the paper names, its day and how it ended. */
    visitNo?: string; serviceDate?: string; status?: string;
    /** The person the code names, when the caller may see them — so a permitted desk can open a new visit. */
    patient?: PatientSummary;
    permitted: ScanAction[];
  };

const LIVE_ENTRY = ["waiting_vitals", "waiting", "called", "in_consult", "done"] as const;
const ENDED = ["completed", "abandoned"] as const;

async function permittedFor(db: Db, actor: Actor): Promise<Set<ScanAction>> {
  const out = new Set<ScanAction>();
  if (actor.type !== "user") return out;
  const cache = new Map<string, boolean>();
  for (const action of SCAN_ACTIONS) {
    const permission = ACTION_PERMISSION[action];
    let held = cache.get(permission);
    if (held === undefined) {
      held = await hasPermission(db, actor.id, permission, "hospital");
      cache.set(permission, held);
    }
    if (held) out.add(action);
  }
  return out;
}

type Entry = { encounterId: string; status: string; tokenNo: number };

/** The newest queue entry per encounter (ascending seq ⇒ the last write wins), as `slips.ts` reads it. */
async function entriesFor(db: Db, encounterIds: readonly string[]): Promise<Map<string, Entry>> {
  const out = new Map<string, Entry>();
  if (encounterIds.length === 0) return out;
  const rows = await db
    .select({ encounterId: opdQueueEntries.encounterId, status: opdQueueEntries.status, tokenNo: opdQueueEntries.tokenNo })
    .from(opdQueueEntries).where(inArray(opdQueueEntries.encounterId, [...encounterIds])).orderBy(asc(opdQueueEntries.seq));
  for (const r of rows) out.set(r.encounterId, r);
  return out;
}

function stageOf(encounter: EncounterRow, entry: Entry | undefined): ScanStage {
  if (encounter.status === "completed" || encounter.status === "awaiting_results" || entry?.status === "done") return "done";
  if (encounter.status === "in_consultation" || entry?.status === "in_consult") return "consult";
  if (entry?.status === "called") return "called";
  if (entry?.status === "waiting") return "waiting";
  if (entry?.status === "waiting_vitals") return "vitals";
  return "registered";
}

async function departmentsOf(db: Db, encounters: readonly EncounterRow[]): Promise<Map<string, { code: string; name: string }>> {
  const ids = [...new Set(encounters.map((e) => e.departmentId).filter((d): d is string => d !== null))];
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: opdDepartments.id, code: opdDepartments.code, name: opdDepartments.name }).from(opdDepartments).where(inArray(opdDepartments.id, ids));
  return new Map(rows.map((r) => [r.id, { code: r.code, name: r.name }] as const));
}

async function visitOf(db: Db, actor: Actor, encounter: EncounterRow, patient: PatientSummary): Promise<ScanVisit> {
  const entry = (await entriesFor(db, [encounter.id])).get(encounter.id);
  const department = encounter.departmentId === null ? undefined : (await departmentsOf(db, [encounter])).get(encounter.departmentId);
  const charts = await db.select({ id: opdVitals.id }).from(opdVitals)
    .where(and(eq(opdVitals.encounterId, encounter.id), eq(opdVitals.status, "active"))).limit(1);
  const pages = (await documentsForEncounters(db, [encounter.id]));
  const request = pages.filter((d) => d.retakeRequestedAt !== null)
    .sort((a, b) => b.retakeRequestedAt!.getTime() - a.retakeRequestedAt!.getTime())[0] ?? null;
  const answered = request !== null && pages.some((d) => d.capturedAt.getTime() > request.retakeRequestedAt!.getTime());
  const fee = await feeMarksFor(db, encounter);
  const doctor = actor.type === "user" ? await doctorForUser(db, actor.id) : null;
  return {
    encounterId: encounter.id, patientId: encounter.patientId, visitNo: encounter.visitNo, serviceDate: encounter.serviceDate,
    tokenNo: entry?.tokenNo ?? null, departmentCode: department?.code ?? null, departmentName: department?.name ?? null,
    stage: stageOf(encounter, entry),
    vitalsDone: charts.length > 0 || encounter.patientAbsentAt !== null,
    slip: pages.length === 0 ? "none" : request !== null && !answered ? "retake" : "filed",
    feeUnpaid: fee.feeUnpaid && fee.feeBypass === null,
    mine: doctor !== null && encounter.doctorId === doctor.id,
    patient,
  };
}

/** `permitted`, narrowed by the one fact a permission cannot carry: whose patient this is. */
function forVisit(permitted: ReadonlySet<ScanAction>, visit: ScanVisit): ScanAction[] {
  return SCAN_ACTIONS.filter((a) => permitted.has(a) && (!TREATING_ONLY.has(a) || visit.mine));
}
/** With no visit in hand, only the acts that need none. */
function forNobody(permitted: ReadonlySet<ScanAction>): ScanAction[] {
  return SCAN_ACTIONS.filter((a) => permitted.has(a) && (a === "newVisit" || a === "book"));
}

async function summaryOf(db: Db, actor: Actor, patientId: string): Promise<PatientSummary | null> {
  const [summary] = await getPatientSummaries(db, actor, [patientId]);
  return summary ?? null;
}

async function answerEncounters(
  db: Db, actor: Actor, permitted: ReadonlySet<ScanAction>, encounters: EncounterRow[], nobody: () => Promise<ScanResult>,
): Promise<ScanResult> {
  const summaries = await getPatientSummaries(db, actor, encounters.map((e) => e.patientId));
  const byPatient = new Map(summaries.map((s) => [s.requestedId, s] as const));
  const seen = encounters.filter((e) => byPatient.has(e.patientId)); // not the caller's to see — absent, not redacted
  if (seen.length === 0) return nobody();
  if (seen.length === 1) {
    const visit = await visitOf(db, actor, seen[0]!, byPatient.get(seen[0]!.patientId)!);
    return { outcome: "visit", visit, permitted: forVisit(permitted, visit) };
  }
  const entries = await entriesFor(db, seen.map((e) => e.id));
  const departments = await departmentsOf(db, seen);
  return {
    outcome: "ambiguous",
    candidates: seen.map((e) => {
      const department = e.departmentId === null ? undefined : departments.get(e.departmentId);
      return {
        encounterId: e.id, visitNo: e.visitNo, tokenNo: entries.get(e.id)?.tokenNo ?? null,
        departmentCode: department?.code ?? null, departmentName: department?.name ?? null, patient: byPatient.get(e.patientId)!,
      };
    }),
  };
}

/** One visit named outright (a visit number, or an e-prescription's encounter id): today's, or the reason it is not. */
async function answerNamed(db: Db, actor: Actor, permitted: ReadonlySet<ScanAction>, encounter: EncounterRow | undefined, today: string): Promise<ScanResult> {
  const unknown: ScanResult = { outcome: "miss", reason: "unknown", permitted: forNobody(permitted) };
  if (encounter === undefined) return unknown;
  const patient = await summaryOf(db, actor, encounter.patientId);
  if (patient === null) return unknown; // a visit number is never a way to learn a sealed record exists
  if (encounter.serviceDate !== today) {
    // The old paper still names the person: if they have a visit open today, that is the answer.
    const open = await openToday(db, [encounter.patientId], today);
    if (open.length > 0) return answerEncounters(db, actor, permitted, open, async () => unknown);
    return {
      outcome: "miss", reason: "other_day", visitNo: encounter.visitNo, serviceDate: encounter.serviceDate, status: encounter.status,
      patient, permitted: forNobody(permitted),
    };
  }
  if (encounter.status === "abandoned") {
    return { outcome: "miss", reason: "abandoned", visitNo: encounter.visitNo, serviceDate: encounter.serviceDate, status: encounter.status, patient, permitted: forNobody(permitted) };
  }
  const visit = await visitOf(db, actor, encounter, patient);
  return { outcome: "visit", visit, permitted: forVisit(permitted, visit) };
}

async function openToday(db: Db, patientIds: readonly string[], today: string): Promise<EncounterRow[]> {
  if (patientIds.length === 0) return [];
  return db.select().from(opdEncounters)
    .where(and(inArray(opdEncounters.patientId, [...patientIds]), eq(opdEncounters.serviceDate, today), notInArray(opdEncounters.status, [...ENDED])))
    .orderBy(asc(opdEncounters.openedAt));
}

/** A person (a UHID, a verified card, a row held on Desk One): their visit today — the open one, else the one that finished. */
async function answerPatient(db: Db, actor: Actor, permitted: ReadonlySet<ScanAction>, patientId: string | undefined, today: string): Promise<ScanResult> {
  const unknown: ScanResult = { outcome: "miss", reason: "unknown", permitted: forNobody(permitted) };
  if (patientId === undefined) return unknown;
  const patient = await summaryOf(db, actor, patientId);
  if (patient === null) return unknown;
  const nobody = async (): Promise<ScanResult> => ({ outcome: "miss", reason: "no_visit_today", patient, permitted: forNobody(permitted) });
  const open = await openToday(db, [patient.id], today);
  if (open.length > 0) return answerEncounters(db, actor, permitted, open, nobody);
  const finished = await db.select().from(opdEncounters)
    .where(and(eq(opdEncounters.patientId, patient.id), eq(opdEncounters.serviceDate, today), eq(opdEncounters.status, "completed")))
    .orderBy(asc(opdEncounters.openedAt));
  const last = finished.at(-1);
  return last === undefined ? nobody() : answerEncounters(db, actor, permitted, [last], nobody);
}

export async function scanResolve(db: Db, actor: Actor, query: ScanQuery, now: Date = new Date()): Promise<ScanResult> {
  const today = istDate(now);
  const permitted = await permittedFor(db, actor);
  const unknown: ScanResult = { outcome: "miss", reason: "unknown", permitted: forNobody(permitted) };
  switch (query.by) {
    case "visit": {
      const [encounter] = await db.select().from(opdEncounters).where(eq(opdEncounters.visitNo, normalizeVisitNo(query.visitNo))).limit(1);
      return answerNamed(db, actor, permitted, encounter, today);
    }
    case "encounter": {
      const [encounter] = await db.select().from(opdEncounters).where(eq(opdEncounters.id, query.encounterId)).limit(1);
      return answerNamed(db, actor, permitted, encounter, today);
    }
    case "token": {
      // Tokens are per doctor's queue: every one of today's live entries with this number, narrowed by the department the slip prints.
      const rows = await db
        .select({ encounterId: opdQueueEntries.encounterId })
        .from(opdQueueEntries)
        .innerJoin(opdQueueSessions, eq(opdQueueSessions.id, opdQueueEntries.sessionId))
        .where(and(eq(opdQueueSessions.serviceDate, today), eq(opdQueueEntries.tokenNo, query.tokenNo), inArray(opdQueueEntries.status, [...LIVE_ENTRY])));
      const ids = [...new Set(rows.map((r) => r.encounterId))];
      if (ids.length === 0) return unknown;
      let encounters = await db.select().from(opdEncounters).where(and(inArray(opdEncounters.id, ids), notInArray(opdEncounters.status, ["abandoned"])));
      if (query.departmentCode !== undefined) {
        const departments = await departmentsOf(db, encounters);
        const code = query.departmentCode.toUpperCase();
        encounters = encounters.filter((e) => e.departmentId !== null && (departments.get(e.departmentId)?.code ?? "").toUpperCase() === code);
      }
      return answerEncounters(db, actor, permitted, encounters, async () => unknown);
    }
    case "uhid": {
      const typed = query.uhid.replace(/\s+/g, "").toUpperCase();
      // `U00110049`, or its digits alone (`110049`, `00110049`) — the bench's own `uhidIs`.
      const rows = /^\d+$/.test(typed)
        ? await db.select({ id: patients.id }).from(patients).where(sql`${patients.uhid} ~ ${`^[^0-9]+0*${String(Number(typed))}$`}`).limit(2)
        : await db.select({ id: patients.id }).from(patients).where(eq(patients.uhid, typed)).limit(2);
      return rows.length === 1 ? answerPatient(db, actor, permitted, rows[0]!.id, today) : unknown;
    }
    case "patient":
      return answerPatient(db, actor, permitted, query.patientId, today);
  }
}
