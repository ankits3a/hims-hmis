import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { deskAndLabel, seedLabDeskBase, serviceIdForLabCode, uhidOf } from "../../../test/helpers/lab";
import { withTx } from "../../kernel/db/client";
import {
  events, invoiceLines, labItems, labSpecimenItems, labSpecimens, orderItems,
} from "../../kernel/db/schema";
import { advanceOrderItem } from "../../kernel/orders/advance";
import { deskOrder } from "./desk";
import { receive, reject } from "./accession";
import { printLabels } from "./specimens";
import { collect } from "./collection";
import { LabError } from "./errors";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 17a T5 — COLLECTION AND ACCESSION. Assertion Book rows **A3, A5, A6, A7, A9**.
 * (A1 and A2 are the concurrency rows and live in `accession.concurrency.test.ts`;
 * A4 and A8 are the sweeps and live in `sweeps.test.ts`.)
 */
describe("lab accession (17a T5)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => { await truncateAll(db); fx = await seedLabDeskBase(db); });
  afterEach(() => { fx.unregister(); });

  const eventsNamed = async (name: string) =>
    db.select().from(events).where(eq(events.name, name));

  /* ───────────── A5 — THE RIGHT-PATIENT SCAN, BEFORE ANY ROW EXISTS ───────────── */

  it("A5: a wrong scan refuses tube_mismatch, flags it, and writes NO lab_specimens row", async () => {
    /**
     * Ordered but NOT labelled — `deskAndLabel` prints, and a second print of the same group is
     * refused `no_active_order` by the active-tube guard long before the scan is looked at. The
     * first version of this test used it and passed for the wrong reason; the assertion below on
     * the FLAG is what caught that, which is why it asserts the event and not just the throw.
     */
    const placed = await withTx(db, (tx) => deskOrder(tx, fx.desk.actor, fx.decls, {
      patientId: fx.patientId, encounterNo: fx.encounterNo, serviceDate: fx.serviceDate,
      orderingClinicianId: fx.pathologist.id, credit: { reason: "counter" },
      items: [{ serviceId: serviceIdForLabCode("CBC") }],
    }));
    /** A second registration of "Ram Kumar" — E1, the case every lab has had. */
    const otherUhid = await uhidOf(db, fx.mergedLoserId);
    const before = (await db.select().from(labSpecimens)).length;

    await expect(printLabels(db, fx.bench.actor, {
      orderGroupId: placed.orderGroupId, scannedUhid: otherUhid,
    })).rejects.toMatchObject({ code: "tube_mismatch" });

    /** THE ROW THE MUTANT MOVES: a labelled tube for the wrong person must not exist, ever. */
    expect((await db.select().from(labSpecimens)).length).toBe(before);
    const flags = await eventsNamed("lab.tube_mismatch_flagged");
    expect(flags).toHaveLength(1);
    expect((flags[0]!.payload as { scannedUhid: string }).scannedUhid).toBe(otherUhid);
  });

  /* ───────────── A6 — AN UNSCANNED DRAW NEEDS A NAMED RE-CHECK ───────────── */

  it("A6: an unscanned ward collection cannot be received without identityRecheckBy", async () => {
    const placed = await deskAndLabel(db, fx, ["CBC"], { wristbandScanned: false });
    const specimenNo = placed.specimens[0]!.specimenNo;

    await expect(withTx(db, (tx) => receive(tx, fx.bench.actor, fx.decls, { specimenNo })))
      .rejects.toMatchObject({ code: "identity_recheck_required" });

    const [before] = await db.select().from(labSpecimens).where(eq(labSpecimens.specimenNo, specimenNo));
    expect(before!.status).toBe("collected");

    await withTx(db, (tx) => receive(tx, fx.bench.actor, fx.decls, {
      specimenNo, identityRecheckBy: fx.pathologist.id,
    }));
    const [row] = await db.select().from(labItems).where(eq(labItems.orderItemId, placed.itemIds[0]!));
    /** Stored, not merely required: "somebody checked" that names nobody is not a control. */
    expect(row!.identityRecheckBy).toBe(fx.pathologist.id);
  });

  /* ───────────── A7 — THE TAT CLOCK STARTS AT RECEIVE ───────────── */

  it("A7: the TAT clock starts at receive — not at placement and not at collection", async () => {
    const placed = await deskAndLabel(db, fx, ["CBC"]);
    const [beforeReceive] = await db.select().from(labItems)
      .where(eq(labItems.orderItemId, placed.itemIds[0]!));
    expect(beforeReceive!.tatStartedAt).toBeNull();

    const RECEIVED_AT = new Date("2026-08-29T09:50:00+05:30");
    await withTx(db, (tx) => receive(tx, fx.bench.actor, fx.decls, {
      specimenNo: placed.specimens[0]!.specimenNo,
    }, RECEIVED_AT));

    const [row] = await db.select().from(labItems).where(eq(labItems.orderItemId, placed.itemIds[0]!));
    expect(row!.tatStartedAt?.toISOString()).toBe(RECEIVED_AT.toISOString());

    /** DD4's FIRST projection point: the lab's `accessioned` becomes the envelope's `in_progress`. */
    const [item] = await db.select().from(orderItems).where(eq(orderItems.id, placed.itemIds[0]!));
    expect(item!.status).toBe("in_progress");
    expect(await eventsNamed("lab.specimen_received")).toHaveLength(1);
    expect(await eventsNamed("order_item.started")).toHaveLength(1);
  });

  it("A7: a second receive of the same tube is refused already_received", async () => {
    const placed = await deskAndLabel(db, fx, ["CBC"]);
    const specimenNo = placed.specimens[0]!.specimenNo;
    await withTx(db, (tx) => receive(tx, fx.bench.actor, fx.decls, { specimenNo }));
    await expect(withTx(db, (tx) => receive(tx, fx.bench.actor, fx.decls, { specimenNo })))
      .rejects.toMatchObject({ code: "already_received" });
    expect(await eventsNamed("lab.specimen_received")).toHaveLength(1);
  });

  /* ───────────── A3 — A RECOLLECTION COSTS THE PATIENT NOTHING ───────────── */

  it("A3: rejecting and redrawing posts ZERO additional charge and leaves the invoice line untouched", async () => {
    const placed = await deskAndLabel(db, fx, ["CBC"]);
    const [beforeItem] = await db.select().from(labItems)
      .where(eq(labItems.orderItemId, placed.itemIds[0]!));
    const invoiceId = beforeItem!.invoiceId!;
    const lineId = beforeItem!.invoiceLineId!;
    const linesBefore = (await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId))).length;

    const redrawn = await withTx(db, (tx) => reject(tx, fx.bench.actor, {
      specimenNo: placed.specimens[0]!.specimenNo,
      reason: "haemolysed",
      attributableTo: "collection",
    }));

    /** A NEW tube with its own `S` number — DD5: the history of which tubes a test rode is kept. */
    expect(redrawn.specimenNo).not.toBe(placed.specimens[0]!.specimenNo);
    expect(redrawn.specimenNo).toMatch(/^S\d{10}$/);

    const uhid = await uhidOf(db, fx.patientId);
    await withTx(db, (tx) => collect(tx, fx.bench.actor, {
      specimenId: redrawn.specimenId, wristbandScanned: true,
    }));
    await withTx(db, (tx) => receive(tx, fx.bench.actor, fx.decls, { specimenNo: redrawn.specimenNo }));
    void uhid;

    /** THE MONEY CLAIM: one line, still the same one. The lab dropped the tube; the patient did not. */
    const linesAfter = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
    expect(linesAfter).toHaveLength(linesBefore);
    const [afterItem] = await db.select().from(labItems)
      .where(eq(labItems.orderItemId, placed.itemIds[0]!));
    expect(afterItem!.invoiceLineId).toBe(lineId);
    expect(afterItem!.invoiceId).toBe(invoiceId);

    /** Exactly one ACTIVE tube per item, and it is the replacement (`lab_specimen_items_active_ux`). */
    const active = await db.select().from(labSpecimenItems)
      .where(eq(labSpecimenItems.orderItemId, placed.itemIds[0]!));
    expect(active.filter((a) => a.active)).toHaveLength(1);
    expect(active.filter((a) => a.active)[0]!.specimenId).toBe(redrawn.specimenId);
    expect(await eventsNamed("lab.recollection_requested")).toHaveLength(1);
    expect(await eventsNamed("lab.specimen_rejected")).toHaveLength(1);
  });

  /* ───────────── A9 — A TUBE WHOSE EVERY ITEM IS CANCELLED ───────────── */

  it("A9: receiving a tube whose every item is cancelled refuses no_active_order and writes no transition", async () => {
    const placed = await deskAndLabel(db, fx, ["CBC", "LFT"]);
    for (const itemId of placed.itemIds) {
      await withTx(db, (tx) => advanceOrderItem(tx, fx.bench.actor, fx.decls, itemId, "cancelled", {
        reason: "patient left",
      }));
    }
    const transitionsBefore = (await eventsNamed("order_item.started")).length;

    /** Every tube the group produced — a CBC rides EDTA and an LFT an SST, so there are two. */
    for (const specimen of placed.specimens) {
      await expect(withTx(db, (tx) => receive(tx, fx.bench.actor, fx.decls, {
        specimenNo: specimen.specimenNo,
      }))).rejects.toMatchObject({ code: "no_active_order" });
    }

    /**
     * The mutant receives anyway and `advanceOrderItem` throws `illegal_transition` from
     * `cancelled` — the bench then sees a raw state-machine error instead of "nobody is waiting
     * for this any more", and 24a is written against the named refusal.
     */
    expect((await eventsNamed("order_item.started")).length).toBe(transitionsBefore);
    for (const specimen of placed.specimens) {
      const [row] = await db.select().from(labSpecimens)
        .where(eq(labSpecimens.specimenNo, specimen.specimenNo));
      expect(row!.status).toBe("collected");
      expect(row!.receivedAt).toBeNull();
    }
  });

  it("A9's neighbour: a PARTIALLY cancelled tube is still received, for the items that live", async () => {
    const placed = await deskAndLabel(db, fx, ["CBC", "ESR"]);
    /** CBC and ESR both ride EDTA, so this is ONE tube carrying two items. */
    expect(placed.specimens).toHaveLength(1);
    await withTx(db, (tx) => advanceOrderItem(tx, fx.bench.actor, fx.decls, placed.itemIds[0]!, "cancelled", {
      reason: "duplicate",
    }));

    const result = await withTx(db, (tx) => receive(tx, fx.bench.actor, fx.decls, {
      specimenNo: placed.specimens[0]!.specimenNo,
    }));
    expect(result.itemIds).toEqual([placed.itemIds[1]]);
    const [cancelled] = await db.select().from(orderItems).where(eq(orderItems.id, placed.itemIds[0]!));
    expect(cancelled!.status).toBe("cancelled");
    const [live] = await db.select().from(orderItems).where(eq(orderItems.id, placed.itemIds[1]!));
    expect(live!.status).toBe("in_progress");
  });

  /* ───────────── The container check (02 G8) ───────────── */

  it("the bench refuses a tube that is not in the container the catalogue asked for (02 G8)", async () => {
    const placed = await deskAndLabel(db, fx, ["CBC"]);
    await expect(withTx(db, (tx) => receive(tx, fx.bench.actor, fx.decls, {
      specimenNo: placed.specimens[0]!.specimenNo, containerSeen: "sst",
    }))).rejects.toMatchObject({ code: "specimen_not_receivable" });
  });

  it("one tube per (specimen_type, container) across the whole group", async () => {
    /** CBC + ESR are EDTA; LFT is SST. Three tests, TWO tubes — not three, and not one. */
    const placed = await deskAndLabel(db, fx, ["CBC", "ESR", "LFT"], { draw: false });
    expect(placed.specimens).toHaveLength(2);
    const containers = (await db.select().from(labSpecimens)).map((s) => s.container).sort();
    expect(containers).toEqual(["edta", "sst"]);
    const serviceIds = placed.itemIds;
    expect(serviceIds).toHaveLength(3);
    void serviceIdForLabCode;
  });
});
