import { Logger } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, lte, ne } from "drizzle-orm";
import {
  IPD_ACUITY_DEFAULT_POINTS, IPD_ACUITY_POINTS, IpdAssignNurseInputSchema, IpdCopyShiftMapInputSchema, IpdEndMyDutyInputSchema,
  IpdMoveFloatNurseInputSchema, IpdPublishShiftMapInputSchema, IpdSaveShiftMapInputSchema, IpdSetAcuityInputSchema, newId,
  patientsPerRnOf, ratioUnitOf, rnsNeededFor,
} from "@hmis/contracts";
import { raiseNoticeIn } from "../../kernel/alerts/notices";
import { istDayString } from "../../kernel/approvals/cumulative";
import { withTx } from "../../kernel/db/client";
import {
  ipdAdmissions, ipdBedStays, ipdNurseAssignments, ipdPatientAcuity, ipdWardRatioBreaches, ipdWardShiftMaps, ipdWardShiftStaff,
  resources,
} from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { actorHoldsAnyRole } from "../../kernel/workflow/roles";
import { withIdempotency } from "../billing";
import { holdsPermission, lockAdmission, provenanceOf, requireIpdPermission } from "./admission-core";
import { IpdBedAttributesSchema } from "./bed-attributes";
import { IpdError } from "./errors";
import { IPD_NURSING_STATES, nursingFallback, shiftOf } from "./nursing";
import {
  acuitySet, bedReassigned, dutyEnded, floatMoved, ratioBreached, shiftMapCarriedOver, shiftMapPublished,
} from "./nursing-events";
import { wardsWithBeds } from "./nursing-read";
import { IPD_ASSESSMENT_RECORD, IPD_NURSING_ASSIGN, IPD_NURSING_FLOAT } from "./permissions";
import type { Actor, IpdNurseShift, IpdRatioUnit, IpdShiftStaffKind } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * WM-1 (#982, decision 0089) — THE WARD'S NURSES: every occupied bed has one named registered nurse every minute.
 *
 * - A SHIFT MAP per (ward, IST date, nursing shift). The in-charge saves a draft (`saveShiftMap`, or `copyLastShiftMap`
 *   for "same as last shift") and publishes it (`publishShiftMap`): every bed occupied at that moment needs a row
 *   (`bed_unassigned`) and a row's nurse must be a registered nurse, never a student (`student_alone`); a student rides
 *   on a row beside her nurse. A publish later than 30 minutes before the shift is allowed and marked late.
 * - THE LIVE MAP of a ward now is the published or carried-over map of the shift `now` falls in. The minute sweep
 *   (`sweepWardShifts`) carries the previous live map over when nothing was published by shift start and tells the
 *   supervisor once; tells the in-charge once per occupied bed with no nurse per shift; and checks the ratio.
 * - `assignNurse` gives a bed to a nurse on the live map. A bed that has a nurse needs a reason (`reassign_reason_required`)
 *   and both nurses are told. The in-charge (`ipd.nursing.assign`) may assign any bed; a nurse may hand over her own.
 *   Rows are never edited in place: the live row gets `valid_to`, a new row carries the reason and who changed it.
 * - `endMyDuty` is refused `beds_still_assigned` while the nurse holds a bed on the live map. It records a sign-off on
 *   the map; it never touches the roster. A 12-hour duty spans two maps; this acts on the current one only.
 * - THE RATIO (decision 0089): registered nurses needed = one per ventilated patient + the rest at the ward's patients
 *   per nurse (`ratioUnitOf`, `patientsPerRnOf`; the day value for morning and evening, the night value at night). On
 *   duty = registered and float nurses on the live map who have not ended duty, plus an in-charge holding beds. A
 *   breach writes ONE row, ONE event and ONE supervisor notice per ward and shift, on publish, on assign and in the
 *   sweep. It never blocks anything, and admission and transfer code never calls it.
 * - `moveFloatNurse` (the supervisor, `ipd.nursing.float`) ends the nurse's place on her own ward's map for that shift
 *   (refused while she holds beds there) and adds her to the receiving ward's map as a float: she counts there.
 * - `setAcuity` records a patient's acuity (append-only); the latest record counts until a new one.
 *
 * DECIDED: candidates are the nurses the roster puts at the ward; with no roster answer, every active holder of the
 * nursing roles (shown as a warning on the screen). Registered = holds ward_nurse, ward_incharge, nursing_supervisor or
 * nursing_superintendent; a student holds student_nurse and none of those.
 */

const SWEEP_ACTOR: Actor = { type: "system", id: "ipd-ward-sweep" };
const sweepLog = new Logger("ipd.sweepWardShifts");
type Opts = { now?: Date };

export const RN_ROLES = ["ward_nurse", "ward_incharge", "nursing_supervisor", "nursing_superintendent"];
export const STUDENT_ROLES = ["student_nurse"];
const ON_DUTY_KINDS: readonly string[] = ["rn", "float"];
/** The publish deadline: this many minutes before the shift starts. */
export const IPD_SHIFT_PUBLISH_LEAD_MINUTES = 30;

// ═══════════════════════════════════════════ shifts ═══════════════════════════════════════════

export type ShiftSlot = { date: string; key: IpdNurseShift; startsAt: Date; endsAt: Date };

/** The nursing shift an instant falls in, with its IST date (the date it starts on). */
export function shiftSlotOf(at: Date): ShiftSlot {
  const s = shiftOf(at);
  return { date: istDayString(s.startsAt), key: s.key, startsAt: s.startsAt, endsAt: s.endsAt };
}

const START_HOUR: Record<IpdNurseShift, number> = { morning: 8, evening: 14, night: 20 };
const LENGTH_HOURS: Record<IpdNurseShift, number> = { morning: 6, evening: 6, night: 12 };

export function shiftSlot(date: string, key: IpdNurseShift): ShiftSlot {
  const startsAt = new Date(Date.parse(`${date}T00:00:00+05:30`) + START_HOUR[key] * 3_600_000);
  return { date, key, startsAt, endsAt: new Date(startsAt.getTime() + LENGTH_HOURS[key] * 3_600_000) };
}

export function previousSlot(s: ShiftSlot): ShiftSlot {
  return shiftSlotOf(new Date(s.startsAt.getTime() - 60_000));
}
export function nextSlot(s: ShiftSlot): ShiftSlot {
  return shiftSlotOf(s.endsAt);
}

// ═══════════════════════════════════════════ shared reads ═══════════════════════════════════════════

type MapRow = typeof ipdWardShiftMaps.$inferSelect;
type StaffRow = typeof ipdWardShiftStaff.$inferSelect;
type RowAssignment = typeof ipdNurseAssignments.$inferSelect;

export async function mapFor(db: Db | Tx, wardId: string, s: Pick<ShiftSlot, "date" | "key">): Promise<MapRow | undefined> {
  return (await db.select().from(ipdWardShiftMaps).where(and(
    eq(ipdWardShiftMaps.wardId, wardId), eq(ipdWardShiftMaps.shiftDate, s.date), eq(ipdWardShiftMaps.shift, s.key),
  )))[0];
}

/** The ward's live map for the shift `at` falls in: published or carried over, never a draft. */
export async function liveMapOf(db: Db | Tx, wardId: string, at: Date): Promise<MapRow | undefined> {
  const m = await mapFor(db, wardId, shiftSlotOf(at));
  return m === undefined || m.status === "draft" ? undefined : m;
}

/** Every live map of the shift `at` falls in, by ward. */
export async function liveMapsAt(db: Db | Tx, at: Date): Promise<Map<string, MapRow>> {
  const s = shiftSlotOf(at);
  const rows = await db.select().from(ipdWardShiftMaps).where(and(
    eq(ipdWardShiftMaps.shiftDate, s.date), eq(ipdWardShiftMaps.shift, s.key), ne(ipdWardShiftMaps.status, "draft"),
  ));
  return new Map(rows.map((m) => [m.wardId, m] as const));
}

export async function liveRowsOf(db: Db | Tx, mapIds: readonly string[]): Promise<RowAssignment[]> {
  if (mapIds.length === 0) return [];
  return db.select().from(ipdNurseAssignments).where(and(inArray(ipdNurseAssignments.mapId, [...mapIds]), isNull(ipdNurseAssignments.validTo)));
}

export async function staffOf(db: Db | Tx, mapIds: readonly string[]): Promise<StaffRow[]> {
  if (mapIds.length === 0) return [];
  return db.select().from(ipdWardShiftStaff).where(inArray(ipdWardShiftStaff.mapId, [...mapIds]));
}

type WardBed = { id: string; code: string; class: string };
type WardFacts = { ward: typeof resources.$inferSelect; beds: WardBed[] };

async function wardFacts(db: Db | Tx, wardId: string): Promise<WardFacts> {
  const ward = (await db.select().from(resources).where(eq(resources.id, wardId)))[0];
  if (ward === undefined || (ward.kind !== "ward" && ward.kind !== "hall")) throw new IpdError("ward_not_found", "no ward has this id", { wardId });
  const { beds } = await wardsWithBeds(db as Db);
  return {
    ward,
    beds: beds.filter((b) => b.wardId === wardId).map((b) => ({ id: b.id, code: b.code, class: IpdBedAttributesSchema.parse(b.attributes).class })),
  };
}

/** Occupied beds of the ward now: bed → admission (patients in a nursing state on an open stay). */
export async function occupantsOf(db: Db | Tx, bedIds: readonly string[]): Promise<Map<string, { admissionId: string; patientId: string }>> {
  if (bedIds.length === 0) return new Map();
  const rows = await db.select({ bedId: ipdBedStays.bedId, admissionId: ipdAdmissions.id, patientId: ipdAdmissions.patientId, state: ipdAdmissions.state })
    .from(ipdBedStays).innerJoin(ipdAdmissions, eq(ipdAdmissions.id, ipdBedStays.admissionId))
    .where(and(inArray(ipdBedStays.bedId, [...bedIds]), isNull(ipdBedStays.endedAt)));
  return new Map(rows.filter((r) => (IPD_NURSING_STATES as readonly string[]).includes(r.state)).map((r) => [r.bedId, { admissionId: r.admissionId, patientId: r.patientId }] as const));
}

export type AcuityNow = { level: keyof typeof IPD_ACUITY_POINTS | null; points: number; ventilated: boolean };
/** The latest acuity record of each admission at or before `at` (self-care, 1 point, when none). */
export async function acuityOf(db: Db | Tx, admissionIds: readonly string[], at: Date): Promise<Map<string, AcuityNow>> {
  const out = new Map<string, AcuityNow>();
  if (admissionIds.length === 0) return out;
  const rows = await db.select().from(ipdPatientAcuity)
    .where(and(inArray(ipdPatientAcuity.admissionId, [...admissionIds]), lte(ipdPatientAcuity.setAt, at)))
    .orderBy(desc(ipdPatientAcuity.setAt), desc(ipdPatientAcuity.id));
  for (const r of rows) {
    if (out.has(r.admissionId)) continue;
    const level = r.level as keyof typeof IPD_ACUITY_POINTS;
    out.set(r.admissionId, { level, points: IPD_ACUITY_POINTS[level], ventilated: r.ventilated });
  }
  for (const id of admissionIds) if (!out.has(id)) out.set(id, { level: null, points: IPD_ACUITY_DEFAULT_POINTS, ventilated: false });
  return out;
}

export type RatioFacts = {
  unit: IpdRatioUnit; night: boolean; patientsPerRn: number; patients: number; ventilated: number; rnsOnDuty: number; rnsNeeded: number; breach: boolean;
};

/** The ward's ratio for shift `slot` with the map's staff and rows, its patients now. */
export async function ratioFor(
  db: Db | Tx, w: WardFacts, slot: ShiftSlot, staff: readonly StaffRow[], rows: readonly RowAssignment[], at: Date,
): Promise<RatioFacts> {
  const occupants = await occupantsOf(db, w.beds.map((b) => b.id));
  const acuity = await acuityOf(db, [...occupants.values()].map((o) => o.admissionId), at);
  const ventilated = [...acuity.values()].filter((a) => a.ventilated).length;
  const holding = new Set(rows.map((r) => r.nurseId));
  const rnsOnDuty = staff.filter((s) => s.endedAt === null && (ON_DUTY_KINDS.includes(s.kind) || (s.kind === "incharge" && holding.has(s.userId)))).length;
  const unit = ratioUnitOf(w.ward.attributes, w.beds.map((b) => b.class));
  const night = slot.key === "night";
  const patientsPerRn = patientsPerRnOf(unit, night, w.ward.attributes.nurseRatio);
  const patients = occupants.size;
  const rnsNeeded = rnsNeededFor({ patients, ventilated, patientsPerRn });
  return { unit, night, patientsPerRn, patients, ventilated, rnsOnDuty, rnsNeeded, breach: rnsOnDuty < rnsNeeded };
}

// ═══════════════════════════════════════════ guards ═══════════════════════════════════════════

function once<T>(db: Db, actor: Actor, act: string, key: string, body: unknown, work: () => Promise<T>, now: Date): Promise<T> {
  return withIdempotency(db, { actorId: actor.id, route: `ipd:${act}`, key: key.toLowerCase() }, body, work, now);
}

async function isRn(tx: Db | Tx, userId: string): Promise<boolean> {
  return actorHoldsAnyRole(tx as Tx, userId, RN_ROLES);
}
async function isStudent(tx: Db | Tx, userId: string): Promise<boolean> {
  return !(await isRn(tx, userId)) && (await actorHoldsAnyRole(tx as Tx, userId, STUDENT_ROLES));
}

async function lockMap(tx: Tx, mapId: string): Promise<MapRow> {
  const m = (await tx.select().from(ipdWardShiftMaps).where(eq(ipdWardShiftMaps.id, mapId)).for("update"))[0];
  if (m === undefined) throw new IpdError("shift_map_not_found", "no shift map has this id", { mapId });
  return m;
}

// ═══════════════════════════════════════════ acuity ═══════════════════════════════════════════

export async function setAcuity(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ acuityId: string; points: number }> {
  const input = IpdSetAcuityInputSchema.parse(raw);
  await requireIpdPermission(db, actor, IPD_ASSESSMENT_RECORD);
  const at = opts.now ?? new Date();
  return once(db, actor, "set_acuity", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const a = await lockAdmission(tx, input.admissionId);
    if (!(IPD_NURSING_STATES as readonly string[]).includes(a.state)) {
      throw new IpdError("acuity_admission_not_on_ward", "the patient is not on a ward bed", { state: a.state });
    }
    const s = shiftSlotOf(at);
    const acuityId = newId();
    const ventilated = input.ventilated === true;
    await tx.insert(ipdPatientAcuity).values({
      id: acuityId, admissionId: a.id, patientId: a.patientId, shiftDate: s.date, shift: s.key, level: input.level, ventilated, setBy: actor.id, setAt: at,
    });
    await appendEvent(tx, acuitySet.make({
      payload: { acuityId, admissionId: a.id, shiftDate: s.date, shift: s.key, level: input.level, ventilated, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
    }));
    return { acuityId, points: IPD_ACUITY_POINTS[input.level] };
  }), at);
}

// ═══════════════════════════════════════════ the shift map ═══════════════════════════════════════════

type StaffIn = { userId: string; kind: IpdShiftStaffKind; pairedWithId?: string | undefined };
type BedIn = { bedId: string; nurseId: string; studentId?: string | undefined };

/** Validates and writes a draft's staff and rows, replacing what the draft held. */
async function writeDraft(tx: Tx, actor: Actor, w: WardFacts, slot: ShiftSlot, staff: readonly StaffIn[], beds: readonly BedIn[], at: Date, carriedFromId: string | null): Promise<string> {
  const onWard = new Set(w.beds.map((b) => b.id));
  const foreign = beds.filter((b) => !onWard.has(b.bedId)).map((b) => b.bedId);
  if (foreign.length > 0) throw new IpdError("bed_not_on_ward", "a bed on the map is not on this ward", { bedIds: foreign });
  const seen = new Set<string>();
  for (const s of staff) {
    if (seen.has(s.userId)) throw new IpdError("staff_not_eligible", "a person is on the map twice", { userId: s.userId });
    seen.add(s.userId);
    const ok = s.kind === "student" ? await isStudent(tx, s.userId) : await isRn(tx, s.userId);
    if (!ok) throw new IpdError("staff_not_eligible", s.kind === "student" ? "not a student nurse" : "not a registered nurse", { userId: s.userId, kind: s.kind });
  }
  const missing = beds.flatMap((b) => [b.nurseId, ...(b.studentId === undefined ? [] : [b.studentId])]).filter((u) => !seen.has(u));
  if (missing.length > 0) throw new IpdError("staff_not_eligible", "a bed's nurse is not on the map's staff", { userIds: [...new Set(missing)] });
  if (new Set(beds.map((b) => b.bedId)).size !== beds.length) throw new IpdError("bed_not_on_ward", "a bed is on the map twice", {});

  const existing = await mapFor(tx, w.ward.id, slot);
  let mapId: string;
  if (existing === undefined) {
    mapId = newId();
    await tx.insert(ipdWardShiftMaps).values({
      id: mapId, wardId: w.ward.id, shiftDate: slot.date, shift: slot.key, status: "draft", createdBy: actor.id, createdAt: at, updatedAt: at, carriedFromId,
    }).onConflictDoNothing();
    const again = await mapFor(tx, w.ward.id, slot);
    mapId = again!.id;
  } else mapId = existing.id;
  const m = await lockMap(tx, mapId);
  if (m.status !== "draft") throw new IpdError("shift_map_not_draft", "this shift's map is already live: change it bed by bed", { mapId, status: m.status });
  await tx.delete(ipdNurseAssignments).where(eq(ipdNurseAssignments.mapId, mapId));
  await tx.delete(ipdWardShiftStaff).where(eq(ipdWardShiftStaff.mapId, mapId));
  if (staff.length > 0) {
    await tx.insert(ipdWardShiftStaff).values(staff.map((s) => ({
      id: newId(), mapId, userId: s.userId, kind: s.kind, pairedWithId: s.pairedWithId ?? null,
      homeWardId: s.kind === "float" ? w.ward.id : null, addedBy: actor.id, addedAt: at,
    })));
  }
  if (beds.length > 0) {
    await tx.insert(ipdNurseAssignments).values(beds.map((b) => ({
      id: newId(), mapId, bedId: b.bedId, nurseId: b.nurseId, studentId: b.studentId ?? null, validFrom: at, changedBy: actor.id,
    })));
  }
  await tx.update(ipdWardShiftMaps).set({ updatedAt: at, ...(carriedFromId === null ? {} : { carriedFromId }) }).where(eq(ipdWardShiftMaps.id, mapId));
  return mapId;
}

export async function saveShiftMap(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ mapId: string; status: "draft" }> {
  const input = IpdSaveShiftMapInputSchema.parse(raw);
  await requireIpdPermission(db, actor, IPD_NURSING_ASSIGN);
  const at = opts.now ?? new Date();
  return once(db, actor, "save_shift_map", input.idempotencyKey, input, async () => {
    const w = await wardFacts(db, input.wardId);
    const mapId = await withTx(db, (tx) => writeDraft(tx, actor, w, shiftSlot(input.shiftDate, input.shift), input.staff, input.beds, at, null));
    return { mapId, status: "draft" as const };
  }, at);
}

/** "Same as last shift": a draft from the ward's latest live map before this shift (staff still on duty, live rows). */
export async function copyLastShiftMap(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ mapId: string; copiedFrom: string | null }> {
  const input = IpdCopyShiftMapInputSchema.parse(raw);
  await requireIpdPermission(db, actor, IPD_NURSING_ASSIGN);
  const at = opts.now ?? new Date();
  return once(db, actor, "copy_shift_map", input.idempotencyKey, input, async () => {
    const w = await wardFacts(db, input.wardId);
    const slot = shiftSlot(input.shiftDate, input.shift);
    const from = (await db.select().from(ipdWardShiftMaps).where(and(eq(ipdWardShiftMaps.wardId, w.ward.id), ne(ipdWardShiftMaps.status, "draft"))))
      .filter((m) => shiftSlot(m.shiftDate, m.shift as IpdNurseShift).startsAt < slot.startsAt)
      .sort((x, y) => shiftSlot(y.shiftDate, y.shift as IpdNurseShift).startsAt.getTime() - shiftSlot(x.shiftDate, x.shift as IpdNurseShift).startsAt.getTime())[0];
    const staff = from === undefined ? [] : (await staffOf(db, [from.id])).filter((s) => s.endedAt === null && s.kind !== "float");
    const kept = new Set(staff.map((s) => s.userId));
    const rows = from === undefined ? [] : (await liveRowsOf(db, [from.id])).filter((r) => kept.has(r.nurseId));
    const mapId = await withTx(db, (tx) => writeDraft(tx, actor, w, slot,
      staff.map((s) => ({ userId: s.userId, kind: s.kind as IpdShiftStaffKind, pairedWithId: s.pairedWithId ?? undefined })),
      rows.map((r) => ({ bedId: r.bedId, nurseId: r.nurseId, studentId: r.studentId !== null && kept.has(r.studentId) ? r.studentId : undefined })),
      at, from?.id ?? null));
    return { mapId, copiedFrom: from?.id ?? null };
  }, at);
}

export async function publishShiftMap(
  db: Db, actor: Actor, raw: unknown, opts: Opts = {},
): Promise<{ mapId: string; status: "published"; late: boolean; ratioBreach: boolean }> {
  const input = IpdPublishShiftMapInputSchema.parse(raw);
  await requireIpdPermission(db, actor, IPD_NURSING_ASSIGN);
  const at = opts.now ?? new Date();
  return once(db, actor, "publish_shift_map", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const m = await lockMap(tx, input.mapId);
    if (m.status !== "draft") throw new IpdError("shift_map_not_draft", "this shift's map is already live", { mapId: m.id, status: m.status });
    const w = await wardFacts(tx, m.wardId);
    const slot = shiftSlot(m.shiftDate, m.shift as IpdNurseShift);
    const staff = await staffOf(tx, [m.id]);
    const rows = await liveRowsOf(tx, [m.id]);
    const occupants = await occupantsOf(tx, w.beds.map((b) => b.id));
    const byBed = new Map(rows.map((r) => [r.bedId, r] as const));
    const unassigned = w.beds.filter((b) => occupants.has(b.id) && !byBed.has(b.id)).map((b) => b.id);
    if (unassigned.length > 0) throw new IpdError("bed_unassigned", "every occupied bed needs a registered nurse", { bedIds: unassigned });
    const kindOf = new Map(staff.map((s) => [s.userId, s.kind] as const));
    const alone = rows.filter((r) => kindOf.get(r.nurseId) === "student").map((r) => r.bedId);
    if (alone.length > 0) throw new IpdError("student_alone", "a student cannot be a bed's only nurse", { bedIds: alone });
    const badStudent = rows.filter((r) => r.studentId !== null && kindOf.get(r.studentId) !== "student").map((r) => r.bedId);
    if (badStudent.length > 0) throw new IpdError("staff_not_eligible", "a bed's student is not a student on the map", { bedIds: badStudent });
    for (const r of rows) {
      await tx.update(ipdNurseAssignments).set({ admissionId: occupants.get(r.bedId)?.admissionId ?? null, validFrom: at }).where(eq(ipdNurseAssignments.id, r.id));
    }
    const late = at.getTime() > slot.startsAt.getTime() - IPD_SHIFT_PUBLISH_LEAD_MINUTES * 60_000;
    await tx.update(ipdWardShiftMaps).set({ status: "published", publishedBy: actor.id, publishedAt: at, late, updatedAt: at }).where(eq(ipdWardShiftMaps.id, m.id));
    await appendEvent(tx, shiftMapPublished.make({
      payload: { mapId: m.id, wardId: m.wardId, shiftDate: m.shiftDate, shift: slot.key, beds: rows.length, late, provenance: provenanceOf(actor) },
      actor, correlationId: m.id, occurredAt: at,
    }));
    const ratio = await checkRatio(tx, actor, w, { ...m, status: "published" }, at);
    return { mapId: m.id, status: "published" as const, late, ratioBreach: ratio.breach };
  }), at);
}

// ═══════════════════════════════════════════ assign, end of duty, float ═══════════════════════════════════════════

export async function assignNurse(
  db: Db, actor: Actor, raw: unknown, opts: Opts = {},
): Promise<{ assignmentId: string; mapId: string; fromNurseId: string | null; ratioBreach: boolean }> {
  const input = IpdAssignNurseInputSchema.parse(raw);
  const at = opts.now ?? new Date();
  const inCharge = await holdsPermission(db, actor, IPD_NURSING_ASSIGN);
  return once(db, actor, "assign_nurse", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const wardId = (await wardsWithBeds(db)).beds.find((b) => b.id === input.bedId)?.wardId;
    if (wardId === undefined) throw new IpdError("bed_not_on_ward", "no ward bed has this id", { bedId: input.bedId });
    const live = await liveMapOf(tx, wardId, at);
    if (live === undefined) throw new IpdError("no_live_shift_map", "this ward has no published map for this shift", { wardId });
    const m = await lockMap(tx, live.id);
    const current = (await liveRowsOf(tx, [m.id])).find((r) => r.bedId === input.bedId);
    if (!inCharge && current?.nurseId !== actor.id) {
      throw new IpdError("ipd_forbidden", `this act needs the permission ${IPD_NURSING_ASSIGN}`, { permission: IPD_NURSING_ASSIGN });
    }
    if (current !== undefined && input.reason === undefined) throw new IpdError("reassign_reason_required", "a reassignment needs a reason", { bedId: input.bedId });
    const staff = await staffOf(tx, [m.id]);
    const row = staff.find((s) => s.userId === input.nurseId);
    if (row?.kind === "student" || (row === undefined && (await isStudent(tx, input.nurseId)))) {
      throw new IpdError("student_alone", "a student cannot be a bed's only nurse", { bedIds: [input.bedId] });
    }
    if (row !== undefined && row.endedAt !== null) throw new IpdError("staff_not_eligible", "this nurse has ended her duty", { userId: input.nurseId });
    const w = await wardFacts(tx, wardId);
    if (row === undefined) {
      if (!(await isRn(tx, input.nurseId))) throw new IpdError("staff_not_eligible", "not a registered nurse", { userId: input.nurseId });
      await tx.insert(ipdWardShiftStaff).values({ id: newId(), mapId: m.id, userId: input.nurseId, kind: "rn", addedBy: actor.id, addedAt: at });
    }
    if (input.studentId !== undefined && staff.find((s) => s.userId === input.studentId)?.kind !== "student") {
      throw new IpdError("staff_not_eligible", "the student is not a student on the map", { userId: input.studentId });
    }
    const occupant = (await occupantsOf(tx, [input.bedId])).get(input.bedId);
    if (current !== undefined) await tx.update(ipdNurseAssignments).set({ validTo: at }).where(eq(ipdNurseAssignments.id, current.id));
    const assignmentId = newId();
    await tx.insert(ipdNurseAssignments).values({
      id: assignmentId, mapId: m.id, bedId: input.bedId, admissionId: occupant?.admissionId ?? null, nurseId: input.nurseId,
      studentId: input.studentId ?? (current?.nurseId === input.nurseId ? current.studentId : null), validFrom: at, validTo: null,
      reason: input.reason ?? null, changedBy: actor.id,
    });
    const bed = w.beds.find((b) => b.id === input.bedId)!;
    if (current !== undefined && current.nurseId !== input.nurseId) {
      for (const userId of [current.nurseId, input.nurseId]) {
        await raiseNoticeIn(tx, {
          userId, kind: "ipd.bed_reassigned", title: userId === input.nurseId ? `Bed ${bed.code} is yours` : `Bed ${bed.code} handed over`,
          body: input.reason ?? "", refType: "ipd_bed", refId: input.bedId, sourceKey: `ipd.bed_reassigned:${assignmentId}`, at,
        });
      }
    }
    await appendEvent(tx, bedReassigned.make({
      payload: {
        mapId: m.id, bedId: input.bedId, admissionId: occupant?.admissionId ?? null, fromNurseId: current?.nurseId ?? null, toNurseId: input.nurseId,
        studentId: input.studentId ?? null, reason: input.reason ?? null, provenance: provenanceOf(actor),
      },
      actor, correlationId: m.id, ...(occupant === undefined ? {} : { patientId: occupant.patientId }), occurredAt: at,
    }));
    const ratio = await checkRatio(tx, actor, w, m, at);
    return { assignmentId, mapId: m.id, fromNurseId: current?.nurseId ?? null, ratioBreach: ratio.breach };
  }), at);
}

export async function endMyDuty(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ mapId: string; endedAt: string }> {
  const input = IpdEndMyDutyInputSchema.parse(raw);
  const at = opts.now ?? new Date();
  return once(db, actor, "end_my_duty", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const live = await liveMapOf(tx, input.wardId, at);
    if (live === undefined) throw new IpdError("no_live_shift_map", "this ward has no published map for this shift", { wardId: input.wardId });
    const m = await lockMap(tx, live.id);
    const me = (await staffOf(tx, [m.id])).find((s) => s.userId === actor.id && s.endedAt === null);
    if (me === undefined) throw new IpdError("not_on_shift", "you are not on this ward's map for this shift", { wardId: input.wardId });
    const held = (await liveRowsOf(tx, [m.id])).filter((r) => r.nurseId === actor.id).map((r) => r.bedId);
    if (held.length > 0) throw new IpdError("beds_still_assigned", "hand each bed to a named registered nurse first", { bedIds: held });
    await tx.update(ipdWardShiftStaff).set({ endedAt: at, endedReason: input.reason ?? null }).where(eq(ipdWardShiftStaff.id, me.id));
    // A student riding on beds leaves them; her nurse keeps them.
    for (const r of (await liveRowsOf(tx, [m.id])).filter((x) => x.studentId === actor.id)) {
      await tx.update(ipdNurseAssignments).set({ validTo: at }).where(eq(ipdNurseAssignments.id, r.id));
      await tx.insert(ipdNurseAssignments).values({ ...r, id: newId(), studentId: null, validFrom: at, validTo: null, reason: "student ended duty", changedBy: actor.id });
    }
    await appendEvent(tx, dutyEnded.make({
      payload: { mapId: m.id, wardId: m.wardId, userId: actor.id, provenance: provenanceOf(actor) }, actor, correlationId: m.id, occurredAt: at,
    }));
    return { mapId: m.id, endedAt: at.toISOString() };
  }), at);
}

export async function moveFloatNurse(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ mapId: string; fromWardId: string | null }> {
  const input = IpdMoveFloatNurseInputSchema.parse(raw);
  await requireIpdPermission(db, actor, IPD_NURSING_FLOAT);
  const at = opts.now ?? new Date();
  return once(db, actor, "move_float_nurse", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const slot = shiftSlot(input.shiftDate, input.shift);
    const target = await mapFor(tx, input.toWardId, slot);
    if (target === undefined) throw new IpdError("no_live_shift_map", "the receiving ward has no map for this shift", { wardId: input.toWardId });
    const m = await lockMap(tx, target.id);
    if (!(await isRn(tx, input.userId))) throw new IpdError("staff_not_eligible", "only a registered nurse floats", { userId: input.userId });
    const sameShift = await tx.select().from(ipdWardShiftMaps).where(and(eq(ipdWardShiftMaps.shiftDate, slot.date), eq(ipdWardShiftMaps.shift, slot.key)));
    const places = (await staffOf(tx, sameShift.map((x) => x.id))).filter((s) => s.userId === input.userId && s.endedAt === null);
    if (places.some((p) => p.mapId === m.id)) throw new IpdError("staff_not_eligible", "this nurse is already on that ward's map", { userId: input.userId });
    const from = places[0];
    const fromWardId = from === undefined ? null : sameShift.find((x) => x.id === from.mapId)!.wardId;
    if (from !== undefined) {
      const held = (await liveRowsOf(tx, [from.mapId])).filter((r) => r.nurseId === input.userId).map((r) => r.bedId);
      if (held.length > 0) throw new IpdError("beds_still_assigned", "hand her beds to a named registered nurse first", { bedIds: held });
      await tx.update(ipdWardShiftStaff).set({ endedAt: at, endedReason: `floated: ${input.reason}` }).where(eq(ipdWardShiftStaff.id, from.id));
    }
    await tx.insert(ipdWardShiftStaff).values({
      id: newId(), mapId: m.id, userId: input.userId, kind: "float", homeWardId: fromWardId ?? input.toWardId, reason: input.reason, addedBy: actor.id, addedAt: at,
    });
    await appendEvent(tx, floatMoved.make({
      payload: { userId: input.userId, fromWardId, toWardId: input.toWardId, shiftDate: slot.date, shift: slot.key, reason: input.reason, provenance: provenanceOf(actor) },
      actor, correlationId: m.id, occurredAt: at,
    }));
    if (m.status !== "draft") await checkRatio(tx, actor, await wardFacts(tx, input.toWardId), m, at);
    return { mapId: m.id, fromWardId };
  }), at);
}

// ═══════════════════════════════════════════ the ratio breach ═══════════════════════════════════════════

/**
 * Checks the live map `m`'s ward ratio. A breach with no row for (ward, date, shift) writes the row and the event; the
 * supervisor (the nursing fallback chain) is told once — `notified_at` is stamped only when a notice went out, so the
 * sweep retries a breach nobody was reached for. Never refuses anything.
 */
async function checkRatio(tx: Tx, actor: Actor, w: WardFacts, m: MapRow, at: Date): Promise<RatioFacts> {
  const slot = shiftSlot(m.shiftDate, m.shift as IpdNurseShift);
  const ratio = await ratioFor(tx, w, slot, await staffOf(tx, [m.id]), await liveRowsOf(tx, [m.id]), at);
  let row = (await tx.select().from(ipdWardRatioBreaches).where(and(
    eq(ipdWardRatioBreaches.wardId, w.ward.id), eq(ipdWardRatioBreaches.shiftDate, slot.date), eq(ipdWardRatioBreaches.shift, slot.key),
  )))[0];
  if (row === undefined && ratio.breach) {
    const id = newId();
    const inserted = await tx.insert(ipdWardRatioBreaches).values({
      id, wardId: w.ward.id, shiftDate: slot.date, shift: slot.key, mapId: m.id, unit: ratio.unit, patients: ratio.patients,
      ventilated: ratio.ventilated, rnsOnDuty: ratio.rnsOnDuty, rnsNeeded: ratio.rnsNeeded, raisedAt: at,
    }).onConflictDoNothing().returning();
    row = inserted[0];
    if (row !== undefined) {
      await appendEvent(tx, ratioBreached.make({
        payload: {
          breachId: id, wardId: w.ward.id, shiftDate: slot.date, shift: slot.key, unit: ratio.unit, patients: ratio.patients,
          ventilated: ratio.ventilated, rnsOnDuty: ratio.rnsOnDuty, rnsNeeded: ratio.rnsNeeded, provenance: provenanceOf(actor),
        },
        actor, correlationId: m.id, occurredAt: at,
      }));
    }
  }
  if (row !== undefined && row.notifiedAt === null) {
    let notified = 0;
    for (const userId of await nursingFallback(tx)) {
      if (await raiseNoticeIn(tx, {
        userId, kind: "ipd.ratio_breach", title: `${w.ward.name}: nurses short`,
        body: `${String(ratio.patients)} patients · ${String(ratio.rnsOnDuty)} of ${String(ratio.rnsNeeded)} nurses`,
        refType: "ward", refId: w.ward.id, sourceKey: `ipd.ratio_breach:${row.id}`, at,
      })) notified += 1;
    }
    if (notified > 0) await tx.update(ipdWardRatioBreaches).set({ notifiedAt: at }).where(eq(ipdWardRatioBreaches.id, row.id));
  }
  return ratio;
}

// ═══════════════════════════════════════════ the minute sweep ═══════════════════════════════════════════

export type WardSweepResult = { carriedOver: number; unassignedBeds: number; ratioBreaches: number; failed: number };

/**
 * The minute job's ward step, one transaction per ward, failures logged and counted. (1) No live map for the shift now
 * and a live map for the shift before: carried over (staff still on duty, live rows), the supervisor told once. (2)
 * Each occupied bed with no nurse on the live map: the map's in-charge and its publisher told once per bed, patient and
 * shift. (3) The ratio, as on publish (one breach per ward and shift; a breach nobody was told for is retried).
 */
export async function sweepWardShifts(db: Db, now: Date): Promise<WardSweepResult> {
  const out: WardSweepResult = { carriedOver: 0, unassignedBeds: 0, ratioBreaches: 0, failed: 0 };
  const slot = shiftSlotOf(now);
  const { wards } = await wardsWithBeds(db);
  for (const ward of wards) {
    try {
      await withTx(db, async (tx) => {
        let live = await mapFor(tx, ward.id, slot);
        const w = await wardFacts(tx, ward.id);
        if (live === undefined || live.status === "draft") {
          const before = await mapFor(tx, ward.id, previousSlot(slot));
          if (before === undefined || before.status === "draft") return;
          live = await carryOver(tx, w, slot, before, live, now);
          let notified = 0;
          for (const userId of await nursingFallback(tx)) {
            if (await raiseNoticeIn(tx, {
              userId, kind: "ipd.shift_map_carried", title: `${ward.name}: no nurse assignment published`,
              body: `Last shift's map carried over · ${slot.key}`, refType: "ward", refId: ward.id, sourceKey: `ipd.shift_map_carried:${live.id}`, at: now,
            })) notified += 1;
          }
          if (notified > 0) await tx.update(ipdWardShiftMaps).set({ supervisorToldAt: now }).where(eq(ipdWardShiftMaps.id, live.id));
          await appendEvent(tx, shiftMapCarriedOver.make({
            payload: { mapId: live.id, wardId: ward.id, shiftDate: slot.date, shift: slot.key, fromMapId: before.id, notified, provenance: "system" },
            actor: SWEEP_ACTOR, correlationId: live.id, occurredAt: now,
          }));
          out.carriedOver += 1;
        }
        const rows = await liveRowsOf(tx, [live.id]);
        const held = new Set(rows.map((r) => r.bedId));
        const occupants = await occupantsOf(tx, w.beds.map((b) => b.id));
        const staff = await staffOf(tx, [live.id]);
        const tell = [...new Set([
          ...staff.filter((s) => s.kind === "incharge" && s.endedAt === null).map((s) => s.userId),
          ...(live.publishedBy === null || live.publishedBy === SWEEP_ACTOR.id ? [] : [live.publishedBy]),
        ])];
        const recipients = tell.length > 0 ? tell : await nursingFallback(tx);
        for (const b of w.beds) {
          const o = occupants.get(b.id);
          if (o === undefined || held.has(b.id)) continue;
          let won = false;
          for (const userId of recipients) {
            if (await raiseNoticeIn(tx, {
              userId, kind: "ipd.bed_unassigned", title: `Bed ${b.code}: no nurse`, body: "Assign a nurse",
              refType: "ipd_bed", refId: b.id, sourceKey: `ipd.bed_unassigned:${live.id}:${b.id}:${o.admissionId}`, at: now,
            })) won = true;
          }
          if (won) out.unassignedBeds += 1;
        }
        const hadBreach = (await tx.select({ id: ipdWardRatioBreaches.id }).from(ipdWardRatioBreaches).where(and(
          eq(ipdWardRatioBreaches.wardId, ward.id), eq(ipdWardRatioBreaches.shiftDate, slot.date), eq(ipdWardRatioBreaches.shift, slot.key),
        ))).length > 0;
        const ratio = await checkRatio(tx, SWEEP_ACTOR, w, live, now);
        if (ratio.breach && !hadBreach) out.ratioBreaches += 1;
      });
    } catch (e) {
      out.failed += 1;
      sweepLog.error(`ward ${ward.id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

/** Writes the carried-over map for `slot` from `before` (replacing an unpublished draft's contents). */
async function carryOver(tx: Tx, w: WardFacts, slot: ShiftSlot, before: MapRow, draft: MapRow | undefined, now: Date): Promise<MapRow> {
  let mapId = draft?.id;
  if (mapId === undefined) {
    mapId = newId();
    await tx.insert(ipdWardShiftMaps).values({
      id: mapId, wardId: w.ward.id, shiftDate: slot.date, shift: slot.key, status: "draft", createdBy: SWEEP_ACTOR.id, createdAt: now, updatedAt: now,
    });
  }
  await lockMap(tx, mapId);
  await tx.delete(ipdNurseAssignments).where(eq(ipdNurseAssignments.mapId, mapId));
  await tx.delete(ipdWardShiftStaff).where(eq(ipdWardShiftStaff.mapId, mapId));
  const staff = (await staffOf(tx, [before.id])).filter((s) => s.endedAt === null);
  if (staff.length > 0) {
    await tx.insert(ipdWardShiftStaff).values(staff.map((s) => ({
      id: newId(), mapId: mapId!, userId: s.userId, kind: s.kind, pairedWithId: s.pairedWithId, homeWardId: s.homeWardId, reason: s.reason,
      addedBy: SWEEP_ACTOR.id, addedAt: now,
    })));
  }
  const kept = new Set(staff.map((s) => s.userId));
  const occupants = await occupantsOf(tx, w.beds.map((b) => b.id));
  const rows = (await liveRowsOf(tx, [before.id])).filter((r) => kept.has(r.nurseId));
  if (rows.length > 0) {
    await tx.insert(ipdNurseAssignments).values(rows.map((r) => ({
      id: newId(), mapId: mapId!, bedId: r.bedId, admissionId: occupants.get(r.bedId)?.admissionId ?? null, nurseId: r.nurseId,
      studentId: r.studentId !== null && kept.has(r.studentId) ? r.studentId : null, validFrom: now, changedBy: SWEEP_ACTOR.id,
    })));
  }
  await tx.update(ipdWardShiftMaps).set({
    status: "carried_over", publishedAt: now, publishedBy: SWEEP_ACTOR.id, carriedFromId: before.id, late: true, updatedAt: now,
  }).where(eq(ipdWardShiftMaps.id, mapId));
  return (await tx.select().from(ipdWardShiftMaps).where(eq(ipdWardShiftMaps.id, mapId)))[0]!;
}
