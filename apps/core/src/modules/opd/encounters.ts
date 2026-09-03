import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { EPISODE_SERIAL_DIGITS, EPISODE_SERIES, nextEpisodeNo } from "../../kernel/episodes/series";
import { withTx } from "../../kernel/db/client";
import {
  opdDepartments, opdDoctors, opdEncounters, opdPrescriptions, opdQueueEntries, opdQueueSessions, opdVitals,
} from "../../kernel/db/schema";
import { startInstance, transition, WorkflowError } from "../../kernel/workflow/instances";
import { getPatient, listMergedLoserIds, resolvePatientId } from "../patients";
import { encounterFeeStatuses } from "../billing";
import type { EncounterFeeStatus } from "../billing";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { loadOpdConfig } from "./config";
import { OpdError } from "./errors";
import { patientCheckedIn, visitAbandoned, visitOpened, visitTransferred } from "./events";
import { allocateToken, getOrCreateSession, roomForDoctorDay } from "./sessions";
import { istDate } from "./time";
import { classifyVisit } from "./visit-type";
import { OPD_VISIT_DEF_KEY } from "./workflow-def";
import type { OpdVisitState } from "./workflow-def";
import type { VisitType } from "./visit-type";
import type { Db, Tx } from "../../kernel/db/client";

export type EncounterRow = typeof opdEncounters.$inferSelect;
export type QueueEntryRow = typeof opdQueueEntries.$inferSelect;
export type VitalsRow = typeof opdVitals.$inferSelect;
export type PrescriptionRow = typeof opdPrescriptions.$inferSelect;

/** Queue-entry statuses a live encounter can be sitting in. */
export const LIVE_ENTRY_STATUSES = ["waiting_vitals", "waiting", "called"] as const;
/** Encounter states an abandon may leave from (the definition's three abandon transitions). */
const ABANDONABLE: readonly string[] = ["registered", "waiting", "awaiting_results"];

export type OpenVisitInput = {
  patientId: string; departmentId: string; doctorId: string;
  intendedPayer?: "self" | "tpa" | "pmjay" | "corporate";
  referralSource?: "self" | "internal_doctor" | "external_rmp" | "camp" | "other";
  referrerName?: string;
  /**
   * FD-7 T9 / R4 — the channel-partner slip's code, as the patient presented it. Stored UNVALIDATED
   * and deliberately: billing is where a code is checked against the partner's issue book and
   * against this patient (RC-2 review MAJOR 5), and duplicating that check here would put the same
   * money rule in two places. What this buys is that the cashier does not have to re-type it.
   */
  attributionCode?: string;
  appointment?: { id: string; slotStart: Date }; // set only by appointments.checkIn (T4)
  /**
   * RC-1 T3 / D4 — `bill_first` is a DEFERRED QUEUE JOIN, not a reordered transaction. The visit
   * opens with its doctor and department (both columns are NOT NULL, and the consult fee is flat
   * by charge_rules, so nothing about the bill waits on assignment); the session, token and queue
   * entry arrive with `joinQueue` after the money. Default "queue" is byte-for-byte the shipped
   * behaviour, and the appointment check-in path never defers.
   */
  join?: "queue" | "defer";
};
export type OpenVisitResult = {
  encounter: EncounterRow; queueEntry: QueueEntryRow; tokenNo: number; sessionId: string; roomId: string | null;
  visitType: VisitType; doctorScheduledToday: boolean;
};
/** RC-1 T3 / D4 — what a DEFERRED open returns: the visit without its day. `joinQueue` fills the nulls. */
export type OpenVisitDeferredResult = {
  encounter: EncounterRow; queueEntry: null; tokenNo: null; sessionId: null; roomId: string | null;
  visitType: VisitType; doctorScheduledToday: boolean;
};

/** Db-first: resolves the patient and its merge chain through the patients module, then runs openVisitInTx on its own transaction. */
export async function openVisit(db: Db, actor: Actor, input: OpenVisitInput & { join: "defer" }, now?: Date): Promise<OpenVisitDeferredResult>;
export async function openVisit(db: Db, actor: Actor, input: Omit<OpenVisitInput, "join"> & { join?: "queue" }, now?: Date): Promise<OpenVisitResult>;
export async function openVisit(db: Db, actor: Actor, input: OpenVisitInput, now?: Date): Promise<OpenVisitResult | OpenVisitDeferredResult>;
export async function openVisit(db: Db, actor: Actor, input: OpenVisitInput, now: Date = new Date()): Promise<OpenVisitResult | OpenVisitDeferredResult> {
  if (actor.type !== "user") throw new OpdError("user_actor_required");
  const canonical = await resolvePatientId(db, input.patientId);
  if (!canonical) throw new OpdError("patient_not_found", `unknown patient ${input.patientId}`);
  const chainIds = [canonical, ...(await listMergedLoserIds(db, canonical))];
  return withTx(db, (tx) => openVisitInTx(tx, actor, { ...input, patientId: canonical, chainIds }, now));
}

/**
 * Tx-first core (also called by appointments.checkIn inside ITS transaction). patientId MUST already be canonical.
 *
 * OVERLOADED on `join` so the DEFERRED branch cannot leak nulls into the shipped callers: the
 * check-in and lab paths never pass `join` and keep the non-null `OpenVisitResult` they always had.
 */
export async function openVisitInTx(tx: Tx, actor: Actor, input: OpenVisitInput & { chainIds: string[]; join: "defer" }, now: Date): Promise<OpenVisitDeferredResult>;
export async function openVisitInTx(tx: Tx, actor: Actor, input: Omit<OpenVisitInput, "join"> & { chainIds: string[]; join?: "queue" }, now: Date): Promise<OpenVisitResult>;
export async function openVisitInTx(tx: Tx, actor: Actor, input: OpenVisitInput & { chainIds: string[] }, now: Date): Promise<OpenVisitResult | OpenVisitDeferredResult>;
export async function openVisitInTx(tx: Tx, actor: Actor, input: OpenVisitInput & { chainIds: string[] }, now: Date): Promise<OpenVisitResult | OpenVisitDeferredResult> {
  if (actor.type !== "user") throw new OpdError("user_actor_required");
  await loadOpdConfig(tx); // opd_not_configured before any write
  const doctor = (await tx.select().from(opdDoctors).where(eq(opdDoctors.id, input.doctorId)))[0];
  if (!doctor) throw new OpdError("unknown_doctor");
  if (!doctor.active) throw new OpdError("doctor_inactive");
  const dept = (await tx.select().from(opdDepartments).where(eq(opdDepartments.id, input.departmentId)))[0];
  if (!dept) throw new OpdError("unknown_department");
  if (!dept.active) throw new OpdError("department_inactive");
  if (doctor.departmentId !== dept.id) throw new OpdError("doctor_department_mismatch");

  const serviceDate = istDate(now);
  const anchorRows = await tx
    .select({ consultCompletedAt: opdEncounters.consultCompletedAt, followUpDays: opdEncounters.followUpDays })
    .from(opdEncounters)
    .where(and(inArray(opdEncounters.patientId, input.chainIds), eq(opdEncounters.departmentId, dept.id), eq(opdEncounters.status, "completed")))
    .orderBy(desc(opdEncounters.consultCompletedAt))
    .limit(1);
  const a = anchorRows[0];
  const visitType = classifyVisit(a && a.consultCompletedAt ? { consultCompletedAt: a.consultCompletedAt, followUpDays: a.followUpDays ?? 7 } : null, now);

  const encounterId = newId();
  // The visit number, allocated once per encounter. A same-day re-entry after results does NOT
  // come back through here — it appends an opd_queue_entries row against THIS encounter — so
  // there is exactly one V number per visit, which is what makes it safe to print on a lab form.
  const visitNo = await nextEpisodeNo(tx, "visit", serviceDate);
  const { instanceId } = await startInstance(tx, OPD_VISIT_DEF_KEY, { type: "opd_encounter", id: encounterId, patientId: input.patientId, encounterId });
  const roomId = await roomForDoctorDay(tx, doctor.id, serviceDate);

  const [encounter] = await tx.insert(opdEncounters).values({
    id: encounterId, visitNo, patientId: input.patientId, workflowInstanceId: instanceId, departmentId: dept.id, doctorId: doctor.id,
    appointmentId: input.appointment?.id ?? null, serviceDate, visitType,
    intendedPayer: input.intendedPayer ?? "self", referralSource: input.referralSource ?? null, referrerName: input.referrerName ?? null,
    // Trimmed, and an empty string is stored as NULL: "" is not a slip, and a blank code reaching
    // the fee quote would be a lookup for a partner that cannot exist.
    attributionCode: (input.attributionCode ?? "").trim() === "" ? null : input.attributionCode!.trim(),
    openedBy: actor.id, openedAt: now, updatedBy: actor.id, updatedAt: now,
  }).returning();

  const env = { actor, patientId: input.patientId, encounterId, correlationId: instanceId };
  const openedPayload = {
    encounterId, patientId: input.patientId, departmentId: dept.id, doctorId: doctor.id, serviceDate,
    visitType, intendedPayer: input.intendedPayer ?? "self",
    kind: input.appointment ? ("appointment" as const) : ("walk_in" as const), appointmentId: input.appointment?.id ?? null,
  };

  // D4 — the deferred branch opens the visit and stops: no session, no token, no queue entry.
  if (input.join === "defer") {
    await appendEvent(tx, visitOpened.make({ ...env, payload: { ...openedPayload, sessionId: null, roomId, tokenNo: null } }));
    return { encounter: encounter!, queueEntry: null, tokenNo: null, sessionId: null, roomId, visitType, doctorScheduledToday: roomId !== null };
  }

  const joined = await joinSessionInTx(tx, { id: encounterId, doctorId: doctor.id, serviceDate }, input.appointment ?? null);
  await appendEvent(tx, visitOpened.make({ ...env, payload: {
    ...openedPayload, sessionId: joined.sessionId, roomId: joined.roomId, tokenNo: joined.tokenNo,
  } }));
  await appendEvent(tx, patientCheckedIn.make({ ...env, payload: {
    encounterId, patientId: input.patientId, doctorId: doctor.id, serviceDate,
    sessionId: joined.sessionId, roomId: joined.roomId, tokenNo: joined.tokenNo, kind: "arrival",
  } }));
  return {
    encounter: encounter!, queueEntry: joined.queueEntry, tokenNo: joined.tokenNo, sessionId: joined.sessionId,
    roomId: joined.roomId, visitType, doctorScheduledToday: roomId !== null,
  };
}

/** The ONE place a visit joins its doctor-day: session get-or-create, token allocation, queue-entry insert. Both callers — the immediate open above and `joinQueue` below — run it inside their own transaction. */
async function joinSessionInTx(
  tx: Tx,
  encounter: { id: string; doctorId: string; serviceDate: string },
  appointment: { id: string; slotStart: Date } | null,
): Promise<{ queueEntry: QueueEntryRow; tokenNo: number; sessionId: string; roomId: string | null }> {
  const roomId = await roomForDoctorDay(tx, encounter.doctorId, encounter.serviceDate);
  const session = await getOrCreateSession(tx, encounter.doctorId, encounter.serviceDate, roomId);
  const tokenNo = await allocateToken(tx, session.id);
  const [queueEntry] = await tx.insert(opdQueueEntries).values({
    id: newId(), sessionId: session.id, encounterId: encounter.id, tokenNo,
    kind: appointment ? "appointment" : "walk_in", appointmentAt: appointment?.slotStart ?? null, status: "waiting_vitals",
  }).returning();
  return { queueEntry: queueEntry!, tokenNo, sessionId: session.id, roomId: session.roomId };
}

export type JoinQueueResult = {
  encounter: EncounterRow; queueEntry: QueueEntryRow; tokenNo: number; sessionId: string; roomId: string | null;
  /** True when a live entry already existed — the call is IDEMPOTENT and returns it unchanged. */
  alreadyJoined: boolean;
};

/**
 * RC-1 T3 / D4 — the second half of a bill-first walk-in: the deferred visit joins its doctor's
 * day. Idempotent per encounter, and race-safe by a lock on the ENCOUNTER row (a row outside the
 * entry's own write path, the `callNext` idiom): two concurrent joins serialize there, the loser
 * re-reads and returns the winner's entry — ONE token, ONE row, whichever interleaving.
 */
export async function joinQueue(db: Db, actor: Actor, encounterId: string, now: Date = new Date()): Promise<JoinQueueResult> {
  if (actor.type !== "user") throw new OpdError("user_actor_required");
  return withTx(db, (tx) => joinQueueInTx(tx, actor, encounterId, now));
}

/**
 * RC-4 CLOSE F1 — THE JOIN, AS A TRANSACTION STEP, so the money can call it where the money lands.
 *
 * The close review found that a deferred visit's "still owes a join" lived ONLY in the seat's
 * component state: a reload, a navigation to open the drawer, an Escape mid-settle, the palette
 * taking another patient, or the money being taken at `/billing` instead of at the seat — each
 * left a PAID patient with no token and no surface in the system able to give them one. The
 * server was ready (this function is idempotent) and had one ephemeral caller.
 *
 * So `queueFeeStatusHook` (`queue.ts`) now joins a deferred visit INSIDE the settling
 * transaction when its fee becomes covered — "the token is BORN PAID" made literal — and the
 * seat's own call afterwards answers `alreadyJoined: true` with the same token. One join path,
 * one set of preconditions, whichever road the money takes.
 */
export async function joinQueueInTx(tx: Tx, actor: Actor, encounterId: string, now: Date): Promise<JoinQueueResult> {
  const rows = await tx.select().from(opdEncounters).where(eq(opdEncounters.id, encounterId)).for("update");
  const encounter = rows[0];
  if (!encounter) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  if (encounter.status !== "registered") {
    throw new OpdError("encounter_state_conflict", `a queue join needs a registered visit, not ${encounter.status}`);
  }
  if (encounter.serviceDate !== istDate(now)) {
    throw new OpdError("encounter_state_conflict", `visit ${encounterId} belongs to ${encounter.serviceDate} — a past day's visit cannot join today's queue`);
  }
  if (encounter.doctorId === null) {
    throw new OpdError("unknown_doctor", `visit ${encounterId} has no responsible doctor to queue for`);
  }

  const existing = (await tx
    .select().from(opdQueueEntries)
    .where(and(eq(opdQueueEntries.encounterId, encounterId), inArray(opdQueueEntries.status, [...LIVE_ENTRY_STATUSES])))
    .orderBy(desc(opdQueueEntries.seq)).limit(1))[0];
  if (existing) {
    const session = (await tx.select().from(opdQueueSessions).where(eq(opdQueueSessions.id, existing.sessionId)))[0]!;
    return { encounter, queueEntry: existing, tokenNo: existing.tokenNo, sessionId: session.id, roomId: session.roomId, alreadyJoined: true };
  }

  const joined = await joinSessionInTx(tx, { id: encounter.id, doctorId: encounter.doctorId, serviceDate: encounter.serviceDate }, null);
  await appendEvent(tx, patientCheckedIn.make({
    actor, patientId: encounter.patientId, encounterId, correlationId: encounter.workflowInstanceId,
    payload: {
      encounterId, patientId: encounter.patientId, doctorId: encounter.doctorId, serviceDate: encounter.serviceDate,
      sessionId: joined.sessionId, roomId: joined.roomId, tokenNo: joined.tokenNo, kind: "arrival",
    },
  }));
  return { encounter, ...joined, alreadyJoined: false };
}

export type ReviewAnchor = { doctorName: string | null; seenOn: string; windowEndsOn: string };

/**
 * RC-1 T5 / D8 — the anchor that made this visit FREE, so the quote can NAME the rule instead of
 * answering a bare `free: true`. Re-derived from the same query `openVisitInTx` classified with;
 * naming only — the free BRANCH itself stays `classifyVisit`'s, and a null here never un-frees
 * anything (an anchor can be absent on a hand-edited row; the quote then says free with no story).
 */
export async function reviewAnchorFor(
  db: Db | Tx,
  encounter: { patientId: string; departmentId: string | null; visitType: string },
): Promise<ReviewAnchor | null> {
  if (encounter.visitType !== "revisit" || encounter.departmentId === null) return null;
  const chainIds = [encounter.patientId, ...(await listMergedLoserIds(db, encounter.patientId))];
  const anchor = (await db
    .select({ consultCompletedAt: opdEncounters.consultCompletedAt, followUpDays: opdEncounters.followUpDays, doctorId: opdEncounters.doctorId })
    .from(opdEncounters)
    .where(and(inArray(opdEncounters.patientId, chainIds), eq(opdEncounters.departmentId, encounter.departmentId), eq(opdEncounters.status, "completed")))
    .orderBy(desc(opdEncounters.consultCompletedAt))
    .limit(1))[0];
  if (!anchor?.consultCompletedAt) return null;
  const days = anchor.followUpDays ?? 7;
  const windowEnd = new Date(anchor.consultCompletedAt.getTime() + days * 24 * 3600 * 1000);
  const doctor = anchor.doctorId === null
    ? undefined
    : (await db.select({ displayName: opdDoctors.displayName }).from(opdDoctors).where(eq(opdDoctors.id, anchor.doctorId)))[0];
  return {
    doctorName: doctor?.displayName ?? null,
    seenOn: istDate(anchor.consultCompletedAt),
    windowEndsOn: istDate(windowEnd),
  };
}

/**
 * PLAN 17a T4 / DD15 — **THE LAB WALK-IN IS A `V` VISIT, NOT A FOURTH KIND OF ENCOUNTER.**
 *
 * A patient who arrives at the lab counter with an outside doctor's slip has no OPD encounter, and
 * everything downstream of a lab order needs one: `placeOrder` resolves `encounterNo` through the
 * prefix registry, `issueInvoice` reads the encounter for `intendedPayer`, and every departmental
 * report and every commission attribution keys off it. The alternatives were a nullable encounter
 * on the order (which makes every downstream reader ask "and what if there is none?") or a new
 * episode series (a new letter, which phase 0 §8 freezes). **A `V` visit in a `LAB` department,
 * with the pathologist of record as its responsible doctor, is the shape that needs no new concept
 * at all** — and it is also true: the hospital did see this person today.
 *
 * ═══ IT LIVES IN `opd/` BECAUSE `openVisitInTx` DOES, AND THAT IS SPEC §4 ═══
 *
 * The lab module may not write `opd_encounters`: a module reaches another module only through its
 * `index.ts`. So the OPD module exports the act, the lab calls it, and the visit is opened by the
 * code that owns visits — with `openVisitInTx`'s own guards intact rather than re-implemented.
 *
 * ═══ THE TWO PRECONDITIONS ARE **DATA**, AND THEIR ABSENCE IS NAMED (T4 A9) ═══
 *
 * Plan 17 §9.3 S2 measured what `openVisitInTx` requires: an ACTIVE doctor in an ACTIVE department
 * with `doctor.departmentId === dept.id`. Production has twelve departments and no `LAB` (S5), so
 * on day one this refuses — with `unknown_department`, which says exactly what the runbook must
 * create. The alternative was to pass `department_id: null` (the column is nullable) and let the
 * visit open anyway; that loses the lab from every departmental report and from every
 * `intendedPayer` read, silently, forever. **Creating the department and the pathologist row is
 * §9.9's runbook act.**
 */
export const LAB_DEPARTMENT_CODE = "LAB";

export type OpenLabWalkinInput = {
  patientId: string;
  /** Named by the caller when the lab has more than one pathologist of record. */
  doctorId?: string;
  intendedPayer?: OpenVisitInput["intendedPayer"];
  referralSource?: OpenVisitInput["referralSource"];
  referrerName?: string;
};

/** Tx-first, so the walk-in and the order it exists for are ONE transaction (DD6). */
export async function openLabWalkinInTx(
  tx: Tx, actor: Actor, input: OpenLabWalkinInput & { chainIds: string[] }, now: Date,
): Promise<OpenVisitResult> {
  if (actor.type !== "user") throw new OpdError("user_actor_required");

  const dept = (await tx.select().from(opdDepartments).where(eq(opdDepartments.code, LAB_DEPARTMENT_CODE)))[0];
  if (!dept) {
    throw new OpdError(
      "unknown_department",
      `no opd_departments row with code "${LAB_DEPARTMENT_CODE}" — a lab walk-in is a visit to the ` +
        "laboratory, and this hospital has not declared one",
    );
  }
  if (!dept.active) throw new OpdError("department_inactive", `department ${LAB_DEPARTMENT_CODE} is inactive`);

  /**
   * THE PATHOLOGIST OF RECORD. Named by the caller, or the sole ACTIVE doctor in the department.
   *
   * **Ambiguity refuses rather than picks.** `ordering_clinician_id` is the doctor answerable for
   * the test in a medico-legal chain; choosing one of two pathologists by row order would put a
   * name on a report by accident. A lab with two of them names one at the counter.
   */
  const labDoctors = await tx
    .select()
    .from(opdDoctors)
    .where(and(eq(opdDoctors.departmentId, dept.id), eq(opdDoctors.active, true)))
    .orderBy(asc(opdDoctors.id));
  let doctorId: string;
  if (input.doctorId !== undefined) {
    const named = labDoctors.find((d) => d.id === input.doctorId);
    if (!named) {
      const anywhere = (await tx.select().from(opdDoctors).where(eq(opdDoctors.id, input.doctorId)))[0];
      if (!anywhere) throw new OpdError("unknown_doctor", `unknown doctor ${input.doctorId}`);
      if (!anywhere.active) throw new OpdError("doctor_inactive", `doctor ${input.doctorId} is inactive`);
      throw new OpdError("doctor_department_mismatch", `doctor ${input.doctorId} is not in ${LAB_DEPARTMENT_CODE}`);
    }
    doctorId = named.id;
  } else if (labDoctors.length === 0) {
    throw new OpdError(
      "unknown_doctor",
      `no active doctor in department ${LAB_DEPARTMENT_CODE} — the pathologist of record is the ` +
        "responsible clinician on a walk-in (DD15), and this hospital has named none",
    );
  } else if (labDoctors.length > 1) {
    throw new OpdError(
      "unknown_doctor",
      `department ${LAB_DEPARTMENT_CODE} has ${labDoctors.length} active doctors — name the ` +
        "pathologist of record for this walk-in rather than letting the counter choose one",
    );
  } else {
    doctorId = labDoctors[0]!.id;
  }

  return await openVisitInTx(tx, actor, {
    patientId: input.patientId,
    chainIds: input.chainIds,
    departmentId: dept.id,
    doctorId,
    intendedPayer: input.intendedPayer,
    referralSource: input.referralSource ?? "external_rmp",
    referrerName: input.referrerName,
  }, now);
}

/** Db-first: resolves the merge chain, then runs the walk-in on its own transaction. */
export async function openLabWalkin(
  db: Db, actor: Actor, input: OpenLabWalkinInput, now: Date = new Date(),
): Promise<OpenVisitResult> {
  if (actor.type !== "user") throw new OpdError("user_actor_required");
  const canonical = await resolvePatientId(db, input.patientId);
  if (!canonical) throw new OpdError("patient_not_found", `unknown patient ${input.patientId}`);
  const chainIds = [canonical, ...(await listMergedLoserIds(db, canonical))];
  return withTx(db, (tx) => openLabWalkinInTx(tx, actor, { ...input, patientId: canonical, chainIds }, now));
}

/** THE only writer of opd_encounters.status: engine transition first (single-winner), then the mirror. */
export async function moveEncounter(
  tx: Tx, actor: Actor, encounter: EncounterRow, to: OpdVisitState,
  patch: Partial<Pick<EncounterRow, "consultStartedAt" | "consultCompletedAt" | "abandonedAt" | "abandonReason" | "followUpDays" | "followUpExtended"
    | "chiefComplaint" | "diagnosis" | "icd10Code" | "advice" | "admissionAdvised" | "referralTo" | "referralNote">> = {},
  now: Date = new Date(),
): Promise<EncounterRow> {
  try {
    await transition(tx, encounter.workflowInstanceId, to, actor);
  } catch (e) {
    if (e instanceof WorkflowError && (e.code === "stale_transition" || e.code === "instance_not_active" || e.code === "unknown_transition")) {
      throw new OpdError("encounter_state_conflict", `${encounter.status}→${to}: ${e.code}`);
    }
    throw e; // role_denied, unknown_instance, no_active_definition stay WorkflowErrors (403 / 409 at the edge)
  }
  const rows = await tx
    .update(opdEncounters)
    .set({ status: to, updatedBy: actor.id, updatedAt: now, ...patch })
    .where(and(eq(opdEncounters.id, encounter.id), eq(opdEncounters.status, encounter.status)))
    .returning();
  if (rows.length === 0) throw new OpdError("encounter_state_conflict", "mirror desync"); // unreachable while the invariant holds — a loud belt
  return rows[0]!;
}

/**
 * A well-formed visit NUMBER — `V` + `YYMMDD` + the four-digit daily serial. Built from the episode
 * constants rather than written out, so a change to either cannot leave this pattern behind.
 */
const VISIT_NO_RE = new RegExp(`^${EPISODE_SERIES.visit}\\d{${6 + EPISODE_SERIAL_DIGITS}}$`);

/** The encounter behind a visit NUMBER (`V2608290001`), which is not its row id. */
export async function getEncounterByVisitNo(db: Db | Tx, visitNo: string): Promise<EncounterRow | null> {
  const rows = await db.select().from(opdEncounters).where(eq(opdEncounters.visitNo, visitNo));
  return rows[0] ?? null;
}

/**
 * ONE ENCOUNTER, BY ROW ID **OR** BY VISIT NUMBER — and the second half is a defect repair.
 *
 * ═══ WHAT WAS BROKEN, PROVED BY EXECUTION BEFORE IT WAS FIXED ═══
 *
 * `opd.module.ts` registers this module's encounter resolver under the prefix
 * `EPISODE_SERIES.visit` (`"V"`), so `resolveEncounterByPrefix` hands it a visit NUMBER — and the
 * resolver called `getEncounter`, which read `opd_encounters.id`. **That column is a `newId()`
 * ULID; the visit number lives in `visit_no`.** So the resolver returned
 * `{matched: true, resolved: null}` for every real visit, and `placeOrder` refused
 * `unknown_encounter` for a lab order placed on a genuine OPD encounter — 17a T4's `deskOrder`
 * passes a caller-supplied `encounterNo` straight through. `modules/ot`'s resolver, one file over,
 * reads `daycare_encounters.encounter_no` and is correct; this was a divergence between two
 * implementations of one seam, not a design.
 *
 * Nothing caught it because every suite that reaches this seam registers its OWN fake `V` resolver
 * — phase 0's four order suites, `duplicates.test.ts`, and 17a's `test/helpers/lab.ts`. The fixture
 * supplied the answer the code got wrong. `encounter-resolver.test.ts` registers the REAL
 * registration against a REAL visit, which is the one arrangement that can see it, and it was
 * written RED first: `expect(received).not.toBeNull() / Received: null`.
 *
 * ═══ WHY THE FIX IS HERE AND NOT IN THE RESOLVER, WHICH IS WHERE IT BELONGS ═══
 *
 * The one-line repair is in `opd.module.ts`'s resolver body. **17a §8 freezes `modules/opd/*`
 * except `encounters.ts` and `index.ts`**, and a frozen path is not something to edit quietly. So
 * the repair lands in the reader the resolver already calls, which this phase does own, and the
 * deviation is disclosed rather than taken: **a later phase that owns `opd.module.ts` should move
 * the discrimination into the resolver and narrow this reader back to its row id.**
 *
 * ═══ THE DISCRIMINATION IS BY SHAPE, AND THAT IS WHAT KEEPS IT SAFE ═══
 *
 * A ULID can never match `VISIT_NO_RE`, so every existing caller — all of which pass a row id
 * (`invoice.encounterId`, `entry.encounterId`, the OPD controllers) — takes exactly the path it
 * took before. Billing's own fallback is unaffected for the same reason: a bare row id matches no
 * registered prefix, falls through, and is read by id here as it always was.
 */
export async function getEncounter(db: Db | Tx, id: string): Promise<EncounterRow | null> {
  if (VISIT_NO_RE.test(id)) return await getEncounterByVisitNo(db, id);
  const rows = await db.select().from(opdEncounters).where(eq(opdEncounters.id, id));
  return rows[0] ?? null;
}

/**
 * The encounter's newest queue entry (seq, never id — ledger §3.26) plus its session, for the
 * doctor-day event fields. RC-1 CLOSE C1: `null` when the encounter has NO entry at all — a
 * deferred (bill-first) visit that never joined. The old non-null assertion made abandoning a
 * walked-away deferred patient a 500, which made the visit unclosable.
 */
async function newestEntryWhere(
  tx: Tx, encounterId: string,
): Promise<{ entry: QueueEntryRow; sessionRoomId: string | null } | null> {
  const entries = await tx
    .select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, encounterId))
    .orderBy(desc(opdQueueEntries.seq)).limit(1);
  const entry = entries[0];
  if (!entry) return null;
  const sessions = await tx.select().from(opdQueueSessions).where(eq(opdQueueSessions.id, entry.sessionId));
  return { entry, sessionRoomId: sessions[0]!.roomId };
}

/** §11.1 walk-away. One transaction: the mirror move, the queue entry cancelled, one visit.abandoned. */
export async function abandonVisit(db: Db, actor: Actor, encounterId: string, reason: string, now: Date = new Date()): Promise<{ encounter: EncounterRow }> {
  if (reason.trim() === "") throw new OpdError("reason_required", "an abandoned visit records why");
  const current = await getEncounter(db, encounterId);
  if (!current) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  if (!ABANDONABLE.includes(current.status)) throw new OpdError("encounter_state_conflict", `cannot abandon from ${current.status}`);
  return withTx(db, async (tx) => {
    const encounter = await moveEncounter(tx, actor, current, "abandoned", { abandonedAt: now, abandonReason: reason }, now);
    await tx
      .update(opdQueueEntries)
      .set({ status: "cancelled" })
      .where(and(eq(opdQueueEntries.encounterId, encounterId), inArray(opdQueueEntries.status, [...LIVE_ENTRY_STATUSES])))
      .returning({ id: opdQueueEntries.id });
    // C1: a deferred visit has no entry — the abandon still happens; the event carries nulls,
    // exactly as visit.opened does for the same state.
    const located = await newestEntryWhere(tx, encounterId);
    await appendEvent(tx, visitAbandoned.make({
      actor, patientId: encounter.patientId, encounterId, correlationId: encounter.workflowInstanceId,
      payload: {
        encounterId, patientId: encounter.patientId, doctorId: encounter.doctorId, serviceDate: encounter.serviceDate,
        sessionId: located?.entry.sessionId ?? null, roomId: located?.sessionRoomId ?? null,
        tokenNo: located?.entry.tokenNo ?? null,
        fromState: current.status, reason,
      },
    }));
    return { encounter };
  });
}

/** Same-day return with results: the SAME encounter and the SAME token, a new queue entry in the re-entry class. */
export async function reEnterVisit(db: Db, actor: Actor, encounterId: string, now: Date = new Date()): Promise<{ encounter: EncounterRow; queueEntry: QueueEntryRow }> {
  const current = await getEncounter(db, encounterId);
  if (!current) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  if (current.status !== "awaiting_results") throw new OpdError("encounter_state_conflict", `re-entry needs awaiting_results, not ${current.status}`);
  if (istDate(now) !== current.serviceDate) throw new OpdError("encounter_state_conflict", "re-entry is same-IST-day only");
  return withTx(db, async (tx) => {
    const encounter = await moveEncounter(tx, actor, current, "waiting", {}, now);
    const previous = await tx
      .select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, encounterId))
      .orderBy(desc(opdQueueEntries.seq)).limit(1);
    const prev = previous[0]!;
    await tx
      .update(opdQueueEntries)
      .set({ status: "done", doneAt: now })
      .where(and(eq(opdQueueEntries.id, prev.id), inArray(opdQueueEntries.status, [...LIVE_ENTRY_STATUSES, "in_consult"])));
    const [queueEntry] = await tx.insert(opdQueueEntries).values({
      id: newId(), sessionId: prev.sessionId, encounterId, tokenNo: prev.tokenNo, kind: prev.kind,
      appointmentAt: null, status: "waiting", danger: encounter.dangerFlagged, reEntry: true, eligibleAt: now,
    }).returning();
    const sessions = await tx.select().from(opdQueueSessions).where(eq(opdQueueSessions.id, prev.sessionId));
    await appendEvent(tx, patientCheckedIn.make({
      actor, patientId: encounter.patientId, encounterId, correlationId: encounter.workflowInstanceId,
      payload: {
        encounterId, patientId: encounter.patientId, doctorId: encounter.doctorId, serviceDate: encounter.serviceDate,
        sessionId: prev.sessionId, roomId: sessions[0]!.roomId, tokenNo: prev.tokenNo, kind: "re_entry",
      },
    }));
    return { encounter, queueEntry: queueEntry! };
  });
}

/**
 * E2 coverage: a supervisor moves a doctor's live queue to another doctor OF THE SAME DEPARTMENT. New tokens in the
 * target session, original eligibility preserved (the patient does not lose their place), consent recorded.
 */
export async function transferQueue(
  db: Db,
  actor: Actor,
  input: { fromDoctorId: string; toDoctorId: string; serviceDate: string; entryIds?: string[]; consented: boolean; reason: string },
  now: Date = new Date(),
): Promise<{ transferred: number; toSessionId: string }> {
  if (input.consented !== true) throw new OpdError("invalid_transfer", "a queue transfer needs the patient's consent (E2)");
  if (input.reason.trim() === "") throw new OpdError("invalid_transfer", "a queue transfer records why");
  if (input.fromDoctorId === input.toDoctorId) throw new OpdError("invalid_transfer", "source and target doctor are the same");
  return withTx(db, async (tx) => {
    const from = (await tx.select().from(opdDoctors).where(eq(opdDoctors.id, input.fromDoctorId)))[0];
    const to = (await tx.select().from(opdDoctors).where(eq(opdDoctors.id, input.toDoctorId)))[0];
    if (!from || !to) throw new OpdError("invalid_transfer", "unknown doctor");
    if (!from.active || !to.active) throw new OpdError("invalid_transfer", "both doctors must be active");
    if (from.departmentId !== to.departmentId) throw new OpdError("invalid_transfer", "a transfer stays inside the department");

    const toRoomId = await roomForDoctorDay(tx, to.id, input.serviceDate);
    const toSession = await getOrCreateSession(tx, to.id, input.serviceDate, toRoomId);
    const fromSessions = await tx
      .select().from(opdQueueSessions)
      .where(and(eq(opdQueueSessions.doctorId, from.id), eq(opdQueueSessions.serviceDate, input.serviceDate)));
    const fromSession = fromSessions[0];
    if (!fromSession) return { transferred: 0, toSessionId: toSession.id };

    const all = await tx
      .select().from(opdQueueEntries)
      .where(and(eq(opdQueueEntries.sessionId, fromSession.id), inArray(opdQueueEntries.status, [...LIVE_ENTRY_STATUSES])))
      .orderBy(asc(opdQueueEntries.seq));
    const live = input.entryIds === undefined ? all : all.filter((e) => input.entryIds!.includes(e.id));

    let transferred = 0;
    for (const entry of live) {
      const claimed = await tx
        .update(opdQueueEntries)
        .set({ status: "transferred" })
        .where(and(eq(opdQueueEntries.id, entry.id), eq(opdQueueEntries.status, entry.status)))
        .returning({ id: opdQueueEntries.id });
      if (claimed.length === 0) continue; // moved concurrently — skip, never overwrite
      const encounter = (await tx.select().from(opdEncounters).where(eq(opdEncounters.id, entry.encounterId)))[0]!;
      const tokenNo = await allocateToken(tx, toSession.id);
      await tx.insert(opdQueueEntries).values({
        id: newId(), sessionId: toSession.id, encounterId: entry.encounterId, tokenNo, kind: entry.kind,
        appointmentAt: entry.appointmentAt, status: entry.status === "called" ? "waiting" : entry.status,
        danger: entry.danger, reEntry: entry.reEntry, perk: entry.perk, eligibleAt: entry.eligibleAt,
      });
      await tx
        .update(opdEncounters)
        .set({ doctorId: to.id, updatedBy: actor.id, updatedAt: now })
        .where(and(eq(opdEncounters.id, entry.encounterId), eq(opdEncounters.doctorId, from.id)));
      await appendEvent(tx, visitTransferred.make({
        actor, patientId: encounter.patientId, encounterId: encounter.id, correlationId: encounter.workflowInstanceId,
        payload: {
          encounterId: encounter.id, patientId: encounter.patientId, serviceDate: input.serviceDate,
          fromDoctorId: from.id, toDoctorId: to.id, fromSessionId: fromSession.id, toSessionId: toSession.id,
          roomId: toSession.roomId, tokenNo, consented: input.consented, reason: input.reason,
        },
      }));
      transferred++;
    }
    return { transferred, toSessionId: toSession.id };
  });
}

export async function getVisit(
  db: Db,
  actor: Actor,
  encounterId: string,
): Promise<{ encounter: EncounterRow; queueEntries: QueueEntryRow[]; vitals: VitalsRow[]; prescriptions: PrescriptionRow[] } | null> {
  // PLAN 07a T1 FOLLOW-UP — this route was the FOURTH instance of the same hole and the first fix
  // missed it. It returns the encounter's diagnosis and ICD-10 code AND the visit's vitals AND its
  // prescriptions; only the patient's NAME was protected, by `getPatientSummaries` aliasing it in
  // the controller. The clinical payload went to any holder of `opd.visits.read`. Same null a
  // missing encounter returns, so sealed and absent stay indistinguishable (07a DD2).
  const encounter = await getEncounter(db, encounterId);
  if (!encounter) return null;
  const visible = await getPatient(db, actor, encounter.patientId);
  if (visible === null) return null;
  await recordPhiAccess(db, {
    actor, patientId: visible.patient.id, surface: "opd.visit", encounterId,
    sealed: visible.patient.isConfidential, reason: visible.breakGlass?.reason ?? null,
  });
  const queueEntries = await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, encounterId)).orderBy(asc(opdQueueEntries.seq));
  const vitals = await db.select().from(opdVitals).where(eq(opdVitals.encounterId, encounterId)).orderBy(asc(opdVitals.recordedAt));
  const prescriptions = await db.select().from(opdPrescriptions).where(eq(opdPrescriptions.encounterId, encounterId)).orderBy(asc(opdPrescriptions.version));
  return { encounter, queueEntries, vitals, prescriptions };
}

/**
 * RC-4 CLOSE / pass 2 N2+N3 — WHAT THE COUNTER NEEDS TO KNOW ABOUT A VISIT IN HAND, AND NOTHING
 * THAT IS PHI. The seat polls this while a patient is in hand, so it must not be `getVisit`: that
 * route ships vitals, prescriptions and the diagnosis and writes a `phi_access_log` row per call —
 * four rows a minute per seat, for a screen that reads a token number. And it must not be "does an
 * invoice exist" (`GET /billing/invoices`): an entered-in-error fee invoice or a lab invoice is an
 * invoice and is not the fee covered. The predicate is `encounterFeeStatuses`, the ONE projection
 * the board reads too (D4), so the seat and the board cannot disagree about the money.
 */
export type CounterState = {
  encounterId: string;
  status: string;
  serviceDate: string;
  feeStatus: EncounterFeeStatus | null;
  /** Has the visit EVER had a queue entry? A deferred visit is `false` until the money joins it. */
  everJoined: boolean;
  /** The latest entry's token, whatever its state — the number the clerk reads out. */
  tokenNo: number | null;
};

/**
 * PLAN 16c T0a (part 2) — THE TOKEN DOOR, for a department counter that is handed a slip.
 *
 * "T-14" is what a patient says at the pharmacy window, and a token is a number on a QUEUE ENTRY,
 * not on an encounter: the same number recurs every day and can recur within a day across
 * sessions. So the read is scoped to the service date first (the visits of the day) and then to
 * the entry, latest `seq` first, so a re-entered visit answers with its current token. No PHI is
 * read here — the caller resolves the encounter through `getVisit`, which logs.
 */
export async function findVisitByToken(db: Db, filter: { serviceDate: string; tokenNo: number }): Promise<EncounterRow | null> {
  const visits = await listVisits(db, { serviceDate: filter.serviceDate });
  if (visits.length === 0) return null;
  const byId = new Map(visits.map((v) => [v.id, v]));
  const entries = await db.select({ encounterId: opdQueueEntries.encounterId, seq: opdQueueEntries.seq })
    .from(opdQueueEntries)
    .where(and(inArray(opdQueueEntries.encounterId, [...byId.keys()]), eq(opdQueueEntries.tokenNo, filter.tokenNo)))
    .orderBy(desc(opdQueueEntries.seq))
    .limit(1);
  const hit = entries[0];
  return hit === undefined ? null : (byId.get(hit.encounterId) ?? null);
}

export async function counterState(db: Db, encounterId: string): Promise<CounterState | null> {
  const encounter = await getEncounter(db, encounterId);
  if (!encounter) return null;
  const entries = await db.select({ tokenNo: opdQueueEntries.tokenNo, seq: opdQueueEntries.seq })
    .from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, encounterId)).orderBy(desc(opdQueueEntries.seq)).limit(1);
  const feeStatus = (await encounterFeeStatuses(db, [encounter])).get(encounter.id) ?? null;
  return {
    encounterId, status: encounter.status, serviceDate: encounter.serviceDate, feeStatus,
    everJoined: entries.length > 0, tokenNo: entries[0]?.tokenNo ?? null,
  };
}

export async function listVisits(
  db: Db,
  filter: { status?: OpdVisitState; departmentId?: string; doctorId?: string; serviceDate?: string },
  limit = 200,
): Promise<EncounterRow[]> {
  const clauses = [
    filter.status === undefined ? undefined : eq(opdEncounters.status, filter.status),
    filter.departmentId === undefined ? undefined : eq(opdEncounters.departmentId, filter.departmentId),
    filter.doctorId === undefined ? undefined : eq(opdEncounters.doctorId, filter.doctorId),
    filter.serviceDate === undefined ? undefined : eq(opdEncounters.serviceDate, filter.serviceDate),
  ].filter((c) => c !== undefined);
  return db.select().from(opdEncounters).where(clauses.length === 0 ? undefined : and(...clauses)).orderBy(asc(opdEncounters.openedAt)).limit(limit);
}

export type TimelineItem = {
  encounterId: string; serviceDate: string; openedAt: Date; status: string; visitType: string;
  doctorId: string | null; doctorName: string | null; departmentId: string | null; departmentName: string | null;
  diagnosis: string | null; icd10Code: string | null; prescriptionLineCount: number; dangerFlagged: boolean;
};

/**
 * The patient's OPD history, newest first, spanning the merge chain: encounters keep the patient_id they were opened
 * with and a merge never rewrites another module's rows (§6), so the chain is walked at read time.
 */
export async function patientTimeline(db: Db, actor: Actor, patientId: string, limit = 50): Promise<TimelineItem[]> {
  // PLAN 07a T1 — `getPatient`, NOT `resolvePatientId`. The latter is id mapping and says so
  // ("no gate"); using it here left a sealed patient's diagnoses and ICD-10 codes readable to any
  // holder of `opd.visits.read`, which `front_office` holds, while `GET /patients/:id` correctly
  // existence-hid the same person. The refusal below is the SAME `patient_not_found` an absent id
  // produces, so it cannot confirm existence (07a DD2).
  const visible = await getPatient(db, actor, patientId);
  if (!visible) throw new OpdError("patient_not_found", `unknown patient ${patientId}`);
  const canonical = visible.patient.id;
  // PLAN 07a T2 — the read happened; record who saw it. Successful reads only: a refusal produced
  // no PHI, and a row naming a patient the reader was refused would be a leak in the audit log.
  await recordPhiAccess(db, {
    actor, patientId: canonical, surface: "opd.timeline",
    sealed: visible.patient.isConfidential, reason: visible.breakGlass?.reason ?? null,
  });
  const chainIds = [canonical, ...(await listMergedLoserIds(db, canonical))];
  const rows = await db
    .select({ encounter: opdEncounters, doctorName: opdDoctors.displayName, departmentName: opdDepartments.name })
    .from(opdEncounters)
    .leftJoin(opdDoctors, eq(opdEncounters.doctorId, opdDoctors.id))
    .leftJoin(opdDepartments, eq(opdEncounters.departmentId, opdDepartments.id))
    .where(inArray(opdEncounters.patientId, chainIds))
    .orderBy(desc(opdEncounters.openedAt))
    .limit(limit);
  const encounterIds = rows.map((r) => r.encounter.id);
  const rx = encounterIds.length === 0
    ? []
    : await db
      .select({ encounterId: opdPrescriptions.encounterId, lines: opdPrescriptions.lines })
      .from(opdPrescriptions)
      .where(and(inArray(opdPrescriptions.encounterId, encounterIds), eq(opdPrescriptions.status, "active")));
  const lineCounts = new Map(rx.map((r) => [r.encounterId, Array.isArray(r.lines) ? r.lines.length : 0] as const));
  return rows.map((r) => ({
    encounterId: r.encounter.id, serviceDate: r.encounter.serviceDate, openedAt: r.encounter.openedAt,
    status: r.encounter.status, visitType: r.encounter.visitType,
    doctorId: r.encounter.doctorId, doctorName: r.doctorName,
    departmentId: r.encounter.departmentId, departmentName: r.departmentName,
    diagnosis: r.encounter.diagnosis, icd10Code: r.encounter.icd10Code,
    prescriptionLineCount: lineCounts.get(r.encounter.id) ?? 0, dangerFlagged: r.encounter.dangerFlagged,
  }));
}
