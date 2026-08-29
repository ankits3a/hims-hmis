import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  activateOpdVisitDefinition, ensureRole, mkDoctor, mkPatient, mkUser, openOpdVisit, seedOpdBase, seedOpdMasters,
} from "../../../test/helpers/opd";
import { grantPermissionToRole, syncPermissions } from "../auth/permissions";
import { ModuleRegistry } from "../modules/loader";
import { ALL_MANIFESTS } from "../modules/manifests";
import { userDayFacts } from "../db/schema";
import { collectDeskProviders } from "./registry";
import { addDays, factsForWindow, liveFactsFor, rollupUserDay, sumWindow } from "./rollup";
import { PERIODS, windowFor } from "./brief";
import type { DeskProvider } from "./types";
import type { Db } from "../db/client";

/**
 * PLAN 07c T8 A1, **ON A SIX-MONTH WINDOW** — the CLOSE item the phase shipped without.
 *
 * The 07c close report says so in as many words: *"the rollup was never run against a seeded
 * six-month dataset. A1 is proven over a three-day window. The arithmetic does not change with
 * length, but the performance claim in DD13 is an inference from the index measurement rather than
 * an observation of the job at scale."* This suite closes the arithmetic half of that gap.
 *
 * ═══ WHAT IT DOES, AND WHAT IT DELIBERATELY DOES NOT ═══
 *
 * It seeds REAL visits through `openOpdVisit` — the module's own writer, never a raw insert — on a
 * SAMPLE of days spread across the whole 183-day window, and rolls EVERY day in that window. Then,
 * for all five periods, it compares the sum the brief would serve from `user_day_facts` against the
 * same window recomputed live, day by day, through the very function the rollup is a cache of.
 *
 * It does NOT seed 183 days of full clinic traffic. That is a load test, it belongs with the
 * performance work DD13's index measurement covers, and pretending 24 seeded days is 2,000
 * visits/day would be a worse claim than the honest one. **What is proven here is that the cache
 * and the truth agree across a six-month span, on days with activity and days without.**
 */
const ANCHOR = "2026-08-17"; // the window's last day; every window below ends here
const AT = (day: string): Date => new Date(`${day}T04:00:00.000Z`); // 09:30 IST

describe("07c T8 A1 — the rollup reconciles to live across a six-month window", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let providers: DeskProvider[];
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let deptId: string;
  let doctorId: string;
  const registry = new ModuleRegistry();
  for (const m of ALL_MANIFESTS) registry.install(m);

  /** Every day of the six-month window — the widest period `brief.ts` serves. */
  const ALL_DAYS = Array.from({ length: 183 }, (_, i) => addDays(ANCHOR, -(182 - i)));
  /** The days that get real traffic: every eighth, so each period contains several and some none. */
  const BUSY_DAYS = ALL_DAYS.filter((_, i) => i % 8 === 0);

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
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
    providers = collectDeskProviders(registry);

    // Real visits, through the module's own writer, spread across the whole window.
    let n = 0;
    for (const day of BUSY_DAYS) {
      const p = await mkPatient(db, clerk.actor, { phone: `98765${String(41000 + n).padStart(5, "0")}` });
      await openOpdVisit(db, { clerk: clerk.actor, patientId: p.id, departmentId: deptId, doctorId }, AT(day));
      n += 1;
    }
    // Roll EVERY day, including the empty ones — a rolled zero and an unrolled day must not be
    // confused, and the window reader's own assertion depends on the difference.
    for (const day of ALL_DAYS) await rollupUserDay(db, providers, clerk.id, day, AT(ANCHOR));
  }, 600_000);

  afterAll(async () => teardown());

  it("seeded a six-month window with traffic spread across it", async () => {
    expect(ALL_DAYS).toHaveLength(183);
    expect(BUSY_DAYS.length).toBeGreaterThanOrEqual(20);
    const rows = await db.select().from(userDayFacts).where(eq(userDayFacts.userId, clerk.id));
    expect(rows).toHaveLength(183);
  });

  /**
   * A1, FOR ALL FIVE PERIODS. The brief serves the rollup; this recomputes the identical window
   * live, day by day, and demands the same number. A cached total and a live total that differ is
   * the worst outcome this design can produce — both look authoritative and neither says which is
   * right.
   */
  it.each([...PERIODS])("A1: the %s window sums the rollup to exactly what live recomputes", async (period) => {
    const w = windowFor(period, ANCHOR);
    // `today` is set BEYOND the window so every day is served from the rollup — this leg is about
    // the CACHE agreeing with the truth, not about the live-today seam (covered in rollup.test.ts).
    const rolled = sumWindow(await factsForWindow(db, providers, clerk.actor, w.from, w.to, addDays(ANCHOR, 1), AT(ANCHOR)));

    let live = 0;
    for (const day of ALL_DAYS.filter((d) => d >= w.from && d <= w.to)) {
      const f = await liveFactsFor(providers, { db, actor: clerk.actor, reader: clerk.actor, date: day, now: AT(ANCHOR) });
      live += f["opd.visitsOpened"] ?? 0;
    }

    expect(rolled["opd.visitsOpened"]).toBe(live);
  }, 600_000);

  /** The six-month window must actually contain the traffic — otherwise every leg above is 0 = 0. */
  it("A1 is not vacuous: the six-month window carries every seeded visit", async () => {
    const w = windowFor("half", ANCHOR);
    const rolled = sumWindow(await factsForWindow(db, providers, clerk.actor, w.from, w.to, addDays(ANCHOR, 1), AT(ANCHOR)));
    expect(rolled["opd.visitsOpened"]).toBe(BUSY_DAYS.length);
    // …and the periods nest, which is what makes the five briefs tell one story rather than five.
    const day = sumWindow(await factsForWindow(db, providers, clerk.actor, ANCHOR, ANCHOR, addDays(ANCHOR, 1), AT(ANCHOR)));
    expect(rolled["opd.visitsOpened"]).toBeGreaterThanOrEqual(day["opd.visitsOpened"] ?? 0);
  });
});
