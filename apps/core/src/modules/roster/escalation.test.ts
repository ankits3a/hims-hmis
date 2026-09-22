import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import {
  orgDepartments, permissions, roleAssignments, rolePermissions, roles, users,
} from "../../kernel/db/schema";
import { usersHoldingRole } from "../../kernel/workflow/roles";
import { RosterError } from "./errors";
import { ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ } from "./policy";
import { seedOrgDepartments, seedRosterPositions } from "./masters";
import { seedUnits } from "./teams";
import { assign, draftPeriod, publishPeriod } from "./periods";
import { escalationRecipients, escalationTarget, setEscalationTarget } from "./escalation";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * PHASE R (R6) — where an escalation goes.
 *
 * ═══ THE LEG THAT MATTERS MOST IS THE ONE THAT CHANGES NOTHING ═══
 *
 * With no configuration row, `escalationRecipients` must return **exactly** what the hospital
 * returned before this phase — the fallback role's holders, in `usersHoldingRole`'s own order. That
 * is the state every deployment is in on the day this merges, and it is asserted against the real
 * function rather than against a copy of its behaviour.
 *
 * ═══ AND THE ONE THAT IS ARGUABLE IS TESTED IN BOTH DIRECTIONS ═══
 *
 * A published roster that names NOBODY as the duty manager tonight is a real statement (R5: an empty
 * `published` answer is not an error). But an escalation is not a report — *"nobody, because the
 * rota has a hole in it"* is the one answer it may never give. So the hole is filled from the role
 * and `rosterWasEmpty` is raised, and both halves of that are legs below.
 */
describe("roster — where an escalation goes (R6)", () => {
  const MS = "01USER00000000000000000MS";
  const DM_A = "01USER00000000000000DMONE";
  const DM_B = "01USER00000000000000DMTWO";
  const ON_TONIGHT = "01USER0000000000000ONDUTY";
  const ms: Actor = { type: "user", id: MS };

  const ON = { true: { ROSTER_RESOLVER_ENABLED: "true" }, false: {} } as const;

  let db: Db;
  let teardown: () => Promise<void>;
  let MED: string;
  let SUR: string;

  const at = (s: string): Date => new Date(`${s}:00+05:30`);
  const OCT = { startsAt: at("2026-10-01T00:00"), endsAt: at("2026-11-01T00:00") };
  const NIGHT = { startsAt: at("2026-10-12T20:00"), endsAt: at("2026-10-13T08:00") };
  const T0214 = at("2026-10-13T02:14");

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
    for (const [id, username] of [
      [MS, "sunita.mishra"], [DM_A, "a.duty"], [DM_B, "b.duty"], [ON_TONIGHT, "kavita.rao"],
    ] as const) {
      await db.insert(users).values({ id, username, fullName: username, staffCode: `EMP-${id.slice(-5)}`, passwordHash: "x" });
    }
    await db.insert(roleAssignments).values([
      { id: "RA-MS", userId: MS, roleKey: "medical_superintendent", scopeType: "hospital", scopeId: null },
      { id: "RA-DMA", userId: DM_A, roleKey: "duty_manager", scopeType: "hospital", scopeId: null },
      { id: "RA-DMB", userId: DM_B, roleKey: "duty_manager", scopeType: "hospital", scopeId: null },
      { id: "RA-ON", userId: ON_TONIGHT, roleKey: "duty_manager", scopeType: "hospital", scopeId: null },
    ]);
    await seedOrgDepartments(db);
    await seedRosterPositions(db);
    await seedUnits(db);
    const depts = await db.select().from(orgDepartments);
    MED = depts.find((d) => d.code === "MED")!.id;
    SUR = depts.find((d) => d.code === "SUR")!.id;
  });

  const refusal = async (p: Promise<unknown>): Promise<RosterError> => {
    const e = await p.then(() => null, (err: unknown) => err);
    if (!(e instanceof RosterError)) throw new Error(`expected a RosterError, got: ${String(e)}`);
    return e;
  };

  /** Publish a Medicine roster that answers for `duty_manager`, with the slots given. */
  const publishDutyManager = async (userId: string | null): Promise<void> => {
    const { periodId } = await withTx(db, (tx) => draftPeriod(tx, ms, {
      scopeType: "department", scopeId: MED, departmentId: MED,
      title: "October", coversPositions: ["duty_manager"], ...OCT,
    }));
    if (userId !== null) {
      await withTx(db, (tx) => assign(tx, ms, periodId, {
        userId, positionKey: "duty_manager", departmentId: MED, ...NIGHT,
      }));
    } else {
      // A published roster that DECLARES the position and names nobody on this night: the hole.
      await withTx(db, (tx) => assign(tx, ms, periodId, {
        userId: DM_A, positionKey: "duty_manager", departmentId: MED,
        startsAt: at("2026-10-20T20:00"), endsAt: at("2026-10-21T08:00"),
      }));
    }
    await withTx(db, (tx) => publishPeriod(tx, ms, periodId));
  };

  const configure = (departmentId: string | null = MED) =>
    withTx(db, (tx) => setEscalationTarget(tx, ms, {
      alertKind: "notification.failed", positionKey: "duty_manager",
      fallbackRoleKey: "duty_manager", departmentId,
    }));

  /* ═══════════════════ 1. NO ROW — every hospital, on the day this merges ═══════════════════ */

  it("with NO configuration row the answer is exactly what it was before this phase", async () => {
    await publishDutyManager(ON_TONIGHT); // even with a roster published, no row means no change
    const before = await withTx(db, (tx) => usersHoldingRole(tx, "duty_manager"));
    const now = await escalationRecipients(
      db, "notification.failed", { fallbackRoleKey: "duty_manager", departmentId: MED }, T0214, ON.true,
    );
    expect(now.userIds).toEqual(before);   // same ids, same order, from the same function
    expect(now.via).toBe("role");
    expect(now.rosterWasEmpty).toBe(false);
  });

  /* ═══════════════════ 2. A ROW, BUT NOTHING PUBLISHED ═══════════════════ */

  it("a row whose roster has published nothing still answers from the role", async () => {
    await configure();
    const answer = await escalationRecipients(
      db, "notification.failed", { fallbackRoleKey: "duty_manager", departmentId: MED }, T0214, ON.true,
    );
    expect(answer.via).toBe("role");
    expect(answer.positionKey).toBe("duty_manager"); // it says what it TRIED
    expect(answer.userIds).toEqual(await withTx(db, (tx) => usersHoldingRole(tx, "duty_manager")));
  });

  it("…and a row with the resolver FLAG OFF answers from the role, whatever is published", async () => {
    await configure();
    await publishDutyManager(ON_TONIGHT);
    const answer = await escalationRecipients(
      db, "notification.failed", { fallbackRoleKey: "duty_manager", departmentId: MED }, T0214, ON.false,
    );
    expect(answer.via).toBe("role");
    expect(answer.userIds).toHaveLength(3);
  });

  /* ═══════════════════ 3. A ROW, AND A ROSTER THAT ANSWERS ═══════════════════ */

  it("a published roster CHANGES the recipient — one person on duty, not three role-holders", async () => {
    await configure();
    await publishDutyManager(ON_TONIGHT);
    const answer = await escalationRecipients(
      db, "notification.failed", { fallbackRoleKey: "duty_manager", departmentId: MED }, T0214, ON.true,
    );
    expect(answer).toEqual({
      userIds: [ON_TONIGHT], via: "roster", rosterWasEmpty: false,
      roleKey: null, positionKey: "duty_manager",
    });
  });

  /* ═══════════════════ 4. THE HOLE — the branch worth arguing about ═══════════════════ */

  it("a roster that answers with NOBODY falls back to the role AND says the rota had a hole", async () => {
    await configure();
    await publishDutyManager(null); // published, declares `duty_manager`, nobody on THIS night
    const answer = await escalationRecipients(
      db, "notification.failed", { fallbackRoleKey: "duty_manager", departmentId: MED }, T0214, ON.true,
    );
    // An escalation may never answer "nobody". The rung is never removed...
    expect(answer.via).toBe("role");
    expect(answer.userIds).toHaveLength(3);
    // ...and the hole is raised rather than papered over.
    expect(answer.rosterWasEmpty).toBe(true);
    expect(answer.positionKey).toBe("duty_manager");
  });

  /* ═══════════════════ scope: a department's own answer wins ═══════════════════ */

  it("a department row beats the hospital-wide one, and the rest of the hospital is untouched", async () => {
    await configure(null);          // hospital-wide: duty_manager
    await configure(MED);           // Medicine's own row
    expect((await escalationTarget(db, "notification.failed", MED))?.departmentId).toBe(MED);
    expect((await escalationTarget(db, "notification.failed", SUR))?.departmentId).toBeNull();
    expect((await escalationTarget(db, "notification.failed"))?.departmentId).toBeNull();
  });

  it("setting the same (kind, department) twice UPDATES rather than adding a second answer", async () => {
    const first = await configure();
    const second = await withTx(db, (tx) => setEscalationTarget(tx, ms, {
      alertKind: "notification.failed", positionKey: "night_sr_pool",
      fallbackRoleKey: "duty_manager", departmentId: MED,
    }));
    expect(second.targetId).toBe(first.targetId);
    expect((await escalationTarget(db, "notification.failed", MED))?.positionKey).toBe("night_sr_pool");
  });

  /* ═══════════════════ configuring it is governed, and cannot point at nothing ═══════════════════ */

  it("configuring a target is a governed act, at the department's own scope", async () => {
    const stranger: Actor = { type: "user", id: DM_A };
    expect((await refusal(withTx(db, (tx) => setEscalationTarget(tx, stranger, {
      alertKind: "notification.failed", positionKey: "duty_manager",
      fallbackRoleKey: "duty_manager", departmentId: MED,
    })))).code).toBe("not_permitted");
  });

  it("refuses an unknown alert kind, an unknown position, an unknown role and an unknown department", async () => {
    const bad = (over: Record<string, unknown>) => withTx(db, (tx) => setEscalationTarget(tx, ms, {
      alertKind: "notification.failed", positionKey: "duty_manager",
      fallbackRoleKey: "duty_manager", departmentId: MED, ...over,
    } as Parameters<typeof setEscalationTarget>[2]));
    expect((await refusal(bad({ alertKind: "pager.went.off" }))).code).toBe("unknown_escalation_kind");
    expect((await refusal(bad({ positionKey: "registrar" }))).code).toBe("unknown_position");
    expect((await refusal(bad({ fallbackRoleKey: "nightwatchman" }))).code).toBe("unknown_role");
    expect((await refusal(bad({ departmentId: "01ORGDEPT0000000000GHOST" }))).code).toBe("unknown_department");
  });

  it("NO machine configures where an escalation goes", async () => {
    for (const type of ["system", "agent"] as const) {
      const e = await refusal(withTx(db, (tx) => setEscalationTarget(tx, { type, id: MS }, {
        alertKind: "notification.failed", positionKey: "duty_manager",
        fallbackRoleKey: "duty_manager", departmentId: MED,
      })));
      expect(`${type}: ${e.code}`).toBe(`${type}: act_not_available_to_actor`);
    }
  });
});
