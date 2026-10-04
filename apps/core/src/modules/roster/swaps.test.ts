import { and, eq, isNull } from "drizzle-orm";
import { confirmSeededUnits } from "../../../test/helpers/units";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import {
  permissions, roleAssignments, rolePermissions, roles, rosterAmendments, rosterAssignments,
  rosterCoverRequests, rosterTeamMemberships, users, orgDepartments,
} from "../../kernel/db/schema";
import { ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ } from "./policy";
import { seedOrgDepartments, seedRosterPositions } from "./masters";
import { seedUnits, teamByCode } from "./teams";
import { seedRosterRules } from "./rules";
import { addMembership } from "./memberships";
import { amend, assign, draftPeriod, effectiveDrift, publishPeriod } from "./periods";
import { recordAbsence } from "./absences";
import { recordDelegation } from "./delegations";
import { onNowBoard } from "./board";
import { RosterError } from "./errors";
import { answerCover, coverOptions, coverRequests, decideCover, requestCover, withdrawCover } from "./swaps";
import { myDuties, openFlags, raiseFlag, resolveFlag } from "./my-duties";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * 20-U U6 — **"I CAN'T DO THIS" TO AN APPROVED AMENDMENT.** Two units of General Medicine, each
 * with its November published: Unit II has Dr. Meena's Tuesday night (10 Nov) and Dr. Rohit's
 * Sunday night (15 Nov); Unit I has Dr. Kavita on a 10:00 list the morning after Meena's night and
 * Dr. Sandeep's Saturday night. The legs are the plan's: the person asked must say yes, the people
 * in the request never approve it, across units only the HOD does, a change that breaks the rest
 * rule is refused naming it — at the request and again at approval — and an approved change is an
 * AMENDMENT that the who-is-on board reads at the swapped instant.
 */
describe("roster — covers and swaps (20-U U6)", () => {
  const MS = "01USER00000000000000000MS";
  const HEAD2 = "01USER000000000000000HEAD2";
  const MEENA = "01USER0000000000000000MEENA";
  const ROHIT = "01USER0000000000000000ROHIT";
  const KAVITA = "01USER000000000000000KAVITA";
  const SANDEEP = "01USER00000000000000SANDEEP";
  const AMAN = "01USER00000000000000000AMAN";
  const READER = "01USER0000000000000READER1";
  const ms: Actor = { type: "user", id: MS };
  const head2: Actor = { type: "user", id: HEAD2 };
  const meena: Actor = { type: "user", id: MEENA };
  const rohit: Actor = { type: "user", id: ROHIT };
  const kavita: Actor = { type: "user", id: KAVITA };
  const sandeep: Actor = { type: "user", id: SANDEEP };
  const reader: Actor = { type: "user", id: READER };
  const ist = (s: string): Date => new Date(`${s}:00+05:30`);
  const NOV = { startsAt: ist("2026-11-01T00:00"), endsAt: ist("2026-12-01T00:00") };
  const ON = { ROSTER_RESOLVER_ENABLED: "true" };

  let db: Db;
  let teardown: () => Promise<void>;
  let MED: string;
  let U1: string;
  let U2: string;
  let P1: string;
  let P2: string;
  /** Meena's night 10 Nov, Rohit's night 15 Nov (Unit II); Kavita's 10:00 list 11 Nov (Unit I). */
  let meenaNight: string;
  let rohitNight: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  const live = async (assignmentId: string) => (await db.select().from(rosterAssignments).where(eq(rosterAssignments.id, assignmentId)))[0]!;
  const holderOf = async (periodId: string, startsAt: Date): Promise<(string | null)[]> =>
    (await db.select().from(rosterAssignments).where(and(eq(rosterAssignments.periodId, periodId), eq(rosterAssignments.startsAt, startsAt), isNull(rosterAssignments.liveTo))))
      .map((r) => r.userId);
  const refusal = async (p: Promise<unknown>): Promise<{ code: string; detail?: Record<string, unknown> }> => {
    const e = await p.then(() => null, (err: unknown) => err);
    if (!(e instanceof RosterError)) throw new Error(`expected a RosterError, got ${String(e)}`);
    return { code: e.code, detail: e.detail };
  };
  const ask = (actor: Actor, counterpartId: string, assignmentId = meenaNight, counterpartAssignmentId?: string) =>
    withTx(db, (tx) => requestCover(tx, actor, { assignmentId, counterpartId, ...(counterpartAssignmentId === undefined ? {} : { counterpartAssignmentId }) }));

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(roles).values([
      { key: "doctor", title: "Doctor" }, { key: "medical_superintendent", title: "Medical Superintendent" },
      ...["duty_manager", "radiologist", "pathologist", "anaesthetist", "pharmacy"].map((key) => ({ key, title: key })),
    ]);
    await db.insert(permissions).values([ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ].map((permission) => ({ permission, module: "roster" })));
    await db.insert(rolePermissions).values([
      ...[ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ].map((permission) => ({ roleKey: "medical_superintendent", permission })),
      { roleKey: "doctor", permission: ROSTER_READ },
    ]);
    for (const [id, fullName] of [
      [MS, "Dr. Sunita Mishra"], [HEAD2, "Dr. Rakesh Verma"], [MEENA, "Dr. Meena Joshi"], [ROHIT, "Dr. Rohit Bansal"],
      [KAVITA, "Dr. Kavita Rao"], [SANDEEP, "Dr. Sandeep Yadav"], [AMAN, "Dr. Aman Gupta"], [READER, "Sr. Mary Thomas"],
    ] as const) {
      await db.insert(users).values({ id, username: id.toLowerCase(), fullName, staffCode: `EMP-${id.slice(-6)}`, passwordHash: "x" });
    }
    await db.insert(roleAssignments).values([
      { id: "RA-MS", userId: MS, roleKey: "medical_superintendent", scopeType: "hospital", scopeId: null },
      ...[HEAD2, MEENA, ROHIT, KAVITA, SANDEEP, AMAN, READER].map((userId, i) => ({ id: `RA-D${String(i)}`, userId, roleKey: "doctor", scopeType: "hospital", scopeId: null })),
    ]);
    await seedOrgDepartments(db);
    await seedRosterPositions(db);
    await seedUnits(db);
    await confirmSeededUnits(db); // only a confirmed unit counts (owner 2026-10-04)
    await seedRosterRules(db, "t");
    MED = (await db.select().from(orgDepartments)).find((d) => d.code === "MED")!.id;
    U1 = (await teamByCode(db, "MED-U1"))!.id;
    U2 = (await teamByCode(db, "MED-U2"))!.id;
    const post = (teamId: string, userId: string) => withTx(db, (tx) => addMembership(tx, ms, {
      teamId, userId, positionKey: "ward_jr", grade: "jr1", roleInTeam: "junior_resident", kind: "parent", startsAt: ist("2026-01-01T00:00"),
    }));
    for (const u of [MEENA, ROHIT, AMAN]) await post(U2, u);
    for (const u of [KAVITA, SANDEEP]) await post(U1, u);
    // The unit head of Unit II is handed `approve_swap` for Unit II alone.
    await withTx(db, (tx) => recordDelegation(tx, ms, {
      delegatorUserId: MS, delegateUserId: HEAD2, authority: "approve_swap", scopeType: "team", scopeId: U2,
      startsAt: ist("2026-01-01T00:00"), endsAt: ist("2027-01-01T00:00"), reason: "Unit II swaps, while the HOD is on deputation",
    }));

    const month = async (teamId: string, slots: { userId: string; startsAt: Date; endsAt: Date }[]): Promise<{ periodId: string; ids: string[] }> => {
      const { periodId } = await withTx(db, (tx) => draftPeriod(tx, ms, {
        scopeType: "team", scopeId: teamId, departmentId: MED, teamId, title: "November", coversPositions: ["ward_jr"], ...NOV,
      }));
      const ids: string[] = [];
      for (const s of slots) {
        ids.push((await withTx(db, (tx) => assign(tx, ms, periodId, { ...s, positionKey: "ward_jr", departmentId: MED, teamId, mode: "presence", kind: "duty" }))).assignmentId);
      }
      await withTx(db, (tx) => publishPeriod(tx, ms, periodId));
      return { periodId, ids };
    };
    const p2 = await month(U2, [
      { userId: MEENA, startsAt: ist("2026-11-10T20:00"), endsAt: ist("2026-11-11T08:00") },
      { userId: ROHIT, startsAt: ist("2026-11-15T20:00"), endsAt: ist("2026-11-16T08:00") },
    ]);
    const p1 = await month(U1, [
      { userId: KAVITA, startsAt: ist("2026-11-11T10:00"), endsAt: ist("2026-11-11T14:00") },
      { userId: SANDEEP, startsAt: ist("2026-11-14T20:00"), endsAt: ist("2026-11-15T08:00") },
    ]);
    P1 = p1.periodId; P2 = p2.periodId;
    [meenaNight, rohitNight] = p2.ids as [string, string];
    // Dr. Aman is away 9–12 Nov.
    await withTx(db, (tx) => recordAbsence(tx, ms, { userId: AMAN, kind: "EL", startsAt: ist("2026-11-09T00:00"), endsAt: ist("2026-11-13T00:00"), reason: "sister's wedding" }));
  });

  it("who CAN take it, and for everybody else WHY NOT — unavailable, never the kind of leave; a rest rule named", async () => {
    const o = await coverOptions(db, meena, meenaNight);
    expect(o.duty.night).toBe(true);
    expect(o.canTake.map((c) => [c.name, c.crossUnit])).toEqual([["Dr. Rohit Bansal", false], ["Dr. Sandeep Yadav", true]]);
    expect(Object.fromEntries(o.cannot.map((c) => [c.name, c.reason.ruleKey]))).toEqual({
      "Dr. Aman Gupta": "unavailable",
      "Dr. Kavita Rao": "rest_after_duty",
    });
    // Nothing in the answer carries the leave's kind or reason (D6, A-4).
    expect(JSON.stringify(o)).not.toMatch(/EL|wedding/);
    // A swap is offered: Rohit's Sunday night, which Meena could take in exchange.
    expect(o.canTake.find((c) => c.userId === ROHIT)!.swaps.map((s) => s.assignmentId)).toEqual([rohitNight]);
  });

  it("a resident cannot ask for cover of somebody else's duty — that is the SR's act", async () => {
    expect((await refusal(ask(rohit, SANDEEP))).code).toBe("not_permitted");
    expect((await refusal(coverOptions(db, rohit, meenaNight))).code).toBe("not_permitted");
    // The SR's (here the MS's) `propose` may.
    await ask(ms, ROHIT);
  });

  it("the person asked must say yes before anybody approves — and only they can say it", async () => {
    const { requestId } = await ask(meena, ROHIT);
    expect((await refusal(withTx(db, (tx) => decideCover(tx, head2, requestId, { approve: true })))).code).toBe("cover_not_accepted");
    expect((await refusal(withTx(db, (tx) => answerCover(tx, sandeep, requestId, true)))).code).toBe("cover_not_counterpart");
    expect(await holderOf(P2, ist("2026-11-10T20:00"))).toEqual([MEENA]);
    // A second request for the same night waits for this one.
    expect((await refusal(ask(meena, SANDEEP))).code).toBe("cover_already_asked");
  });

  it("the people in a request never approve it, whatever they hold", async () => {
    const { requestId } = await ask(ms, ROHIT); // the MS asks on Meena's behalf
    await withTx(db, (tx) => answerCover(tx, rohit, requestId, true));
    expect((await refusal(withTx(db, (tx) => decideCover(tx, ms, requestId, { approve: true })))).code).toBe("cover_self_approval");
    expect((await withTx(db, (tx) => decideCover(tx, head2, requestId, { approve: true }))).status).toBe("approved");
  });

  it("a cover that breaks the rest after a night is refused naming the rule — at the request, and again at approval when the roster moved", async () => {
    const asked = await refusal(ask(meena, KAVITA));
    expect(asked.code).toBe("cover_breaks_rule");
    expect(asked.detail).toMatchObject({ ruleKey: "rest_after_duty", userId: KAVITA });

    const { requestId } = await ask(meena, ROHIT);
    await withTx(db, (tx) => answerCover(tx, rohit, requestId, true));
    // Meanwhile Rohit is put on the 10:00 list the morning after — by an amendment, the only way.
    await withTx(db, (tx) => amend(tx, ms, P2, {
      kind: "correction", reason: "extra list", requestedBy: MS,
      open: [{ userId: ROHIT, positionKey: "ward_jr", departmentId: MED, teamId: U2, mode: "presence", kind: "duty", startsAt: ist("2026-11-11T10:00"), endsAt: ist("2026-11-11T14:00") }],
    }));
    const d = await withTx(db, (tx) => decideCover(tx, head2, requestId, { approve: true }));
    expect(d).toEqual({ status: "refused", ruleKey: "rest_after_duty", amendmentIds: [] });
    expect(await holderOf(P2, ist("2026-11-10T20:00"))).toEqual([MEENA]);
    const row = (await db.select().from(rosterCoverRequests).where(eq(rosterCoverRequests.id, requestId)))[0]!;
    expect([row.status, row.refusedRule, row.decidedBy]).toEqual(["refused", "rest_after_duty", HEAD2]);
  });

  it("approval AMENDS the published month, and the who-is-on board names the new person at 02:40 that night", async () => {
    const { requestId } = await ask(meena, ROHIT);
    await withTx(db, (tx) => answerCover(tx, rohit, requestId, true));
    const before = await onNowBoard(db, ist("2026-11-11T02:40"), ON);
    expect(before.departments.find((x) => x.departmentId === MED)!.inTheBuilding.map((p) => p.userId)).toEqual([MEENA]);

    const d = await withTx(db, (tx) => decideCover(tx, head2, requestId, { approve: true }));
    expect(d.status).toBe("approved");
    expect(d.amendmentIds).toHaveLength(1);
    const am = (await db.select().from(rosterAmendments).where(eq(rosterAmendments.id, d.amendmentIds[0]!)))[0]!;
    expect([am.kind, am.periodId, am.requestedBy, am.approvedBy, am.afterTheFact]).toEqual(["cover", P2, MEENA, HEAD2, false]);
    // Superseded, not edited: the old slot is closed and the new one carries its lineage.
    const old = await live(meenaNight);
    expect(old.liveTo).not.toBeNull();
    expect(await holderOf(P2, ist("2026-11-10T20:00"))).toEqual([ROHIT]);
    expect(await effectiveDrift(db)).toBe(0);

    const after = await onNowBoard(db, ist("2026-11-11T02:40"), ON);
    expect(after.departments.find((x) => x.departmentId === MED)!.inTheBuilding.map((p) => p.userId)).toEqual([ROHIT]);
    // Meena's phone no longer shows Tuesday night; Rohit's does.
    expect((await myDuties(db, rohit, ist("2026-11-10T07:40"))).duties.map((x) => x.istDate)).toContain("2026-11-10");
    expect((await myDuties(db, meena, ist("2026-11-10T07:40"))).duties).toEqual([]);
  });

  it("across units only the HOD approves — the unit head's delegation does not reach — and the borrowed JR is posted as a float", async () => {
    const { requestId } = await ask(meena, SANDEEP);
    expect((await db.select().from(rosterCoverRequests).where(eq(rosterCoverRequests.id, requestId)))[0]!.crossUnit).toBe(true);
    await withTx(db, (tx) => answerCover(tx, sandeep, requestId, true));
    // Refused AT THE APPROVAL ACT, asked without the unit — not by some later write it happens to reach.
    const head = await refusal(withTx(db, (tx) => decideCover(tx, head2, requestId, { approve: true })));
    expect([head.code, head.detail?.act]).toEqual(["not_permitted", "approve_swap"]);
    expect((await withTx(db, (tx) => decideCover(tx, ms, requestId, { approve: true }))).status).toBe("approved");
    const float = await db.select().from(rosterTeamMemberships).where(and(eq(rosterTeamMemberships.userId, SANDEEP), eq(rosterTeamMemberships.teamId, U2)));
    expect(float.map((m) => [m.kind, m.startsAt.toISOString(), m.endsAt?.toISOString()])).toEqual([["float", ist("2026-11-10T20:00").toISOString(), ist("2026-11-11T08:00").toISOString()]]);
    const board = await onNowBoard(db, ist("2026-11-11T02:40"), ON);
    expect(board.departments.find((x) => x.departmentId === MED)!.inTheBuilding.map((p) => p.userId)).toContain(SANDEEP);
  });

  it("a swap exchanges two duties in one approval, each new slot naming the one it was exchanged for", async () => {
    const { requestId } = await ask(meena, ROHIT, meenaNight, rohitNight);
    await withTx(db, (tx) => answerCover(tx, rohit, requestId, true));
    const d = await withTx(db, (tx) => decideCover(tx, head2, requestId, { approve: true }));
    expect(d.status).toBe("approved");
    expect(await holderOf(P2, ist("2026-11-10T20:00"))).toEqual([ROHIT]);
    expect(await holderOf(P2, ist("2026-11-15T20:00"))).toEqual([MEENA]);
    const swapped = await db.select().from(rosterAssignments).where(and(eq(rosterAssignments.periodId, P2), isNull(rosterAssignments.liveTo)));
    expect(swapped.map((r) => r.swapOfId).sort()).toEqual([meenaNight, rohitNight].sort());
  });

  it("a declined or withdrawn request changes nothing; the requests list says where each stands, and the asked person may answer", async () => {
    const a = await ask(meena, ROHIT);
    const view = await coverRequests(db, rohit, { userId: ROHIT });
    expect(view.map((v) => [v.status, v.youMay.answer, v.youMay.approve])).toEqual([["asked", true, false]]);
    await withTx(db, (tx) => answerCover(tx, rohit, a.requestId, false));
    const b = await ask(meena, SANDEEP);
    await withTx(db, (tx) => withdrawCover(tx, meena, b.requestId));
    expect(await holderOf(P2, ist("2026-11-10T20:00"))).toEqual([MEENA]);
    const mine = (await coverRequests(db, meena, { userId: MEENA })).map((v) => v.status).sort();
    expect(mine).toEqual(["declined", "withdrawn"]);
    // An approver sees the requests they could decide: the unit head the same-unit one, not the
    // cross-unit one (that is the HOD's); the MS both. A plain reader sees none of anybody else's.
    expect((await coverRequests(db, head2, { teamId: U2 })).map((v) => v.counterpart.userId)).toEqual([ROHIT]);
    expect((await coverRequests(db, ms, { teamId: U2 })).length).toBe(2);
    expect(await coverRequests(db, reader, { teamId: U2 })).toEqual([]);
  });

  it("\"this is wrong\": any reader flags a name in one line; it stays on the board until somebody who can fix the roster deals with it", async () => {
    const { flagId } = await withTx(db, (tx) => raiseFlag(tx, reader, { departmentId: MED, userId: MEENA, at: ist("2026-11-11T02:40"), note: "Dr. Meena went home sick at 22:00" }));
    const open = await openFlags(db, reader);
    expect(open.map((f) => [f.user?.name, f.note, f.youMayResolve])).toEqual([["Dr. Meena Joshi", "Dr. Meena went home sick at 22:00", false]]);
    expect((await refusal(withTx(db, (tx) => resolveFlag(tx, reader, flagId)))).code).toBe("not_permitted");
    await withTx(db, (tx) => resolveFlag(tx, ms, flagId));
    expect(await openFlags(db, reader)).toEqual([]);
    expect((await refusal(withTx(db, (tx) => raiseFlag(tx, reader, { departmentId: MED, at: new Date(), note: "   " })))).code).toBe("invalid_window");
  });
});
