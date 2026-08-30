import { and, asc, eq, inArray } from "drizzle-orm";
import { withTx } from "../../kernel/db/client";
import {
  labItems, labOrderables, labSpecimenItems, labSpecimens, orderItems, orders, patients,
  workflowInstances,
} from "../../kernel/db/schema";
import { hasPermission } from "../../kernel/auth/permissions";
import { appendEvent } from "../../kernel/events/append";
import { LIVE_ITEM_STATUSES } from "../../kernel/orders/transitions";
import { transition } from "../../kernel/workflow/instances";
import { displayNameFor } from "../patients";
import { LabError } from "./errors";
import { labSpecimenCollected, labTubeMismatchFlagged } from "./events";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { LabCollectionSite, LabPriority } from "./desk";

/**
 * PLAN 17a T5 — THE PHLEBOTOMY QUEUE AND THE DRAW.
 *
 * ═══ STAT BEATS URGENT BEATS ROUTINE, AND THE ORDER IS THE POINT (E18) ═══
 *
 * A STAT troponin arriving behind a batch of forty routine morning fastings is the case this
 * ordering exists for. It is expressed as an explicit rank rather than as a text sort, because
 * `'routine' < 'stat' < 'urgent'` is what a text sort actually returns and it puts the emergency
 * last.
 *
 * ═══ THE NAME GOES THROUGH THE KERNEL'S ALIAS RULE, NOT THROUGH `patients.name` ═══
 *
 * `displayNameFor` is the rule 07a shipped after the confidential-patient leak: a VIP's legal name
 * is replaced by their alias unless the reader holds the permission, and a `system` actor never
 * sees through the flag. A phlebotomy list is a piece of paper carried around a hospital, which is
 * the single most copyable surface in the building, so it takes the same rule as every other read.
 */

/**
 * ═══ DD10 / T5 A5 — THE RIGHT-PATIENT SCAN, AND IT LIVES HERE RATHER THAN IN `specimens.ts` ═══
 *
 * `printLabels` calls it, and the guard sits in the COLLECTION module because that is where a
 * reader looks for it and because `errors.ts`'s own census says so: `tube_mismatch` is owned by
 * this file, which T2 recorded from the phase document's Produces list before any of this code
 * existed. The census caught the first placement (finding F22) — a derived expectation working
 * exactly as designed, and the second time this phase has been corrected by one.
 *
 * ═══ THE FLAG IS WRITTEN ON ITS OWN TRANSACTION, WHICH IS WHY THIS TAKES A `Db` ═══
 *
 * The refusal rolls its caller's transaction back, and the first implementation appended the flag
 * on that same transaction — so the rollback took the audit record with it and a near-miss left no
 * trace at all (finding F20). NABL asks for the count of these, and a control nobody can count is
 * a control nobody can audit.
 */
export async function assertRightPatient(
  db: Db,
  actor: Actor,
  input: { orderGroupId: string; patientId: string; expectedUhid: string; scannedUhid: string },
  now: Date,
): Promise<void> {
  if (input.scannedUhid === input.expectedUhid) return;
  await withTx(db, (flagTx) => appendEvent(flagTx, labTubeMismatchFlagged.make({
    actor,
    patientId: input.patientId,
    correlationId: input.orderGroupId,
    payload: {
      orderGroupId: input.orderGroupId, expectedUhid: input.expectedUhid,
      scannedUhid: input.scannedUhid, at: now.toISOString(),
    },
  })));
  throw new LabError(
    "tube_mismatch",
    `the scan says ${input.scannedUhid} and this order group belongs to ${input.expectedUhid} — ` +
      "no label was printed",
  );
}

export type CollectionQueueRow = {
  specimenId: string;
  specimenNo: string;
  patientId: string;
  /** Through `displayNameFor` — the alias for a confidential patient (07a). */
  patientName: string;
  uhid: string;
  /** The `V` number. **The queue TOKEN is not resolved here — finding F17.** */
  encounterNo: string;
  specimenType: string;
  container: string;
  collectionSite: LabCollectionSite;
  priority: LabPriority;
  requiresFasting: boolean;
  orderableCodes: string[];
  itemIds: string[];
};

const PRIORITY_RANK: Record<string, number> = { stat: 0, urgent: 1, routine: 2 };

/** The permission a worklist reader holds. Declared by the manifest and granted to all four roles. */
export const LAB_WORKLIST_READ = "lab.worklist.read";
/** The kernel's own clearance for a restricted item — `orders/read.ts:141`, and nobody else. */
const ORDERS_READ_RESTRICTED = "orders.read.restricted";

/**
 * WHAT IS WAITING TO BE DRAWN, at one site, on one IST service date.
 *
 * `Db`-first and read-only: a worklist is a screen, not a transaction.
 *
 * ═══ CLOSE REVIEW PASS 1, MAJOR 3 — THIS WAS AN UNGATED BULK PHI READ ═══
 *
 * As first shipped this function took an `Actor` and asked it for nothing: no permission, no actor
 * type, no `restricted` filter. `collectionQueue(db, anyActor, {serviceDate})` returned, for every
 * patient labelled that day, their display name, their **UHID**, their `V` number and their
 * orderable codes — `["HIV"]`, `["HBSAG"]`, `["VDRL"]`, `["UPT"]`. `deskOrder` sets
 * `order_items.restricted` precisely so the kernel's reader omits those, and this re-implemented a
 * reader over the same rows one level down from where that rule is enforced. It is 22c-A's shape
 * exactly: a filter applied at one level of a nested structure is not a filter.
 *
 * **THE TUBE STAYS ON THE LIST AND THE TEST NAME LEAVES IT**, which is the trade this surface
 * needs. A phlebotomist must still draw the EDTA tube — dropping the row would make a
 * confidentiality rule into a clinical failure — but nothing about the worklist requires them to
 * learn that it is an HIV test. A reader holding `orders.read.restricted` sees the codes; nobody
 * else does, and the same `restricted` boolean decides it.
 */
export async function collectionQueue(
  db: Db,
  actor: Actor,
  filter: { site?: LabCollectionSite; serviceDate: string },
): Promise<CollectionQueueRow[]> {
  /**
   * A `user` ACTOR ONLY, by TYPE before permission — `kernel/orders/read.ts:121` refuses `patient`
   * and `agent` outright for the same reason, and `hasPermission` handed a non-user id returns
   * false, which would report "this user lacks the permission" about something that is not a user.
   */
  if (actor.type !== "user") {
    throw new LabError("no_active_order", `a ${actor.type} actor may not read the collection worklist`);
  }
  if (!(await hasPermission(db, actor.id, LAB_WORKLIST_READ, "hospital"))) {
    throw new LabError("no_active_order", `reading the collection worklist requires ${LAB_WORKLIST_READ}`);
  }
  const canSeeRestricted = await hasPermission(db, actor.id, ORDERS_READ_RESTRICTED, "hospital");
  const specimens = await db
    .select()
    .from(labSpecimens)
    .where(and(eq(labSpecimens.serviceDate, filter.serviceDate), eq(labSpecimens.status, "labelled")))
    .orderBy(asc(labSpecimens.specimenNo));
  if (specimens.length === 0) return [];

  const links = await db
    .select({ specimenId: labSpecimenItems.specimenId, orderItemId: labSpecimenItems.orderItemId })
    .from(labSpecimenItems)
    .where(and(
      inArray(labSpecimenItems.specimenId, specimens.map((s) => s.id)),
      eq(labSpecimenItems.active, true),
    ));
  const itemIds = links.map((l) => l.orderItemId);
  if (itemIds.length === 0) return [];

  const itemRows = await db
    .select({
      itemId: orderItems.id,
      status: orderItems.status,
      restricted: orderItems.restricted,
      priority: labItems.priority,
      collectionSite: labItems.collectionSite,
      encounterNo: orders.encounterNo,
      code: labOrderables.code,
      requiresFasting: labOrderables.requiresFasting,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .innerJoin(labItems, eq(labItems.orderItemId, orderItems.id))
    .innerJoin(labOrderables, eq(labOrderables.serviceId, orderItems.serviceId))
    .where(inArray(orderItems.id, itemIds));
  const byItem = new Map(itemRows.map((r) => [r.itemId, r]));

  const patientRows = await db
    .select()
    .from(patients)
    .where(inArray(patients.id, [...new Set(specimens.map((s) => s.patientId))]));
  const byPatient = new Map(patientRows.map((p) => [p.id, p]));

  const rows: CollectionQueueRow[] = [];
  for (const specimen of specimens) {
    const mine = links.filter((l) => l.specimenId === specimen.id).map((l) => byItem.get(l.orderItemId))
      /** LIVE work, not `placed` alone — a redrawn item is `in_progress` (pass 1 CRITICAL 1). */
      .filter((r): r is NonNullable<typeof r> => r !== undefined
        && (LIVE_ITEM_STATUSES as readonly string[]).includes(r.status));
    if (mine.length === 0) continue;

    const site = (mine[0]!.collectionSite ?? "opd") as LabCollectionSite;
    if (filter.site !== undefined && site !== filter.site) continue;

    const patient = byPatient.get(specimen.patientId);
    if (!patient) continue;

    /** The most urgent test on the tube decides when the tube is drawn — never the average. */
    const priority = mine
      .map((m) => m.priority as LabPriority)
      .sort((a, b) => (PRIORITY_RANK[a] ?? 3) - (PRIORITY_RANK[b] ?? 3))[0]!;

    rows.push({
      specimenId: specimen.id,
      specimenNo: specimen.specimenNo,
      patientId: specimen.patientId,
      patientName: await displayNameFor(db, actor, patient),
      uhid: patient.uhid,
      encounterNo: mine[0]!.encounterNo,
      specimenType: specimen.specimenType,
      container: specimen.container,
      collectionSite: site,
      priority,
      /** One fasting test on the tube makes the whole draw a fasting draw. */
      requiresFasting: mine.some((m) => m.requiresFasting),
      /** DD11 — omitted, not flagged: the EXISTENCE of the test is the sensitive fact. */
      orderableCodes: mine.filter((m) => canSeeRestricted || !m.restricted).map((m) => m.code),
      itemIds: mine.map((m) => m.itemId),
    });
  }

  return rows.sort((a, b) =>
    (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3) ||
    a.specimenNo.localeCompare(b.specimenNo));
}

export type CollectInput = {
  specimenId: string;
  /** DD10 / 02 A2 — false on a ward draw forces an identity re-check at accession (A6). */
  wristbandScanned: boolean;
  site?: LabCollectionSite;
};

/**
 * THE DRAW. `labelled → collected`, with the scan recorded rather than judged.
 *
 * **An unscanned draw is NOT refused here, and that is deliberate** — a ward nurse drawing at 03:00
 * with a broken scanner must still be able to record what she did, and refusing would push the
 * record onto paper where nothing checks it at all. The consequence lands at ACCESSION instead
 * (A6): the tube cannot be received without a named identity re-check. The friction is placed
 * where a second person is present to resolve it.
 */
export async function collect(
  tx: Tx,
  actor: Actor,
  input: CollectInput,
  now: Date = new Date(),
): Promise<{ specimenId: string; specimenNo: string; itemIds: string[] }> {
  const specimen = (await tx.select().from(labSpecimens)
    .where(eq(labSpecimens.id, input.specimenId)))[0];
  if (!specimen) throw new LabError("unknown_specimen", `no specimen ${input.specimenId}`);

  const site = input.site ?? (specimen.collectionSite as LabCollectionSite);

  /**
   * CAS on the STATUS, not a read-then-write: two phlebotomists scanning one tube is the ordinary
   * race on a busy morning, and the loser must be told rather than silently overwriting the first
   * draw's time and collector.
   */
  const moved = await tx
    .update(labSpecimens)
    .set({
      status: "collected", collectedBy: actor.id, collectedAt: now,
      wristbandScanned: input.wristbandScanned, collectionSite: site,
    })
    .where(and(eq(labSpecimens.id, input.specimenId), eq(labSpecimens.status, "labelled")))
    .returning({ id: labSpecimens.id });
  if (moved.length === 0) {
    throw new LabError(
      "specimen_not_receivable",
      `specimen ${specimen.specimenNo} is ${specimen.status} and only a labelled tube can be drawn`,
    );
  }

  const links = await tx
    .select({ orderItemId: labSpecimenItems.orderItemId })
    .from(labSpecimenItems)
    .where(and(eq(labSpecimenItems.specimenId, input.specimenId), eq(labSpecimenItems.active, true)));
  const itemIds = links.map((l) => l.orderItemId);

  const instances = await tx
    .select({ orderItemId: labItems.orderItemId, instanceId: labItems.instanceId })
    .from(labItems)
    .where(inArray(labItems.orderItemId, itemIds));
  const states = instances.length === 0 ? [] : await tx
    .select({ id: workflowInstances.id, currentState: workflowInstances.currentState })
    .from(workflowInstances)
    .where(inArray(workflowInstances.id, instances.map((i) => i.instanceId)));
  const stateOf = new Map(states.map((s) => [s.id, s.currentState]));

  for (const row of instances) {
    await tx.update(labItems)
      .set({ collectionSite: site })
      .where(eq(labItems.orderItemId, row.orderItemId));
    /**
     * A REDRAW TAKES TWO HOPS, and that is the definition being honest rather than an awkwardness.
     *
     * A rejected item sits in `recollection_pending` and its replacement tube was labelled by
     * `reject` rather than by a `printLabels` call, so nothing has moved it back to
     * `awaiting_collection`. The machine has no `recollection_pending → collected` edge and MUST
     * NOT gain one: the intermediate state is what the seven-day non-return sweep measures the age
     * of (T5 A4), and a shortcut would make a redrawn tube indistinguishable from one nobody ever
     * came back for.
     */
    if (stateOf.get(row.instanceId) === "recollection_pending") {
      await transition(tx, row.instanceId, "awaiting_collection", actor);
    }
    await transition(tx, row.instanceId, "collected", actor);
  }

  await appendEvent(tx, labSpecimenCollected.make({
    actor,
    patientId: specimen.patientId,
    correlationId: specimen.orderGroupId,
    payload: {
      specimenId: specimen.id, specimenNo: specimen.specimenNo, patientId: specimen.patientId,
      collectedBy: actor.id, at: now.toISOString(),
      wristbandScanned: input.wristbandScanned, collectionSite: site,
    },
  }));

  return { specimenId: specimen.id, specimenNo: specimen.specimenNo, itemIds };
}
