import { and, eq, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import {
  labItems, labOrderables, labSpecimenItems, labSpecimens, orderItems, orders, patients,
} from "../../kernel/db/schema";
import { nextEpisodeNo } from "../../kernel/episodes/series";
import { LIVE_ITEM_STATUSES } from "../../kernel/orders/transitions";
import { appendEvent } from "../../kernel/events/append";
import { transition } from "../../kernel/workflow/instances";
import { resolvePatientId } from "../patients";
import { LabError } from "./errors";
import { labLabelPrinted } from "./events";
import { assertRightPatient } from "./collection";
import type { Actor } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * PLAN 17a T5 / DD5, DD10 — THE TUBE: one `lab_specimens` row per physical container, an `S`
 * number, and the scan that has to happen before a label is printed.
 *
 * ═══ THE SCAN IS BEFORE THE INSERT, AND E1 IS WHY ═══
 *
 * Two Ram Kumars in one morning queue is the case every laboratory in India has had. The refusal
 * therefore fires **before any `lab_specimens` row exists** (T5 A5): an implementation that
 * inserts first and checks second is one early `return` away from leaving a tube that carries the
 * wrong `S` number, and the harm here is physical rather than clerical — somebody is transfused,
 * or told they are pregnant, on another person's blood.
 *
 * ═══ AND THE FLAG IS WRITTEN ON A SEPARATE TRANSACTION, WHICH IS WHY THIS ONE IS `Db`-FIRST ═══
 *
 * A near-miss nobody logged is a near-miss nobody learns from, and NABL asks for the count. The
 * first implementation appended `lab.tube_mismatch_flagged` and then threw **on the same
 * transaction**, so the rollback took the audit record with it and the refusal left no trace at
 * all — the assertion caught it, and it is finding F20. So `printLabels` takes a `Db`, appends the
 * flag on its OWN transaction, and only then refuses.
 *
 * That is why this act is `Db`-first while `collect`, `receive` and `reject` are `Tx`-first: it is
 * the only one of the four that must WRITE on its refusal path. A label print is its own act at a
 * counter, never a step inside somebody else's transaction, so nothing is lost by the shape.
 *
 * ═══ ONE TUBE PER `(specimen_type, container)`, ACROSS THE WHOLE GROUP ═══
 *
 * A CBC and an ESR both want EDTA, so they ride one tube; an LFT wants an SST, so it gets another.
 * Grouping by the PAIR rather than by the type is deliberate — plain and fluoride are both "blood"
 * and must never share a container, and a design that keyed on `specimen_type` alone would put a
 * glucose in a tube with no fluoride and report a value that falls while the tube sits.
 *
 * The group is the ORDER GROUP, not the order (phase 0 DD2), so an add-on placed as its own order
 * (DD9) is drawn on the same tube as its parent when the containers match — which is what stops a
 * patient being stuck twice because a doctor added a test after the first slip printed.
 */

export type PrintLabelsInput = {
  orderGroupId: string;
  /** DD10 — what the phlebotomist actually scanned off the wristband or the card. */
  scannedUhid: string;
  /** E20 / 02 C3 — the pre-printed kit used when the label printer is down. */
  labelSource?: "printer" | "downtime_kit";
  downtimeKitSerial?: string;
  serviceDate?: string;
};

export type PrintedSpecimen = {
  specimenId: string;
  specimenNo: string;
  specimenType: string;
  container: string;
  itemIds: string[];
};

export type PrintLabelsResult = { specimens: PrintedSpecimen[] };

type DrawableItem = {
  itemId: string; serviceId: string; instanceId: string; patientId: string; serviceDate: string;
};

/** The items a tube may be drawn for: live on an open order, and not already on an active tube. */
async function drawableItems(tx: Tx, orderGroupId: string): Promise<DrawableItem[]> {
  const rows = await tx
    .select({
      itemId: orderItems.id,
      serviceId: orderItems.serviceId,
      instanceId: labItems.instanceId,
      patientId: orders.patientId,
      serviceDate: orders.serviceDate,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .innerJoin(labItems, eq(labItems.orderItemId, orderItems.id))
    .where(and(
      eq(orders.orderGroupId, orderGroupId),
      inArray(orderItems.status, [...LIVE_ITEM_STATUSES]),
    ));
  if (rows.length === 0) return [];

  /**
   * `lab_specimen_items_active_ux` already makes a second ACTIVE tube per item impossible, so this
   * read is not the guard — it is what stops the guard being met as a raw unique violation at a
   * counter. The invariant is the index; this is the sentence.
   */
  const already = await tx
    .select({ orderItemId: labSpecimenItems.orderItemId })
    .from(labSpecimenItems)
    .where(and(
      inArray(labSpecimenItems.orderItemId, rows.map((r) => r.itemId)),
      eq(labSpecimenItems.active, true),
    ));
  const onATube = new Set(already.map((a) => a.orderItemId));
  return rows.filter((r) => !onATube.has(r.itemId));
}

/** MINT THE TUBES FOR ONE CLINICAL ACT. Refuses `tube_mismatch` before it writes anything (A5). */
export async function printLabels(
  db: Db,
  actor: Actor,
  input: PrintLabelsInput,
  now: Date = new Date(),
): Promise<PrintLabelsResult> {
  return await withTx(db, (tx) => printLabelsInTx(db, tx, actor, input, now));
}

async function printLabelsInTx(
  db: Db,
  tx: Tx,
  actor: Actor,
  input: PrintLabelsInput,
  now: Date,
): Promise<PrintLabelsResult> {
  const items = await drawableItems(tx, input.orderGroupId);
  if (items.length === 0) {
    throw new LabError(
      "no_active_order",
      `order group ${input.orderGroupId} has no item awaiting collection — every test on it is ` +
        "already on a tube, cancelled, or finished",
    );
  }

  /**
   * ═══ CLOSE REVIEW PASS 1, MAJOR 5 — ONE GROUP MUST NAME ONE PATIENT ═══
   *
   * `drawableItems` reads across `orders.order_group_id` and returns a `patient_id` PER ROW, and the
   * right-patient scan below validates ONE of them. `deskOrder` takes `orderGroupId` as free caller
   * input, so a clerk's screen still holding the previous group — a reused draft, a copy-paste, a
   * back-button — puts a second patient's tests into it. The scan then matched row zero, passed, and
   * minted a single tube carrying BOTH patients' items under the first one's `patient_id`: the tube
   * is labelled for Ram Kumar and 17b would result Ram Kumar Yadav's test against it. DD10 exists
   * for exactly this (E1, two Ram Kumars) and a guard that checks one row of N is not that guard.
   */
  /**
   * CANONICAL ids, not raw ones — close review pass 2, finding 4. `merge.ts` does not repoint
   * `orders.patient_id`, so one person's group legitimately carries two ids across a merge, and
   * comparing raw ids refused the label for BOTH orders with the money already taken.
   */
  const canonicalOf = new Map<string, string>();
  for (const raw of new Set(items.map((i) => i.patientId))) {
    canonicalOf.set(raw, (await resolvePatientId(tx, raw)) ?? raw);
  }
  const patientIds = [...new Set([...canonicalOf.values()])];
  if (patientIds.length > 1) {
    throw new LabError(
      "tube_mismatch",
      `order group ${input.orderGroupId} names ${patientIds.length} different patients — one tube ` +
        "cannot carry two people's tests, and no label was printed",
    );
  }
  const patientId = patientIds[0]!;
  const patient = (await tx.select().from(patients).where(eq(patients.id, patientId)))[0];
  if (!patient) throw new LabError("unknown_item", `order group ${input.orderGroupId} names no patient`);

  /**
   * ═══ THE REFUSAL, BEFORE ANY WRITE (T5 A5 / DD10 / E1) ═══
   *
   * The event IS a write, and it is the one write this path is allowed: it records that the check
   * fired. `lab_specimens` stays untouched, which is the assertion — and the flag goes on `db`,
   * OUTSIDE the transaction that is about to roll back (F20).
   */
  await assertRightPatient(db, actor, {
    orderGroupId: input.orderGroupId, patientId,
    expectedUhid: patient.uhid, scannedUhid: input.scannedUhid,
  }, now);

  const labelSource = input.labelSource ?? "printer";
  if (labelSource === "printer" && input.downtimeKitSerial) {
    throw new LabError("tube_mismatch", "a printer label carries no downtime-kit serial");
  }
  if (labelSource === "downtime_kit" && !input.downtimeKitSerial) {
    throw new LabError("tube_mismatch", "a downtime kit is identified by its serial, and none was given");
  }

  /** The container each test needs, read from the catalogue in ONE query rather than per item. */
  const orderables = await tx
    .select({
      serviceId: labOrderables.serviceId,
      specimenType: labOrderables.specimenType,
      container: labOrderables.container,
    })
    .from(labOrderables)
    .where(inArray(labOrderables.serviceId, [...new Set(items.map((i) => i.serviceId))]));
  const byService = new Map(orderables.map((o) => [o.serviceId, o]));

  const buckets = new Map<string, { specimenType: string; container: string; items: DrawableItem[] }>();
  for (const item of items) {
    const o = byService.get(item.serviceId);
    if (!o) throw new LabError("unknown_orderable", `no lab orderable for service ${item.serviceId}`);
    const key = `${o.specimenType} ${o.container}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.items.push(item);
    else buckets.set(key, { specimenType: o.specimenType, container: o.container, items: [item] });
  }

  const serviceDate = input.serviceDate ?? items[0]!.serviceDate;
  const printed: PrintedSpecimen[] = [];
  /**
   * SORTED, so two concurrent prints take the counter in a deterministic order and the `S` numbers
   * a suite asserts are reproducible. `nextEpisodeNo` is a single-winner `UPDATE … RETURNING` (S6)
   * and its row lock is what makes A2 true; sorting only makes the result readable.
   */
  for (const key of [...buckets.keys()].sort()) {
    const bucket = buckets.get(key)!;
    const specimenId = newId();
    const specimenNo = await nextEpisodeNo(tx, "lab_specimen", serviceDate);
    await tx.insert(labSpecimens).values({
      id: specimenId,
      specimenNo,
      orderGroupId: input.orderGroupId,
      patientId,
      specimenType: bucket.specimenType,
      container: bucket.container,
      status: "labelled",
      labelSource,
      downtimeKitSerial: input.downtimeKitSerial ?? null,
      serviceDate,
    });
    for (const item of bucket.items) {
      await tx.insert(labSpecimenItems).values({ specimenId, orderItemId: item.itemId, active: true });
      /** The lab machine moves with the tube: an item with a label is awaiting its draw. */
      await transition(tx, item.instanceId, "awaiting_collection", actor);
    }
    await appendEvent(tx, labLabelPrinted.make({
      actor,
      patientId,
      correlationId: input.orderGroupId,
      payload: {
        specimenId, specimenNo, patientId, orderGroupId: input.orderGroupId,
        itemIds: bucket.items.map((i) => i.itemId), labelSource,
      },
    }));
    printed.push({
      specimenId, specimenNo, specimenType: bucket.specimenType, container: bucket.container,
      itemIds: bucket.items.map((i) => i.itemId),
    });
  }
  return { specimens: printed };
}

/** The tube, with the items currently riding it. `null` when no such `S` number exists. */
export async function getSpecimenByNo(
  exec: Db | Tx,
  specimenNo: string,
): Promise<{ specimen: typeof labSpecimens.$inferSelect; itemIds: string[] } | null> {
  const specimen = (await (exec as Db).select().from(labSpecimens)
    .where(eq(labSpecimens.specimenNo, specimenNo)))[0];
  if (!specimen) return null;
  const links = await (exec as Db)
    .select({ orderItemId: labSpecimenItems.orderItemId })
    .from(labSpecimenItems)
    .where(and(eq(labSpecimenItems.specimenId, specimen.id), eq(labSpecimenItems.active, true)));
  return { specimen, itemIds: links.map((l) => l.orderItemId) };
}
