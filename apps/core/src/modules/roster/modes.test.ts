import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import {
  orgDepartments, permissions, roleAssignments, rolePermissions, roles, staffAbsences, users,
} from "../../kernel/db/schema";
import { RosterError } from "./errors";
import { ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ } from "./policy";
import {
  declareSkeletonMode, modeDeclarations, skeletonModeOn, withdrawSkeletonMode,
} from "./modes";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * PHASE R (R8) — **SKELETON MODE (D4).**
 *
 * The leg that matters most is the FIRST one: a declaration is for one day and expires by itself.
 * Every emergency flag in every hospital system eventually fails the same way — switched on at
 * 02:00 during a crisis, never switched off, and months later something is still quietly routing
 * around a rota nobody thinks is in force. The test that the next day is NOT on skeleton cover is
 * what stops this one joining them.
 *
 * The second is that the mode marks NOBODY absent. It says the hospital is short; `staff_absences`
 * says who is not coming. Fusing them would let one declaration mark a department away.
 */
describe("roster — skeleton mode, declared and stood down (R8/D4)", () => {
  const MS = "01USER00000000000000000MS";
  const SR = "01USER00000000000000000SR";
  const MED = "01ORGDEPT000000000000MED";
  const SUR = "01ORGDEPT000000000000SUR";

  const ms: Actor = { type: "user", id: MS };
  const machine: Actor = { type: "system", id: "roster-proposer" };

  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(roles).values([
      { key: "doctor", title: "Doctor" },
      { key: "medical_superintendent", title: "Medical Superintendent" },
    ]);
    await db.insert(permissions).values(
      [ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ].map((permission) => ({ permission, module: "roster" })),
    );
    await db.insert(rolePermissions).values(
      [ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ].map((permission) => ({ roleKey: "medical_superintendent", permission })),
    );
    await db.insert(orgDepartments).values([
      { id: MED, code: "MED", name: "General Medicine", kind: "clinical", admitting: true, createdBy: "t", updatedBy: "t" },
      { id: SUR, code: "SUR", name: "General Surgery", kind: "clinical", admitting: true, createdBy: "t", updatedBy: "t" },
    ]);
    for (const [id, username] of [[MS, "sunita.mishra"], [SR, "kavita.rao"]] as const) {
      await db.insert(users).values({ id, username, fullName: username, staffCode: `EMP-${id.slice(-4)}`, passwordHash: "x" });
    }
    await db.insert(roleAssignments).values([
      { id: "RA-MS", userId: MS, roleKey: "medical_superintendent", scopeType: "hospital", scopeId: null },
      { id: "RA-SR", userId: SR, roleKey: "doctor", scopeType: "hospital", scopeId: null },
    ]);
  });

  const refusal = async (p: Promise<unknown>): Promise<RosterError> => {
    const e = await p.then(() => null, (err: unknown) => err);
    if (!(e instanceof RosterError)) throw new Error(`expected a RosterError, got: ${String(e)}`);
    return e;
  };

  it("EXPIRES DAILY: declared for the 12th, and the 13th is an ordinary day again", async () => {
    await withTx(db, (tx) => declareSkeletonMode(tx, ms, {
      departmentId: MED, istDate: "2026-10-12", reason: "bandh; half the residents cannot reach the hospital",
    }));

    expect(await skeletonModeOn(db, MED, "2026-10-12")).toBe(true);
    // Nobody has to remember to turn it off, because there is nothing to turn off.
    expect(await skeletonModeOn(db, MED, "2026-10-13")).toBe(false);
    expect(await skeletonModeOn(db, MED, "2026-10-11")).toBe(false);
  });

  it("a hospital-wide declaration answers for every department; a department's own does not", async () => {
    await withTx(db, (tx) => declareSkeletonMode(tx, ms, {
      istDate: "2026-10-12", reason: "mass casualty — rail accident at Danapur",
    }));
    expect(await skeletonModeOn(db, MED, "2026-10-12")).toBe(true);
    expect(await skeletonModeOn(db, SUR, "2026-10-12")).toBe(true);

    await withTx(db, (tx) => declareSkeletonMode(tx, ms, {
      departmentId: MED, istDate: "2026-10-14", reason: "influenza among the residents",
    }));
    expect(await skeletonModeOn(db, MED, "2026-10-14")).toBe(true);
    expect(await skeletonModeOn(db, SUR, "2026-10-14")).toBe(false);
  });

  it("declaring twice on one day is one row — a crisis produces duplicate calls, not duplicate days", async () => {
    const first = await withTx(db, (tx) => declareSkeletonMode(tx, ms, {
      departmentId: MED, istDate: "2026-10-12", reason: "bandh",
    }));
    const second = await withTx(db, (tx) => declareSkeletonMode(tx, ms, {
      departmentId: MED, istDate: "2026-10-12", reason: "bandh, said again by somebody else",
    }));
    expect(second.id).toBe(first.id);
    expect((await modeDeclarations(db, "2026-10-12"))).toHaveLength(1);
    // …and the FIRST reason stands, because it is the one that was acted on.
    expect(second.reason).toBe("bandh");
  });

  it("withdrawal stamps the row and never deletes it — the day's checklist still names it", async () => {
    const d = await withTx(db, (tx) => declareSkeletonMode(tx, ms, {
      departmentId: MED, istDate: "2026-10-12", reason: "bandh",
    }));
    expect(await skeletonModeOn(db, MED, "2026-10-12")).toBe(true);

    await withTx(db, (tx) => withdrawSkeletonMode(tx, ms, d.id, "roads open, staff arriving"));
    expect(await skeletonModeOn(db, MED, "2026-10-12")).toBe(false);

    // The question afterwards is who said so and when it stopped — so the row is still there.
    const list = await modeDeclarations(db, "2026-10-12");
    expect(list).toHaveLength(1);
    expect(list[0]!.withdrawnBy).toBe(MS);
    expect(list[0]!.withdrawnAt).not.toBeNull();
    expect(list[0]!.withdrawReason).toBe("roads open, staff arriving");
    expect(list[0]!.declaredBy).toBe(MS); // and who declared it is untouched
  });

  it("standing the same one down twice is refused", async () => {
    const d = await withTx(db, (tx) => declareSkeletonMode(tx, ms, {
      departmentId: MED, istDate: "2026-10-12", reason: "bandh",
    }));
    await withTx(db, (tx) => withdrawSkeletonMode(tx, ms, d.id, "over"));
    expect((await refusal(withTx(db, (tx) => withdrawSkeletonMode(tx, ms, d.id, "over again")))).code)
      .toBe("mode_already_withdrawn");
  });

  it("NO MACHINE puts a hospital on skeleton cover, however sure it is", async () => {
    const e = await refusal(withTx(db, (tx) => declareSkeletonMode(tx, machine, {
      departmentId: MED, istDate: "2026-10-12", reason: "attendance is 40% below the median",
    })));
    expect(e.code).toBe("act_not_available_to_actor");
    expect(await skeletonModeOn(db, MED, "2026-10-12")).toBe(false);
  });

  it("a declaration without a reason is refused — somebody reads this at handover", async () => {
    expect((await refusal(withTx(db, (tx) => declareSkeletonMode(tx, ms, {
      departmentId: MED, istDate: "2026-10-12", reason: "   ",
    })))).code).toBe("invalid_window");
  });

  it("a day that is not a calendar day is refused rather than stored", async () => {
    expect((await refusal(withTx(db, (tx) => declareSkeletonMode(tx, ms, {
      departmentId: MED, istDate: "12-10-2026", reason: "bandh",
    })))).code).toBe("invalid_window");
  });

  it("declaring skeleton mode marks NOBODY absent", async () => {
    await withTx(db, (tx) => declareSkeletonMode(tx, ms, {
      departmentId: MED, istDate: "2026-10-12", reason: "bandh",
    }));
    // The mode says the hospital is short. Who is not coming is `staff_absences`, and R4 guards
    // that separately — one declaration must never be able to mark a department away.
    const n = await db.execute(sql`select count(*)::int as n from staff_absences`);
    expect((n.rows[0] as { n: number }).n).toBe(0);

    // …and the two compose: bulk abstention is recorded as its own act, against the same day.
    await db.insert(staffAbsences).values({
      id: "01ABS000000000000000009", userId: SR, kind: "abstaining",
      startsAt: new Date("2026-10-12T00:00:00+05:30"), endsAt: new Date("2026-10-13T00:00:00+05:30"),
      status: "approved", requestedBy: SR, approvedBy: MS, decidedAt: new Date("2026-10-11T10:00:00+05:30"),
      source: "manual", createdBy: "t", updatedBy: "t",
    });
    const after = await db.execute(sql`select count(*)::int as n from staff_absences`);
    expect((after.rows[0] as { n: number }).n).toBe(1);
    expect(await skeletonModeOn(db, MED, "2026-10-12")).toBe(true);
  });
});
