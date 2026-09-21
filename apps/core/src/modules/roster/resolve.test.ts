import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import {
  orgDepartments, permissions, roleAssignments, rolePermissions, roles, rosterAssignments,
  rosterTeams, users,
} from "../../kernel/db/schema";
import { usersHoldingRole } from "../../kernel/workflow/roles";
import { RosterError } from "./errors";
import { ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ } from "./policy";
import { seedOrgDepartments, seedRosterPositions } from "./masters";
import { seedUnits, teamByCode } from "./teams";
import { addMembership, endMembership } from "./memberships";
import { recordOfficiating } from "./officiating";
import { recordAbsence } from "./absences";
import { assign, draftPeriod, publishPeriod } from "./periods";
import { calloutList, dutiesOf, onDutyNow, teamMembers, whoIsAt, whoIsOn } from "./resolve";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * PHASE R (R5) — the resolvers, and the flag that lets a hospital adopt them without a leap.
 *
 * The leg a reviewer should read first is **"a Medicine question never answers with Surgery's
 * resident"**. Plan 20 T2's resolver took a role and no scope, and RBAC's only word for a resident
 * is `doctor` — so the previous design would have woken a surgeon for a medical ward, correctly,
 * as designed. Everything else here is downstream of fixing that.
 */
describe("roster — who is on (R5)", () => {
  const MS = "01USER00000000000000000MS";
  const SR_MED = "01USER0000000000000SRMED";
  const JR_MED = "01USER0000000000000JRMED";
  const SR_SUR = "01USER0000000000000SRSUR";
  const GONE = "01USER00000000000000GONE";
  const ms: Actor = { type: "user", id: MS };

  const ON = { true: { ROSTER_RESOLVER_ENABLED: "true" }, false: {} } as const;

  let db: Db;
  let teardown: () => Promise<void>;
  let MED: string;
  let SUR: string;
  let MED_U1: string;
  let MED_U2: string;

  const at = (s: string): Date => new Date(`${s}:00+05:30`);
  const OCT = { startsAt: at("2026-10-01T00:00"), endsAt: at("2026-11-01T00:00") };
  const NIGHT = { startsAt: at("2026-10-12T20:00"), endsAt: at("2026-10-13T08:00") };
  const T0210 = at("2026-10-13T02:10");

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(roles).values([
      { key: "doctor", title: "Doctor" },
      { key: "medical_superintendent", title: "Medical Superintendent" },
      { key: "duty_manager", title: "Duty manager" }, { key: "radiologist", title: "Radiologist" },
      { key: "pathologist", title: "Pathologist" }, { key: "anaesthetist", title: "Anaesthetist" },
      { key: "pharmacy", title: "Pharmacy" },
    ]);
    await db.insert(permissions).values(
      [ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ].map((permission) => ({ permission, module: "roster" })),
    );
    await db.insert(rolePermissions).values(
      [ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ].map((permission) => ({ roleKey: "medical_superintendent", permission })),
    );
    for (const [id, username] of [
      [MS, "sunita.mishra"], [SR_MED, "kavita.rao"], [JR_MED, "sandeep.yadav"],
      [SR_SUR, "arun.gupta"], [GONE, "p.leaver"],
    ] as const) {
      await db.insert(users).values({ id, username, fullName: username, staffCode: `EMP-${id.slice(-5)}`, passwordHash: "x" });
    }
    await db.insert(roleAssignments).values([
      { id: "RA-MS", userId: MS, roleKey: "medical_superintendent", scopeType: "hospital", scopeId: null },
      { id: "RA-1", userId: SR_MED, roleKey: "doctor", scopeType: "hospital", scopeId: null },
      { id: "RA-2", userId: JR_MED, roleKey: "doctor", scopeType: "hospital", scopeId: null },
      { id: "RA-3", userId: SR_SUR, roleKey: "doctor", scopeType: "hospital", scopeId: null },
      { id: "RA-4", userId: GONE, roleKey: "doctor", scopeType: "hospital", scopeId: null },
    ]);
    await seedOrgDepartments(db);
    await seedRosterPositions(db);
    await seedUnits(db);
    const depts = await db.select().from(orgDepartments);
    MED = depts.find((d) => d.code === "MED")!.id;
    SUR = depts.find((d) => d.code === "SUR")!.id;
    MED_U1 = (await teamByCode(db, "MED-U1"))!.id;
    MED_U2 = (await teamByCode(db, "MED-U2"))!.id;
  });

  /** Publish one period covering `covers`, with the slots given. Returns its id. */
  const publish = async (
    over: { departmentId?: string | null; teamId?: string | null; covers?: string[]; scopeId?: string },
    slots: Parameters<typeof assign>[3][],
  ): Promise<string> => {
    const { periodId } = await withTx(db, (tx) => draftPeriod(tx, ms, {
      scopeType: over.teamId != null ? "team" : "department",
      scopeId: over.scopeId ?? over.teamId ?? over.departmentId ?? MED,
      departmentId: over.departmentId === undefined ? MED : over.departmentId,
      teamId: over.teamId ?? null,
      title: "October", coversPositions: over.covers ?? ["unit_sr", "ward_jr"], ...OCT,
    }));
    for (const slot of slots) await withTx(db, (tx) => assign(tx, ms, periodId, slot));
    await withTx(db, (tx) => publishPeriod(tx, ms, periodId));
    return periodId;
  };

  const nightSlot = (over: Partial<Parameters<typeof assign>[3]> = {}) => ({
    userId: SR_MED, positionKey: "unit_sr", departmentId: MED, ...NIGHT, ...over,
  });

  /* ═══════════════════ V14 — PARITY, WHICH IS WHAT "OFF" MEANS ═══════════════════ */

  it("flag OFF: the answer is exactly `usersHoldingRole`, same ids and same order", async () => {
    await publish({ teamId: MED_U1 }, [nightSlot()]);
    const answer = await whoIsOn(db, { position: "unit_sr", departmentId: MED }, T0210, ON.false);
    const before = await withTx(db, (tx) => usersHoldingRole(tx, "doctor"));
    expect(answer.source).toBe("static");
    expect(answer.userIds).toEqual(before);        // identical, in order, not merely the same set
    expect(answer.userIds).toEqual([...before]);
  });

  it("flag ON but the position UNDECLARED: still static, and it says what the roster DOES answer for", async () => {
    // Medicine has published a roster that answers for SRs and ward JRs. Nothing in the building
    // answers for the night nursing supervisor — so the question falls back rather than reading
    // "nobody is on", which is the difference between normal operation and a silent hole.
    await publish({ teamId: MED_U1 }, [nightSlot()]);
    const answer = await whoIsOn(db, { position: "night_nursing_supervisor", departmentId: MED }, T0210, ON.true);
    expect(answer.source).toBe("static");
    expect(answer.declared).toEqual(["unit_sr", "ward_jr"]);
  });

  it("a position with no eligible RBAC role falls back to NOBODY, honestly", async () => {
    // There is no RBAC question whose answer is "the interns", so `[]` here is the truth rather
    // than an empty-by-accident.
    const answer = await whoIsOn(db, { position: "intern", departmentId: MED }, T0210, ON.false);
    expect(answer).toEqual({ userIds: [], source: "static" });
  });

  it("an unknown position is an error, not an empty answer", async () => {
    await expect(whoIsOn(db, { position: "registrar", departmentId: MED }, T0210, ON.true))
      .rejects.toThrow(RosterError);
  });

  /* ═══════════════════ S1 — THE SCOPING, AND IT IS THE POINT ═══════════════════ */

  it("a MEDICINE question never answers with Surgery's resident, even when only Surgery has published", async () => {
    await publish(
      { departmentId: SUR, scopeId: SUR, covers: ["unit_sr"] },
      [nightSlot({ userId: SR_SUR, departmentId: SUR })],
    );
    // Surgery answers for itself...
    const surgery = await whoIsOn(db, { position: "unit_sr", departmentId: SUR }, T0210, ON.true);
    expect(surgery).toEqual({ userIds: [SR_SUR], source: "published" });

    // ...and Medicine, which has published nothing, falls back rather than borrowing him.
    const medicine = await whoIsOn(db, { position: "unit_sr", departmentId: MED }, T0210, ON.true);
    expect(medicine.source).toBe("static");
    expect(medicine.userIds).not.toEqual([SR_SUR]); // it is everyone holding `doctor`, not Surgery's SR

    /**
     * AND THE SAME QUESTION ONCE MEDICINE HAS PUBLISHED TOO — the leg that matters, and the one
     * this test did not have until a mutant showed why. With Medicine unpublished the answer is
     * `static` whatever the scoping does, so the assertion above proves the PERIOD filter and not
     * the slot's reach. Both departments live is the state a real hospital is in.
     */
    await publish({ departmentId: MED, scopeId: MED, covers: ["unit_sr"] }, [nightSlot({ userId: SR_MED })]);
    expect((await whoIsOn(db, { position: "unit_sr", departmentId: MED }, T0210, ON.true)))
      .toEqual({ userIds: [SR_MED], source: "published" });
    expect((await whoIsOn(db, { position: "unit_sr", departmentId: SUR }, T0210, ON.true)))
      .toEqual({ userIds: [SR_SUR], source: "published" });
  });

  it("a department-POOLED night is found from a question about any team in it; a team-only duty is not", async () => {
    // S4: the owner's night rule is only feasible pooled at department level. **This is the test
    // that exercises a slot's COVER SCOPE** — the cross-department leak above is closed by the
    // period filter, so stubbing `reaches` to `true` reddens this one and only this one.
    await publish({ departmentId: MED, scopeId: MED, covers: ["unit_sr", "ward_jr"] }, [
      nightSlot({ userId: SR_MED, coverScope: "department" }),
      nightSlot({ userId: JR_MED, positionKey: "ward_jr", teamId: MED_U1, coverScope: "team" }),
    ]);
    await withTx(db, (tx) => addMembership(tx, ms, {
      teamId: MED_U1, userId: JR_MED, positionKey: "ward_jr", grade: "jr2",
      roleInTeam: "junior_resident", startsAt: at("2026-04-01T00:00"),
    }));

    // Unit II asks: the pooled SR reaches it, the other unit's own JR does not.
    expect((await whoIsOn(db, { position: "unit_sr", teamId: MED_U2 }, T0210, ON.true)).userIds).toEqual([SR_MED]);
    expect((await whoIsOn(db, { position: "ward_jr", teamId: MED_U2 }, T0210, ON.true)).userIds).toEqual([]);
    // Unit I asks about its own JR: found.
    expect((await whoIsOn(db, { position: "ward_jr", teamId: MED_U1 }, T0210, ON.true)).userIds).toEqual([JR_MED]);
  });

  /* ═══════════════════ V13 — SLOTS MINUS WHAT OVERTOOK THEM ═══════════════════ */

  it("an empty published answer is NOT an error, and says so", async () => {
    await publish({ teamId: MED_U1 }, [nightSlot({ ...NIGHT, startsAt: at("2026-10-20T20:00"), endsAt: at("2026-10-21T08:00") })]);
    const answer = await whoIsOn(db, { position: "unit_sr", departmentId: MED }, T0210, ON.true);
    // The roster answers for this position here and nobody is on at 02:10 — a real statement.
    expect(answer).toEqual({ userIds: [], source: "published" });
  });

  it("subtracts APPROVED absence, a person who has LEFT, and a CLOSED membership", async () => {
    await publish({ departmentId: MED, scopeId: MED, covers: ["unit_sr", "ward_jr"] }, [
      nightSlot({ userId: SR_MED }),
      nightSlot({ userId: JR_MED, positionKey: "ward_jr", teamId: MED_U1 }),
      nightSlot({ userId: GONE, positionKey: "ward_jr" }),
    ]);
    await withTx(db, (tx) => addMembership(tx, ms, {
      teamId: MED_U1, userId: JR_MED, positionKey: "ward_jr", grade: "jr2",
      roleInTeam: "junior_resident", startsAt: at("2026-04-01T00:00"),
    }));
    expect((await whoIsOn(db, { position: "ward_jr", departmentId: MED }, T0210, ON.true)).userIds)
      .toEqual([GONE, JR_MED].sort());

    // (a) the person who left the hospital
    await db.update(users).set({ active: false }).where(eq(users.id, GONE));
    expect((await whoIsOn(db, { position: "ward_jr", departmentId: MED }, T0210, ON.true)).userIds).toEqual([JR_MED]);

    // (b) approved absence over that very night
    await withTx(db, (tx) => recordAbsence(tx, ms, {
      userId: JR_MED, kind: "EL", startsAt: at("2026-10-12T00:00"), endsAt: at("2026-10-15T00:00"),
    }));
    expect((await whoIsOn(db, { position: "ward_jr", departmentId: MED }, T0210, ON.true)).userIds).toEqual([]);

    // (c) the SR is untouched by any of it
    expect((await whoIsOn(db, { position: "unit_sr", departmentId: MED }, T0210, ON.true)).userIds).toEqual([SR_MED]);
  });

  it("a rostered person whose team membership CLOSED before the duty is no longer that unit's", async () => {
    await publish({ teamId: MED_U1, covers: ["ward_jr"] }, [
      nightSlot({ userId: JR_MED, positionKey: "ward_jr", teamId: MED_U1 }),
    ]);
    const { membershipId } = await withTx(db, (tx) => addMembership(tx, ms, {
      teamId: MED_U1, userId: JR_MED, positionKey: "ward_jr", grade: "jr2",
      roleInTeam: "junior_resident", startsAt: at("2026-04-01T00:00"),
    }));
    expect((await whoIsOn(db, { position: "ward_jr", teamId: MED_U1 }, T0210, ON.true)).userIds).toEqual([JR_MED]);

    // rotated out on the 10th; the October roster still names them on the 12th, and it is stale
    await withTx(db, (tx) => endMembership(tx, ms, membershipId, at("2026-10-10T00:00")));
    expect((await whoIsOn(db, { position: "ward_jr", teamId: MED_U1 }, T0210, ON.true)).userIds).toEqual([]);
  });

  it("a VACANT slot is skipped by whoIsOn and SHOWN by the callout list", async () => {
    await publish({ departmentId: MED, scopeId: MED, covers: ["unit_sr"] }, [
      nightSlot({ userId: null }),
    ]);
    expect((await whoIsOn(db, { position: "unit_sr", departmentId: MED }, T0210, ON.true)).userIds).toEqual([]);
    // ...but the ladder must be able to say "the first rung is EMPTY" rather than ring the second.
    const rungs = await calloutList(db, MED, T0210, ON.true);
    expect(rungs).toHaveLength(1);
    expect(rungs[0]).toMatchObject({ userId: null, positionKey: "unit_sr" });
  });

  it("an OFF row is never on duty", async () => {
    await publish({ departmentId: MED, scopeId: MED, covers: ["unit_sr"] }, [
      nightSlot({ userId: SR_MED, kind: "off", mode: null, offKind: "WO", startsAt: at("2026-10-12T00:00"), endsAt: at("2026-10-14T00:00") }),
    ]);
    expect((await whoIsOn(db, { position: "unit_sr", departmentId: MED }, T0210, ON.true)).userIds).toEqual([]);
  });

  /* ═══════════════════ the other questions ═══════════════════ */

  it("the callout list is ordered by call tier, then by the position's own rung", async () => {
    await publish({ departmentId: MED, scopeId: MED, covers: ["unit_sr", "ward_jr", "faculty_on_call"] }, [
      nightSlot({ userId: SR_MED, positionKey: "unit_sr", callTier: 2 }),
      nightSlot({ userId: JR_MED, positionKey: "ward_jr", callTier: 1 }),
      nightSlot({ userId: SR_SUR, positionKey: "faculty_on_call", mode: "call", callTier: null }),
    ]);
    const rungs = await calloutList(db, MED, T0210, ON.true);
    // tier 1 first, then tier 2, then the untiered faculty by ladder rank
    expect(rungs.map((r) => r.positionKey)).toEqual(["ward_jr", "unit_sr", "faculty_on_call"]);
  });

  it("`dutiesOf` answers for one person and refuses a backwards window", async () => {
    await publish({ departmentId: MED, scopeId: MED, covers: ["unit_sr", "ward_jr"] }, [
      nightSlot({ userId: SR_MED }),
      nightSlot({ userId: JR_MED, positionKey: "ward_jr" }),
    ]);
    const mine = await dutiesOf(db, SR_MED, at("2026-10-01T00:00"), at("2026-11-01T00:00"));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.positionKey).toBe("unit_sr");
    await expect(dutiesOf(db, SR_MED, at("2026-11-01T00:00"), at("2026-10-01T00:00")))
      .rejects.toThrow(RosterError);
  });

  it("`whoIsAt` answers about a PLACE, and only about people who are physically present", async () => {
    const [ward] = await db.select().from(rosterTeams).limit(1);
    void ward;
    await publish({ departmentId: MED, scopeId: MED, covers: ["unit_sr", "faculty_on_call"] }, [
      nightSlot({ userId: SR_MED, locationResourceId: null }),
      nightSlot({ userId: SR_SUR, positionKey: "faculty_on_call", mode: "call" }),
    ]);
    // nothing carries a location in this fixture, so the honest answer is nobody
    expect((await whoIsAt(db, "01RESOURCE0000000000WARD", T0210, ON.true)).userIds).toEqual([]);
  });

  it("`onDutyNow` carries the SOURCE, so a board can say UNPUBLISHED rather than show an empty ward", async () => {
    const unpublished = await onDutyNow(db, MED, T0210, ON.true);
    expect(unpublished.source).toBe("static");
    expect(unpublished.positions).toEqual([]);

    await publish({ departmentId: MED, scopeId: MED, covers: ["unit_sr"] }, [nightSlot()]);
    const published = await onDutyNow(db, MED, T0210, ON.true);
    expect(published.source).toBe("published");
    expect(published.positions).toEqual([{ positionKey: "unit_sr", userIds: [SR_MED] }]);

    // and with the flag off it is `static` however much is published
    expect((await onDutyNow(db, MED, T0210, ON.false)).source).toBe("static");
  });

  /* ═══════════════════ officiating reaches the resolver ═══════════════════ */

  it("an officiating head is who the team resolves to for the head's role", async () => {
    await withTx(db, (tx) => addMembership(tx, ms, {
      teamId: MED_U1, userId: SR_MED, positionKey: "unit_head", grade: "professor",
      roleInTeam: "head", startsAt: at("2026-04-01T00:00"),
    }));
    await withTx(db, (tx) => recordOfficiating(tx, ms, {
      teamId: MED_U1, userId: JR_MED, role: "head", reason: "the head is on leave",
      startsAt: at("2026-10-01T00:00"), endsAt: at("2026-10-21T00:00"),
    }));
    const during = await teamMembers(db, MED_U1, T0210);
    const acting = during.find((m) => m.userId === JR_MED)!;
    expect(acting).toMatchObject({ roleInTeam: "head", officiating: true });
  });

  /* ═══════════════════ the budget, written as ORDER rather than milliseconds ═══════════════════ */

  it("the number of database round-trips does not grow with the number of slots", async () => {
    /**
     * A wall-clock budget written on an idle box is a budget that goes red on a busy one and proves
     * nothing on either (`bounds-sized-in-the-quiet-regime`). What actually matters is the SHAPE:
     * the resolver must not issue a query per slot. So this counts round-trips over 10 slots and
     * over 2,000 and requires the SAME NUMBER — which is the property a timing test was a proxy for,
     * measured directly and immune to what else the machine is doing.
     *
     * Round-trips are bounded by the number of TEAMS involved (the membership read is per team, and
     * teams are bounded by the establishment at 27), never by the number of slots. Both fixtures
     * here use one team, so the counts are directly comparable.
     */
    const countingDb = (): { db: Db; count: () => number } => {
      let n = 0;
      const proxy = new Proxy(db as object, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver) as unknown;
          if ((prop === "select" || prop === "execute") && typeof value === "function") {
            return (...args: unknown[]) => { n += 1; return (value as (...a: unknown[]) => unknown).apply(target, args); };
          }
          return value;
        },
      }) as Db;
      return { db: proxy, count: () => n };
    };

    // One real slot through the checked path, so the period is publishable; the rest are bulk rows,
    // because the shape being measured is the resolver's, not `assign`'s.
    const periodId = await publish({ teamId: MED_U1, covers: ["ward_jr"] }, [
      nightSlot({ userId: JR_MED, positionKey: "ward_jr", teamId: MED_U1, mode: "call" }),
    ]);
    await withTx(db, (tx) => addMembership(tx, ms, {
      teamId: MED_U1, userId: JR_MED, positionKey: "ward_jr", grade: "jr2",
      roleInTeam: "junior_resident", startsAt: at("2026-04-01T00:00"),
    }));

    const seed = async (from: number, to: number): Promise<void> => {
      const rows = [];
      for (let i = from; i < to; i += 1) {
        const id = `01SLOT${String(i).padStart(19, "0")}`;
        rows.push({
          id, periodId, userId: JR_MED, positionKey: "ward_jr", departmentId: MED, teamId: MED_U1,
          startsAt: NIGHT.startsAt, endsAt: NIGHT.endsAt, mode: "call" as const, effective: true,
          lineageId: id, proposedByActorId: "t", createdBy: "t", updatedBy: "t",
        });
      }
      for (let i = 0; i < rows.length; i += 500) await db.insert(rosterAssignments).values(rows.slice(i, i + 500));
    };

    await seed(0, 10);
    const small = countingDb();
    const a = await whoIsOn(small.db, { position: "ward_jr", teamId: MED_U1 }, T0210, ON.true);
    const smallCount = small.count();

    await seed(10, 2000);
    const large = countingDb();
    const b = await whoIsOn(large.db, { position: "ward_jr", teamId: MED_U1 }, T0210, ON.true);
    const largeCount = large.count();

    expect(a.userIds).toEqual([JR_MED]);
    expect(b.userIds).toEqual([JR_MED]);     // 2,000 slots, one person, one answer
    expect(`10 slots: ${smallCount} round-trips, 2000 slots: ${largeCount}`)
      .toBe(`10 slots: ${smallCount} round-trips, 2000 slots: ${smallCount}`);
    expect(smallCount).toBeLessThan(10);      // and it is a handful, not a handful per slot
  });
});
