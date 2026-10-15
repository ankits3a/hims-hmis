import { and, eq, isNull } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { confirmSeededUnits } from "../../../test/helpers/units";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import {
  orgDepartments, permissions, roleAssignments, rolePermissions, roles, rosterCycleEntries, rosterCycles,
  rosterDutyWindows, users,
} from "../../kernel/db/schema";
import { registerAllJobs, type JobIntervals } from "../../kernel/worker/jobs";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ } from "./policy";
import { seedOrgDepartments, seedRosterPositions } from "./masters";
import { seedUnits, teamByCode } from "./teams";
import { HORIZON_DAYS, MATERIALISER_ACTOR, materialiseWindows, publishCycle } from "./calendar";
import type { JobSpec, Scheduler } from "../../kernel/worker/scheduler";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * **THE NIGHTLY WINDOW SWEEP, RUN THE WAY THE WORKER RUNS IT, AGAINST A HOSPITAL THAT HAS A CYCLE.**
 *
 * 2026-10-06, 20:00 UTC (01:30 IST) — on production and on staging `sweepRosterWindows` failed every
 * night with *"you do not hold the permission this needs"*. The job acted as a `user`-typed actor that
 * holds no grant, and `materialiseWindows` asks `publish` at the department. Phase R registered the
 * job, pinned its name in four censuses and never once RAN it with a published cycle in the database:
 * with no cycle the loop body is never entered, so every test of the registration was green. The first
 * night the hospital had real units and a day to extend, it threw.
 *
 * So these legs enter through `registerAllJobs` — the worker's own entry — and never call the domain
 * function with an actor the test chose.
 */
describe("roster — the scheduled jobs run as the worker runs them", () => {
  const MS = "01USER00000000000000000MS";
  const ms: Actor = { type: "user", id: MS };
  const ANCHOR = "2026-10-05"; // a Monday
  const ist = (s: string): Date => new Date(`${s}:00+05:30`);
  const NINE_HOURS_MS = 9 * 60 * 60 * 1000;
  const INTERVALS = {
    workerDispatchIntervalMs: NINE_HOURS_MS, workerTimersIntervalMs: NINE_HOURS_MS,
    workerTempRolesIntervalMs: NINE_HOURS_MS, workerNotifyIntervalMs: NINE_HOURS_MS,
    workerReachIntervalMs: 60_000, notifyStuckAfterMs: 300_000, retentionEnabled: false,
    retentionEventsMonths: 120,
  } as unknown as JobIntervals;

  let db: Db;
  let teardown: () => Promise<void>;
  let MED: string;
  let cycleId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  const jobs = (): Map<string, JobSpec> => {
    const specs: JobSpec[] = [];
    registerAllJobs(
      { register: (spec: JobSpec): void => { specs.push(spec); } } as unknown as Scheduler,
      db, new ModuleRegistry(), {}, INTERVALS,
    );
    return new Map(specs.map((s) => [s.name, s]));
  };

  const liveWindows = async (): Promise<{ startsAt: Date; createdBy: string }[]> =>
    db.select({ startsAt: rosterDutyWindows.startsAt, createdBy: rosterDutyWindows.createdBy }).from(rosterDutyWindows)
      .where(and(eq(rosterDutyWindows.departmentId, MED), isNull(rosterDutyWindows.supersededAt)));

  const lastIstDay = (rows: { startsAt: Date }[]): string =>
    new Date(Math.max(...rows.map((r) => r.startsAt.getTime())) + 330 * 60_000).toISOString().slice(0, 10);

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(roles).values([
      { key: "doctor", title: "Doctor" }, { key: "duty_manager", title: "Duty manager" },
      { key: "medical_superintendent", title: "Medical Superintendent" },
      { key: "radiologist", title: "Radiologist" }, { key: "pathologist", title: "Pathologist" },
      { key: "anaesthetist", title: "Anaesthetist" }, { key: "pharmacy", title: "Pharmacy" },
    ]);
    await db.insert(permissions).values(
      [ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ].map((permission) => ({ permission, module: "roster" })),
    );
    await db.insert(rolePermissions).values(
      [ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ].map((permission) => ({ roleKey: "medical_superintendent", permission })),
    );
    await db.insert(users).values({ id: MS, username: "ms", fullName: "Dr. Sunita Mishra", staffCode: "EMP-000MS", passwordHash: "x" });
    await db.insert(roleAssignments).values({ id: "RA-MS", userId: MS, roleKey: "medical_superintendent", scopeType: "hospital", scopeId: null });
    await seedOrgDepartments(db);
    await seedRosterPositions(db);
    await seedUnits(db);
    await confirmSeededUnits(db);
    MED = (await db.select().from(orgDepartments)).find((d) => d.code === "MED")!.id;
    // The hospital as it is: ONE unit, on take every day (CRKMCH, October 2026).
    const unit = (await teamByCode(db, "MED-U1"))!.id;
    cycleId = newId();
    await db.insert(rosterCycles).values({
      id: cycleId, departmentId: MED, cycleDays: 1, anchorIstDate: ANCHOR, version: 1, createdBy: "t", updatedBy: "t",
    });
    await db.insert(rosterCycleEntries).values({
      id: newId(), cycleId, dayIndex: 0, teamId: unit, activity: "take" as const, startMinute: 480, durationMinutes: 1440, createdBy: "t", updatedBy: "t",
    });
    await withTx(db, (tx) => publishCycle(tx, ms, cycleId, ANCHOR));
  });

  it("the 01:30 sweep rolls a published cycle's horizon forward — as the worker's own actor, holding no grant", async () => {
    const before = await liveWindows();
    expect(before.length).toBeGreaterThan(0);
    const sweep = jobs().get("sweepRosterWindows")!;

    // The night after publication there is exactly one more day to write.
    await expect(sweep.run(ist("2026-10-06T01:30"))).resolves.toBeUndefined();

    const after = await liveWindows();
    expect(after.length).toBe(before.length + 1);
    expect(lastIstDay(after)).toBe("2027-01-03"); // 6 Oct + 90 days, exclusive
    expect(after.filter((w) => w.createdBy === MATERIALISER_ACTOR.id)).toHaveLength(1);
    expect(MATERIALISER_ACTOR.type).toBe("system");
    expect(HORIZON_DAYS).toBe(90);
  });

  it("nights it missed are caught up by the next run, and a second run the same night writes nothing", async () => {
    const before = await liveWindows();
    const sweep = jobs().get("sweepRosterWindows")!;
    // Four nights failed (as 6–9 October did in production); the fifth succeeds.
    await sweep.run(ist("2026-10-10T01:30"));
    const after = await liveWindows();
    expect(after.length).toBe(before.length + 5);
    expect(lastIstDay(after)).toBe("2027-01-07");
    await sweep.run(ist("2026-10-10T01:31"));
    expect((await liveWindows()).length).toBe(after.length);
  });

  it("CENSUS — every roster job the worker registers runs at its own hours without a permission refusal", async () => {
    const all = jobs();
    const roster = ["sweepRosterWindows", "runMonthlyProposals", "printRosterBoard", "sweepStaffNotices"];
    for (const name of roster) expect(all.has(name)).toBe(true);
    // The instants at which each has work: the nightly roll, the 20th's proposals, both board prints.
    const instants = [ist("2026-10-06T01:30"), ist("2026-10-20T02:10"), ist("2026-10-06T08:00"), ist("2026-10-06T20:00"), ist("2026-10-07T07:00")];
    for (const name of roster) {
      for (const at of instants) {
        await all.get(name)!.run(at).catch((e: unknown) => {
          const code = (e as { code?: string }).code;
          if (code === "not_permitted" || code === "act_not_available_to_actor") {
            throw new Error(`${name} at ${at.toISOString()} was refused: ${code}`);
          }
          throw e;
        });
      }
    }
  });

  describe("the allowance is narrow", () => {
    const day = (n: number): string => new Date(Date.parse(`${ANCHOR}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

    it("a job may not PUBLISH: the ordinary act still refuses a system actor", async () => {
      await expect(withTx(db, (tx) => materialiseWindows(tx, MATERIALISER_ACTOR, cycleId, day(200), day(201))))
        .rejects.toMatchObject({ code: "act_not_available_to_actor" });
    });

    it("a job may not extend a cycle nobody published", async () => {
      const draft = newId();
      await db.insert(rosterCycles).values({
        id: draft, departmentId: MED, cycleDays: 1, anchorIstDate: ANCHOR, version: 2, createdBy: "t", updatedBy: "t",
      });
      await expect(withTx(db, (tx) => materialiseWindows(tx, MATERIALISER_ACTOR, draft, day(200), day(201), "extend_published_windows")))
        .rejects.toMatchObject({ code: "act_not_available_to_actor" });
    });

    it("a person without the publish grant gains nothing from the new act", async () => {
      const NOBODY = "01USER0000000000000NOBODY";
      await db.insert(users).values({ id: NOBODY, username: "nobody", fullName: "Nobody", staffCode: "EMP-NOBDY", passwordHash: "x" });
      await expect(withTx(db, (tx) => materialiseWindows(tx, { type: "user", id: NOBODY }, cycleId, day(200), day(201), "extend_published_windows")))
        .rejects.toMatchObject({ code: "not_permitted" });
    });
  });
});
