import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  grantLabResultPermissions, seedLabDeskBase, serviceIdForLabCode, uhidOf,
} from "../../../test/helpers/lab";
import { mkUser } from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import {
  events, labAnalytes, labItems, labResults, labSpecimenItems, orderItems, orders, tariffItems,
  workflowInstances,
} from "../../kernel/db/schema";
import { receive } from "./accession";
import { collect } from "./collection";
import { deskOrder } from "./desk";
import { duplicateWarnings } from "./duplicates";
import { enterResult } from "./results";
import { printLabels } from "./specimens";
import { isSingleOperatorNight, verifyResult } from "./verify";
import { activateTshReflex } from "./verify.test.helpers";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * PLAN 17b T6 — **THE SIGNATURE**. Assertion Book rows **A1, A3, A4, A4b, A9**.
 * (A2, the two-verifier race, is `verify.concurrency.test.ts`; A5–A8 are `results.test.ts`.)
 *
 * ═══ DAY AND NIGHT ARE INJECTED INSTANTS, NOT A FLAG ═══
 *
 * `verifyResult` derives single-operator night mode from the clock in IST (§9.2 F34), so every row
 * below hands it an explicit `now`: 06:00 UTC is 11:30 IST — the middle of a working day — and
 * 20:00 UTC is 01:30 IST. A test that let the wall clock decide would pass or fail depending on
 * when CI happened to run, which is the one property a separation-of-duties assertion must not have.
 */
const DAY = new Date("2026-08-30T06:00:00Z");
const NIGHT = new Date("2026-08-30T20:00:00Z");

describe("lab results — verification, SoD and reflex (17b T6)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;
  /** The one-person night lab: `pathologist` AND `lab_technician`, and therefore both permissions. */
  let solo: { id: string; actor: Actor };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedLabDeskBase(db);
    await grantLabResultPermissions(db, fx);
    solo = await mkUser(db, "dr.night", ["pathologist", "lab_technician"]);
  });
  afterEach(() => { fx.unregister(); });

  /* ─────────────────────────────── the shared helpers ─────────────────────────────── */

  async function resultable(
    codes: readonly string[],
    opts: { reflexConsent?: boolean; at?: Date } = {},
  ): Promise<{ orderId: string; orderGroupId: string; itemIds: string[]; specimenIds: string[] }> {
    const now = opts.at ?? DAY;
    const serviceIds = codes.map((c) => serviceIdForLabCode(c));
    const warnings = await withTx(db, (tx) =>
      duplicateWarnings(tx, fx.desk.actor, fx.patientId, serviceIds, now));
    const placed = await withTx(db, (tx) => deskOrder(tx, fx.desk.actor, fx.decls, {
      patientId: fx.patientId, encounterNo: fx.encounterNo, serviceDate: fx.serviceDate,
      orderingClinicianId: fx.pathologist.id,
      items: serviceIds.map((serviceId) => ({ serviceId })),
      credit: { reason: "counter order" },
      reflexConsent: opts.reflexConsent,
      acknowledgedDuplicates: warnings.map((w) => w.duplicateOfItemId),
      placedAt: now,
    }, now));
    const { specimens } = await printLabels(db, fx.bench.actor, {
      orderGroupId: placed.orderGroupId, scannedUhid: await uhidOf(db, fx.patientId),
    }, now);
    for (const s of specimens) {
      await withTx(db, (tx) => collect(tx, fx.bench.actor, { specimenId: s.specimenId, wristbandScanned: true }, now));
      await withTx(db, (tx) => receive(tx, fx.bench.actor, fx.decls, { specimenNo: s.specimenNo }, now));
    }
    return {
      orderId: placed.orderId, orderGroupId: placed.orderGroupId, itemIds: placed.itemIds,
      specimenIds: specimens.map((s) => s.specimenId),
    };
  }

  const analyteIdFor = async (code: string): Promise<string> =>
    (await db.select({ id: labAnalytes.id }).from(labAnalytes).where(eq(labAnalytes.code, code)))[0]!.id;

  const eventsNamed = async (name: string) =>
    db.select().from(events).where(eq(events.name, name));

  const enter = async (itemId: string, code: string, value: string, actor: Actor, at = DAY) =>
    withTx(db, (tx) => enterResult(tx, actor, {
      orderItemId: itemId, analyteId: analyteIds.get(code)!, value, entryMode: "manual",
    }, at));

  /** Cached per test: `analyteIdFor` in a loop is 16 round-trips for one CBC. */
  let analyteIds: Map<string, string>;
  beforeEach(async () => {
    const rows = await db.select({ code: labAnalytes.code, id: labAnalytes.id }).from(labAnalytes);
    analyteIds = new Map(rows.map((r) => [r.code, r.id] as const));
  });

  /* ═════════════ A1 — SEPARATION OF DUTIES IS PER RESULT ROW, NOT PER ROLE ═════════════ */

  it("A1: one user holding BOTH permissions cannot sign their own number by day", async () => {
    const { itemIds } = await resultable(["TSH"]);
    const entered = await enter(itemIds[0]!, "TSH", "2.0", solo.actor);

    await expect(verifyResult(db, solo.actor, fx.decls, { resultId: entered.resultId }, DAY))
      .rejects.toMatchObject({ code: "sod_violation" });

    const [row] = await db.select().from(labResults).where(eq(labResults.id, entered.resultId));
    expect([row!.verificationStatus, row!.verifiedBy]).toEqual(["unverified", null]);

    /**
     * ═══ THE REFUSAL IS EVENTED, AND IT SURVIVED THE ROLLBACK (F20's shape) ═══
     *
     * NABL asks how often the single-operator path was used. `verifyResult` is `Db`-first for
     * exactly this: appended on the transaction that the throw rolls back, this row would not exist.
     */
    const blocked = await eventsNamed("lab.sod_violation_blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.payload).toMatchObject({ actorId: solo.id, enteredById: solo.id });
  });

  it("A1: night mode releases the same result, flagged for the morning queue, and events NO refusal", async () => {
    expect([isSingleOperatorNight(DAY), isSingleOperatorNight(NIGHT)]).toEqual([false, true]);

    const { itemIds } = await resultable(["TSH"], { at: NIGHT });
    const entered = await enter(itemIds[0]!, "TSH", "2.0", solo.actor, NIGHT);

    const out = await verifyResult(db, solo.actor, fx.decls, { resultId: entered.resultId }, NIGHT);
    expect(out.pathologistReviewPending).toBe(true);

    const [row] = await db.select().from(labResults).where(eq(labResults.id, entered.resultId));
    expect([row!.verificationStatus, row!.verifiedBy, row!.pathologistReviewPending])
      .toEqual(["verified", solo.id, true]);
    expect(await eventsNamed("lab.sod_violation_blocked")).toHaveLength(0);
  });

  it("a DIFFERENT verifier signs by day, and the row carries no morning-queue flag", async () => {
    const { itemIds } = await resultable(["TSH"]);
    const entered = await enter(itemIds[0]!, "TSH", "2.0", fx.bench.actor);
    const out = await verifyResult(db, fx.pathologist.actor, fx.decls, { resultId: entered.resultId }, DAY);
    expect(out.pathologistReviewPending).toBe(false);
    const verified = await eventsNamed("lab.result_verified");
    expect(verified).toHaveLength(1);
    /** 17c pass 1 F4 — the review flag is the ROW's (asserted above); the payload rides `lab:bench` and carries ids only. */
    expect(verified[0]!.payload).toMatchObject({ verifiedBy: fx.pathologist.id });
    expect(verified[0]!.payload).not.toHaveProperty("pathologistReviewPending");
  });

  /* ══════════ A3 — `completed` FIRES WHEN THE LAST ANALYTE IS SIGNED, NEVER EARLIER ══════════ */

  it("A3: a three-analyte panel stays in_progress after two signatures and completes on the third", async () => {
    /** TFT reports exactly three analytes — TSH, FT3, FT4 — which is A3's shape in the fixture. */
    const { itemIds } = await resultable(["TFT"]);
    const item = itemIds[0]!;
    const ids: string[] = [];
    for (const [code, value] of [["TSH", "2.0"], ["FT3", "3.1"], ["FT4", "1.2"]] as const) {
      ids.push((await enter(item, code, value, fx.bench.actor)).resultId);
    }

    for (const resultId of ids.slice(0, 2)) {
      const out = await verifyResult(db, fx.pathologist.actor, fx.decls, { resultId }, DAY);
      expect(out.itemCompleted).toBe(false);
    }
    let [envelope] = await db.select({ status: orderItems.status })
      .from(orderItems).where(eq(orderItems.id, item));
    expect(envelope!.status).toBe("in_progress");

    const last = await verifyResult(db, fx.pathologist.actor, fx.decls, { resultId: ids[2]! }, DAY);
    expect(last.itemCompleted).toBe(true);
    [envelope] = await db.select({ status: orderItems.status })
      .from(orderItems).where(eq(orderItems.id, item));
    expect(envelope!.status).toBe("completed");

    /** The transitions row names the VERIFIER, not the system and not the enterer. */
    const completed = await eventsNamed("order_item.completed");
    expect(completed).toHaveLength(1);
    expect([completed[0]!.actorType, completed[0]!.actorId]).toEqual(["user", fx.pathologist.id]);

    const [instance] = await db.select({ state: workflowInstances.currentState })
      .from(workflowInstances).where(eq(workflowInstances.subjectId, item));
    expect(instance!.state).toBe("verified");
  });

  /* ══════════════════ A4 / A4b — THE SYNCHRONOUS REFLEX (DD8) ══════════════════ */

  it("A4: verifying TSH 9.0 places ONE reflex order in the same group, billed and on the same tube", async () => {
    await activateTshReflex(db);
    const { orderId, orderGroupId, itemIds, specimenIds } = await resultable(["TSH"], { reflexConsent: true });
    const parent = itemIds[0]!;
    const entered = await enter(parent, "TSH", "9.0", fx.bench.actor);

    const out = await verifyResult(db, fx.pathologist.actor, fx.decls, { resultId: entered.resultId }, DAY);
    expect(out.reflex).toHaveLength(1);
    const placed = out.reflex[0]!;

    const [reflexOrder] = await db.select().from(orders).where(eq(orders.id, placed.orderId));
    expect([
      reflexOrder!.orderGroupId, reflexOrder!.orderedByType, reflexOrder!.authority,
      reflexOrder!.protocolRef, reflexOrder!.orderingClinicianId,
    ]).toEqual([orderGroupId, "system", "protocol", placed.ruleId, fx.pathologist.id]);
    expect(reflexOrder!.id).not.toBe(orderId);

    const [reflexItem] = await db.select().from(orderItems).where(eq(orderItems.id, placed.orderItemId));
    expect([reflexItem!.origin, reflexItem!.parentItemId, reflexItem!.status])
      .toEqual(["reflex", parent, "in_progress"]);

    const [labItem] = await db.select().from(labItems).where(eq(labItems.orderItemId, placed.orderItemId));
    expect(labItem!.chargeReason).toBe("lab_reflex");
    expect(labItem!.invoiceId).toBe(placed.invoiceId);
    expect(labItem!.invoiceId).not.toBeNull();
    expect(labItem!.tatStartedAt).not.toBeNull();

    /** IT RIDES THE TUBE THAT IS ALREADY ON THE BENCH — no second needle for a reflex. */
    const [link] = await db.select().from(labSpecimenItems)
      .where(eq(labSpecimenItems.orderItemId, placed.orderItemId));
    expect([link!.specimenId, link!.active]).toEqual([specimenIds[0]!, true]);

    const added = await eventsNamed("lab.reflex_added");
    expect(added).toHaveLength(1);
    expect(added[0]!.payload).toMatchObject({ parentItemId: parent, triggerResultId: entered.resultId });
  });

  it("A4b: no consent ⇒ no reflex; and a re-examined trigger does not place it twice", async () => {
    await activateTshReflex(db);

    /** Leg 1 — the rule fires and the ITEM carries no order-time consent. */
    const noConsent = await resultable(["TSH"], { reflexConsent: false });
    const entered = await enter(noConsent.itemIds[0]!, "TSH", "9.0", fx.bench.actor);
    const out = await verifyResult(db, fx.pathologist.actor, fx.decls, { resultId: entered.resultId }, DAY);
    expect(out.reflex).toEqual([]);
    expect(await eventsNamed("lab.reflex_added")).toHaveLength(0);
    /** The whole order set is unchanged: one order, one item. */
    expect(await db.select().from(orders).where(eq(orders.orderGroupId, noConsent.orderGroupId))).toHaveLength(1);

    /** Leg 2 — consent given, verified once, then a SECOND analyte of the same panel verified. */
    const consented = await resultable(["TFT"], { reflexConsent: true, at: new Date(DAY.getTime() + 3600_000) });
    const item = consented.itemIds[0]!;
    const tsh = await enter(item, "TSH", "9.0", fx.bench.actor);
    const ft3 = await enter(item, "FT3", "3.0", fx.bench.actor);
    await verifyResult(db, fx.pathologist.actor, fx.decls, { resultId: tsh.resultId }, DAY);
    const second = await verifyResult(db, fx.pathologist.actor, fx.decls, { resultId: ft3.resultId }, DAY);
    expect(second.reflex).toEqual([]);
    expect(await eventsNamed("lab.reflex_added")).toHaveLength(1);
  });

  it("an INACTIVE rule places nothing, whatever the value — the catalogue ships all three off", async () => {
    const { itemIds, orderGroupId } = await resultable(["TSH"], { reflexConsent: true });
    const entered = await enter(itemIds[0]!, "TSH", "9.0", fx.bench.actor);
    const out = await verifyResult(db, fx.pathologist.actor, fx.decls, { resultId: entered.resultId }, DAY);
    expect(out.reflex).toEqual([]);
    expect(await db.select().from(orders).where(eq(orders.orderGroupId, orderGroupId))).toHaveLength(1);
  });

  /* ══════════════════ THE CLOSE REVIEW'S FIXES, PINNED ══════════════════ */

  it("C4: two pathologists signing the LAST TWO analytes still complete the item, exactly once", async () => {
    const { itemIds } = await resultable(["TFT"]);
    const item = itemIds[0]!;
    const ids: string[] = [];
    for (const [code, value] of [["TSH", "2.0"], ["FT3", "3.1"], ["FT4", "1.2"]] as const) {
      ids.push((await enter(item, code, value, fx.bench.actor)).resultId);
    }
    /** One signed, two outstanding — the state the race needs. */
    await verifyResult(db, fx.pathologist.actor, fx.decls, { resultId: ids[0]! }, DAY);

    /**
     * ═══ WITHOUT THE ORDER LOCK, NEITHER TRANSACTION SAW THE OTHER'S ANALYTE ═══
     *
     * Each counted its own uncommitted write plus the other still `unverified`, so BOTH returned
     * false and `advanceOrderItem(… 'completed')` never ran. The item then sat on the verify queue
     * for ever with every value signed and no button that could clear it — a second verify throws
     * `already_verified` and `publishReport` refuses "not finished" permanently, with no recovery
     * through any shipped route.
     */
    const settled = await Promise.allSettled([
      verifyResult(db, fx.pathologist.actor, fx.decls, { resultId: ids[1]! }, DAY),
      verifyResult(db, fx.pathologist.actor, fx.decls, { resultId: ids[2]! }, DAY),
    ]);
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(settled.filter((r) => r.status === "fulfilled" && r.value.itemCompleted)).toHaveLength(1);

    const [envelope] = await db.select({ status: orderItems.status })
      .from(orderItems).where(eq(orderItems.id, item));
    expect(envelope!.status).toBe("completed");
    /** EXACTLY ONE completion event: two would make the immutability story lie. */
    expect(await eventsNamed("order_item.completed")).toHaveLength(1);
  });

  it("M1: a reflex whose invoice cannot be raised does NOT hold the signature", async () => {
    await activateTshReflex(db);
    /**
     * THE ORDINARY GO-LIVE GAP: the reflexed test has no tariff price, because the counter never
     * SELLS it and nobody noticed. `issueInvoice` throws `TariffError` inside the verifying
     * transaction, which used to roll the VERIFICATION back — so every TSH with reflex consent was
     * unsignable, `listResultsForEncounter` showed the treating doctor nothing, and the error named
     * a test the pathologist never ordered. **Money held a clinical fact**, which is 02 O-1 inverted.
     */
    const tft = serviceIdForLabCode("TFT");
    await db.delete(tariffItems).where(eq(tariffItems.serviceId, tft));

    const { itemIds, orderGroupId } = await resultable(["TSH"], { reflexConsent: true });
    const entered = await enter(itemIds[0]!, "TSH", "9.0", fx.bench.actor);

    const out = await verifyResult(db, fx.pathologist.actor, fx.decls, { resultId: entered.resultId }, DAY);

    /** THE SIGNATURE STANDS. */
    const [row] = await db.select().from(labResults).where(eq(labResults.id, entered.resultId));
    expect(row!.verificationStatus).toBe("verified");
    expect(out.itemCompleted).toBe(true);

    /** THE REFLEX DID NOT LAND, and the refusal is REPORTED rather than swallowed. */
    expect(out.reflex).toEqual([]);
    expect(out.reflexRefused).toHaveLength(1);
    expect(out.reflexRefused[0]).toMatchObject({ addedServiceId: tft, code: "tariff_item_missing" });
    expect(await db.select().from(orders).where(eq(orders.orderGroupId, orderGroupId))).toHaveLength(1);
  });

  /* ═════════════ A9 — A `system` ACTOR IS REFUSED, AND THE SEAM IS CLOSED ═════════════ */

  it("A9: a system actor is refused user_actor_required, and no permission lookup is attempted", async () => {
    const { itemIds } = await resultable(["TSH"]);
    const entered = await enter(itemIds[0]!, "TSH", "2.0", fx.bench.actor);
    await expect(verifyResult(db, { type: "system", id: "auto-verify" }, fx.decls, {
      resultId: entered.resultId,
    }, DAY)).rejects.toMatchObject({ code: "user_actor_required" });
    const [row] = await db.select().from(labResults).where(eq(labResults.id, entered.resultId));
    expect(row!.verificationStatus).toBe("unverified");
  });

  it("refuses already_verified on a second signature, and permission_denied without the grant", async () => {
    const { itemIds } = await resultable(["TSH"]);
    const entered = await enter(itemIds[0]!, "TSH", "2.0", fx.bench.actor);

    await expect(verifyResult(db, fx.bench.actor, fx.decls, { resultId: entered.resultId }, DAY))
      .rejects.toMatchObject({ code: "permission_denied" });

    await verifyResult(db, fx.pathologist.actor, fx.decls, { resultId: entered.resultId }, DAY);
    await expect(verifyResult(db, fx.pathologist.actor, fx.decls, { resultId: entered.resultId }, DAY))
      .rejects.toMatchObject({ code: "already_verified" });
  });
});
