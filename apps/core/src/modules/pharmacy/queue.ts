import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { nextEpisodeNo } from "../../kernel/episodes/series";
import { opdPrescriptions, pharmacyDispenseLines, pharmacyDispenses, users } from "../../kernel/db/schema";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { withTx } from "../../kernel/db/client";
import { medicinesByIds, unreviewedSaltIds } from "../formulary";
import { availableQty, getBatch, itemsByIds, itemUomRows, sellableBatchesByItem } from "../materials";
import { getPatient, getPatientSummaries, listAllergies } from "../patients";
import { istDateOf } from "./config";
import { dispenseQueued } from "./events";
import { PharmacyError } from "./errors";
import { shelfChecks } from "./precheck";
import { getSaleItem } from "./sale-items";
import { shelfLocationsFor } from "./shelf-locations";
import type { ShelfCheck } from "./precheck";
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
  /*
    PD-2 — OWNER RULING 2026-09-19: the ticket's P-number is minted HERE, when it is queued, so the
    queue can call a person by it from the first minute. The medication order placed at the check
    carries this same number (`placeOrder`'s `preallocatedOrderNo`), so one dispense has one number
    from the window to the bill. A ticket cancelled while waiting keeps its number — a gap in the
    series is an explained gap, never a reused number.
  */
  const dispenseNo = await nextEpisodeNo(tx, "pharmacy_dispense", istDateOf(now));
  await tx.insert(pharmacyDispenses).values({
    id: dispenseId, dispenseNo, prescriptionId: input.prescriptionId, prescriptionVersion: input.prescriptionVersion,
    patientId: input.patientId, encounterId: input.encounterId, status: "queued", createdBy: actor.id, createdAt: now,
  });
  await appendEvent(tx, dispenseQueued.make({
    occurredAt: now, actor, patientId: input.patientId, encounterId: input.encounterId, correlationId: dispenseId,
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
  /**
   * ═══ FD-31 — WHO TYPED THIS, AND WHETHER THE SLIP HAS BEEN SEEN ═══
   *
   * Owner, 2026-09-12: the departments *"would see that it is notified by which staff of which
   * desk"*. Null on the ordinary prescription — the doctor keyed it — and the user id of the OPD
   * Order Desk clerk on one typed from paper. The pharmacist needs this on the LIST, not inside the
   * dispense: it is what tells them to have the slip in hand before they claim it.
   */
  transcribedBy: string | null;
  /** Set once a pharmacist has cross-confirmed the slip. `billDispense` refuses while it is null. */
  slipConfirmedBy: string | null;
  /**
   * ═══ PD-1 / PD-D9 — A CLAIMED TICKET NAMES ITS HOLDER ═══
   *
   * The claim is exclusive and always was; what was missing is that every OTHER pharmacist learnt
   * so only by being refused. The row stays on their list — the owner wants it seen and marked, not
   * hidden — and says whose it is, so "Vikas has this" is read off the list rather than off a 409.
   */
  claimedBy: string | null;
  claimedByName: string | null;
  /**
   * PD-7 / C1 — for a WAITING ticket, what the shelf can do with it before anybody claims it
   * (`precheck.ts`). Null once claimed: the ticket's own lines are the truth from then on.
   */
  shelf: ShelfCheck | null;
};

/** Full names for a set of user ids — the `leakage.ts` read, one query for a page. */
export async function userNames(db: Db | Tx, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0) return new Map();
  const rows = await db.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, wanted));
  return new Map(rows.map((u) => [u.id, u.fullName]));
}

/** The counter's portal list: today's dispenses that are not finished, oldest first. Names are alias-safe. */
export async function listQueue(db: Db, actor: Actor, filter: { serviceDate: string }, now: Date = new Date()): Promise<QueueRow[]> {
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
  /* ONE query for the whole page, not one per row: the counter's list is polled. */
  const rxRows = await db
    .select({ id: opdPrescriptions.id, transcribedBy: opdPrescriptions.transcribedBy })
    .from(opdPrescriptions)
    .where(inArray(opdPrescriptions.id, rows.map((r) => r.prescriptionId)));
  const transcribedByRx = new Map(rxRows.map((r) => [r.id, r.transcribedBy]));
  const summaries = await getPatientSummaries(db, actor, rows.map((r) => r.patientId));
  const byRequested = new Map(summaries.map((s) => [s.requestedId, s]));
  const holders = await userNames(db, rows.map((r) => r.claimedBy));
  const checks = await shelfChecks(db, rows.filter((r) => r.status === "queued").map((r) => ({ dispenseId: r.id, prescriptionId: r.prescriptionId })), now);
  const out: QueueRow[] = [];
  for (const r of rows) {
    const s = byRequested.get(r.patientId);
    if (s === undefined) continue; // not visible to this actor — not on their list
    out.push({
      dispenseId: r.id, status: r.status, dispenseNo: r.dispenseNo, scheduled: r.scheduled,
      lineCount: countById.get(r.id) ?? 0, createdAt: r.createdAt, claimedAt: r.claimedAt,
      patient: { id: s.id, uhid: s.uhid, name: s.name, alias: s.alias, restricted: s.restricted },
      transcribedBy: transcribedByRx.get(r.prescriptionId) ?? null,
      slipConfirmedBy: r.slipConfirmedBy,
      claimedBy: r.claimedBy,
      claimedByName: r.claimedBy === null ? null : (holders.get(r.claimedBy) ?? null),
      shelf: checks.get(r.id) ?? null,
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
  /** PD-D18 — where this item sits in the counter's store ("R-12"), or null when nobody has said. */
  location: string | null;
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
  /**
   * PHARMACY P3 — the medicine this line hands over (the verified one, else the one ordered) has a
   * component no one has reviewed: a national-release entry with no drug class and no interaction
   * pairs. The checks ran on it, and for that component they could find nothing. Live, from the
   * formulary's one predicate (`unreviewedSaltIds`), so it clears the moment the substance is decided.
   */
  partlyChecked: boolean;
  /**
   * PD-4 / PD-D3 / E8 — the batches the pick would draw from, earliest expiry first, while the line
   * is still OPEN. The right column of the desk shows the batch the pharmacist will give and warns
   * at the TICK — where another batch can still be chosen — when it dies inside the course, rather
   * than at the hand-over, where it is a refund. `availableQty`'s predicate, one definition.
   */
  batches: { batchId: string; batchNo: string; expiryDate: string | null; available: number }[];
  /** PD-4 — once picked, the batch the line was GIVEN from, which the desk prints beside it. */
  pickedBatch: { batchNo: string; expiryDate: string | null } | null;
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
  /** PD-1 — who holds it, so a pharmacist who opens somebody else's ticket is told whose it is. */
  claimedBy: string | null;
  claimedByName: string | null;
  /**
   * PD-8 / E28 — typed from the doctor's paper (FD-31), by whom, and whether a pharmacist has
   * cross-confirmed the slip. The queue row carried these; the ticket did not, so the desk could
   * only learn the slip was owed from `billDispense`'s refusal — at the till, the worst moment.
   */
  transcribedBy: string | null;
  transcribedByName: string | null;
  slipConfirmedBy: string | null;
  patient: { id: string; uhid: string; name: string | null; alias: string | null; restricted: boolean };
  allergies: { substance: string; severity: string | null }[];
  lines: DispenseLineView[];
};

/**
 * ONE dispense, everything the counter shows about it. The patient is read through the alias
 * rules (`getPatientSummaries`); the Rx lines are PHI and the read is logged on the pharmacy's own
 * surface. An invisible patient gives the same `unknown_dispense` as a missing row.
 */
/**
 * ═══ FD-31 — THE PHARMACIST SAYS THEY HAVE SEEN THE SLIP (OWNER RULING 2026-09-12) ═══
 *
 * *"The pharmacist will cross confirm the prescription slip (either the photo capture of
 * prescription or physical prescription slip) before generating the medicine bill."* Either source
 * satisfies it, which is why this records WHO attested and not WHICH artefact they looked at: the
 * hospital's control is a named pharmacist's word, and a field claiming "photo" on a paper check
 * would be a fact the system cannot support.
 *
 * IT IS ONLY MEANINGFUL ON A TRANSCRIPTION, and calling it on a doctor-keyed Rx is refused rather
 * than silently recorded — an attestation that means nothing is worse than none, because it makes
 * the column untrustworthy where it does mean something.
 *
 * Idempotent: confirming twice keeps the FIRST pharmacist's name. The attestation is theirs.
 */
export async function confirmSlip(
  db: Db, actor: Actor, dispenseId: string, now: Date = new Date(),
): Promise<DispenseRow> {
  if (actor.type !== "user") throw new PharmacyError("permission_denied", "a slip is confirmed by a person");
  const d = await getDispenseRow(db, dispenseId);
  const rx = await db
    .select({ transcribedBy: opdPrescriptions.transcribedBy })
    .from(opdPrescriptions)
    .where(eq(opdPrescriptions.id, d.prescriptionId));
  if ((rx[0]?.transcribedBy ?? null) === null) {
    throw new PharmacyError(
      "dispense_not_in_state",
      `dispense ${d.id} is against a prescription the doctor entered — there is no paper slip to cross-confirm`,
      { status: d.status },
    );
  }
  if (d.slipConfirmedBy !== null) return d;
  const updated = await db
    .update(pharmacyDispenses)
    .set({ slipConfirmedBy: actor.id, slipConfirmedAt: now })
    .where(and(eq(pharmacyDispenses.id, d.id), isNull(pharmacyDispenses.slipConfirmedBy)))
    .returning();
  return updated[0] ?? d;
}

export async function getDispense(db: Db, actor: Actor, dispenseId: string, now: Date = new Date()): Promise<DispenseView> {
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
  /**
   * `getDispense` is the return value of every pharmacy mutation, and this line used to load the
   * whole catalogue and then `.filter((m) => medicineIds.includes(m.id))` it — an O(catalogue x
   * lines) scan to keep two rows, on the hottest path the module has. It asks for the two now.
   */
  const medicines = await medicinesByIds(db, medicineIds);
  const unreviewed = await unreviewedSaltIds(db, [...medicines.values()].flatMap((m) => m.salts.map((s) => s.saltId)));
  const itemIds = [...new Set(lines.map((l) => l.itemId).filter((x): x is string => x !== null))];
  const items = itemIds.length === 0 ? new Map() : await itemsByIds(db, itemIds);
  const allergies = await listAllergies(db, d.patientId);
  const [rxRow] = await db.select({ transcribedBy: opdPrescriptions.transcribedBy }).from(opdPrescriptions).where(eq(opdPrescriptions.id, d.prescriptionId));
  const transcribedBy = rxRow?.transcribedBy ?? null;
  const names = await userNames(db, [d.claimedBy, transcribedBy]);
  const openItems = lines.filter((l) => l.status === "open" && l.itemId !== null).map((l) => l.itemId as string);
  /* PD-D18 — the shelf label for each item, in THIS dispense's store. */
  const locations = d.storeResourceId === null || itemIds.length === 0 ? new Map<string, string>() : await shelfLocationsFor(db, d.storeResourceId, itemIds);
  const batchesByItem = d.storeResourceId === null || openItems.length === 0
    ? new Map<string, DispenseLineView["batches"]>()
    : await sellableBatchesByItem(db, d.storeResourceId, openItems, now);
  const views: DispenseLineView[] = [];
  for (const l of lines) {
    const om = l.orderedMedicineId === null ? undefined : medicines.get(l.orderedMedicineId);
    const dm = l.dispensedMedicineId === null ? undefined : medicines.get(l.dispensedMedicineId);
    const item = l.itemId === null ? undefined : items.get(l.itemId);
    const picked = l.batchId === null ? undefined : await getBatch(db, l.batchId);
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
        //
        // A plain display read still means "as of now" and gets the wall clock by default — that
        // is exactly what a counter means. But a WRITE that was handed a clock, decided the pick
        // with it and then returns this view must be answered on ITS clock, or the view it returns
        // contradicts the write that produced it: a batch the pick refused as expired would be
        // reported available. Hence `now`, defaulted rather than required.
        available = await availableQty(db, d.storeResourceId, item.id, now);
      }
    }
    views.push({
      lineIdx: l.lineIdx, rxLine: l.rxLine as RxLine, status: l.status, declinedReason: l.declinedReason,
      substitutionType: l.substitutionType, qtyBase: l.qtyBase, scheduleFlag: l.scheduleFlag,
      orderedMedicine: om === undefined ? null : { id: om.id, brandName: om.brandName, strengthLabel: om.strengthLabel, form: om.form },
      dispensedMedicine: dm === undefined ? null : { id: dm.id, brandName: dm.brandName, strengthLabel: dm.strengthLabel, form: dm.form, scheduleFlag: dm.scheduleFlag },
      item: item === undefined ? null : { id: item.id, code: item.code, name: item.name, baseUom: item.baseUom, uoms },
      saleable, location: l.itemId === null ? null : (locations.get(l.itemId) ?? null), available, batchId: l.batchId, reservationId: l.reservationId, ledgerEntryId: l.ledgerEntryId,
      orderItemId: l.orderItemId, invoiceLineId: l.invoiceLineId, unitPaise: l.unitPaise, priceWinner: l.priceWinner,
      fefoOverride: l.fefoOverride, pickNote: l.pickNote,
      partlyChecked: (dm ?? om)?.salts.some((s) => unreviewed.has(s.saltId)) ?? false,
      batches: l.status === "open" && l.itemId !== null && l.batchId === null ? (batchesByItem.get(l.itemId) ?? []) : [],
      pickedBatch: picked === undefined ? null : { batchNo: picked.batchNo, expiryDate: picked.expiryDate },
    });
  }
  return {
    id: d.id, status: d.status, dispenseNo: d.dispenseNo, orderId: d.orderId, prescriptionId: d.prescriptionId,
    prescriptionVersion: d.prescriptionVersion, encounterId: d.encounterId, storeResourceId: d.storeResourceId,
    scheduled: d.scheduled, invoiceId: d.invoiceId, identityConfirmedVia: d.identityConfirmedVia,
    claimedAt: d.claimedAt, verifiedAt: d.verifiedAt, pickedAt: d.pickedAt, billedAt: d.billedAt, handedOverAt: d.handedOverAt,
    claimedBy: d.claimedBy,
    claimedByName: names.get(d.claimedBy ?? "") ?? null,
    transcribedBy,
    transcribedByName: names.get(transcribedBy ?? "") ?? null,
    slipConfirmedBy: d.slipConfirmedBy,
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
