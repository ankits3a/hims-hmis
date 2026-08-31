import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { appendEvent } from "../events/append";
import { SubscriptionBus } from "../events/subscriptions";
import { runDispatchCycle } from "../events/dispatcher";
import { withTx, Db } from "../db/client";
import { ALERTS_CONSUMER } from "../alerts/consumer";
import { NOTIFY_CONSUMER } from "../notify/consumer";
import { PARTNERS_ACCRUAL_CONSUMER } from "../../modules/partners";
import { MATERIALS_CONSUMPTION_CONSUMER } from "../../modules/materials";
import { OT_IMPLANT_CONFIRMED_CONSUMER, OT_PATIENT_MERGED_CONSUMER } from "../../modules/ot";
import { RADIOLOGY_ORDER_PLACED_CONSUMER } from "../../modules/radiology";
import { seedCursors } from "./seed-cursors";

const mkInput = (name: string) => ({
  name, version: 1, occurredAt: new Date(),
  actor: { type: "system" as const, id: "test" }, module: "opd",
  payload: { n: name }, siteId: "main",
});

const cursorOf = async (db: Db, consumer: string): Promise<number> => {
  const rows = (await db.execute(
    sql`select last_seq as "lastSeq" from event_cursors where consumer = ${consumer}`,
  )).rows as { lastSeq: number | string }[];
  return rows.length === 0 ? 0 : Number(rows[0]!.lastSeq);
};

describe("seedCursors", () => {
  let db: Db; let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  /**
   * PLAN 09 T6 — THE CENSUS MOVED, AND THE THIRD ENTRY IS NOT JUST A NUMBER.
   *
   * `workerConsumers(db)` gained `partners.accrual` (DD7: four subscriptions, one handler, and a
   * flag that decides only whether it WRITES), so this list is three. The bump is disclosed in
   * T6's task report as a Files-list deviation — this file is named in no task's Files list and
   * §6.0's sweep did not find it, which is the same shape as S2, S9, S11 and S14 and the same
   * remedy the phase already applied once (T3 / `deploy-parity.test.ts`): correct the census in
   * place, with the reason, rather than push a red tree or drop the wire that moved it.
   *
   * WHAT SEEDING THE NEW CONSUMER ACTUALLY DOES, because it looks like it contradicts DD7 and does
   * not. `seedCursors` sets a brand-new consumer's cursor to `max(seq)` — i.e. it SKIPS the history
   * that existed at deployment time, which is the flood D10 exists to prevent. DD7's promise is
   * that a later flag flip does not lose that history; the mechanism that keeps that promise is
   * `replayAccruals`, which walks the `events` TABLE directly and reads no cursor at all. So the
   * two are complementary: the live lane starts at the head and writes nothing until the flag is
   * on, and the backfill fills the ledger in from event history when it is.
   *
   * ═══ FOUR SINCE PLAN 14 T7 / DD13, AND IT IS THE SAME SHAPE A FIFTH TIME ═══
   *
   * `materials.consumption` subscribes to `consignment.deployed`. **This file was not in T7's Files
   * list either** — the paragraph above predicted exactly that ("this file is named in no task's
   * Files list") and it happened again; recorded as finding F12 in Plan 14's CLOSE, with the same
   * remedy: correct the census in place, with the reason.
   *
   * **What seeding THIS consumer does is the interesting part.** `consignment.deployed` is defined
   * by Plan 14 and EMITTED BY PLAN 15, so on the deploy that ships Plan 14 the cursor is set to
   * `max(seq)` over a history that contains none of them — and then Plan 15's first scan-on-use
   * lands after it and is delivered. That is the correct outcome and it is why the consumer is
   * wired a phase early: without a seeded cursor the consumer's first cycle after Plan 15 ships
   * would start from zero and re-walk every event the hospital has ever emitted.
   */
  it("enumerates workerConsumers(db)'s keys — the kernel two, partners.accrual, materials.consumption, the OT's two and radiology's, and no others", async () => {
    const seeded = await seedCursors(db);
    // PLAN 15 T2 / A5 — the fifth. It joins for the reason D10 gives every entry here: a consumer
    // whose cursor is not seeded starts from zero and re-reads the WHOLE subscribed backlog on its
    // first cycle. For this one that means replaying every `patient.merged` since Plan 05 against a
    // module that did not exist for any of them — harmless by luck (no OT row names those patients)
    // and not a property anybody should be relying on.
    //
    // **THIS FILE IS NOT IN PLAN 15 T2's FILES LIST** — a census the task moves, recorded as finding
    // T2-f with the three others rather than fixed silently.
    expect(seeded.map((s) => s.consumer).sort())
      .toEqual([
        ALERTS_CONSUMER, NOTIFY_CONSUMER, PARTNERS_ACCRUAL_CONSUMER, MATERIALS_CONSUMPTION_CONSUMER,
        OT_PATIENT_MERGED_CONSUMER,
        // PLAN 15 T5 / DD9 — the sixth. Same reason as the fifth: an unseeded cursor starts from
        // zero and re-reads every `material.consumed` since Plan 14's consumer first ran.
        OT_IMPLANT_CONFIRMED_CONSUMER,
        // PLAN 18a T3 — the seventh, and the FIRST whose unseeded cursor would replay a KERNEL
        // event. `order.placed` has been raised by every lab order since Plan 17, so a radiology
        // consumer starting from zero would walk the entire lab backlog on its first cycle,
        // returning immediately on each (`kind !== "imaging"`) — harmless by construction rather
        // than by luck, which is a better reason than the fifth entry could give, and still not a
        // property to rely on when seeding the cursor costs one line.
        //
        // **THIS FILE IS NOT IN 18a T3's FILES LIST** — the fifth census this task moves and the
        // second consumer census, recorded as finding F14 rather than fixed silently, exactly as
        // Plan 15 recorded T2-f.
        RADIOLOGY_ORDER_PLACED_CONSUMER,
      ].sort());
  });

  /**
   * V10 — THE FLOOD THIS EXISTS TO PREVENT, PROVEN AGAINST HISTORY SEEDED FIRST.
   *
   * The plan's own words: "the flood has never actually been observed because the dev DB holds
   * no subscribed events — so a test that does not seed history first is asserting nothing."
   * History goes in BEFORE `seedCursors` runs, so the cursor it produces is a real answer to a
   * real backlog, not an artefact of an empty table where `max(seq)` and "no history" look
   * identical.
   *
   * THE EXPLICIT `lookback: 0`, AND WHY IT IS NOT A DIFFERENT CLAIM. `runDispatchCycle`'s window
   * is `seq > max(cursor − lookback, 0)` (dispatcher.ts), never `seq > cursor` directly — the
   * look-back exists to catch a row that committed late (dispatcher.test.ts's L1). At the
   * DEFAULT lookback (5000) a fixture with only a handful of history rows floors at 0 either
   * way, seeded or not, which would make this test pass under the mutant too (both leave the
   * whole tiny backlog inside the window) and prove nothing (rule 21). In production the
   * distinction is real the moment subscribed history exceeds 5000 rows — exactly the volume
   * D10 exists for. `lookback: 0` reproduces that same floor (`seq > cursor`) without paying for
   * 5000 inserts, the same knob dispatcher.test.ts's own suite overrides explicitly for
   * determinism (its "does not redeliver ... re-reads" case sets `lookback: 5_000`).
   */
  it("V10 — leaves a newly-seeded consumer at max(seq); the next cycle delivers nothing", async () => {
    for (let i = 0; i < 4; i += 1) {
      await withTx(db, (tx) => appendEvent(tx, mkInput("alert.raised")));
    }
    const last = await withTx(db, (tx) => appendEvent(tx, mkInput("alert.raised")));

    const seeded = await seedCursors(db);
    const alertsSeed = seeded.find((s) => s.consumer === ALERTS_CONSUMER);
    expect(alertsSeed).toBeDefined();
    expect(alertsSeed!.lastSeq).toBe(last.seq); // max(seq) at seed time — the whole backlog
    expect(await cursorOf(db, ALERTS_CONSUMER)).toBe(last.seq);

    const delivered: number[] = [];
    const bus = new SubscriptionBus();
    bus.on(ALERTS_CONSUMER, "alert.raised", async (e) => { delivered.push(e.seq); });

    expect(await runDispatchCycle(db, bus, { lookback: 0 })).toBe(0); // shipped: nothing replayed
    expect(delivered).toEqual([]);
  });

  /**
   * V11 — SEEDING NEVER LOWERS AN EXISTING CURSOR.
   *
   * Staged directly rather than produced by a race (matching dispatcher.test.ts's own precedent
   * for a cursor state only a concurrent process can reach): an existing cursor ahead of
   * `max(seq)` — a live dispatch cycle already past the current backlog — must survive a seeding
   * run untouched. An unconditional overwrite would drag it back to `max(seq)`, and everything
   * between the regressed cursor and the value it held would be delivered again next cycle.
   */
  it("V11 — never lowers an existing cursor that already sits ahead of max(seq)", async () => {
    const e1 = await withTx(db, (tx) => appendEvent(tx, mkInput("alert.raised")));
    const aheadOfHistory = e1.seq + 1000;
    await db.execute(sql`
      insert into event_cursors (consumer, last_seq) values (${ALERTS_CONSUMER}, ${aheadOfHistory})
    `);

    const seeded = await seedCursors(db);
    const alertsSeed = seeded.find((s) => s.consumer === ALERTS_CONSUMER);
    expect(alertsSeed).toBeDefined();
    expect(alertsSeed!.lastSeq).toBe(aheadOfHistory); // untouched
    expect(await cursorOf(db, ALERTS_CONSUMER)).toBe(aheadOfHistory);
  });

  it("is idempotent: seeding twice with no new history leaves the cursor exactly where it was", async () => {
    await withTx(db, (tx) => appendEvent(tx, mkInput("alert.raised")));
    const first = await seedCursors(db);
    const second = await seedCursors(db);
    expect(second).toEqual(first);
  });
});
