import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import {
  orgDepartments, permissions, roleAssignments, rolePermissions, roles, users,
} from "../../kernel/db/schema";
import { RosterError } from "./errors";
import { requireRosterAct } from "./access";
import { ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ } from "./policy";
import { seedOrgDepartments, seedRosterPositions } from "./masters";
import { AUTHORITY_PERMISSION, delegationsInForce, recordDelegation } from "./delegations";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * PHASE R (R3) — a delegation is how a head of department going on leave keeps their department
 * running, and the four legs below are the four ways it could quietly become something worse.
 *
 *   1. it grants only the acts the DELEGATED AUTHORITY covers — a delegated leave approval must not
 *      publish October's roster, even though both are gated on the same permission string today;
 *   2. it reaches only the scope it names;
 *   3. it is bounded in time, and a delegation that has not started or has ended grants nothing;
 *   4. **it never makes a machine into a person.** `rosterActPolicy` runs first, so no delegation
 *      can put a scheduled job through the `never` column.
 */
describe("roster — delegations (R3)", () => {
  const HOD = "01USER0000000000000000HOD";
  const DEPUTY = "01USER000000000000000DEP";
  const OTHER = "01USER0000000000000000OTH";
  /** Holds the roster strings across the whole hospital — the office that RECORDS a delegation. */
  const SUPER = "01USER0000000000000000SUP";
  const hod: Actor = { type: "user", id: HOD };
  const deputy: Actor = { type: "user", id: DEPUTY };

  let db: Db;
  let teardown: () => Promise<void>;
  let MED: string;
  let SUR: string;

  const at = (s: string): Date => new Date(`${s}:00+05:30`);
  /** A window that is open right now, whenever "now" is — see `bounds-sized-in-the-quiet-regime`. */
  const OPEN = { startsAt: new Date(Date.now() - 86_400_000), endsAt: new Date(Date.now() + 86_400_000) };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(roles).values([
      { key: "doctor", title: "Doctor" },
      { key: "medical_superintendent", title: "Medical Superintendent" },
      { key: "duty_manager", title: "Duty manager" },
      { key: "radiologist", title: "Radiologist" },
      { key: "pathologist", title: "Pathologist" },
      { key: "anaesthetist", title: "Anaesthetist" },
      { key: "pharmacy", title: "Pharmacy" },
    ]);
    await db.insert(permissions).values(
      [ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ].map((permission) => ({ permission, module: "roster" })),
    );
    await db.insert(rolePermissions).values(
      [ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ].map((permission) => ({ roleKey: "medical_superintendent", permission })),
    );
    for (const [id, username] of [[HOD, "r.prasad"], [DEPUTY, "n.verma"], [OTHER, "s.kumar"], [SUPER, "sunita.mishra"]] as const) {
      await db.insert(users).values({ id, username, fullName: username, staffCode: `EMP-${id.slice(-4)}`, passwordHash: "x" });
    }
    await seedOrgDepartments(db);
    await seedRosterPositions(db);
    const depts = await db.select().from(orgDepartments);
    MED = depts.find((d) => d.code === "MED")!.id;
    SUR = depts.find((d) => d.code === "SUR")!.id;
    // The HOD holds the roster strings inside Medicine and nowhere else. The deputy holds nothing.
    await db.insert(roleAssignments).values([
      { id: "RA-HOD", userId: HOD, roleKey: "medical_superintendent", scopeType: "department", scopeId: MED },
      { id: "RA-SUP", userId: SUPER, roleKey: "medical_superintendent", scopeType: "hospital", scopeId: null },
    ]);
  });

  const refusal = async (p: Promise<unknown>): Promise<RosterError> => {
    const e = await p.then(() => null, (err: unknown) => err);
    if (!(e instanceof RosterError)) throw new Error(`expected a RosterError, got: ${String(e)}`);
    return e;
  };

  const delegate = (over: Partial<Parameters<typeof recordDelegation>[2]> = {}) =>
    withTx(db, (tx) => recordDelegation(tx, hod, {
      delegatorUserId: HOD, delegateUserId: DEPUTY, authority: "publish",
      scopeType: "department", scopeId: MED, reason: "on leave until the 21st",
      ...OPEN, ...over,
    }));

  /* ═══════════════════ it works ═══════════════════ */

  it("the deputy cannot publish, and then can, and the delegation is what changed", async () => {
    expect((await refusal(requireRosterAct(db, deputy, "publish", { departmentId: MED }))).code).toBe("not_permitted");
    await delegate();
    await expect(requireRosterAct(db, deputy, "publish", { departmentId: MED })).resolves.toBeUndefined();
    expect(await delegationsInForce(db, DEPUTY, new Date())).toHaveLength(1);
  });

  /* ═══════════════════ 1. the authority, not the string it shares ═══════════════════ */

  it("a delegated LEAVE APPROVAL does not publish a roster — even though both ride on one permission", async () => {
    // This is the hole the obvious implementation has: all six authorities are gated on
    // `roster.periods.publish` today, so "a delegation grants the permission" would hand the
    // deputy the whole department's rota when the HOD meant to let them approve a day's leave.
    expect(AUTHORITY_PERMISSION.approve_leave).toBe(AUTHORITY_PERMISSION.publish);
    await delegate({ authority: "approve_leave" });
    expect((await refusal(requireRosterAct(db, deputy, "publish", { departmentId: MED }))).code).toBe("not_permitted");
  });

  it("overriding a rule and declaring a holiday are their own authorities", async () => {
    await delegate({ authority: "override_rule" });
    await expect(requireRosterAct(db, deputy, "accept_warning", { departmentId: MED })).resolves.toBeUndefined();
    expect((await refusal(requireRosterAct(db, deputy, "declare", { departmentId: MED }))).code).toBe("not_permitted");

    await delegate({ authority: "declare_holiday", startsAt: OPEN.startsAt, endsAt: OPEN.endsAt });
    await expect(requireRosterAct(db, deputy, "declare", { departmentId: MED })).resolves.toBeUndefined();
  });

  /* ═══════════════════ 2. the scope it names ═══════════════════ */

  it("reaches only the department it names, and a hospital-scoped one reaches every department", async () => {
    await delegate();
    await expect(requireRosterAct(db, deputy, "publish", { departmentId: MED })).resolves.toBeUndefined();
    expect((await refusal(requireRosterAct(db, deputy, "publish", { departmentId: SUR }))).code).toBe("not_permitted");
    // an act naming NO department is a hospital-level act, and a department delegation is not one
    expect((await refusal(requireRosterAct(db, deputy, "publish"))).code).toBe("not_permitted");

    // give the HOD the hospital, then delegate the hospital
    await db.insert(roleAssignments).values({ id: "RA-HOD-H", userId: HOD, roleKey: "medical_superintendent", scopeType: "hospital", scopeId: null });
    await delegate({ scopeType: "hospital", scopeId: null });
    await expect(requireRosterAct(db, deputy, "publish", { departmentId: SUR })).resolves.toBeUndefined();
    await expect(requireRosterAct(db, deputy, "publish")).resolves.toBeUndefined();
  });

  /* ═══════════════════ 3. it always ends ═══════════════════ */

  it("grants nothing before it starts or after it ends", async () => {
    await delegate({ startsAt: at("2026-01-01T00:00"), endsAt: at("2026-01-21T00:00") }); // long over
    expect((await refusal(requireRosterAct(db, deputy, "publish", { departmentId: MED }))).code).toBe("not_permitted");
    expect(await delegationsInForce(db, DEPUTY, new Date())).toEqual([]);
    // ...and it WAS in force at the time it covered
    expect(await delegationsInForce(db, DEPUTY, at("2026-01-10T00:00"))).toHaveLength(1);
  });

  it("refuses an open-ended delegation, and one to yourself", async () => {
    expect((await refusal(delegate({ endsAt: OPEN.startsAt }))).code).toBe("invalid_window");
    expect((await refusal(delegate({ delegateUserId: HOD }))).code).toBe("invalid_window");
  });

  /* ═══════════════════ nobody hands on what they do not hold ═══════════════════ */

  it("refuses a delegation of an authority the DELEGATOR does not hold", async () => {
    // TWO checks, in this order, and the test has to separate them or it only ever sees the first.
    // The superintendent's office RECORDS the delegation and is permitted everywhere; the HOD whose
    // authority is being handed on holds Medicine and NOT Surgery. So the act passes and the
    // delegation is refused — which is the pair of answers that matters.
    const superintendent: Actor = { type: "user", id: SUPER };
    const e = await refusal(withTx(db, (tx) => recordDelegation(tx, superintendent, {
      delegatorUserId: HOD, delegateUserId: DEPUTY, authority: "publish",
      scopeType: "department", scopeId: SUR, reason: "covering Surgery too", ...OPEN,
    })));
    expect(e.code).toBe("delegation_not_held");
    expect(e.detail).toMatchObject({ delegatorUserId: HOD, authority: "publish" });

    // ...and the ACTOR check is the one that fires first when the recorder is not permitted there.
    const actorRefused = await refusal(withTx(db, (tx) => recordDelegation(tx, hod, {
      delegatorUserId: HOD, delegateUserId: DEPUTY, authority: "publish",
      scopeType: "department", scopeId: SUR, reason: "covering Surgery too", ...OPEN,
    })));
    expect(actorRefused.code).toBe("not_permitted");

    // The same office CAN hand on Medicine, because the HOD does hold it.
    await expect(withTx(db, (tx) => recordDelegation(tx, superintendent, {
      delegatorUserId: HOD, delegateUserId: DEPUTY, authority: "publish",
      scopeType: "department", scopeId: MED, reason: "on leave", ...OPEN,
    }))).resolves.toBeDefined();
  });

  it("refuses a delegation FROM somebody who holds nothing at all — the mutual-grant hole", async () => {
    // Two people without the authority delegating it to each other is how a permission system
    // grows a hole nobody planted. Asked at the delegation's own scope, against the DELEGATOR.
    await db.insert(roleAssignments).values({ id: "RA-DEP", userId: DEPUTY, roleKey: "medical_superintendent", scopeType: "department", scopeId: MED });
    const e = await refusal(withTx(db, (tx) => recordDelegation(tx, deputy, {
      delegatorUserId: OTHER, delegateUserId: DEPUTY, authority: "publish",
      scopeType: "department", scopeId: MED, reason: "a favour", ...OPEN,
    })));
    expect(e.code).toBe("delegation_not_held");
  });

  /* ═══════════════════ 4. AND IT NEVER MAKES A MACHINE INTO A PERSON ═══════════════════ */

  it("a delegation held by the SAME ID does not let a system job or an agent publish", async () => {
    await delegate();
    // The deputy may publish. A scheduled job wearing the deputy's id may not, and is told it is
    // the wrong KIND of thing rather than that it lacks a grant — the policy ran first.
    await expect(requireRosterAct(db, deputy, "publish", { departmentId: MED })).resolves.toBeUndefined();
    for (const type of ["system", "agent"] as const) {
      const e = await refusal(requireRosterAct(db, { type, id: DEPUTY }, "publish", { departmentId: MED }));
      expect(`${type}: ${e.code}`).toBe(`${type}: act_not_available_to_actor`);
    }
    // ...and neither may the deputy's own copilot.
    const e = await refusal(requireRosterAct(db, deputy, "publish", { departmentId: MED }, "copilot"));
    expect(e.code).toBe("act_not_available_to_actor");
  });
});
