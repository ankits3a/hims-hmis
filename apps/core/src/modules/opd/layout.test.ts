import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters, testCfg,
} from "../../../test/helpers/opd";
import { opdConsultLayouts, opdDepartments, opdEncounters } from "../../kernel/db/schema";
import { openVisit } from "./encounters";
import { recordVitals } from "./vitals";
import { callNext } from "./queue";
import { startConsultation } from "./consultation";
import { OpdQueueController } from "./opd-queue.controller";
import {
  baseDefault, catalogFor, departmentLayout, describeChanges, diffDefault, myLayout, resolveLayout,
  saveDepartmentLayout, saveMyLayout, validateDefault, validateOverlay,
} from "./layout";
import type { DefaultBody, LayoutSection } from "./layout";
import type { Db } from "../../kernel/db/client";

/**
 * THE CONSULT LAYOUT BUILDER (board `Profiles`; 01-CONSULT-ENGINE.md §3, D1) — the department
 * default, the doctor's overlay within its bounds, append-only versions, and a visit that keeps the
 * versions it started under.
 */
const CAT = catalogFor(false);
const keys = (rows: { key: LayoutSection }[]): LayoutSection[] => rows.map((r) => r.key);
/** The base default with one section's row replaced. */
const withRow = (key: LayoutSection, patch: { shown?: boolean; mandatory?: boolean }): DefaultBody => ({
  sections: baseDefault(CAT).sections.map((r) => (r.key === key ? { ...r, ...patch } : r)),
});

describe("consult layout — the one validator and resolver", () => {
  it("the base layout is today's tab order; `eye` exists only where the department's profile has eye sections", () => {
    expect(keys(resolveLayout(null, null, CAT))).toEqual(["vitals", "complaints", "exam", "dx", "inv", "rx", "treat", "advice", "notes"]);
    expect(catalogFor(true)).toContain("eye");
    expect(catalogFor(false)).not.toContain("eye");
  });

  it("the locked five are always mandatory and shown — the admin cannot hide or relax them", () => {
    for (const k of ["complaints", "vitals", "exam", "dx", "rx"] as const) {
      expect(() => validateDefault(withRow(k, { shown: false, mandatory: false }), CAT)).toThrow(/always mandatory/);
      expect(() => validateDefault(withRow(k, { mandatory: false }), CAT)).toThrow(/always mandatory/);
    }
    // A stored row written without the lock cannot unlock it on read either.
    const stored = withRow("rx", { shown: false, mandatory: false });
    expect(resolveLayout(stored, null, CAT).find((s) => s.key === "rx")).toEqual({ key: "rx", mandatory: true });
    expect(() => validateDefault(withRow("advice", { shown: false, mandatory: true }), CAT)).toThrow(/must be shown/);
  });

  it("unknown keys and duplicates are refused, in both bodies", () => {
    expect(() => validateDefault({ sections: [...baseDefault(CAT).sections, { key: "summary", shown: true, mandatory: false }] }, CAT)).toThrow(/unknown section summary/);
    expect(() => validateDefault({ sections: [...baseDefault(CAT).sections, { key: "advice", shown: true, mandatory: false }] }, CAT)).toThrow(/appears twice/);
    expect(() => validateDefault({ sections: [{ key: "eye", shown: true, mandatory: false }] }, CAT)).toThrow(/unknown section eye/);
    const def = baseDefault(CAT);
    expect(() => validateOverlay({ order: ["rx", "bogus"], hidden: [] }, def, CAT)).toThrow(/unknown section bogus/);
    expect(() => validateOverlay({ order: ["rx", "rx"], hidden: [] }, def, CAT)).toThrow(/appears twice/);
    expect(() => validateOverlay({ order: [], hidden: ["notes", "notes"] }, def, CAT)).toThrow(/appears twice/);
  });

  it("a doctor cannot hide a mandatory section — a locked one, or one the admin made mandatory", () => {
    expect(() => validateOverlay({ order: [], hidden: ["rx"] }, baseDefault(CAT), CAT)).toThrow(/mandatory and cannot be hidden/);
    const adviceMandatory = validateDefault(withRow("advice", { mandatory: true }), CAT);
    expect(() => validateOverlay({ order: [], hidden: ["advice"] }, adviceMandatory, CAT)).toThrow(/mandatory and cannot be hidden/);
    // …but may hide one that is not.
    const ok = validateOverlay({ order: [], hidden: ["notes"] }, adviceMandatory, CAT);
    expect(keys(resolveLayout(adviceMandatory, ok, CAT))).not.toContain("notes");
    expect(resolveLayout(adviceMandatory, ok, CAT).find((s) => s.key === "advice")).toEqual({ key: "advice", mandatory: true });
  });

  it("a section the admin hid stays hidden: the doctor cannot name it, and a stale overlay naming it does not bring it back", () => {
    const def = validateDefault(withRow("treat", { shown: false }), CAT);
    expect(() => validateOverlay({ order: ["treat"], hidden: [] }, def, CAT)).toThrow(/hidden by the department layout/);
    const stale = { order: ["treat", "rx", "vitals"] as LayoutSection[], hidden: [] };
    expect(keys(resolveLayout(def, stale, CAT))).not.toContain("treat");
  });

  it("the doctor's order applies; a section the admin added later is appended in the admin's order", () => {
    const overlay = validateOverlay({ order: ["rx", "dx", "exam", "complaints", "vitals"], hidden: ["notes"] }, baseDefault(CAT), CAT);
    expect(keys(resolveLayout(null, overlay, CAT))).toEqual(["rx", "dx", "exam", "complaints", "vitals", "inv", "treat", "advice"]);
    // The overlay was saved before this department had an eye profile: its order never mentions `eye`.
    const eyeCat = catalogFor(true);
    const stale = { order: ["rx", "dx", "exam", "complaints", "vitals", "inv", "treat", "advice", "notes"] as LayoutSection[], hidden: [] };
    expect(keys(resolveLayout(null, stale, eyeCat))).toEqual(["rx", "dx", "exam", "complaints", "vitals", "inv", "treat", "advice", "notes", "eye"]);
  });

  it("the audit line is a diff of two versions, not stored prose", () => {
    const base = baseDefault(CAT);
    const v1 = validateDefault(withRow("exam", { mandatory: true }), CAT); // exam is locked: no change
    expect(diffDefault(base, v1)).toEqual([]);
    const v2 = validateDefault({ sections: [...withRow("notes", { mandatory: true }).sections] }, CAT);
    expect(describeChanges(diffDefault(base, v2))).toBe("Notes set to mandatory");
    const order = ["vitals", "complaints", "exam", "dx", "inv", "advice", "rx", "treat", "notes"] as const;
    const v3 = validateDefault({ sections: order.map((k) => ({ ...v2.sections.find((r) => r.key === k)! })) }, CAT);
    expect(describeChanges(diffDefault(v2, v3))).toBe("Advice moved above Rx");
    const v4 = validateDefault({ sections: v3.sections.map((r) => (r.key === "treat" ? { ...r, shown: false } : r)) }, CAT);
    expect(describeChanges(diffDefault(v3, v4))).toBe("Treatment hidden");
  });
});

const MON = new Date("2026-08-17T04:00:00.000Z");
const T1 = new Date("2026-08-17T04:05:00.000Z");
const T2 = new Date("2026-08-17T04:10:00.000Z");
const T3 = new Date("2026-08-17T04:20:00.000Z");
const adultOk = { heightCm: 172, weightKg: 70, sbp: 118, dbp: 76, pulse: 70, rr: 15, spo2: 99, tempC: 36.6 };

describe("consult layout — versions, audit, and the visit that keeps its own", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let admin: Awaited<ReturnType<typeof mkUser>>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let dr: Awaited<ReturnType<typeof mkDoctor>>;
  let deptId: string;
  let eyeDeptId: string;
  let patientId: string;
  let ctl: OpdQueueController;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const m = await seedOpdMasters(db);
    deptId = m.deptId;
    eyeDeptId = m.dept2Id;
    await db.update(opdDepartments).set({ code: "OPH", name: "Ophthalmology" }).where(eq(opdDepartments.id, eyeDeptId));
    dr = await mkDoctor(db, { username: "drl", departmentId: deptId, roomId: m.roomId });
    admin = await mkUser(db, "opdadmin", []);
    clerk = await mkUser(db, "clerk1", ["front_office_t"]);
    vd = await mkUser(db, "vitals1", ["vitals_desk"]);
    patientId = (await mkPatient(db, clerk.actor)).id;
    ctl = new OpdQueueController(db, testCfg as never);
  });

  const body = (d: DefaultBody): { sections: { key: string; shown: boolean; mandatory: boolean }[] } => ({ sections: d.sections });

  it("every save is a new version in its own scope; an unchanged body writes nothing", async () => {
    await saveDepartmentLayout(db, admin.actor, deptId, body(baseDefault(CAT)), MON); // == the base: nothing to record
    expect(await db.select().from(opdConsultLayouts)).toHaveLength(0);
    const v1 = await saveDepartmentLayout(db, admin.actor, deptId, body(withRow("notes", { shown: false })), T1);
    expect(v1.version).toBe(1);
    const again = await saveDepartmentLayout(db, admin.actor, deptId, body(withRow("notes", { shown: false })), T2);
    expect(again.version).toBe(1);
    const v2 = await saveDepartmentLayout(db, admin.actor, deptId, body(withRow("advice", { mandatory: true })), T2);
    expect(v2.version).toBe(2);
    // The doctor's overlay counts from 1 in its own scope, and so does another department's default.
    const mine = await saveMyLayout(db, dr.actor, { order: ["rx"], hidden: ["notes"] }, T2);
    expect(mine.version).toBe(1);
    expect((await saveMyLayout(db, dr.actor, { order: ["rx"], hidden: ["notes"] }, T3)).version).toBe(1);
    expect((await saveDepartmentLayout(db, admin.actor, eyeDeptId, body({ sections: [{ key: "eye", shown: false, mandatory: false }] }), T3)).version).toBe(1);
    expect(await db.select().from(opdConsultLayouts)).toHaveLength(4);
  });

  it("the audit is the rows, newest first, with who and the computed diff", async () => {
    await saveDepartmentLayout(db, admin.actor, deptId, body(withRow("notes", { mandatory: true })), T1);
    const order = ["vitals", "complaints", "exam", "dx", "inv", "advice", "rx", "treat", "notes"] as const;
    const cur = (await departmentLayout(db, deptId)).sections;
    await saveDepartmentLayout(db, admin.actor, deptId, { sections: order.map((k) => cur.find((r) => r.key === k)!) }, T2);
    const v = await departmentLayout(db, deptId);
    expect(v.version).toBe(2);
    expect(v.audit.map((a) => [a.version, a.by, a.summary])).toEqual([
      [2, admin.actor.id, "Advice moved above Rx"],
      [1, admin.actor.id, "Notes set to mandatory"],
    ]);
    expect(v.audit[0]!.byName).not.toBe("");
    await saveMyLayout(db, dr.actor, { order: [], hidden: ["treat"] }, T3);
    const mine = await myLayout(db, dr.actor);
    expect(mine.audit.map((a) => a.summary)).toEqual(["Treatment hidden"]);
    expect(mine.defaultVersion).toBe(2);
    expect(mine.sections.find((s) => s.key === "notes")).toEqual({ key: "notes", mandatory: true, hidden: false });
  });

  it("a visit keeps the layout it started under; a later admin change reaches only the next visit", async () => {
    await saveDepartmentLayout(db, admin.actor, deptId, body(withRow("notes", { shown: false })), MON);
    const [v1] = await db.select().from(opdConsultLayouts);

    const first = await openVisit(db, clerk.actor, { patientId, departmentId: deptId, doctorId: dr.doctorId }, MON);
    await recordVitals(db, vd.actor, first.encounter.id, adultOk, MON);
    await callNext(db, dr.actor, first.sessionId, MON);
    await startConsultation(db, dr.actor, first.encounter.id, T1);
    const [stamped] = await db.select().from(opdEncounters).where(eq(opdEncounters.id, first.encounter.id));
    expect(stamped!.layoutDefaultId).toBe(v1!.id);
    expect(stamped!.layoutOverlayId).toBeNull();

    // The admin now hides Advice as well, and the doctor moves Rx to the top of their own screen.
    await saveDepartmentLayout(db, admin.actor, deptId, body({ sections: withRow("notes", { shown: false }).sections.map((r) => (r.key === "advice" ? { ...r, shown: false } : r)) }), T2);
    await saveMyLayout(db, dr.actor, { order: ["rx"], hidden: [] }, T2);

    const old = await ctl.layout(dr.actor, first.encounter.id);
    expect(old.defaultVersion).toBe(1);
    expect(old.overlayVersion).toBeNull();
    expect(keys(old.sections)).toEqual(["vitals", "complaints", "exam", "dx", "inv", "rx", "treat", "advice"]);

    // The next visit — opened and started after the change — reads the new versions.
    const p2 = (await mkPatient(db, clerk.actor)).id;
    const second = await openVisit(db, clerk.actor, { patientId: p2, departmentId: deptId, doctorId: dr.doctorId }, T3);
    await recordVitals(db, vd.actor, second.encounter.id, adultOk, T3);
    await startConsultation(db, dr.actor, second.encounter.id, T3);
    const next = await ctl.layout(dr.actor, second.encounter.id);
    expect(next.defaultVersion).toBe(2);
    expect(next.overlayVersion).toBe(1);
    expect(keys(next.sections)).toEqual(["rx", "vitals", "complaints", "exam", "dx", "inv", "treat"]);
    // And the first visit still reads exactly as before.
    expect(await ctl.layout(dr.actor, first.encounter.id)).toEqual(old);
  });

  it("a doctor may not hide a mandatory section through the service, and the eye department's catalog has `eye`", async () => {
    await expect(saveMyLayout(db, dr.actor, { order: [], hidden: ["dx"] }, T1)).rejects.toMatchObject({ code: "invalid_layout" });
    await expect(saveMyLayout(db, admin.actor, { order: [], hidden: [] }, T1)).rejects.toMatchObject({ code: "not_a_doctor" });
    expect(keys((await departmentLayout(db, eyeDeptId)).sections)).toContain("eye");
    expect(keys((await departmentLayout(db, deptId)).sections)).not.toContain("eye");
    await expect(departmentLayout(db, "01NOSUCH00000000000000000")).rejects.toMatchObject({ code: "unknown_department" });
  });
});
