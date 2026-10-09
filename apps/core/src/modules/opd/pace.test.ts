import { newId, PACE_GROUP_ITEMS_FLOOR, PACE_GROUP_PEOPLE_FLOOR, PACE_MAX_MINUTES, PACE_MIN_MINUTES, PACE_OWN_FLOOR } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../kernel/modules/manifests";
import { opdEncounters, opdVitals } from "../../kernel/db/schema";
import { groupFigure, loadMyPace, medianOf, ownFigure, paceWindow, withinBounds } from "./pace";
import { addDays } from "./time";
import type { Db } from "../../kernel/db/client";

/**
 * MY PACE — owner 2026-10-09. What is proved: the minutes come from the two stored instants; paper,
 * abandoned and out-of-bounds visits are left out and counted; the floors hold ON THE SERVER — own 10,
 * a group 3 people AND 30 items; the caller is inside their own group; and the answer for one doctor
 * holds nothing that names or measures another.
 *
 * The clock is injected (`NOW`), so no day here is read from the real one.
 */
const NOW = new Date("2026-06-15T08:00:00.000Z"); // 13:30 IST
const TODAY = "2026-06-15";

type Doc = Awaited<ReturnType<typeof mkDoctor>>;

describe("my pace — the pure rules", () => {
  it("states its floors and bounds as numbers", () => {
    expect([PACE_OWN_FLOOR, PACE_GROUP_PEOPLE_FLOOR, PACE_GROUP_ITEMS_FLOOR, PACE_MIN_MINUTES, PACE_MAX_MINUTES]).toEqual([10, 3, 30, 1, 90]);
  });
  it("a duration is kept from 1 to 90 minutes inclusive", () => {
    expect([0.99, 1, 45, 90, 90.01].map(withinBounds)).toEqual([false, true, true, true, false]);
  });
  it("the median of an even run is the middle pair's mean", () => {
    expect(medianOf([4, 1, 3, 2])).toBe(2.5);
    expect(medianOf([5, 1, 100])).toBe(5);
    expect(medianOf([])).toBeNull();
  });
  it("own: nine is not enough, ten is", () => {
    expect(ownFigure(Array.from({ length: 9 }, () => 8))).toEqual({ enough: false, meanMin: null, medianMin: null, n: 9 });
    expect(ownFigure(Array.from({ length: 10 }, () => 8))).toEqual({ enough: true, meanMin: 8, medianMin: 8, n: 10 });
  });
  it("a group needs three people AND thirty items", () => {
    const of = (people: number, each: number) => Array.from({ length: people * each }, (_, i) => ({ person: `p${i % people}`, group: "g", minutes: 10 }));
    expect(groupFigure(of(2, 250))).toEqual({ enough: false, meanMin: null, medianMin: null });
    expect(groupFigure(of(3, 9))).toEqual({ enough: false, meanMin: null, medianMin: null });
    expect(groupFigure(of(3, 10))).toEqual({ enough: true, meanMin: 10, medianMin: 10 });
  });
  it("a period is IST days ending today", () => {
    expect(paceWindow("today", NOW)).toEqual({ from: TODAY, to: TODAY });
    expect(paceWindow("7d", NOW)).toEqual({ from: "2026-06-09", to: TODAY });
    expect(paceWindow("30d", NOW)).toEqual({ from: "2026-05-17", to: TODAY });
    // 19:00 UTC is already tomorrow in India.
    expect(paceWindow("today", new Date("2026-06-15T19:00:00.000Z")).to).toBe("2026-06-16");
  });
});

describe("my pace — read from the visits", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  for (const m of ALL_MANIFESTS) registry.install(m);
  let medId: string; let pedId: string;
  let a: Doc; let b: Doc; let c: Doc; let d: Doc; let e: Doc;
  let clerk: Awaited<ReturnType<typeof mkUser>>; let nurse: Awaited<ReturnType<typeof mkUser>>;
  let patientId: string; let seq = 0;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  type Over = Partial<typeof opdEncounters.$inferInsert>;
  /** `count` visits of `minutes` each for one doctor, started at 10:00 IST on `day`. */
  const consults = async (doc: Doc, count: number, minutes: number, over: Over = {}, day = TODAY): Promise<string[]> => {
    const start = new Date(`${day}T04:30:00.000Z`);
    const rows = Array.from({ length: count }, () => {
      seq += 1;
      return {
        id: newId(), visitNo: `V${String(seq).padStart(10, "0")}`, patientId, workflowInstanceId: newId(), serviceDate: day,
        visitType: "new", status: "completed", doctorId: doc.doctorId,
        consultStartedAt: start, consultCompletedAt: new Date(start.getTime() + minutes * 60_000),
        openedBy: clerk.id, updatedBy: clerk.id, ...over,
      };
    });
    if (rows.length > 0) await db.insert(opdEncounters).values(rows);
    return rows.map((r) => r.id);
  };

  beforeEach(async () => {
    await truncateAll(db);
    await syncPermissions(db, registry);
    await seedOpdBase(db);
    const m = await seedOpdMasters(db);
    medId = m.deptId; pedId = m.dept2Id;
    // General Medicine has TWO doctors; Paediatrics has three.
    a = await mkDoctor(db, { username: "dra", departmentId: medId, roomId: m.roomId, displayName: "Dr Anil Sinha" });
    b = await mkDoctor(db, { username: "drb", departmentId: medId, roomId: m.roomId, displayName: "Dr Bharti Rao" });
    c = await mkDoctor(db, { username: "drc", departmentId: pedId, roomId: m.room2Id, displayName: "Dr Chandan Kumar" });
    d = await mkDoctor(db, { username: "drd", departmentId: pedId, roomId: m.room2Id, displayName: "Dr Deepa Jha" });
    e = await mkDoctor(db, { username: "dre", departmentId: pedId, roomId: m.room2Id, displayName: "Dr Esha Verma" });
    for (const [role, perms] of [["pc_clerk", ["opd.visits.open"]], ["pc_nurse", ["opd.vitals.record"]]] as const) {
      await ensureRole(db, role);
      for (const p of perms) await grantPermissionToRole(db, registry, role, p);
    }
    clerk = await mkUser(db, "clerk", ["pc_clerk"]);
    nurse = await mkUser(db, "nurse", ["pc_nurse"]);
    patientId = (await mkPatient(db, clerk.actor, { name: "Asha Devi", phone: "9100000001" })).id;
  });

  it("computes the minutes from consult_started_at to consult_completed_at", async () => {
    await consults(c, 6, 6); await consults(c, 5, 12); await consults(c, 1, 31);
    const r = await loadMyPace(db, c.actor, "today", NOW);
    // (6×6 + 5×12 + 31) / 12 = 10.58…; the median of six 6s, five 12s and a 31 is (6 + 12) / 2.
    expect(r.consultation!.own).toEqual({ enough: true, meanMin: 10.6, medianMin: 9, n: 12 });
    expect(r).toMatchObject({ period: "today", from: TODAY, to: TODAY });
  });

  it("leaves out paper, abandoned and out-of-bounds visits, and counts each", async () => {
    await consults(c, 10, 8);
    await consults(c, 3, 2, { completedVia: "paper", paperCompletedBy: clerk.id, paperCompletedAt: NOW });
    await consults(c, 2, 5, { status: "abandoned", consultCompletedAt: null, abandonedAt: NOW, abandonReason: "left" });
    await consults(c, 1, 0.5); await consults(c, 1, 91); await consults(c, 1, 240);
    // Not completed yet: neither a figure nor an exclusion.
    await consults(c, 1, 5, { status: "in_consultation", consultCompletedAt: null });
    const r = await loadMyPace(db, c.actor, "today", NOW);
    expect(r.consultation!.own).toEqual({ enough: true, meanMin: 8, medianMin: 8, n: 10 });
    expect(r.consultation!.excluded).toEqual({ paper: 3, abandoned: 2, outOfBounds: 3 });
    // Another doctor's exclusions are not the caller's to be told.
    const other = await loadMyPace(db, d.actor, "today", NOW);
    expect(other.consultation!.excluded).toEqual({ paper: 0, abandoned: 0, outOfBounds: 0 });
  });

  it("the bounds are inclusive: one minute and ninety minutes count", async () => {
    await consults(c, 5, 1); await consults(c, 5, 90);
    const r = await loadMyPace(db, c.actor, "today", NOW);
    expect(r.consultation!.own).toMatchObject({ n: 10, meanMin: 45.5 });
    expect(r.consultation!.excluded.outOfBounds).toBe(0);
  });

  it("own floor: nine consultations is 'not enough yet', the tenth shows the number", async () => {
    await consults(c, 9, 7);
    expect((await loadMyPace(db, c.actor, "today", NOW)).consultation!.own).toEqual({ enough: false, meanMin: null, medianMin: null, n: 9 });
    await consults(c, 1, 7);
    expect((await loadMyPace(db, c.actor, "today", NOW)).consultation!.own).toEqual({ enough: true, meanMin: 7, medianMin: 7, n: 10 });
  });

  it("a department of two doctors yields no average, even with 500 visits", async () => {
    await consults(a, 250, 9); await consults(b, 250, 14);
    const r = await loadMyPace(db, a.actor, "today", NOW);
    expect(r.consultation!.own).toMatchObject({ enough: true, meanMin: 9, n: 250 });
    expect(r.consultation!.department).toEqual({ enough: false, meanMin: null, medianMin: null });
    // And the hospital is those same two people: withheld as well.
    expect(r.consultation!.all).toEqual({ enough: false, meanMin: null, medianMin: null });
  });

  it("three people are not enough without thirty items between them", async () => {
    await consults(c, 10, 5); await consults(d, 10, 5); await consults(e, 9, 5);
    expect((await loadMyPace(db, c.actor, "today", NOW)).consultation!.department).toEqual({ enough: false, meanMin: null, medianMin: null });
    await consults(e, 1, 5);
    expect((await loadMyPace(db, c.actor, "today", NOW)).consultation!.department).toEqual({ enough: true, meanMin: 5, medianMin: 5 });
  });

  it("the caller is inside their own department's and the hospital's average", async () => {
    await consults(c, 10, 10); await consults(d, 10, 20); await consults(e, 10, 30);
    await consults(a, 10, 40); // another department: in the hospital, not in Paediatrics
    const r = await loadMyPace(db, c.actor, "today", NOW);
    expect(r.consultation!.own.meanMin).toBe(10);
    expect(r.consultation!.department).toEqual({ enough: true, meanMin: 20, medianMin: 20 }); // 15 if the caller were left out
    expect(r.consultation!.all).toEqual({ enough: true, meanMin: 25, medianMin: 25 });
    // Dr Anil's own department is himself alone: withheld. The hospital he may read.
    const med = await loadMyPace(db, a.actor, "today", NOW);
    expect(med.consultation!.department!.enough).toBe(false);
    expect(med.consultation!.all.meanMin).toBe(25);
  });

  it("the answer for one doctor holds nothing that names or measures another", async () => {
    await consults(c, 12, 10); await consults(d, 12, 23.7); await consults(e, 12, 31.3);
    const r = await loadMyPace(db, c.actor, "30d", NOW);
    const json = JSON.stringify(r);
    for (const other of [d, e, a, b]) {
      expect(json).not.toContain(other.doctorId);
      expect(json).not.toContain(other.userId);
    }
    for (const word of ["Deepa", "Esha", "Dr ", "drd", "dre", "23.7", "31.3", "userId", "doctorId", "name", "people", "count"]) expect(json).not.toContain(word);
    expect(json).not.toContain(c.doctorId); // not even the caller's own id: there is no id in the shape
    expect(Object.keys(r).sort()).toEqual(["consultation", "from", "period", "to", "vitals"]);
    expect(Object.keys(r.consultation!).sort()).toEqual(["all", "department", "excluded", "own"]);
    expect(Object.keys(r.consultation!.department!).sort()).toEqual(["enough", "meanMin", "medianMin"]);
    expect(Object.keys(r.consultation!.all).sort()).toEqual(["enough", "meanMin", "medianMin"]);
    expect(Object.keys(r.consultation!.own).sort()).toEqual(["enough", "meanMin", "medianMin", "n"]);
  });

  it("today, 7 days and 30 days read IST days ending today", async () => {
    await consults(c, 10, 6);
    await consults(c, 10, 12, {}, addDays(TODAY, -6));
    await consults(c, 10, 18, {}, addDays(TODAY, -29));
    await consults(c, 10, 60, {}, addDays(TODAY, -30)); // outside every period
    const own = async (p: "today" | "7d" | "30d") => (await loadMyPace(db, c.actor, p, NOW)).consultation!.own;
    expect(await own("today")).toMatchObject({ n: 10, meanMin: 6 });
    expect(await own("7d")).toMatchObject({ n: 20, meanMin: 9 });
    expect(await own("30d")).toMatchObject({ n: 30, meanMin: 12 });
  });

  it("a desk user is answered with nothing; so is an agent", async () => {
    await consults(c, 12, 10);
    expect(await loadMyPace(db, clerk.actor, "30d", NOW)).toEqual({ period: "30d", from: "2026-05-17", to: TODAY, consultation: null, vitals: null });
    expect(await loadMyPace(db, { type: "agent", id: "agent_x" } as never, "30d", NOW)).toMatchObject({ consultation: null, vitals: null });
  });

  it("the vitals bay has no measure: the in-hand moment is not stored, and none is made up from the saves", async () => {
    const [enc] = await consults(c, 1, 10);
    await db.insert(opdVitals).values(Array.from({ length: 12 }, (_, i) => ({
      id: newId(), encounterId: enc!, patientId, pulse: 80, recordedBy: nurse.id, recordedAt: new Date(NOW.getTime() - i * 4 * 60_000),
    })));
    expect(await loadMyPace(db, nurse.actor, "today", NOW)).toMatchObject({ consultation: null, vitals: null });
  });
});
