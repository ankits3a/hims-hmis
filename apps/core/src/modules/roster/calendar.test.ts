import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import {
  orgDepartments, permissions, roleAssignments, rolePermissions, roles,
  rosterCycleEntries, rosterCycleOverlays, rosterCycles, rosterDutyWindows, users,
} from "../../kernel/db/schema";
import { RosterError } from "./errors";
import { ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ } from "./policy";
import { seedOrgDepartments, seedRosterPositions } from "./masters";
import { seedUnits, teamByCode } from "./teams";
import {
  HORIZON_DAYS, SHORT_OPD_MINUTES, addIstDays, backupUnit, declareHoliday, expandCycle,
  istMidnightUtc, istWeekday, publishCycle, takeGaps, unitOnTake,
} from "./calendar";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * PHASE R (R7) — the calendar a department actually runs on.
 *
 * Four legs a reviewer should read first, each of which is an invariant with a number:
 *
 *   · **V12 — 07:59 and 08:00.** A take runs `[08:00, 08:00)` across a day boundary. There must be
 *     no instant belonging to both units and none belonging to neither, **with the database session
 *     in `Etc/UTC`** (G6). If the session zone ever moved, every window in this phase would shift by
 *     five and a half hours and this is the test that would say so.
 *   · **V15 — one generator.** The materialised rows and a fresh `expandCycle` must agree on every
 *     instant of ninety days, or the hospital has two calendars.
 *   · **V11 — the take is continuous.** A gap is an hour in which a department has nobody admitting,
 *     and the hospital finds out when an ambulance arrives.
 *   · **the overlay is not advanced by a declared holiday.** Getting this wrong shifts every unit's
 *     Sunday for the rest of the year, silently, from one evening's decision.
 */
describe("roster — the calendar (R7)", () => {
  const MS = "01USER00000000000000000MS";
  const ms: Actor = { type: "user", id: MS };

  let db: Db;
  let teardown: () => Promise<void>;
  let MED: string;
  let units: string[];

  /** A Monday, asserted rather than assumed. */
  const ANCHOR = "2026-10-05";
  /** The Sunday before it — the overlay's own anchor. */
  const OVERLAY_ANCHOR = "2026-10-04";

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

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
    await db.insert(users).values({ id: MS, username: "sunita.mishra", fullName: "sunita.mishra", staffCode: "EMP-0001", passwordHash: "x" });
    await db.insert(roleAssignments).values({ id: "RA-MS", userId: MS, roleKey: "medical_superintendent", scopeType: "hospital", scopeId: null });
    await seedOrgDepartments(db);
    await seedRosterPositions(db);
    await seedUnits(db);
    MED = (await db.select().from(orgDepartments)).find((d) => d.code === "MED")!.id;
    units = [];
    for (let i = 1; i <= 5; i += 1) units.push((await teamByCode(db, `MED-U${i}`))!.id);
  });

  /** Medicine's five-day take cycle: one unit a day, 08:00 to 08:00. */
  const buildCycle = async (opts: { withOverlay?: boolean; skipDay?: number } = {}): Promise<string> => {
    const cycleId = newId();
    await db.insert(rosterCycles).values({
      id: cycleId, departmentId: MED, cycleDays: 5, anchorIstDate: ANCHOR, version: 1,
      createdBy: "t", updatedBy: "t",
    });
    await db.insert(rosterCycleEntries).values(
      units.flatMap((teamId, dayIndex) => (dayIndex === opts.skipDay ? [] : [
        { id: newId(), cycleId, dayIndex, teamId, activity: "take" as const, startMinute: 480, durationMinutes: 1440, createdBy: "t", updatedBy: "t" },
        { id: newId(), cycleId, dayIndex, teamId, activity: "opd" as const, startMinute: 540, durationMinutes: 240, createdBy: "t", updatedBy: "t" },
        { id: newId(), cycleId, dayIndex, teamId, activity: "elective_ot" as const, startMinute: 540, durationMinutes: 300, createdBy: "t", updatedBy: "t" },
      ])),
    );
    if (opts.withOverlay === true) {
      await db.insert(rosterCycleOverlays).values(units.map((teamId, sequencePosition) => ({
        id: newId(), departmentId: MED, sequencePosition, teamId, activity: "take" as const,
        startMinute: 480, durationMinutes: 1440, anchorIstDate: OVERLAY_ANCHOR,
        createdBy: "t", updatedBy: "t",
      })));
    }
    return cycleId;
  };

  const ist = (date: string, hhmm: string): Date => new Date(`${date}T${hhmm}:00+05:30`);

  /* ═══════════════════ the fixture's own assumptions, asserted ═══════════════════ */

  it("the anchor is a Monday and the overlay anchor is the Sunday before it", () => {
    expect(istWeekday(ANCHOR)).toBe(1);
    expect(istWeekday(OVERLAY_ANCHOR)).toBe(0);
    // ...and IST midnight is 18:30 UTC the previous day, which is what makes V12 meaningful
    expect(istMidnightUtc(ANCHOR).toISOString()).toBe("2026-10-04T18:30:00.000Z");
  });

  /* ═══════════════════ V12 — 07:59 AND 08:00 ═══════════════════ */

  it("V12: the take flips EXACTLY at the handover instant, with no overlap and no gap", async () => {
    const cycleId = await buildCycle();
    await withTx(db, (tx) => publishCycle(tx, ms, cycleId, ANCHOR));

    // Day 0 is Unit I's take: [08:00 on the 5th, 08:00 on the 6th).
    expect((await unitOnTake(db, MED, ist(ANCHOR, "08:00"))).teamId).toBe(units[0]);
    expect((await unitOnTake(db, MED, ist(ANCHOR, "23:59"))).teamId).toBe(units[0]);

    // 07:59 the next morning: STILL Unit I. The night belongs to the unit that started it.
    expect((await unitOnTake(db, MED, ist("2026-10-06", "07:59"))).teamId).toBe(units[0]);
    // 08:00 exactly: Unit II. One instant, one unit, no overlap.
    expect((await unitOnTake(db, MED, ist("2026-10-06", "08:00"))).teamId).toBe(units[1]);

    // And before the cycle starts there is simply no answer — which is not an error.
    expect(await unitOnTake(db, MED, ist(ANCHOR, "07:59"))).toMatchObject({ teamId: null, source: "none" });
  });

  it("V12: the five-day cycle returns to Unit I on the sixth day", async () => {
    const cycleId = await buildCycle();
    await withTx(db, (tx) => publishCycle(tx, ms, cycleId, ANCHOR));
    for (let d = 0; d < 10; d += 1) {
      const date = addIstDays(ANCHOR, d);
      const answer = await unitOnTake(db, MED, ist(date, "12:00"));
      expect(`${date}: ${answer.teamId}`).toBe(`${date}: ${units[d % 5]}`);
    }
  });

  /* ═══════════════════ V15 — ONE GENERATOR ═══════════════════ */

  it("V15: the materialised windows equal a fresh expansion, instant by instant, over ninety days", async () => {
    const cycleId = await buildCycle();
    await withTx(db, (tx) => publishCycle(tx, ms, cycleId, ANCHOR));

    const spec = {
      cycleDays: 5, anchorIstDate: ANCHOR,
      entries: units.flatMap((teamId, dayIndex) => [
        { dayIndex, teamId, activity: "take" as const, startMinute: 480, durationMinutes: 1440 },
        { dayIndex, teamId, activity: "opd" as const, startMinute: 540, durationMinutes: 240 },
        { dayIndex, teamId, activity: "elective_ot" as const, startMinute: 540, durationMinutes: 300 },
      ]),
    };
    const fresh = expandCycle(spec, ANCHOR, addIstDays(ANCHOR, HORIZON_DAYS));

    const rows = await db.select().from(rosterDutyWindows)
      .where(eq(rosterDutyWindows.departmentId, MED)).orderBy(rosterDutyWindows.startsAt, rosterDutyWindows.activity);
    const live = rows.filter((r) => r.supersededAt === null);

    const key = (w: { teamId: string; activity: string; startsAt: Date; endsAt: Date }): string =>
      `${w.startsAt.toISOString()}|${w.endsAt.toISOString()}|${w.activity}|${w.teamId}`;
    expect(live.map(key).sort()).toEqual(fresh.map(key).sort());
    expect(live).toHaveLength(HORIZON_DAYS * 3);
  });

  /* ═══════════════════ V11 — THE TAKE IS CONTINUOUS ═══════════════════ */

  it("V11: a complete cycle has no gap, and a cycle missing a day has exactly one per turn", async () => {
    const good = await buildCycle();
    await withTx(db, (tx) => publishCycle(tx, ms, good, ANCHOR));
    const from = ist(ANCHOR, "08:00");
    const to = ist(addIstDays(ANCHOR, 20), "08:00");
    expect(await takeGaps(db, MED, from, to)).toEqual([]);

    /**
     * The holed cycle goes in a DIFFERENT department rather than rebuilding this one's fixture.
     * The first version of this test truncated mid-test and re-seeded, which dropped the RBAC roles
     * the position seed depends on — a test that breaks its own preconditions to make a point.
     */
    const SUR = (await db.select().from(orgDepartments)).find((d) => d.code === "SUR")!.id;
    const surUnits: string[] = [];
    for (let i = 1; i <= 5; i += 1) surUnits.push((await teamByCode(db, `SUR-U${i}`))!.id);
    const holed = newId();
    await db.insert(rosterCycles).values({
      id: holed, departmentId: SUR, cycleDays: 5, anchorIstDate: ANCHOR, version: 1,
      createdBy: "t", updatedBy: "t",
    });
    // Day 3 missing: a hole every five days, 24 hours wide.
    await db.insert(rosterCycleEntries).values(
      surUnits.flatMap((teamId, dayIndex) => (dayIndex === 3 ? [] : [{
        id: newId(), cycleId: holed, dayIndex, teamId, activity: "take" as const,
        startMinute: 480, durationMinutes: 1440, createdBy: "t", updatedBy: "t",
      }])),
    );
    await withTx(db, (tx) => publishCycle(tx, ms, holed, ANCHOR));
    const gaps = await takeGaps(db, SUR, from, to);
    expect(gaps.length).toBeGreaterThanOrEqual(3);
    expect(gaps[0]!.from.toISOString()).toBe(ist(addIstDays(ANCHOR, 3), "08:00").toISOString());
    expect(gaps[0]!.to.toISOString()).toBe(ist(addIstDays(ANCHOR, 4), "08:00").toISOString());
  });

  /* ═══════════════════ the holiday declared at 19:30 ═══════════════════ */

  it("a holiday declared the evening before withdraws OPD and elective theatre for THAT DATE, and nothing else", async () => {
    const cycleId = await buildCycle();
    await withTx(db, (tx) => publishCycle(tx, ms, cycleId, ANCHOR));
    const target = addIstDays(ANCHOR, 1);

    await withTx(db, (tx) => declareHoliday(tx, ms, {
      istDate: target, kind: "declared", pattern: "opd_off_ot_proceeds",
    }));

    const live = await db.select().from(rosterDutyWindows).where(eq(rosterDutyWindows.departmentId, MED));
    const onTarget = live.filter((w) => w.supersededAt === null
      && w.startsAt >= istMidnightUtc(target) && w.startsAt < istMidnightUtc(addIstDays(target, 1)));
    // The take PROCEEDS — that is what this pattern means.
    expect(onTarget.map((w) => w.activity).sort()).toEqual(["take"]);

    // The day before and the day after are untouched: three activities each.
    for (const other of [ANCHOR, addIstDays(ANCHOR, 2)]) {
      const rows = live.filter((w) => w.supersededAt === null
        && w.startsAt >= istMidnightUtc(other) && w.startsAt < istMidnightUtc(addIstDays(other, 1)));
      expect(`${other}: ${rows.length}`).toBe(`${other}: 3`);
    }
    // ...and the take is still continuous across the holiday.
    expect(await takeGaps(db, MED, ist(ANCHOR, "08:00"), ist(addIstDays(ANCHOR, 5), "08:00"))).toEqual([]);
  });

  it("a restricted holiday shortens OPD instead of withdrawing it", () => {
    const spec = {
      cycleDays: 1, anchorIstDate: ANCHOR,
      entries: [
        { dayIndex: 0, teamId: units[0]!, activity: "opd" as const, startMinute: 540, durationMinutes: 240 },
        { dayIndex: 0, teamId: units[0]!, activity: "elective_ot" as const, startMinute: 540, durationMinutes: 300 },
      ],
    };
    const out = expandCycle(spec, ANCHOR, addIstDays(ANCHOR, 1), [
      { istDate: ANCHOR, kind: "restricted", pattern: "opd_short" },
    ]);
    expect(out.map((w) => w.activity)).toEqual(["opd"]); // theatre off
    const minutes = (out[0]!.endsAt.getTime() - out[0]!.startsAt.getTime()) / 60_000;
    expect(minutes).toBe(SHORT_OPD_MINUTES);
  });

  /* ═══════════════════ the overlay, and the sequence a holiday must not consume ═══════════════════ */

  it("Sundays run their own sequence, advancing one position each Sunday", () => {
    const spec = {
      cycleDays: 5, anchorIstDate: ANCHOR, overlayAnchorIstDate: OVERLAY_ANCHOR,
      entries: units.map((teamId, dayIndex) => ({
        dayIndex, teamId, activity: "take" as const, startMinute: 480, durationMinutes: 1440,
      })),
      overlays: units.map((teamId, sequencePosition) => ({
        sequencePosition, teamId, activity: "take" as const, startMinute: 480, durationMinutes: 1440,
      })),
    };
    const out = expandCycle(spec, OVERLAY_ANCHOR, addIstDays(OVERLAY_ANCHOR, 36));
    const sundays = out.filter((w) => w.source === "overlay");
    expect(sundays).toHaveLength(6);                          // six Sundays in 36 days
    expect(sundays.map((w) => w.overlayIndex)).toEqual([0, 1, 2, 3, 4, 0]); // and it wraps
  });

  it("A DECLARED HOLIDAY RUNS THE SUNDAY PATTERN AND DOES NOT ADVANCE THE SEQUENCE", () => {
    // The 19:30 decision that must not shift every unit's Sunday for the rest of the year.
    const spec = {
      cycleDays: 5, anchorIstDate: ANCHOR, overlayAnchorIstDate: OVERLAY_ANCHOR,
      entries: units.map((teamId, dayIndex) => ({
        dayIndex, teamId, activity: "take" as const, startMinute: 480, durationMinutes: 1440,
      })),
      overlays: units.map((teamId, sequencePosition) => ({
        sequencePosition, teamId, activity: "take" as const, startMinute: 480, durationMinutes: 1440,
      })),
    };
    const range = [OVERLAY_ANCHOR, addIstDays(OVERLAY_ANCHOR, 22)] as const;
    const without = expandCycle(spec, range[0], range[1]);
    // A Wednesday declared as a Sunday, between the second and third Sundays.
    const wednesday = addIstDays(OVERLAY_ANCHOR, 10);
    expect(istWeekday(wednesday)).toBe(3);
    const withHoliday = expandCycle(spec, range[0], range[1], [
      { istDate: wednesday, kind: "declared", pattern: "as_sunday" },
    ]);

    const sundayIndices = (ws: typeof without): (number | null)[] =>
      ws.filter((w) => w.source === "overlay" && istWeekday(w.istDate) === 0).map((w) => w.overlayIndex);
    // EVERY Sunday keeps the position it had. The holiday borrowed one; it consumed none.
    expect(sundayIndices(withHoliday)).toEqual(sundayIndices(without));

    const borrowed = withHoliday.find((w) => w.istDate === wednesday)!;
    expect(borrowed.source).toBe("overlay");
    expect(borrowed.overlayIndex).toBe(1); // the position the sequence was already at
  });

  /* ═══════════════════ E17 — a version that takes effect mid-period ═══════════════════ */

  it("E17: publishing a new version leaves the old version's windows standing before its instant", async () => {
    const v1 = await buildCycle();
    await withTx(db, (tx) => publishCycle(tx, ms, v1, ANCHOR));
    const switchDate = addIstDays(ANCHOR, 10);

    // v2 reverses the order of the units.
    const v2 = newId();
    await db.insert(rosterCycles).values({
      id: v2, departmentId: MED, cycleDays: 5, anchorIstDate: switchDate, version: 2,
      createdBy: "t", updatedBy: "t",
    });
    await db.insert(rosterCycleEntries).values([...units].reverse().map((teamId, dayIndex) => ({
      id: newId(), cycleId: v2, dayIndex, teamId, activity: "take" as const,
      startMinute: 480, durationMinutes: 1440, createdBy: "t", updatedBy: "t",
    })));
    await withTx(db, (tx) => publishCycle(tx, ms, v2, switchDate));

    // Before the switch: v1's answer, untouched.
    expect((await unitOnTake(db, MED, ist(addIstDays(ANCHOR, 1), "12:00"))).teamId).toBe(units[1]);
    // On and after it: v2's.
    expect((await unitOnTake(db, MED, ist(switchDate, "12:00"))).teamId).toBe(units[4]);
    // ...and v1 is superseded rather than deleted.
    const [old] = await db.select().from(rosterCycles).where(eq(rosterCycles.id, v1));
    expect(old!.status).toBe("superseded");
  });

  /* ═══════════════════ refusals ═══════════════════ */

  it("refuses to publish a cycle with no days on it, and to publish one twice", async () => {
    const empty = newId();
    await db.insert(rosterCycles).values({
      id: empty, departmentId: MED, cycleDays: 5, anchorIstDate: ANCHOR, version: 9,
      createdBy: "t", updatedBy: "t",
    });
    await expect(withTx(db, (tx) => publishCycle(tx, ms, empty, ANCHOR))).rejects.toThrow(RosterError);

    const good = await buildCycle();
    await withTx(db, (tx) => publishCycle(tx, ms, good, ANCHOR));
    await expect(withTx(db, (tx) => publishCycle(tx, ms, good, ANCHOR))).rejects.toThrow(RosterError);
  });

  it("no machine declares a holiday or publishes a cycle", async () => {
    const cycleId = await buildCycle();
    for (const type of ["system", "agent"] as const) {
      await expect(withTx(db, (tx) => publishCycle(tx, { type, id: MS }, cycleId, ANCHOR)))
        .rejects.toThrow(RosterError);
      await expect(withTx(db, (tx) => declareHoliday(tx, { type, id: MS }, {
        istDate: ANCHOR, kind: "declared",
      }))).rejects.toThrow(RosterError);
    }
  });

  it("`backupUnit` answers separately from the take, and is silent when no backup is rostered", async () => {
    const cycleId = await buildCycle();
    await withTx(db, (tx) => publishCycle(tx, ms, cycleId, ANCHOR));
    expect(await backupUnit(db, MED, ist(ANCHOR, "12:00"))).toMatchObject({ teamId: null, source: "none" });
  });
});
