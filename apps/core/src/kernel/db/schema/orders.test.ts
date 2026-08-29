import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { ACTOR_TYPE_NAMES, orderItemTransitions, orderItems, orders, patients, services } from "./index";
import type { Db } from "../client";

/**
 * PLAN 17 PHASE 0 T1 — migration `0044`'s structural guarantees, each one EXECUTED rather than read
 * out of `information_schema`. "The constraint exists in `pg_constraint`" proves nothing about what
 * Postgres will do with a row; the `0012` immutability test says so in as many words and
 * `patient-identity.test.ts` follows it. Every assertion below issues the real statement.
 *
 * THE ONE EXCEPTION IS DELIBERATE AND IS NOT A HEDGE: the two `actor_type` parity assertions read
 * `pg_get_constraintdef` and compare it to `ACTOR_TYPE_NAMES`. That is not "does Postgres refuse
 * this row" — it is "do the SQL copy and the TypeScript copy of the `Actor` union still agree",
 * which is a question about DRIFT and has no row that can be inserted to ask it (spike S2).
 */
describe("the order envelope — 0044 structure", () => {
  const PATIENT = "01PATIENT0000000000000001";
  const SERVICE = "01SERVICE0000000000000001";

  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(patients).values({
      id: PATIENT, uhid: "HMS-00000001-5", name: "Asha Devi",
      sex: "female", administrativeGender: "female", createdBy: "u1", updatedBy: "u1",
    });
    await db.insert(services).values({
      id: SERVICE, code: "CBC", name: "Complete blood count", category: "investigation",
      createdBy: "u1", updatedBy: "u1",
    });
  });

  const order = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: "01ORDER00000000000000001",
    orderNo: "L2608290001",
    orderGroupId: "01GROUP00000000000000001",
    kind: "lab",
    patientId: PATIENT,
    encounterNo: "V2608290001",
    serviceDate: "2026-08-29",
    priority: "routine",
    authority: "clinician",
    orderedByType: "user",
    orderedById: "u1",
    orderingClinicianId: "u1",
    placedAt: new Date("2026-08-29T04:00:00.000Z"),
    ...over,
  });

  const item = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: "01ITEM000000000000000001",
    orderId: "01ORDER00000000000000001",
    serviceId: SERVICE,
    ...over,
  });

  /** Inserts a valid header so an ITEM assertion is testing the item's own constraint, not the FK. */
  async function withHeader(over: Record<string, unknown> = {}): Promise<void> {
    await db.insert(orders).values(order(over) as never);
  }

  describe("orders — the header's CHECKs, each refused by Postgres", () => {
    it("accepts the valid header this file's other assertions are the negative of", async () => {
      await withHeader();
      const [row] = await db.select().from(orders);
      expect(row!.status).toBe("open");      // the column default, not a value any caller passed
      expect(row!.closedAt).toBeNull();
    });

    it("refuses a priority outside routine/urgent/stat", async () => {
      await expect(db.insert(orders).values(order({ priority: "asap" }) as never))
        .rejects.toThrow(/orders_priority_ck/);
    });

    it("refuses an authority outside the four DD6 names", async () => {
      await expect(db.insert(orders).values(order({ authority: "verbal" }) as never))
        .rejects.toThrow(/orders_authority_ck/);
    });

    it("refuses a header status outside open/closed/cancelled", async () => {
      await expect(db.insert(orders).values(order({ status: "in_progress", closedAt: new Date() }) as never))
        .rejects.toThrow(/orders_status_ck/);
    });

    /**
     * S2's whole point: a fifth actor name is refused by the DATABASE, so a caller that bypasses
     * `placeOrder` entirely still cannot stamp an order with an actor type the system does not have.
     */
    it("refuses an ordered_by_type that is not one of the four actor names", async () => {
      await expect(db.insert(orders).values(order({ orderedByType: "kiosk" }) as never))
        .rejects.toThrow(/orders_ordered_by_type_ck/);
    });

    it("refuses an external referrer on a clinician order — BOTH directions of the biconditional", async () => {
      await expect(db.insert(orders).values(order({ externalReferrerId: "01PARTNER000000000000001" }) as never))
        .rejects.toThrow(/orders_external_referrer_ck/);
      // ...and an external_prescription with no referrer, which is the direction that would leave
      // 02 §1's commission ledger with a walk-in it can attribute to nobody.
      await expect(db.insert(orders).values(order({ authority: "external_prescription" }) as never))
        .rejects.toThrow(/orders_external_referrer_ck/);
    });

    it("refuses a protocol order with no protocol_ref, and a protocol_ref on any other authority", async () => {
      await expect(db.insert(orders).values(order({ authority: "protocol", orderedByType: "system" }) as never))
        .rejects.toThrow(/orders_protocol_ref_ck/);
      await expect(db.insert(orders).values(order({ protocolRef: "reflex-7" }) as never))
        .rejects.toThrow(/orders_protocol_ref_ck/);
    });

    it("refuses an open header carrying a closed_at, and a closed header carrying none", async () => {
      await expect(db.insert(orders).values(order({ closedAt: new Date() }) as never))
        .rejects.toThrow(/orders_closed_at_ck/);
      await expect(db.insert(orders).values(order({ status: "closed" }) as never))
        .rejects.toThrow(/orders_closed_at_ck/);
    });

    it("refuses a second order with the same order_no — the UNIQUE the counter depends on", async () => {
      await withHeader();
      await expect(db.insert(orders).values(order({ id: "01ORDER00000000000000002" }) as never))
        .rejects.toThrow(/order_no/);
    });

    it("refuses an order for a patient that does not exist", async () => {
      await expect(db.insert(orders).values(order({ patientId: "no-such-patient" }) as never))
        .rejects.toThrow(/patient_id/);
    });
  });

  describe("order_items — the item's CHECKs", () => {
    beforeEach(async () => withHeader());

    it("defaults a new item to placed/direct and unrestricted", async () => {
      await db.insert(orderItems).values(item() as never);
      const [row] = await db.select().from(orderItems);
      expect([row!.status, row!.origin, row!.restricted]).toEqual(["placed", "direct", false]);
    });

    it("refuses an item status outside the four envelope states", async () => {
      await expect(db.insert(orderItems).values(item({ status: "accessioned" }) as never))
        .rejects.toThrow(/order_items_status_ck/);
    });

    it("refuses an origin outside direct/addon/reflex/duplicate_confirmed", async () => {
      await expect(db.insert(orderItems).values(item({ origin: "manual" }) as never))
        .rejects.toThrow(/order_items_origin_ck/);
    });

    it("refuses a cancelled_from that is not a state an item can be cancelled FROM", async () => {
      await expect(db.insert(orderItems).values(
        item({ status: "cancelled", cancelledFrom: "completed", cancelReason: "x" }) as never,
      )).rejects.toThrow(/order_items_cancelled_from_ck/);
    });

    /**
     * DD5 / 02 §5 B6, and it is the CHECK half of T4's A2: cancelling an item that had already
     * STARTED without saying why is refused by Postgres, not merely by `advanceOrderItem`. O-4's
     * money rule ("the charge stands if it was analysed") reads `cancelled_from` and would have
     * nothing to read.
     */
    it("refuses cancellation from in_progress with no reason — the DD5 CHECK", async () => {
      await expect(db.insert(orderItems).values(
        item({ status: "cancelled", cancelledFrom: "in_progress" }) as never,
      )).rejects.toThrow(/order_items_cancel_reason_ck/);
      // ...and accepts it once the reason is there.
      await db.insert(orderItems).values(
        item({ status: "cancelled", cancelledFrom: "in_progress", cancelReason: "haemolysed" }) as never,
      );
      expect(await db.select().from(orderItems)).toHaveLength(1);
    });

    it("accepts cancellation from placed with no reason — nothing was consumed", async () => {
      await db.insert(orderItems).values(item({ status: "cancelled", cancelledFrom: "placed" }) as never);
      expect(await db.select().from(orderItems)).toHaveLength(1);
    });

    it("refuses a duplicate pointer with no reason, and a reason with no pointer (D11)", async () => {
      await expect(db.insert(orderItems).values(item({ duplicateOfItemId: "01ITEM000000000000000009" }) as never))
        .rejects.toThrow(/order_items_duplicate_ck/);
      await expect(db.insert(orderItems).values(item({ duplicateReason: "clinically required repeat" }) as never))
        .rejects.toThrow(/order_items_duplicate_ck/);
    });

    /**
     * CLOSE REVIEW (MINOR 13) — `0045`. `cancelled` and `cancelled_from` are ONE fact. Before this,
     * `insert … (status='cancelled')` with everything else null passed every constraint, and 02
     * O-4's money rule — which decides whether the charge stands by reading `cancelled_from` —
     * would have had a row it cannot interpret. `order_items_cancel_reason_ck` does not cover it:
     * that one fires only once `cancelled_from` is already `'in_progress'`.
     */
    it("refuses a cancelled item with no cancelled_from, and a cancelled_from on a live item (0045)", async () => {
      await expect(db.insert(orderItems).values(item({ status: "cancelled" }) as never))
        .rejects.toThrow(/order_items_cancelled_shape_ck/);
      await expect(db.insert(orderItems).values(item({ status: "placed", cancelledFrom: "placed" }) as never))
        .rejects.toThrow(/order_items_cancelled_shape_ck/);
    });

    it("refuses an item whose service is not in the tariff", async () => {
      await expect(db.insert(orderItems).values(item({ serviceId: "no-such-service" }) as never))
        .rejects.toThrow(/service_id/);
    });
  });

  describe("order_item_transitions — the CHECKs and the append-only trigger (DD12)", () => {
    beforeEach(async () => {
      await withHeader();
      await db.insert(orderItems).values(item() as never);
    });

    const transition = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
      id: "01TRANS00000000000000001",
      itemId: "01ITEM000000000000000001",
      fromStatus: "placed",
      toStatus: "in_progress",
      actorType: "user",
      actorId: "u1",
      ...over,
    });

    it("refuses a from/to status outside the four envelope states", async () => {
      await expect(db.insert(orderItemTransitions).values(transition({ fromStatus: "queued" }) as never))
        .rejects.toThrow(/order_item_transitions_from_ck/);
      await expect(db.insert(orderItemTransitions).values(transition({ toStatus: "resulted" }) as never))
        .rejects.toThrow(/order_item_transitions_to_ck/);
    });

    it("refuses an actor_type that is not one of the four", async () => {
      await expect(db.insert(orderItemTransitions).values(transition({ actorType: "analyzer" }) as never))
        .rejects.toThrow(/order_item_transitions_actor_type_ck/);
    });

    it("REFUSES AN UPDATE — the trigger, not a convention", async () => {
      await db.insert(orderItemTransitions).values(transition() as never);
      await expect(
        db.execute(sql`update order_item_transitions set note = 'rewritten'`),
      ).rejects.toThrow(/order_envelope_immutable/);
    });

    it("REFUSES A DELETE — an audit row that can be removed is not an audit row", async () => {
      await db.insert(orderItemTransitions).values(transition() as never);
      await expect(
        db.execute(sql`delete from order_item_transitions`),
      ).rejects.toThrow(/order_envelope_immutable/);
      expect(await db.select().from(orderItemTransitions)).toHaveLength(1);
    });
  });

  describe("the header's identity columns are frozen after insert (DD12)", () => {
    beforeEach(async () => withHeader());

    it.each([
      ["order_no", sql`update orders set order_no = 'L2608290999'`],
      ["kind", sql`update orders set kind = 'imaging'`],
      ["encounter_no", sql`update orders set encounter_no = 'V2608290002'`],
      ["ordered_by_type", sql`update orders set ordered_by_type = 'system'`],
      ["ordered_by_id", sql`update orders set ordered_by_id = 'u2'`],
    ])("refuses a change to %s", async (_column, statement) => {
      await expect(db.execute(statement)).rejects.toThrow(/order_identity_immutable/);
    });

    /**
     * THE TRIGGER MUST NOT FREEZE WHAT THE ENVELOPE'S OWN MACHINE MOVES. `advanceOrderItem` closes
     * a header, so a trigger that refused `status` would make the phase's central write path
     * impossible — a mistake that would only surface at T4.
     */
    /**
     * CLOSE REVIEW (MAJOR 10) — `0045` adds these two to the trigger. They ARE the commission
     * ledger's attribution (02 §1), and they move together cleanly enough to satisfy every CHECK:
     * `authority='external_prescription'` + a referrer id passes `orders_external_referrer_ck`'s
     * biconditional and `orders_authority_ck`, so nothing refused it — turning a completed clinician
     * order into a referral fee after the fact, with no audit row, because `order_item_transitions`
     * records ITEM moves and never header edits.
     */
    it.each([
      ["authority + external_referrer_id together — the attribution",
        sql`update orders set authority = 'external_prescription', external_referrer_id = '01PARTNER000000000000001'`],
      ["authority alone", sql`update orders set authority = 'protocol', protocol_ref = 'r1'`],
    ])("refuses a change to %s (0045)", async (_what, statement) => {
      await expect(db.execute(statement)).rejects.toThrow(/order_identity_immutable/);
    });

    /**
     * `ordering_clinician_id` is deliberately NOT frozen, and the omission is a decision: it is the
     * RESPONSIBLE clinician, and a genuine correction — the wrong doctor was named on a CT — has to
     * stay possible. Asserted so the boundary is pinned rather than assumed.
     */
    it("PERMITS a correction to ordering_clinician_id — naming the wrong doctor must be fixable", async () => {
      await db.execute(sql`update orders set ordering_clinician_id = 'dr-correct'`);
      expect((await db.select().from(orders))[0]!.orderingClinicianId).toBe("dr-correct");
    });

    it("PERMITS the moves the envelope itself makes — status and closed_at", async () => {
      await db.execute(sql`update orders set status = 'closed', closed_at = now()`);
      const [row] = await db.select().from(orders);
      expect(row!.status).toBe("closed");
    });

    /**
     * S6b: the patients merge uses NO GUC (`set_config`/`current_setting` appear nowhere in
     * `apps/core/src`), so DD12's merge exemption has no mechanism to hang on and `patient_id` is
     * left mutable rather than frozen behind a GUC this repository does not use. E8 still holds
     * because `order_no` is frozen: a printed label keeps its number through any merge.
     */
    it("PERMITS a patient_id re-link — the merge path (02 A4 / E8), which uses no GUC today", async () => {
      await db.insert(patients).values({
        id: "01PATIENT0000000000000002", uhid: "HMS-00000002-3", name: "Asha D.",
        sex: "female", administrativeGender: "female", createdBy: "u1", updatedBy: "u1",
      });
      await db.execute(sql`update orders set patient_id = '01PATIENT0000000000000002'`);
      const [row] = await db.select().from(orders);
      expect(row!.patientId).toBe("01PATIENT0000000000000002");
      expect(row!.orderNo).toBe("L2608290001");
    });
  });

  /**
   * ═══ THE DRIFT ASSERTION (S2) ═══
   *
   * There is no `actor_type` CHECK anywhere else in this repository, so these two are the first
   * SQL copy of the `Actor` union rather than the second. `ACTOR_TYPE_NAMES` is the TypeScript
   * copy and is itself pinned to the union by a `Record<Actor["type"], true>` in `orders.ts` —
   * widening the union breaks typecheck there. THIS closes the other end: it reads what Postgres
   * actually holds and fails if the migration and the union have parted company.
   */
  it.each(["orders_ordered_by_type_ck", "order_item_transitions_actor_type_ck"])(
    "%s lists exactly the Actor union's four members, and no others",
    async (constraint) => {
      const [{ def }] = (await db.execute(
        sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = ${constraint}`,
      )).rows as [{ def: string }];
      const quoted = [...def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
      expect([...quoted].sort()).toEqual([...ACTOR_TYPE_NAMES].sort());
    },
  );
});
