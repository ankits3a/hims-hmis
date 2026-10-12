import { eq, sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { H1, actorOf, seedLinenHospital } from "../../../test/helpers/linen";
import { linenMovements, tasks } from "../../kernel/db/schema";
import {
  LINEN_CHANGE_TASK, borrowBetweenWards, formatBatchNo, linenHandlerView, raiseLinenChange, recordSoiled, topUpWard, wardStates,
} from "./index";
import type { Db } from "../../kernel/db/client";
import type { LinenHospital } from "../../../test/helpers/linen";

describe("linen — intents and seams", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let h: LinenHospital;
  const now = new Date();

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    h = await seedLinenHospital(db);
  });

  it("raiseLinenChange raises one linen_change task at the bed (the IPD seam)", async () => {
    const r = await raiseLinenChange(db, { placeId: h.aGeneralBed, reason: "admission" }, now);
    expect(r.merged).toBe(false);
    const row = (await db.select().from(tasks).where(eq(tasks.id, r.task.id)))[0]!;
    expect(row).toMatchObject({ kind: LINEN_CHANGE_TASK.kind, placeResourceId: h.aGeneralBed, skill: "general", proofNeeded: "tap" });
  });

  it("a double tap on Save (same key) is one act", async () => {
    const body = { wardId: h.generalWard, lines: [{ itemCode: "bedsheet", qty: 4 }], idempotencyKey: "tap-0000-0001" };
    await recordSoiled(db, actorOf(H1), body, now);
    await recordSoiled(db, actorOf(H1), body, now);
    expect(await db.select().from(linenMovements)).toHaveLength(1);
  });

  it("refusals carry a code: above par, the same ward, a room is not a ward, an item twice", async () => {
    await expect(topUpWard(db, actorOf(H1), { wardId: h.generalWard, lines: [{ itemCode: "bedsheet", qty: 31 }] }, now))
      .rejects.toMatchObject({ code: "above_par", details: { itemCode: "bedsheet", max: 30 } });
    await expect(borrowBetweenWards(db, actorOf(H1), { fromWardId: h.icuWard, toWardId: h.icuWard, lines: [{ itemCode: "towel", qty: 1 }] }, now))
      .rejects.toMatchObject({ code: "same_ward" });
    await expect(topUpWard(db, actorOf(H1), { wardId: h.aGeneralBed }, now)).rejects.toMatchObject({ code: "unknown_ward" });
    await expect(recordSoiled(db, actorOf(H1), { wardId: h.generalWard, lines: [{ itemCode: "towel", qty: 1 }, { itemCode: "towel", qty: 2 }] }, now))
      .rejects.toMatchObject({ code: "duplicate_item" });
  });

  it("the book balance follows the ledger; borrowing moves pieces between two books", async () => {
    await topUpWard(db, actorOf(H1), { wardId: h.generalWard, lines: [{ itemCode: "towel", qty: 10 }] }, now);
    await borrowBetweenWards(db, actorOf(H1), { fromWardId: h.generalWard, toWardId: h.icuWard, lines: [{ itemCode: "towel", qty: 4 }] }, now);
    await recordSoiled(db, actorOf(H1), { wardId: h.generalWard, lines: [{ itemCode: "towel", qty: 1 }] }, now);
    const towel = async (w: string) => (await wardStates(db, now, w))[0]!.items.find((i) => i.itemCode === "towel")!.onHand;
    expect(await towel(h.generalWard)).toBe(5);
    expect(await towel(h.icuWard)).toBe(4);
    const view = await linenHandlerView(db, now);
    expect(view.soiled.general).toEqual({ towel: 1 });
    expect(view.wards.map((w) => w.wardName)).toEqual(["General ward", "Medical ICU", "Private wing"]);
  });

  it("the ledger is append-only", async () => {
    await recordSoiled(db, actorOf(H1), { wardId: h.generalWard, lines: [{ itemCode: "towel", qty: 1 }] }, now);
    await expect(db.execute(sql`update linen_movements set qty = 2`)).rejects.toThrow(/append-only/);
    await expect(db.execute(sql`delete from linen_movements`)).rejects.toThrow(/append-only/);
  });

  it("a batch number is LN-<IST day>-<serial>", () => {
    expect(formatBatchNo(new Date("2026-03-31T20:00:00Z"), 7)).toBe("LN-20260401-0007");
  });
});
