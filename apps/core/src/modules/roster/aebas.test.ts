import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import { permissions, roleAssignments, rolePermissions, roles, rosterHolidays, users } from "../../kernel/db/schema";
import { RosterError } from "./errors";
import { ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ } from "./policy";
import { markAebasEntered, recordAbsence, requestAbsence } from "./absences";
import { aebasCensus, aebasTodo, markHolidayAebasEntered } from "./aebas";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * 20-U U8b — THE AEBAS TO-DO LIST (plan §2.2).
 *
 * AEBAS takes leave, tours and holidays in advance only, so each item is due the IST day before it
 * starts. The legs: what is listed (approved leave of AEBAS's kinds and holidays — not a request, not
 * the roster's own night off), when it is due, that one tap takes it off the list, that the reason
 * never reaches the officer, who may see it, and the census's two halves — RED when something is
 * due today, and RED on an empty population.
 */
describe("roster — the AEBAS to-do list (20-U U8b)", () => {
  const MS = "01USER00000000000000000MS";
  const JR = "01USER00000000000000000JR";
  const SR = "01USER00000000000000000SR";
  const ms: Actor = { type: "user", id: MS };
  const jr: Actor = { type: "user", id: JR };
  const ist = (s: string): Date => new Date(`${s}:00+05:30`);
  /** Monday 9 November 2026, 10:00 IST — "today". */
  const NOW = ist("2026-11-09T10:00");

  let db: Db;
  let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(roles).values([{ key: "medical_superintendent", title: "MS" }, { key: "reader", title: "reader" }]);
    await db.insert(permissions).values([ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ].map((permission) => ({ permission, module: "roster" })));
    await db.insert(rolePermissions).values([ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ].map((permission) => ({ roleKey: "medical_superintendent", permission })));
    await db.insert(rolePermissions).values({ roleKey: "reader", permission: ROSTER_READ });
    for (const [id, name] of [[MS, "Dr. R. Prasad"], [JR, "Dr. Sandeep Yadav"], [SR, "Dr. Meena Joshi"]] as const) {
      await db.insert(users).values({ id, username: id.slice(-2), fullName: name, staffCode: `EMP-${id.slice(-2)}`, passwordHash: "x", phone: "9812345678" });
    }
    await db.insert(roleAssignments).values([
      { id: "RA-MS", userId: MS, roleKey: "medical_superintendent", scopeType: "hospital", scopeId: null },
      { id: "RA-JR", userId: JR, roleKey: "reader", scopeType: "hospital", scopeId: null },
    ]);
  });

  const leave = (userId: string, kind: Parameters<typeof recordAbsence>[2]["kind"], from: string, to: string, reason = "my father is in ICU at Patna") =>
    withTx(db, (tx) => recordAbsence(tx, ms, { userId, kind, reason, startsAt: ist(`${from}T00:00`), endsAt: ist(`${to}T00:00`) }));
  const keys = async (): Promise<string[]> => (await aebasTodo(db, ms, NOW)).items.map((i) => `${i.key.split(":")[0]!}:${i.firstDay}:${i.state}`);

  it("lists approved leave, deputation and holidays, each due the day before it starts — and nothing else", async () => {
    await leave(JR, "CL", "2026-11-10", "2026-11-12"); // starts tomorrow: due TODAY
    await leave(SR, "deputation", "2026-11-14", "2026-11-17"); // due the 13th
    await leave(SR, "night_off", "2026-11-10", "2026-11-11"); // the roster's own rest — not AEBAS's
    await withTx(db, (tx) => requestAbsence(tx, jr, { userId: JR, kind: "EL", startsAt: ist("2026-11-20T00:00"), endsAt: ist("2026-11-21T00:00") })); // not approved
    await db.insert(rosterHolidays).values({ istDate: "2026-11-10", kind: "declared", declaredBy: MS, createdBy: MS, updatedBy: MS });

    const todo = await aebasTodo(db, ms, NOW);
    expect(todo.today).toBe("2026-11-09");
    expect(todo.items.map((i) => [i.kind, i.what, i.person?.name ?? null, i.firstDay, i.lastDay, i.dueDay, i.state])).toEqual([
      // A holiday is everybody's, so it heads its day.
      ["holiday", "declared", null, "2026-11-10", "2026-11-10", "2026-11-09", "due_today"],
      ["absence", "CL", "Dr. Sandeep Yadav", "2026-11-10", "2026-11-11", "2026-11-09", "due_today"],
      ["absence", "deputation", "Dr. Meena Joshi", "2026-11-14", "2026-11-16", "2026-11-13", "upcoming"],
    ]);
  });

  it("one tap marks it entered, and it leaves the list (absence and holiday alike)", async () => {
    const { absenceId } = await leave(JR, "EL", "2026-11-10", "2026-11-11");
    await db.insert(rosterHolidays).values({ istDate: "2026-11-10", kind: "gazetted", declaredBy: MS, createdBy: MS, updatedBy: MS });
    expect(await keys()).toEqual(["holiday:2026-11-10:due_today", "absence:2026-11-10:due_today"]);
    await withTx(db, (tx) => markAebasEntered(tx, ms, absenceId));
    await withTx(db, (tx) => markHolidayAebasEntered(tx, ms, "2026-11-10"));
    expect(await keys()).toEqual([]);
    // …and shows in what was entered this week, so the officer sees the tap landed.
    expect((await aebasTodo(db, ms, new Date())).recentlyEntered.map((i) => i.key).sort()).toEqual([`absence:${absenceId}`, "holiday:2026-11-10"]);
  });

  it("a first day already past is MISSED, not due — AEBAS takes nothing retrospectively", async () => {
    await leave(JR, "CL", "2026-11-06", "2026-11-07");
    expect(await keys()).toEqual(["absence:2026-11-06:missed"]);
    expect((await aebasCensus(db, NOW)).overdue).toBe(0);
  });

  it("never carries the reason, and never a phone", async () => {
    await leave(JR, "ML", "2026-11-10", "2026-11-11", "piles surgery at Patna");
    const wire = JSON.stringify(await aebasTodo(db, ms, NOW));
    expect(wire).not.toMatch(/piles|Patna|9812345678/);
  });

  it("is the nodal officer's (publish at hospital scope): a reader is refused the list and the mark", async () => {
    const { absenceId } = await leave(JR, "CL", "2026-11-10", "2026-11-11");
    await db.insert(rosterHolidays).values({ istDate: "2026-11-10", kind: "gazetted", declaredBy: MS, createdBy: MS, updatedBy: MS });
    const acts = [
      () => aebasTodo(db, jr, NOW),
      () => withTx(db, (tx) => markAebasEntered(tx, jr, absenceId)),
      () => withTx(db, (tx) => markHolidayAebasEntered(tx, jr, "2026-11-10")),
    ];
    for (const act of acts) {
      const e = await act().then(() => null, (err: unknown) => err);
      expect(e instanceof RosterError ? e.code : String(e)).toBe("not_permitted");
    }
  });

  it("the census: RED on an empty population, RED when an item is due today, GREEN once it is marked", async () => {
    expect(await aebasCensus(db, NOW)).toEqual({ population: 0, overdue: 0 });
    const { absenceId } = await leave(JR, "CL", "2026-11-10", "2026-11-11");
    expect(await aebasCensus(db, NOW)).toEqual({ population: 1, overdue: 1 });
    await withTx(db, (tx) => markAebasEntered(tx, ms, absenceId));
    expect(await aebasCensus(db, NOW)).toEqual({ population: 1, overdue: 0 });
  });
});
