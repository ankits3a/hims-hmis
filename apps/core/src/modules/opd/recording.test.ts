import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../kernel/modules/manifests";
import { opdDepartments, opdEncounters, opdPrescriptions, patientDocuments } from "../../kernel/db/schema";
import { loadRecording } from "./recording";
import { rangeFor } from "./report";
import type { Db } from "../../kernel/db/client";

/**
 * "IS TODAY BEING RECORDED?" — owner 2026-10-07. The definitions are the feature: a consultation with a
 * photographed slip, a typed paper or an issued prescription is on record; one with none of them is the
 * number the owner asked to see. And a count that names a doctor is not handed to a desk.
 */
const DAY = "2026-10-05"; // Monday
const TUE = "2026-10-06";

describe("OPD recording count", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  for (const m of ALL_MANIFESTS) registry.install(m);
  let deptId: string; let dept2Id: string; let labId: string;
  let dra: Awaited<ReturnType<typeof mkDoctor>>; let drp: Awaited<ReturnType<typeof mkDoctor>>;
  let clerk: Awaited<ReturnType<typeof mkUser>>; let slip: Awaited<ReturnType<typeof mkUser>>;
  let owner: Awaited<ReturnType<typeof mkUser>>; let nobody: Awaited<ReturnType<typeof mkUser>>;
  let phone = 9100000000; let seq = 0;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  const visit = async (over: Partial<typeof opdEncounters.$inferInsert> & { departmentId: string; doctorId: string }, serviceDate = DAY): Promise<string> => {
    phone += 1; seq += 1;
    const p = await mkPatient(db, clerk.actor, { name: `P${seq}`, phone: String(phone) });
    const id = newId();
    const status = over.status ?? "completed";
    await db.insert(opdEncounters).values({
      id, visitNo: `V${String(seq).padStart(10, "0")}`, patientId: p.id, workflowInstanceId: newId(), serviceDate,
      visitType: "new", status, consultCompletedAt: status === "completed" ? new Date(`${serviceDate}T05:00:00Z`) : null,
      openedBy: clerk.id, updatedBy: clerk.id, ...over,
    });
    return id;
  };
  const patientOf = async (encounterId: string): Promise<string> =>
    (await db.select({ id: opdEncounters.id, p: opdEncounters.patientId }).from(opdEncounters)).find((e) => e.id === encounterId)!.p;
  const photo = async (encounterId: string, kind = "consult_prescription"): Promise<void> => {
    await db.insert(patientDocuments).values({
      id: newId(), patientId: await patientOf(encounterId), encounterId, kind, mimeType: "image/jpeg", byteSize: 10,
      storageKey: newId(), sha256: "0".repeat(64), capturedBy: slip.id,
    });
  };
  const rx = async (encounterId: string, doctorId: string, lines: number, transcribedBy: string | null): Promise<void> => {
    await db.insert(opdPrescriptions).values({
      id: newId(), encounterId, patientId: await patientOf(encounterId), doctorId, version: 1,
      lines: Array.from({ length: lines }, (_, i) => ({ name: `Drug ${i}` })), document: {}, allergyOverrides: [],
      transcribedBy, issuedBy: transcribedBy ?? dra.userId,
    });
  };

  beforeEach(async () => {
    await truncateAll(db);
    await syncPermissions(db, registry);
    await seedOpdBase(db);
    const m = await seedOpdMasters(db);
    deptId = m.deptId; dept2Id = m.dept2Id;
    labId = newId();
    await db.insert(opdDepartments).values({ id: labId, code: "LAB", name: "Laboratory", createdBy: "t", updatedBy: "t" });
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId: m.roomId, displayName: "Dr Anil" });
    drp = await mkDoctor(db, { username: "drp", departmentId: dept2Id, roomId: m.room2Id, displayName: "Dr Priya" });
    for (const [role, perms] of [["rc_clerk", ["opd.visits.open"]], ["rc_slip", ["opd.consult.paper"]], ["rc_owner", ["opd.reports.read", "staff.reports.read"]]] as const) {
      await ensureRole(db, role);
      for (const p of perms) await grantPermissionToRole(db, registry, role, p);
    }
    clerk = await mkUser(db, "clerk", ["rc_clerk"]);
    slip = await mkUser(db, "slip", ["rc_slip"]);
    owner = await mkUser(db, "owner1", ["rc_owner"]);
    nobody = await mkUser(db, "nobody", []);

    // Dr Anil, Monday: issued on screen (2 lines) · paper + photo, not typed · paper + photo + typed ·
    // completed with nothing on record · still waiting · left unseen.
    const a1 = await visit({ departmentId: deptId, doctorId: dra.doctorId }); await rx(a1, dra.doctorId, 2, null);
    const a2 = await visit({ departmentId: deptId, doctorId: dra.doctorId, completedVia: "paper" }); await photo(a2);
    const a3 = await visit({ departmentId: deptId, doctorId: dra.doctorId, completedVia: "paper" }); await photo(a3); await rx(a3, dra.doctorId, 3, slip.id);
    await visit({ departmentId: deptId, doctorId: dra.doctorId });
    await visit({ departmentId: deptId, doctorId: dra.doctorId, status: "waiting" });
    await visit({ departmentId: deptId, doctorId: dra.doctorId, status: "abandoned", abandonedAt: new Date(`${DAY}T06:00:00Z`), abandonReason: "left" });
    // Dr Priya, Monday: one consult, only an OUTSIDE report photographed — that is no record of her prescription.
    const b1 = await visit({ departmentId: dept2Id, doctorId: drp.doctorId }); await photo(b1, "outside_report");
    // A wrong-department correction: the abandoned half is counted nowhere.
    await visit({ departmentId: dept2Id, doctorId: drp.doctorId, status: "abandoned", abandonedAt: new Date(`${DAY}T06:10:00Z`), abandonReason: "wrong department — fever" });
    // The laboratory's walk-in is no consultation.
    await visit({ departmentId: labId, doctorId: dra.doctorId });
    // Tuesday: one more for Dr Anil, issued.
    const t1 = await visit({ departmentId: deptId, doctorId: dra.doctorId }, TUE); await rx(t1, dra.doctorId, 1, null);
  });

  it("counts the day: what is on record, what waits to be typed, and what is on no record at all", async () => {
    const r = await loadRecording(db, owner.actor, rangeFor("day", DAY));
    expect(r.scope).toBe("hospital");
    expect(r.totals).toEqual({
      opened: 7, consulted: 5, onScreen: 3, onPaper: 2, photographed: 2, typed: 1, issued: 1, issuedLines: 2,
      toType: 1, notRecorded: 2, stillOpen: 1,
    });
    expect(r.days).toEqual([]);
  });

  it("a moved visit is counted once and the laboratory not at all", async () => {
    const r = await loadRecording(db, owner.actor, rangeFor("day", DAY));
    const paeds = r.departments!.find((d) => d.id === dept2Id)!;
    expect(paeds).toMatchObject({ opened: 1, consulted: 1, notRecorded: 1 });
    expect(r.departments!.some((d) => d.id === labId)).toBe(false);
  });

  it("names each doctor only for a reader who holds the staff figures, worst-recorded first", async () => {
    const r = await loadRecording(db, owner.actor, rangeFor("day", DAY));
    expect(r.doctors!.map((d) => [d.name, d.consulted, d.issued, d.photographed, d.typed, d.notRecorded])).toEqual([
      ["Dr Anil", 4, 1, 2, 1, 1], ["Dr Priya", 1, 0, 0, 0, 1],
    ]);
    for (const desk of [clerk, slip]) {
      const d = await loadRecording(db, desk.actor, rangeFor("day", DAY));
      expect(d.scope).toBe("hospital");
      expect(d.totals!.notRecorded).toBe(2);
      expect(d.doctors).toBeNull();
      expect(JSON.stringify(d)).not.toContain("Dr Anil");
    }
  });

  it("a doctor sees only their own visits", async () => {
    const r = await loadRecording(db, drp.actor, rangeFor("day", DAY));
    expect(r.scope).toBe("mine");
    expect(r.totals).toMatchObject({ opened: 1, consulted: 1, notRecorded: 1 });
    expect(r.mine).toEqual(r.totals);
    expect(r.departments).toBeNull();
    expect(r.doctors).toBeNull();
  });

  it("a login with no part in it sees nothing", async () => {
    const r = await loadRecording(db, nobody.actor, rangeFor("day", DAY));
    expect(r).toMatchObject({ scope: "none", totals: null, mine: null, departments: null, doctors: null });
  });

  it("a week is one row per day", async () => {
    const r = await loadRecording(db, owner.actor, rangeFor("week", TUE));
    expect(r.days.map((d) => [d.date, d.consulted, d.notRecorded])).toEqual([[DAY, 5, 2], [TUE, 1, 0]]);
    expect(r.totals).toMatchObject({ consulted: 6, issued: 2, issuedLines: 3 });
  });
});
