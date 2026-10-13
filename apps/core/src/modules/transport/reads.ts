import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { TRANSPORT_KIND_LIST, OPEN_TASK_STATES } from "@hmis/contracts";
import { resources, tasks, transportRequests, users } from "../../kernel/db/schema";
import { admissionForTransport, initialsOf, movableAdmissions } from "../ipd";
import { getPatientSummaries } from "../patients";
import { taskBoard } from "../tasks";
import { WAITING_ESCORT_SQL, escortNeeded } from "./guards";
import type {
  Actor, EscortState, TransportBoardRow, TransportBoardView, TransportDetail, TransportDetailsView, TransportIsolation,
  TransportKind, TransportMode, TransportPatientOption, TransportPlaceOption, TransportReason, EscortReason,
} from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { TransportRequestRow } from "./guards";

/** Where a request goes to, in words: the register place's name, or the requester's note. */
async function placeNames(db: Db, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((i): i is string => i !== null))];
  if (want.length === 0) return new Map();
  const rows = await db.select({ id: resources.id, name: resources.name, code: resources.code }).from(resources).where(inArray(resources.id, want));
  return new Map(rows.map((r) => [r.id, r.name === "" ? r.code : r.name]));
}

async function userNames(db: Db, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((i): i is string => i !== null))];
  if (want.length === 0) return new Map();
  const rows = await db.select({ id: users.id, name: users.fullName }).from(users).where(inArray(users.id, want));
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function escortStateOf(db: Db, r: TransportRequestRow): Promise<{ required: boolean; state: EscortState }> {
  const required = await escortNeeded(db, r);
  if (r.escortUserId !== null) return { required, state: "with_escort" };
  return { required, state: required ? "waiting" : "not_needed" };
}

/**
 * The porter's card details for their own transport tasks (and the pool's). The patient's name and IP number are on
 * the porter's OWN card — they fetch the patient by them — never on the board. A confidential patient's name stays
 * sealed (`getPatientSummaries`).
 */
export async function transportDetails(db: Db, actor: Actor, taskIds: readonly string[]): Promise<TransportDetailsView> {
  const ids = [...new Set(taskIds)].slice(0, 100);
  if (ids.length === 0) return { details: [] };
  const rows = await db.select({ r: transportRequests, patientId: tasks.patientId }).from(transportRequests)
    .innerJoin(tasks, eq(tasks.id, transportRequests.taskId)).where(inArray(transportRequests.taskId, ids));
  const places = await placeNames(db, rows.flatMap((x) => [x.r.fromResourceId, x.r.toResourceId]));
  const escorts = await userNames(db, rows.map((x) => x.r.escortUserId));
  const summaries = await getPatientSummaries(db, actor, rows.map((x) => x.patientId).filter((p): p is string => p !== null));
  const nameOf = new Map(summaries.map((s) => [s.requestedId, s.name ?? s.alias ?? null]));
  const details: TransportDetail[] = [];
  for (const { r, patientId } of rows) {
    const esc = await escortStateOf(db, r);
    const facts = r.admissionId === null ? null : await admissionForTransport(db, r.admissionId);
    details.push({
      taskId: r.taskId, kind: r.kind as TransportKind,
      fromName: r.fromResourceId === null ? null : places.get(r.fromResourceId) ?? null,
      toName: r.toResourceId === null ? r.toNote : places.get(r.toResourceId) ?? r.toNote,
      mode: r.mode as TransportMode | null, oxygen: r.oxygen, oxygenChecked: r.oxygenCheckedAt !== null, monitor: r.monitor,
      isolation: r.isolation as TransportIsolation, reason: r.reason as TransportReason | null,
      escortRequired: esc.required, escortReason: (r.escortReason ?? (esc.required ? "critical_care_bed" : null)) as EscortReason | null,
      escortState: esc.state, escortName: r.escortUserId === null ? null : escorts.get(r.escortUserId) ?? null,
      patientName: patientId === null ? null : nameOf.get(patientId) ?? null,
      admissionNo: facts?.admissionNo ?? null,
      handedOverAt: r.handoverAt === null ? null : r.handoverAt.toISOString(),
    });
  }
  return { details };
}

const KINDS = [...TRANSPORT_KIND_LIST];

/**
 * The supervisor's wall board (16:9, no vertical scroll): every open move and run, late first, then those waiting
 * for an escort, then by due time. No patient identity; the porter by initials. Counts are SQL over every open task.
 */
export async function transportBoard(db: Db, now: Date = new Date()): Promise<TransportBoardView> {
  const base = await taskBoard(db, now, { kinds: KINDS });
  const cards = base.floors.flatMap((f) => f.tasks);
  const ids = cards.map((c) => c.id);
  const reqs = ids.length === 0 ? [] : await db.select().from(transportRequests).where(inArray(transportRequests.taskId, ids));
  const byTask = new Map(reqs.map((r) => [r.taskId, r]));
  const places = await placeNames(db, reqs.flatMap((r) => [r.fromResourceId, r.toResourceId]));
  const rows: TransportBoardRow[] = [];
  for (const c of cards) {
    const r = byTask.get(c.id);
    const esc = r === undefined ? { state: "not_needed" as EscortState } : await escortStateOf(db, r);
    rows.push({
      taskId: c.id, kind: c.kind as TransportKind, state: c.state, priority: c.priority,
      fromName: r?.fromResourceId != null ? places.get(r.fromResourceId) ?? c.placeName : c.placeName,
      toName: r === undefined ? null : r.toResourceId === null ? r.toNote : places.get(r.toResourceId) ?? r.toNote,
      mode: (r?.mode ?? null) as TransportMode | null, oxygen: r?.oxygen ?? false, monitor: r?.monitor ?? false,
      isolation: (r?.isolation ?? "none") as TransportIsolation, escortState: esc.state,
      porterInitials: c.assigneeName === null ? null : initialsOf(c.assigneeName),
      createdAt: c.createdAt, dueAt: c.dueAt, late: Date.parse(c.dueAt) <= now.getTime(), version: c.version,
    });
  }
  const rank = (x: TransportBoardRow): number => (x.late ? 0 : x.escortState === "waiting" ? 1 : 2);
  rows.sort((a, b) => (rank(a) - rank(b)) || (Date.parse(a.dueAt) - Date.parse(b.dueAt)));
  const waiting = (await db.select({ n: sql<number>`count(*)::int` }).from(transportRequests)
    .innerJoin(tasks, eq(tasks.id, transportRequests.taskId))
    .where(and(inArray(tasks.state, [...OPEN_TASK_STATES]), WAITING_ESCORT_SQL)))[0]!.n;
  return {
    serverNow: base.serverNow, rows,
    workers: base.workers,
    counts: { ...base.counts, waitingEscort: waiting },
  };
}

/** The request sheet's patient list: open, movable admissions, filtered by name, UHID, IP number or bed. */
export async function patientOptions(db: Db, actor: Actor, q: string, limit = 30): Promise<TransportPatientOption[]> {
  const all = await movableAdmissions(db);
  const summaries = await getPatientSummaries(db, actor, all.map((a) => a.patientId));
  const byId = new Map(summaries.map((s) => [s.requestedId, s]));
  const needle = q.trim().toLowerCase();
  const out: TransportPatientOption[] = [];
  for (const a of all) {
    const s = byId.get(a.patientId);
    const name = s?.name ?? s?.alias ?? "—";
    const hay = [name, s?.uhid ?? "", a.admissionNo ?? "", a.bedName ?? ""].join(" ").toLowerCase();
    if (needle !== "" && !hay.includes(needle)) continue;
    out.push({
      admissionId: a.admissionId, admissionNo: a.admissionNo, name, uhid: s?.uhid ?? "", bedId: a.bedId, bedName: a.bedName,
      criticalCare: a.criticalCareBed,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** DECIDED: a destination is a ward, hall, room or operating theatre in the register; anything else is a typed note. */
export const DESTINATION_KINDS = ["ward", "hall", "room", "theatre"] as const;

export async function placeOptions(db: Db): Promise<TransportPlaceOption[]> {
  return db.select({ id: resources.id, kind: resources.kind, code: resources.code, name: resources.name }).from(resources)
    .where(and(inArray(resources.kind, [...DESTINATION_KINDS]), ne(resources.status, "retired")))
    .orderBy(asc(resources.kind), asc(resources.name)).limit(500);
}
