import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters,
} from "../../../test/helpers/opd";
import { opdEncounterDiagnoses, opdEncounters } from "../../kernel/db/schema";
import { openVisit } from "./encounters";
import { OpdCdsController } from "./opd-cds.controller";
import { myTerms, testsForDiagnosis } from "./term-suggest";
import type { Db } from "../../kernel/db/client";

/**
 * CONSULT V2 PR 3 (owner, 2026-09-23, round 4) — autocomplete offers the doctor's OWN earlier words for
 * examination and treatment (never another doctor's, D4), and tests are suggested from what was advised
 * before for the same diagnosis — yours first, then the hospital's.
 */
const MON = new Date("2026-08-17T04:00:00.000Z");

describe("consult v2 PR 3 — the doctor's own terms, and tests for a diagnosis", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let drb: Awaited<ReturnType<typeof mkDoctor>>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let deptId: string;
  let patientId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const m = await seedOpdMasters(db);
    deptId = m.deptId;
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId: m.roomId });
    drb = await mkDoctor(db, { username: "drb", departmentId: deptId, roomId: m.room2Id });
    clerk = await mkUser(db, "clerk1", ["front_office_t"]);
    patientId = (await mkPatient(db, clerk.actor)).id;
  });

  /** A completed visit carrying the given words — written directly: the note route is not under test here. */
  async function completed(doctorId: string, v: {
    exam?: { group: string; text: string }[]; treatment?: string[];
    dx?: { text: string; icd10: string | null }[]; tests?: { serviceId: string; code: string; name: string; pricePaise: number }[];
  }): Promise<string> {
    const opened = await openVisit(db, clerk.actor, { patientId, departmentId: deptId, doctorId }, MON);
    const id = opened.encounter.id;
    await db.update(opdEncounters).set({
      examination: v.exam ?? null, treatment: v.treatment ?? null, advisedTests: v.tests ?? null,
      consultCompletedAt: MON,
    }).where(eq(opdEncounters.id, id));
    for (const [i, d] of (v.dx ?? []).entries()) {
      await db.insert(opdEncounterDiagnoses).values({ encounterId: id, seq: i, text: d.text, icd10Code: d.icd10 });
    }
    return id;
  }

  it("offers the doctor's own examination words for that group, most used first, prefix before substring", async () => {
    await completed(dra.doctorId, { exam: [{ group: "general", text: "Pallor present" }, { group: "systemic", text: "Pallor noted on CVS?" }] });
    await completed(dra.doctorId, { exam: [{ group: "general", text: "Pallor present" }, { group: "general", text: "Mild pallor" }] });
    const hits = await myTerms(db, dra.doctorId, "exam_general", "pall");
    expect(hits).toEqual([{ term: "Pallor present", uses: 2 }, { term: "Mild pallor", uses: 1 }]);
  });

  it("never offers another doctor's words (D4), and an unfinished visit teaches nothing", async () => {
    await completed(dra.doctorId, { treatment: ["Steam inhalation shown"] });
    const opened = await openVisit(db, clerk.actor, { patientId, departmentId: deptId, doctorId: drb.doctorId }, MON);
    await db.update(opdEncounters).set({ treatment: ["Steam at bedside"] }).where(eq(opdEncounters.id, opened.encounter.id));
    expect(await myTerms(db, drb.doctorId, "treatment", "steam")).toEqual([]);
    expect(await myTerms(db, dra.doctorId, "treatment", "steam")).toEqual([{ term: "Steam inhalation shown", uses: 1 }]);
  });

  it("the route answers the asking doctor only, and a non-doctor gets nothing", async () => {
    await completed(dra.doctorId, { treatment: ["Dressing done"] });
    const ctl = new OpdCdsController(db);
    expect((await ctl.completeTerm(dra.actor, { field: "treatment", q: "dress" })).items).toEqual([{ term: "Dressing done", uses: 1 }]);
    expect((await ctl.completeTerm(drb.actor, { field: "treatment", q: "dress" })).items).toEqual([]);
    expect((await ctl.completeTerm(clerk.actor, { field: "treatment", q: "dress" })).items).toEqual([]);
  });

  it("suggests tests advised before for the same diagnosis — by code or by exact words — mine first", async () => {
    const lipid = { serviceId: "svc-lipid", code: "LIP", name: "Lipid profile", pricePaise: 50000 };
    const rft = { serviceId: "svc-rft", code: "RFT", name: "RFT", pricePaise: 40000 };
    const cbc = { serviceId: "svc-cbc", code: "CBC", name: "CBC", pricePaise: 30000 };
    await completed(drb.doctorId, { dx: [{ text: "Essential hypertension", icd10: "I10" }], tests: [rft] });
    await completed(drb.doctorId, { dx: [{ text: "Essential hypertension", icd10: "I10" }], tests: [rft] });
    await completed(dra.doctorId, { dx: [{ text: "high bp", icd10: null }], tests: [lipid] });
    await completed(dra.doctorId, { dx: [{ text: "Fever", icd10: "R50.9" }], tests: [cbc] });
    const hits = await testsForDiagnosis(db, dra.doctorId, [{ text: "Essential hypertension", icd10: "I10" }, { text: "High BP", icd10: null }]);
    expect(hits.map((h) => [h.name, h.mine, h.hospital])).toEqual([["Lipid profile", 1, 1], ["RFT", 0, 2]]);
  });

  it("an empty diagnosis list suggests nothing, and a malformed dx is a 400, not a 500", async () => {
    expect(await testsForDiagnosis(db, dra.doctorId, [])).toEqual([]);
    const ctl = new OpdCdsController(db);
    await expect(ctl.suggestTests(dra.actor, { dx: "not json" })).rejects.toMatchObject({ status: 400 });
  });
});
