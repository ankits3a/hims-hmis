import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "./helpers/db";
import {
  activateOpdVisitDefinition, ensureRole, mkDoctor, mkPatient, mkUser, openOpdVisit, seedOpdBase,
  seedOpdMasters,
} from "./helpers/opd";
import { grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { ALL_MANIFESTS } from "../src/kernel/modules/manifests";
import { opdEncounters } from "../src/kernel/db/schema";
import { collectDeskProviders } from "../src/kernel/desk/registry";
import { addDays, liveFactsFor, sumWindow } from "../src/kernel/desk/rollup";
import { mergeBuckets, totalsOf } from "../src/kernel/desk/range";
import { opdRange } from "../src/modules/opd/range";
import type { DeskProvider } from "../src/kernel/desk/types";
import type { RangeDimension } from "../src/kernel/desk/range";
import type { Db } from "../src/kernel/db/client";

/**
 * ═══ PHASE STAFF-REPORTS T3 — THE TWO INSTRUMENTS MUST AGREE. THIS IS THAT ASSERTION. ═══
 *
 * The phase deliberately has two ways to count the same events:
 *
 *   - `user_day_facts` — the PULSE. Pre-aggregated per person per day, summed across a window,
 *     cheap enough to read on every desk render. It cannot hold a breakdown, because its keys are
 *     stored and a key per department would orphan history on a rename.
 *   - `opdRange` — the BREAKDOWN. Live SQL over the source tables, grouped by whatever dimensions
 *     the reader asked for, bounded by their date range.
 *
 * **The cost of having two is that they can disagree**, and the failure is specific and corrosive:
 * a hospital shown 214 on a dashboard and 211 in the export it downloaded from the same screen
 * stops trusting both numbers, and nothing on either surface says which is wrong. `rollup.test.ts`
 * makes exactly this argument about its own A1 — *"a cached total and a live total that differ is
 * the worst outcome available to this task: both look authoritative, neither says which is right,
 * and the person reading them is the one who has to explain the gap"* — and this file is the same
 * property one level out, between two different queries rather than a query and its cache.
 *
 * It is scoped as part of T3 rather than as a follow-up for that reason. A reconciliation test
 * written later is a reconciliation test written after the two have already drifted.
 */
const T0 = new Date("2026-08-17T04:00:00.000Z"); // Monday 09:30 IST
const DAY = "2026-08-17";

/** The measures both instruments claim to count. A new shared measure belongs in this list. */
const RECONCILED = [
  "opd.visitsOpened",
  "opd.visitsNew",
  "opd.visitsRevisit",
  "opd.visitsRenewal",
  "opd.appointmentsBooked",
] as const;

describe("staff-reports T3 — the pulse and the breakdown agree", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let providers: DeskProvider[];
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let other: Awaited<ReturnType<typeof mkUser>>;
  let deptId: string;
  let dept2Id: string;
  let doctorId: string;
  let doctor2Id: string;
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
    dept2Id = masters.dept2Id;
    doctorId = (await mkDoctor(db, { username: "dra", departmentId: deptId, roomId: masters.roomId })).doctorId;
    doctor2Id = (await mkDoctor(db, { username: "drb", departmentId: dept2Id, roomId: masters.room2Id })).doctorId;
    await ensureRole(db, "desk_clerk");
    await grantPermissionToRole(db, registry, "desk_clerk", "opd.queue.read");
    clerk = await mkUser(db, "clerk_a", ["desk_clerk"]);
    other = await mkUser(db, "clerk_b", ["desk_clerk"]);
    providers = collectDeskProviders(registry);
  });

  let phone = 9876540000;
  const open = async (
    u: Awaited<ReturnType<typeof mkUser>>, at: Date,
    over: { departmentId?: string; doctorId?: string; visitType?: "new" | "revisit" | "renewal" } = {},
  ): Promise<void> => {
    phone += 1;
    const p = await mkPatient(db, u.actor, { phone: String(phone) });
    const { encounterId } = await openOpdVisit(db, {
      clerk: u.actor, patientId: p.id,
      departmentId: over.departmentId ?? deptId, doctorId: over.doctorId ?? doctorId,
    }, at);
    if (over.visitType !== undefined) {
      await db.update(opdEncounters).set({ visitType: over.visitType }).where(eq(opdEncounters.id, encounterId));
    }
  };

  /** THE PULSE: every day in the window, computed the way the rollup computes it, then summed. */
  const pulse = async (
    u: Awaited<ReturnType<typeof mkUser>>, from: string, to: string,
  ): Promise<Record<string, number>> => {
    const days: { day: string; facts: Record<string, number>; provisional: boolean }[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      days.push({
        day: d, provisional: false,
        facts: await liveFactsFor(providers, { db, actor: u.actor, reader: u.actor, date: d, now: T0 }),
      });
    }
    return sumWindow(days);
  };

  /** THE BREAKDOWN: the same window through the live range query, totalled. */
  const breakdown = async (
    from: string, to: string, groupBy: RangeDimension[], userIds?: string[],
  ): Promise<Record<string, number>> => totalsOf(mergeBuckets(
    await opdRange({ db, reader: clerk.actor, filters: { from, to, userIds }, groupBy, now: T0 }),
    groupBy,
  ));

  const compare = (a: Record<string, number>, b: Record<string, number>): void => {
    for (const m of RECONCILED) expect([m, b[m] ?? 0]).toEqual([m, a[m] ?? 0]);
  };

  /**
   * A SINGLE DAY, ONE PERSON. The narrowest case, and the one that fails first if the two paths
   * disagree about which column means "who did this" — `opened_by` versus `booked_by`.
   */
  it("one person, one day: every reconciled measure matches", async () => {
    await open(clerk, T0, { visitType: "new" });
    await open(clerk, T0, { visitType: "revisit" });
    await open(clerk, T0, { visitType: "renewal" });

    compare(await pulse(clerk, DAY, DAY), await breakdown(DAY, DAY, ["userId"], [clerk.id]));
  });

  /**
   * A WINDOW OF DAYS. This is where a date-boundary disagreement shows up: the pulse asks each day
   * separately and the range asks once with `between`, so an off-by-one at either end appears here
   * and nowhere else.
   */
  it("one person, a week: every reconciled measure matches across the boundary", async () => {
    const from = addDays(DAY, -6);
    for (let i = 0; i <= 6; i += 1) {
      await open(clerk, new Date(`${addDays(DAY, -i)}T04:00:00.000Z`), { visitType: i % 2 === 0 ? "new" : "renewal" });
    }
    // Two visits OUTSIDE the window on each side — if either instrument's bounds are wrong, these
    // are what it swallows, and a matching pair of wrong answers would still fail against the other.
    await open(clerk, new Date(`${addDays(DAY, -7)}T04:00:00.000Z`));
    await open(clerk, new Date(`${addDays(DAY, 1)}T04:00:00.000Z`));

    compare(await pulse(clerk, from, DAY), await breakdown(from, DAY, ["userId"], [clerk.id]));
  });

  /**
   * TWO PEOPLE. The pulse is per-person by construction; the range is per-person only because it
   * filters. A range that forgot its `userIds` filter would return the hospital's total and still
   * look plausible on screen — it fails here.
   */
  it("two people: each reconciles against their own pulse, not the hospital's total", async () => {
    await open(clerk, T0, { visitType: "new" });
    await open(clerk, T0, { visitType: "new" });
    await open(other, T0, { visitType: "renewal" });

    compare(await pulse(clerk, DAY, DAY), await breakdown(DAY, DAY, ["userId"], [clerk.id]));
    compare(await pulse(other, DAY, DAY), await breakdown(DAY, DAY, ["userId"], [other.id]));
  });

  /**
   * ═══ THE DIMENSION-INVARIANCE PROPERTY, AND IT IS THE ONE THAT EARNS THIS FILE ═══
   *
   * The TOTAL must not depend on how the table is grouped. Adding a department column cannot change
   * how many visits happened — but it is exactly the sort of thing that does change it, through a
   * GROUP BY that drops rows with a NULL dimension, or a key that fails to merge and double-counts.
   *
   * This is also the assertion that would have caught the insertion-order key bug in `range.ts`
   * had the unit test not: with two modules contributing on keys that failed to merge, the grouped
   * total and the ungrouped total come apart.
   */
  it("the total is the same however the table is grouped", async () => {
    await open(clerk, T0, { departmentId: deptId, doctorId, visitType: "new" });
    await open(clerk, T0, { departmentId: dept2Id, doctorId: doctor2Id, visitType: "revisit" });
    await open(other, T0, { departmentId: dept2Id, doctorId: doctor2Id, visitType: "renewal" });

    const groupings: RangeDimension[][] = [
      ["userId"],
      ["departmentId"],
      ["doctorId"],
      ["visitType"],
      ["day"],
      ["userId", "departmentId"],
      ["userId", "departmentId", "doctorId", "visitType", "day"],
    ];
    const first = await breakdown(DAY, DAY, groupings[0]!);
    for (const g of groupings.slice(1)) {
      expect([g.join("+"), await breakdown(DAY, DAY, g)]).toEqual([g.join("+"), first]);
    }
  });

  /**
   * AND THE UNGROUPED TOTAL RECONCILES AGAINST BOTH PEOPLE'S PULSES ADDED TOGETHER — the hospital
   * view, which is the team roll-up T4 is built on.
   */
  it("the whole-desk total equals the sum of the individual pulses", async () => {
    await open(clerk, T0, { visitType: "new" });
    await open(other, T0, { visitType: "renewal" });
    await open(other, T0, { visitType: "new" });

    const a = await pulse(clerk, DAY, DAY);
    const b = await pulse(other, DAY, DAY);
    const both = Object.fromEntries(RECONCILED.map((m) => [m, (a[m] ?? 0) + (b[m] ?? 0)]));

    compare(both, await breakdown(DAY, DAY, ["userId"]));
  });

  /** A window with nothing in it agrees at zero — silence from both, not silence from one. */
  it("an empty window reconciles too", async () => {
    compare(await pulse(clerk, DAY, DAY), await breakdown(DAY, DAY, ["userId"], [clerk.id]));
  });
});
