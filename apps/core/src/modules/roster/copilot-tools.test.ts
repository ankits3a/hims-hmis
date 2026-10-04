import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import { permissionCheckFor, runTool } from "../../kernel/copilot/catalog";
import { matchIntent } from "../../kernel/copilot/phrasebook";
import {
  orgDepartments, permissions, roleAssignments, rolePermissions, roles, rosterCoverRequests,
  rosterCycleEntries, rosterCycles, users,
} from "../../kernel/db/schema";
import { ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ, rosterActPolicy } from "./policy";
import { seedOrgDepartments, seedRosterPositions } from "./masters";
import { seedUnits, teamByCode } from "./teams";
import { addMembership } from "./memberships";
import { assign, draftPeriod, publishPeriod } from "./periods";
import { publishCycle } from "./calendar";
import { RosterError } from "./errors";
import { rosterManifest } from "./manifest";
import { departmentOf, rosterCopilotTools, whenOf } from "./copilot-tools";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";
import type { CopilotAnswer, CopilotToolCtx, CopilotToolDecl } from "../../kernel/copilot/types";

/**
 * 20-U U9 — **THE COPILOT ANSWERS FROM THE ROSTER.** General Medicine: Unit II's November is
 * published with Dr. Meena's Tuesday night (10 Nov, 20:00 → 08:00) and Dr. Rohit's Sunday night; a
 * two-day take cycle puts Unit I on take on even days from Monday 2 Nov. Each tool answers from those
 * rows, each refuses a login without `roster.read`, and `roster.ask_cover` returns a DRAFT and never
 * writes a cover request — the person sends it with their own tap.
 */
describe("roster — the copilot's tools (20-U U9)", () => {
  const MS = "01USER00000000000000000MS";
  const MEENA = "01USER0000000000000000MEENA";
  const ROHIT = "01USER0000000000000000ROHIT";
  const AMAN = "01USER00000000000000000AMAN";
  const CLERK = "01USER00000000000000000CLERK";
  const ms: Actor = { type: "user", id: MS };
  const meena: Actor = { type: "user", id: MEENA };
  const clerk: Actor = { type: "user", id: CLERK };
  const ist = (s: string): Date => new Date(`${s}:00+05:30`);
  const ON = { ROSTER_RESOLVER_ENABLED: "true" };

  let db: Db;
  let teardown: () => Promise<void>;
  let MED: string;
  let meenaNight: string;
  let now: Date;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  const tools = (): readonly CopilotToolDecl[] => rosterCopilotTools({ now: () => now, env: ON });
  const ask = (intent: string, question: string, actor: Actor = meena): Promise<CopilotAnswer> => {
    const tool = tools().find((t) => t.intent === intent)!;
    const c: CopilotToolCtx = { db, actor, subject: null, serviceDate: "2026-11-08", question };
    return runTool(tool, c, permissionCheckFor(c));
  };

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(roles).values([
      { key: "doctor", title: "Doctor" }, { key: "medical_superintendent", title: "Medical Superintendent" }, { key: "clerk", title: "Clerk" },
      ...["duty_manager", "radiologist", "pathologist", "anaesthetist", "pharmacy"].map((key) => ({ key, title: key })),
    ]);
    await db.insert(permissions).values([ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ].map((permission) => ({ permission, module: "roster" })));
    await db.insert(rolePermissions).values([
      ...[ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ].map((permission) => ({ roleKey: "medical_superintendent", permission })),
      { roleKey: "doctor", permission: ROSTER_READ },
    ]);
    for (const [id, fullName] of [[MS, "Dr. Sunita Mishra"], [MEENA, "Dr. Meena Joshi"], [ROHIT, "Dr. Rohit Bansal"], [AMAN, "Dr. Aman Gupta"], [CLERK, "Ravi Clerk"]] as const) {
      await db.insert(users).values({ id, username: id.toLowerCase(), fullName, staffCode: `EMP-${id.slice(-5)}`, passwordHash: "x" });
    }
    await db.insert(roleAssignments).values([
      { id: "RA-MS", userId: MS, roleKey: "medical_superintendent", scopeType: "hospital", scopeId: null },
      ...[MEENA, ROHIT, AMAN].map((userId, i) => ({ id: `RA-D${String(i)}`, userId, roleKey: "doctor", scopeType: "hospital", scopeId: null })),
      { id: "RA-C", userId: CLERK, roleKey: "clerk", scopeType: "hospital", scopeId: null },
    ]);
    await seedOrgDepartments(db);
    await seedRosterPositions(db);
    await seedUnits(db);
    MED = (await db.select().from(orgDepartments)).find((d) => d.code === "MED")!.id;
    const U1 = (await teamByCode(db, "MED-U1"))!.id;
    const U2 = (await teamByCode(db, "MED-U2"))!.id;
    for (const u of [MEENA, ROHIT, AMAN]) {
      await withTx(db, (tx) => addMembership(tx, ms, {
        teamId: U2, userId: u, positionKey: "ward_jr", grade: "jr1", roleInTeam: "junior_resident", kind: "parent", startsAt: ist("2026-01-01T00:00"),
      }));
    }
    const { periodId } = await withTx(db, (tx) => draftPeriod(tx, ms, {
      scopeType: "team", scopeId: U2, departmentId: MED, teamId: U2, title: "November", coversPositions: ["ward_jr"],
      startsAt: ist("2026-11-01T00:00"), endsAt: ist("2026-12-01T00:00"),
    }));
    meenaNight = (await withTx(db, (tx) => assign(tx, ms, periodId, {
      userId: MEENA, startsAt: ist("2026-11-10T20:00"), endsAt: ist("2026-11-11T08:00"), positionKey: "ward_jr", departmentId: MED, teamId: U2, mode: "presence", kind: "duty",
    }))).assignmentId;
    await withTx(db, (tx) => assign(tx, ms, periodId, {
      userId: ROHIT, startsAt: ist("2026-11-15T20:00"), endsAt: ist("2026-11-16T08:00"), positionKey: "ward_jr", departmentId: MED, teamId: U2, mode: "presence", kind: "duty",
    }));
    await withTx(db, (tx) => publishPeriod(tx, ms, periodId));

    // The take: Unit I on even days from Monday 2 Nov, Unit II on odd days, 08:00 → 08:00.
    const cycleId = newId();
    await db.insert(rosterCycles).values({ id: cycleId, departmentId: MED, cycleDays: 2, anchorIstDate: "2026-11-02", version: 1, createdBy: "t", updatedBy: "t" });
    await db.insert(rosterCycleEntries).values([U1, U2].map((teamId, dayIndex) => ({
      id: newId(), cycleId, dayIndex, teamId, activity: "take" as const, startMinute: 480, durationMinutes: 1440, createdBy: "t", updatedBy: "t",
    })));
    await withTx(db, (tx) => publishCycle(tx, ms, cycleId, "2026-11-02"));
    now = ist("2026-11-08T11:00"); // a Sunday morning
  });

  /* ═══ reading the question — pure ═══ */

  it("whenOf: kal is tomorrow unless the sentence is past; a weekday is the next one; a night is 22:00", () => {
    const sun = ist("2026-11-08T11:00");
    expect(whenOf("abhi kaun hai", sun)).toEqual({ at: sun, day: null, night: false });
    expect(whenOf("kal raat surgery ka unit kaun sa hai?", sun)).toEqual({ at: ist("2026-11-09T22:00"), day: "2026-11-09", night: true });
    expect(whenOf("kal raat kaun tha", sun)).toMatchObject({ day: "2026-11-07", night: true });
    expect(whenOf("Saturday night koi le sakta hai kya?", sun)).toEqual({ at: ist("2026-11-14T22:00"), day: "2026-11-14", night: true });
    expect(whenOf("Tuesday ko", sun)).toEqual({ at: ist("2026-11-10T10:00"), day: "2026-11-10", night: false });
    // "my next night" names no day.
    expect(whenOf("mera agla night kab hai?", sun)).toMatchObject({ day: null, night: true });
  });

  it("departmentOf: an alias, a code, a unique name — and 'medicine' is General Medicine", () => {
    const depts = [
      { departmentId: "1", code: "MED", name: "General Medicine" }, { departmentId: "2", code: "RESP", name: "Respiratory Medicine" },
      { departmentId: "3", code: "ORT", name: "Orthopaedics" }, { departmentId: "4", code: "SUR", name: "General Surgery" },
    ];
    expect(departmentOf("ortho mein abhi on call kaun hai?", depts)?.code).toBe("ORT");
    expect(departmentOf("medicine mein kaun hai", depts)?.code).toBe("MED");
    expect(departmentOf("chest unit on take", depts)?.code).toBe("RESP");
    expect(departmentOf("kal raat surgery ka unit kaun sa hai?", depts)?.code).toBe("SUR");
    expect(departmentOf("abhi on call kaun hai", depts)).toBeNull();
  });

  /* ═══ each tool answers from the roster ═══ */

  it("roster.who_is_on names who is in the building in the department asked, at the time asked", async () => {
    const a = await ask("roster.who_is_on", "medicine mein Tuesday raat on call kaun hai?");
    expect(a.key).toBe("copilot.answer.rosterWhoIsOn");
    expect(a.params).toMatchObject({ dept: "General Medicine", when: "10-11-2026 22:00", unit: "Unit I", here: "JR Dr. Meena Joshi" });
    expect(await ask("roster.who_is_on", "abhi on call kaun hai?")).toEqual({ key: "copilot.answer.rosterNeedDept", params: {} });
  });

  it("roster.unit_on_take names the unit on take at the night asked", async () => {
    const a = await ask("roster.unit_on_take", "kal raat medicine ka unit kaun sa hai?");
    // Monday 9 Nov is an odd day from the anchor: Unit II, 09-11 08:00 → 10-11 08:00.
    expect(a).toEqual({
      key: "copilot.answer.rosterUnitOnTake",
      params: { dept: "General Medicine", when: "09-11-2026 22:00", unit: "Unit II", from: "09-11-2026 08:00", till: "10-11-2026 08:00", backup: "—" },
    });
  });

  it("roster.my_duties answers the reader's own next night, and a day with nothing on it", async () => {
    expect(await ask("roster.my_duties", "mera agla night kab hai?")).toEqual({
      key: "copilot.answer.rosterMyNextNight",
      params: { post: "Ward junior resident", unit: "General Medicine Unit II", from: "10-11-2026 20:00", till: "11-11-2026 08:00" },
    });
    expect(await ask("roster.my_duties", "Saturday ko meri duty hai?")).toEqual({ key: "copilot.answer.rosterMyNoneOnDay", params: { day: "14-11-2026" } });
  });

  it("roster.ask_cover returns a DRAFT of who can take my Tuesday night — and never asks anybody itself", async () => {
    const a = await ask("roster.ask_cover", "Tuesday night koi le sakta hai kya?");
    expect(a.key).toBe("copilot.answer.rosterCoverDraft");
    expect(a.payload).toMatchObject({ kind: "roster_cover_draft", assignmentId: meenaNight, post: "Ward junior resident", night: true });
    const draft = a.payload as { canTake: { userId: string; name: string }[] };
    expect(draft.canTake.length).toBeGreaterThan(0);
    expect(draft.canTake.map((c) => c.userId)).not.toContain(MEENA);
    expect(a.params).toMatchObject({ post: "Ward junior resident", when: "10-11-2026 20:00 – 11-11-2026 08:00" });
    // Nothing was written: the request is the person's tap on the draft, through POST /roster/covers.
    expect(await db.select().from(rosterCoverRequests)).toHaveLength(0);
    // …and the matrix still closes the act itself to the copilot.
    expect(() => rosterActPolicy(meena, "request_cover", "copilot")).toThrow(RosterError);
  });

  it("roster.ask_cover says so when there is no duty of mine on the day named", async () => {
    expect(await ask("roster.ask_cover", "Saturday night koi le sakta hai kya?")).toEqual({ key: "copilot.answer.rosterCoverNoDutyOn", params: { day: "14-11-2026" } });
    expect(await db.select().from(rosterCoverRequests)).toHaveLength(0);
  });

  it("every roster tool refuses a login without roster.read, before it reads anything", async () => {
    for (const [intent, q] of [
      ["roster.who_is_on", "medicine mein on call kaun hai"], ["roster.unit_on_take", "medicine ka unit kaun sa hai"],
      ["roster.my_duties", "mera agla night kab hai"], ["roster.ask_cover", "Tuesday night koi le sakta hai"],
    ] as const) {
      expect(await ask(intent, q, clerk)).toEqual({ key: "copilot.answer.notPermitted", params: {} });
    }
    expect(await db.select().from(rosterCoverRequests)).toHaveLength(0);
  });

  it("the manifest declares the four tools, each on roster.read, and the phrasebook routes the plan's sentences to them", () => {
    expect((rosterManifest.copilotTools ?? []).map((t) => [t.intent, t.permission])).toEqual([
      ["roster.who_is_on", ROSTER_READ], ["roster.unit_on_take", ROSTER_READ], ["roster.my_duties", ROSTER_READ], ["roster.ask_cover", ROSTER_READ],
    ]);
    expect(matchIntent("ortho mein abhi on call kaun hai?")?.intent).toBe("roster.who_is_on");
    expect(matchIntent("kal raat surgery ka unit kaun sa hai?")?.intent).toBe("roster.unit_on_take");
    expect(matchIntent("mera agla night kab hai?")?.intent).toBe("roster.my_duties");
    expect(matchIntent("Saturday night koi le sakta hai kya?")?.intent).toBe("roster.ask_cover");
  });
});
