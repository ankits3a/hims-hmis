import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { seedLabDeskBase, serviceIdForLabCode } from "../../../test/helpers/lab";
import { withTx } from "../../kernel/db/client";
import { events, labQuickReports } from "../../kernel/db/schema";
import { awaitingLabels } from "./collection";
import { deskOrder } from "./desk";
import { recentLabOrders } from "./desk-picker";
import {
  getQuickReport, handOverQuick, quickCollect, quickCollectQueue, QuickEntryError, quickQueue, quickReportsDesk,
  saveQuickResults, sendBackQuick,
} from "./quick";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { DeskOrderInput } from "./desk";
import type { Db } from "../../kernel/db/client";

/**
 * OWNER 2026-10-11 — THE QUICK CHAIN (spec `SPEC-lab-quick-chain-2026-10-11.md`): an order placed at
 * the counter waits on /lab/qcollect; Blood collected stamps a sample number and moves it to
 * /lab/qbench; Save draft keeps it there; Save & Complete moves it to /lab/qreports; Send back makes
 * it a draft again; Print & Hand over closes it.
 */
describe("the quick lab chain (owner 2026-10-11)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => { await truncateAll(db); fx = await seedLabDeskBase(db); });
  afterEach(() => { fx.unregister(); });

  const order = (codes: string[] = ["CBC", "LFT"]) => withTx(db, (tx) => deskOrder(tx, fx.desk.actor, fx.decls, {
    patientId: fx.patientId, encounterNo: fx.encounterNo, serviceDate: fx.serviceDate,
    orderingClinicianId: fx.pathologist.id, items: codes.map((c) => ({ serviceId: serviceIdForLabCode(c) })),
    credit: { reason: "counter order, paid at collection" },
  } as DeskOrderInput));

  async function code(p: Promise<unknown>): Promise<string> {
    const e = await p.then(() => null, (err: unknown) => err);
    expect(e).toBeInstanceOf(QuickEntryError);
    return (e as QuickEntryError).code;
  }

  it("an order waits for blood; Blood collected stamps a sample number once and moves it to the bench", async () => {
    const placed = await order();
    const waiting = await quickCollectQueue(db, fx.desk.actor);
    expect(waiting.map((w) => [w.orderNo, w.tests.map((t) => t.code)])).toEqual([[placed.orderNo, ["CBC", "LFT"]]]);

    const row = await withTx(db, (tx) => quickCollect(tx, fx.desk.actor, placed.orderId));
    expect(row.sampleNo).toMatch(/^S\d{10}$/);
    expect([row.status, row.orderNo, row.encounterNo]).toEqual(["waiting", placed.orderNo, fx.encounterNo]);
    /** It leaves the collection queue, and the full workflow's label queue does not offer it either. */
    expect(await quickCollectQueue(db, fx.desk.actor)).toEqual([]);
    expect(await awaitingLabels(db, fx.desk.actor, { serviceDate: fx.serviceDate })).toEqual([]);
    expect((await quickQueue(db, fx.desk.actor)).waiting.map((w) => w.id)).toEqual([row.id]);
    /** The blood is confirmed once. */
    expect(await code(withTx(db, (tx) => quickCollect(tx, fx.desk.actor, placed.orderId)))).toBe("already_collected");
  });

  /**
   * #889 — an order's tests come back in ONE fixed order (by test name, as the catalogue picker lists
   * them), whatever order they were ordered or stored in. The order is placed LFT first so the heap
   * order is the reverse of the name order; without the reader's ORDER BY this saw [LFT, CBC].
   */
  it("an order's tests are listed by test name, not by the order they were placed in (#889)", async () => {
    const placed = await order(["LFT", "CBC"]);
    for (let i = 0; i < 3; i++) {
      const waiting = await quickCollectQueue(db, fx.desk.actor);
      expect(waiting.map((w) => w.tests.map((t) => t.code))).toEqual([["CBC", "LFT"]]);
    }
    /** Blood collected stores the same order, so the bench form and the printed groups follow it. */
    const row = await withTx(db, (tx) => quickCollect(tx, fx.desk.actor, placed.orderId));
    expect(row.tests.map((t) => t.code)).toEqual(["CBC", "LFT"]);
  });

  it("Save draft stays on the bench; Save & Complete goes to the reports; Send back returns it as a draft; Hand over closes it", async () => {
    const placed = await order();
    const { id } = await withTx(db, (tx) => quickCollect(tx, fx.desk.actor, placed.orderId));
    const report = await getQuickReport(db, fx.desk.actor, id);
    const hb = report.analyteIds[0]!;

    const draft = await withTx(db, (tx) => saveQuickResults(tx, fx.desk.actor, { id, lines: [{ analyteId: hb, value: "12.1" }], summary: "", complete: false }));
    expect([draft.status, draft.reportedAt, draft.lines.length]).toEqual(["draft", null, 1]);
    expect((await quickQueue(db, fx.desk.actor)).waiting.map((w) => w.status)).toEqual(["draft"]);
    expect((await quickReportsDesk(db, fx.desk.actor)).ready).toEqual([]);

    const done = await withTx(db, (tx) => saveQuickResults(tx, fx.desk.actor, { id, lines: [{ analyteId: hb, value: "12.4" }], summary: "All normal." }));
    expect(done.status).toBe("reported");
    expect((await quickReportsDesk(db, fx.desk.actor)).ready.map((r) => r.id)).toEqual([id]);

    const back = await withTx(db, (tx) => sendBackQuick(tx, fx.desk.actor, id));
    expect([back.status, back.reportedAt]).toEqual(["draft", null]);
    expect((await getQuickReport(db, fx.desk.actor, id)).lines[0]?.value).toBe("12.4");
    /** Only a completed report is handed over. */
    expect(await code(withTx(db, (tx) => handOverQuick(tx, fx.desk.actor, id)))).toBe("not_completed");

    await withTx(db, (tx) => saveQuickResults(tx, fx.desk.actor, { id, lines: [{ analyteId: hb, value: "12.4" }], summary: "All normal." }));
    const handed = await withTx(db, (tx) => handOverQuick(tx, fx.desk.actor, id));
    expect(handed.handedOverBy).toBe(fx.desk.id);
    const desk = await quickReportsDesk(db, fx.desk.actor);
    expect([desk.ready.length, desk.handedOverToday.map((r) => r.id)]).toEqual([0, [id]]);
    /** Once handed over it is closed: no send-back, no edit, no second hand-over. */
    expect(await code(withTx(db, (tx) => sendBackQuick(tx, fx.desk.actor, id)))).toBe("already_handed_over");
    expect(await code(withTx(db, (tx) => saveQuickResults(tx, fx.desk.actor, { id, lines: [], summary: "" })))).toBe("already_handed_over");
    expect(await code(withTx(db, (tx) => handOverQuick(tx, fx.desk.actor, id)))).toBe("already_handed_over");

    const names = (await db.select().from(events)).map((e) => e.name).filter((n) => n.startsWith("lab.quick"));
    expect(names).toEqual(["lab.quick_started", "lab.quick_reported", "lab.quick_sent_back", "lab.quick_reported", "lab.quick_handed_over"]);
  });

  it("a person with neither the counter's nor the phlebotomist's grant cannot confirm blood", async () => {
    const placed = await order();
    expect(await code(withTx(db, (tx) => quickCollect(tx, { type: "user", id: "u-nobody" }, placed.orderId)))).toBe("not_permitted");
    expect(await db.select().from(labQuickReports).where(eq(labQuickReports.orderId, placed.orderId))).toEqual([]);
  });

  it("the counter's last tests name each order's tests and say where it stands, newest first", async () => {
    const first = await order();
    const { id } = await withTx(db, (tx) => quickCollect(tx, fx.desk.actor, first.orderId));
    const second = await order(["TSH"]);
    let recent = await recentLabOrders(db, fx.patientId, false);
    expect(recent.map((r) => [r.orderNo, r.stage, r.tests.map((t) => t.code)])).toEqual([
      [second.orderNo, "awaiting_blood", ["TSH"]],
      [first.orderNo, "sample_taken", ["CBC", "LFT"]],
    ]);
    const hb = (await getQuickReport(db, fx.desk.actor, id)).analyteIds[0]!;
    await withTx(db, (tx) => saveQuickResults(tx, fx.desk.actor, { id, lines: [{ analyteId: hb, value: "12" }], summary: "" }));
    recent = await recentLabOrders(db, fx.patientId, false);
    expect(recent[1]?.stage).toBe("report_ready");
  });

});
