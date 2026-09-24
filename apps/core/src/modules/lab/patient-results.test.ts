import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { grantLabResultPermissions, runLabOrder, seedLabDeskBase } from "../../../test/helpers/lab";
import { mkUser } from "../../../test/helpers/opd";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { labAnalytes, labResults, orderItems, phiAccessLog } from "../../kernel/db/schema";
import { patientResultsForDoctor } from "./patient-results";
import { amendResult } from "./results";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * CONSULT V2 — the doctor's brief reads the patient's SIGNED lab values (`patientResultsForDoctor`).
 * Every row is built through the lab's real writers (`runLabOrder`); the only hand-written row is
 * the `restricted` flag, see that test.
 */
const AT = new Date("2026-08-30T06:00:00Z");
const LATER = new Date(AT.getTime() + 3600_000);
const READ_AT = new Date(AT.getTime() + 2 * 3600_000);

describe("patientResultsForDoctor — the brief's lab values", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;
  /** A doctor who did NOT order anything here and holds no restricted-read grant. */
  let otherDoctor: { id: string; actor: Actor };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedLabDeskBase(db);
    await grantLabResultPermissions(db, fx);
    otherDoctor = await mkUser(db, "dr.other", ["doctor"]);
  });
  afterEach(() => { fx.unregister(); });

  const analyteId = async (code: string) =>
    (await db.select({ id: labAnalytes.id }).from(labAnalytes).where(eq(labAnalytes.code, code)))[0]!.id;

  it("returns verified values newest first, with the brief's fields; another patient's are not here", async () => {
    await runLabOrder(db, fx, ["TSH"], { at: AT, values: { TSH: "2.5" } });
    await runLabOrder(db, fx, ["GLUF"], { at: LATER, encounterNo: fx.newVisit() });

    const rows = await patientResultsForDoctor(db, otherDoctor.actor, fx.patientId, READ_AT);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0]!.verifiedAt).toBe(LATER.toISOString());
    expect(rows[rows.length - 1]!.verifiedAt).toBe(AT.toISOString());
    const tsh = rows.find((r) => r.verifiedAt === AT.toISOString())!;
    expect(tsh.value).toBe("2.5000");
    expect(Object.keys(tsh).sort()).toEqual(["analyteName", "flag", "orderableName", "unit", "value", "verifiedAt"]);
    expect(tsh.analyteName).toMatch(/TSH|thyroid/i);

    expect(await patientResultsForDoctor(db, otherDoctor.actor, fx.otherPatientId, READ_AT)).toEqual([]);
  });

  it("an unverified value is held back, and a superseded one is replaced by its amendment", async () => {
    await runLabOrder(db, fx, ["TSH"], { at: AT, values: { TSH: "2.5" } });
    await runLabOrder(db, fx, ["GLUF"], { at: AT, verify: false, encounterNo: fx.newVisit() });

    const before = await patientResultsForDoctor(db, otherDoctor.actor, fx.patientId, READ_AT);
    expect(before.map((r) => r.value)).toEqual(["2.5000"]);

    const [prior] = await db.select().from(labResults).where(eq(labResults.analyteId, await analyteId("TSH")));
    await amendResult(db, fx.pathologist.actor, { resultId: prior!.id, value: "9.9" }, LATER);

    const after = await patientResultsForDoctor(db, otherDoctor.actor, fx.patientId, READ_AT);
    expect(after.map((r) => r.value)).toEqual(["9.9000"]);
  });

  it("a restricted test is omitted for an unrelated doctor, shown to its ordering clinician and to a restricted-read holder", async () => {
    const run = await runLabOrder(db, fx, ["TSH"], { at: AT });
    /**
     * The flag is written directly: making a test restricted through placement needs a catalogue
     * row configured for it, and this reader only reads the column. Everything else is real.
     */
    await db.update(orderItems).set({ restricted: true }).where(eq(orderItems.id, run.itemIds[0]!));

    expect(await patientResultsForDoctor(db, otherDoctor.actor, fx.patientId, READ_AT)).toEqual([]);
    expect(await patientResultsForDoctor(db, fx.pathologist.actor, fx.patientId, READ_AT)).toHaveLength(1);

    const holder = await mkUser(db, "dr.restricted", ["restricted_reader"]);
    await grantPermissionToRole(db, fx.registry, "restricted_reader", "orders.read.restricted");
    expect(await patientResultsForDoctor(db, holder.actor, fx.patientId, READ_AT)).toHaveLength(1);
  });

  it("writes one PHI access row under lab.patient_results", async () => {
    await runLabOrder(db, fx, ["TSH"], { at: AT });
    await patientResultsForDoctor(db, otherDoctor.actor, fx.patientId, READ_AT);
    const logged = await db.select().from(phiAccessLog).where(and(
      eq(phiAccessLog.surface, "lab.patient_results"), eq(phiAccessLog.actorId, otherDoctor.id),
    ));
    expect(logged).toHaveLength(1);
    expect(logged[0]!.patientId).toBe(fx.patientId);
  });

  it("an unknown patient is refused as unknown_patient", async () => {
    await expect(patientResultsForDoctor(db, otherDoctor.actor, newId(), READ_AT))
      .rejects.toMatchObject({ code: "unknown_patient" });
  });
});
