import { and, asc, eq, inArray } from "drizzle-orm";
import { IPD_INTENTS, newId } from "@hmis/contracts";
import { istDayString } from "../../kernel/approvals/cumulative";
import { withTx } from "../../kernel/db/client";
import { ipdOrders, ipdRounds } from "../../kernel/db/schema";
import { medicinesByIds, resolveDrugTexts, resolveMedicines } from "../formulary";
import { lastActiveVitals, matchAllergiesSaltAware } from "../opd";
import { getPatientSummaries, listAllergies } from "../patients";
import { ageInYears } from "./bed-rules";
import { IPD_SYSTEM_ACTOR } from "./beds";
import { appendEvent } from "../../kernel/events/append";
import { orderTests, routeTests } from "../ordering";
import { lockAdmission, onceIpd, provenanceOf, requireIpdPermission } from "./admission-core";
import { IpdRefusal } from "./errors";
import { IPD_ORDER_PLACE } from "./permissions";
import { assertInBed } from "./rounds";
import { orderCancelled, orderPlaced, orderStopped } from "./rounds-events";
import { isConsultant, onTeam, treatingTeamOf } from "./rounds-team";
import type { Actor, IpdIntentName, IpdOrderDrugFacts, IpdOrderPlacedPayload } from "@hmis/contracts";
import type { z } from "zod";
import type { Db, Tx } from "../../kernel/db/client";
import type { OrderKindDecl } from "../../kernel/orders/kinds";
import type { AdmissionRow } from "./admission-core";

/**
 * E4.2 (#734) — THE DOCTOR'S INPATIENT ORDERS (spec §4.5A; decision 0067 the ordering door; §4.6 the eMAR they feed).
 *
 * DRUG orders name a FORMULARY medicine (`formulary_medicines`, the same catalogue the OPD prescriber searches) with dose,
 * route, frequency, start and a course (days or a stop time). An ANTIBIOTIC — the prescriber's flag OR any medicine the
 * formulary classifies under WHO AWaRe (`aware_category`) — needs a stop time (`antibiotic_stop_date_required`; the table's
 * check refuses it too). A drug order is placed `pending` for the pharmacist: verification, allergy, interaction and dose
 * checks, issue and doses are the eMAR's (E4.3, DECIDED — the pharmacist's verify is where §4.6 puts those checks).
 *
 * LAB and IMAGING orders are NOT a second order path: they go through the ordering door (`orderTests`, decision 0067) with
 * the inpatient's IP number as the episode (the `IP` resolver, `registerIpdEncounterResolver`); the door asks the kernel
 * for `orders.place` and the department's own permission, and the department's refusal comes back as
 * `test_not_orderable` with its words. This row only records the order for the round page and the event.
 *
 * STATES: `active` → `stopped` (any time; after issue `return_owed` — the return and its credit are the pharmacy's) or
 * `cancelled` (before issue only, with a reason — "order placed for the wrong patient"). Verbal orders are the nurse's
 * act on the eMAR lane (`order_kind_not_here` here).
 */
type Input<N extends IpdIntentName> = z.infer<(typeof IPD_INTENTS)[N]["input"]>;
type Output<N extends IpdIntentName> = z.infer<(typeof IPD_INTENTS)[N]["output"]>;
/** `door` is the ordering door (`ordering` `routeTests` + `orderTests`); a suite may stand a stub in for it. */
export type IpdOrderDoor = { routeTests: typeof routeTests; orderTests: typeof orderTests };
export type IpdOrderOpts = { now?: Date; orderKinds?: readonly OrderKindDecl[]; door?: IpdOrderDoor };
export type IpdOrderRow = typeof ipdOrders.$inferSelect;

/** One line a person reads, e.g. "Ceftriaxone 1 g · IV · BD". */
export function medicineLabel(m: { brandName: string; strengthLabel: string | null }): string {
  return [m.brandName, m.strengthLabel].filter((s) => s !== null && s !== "").join(" ");
}

async function teamCheck(tx: Tx, a: AdmissionRow, actor: Actor, at: Date): Promise<"consultant" | "resident"> {
  assertInBed(a);
  const team = await treatingTeamOf(tx, a, at);
  if (!onTeam(team, actor.id)) throw new IpdRefusal("not_treating_team");
  return actor.type === "user" && await isConsultant(tx, actor.id, at) ? "consultant" : "resident";
}

export function drugFactsOf(o: IpdOrderRow): IpdOrderDrugFacts | null {
  if (o.kind !== "drug") return null;
  // The table's check makes these non-null on a drug row; a row that breaks it is a defect, never a 0 mg dose.
  if (o.medicineId === null || o.doseValue === null || o.doseUnit === null || o.route === null || o.frequency === null || o.startAt === null) {
    throw new Error(`ipd_orders ${o.id}: a drug order without its dose, route, frequency or start`);
  }
  return {
    medicineId: o.medicineId, doseValue: o.doseValue, doseUnit: o.doseUnit, route: o.route as IpdOrderDrugFacts["route"],
    frequency: o.frequency, startAt: o.startAt.toISOString(), stopAt: o.stopAt?.toISOString() ?? null,
    durationDays: o.durationDays, antibiotic: o.antibiotic, prn: o.prn ?? null, weightBasedPerKg: o.weightBasedPerKg, weightKg: o.weightKg,
  };
}

export async function placeIpOrder(db: Db, actor: Actor, raw: unknown, opts: IpdOrderOpts = {}): Promise<Output<"place_ip_order">> {
  const input: Input<"place_ip_order"> = IPD_INTENTS.place_ip_order.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_ORDER_PLACE);
  const at = opts.now ?? new Date();
  if (input.verbal !== undefined || !["drug", "lab", "imaging"].includes(input.kind)) {
    throw new IpdRefusal("order_kind_not_here", undefined, { kind: input.verbal !== undefined ? "verbal" : input.kind });
  }
  return onceIpd(db, actor, "place_ip_order", input.idempotencyKey, input, async () => {
    if (input.kind === "drug") return placeDrug(db, actor, input, at);
    return placeTests(db, actor, input, at, opts.orderKinds ?? [], opts.door ?? { routeTests, orderTests });
  }, at);
}

/** E4.2 review: the latest recorded weight is good for 30 days (DECIDED); a child's dose is always weight-based. */
export const WEIGHT_VALID_DAYS = 30;
export const CHILD_WEIGHT_AGE_YEARS = 16;
/** E4.2 review ($ no; clinical DECIDED): an antibiotic course over 14 days needs a reason. */
export const ANTIBIOTIC_COURSE_DAYS = 14;

const MASS_MG: Record<string, number> = { mg: 1, g: 1000, mcg: 0.001 };
const COUNT_UNITS = new Set(["tab", "cap", "drop", "puff", "sachet", "amp", "vial", "respule"]);
const VOLUME_UNITS = new Set(["ml", "tsp"]);
const UNITS_UNITS = new Set(["unit", "iu"]);

/** One dose's ceiling by unit family (DECIDED, gross-error guard; the pharmacist checks the dose itself). */
function doseInRange(value: number, unit: string, perKg: boolean): boolean {
  if (MASS_MG[unit] !== undefined) return value * MASS_MG[unit]! <= (perKg ? 1_000 : 20_000);
  if (VOLUME_UNITS.has(unit)) return value <= (unit === "tsp" ? 20 : 2_000);
  if (UNITS_UNITS.has(unit)) return value <= 1_000_000;
  return value <= 20;
}

/** The dose unit's family must be one the medicine's strength names (mass, IU); counts and volumes always fit. */
function unitFitsStrength(unit: string, strengthLabel: string | null): boolean {
  if (strengthLabel === null || strengthLabel.trim() === "") return true;
  const s = strengthLabel.toLowerCase();
  if (MASS_MG[unit] !== undefined) return /\d\s*(mg|g|mcg|µg)\b/.test(s);
  if (UNITS_UNITS.has(unit)) return /\b(iu|units?)\b/.test(s);
  return COUNT_UNITS.has(unit) || VOLUME_UNITS.has(unit);
}

/** A topical product goes on topically; a systemic one never "topical". */
function routeFits(route: string, routeClass: string): boolean {
  if (routeClass === "topical") return route === "topical" || route === "other";
  return route !== "topical";
}

async function placeDrug(db: Db, actor: Actor, input: Input<"place_ip_order">, at: Date): Promise<Output<"place_ip_order">> {
  const d = input.drug;
  if (d === undefined) throw new IpdRefusal("medicine_not_found");
  const med = (await medicinesByIds(db, [d.itemId])).get(d.itemId);
  if (med === undefined || !med.active) throw new IpdRefusal("medicine_not_found", undefined, { medicineId: d.itemId });
  const perKg = d.weightBasedPerKg ?? false;
  if (!doseInRange(d.dose.value, d.dose.unit, perKg)) throw new IpdRefusal("dose_out_of_range", undefined, { value: d.dose.value, unit: d.dose.unit });
  if (!unitFitsStrength(d.dose.unit, med.strengthLabel)) throw new IpdRefusal("dose_unit_mismatch", undefined, { unit: d.dose.unit, strength: med.strengthLabel });
  if (!routeFits(d.route, med.routeClass)) throw new IpdRefusal("route_mismatch", undefined, { route: d.route, routeClass: med.routeClass });
  if ((d.frequency === "SOS") !== (d.prn !== undefined)) throw new IpdRefusal("prn_mismatch", undefined, { frequency: d.frequency });
  const antibiotic = d.antibiotic || med.awareCategory !== null;
  if (antibiotic && d.stopAt === undefined) throw new IpdRefusal("antibiotic_stop_date_required", undefined, { awareCategory: med.awareCategory });
  if (d.stopAt === undefined && d.durationDays === undefined) throw new IpdRefusal("duration_required");
  const startAt = new Date(d.startAt);
  const stopAt = d.stopAt === undefined ? null : new Date(d.stopAt);
  if (stopAt !== null && stopAt.getTime() <= at.getTime()) throw new IpdRefusal("stop_date_past");
  if (stopAt !== null && stopAt.getTime() <= startAt.getTime()) throw new IpdRefusal("duration_required", undefined, { stopBeforeStart: true });
  if (antibiotic && d.longCourseReason === undefined) {
    const days = stopAt !== null ? (stopAt.getTime() - startAt.getTime()) / 86_400_000 : (d.durationDays ?? 0);
    if (days > ANTIBIOTIC_COURSE_DAYS) throw new IpdRefusal("course_too_long", undefined, { days: Math.ceil(days) });
  }
  return withTx(db, async (tx) => {
    const a = await lockAdmission(tx, input.admissionId);
    const byKind = await teamCheck(tx, a, actor, at);
    const roundId = await roundOf(tx, a.id, input.roundId);
    // Weight: typed, else the latest recorded (30 days). A weight-based dose and every child (< 16) need one.
    const patient = (await getPatientSummaries(db, IPD_SYSTEM_ACTOR, [a.patientId]))[0];
    const age = patient?.dob == null ? null : ageInYears(patient.dob, at);
    let weightKg = d.weightKg ?? null;
    if (weightKg === null) {
      const v = await lastActiveVitals(tx, a.patientId);
      if (v?.weightKg != null && at.getTime() - v.recordedAt.getTime() <= WEIGHT_VALID_DAYS * 86_400_000) weightKg = v.weightKg;
    }
    if ((perKg || (age !== null && age < CHILD_WEIGHT_AGE_YEARS)) && weightKg === null) throw new IpdRefusal("weight_required", undefined, { child: age !== null && age < CHILD_WEIGHT_AGE_YEARS });
    // CPOE allergy check (DECIDED): the OPD prescription's salt-aware matcher against the patient's active allergies.
    const conflicts = await allergyConflicts(db, a.patientId, med.id, medicineLabel(med));
    if (conflicts.length > 0 && d.allergyOverrideReason === undefined) throw new IpdRefusal("allergy_conflict", undefined, { substances: conflicts });
    const dup = (await tx.select({ id: ipdOrders.id }).from(ipdOrders).where(and(
      eq(ipdOrders.admissionId, a.id), eq(ipdOrders.status, "active"), eq(ipdOrders.medicineId, med.id), eq(ipdOrders.route, d.route),
    )))[0];
    if (dup !== undefined) throw new IpdRefusal("duplicate_order", undefined, { orderId: dup.id });
    const orderId = newId();
    const row = (await tx.insert(ipdOrders).values({
      id: orderId, admissionId: a.id, patientId: a.patientId, kind: "drug", status: "active", verification: "pending",
      medicineId: med.id, medicineName: medicineLabel(med), doseValue: d.dose.value, doseUnit: d.dose.unit, route: d.route,
      frequency: d.frequency, startAt, stopAt, durationDays: d.durationDays ?? null, antibiotic, prn: d.prn ?? null,
      weightBasedPerKg: perKg, weightKg, allergyOverrideReason: conflicts.length > 0 ? d.allergyOverrideReason ?? null : null,
      longCourseReason: d.longCourseReason ?? null, note: input.note ?? null, orderedBy: actor.id, orderedByKind: byKind, orderedAt: at,
      roundId, provenance: provenanceOf(actor),
    }).returning())[0]!;
    await emitPlaced(tx, actor, a.patientId, row, roundId);
    return { orderId, status: "pending_verify" as const, signBy: null };
  });
}

/** The patient's active allergies this medicine conflicts with (substance words), by the OPD prescription's matcher. */
async function allergyConflicts(db: Db, patientId: string, medicineId: string, label: string): Promise<string[]> {
  const active = (await listAllergies(db, patientId)).filter((x) => x.status === "active");
  if (active.length === 0) return [];
  const resolution = (await resolveMedicines(db, [medicineId])).get(medicineId) ?? null;
  const texts = await resolveDrugTexts(db, active.map((x) => x.substance));
  const matches = matchAllergiesSaltAware([{ lineIndex: 0, drug: label, resolution }], active.map((x) => ({
    substance: x.substance, resolution: texts.get(x.substance) ?? null, allergenClass: x.allergenClass,
  })));
  return [...new Set(matches.map((m) => m.substance))];
}

/** A round named on an order must be this admission's. */
async function roundOf(tx: Tx, admissionId: string, roundId: string | undefined): Promise<string | null> {
  if (roundId === undefined) return null;
  const r = (await tx.select({ id: ipdRounds.id }).from(ipdRounds).where(and(eq(ipdRounds.id, roundId), eq(ipdRounds.admissionId, admissionId))))[0];
  if (r === undefined) throw new IpdRefusal("round_not_found", undefined, { roundId });
  return r.id;
}

/**
 * LAB / IMAGING — review of 72f10b68: never an orphan, never twice. Everything runs in ONE transaction under the admission
 * lock: an `ipd_orders` row with this act's idempotency key is looked for first (a retry answers it and asks no
 * department); the LAB order is placed inside this transaction (the door's `tx`, a savepoint), so the lab order and this
 * row commit together or not at all; the IMAGING order carries radiology's own idempotency key (`ipd:<key>`), so a retry
 * after a failure here replays the first study instead of booking a second. The unique key index settles a race.
 */
async function placeTests(
  db: Db, actor: Actor, input: Input<"place_ip_order">, at: Date, decls: readonly OrderKindDecl[], door: IpdOrderDoor,
): Promise<Output<"place_ip_order">> {
  const department = input.kind as "lab" | "imaging";
  const tests = input.tests;
  if (tests === undefined) throw new IpdRefusal("test_not_orderable", undefined, { reason: "no_tests" });
  const key = input.idempotencyKey.toLowerCase();
  return withTx(db, async (tx) => {
    const a = await lockAdmission(tx, input.admissionId);
    const already = (await tx.select().from(ipdOrders).where(eq(ipdOrders.idempotencyKey, key)))[0];
    if (already !== undefined) return { orderId: already.id, status: "active" as const, signBy: null };
    const byKind = await teamCheck(tx, a, actor, at);
    if (a.admissionNo === null) throw new IpdRefusal("admission_wrong_state", undefined, { state: a.state });
    const roundId = await roundOf(tx, a.id, input.roundId);
    const routed = await door.routeTests(tx, tests.serviceIds);
    const mine = department === "lab" ? routed.lab : routed.imaging;
    const elsewhere = tests.serviceIds.filter((s) => !mine.includes(s));
    if (elsewhere.length > 0) throw new IpdRefusal("test_not_orderable", undefined, { reason: "not_this_department", serviceIds: elsewhere });
    const done = await door.orderTests(db, actor, decls, {
      patientId: a.patientId, encounterNo: a.admissionNo, serviceDate: istDayString(at), orderingClinicianId: actor.id,
      serviceIds: mine, indication: tests.indication, priority: tests.priority,
      departments: { lab: department === "lab", imaging: department === "imaging" },
    }, at, { tx, imagingKey: `ipd:${key}` });
    const skipped = done.skipped.find((s) => s.department === department);
    if (skipped !== undefined) throw new IpdRefusal("test_not_orderable", undefined, { reason: skipped.code, words: skipped.message });
    const departmentOrderId = (department === "lab" ? done.lab?.orderId : done.imaging?.orderId) ?? null;
    const orderId = newId();
    const row = (await tx.insert(ipdOrders).values({
      id: orderId, admissionId: a.id, patientId: a.patientId, kind: department, status: "active", verification: null,
      serviceIds: mine, department, departmentOrderId, indication: tests.indication, note: input.note ?? null, idempotencyKey: key,
      orderedBy: actor.id, orderedByKind: byKind, orderedAt: at, roundId, provenance: provenanceOf(actor),
    }).returning())[0]!;
    await emitPlaced(tx, actor, a.patientId, row, roundId);
    return { orderId, status: "active" as const, signBy: null };
  });
}

async function emitPlaced(tx: Tx, actor: Actor, patientId: string, o: IpdOrderRow, roundId: string | null): Promise<void> {
  const payload: IpdOrderPlacedPayload = {
    orderId: o.id, admissionId: o.admissionId, kind: o.kind as IpdOrderPlacedPayload["kind"],
    status: o.kind === "drug" ? "pending_verify" : "active", orderedBy: o.orderedBy,
    orderedByKind: o.orderedByKind as "consultant" | "resident", placedAt: o.orderedAt.toISOString(), roundId,
    drug: drugFactsOf(o),
    allergyOverride: o.allergyOverrideReason !== null,
    tests: o.kind === "drug" ? null : { department: o.department as "lab" | "imaging", serviceIds: o.serviceIds ?? [], departmentOrderId: o.departmentOrderId },
    provenance: provenanceOf(actor),
  };
  await appendEvent(tx, orderPlaced.make({
    payload, actor, correlationId: o.admissionId, patientId, encounterId: o.admissionId, occurredAt: o.orderedAt,
  }));
}

async function lockOrder(tx: Tx, orderId: string): Promise<{ o: IpdOrderRow; a: Awaited<ReturnType<typeof lockAdmission>> }> {
  const first = (await tx.select().from(ipdOrders).where(eq(ipdOrders.id, orderId)))[0];
  if (first === undefined) throw new IpdRefusal("order_not_found");
  const a = await lockAdmission(tx, first.admissionId);
  const o = (await tx.select().from(ipdOrders).where(eq(ipdOrders.id, orderId)).for("update"))[0]!;
  return { o, a };
}

/** Stop: any active order; after issue the return and credit are owed to the pharmacy (eMAR finishes them). */
export async function stopIpOrder(db: Db, actor: Actor, raw: unknown, opts: Pick<IpdOrderOpts, "now"> = {}): Promise<Output<"stop_ip_order">> {
  const input: Input<"stop_ip_order"> = IPD_INTENTS.stop_ip_order.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_ORDER_PLACE);
  const at = opts.now ?? new Date();
  return onceIpd(db, actor, "stop_ip_order", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const { o, a } = await lockOrder(tx, input.orderId);
    // A lab or imaging order belongs to its department once placed: the lab / imaging desk cancels it there.
    if (o.kind !== "drug") throw new IpdRefusal("order_kind_not_here", undefined, { kind: o.kind });
    if (o.status !== "active") throw new IpdRefusal("order_not_active", undefined, { status: o.status });
    const team = await treatingTeamOf(tx, a, at);
    if (!onTeam(team, actor.id)) throw new IpdRefusal("not_treating_team");
    const returnOwed = o.issuedAt !== null;
    await tx.update(ipdOrders).set({ status: "stopped", stoppedAt: at, stoppedBy: actor.id, stopReason: input.reason, returnOwed })
      .where(eq(ipdOrders.id, o.id));
    await appendEvent(tx, orderStopped.make({
      payload: { orderId: o.id, admissionId: a.id, kind: o.kind as "drug", stoppedAt: at.toISOString(), afterIssue: returnOwed, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, encounterId: a.id, occurredAt: at,
    }));
    return { orderId: o.id, status: "stopped" as const, stoppedAt: at.toISOString(), returnOwed };
  }), at);
}

/** Cancel with a reason, before issue only (a wrong order); after issue it is stopped instead. */
export async function cancelIpOrder(db: Db, actor: Actor, raw: unknown, opts: Pick<IpdOrderOpts, "now"> = {}): Promise<Output<"cancel_ip_order">> {
  const input: Input<"cancel_ip_order"> = IPD_INTENTS.cancel_ip_order.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_ORDER_PLACE);
  const at = opts.now ?? new Date();
  return onceIpd(db, actor, "cancel_ip_order", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const { o, a } = await lockOrder(tx, input.orderId);
    // A lab or imaging order belongs to its department once placed: the lab / imaging desk cancels it there.
    if (o.kind !== "drug") throw new IpdRefusal("order_kind_not_here", undefined, { kind: o.kind });
    if (o.status !== "active") throw new IpdRefusal("order_not_active", undefined, { status: o.status });
    if (o.issuedAt !== null) throw new IpdRefusal("order_already_issued", undefined, { issuedAt: o.issuedAt.toISOString() });
    const team = await treatingTeamOf(tx, a, at);
    if (!onTeam(team, actor.id)) throw new IpdRefusal("not_treating_team");
    await tx.update(ipdOrders).set({ status: "cancelled", cancelledAt: at, cancelledBy: actor.id, cancelReason: input.reason })
      .where(eq(ipdOrders.id, o.id));
    await appendEvent(tx, orderCancelled.make({
      payload: { orderId: o.id, admissionId: a.id, kind: o.kind as "drug", cancelledAt: at.toISOString(), provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, encounterId: a.id, occurredAt: at,
    }));
    return { orderId: o.id, status: "cancelled" as const, cancelledAt: at.toISOString() };
  }), at);
}

// ═══════════════════════════════════════ the eMAR's seams (E4.3) ═══════════════════════════════════════

/** One order as stored (the eMAR re-reads it on `ipd.order.placed`). */
export async function readIpdOrder(exec: Db | Tx, orderId: string): Promise<IpdOrderRow | null> {
  return (await (exec as Db).select().from(ipdOrders).where(eq(ipdOrders.id, orderId)))[0] ?? null;
}

/** An admission's ACTIVE orders, oldest first (the MAR's input; the summary's "medicines on active orders"). */
export async function activeIpdOrdersOf(exec: Db | Tx, admissionId: string, kinds: readonly string[] = ["drug", "lab", "imaging"]): Promise<IpdOrderRow[]> {
  return (exec as Db).select().from(ipdOrders)
    .where(and(eq(ipdOrders.admissionId, admissionId), eq(ipdOrders.status, "active"), inArray(ipdOrders.kind, [...kinds])))
    .orderBy(asc(ipdOrders.orderedAt), asc(ipdOrders.id));
}

/**
 * The eMAR stamps the FIRST issue of a drug order, in its own transaction. Answers (review of 72f10b68):
 * `issued` — this call stamped it; `already_issued` — an earlier issue stands (idempotent: the first instant is kept);
 * `not_active` — the order is stopped or cancelled, nothing is stamped; `not_found` — no drug order has this id.
 * From `issued` on, `cancel_ip_order` refuses `order_already_issued` and a stop owes the return.
 */
export type IpdOrderIssueStamp = "issued" | "already_issued" | "not_active" | "not_found";
export async function markIpdOrderIssuedIn(tx: Tx, orderId: string, at: Date): Promise<IpdOrderIssueStamp> {
  const o = (await tx.select().from(ipdOrders).where(and(eq(ipdOrders.id, orderId), eq(ipdOrders.kind, "drug"))).for("update"))[0];
  if (o === undefined) return "not_found";
  if (o.issuedAt !== null) return "already_issued";
  if (o.status !== "active") return "not_active";
  await tx.update(ipdOrders).set({ issuedAt: at }).where(eq(ipdOrders.id, o.id));
  return "issued";
}
