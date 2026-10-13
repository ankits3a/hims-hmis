import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { IPD_INTENTS, newId } from "@hmis/contracts";
import { istDayString } from "../../kernel/approvals/cumulative";
import { withTx } from "../../kernel/db/client";
import { ipdOrders } from "../../kernel/db/schema";
import { medicinesByIds } from "../formulary";
import { appendEvent } from "../../kernel/events/append";
import { orderTests, routeTests } from "../ordering";
import { lockAdmission, onceIpd, provenanceOf, readAdmission, requireIpdPermission } from "./admission-core";
import { IpdRefusal } from "./errors";
import { IPD_ORDER_PLACE } from "./permissions";
import { assertInBed } from "./rounds";
import { orderCancelled, orderPlaced, orderStopped } from "./rounds-events";
import { isConsultant, onTeam, treatingTeamOf } from "./rounds-team";
import type { Actor, IpdIntentName, IpdOrderDrugFacts, IpdOrderPlacedPayload } from "@hmis/contracts";
import type { z } from "zod";
import type { Db, Tx } from "../../kernel/db/client";
import type { OrderKindDecl } from "../../kernel/orders/kinds";

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
export type IpdOrderOpts = { now?: Date; orderKinds?: readonly OrderKindDecl[] };
export type IpdOrderRow = typeof ipdOrders.$inferSelect;

/** One line a person reads, e.g. "Ceftriaxone 1 g · IV · BD". */
export function medicineLabel(m: { brandName: string; strengthLabel: string | null }): string {
  return [m.brandName, m.strengthLabel].filter((s) => s !== null && s !== "").join(" ");
}

async function teamCheck(tx: Tx, a: Awaited<ReturnType<typeof readAdmission>>, actor: Actor, at: Date): Promise<"consultant" | "resident"> {
  assertInBed(a);
  const team = await treatingTeamOf(tx, a, at);
  if (!onTeam(team, actor.id)) throw new IpdRefusal("not_treating_team");
  return actor.type === "user" && await isConsultant(tx, actor.id) ? "consultant" : "resident";
}

export function drugFactsOf(o: IpdOrderRow): IpdOrderDrugFacts | null {
  if (o.kind !== "drug" || o.medicineId === null) return null;
  return {
    medicineId: o.medicineId, doseValue: o.doseValue ?? 0, doseUnit: o.doseUnit ?? "", route: o.route as IpdOrderDrugFacts["route"],
    frequency: o.frequency ?? "", startAt: (o.startAt ?? o.orderedAt).toISOString(), stopAt: o.stopAt?.toISOString() ?? null,
    durationDays: o.durationDays, antibiotic: o.antibiotic, prn: o.prn ?? null, weightBasedPerKg: o.weightBasedPerKg,
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
    return placeTests(db, actor, input, at, opts.orderKinds ?? []);
  }, at);
}

async function placeDrug(db: Db, actor: Actor, input: Input<"place_ip_order">, at: Date): Promise<Output<"place_ip_order">> {
  const d = input.drug;
  if (d === undefined) throw new IpdRefusal("medicine_not_found");
  const med = (await medicinesByIds(db, [d.itemId])).get(d.itemId);
  if (med === undefined || !med.active) throw new IpdRefusal("medicine_not_found", undefined, { medicineId: d.itemId });
  const antibiotic = d.antibiotic || med.awareCategory !== null;
  if (antibiotic && d.stopAt === undefined) throw new IpdRefusal("antibiotic_stop_date_required", undefined, { awareCategory: med.awareCategory });
  if (d.stopAt === undefined && d.durationDays === undefined) throw new IpdRefusal("duration_required");
  if (d.stopAt !== undefined && new Date(d.stopAt).getTime() <= new Date(d.startAt).getTime()) throw new IpdRefusal("duration_required", undefined, { stopBeforeStart: true });
  return withTx(db, async (tx) => {
    const a = await lockAdmission(tx, input.admissionId);
    const byKind = await teamCheck(tx, a, actor, at);
    const dup = (await tx.select({ id: ipdOrders.id }).from(ipdOrders).where(and(
      eq(ipdOrders.admissionId, a.id), eq(ipdOrders.status, "active"), eq(ipdOrders.medicineId, med.id), eq(ipdOrders.route, d.route),
    )))[0];
    if (dup !== undefined) throw new IpdRefusal("duplicate_order", undefined, { orderId: dup.id });
    const orderId = newId();
    const row = (await tx.insert(ipdOrders).values({
      id: orderId, admissionId: a.id, patientId: a.patientId, kind: "drug", status: "active", verification: "pending",
      medicineId: med.id, medicineName: medicineLabel(med), doseValue: d.dose.value, doseUnit: d.dose.unit, route: d.route,
      frequency: d.frequency, startAt: new Date(d.startAt), stopAt: d.stopAt === undefined ? null : new Date(d.stopAt),
      durationDays: d.durationDays ?? null, antibiotic, prn: d.prn ?? null, weightBasedPerKg: d.weightBasedPerKg ?? false,
      note: input.note ?? null, orderedBy: actor.id, orderedByKind: byKind, orderedAt: at, provenance: provenanceOf(actor),
    }).returning())[0]!;
    await emitPlaced(tx, actor, a.patientId, row, null);
    return { orderId, status: "pending_verify" as const, signBy: null };
  });
}

async function placeTests(
  db: Db, actor: Actor, input: Input<"place_ip_order">, at: Date, decls: readonly OrderKindDecl[],
): Promise<Output<"place_ip_order">> {
  const department = input.kind as "lab" | "imaging";
  const tests = input.tests;
  if (tests === undefined) throw new IpdRefusal("test_not_orderable", undefined, { reason: "no_tests" });
  // The checks a person can be told about, before any department is asked.
  const before = await readAdmission(db, input.admissionId);
  await withTx(db, (tx) => teamCheck(tx, before, actor, at));
  if (before.admissionNo === null) throw new IpdRefusal("admission_wrong_state", undefined, { state: before.state });
  const routed = await routeTests(db, tests.serviceIds);
  const mine = department === "lab" ? routed.lab : routed.imaging;
  const elsewhere = tests.serviceIds.filter((s) => !mine.includes(s));
  if (elsewhere.length > 0) throw new IpdRefusal("test_not_orderable", undefined, { reason: "not_this_department", serviceIds: elsewhere });

  const done = await orderTests(db, actor, decls, {
    patientId: before.patientId, encounterNo: before.admissionNo, serviceDate: istDayString(at), orderingClinicianId: actor.id,
    serviceIds: mine, indication: tests.indication, priority: tests.priority,
    departments: { lab: department === "lab", imaging: department === "imaging" },
  }, at);
  const skipped = done.skipped.find((s) => s.department === department);
  if (skipped !== undefined) throw new IpdRefusal("test_not_orderable", undefined, { reason: skipped.code, words: skipped.message });
  const departmentOrderId = (department === "lab" ? done.lab?.orderId : done.imaging?.orderId) ?? null;

  return withTx(db, async (tx) => {
    const a = await lockAdmission(tx, input.admissionId);
    const byKind = await teamCheck(tx, a, actor, at);
    const orderId = newId();
    const row = (await tx.insert(ipdOrders).values({
      id: orderId, admissionId: a.id, patientId: a.patientId, kind: department, status: "active", verification: null,
      serviceIds: mine, department, departmentOrderId, indication: tests.indication, note: input.note ?? null,
      orderedBy: actor.id, orderedByKind: byKind, orderedAt: at, provenance: provenanceOf(actor),
    }).returning())[0]!;
    await emitPlaced(tx, actor, a.patientId, row, null);
    return { orderId, status: "active" as const, signBy: null };
  });
}

async function emitPlaced(tx: Tx, actor: Actor, patientId: string, o: IpdOrderRow, roundId: string | null): Promise<void> {
  const payload: IpdOrderPlacedPayload = {
    orderId: o.id, admissionId: o.admissionId, kind: o.kind as IpdOrderPlacedPayload["kind"],
    status: o.kind === "drug" ? "pending_verify" : "active", orderedBy: o.orderedBy,
    orderedByKind: o.orderedByKind as "consultant" | "resident", placedAt: o.orderedAt.toISOString(), roundId,
    drug: drugFactsOf(o),
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
 * The eMAR stamps the FIRST issue of a drug order, in its own transaction (idempotent: a later issue keeps the first
 * instant; answers true only for that first stamp). From then on `cancel_ip_order` refuses `order_already_issued` and a stop owes the return.
 */
export async function markIpdOrderIssuedIn(tx: Tx, orderId: string, at: Date): Promise<boolean> {
  const done = await tx.update(ipdOrders).set({ issuedAt: at })
    .where(and(eq(ipdOrders.id, orderId), eq(ipdOrders.kind, "drug"), isNull(ipdOrders.issuedAt))).returning({ id: ipdOrders.id });
  return done.length > 0;
}
