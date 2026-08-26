import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { seedSodPairs } from "../../kernel/auth/sod";
import { getApprovalType } from "../../kernel/approvals/types";
import { withTx } from "../../kernel/db/client";
import { createUser } from "../../kernel/auth/identity";
import { createRole, assignRole, grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../kernel/modules/manifests";
import { registrationConfig } from "../../kernel/db/schema";
import { registerPatient } from "./registration";
import { createMergeRequest, executeMerge, MERGE_APPROVAL_TYPE, UNMERGE_APPROVAL_TYPE } from "./merge";
import { PATIENT_APPROVAL_TYPES, registerPatientApprovalTypes } from "./approval-types";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

const ACTIVATOR: Actor = { type: "user", id: "patients-approval-activator" };

/**
 * The `billing/approval-types.test.ts` shape, plus one leg that file has no reason to carry: the
 * REGRESSION. `patient_merge` was named by `merge.ts` from Plan 05 and registered by nothing, so
 * `requestApproval` threw `unknown_type` and the merge lane was dead at step one on every
 * deployment — measured against production 2026-08-26, which held seven approval types, none of
 * them patients'. The first test below is what fails if that registration is ever dropped again.
 */
describe("approval-types: registerPatientApprovalTypes", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  for (const manifest of ALL_MANIFESTS) registry.install(manifest);

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    // `registerPatient` mints a UHID from this row; without it the two fixtures below cannot exist
    // and `createMergeRequest` would refuse on `patient_not_found` before ever reaching the
    // approval lookup this file is about.
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" });
    await seedSodPairs(db);
  });

  test("registers both types with medical_superintendent as approver and actFirstAllowed false", async () => {
    expect(PATIENT_APPROVAL_TYPES.map((s) => s.typeKey)).toEqual(["patient_merge", "patient_unmerge"]);
    // The two constants `merge.ts` actually calls `requestApproval` with. Pinned against the specs
    // rather than retyped: a rename on either side that missed the other is precisely how this
    // lane came to be unregistered for the whole of Plan 05.
    expect(PATIENT_APPROVAL_TYPES.map((s) => s.typeKey))
      .toEqual([MERGE_APPROVAL_TYPE, UNMERGE_APPROVAL_TYPE]);

    await registerPatientApprovalTypes(db, ACTIVATOR);
    for (const spec of PATIENT_APPROVAL_TYPES) {
      const row = await withTx(db, (tx) => getApprovalType(tx, spec.typeKey));
      expect(row).not.toBeNull();
      // The owner's 2026-08-26 ruling: a merge is medical-record governance, not a front-office
      // correction. `front_office_supervisor` was considered and rejected — it keeps the fix inside
      // the team that made the duplicate.
      expect(row!.approverRole).toBe("medical_superintendent");
      expect(row!.urgencyClass).toBe(spec.urgencyClass);
      // Check-on-execute, always: `executeMerge` refuses anything but a granted approval regardless.
      expect(row!.actFirstAllowed).toBe(false);
    }
  });

  test("idempotent on a second call: no throw, both still registered exactly once", async () => {
    await registerPatientApprovalTypes(db, ACTIVATOR);
    await expect(registerPatientApprovalTypes(db, ACTIVATOR)).resolves.toBeUndefined();
    for (const spec of PATIENT_APPROVAL_TYPES) {
      const row = await withTx(db, (tx) => getApprovalType(tx, spec.typeKey));
      expect(row!.typeKey).toBe(spec.typeKey);
    }
  });

  /**
   * THE REGRESSION LEG — the state production was actually in, reproduced.
   *
   * Without the registration a merge request does not merely fail to be approved; it cannot be
   * CREATED. That is the difference between "the approver has not got to it" and "nobody on this
   * deployment can start a merge", and only the second one is invisible until somebody tries.
   */
  test("WITHOUT the registration, createMergeRequest throws unknown_type — the state Plan 05 shipped", async () => {
    await syncPermissions(db, registry);
    await createRole(db, "mrd_officer", "MRD Officer");
    await grantPermissionToRole(db, registry, "mrd_officer", "patients.merge");
    const { id: actorId } = await createUser(db, { username: "mrd", fullName: "MRD", password: "p1234567" });
    await assignRole(db, { userId: actorId, roleKey: "mrd_officer", scopeType: "hospital" });
    const actor: Actor = { type: "user", id: actorId };
    // REAL patients: `createMergeRequest` checks both exist before it looks at approvals, so
    // fixture ids would fail on `patient_not_found` and this test would pass for the wrong reason.
    const winner = await withTx(db, (tx) => registerPatient(tx, actor, { name: "Asha Devi", sex: "female", phone: "9876543210" }));
    const loser = await withTx(db, (tx) => registerPatient(tx, actor, { name: "Asha Debi", sex: "female", phone: "9876543210" }));

    // Deliberately NOT calling registerPatientApprovalTypes here.
    await expect(
      withTx(db, (tx) => createMergeRequest(tx, actor, {
        winnerId: winner.patient.id, loserId: loser.patient.id, note: "same person, two registrations",
      })),
    ).rejects.toThrow(/unknown_type|unknown approval type/);

    // And the permission made no difference to that, which is the whole point: the holder of
    // `patients.merge` hit exactly the same wall as everybody else.
    await registerPatientApprovalTypes(db, ACTIVATOR);
    const row = await withTx(db, (tx) => getApprovalType(tx, MERGE_APPROVAL_TYPE));
    expect(row).not.toBeNull();
  });

  /**
   * `executeMerge` is check-on-execute and stays that way: registering the type opens the REQUEST,
   * never the execution. A registration that also made merges self-approving would be a far worse
   * bug than the one it fixed.
   */
  test("registration opens the request, NOT the execution — an ungranted approval still refuses", async () => {
    await registerPatientApprovalTypes(db, ACTIVATOR);
    await expect(executeMerge(db, { type: "user", id: "u-1" }, "no-such-merge-request"))
      .rejects.toThrow(/unknown_merge_request|approval/);
  });
});
