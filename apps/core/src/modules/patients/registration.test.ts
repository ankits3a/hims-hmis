import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { events, patientGuardians, patients, registrationConfig } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { createUser } from "../../kernel/auth/identity";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { patientsManifest } from "./manifest";
import { getPatient, registerPatient, resolvePatientId, updatePatient } from "./registration";
import { isValidUhid } from "./uhid";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

const clerk: Actor = { type: "user", id: "clerk-1" };

describe("registration service", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "test" });
  });

  const baseInput = { name: "Asha Devi", sex: "female" as const, phone: "9876543210" };

  it("registers a patient: UHID allocated, row inserted, patient.registered with full envelope", async () => {
    const { patient } = await withTx(db, (tx) => registerPatient(tx, clerk, baseInput));
    expect(isValidUhid(patient.uhid)).toBe(true);
    expect(patient.uhid.startsWith("HMS-")).toBe(true);
    expect(patient.language).toBe("hi");
    expect(patient.status).toBe("active");
    expect(patient.createdBy).toBe("clerk-1");

    const evs = await db.select().from(events).where(eq(events.name, "patient.registered"));
    expect(evs).toHaveLength(1);
    expect(evs[0]!.module).toBe("patients");
    expect(evs[0]!.patientId).toBe(patient.id);
    expect(evs[0]!.actorId).toBe("clerk-1");
    const payload = evs[0]!.payload as { uhid: string; name: string; phone: string | null; language: string };
    expect(payload.uhid).toBe(patient.uhid);
    expect(payload.name).toBe("Asha Devi");
    expect(payload.phone).toBe("9876543210");
  });

  it("refuses non-user actors", async () => {
    await expect(
      withTx(db, (tx) => registerPatient(tx, { type: "system", id: "sys" }, baseInput)),
    ).rejects.toMatchObject({ code: "user_actor_required" });
  });

  it("refuses dob AND ageYears together; converts a lone ageYears to an estimated dob", async () => {
    await expect(
      withTx(db, (tx) =>
        registerPatient(tx, clerk, { ...baseInput, dob: new Date(Date.UTC(1990, 0, 1)), ageYears: 30 }),
      ),
    ).rejects.toMatchObject({ code: "dob_or_age" });

    const { patient } = await withTx(db, (tx) =>
      registerPatient(tx, clerk, { ...baseInput, ageYears: 30 }),
    );
    expect(patient.dobEstimated).toBe(true);
    expect(patient.dob).not.toBeNull();
    const yearNow = new Date().getUTCFullYear();
    expect(patient.dob!.getUTCFullYear()).toBe(yearNow - 30);
  });

  it("requires an alias for confidential patients (§14)", async () => {
    await expect(
      withTx(db, (tx) => registerPatient(tx, clerk, { ...baseInput, isConfidential: true })),
    ).rejects.toMatchObject({ code: "alias_required" });
    const { patient } = await withTx(db, (tx) =>
      registerPatient(tx, clerk, { ...baseInput, isConfidential: true, alias: "Patient A" }),
    );
    expect(patient.alias).toBe("Patient A");
  });

  it("requires a guardian for a known minor (D-31 + DPDP §9) and links it atomically", async () => {
    const minorDob = new Date(Date.UTC(new Date().getUTCFullYear() - 10, 5, 1));
    await expect(
      withTx(db, (tx) => registerPatient(tx, clerk, { ...baseInput, dob: minorDob })),
    ).rejects.toMatchObject({ code: "minor_needs_guardian" });

    const { patient, guardianId } = await withTx(db, (tx) =>
      registerPatient(tx, clerk, {
        ...baseInput,
        dob: minorDob,
        guardian: { name: "Ram Prasad", relationship: "father", phone: "9812345678", consentNote: "DPDP consent at desk" },
      }),
    );
    expect(guardianId).not.toBeNull();
    const g = await db.select().from(patientGuardians).where(eq(patientGuardians.patientId, patient.id));
    expect(g).toHaveLength(1);
    expect(g[0]!.authorityMessages).toBe(true);

    const evs = await db.select().from(events).where(eq(events.name, "guardian.linked"));
    expect(evs).toHaveLength(1);
    expect(evs[0]!.patientId).toBe(patient.id);
    const payload = evs[0]!.payload as { authority: { messages: boolean; dsr: boolean } };
    expect(payload.authority.messages).toBe(true);
    expect(payload.authority.dsr).toBe(false);
  });

  it("updatePatient diffs, updates, and events — and a no-op patch emits nothing", async () => {
    const { patient } = await withTx(db, (tx) => registerPatient(tx, clerk, baseInput));
    const { changed } = await withTx(db, (tx) =>
      updatePatient(tx, clerk, patient.id, { phone: "9000000001", language: "en" }),
    );
    expect(changed.sort()).toEqual(["language", "phone"]);
    const evs = await db.select().from(events).where(eq(events.name, "patient.updated"));
    expect(evs).toHaveLength(1);
    const payload = evs[0]!.payload as { changes: { field: string; from: string | null; to: string | null }[] };
    const phoneChange = payload.changes.find((c) => c.field === "phone")!;
    expect(phoneChange.from).toBe("9876543210");
    expect(phoneChange.to).toBe("9000000001");

    const second = await withTx(db, (tx) => updatePatient(tx, clerk, patient.id, { phone: "9000000001" }));
    expect(second.changed).toEqual([]);
    expect(await db.select().from(events).where(eq(events.name, "patient.updated"))).toHaveLength(1);
  });

  it("updatePatient refuses a merged (frozen) row with patient_not_active", async () => {
    const { patient } = await withTx(db, (tx) => registerPatient(tx, clerk, baseInput));
    await db.update(patients).set({ status: "merged", mergedIntoPatientId: "01WINNER00000000000000001" }).where(eq(patients.id, patient.id));
    await expect(
      withTx(db, (tx) => updatePatient(tx, clerk, patient.id, { name: "New Name" })),
    ).rejects.toMatchObject({ code: "patient_not_active" });
  });

  it("getPatient resolves the merged_into chain and reports resolvedFrom", async () => {
    const a = (await withTx(db, (tx) => registerPatient(tx, clerk, baseInput))).patient;
    const b = (await withTx(db, (tx) => registerPatient(tx, clerk, { ...baseInput, name: "Asha D" }))).patient;
    await db.update(patients).set({ status: "merged", mergedIntoPatientId: b.id }).where(eq(patients.id, a.id));

    const viaLoser = await getPatient(db, clerk, a.id);
    expect(viaLoser!.patient.id).toBe(b.id);
    expect(viaLoser!.resolvedFrom).toBe(a.id);
    const direct = await getPatient(db, clerk, b.id);
    expect(direct!.resolvedFrom).toBeNull();
    expect(await resolvePatientId(db, a.id)).toBe(b.id);
    expect(await resolvePatientId(db, "01NOSUCH00000000000000000")).toBeNull();
  });

  it("hides confidential patients from users without the permission, shows them with it, passes system actors, blocks agents", async () => {
    const registry = new ModuleRegistry();
    registry.install(patientsManifest);
    await syncPermissions(db, registry);
    await createRole(db, "vip_desk", "VIP Desk");
    await grantPermissionToRole(db, registry, "vip_desk", "patients.confidential.read");
    const holder = await createUser(db, { username: "holder", fullName: "Holder", password: "p1234567" });
    const plain = await createUser(db, { username: "plain", fullName: "Plain", password: "p1234567" });
    await assignRole(db, { userId: holder.id, roleKey: "vip_desk", scopeType: "hospital" });

    const { patient } = await withTx(db, (tx) =>
      registerPatient(tx, clerk, { ...baseInput, isConfidential: true, alias: "Patient A" }),
    );
    expect(await getPatient(db, { type: "user", id: plain.id }, patient.id)).toBeNull();
    expect((await getPatient(db, { type: "user", id: holder.id }, patient.id))!.patient.id).toBe(patient.id);
    expect((await getPatient(db, { type: "system", id: "sys" }, patient.id))!.patient.id).toBe(patient.id);
    expect(await getPatient(db, { type: "agent", id: "agent-1" }, patient.id)).toBeNull();
  });
});
