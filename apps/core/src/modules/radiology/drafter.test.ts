import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { acquireStudy, setupRadiologyFixture, studyTypeRow } from "../../../test/helpers/radiology";
import { imagingDefinitions, imagingReports, patients } from "../../kernel/db/schema";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import { offlineTemplateDrafter, proposalLockoutHits, setActiveDrafter } from "./drafter";
import { draftReport, proposeDraft, signReport } from "./reports";
import { templateFor } from "./templates";
import type { DrafterFacts, ReportDrafter } from "./drafter";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18b T4 — the drafter seam. The assertion book: an obstetric USG proposal carries exactly
 * the template's sections, `findings` and `impression` EMPTY, `provenance.drafter =
 * 'offline_template'`, and no lockout hit (mutant: a drafter that writes "No acute abnormality"
 * into the impression — a machine finding); after `signReport` the signed version's provenance is
 * null and the draft's is intact (§6.8).
 */
describe("the report drafter seam, offline (18b T4)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;
  const DAY = "2026-08-31";
  const NOW = new Date("2026-08-31T06:00:00.000Z");
  const SLOT = new Date("2026-08-31T09:00:00.000Z");
  const FRESH = new Date(NOW.getTime() - 60_000);
  let seq = 0;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    seq = 0;
    setActiveDrafter(null);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    // Close review B7 — `proposeDraft` checks the permission at its boundary now.
    const registry = new ModuleRegistry();
    registry.install({ key: "radiology", title: "R", menu: [], permissions: ["radiology.reports.write"], subscriptions: [] });
    await syncPermissions(db, registry);
    await grantPermissionToRole(db, registry, "radiologist", "radiology.reports.write");
  });
  afterEach(() => { fx.unregister(); setActiveDrafter(null); });

  const acquired = async (over: { serviceCode?: string; deviceKey?: string; dose?: boolean } = {}) => {
    seq += 1;
    return await acquireStudy(db, fx, {
      idemKey: `d${String(seq)}`, now: new Date(NOW.getTime() + seq * 25 * 3_600_000),
      slot: new Date(SLOT.getTime() + seq * 3_600_000), ...over,
    });
  };
  const obstetricBook = async () => {
    await db.update(imagingDefinitions).set({
      body: { types: [studyTypeRow({ code: "USG-ABDO", service_id: fx.services["USG-ABDO"]!, modality: "usg", body_part: "obstetric" })] },
    }).where(eq(imagingDefinitions.kind, "study_types"));
  };
  const FACTS: DrafterFacts = {
    studyId: "s1", accessionNo: "X1",
    studyType: { code: "CT-ABDO", name: "CT abdomen", modality: "ct", body_part: "abdomen", contrast_option: "required", ionising: true },
    laterality: "na", contrastGiven: true, contrastAgent: "Iohexol", contrastVolumeMl: "80.00",
    dose: { ctdivol: "6.400", dlp: "320.500", dap: null, fluoroSeconds: null },
  };

  it("the offline drafter fills TECHNIQUE from the recorded facts and nothing clinical, deterministically", async () => {
    const a = await offlineTemplateDrafter.draft(FACTS, NOW);
    const b = await offlineTemplateDrafter.draft(FACTS, NOW);
    expect(a).toEqual(b);
    expect(a.templateKey).toBe("ct");
    expect(Object.keys(a.body).sort()).toEqual([...templateFor("ct").sections].sort());
    expect(a.body.technique).toBe("CT: CT abdomen with 80.00 ml Iohexol intravenously. Dose: CTDIvol 6.400 mGy, DLP 320.500 mGy·cm.");
    expect([a.body.findings, a.impression]).toEqual(["", null]);
    expect(a.provenance).toMatchObject({ drafter: "offline_template", version: "1", at: NOW.toISOString() });
    expect(proposalLockoutHits(a, "full")).toEqual([]);
    // Close review B3 — DAP has no house unit; it is NOT rendered (the register, 18c, owns its unit).
    const withDap = await offlineTemplateDrafter.draft({ ...FACTS, dose: { ...FACTS.dose, dap: "245.600" } }, NOW);
    expect(withDap.body.technique).not.toMatch(/DAP/);
  });

  it("an obstetric USG proposal is the template's sections, findings and impression EMPTY, provenance on the row", async () => {
    await obstetricBook();
    const study = await acquired();
    const out = await withTx(db, (tx) => proposeDraft(tx, fx.radiologist, { studyId: study.studyId, now: NOW }));
    expect(out.templateKey).toBe("usg_obstetric");
    const [row] = await db.select().from(imagingReports).where(eq(imagingReports.id, out.reportId));
    const body = row!.body as Record<string, string>;
    expect(Object.keys(body).sort()).toEqual([...templateFor("usg_obstetric").sections].sort());
    expect([body.findings, body.biometry, row!.impression, row!.status]).toEqual(["", "", null, "draft"]);
    expect(body.technique).toBe("Ultrasound: Study USG-ABDO."); // B6 — the type's NAME, not the body-part label
    expect(row!.provenance).toMatchObject({ drafter: "offline_template", inputs: { studyTypeCode: "USG-ABDO", modality: "usg", requestedBy: fx.radiologist.id } });
    expect(proposalLockoutHits({ templateKey: out.templateKey, body, impression: row!.impression, laterality: null, provenance: out.provenance as never }, "full")).toEqual([]);
    expect(out.body).toEqual(body); // C4 — the answer carries the body
  });

  it("§6.8 — the machine's proposal is NOT signable as it stands; the human's own draft over it is, and carries no provenance", async () => {
    const study = await acquired({ serviceCode: "XR-CHEST", deviceKey: "xray", dose: true });
    const proposal = await withTx(db, (tx) => proposeDraft(tx, fx.radiologist, { studyId: study.studyId, now: NOW }));
    // Close review B2 — "Start from template" then "Sign" used to produce a signed report with no finding.
    await expect(withTx(db, (tx) => signReport(tx, fx.radiologist, {
      studyId: study.studyId, reportId: proposal.reportId, secondFactorAt: FRESH, now: NOW,
    }))).rejects.toMatchObject({ code: "machine_draft_not_signable", detail: { drafter: "offline_template" } });
    const human = await withTx(db, (tx) => draftReport(tx, fx.radiologist, {
      studyId: study.studyId, body: { ...proposal.body, findings: "Clear lung fields." }, impression: "Normal chest radiograph.",
    }));
    const signed = await withTx(db, (tx) => signReport(tx, fx.radiologist, {
      studyId: study.studyId, reportId: human.reportId, secondFactorAt: FRESH, now: NOW,
    }));
    const rows = await db.select().from(imagingReports).where(eq(imagingReports.studyId, study.studyId));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(signed.reportId)!.provenance).toBeNull();
    expect(byId.get(human.reportId)!.provenance).toBeNull();
    expect(byId.get(proposal.reportId)!.provenance).not.toBeNull();
    expect((byId.get(signed.reportId)!.body as Record<string, string>).technique).toBe(proposal.body.technique);
  });

  it("close review B1 — the drafter gets the HUMAN tier (F66): the same type name is refused in an obstetric context and allowed outside one", async () => {
    await db.update(imagingDefinitions).set({
      body: { types: [studyTypeRow({ code: "USG-ABDO", service_id: fx.services["USG-ABDO"]!, modality: "usg", body_part: "pelvis", name: "USG pelvis (female)" })] },
    }).where(eq(imagingDefinitions.kind, "study_types"));
    // The fixture patient is a 30-year-old woman: FULL tier, exactly as a human typing the same words.
    const hers = await acquired();
    await expect(withTx(db, (tx) => proposeDraft(tx, fx.radiologist, { studyId: hers.studyId, now: NOW })))
      .rejects.toMatchObject({ code: "lexical_lockout", detail: { terms: ["female"] } });
    // A 62-year-old man: CODED tier, and the type's name is not a coded term — the draft is written.
    await db.update(patients).set({ sex: "male", administrativeGender: "male", dob: new Date(Date.UTC(1964, 0, 1)) })
      .where(eq(patients.id, fx.patientId));
    const his = await acquired();
    const out = await withTx(db, (tx) => proposeDraft(tx, fx.radiologist, { studyId: his.studyId, now: NOW }));
    expect(out.body.technique).toBe("Ultrasound: USG pelvis (female).");
  });

  it("a drafter that emits a §5(2) term is REFUSED with lexical_lockout and writes no version — no override lane", async () => {
    await obstetricBook();
    const study = await acquired();
    const talkative: ReportDrafter = {
      key: "talkative", version: "0",
      draft: async (facts, now) => {
        const p = await offlineTemplateDrafter.draft(facts, now);
        return { ...p, body: { ...p.body, findings: "Single live fetus, male." }, provenance: { ...p.provenance, drafter: "talkative" } };
      },
    };
    setActiveDrafter(talkative);
    await expect(withTx(db, (tx) => proposeDraft(tx, fx.radiologist, { studyId: study.studyId, now: NOW })))
      .rejects.toMatchObject({ code: "lexical_lockout", detail: { drafter: "talkative" } });
    expect(await db.select().from(imagingReports).where(eq(imagingReports.studyId, study.studyId))).toHaveLength(0);
  });
});
