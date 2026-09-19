import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkUser } from "../../../test/helpers/opd";
import { grantPermissionToRole, syncPermissions } from "../auth/permissions";
import { ModuleRegistry } from "../modules/loader";
import { patients, phiAccessLog, registrationConfig } from "../db/schema";
import { withPeople } from "./people";
import type { ApprovalRow } from "./worklist";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../db/client";

/**
 * APPROVALS-UX — `withPeople` names the requester, the decider and the patient for the inbox.
 *
 * The property that matters is the SEAL: whether a sealed patient's legal name reaches the screen is
 * the reader's clearance to decide, not the inbox's. The same two rows are therefore read by two
 * approvers — one without `patients.confidential.read` and one with it — and only the second sees the
 * name. A merged record answers with the record that survived.
 */
const CONFIDENTIAL_READ = "patients.confidential.read";
const PLAIN = "01PATIENT0000000000000001";
const SEALED = "01PATIENT0000000000000002";
const LOSER = "01PATIENT0000000000000003";

function row(over: Partial<ApprovalRow>): ApprovalRow {
  return {
    id: "ap", typeKey: "billing_refund", instanceId: "wi", requesterId: "nobody", approverRole: "billing_manager",
    urgencyClass: "urgent", actedFirst: false, subjectType: "billing_refund", subjectId: "s", patientId: null,
    encounterId: null, payeeId: null, amountPaise: null, cumulativePatientPaise: null, cumulativePayeePaise: null,
    requestNote: null, status: "pending", decisionNote: null, decidedBy: null, decidedAt: null,
    requestedAt: new Date("2026-09-19T05:00:00Z"),
    ...over,
  };
}

describe("withPeople — the inbox's names", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: { id: string; actor: Actor };
  let manager: { id: string; actor: Actor };
  let privacy: { id: string; actor: Actor };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    await db.insert(patients).values([
      { id: PLAIN, uhid: "HMS-00000001-5", name: "Asha Devi", sex: "female", administrativeGender: "female", createdBy: "t", updatedBy: "t" },
      { id: SEALED, uhid: "HMS-00000002-3", name: "Meera Raghavan", alias: "Patient S-14", isConfidential: true,
        sex: "female", administrativeGender: "female", createdBy: "t", updatedBy: "t" },
      { id: LOSER, uhid: "HMS-00000003-1", name: "Asha Devi (duplicate)", status: "merged", mergedIntoPatientId: PLAIN,
        sex: "female", administrativeGender: "female", createdBy: "t", updatedBy: "t" },
    ]);
    const registry = new ModuleRegistry();
    registry.install({ key: "patients", title: "P", menu: [], permissions: [CONFIDENTIAL_READ], subscriptions: [] });
    await syncPermissions(db, registry);
    clerk = await mkUser(db, "sunita.verma", ["front_desk"]);
    manager = await mkUser(db, "billing.manager", ["billing_manager"]);
    privacy = await mkUser(db, "privacy.bose", ["privacy_officer"]);
    await grantPermissionToRole(db, registry, "privacy_officer", CONFIDENTIAL_READ);
  });

  it("names the requester and the decider from the user table", async () => {
    const [named] = await withPeople(db, manager.actor, [
      row({ requesterId: clerk.id, status: "granted", decidedBy: manager.id, decidedAt: new Date() }),
    ], "t");
    expect(named).toMatchObject({ requesterName: "sunita.verma", decidedByName: "billing.manager", patient: null });
  });

  it("a sealed patient reaches a reader without clearance by alias only — and by name for one with it", async () => {
    const rows = [row({ id: "a1", patientId: PLAIN }), row({ id: "a2", patientId: SEALED })];

    const forManager = await withPeople(db, manager.actor, rows, "t");
    expect(forManager.map((r) => r.patient)).toEqual([
      { id: PLAIN, uhid: "HMS-00000001-5", name: "Asha Devi", alias: null, restricted: false },
      { id: SEALED, uhid: "HMS-00000002-3", name: null, alias: "Patient S-14", restricted: true },
    ]);
    expect(JSON.stringify(forManager)).not.toContain("Meera Raghavan");

    const forPrivacy = await withPeople(db, privacy.actor, rows, "t");
    expect(forPrivacy[1]!.patient).toMatchObject({ name: "Meera Raghavan", restricted: false });
  });

  it("logs one approvals.worklist row per distinct patient, sealed where the record is", async () => {
    await withPeople(db, manager.actor, [
      row({ id: "a1", patientId: PLAIN }), row({ id: "a2", patientId: PLAIN }), row({ id: "a3", patientId: SEALED }),
    ], "approvals worklist (pending), 3 rows");
    const logged = await db.select().from(phiAccessLog).where(eq(phiAccessLog.surface, "approvals.worklist"));
    expect(logged.map((r) => [r.patientId, r.sealed, r.actorId]).sort()).toEqual(
      [[PLAIN, false, manager.id], [SEALED, true, manager.id]].sort(),
    );
  });

  it("a merged record answers with the record that survived; an unknown id names nobody and logs nothing", async () => {
    const out = await withPeople(db, manager.actor, [
      row({ id: "a1", patientId: LOSER }), row({ id: "a2", patientId: "01PATIENTNOSUCH0000000000" }),
    ], "t");
    expect(out[0]!.patient).toMatchObject({ id: PLAIN, uhid: "HMS-00000001-5", name: "Asha Devi" });
    expect(out[1]!.patient).toBeNull();
    const logged = await db.select().from(phiAccessLog).where(eq(phiAccessLog.surface, "approvals.worklist"));
    expect(logged.map((r) => r.patientId)).toEqual([PLAIN]);
  });

  it("an empty page reads nothing", async () => {
    expect(await withPeople(db, manager.actor, [], "t")).toEqual([]);
  });
});
