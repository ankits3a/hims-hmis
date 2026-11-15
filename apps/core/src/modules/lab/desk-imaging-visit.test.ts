import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { seedLabDeskBase } from "../../../test/helpers/lab";
import { opdEncounters } from "../../kernel/db/schema";
import { deskFind } from "./desk";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { Db } from "../../kernel/db/client";

/**
 * #1079 — THE LAB DESK MUST NOT TAKE THE IMAGING WALK-IN FOR THE PATIENT'S VISIT.
 *
 * The imaging desk now opens a `V` visit of type `imaging` for an outside referral (`openImagingWalkinInTx`),
 * under the radiologist of record. The lab desk's patient door resolves "today's visit" as the latest
 * visit of the day, so a patient who saw a doctor in the morning and then walked into imaging with a
 * slip was shown the IMAGING visit at the lab — and a lab test ordered there would hang off the
 * radiologist's walk-in. The door resolves the OPD visit; a patient whose only visit today is the
 * imaging walk-in has no visit at the lab (the lab opens its own walk-in, as for anyone else).
 */
describe("#1079 — the lab desk's patient door and the imaging walk-in", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;

  jest.setTimeout(120_000);
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedLabDeskBase(db);
  });
  afterEach(() => { fx.unregister(); });

  const visit = async (visitNo: string, type: string, openedAt: string): Promise<void> => {
    await db.insert(opdEncounters).values({
      id: newId(), visitNo, patientId: fx.patientId, type, workflowInstanceId: newId(), serviceDate: fx.serviceDate,
      visitType: "new", openedBy: "t", openedAt: new Date(openedAt), updatedBy: "t",
    });
  };
  const doorFor = async () => (await deskFind(db, fx.desk.actor, "Ram Kumar", fx.serviceDate)).find((h) => h.patient.id === fx.patientId);

  it("an OPD visit in the morning and an imaging walk-in after it: the lab desk resolves the OPD visit", async () => {
    /** 09:30 IST the OPD visit, 11:30 IST the imaging walk-in — the walk-in is the LATER of the two. */
    await visit("V2608290101", "opd", "2026-08-29T04:00:00.000Z");
    await visit("V2608290102", "imaging", "2026-08-29T06:00:00.000Z");
    expect((await doorFor())?.visit?.encounterNo).toBe("V2608290101");
  });

  it("the imaging walk-in alone is not a visit at the lab desk", async () => {
    await visit("V2608290102", "imaging", "2026-08-29T06:00:00.000Z");
    const hit = await doorFor();
    expect(hit?.patient.id).toBe(fx.patientId);
    expect(hit?.visit).toBeNull();
  });

  it("the lab's own walk-in is still the patient's visit at the lab desk", async () => {
    await visit("V2608290102", "imaging", "2026-08-29T06:00:00.000Z");
    await visit("V2608290103", "lab", "2026-08-29T07:00:00.000Z");
    expect((await doorFor())?.visit?.encounterNo).toBe("V2608290103");
  });
});
