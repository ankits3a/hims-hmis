import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { placeAndCreateStudy, setupRadiologyFixture } from "../../../test/helpers/radiology";
import { events, imagingStudies, orderItems, resources } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { recordAcquired, startAcquisition } from "./acquisition";
import { checkIn } from "./checkin";
import { evaluateReadiness, requireStudyGate, satisfyGate } from "./gates";
import { scheduleStudy } from "./schedule";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18a T7 — the two races: **A1's device occupancy** and **A6's single emit**. Their own file,
 * because a race needs real concurrent transactions.
 *
 * ═══ WHICH ONE NEEDS A HELD TRANSACTION, AND WHY THEY DIFFER (F21) ═══
 *
 * **A1 does not.** Its contention is `assignResource`'s row lock (`lockResource`), which every
 * caller must take before it can read the occupant at all — there is no pre-read in front of it to
 * short-circuit, so a serialised pair still produces one winner and one `already_occupied`.
 *
 * **A6 does.** Its control is a status compare-and-set, and T5's F21 is the lesson: two
 * `recordAcquired` calls that happen to serialise never reach the CAS — the loser's pre-read sees
 * `acquired` and refuses at the kindness check, so the assertion would pass against a read-then-write
 * implementation. Holding each transaction open past the other's pre-read is what constructs the
 * interleaving the assertion is actually about.
 */
describe("two consoles, one machine and one study (18a T7 A1/A6)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;

  const DAY = "2026-08-31";
  const NOW = new Date("2026-08-31T06:00:00.000Z");
  const SLOT = new Date("2026-08-31T09:00:00.000Z");
  const HOLD_MS = 200;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    seq = 0;
  });
  afterEach(() => { fx.unregister(); });

  let seq = 0;

  /** A plain USG on `ready` and authorised — one gate, one satisfy, `stat` so no cashier is needed. */
  const readyStat = async (deviceKey = "usg") => {
    seq += 1;
    const study = await placeAndCreateStudy(
      db, fx, "USG-ABDO", `k${String(seq)}`, new Date(NOW.getTime() + seq * 25 * 3_600_000),
    );
    await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, {
      studyId: study.studyId, deviceResourceId: fx.devices[deviceKey]!,
      scheduledAt: new Date(SLOT.getTime() + seq * 3_600_000),
    }));
    await withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: study.studyId, now: NOW }));
    const gate = await requireStudyGate(db, study.studyId, "identity_two_factor");
    await withTx(db, (tx) => satisfyGate(
      tx, fx.radiographer, gate.id, { secondIdentifier: "uhid", value: "HMS-00000001-5" }, NOW,
    ));
    await withTx(db, (tx) => evaluateReadiness(tx, study.studyId));
    await db.update(imagingStudies).set({ priority: "stat" }).where(eq(imagingStudies.id, study.studyId));
    return study;
  };

  const start = (studyId: string) =>
    withTx(db, (tx) => startAcquisition(tx, fx.radiographer, fx.decls, { studyId, onDate: DAY, now: NOW }));

  /**
   * A1 — TWO STUDIES, ONE MACHINE. The winner occupies it; the loser is refused by the KERNEL's
   * `already_occupied`, which is what spike S3 measured and why this file writes no status check.
   *
   * Five rounds, each on its own pair of studies, because one round of a race proves very little.
   * No fixture is rebuilt inside the loop — §2.144 / F17.
   */
  it("A1: two concurrent starts on one device — exactly ONE occupies it", async () => {
    for (let round = 0; round < 5; round += 1) {
      await db.update(resources).set({ status: "available", occupantRef: null, occupantType: null })
        .where(eq(resources.id, fx.devices.usg!));
      const a = await readyStat();
      const b = await readyStat();

      const settled = await Promise.allSettled([start(a.studyId), start(b.studyId)]);
      const fulfilled = settled.filter((r) => r.status === "fulfilled");
      const rejected = settled.filter((r) => r.status === "rejected");
      expect([round, fulfilled.length, rejected.length]).toEqual([round, 1, 1]);
      expect([round, (rejected[0] as PromiseRejectedResult).reason.code])
        .toEqual([round, "already_occupied"]);

      /** And the LOSER's envelope item never moved — A1's mutant is only visible here. */
      const loserId = (fulfilled[0] as PromiseFulfilledResult<{ studyId: string }>).value.studyId === a.studyId
        ? b : a;
      const [item] = await db.select().from(orderItems).where(eq(orderItems.id, loserId.itemId));
      expect([round, item!.status]).toEqual([round, "placed"]);
    }
  });

  /**
   * A6 — ONE STUDY, TWO CONSOLES RECORDING IT. The held transaction is what makes both callers read
   * `in_acquisition` before either commits, so the loser's conditional UPDATE is what refuses rather
   * than its pre-read. Without the hold this measures the Node scheduler (F21).
   */
  it("A6: two concurrent `recordAcquired` on one study — one lands, one is refused, ONE event", async () => {
    const study = await readyStat();
    await start(study.studyId);

    const race = () => withTx(db, async (tx) => {
      const r = await recordAcquired(tx, fx.radiographer, fx.decls, {
        studyId: study.studyId, onDate: DAY, imageSource: "no_pacs_images", now: NOW,
      });
      await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
      return r;
    });

    const settled = await Promise.allSettled([race(), race()]);
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect((settled.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.code)
      .toBe("already_acquired");

    /** 18c counts this event to build a dose register. Two of them is one patient's dose, twice. */
    const emitted = (await db.select().from(events)).filter((e) => e.name === "imaging.study_acquired");
    expect(emitted).toHaveLength(1);

    const [row] = await db.select().from(imagingStudies).where(eq(imagingStudies.id, study.studyId));
    expect(row!.status).toBe("acquired");
    const [device] = await db.select().from(resources).where(eq(resources.id, fx.devices.usg!));
    expect(device!.status).toBe("available");
  });

  /** The sequential second call takes the kindness lane, and both must exist. */
  it("the sequential second `recordAcquired` is `already_acquired` too", async () => {
    const study = await readyStat();
    await start(study.studyId);
    const once = () => withTx(db, (tx) => recordAcquired(tx, fx.radiographer, fx.decls, {
      studyId: study.studyId, onDate: DAY, imageSource: "no_pacs_images", now: NOW,
    }));
    await once();
    await expect(once()).rejects.toMatchObject({ code: "already_acquired" });
    expect((await db.select().from(events)).filter((e) => e.name === "imaging.study_acquired")).toHaveLength(1);
  });
});
