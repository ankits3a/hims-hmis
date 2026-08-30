import { eq, sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { deskAndLabel, seedLabDeskBase, serviceIdForLabCode, uhidOf } from "../../../test/helpers/lab";
import { mkUser } from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import {
  creditNotes, events, labItems, labSlaBreaches, labSpecimenItems, orderItems, orders,
  workflowInstances,
} from "../../kernel/db/schema";
import { advanceOrderItem } from "../../kernel/orders/advance";
import { deskOrder } from "./desk";
import { printLabels } from "./specimens";
import { LabError } from "./errors";
import { receive, reject } from "./accession";
import { collectionQueue } from "./collection";
import { NON_RETURN_DAYS, sweepLabNonReturn, sweepLabSla } from "./sweeps";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 17a T5 — THE TWO WORKER SWEEPS. Assertion Book rows **A4 and A8**, plus the queue ordering.
 *
 * ═══ THE CLOCK IS INJECTED, WHICH IS WHY A4 IS TESTABLE AT ALL (spike S10) ═══
 *
 * `scheduler.ts` types a job as `(now: Date) => Promise<void>` and `sweepBatchExpiry` is `(db, now)`,
 * so both sweeps take the instant as a parameter and A4's seven-day boundary is TWO CALLS WITH TWO
 * INSTANTS. The alternative — waiting seven days — is not a test, and §2.127 forbids inventing a
 * test-only clock when the shipped signature already has the seam.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

describe("the lab worker sweeps (17a T5)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => { await truncateAll(db); fx = await seedLabDeskBase(db); });
  afterEach(() => { fx.unregister(); });

  /** Back-dates the `recollection_pending` state so the sweep sees an age without a seven-day wait. */
  async function ageRecollection(itemId: string, ms: number): Promise<void> {
    const [item] = await db.select().from(labItems).where(eq(labItems.orderItemId, itemId));
    await db
      .update(workflowInstances)
      .set({ stateEnteredAt: sql`now() - ${sql.raw(`interval '${Math.round(ms / 1000)} seconds'`)}` })
      .where(eq(workflowInstances.id, item!.instanceId));
  }

  /* ─────────────────── A4 — THE SEVEN-DAY NON-RETURN BOUNDARY ─────────────────── */

  it("A4: a rejection at -7d 1h is cancelled with a credit note; one at -6d 23h is untouched", async () => {
    const stale = await deskAndLabel(db, fx, ["CBC"]);
    await withTx(db, (tx) => reject(tx, fx.bench.actor, {
      specimenNo: stale.specimens[0]!.specimenNo, reason: "clotted", attributableTo: "collection",
    }));
    const fresh = await deskAndLabel(db, fx, ["LFT"]);
    await withTx(db, (tx) => reject(tx, fx.bench.actor, {
      specimenNo: fresh.specimens[0]!.specimenNo, reason: "haemolysed", attributableTo: "collection",
    }));

    await ageRecollection(stale.itemIds[0]!, NON_RETURN_DAYS * DAY_MS + HOUR_MS);
    await ageRecollection(fresh.itemIds[0]!, NON_RETURN_DAYS * DAY_MS - HOUR_MS);

    const report = await sweepLabNonReturn(db, new Date(), fx.decls);

    /** EXACTLY ONE cancellation. An off-by-one on the comparator takes both or neither. */
    expect(report.cancelled.map((c) => c.orderItemId)).toEqual([stale.itemIds[0]]);
    const [cancelled] = await db.select().from(orderItems).where(eq(orderItems.id, stale.itemIds[0]!));
    expect(cancelled!.status).toBe("cancelled");
    expect(cancelled!.cancelReason).toBe("no_recollection");

    const [untouched] = await db.select().from(orderItems).where(eq(orderItems.id, fresh.itemIds[0]!));
    expect(untouched!.status).toBe("placed");

    /** DD7 — the money goes back. The hospital charged at the desk and is not going to do the test. */
    expect(report.creditNotes).toHaveLength(1);
    expect(await db.select().from(creditNotes)).toHaveLength(1);

    /** The replacement tube is withdrawn with the item: nobody is going to draw it. */
    const links = await db.select().from(labSpecimenItems)
      .where(eq(labSpecimenItems.orderItemId, stale.itemIds[0]!));
    expect(links.filter((l) => l.active)).toHaveLength(0);
  }, 180_000);

  it("A4: the sweep is a no-op when nothing has been waiting long enough", async () => {
    const placed = await deskAndLabel(db, fx, ["CBC"]);
    await withTx(db, (tx) => reject(tx, fx.bench.actor, {
      specimenNo: placed.specimens[0]!.specimenNo, reason: "leaked", attributableTo: "transport",
    }));
    const report = await sweepLabNonReturn(db, new Date(), fx.decls);
    expect(report).toEqual({ cancelled: [], creditNotes: [], failed: [] });
    expect(await db.select().from(creditNotes)).toHaveLength(0);
  });

  it("A4: a sweep run TWICE cancels once — the item is no longer pending on the second pass", async () => {
    const placed = await deskAndLabel(db, fx, ["CBC"]);
    await withTx(db, (tx) => reject(tx, fx.bench.actor, {
      specimenNo: placed.specimens[0]!.specimenNo, reason: "clotted", attributableTo: "lab",
    }));
    await ageRecollection(placed.itemIds[0]!, NON_RETURN_DAYS * DAY_MS + HOUR_MS);

    const first = await sweepLabNonReturn(db, new Date(), fx.decls);
    const second = await sweepLabNonReturn(db, new Date(), fx.decls);
    expect(first.cancelled).toHaveLength(1);
    expect(second.cancelled).toHaveLength(0);
    /** One credit note, not two — a patient refunded twice is a hole in the other direction. */
    expect(await db.select().from(creditNotes)).toHaveLength(1);
  }, 180_000);

  /* ─────────────────── A8 — THE SLA SWEEP EMITS ONCE ─────────────────── */

  it("A8: a breached item is emitted ONCE across two sweeps, and never for a cancelled item", async () => {
    const breaching = await deskAndLabel(db, fx, ["CBC"], { draw: false });
    const cancelledOne = await deskAndLabel(db, fx, ["LFT"], { draw: false });

    /** Both sat in `awaiting_collection` far longer than its 120-minute SLA. */
    await ageRecollection(breaching.itemIds[0]!, 10 * HOUR_MS);
    await ageRecollection(cancelledOne.itemIds[0]!, 10 * HOUR_MS);
    await withTx(db, (tx) => advanceOrderItem(tx, fx.bench.actor, fx.decls, cancelledOne.itemIds[0]!, "cancelled", {
      reason: "patient left",
    }));

    const now = new Date();
    const first = await sweepLabSla(db, now);
    const second = await sweepLabSla(db, now);

    expect(first.breached.map((b) => b.orderItemId)).toEqual([breaching.itemIds[0]]);
    /**
     * THE SECOND SWEEP SAYS NOTHING, and the mechanism is T1's `lab_sla_breaches_item_stage_ux`
     * rather than a cursor this sweep maintains — which is what makes it safe on two workers.
     */
    expect(second.breached).toEqual([]);
    expect(await db.select().from(events).where(eq(events.name, "lab.sla_breached"))).toHaveLength(1);
    expect(await db.select().from(labSlaBreaches)).toHaveLength(1);

    /** A withdrawn order is not a missed turnaround, and paging a pathologist about one mutes the channel. */
    const rows = await db.select().from(labSlaBreaches);
    expect(rows[0]!.orderItemId).toBe(breaching.itemIds[0]);
  }, 180_000);

  it("A8: an item inside its SLA is not breached, and the SAME item breaches again in a NEW stage", async () => {
    const placed = await deskAndLabel(db, fx, ["CBC"], { draw: false });
    expect((await sweepLabSla(db, new Date())).breached).toEqual([]);

    await ageRecollection(placed.itemIds[0]!, 10 * HOUR_MS);
    expect((await sweepLabSla(db, new Date())).breached).toHaveLength(1);

    /** Move it on, age it again: `(item, stage)` is the key, so a new stage is a new breach. */
    const [row] = await db.select().from(labItems).where(eq(labItems.orderItemId, placed.itemIds[0]!));
    await db.update(workflowInstances)
      .set({ currentState: "collected", stateEnteredAt: new Date(Date.now() - 10 * HOUR_MS) })
      .where(eq(workflowInstances.id, row!.instanceId));

    const again = await sweepLabSla(db, new Date());
    expect(again.breached.map((b) => b.stage)).toEqual(["collected"]);
    expect(await db.select().from(labSlaBreaches)).toHaveLength(2);
  }, 180_000);

  /* ─────────────────── The phlebotomy queue's ordering (E18) ─────────────────── */

  it("the collection queue puts STAT ahead of urgent ahead of routine (E18)", async () => {
    await deskAndLabel(db, fx, ["CBC"], { draw: false, priority: "routine" });
    await deskAndLabel(db, fx, ["LFT"], { draw: false, priority: "stat" });
    await deskAndLabel(db, fx, ["RFT"], { draw: false, priority: "urgent" });

    const queue = await collectionQueue(db, fx.bench.actor, { serviceDate: fx.serviceDate });
    /** A text sort returns routine < stat < urgent and puts the emergency LAST. */
    expect(queue.map((q) => q.priority)).toEqual(["stat", "urgent", "routine"]);
    expect(queue.every((q) => /^S\d{10}$/.test(q.specimenNo))).toBe(true);
    expect(queue.every((q) => q.encounterNo === fx.encounterNo)).toBe(true);
  }, 120_000);

  /* ───── CLOSE REVIEW PASS 1, MAJOR 3 — THE WORKLIST IS A BULK PHI READ ───── */

  it("MAJOR 3: the collection queue requires lab.worklist.read and refuses a non-user actor", async () => {
    await deskAndLabel(db, fx, ["CBC"], { draw: false });
    /**
     * The ENVELOPE's refusals, not a borrowed lab code (pass 2, finding 5): `actor_cannot_read` and
     * `permission_denied` are what `kernel/orders/read.ts` uses for exactly these two gates, and
     * they carry 403 rather than the 409 "re-read and retry" the first remediation served.
     */
    await expect(collectionQueue(db, { type: "system", id: "some-job" }, { serviceDate: fx.serviceDate }))
      .rejects.toMatchObject({ code: "actor_cannot_read" });
    /** A real user holding nothing is refused by permission, not served. */
    const nobody = await mkUser(db, "holds.nothing", []);
    await expect(collectionQueue(db, nobody.actor, { serviceDate: fx.serviceDate }))
      .rejects.toMatchObject({ code: "permission_denied" });
  }, 120_000);

  it("MAJOR 3: a restricted test's CODE is omitted from the worklist, and the tube still appears", async () => {
    await withTx(db, (tx) => deskOrder(tx, fx.desk.actor, fx.decls, {
      patientId: fx.patientId, encounterNo: fx.encounterNo, serviceDate: fx.serviceDate,
      orderingClinicianId: fx.pathologist.id, credit: { reason: "counter" },
      items: [{ serviceId: serviceIdForLabCode("HIV"), consent: { recordedBy: fx.desk.id } }],
    }));
    const uhid = await uhidOf(db, fx.patientId);
    const groups = await db.select().from(orders);
    await printLabels(db, fx.bench.actor, { orderGroupId: groups[0]!.orderGroupId, scannedUhid: uhid });

    const queue = await collectionQueue(db, fx.bench.actor, { serviceDate: fx.serviceDate });
    /** THE TUBE IS STILL THERE — a phlebotomist must draw it; dropping the row breaks the clinic. */
    expect(queue).toHaveLength(1);
    expect(queue[0]!.specimenNo).toMatch(/^S\d{10}$/);
    /** AND THE TEST NAME IS NOT: the existence of the HIV test is the sensitive fact (DD11). */
    expect(queue[0]!.orderableCodes).toEqual([]);
  }, 120_000);

  /**
   * ═══ PASS 2, FINDING 1 — THE OMISSION MUST NOT BE COUNTABLE ═══
   *
   * The first remediation filtered restricted codes out and left `itemIds` beside them, so
   * `orderableCodes.length < itemIds.length` proved a restricted test existed — the
   * `hasHiddenItems` boolean the kernel deleted, rebuilt from two fields. A row carrying a
   * restricted test must be INDISTINGUISHABLE from one that does not.
   */
  it("PASS 2 finding 1: a restricted row is indistinguishable from an unrestricted one", async () => {
    await withTx(db, (tx) => deskOrder(tx, fx.desk.actor, fx.decls, {
      patientId: fx.patientId, encounterNo: fx.encounterNo, serviceDate: fx.serviceDate,
      orderingClinicianId: fx.pathologist.id, credit: { reason: "counter" },
      items: [{ serviceId: serviceIdForLabCode("HIV"), consent: { recordedBy: fx.desk.id } }],
    }));
    await withTx(db, (tx) => deskOrder(tx, fx.desk.actor, fx.decls, {
      patientId: fx.otherPatientId, encounterNo: fx.otherEncounterNo, serviceDate: fx.serviceDate,
      orderingClinicianId: fx.pathologist.id, credit: { reason: "counter" },
      items: [{ serviceId: serviceIdForLabCode("CBC") }],
    }));
    for (const group of await db.select().from(orders)) {
      const uhid = await uhidOf(db, group.patientId);
      await printLabels(db, fx.bench.actor, { orderGroupId: group.orderGroupId, scannedUhid: uhid });
    }

    const queue = await collectionQueue(db, fx.bench.actor, { serviceDate: fx.serviceDate });
    expect(queue).toHaveLength(2);
    /**
     * NEITHER row carries a code — not "the restricted one is empty and the other is not", which is
     * the difference a reader counts. The bench holds `lab.worklist.read` and not
     * `orders.read.restricted`, which `seed-roles.ts` grants to no lab role by owner ruling.
     */
    expect(queue.map((q) => q.orderableCodes)).toEqual([[], []]);
    /** And the length relation that WAS the oracle now holds identically on both rows. */
    expect(queue.map((q) => q.orderableCodes.length - q.itemIds.length)).toEqual([-1, -1]);
  }, 180_000);

  it("a drawn tube leaves the collection queue", async () => {
    const placed = await deskAndLabel(db, fx, ["CBC"]);
    const queue = await collectionQueue(db, fx.bench.actor, { serviceDate: fx.serviceDate });
    expect(queue.map((q) => q.specimenNo)).not.toContain(placed.specimens[0]!.specimenNo);
    await withTx(db, (tx) => receive(tx, fx.bench.actor, fx.decls, {
      specimenNo: placed.specimens[0]!.specimenNo,
    }));
    expect(await collectionQueue(db, fx.bench.actor, { serviceDate: fx.serviceDate })).toEqual([]);
  });
});
