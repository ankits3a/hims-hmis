import { and, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  activateOpdVisitDefinition, ensureRole, mkDoctor, mkPatient, mkUser, openOpdVisit, seedOpdBase, seedOpdMasters,
} from "../../../test/helpers/opd";
import { grantPermissionToRole, syncPermissions } from "../auth/permissions";
import { ModuleRegistry } from "../modules/loader";
import { ALL_MANIFESTS } from "../modules/manifests";
import { userDayFacts, users } from "../db/schema";
import { collectDeskProviders } from "./registry";
import { DeskError } from "./types";
import { addDays, factsForWindow, liveFactsFor, rollupAll, rollupUserDay, sumWindow } from "./rollup";
import { buildBrief, windowFor } from "./brief";
import type { DeskProvider } from "./types";
import type { Db } from "../db/client";

/**
 * PLAN 07c T8 / DD13 — THE NIGHTLY ROLL AND THE WINDOW READER, WHICH MUST NEVER DISAGREE.
 *
 * A cached total and a live total that differ is the worst outcome available to this task: both
 * look authoritative, neither says which is right, and the person reading them is the one who has
 * to explain the gap. A1 is therefore not a nicety — it is the property that makes the cache
 * safe to exist at all, and it holds because there is exactly ONE arithmetic (`liveFactsFor`) of
 * which the rollup is a cache.
 */
const T0 = new Date("2026-08-17T04:00:00.000Z"); // Monday 09:30 IST
const DAY = "2026-08-17";

describe("07c T8 — the user-day rollup", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let providers: DeskProvider[];
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let other: Awaited<ReturnType<typeof mkUser>>;
  let deptId: string;
  let doctorId: string;
  const registry = new ModuleRegistry();
  for (const m of ALL_MANIFESTS) registry.install(m);

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await syncPermissions(db, registry);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const masters = await seedOpdMasters(db);
    deptId = masters.deptId;
    doctorId = (await mkDoctor(db, { username: "dra", departmentId: deptId, roomId: masters.roomId })).doctorId;
    await ensureRole(db, "desk_clerk");
    await grantPermissionToRole(db, registry, "desk_clerk", "opd.queue.read");
    clerk = await mkUser(db, "clerk_a", ["desk_clerk"]);
    other = await mkUser(db, "clerk_b", ["desk_clerk"]);
    providers = collectDeskProviders(registry);
  });

  const openOne = async (u: { actor: { type: "user"; id: string } | typeof clerk.actor }, at: Date, phone: string) => {
    const p = await mkPatient(db, u.actor, { phone });
    await openOpdVisit(db, { clerk: u.actor, patientId: p.id, departmentId: deptId, doctorId }, at);
  };

  const stored = async (userId: string, day: string) =>
    (await db.select().from(userDayFacts).where(and(eq(userDayFacts.userId, userId), eq(userDayFacts.day, day))))[0];

  /**
   * A1 — THE ROLLUP IS A CACHE OF THE LIVE QUERY, AND THIS IS WHAT SAYS SO.
   */
  it("A1: what the roll stores is exactly what the live computation returns for that day", async () => {
    await openOne(clerk, T0, "9876540031");
    await openOne(clerk, T0, "9876540032");

    const live = await liveFactsFor(providers, { db, actor: clerk.actor, reader: clerk.actor, date: DAY, now: T0 });
    await rollupUserDay(db, providers, clerk.id, DAY, T0);

    expect((await stored(clerk.id, DAY))!.facts).toEqual(live);
    expect(live["opd.visitsOpened"]).toBe(2);
    /*
     * AND REGISTRATIONS ARE ZERO ON THIS DAY, WHICH IS CORRECT AND WORTH ASSERTING. The two facts
     * are cut on DIFFERENT grains, deliberately: a visit carries `service_date`, an IST calendar day
     * the fixture stamps as T0, while a patient carries only `created_at`, which the helper stamps
     * at wall-clock now. So these two patients were registered today and their visits were opened on
     * the 17th, and the provider reports each against the day it actually happened.
     *
     * The failure this pins is the tempting simplification — filtering a timestamp column against a
     * date string — which silently drops the 18:30-to-midnight slice of every day and is invisible
     * because the number is merely small rather than absent.
     */
    expect(live["opd.patientsRegistered"]).toBe(0);
  });

  /**
   * A1, THE WINDOW FORM — the assertion the brief actually rests on. A window that mixes rolled
   * days and today must sum to what a day-by-day live computation gives, or a week's brief and a
   * day's brief disagree about the same Monday.
   */
  it("A1: a window summed from the rollup equals the same window summed live, day by day", async () => {
    const days = [addDays(DAY, -2), addDays(DAY, -1), DAY];
    for (const day of days) {
      await openOne(clerk, new Date(`${day}T04:00:00.000Z`), `98765403${days.indexOf(day)}9`);
    }
    for (const day of days.slice(0, 2)) await rollupUserDay(db, providers, clerk.id, day, T0);

    const fromRollup = sumWindow(await factsForWindow(db, providers, clerk.actor, days[0]!, DAY, DAY, T0));

    let liveTotal = 0;
    for (const day of days) {
      const f = await liveFactsFor(providers, { db, actor: clerk.actor, reader: clerk.actor, date: day, now: T0 });
      liveTotal += f["opd.visitsOpened"] ?? 0;
    }
    expect(fromRollup["opd.visitsOpened"]).toBe(liveTotal);
    expect(fromRollup["opd.visitsOpened"]).toBe(3);
  });

  /**
   * A2 — IDEMPOTENCE IS STRUCTURAL. `(user_id, day)` is the PRIMARY KEY, so no shape of retry,
   * overlap or double-scheduling can give one person two rows for one day. An append-only design
   * would double every retried day and look fine until somebody summed a month.
   */
  it("A2: rolling the same day twice changes the numbers not at all, and writes ONE row", async () => {
    await openOne(clerk, T0, "9876540041");
    await rollupUserDay(db, providers, clerk.id, DAY, T0);
    const first = await stored(clerk.id, DAY);

    await rollupUserDay(db, providers, clerk.id, DAY, new Date(T0.getTime() + 3_600_000));

    const rows = await db.select().from(userDayFacts).where(eq(userDayFacts.userId, clerk.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.facts).toEqual(first!.facts);
    // …and `computed_at` DID move, so an operator can tell a fresh roll from a stale one.
    expect(rows[0]!.computedAt.getTime()).toBeGreaterThan(first!.computedAt.getTime());
  });

  /**
   * A2, THE OTHER HALF — AND IT IS THE HALF A MUTANT COULD NOT REACH.
   *
   * The Assertion Book's mutant for A2 is *"append instead of claim → every retry doubles a
   * person's day"*, and that mutant CANNOT BE BUILT against this schema: `(user_id, day)` is the
   * PRIMARY KEY, so an appending implementation does not produce a doubled day, it produces an
   * error from Postgres. Writing it and watching it fail to compile — or fail for the wrong reason
   * — would have proved nothing (rule 21).
   *
   * So the property is evidenced where it actually lives: this test asks the database directly for
   * a second row for the same person and the same day, and reads the refusal. That is stronger than
   * the mutant would have been. Idempotence here is a CONSTRAINT, not a code path that a later edit
   * can drop, and this is the assertion that says so.
   */
  it("A2: the database itself REFUSES a second row for one person and one day", async () => {
    await rollupUserDay(db, providers, clerk.id, DAY, T0);
    await expect(
      db.insert(userDayFacts).values({ userId: clerk.id, day: DAY, facts: {}, computedAt: T0 }),
    ).rejects.toThrow(/duplicate key|unique constraint/i);

    expect(await db.select().from(userDayFacts).where(eq(userDayFacts.userId, clerk.id))).toHaveLength(1);
  });

  /**
   * A5 — A CORRECTED DAY RE-ROLLS, and it does so by recomputing rather than by applying a delta.
   * That is what makes a cache safe to be wrong for a few hours: there is nothing to compensate.
   */
  it("A5: a day that gains a visit after it was rolled is correct again on the next roll", async () => {
    await openOne(clerk, T0, "9876540051");
    await rollupUserDay(db, providers, clerk.id, DAY, T0);
    expect((await stored(clerk.id, DAY))!.facts).toMatchObject({ "opd.visitsOpened": 1 });

    await openOne(clerk, T0, "9876540052"); // a backfilled visit for a day already rolled
    await rollupUserDay(db, providers, clerk.id, DAY, T0);

    expect((await stored(clerk.id, DAY))!.facts).toMatchObject({ "opd.visitsOpened": 2 });
  });

  /**
   * A3 — TODAY IS NEVER ROLLED, and the window reader computes it live and says it is provisional.
   * The nightly job's window ends YESTERDAY for exactly this reason: a row for a day that is still
   * happening is a settled-looking answer to an unsettled question.
   */
  it("A3: the nightly roll covers the days ENDING YESTERDAY and never writes today", async () => {
    const res = await rollupAll(db, providers, DAY, T0);
    const days = (await db.select({ day: userDayFacts.day }).from(userDayFacts)).map((r) => r.day);

    expect(days).not.toContain(DAY);
    expect([...new Set(days)].sort()).toEqual([addDays(DAY, -3), addDays(DAY, -2), addDays(DAY, -1)]);
    expect(res.days).toBe(3);
    // Every ACTIVE user is rolled — the fixture's clerks, the doctor and the definition users.
    expect(res.users).toBe((await db.select().from(users).where(eq(users.active, true))).length);
  });

  it("A3: today comes back from the window reader LIVE and marked provisional", async () => {
    await openOne(clerk, T0, "9876540061");
    await rollupAll(db, providers, DAY, T0); // rolls yesterday and before; today is untouched

    const window = await factsForWindow(db, providers, clerk.actor, addDays(DAY, -2), DAY, DAY, T0);
    const today = window.find((d) => d.day === DAY);

    expect(today?.provisional).toBe(true);
    expect(today?.facts["opd.visitsOpened"]).toBe(1);
    expect(window.filter((d) => d.day !== DAY).every((d) => !d.provisional)).toBe(true);
  });

  /**
   * A DAY NOBODY ROLLED IS ABSENT, NOT ZERO. A person who did not work on Sunday and a Sunday the
   * job never ran on are different facts, and rendering the second as a zero makes a broken job
   * look like a quiet weekend — which is the one reading nobody would investigate.
   */
  it("a day with no rollup row is absent from the window rather than a zero", async () => {
    const window = await factsForWindow(db, providers, clerk.actor, addDays(DAY, -5), addDays(DAY, -1), DAY, T0);
    expect(window).toEqual([]);
  });

  /** The permission gate is the desk's, applied before the provider runs — never run-then-filter. */
  it("a person who holds no desk permission contributes no facts at all", async () => {
    await openOne(clerk, T0, "9876540071");
    const stranger = await mkUser(db, "stranger", []);
    expect(await liveFactsFor(providers, { db, actor: stranger.actor, reader: stranger.actor, date: DAY, now: T0 })).toEqual({});
  });

  it("one clerk's roll never carries another clerk's work", async () => {
    await openOne(clerk, T0, "9876540081");
    await rollupUserDay(db, providers, clerk.id, DAY, T0);
    await rollupUserDay(db, providers, other.id, DAY, T0);

    expect((await stored(clerk.id, DAY))!.facts).toMatchObject({ "opd.visitsOpened": 1 });
    expect((await stored(other.id, DAY))!.facts).toMatchObject({ "opd.visitsOpened": 0 });
  });

  /**
   * THE FACT CONTRACT, REFUSED AT THE BOUNDARY. A float arrives because somebody divided by 100
   * upstream; a NaN poisons every window it appears in and renders as "NaN" on a printed shift
   * report. Both are programming errors in a provider and both are cheap to catch exactly here.
   */
  it("a provider returning a non-countable fact is REFUSED, not stored", async () => {
    const bad: DeskProvider = {
      key: "bad.desk", permission: "opd.queue.read",
      load: async () => [],
      facts: async () => ({ "bad.money": 12.5 }),
    };
    await expect(liveFactsFor([bad], { db, actor: clerk.actor, reader: clerk.actor, date: DAY, now: T0 }))
      .rejects.toBeInstanceOf(DeskError);
  });

  /** A provider whose QUERY fails costs its own facts and never the whole brief. */
  it("a provider that throws costs its own numbers and nothing else", async () => {
    const boom: DeskProvider = {
      key: "boom.desk", permission: "opd.queue.read",
      load: async () => [],
      facts: () => Promise.reject(new Error("index missing")),
    };
    const facts = await liveFactsFor([...providers, boom], { db, actor: clerk.actor, reader: clerk.actor, date: DAY, now: T0 });
    expect(facts["opd.visitsOpened"]).toBeDefined();
  });

  /** End to end: a real window, through the real generator, produces a real clause. */
  it("the brief a week's window produces speaks about what actually happened", async () => {
    await openOne(clerk, T0, "9876540091");
    const w = windowFor("week", DAY);
    const days = await factsForWindow(db, providers, clerk.actor, w.from, w.to, DAY, T0);
    const brief = buildBrief("week", DAY, days, []);

    expect(brief.clauses).toContainEqual({ key: "brief.visits.plain", values: { total: "1" } });
    expect(brief.daysWithActivity).toBe(1);
  });
});
