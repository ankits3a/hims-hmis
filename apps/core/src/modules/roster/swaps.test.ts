import { and, asc, eq, isNull } from "drizzle-orm";
import { confirmSeededUnits } from "../../../test/helpers/units";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import {
  alerts, events, permissions, roleAssignments, rolePermissions, roles, rosterAmendments, rosterAssignments,
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
import { alertsConsumer } from "../../kernel/alerts/consumer";
import { dueDutyReminders, longReminderAt, sweepDutyReminders, wantsLongReminder } from "./staff-notices";
import type { DispatchedEvent } from "../../kernel/events/subscriptions";
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

  /* ═══════════ MOBILE §3i (owner 2026-10-07) — a person's own duties reach their own bell ═══════════ */

  /** Every event of these names appended so far, in order, as the dispatcher would hand them over. */
  const dispatched = async (...names: string[]): Promise<DispatchedEvent[]> =>
    (await db.select().from(events).orderBy(asc(events.seq))).filter((r) => names.includes(r.name)).map((r) => ({
      seq: Number(r.seq), eventId: r.eventId, name: r.name, payload: r.payload,
      patientId: r.patientId, correlationId: r.correlationId, occurredAt: r.occurredAt,
    }));
  const deliver = async (...names: string[]): Promise<void> => {
    const handle = alertsConsumer(db);
    for (const e of await dispatched(...names)) { await handle(e); await handle(e); } // at-least-once: every one twice
  };
  const bell = async (kind: string) => (await db.select().from(alerts).where(eq(alerts.kind, kind))).map((a) => ({ to: a.userId, title: a.title, body: a.body ?? "" }));

  it("a cover ASKED of me rings my bell and nobody else's — once, however often it is delivered, and never with the note", async () => {
    await withTx(db, (tx) => requestCover(tx, meena, { assignmentId: meenaNight, counterpartId: ROHIT, note: "my father is in ICU" }));
    await deliver("roster.cover_requested");
    const rows = await bell("roster_cover_asked");
    expect(rows.map((r) => r.to)).toEqual([ROHIT]);
    expect(rows[0]!.title).toBe("Dr. Meena Joshi asks you to cover a duty");
    expect(rows[0]!.body).toContain("10 Nov, 20:00–08:00 IST");
    expect(JSON.stringify(rows)).not.toContain("ICU");
  });

  it("the ANSWER goes back to the person whose duty it is — not to the one who gave it", async () => {
    const { requestId } = await ask(meena, ROHIT);
    await withTx(db, (tx) => answerCover(tx, rohit, requestId, true));
    await deliver("roster.cover_answered");
    const rows = await bell("roster_cover_answered");
    expect(rows.map((r) => r.to)).toEqual([MEENA]);
    expect(rows[0]!.title).toBe("Dr. Rohit Bansal said yes to the cover");
  });

  it("an APPROVAL tells both people once — the amendment it applied is not announced again as 'your duties changed'", async () => {
    const { requestId } = await ask(meena, ROHIT);
    await withTx(db, (tx) => answerCover(tx, rohit, requestId, true));
    await withTx(db, (tx) => decideCover(tx, head2, requestId, { approve: true }));
    await deliver("roster.cover_decided", "roster.duty_changed");
    expect((await bell("roster_cover_decided")).map((r) => r.to).sort()).toEqual([MEENA, ROHIT].sort());
    expect((await bell("roster_cover_decided"))[0]!.title).toBe("The cover is approved");
    expect(await bell("roster_duty_changed")).toEqual([]);
  });

  it("a WITHDRAWAL tells the colleague who was asked, and not the person who withdrew it", async () => {
    const { requestId } = await ask(meena, ROHIT);
    await withTx(db, (tx) => withdrawCover(tx, meena, requestId));
    await deliver("roster.cover_decided");
    expect((await bell("roster_cover_decided")).map((r) => [r.to, r.title])).toEqual([[ROHIT, "The cover request was withdrawn"]]);
  });

  it("a PUBLISHED month tells each person on it, once; an amendment by the office tells only the person it moved", async () => {
    await deliver("roster.duty_changed");
    expect((await bell("roster_month_published")).map((r) => r.to).sort()).toEqual([KAVITA, MEENA, ROHIT, SANDEEP].sort());
    expect(await bell("roster_duty_changed")).toEqual([]);

    await withTx(db, (tx) => amend(tx, ms, P2, {
      kind: "correction", reason: "extra list", requestedBy: MS,
      open: [{ userId: ROHIT, positionKey: "ward_jr", departmentId: MED, teamId: U2, mode: "presence", kind: "duty", startsAt: ist("2026-11-11T10:00"), endsAt: ist("2026-11-11T14:00") }],
    }));
    await deliver("roster.duty_changed");
    const changed = await bell("roster_duty_changed");
    expect(changed.map((r) => r.to)).toEqual([ROHIT]);
    expect(changed[0]!.body).toContain("Now yours: 11 Nov, 10:00–14:00 IST.");
    expect(await bell("roster_month_published")).toHaveLength(4); // nobody was told about the month again
  });

  it("the twelve-hour reminder is for a night or a take, and is never due between 22:00 and 06:00 — it moves EARLIER, to 21:00", () => {
    const hhmm = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 16);
    expect(hhmm(longReminderAt(ist("2026-11-10T20:00")))).toBe("2026-11-10T08:00"); // twelve hours, untouched
    expect(hhmm(longReminderAt(ist("2026-11-11T08:00")))).toBe("2026-11-10T20:00"); // a take: the evening before
    expect(hhmm(longReminderAt(ist("2026-11-11T10:30")))).toBe("2026-11-10T21:00"); // 22:30 → 21:00 the same evening
    expect(hhmm(longReminderAt(ist("2026-11-11T14:00")))).toBe("2026-11-10T21:00"); // 02:00 → 21:00 the evening BEFORE
    expect(hhmm(longReminderAt(ist("2026-11-11T17:59")))).toBe("2026-11-10T21:00"); // 05:59 → still earlier, never 06:00
    expect(wantsLongReminder({ startsAt: ist("2026-11-10T20:00"), endsAt: ist("2026-11-11T08:00") })).toBe(true);
    expect(wantsLongReminder({ startsAt: ist("2026-11-11T08:00"), endsAt: ist("2026-11-12T08:00") })).toBe(true);
    expect(wantsLongReminder({ startsAt: ist("2026-11-11T10:00"), endsAt: ist("2026-11-11T14:00") })).toBe(false);
  });

  it("reminders come from the PUBLISHED roster: one an hour ahead, one twelve hours ahead of a night — each raised once, and not after its moment", async () => {
    const lead = async (at: string) => (await dueDutyReminders(db, ist(at))).map((r) => `${r.userId === MEENA ? "meena" : r.userId === KAVITA ? "kavita" : "other"}:${r.lead}`).sort();
    expect(await lead("2026-11-10T08:05")).toEqual(["meena:12h"]);
    expect(await lead("2026-11-10T08:31")).toEqual([]); // half an hour late is too late
    expect(await lead("2026-11-10T19:10")).toEqual(["meena:1h"]);
    expect(await lead("2026-11-11T09:02")).toEqual(["kavita:1h"]); // a four-hour list: the hour, never the twelve
    expect(await lead("2026-11-10T22:00")).toEqual([]);

    expect(await sweepDutyReminders(db, ist("2026-11-10T19:10"))).toBe(1);
    expect(await sweepDutyReminders(db, ist("2026-11-10T19:11"))).toBe(0); // the next tick raises nothing
    const rows = await bell("roster_duty_reminder");
    expect(rows).toEqual([{ to: MEENA, title: "Your duty starts at 20:00 IST", body: expect.stringContaining("General Medicine · 10 Nov, 20:00–08:00 IST") }]);
    expect((await db.select().from(events).where(eq(events.name, "alert.raised"))).length).toBe(1);
  });

  it("a person already on a duty that runs into the next one is not reminded of it", async () => {
    // The day shift before Meena's own night, written as the published row it would be (the rule under test is the reminder's, not the validator's).
    const night = await live(meenaNight);
    await db.insert(rosterAssignments).values({ ...night, id: "01ASSIGN0000000000MEENADAY", startsAt: ist("2026-11-10T08:00"), endsAt: ist("2026-11-10T20:00") });
    expect((await dueDutyReminders(db, ist("2026-11-10T19:10"))).filter((r) => r.userId === MEENA)).toEqual([]);
    expect((await dueDutyReminders(db, ist("2026-11-10T07:10"))).filter((r) => r.userId === MEENA).map((r) => r.lead)).toEqual(["1h"]); // the day shift itself is
  });
});
