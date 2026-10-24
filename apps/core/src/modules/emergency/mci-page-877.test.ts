import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { alerts, rosterAssignments, rosterPeriods } from "../../kernel/db/schema";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkErWorld } from "../../../test/helpers/emergency";
import { orgDepartmentByCode, seedOrgDepartments, seedRosterPositions } from "../roster";
import { declareMci } from "./index";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { ErWorld } from "../../../test/helpers/emergency";

/**
 * #877 item 1 — declaring a Code Yellow PAGES: every Casualty roster member on duty now, the hospital-wide on-call cover
 * (the roster's call-out list for Casualty), and the people who command a Code Yellow (MS, duty managers). The bell's
 * words carry no patient (there is none yet) — "Code Yellow · <place>", "Mass casualty · report to the ER". Nobody on
 * the roster → the casualty nurses (fallback). The declarer is not paged.
 */

jest.setTimeout(240_000);

const key = (): string => randomUUID();
const H = 3_600_000;

describe("#877 Code Yellow pages the ER and the on-call phones", () => {
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
  });

  async function duty(userId: string, deptCode: string, positionKey: string, from: Date, to: Date, cover: "department" | "hospital" = "department"): Promise<void> {
    const dept = (await orgDepartmentByCode(db, deptCode))!;
    let periodId = (await db.select({ id: rosterPeriods.id }).from(rosterPeriods).where(eq(rosterPeriods.departmentId, dept.id)))[0]?.id;
    if (periodId === undefined) {
      periodId = newId();
      await db.insert(rosterPeriods).values({
        id: periodId, scopeType: "department", scopeId: dept.id, departmentId: dept.id, title: `${deptCode} fixture`,
        startsAt: new Date(from.getTime() - 48 * H), endsAt: new Date(to.getTime() + 48 * H), version: 1, status: "published",
        coversPositions: [positionKey], publishedAt: from, publishedBy: w.ms.id, contentHash: "fixture", createdBy: w.ms.id, updatedBy: w.ms.id,
      });
    }
    const id = newId();
    await db.insert(rosterAssignments).values({
      id, periodId, userId, positionKey, startsAt: from, endsAt: to, mode: cover === "hospital" ? "call" : "presence", kind: "duty",
      departmentId: dept.id, coverScope: cover, effective: true, lineageId: id, proposedByActorId: w.ms.id, createdBy: w.ms.id, updatedBy: w.ms.id,
    });
  }

  const pagesOf = async (mciId: string) => (await db.select().from(alerts).where(and(eq(alerts.kind, "er.code_yellow"), eq(alerts.refId, mciId))));

  it("pages the Casualty duty, the on-call cover and the command; not the off-duty, other departments or the declarer", async () => {
    process.env.ROSTER_RESOLVER_ENABLED = "true";
    const now = new Date();
    const casNurse = await mkUser(db, "cas.nurse.on", ["er_nurse"]);
    const casMo = await mkUser(db, "cas.mo.on", ["doctor"]);
    const casOff = await mkUser(db, "cas.nurse.off", ["er_nurse"]);
    const onCall = await mkUser(db, "anaes.on.call", ["anaesthetist"]);
    const medWard = await mkUser(db, "med.ward.jr", ["doctor"]);
    await duty(casNurse.id, "CAS", "staff_nurse", new Date(now.getTime() - H), new Date(now.getTime() + 5 * H));
    await duty(casMo.id, "CAS", "casualty_mo", new Date(now.getTime() - 2 * H), new Date(now.getTime() + 4 * H));
    await duty(casOff.id, "CAS", "staff_nurse", new Date(now.getTime() - 10 * H), new Date(now.getTime() - 2 * H));
    await duty(onCall.id, "ANAE", "anaesthetist_on_call", new Date(now.getTime() - H), new Date(now.getTime() + 8 * H), "hospital");
    await duty(medWard.id, "MED", "ward_jr", new Date(now.getTime() - H), new Date(now.getTime() + 8 * H));

    const m = await declareMci(db, dm, { idempotencyKey: key(), name: "Bus collision", place: "NH-31 Bypass" });
    const pages = await pagesOf(m.mciId);
    const who = new Set(pages.map((p) => p.userId));
    expect(who).toEqual(new Set([casNurse.id, casMo.id, onCall.id, w.ms.id]));
    for (const p of pages) {
      expect(p.title).toBe("Code Yellow · NH-31 Bypass");
      expect(p.body).toBe("Mass casualty · report to the ER");
      expect(p.refType).toBe("er_mci");
    }
    expect(m.paged).toBe(4);
  });

  it("no roster answering: the casualty nurses and the command are paged", async () => {
    delete process.env.ROSTER_RESOLVER_ENABLED;
    const m = await declareMci(db, w.ms, { idempotencyKey: key(), name: "Fire" });
    const pages = await pagesOf(m.mciId);
    expect(new Set(pages.map((p) => p.userId))).toEqual(new Set([w.erNurse.id, dm.id]));
    expect(pages.every((p) => p.title === "Code Yellow · ER")).toBe(true);
  });
});
