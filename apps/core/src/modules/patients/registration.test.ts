import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { events, patientGuardians, patients, registrationConfig } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { createUser } from "../../kernel/auth/identity";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { patientsManifest } from "./manifest";
import { getPatient, getPatientSummaries, listMergedLoserIds, registerPatient, resolvePatientId, updatePatient } from "./registration";
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

  // Plan 10 T6 · verify-by-execution flag ⑤ — registration persists promotionalOptIn; a PATCH
  // marking (and clearing) deceased lands in patient.updated.changes.
  it("persists promotionalOptIn on registration, and PATCH diffs deceasedAt into patient.updated on mark and clear (flag ⑤)", async () => {
    const { patient } = await withTx(db, (tx) =>
      registerPatient(tx, clerk, { ...baseInput, promotionalOptIn: true }),
    );
    expect(patient.promotionalOptIn).toBe(true);
    expect(patient.deceasedAt).toBeNull();

    const markedAt = "2026-08-20T10:15:00.000Z";
    const marked = await withTx(db, (tx) => updatePatient(tx, clerk, patient.id, { deceasedAt: markedAt }));
    expect(marked.changed).toEqual(["deceasedAt"]);
    expect(marked.patient.deceasedAt?.toISOString()).toBe(markedAt);

    const afterMark = await db.select().from(events).where(eq(events.name, "patient.updated"));
    expect(afterMark).toHaveLength(1);
    const markPayload = afterMark[0]!.payload as { changes: { field: string; from: string | null; to: string | null }[] };
    expect(markPayload.changes).toEqual([{ field: "deceasedAt", from: null, to: markedAt }]);

    const cleared = await withTx(db, (tx) => updatePatient(tx, clerk, patient.id, { deceasedAt: null }));
    expect(cleared.changed).toEqual(["deceasedAt"]);
    expect(cleared.patient.deceasedAt).toBeNull();

    const afterClear = await db.select().from(events).where(eq(events.name, "patient.updated"));
    expect(afterClear).toHaveLength(2);
    const clearPayload = afterClear[1]!.payload as { changes: { field: string; from: string | null; to: string | null }[] };
    expect(clearPayload.changes).toEqual([{ field: "deceasedAt", from: markedAt, to: null }]);
  });

  it("promotionalOptIn defaults false when omitted at registration, and updatePatient leaves it untouched when the patch key is absent", async () => {
    const { patient } = await withTx(db, (tx) => registerPatient(tx, clerk, baseInput));
    expect(patient.promotionalOptIn).toBe(false);

    const { patient: optedIn } = await withTx(db, (tx) =>
      registerPatient(tx, clerk, { ...baseInput, phone: "9876500099", promotionalOptIn: true }),
    );
    const { changed, patient: afterUnrelatedPatch } = await withTx(db, (tx) =>
      updatePatient(tx, clerk, optedIn.id, { language: "en" }),
    );
    expect(changed).toEqual(["language"]);
    expect(afterUnrelatedPatch.promotionalOptIn).toBe(true); // an unrelated field patch must never revert consent
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

describe("Plan 07 read helpers: summaries + merged losers", () => {
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

  it("getPatientSummaries: a confidential row returns alias + restricted for a clerk without the permission, the name with it; uhid/sex/dob always", async () => {
    const { patient: plain } = await withTx(db, (tx) => registerPatient(tx, clerk, { ...baseInput }));
    const { patient: vip } = await withTx(db, (tx) => registerPatient(tx, clerk, { ...baseInput, name: "VIP Person", phone: "9876500001", isConfidential: true, alias: "Patient A", ageYears: 40 }));
    const before = await getPatientSummaries(db, clerk, [vip.id, plain.id]);
    expect(before.find((s) => s.id === vip.id)).toEqual({ requestedId: vip.id, id: vip.id, uhid: vip.uhid, name: null, alias: "Patient A", restricted: true, sex: "female", dob: vip.dob });
    expect(before.find((s) => s.id === plain.id)).toMatchObject({ name: "Asha Devi", alias: null, restricted: false });
    // grant the permission → the name appears (patientsManifest + registry are already imported by this file)
    const registry = new ModuleRegistry(); registry.install(patientsManifest);
    await syncPermissions(db, registry);
    await createRole(db, "vip_reader", "VIP reader");
    await grantPermissionToRole(db, registry, "vip_reader", "patients.confidential.read");
    const { id: readerId } = await createUser(db, { username: "reader", fullName: "reader", password: "p1234567" });
    await assignRole(db, { userId: readerId, roleKey: "vip_reader", scopeType: "hospital" });
    const after = await getPatientSummaries(db, { type: "user", id: readerId }, [vip.id]);
    expect(after[0]).toMatchObject({ name: "VIP Person", alias: null, restricted: false });
    // system actors always see; agents never do
    expect((await getPatientSummaries(db, { type: "system", id: "s" }, [vip.id]))[0]!.restricted).toBe(false);
    expect((await getPatientSummaries(db, { type: "agent", id: "a" }, [vip.id]))[0]!.restricted).toBe(true);
  });

  it("getPatientSummaries resolves a merged loser id to the winner (requestedId kept); listMergedLoserIds walks a two-hop chain", async () => {
    const { patient: w } = await withTx(db, (tx) => registerPatient(tx, clerk, { ...baseInput, phone: "9876500002" }));
    const { patient: l1 } = await withTx(db, (tx) => registerPatient(tx, clerk, { ...baseInput, phone: "9876500003" }));
    const { patient: l0 } = await withTx(db, (tx) => registerPatient(tx, clerk, { ...baseInput, phone: "9876500004" }));
    // The storage shape a merge produces (merge.ts executeMerge) — written directly: this is a read-helper test.
    await db.update(patients).set({ status: "merged", mergedIntoPatientId: w.id }).where(eq(patients.id, l1.id));
    await db.update(patients).set({ status: "merged", mergedIntoPatientId: l1.id }).where(eq(patients.id, l0.id));
    const s = await getPatientSummaries(db, clerk, [l0.id]);
    expect(s).toEqual([expect.objectContaining({ requestedId: l0.id, id: w.id, uhid: w.uhid })]);
    expect((await listMergedLoserIds(db, w.id)).sort()).toEqual([l0.id, l1.id].sort());
    expect(await listMergedLoserIds(db, l0.id)).toEqual([]);
  });

  it("getPatientSummaries dedupes ids and skips unknown ones", async () => {
    const { patient } = await withTx(db, (tx) => registerPatient(tx, clerk, { ...baseInput }));
    const s = await getPatientSummaries(db, clerk, [patient.id, patient.id, "01NOSUCH00000000000000000"]);
    expect(s).toHaveLength(1);
  });
});
