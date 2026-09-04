import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { pharmacyDispenseLines, pharmacyDispenses } from "../../kernel/db/schema";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { withTx } from "../../kernel/db/client";
import { listMedicines } from "../formulary";
import { availableQty, itemsByIds, itemUomRows } from "../materials";
import { getPatient, getPatientSummaries, listAllergies } from "../patients";
import { dispenseQueued } from "./events";
import { PharmacyError } from "./errors";
import { getSaleItem } from "./sale-items";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { RxLine } from "../opd";
import type { UomRow } from "../materials";

export type DispenseRow = typeof pharmacyDispenses.$inferSelect;
export type DispenseLineRow = typeof pharmacyDispenseLines.$inferSelect;

/**
 * PLAN 16c D10 — THE QUEUE IS PHARMACY'S OWN ROW, and one live row per `(prescription, version)`.
 *
 * `enqueueDispense` is idempotent: the `prescription.issued` consumer and a first scan can both
 * ask, in either order, and the partial unique index (`pharmacy_dispenses_live_rx_ux`) is the
 * arbiter under a race — the loser's insert fails and it re-reads the winner. A NEWER version on
 * the same ENCOUNTER cancels the older version's still-QUEUED row (a re-issued Rx is a new
 * `opd_prescriptions` row, version + 1, and it supersedes; a dispense already claimed is left for
 * the pharmacist, who is told at verify by `prescription_superseded`).
 */
export async function enqueueDispense(
  tx: Tx,
  actor: Actor,
  input: { prescriptionId: string; prescriptionVersion: number; patientId: string; encounterId: string; source: "prescription_issued" | "scan" },
  now: Date,
): Promise<{ dispenseId: string; created: boolean }> {
  // A re-issue is a NEW `opd_prescriptions` row (version + 1) on the SAME encounter — supersession
  // is keyed by the encounter, and the (prescription, version) pair is what makes a row unique.
  const live = await tx.select({ id: pharmacyDispenses.id, prescriptionId: pharmacyDispenses.prescriptionId, version: pharmacyDispenses.prescriptionVersion, status: pharmacyDispenses.status })
    .from(pharmacyDispenses)
    .where(and(eq(pharmacyDispenses.encounterId, input.encounterId), sql`${pharmacyDispenses.status} <> 'cancelled'`));
  const same = live.find((r) => r.prescriptionId === input.prescriptionId && r.version === input.prescriptionVersion);
  if (same !== undefined) return { dispenseId: same.id, created: false };
  for (const older of live) {
    if (older.version < input.prescriptionVersion && older.status === "queued") {
      await tx.update(pharmacyDispenses)
        .set({ status: "cancelled", cancelledBy: actor.id, cancelledAt: now, cancelReason: `superseded by version ${String(input.prescriptionVersion)}` })
        .where(eq(pharmacyDispenses.id, older.id));
    }
  }
  const dispenseId = newId();
  await tx.insert(pharmacyDispenses).values({
    id: dispenseId, prescriptionId: input.prescriptionId, prescriptionVersion: input.prescriptionVersion,
    patientId: input.patientId, encounterId: input.encounterId, status: "queued", createdBy: actor.id, createdAt: now,
  });
  await appendEvent(tx, dispenseQueued.make({
    actor, patientId: input.patientId, encounterId: input.encounterId, correlationId: dispenseId,
    payload: {
      dispenseId, prescriptionId: input.prescriptionId, prescriptionVersion: input.prescriptionVersion,
      patientId: input.patientId, encounterId: input.encounterId, source: input.source,
    },
  }));
  return { dispenseId, created: true };
}

export async function getDispenseRow(db: Db | Tx, dispenseId: string): Promise<DispenseRow> {
  const rows = await db.select().from(pharmacyDispenses).where(eq(pharmacyDispenses.id, dispenseId));
  const row = rows[0];
  if (row === undefined) throw new PharmacyError("unknown_dispense", `dispense ${dispenseId} not found`);
  return row;
}

export async function linesOf(db: Db | Tx, dispenseId: string): Promise<DispenseLineRow[]> {
  return db.select().from(pharmacyDispenseLines).where(eq(pharmacyDispenseLines.dispenseId, dispenseId)).orderBy(asc(pharmacyDispenseLines.lineIdx));
}

export type QueueRow = {
  dispenseId: string;
  status: string;
  dispenseNo: string | null;
  scheduled: boolean;
  lineCount: number;
  createdAt: Date;
  claimedAt: Date | null;
  patient: { id: string; uhid: string; name: string | null; alias: string | null; restricted: boolean };
};

/** The counter's portal list: today's dispenses that are not finished, oldest first. Names are alias-safe. */
export async function listQueue(db: Db, actor: Actor, filter: { serviceDate: string }): Promise<QueueRow[]> {
  const rows = await db.select().from(pharmacyDispenses)
    .where(and(
      sql`(${pharmacyDispenses.createdAt} at time zone 'Asia/Kolkata')::date = ${filter.serviceDate}::date`,
      sql`${pharmacyDispenses.status} not in ('handed_over', 'cancelled')`,
    ))
    .orderBy(asc(pharmacyDispenses.createdAt));
  if (rows.length === 0) return [];
  const counts = await db.select({ dispenseId: pharmacyDispenseLines.dispenseId, n: sql<number>`count(*)::int` })
    .from(pharmacyDispenseLines)
    .where(inArray(pharmacyDispenseLines.dispenseId, rows.map((r) => r.id)))
    .groupBy(pharmacyDispenseLines.dispenseId);
  const countById = new Map(counts.map((c) => [c.dispenseId, c.n]));
  const summaries = await getPatientSummaries(db, actor, rows.map((r) => r.patientId));
  const byRequested = new Map(summaries.map((s) => [s.requestedId, s]));
  const out: QueueRow[] = [];
  for (const r of rows) {
    const s = byRequested.get(r.patientId);
    if (s === undefined) continue; // not visible to this actor — not on their list
    out.push({
      dispenseId: r.id, status: r.status, dispenseNo: r.dispenseNo, scheduled: r.scheduled,
      lineCount: countById.get(r.id) ?? 0, createdAt: r.createdAt, claimedAt: r.claimedAt,
      patient: { id: s.id, uhid: s.uhid, name: s.name, alias: s.alias, restricted: s.restricted },
    });
  }
  return out;
}

export type DispenseLineView = {
  lineIdx: number;
  rxLine: RxLine;
  status: string;
  declinedReason: string | null;
  substitutionType: string;
  qtyBase: number | null;
  scheduleFlag: string | null;
  orderedMedicine: { id: string; brandName: string; strengthLabel: string | null; form: string } | null;
  dispensedMedicine: { id: string; brandName: string; strengthLabel: string | null; form: string; scheduleFlag: string | null } | null;
  item: { id: string; code: string; name: string; baseUom: string; uoms: UomRow[] } | null;
  saleable: boolean;
  /** At the counter's store: on hand minus reserved minus frozen, in base units. `null` before the claim names a store. */
  available: number | null;
  batchId: string | null;
  reservationId: string | null;
  ledgerEntryId: string | null;
  orderItemId: string | null;
  invoiceLineId: string | null;
  unitPaise: number | null;
  priceWinner: string | null;
  fefoOverride: boolean;
  pickNote: string | null;
};

export type DispenseView = {
  id: string;
  status: string;
  dispenseNo: string | null;
  orderId: string | null;
  prescriptionId: string;
  prescriptionVersion: number;
  encounterId: string;
  storeResourceId: string | null;
  scheduled: boolean;
  invoiceId: string | null;
  identityConfirmedVia: string | null;
  claimedAt: Date | null;
  verifiedAt: Date | null;
  pickedAt: Date | null;
  billedAt: Date | null;
  handedOverAt: Date | null;
  cancelReason: string | null;
  patient: { id: string; uhid: string; name: string | null; alias: string | null; restricted: boolean };
  allergies: { substance: string; severity: string | null }[];
  lines: DispenseLineView[];
};

/**
 * ONE dispense, everything the counter shows about it. The patient is read through the alias
 * rules (`getPatientSummaries`); the Rx lines are PHI and the read is logged on the pharmacy's own
 * surface. An invisible patient gives the same `unknown_dispense` as a missing row.
 */
export async function getDispense(db: Db, actor: Actor, dispenseId: string): Promise<DispenseView> {
  const d = await getDispenseRow(db, dispenseId);
  const [summary] = await getPatientSummaries(db, actor, [d.patientId]);
  const visible = summary === undefined ? null : await getPatient(db, actor, d.patientId);
  if (summary === undefined || visible === null) throw new PharmacyError("unknown_dispense", `dispense ${dispenseId} not found`);
  await recordPhiAccess(db, {
    actor, patientId: d.patientId, surface: "pharmacy.dispense", encounterId: d.encounterId,
    sealed: visible.patient.isConfidential, reason: visible.breakGlass?.reason ?? null,
  });
  const lines = await linesOf(db, dispenseId);
  const medicineIds = [...new Set(lines.flatMap((l) => [l.orderedMedicineId, l.dispensedMedicineId]).filter((x): x is string => x !== null))];
  const medicines = medicineIds.length === 0 ? new Map() : new Map((await listMedicines(db)).filter((m) => medicineIds.includes(m.id)).map((m) => [m.id, m]));
  const itemIds = [...new Set(lines.map((l) => l.itemId).filter((x): x is string => x !== null))];
  const items = itemIds.length === 0 ? new Map() : await itemsByIds(db, itemIds);
  const allergies = await listAllergies(db, d.patientId);
  const views: DispenseLineView[] = [];
  for (const l of lines) {
    const om = l.orderedMedicineId === null ? undefined : medicines.get(l.orderedMedicineId);
    const dm = l.dispensedMedicineId === null ? undefined : medicines.get(l.dispensedMedicineId);
    const item = l.itemId === null ? undefined : items.get(l.itemId);
    let uoms: UomRow[] = [];
    let saleable = false;
    let available: number | null = null;
    if (item !== undefined) {
      uoms = await itemUomRows(db, item.id);
      const sale = await getSaleItem(db, item.id);
      saleable = sale !== undefined && sale.active;
      if (d.storeResourceId !== null) {
        // The number on the screen is the number the PICK will honour — same exclusions, one
        // definition (`availableQty`). Summing raw balances here counted recalled and EXPIRED
        // batches the pick refuses, so the counter could promise fifty and then refuse twenty.
        // A display read has no injected clock; "as of now" is exactly what a counter means.
        available = await availableQty(db, d.storeResourceId, item.id);
      }
    }
    views.push({
      lineIdx: l.lineIdx, rxLine: l.rxLine as RxLine, status: l.status, declinedReason: l.declinedReason,
      substitutionType: l.substitutionType, qtyBase: l.qtyBase, scheduleFlag: l.scheduleFlag,
      orderedMedicine: om === undefined ? null : { id: om.id, brandName: om.brandName, strengthLabel: om.strengthLabel, form: om.form },
      dispensedMedicine: dm === undefined ? null : { id: dm.id, brandName: dm.brandName, strengthLabel: dm.strengthLabel, form: dm.form, scheduleFlag: dm.scheduleFlag },
      item: item === undefined ? null : { id: item.id, code: item.code, name: item.name, baseUom: item.baseUom, uoms },
      saleable, available, batchId: l.batchId, reservationId: l.reservationId, ledgerEntryId: l.ledgerEntryId,
      orderItemId: l.orderItemId, invoiceLineId: l.invoiceLineId, unitPaise: l.unitPaise, priceWinner: l.priceWinner,
      fefoOverride: l.fefoOverride, pickNote: l.pickNote,
    });
  }
  return {
    id: d.id, status: d.status, dispenseNo: d.dispenseNo, orderId: d.orderId, prescriptionId: d.prescriptionId,
    prescriptionVersion: d.prescriptionVersion, encounterId: d.encounterId, storeResourceId: d.storeResourceId,
    scheduled: d.scheduled, invoiceId: d.invoiceId, identityConfirmedVia: d.identityConfirmedVia,
    claimedAt: d.claimedAt, verifiedAt: d.verifiedAt, pickedAt: d.pickedAt, billedAt: d.billedAt, handedOverAt: d.handedOverAt,
    cancelReason: d.cancelReason,
    patient: { id: summary.id, uhid: summary.uhid, name: summary.name, alias: summary.alias, restricted: summary.restricted },
    allergies: allergies.map((a) => ({ substance: a.substance, severity: (a as { severity?: string | null }).severity ?? null })),
    lines: views,
  };
}

/** The latest live dispense for a prescription, if any — what a scan resolves to before enqueueing. */
export async function liveDispenseFor(db: Db | Tx, prescriptionId: string, version: number): Promise<DispenseRow | undefined> {
  const rows = await db.select().from(pharmacyDispenses)
    .where(and(eq(pharmacyDispenses.prescriptionId, prescriptionId), eq(pharmacyDispenses.prescriptionVersion, version), sql`${pharmacyDispenses.status} <> 'cancelled'`))
    .orderBy(desc(pharmacyDispenses.createdAt)).limit(1);
  return rows[0];
}

export { withTx };
