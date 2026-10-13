import { eq, sql } from "drizzle-orm";
import { TRANSPORT_KINDS, addEscortInput, newId, oxygenCheckInput, requestTransportInput } from "@hmis/contracts";
import { resources, transportRequests, users } from "../../kernel/db/schema";
import { actorHoldsAnyRole } from "../../kernel/workflow/roles";
import { admissionForTransport } from "../ipd";
import { TaskError, getTask, raiseTask } from "../tasks";
import { TransportRefusal } from "./errors";
import { requestOfTask } from "./guards";
import { ESCORT_ROLE_KEYS } from "./names";
import { isHighRiskForTransport } from "./risk";
import type { Actor, EscortReason, RequestTransportInput } from "@hmis/contracts";
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

    const raised = await raiseTask(t, actor, {
      kind: input.kind, placeResourceId: from, patientId, priority: input.priority, note: input.note,
      ...(input.sourceRef === undefined ? {} : { sourceRef: input.sourceRef }),
    }, now).catch((e: unknown) => {
      if (e instanceof TaskError && e.code === "unknown_place") throw new TransportRefusal("unknown_place");
      throw e;
    });
    const existing = await requestOfTask(t, raised.task.id, true);
    if (existing !== null) {
      if (raised.duplicate === true) return { task: raised.task, request: existing, merged: false, duplicate: true };
      // MERGED: the first request's places and mode stand; a flag either asker raised is kept.
      const upgraded = (await t.update(transportRequests).set({
        oxygen: existing.oxygen || input.oxygen === true,
        monitor: existing.monitor || input.monitor === true,
        escortRequired: existing.escortRequired || escortReason !== null,
        escortReason: existing.escortReason ?? escortReason,
        updatedAt: now,
      }).where(eq(transportRequests.id, existing.id)).returning())[0]!;
      return { task: raised.task, request: upgraded, merged: raised.merged, duplicate: false };
    }
    const request = (await t.insert(transportRequests).values({
      id: newId(), taskId: raised.task.id, kind: input.kind, admissionId: input.admissionId ?? null,
      fromResourceId: from, toResourceId: input.toResourceId ?? null, toNote: input.toNote ?? null,
      mode: isMove ? (input.mode ?? "wheelchair") : null,
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
    const u = (await t.select({ active: users.active }).from(users).where(eq(users.id, input.escortUserId)))[0];
    if (u === undefined || !u.active || !(await actorHoldsAnyRole(t, input.escortUserId, [...ESCORT_ROLE_KEYS]))) {
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
export async function escortCandidates(db: Db, limit = 400): Promise<{ userId: string; name: string }[]> {
  const rows = await db.execute<{ id: string; full_name: string }>(sql`
    select distinct u.id, u.full_name from users u
    join role_assignments ra on ra.user_id = u.id
    where u.active and ra.role_key in (${sql.join(ESCORT_ROLE_KEYS.map((k) => sql`${k}`), sql`, `)})
    order by u.full_name limit ${limit}`);
  return rows.rows.map((r) => ({ userId: r.id, name: r.full_name }));
}

