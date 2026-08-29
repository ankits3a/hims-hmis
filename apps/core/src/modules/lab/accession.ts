import { and, eq, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import {
  labItems, labOrderables, labSpecimenItems, labSpecimens, orderItems,
} from "../../kernel/db/schema";
import { nextEpisodeNo } from "../../kernel/episodes/series";
import { appendEvent } from "../../kernel/events/append";
import { advanceOrderItem } from "../../kernel/orders/advance";
import { transition } from "../../kernel/workflow/instances";
import { LabError } from "./errors";
import { labRecollectionRequested, labSpecimenReceived, labSpecimenRejected } from "./events";
import type { Actor } from "@hmis/contracts";
import type { Tx } from "../../kernel/db/client";
import type { OrderKindDecl } from "../../kernel/orders/kinds";

/**
 * PLAN 17a T5 / DD4, DD5 — ACCESSION: the tube reaches the bench, and the TAT clock starts.
 *
 * ═══ THIS IS THE PHASE'S LAST ACT, AND IT IS ONE OF DD4's THREE PROJECTION POINTS ═══
 *
 * The lab's own machine has eleven stages and the envelope has four. They meet in exactly three
 * places, and **`receive` owns the first**: the item's `accessioned` projects `in_progress` onto
 * `order_items.status`, which is the word a WARD screen reads. Everything before this point is the
 * lab arranging itself; this is the moment the hospital can say the test has started.
 *
 * ═══ THE TAT CLOCK STARTS HERE — NOT AT PLACEMENT, NOT AT COLLECTION (T5 A7) ═══
 *
 * A turnaround time measured from PLACEMENT charges the laboratory for the ninety minutes a ward
 * took to send the tube down, and a lab measured that way learns to argue about porters instead of
 * about analysers. Measured from COLLECTION it charges the lab for transport. NABL's own reading
 * is the one implemented: the clock starts when the specimen is ACCEPTED at the bench, because
 * that is the first instant the laboratory controls.
 *
 * ═══ A REJECTED TUBE COSTS THE PATIENT NOTHING (T5 A3) ═══
 *
 * `reject` opens a NEW specimen for the SAME items and issues no invoice at all. The order stands,
 * `lab_items.invoice_line_id` is untouched, and the patient is not billed twice because the lab
 * dropped the tube. That is the whole of A3 and it is a money claim: the tempting implementation
 * bills the recollection as an add-on, which is exactly right for E14 (the serum was discarded
 * after a legitimate run) and exactly wrong here.
 */

export type ReceiveInput = {
  specimenNo: string;
  /** 02 G8 — what the bench actually has in its hand. A mismatch is a rejection, not a guess. */
  containerSeen?: string;
  /** 02 A2 / A6 — required when the tube was drawn without a wristband scan. */
  identityRecheckBy?: string;
  /** E20 — the downtime kit's serial, mapped to the tube at accession. */
  downtimeKitSerial?: string;
};

export type ReceiveResult = {
  specimenId: string;
  specimenNo: string;
  itemIds: string[];
  tatStartedAt: Date;
};

/**
 * RECEIVE ONE TUBE. Single-winner on the status CAS (A1).
 */
export async function receive(
  tx: Tx,
  actor: Actor,
  decls: readonly OrderKindDecl[],
  input: ReceiveInput,
  now: Date = new Date(),
): Promise<ReceiveResult> {
  const specimen = (await tx.select().from(labSpecimens)
    .where(eq(labSpecimens.specimenNo, input.specimenNo)))[0];
  if (!specimen) throw new LabError("unknown_specimen", `no specimen ${input.specimenNo}`);

  if (specimen.status === "received" || specimen.status === "stored" || specimen.status === "disposed") {
    throw new LabError(
      "already_received",
      `specimen ${input.specimenNo} was received at ${specimen.receivedAt?.toISOString() ?? "an earlier time"}`,
    );
  }
  if (specimen.status !== "collected" && specimen.status !== "in_transit") {
    throw new LabError(
      "specimen_not_receivable",
      `specimen ${input.specimenNo} is ${specimen.status} — only a drawn tube can be accessioned`,
    );
  }

  /**
   * 02 A2 / T5 A6 — AN UNSCANNED DRAW CANNOT REACH THE BENCH WITHOUT A NAMED SECOND PERSON.
   *
   * Checked before the CAS so the refusal is about identity rather than about a race, and stored
   * rather than merely required: "somebody checked" that names nobody is not a control.
   */
  if (!specimen.wristbandScanned && !input.identityRecheckBy) {
    throw new LabError(
      "identity_recheck_required",
      `specimen ${input.specimenNo} was drawn without a wristband scan — accessioning it requires ` +
        "a named identity re-check at the bench",
    );
  }

  /** 02 G8 — the container the bench sees must be the container the catalogue asked for. */
  if (input.containerSeen !== undefined && input.containerSeen !== specimen.container) {
    throw new LabError(
      "specimen_not_receivable",
      `specimen ${input.specimenNo} should be in ${specimen.container} and the bench has ` +
        `${input.containerSeen} — reject it rather than running it`,
    );
  }

  const links = await tx
    .select({ orderItemId: labSpecimenItems.orderItemId })
    .from(labSpecimenItems)
    .where(and(eq(labSpecimenItems.specimenId, specimen.id), eq(labSpecimenItems.active, true)));
  const linkedIds = links.map((l) => l.orderItemId);

  /**
   * ═══ T5 A9 / CONTRACT 2 — A TUBE WHOSE EVERY ITEM IS CANCELLED IS REFUSED BY NAME ═══
   *
   * E51's home tube arriving after the order was withdrawn. Without this check `advanceOrderItem`
   * throws `illegal_transition` from `cancelled`, and the bench sees a raw CAS error about a state
   * machine instead of "nobody is waiting for this any more". 24a is written against this refusal.
   */
  const live = linkedIds.length === 0 ? [] : await tx
    .select({ id: orderItems.id })
    .from(orderItems)
    .where(and(inArray(orderItems.id, linkedIds), eq(orderItems.status, "placed")));
  if (live.length === 0) {
    throw new LabError(
      "no_active_order",
      `every test on specimen ${input.specimenNo} has been cancelled — nothing on this tube is ` +
        "waiting to be run",
    );
  }
  const liveIds = live.map((l) => l.id);

  /**
   * ═══ THE CAS (T5 A1) ═══
   *
   * Two benches scanning one tube into the analyser queue is the ordinary morning race. Read-then-
   * update would let both pass the status check above and both emit `lab.specimen_received` and
   * both start the item — two TAT clocks, two `order_item.started` events, and a duplicate run
   * charged to nobody. The single-winner UPDATE is what makes "exactly one" true.
   */
  const won = await tx
    .update(labSpecimens)
    .set({
      status: "received", receivedBy: actor.id, receivedAt: now,
      downtimeKitSerial: input.downtimeKitSerial ?? specimen.downtimeKitSerial,
    })
    .where(and(eq(labSpecimens.id, specimen.id), eq(labSpecimens.status, specimen.status)))
    .returning({ id: labSpecimens.id });
  if (won.length === 0) {
    throw new LabError(
      "already_received",
      `specimen ${input.specimenNo} was received concurrently by another bench`,
    );
  }

  const instances = await tx
    .select({ orderItemId: labItems.orderItemId, instanceId: labItems.instanceId })
    .from(labItems)
    .where(inArray(labItems.orderItemId, liveIds));

  for (const row of instances) {
    /** The lab's own machine first, then the envelope's — DD4's projection, in that order. */
    await transition(tx, row.instanceId, "accessioned", actor);
    await advanceOrderItem(tx, actor, decls, row.orderItemId, "in_progress", { at: now });
    await tx.update(labItems)
      .set({ tatStartedAt: now, identityRecheckBy: input.identityRecheckBy ?? null })
      .where(eq(labItems.orderItemId, row.orderItemId));
  }

  await appendEvent(tx, labSpecimenReceived.make({
    actor,
    patientId: specimen.patientId,
    correlationId: specimen.orderGroupId,
    payload: {
      specimenId: specimen.id, specimenNo: specimen.specimenNo, itemIds: liveIds,
      receivedBy: actor.id, at: now.toISOString(),
    },
  }));

  return { specimenId: specimen.id, specimenNo: specimen.specimenNo, itemIds: liveIds, tatStartedAt: now };
}

export type RejectInput = {
  specimenNo: string;
  reason:
    | "haemolysed" | "clotted" | "insufficient" | "wrong_container" | "unlabelled" | "mislabelled"
    | "leaked" | "contaminated" | "delayed_transport" | "temperature_excursion";
  attributableTo: "collection" | "transport" | "lab" | "patient";
};

export type RejectResult = {
  rejectedSpecimenId: string;
  /** The replacement tube, already labelled and awaiting a fresh draw. NO new charge (A3). */
  specimenId: string;
  specimenNo: string;
  itemIds: string[];
};

/**
 * REJECT A TUBE AND OPEN ITS RECOLLECTION. **Issues no invoice** (A3).
 *
 * The replacement is a NEW `lab_specimens` row rather than a reset of the old one, because DD5's
 * whole claim is that the history of which tubes a test rode is kept: a quality register that can
 * only see the tube that finally worked cannot count haemolysis at all, and haemolysis rates are
 * how a hospital finds the ward that draws through a running drip.
 */
export async function reject(
  tx: Tx,
  actor: Actor,
  input: RejectInput,
  now: Date = new Date(),
): Promise<RejectResult> {
  const specimen = (await tx.select().from(labSpecimens)
    .where(eq(labSpecimens.specimenNo, input.specimenNo)))[0];
  if (!specimen) throw new LabError("unknown_specimen", `no specimen ${input.specimenNo}`);
  if (specimen.status === "rejected") {
    throw new LabError("specimen_not_receivable", `specimen ${input.specimenNo} is already rejected`);
  }
  if (specimen.status === "disposed") {
    throw new LabError("specimen_not_receivable", `specimen ${input.specimenNo} has been disposed of`);
  }

  const links = await tx
    .select({ orderItemId: labSpecimenItems.orderItemId })
    .from(labSpecimenItems)
    .where(and(eq(labSpecimenItems.specimenId, specimen.id), eq(labSpecimenItems.active, true)));
  const linkedIds = links.map((l) => l.orderItemId);

  const rejected = await tx
    .update(labSpecimens)
    .set({ status: "rejected", rejectionReason: input.reason, attributableTo: input.attributableTo })
    .where(and(eq(labSpecimens.id, specimen.id), eq(labSpecimens.status, specimen.status)))
    .returning({ id: labSpecimens.id });
  if (rejected.length === 0) {
    throw new LabError("specimen_not_receivable", `specimen ${input.specimenNo} moved concurrently`);
  }

  await appendEvent(tx, labSpecimenRejected.make({
    actor,
    patientId: specimen.patientId,
    correlationId: specimen.orderGroupId,
    payload: {
      specimenId: specimen.id, specimenNo: specimen.specimenNo, reason: input.reason,
      attributableTo: input.attributableTo, rejectedBy: actor.id, at: now.toISOString(),
    },
  }));

  /**
   * NOTHING LIVE ON THE TUBE ⇒ NO RECOLLECTION. A tube rejected after its every test was cancelled
   * is a disposal record, not a redraw, and minting an `S` number for a tube nobody will draw makes
   * the daily counter lie about how much blood the hospital took.
   */
  const live = linkedIds.length === 0 ? [] : await tx
    .select({ id: orderItems.id })
    .from(orderItems)
    .where(and(inArray(orderItems.id, linkedIds), eq(orderItems.status, "placed")));
  if (live.length === 0) {
    return {
      rejectedSpecimenId: specimen.id, specimenId: specimen.id,
      specimenNo: specimen.specimenNo, itemIds: [],
    };
  }
  const liveIds = live.map((l) => l.id);

  /** The old links go inactive FIRST — `lab_specimen_items_active_ux` admits one live tube. */
  for (const itemId of linkedIds) {
    await tx.update(labSpecimenItems)
      .set({ active: false })
      .where(and(eq(labSpecimenItems.specimenId, specimen.id), eq(labSpecimenItems.orderItemId, itemId)));
  }

  const replacementId = newId();
  const replacementNo = await nextEpisodeNo(tx, "lab_specimen", specimen.serviceDate);
  await tx.insert(labSpecimens).values({
    id: replacementId,
    specimenNo: replacementNo,
    orderGroupId: specimen.orderGroupId,
    patientId: specimen.patientId,
    specimenType: specimen.specimenType,
    container: specimen.container,
    status: "labelled",
    labelSource: specimen.labelSource,
    collectionSite: specimen.collectionSite,
    recollectionOfSpecimenId: specimen.id,
    serviceDate: specimen.serviceDate,
  });
  for (const itemId of liveIds) {
    await tx.insert(labSpecimenItems).values({ specimenId: replacementId, orderItemId: itemId, active: true });
  }

  /**
   * The items go to `recollection_pending`, which is the state DD20's seven-day sweep measures the
   * age of. They stay `pending` on the ENVELOPE: nothing has started, and a ward reading the order
   * should see a test still owed rather than one in progress.
   */
  const instances = await tx
    .select({ orderItemId: labItems.orderItemId, instanceId: labItems.instanceId })
    .from(labItems)
    .where(inArray(labItems.orderItemId, liveIds));
  for (const row of instances) {
    await transition(tx, row.instanceId, "recollection_pending", actor);
  }

  await appendEvent(tx, labRecollectionRequested.make({
    actor,
    patientId: specimen.patientId,
    correlationId: specimen.orderGroupId,
    payload: {
      priorSpecimenId: specimen.id, specimenId: replacementId, specimenNo: replacementNo,
      itemIds: liveIds, reason: input.reason,
    },
  }));

  return {
    rejectedSpecimenId: specimen.id, specimenId: replacementId,
    specimenNo: replacementNo, itemIds: liveIds,
  };
}

/** Re-exported so a caller reading an accession never has to import the catalogue for a code. */
export async function orderableCodesFor(
  tx: Tx,
  itemIds: readonly string[],
): Promise<string[]> {
  if (itemIds.length === 0) return [];
  const rows = await tx
    .select({ code: labOrderables.code })
    .from(orderItems)
    .innerJoin(labOrderables, eq(labOrderables.serviceId, orderItems.serviceId))
    .where(inArray(orderItems.id, [...itemIds]));
  return rows.map((r) => r.code);
}
