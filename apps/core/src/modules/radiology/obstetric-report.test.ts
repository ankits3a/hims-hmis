import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { acquireStudy, setupRadiologyFixture, studyTypeRow } from "../../../test/helpers/radiology";
import { PCPNDT_PERMISSIONS } from "../../../test/helpers/pcpndt";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { imagingDefinitions, imagingReports, imagingStudies } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { addMachine, addPerson, createRegistration } from "../pcpndt";
import { draftReport, publishReport, savePrelim, signReport } from "./reports";
import { PCPNDT_REPORT_DECLARATION } from "./obstetric-report";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { StudyType } from "./definitions";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18-S RS7 — the obstetric report, end to end through `reports.ts`:
 *   T1 the foetal-sex guard (`foetal_sex_disclosure`, no approver), on prelim, sign and publish;
 *   T2 the structured biometry the server recomputes, and the declaration the server writes;
 *   and the Act's membership rule at the SIGNATURE — only a person registered on the machine's
 *   registration signs a PCPNDT study.
 */
describe("the obstetric report (18-S RS7)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;
  let ms: Actor;
  let incharge: Actor;

  const DAY = "2026-08-31";
  const NOW = new Date(`${DAY}T06:00:00.000Z`);
  const SLOT = new Date(`${DAY}T09:00:00.000Z`);
  const FRESH = new Date(NOW.getTime() - 60_000);

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    seq = 0;
    await ensureRole(db, "medical_superintendent");
    ({ actor: ms } = await mkUser(db, "ms.rs7", ["medical_superintendent"]));
    const registry = new ModuleRegistry();
    registry.install({ key: "pcpndt", title: "PCPNDT", menu: [], permissions: [...PCPNDT_PERMISSIONS], subscriptions: [] });
    await syncPermissions(db, registry);
    await ensureRole(db, "pcpndt_incharge");
    for (const p of PCPNDT_PERMISSIONS) await grantPermissionToRole(db, registry, "pcpndt_incharge", p);
    ({ actor: incharge } = await mkUser(db, "pndt.rs7", ["pcpndt_incharge"]));
  });
  afterEach(() => { fx.unregister(); });

  let seq = 0;
  const acquired = async () => {
    seq += 1;
    return await acquireStudy(db, fx, {
      idemKey: `ob${String(seq)}`, now: new Date(NOW.getTime() + seq * 25 * 3_600_000),
      slot: new Date(SLOT.getTime() + seq * 3_600_000),
    });
  };
  const obstetricBook = async () => {
    const row = (code: string, over: Partial<StudyType>) => studyTypeRow({ code, service_id: fx.services[code]!, ...over });
    await db.update(imagingDefinitions).set({
      body: {
        types: [
          row("USG-ABDO", { modality: "usg", body_part: "obstetric" }),
          row("XR-CHEST", { modality: "xray", ionising: true }),
          row("CT-HEAD", { modality: "ct", ionising: true }),
          row("MRI-BRAIN", { modality: "mri" }),
        ],
      },
    }).where(eq(imagingDefinitions.kind, "study_types"));
  };
  const draft = (studyId: string, body: Record<string, unknown>, impression = "Single live intrauterine pregnancy.") =>
    withTx(db, (tx) => draftReport(tx, fx.radiologist, { studyId, body, impression }));
  const sign = (studyId: string, reportId: string, over: Record<string, unknown> = {}) =>
    withTx(db, (tx) => signReport(tx, fx.radiologist, { studyId, reportId, secondFactorAt: FRESH, now: NOW, ...over }));

  /* ═══════════════════════ T1 — THE FOETAL-SEX GUARD ═══════════════════════ */

  it("T1: 'male foetus' on an obstetric report is refused `foetal_sex_disclosure`, and the MS override does NOT lift it", async () => {
    await obstetricBook();
    const study = await acquired();
    const { reportId } = await draft(study.studyId, { findings: "Single live intrauterine male foetus, cephalic." });
    const e = await sign(study.studyId, reportId).catch((x: unknown) => x);
    expect((e as { code: string }).code).toBe("foetal_sex_disclosure");
    expect(String((e as Error).message)).toMatch(/"male foetus"/);
    /** F66's lane lifts a DEMOGRAPHIC word. It must not lift a sentence that discloses. */
    await expect(sign(study.studyId, reportId, { lockoutOverride: { approvedBy: ms.id, reason: "typo" } }))
      .rejects.toMatchObject({ code: "foetal_sex_disclosure" });
    const signed = await db.select().from(imagingReports).where(eq(imagingReports.status, "signed"));
    expect(signed).toEqual([]);
  });

  it("T1: a PRELIM that states the sex is refused too — a prelim is readable by the ward", async () => {
    await obstetricBook();
    const study = await acquired();
    await expect(withTx(db, (tx) => savePrelim(tx, fx.radiologist, {
      studyId: study.studyId, body: { findings: "Foetal gender: female." }, impression: "SLIUP.",
    }))).rejects.toMatchObject({ code: "foetal_sex_disclosure" });
  });

  it("T1: a strictly foetal phrase is refused on ANY report — the pregnant trauma CT (N9)", async () => {
    const study = await acquired();
    const { reportId } = await draft(study.studyId, { findings: "Incidental live male foetus in the pelvis." }, "Free fluid.");
    await expect(sign(study.studyId, reportId, { lockoutOverride: { approvedBy: ms.id, reason: "x" } }))
      .rejects.toMatchObject({ code: "foetal_sex_disclosure" });
  });

  it("T1: publish re-reads the SIGNED text — a version signed before this guard existed is not published", async () => {
    await obstetricBook();
    const study = await acquired();
    /** A legacy signed row, written the way the table allows and the guard now refuses. */
    await db.insert(imagingReports).values({
      id: newId(), studyId: study.studyId, version: 1, status: "signed", templateKey: "usg_obstetric",
      body: { findings: "Single live foetus. It is a girl." }, impression: "SLIUP.",
      signerId: fx.radiologist.id, signedAt: NOW, secondFactorAt: FRESH,
    });
    await expect(withTx(db, (tx) => publishReport(tx, fx.radiologist, fx.decls, { studyId: study.studyId, now: NOW })))
      .rejects.toMatchObject({ code: "foetal_sex_disclosure" });
  });

  /** (beta hCG is the F66 demographic tier's word, not this guard's — `foetal-sex.test.ts` covers it.) */
  it("T1 false-positive guard: maternal words and 'sex not disclosed' sign on an obstetric report", async () => {
    await obstetricBook();
    const study = await acquired();
    const { reportId } = await draft(study.studyId, {
      findings: "Maternal kidneys normal. The mother was counselled. Single live intrauterine foetus. "
        + "Sex of the foetus has not been disclosed.",
    });
    await expect(sign(study.studyId, reportId)).resolves.toBeDefined();
  });

  /* ═══════════════════════ T2 — BIOMETRY AND THE DECLARATION ═══════════════════════ */

  it("T2: the biometry's derived block is the SERVER's — a caller's GA/EFW is thrown away and recomputed", async () => {
    await obstetricBook();
    const study = await acquired();
    const { reportId } = await draft(study.studyId, {
      findings: "Single live intrauterine foetus.",
      obstetric_biometry: {
        lmp: "2026-04-13",
        foetuses: [{ label: "A", bpdMm: 47, hcMm: 175, acMm: 150, flMm: 33, fhrBpm: 148, presentation: "cephalic" }],
        afiCm: 12, placenta: "posterior",
        derived: { efwGrams: 9999, gaByScanDays: 1 },
      },
    });
    const [row] = await db.select().from(imagingReports).where(eq(imagingReports.id, reportId));
    const bio = (row!.body as { obstetric_biometry: { derived: Record<string, unknown> & { foetuses: { efwGrams: number }[] } } }).obstetric_biometry;
    expect(bio.derived.foetuses[0]!.efwGrams).toBe(342);
    expect(bio.derived.gaByScanDays).not.toBe(1);
    expect(bio.derived.liquor).toBe("normal");
    expect(bio.derived.eddByLmp).toBe("2027-01-18");
  });

  it("T2: a measurement out of range, a sex field, or biometry on a non-obstetric study is `invalid_biometry`", async () => {
    await obstetricBook();
    const study = await acquired();
    await expect(draft(study.studyId, { obstetric_biometry: { foetuses: [{ label: "A", flMm: 250 }] } }))
      .rejects.toMatchObject({ code: "invalid_biometry" });
    await expect(draft(study.studyId, { obstetric_biometry: { foetuses: [{ label: "A", crlMm: 40, sex: "m" }] } }))
      .rejects.toMatchObject({ code: "invalid_biometry" });
  });

  it("T2: biometry on a plain (non-obstetric) report is refused", async () => {
    const study = await acquired();
    await expect(draft(study.studyId, { obstetric_biometry: { foetuses: [{ label: "A", crlMm: 40 }] } }))
      .rejects.toMatchObject({ code: "invalid_biometry" });
  });

  it("T2: the SIGNED obstetric report carries the fixed declaration in the server's words, whatever the draft said", async () => {
    await obstetricBook();
    const study = await acquired();
    const { reportId } = await draft(study.studyId, {
      findings: "Single live intrauterine foetus.",
      pcpndt_declaration: { en: "edited by hand" },
    });
    const [draftRow] = await db.select().from(imagingReports).where(eq(imagingReports.id, reportId));
    expect((draftRow!.body as Record<string, unknown>).pcpndt_declaration).toBeUndefined();
    const signed = await sign(study.studyId, reportId);
    const [row] = await db.select().from(imagingReports).where(eq(imagingReports.id, signed.reportId));
    expect((row!.body as Record<string, unknown>).pcpndt_declaration).toEqual(PCPNDT_REPORT_DECLARATION);
  });

  it("T2: a non-obstetric signed report carries no declaration", async () => {
    const study = await acquired();
    const { reportId } = await draft(study.studyId, { findings: "Normal liver." }, "Normal.");
    const signed = await sign(study.studyId, reportId);
    const [row] = await db.select().from(imagingReports).where(eq(imagingReports.id, signed.reportId));
    expect((row!.body as Record<string, unknown>).pcpndt_declaration).toBeUndefined();
  });

  /* ═══════════════════════ THE ACT — WHO MAY SIGN ═══════════════════════ */

  it("a PCPNDT study is signed only by a person registered on its machine's registration", async () => {
    const study = await acquired();
    await db.update(imagingStudies).set({ formFRequired: true }).where(eq(imagingStudies.id, study.studyId));
    const { registrationId } = await withTx(db, (tx) => createRegistration(tx, incharge, {
      site: "Main", registrationNo: "PNDT/2026/9", validFrom: "2026-01-01", validTo: "2027-12-31",
    }));
    await withTx(db, (tx) => addMachine(tx, incharge, {
      registrationId, deviceResourceId: fx.devices.usg!, make: "GE", model: "V", serial: "SN-1",
    }));
    const { reportId } = await draft(study.studyId, { findings: "Single live intrauterine foetus." });
    await expect(sign(study.studyId, reportId)).rejects.toMatchObject({ code: "person_not_registered" });

    await withTx(db, (tx) => addPerson(tx, incharge, {
      registrationId, userId: fx.radiologist.id, qualification: "MD Radiodiagnosis",
    }));
    await expect(sign(study.studyId, reportId)).resolves.toBeDefined();
  });
});
