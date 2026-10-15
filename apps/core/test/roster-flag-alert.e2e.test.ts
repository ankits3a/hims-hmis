import { desc, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedRoster } from "../scripts/seed-roster";
import { withTx } from "../src/kernel/db/client";
import {
  alerts, events, orgDepartments, permissions, roleAssignments, rolePermissions, roles, users,
} from "../src/kernel/db/schema";
import { alertsConsumer } from "../src/kernel/alerts/consumer";
import { alertsManifest } from "../src/kernel/alerts/manifest";
import {
  ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ, assign, draftPeriod, publishPeriod, raiseFlag, resolveFlag,
} from "../src/modules/roster";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";
import type { DispatchedEvent } from "../src/kernel/events/subscriptions";

/**
 * 20-U infra (owner 2026-10-04) — **"THIS IS WRONG" PAGES THE DUTY MANAGER ON DUTY.**
 *
 * A reader's flag on the who-is-on board (register I22) was stored and shown on the board only. It
 * now raises exactly one bell row for whoever the roster says is duty manager at the instant it was
 * raised, falling back to every `duty_manager` role holder when no published roster answers — R6's
 * rungs — and never for the reader who raised it.
 */
describe("roster — a \"this is wrong\" flag pages the duty manager on duty", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  const MS = "01USER00000000000000000MS";
  const DM_ON = "01USER0000000000000DMON";
  const DM_OFF = "01USER000000000000DMOFF";
  const READER = "01USER00000000000READER";
  const ms: Actor = { type: "user", id: MS };
  const reader: Actor = { type: "user", id: READER };
  const savedFlag = process.env.ROSTER_RESOLVER_ENABLED;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => {
    if (savedFlag === undefined) delete process.env.ROSTER_RESOLVER_ENABLED; else process.env.ROSTER_RESOLVER_ENABLED = savedFlag;
    await teardown();
  });

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(roles).values(["doctor", "medical_superintendent", "duty_manager", "pharmacy", "radiologist", "pathologist", "anaesthetist"]
      .map((key) => ({ key, title: key })));
    await db.insert(permissions).values([ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ].map((permission) => ({ permission, module: "roster" })));
    await db.insert(rolePermissions).values([
      ...[ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ].map((permission) => ({ roleKey: "medical_superintendent", permission })),
      { roleKey: "doctor", permission: ROSTER_READ },
      { roleKey: "duty_manager", permission: ROSTER_READ },
    ]);
    for (const [id, username, roleKey] of [[MS, "ms", "medical_superintendent"], [DM_ON, "dm.on", "duty_manager"], [DM_OFF, "dm.off", "duty_manager"], [READER, "reader", "doctor"]] as const) {
      await db.insert(users).values({ id, username, fullName: `Name ${username}`, staffCode: `EMP-${username}`, passwordHash: "x" });
      await db.insert(roleAssignments).values({ id: `RA-${username}`, userId: id, roleKey, scopeType: "hospital", scopeId: null });
    }
    await seedRoster(db);
    process.env.ROSTER_RESOLVER_ENABLED = "true";
  });

  /** A published hospital-services roster naming DM_ON as duty manager for the next few hours. */
  const publishDutyManager = async (userId = DM_ON): Promise<void> => {
    const admn = (await db.select().from(orgDepartments)).find((d) => d.code === "ADMN")!;
    const now = Date.now();
    const hour = 3_600_000;
    await withTx(db, async (tx) => {
      const { periodId } = await draftPeriod(tx, ms, {
        scopeType: "hospital", scopeId: null, departmentId: null, teamId: null, title: "Hospital services",
        coversPositions: ["duty_manager"], startsAt: new Date(now - 6 * hour), endsAt: new Date(now + 6 * hour),
      });
      await assign(tx, ms, periodId, {
        userId, positionKey: "duty_manager", departmentId: admn.id, coverScope: "hospital",
        startsAt: new Date(now - 5 * hour), endsAt: new Date(now + 5 * hour),
      });
      await publishPeriod(tx, ms, periodId);
    });
  };

  const raise = async (by: Actor = reader): Promise<{ flagId: string; event: DispatchedEvent }> => {
    const { flagId } = await withTx(db, (tx) => raiseFlag(tx, by, { at: new Date(), userId: DM_OFF, note: "Dr Sen is on leave today" }));
    const row = (await db.select().from(events).where(eq(events.name, "roster.flag_raised")).orderBy(desc(events.seq)).limit(1))[0]!;
    return {
      flagId,
      event: {
        seq: Number(row.seq), eventId: row.eventId, name: row.name, payload: row.payload,
        patientId: row.patientId, correlationId: row.correlationId, occurredAt: row.occurredAt,
      },
    };
  };

  it("the alerts manifest subscribes the kernel alerts consumer to roster.flag_raised", () => {
    expect(alertsManifest.subscriptions).toContainEqual({ event: "roster.flag_raised", consumer: "kernel.alerts" });
  });

  it("raises exactly one alert, for the duty manager the roster has on duty — and a redelivery adds nothing", async () => {
    await publishDutyManager();
    const { flagId, event } = await raise();
    const handle = alertsConsumer(db);
    await handle(event);
    await handle(event);

    const rows = await db.select().from(alerts);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: DM_ON, kind: "roster_flag", refType: "roster_flag", refId: flagId, sourceEventId: event.eventId });
    expect(rows[0]!.title).toBe("Roster flagged wrong: Hospital-wide · Name dm.off");
    expect(rows[0]!.body).toContain("\"Dr Sen is on leave today\" — Name reader,");
    expect((await db.select().from(events).where(eq(events.name, "alert.raised"))).length).toBe(1);

    // Resolving the flag changes the flag, not the manager's answer on the bell (see the consumer).
    await withTx(db, (tx) => resolveFlag(tx, ms, flagId));
    expect((await db.select().from(alerts))[0]!.ackKind).toBeNull();
  });

  it("with no published roster answering, every duty_manager role holder is paged (R6's rung never removed)", async () => {
    const { event } = await raise();
    await alertsConsumer(db)(event);
    expect((await db.select().from(alerts)).map((a) => a.userId).sort()).toEqual([DM_OFF, DM_ON].sort());
  });

  it("the duty manager who raised it is not paged about their own flag", async () => {
    await publishDutyManager();
    const { event } = await raise({ type: "user", id: DM_ON });
    await alertsConsumer(db)(event);
    expect(await db.select().from(alerts)).toEqual([]);
  });
});
