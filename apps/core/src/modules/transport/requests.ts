import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { TRANSPORT_KINDS, addEscortInput, newId, oxygenCheckInput, requestTransportInput } from "@hmis/contracts";
import { resources, tasks, transportRequests } from "../../kernel/db/schema";
import { admissionForTransport } from "../ipd";
import { MERGE_WINDOW_MS, TaskError, getTask, raiseTask } from "../tasks";
import { TransportRefusal } from "./errors";
import { escortIsClinical, requestOfTask } from "./guards";
import { ESCORT_ROLE_KEYS } from "./names";
import { isHighRiskForTransport } from "./risk";
import type { Actor, EscortReason, RequestTransportInput, TransportIsolation } from "@hmis/contracts";
import type { z } from "zod";
import type { Db, Tx } from "../../kernel/db/client";
import type { TaskRow } from "../tasks";
import type { TransportRequestRow } from "./guards";

/**
 * ═══ THE TRANSPORT INTENTS ═══
 *
 * A request raises ONE task on the engine (kind, FROM place, patient) and writes its transport row in the same
 * transaction. The engine's ten-minute merge applies: the same patient's move from the same place, asked again within
 * ten minutes, is the same request (its flags are OR-ed in — a second asker who says "oxygen" is never ignored); a
 * different patient never merges (the engine's merge key includes the patient).
 */
type Exec = Db | Tx;
const OPEN_BEFORE_START = ["created", "assigned", "accepted"] as const;

function parse<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const r = schema.safeParse(raw);
  if (!r.success) throw new TransportRefusal("bad_input", { issues: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
  return r.data;
}

async function placeExists(t: Exec, id: string): Promise<void> {
  const found = await (t as Db).select({ id: resources.id }).from(resources).where(eq(resources.id, id));
  if (found.length === 0) throw new TransportRefusal("unknown_place", { placeResourceId: id });
}

/** DECIDED: a merge keeps the STRICTER precaution and the STRONGER escort reason — never the weaker of two askers'. */
const ISOLATION_RANK: Record<TransportIsolation, number> = { none: 0, contact: 1, droplet: 2, airborne: 3 };
const ESCORT_RANK: Record<EscortReason, number> = { requested: 1, high_risk_flag: 2, critical_care_bed: 3 };
const stricterIsolation = (a: string, b: string): TransportIsolation =>
  (ISOLATION_RANK[a as TransportIsolation] ?? 0) >= (ISOLATION_RANK[b as TransportIsolation] ?? 0) ? a as TransportIsolation : b as TransportIsolation;
const strongerEscort = (a: EscortReason | null, b: EscortReason | null): EscortReason | null =>
  a === null ? b : b === null ? a : ESCORT_RANK[a] >= ESCORT_RANK[b] ? a : b;
const OPEN_STATES = ["created", "assigned", "accepted", "in_progress"] as const;

export type TransportRequestResult = { task: TaskRow; request: TransportRequestRow; merged: boolean; duplicate: boolean };

export async function requestTransport(exec: Exec, actor: Actor, raw: unknown, now: Date = new Date()): Promise<TransportRequestResult> {
  const input = parse(requestTransportInput, raw);
  return (exec as Db).transaction(async (t) => {
    const isMove = input.kind === TRANSPORT_KINDS.patientMove;
    let patientId: string | null = null;
    let from = input.fromResourceId ?? null;
    let escortReason: EscortReason | null = null;
    if (isMove && input.admissionId === undefined) throw new TransportRefusal("admission_required");
    if (input.admissionId !== undefined) {
      const facts = await admissionForTransport(t, input.admissionId);
      if (facts === null || !facts.movable) throw new TransportRefusal("admission_not_open", { admissionId: input.admissionId });
      patientId = facts.patientId;
      if (isMove) {
        from = from ?? facts.bedId;
        const risk = await isHighRiskForTransport(t, facts.admissionId);
        escortReason = risk.highRisk ? "critical_care_bed"
          : input.highRisk === true ? "high_risk_flag"
            : input.escortRequired === true ? "requested" : null;
      }
    }
    if (isMove && from === null) throw new TransportRefusal("no_origin");
    if (input.toResourceId === undefined && input.toNote === undefined) throw new TransportRefusal("no_destination");
    if (from !== null) await placeExists(t, from);
    if (input.toResourceId !== undefined) await placeExists(t, input.toResourceId);

    const mode = isMove ? (input.mode ?? "wheelchair") : null;
    const toResourceId = input.toResourceId ?? null;
    const toNote = input.toNote ?? null;
    // DECIDED: the engine would merge this into the open task of the same kind, place and patient raised within ten
    // minutes. If THAT task goes somewhere else or another way, it is a different move: raise it as its own task.
    let sourceRef = input.sourceRef;
    if (sourceRef === undefined && from !== null) {
      await t.execute(sql`select pg_advisory_xact_lock(hashtext(${`tasks:${input.kind}:${from}:${patientId ?? "-"}`}))`);
      const candidate = (await t.select({ to: transportRequests.toResourceId, toNote: transportRequests.toNote, mode: transportRequests.mode })
        .from(tasks).innerJoin(transportRequests, eq(transportRequests.taskId, tasks.id))
        .where(and(
          eq(tasks.kind, input.kind), eq(tasks.placeResourceId, from), sql`${tasks.patientId} is not distinct from ${patientId}`,
          inArray(tasks.state, [...OPEN_STATES]), gte(tasks.createdAt, new Date(now.getTime() - MERGE_WINDOW_MS)),
        )).orderBy(desc(tasks.createdAt)).limit(1))[0];
      if (candidate !== undefined && (candidate.to !== toResourceId || (candidate.to === null && candidate.toNote !== toNote) || candidate.mode !== mode)) {
        sourceRef = `transport:distinct:${newId()}`;
      }
    }
    const raised = await raiseTask(t, actor, {
      kind: input.kind, placeResourceId: from, patientId, priority: input.priority, note: input.note,
      ...(sourceRef === undefined ? {} : { sourceRef }),
    }, now).catch((e: unknown) => {
      if (e instanceof TaskError && e.code === "unknown_place") throw new TransportRefusal("unknown_place");
      throw e;
    });
    const existing = await requestOfTask(t, raised.task.id, true);
    if (existing !== null) {
      if (raised.duplicate === true) return { task: raised.task, request: existing, merged: false, duplicate: true };
      // MERGED (same place, destination and mode): a flag either asker raised is kept; the stricter isolation and the
      // stronger escort reason win.
      const reason = strongerEscort(existing.escortReason as EscortReason | null, escortReason);
      const upgraded = (await t.update(transportRequests).set({
        oxygen: existing.oxygen || input.oxygen === true,
        monitor: existing.monitor || input.monitor === true,
        isolation: stricterIsolation(existing.isolation, input.isolation ?? "none"),
        escortRequired: existing.escortRequired || reason !== null,
        escortReason: reason,
        updatedAt: now,
      }).where(eq(transportRequests.id, existing.id)).returning())[0]!;
      return { task: raised.task, request: upgraded, merged: raised.merged, duplicate: false };
    }
    const request = (await t.insert(transportRequests).values({
      id: newId(), taskId: raised.task.id, kind: input.kind, admissionId: input.admissionId ?? null,
      fromResourceId: from, toResourceId, toNote, mode,
      oxygen: input.oxygen === true, monitor: input.monitor === true, isolation: input.isolation ?? "none",
      reason: input.reason ?? null, escortRequired: escortReason !== null, escortReason,
      requestedBy: actor.id, createdAt: now, updatedAt: now,
    }).returning())[0]!;
    return { task: raised.task, request, merged: raised.merged, duplicate: false };
  });
}

/**
 * For the IPD lanes (admit, transfer, discharge, OT, imaging): ask for a patient move inside the caller's own
 * transaction. Give a `sourceRef` (e.g. `admission:<id>:to-bed`) to make a retried intent ask once.
 */
export function requestPatientMove(
  tx: Exec, actor: Actor, input: Omit<RequestTransportInput, "kind">, now: Date = new Date(),
): Promise<TransportRequestResult> {
  return requestTransport(tx, actor, { ...input, kind: TRANSPORT_KINDS.patientMove }, now);
}

async function openBeforeStart(t: Tx, taskId: string, version: number | undefined): Promise<{ task: TaskRow; req: TransportRequestRow }> {
  const req = await requestOfTask(t, taskId, true);
  if (req === null) throw new TransportRefusal("not_transport", { taskId });
  const task = await getTask(t, taskId);
  if (task === null) throw new TransportRefusal("not_transport", { taskId });
  if (version !== undefined && version !== task.version) throw new TaskError("stale", { taskId });
  if (task.state === "in_progress") throw new TransportRefusal("already_started", { taskId });
  if (!(OPEN_BEFORE_START as readonly string[]).includes(task.state)) throw new TaskError("not_open", { taskId, state: task.state });
  return { task, req };
}

/**
 * Record the escort who goes with the patient: an active user holding a nurse or doctor role, who is not the porter.
 * Before Start only; the porter, the requester or the supervisor records it (the door says who may).
 */
export async function addEscort(exec: Exec, actor: Actor, raw: unknown, now: Date = new Date()): Promise<TransportRequestRow> {
  const input = parse(addEscortInput, raw);
  return (exec as Db).transaction(async (t) => {
    const { task, req } = await openBeforeStart(t, input.taskId, input.version);
    if (req.kind !== TRANSPORT_KINDS.patientMove) throw new TransportRefusal("not_transport", { taskId: task.id });
    if (task.assigneeId === input.escortUserId) throw new TransportRefusal("escort_is_porter", { taskId: task.id });
    if (!(await escortIsClinical(t, input.escortUserId))) {
      throw new TransportRefusal("escort_not_clinical", { escortUserId: input.escortUserId });
    }
    return (await t.update(transportRequests).set({
      escortUserId: input.escortUserId, escortAddedBy: actor.id, escortAddedAt: now, updatedAt: now,
    }).where(eq(transportRequests.id, req.id)).returning())[0]!;
  });
}

/** The oxygen cylinder was checked (full enough for the trip, flow set) before the move. Before Start only. */
export async function recordOxygenCheck(exec: Exec, actor: Actor, raw: unknown, now: Date = new Date()): Promise<TransportRequestRow> {
  const input = parse(oxygenCheckInput, raw);
  return (exec as Db).transaction(async (t) => {
    const { req } = await openBeforeStart(t, input.taskId, input.version);
    return (await t.update(transportRequests).set({
      oxygenCheckedBy: actor.id, oxygenCheckedAt: now, updatedAt: now,
    }).where(eq(transportRequests.id, req.id)).returning())[0]!;
  });
}

/** Active users who may escort (the request sheet's and the porter's picker). */
/** Same predicate as `escortIsClinical` (`actorHoldsAnyRole`): a permanent role, or an unexpired temporary grant. */
export async function escortCandidates(db: Db, limit = 400): Promise<{ userId: string; name: string }[]> {
  const keys = sql.join(ESCORT_ROLE_KEYS.map((k) => sql`${k}`), sql`, `);
  const rows = await db.execute<{ id: string; full_name: string }>(sql`
    select distinct u.id, u.full_name from users u
    where u.active and (
      exists (select 1 from role_assignments ra where ra.user_id = u.id and ra.role_key in (${keys}))
      or exists (select 1 from temp_role_grants tg where tg.user_id = u.id and tg.role_key in (${keys}) and tg.expires_at > now())
    )
    order by u.full_name limit ${limit}`);
  return rows.rows.map((r) => ({ userId: r.id, name: r.full_name }));
}

