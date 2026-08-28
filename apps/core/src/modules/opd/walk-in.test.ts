import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters,
} from "../../../test/helpers/opd";
import { patients } from "../../kernel/db/schema";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { walkIn } from "./walk-in";
import { OpdError } from "./errors";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 07b T6 — THE WALK-IN AS ONE ACT.
 *
 * Two of the seven calls a walk-in used to cost carried real DATA defects rather than merely being
 * slow: `registerPatient` had no idempotency at all (a duplicated request minted a second UHID) and
 * no duplicate check (it allocated a UHID and inserted, unconditionally). A duplicate UHID is a
 * split medical record, so both are patient-safety problems wearing a performance problem's clothes.
 */
const T0 = new Date("2026-08-17T04:00:00.000Z"); // Monday 09:30 IST

describe("walk-in (07b T6)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let deptId: string;
  let roomId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    ({ deptId, roomId } = await seedOpdMasters(db));
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId });
    clerk = await mkUser(db, "clerk1", ["front_office_t"]);
    // The walk-in asserts `patients.register` itself (the guard writes one metadata key and cannot
    // carry two), so the counter role must actually hold it — through the kernel's registry-checked
    // path, never a raw row.
    const registry = new ModuleRegistry();
    registry.install({
      key: "patients", title: "Patients", menu: [], permissions: ["patients.register"], subscriptions: [],
    });
    await syncPermissions(db, registry);
    await grantPermissionToRole(db, registry, "front_office_t", "patients.register");
  });

  const NEW_PATIENT = { name: "Ramesh Kale", sex: "male" as const, phone: "9876540002", ageYears: 44 };
  const base = { departmentId: "", doctorId: "" };
  const walk = (over: Record<string, unknown> = {}, key?: string) =>
    walkIn(db, clerk.actor, {
      ...base, departmentId: deptId, doctorId: dra.doctorId,
      patient: { register: NEW_PATIENT }, ...over,
    } as never, key, T0);

  const patientCount = async (): Promise<number> => (await db.select().from(patients)).length;

  it("registers and opens a visit in one call", async () => {
    const res = await walk();
    expect(res.registered).toBe(true);
    expect(res.tokenNo).toBeGreaterThan(0);
    expect(res.encounter.patientId).toBe(res.patientId);
    expect(await patientCount()).toBe(1);
  });

  /**
   * A1 — THE ATOMIC PAIR. An unknown doctor fails inside `openVisitInTx`, and the patient created
   * moments earlier in the same transaction must go with it. Before this, registration and
   * visit-opening were separate transactions from the browser, so this left a person half-created:
   * a real UHID, allocated, attached to no visit and known to nobody.
   */
  it("A1: a failure opening the visit leaves NO patient behind", async () => {
    await expect(walk({ doctorId: "no-such-doctor" })).rejects.toThrow(OpdError);
    expect(await patientCount()).toBe(0);
  });

  /** A2 — a replay must return the original, not a refusal: the clerk's retry is not a new patient. */
  it("A2: replaying the same key returns the original result and creates nothing new", async () => {
    const first = await walk({}, "key-1");
    const replay = await walk({}, "key-1");
    expect(replay.encounter.id).toBe(first.encounter.id);
    expect(replay.patientId).toBe(first.patientId);
    expect(await patientCount()).toBe(1);
  });

  it("A2b: WITHOUT a key the same request runs twice — the protection is the key, not the shape", async () => {
    await walk({}, "key-a");
    await walk({ patient: { register: { ...NEW_PATIENT, phone: "9876540003" } }, acknowledgedDuplicates: true });
    expect(await patientCount()).toBe(2);
  });

  /** A3 — the same key with a DIFFERENT body is a client bug, and answering the original would hide it. */
  it("A3: the same key with a different body is refused", async () => {
    await walk({}, "key-2");
    await expect(
      walk({ patient: { register: { ...NEW_PATIENT, name: "Someone Else", phone: "9000000001" } } }, "key-2"),
    ).rejects.toThrow();
  });

  /**
   * DD8 — the duplicate check is a WARNING a human may override, never a gate. A real second person
   * on a shared family phone must still be registrable; a system that refuses her teaches the desk
   * to invent phone numbers, which is worse than the duplicate.
   */
  it("DD8: a near-match refuses the registration and names the candidates", async () => {
    await mkPatient(db, clerk.actor, { name: "Ramesh Kale", phone: "9876540002" });
    const err = await walk().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpdError);
    expect((err as OpdError).code).toBe("duplicate_suspected");
    const detail = (err as OpdError).detail as { candidates: { uhid: string }[] };
    expect(detail.candidates.length).toBeGreaterThan(0);
    expect(await patientCount()).toBe(1); // the existing one only — nothing was written
  });

  it("DD8b: acknowledging the warning registers anyway", async () => {
    await mkPatient(db, clerk.actor, { name: "Ramesh Kale", phone: "9876540002" });
    const res = await walk({ acknowledgedDuplicates: true });
    expect(res.registered).toBe(true);
    expect(await patientCount()).toBe(2);
  });

  it("an existing patient is attached, not registered, and no duplicate check runs", async () => {
    const existing = await mkPatient(db, clerk.actor, { name: "Asha Devi", phone: "9876540011" });
    const res = await walk({ patient: { existingId: existing.id } });
    expect(res.registered).toBe(false);
    expect(res.patientId).toBe(existing.id);
    expect(await patientCount()).toBe(1);
  });

  /**
   * The permission split the guard cannot express. `@RequirePermission` writes ONE metadata key, so
   * a second decorator would have silently replaced the first and left this route creating patients
   * behind `opd.visits.open` alone.
   */
  it("a holder of opd.visits.open but NOT patients.register cannot register through the walk-in", async () => {
    const opener = await mkUser(db, "opener1", ["opd_open_only_t"]);
    await expect(
      walkIn(db, opener.actor, {
        departmentId: deptId, doctorId: dra.doctorId, patient: { register: NEW_PATIENT },
        acknowledgedDuplicates: true,
      } as never, undefined, T0),
    ).rejects.toMatchObject({ code: "registration_not_permitted" });
    expect(await patientCount()).toBe(0);
  });

  it("that same account may still attach an EXISTING patient — the check is on the create branch only", async () => {
    const existing = await mkPatient(db, clerk.actor, { name: "Asha Devi", phone: "9876540011" });
    const opener = await mkUser(db, "opener2", ["opd_open_only_t"]);
    const res = await walkIn(db, opener.actor, {
      departmentId: deptId, doctorId: dra.doctorId, patient: { existingId: existing.id },
    } as never, undefined, T0);
    expect(res.registered).toBe(false);
  });

  it("an unknown existing id is refused", async () => {
    await expect(walk({ patient: { existingId: "no-such-patient" } }))
      .rejects.toMatchObject({ code: "patient_not_found" });
  });
});
