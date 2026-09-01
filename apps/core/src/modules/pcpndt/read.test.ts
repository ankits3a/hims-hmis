import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { setupPcpndtFixture } from "../../../test/helpers/pcpndt";
import { mkUser } from "../../../test/helpers/opd";
import * as pcpndtSurface from "./index";
import { patients, phiAccessLog } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { displayName } from "../patients";
import { openFormF, recordFormF } from "./form-f";
import { formFForStudy } from "./read";
import type { PcpndtFixture } from "../../../test/helpers/pcpndt";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18a T6 — Assertion Book row **A6**, and it is the one place in this phase where the alias
 * path is deliberately NOT used.
 *
 * A6's mutant is routing the Form F through `displayName`, and it is the natural mistake precisely
 * because the alias is right on every other surface in the building. **A statutory declaration
 * bearing a pseudonym is a FALSE declaration** — the offence is the paperwork being wrong, and
 * "we anonymise our records" is not a defence. T9 A3 pins the other half (the radiology worklist
 * for the same patient shows the alias), so the two assertions together are J1's split.
 */
describe("the Form F reader shows the REAL name, and logs that it did (18a T6 A6)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PcpndtFixture;

  const DAY = "2026-06-15";

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupPcpndtFixture(db);
    /** THE PATIENT IS CONFIDENTIAL. Every other surface in this hospital would show "Priya M.". */
    await db.update(patients)
      .set({ isConfidential: true, alias: "Priya M." })
      .where(eq(patients.id, fx.patientId));
  });

  const openAndRecord = async (studyId: string) => {
    const { formFId } = await withTx(db, (tx) => openFormF(tx, fx.sonologist, {
      studyId, patientId: fx.patientId, deviceResourceId: fx.deviceResourceId,
      personUserId: fx.sonologist.id, indicationCode: "obstetric-anomaly",
      applicability: "pregnant", onDate: DAY,
    }));
    await withTx(db, (tx) => recordFormF(tx, fx.sonologist, {
      formFId,
      sections: { A: "Dr Referrer", F: "anomaly scan at 19 weeks" },
      declaration: { signature_kind: "signature" },
      referral: { self_referral: false },
    }));
    return formFId;
  };

  it("A6: returns `patients.name` for a CONFIDENTIAL patient — never the alias", async () => {
    await openAndRecord("STUDY-A6");
    const view = await formFForStudy(db, fx.incharge, "STUDY-A6");

    expect(view?.patientName).toBe("Asha Devi");
    expect(view?.patientIsConfidential).toBe(true);
    /** And the contrast is pinned: the alias path, given the same row, would have said otherwise. */
    expect(displayName({ name: "Asha Devi", alias: "Priya M.", isConfidential: true }, false)).toBe("Priya M.");
    expect(view?.patientName).not.toBe("Priya M.");
  });

  it("A6: every accepted read writes a `pcpndt.form_f` PHI row naming the actor and the patient", async () => {
    await openAndRecord("STUDY-LOG");
    await formFForStudy(db, fx.incharge, "STUDY-LOG");

    const rows = (await db.select().from(phiAccessLog)).filter((r) => r.surface === "pcpndt.form_f");
    expect(rows).toHaveLength(1);
    expect([rows[0]!.actorId, rows[0]!.patientId]).toEqual([fx.incharge.id, fx.patientId]);
  });

  /**
   * The enquiry is logged even when it finds nothing. Somebody asked about this woman's statutory
   * record; that there was no form does not make the asking invisible — which is the only thing an
   * access log is for.
   */
  it("A6: a read that finds NO form still logs, and returns null rather than throwing", async () => {
    expect(await formFForStudy(db, fx.incharge, "STUDY-ABSENT")).toBeNull();
    const rows = (await db.select().from(phiAccessLog)).filter((r) => r.surface === "pcpndt.form_f");
    expect(rows).toHaveLength(1);
  });

  it("refuses a reader without `pcpndt.form_f.read`, and logs nothing for a refused read", async () => {
    await openAndRecord("STUDY-DENY");
    const { actor: nobody } = await mkUser(db, "nurse.nopcpndt", []);
    await expect(formFForStudy(db, nobody, "STUDY-DENY"))
      .rejects.toMatchObject({ code: "person_not_registered" });
    expect((await db.select().from(phiAccessLog)).filter((r) => r.surface === "pcpndt.form_f")).toEqual([]);
  });

  it("refuses a non-user actor — the register is read by staff, not by automation", async () => {
    await openAndRecord("STUDY-SYS");
    await expect(formFForStudy(db, { type: "system", id: "worker" }, "STUDY-SYS"))
      .rejects.toMatchObject({ code: "person_not_registered" });
  });

  /** The view carries what an inspector's page needs: the serial, the machine and the person. */
  it("returns the serial, the machine and the registered person the declaration names", async () => {
    await openAndRecord("STUDY-FULL");
    const view = await formFForStudy(db, fx.incharge, "STUDY-FULL");
    expect(view).toMatchObject({
      serialNo: 1, serialYear: 2026, status: "recorded", applicability: "pregnant",
      machine: { id: fx.machineId, make: "GE", model: "Voluson S10", serial: "SN-99001" },
      person: { id: fx.personId, userId: fx.sonologist.id, qualification: "MD Radiodiagnosis" },
    });
    expect(view?.sections).toMatchObject({ F: "anomaly scan at 19 weeks" });
  });

  /** There is NO list route and no list reader — `manifest.ts`'s sharpest sentence, asserted. */
  it("the module exports exactly ONE reader, and it takes a study", async () => {
    const readers = Object.keys(pcpndtSurface).filter((k) => /^formFFor/.test(k));
    expect(readers.sort()).toEqual(["formFForStudy", "formFForStudyTx"]);
    expect(Object.keys(pcpndtSurface).some((k) => /list|search|all/i.test(k) && /form/i.test(k))).toBe(false);
  });
});
