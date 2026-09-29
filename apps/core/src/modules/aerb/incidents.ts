import { desc, eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { appendEvent } from "../../kernel/events/append";
import { istDayString } from "../../kernel/approvals/cumulative";
import { displayName, resolvePatientId } from "../patients";
import { AERB_INCIDENT_AFFECTED, AERB_INCIDENT_KINDS, aerbIncidents } from "../../kernel/db/schema/aerb";
import { patients } from "../../kernel/db/schema/patients";
import { resources } from "../../kernel/db/schema/resources";
import { users } from "../../kernel/db/schema/auth";
import { AerbError } from "./errors";
import { mayManage, requireManage } from "./access";
import { aerbIncidentRecorded } from "./events";
import type {
  AerbIncidentAction, AerbIncidentAffected, AerbIncidentKind, AerbIncidentState,
} from "../../kernel/db/schema/aerb";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * 18-S RS11 T2 — **THE RADIATION INCIDENT REGISTER.**
 *
 * Unintended or accidental exposure: a wrong patient, a wrong study, a pregnant patient exposed
 * unknowingly, a repeat beyond the threshold, an equipment malfunction, a worker over a limit. What
 * happened, what was done at once, why, what changes — and whether AERB had to be told.
 *
 * ═══ THE STATES ═══
 *
 *   open ──investigate (root cause + at least one corrective action)──▶ investigated ──close──▶ closed
 *
 * Close refuses while any corrective action has no done date (`incident_actions_open`) and while a
 * notifiable incident has no AERB notification date and reference (`notification_required`).
 *
 * ═══ DECIDED — WHEN AERB MUST BE TOLD (brief T2; standard Indian corporate-hospital practice) ═══
 *
 * Notify AERB for **any exposure significantly above what was intended** (the RSO's judgement,
 * recorded as `significantlyAboveIntended`) **or any worker over a dose limit** (kind
 * `worker_over_limit`). The verdict is computed when the incident is recorded and STORED, so a later
 * change of rule does not rewrite what the register said. The clock: **within 24 hours of recording**
 * (AERB's prompt-reporting expectation for an unusual occurrence) — shown on the RSO's list, never a
 * block. Everything else is recorded in the hospital's register and is not reportable.
 *
 * ═══ WHO ═══
 *
 * The RSO writes (`aerb.registers.manage`). The RSO and the radiologist read
 * (`aerb.incidents.read`) — the radiologist-in-charge is the department's HOD (RS4), and the
 * incident is theirs to know about; the licence file is not.
 */

/** Hours from recording within which a notifiable incident should reach AERB. DECIDED. */
export const AERB_NOTIFY_WITHIN_HOURS = 24;

export function notifyRequiredFor(kind: AerbIncidentKind, significantlyAboveIntended: boolean): boolean {
  return kind === "worker_over_limit" || significantlyAboveIntended;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function assertDate(value: string, field: string): void {
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(y, m - 1, d));
  if (!DATE_RE.test(value) || parsed.getUTCFullYear() !== y || parsed.getUTCMonth() !== m - 1 || parsed.getUTCDate() !== d) {
    throw new AerbError("invalid_validity", `${field} "${value}" is not a real date (YYYY-MM-DD)`, { field });
  }
}

function cleanActions(actions: readonly AerbIncidentAction[]): AerbIncidentAction[] {
  return actions.map((a, i) => {
    const action = a.action.trim();
    const owner = a.owner.trim();
    if (action === "" || owner === "") {
      throw new AerbError("invalid_validity", `corrective action ${String(i + 1)} needs both what is to be done and who owns it`);
    }
    if (a.doneOn !== null) assertDate(a.doneOn, `corrective action ${String(i + 1)} done on`);
    return { action, owner, doneOn: a.doneOn };
  });
}

export interface RecordIncidentInput {
  kind: AerbIncidentKind;
  occurredAt: string;
  deviceResourceId?: string | null;
  affectedType: AerbIncidentAffected;
  /** The patient by UHID — what the RSO has in hand. */
  patientUhid?: string | null;
  workerUserId?: string | null;
  affectedName?: string | null;
  estimatedDoseMsv?: number | null;
  doseNote?: string | null;
  description: string;
  immediateAction: string;
  significantlyAboveIntended: boolean;
}

async function nextIncidentNo(tx: Tx, now: Date): Promise<string> {
  const yy = istDayString(now).slice(2, 4);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('aerb_incidents_no'))`);
  const prefix = `INC-${yy}-`;
  const rows = await tx.select({ no: aerbIncidents.incidentNo }).from(aerbIncidents)
    .where(sql`${aerbIncidents.incidentNo} like ${`${prefix}%`}`);
  const max = rows.reduce((m, r) => Math.max(m, Number(r.no.slice(prefix.length)) || 0), 0);
  return `${prefix}${String(max + 1).padStart(3, "0")}`;
}

export async function recordIncident(
  tx: Tx, actor: Actor, input: RecordIncidentInput, opts: { now?: Date } = {},
): Promise<{ incidentId: string; incidentNo: string; notifyRequired: boolean }> {
  await requireManage(tx, actor, "an incident is recorded by a person");
  const now = opts.now ?? new Date();
  if (!(AERB_INCIDENT_KINDS as readonly string[]).includes(input.kind)) {
    throw new AerbError("invalid_validity", `"${input.kind}" is not an incident kind`);
  }
  if (!(AERB_INCIDENT_AFFECTED as readonly string[]).includes(input.affectedType)) {
    throw new AerbError("invalid_validity", `"${input.affectedType}" is not who can be affected`);
  }
  const occurredAt = new Date(input.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) {
    throw new AerbError("invalid_validity", `occurredAt "${input.occurredAt}" is not a time`);
  }
  if (occurredAt.getTime() > now.getTime() + 60_000) {
    throw new AerbError("invalid_validity", "an incident is recorded after it happened — the time is in the future");
  }
  const description = input.description.trim();
  const immediateAction = input.immediateAction.trim();
  if (description === "" || immediateAction === "") {
    throw new AerbError("invalid_validity", "say what happened and what was done at once — facts only; the root cause comes later");
  }
  if (input.estimatedDoseMsv != null && !(input.estimatedDoseMsv >= 0)) {
    throw new AerbError("invalid_validity", "an estimated dose is not negative");
  }

  let deviceResourceId: string | null = null;
  if (input.deviceResourceId != null) {
    const [d] = await tx.select({ id: resources.id, kind: resources.kind }).from(resources).where(eq(resources.id, input.deviceResourceId));
    if (d === undefined || d.kind !== "device") {
      throw new AerbError("unknown_licence", "the machine named is not a device in the register", { deviceResourceId: input.deviceResourceId });
    }
    deviceResourceId = d.id;
  }

  let patientId: string | null = null;
  let workerUserId: string | null = null;
  let affectedName: string | null = input.affectedName?.trim() || null;
  if (input.affectedType === "patient") {
    const uhid = input.patientUhid?.trim() ?? "";
    if (uhid === "") throw new AerbError("invalid_validity", "a patient incident names the patient's UHID");
    const [p] = await tx.select({ id: patients.id }).from(patients).where(eq(patients.uhid, uhid));
    if (p === undefined) throw new AerbError("unknown_person", `no patient with UHID ${uhid}`, { uhid });
    patientId = p.id;
  } else if (input.affectedType === "worker") {
    if (input.workerUserId == null) throw new AerbError("invalid_validity", "a worker incident names the worker");
    const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.id, input.workerUserId));
    if (u === undefined) throw new AerbError("unknown_person", `no user ${input.workerUserId}`);
    workerUserId = u.id;
  } else if (affectedName === null) {
    throw new AerbError("invalid_validity", "name the person exposed (a relative, a visitor)");
  }
  if (input.affectedType !== "other") affectedName = null;

  const notifyRequired = notifyRequiredFor(input.kind, input.significantlyAboveIntended);
  const incidentId = newId();
  const incidentNo = await nextIncidentNo(tx, now);
  await tx.insert(aerbIncidents).values({
    id: incidentId,
    incidentNo,
    kind: input.kind,
    occurredAt,
    deviceResourceId,
    affectedType: input.affectedType,
    patientId,
    workerUserId,
    affectedName,
    estimatedDoseMsv: input.estimatedDoseMsv == null ? null : String(input.estimatedDoseMsv),
    doseNote: input.doseNote?.trim() || null,
    description,
    immediateAction,
    significantlyAboveIntended: input.significantlyAboveIntended,
    notifyRequired,
    state: "open",
    createdBy: actor.id,
    createdAt: now,
  });
  /** The audit trail of WHO recorded WHAT. No patient in the payload — the row holds that. */
  await appendEvent(tx, aerbIncidentRecorded.make({
    payload: { incidentId, incidentNo, kind: input.kind, notifyRequired },
    actor,
    correlationId: incidentId,
  }));
  return { incidentId, incidentNo, notifyRequired };
}

async function loadIncident(tx: Tx, id: string): Promise<typeof aerbIncidents.$inferSelect> {
  const [row] = await tx.select().from(aerbIncidents).where(eq(aerbIncidents.id, id)).for("update");
  if (row === undefined) throw new AerbError("unknown_incident", `no incident ${id}`, { incidentId: id });
  return row;
}

/** open → investigated: the root cause and the corrective actions. */
export async function investigateIncident(
  tx: Tx, actor: Actor, id: string, input: { rootCause: string; correctiveActions: readonly AerbIncidentAction[] },
  opts: { now?: Date } = {},
): Promise<void> {
  await requireManage(tx, actor, "an incident is investigated by a person");
  const row = await loadIncident(tx, id);
  if (row.state !== "open") {
    throw new AerbError("incident_state", `${row.incidentNo} is ${row.state}; only an open incident is investigated — edit its actions instead`);
  }
  const rootCause = input.rootCause.trim();
  if (rootCause === "") throw new AerbError("invalid_validity", "an investigation names the root cause");
  const actions = cleanActions(input.correctiveActions);
  if (actions.length === 0) {
    throw new AerbError("invalid_validity", "an investigation names at least one corrective action — what changes so this does not happen again");
  }
  const now = opts.now ?? new Date();
  await tx.update(aerbIncidents).set({
    rootCause, correctiveActions: actions, state: "investigated",
    investigatedAt: now, investigatedBy: actor.id, updatedAt: now,
  }).where(eq(aerbIncidents.id, id));
}

/** The actions list, replaced whole — adding one, or marking one done. Refused once closed. */
export async function updateIncidentActions(
  tx: Tx, actor: Actor, id: string, actions: readonly AerbIncidentAction[],
): Promise<void> {
  await requireManage(tx, actor, "an incident's actions are kept by a person");
  const row = await loadIncident(tx, id);
  if (row.state === "closed") throw new AerbError("incident_state", `${row.incidentNo} is closed`);
  await tx.update(aerbIncidents).set({ correctiveActions: cleanActions(actions), updatedAt: new Date() })
    .where(eq(aerbIncidents.id, id));
}

/** AERB was told: the date and the reference, both. */
export async function recordIncidentNotification(
  tx: Tx, actor: Actor, id: string, input: { notifiedOn: string; notificationRef: string }, opts: { now?: Date } = {},
): Promise<void> {
  await requireManage(tx, actor, "an AERB notification is recorded by a person");
  const row = await loadIncident(tx, id);
  if (row.state === "closed") throw new AerbError("incident_state", `${row.incidentNo} is closed`);
  assertDate(input.notifiedOn, "notifiedOn");
  const today = istDayString(opts.now ?? new Date());
  if (input.notifiedOn > today) throw new AerbError("invalid_validity", `notifiedOn ${input.notifiedOn} is in the future`);
  const ref = input.notificationRef.trim();
  if (ref === "") throw new AerbError("invalid_validity", "the AERB notification needs its reference (eLORA / letter number)");
  await tx.update(aerbIncidents).set({ notifiedOn: input.notifiedOn, notificationRef: ref, updatedAt: new Date() })
    .where(eq(aerbIncidents.id, id));
}

export async function closeIncident(
  tx: Tx, actor: Actor, id: string, input: { closureNote?: string | null }, opts: { now?: Date } = {},
): Promise<void> {
  await requireManage(tx, actor, "an incident is closed by a person");
  const row = await loadIncident(tx, id);
  if (row.state !== "investigated") {
    throw new AerbError(
      "incident_state",
      row.state === "closed"
        ? `${row.incidentNo} is already closed`
        : `${row.incidentNo} has not been investigated — record the root cause and the corrective actions first`,
    );
  }
  const open = row.correctiveActions.filter((a) => a.doneOn === null);
  if (open.length > 0) {
    throw new AerbError(
      "incident_actions_open",
      `${row.incidentNo} has ${String(open.length)} corrective action${open.length === 1 ? "" : "s"} still open: `
      + `${open.map((a) => `"${a.action}" (${a.owner})`).join("; ")} — mark each done, then close`,
      { open },
    );
  }
  if (row.notifyRequired && row.notifiedOn === null) {
    throw new AerbError(
      "notification_required",
      `${row.incidentNo} must be notified to AERB — record the date and the reference, then close`,
    );
  }
  const now = opts.now ?? new Date();
  await tx.update(aerbIncidents).set({
    state: "closed", closedAt: now, closedBy: actor.id, closureNote: input.closureNote?.trim() || null, updatedAt: now,
  }).where(eq(aerbIncidents.id, id));
}

export interface IncidentRow {
  id: string;
  incidentNo: string;
  kind: AerbIncidentKind;
  occurredAt: string;
  deviceCode: string | null;
  deviceName: string | null;
  affectedType: AerbIncidentAffected;
  /** The patient (display name per clearance), the worker, or the free-text name. */
  affectedLabel: string;
  uhid: string | null;
  restricted: boolean;
  estimatedDoseMsv: string | null;
  doseNote: string | null;
  description: string;
  immediateAction: string;
  rootCause: string | null;
  correctiveActions: AerbIncidentAction[];
  significantlyAboveIntended: boolean;
  notifyRequired: boolean;
  notifiedOn: string | null;
  notificationRef: string | null;
  /** When the 24-hour clock runs out, for a notifiable incident not yet notified. */
  notifyDueAt: string | null;
  notifyOverdue: boolean;
  state: AerbIncidentState;
  createdAt: string;
  closedAt: string | null;
  closureNote: string | null;
}

/** The register, open first then newest. One PHI row per patient disclosed. */
export async function incidentRegister(
  db: Db, actor: Actor, opts: { now?: Date } = {},
): Promise<{ rows: IncidentRow[]; canManage: boolean }> {
  const now = opts.now ?? new Date();
  const rows = await db.select({
    i: aerbIncidents,
    deviceCode: resources.code,
    deviceName: resources.name,
    pName: patients.name,
    pAlias: patients.alias,
    pConfidential: patients.isConfidential,
    uhid: patients.uhid,
    workerName: users.fullName,
  })
    .from(aerbIncidents)
    .leftJoin(resources, eq(resources.id, aerbIncidents.deviceResourceId))
    .leftJoin(patients, eq(patients.id, aerbIncidents.patientId))
    .leftJoin(users, eq(users.id, aerbIncidents.workerUserId))
    .orderBy(sql`case ${aerbIncidents.state} when 'open' then 0 when 'investigated' then 1 else 2 end`, desc(aerbIncidents.occurredAt))
    .limit(500);

  const canSeeConfidential = actor.type === "user"
    && await hasPermission(db, actor.id, "patients.confidential.read", "hospital");

  const out: IncidentRow[] = rows.map(({ i, deviceCode, deviceName, pName, pAlias, pConfidential, uhid, workerName }) => {
    const withheld = i.patientId !== null && pConfidential === true && !canSeeConfidential;
    const affectedLabel = i.affectedType === "patient"
      ? displayName({ name: pName ?? "", alias: pAlias ?? null, isConfidential: pConfidential ?? false }, canSeeConfidential)
      : i.affectedType === "worker" ? (workerName ?? "") : (i.affectedName ?? "");
    const due = i.notifyRequired && i.notifiedOn === null
      ? new Date(i.createdAt.getTime() + AERB_NOTIFY_WITHIN_HOURS * 3_600_000) : null;
    return {
      id: i.id,
      incidentNo: i.incidentNo,
      kind: i.kind as AerbIncidentKind,
      occurredAt: i.occurredAt.toISOString(),
      deviceCode: deviceCode ?? null,
      deviceName: deviceName ?? null,
      affectedType: i.affectedType as AerbIncidentAffected,
      affectedLabel,
      uhid: i.patientId === null || withheld ? null : (uhid ?? null),
      restricted: withheld,
      estimatedDoseMsv: i.estimatedDoseMsv,
      doseNote: i.doseNote,
      description: i.description,
      immediateAction: i.immediateAction,
      rootCause: i.rootCause,
      correctiveActions: i.correctiveActions,
      significantlyAboveIntended: i.significantlyAboveIntended,
      notifyRequired: i.notifyRequired,
      notifiedOn: i.notifiedOn,
      notificationRef: i.notificationRef,
      notifyDueAt: due?.toISOString() ?? null,
      notifyOverdue: due !== null && i.state !== "closed" && due.getTime() < now.getTime(),
      state: i.state as AerbIncidentState,
      createdAt: i.createdAt.toISOString(),
      closedAt: i.closedAt?.toISOString() ?? null,
      closureNote: i.closureNote,
    };
  });

  for (const pid of new Set(rows.map((r) => r.i.patientId).filter((p): p is string => p !== null))) {
    await recordPhiAccess(db, {
      actor, patientId: (await resolvePatientId(db, pid)) ?? pid,
      surface: "aerb.incident_register", reason: `AERB incident register, ${String(out.length)} rows`,
    });
  }
  return { rows: out, canManage: await mayManage(db, actor) };
}
