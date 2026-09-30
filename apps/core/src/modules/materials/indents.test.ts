import { eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import { events, stockBatches, storeIndentLines, storeIndents } from "../../kernel/db/schema";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../kernel/modules/manifests";
import { MaterialsError } from "./errors";
import { cancelIndent, getIndent, issueIndent, listIndents, raiseIndent, rejectIndent } from "./indents";
import { registerItem } from "./items";
import { balances, postMovements } from "./ledger";
import { createStore, setStoreCustodianRoles } from "./stores";
import { getTransfer, receiveStock } from "./transfers";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PHARMACY GAP A6b — the indent: a sub-store asks, the supplying store answers with an ordinary transfer or a
 * refusal, and the requester receives that transfer through the unchanged receipt. The fixtures keep two batches
 * whose expiry order is the OPPOSITE of their creation order, so a FEFO pick is visible (§2.102).
 */
const T0 = new Date("2026-09-29T06:00:00Z");

describe("indents (pharmacy gap A6b)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let keeper: { id: string; actor: Actor };
  let nurse: { id: string; actor: Actor };
  let outsider: { id: string; actor: Actor };
  let reader: { id: string; actor: Actor };
  let main: string;
  let ward: string;
  let gloves: string;
  let gauze: string;
  let lateBatch: string;
  let earlyBatch: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) registry.install(m);
    await syncPermissions(db, registry);
    const grants: Record<string, string[]> = {
      storekeeper: ["materials.stock.read", "materials.stock.issue"],
      ward_nurse: ["materials.stock.read", "materials.stock.receive"],
      // Both grants and neither store's keeper role: the custodian rule, not the permission, refuses them.
      materials_clerk: ["materials.stock.read", "materials.stock.issue", "materials.stock.receive"],
      viewer: ["materials.stock.read"],
    };
    for (const [role, perms] of Object.entries(grants)) {
      await ensureRole(db, role);
      for (const p of perms) await grantPermissionToRole(db, registry, role, p);
    }
    keeper = await mkUser(db, "store.keeper", ["storekeeper"]);
    nurse = await mkUser(db, "ward.nurse", ["ward_nurse"]);
    outsider = await mkUser(db, "mat.clerk", ["materials_clerk"]);
    reader = await mkUser(db, "the.viewer", ["viewer"]);
    ({ resourceId: main } = await withTx(db, (tx) => createStore(tx, keeper.actor, { code: "MAIN", name: "Main store" })));
    ({ resourceId: ward } = await withTx(db, (tx) => createStore(tx, keeper.actor, { code: "WARD-3", name: "Ward 3" })));
    await withTx(db, (tx) => setStoreCustodianRoles(tx, keeper.actor, main, ["storekeeper"]));
    await withTx(db, (tx) => setStoreCustodianRoles(tx, keeper.actor, ward, ["ward_nurse"]));
    gloves = await anItem("GLOVE-M");
    gauze = await anItem("GAUZE-10");
    // Created first, expires LATER; FEFO must take the second one first.
    lateBatch = await aBatch(gloves, "GL-LATE", "2028-12-31", 60);
    earlyBatch = await aBatch(gloves, "GL-EARLY", "2027-06-30", 40);
    await aBatch(gauze, "GZ-1", "2028-01-31", 5);
  });

  async function anItem(code: string): Promise<string> {
    const { itemId } = await withTx(db, (tx) => registerItem(tx, keeper.actor, {
      code, name: `Item ${code}`, class: "consumable", baseUom: "piece", batchTracked: true, uoms: [],
    }));
    return itemId;
  }
  async function aBatch(itemId: string, batchNo: string, expiryDate: string, qty: number): Promise<string> {
    const id = newId();
    await db.insert(stockBatches).values({ id, itemId, batchNo, expiryDate, landedCostPaise: 100, ownership: "owned", createdBy: keeper.id });
    await withTx(db, (tx) => postMovements(tx, keeper.actor, [{ resourceId: main, batchId: id, qtyDelta: qty, reason: "grn", occurredAt: T0 }]));
    return id;
  }
  const onHand = async (store: string, batchId: string): Promise<number> =>
    (await balances(db, { resourceId: store })).find((b) => b.batchId === batchId)?.qtyOnHand ?? 0;
  const eventsNamed = async (name: string): Promise<Record<string, unknown>[]> =>
    (await db.select({ payload: events.payload }).from(events).where(eq(events.name, name))).map((e) => e.payload as Record<string, unknown>);
  const raise = (lines = [{ itemId: gloves, qtyBase: 70 }, { itemId: gauze, qtyBase: 10 }]) =>
    raiseIndent(db, nurse.actor, { fromResourceId: ward, toResourceId: main, lines, note: "night shift" }, T0);
  async function refusal(p: Promise<unknown>): Promise<{ code: string }> {
    try { await p; } catch (e) {
      if (e instanceof MaterialsError) return { code: e.code };
      throw e;
    }
    throw new Error("expected a refusal");
  }

  it("raise → issue in full → one FEFO transfer → the ward receives it through the ordinary receipt", async () => {
    const indent = await raise([{ itemId: gloves, qtyBase: 70 }]);
    expect(indent.indentNo).toMatch(/^MIN2609290001$/);
    expect(indent).toMatchObject({ status: "requested", note: "night shift", from: { code: "WARD-3" }, to: { code: "MAIN" }, requestedBy: { name: "ward.nurse" } });
    expect(indent.lines).toEqual([expect.objectContaining({ lineIdx: 0, itemCode: "GLOVE-M", baseUom: "piece", qtyBase: 70, qtyIssued: null, available: 100 })]);
    expect(await eventsNamed("material.indent_raised")).toEqual([expect.objectContaining({ indentId: indent.id, lines: [{ itemId: gloves, qtyBase: 70 }] })]);

    const issued = await issueIndent(db, keeper.actor, indent.id, {}, T0);
    expect(issued).toMatchObject({ status: "issued", decidedBy: { id: keeper.id }, transfer: { status: "in_transit" } });
    expect(issued.lines[0]).toMatchObject({ qtyIssued: 70, available: null });
    const transfer = (await getTransfer(db, issued.transfer!.id))!;
    expect(transfer).toMatchObject({ fromResourceId: main, toResourceId: ward, note: `indent ${indent.indentNo}` });
    // FEFO: all 40 of the early batch, then 30 of the late one.
    expect(transfer.lines.map((l) => [l.batchId, l.qtyIssued])).toEqual(expect.arrayContaining([[earlyBatch, 40], [lateBatch, 30]]));
    expect(transfer.lines).toHaveLength(2);
    expect(await eventsNamed("material.indent_issued")).toEqual([expect.objectContaining({
      indentId: indent.id, transferId: transfer.id, lines: [{ itemId: gloves, qtyBase: 70, qtyIssued: 70 }],
    })]);

    const got = await withTx(db, (tx) => receiveStock(tx, nurse.actor, transfer.id, transfer.lines.map((l) => ({ lineId: l.id, qtyReceived: l.qtyIssued })), T0));
    expect(got.status).toBe("received");
    expect(await onHand(ward, earlyBatch)).toBe(40);
    expect(await onHand(ward, lateBatch)).toBe(30);
    expect(await onHand(main, lateBatch)).toBe(30);
    expect((await getIndent(db, indent.id))!.transfer).toMatchObject({ status: "received" });
  });

  it("issues short: one line at 0, one line partial — and by default a line is capped at what the shelf has", async () => {
    const indent = await raise();
    // Gauze: 10 asked, 5 on the shelf. Given no quantities, the default caps it at 5.
    const byDefault = await getIndent(db, indent.id);
    expect(byDefault!.lines.map((l) => l.available)).toEqual([100, 5]);
    const issued = await issueIndent(db, keeper.actor, indent.id, { lines: [{ lineIdx: 0, qtyBase: 25 }, { lineIdx: 1, qtyBase: 0 }] }, T0);
    expect(issued.lines.map((l) => [l.itemCode, l.qtyBase, l.qtyIssued])).toEqual([["GLOVE-M", 70, 25], ["GAUZE-10", 10, 0]]);
    const transfer = (await getTransfer(db, issued.transfer!.id))!;
    expect(transfer.lines.map((l) => [l.batchId, l.qtyIssued])).toEqual([[earlyBatch, 25]]);

    const second = await raise();
    const capped = await issueIndent(db, keeper.actor, second.id, {}, T0);
    expect(capped.lines.map((l) => l.qtyIssued)).toEqual([70, 5]);
  });

  it("rejects with a reason, and cancels with one — nothing moves either way", async () => {
    const a = await raise();
    expect(await refusal(rejectIndent(db, keeper.actor, a.id, "  ", T0))).toEqual({ code: "reason_required" });
    const rejected = await rejectIndent(db, keeper.actor, a.id, "ward holds a week's stock", T0);
    expect(rejected).toMatchObject({ status: "rejected", rejectReason: "ward holds a week's stock", transfer: null, decidedBy: { id: keeper.id } });
    expect(await eventsNamed("material.indent_rejected")).toEqual([expect.objectContaining({ indentId: a.id, reason: "ward holds a week's stock" })]);

    const b = await raise();
    const cancelled = await cancelIndent(db, nurse.actor, b.id, "raised twice", T0);
    expect(cancelled).toMatchObject({ status: "cancelled", cancelReason: "raised twice" });
    expect(await eventsNamed("material.indent_cancelled")).toEqual([expect.objectContaining({ indentId: b.id, reason: "raised twice" })]);
    expect(await onHand(main, earlyBatch)).toBe(40);

    const listed = await listIndents(db, { storeId: ward });
    expect(listed.map((i) => i.status).sort()).toEqual(["cancelled", "rejected"]);
    expect(await listIndents(db, { status: "requested" })).toEqual([]);
  });

  it("refuses: the wrong grant, a store's non-keeper, a closed indent, and each malformed indent", async () => {
    // permission
    expect(await refusal(raiseIndent(db, reader.actor, { fromResourceId: ward, toResourceId: main, lines: [{ itemId: gloves, qtyBase: 1 }] }, T0))).toEqual({ code: "permission_denied" });
    const indent = await raise();
    expect(await refusal(issueIndent(db, nurse.actor, indent.id, {}, T0))).toEqual({ code: "permission_denied" });
    expect(await refusal(rejectIndent(db, reader.actor, indent.id, "no", T0))).toEqual({ code: "permission_denied" });
    expect(await refusal(cancelIndent(db, keeper.actor, indent.id, "no", T0))).toEqual({ code: "permission_denied" });
    // non-keeper: holds every grant, keeps neither store
    expect(await refusal(raiseIndent(db, outsider.actor, { fromResourceId: ward, toResourceId: main, lines: [{ itemId: gloves, qtyBase: 1 }] }, T0))).toEqual({ code: "not_store_keeper" });
    expect(await refusal(issueIndent(db, outsider.actor, indent.id, {}, T0))).toEqual({ code: "not_store_keeper" });
    expect(await refusal(rejectIndent(db, outsider.actor, indent.id, "no", T0))).toEqual({ code: "not_store_keeper" });
    expect(await refusal(cancelIndent(db, outsider.actor, indent.id, "no", T0))).toEqual({ code: "not_store_keeper" });
    // malformed
    const asks = (lines: { itemId: string; qtyBase: number }[], from = ward) => raiseIndent(db, nurse.actor, { fromResourceId: from, toResourceId: main, lines }, T0);
    expect(await refusal(asks([]))).toEqual({ code: "invalid_indent" });
    expect(await refusal(asks([{ itemId: gloves, qtyBase: 2 }, { itemId: gloves, qtyBase: 3 }]))).toEqual({ code: "invalid_indent" });
    expect(await refusal(asks([{ itemId: gloves, qtyBase: 0 }]))).toEqual({ code: "invalid_indent" });
    expect(await refusal(asks([{ itemId: gloves, qtyBase: 1.5 }]))).toEqual({ code: "invalid_indent" });
    expect(await refusal(asks([{ itemId: gloves, qtyBase: 1 }], main))).toEqual({ code: "invalid_indent" });
    expect(await refusal(asks([{ itemId: "01NOSUCHITEM000000000000000", qtyBase: 1 }]))).toEqual({ code: "unknown_item" });
    // issuing: more than asked, more than the shelf has, nothing at all
    expect(await refusal(issueIndent(db, keeper.actor, indent.id, { lines: [{ lineIdx: 0, qtyBase: 71 }] }, T0))).toEqual({ code: "invalid_indent" });
    expect(await refusal(issueIndent(db, keeper.actor, indent.id, { lines: [{ lineIdx: 1, qtyBase: 6 }] }, T0))).toEqual({ code: "insufficient_stock" });
    expect(await refusal(issueIndent(db, keeper.actor, indent.id, { lines: [{ lineIdx: 0, qtyBase: 0 }, { lineIdx: 1, qtyBase: 0 }] }, T0))).toEqual({ code: "invalid_indent" });
    expect(await refusal(issueIndent(db, keeper.actor, indent.id, { lines: [{ lineIdx: 7, qtyBase: 1 }] }, T0))).toEqual({ code: "invalid_indent" });
    expect((await getIndent(db, indent.id))!.status).toBe("requested");
    // closed
    await issueIndent(db, keeper.actor, indent.id, {}, T0);
    expect(await refusal(issueIndent(db, keeper.actor, indent.id, {}, T0))).toEqual({ code: "indent_closed" });
    expect(await refusal(rejectIndent(db, keeper.actor, indent.id, "late", T0))).toEqual({ code: "indent_closed" });
    expect(await refusal(cancelIndent(db, nurse.actor, indent.id, "late", T0))).toEqual({ code: "indent_closed" });
    expect(await refusal(issueIndent(db, keeper.actor, "01NOSUCHINDENT0000000000000", {}, T0))).toEqual({ code: "unknown_indent" });
    // one event per act that happened, none for a refusal
    expect(await eventsNamed("material.indent_raised")).toHaveLength(1);
    expect(await eventsNamed("material.indent_issued")).toHaveLength(1);
    expect(await eventsNamed("material.indent_rejected")).toHaveLength(0);
    expect(await eventsNamed("material.indent_cancelled")).toHaveLength(0);
  });

  it("the database holds the record: an issued line's quantity, a decided header and a deletion are refused", async () => {
    const indent = await raise();
    await issueIndent(db, keeper.actor, indent.id, {}, T0);
    const [line] = await db.select().from(storeIndentLines).where(eq(storeIndentLines.indentId, indent.id)).limit(1);
    await expect(db.execute(sql`update store_indent_lines set qty_base = 1 where id = ${line!.id}`)).rejects.toThrow(/store_indent_immutable/);
    await expect(db.execute(sql`update store_indent_lines set qty_issued = 1 where id = ${line!.id}`)).rejects.toThrow(/store_indent_immutable/);
    await expect(db.execute(sql`delete from store_indent_lines where id = ${line!.id}`)).rejects.toThrow(/store_indent_immutable/);
    await expect(db.execute(sql`update store_indents set status = 'cancelled', cancel_reason = 'x' where id = ${indent.id}`)).rejects.toThrow(/store_indent_immutable/);
    await expect(db.execute(sql`delete from store_indents where id = ${indent.id}`)).rejects.toThrow(/store_indent_immutable/);

    // A requested header keeps what was asked, and the CHECKs tie each outcome to its evidence.
    const open = await raise();
    await expect(db.execute(sql`update store_indents set note = 'edited' where id = ${open.id}`)).rejects.toThrow(/store_indent_immutable/);
    await expect(db.update(storeIndents).set({ status: "issued", decidedBy: keeper.id, decidedAt: T0 }).where(eq(storeIndents.id, open.id)))
      .rejects.toThrow(/store_indents_issued_ck/);
    await expect(db.update(storeIndents).set({ status: "rejected", decidedBy: keeper.id, decidedAt: T0 }).where(eq(storeIndents.id, open.id)))
      .rejects.toThrow(/store_indents_rejected_ck/);
    await expect(db.insert(storeIndents).values({ id: newId(), indentNo: "MIN-SAME", fromResourceId: main, toResourceId: main, requestedBy: nurse.id }))
      .rejects.toThrow(/store_indents_stores_ck/);
  });
});
