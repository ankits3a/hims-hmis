import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { nextEpisodeNo } from "../../kernel/episodes/series";
import { events, opdPrescriptions, pharmacyDispenseLines, pharmacyDispenses, users } from "../../kernel/db/schema";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { withTx } from "../../kernel/db/client";
import { medicinesByIds, saltsByIds, unreviewedSaltIds } from "../formulary";
import { availableQty, getBatch, itemsByIds, itemUomRows, sellableBatchesByItem } from "../materials";
import { getPatient, getPatientSummaries, listAllergies } from "../patients";
import { istDateOf } from "./config";
import { controlledStore, controlOf } from "./controlled";
import { controlledChecklist } from "./controlled-dispense";
import type { ControlledChecklist } from "./controlled-dispense";
import { gstCategoryMap } from "./bill";
import { quotedAmountPaise, quoteItem } from "./quote";
import type { Quote } from "./quote";
import { dispenseQueued } from "./events";
import { PharmacyError } from "./errors";
import { shelfChecks } from "./precheck";
import { getSaleItem } from "./sale-items";
import { shelfLocationsFor } from "./shelf-locations";
import { authorisationsOf } from "./authorisation-reads";
import { getDoctor } from "../opd";
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
  /** What the doctor wrote, in order — the board's queue rows name the drugs, not a count. */
  drugs: string[];
  createdAt: Date;
  /** The IST day the ticket was queued — an earlier day's ticket carried over says so (`listQueue`). */
  queuedOn: string;
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

/**
 * How many IST days an UNTOUCHED ticket stays on the live queue, the asked-for day included. DECIDED
 * 2026-09-20 under the owner's standing rule: an OPD prescription nobody has collected in three days
 * has almost always been filled elsewhere. It is still found by scanning the prescription or by the
 * UHID; it only stops crowding the list.
 */
export const QUEUED_CARRY_DAYS = 3;

/** Every state a ticket can be open in. Started or PAID tickets stay listed until they close, whatever their day. */
const OPEN_STATES = ["queued", "claimed", "verified", "picked", "billed"] as const;

/**
 * THE one definition of "on the counter's line on `serviceDate`": open, queued on or before the day,
 * and — if nobody has touched it — queued within `QUEUED_CARRY_DAYS`. The line and the day summary's
 * open counts both read it, so the header never counts a ticket the line does not show.
 */
export function openOnDay(serviceDate: string): SQL {
  const queuedOn = sql`(${pharmacyDispenses.createdAt} at time zone 'Asia/Kolkata')::date`;
  return and(
    inArray(pharmacyDispenses.status, [...OPEN_STATES]),
    sql`${queuedOn} <= ${serviceDate}::date`,
    sql`(${pharmacyDispenses.status} <> 'queued' or ${queuedOn} > ${serviceDate}::date - ${QUEUED_CARRY_DAYS}::int)`,
  )!;
}

/**
 * The counter's portal list, oldest first. Names are alias-safe.
 *
 * It was "the tickets CREATED on the day", so at midnight IST a ticket in a pharmacist's hands — and
 * one the patient had PAID for and not collected — fell off the desk with its stock still reserved and
 * its money still taken (measured on production, 2026-09-20). Now: every open ticket queued on or
 * before the day, except that an untouched one leaves after `QUEUED_CARRY_DAYS`.
 */
export async function listQueue(db: Db, actor: Actor, filter: { serviceDate: string }, now: Date = new Date()): Promise<QueueRow[]> {
  const rows = await db.select().from(pharmacyDispenses)
    .where(openOnDay(filter.serviceDate))
    .orderBy(asc(pharmacyDispenses.createdAt));
  if (rows.length === 0) return [];
  const counts = await db.select({ dispenseId: pharmacyDispenseLines.dispenseId, n: sql<number>`count(*)::int` })
    .from(pharmacyDispenseLines)
    .where(inArray(pharmacyDispenseLines.dispenseId, rows.map((r) => r.id)))
    .groupBy(pharmacyDispenseLines.dispenseId);
  const countById = new Map(counts.map((c) => [c.dispenseId, c.n]));
  /**
   * The DRUGS on each waiting ticket (the board's queue rows name them: "Augmentin 625, Pan 40,
   * Alzolam 0.5"). One query for the page, as the counts are: a pharmacist reads the line to decide
   * which ticket to take, and "4 lines" does not tell them whether the shelf can serve it.
   */
  const drugRows = await db.select({ dispenseId: pharmacyDispenseLines.dispenseId, lineIdx: pharmacyDispenseLines.lineIdx, rxLine: pharmacyDispenseLines.rxLine })
    .from(pharmacyDispenseLines)
    .where(inArray(pharmacyDispenseLines.dispenseId, rows.map((r) => r.id)))
    .orderBy(asc(pharmacyDispenseLines.lineIdx));
  const drugsById = new Map<string, string[]>();
  for (const r of drugRows) {
    const list = drugsById.get(r.dispenseId) ?? [];
    list.push((r.rxLine as RxLine).drug);
    drugsById.set(r.dispenseId, list);
  }
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
      lineCount: countById.get(r.id) ?? 0, drugs: drugsById.get(r.id) ?? [],
      createdAt: r.createdAt, queuedOn: istDateOf(r.createdAt), claimedAt: r.claimedAt,
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
  /** PHARMACY P6 — the NDPS Act class (`narcotic` | `psychotropic`) and whether the line is controlled (that, or Schedule X). */
  ndpsClass: string | null;
  controlled: boolean;
  orderedMedicine: { id: string; brandName: string; strengthLabel: string | null; form: string } | null;
  dispensedMedicine: { id: string; brandName: string; strengthLabel: string | null; form: string; scheduleFlag: string | null } | null;
  item: { id: string; code: string; name: string; baseUom: string; uoms: UomRow[] } | null;
  saleable: boolean;
  /** PD-D18 — where this item sits in the counter's store ("R-12"), or null when nobody has said. */
  location: string | null;
  /**
   * PD-9 — every request to the prescriber about this line, oldest first: what was asked, and what the
   * doctor decided and why. `about` is the hit's identity (`refusalKey`), the same the line's refusal carries.
   */
  authorisations: {
    id: string; book: string; about: string; status: string; requestNote: string | null;
    decisionReason: string | null; requestedAt: Date; decidedAt: Date | null;
  }[];
  /** At the counter's store: on hand minus reserved minus frozen, in base units. `null` before the claim names a store. */
  available: number | null;
  batchId: string | null;
  reservationId: string | null;
  ledgerEntryId: string | null;
  orderItemId: string | null;
  invoiceLineId: string | null;
  unitPaise: number | null;
  priceWinner: string | null;
  /**
   * What the bill will ask for this line's own medicine, from the batch the pick would take
   * (`quote.ts`) — so the counter can answer "how much will this be?" before a strip is pulled.
   * Null when the shelf cannot fill it. The bill at payment is still billing's, never this.
   */
  quote: Quote | null;
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
  /**
   * 2026-09-23 — "salt" when the counter filled a line the doctor named no brand on with the stocked
   * brand of exactly its composition (`auto-match.ts`, `dispense.line_matched`). The desk shows a quiet
   * "matched by salt"; the line is otherwise an ordinary placed line.
   */
  matchedBy: "salt" | null;
  /**
   * The desk board's doctor column: what the medicine the doctor wrote is made of ("Amoxicillin +
   * Clavulanic acid"), else the one dispensed, else null. Display only.
   */
  salt: string | null;
};


export type DispenseView = {
  /** The ticket at today's shelf prices, before the bill exists (`quote.ts`): the server's own sum. */
  quotedTotalPaise: number;
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
  /** PD-9 — the doctor who wrote this prescription, whom the counter asks to authorise. */
  prescriberName: string | null;
  patient: { id: string; uhid: string; name: string | null; alias: string | null; restricted: boolean };
  allergies: { substance: string; severity: string | null }[];
  lines: DispenseLineView[];
  /**
   * PHARMACY P6 — for a ticket with a controlled line: what the law asks before the hand-over, each ok or
   * not (`controlledChecklist`) — the counter agent's card. Null when no open line is controlled.
   */
  controlled: ControlledChecklist | null;
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
  const saltNames = await saltsByIds(db, [...new Set([...medicines.values()].flatMap((m) => m.salts.map((s) => s.saltId)))]);
  const saltOf = (m: { salts: { saltId: string }[] } | undefined): string | null => {
    const names = (m?.salts ?? []).map((s) => saltNames.get(s.saltId)?.name).filter((n): n is string => n !== undefined);
    return names.length === 0 ? null : names.join(" + ");
  };
  const itemIds = [...new Set(lines.map((l) => l.itemId).filter((x): x is string => x !== null))];
  const items = itemIds.length === 0 ? new Map() : await itemsByIds(db, itemIds);
  const allergies = await listAllergies(db, d.patientId);
  const [rxRow] = await db.select({ transcribedBy: opdPrescriptions.transcribedBy, doctorId: opdPrescriptions.doctorId }).from(opdPrescriptions).where(eq(opdPrescriptions.id, d.prescriptionId));
  const prescriber = rxRow === undefined ? null : await getDoctor(db, rxRow.doctorId);
  const asked = await authorisationsOf(db, d.id);
  const transcribedBy = rxRow?.transcribedBy ?? null;
  const names = await userNames(db, [d.claimedBy, transcribedBy]);
  /**
   * PHARMACY P6 — a controlled line's stock is in the CABINET, not on the counter's shelf: its
   * availability, batches and price are read there (the pick reserves there too, `pick.ts`).
   */
  const isControlled = (l: { scheduleFlag: string | null; ndpsClass: string | null }): boolean => controlOf(l.scheduleFlag, l.ndpsClass).controlled;
  const cabinet = lines.some((l) => isControlled(l)) ? await controlledStore(db) : undefined;
  const controlledItems = new Set(lines.filter((l) => isControlled(l) && l.itemId !== null).map((l) => l.itemId as string));
  const storeOf = (itemId: string): string | null => (controlledItems.has(itemId) ? (cabinet?.id ?? null) : d.storeResourceId);
  const openItems = lines.filter((l) => l.status === "open" && l.itemId !== null).map((l) => l.itemId as string);
  /* PD-D18 — the shelf label for each item, in THIS dispense's store. */
  const locations = d.storeResourceId === null || itemIds.length === 0 ? new Map<string, string>() : await shelfLocationsFor(db, d.storeResourceId, itemIds);
  const batchesByItem = new Map<string, DispenseLineView["batches"]>();
  for (const store of new Set(openItems.map(storeOf))) {
    if (store === null) continue;
    const here = openItems.filter((i) => storeOf(i) === store);
    for (const [k, v] of await sellableBatchesByItem(db, store, here, now)) batchesByItem.set(k, v);
  }
  /**
   * One quote per ITEM on the ticket, asked once for the whole view (it is polled). A line the shelf
   * cannot fill has none, and is left out of the running total — a number the server adds up, because
   * the desk does no arithmetic on money.
   */
  const quotes = new Map<string, Quote>();
  if (d.storeResourceId !== null) {
    const gst = await gstCategoryMap(db);
    for (const itemId of [...new Set(lines.map((l) => l.itemId).filter((x): x is string => x !== null))]) {
      const store = storeOf(itemId);
      const q = store === null ? null : await quoteItem(db, gst, store, itemId, now);
      if (q !== null) quotes.set(itemId, q);
    }
  }
  /* Which lines the shelf matched by composition — the rule's own record, one indexed read. */
  const matchedRows = await db.select({ payload: events.payload }).from(events)
    .where(and(eq(events.correlationId, d.id), eq(events.name, "dispense.line_matched")));
  const matchedAt = new Map(matchedRows.map((r) => {
    const p = r.payload as { lineIdx: number; dispensedMedicineId: string };
    return [p.lineIdx, p.dispensedMedicineId] as const;
  }));
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
      const store = storeOf(item.id);
      if (store !== null) {
        // The number on the screen is the number the PICK will honour — same exclusions, one
        // definition (`availableQty`). Summing raw balances here counted recalled and EXPIRED
        // batches the pick refuses, so the counter could promise fifty and then refuse twenty.
        //
        // A plain display read still means "as of now" and gets the wall clock by default — that
        // is exactly what a counter means. But a WRITE that was handed a clock, decided the pick
        // with it and then returns this view must be answered on ITS clock, or the view it returns
        // contradicts the write that produced it: a batch the pick refused as expired would be
        // reported available. Hence `now`, defaulted rather than required.
        available = await availableQty(db, store, item.id, now);
      }
    }
    views.push({
      lineIdx: l.lineIdx, rxLine: l.rxLine as RxLine, status: l.status, declinedReason: l.declinedReason,
      substitutionType: l.substitutionType, qtyBase: l.qtyBase, scheduleFlag: l.scheduleFlag,
      ndpsClass: l.ndpsClass, controlled: isControlled(l),
      orderedMedicine: om === undefined ? null : { id: om.id, brandName: om.brandName, strengthLabel: om.strengthLabel, form: om.form },
      dispensedMedicine: dm === undefined ? null : { id: dm.id, brandName: dm.brandName, strengthLabel: dm.strengthLabel, form: dm.form, scheduleFlag: dm.scheduleFlag },
      item: item === undefined ? null : { id: item.id, code: item.code, name: item.name, baseUom: item.baseUom, uoms },
      saleable, location: l.itemId === null ? null : (locations.get(l.itemId) ?? null), available, batchId: l.batchId, reservationId: l.reservationId, ledgerEntryId: l.ledgerEntryId,
      orderItemId: l.orderItemId, invoiceLineId: l.invoiceLineId, unitPaise: l.unitPaise, priceWinner: l.priceWinner,
      quote: item === undefined ? null : (quotes.get(item.id) ?? null),
      fefoOverride: l.fefoOverride, pickNote: l.pickNote,
      partlyChecked: (dm ?? om)?.salts.some((s) => unreviewed.has(s.saltId)) ?? false,
      salt: saltOf(om) ?? saltOf(dm),
      matchedBy: l.dispensedMedicineId !== null && matchedAt.get(l.lineIdx) === l.dispensedMedicineId ? "salt" : null,
      batches: l.status === "open" && l.itemId !== null && l.batchId === null ? (batchesByItem.get(l.itemId) ?? []) : [],
      pickedBatch: picked === undefined ? null : { batchNo: picked.batchNo, expiryDate: picked.expiryDate },
      authorisations: asked.filter((a) => a.lineIdx === l.lineIdx).map((a) => ({
        id: a.id, book: a.book, about: a.about, status: a.status, requestNote: a.requestNote,
        decisionReason: a.decisionReason, requestedAt: a.requestedAt, decidedAt: a.decidedAt,
      })),
    });
  }
  return {
    /* What the ticket comes to at today's shelf prices, over the quantities the check is made against. */
    quotedTotalPaise: views.reduce((n, v) => n + (v.quote === null || v.qtyBase === null ? 0 : quotedAmountPaise(v.quote, v.qtyBase)), 0),
    id: d.id, status: d.status, dispenseNo: d.dispenseNo, orderId: d.orderId, prescriptionId: d.prescriptionId,
    prescriptionVersion: d.prescriptionVersion, encounterId: d.encounterId, storeResourceId: d.storeResourceId,
    scheduled: d.scheduled, invoiceId: d.invoiceId, identityConfirmedVia: d.identityConfirmedVia,
    claimedAt: d.claimedAt, verifiedAt: d.verifiedAt, pickedAt: d.pickedAt, billedAt: d.billedAt, handedOverAt: d.handedOverAt,
    claimedBy: d.claimedBy,
    claimedByName: names.get(d.claimedBy ?? "") ?? null,
    transcribedBy,
    transcribedByName: names.get(transcribedBy ?? "") ?? null,
    slipConfirmedBy: d.slipConfirmedBy,
    prescriberName: prescriber?.displayName ?? null,
    cancelReason: d.cancelReason,
    patient: { id: summary.id, uhid: summary.uhid, name: summary.name, alias: summary.alias, restricted: summary.restricted },
    allergies: allergies.map((a) => ({ substance: a.substance, severity: (a as { severity?: string | null }).severity ?? null })),
    lines: views,
    controlled: d.status === "handed_over" || d.status === "cancelled" ? null : await controlledChecklist(db, {
      lines: views.map((v) => ({
        lineIdx: v.lineIdx, drug: v.dispensedMedicine?.brandName ?? v.rxLine.drug, scheduleFlag: v.scheduleFlag, ndpsClass: v.ndpsClass,
        qtyBase: v.qtyBase, rxLine: v.rxLine, status: v.status,
      })),
      prescriber: prescriber === null ? null : { id: prescriber.id, displayName: prescriber.displayName, registrationNo: prescriber.registrationNo ?? null },
      patientAddress: visible.patient.addressLine ?? null,
    }, now),
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
