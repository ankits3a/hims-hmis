import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { newId } from "@hmis/contracts";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { aerbIncidents, events, patients, phiAccessLog } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { createResource } from "../../kernel/resources/registry";
import { RADIOLOGY_RESOURCE_KINDS } from "../radiology";
import { aerbManifest } from "./manifest";
import {
  closeIncident, incidentRegister, investigateIncident, notifyRequiredFor, recordIncident,
  recordIncidentNotification, updateIncidentActions,
} from "./incidents";
import { AerbError } from "./errors";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * 18-S RS11 T2 — the radiation incident register.
 *
 * The mutant this file is built around: **"close it anyway."** An incident closed with a corrective
 * action still open is a register telling an inspector the fix happened when it has not; one closed
 * without the AERB notification it owed is the register hiding a reportable event. Both refusals
 * read the ROW afterwards and find it still open.
 */
describe("the radiation incident register (18-S RS11 T2)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let rso: Actor;
  let radiologist: Actor;
  let tech: Actor;
  let techId: string;
  let uhid: string;
  let ct: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    const registry = new ModuleRegistry();
    registry.install(aerbManifest);
    await syncPermissions(db, registry);
    for (const role of ["radiation_safety_officer", "radiologist", "radiographer"]) await ensureRole(db, role);
    for (const p of aerbManifest.permissions) await grantPermissionToRole(db, registry, "radiation_safety_officer", p);
    await grantPermissionToRole(db, registry, "radiologist", "aerb.incidents.read");
    ({ actor: rso } = await mkUser(db, "rso.mondal", ["radiation_safety_officer"]));
    ({ actor: radiologist } = await mkUser(db, "dr.sahay", ["radiologist"]));
    const t = await mkUser(db, "Amit Oraon", ["radiographer"]);
    tech = t.actor; techId = t.id;
    uhid = "HMS-00000001-5";
    await db.insert(patients).values({
      id: newId(), uhid, name: "Laxmi Oraon", sex: "female", administrativeGender: "female",
      dob: new Date(Date.UTC(1977, 0, 1)), createdBy: "t", updatedBy: "t",
    });
    ct = (await withTx(db, (tx) => createResource(tx, rso, RADIOLOGY_RESOURCE_KINDS, {
      kind: "device", code: "CT-1", name: "CT scanner", attributes: { modality: "ct" },
    }))).resourceId;
  });

  const refusal = async (p: Promise<unknown>): Promise<AerbError> => {
    try { await p; } catch (e) { if (e instanceof AerbError) return e; throw e; }
    throw new Error("expected a refusal");
  };

  const record = (over: Partial<Parameters<typeof recordIncident>[2]> = {}) =>
    withTx(db, (tx) => recordIncident(tx, rso, {
      kind: "repeat_over_threshold", occurredAt: "2026-09-26T10:10:00Z", deviceResourceId: ct,
      affectedType: "patient", patientUhid: uhid, estimatedDoseMsv: 12, doseNote: "extra DLP 820 mGy·cm",
      description: "CECT abdomen repeated: bolus-tracking ROI on the IVC", immediateAction: "Patient told; radiologist informed",
      significantlyAboveIntended: false, ...over,
    }, { now: new Date("2026-09-26T12:00:00Z") }));

  it("records an incident with a yearly number, an event, and no patient in the event", async () => {
    const a = await record();
    const b = await record();
    expect(a.incidentNo).toBe("INC-26-001");
    expect(b.incidentNo).toBe("INC-26-002");
    expect(a.notifyRequired).toBe(false);
    const [ev] = await db.select().from(events).where(eq(events.name, "aerb.incident_recorded"));
    expect(ev!.payload).toEqual({ incidentId: a.incidentId, incidentNo: "INC-26-001", kind: "repeat_over_threshold", notifyRequired: false });
  });

  it("DECIDED rule: AERB must be told for a worker over a limit or an exposure significantly above intended", async () => {
    expect(notifyRequiredFor("worker_over_limit", false)).toBe(true);
    expect(notifyRequiredFor("pregnant_patient", true)).toBe(true);
    expect(notifyRequiredFor("wrong_patient", false)).toBe(false);
    const w = await record({ kind: "worker_over_limit", affectedType: "worker", workerUserId: techId, patientUhid: null });
    expect(w.notifyRequired).toBe(true);
  });

  it("refuses a patient incident without the UHID, and a stranger's pen", async () => {
    expect((await refusal(record({ patientUhid: null }))).code).toBe("invalid_validity");
    expect((await refusal(record({ patientUhid: "UH-NOPE" }))).code).toBe("unknown_person");
    const e = await refusal(withTx(db, (tx) => recordIncident(tx, tech, {
      kind: "other", occurredAt: "2026-09-26T10:10:00Z", affectedType: "other", affectedName: "a visitor",
      description: "x", immediateAction: "y", significantlyAboveIntended: false,
    })));
    expect(e.code).toBe("not_appointed");
  });

  it("CLOSE REFUSES with a corrective action open, and the row stays investigated", async () => {
    const { incidentId } = await record();
    expect((await refusal(withTx(db, (tx) => closeIncident(tx, rso, incidentId, {})))).code).toBe("incident_state");
    await withTx(db, (tx) => investigateIncident(tx, rso, incidentId, {
      rootCause: "ROI on the IVC; new technologist",
      correctiveActions: [
        { action: "Protocol card shows the ROI position", owner: "Amit Oraon", doneOn: "2026-09-27" },
        { action: "Second tech checks the ROI for 2 weeks", owner: "Bikash Mondal", doneOn: null },
      ],
    }));
    const e = await refusal(withTx(db, (tx) => closeIncident(tx, rso, incidentId, {})));
    expect(e.code).toBe("incident_actions_open");
    expect(e.message).toContain("Second tech checks the ROI");
    const [row] = await db.select().from(aerbIncidents).where(eq(aerbIncidents.id, incidentId));
    expect(row!.state).toBe("investigated");
    expect(row!.closedAt).toBeNull();

    await withTx(db, (tx) => updateIncidentActions(tx, rso, incidentId, [
      { action: "Protocol card shows the ROI position", owner: "Amit Oraon", doneOn: "2026-09-27" },
      { action: "Second tech checks the ROI for 2 weeks", owner: "Bikash Mondal", doneOn: "2026-10-10" },
    ]));
    await withTx(db, (tx) => closeIncident(tx, rso, incidentId, { closureNote: "ROI checks clean for two weeks" }));
    const [closed] = await db.select().from(aerbIncidents).where(eq(aerbIncidents.id, incidentId));
    expect(closed!.state).toBe("closed");
    expect((await refusal(withTx(db, (tx) => updateIncidentActions(tx, rso, incidentId, [])))).code).toBe("incident_state");
  });

  it("CLOSE REFUSES a notifiable incident until AERB's date and reference are on the row", async () => {
    const { incidentId } = await record({ kind: "pregnant_patient", significantlyAboveIntended: true });
    await withTx(db, (tx) => investigateIncident(tx, rso, incidentId, {
      rootCause: "LMP asked verbally", correctiveActions: [{ action: "LMP date required", owner: "HOD", doneOn: "2026-09-27" }],
    }));
    expect((await refusal(withTx(db, (tx) => closeIncident(tx, rso, incidentId, {})))).code).toBe("notification_required");
    await withTx(db, (tx) => recordIncidentNotification(tx, rso, incidentId, {
      notifiedOn: "2026-09-26", notificationRef: "AERB/RSD/INC/2026/0411",
    }, { now: new Date("2026-09-27T06:00:00Z") }));
    await withTx(db, (tx) => closeIncident(tx, rso, incidentId, {}));
    const [row] = await db.select().from(aerbIncidents).where(eq(aerbIncidents.id, incidentId));
    expect([row!.state, row!.notificationRef]).toEqual(["closed", "AERB/RSD/INC/2026/0411"]);
  });

  it("the register: the radiologist reads it, the 24-hour clock shows overdue, one PHI row per patient", async () => {
    await record({ kind: "wrong_patient", significantlyAboveIntended: true });
    await record();
    const { rows, canManage } = await incidentRegister(db, radiologist, { now: new Date("2026-09-28T12:00:00Z") });
    expect(canManage).toBe(false);
    expect(rows).toHaveLength(2);
    const notifiable = rows.find((r) => r.notifyRequired)!;
    expect(notifiable.notifyOverdue).toBe(true);
    expect(notifiable.affectedLabel).toBe("Laxmi Oraon");
    expect(notifiable.deviceCode).toBe("CT-1");
    expect(rows.find((r) => !r.notifyRequired)!.notifyOverdue).toBe(false);
    expect(await db.select().from(phiAccessLog).where(eq(phiAccessLog.surface, "aerb.incident_register"))).toHaveLength(1);
  });
});
