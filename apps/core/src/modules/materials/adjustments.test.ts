import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { approveRequest, rejectRequest } from "../../kernel/approvals/decisions";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { seedSodPairs } from "../../kernel/auth/sod";
import { withTx } from "../../kernel/db/client";
import { approvals, events, stockBatches, stockLedger } from "../../kernel/db/schema";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../kernel/modules/manifests";
import { listAdjustments, postAdjustments, requestCountAdjustment } from "./adjustments";
import { registerMaterialsApprovalTypes } from "./approval-types";
import { countSheet, getCount, scheduleCount, submitCount } from "./counts";
import { registerItem } from "./items";
import { balances, postMovement } from "./ledger";
import { createStore } from "./stores";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PLAN 14c, SECOND SLICE — A COUNT'S VARIANCE, BOOKED WITH A SECOND KEY ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-17-phase-materials-adjustments.md`. The materials head
 * asks; the medical superintendent decides; nothing moves before GRANTED; a write-off the shelf can
 * no longer cover is refused whole.
 */
const T0 = new Date("2026-09-16T04:30:00.000Z");
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);
const DAY = 24 * 60 * 60 * 1000;

describe("booking a count's variance (Plan 14c, second slice)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let head: { id: string; actor: Actor };
  let keeper: { id: string; actor: Actor };
  let ms: { id: string; actor: Actor };
  let aide: { id: string; actor: Actor };
  let store: string;
  let az1: string;
  let az2: string;
  let cr1: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) registry.install(m);
    await syncPermissions(db, registry);
    await seedSodPairs(db);
    await registerMaterialsApprovalTypes(db, { type: "user", id: "seed-materials" });
    for (const role of ["materials_head", "storekeeper", "medical_superintendent", "pharmacy_assistant"]) await ensureRole(db, role);
    await grantPermissionToRole(db, registry, "materials_head", "materials.counts.manage");
    await grantPermissionToRole(db, registry, "storekeeper", "materials.counts.perform");
    for (const p of ["approvals.requests.decide", "approvals.requests.read"]) await grantPermissionToRole(db, registry, "medical_superintendent", p);
    head = await mkUser(db, "mat.head", ["materials_head"]);
    keeper = await mkUser(db, "store.keeper", ["storekeeper"]);
    ms = await mkUser(db, "ms.approver", ["medical_superintendent"]);
    aide = await mkUser(db, "counter.aide", ["pharmacy_assistant"]);
    ({ resourceId: store } = await withTx(db, (tx) => createStore(tx, head.actor, { code: "PHARM-OPD", name: "OPD pharmacy" })));
    const { itemId } = await withTx(db, (tx) => registerItem(tx, head.actor, { code: "AZEE500", name: "Azee 500", class: "consumable", baseUom: "tablet", batchTracked: true, uoms: [] }));
    const batch = async (batchNo: string): Promise<string> => {
      const id = newId();
      await db.insert(stockBatches).values({ id, itemId, batchNo, expiryDate: "2027-06-30", landedCostPaise: 500, ownership: "owned", createdBy: head.id });
      return id;
    };
    az1 = await batch("AZ-1");
    az2 = await batch("AZ-2");
    cr1 = await batch("CR-1");
    const back = new Date(T0.getTime() - 5 * DAY);
    for (const [b, q] of [[az1, 100], [az2, 40], [cr1, 20]] as const) await move(aide.actor, b, q, "grn", back);
  });

  const move = (actor: Actor, batchId: string, qtyDelta: number, reason: "grn" | "consume", occurredAt: Date) =>
    withTx(db, (tx) => postMovement(tx, actor, { resourceId: store, batchId, qtyDelta, reason, refType: "test", refId: batchId, occurredAt }));
  const books = async (): Promise<Map<string, number>> => new Map((await balances(db, { resourceId: store })).map((b) => [b.batchId, b.qtyOnHand] as const));

  /** AZ-1 three short (variance), AZ-2 one over (variance), CR-1 matching. Returns the count and its line ids. */
  async function counted(): Promise<{ countId: string; line: (batchNo: string) => string }> {
    const count = await scheduleCount(db, head.actor, { storeResourceId: store }, T0);
    const sheet = await countSheet(db, keeper.actor, count.id);
    const qty: Record<string, number> = { "AZ-1": 97, "AZ-2": 41, "CR-1": 20 };
    await submitCount(db, keeper.actor, count.id, {
      countedAt: at(20).toISOString(), lines: sheet.lines.map((l) => ({ lineId: l.lineId, countedQty: qty[l.batchNo]! })),
    }, at(25));
    const review = await getCount(db, head.actor, count.id);
    return { countId: count.id, line: (batchNo) => review.lines.find((l) => l.batchNo === batchNo)!.lineId };
  }

  it("books the variance only after the medical superintendent grants it, once, with one event", async () => {
    const { countId, line } = await counted();
    const req = await requestCountAdjustment(db, head.actor, countId, {
      lines: [{ lineId: line("AZ-1"), reasonCode: "shrinkage" }, { lineId: line("AZ-2"), reasonCode: "found" }],
      note: "three strips missing, one found behind the rack",
    }, at(30));
    expect(req.adjustments.map((a) => [a.batchNo, a.qtyDelta, a.valuePaise, a.reasonCode, a.status, a.approvalStatus])).toEqual([
      ["AZ-1", -3, -1500, "shrinkage", "requested", "pending"],
      ["AZ-2", 1, 500, "found", "requested", "pending"],
    ]);

    // Pending: nothing moves.
    await expect(postAdjustments(db, head.actor, req.approvalId, at(31))).rejects.toMatchObject({ code: "adjustment_unapproved" });
    expect((await books()).get(az1)).toBe(100);
    // The one who asked cannot decide.
    await expect(approveRequest(db, head.actor, { approvalId: req.approvalId, note: "mine" })).rejects.toBeDefined();

    await approveRequest(db, ms.actor, { approvalId: req.approvalId, note: "write off; found stock booked" });
    expect(await postAdjustments(db, head.actor, req.approvalId, at(40))).toEqual({ posted: 2, refused: 0 });
    const after = await books();
    expect([after.get(az1), after.get(az2), after.get(cr1)]).toEqual([97, 41, 20]);
    const rows = await db.select().from(stockLedger).where(eq(stockLedger.reason, "adjust"));
    expect(rows.map((r) => [r.batchId, r.qtyDelta, r.refType]).sort()).toEqual([[az1, -3, "stock_adjustment"], [az2, 1, "stock_adjustment"]].sort());
    const listed = await listAdjustments(db, head.actor, { countId });
    expect(listed.map((a) => [a.status, a.approvalStatus, a.ledgerEntryId !== null])).toEqual([["posted", "granted", true], ["posted", "granted", true]]);
    const [ev] = await db.select().from(events).where(eq(events.name, "stock.adjusted"));
    expect(ev?.payload).toMatchObject({ approvalId: req.approvalId, countId, postedBy: head.id, netValuePaise: -1000, lines: expect.any(Array) });

    // Once only.
    expect(await postAdjustments(db, head.actor, req.approvalId, at(41))).toEqual({ posted: 0, refused: 0 });
    expect(await db.select().from(stockLedger).where(eq(stockLedger.reason, "adjust"))).toHaveLength(2);
    expect(await db.select().from(events).where(eq(events.name, "stock.adjusted"))).toHaveLength(1);
    await expect(requestCountAdjustment(db, head.actor, countId, { lines: [{ lineId: line("AZ-1"), reasonCode: "shrinkage" }] }, at(42)))
      .rejects.toMatchObject({ code: "already_requested" });
  });

  it("refuses what has nothing to book, a reason against the direction, a count not yet counted, and anyone but the head", async () => {
    const pending = await scheduleCount(db, head.actor, { storeResourceId: store }, T0);
    await expect(requestCountAdjustment(db, head.actor, pending.id, { lines: [] }, at(1))).rejects.toMatchObject({ code: "count_not_submitted" });
    const sheet = await countSheet(db, keeper.actor, pending.id);
    const qty: Record<string, number> = { "AZ-1": 97, "AZ-2": 41, "CR-1": 20 };
    await submitCount(db, keeper.actor, pending.id, { countedAt: at(20).toISOString(), lines: sheet.lines.map((l) => ({ lineId: l.lineId, countedQty: qty[l.batchNo]! })) }, at(25));
    const review = await getCount(db, head.actor, pending.id);
    const line = (b: string): string => review.lines.find((l) => l.batchNo === b)!.lineId;

    await expect(requestCountAdjustment(db, head.actor, pending.id, { lines: [] }, at(30))).rejects.toMatchObject({ code: "nothing_to_adjust" });
    await expect(requestCountAdjustment(db, head.actor, pending.id, { lines: [{ lineId: line("CR-1"), reasonCode: "shrinkage" }] }, at(30))).rejects.toMatchObject({ code: "nothing_to_adjust" });
    await expect(requestCountAdjustment(db, head.actor, pending.id, { lines: [{ lineId: line("AZ-1"), reasonCode: "found" }] }, at(30))).rejects.toMatchObject({ code: "invalid_adjustment_reason" });
    await expect(requestCountAdjustment(db, head.actor, pending.id, { lines: [{ lineId: line("AZ-2"), reasonCode: "damage" }] }, at(30))).rejects.toMatchObject({ code: "invalid_adjustment_reason" });
    await expect(requestCountAdjustment(db, head.actor, pending.id, { lines: [{ lineId: line("AZ-1"), reasonCode: "shrinkage" }, { lineId: line("AZ-1"), reasonCode: "shrinkage" }] }, at(30))).rejects.toMatchObject({ code: "already_requested" });
    await expect(requestCountAdjustment(db, keeper.actor, pending.id, { lines: [{ lineId: line("AZ-1"), reasonCode: "shrinkage" }] }, at(30))).rejects.toMatchObject({ code: "permission_denied" });
    // …and nothing was asked on the way to that refusal: no request, no approval.
    expect(await listAdjustments(db, head.actor, { countId: pending.id })).toEqual([]);
    expect(await db.select().from(approvals)).toEqual([]);
    // An entry error books either way.
    await expect(requestCountAdjustment(db, head.actor, pending.id, { lines: [{ lineId: line("AZ-2"), reasonCode: "entry_error" }] }, at(30))).resolves.toMatchObject({ adjustments: [{ qtyDelta: 1 }] });
  });

  it("a line flagged for recount is booked from its recount, never from the count that flagged it", async () => {
    const count = await scheduleCount(db, head.actor, { storeResourceId: store }, T0);
    const sheet = await countSheet(db, keeper.actor, count.id);
    // CR-1: 10 of 20 is half gone — a recount.
    const qty: Record<string, number> = { "AZ-1": 100, "AZ-2": 40, "CR-1": 10 };
    await submitCount(db, keeper.actor, count.id, { countedAt: at(20).toISOString(), lines: sheet.lines.map((l) => ({ lineId: l.lineId, countedQty: qty[l.batchNo]! })) }, at(25));
    const review = await getCount(db, head.actor, count.id);
    const cr = review.lines.find((l) => l.batchNo === "CR-1")!;
    expect(cr.flag).toBe("recount");
    await expect(requestCountAdjustment(db, head.actor, count.id, { lines: [{ lineId: cr.lineId, reasonCode: "shrinkage" }] }, at(30))).rejects.toMatchObject({ code: "recount_pending" });
  });

  it("a rejected request books nothing and frees its lines; a write-off the shelf can no longer cover is refused whole", async () => {
    const { countId, line } = await counted();
    const first = await requestCountAdjustment(db, head.actor, countId, { lines: [{ lineId: line("AZ-1"), reasonCode: "shrinkage" }] }, at(30));
    await rejectRequest(db, ms.actor, { approvalId: first.approvalId, note: "recount it first" });
    expect(await postAdjustments(db, head.actor, first.approvalId, at(31))).toEqual({ posted: 0, refused: 1 });
    expect((await listAdjustments(db, head.actor, { approvalId: first.approvalId }))[0]).toMatchObject({ status: "refused", approvalStatus: "rejected" });

    // Asked again, granted — but the shelf sold all 100 meanwhile, so a write-off of 3 cannot post.
    const second = await requestCountAdjustment(db, head.actor, countId, { lines: [{ lineId: line("AZ-1"), reasonCode: "shrinkage" }] }, at(32));
    await approveRequest(db, ms.actor, { approvalId: second.approvalId, note: "ok" });
    await move(aide.actor, az1, -99, "consume", at(33));
    await expect(postAdjustments(db, head.actor, second.approvalId, at(34))).rejects.toMatchObject({ code: "insufficient_stock" });
    expect((await books()).get(az1)).toBe(1);
    expect((await listAdjustments(db, head.actor, { approvalId: second.approvalId }))[0]?.status).toBe("requested");
    await expect(postAdjustments(db, head.actor, "no-such-approval", at(35))).rejects.toMatchObject({ code: "unknown_adjustment" });
  });
});
