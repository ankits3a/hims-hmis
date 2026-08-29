import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { grantPermissionToRole, syncPermissions } from "../auth/permissions";
import { ModuleRegistry } from "../modules/loader";
import {
  events, orderItemTransitions, orderItems, orders, patients, registrationConfig, services,
} from "../db/schema";
import { withTx } from "../db/client";
import { registerEncounterResolver } from "../episodes/encounter-resolvers";
import { advanceOrderItem } from "./advance";
import { OrderError } from "./errors";
import { ORDERS_PLACE, placeOrder } from "./place";
import { ORDER_ITEM_TRANSITIONS, isLegalItemTransition } from "./transitions";
import type { OrderKindDecl } from "./kinds";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../db/client";
import type { OrderItemStatus } from "../db/schema/orders";

/**
 * PLAN 17 PHASE 0 T4 — the four-state compare-and-set machine, cancellation, and the header close.
 */
const LAB_PLACE = "lab.orders.place";
const labDecl: OrderKindDecl = {
  kind: "lab", seriesKey: "lab_order", placePermission: LAB_PLACE,
  requiresClinician: false, requiresIndication: false, selfOrderable: false,
};
const packageDecl: OrderKindDecl = {
  kind: "package", seriesKey: "lab_order", placePermission: LAB_PLACE,
  requiresClinician: false, requiresIndication: false, selfOrderable: true,
};
const DECLS = [labDecl, packageDecl];

describe("advanceOrderItem (Plan 17 phase 0 T4)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let unregister: () => void;
  let tech: Actor;

  const PATIENT = "01PATIENT0000000000000001";
  const VISIT = "V2608290001";
  const S1 = "01SERVICE0000000000000001";
  const S2 = "01SERVICE0000000000000002";
  const DAY = "2026-08-29";

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    await db.insert(patients).values({
      id: PATIENT, uhid: "HMS-00000001-5", name: "Asha Devi", sex: "female",
      administrativeGender: "female", createdBy: "t", updatedBy: "t",
    });
    await db.insert(services).values([
      { id: S1, code: "CBC", name: "Complete blood count", category: "investigation", createdBy: "t", updatedBy: "t" },
      { id: S2, code: "LFT", name: "Liver function", category: "investigation", createdBy: "t", updatedBy: "t" },
    ]);
    unregister = registerEncounterResolver("V", async (_db, no) =>
      no === VISIT ? { patientId: PATIENT, intendedPayer: "self" } : null);

    const registry = new ModuleRegistry();
    registry.install({ key: "orders", title: "Orders", menu: [], permissions: [ORDERS_PLACE], subscriptions: [] });
    registry.install({ key: "lab", title: "Lab", menu: [], permissions: [LAB_PLACE], subscriptions: [] });
    await syncPermissions(db, registry);
    await ensureRole(db, "lab_tech");
    await grantPermissionToRole(db, registry, "lab_tech", ORDERS_PLACE);
    await grantPermissionToRole(db, registry, "lab_tech", LAB_PLACE);
    ({ actor: tech } = await mkUser(db, "lab.tech", ["lab_tech"]));
  });

  afterEach(() => { unregister(); });

  /** An order of `kind` with one item per service given. Returns the ids in the order supplied. */
  async function order(
    serviceIds: readonly string[] = [S1],
    kind = "lab",
    actor: Actor = tech,
  ): Promise<{ orderId: string; itemIds: string[] }> {
    const { orderId, itemIds } = await withTx(db, (tx) =>
      placeOrder(tx, actor, DECLS, {
        kind, patientId: PATIENT, encounterNo: VISIT, serviceDate: DAY,
        items: serviceIds.map((serviceId) => ({ serviceId })),
      }));
    return { orderId, itemIds };
  }

  const advance = (actor: Actor, itemId: string, to: OrderItemStatus, opts = {}) =>
    withTx(db, (tx) => advanceOrderItem(tx, actor, DECLS, itemId, to, opts));

  async function codeOf(promise: Promise<unknown>): Promise<string> {
    try { await promise; } catch (error) {
      expect(error).toBeInstanceOf(OrderError);
      return (error as OrderError).code;
    }
    throw new Error("expected advanceOrderItem to refuse, and it did not");
  }

  it("moves placed → in_progress → completed, stamping each instant", async () => {
    const { itemIds } = await order();
    await advance(tech, itemIds[0]!, "in_progress");
    const mid = (await db.select().from(orderItems))[0]!;
    expect(mid.status).toBe("in_progress");
    expect(mid.startedAt).not.toBeNull();
    expect(mid.completedAt).toBeNull();
    await advance(tech, itemIds[0]!, "completed");
    const done = (await db.select().from(orderItems))[0]!;
    expect(done.status).toBe("completed");
    expect(done.completedAt).not.toBeNull();
    // The start instant is not overwritten by the completion — `undefined` in the SET, not `null`.
    expect(done.startedAt).not.toBeNull();
  });

  it("refuses an item id that does not exist", async () => {
    expect(await codeOf(advance(tech, "01ITEM000000000000000009", "in_progress"))).toBe("unknown_item");
  });

  // ───────────────────────────────── A1 — the closed table ─────────────────────────────────

  it("A1 — completed → in_progress is refused; a published result's item does not reopen", async () => {
    const { itemIds } = await order();
    await advance(tech, itemIds[0]!, "in_progress");
    await advance(tech, itemIds[0]!, "completed");
    expect(await codeOf(advance(tech, itemIds[0]!, "in_progress"))).toBe("illegal_transition");
  });

  it("A1b — placed → completed skips the machine and is refused", async () => {
    const { itemIds } = await order();
    expect(await codeOf(advance(tech, itemIds[0]!, "completed"))).toBe("illegal_transition");
  });

  it("A1c — the exported table is exactly the four edges, and nothing else is legal", async () => {
    expect(ORDER_ITEM_TRANSITIONS.map((t) => `${t.from}→${t.to}`)).toEqual([
      "placed→in_progress", "in_progress→completed", "placed→cancelled", "in_progress→cancelled",
    ]);
    const all: OrderItemStatus[] = ["placed", "in_progress", "completed", "cancelled"];
    const legal = all.flatMap((f) => all.filter((t) => isLegalItemTransition(f, t)).map((t) => `${f}→${t}`));
    expect(legal.sort()).toEqual([
      "in_progress→cancelled", "in_progress→completed", "placed→cancelled", "placed→in_progress",
    ]);
  });

  // ─────────────────────────── A2 — the reason, guarded and CHECKed ───────────────────────────

  /**
   * A2's first half. The refusal is an `OrderError`, not a Postgres constraint error, which is what
   * says the GUARD fired — the UPDATE never ran. T1's schema suite proves the second half
   * independently: `order_items_cancel_reason_ck` refuses the same row on a direct insert.
   */
  it("A2 — cancelling from in_progress with no reason is refused by the GUARD", async () => {
    const { itemIds } = await order();
    await advance(tech, itemIds[0]!, "in_progress");
    expect(await codeOf(advance(tech, itemIds[0]!, "cancelled"))).toBe("cancel_reason_required");
    // Nothing was written: the item is untouched and no transitions row was added for the attempt.
    expect((await db.select().from(orderItems))[0]!.status).toBe("in_progress");
    expect(await db.select().from(orderItemTransitions)).toHaveLength(1);
  });

  it("A2b — with a reason it is accepted, and cancelled_from records the stage it left", async () => {
    const { itemIds } = await order();
    await advance(tech, itemIds[0]!, "in_progress");
    await advance(tech, itemIds[0]!, "cancelled", { reason: "haemolysed" });
    const row = (await db.select().from(orderItems))[0]!;
    expect([row.status, row.cancelledFrom, row.cancelReason]).toEqual(["cancelled", "in_progress", "haemolysed"]);
  });

  it("A2c — cancelling from placed needs no reason; nothing was consumed", async () => {
    const { itemIds } = await order();
    await advance(tech, itemIds[0]!, "cancelled");
    const row = (await db.select().from(orderItems))[0]!;
    expect([row.status, row.cancelledFrom, row.cancelReason]).toEqual(["cancelled", "placed", null]);
  });

  // ───────────────────────── A3 — the compare-and-set, under a real race ─────────────────────────

  /**
   * A3 / E5 — a cancellation racing the analyzer's start. Both transactions read `placed`; the
   * second blocks on the row lock and its UPDATE re-evaluates `status = 'placed'` against the
   * committed row, matches nothing, and answers `stale_state`. A read-then-write would let both
   * succeed and leave the item `cancelled` WITH a `started_at`, with the analyzer running a tube
   * nobody will report.
   */
  /**
   * ═══ A3 — MEASURED, NOT ENGINEERED (AGENT-RULES §2.3) ═══
   *
   * The plan's A3 predicted that the loser of a start-versus-cancel race gets `stale_state`. **It
   * gets one of THREE correct refusals, and which one depends on where the two transactions
   * interleave** — a fact this test discovered by running rather than by reasoning:
   *
   *   · the loser READ before the winner committed → it validated against `placed`, its CAS matched
   *     nothing, and it answers **`stale_state`**. This is the CAS doing its job.
   *   · the loser READ after the winner committed a START → it sees `in_progress`, so
   *     `in_progress → cancelled` is a LEGAL edge that needs a reason, and it answers
   *     **`cancel_reason_required`**;
   *   · the loser READ after the winner committed a CANCEL → `cancelled → in_progress` is not in
   *     the table at all, and it answers **`illegal_transition`**.
   *
   * All three are correct and none of them is the defect A3 exists to catch. **The invariant that
   * holds on EVERY interleaving is the one worth asserting, and it is the stronger claim:** exactly
   * one call succeeds, the loser writes NOTHING, and the item ends with the winner's stamps and
   * only the winner's. The read-then-write mutant fails that on any interleaving — both succeed,
   * the item is `cancelled` carrying a `started_at`, and two transitions rows exist for one item.
   *
   * The rate at which the CAS itself is the discriminator is REPORTED rather than asserted at a
   * threshold, because the window is the scheduler's and engineering it would be measuring
   * something else. Observed on this host: see the phase document's §9.4.
   */
  it("A3 — a start/cancel race has exactly ONE winner and the loser writes nothing, every round", async () => {
    const ROUNDS = 12;
    const codes: string[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      const { itemIds } = await order();
      const id = itemIds[0]!;
      const results = await Promise.allSettled([
        advance(tech, id, "in_progress"),
        advance(tech, id, "cancelled"),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(loser.reason).toBeInstanceOf(OrderError);
      codes.push((loser.reason as OrderError).code);

      // THE LOSER WROTE NOTHING: one transitions row for this item, and one set of stamps.
      const rows = await db.select().from(orderItemTransitions).where(eq(orderItemTransitions.itemId, id));
      expect(rows).toHaveLength(1);
      const [item] = await db.select().from(orderItems).where(eq(orderItems.id, id));
      if (item!.status === "in_progress") {
        expect([item!.cancelledAt, item!.cancelledFrom]).toEqual([null, null]);
      } else {
        expect(item!.status).toBe("cancelled");
        expect(item!.startedAt).toBeNull();
      }
    }
    // Every refusal is one of the three the interleaving admits — never a fourth, never a success.
    expect(codes.every((c) => ["stale_state", "cancel_reason_required", "illegal_transition"].includes(c))).toBe(true);
    // eslint-disable-next-line no-console
    console.log(`A3 observed refusals over ${ROUNDS} rounds:`, codes.reduce<Record<string, number>>(
      (acc, c) => ({ ...acc, [c]: (acc[c] ?? 0) + 1 }), {}));
  });

  /**
   * A3b — THE SEQUENTIAL CASE, and it is the distinction the plan's A3 conflated.
   *
   * `stale_state` is reachable ONLY under true concurrency. A caller who repeats a move
   * sequentially re-reads the CURRENT state, so `from` is whatever the item is NOW — and the
   * transition table catches it first. There is no path by which a sequential caller validates
   * against a state the row has already left. Asserting `stale_state` here (as the first draft of
   * this test did) would have been asserting something unreachable.
   */
  it("A3b — repeating a move sequentially is caught by the TABLE, not by the CAS", async () => {
    const { itemIds } = await order();
    await advance(tech, itemIds[0]!, "in_progress");
    expect(await codeOf(advance(tech, itemIds[0]!, "in_progress"))).toBe("illegal_transition");
  });

  // ───────────────────────────── A4 — when the header closes ─────────────────────────────

  it("A4 — the header stays open while a sibling is still live, and closes on the last one", async () => {
    const { orderId, itemIds } = await order([S1, S2]);
    await advance(tech, itemIds[0]!, "in_progress");
    const first = await advance(tech, itemIds[0]!, "completed");
    expect(first.headerClosedAs).toBeNull();
    expect((await db.select().from(orders).where(eq(orders.id, orderId)))[0]!.status).toBe("open");

    await advance(tech, itemIds[1]!, "in_progress");
    const last = await advance(tech, itemIds[1]!, "completed");
    expect(last.headerClosedAs).toBe("closed");
    const header = (await db.select().from(orders).where(eq(orders.id, orderId)))[0]!;
    expect(header.status).toBe("closed");
    expect(header.closedAt).not.toBeNull();
  });

  /**
   * A4's mutant is "count ALL items instead of LIVE ones", and this is the leg that kills it: an
   * order whose add-on was cancelled must still close when its real work finishes, or it sits on
   * every pending-investigations list for ever.
   */
  it("A4b — a CANCELLED sibling does not block the close", async () => {
    const { orderId, itemIds } = await order([S1, S2]);
    await advance(tech, itemIds[1]!, "cancelled");
    await advance(tech, itemIds[0]!, "in_progress");
    const result = await advance(tech, itemIds[0]!, "completed");
    expect(result.headerClosedAs).toBe("closed");
    expect((await db.select().from(orders).where(eq(orders.id, orderId)))[0]!.status).toBe("closed");
  });

  it("A4c — an order whose every item is cancelled closes as CANCELLED, not as closed", async () => {
    const { orderId, itemIds } = await order([S1, S2]);
    await advance(tech, itemIds[0]!, "cancelled");
    const last = await advance(tech, itemIds[1]!, "cancelled");
    expect(last.headerClosedAs).toBe("cancelled");
    const header = (await db.select().from(orders).where(eq(orders.id, orderId)))[0]!;
    expect([header.status, header.closedAt === null]).toEqual(["cancelled", false]);
    const names = (await db.select().from(events)).map((e) => e.name);
    expect(names).toContain("order.cancelled");
    expect(names).not.toContain("order.closed");
  });

  // ───────────────────── A5 — one transitions row per move, with the actor ─────────────────────

  it("A5 — every success writes EXACTLY ONE transitions row carrying the caller's actor type", async () => {
    const { itemIds } = await order();
    await advance(tech, itemIds[0]!, "in_progress");
    await advance({ type: "system", id: "analyzer-1" }, itemIds[0]!, "completed");
    const rows = await db.select().from(orderItemTransitions).orderBy(orderItemTransitions.at);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.fromStatus, r.toStatus, r.actorType, r.actorId])).toEqual([
      ["placed", "in_progress", "user", tech.id],
      ["in_progress", "completed", "system", "analyzer-1"],
    ]);
  });

  it("emits one order_item.* event per move, carrying the kind so a consumer need not read back", async () => {
    const { itemIds } = await order();
    await advance(tech, itemIds[0]!, "in_progress");
    await advance(tech, itemIds[0]!, "completed");
    const item = (await db.select().from(events)).filter((e) => e.name.startsWith("order_item."));
    expect(item.map((e) => e.name)).toEqual(["order_item.started", "order_item.completed"]);
    expect(item[0]!.payload).toMatchObject({ kind: "lab", serviceId: S1, from: "placed", to: "in_progress" });
  });

  it("the cancellation event carries cancelledFrom and the reason (DD5, for 02 O-4)", async () => {
    const { itemIds } = await order();
    await advance(tech, itemIds[0]!, "in_progress");
    await advance(tech, itemIds[0]!, "cancelled", { reason: "clotted sample" });
    const [cancelled] = (await db.select().from(events)).filter((e) => e.name === "order_item.cancelled");
    expect(cancelled!.payload).toMatchObject({ cancelledFrom: "in_progress", reason: "clotted sample" });
  });

  // ───────────────────────── A6 — the actor legs on the state machine ─────────────────────────

  it("A6 — a patient may not start or complete their own test", async () => {
    const { itemIds } = await order([S1], "package");
    const patient: Actor = { type: "patient", id: "patient-credential-1" };
    expect(await codeOf(advance(patient, itemIds[0]!, "in_progress"))).toBe("actor_cannot_advance");
    await advance(tech, itemIds[0]!, "in_progress");
    expect(await codeOf(advance(patient, itemIds[0]!, "completed"))).toBe("actor_cannot_advance");
  });

  it("A6b — a patient MAY cancel a not-yet-started item of a self-orderable kind (26)", async () => {
    const { itemIds } = await order([S1], "package");
    const result = await advance({ type: "patient", id: "p-1" }, itemIds[0]!, "cancelled");
    expect(result.headerClosedAs).toBe("cancelled");
  });

  it("A6c — a patient may NOT cancel an item of a kind that is not self-orderable", async () => {
    const { itemIds } = await order([S1], "lab");
    expect(await codeOf(advance({ type: "patient", id: "p-1" }, itemIds[0]!, "cancelled")))
      .toBe("actor_cannot_advance");
  });

  it("A6d — a patient may not cancel once the work has started, even on their own package", async () => {
    const { itemIds } = await order([S1], "package");
    await advance(tech, itemIds[0]!, "in_progress");
    expect(await codeOf(advance({ type: "patient", id: "p-1" }, itemIds[0]!, "cancelled", { reason: "changed mind" })))
      .toBe("actor_cannot_advance");
  });

  it("A6e — an agent may not move an item at all", async () => {
    const { itemIds } = await order();
    expect(await codeOf(advance({ type: "agent", id: "drafter" }, itemIds[0]!, "in_progress")))
      .toBe("actor_cannot_advance");
  });
});
