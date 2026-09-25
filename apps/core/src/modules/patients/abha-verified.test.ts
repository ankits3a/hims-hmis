import { and, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { events, patientIdentityVersions, patients, registrationConfig } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { recordAbhaVerifiedByAbdm, registerPatient, updatePatient } from "./index";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ABDM S0 — THE FIX FOUND IN RESEARCH: `verified` is reachable only from ABDM answering.
 *
 * `abha_verification_status = 'verified'` is a claim about a NATIONAL REGISTRY. Before S0 the
 * counter's register path stored whatever the client sent and the amend path listed the field as
 * patchable, so one request body could stamp an ABHA "verified" that nobody had ever checked. The
 * registration and amendment paths now REFUSE it (never silently downgrade it — a clerk told nothing
 * would believe the stamp took), and the one writer is `recordAbhaVerifiedByAbdm`, which no route
 * reaches; the abdm module's S1 handlers call it after ABDM's answer.
 */
const clerk: Actor = { type: "user", id: "clerk-1" };
const baseInput = { name: "Asha Devi", sex: "female" as const, phone: "9876543210" };

describe("ABHA verified — only ABDM may set it", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "test" });
  });

  const register = (over: Record<string, unknown> = {}) =>
    withTx(db, (tx) => registerPatient(tx, clerk, { ...baseInput, ...over }));

  it("registration REFUSES a client-sent verified — and writes no patient", async () => {
    await expect(register({ abhaNumber: "12-3456-7890-1234", abhaVerificationStatus: "verified" }))
      .rejects.toMatchObject({ code: "abha_verified_only_by_abdm" });
    expect(await db.select().from(patients)).toHaveLength(0);
  });

  it("registration still takes what the counter can honestly say: self_declared and none", async () => {
    const { patient: a } = await register({ abhaNumber: "12-3456-7890-1234", abhaVerificationStatus: "self_declared" });
    expect(a.abhaVerificationStatus).toBe("self_declared");
    const { patient: b } = await register({ phone: "9876543211" });
    expect(b.abhaVerificationStatus).toBe("none");
  });

  it("amendment REFUSES a move to verified and leaves the row as it was", async () => {
    const { patient } = await register({ abhaNumber: "12-3456-7890-1234", abhaVerificationStatus: "self_declared" });
    await expect(withTx(db, (tx) => updatePatient(tx, clerk, patient.id, { abhaVerificationStatus: "verified" })))
      .rejects.toMatchObject({ code: "abha_verified_only_by_abdm" });
    const [row] = await db.select().from(patients).where(eq(patients.id, patient.id));
    expect(row!.abhaVerificationStatus).toBe("self_declared");
  });

  it("the server path sets verified, normalises the number, and leaves an audit trail under the ABDM actor", async () => {
    const { patient } = await register({ abhaVerificationStatus: "none" });
    const result = await withTx(db, (tx) =>
      recordAbhaVerifiedByAbdm(tx, patient.id, { abhaNumber: "12345678901234", abhaAddress: "asha@sbx", via: "abha-otp" }));
    expect(result.patient).toMatchObject({ abhaVerificationStatus: "verified", abhaNumber: "12-3456-7890-1234", abhaAddress: "asha@sbx" });
    expect(result.changed.sort()).toEqual(["abhaAddress", "abhaNumber", "abhaVerificationStatus"]);

    const updated = await db.select().from(events)
      .where(and(eq(events.name, "patient.updated"), eq(events.patientId, patient.id)));
    expect(updated).toHaveLength(1);
    expect(updated[0]!.actorType).toBe("system");
    expect(updated[0]!.actorId).toBe("abdm");

    // abhaNumber is Class I: the change mints an identity version, evidenced by ABDM.
    const versions = await db.select().from(patientIdentityVersions)
      .where(eq(patientIdentityVersions.patientId, patient.id));
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2]);
    const v2 = versions.find((v) => v.version === 2)!;
    expect(v2.abhaNumber).toBe("12-3456-7890-1234");
    expect(v2.evidenceRef).toBe("ABDM abha-otp");
  });

  it("an amendment that leaves an ABDM-verified record verified is not a move to verified", async () => {
    const { patient } = await register();
    await withTx(db, (tx) => recordAbhaVerifiedByAbdm(tx, patient.id, { abhaNumber: "12-3456-7890-1234", via: "abha-otp" }));
    // The screen sends only dirty fields, but a client that echoes the unchanged status must not be refused.
    const { changed } = await withTx(db, (tx) =>
      updatePatient(tx, clerk, patient.id, { abhaVerificationStatus: "verified", phone: "9811111111" }));
    expect(changed).toEqual(["phone"]);
  });

  it("changing the NUMBER under a verified stamp is refused — the stamp would cover a number ABDM never saw", async () => {
    const { patient } = await register();
    await withTx(db, (tx) => recordAbhaVerifiedByAbdm(tx, patient.id, { abhaNumber: "12-3456-7890-1234", abhaAddress: "asha@sbx", via: "abha-otp" }));
    await expect(withTx(db, (tx) => updatePatient(tx, clerk, patient.id, { abhaNumber: "12-3456-7890-9999" }, { reasonClass: "clerical_error" })))
      .rejects.toMatchObject({ code: "abha_verified_only_by_abdm" });
    await expect(withTx(db, (tx) => updatePatient(tx, clerk, patient.id, { abhaAddress: "someone@sbx" })))
      .rejects.toMatchObject({ code: "abha_verified_only_by_abdm" });
    // …and allowed when the same amendment takes the stamp down to what the clerk can vouch for.
    const { patient: after } = await withTx(db, (tx) => updatePatient(tx, clerk, patient.id,
      { abhaNumber: "12-3456-7890-9999", abhaVerificationStatus: "self_declared" }, { reasonClass: "clerical_error" }));
    expect(after).toMatchObject({ abhaNumber: "12-3456-7890-9999", abhaVerificationStatus: "self_declared" });
  });

  it("a clerk may always take the stamp DOWN", async () => {
    const { patient } = await register();
    await withTx(db, (tx) => recordAbhaVerifiedByAbdm(tx, patient.id, { abhaNumber: "12-3456-7890-1234", via: "abha-otp" }));
    const { patient: after } = await withTx(db, (tx) => updatePatient(tx, clerk, patient.id, { abhaVerificationStatus: "none" }));
    expect(after.abhaVerificationStatus).toBe("none");
  });

  it("the server path refuses a number that is not fourteen digits, and an unknown patient", async () => {
    const { patient } = await register();
    await expect(withTx(db, (tx) => recordAbhaVerifiedByAbdm(tx, patient.id, { abhaNumber: "1234", via: "abha-otp" })))
      .rejects.toMatchObject({ code: "abha_number_invalid" });
    await expect(withTx(db, (tx) => recordAbhaVerifiedByAbdm(tx, "01NOSUCHPATIENT0000000000", { abhaNumber: "12345678901234", via: "abha-otp" })))
      .rejects.toMatchObject({ code: "patient_not_found" });
  });
});
