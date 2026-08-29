import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { deactivateLabDepartment, seedLabDeskBase, serviceIdForLabCode, UNPRICED_LAB_CODE } from "../../../test/helpers/lab";
import { withTx } from "../../kernel/db/client";
import { events } from "../../kernel/db/schema";
import { labItems, opdDepartments, opdDoctors, opdEncounters, orderItems, orders } from "../../kernel/db/schema";
import { invoices } from "../../kernel/db/schema";
import { withIdempotency } from "../billing";
import { BillingError } from "../billing";
import { openLabWalkin } from "../opd";
import { addOnOrder, advisedTestItems, deskOrder } from "./desk";
import { LabError } from "./errors";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { DeskOrderInput } from "./desk";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 17a T4 — THE DESK. Assertion Book rows A1, A1b, A2, A3, A4, A5, A6, A7, A9.
 * (A8 is the two definitions' own matrix walk and lives in `workflow-def.test.ts`.)
 *
 * **A3 IS FIRST IN THIS FILE BECAUSE IT WAS BUILT FIRST** (§5 T4). The whole one-transaction design
 * rests on `issueInvoice(tx as unknown as Db, …)` nesting as a savepoint that rolls back with its
 * parent; §9.3 proved that against Postgres before `desk.ts` existed, and this row asserts it over
 * the REAL `placeOrder` + `issueInvoice` pair.
 */
const ROUTE = "lab.desk.place";

describe("the lab desk (17a T4)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedLabDeskBase(db);
  });
  afterEach(() => { fx.unregister(); });

  function input(over: Partial<DeskOrderInput> = {}): DeskOrderInput {
    return {
      patientId: fx.patientId,
      encounterNo: fx.encounterNo,
      serviceDate: fx.serviceDate,
      orderingClinicianId: fx.pathologist.id,
      items: [{ serviceId: serviceIdForLabCode("CBC") }],
      credit: { reason: "counter order, paid at collection" },
      ...over,
    } as DeskOrderInput;
  }

  const place = (over: Partial<DeskOrderInput> = {}, actor = fx.desk.actor) =>
    withTx(db, (tx) => deskOrder(tx, actor, fx.decls, input(over)));

  const counts = async () => ({
    orders: (await db.select().from(orders)).length,
    items: (await db.select().from(orderItems)).length,
    labItems: (await db.select().from(labItems)).length,
    invoices: (await db.select().from(invoices)).length,
    placed: (await db.select().from(events).where(eq(events.name, "order.placed"))).length,
    desked: (await db.select().from(events).where(eq(events.name, "lab.order_desked"))).length,
  });

  /* ─────────────────────────── A3 — ONE TRANSACTION ─────────────────────────── */

  it("A3: an invoice failure leaves NO order, NO items and NO order.placed (F7's proof, over the real pair)", async () => {
    /**
     * `TROPI` is a real orderable the fixture deliberately gave no tariff item, so `issueInvoice`
     * throws `tariff_item_missing` INSIDE the savepoint, AFTER `placeOrder` has already inserted the
     * order, its items and its event. A service id the catalogue does not carry would be refused by
     * the desk's own `unknown_service` gate long before the money path and would assert nothing.
     */
    await expect(
      place({ items: [{ serviceId: serviceIdForLabCode("CBC") }, { serviceId: serviceIdForLabCode(UNPRICED_LAB_CODE) }] }),
    ).rejects.toThrow(/tariff_item_missing|no price for/);

    expect(await counts()).toEqual({ orders: 0, items: 0, labItems: 0, invoices: 0, placed: 0, desked: 0 });
  });

  it("A3 (the other direction): the happy path commits placement and invoice together", async () => {
    const result = await place({ items: [{ serviceId: serviceIdForLabCode("CBC") }, { serviceId: serviceIdForLabCode("LFT") }] });
    expect(result.orderNo).toMatch(/^L\d{10}$/);
    expect(result.invoice.invoiceId).toBeTruthy();
    expect(await counts()).toEqual({ orders: 1, items: 2, labItems: 2, invoices: 1, placed: 1, desked: 1 });

    /** Every lab item points at the line that paid for it, and the two lines are DISTINCT. */
    const rows = await db.select().from(labItems);
    const lineIds = rows.map((r) => r.invoiceLineId);
    expect(new Set(lineIds).size).toBe(2);
    expect(lineIds.every((l) => l !== null)).toBe(true);
    expect(rows.every((r) => r.invoiceId === result.invoice.invoiceId)).toBe(true);
    expect(rows.every((r) => r.chargeReason === "lab_desk")).toBe(true);
  });

  /* ───────────────────── A1 / A1b / A2 — IDEMPOTENCY (DD22) ───────────────────── */

  /**
   * DD22: 17a mounts no route, so these call `withIdempotency` — imported from `../billing`, the
   * function 17b's controller will use — directly around `deskOrder`. Wrapping it INSIDE the
   * transaction is the one shape that cannot work: a rolled-back claim protects nothing.
   */
  const desked = (key: string, body: Partial<DeskOrderInput>) =>
    withIdempotency(db, { actorId: fx.desk.id, route: ROUTE, key }, body, () =>
      withTx(db, (tx) => deskOrder(tx, fx.desk.actor, fx.decls, input(body))));

  it("A1: a replay with the same key returns the SAME orderNo and invoiceId, and the database holds one of each", async () => {
    const body = { items: [{ serviceId: serviceIdForLabCode("CBC") }] };
    const first = await desked("k-A1", body);
    const second = await desked("k-A1", body);

    expect(second.orderNo).toBe(first.orderNo);
    expect(second.invoice.invoiceId).toBe(first.invoice.invoiceId);
    const c = await counts();
    expect([c.orders, c.invoices, c.placed]).toEqual([1, 1, 1]);
  });

  /**
   * EIGHT ROUNDS ON ONE FIXTURE, each against a DIFFERENT orderable, counting the DELTA rather than
   * the total. Re-seeding per round costs ~5 s of tariff activation and asserts nothing extra; a
   * different orderable each round is what keeps the duplicate detector out of the measurement,
   * since the same test twice in ten seconds is exactly what it exists to refuse.
   */
  const A1B_CODES = ["CBC", "LFT", "RFT", "LIPID", "TSH", "GLUF", "UPT", "HBSAG"] as const;

  it("A1b: two CONCURRENT calls with one key — exactly one does the work, over 8 rounds", async () => {
    const observed: number[] = [];
    for (const [round, code] of A1B_CODES.entries()) {
      const before = (await db.select().from(orders)).length;
      const body = { items: [{ serviceId: serviceIdForLabCode(code) }] };
      const key = `k-A1b-${round}`;
      const settled = await Promise.allSettled([desked(key, body), desked(key, body)]);
      /**
       * The LOSER may legitimately be a `replay_in_progress` refusal rather than a replayed result:
       * the winner had not committed when the loser looked. What must be true every round is that
       * the DATABASE gained ONE order — that is the claim, and it is what the mutant breaks.
       */
      expect(settled.some((s) => s.status === "fulfilled")).toBe(true);
      observed.push((await db.select().from(orders)).length - before);
    }
    expect(observed).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  }, 180_000);

  it("A2: the same key with a DIFFERENT body is refused, not replayed", async () => {
    await desked("k-A2", { items: [{ serviceId: serviceIdForLabCode("CBC") }] });
    await expect(
      desked("k-A2", { items: [{ serviceId: serviceIdForLabCode("CBC") }, { serviceId: serviceIdForLabCode("LFT") }] }),
    ).rejects.toThrow(BillingError);
    /** One order, and the second basket was never placed — not silently answered with the first. */
    expect((await db.select().from(orders)).length).toBe(1);
  });

  /* ──────────────────────── A4 — THE CONSENT GATE (DD14) ──────────────────────── */

  it("A4: a consent_required orderable without consent is refused BEFORE placeOrder", async () => {
    await expect(place({ items: [{ serviceId: serviceIdForLabCode("HIV") }] }))
      .rejects.toThrow(LabError);
    expect(await counts()).toEqual({ orders: 0, items: 0, labItems: 0, invoices: 0, placed: 0, desked: 0 });
  });

  it("A4: with consent, the item is restricted:true and lab_items records who took it", async () => {
    const result = await place({
      items: [{ serviceId: serviceIdForLabCode("HIV"), consent: { recordedBy: fx.desk.id } }],
    });
    const [item] = await db.select().from(orderItems).where(eq(orderItems.id, result.itemIds[0]!));
    /** One false here and the kernel reader shows an HIV test to the ward clerk — the whole of DD14. */
    expect(item!.restricted).toBe(true);
    const [row] = await db.select().from(labItems).where(eq(labItems.orderItemId, result.itemIds[0]!));
    expect(row!.consentRecordedBy).toBe(fx.desk.id);
    expect(row!.consentRecordedAt).toBeInstanceOf(Date);
  });

  it("A4 (DD11's neighbour): a SENSITIVE orderable that needs no consent is still restricted", async () => {
    const result = await place({ items: [{ serviceId: serviceIdForLabCode("HBSAG") }] });
    const [item] = await db.select().from(orderItems).where(eq(orderItems.id, result.itemIds[0]!));
    expect(item!.restricted).toBe(true);
  });

  /* ───────────────── A5 — THE ADVISED-TESTS CONVERSION IS EXACT ───────────────── */

  it("A5: advised tests convert EXACTLY — same serviceId set, same count, duplicates kept", async () => {
    const advised = [
      { serviceId: serviceIdForLabCode("CBC"), code: "CBC", name: "Complete blood count", pricePaise: 30000 },
      { serviceId: serviceIdForLabCode("LFT"), code: "LFT", name: "Liver function test", pricePaise: 30000 },
      { serviceId: serviceIdForLabCode("CBC"), code: "CBC", name: "Complete blood count", pricePaise: 30000 },
    ];
    const items = advisedTestItems(advised);
    /** A converter that deduped would drop the second glucose a doctor deliberately advised twice. */
    expect(items.map((i) => i.serviceId)).toEqual(advised.map((a) => a.serviceId));
    expect(items).toHaveLength(3);

    const result = await place({ items: items.slice(0, 2), acknowledgedDuplicates: [] });
    const placedItems = await db.select().from(orderItems).where(eq(orderItems.orderId, result.orderId));
    expect(placedItems.map((i) => i.serviceId).sort()).toEqual(advised.slice(0, 2).map((a) => a.serviceId).sort());
    expect(placedItems).toHaveLength(2);
  });

  it("A5: an orphan serviceId refuses with unknown_service NAMING it, and places nothing", async () => {
    const orphan = "LABSVC-DOES-NOT-EXIST";
    await expect(
      place({ items: [{ serviceId: serviceIdForLabCode("CBC") }, { serviceId: orphan }, { serviceId: serviceIdForLabCode("LFT") }] }),
    ).rejects.toThrow(orphan);
    /** Not "two of three placed as advised" — the patient would be billed for a partial basket. */
    expect(await counts()).toEqual({ orders: 0, items: 0, labItems: 0, invoices: 0, placed: 0, desked: 0 });
  });

  /* ─────────────────── A6 — AN ADD-ON IS A NEW ORDER (DD9) ─────────────────── */

  it("A6: an add-on is a NEW order in the SAME group, origin 'addon', and the parent gains no item", async () => {
    const parent = await place({ items: [{ serviceId: serviceIdForLabCode("CBC") }] });
    const parentItemId = parent.itemIds[0]!;

    const added = await withTx(db, (tx) => addOnOrder(tx, fx.desk.actor, fx.decls, {
      parentItemId,
      serviceIds: [serviceIdForLabCode("LFT")],
      orderingClinicianId: fx.pathologist.id,
      credit: { reason: "add-on at the chair" },
    }));

    expect(added.orderId).not.toBe(parent.orderId);
    expect(added.orderGroupId).toBe(parent.orderGroupId);
    expect((await db.select().from(orders))).toHaveLength(2);

    /** THE ROW THE MUTANT MOVES: the parent's own item count must not change. */
    const parentItems = await db.select().from(orderItems).where(eq(orderItems.orderId, parent.orderId));
    expect(parentItems).toHaveLength(1);

    const [addedItem] = await db.select().from(orderItems).where(eq(orderItems.id, added.itemIds[0]!));
    expect(addedItem!.origin).toBe("addon");
    const [addedLabItem] = await db.select().from(labItems).where(eq(labItems.orderItemId, added.itemIds[0]!));
    expect(addedLabItem!.chargeReason).toBe("lab_addon");
    /** E22 — two documents, not one amended one. */
    expect((await db.select().from(invoices))).toHaveLength(2);
  });

  /* ─────────────── A7 — THE WALK-IN'S REFERRER AND THE SENTINEL ─────────────── */

  it("A7: an unattributed walk-in carries the SENTINEL referrer and emits lab.attribution_unverified_flagged", async () => {
    const result = await place({
      authority: "external_prescription",
      referrerName: "illegible stamp",
      chargeReason: "lab_walkin",
    } as Partial<DeskOrderInput>);

    const [order] = await db.select().from(orders).where(eq(orders.id, result.orderId));
    expect(order!.authority).toBe("external_prescription");
    /** The BICONDITIONAL CHECK, not an FK (S3): a null here is a constraint error at the counter. */
    expect(order!.externalReferrerId).toBeTruthy();

    const flags = await db.select().from(events).where(eq(events.name, "lab.attribution_unverified_flagged"));
    expect(flags).toHaveLength(1);
  });

  it("A7: a walk-in whose attribution WAS confirmed is not flagged", async () => {
    await place({
      authority: "external_prescription",
      referrerName: "Dr Sharma, Civil Lines",
      attributionConfirmed: true,
    } as Partial<DeskOrderInput>);
    expect(await db.select().from(events).where(eq(events.name, "lab.attribution_unverified_flagged"))).toHaveLength(0);
  });

  /* ───────────────── A9 — THE WALK-IN VISIT'S TWO PRECONDITIONS ───────────────── */

  it("A9: openLabWalkin opens a V visit in the LAB department under the pathologist of record", async () => {
    const visit = await openLabWalkin(db, fx.desk.actor, { patientId: fx.patientId, referrerName: "Dr Sharma" });
    expect(visit.encounter.visitNo).toMatch(/^V\d{10}$/);
    expect(visit.encounter.departmentId).toBe(fx.labDepartmentId);
    expect(visit.encounter.doctorId).toBe(fx.pathologist.doctorId);
    expect(visit.encounter.referralSource).toBe("external_rmp");
  });

  it("A9: no LAB department refuses with unknown_department and opens no visit", async () => {
    /**
     * Production has twelve departments and no `LAB` (S5), so this is day one's real state. The
     * mutant leaves `department_id` null and the visit OPENS — every downstream `intendedPayer`
     * read and every departmental report silently loses the lab, with nothing failing.
     */
    await db.update(opdDepartments).set({ code: "LABX" }).where(eq(opdDepartments.id, fx.labDepartmentId));
    await expect(openLabWalkin(db, fx.desk.actor, { patientId: fx.patientId }))
      .rejects.toMatchObject({ code: "unknown_department" });
    expect(await db.select().from(opdEncounters)).toHaveLength(0);
  });

  it("A9: an INACTIVE LAB department refuses with department_inactive", async () => {
    await deactivateLabDepartment(db, fx.labDepartmentId);
    await expect(openLabWalkin(db, fx.desk.actor, { patientId: fx.patientId }))
      .rejects.toMatchObject({ code: "department_inactive" });
  });

  it("A9: an inactive pathologist of record refuses with unknown_doctor, naming what is missing", async () => {
    await db.update(opdDoctors).set({ active: false }).where(eq(opdDoctors.id, fx.pathologist.doctorId));
    await expect(openLabWalkin(db, fx.desk.actor, { patientId: fx.patientId }))
      .rejects.toMatchObject({ code: "unknown_doctor" });
  });

  it("A9: two active pathologists refuse rather than let the counter pick one", async () => {
    await db.insert(opdDoctors).values({
      id: newId(), userId: fx.desk.id, departmentId: fx.labDepartmentId,
      displayName: "Dr Second", registrationNo: "MCI/PATH/9002", active: true, createdBy: "t", updatedBy: "t",
    });
    await expect(openLabWalkin(db, fx.desk.actor, { patientId: fx.patientId }))
      .rejects.toMatchObject({ code: "unknown_doctor" });
    /** Naming one is what unblocks it — the medico-legal chain wants a person, not a row order. */
    const visit = await openLabWalkin(db, fx.desk.actor, { patientId: fx.patientId, doctorId: fx.pathologist.doctorId });
    expect(visit.encounter.doctorId).toBe(fx.pathologist.doctorId);
  });
});
