import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, openOpdVisit, seedOpdBase, seedOpdMasters, testCfg,
} from "../../../test/helpers/opd";
import { opdEncounters, patients } from "../../kernel/db/schema";
import { useBreakGlass } from "../../kernel/auth/break-glass";
import { withTx } from "../../kernel/db/client";
import { addAllergy } from "./allergies";
import { ageOnIstCalendar, patientProfile } from "./profile";
import type { Db } from "../../kernel/db/client";

/**
 * #657 — the profile's own read. Board: `docs/design/2026-09-29-patient-profile/`.
 *   · a readable record: the full row plus "patient since · N visits" (non-abandoned, merge chain);
 *   · a SEALED record the reader may not open: alias, UHID, age and allergies, and NOTHING else of
 *     the person (owner ruling 28-Sep-2026) — until the MS breaks the glass;
 *   · an agent credential is refused as before.
 */
const T0 = new Date("2026-08-17T04:00:00.000Z");

describe("#657 patientProfile", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let deptId: string;
  let doctorId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const m = await seedOpdMasters(db);
    deptId = m.deptId;
    clerk = await mkUser(db, "pf_clerk", ["front_office"]);
    ({ doctorId } = await mkDoctor(db, { username: "pf_dr", departmentId: deptId, roomId: m.roomId, weekdays: [0, 1, 2, 3, 4, 5, 6] }));
  });

  it("a readable record answers the full row with its visit count (abandoned visits not counted)", async () => {
    const p = await mkPatient(db, clerk.actor, { phone: "9899000101" });
    await openOpdVisit(db, { clerk: clerk.actor, patientId: p.id, departmentId: deptId, doctorId }, T0);
    const second = await openOpdVisit(db, { clerk: clerk.actor, patientId: p.id, departmentId: deptId, doctorId }, new Date(T0.getTime() + 86_400_000));
    const third = await openOpdVisit(db, { clerk: clerk.actor, patientId: p.id, departmentId: deptId, doctorId }, new Date(T0.getTime() + 2 * 86_400_000));
    await db.update(opdEncounters).set({ status: "abandoned" }).where(eq(opdEncounters.id, third.encounterId));

    const view = await patientProfile(db, clerk.actor, p.id, T0);
    expect(view?.view).toBe("full");
    if (view?.view !== "full") throw new Error("unreachable");
    expect(view.patient.phone).toBe("9899000101");
    expect(view.visits.count).toBe(2);
    const secondDay = (await db.select().from(opdEncounters).where(eq(opdEncounters.id, second.encounterId)))[0]!.serviceDate;
    expect(view.visits.lastVisitOn).toBe(secondDay);
    expect(view.breakGlass).toBeNull();
  });

  it("a SEALED record answers the alias-only shape to a reader without the grant — no name, mobile, address or DOB", async () => {
    const p = await mkPatient(db, clerk.actor, {
      name: "Real Legal Name", phone: "9899000102", isConfidential: true, alias: "R-2291",
      addressLine: "12 Hidden Lane", dob: new Date("1955-03-12T00:00:00Z"), ageYears: undefined, sex: "female",
    });
    await withTx(db, (tx) => addAllergy(tx, clerk.actor, p.id, { substance: "Penicillin", reaction: "anaphylaxis", severity: "severe", source: "registration" }));

    const view = await patientProfile(db, clerk.actor, p.id, T0);
    expect(view?.view).toBe("restricted");
    if (view?.view !== "restricted") throw new Error("unreachable");
    expect(view.patient).toEqual({
      id: p.id, uhid: p.uhid, alias: "R-2291", isConfidential: true, administrativeGender: expect.any(String),
      ageYears: 71, ageMonths: null, sensitiveContext: false, status: "active",
    });
    expect(view.allergies).toEqual([expect.objectContaining({ substance: "Penicillin", reaction: "anaphylaxis", severity: "severe" })]);
    const wire = JSON.stringify(view);
    for (const leak of ["Real Legal Name", "9899000102", "12 Hidden Lane", "1955-03-12"]) expect(wire).not.toContain(leak);
  });

  it("#849 — the restricted view carries the board's history rows: date and department only, newest first, abandoned left out", async () => {
    const p = await mkPatient(db, clerk.actor, { name: "Real Legal Name", isConfidential: true, alias: "R-2294", phone: "9899000103" });
    const a = await openOpdVisit(db, { clerk: clerk.actor, patientId: p.id, departmentId: deptId, doctorId }, T0);
    const b = await openOpdVisit(db, { clerk: clerk.actor, patientId: p.id, departmentId: deptId, doctorId }, new Date(T0.getTime() + 86_400_000));
    const c = await openOpdVisit(db, { clerk: clerk.actor, patientId: p.id, departmentId: deptId, doctorId }, new Date(T0.getTime() + 2 * 86_400_000));
    await db.update(opdEncounters).set({ status: "abandoned" }).where(eq(opdEncounters.id, c.encounterId));
    const day = async (id: string): Promise<string> => (await db.select().from(opdEncounters).where(eq(opdEncounters.id, id)))[0]!.serviceDate;

    const view = await patientProfile(db, clerk.actor, p.id, T0);
    if (view?.view !== "restricted") throw new Error("expected the restricted view");
    expect(view.history).toEqual([
      { serviceDate: await day(b.encounterId), departmentName: "General Medicine" },
      { serviceDate: await day(a.encounterId), departmentName: "General Medicine" },
    ]);
    const wire = JSON.stringify(view);
    for (const leak of ["Real Legal Name", "9899000103", "pf_dr", a.encounterId]) expect(wire).not.toContain(leak);
  });

  it("after the MS breaks the glass on that record, the same read answers the full row with the grant", async () => {
    const p = await mkPatient(db, clerk.actor, { name: "Real Legal Name", isConfidential: true, alias: "R-2292" });
    const ms = await mkUser(db, "pf_ms", ["medical_superintendent"]);
    expect((await patientProfile(db, ms.actor, p.id, T0))?.view).toBe("restricted");
    await useBreakGlass(db, testCfg, ms.actor, { patientId: p.id, reason: "night emergency" });
    const view = await patientProfile(db, ms.actor, p.id, T0);
    expect(view?.view).toBe("full");
    if (view?.view !== "full") throw new Error("unreachable");
    expect(view.patient.name).toBe("Real Legal Name");
    expect(view.breakGlass?.reason).toBe("night emergency");
  });

  it("an agent credential and an absent id are refused (null), never the alias view", async () => {
    const p = await mkPatient(db, clerk.actor, { isConfidential: true, alias: "R-2293" });
    expect(await patientProfile(db, { type: "agent", id: "relay-1" } as never, p.id, T0)).toBeNull();
    expect(await patientProfile(db, clerk.actor, "01NOSUCH00000000000000000", T0)).toBeNull();
    // and the row is untouched
    expect((await db.select().from(patients).where(eq(patients.id, p.id)))[0]!.isConfidential).toBe(true);
  });

  it("age is whole years on the IST calendar, months under one year", () => {
    expect(ageOnIstCalendar(new Date("1955-03-12T00:00:00Z"), new Date("2026-03-11T19:00:00Z"))).toEqual({ years: 71, months: null }); // 00:30 IST on the 12th
    expect(ageOnIstCalendar(new Date("1955-03-12T00:00:00Z"), new Date("2026-03-11T12:00:00Z"))).toEqual({ years: 70, months: null });
    expect(ageOnIstCalendar(new Date("2026-05-20T00:00:00Z"), new Date("2026-08-17T04:00:00Z"))).toEqual({ years: 0, months: 2 });
    expect(ageOnIstCalendar(null, T0)).toEqual({ years: null, months: null });
  });
});
