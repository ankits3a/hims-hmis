import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedRoster } from "../scripts/seed-roster";
import { withTx } from "../src/kernel/db/client";
import {
  orgDepartments, permissions, roleAssignments, rolePermissions, roles, rosterTeams, users,
} from "../src/kernel/db/schema";
import {
  ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ, ROSTER_RULE_COUNT, assign, draftPeriod, publishPeriod,
} from "../src/modules/roster";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";

/**
 * 20-U infra (owner 2026-10-04, "go with your recommendation") — **THE RULE BOOK IS LOADED BY THE
 * INSTALL'S OWN SEED.** `seedRosterRules` existed and no script called it, so `roster_rules` was
 * empty on every install and the publish gate judged every roster against NO rules: a resident
 * rostered for a day four hours after a night published without a word.
 *
 * The legs: seeding twice changes nothing; an owner's edit to a rule survives a re-seed; and a
 * roster with a blocking finding is refused once `seed:roster` has run — the leg that was red before
 * the seed loaded the book.
 */
describe("seed:roster — masters and the rule book", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  const at = (s: string): Date => new Date(`${s}:00+05:30`);
  const MS = "01USER00000000000000000MS";
  const SR = "01USER00000000000000000SR";
  const TEAM = "01ROSTERTEAM0000SEEDT1";
  const ms: Actor = { type: "user", id: MS };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    // The roles the seventeen positions name — `seed:roles` runs before `seed:roster` on a real box.
    await db.insert(roles).values(["doctor", "medical_superintendent", "duty_manager", "pharmacy", "radiologist", "pathologist", "anaesthetist"]
      .map((key) => ({ key, title: key })));
    await db.insert(permissions).values([ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ].map((permission) => ({ permission, module: "roster" })));
    await db.insert(rolePermissions).values([ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ].map((permission) => ({ roleKey: "medical_superintendent", permission })));
    for (const [id, username, roleKey] of [[MS, "ms", "medical_superintendent"], [SR, "sr", "doctor"]] as const) {
      await db.insert(users).values({ id, username, fullName: username, staffCode: `EMP-${username}`, passwordHash: "x" });
      await db.insert(roleAssignments).values({ id: `RA-${username}`, userId: id, roleKey, scopeType: "hospital", scopeId: null });
    }
  });

  const count = async (table: string): Promise<number> =>
    Number((await db.execute(sql`select count(*)::int as n from ${sql.identifier(table)}`)).rows[0]!.n);

  it("loads the rule book, and a second run changes no row", async () => {
    const first = await seedRoster(db);
    expect(first.rules).toEqual({ added: ROSTER_RULE_COUNT, present: 0 });
    const counts = async () => Promise.all(["org_departments", "roster_positions", "roster_teams", "roster_rules"].map(count));
    const before = await counts();
    expect(before[3]).toBe(ROSTER_RULE_COUNT);

    const second = await seedRoster(db);
    expect(second.rules).toEqual({ added: 0, present: ROSTER_RULE_COUNT });
    expect(await counts()).toEqual(before);
  });

  it("never overwrites a rule somebody has edited", async () => {
    await seedRoster(db);
    // The owner moves the weekly-off rule to a block and widens one-in-three to one-in-four.
    await db.execute(sql`update roster_rules set severity = 'block', params = '{"perDays": 7, "minOff": 1, "edited": true}', updated_by = ${MS} where key = 'weekly_off'`);
    await db.execute(sql`update roster_rules set active = false, updated_by = ${MS} where key = 'night_one_in_three'`);
    await seedRoster(db);
    const rows = (await db.execute(sql`select key, severity, params, active, updated_by from roster_rules where key in ('weekly_off', 'night_one_in_three') order by key`)).rows;
    expect(rows).toEqual([
      { key: "night_one_in_three", severity: "warn", params: { oneInN: 3 }, active: false, updated_by: MS },
      { key: "weekly_off", severity: "block", params: { perDays: 7, minOff: 1, edited: true }, active: true, updated_by: MS },
    ]);
  });

  it("after the seed, a roster with a blocking finding does not publish", async () => {
    await seedRoster(db);
    const med = (await db.select().from(orgDepartments)).find((d) => d.code === "MED")!;
    await db.insert(rosterTeams).values({ id: TEAM, departmentId: med.id, code: "MED-T1", name: "Medicine Unit T1", kind: "clinical_unit", createdBy: "t", updatedBy: "t" });
    const { periodId } = await withTx(db, (tx) => draftPeriod(tx, ms, {
      scopeType: "team", scopeId: "MED-T1", departmentId: med.id, title: "October — Medicine T1",
      coversPositions: ["unit_sr"], startsAt: at("2026-10-01T00:00"), endsAt: at("2026-11-01T00:00"),
    }));
    const slot = (startsAt: Date, endsAt: Date) => withTx(db, (tx) => assign(tx, ms, periodId, {
      userId: SR, positionKey: "unit_sr", departmentId: med.id, teamId: TEAM, startsAt, endsAt,
    }));
    // A night, then a day six hours after it ends: doc 10 §3.9's hard block.
    await slot(at("2026-10-12T20:00"), at("2026-10-13T08:00"));
    await slot(at("2026-10-13T14:00"), at("2026-10-13T20:00"));

    const refused = await withTx(db, (tx) => publishPeriod(tx, ms, periodId)).then(() => null, (e: unknown) => e);
    expect(refused).toMatchObject({ code: "blocked_by_findings" });
    expect((refused as { detail: { codes: string[] } }).detail.codes).toContain("rest_after_duty");
    const status = (await db.execute(sql`select status from roster_periods where id = ${periodId}`)).rows[0];
    expect(status).toEqual({ status: "draft" });
  });
});
