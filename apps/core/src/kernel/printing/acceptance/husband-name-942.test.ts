import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../../test/helpers/opd";
import { openVisit } from "../../../modules/opd/encounters";
import { renderPrescriptionSheet } from "../render";
import { patientGuardians, patients } from "../../db/schema";
import type { Db } from "../../db/client";

/**
 * ACCEPTANCE — issue #942, spec docs/specs/942-spouse-husband-name.md (owner APPROVED 2026-10-22):
 * a woman whose spouse is on file prints "Husband Name: <name>" in the Guardian Name row of the
 * prescription header. Spouse wins over a newer father link; a man's wife and a woman's father keep
 * today's Guardian Name row; a sealed patient's label never says a husband exists.
 */
const MON = new Date("2026-08-17T04:00:00.000Z");
const row = (label: string, value: string): string =>
  `<div class="c-guard"><div class="row"><span class="lb">${label}</span><span class="vl">${value}</span></div></div>`;

describe("#942 — Husband Name on a woman's prescription", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let encounterId: string;
  let patientId: string;

  const link = (over: { name: string; relationship: string; status?: string; validTo?: Date | null; createdAt: string }): Promise<unknown> =>
    db.insert(patientGuardians).values({
      id: newId(), patientId, name: over.name, relationship: over.relationship, status: over.status ?? "active",
      validTo: over.validTo ?? null, createdAt: new Date(over.createdAt), createdBy: "test-clerk",
    });
  const html = async (): Promise<string> => (await renderPrescriptionSheet(db, { encounterId }, MON))!.html;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const { deptId, roomId } = await seedOpdMasters(db);
    const clerk = await mkUser(db, "husband-clerk", ["front_office"]);
    const doctor = await mkDoctor(db, { username: "dr-husband", departmentId: deptId, roomId, displayName: "Dr Test", code: "DR-0942" });
    const patient = await mkPatient(db, clerk.actor, { name: "Sunita Devi", sex: "female", ageYears: 31 });
    patientId = patient.id;
    encounterId = (await openVisit(db, clerk.actor, { patientId, departmentId: deptId, doctorId: doctor.doctorId }, MON)).encounter.id;
  });

  it("spec #942 D2: a woman with a standing spouse link prints Husband Name and the bare name, no W/o", async () => {
    await link({ name: "Ramesh Kumar", relationship: "spouse", createdAt: "2026-01-01T00:00:00.000Z" });
    const h = await html();
    expect(h).toContain(row("Husband Name:", "Ramesh Kumar"));
    expect(h).not.toContain("Guardian Name:");
    expect(h).not.toContain("W/o");
  });

  it("spec #942 D3: a newer father link does not hide the husband", async () => {
    await link({ name: "Ramesh Kumar", relationship: "spouse", createdAt: "2026-01-01T00:00:00.000Z" });
    await link({ name: "Mohan Lal", relationship: "father", createdAt: "2026-03-01T00:00:00.000Z" });
    const h = await html();
    expect(h).toContain(row("Husband Name:", "Ramesh Kumar"));
    expect(h).not.toContain("Mohan Lal");
  });

  it("spec #942 D4: a man's wife stays C/o, a woman's father stays D/o, under Guardian Name", async () => {
    await link({ name: "Mohan Lal", relationship: "father", createdAt: "2026-01-01T00:00:00.000Z" });
    expect(await html()).toContain(row("Guardian Name:", "D/o Mohan Lal"));
    await db.delete(patientGuardians).where(eq(patientGuardians.patientId, patientId));
    await db.update(patients).set({ administrativeGender: "male" }).where(eq(patients.id, patientId));
    await link({ name: "Sunita Devi", relationship: "spouse", createdAt: "2026-01-01T00:00:00.000Z" });
    const h = await html();
    expect(h).toContain(row("Guardian Name:", "C/o Sunita Devi"));
    expect(h).not.toContain("Husband Name:");
  });

  it("spec #942 D5: a sealed woman's row is Guardian Name with a blank value", async () => {
    await link({ name: "Ramesh Kumar", relationship: "spouse", createdAt: "2026-01-01T00:00:00.000Z" });
    await db.update(patients).set({ isConfidential: true }).where(eq(patients.id, patientId));
    const h = await html();
    expect(h).toContain(row("Guardian Name:", ""));
    expect(h).not.toContain("Husband Name:");
    expect(h).not.toContain("Ramesh Kumar");
  });

  it("spec #942 D6: an ended or expired spouse link is not the husband; today's rules apply", async () => {
    await link({ name: "Ended Spouse", relationship: "spouse", status: "ended", createdAt: "2026-03-01T00:00:00.000Z" });
    await link({ name: "Expired Spouse", relationship: "spouse", validTo: new Date("2026-02-01T00:00:00.000Z"), createdAt: "2026-02-01T00:00:00.000Z" });
    await link({ name: "Mohan Lal", relationship: "father", createdAt: "2026-01-01T00:00:00.000Z" });
    const h = await html();
    expect(h).toContain(row("Guardian Name:", "D/o Mohan Lal"));
    expect(h).not.toContain("Husband Name:");
    expect(h).not.toContain("Spouse");
  });
});
