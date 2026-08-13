import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  approvals, events, patientAllergies, patientGuardians, patientPhotos, patients, registrationConfig,
} from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { createUser } from "../../kernel/auth/identity";
import { assignRole, createRole } from "../../kernel/auth/permissions";
import { seedSodPairs } from "../../kernel/auth/sod";
import { approvalFlowDefinition } from "../../kernel/approvals/flow";
import { registerApprovalType } from "../../kernel/approvals/types";
import { approveRequest } from "../../kernel/approvals/decisions";
import { getApproval } from "../../kernel/approvals/worklist";
import { createDraft, activateDefinition } from "../../kernel/workflow/definitions";
import { registerPatient } from "./registration";
import { addAllergy } from "./allergies";
import { linkGuardian } from "./guardians";
import { storePatientPhoto } from "./photos";
import {
  MERGE_APPROVAL_TYPE, UNMERGE_APPROVAL_TYPE, createMergeRequest, executeMerge,
  executeUnmerge, getMergeRequest, requestUnmerge,
} from "./merge";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

describe("merge & unmerge (§11.5 — approval-gated, splittable)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Actor;
  let mrdHead: Actor;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" });
    await seedSodPairs(db);

    // Two-step type registration — EXACTLY the go-live runbook flow (Plan 04 gate report §8):
    // builder → Plan 03 draft → activate (Class C; drafter≠activator SoD) → registerApprovalType.
    const drafterUser = await createUser(db, { username: "drafter", fullName: "D", password: "p1234567" });
    const activatorUser = await createUser(db, { username: "activator", fullName: "A", password: "p1234567" });
    const clerkUser = await createUser(db, { username: "clerk", fullName: "C", password: "p1234567" });
    const mrdUser = await createUser(db, { username: "mrd", fullName: "M", password: "p1234567" });
    const drafter: Actor = { type: "user", id: drafterUser.id };
    const activator: Actor = { type: "user", id: activatorUser.id };
    clerk = { type: "user", id: clerkUser.id };
    mrdHead = { type: "user", id: mrdUser.id };
    await createRole(db, "mrd_head", "MRD Head");
    await assignRole(db, { userId: mrdUser.id, roleKey: "mrd_head", scopeType: "hospital" });

    for (const spec of [
      { typeKey: MERGE_APPROVAL_TYPE, title: "Patient Merge", urgencyClass: "routine" as const, actFirstAllowed: false, sla: 240 },
      { typeKey: UNMERGE_APPROVAL_TYPE, title: "Patient Unmerge", urgencyClass: "urgent" as const, actFirstAllowed: true, sla: 60 },
    ]) {
      const def = approvalFlowDefinition({
        typeKey: spec.typeKey, title: spec.title, approverRole: "mrd_head", closureSlaMinutes: spec.sla,
      });
      const draft = await createDraft(db, drafter, def);
      await activateDefinition(db, activator, draft.definitionId);
      await registerApprovalType(db, activator, {
        typeKey: spec.typeKey, title: spec.title, approverRole: "mrd_head",
        urgencyClass: spec.urgencyClass, actFirstAllowed: spec.actFirstAllowed,
      });
    }
  });

  async function twoPatients(): Promise<{ winnerId: string; loserId: string; loserUhid: string }> {
    const w = await withTx(db, (tx) => registerPatient(tx, clerk, { name: "Asha Devi", sex: "female", phone: "9876543210" }));
    const l = await withTx(db, (tx) => registerPatient(tx, clerk, { name: "Asha Debi", sex: "female", phone: "9876543210" }));
    return { winnerId: w.patient.id, loserId: l.patient.id, loserUhid: l.patient.uhid };
  }

  async function requestedMerge(): Promise<{ winnerId: string; loserId: string; mergeRequestId: string; approvalId: string }> {
    const { winnerId, loserId } = await twoPatients();
    const req = await withTx(db, (tx) =>
      createMergeRequest(tx, clerk, { winnerId, loserId, note: "same person, double registration" }),
    );
    return { winnerId, loserId, mergeRequestId: req.mergeRequestId, approvalId: req.approvalId };
  }

  it("createMergeRequest files the approval atomically and snapshots both rows", async () => {
    const { loserId, mergeRequestId, approvalId } = await requestedMerge();
    const view = await getMergeRequest(db, mergeRequestId);
    expect(view!.request.status).toBe("requested");
    expect(view!.approvalStatus).toBe("pending");
    expect(view!.unmergeApprovalStatus).toBeNull();
    const snapshot = view!.request.snapshot as { winnerBefore: { name: string }; loserBefore: { id: string } };
    expect(snapshot.winnerBefore.name).toBe("Asha Devi");
    expect(snapshot.loserBefore.id).toBe(loserId);

    const approval = await getApproval(db, approvalId);
    expect(approval!.typeKey).toBe(MERGE_APPROVAL_TYPE);
    expect(approval!.patientId).toBe(loserId);
    expect(approval!.urgencyClass).toBe("routine");
  });

  it("guards: same patient, unknown patients, missing note, duplicate pending request", async () => {
    const { winnerId, loserId } = await twoPatients();
    await expect(
      withTx(db, (tx) => createMergeRequest(tx, clerk, { winnerId, loserId: winnerId, note: "x" })),
    ).rejects.toMatchObject({ code: "merge_same_patient" });
    // The unknown-patient branch this test's NAME promises (§3.14: a name that promises what
    // no assertion proves is the same defect class as a fixture that separates nothing).
    await expect(
      withTx(db, (tx) =>
        createMergeRequest(tx, clerk, { winnerId, loserId: "01NOSUCH00000000000000000", note: "x" }),
      ),
    ).rejects.toMatchObject({ code: "patient_not_found" });
    await expect(
      withTx(db, (tx) => createMergeRequest(tx, clerk, { winnerId, loserId, note: "  " })),
    ).rejects.toMatchObject({ code: "reason_required" });
    await withTx(db, (tx) => createMergeRequest(tx, clerk, { winnerId, loserId, note: "dup reg" }));
    await expect(
      withTx(db, (tx) => createMergeRequest(tx, clerk, { winnerId, loserId, note: "again" })),
    ).rejects.toMatchObject({ code: "merge_already_requested" });
    // Tx-first atomicity: the refused duplicate's approval rolled back WITH the row that lost
    // the partial-unique race — exactly one approval exists, the first request's.
    const filed = await db.select().from(approvals).where(eq(approvals.typeKey, MERGE_APPROVAL_TYPE));
    expect(filed).toHaveLength(1);
    expect(filed[0]!.requestNote).toBe("dup reg");
  });

  it("executeMerge refuses while pending, then moves children, freezes the loser, events with the instance correlation", async () => {
    const { winnerId, loserId, mergeRequestId, approvalId } = await requestedMerge();
    await withTx(db, (tx) => addAllergy(tx, clerk, loserId, { substance: "penicillin", source: "registration" }));
    await withTx(db, (tx) => linkGuardian(tx, clerk, loserId, { name: "Ram Devi", relationship: "mother", phone: "9800000000" }));
    await withTx(db, (tx) => storePatientPhoto(tx, clerk, loserId, { mimeType: "image/jpeg", bytes: Buffer.from([1, 2, 3, 4]) }));

    await expect(executeMerge(db, clerk, mergeRequestId)).rejects.toMatchObject({ code: "approval_not_granted" });

    await approveRequest(db, mrdHead, { approvalId, note: "verified same person at desk" });
    const { winnerId: w } = await executeMerge(db, clerk, mergeRequestId);
    expect(w).toBe(winnerId);

    const loser = (await db.select().from(patients).where(eq(patients.id, loserId)))[0]!;
    expect(loser.status).toBe("merged");
    expect(loser.mergedIntoPatientId).toBe(winnerId);

    const movedAllergies = await db.select().from(patientAllergies).where(eq(patientAllergies.patientId, winnerId));
    expect(movedAllergies).toHaveLength(1);
    const movedGuardians = await db.select().from(patientGuardians).where(eq(patientGuardians.patientId, winnerId));
    expect(movedGuardians).toHaveLength(1);
    // Photos deliberately NEVER move: the loser's stays on the frozen row, the winner's absence stands.
    expect(await db.select().from(patientPhotos).where(eq(patientPhotos.patientId, loserId))).toHaveLength(1);
    expect(await db.select().from(patientPhotos).where(eq(patientPhotos.patientId, winnerId))).toHaveLength(0);

    const evs = await db.select().from(events).where(eq(events.name, "patient.merged"));
    expect(evs).toHaveLength(1);
    expect(evs[0]!.patientId).toBe(winnerId);
    const approval = await getApproval(db, approvalId);
    expect(evs[0]!.correlationId).toBe(approval!.instanceId); // §10.5: correlation = the backing instance

    const view = await getMergeRequest(db, mergeRequestId);
    const moved = view!.request.movedRows as { allergyIds: string[]; guardianIds: string[] };
    expect(moved.allergyIds).toHaveLength(1);
    expect(moved.guardianIds).toHaveLength(1);
  });

  it("concurrent executeMerge: exactly one winner; the loser's code is merge_not_requested; exactly one event", async () => {
    const { mergeRequestId, approvalId } = await requestedMerge();
    await approveRequest(db, mrdHead, { approvalId, note: "ok" });
    const results = await Promise.allSettled([
      executeMerge(db, clerk, mergeRequestId),
      executeMerge(db, clerk, mergeRequestId),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // The claim is the transaction's FIRST write and both pre-reads see 'requested', so the
    // shipped arbiter produces exactly ONE loser code (§3.13: enumerate them all — here, one).
    expect((rejected[0]!.reason as { code: string }).code).toBe("merge_not_requested");
    expect(await db.select().from(events).where(eq(events.name, "patient.merged"))).toHaveLength(1);
  });

  it("unmerge: act-first executes while pending, restores exactly the moved rows, events, and is single-winner", async () => {
    const { winnerId, loserId, mergeRequestId, approvalId } = await requestedMerge();
    await withTx(db, (tx) => addAllergy(tx, clerk, loserId, { substance: "sulfa", source: "registration" }));
    await approveRequest(db, mrdHead, { approvalId, note: "ok" });
    await executeMerge(db, clerk, mergeRequestId);

    // wrong merge discovered — act first (E-15), review after
    const un = await withTx(db, (tx) =>
      requestUnmerge(tx, clerk, { mergeRequestId, note: "different persons — DOB mismatch found", actFirst: true }),
    );
    await expect(
      withTx(db, (tx) => requestUnmerge(tx, clerk, { mergeRequestId, note: "again", actFirst: true })),
    ).rejects.toMatchObject({ code: "unmerge_already_requested" });

    await executeUnmerge(db, clerk, mergeRequestId); // approval still pending + actedFirst → allowed

    const loser = (await db.select().from(patients).where(eq(patients.id, loserId)))[0]!;
    expect(loser.status).toBe("active");
    expect(loser.mergedIntoPatientId).toBeNull();
    const restored = await db.select().from(patientAllergies).where(eq(patientAllergies.patientId, loserId));
    expect(restored).toHaveLength(1); // the moved allergy came home
    expect(await db.select().from(patientAllergies).where(eq(patientAllergies.patientId, winnerId))).toHaveLength(0);

    const evs = await db.select().from(events).where(eq(events.name, "patient.unmerged"));
    expect(evs).toHaveLength(1);
    expect(evs[0]!.patientId).toBe(loserId);
    const unApproval = await getApproval(db, un.approvalId);
    expect(evs[0]!.correlationId).toBe(unApproval!.instanceId);

    await expect(executeUnmerge(db, clerk, mergeRequestId)).rejects.toMatchObject({ code: "merge_not_executed" });
  });

  it("unmerge without act-first waits for the grant", async () => {
    const { mergeRequestId, approvalId } = await requestedMerge();
    await approveRequest(db, mrdHead, { approvalId, note: "ok" });
    await executeMerge(db, clerk, mergeRequestId);
    const un = await withTx(db, (tx) =>
      requestUnmerge(tx, clerk, { mergeRequestId, note: "wrong merge" }),
    );
    await expect(executeUnmerge(db, clerk, mergeRequestId)).rejects.toMatchObject({ code: "approval_not_granted" });
    await approveRequest(db, mrdHead, { approvalId: un.approvalId, note: "confirmed distinct" });
    await executeUnmerge(db, clerk, mergeRequestId);
  });
});
