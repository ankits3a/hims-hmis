import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { resources, rosterAssignments, rosterPeriods, rosterTeamMemberships, rosterTeams } from "../../kernel/db/schema";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkErWorld } from "../../../test/helpers/emergency";
import { orgDepartmentByCode, seedOrgDepartments, seedRosterPositions } from "../roster";
import { declareMci, openSurgeBays, readMciBoard } from "./index";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { ErWorld } from "../../../test/helpers/emergency";

/**
 * #877 item 4 — THE TEAMS ON THE MCI BOARD, per zone. The ER zone: the Casualty roster's active teams with their members,
 * and who is on duty in Casualty now (name and position). A surge zone per ward whose overflow beds were opened: the teams
 * homed in that ward. No phone numbers; nothing when no Code Yellow runs.
 */

jest.setTimeout(240_000);

const key = (): string => randomUUID();
const H = 3_600_000;

describe("#877 the teams per zone on the MCI board", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: ErWorld;
  let dm: Actor;
  const saved = process.env.ROSTER_RESOLVER_ENABLED;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => {
    if (saved === undefined) delete process.env.ROSTER_RESOLVER_ENABLED; else process.env.ROSTER_RESOLVER_ENABLED = saved;
    await teardown();
  });
  beforeEach(async () => {
    await truncateAll(db);
    w = await mkErWorld(db);
    dm = (await mkUser(db, "er.mci.dm", ["duty_manager"])).actor;
    for (const r of ["doctor", "duty_manager", "radiologist", "pathologist", "anaesthetist", "pharmacy"]) await ensureRole(db, r);
    await seedOrgDepartments(db);
    await seedRosterPositions(db);
    process.env.ROSTER_RESOLVER_ENABLED = "true";
  });

  async function team(deptCode: string, code: string, name: string, home: string | null, members: { userId: string; positionKey: string; role: string; grade: string }[]): Promise<void> {
    const dept = (await orgDepartmentByCode(db, deptCode))!;
    const id = newId();
    await db.insert(rosterTeams).values({ id, kind: home === null ? "service" : "ward_team", departmentId: dept.id, code, name, homeLocationResourceId: home, active: true, createdBy: w.ms.id, updatedBy: w.ms.id });
    for (const m of members) {
      await db.insert(rosterTeamMemberships).values({
        id: newId(), teamId: id, userId: m.userId, positionKey: m.positionKey, grade: m.grade, roleInTeam: m.role, startsAt: new Date(Date.now() - 30 * 24 * H), createdBy: w.ms.id, updatedBy: w.ms.id,
      });
    }
  }

  it("the ER zone carries the Casualty teams and who is on duty; a surge zone carries the teams of its ward", async () => {
    const now = new Date();
    const lead = await mkUser(db, "cas.lead", ["doctor"]);
    const sister = await mkUser(db, "cas.sister", ["er_nurse"]);
    const surgeNurse = await mkUser(db, "ovf.nurse", ["er_nurse"]);
    await team("CAS", "CAS-A", "Casualty team A", null, [
      { userId: lead.id, positionKey: "casualty_mo", role: "lead", grade: "medical_officer" },
      { userId: sister.id, positionKey: "staff_nurse", role: "member", grade: "staff_nurse" },
    ]);
    const cas = (await orgDepartmentByCode(db, "CAS"))!;
    const periodId = newId();
    await db.insert(rosterPeriods).values({
      id: periodId, scopeType: "department", scopeId: cas.id, departmentId: cas.id, title: "CAS fixture", startsAt: new Date(now.getTime() - 48 * H),
      endsAt: new Date(now.getTime() + 48 * H), version: 1, status: "published", coversPositions: ["staff_nurse"], publishedAt: now, publishedBy: w.ms.id,
      contentHash: "fixture", createdBy: w.ms.id, updatedBy: w.ms.id,
    });
    const aid = newId();
    await db.insert(rosterAssignments).values({
      id: aid, periodId, userId: sister.id, positionKey: "staff_nurse", startsAt: new Date(now.getTime() - H), endsAt: new Date(now.getTime() + 5 * H), mode: "presence",
      kind: "duty", departmentId: cas.id, coverScope: "department", effective: true, lineageId: aid, proposedByActorId: w.ms.id, createdBy: w.ms.id, updatedBy: w.ms.id,
    });
    const ovf = await w.bed("OVF-1", { class: "overflow", overflow: true }, "ward");
    const wardId = (await db.select({ p: resources.parentId }).from(resources).where(eq(resources.id, ovf)))[0]!.p!;
    const wardName = (await db.select({ n: resources.name }).from(resources).where(eq(resources.id, wardId)))[0]!.n;
    await team("NURS", "OVF-NURSES", "Overflow ward nurses", wardId, [{ userId: surgeNurse.id, positionKey: "staff_nurse", role: "member", grade: "staff_nurse" }]);

    expect((await readMciBoard(db, w.erNurse)).teams).toEqual([]);
    const m = await declareMci(db, dm, { idempotencyKey: key(), name: "Bus collision" });
    await openSurgeBays(db, dm, { idempotencyKey: key(), mciId: m.mciId, bedIds: [ovf] });

    const { teams } = await readMciBoard(db, w.erNurse);
    expect(teams).toEqual([
      {
        zone: "ER",
        teams: [{ code: "CAS-A", name: "Casualty team A", members: [{ name: "cas.lead", role: "lead" }, { name: "cas.sister", role: "member" }] }],
        onDuty: [{ name: "cas.sister", position: "Staff nurse" }],
      },
      { zone: `Surge · ${wardName}`, teams: [{ code: "OVF-NURSES", name: "Overflow ward nurses", members: [{ name: "ovf.nurse", role: "member" }] }], onDuty: [] },
    ]);
    expect(JSON.stringify(teams)).not.toMatch(/phone/i);
  });
});
