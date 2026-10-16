import { and, eq, inArray } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { SUP1, W1, W2, actorOf, bagInStore, clockNow, hours, minutes, seedBmwHospital } from "../../../test/helpers/bmw";
import { putOnDuty } from "../../../test/helpers/tasks";
import { alerts, bmwBags, bmwDisputes, roleAssignments, roles, users } from "../../kernel/db/schema";
import { tasks as taskRows } from "../../kernel/db/schema";
import {
  bmwBoard, collectBag, generateBag, handOverManifest, recordCbwtfWeight, sweepBmwStorage,
} from "./index";
import type { Db } from "../../kernel/db/client";
import type { BmwHospital } from "../../../test/helpers/bmw";

/** PR #749 review findings — each pinned by a test that was red against the code before the fix. */
describe("bmw — review findings (PR #749)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let t0: Date;
  let h: BmwHospital;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    t0 = clockNow();
    h = await seedBmwHospital(db, hours(t0, -6));
  });

  const slip = (barcodes: string[]) => ({ barcodes, cbwtfName: "Bihar Biocare CBWTF", vehicleNo: "BR06GA1234" });

  it("1 · a bag weighed both per bag and in its category's slip is refused (weight_given_twice), nothing written", async () => {
    const a = await bagInStore(db, h.roomA, "yellow", 600, hours(t0, -5));
    const b = await bagInStore(db, h.roomB, "yellow", 400, hours(t0, -5));
    const m = await handOverManifest(db, actorOf(SUP1), slip([a, b]), hours(t0, -1));
    await expect(recordCbwtfWeight(db, actorOf(SUP1), {
      manifestId: m.id, byBag: [{ barcode: a, grams: 610 }], byCategory: [{ category: "yellow", grams: 1000 }],
    }, t0)).rejects.toMatchObject({ code: "weight_given_twice" });
    expect((await db.select().from(bmwBags).where(eq(bmwBags.manifestId, m.id))).map((x) => x.cbwtfWeightGrams)).toEqual([null, null]);
  });

  it("2 · a category slip that would give any bag 0 g is refused (slip_too_light)", async () => {
    const a = await bagInStore(db, h.roomA, "red", 5000, hours(t0, -5));
    const b = await bagInStore(db, h.roomB, "red", 1, hours(t0, -5));
    const m = await handOverManifest(db, actorOf(SUP1), slip([a, b]), hours(t0, -1));
    await expect(recordCbwtfWeight(db, actorOf(SUP1), { manifestId: m.id, byCategory: [{ category: "red", grams: 3 }] }, t0))
      .rejects.toMatchObject({ code: "slip_too_light" });
    expect(await db.select().from(bmwDisputes)).toHaveLength(0);
    expect((await db.select().from(bmwBags).where(eq(bmwBags.manifestId, m.id))).every((x) => x.state === "handed_over")).toBe(true);
  });

  it("3 · a bag generated while the last waiting bag is collected is never left without an open collection task", async () => {
    await putOnDuty(db, h, W1, minutes(t0, -60), minutes(t0, 480));
    for (let round = 0; round < 6; round += 1) {
      const at = minutes(t0, round * 20);
      const first = await generateBag(db, actorOf(SUP1), { category: "yellow", placeResourceId: h.roomA, deptWeightGrams: 500 }, at);
      const [, second] = await Promise.all([
        collectBag(db, actorOf(W1), { barcode: first.bag.barcode }, minutes(at, 1)),
        generateBag(db, actorOf(W2), { category: "red", placeResourceId: h.roomA, deptWeightGrams: 300 }, minutes(at, 1)),
      ]);
      const open = await db.select().from(taskRows).where(and(eq(taskRows.kind, "bmw_collection"), eq(taskRows.placeResourceId, h.roomA),
        inArray(taskRows.state, ["created", "assigned", "accepted", "in_progress"])));
      expect({ round, open: open.length }).toEqual({ round, open: 1 });
      await collectBag(db, actorOf(W1), { barcode: second.bag.barcode }, minutes(at, 2));
    }
  });

  it("4 · with no services supervisor the storage alarm goes to admin; with nobody it is counted unnotified", async () => {
    await db.delete(roleAssignments).where(eq(roleAssignments.roleKey, "services_supervisor"));
    await bagInStore(db, h.roomA, "yellow", 700, hours(t0, -49));
    const nobody = await sweepBmwStorage(db, t0);
    expect(nobody).toMatchObject({ alert: 1, noticesRaised: 0, unnotified: 1 });
    await db.insert(roles).values({ key: "admin", title: "Admin" }).onConflictDoNothing();
    await db.insert(users).values({ id: "01BMWADMIN0000000000000AD1", username: "it.admin", fullName: "it.admin", staffCode: "T-AD1", passwordHash: "x" });
    await db.insert(roleAssignments).values({ id: "RA-BMW-AD1", userId: "01BMWADMIN0000000000000AD1", roleKey: "admin", scopeType: "hospital", scopeId: null });
    const toAdmin = await sweepBmwStorage(db, minutes(t0, 1));
    expect(toAdmin).toMatchObject({ noticesRaised: 1, unnotified: 0 });
    expect((await db.select().from(alerts).where(eq(alerts.kind, "bmw.storage_alert"))).map((a) => a.userId)).toEqual(["01BMWADMIN0000000000000AD1"]);
  });

  it("6 · the board's counts come from the whole table, not from the shown list", async () => {
    for (let i = 0; i < 305; i += 1) {
      await generateBag(db, actorOf(W1), { category: "red", placeResourceId: i % 2 === 0 ? h.roomA : h.roomB, deptWeightGrams: 100 }, minutes(t0, -(i % 50)));
    }
    const board = await bmwBoard(db, t0);
    expect(board.onSite.length).toBeLessThan(305);
    expect(board.counts.onSite).toBe(305);
  });

  it("7 · a double tap with one idempotency key makes one bag; a fresh key makes another", async () => {
    const one = await generateBag(db, actorOf(W1), { category: "blue", placeResourceId: h.roomA, idempotencyKey: "tap-0000000001" }, t0);
    const again = await generateBag(db, actorOf(W1), { category: "blue", placeResourceId: h.roomA, idempotencyKey: "tap-0000000001" }, minutes(t0, 0.1));
    const other = await generateBag(db, actorOf(W1), { category: "blue", placeResourceId: h.roomA, idempotencyKey: "tap-0000000002" }, minutes(t0, 0.2));
    expect(again.bag.id).toBe(one.bag.id);
    expect(other.bag.id).not.toBe(one.bag.id);
    expect(await db.select().from(bmwBags)).toHaveLength(2);
  });
});
