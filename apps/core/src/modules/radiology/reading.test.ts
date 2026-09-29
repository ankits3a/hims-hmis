import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  FIXTURE_COUNCIL_REG, FIXTURE_QUALIFICATION, acquireStudy, setupRadiologyFixture,
} from "../../../test/helpers/radiology";
import { mkUser } from "../../../test/helpers/opd";
import {
  imagingDefinitions, imagingImageViews, imagingReports, imagingStudies, opdDepartments, opdDoctors,
} from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { amendReport, draftReport, dryRunPreSign, publishReport, signReport } from "./reports";
import { parseDefinitionBody } from "./definitions";
import { readingContext, readingWorklist, reportPrintView, tatClassOf } from "./reading";
import { signedContentDigest } from "./signer";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18-S RS8a — the reading room through the real report chain: the pre-sign checks at SIGN
 * (T2), the signer block snapshotted and printed (T3, ruling 4), the governed templates book (T1)
 * and the reading room's reads (T4's server half).
 */
describe("the reading room (18-S RS8a)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;

  const DAY = "2026-08-31";
  const NOW = new Date("2026-08-31T06:00:00.000Z");
  const SLOT = new Date("2026-08-31T09:00:00.000Z");
  const FRESH = new Date(NOW.getTime() - 60_000);

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    seq = 0;
    const perms = ["radiology.reports.write", "radiology.reports.read"];
    const registry = new ModuleRegistry();
    registry.install({ key: "radiology", title: "R", menu: [], permissions: perms, subscriptions: [] });
    await syncPermissions(db, registry);
    for (const p of perms) await grantPermissionToRole(db, registry, "radiologist", p);
  });
  afterEach(() => { fx.unregister(); });

  let seq = 0;
  const acquired = async (over: { serviceCode?: string; deviceKey?: string } = {}) => {
    seq += 1;
    return await acquireStudy(db, fx, {
      idemKey: `rr${String(seq)}`, now: new Date(NOW.getTime() + seq * 25 * 3_600_000),
      slot: new Date(SLOT.getTime() + seq * 3_600_000), ...over,
    });
  };
  const draft = (studyId: string, over: Record<string, unknown> = {}) =>
    withTx(db, (tx) => draftReport(tx, fx.radiologist, {
      studyId, body: { technique: "Transabdominal.", findings: "Liver normal." }, impression: "Normal study.", ...over,
    }));
  const sign = (studyId: string, reportId: string, over: Record<string, unknown> = {}) =>
    withTx(db, (tx) => signReport(tx, fx.radiologist, { studyId, reportId, secondFactorAt: FRESH, now: NOW, ...over }));
  const signedRow = async (reportId: string) =>
    (await db.select().from(imagingReports).where(eq(imagingReports.id, reportId)))[0]!;
  const publishBook = async (kind: "report_templates" | "report_signatories", body: unknown) => {
    await db.update(imagingDefinitions).set({ status: "superseded" })
      .where(eq(imagingDefinitions.kind, kind));
    await db.insert(imagingDefinitions).values({
      id: newId(), kind, version: 9, status: "active", draftedBy: "t", publishedBy: "t", publishedAt: NOW, body: body as object,
    });
  };

  /* ═══════════════════════ T2 — the checks at the signature ═══════════════════════ */

  it("T2: an empty impression is refused at sign with impression_required, and nothing is signed", async () => {
    const s = await acquired();
    const d = await draft(s.studyId, { impression: "" });
    await expect(sign(s.studyId, d.reportId)).rejects.toMatchObject({ code: "impression_required" });
    expect((await db.select().from(imagingReports).where(eq(imagingReports.status, "signed")))).toHaveLength(0);
  });

  it("T2: the study's side against the words — only the other side is refused side_conflict", async () => {
    const s = await acquired();
    await db.update(imagingStudies).set({ laterality: "left" }).where(eq(imagingStudies.id, s.studyId));
    const d = await draft(s.studyId, { body: { findings: "Simple cyst, right kidney." }, impression: "Right renal cyst." });
    await expect(sign(s.studyId, d.reportId)).rejects.toMatchObject({ code: "side_conflict" });
  });

  it("T2: a sex-specific organ against the registered sex is refused sex_organ_mismatch", async () => {
    const s = await acquired();
    /** The fixture's patient is registered female. */
    const d = await draft(s.studyId, { body: { findings: "Prostate enlarged, 48 cc." }, impression: "Prostatomegaly." });
    await expect(sign(s.studyId, d.reportId)).rejects.toMatchObject({ code: "sex_organ_mismatch" });
  });

  it("T2: a template requiring BI-RADS refuses a signature without one; with it, the report signs", async () => {
    await publishBook("report_templates", { templates: [{
      key: "usg_breast", name: "USG breast", modalities: ["usg"],
      sections: [{ key: "findings", label: "Findings" }, { key: "impression", label: "Impression" }],
      coded: [{ system: "birads", required: true }],
    }] });
    const s = await acquired();
    const bare = await draft(s.studyId, { templateKey: "usg_breast" });
    await expect(sign(s.studyId, bare.reportId)).rejects.toMatchObject({ code: "coded_category_required" });
    const coded = await draft(s.studyId, { templateKey: "usg_breast", body: { findings: "Simple cyst.", coded: { birads: { value: "2" } } } });
    await expect(sign(s.studyId, coded.reportId)).resolves.toBeDefined();
  });

  it("T2: an unflagged critical term needs an ACKNOWLEDGEMENT, which the signed row records", async () => {
    const s = await acquired();
    const d = await draft(s.studyId, { body: { findings: "Free air under the right hemidiaphragm." }, impression: "Pneumoperitoneum." });
    await expect(sign(s.studyId, d.reportId)).rejects.toMatchObject({ code: "checks_unacknowledged" });

    const signed = await sign(s.studyId, d.reportId, { acknowledgedWarnings: ["critical_term"] });
    const row = await signedRow(signed.reportId);
    expect(row.signChecks).toMatchObject({
      warnings: [{ code: "critical_term" }], acknowledgedBy: fx.radiologist.id, acknowledgedAt: NOW.toISOString(),
    });
    expect((row.signChecks as { ran: string[] }).ran).toEqual(
      ["impression_required", "side_conflict", "sex_organ_mismatch", "coded_category_required", "critical_term"],
    );
  });

  it("T2 false positive: a negated critical term signs with no acknowledgement", async () => {
    const s = await acquired();
    const d = await draft(s.studyId, { body: { findings: "No free air. No pneumoperitoneum." }, impression: "Normal study." });
    await expect(sign(s.studyId, d.reportId)).resolves.toBeDefined();
  });

  it("T2: an AMENDMENT meets the same checks — it is not the way round them", async () => {
    const s = await acquired();
    const d = await draft(s.studyId);
    await sign(s.studyId, d.reportId);
    await expect(withTx(db, (tx) => amendReport(tx, fx.radiologist, {
      studyId: s.studyId, secondFactorAt: FRESH, now: NOW, reason: "addendum",
      body: { findings: "Addendum." }, impression: "",
    }))).rejects.toMatchObject({ code: "impression_required" });
  });

  it("T2: the dry run answers the same findings and writes nothing", async () => {
    const s = await acquired();
    const before = (await db.select().from(imagingReports)).length;
    const r = await withTx(db, (tx) => dryRunPreSign(tx, fx.radiologist, {
      studyId: s.studyId, body: { findings: "Large pneumothorax." }, impression: "",
    }));
    expect(r.findings.map((f) => `${f.level}:${f.code}`)).toEqual(["refuse:impression_required", "warn:critical_term"]);
    expect(r.signable).toBe(false);
    expect((await db.select().from(imagingReports)).length).toBe(before);
  });

  /* ═══════════════════════ T3 — the signer block (ruling 4) ═══════════════════════ */

  it("T3: the signed row carries name, qualification, council number and the signature marker", async () => {
    const s = await acquired();
    const d = await draft(s.studyId);
    const signed = await sign(s.studyId, d.reportId);
    const row = await signedRow(signed.reportId);
    expect(row.signer).toMatchObject({
      userId: fx.radiologist.id, name: "dr.rao", qualification: FIXTURE_QUALIFICATION,
      designation: "Consultant Radiologist", councilRegNo: FIXTURE_COUNCIL_REG, councilRegSource: "signatories",
      signature: {
        method: "totp_second_factor", secondFactorAt: FRESH.toISOString(),
        contentSha256: signedContentDigest({ templateKey: row.templateKey, body: row.body, impression: row.impression, laterality: row.laterality }),
      },
    });
    /** A draft carries none. */
    expect((await signedRow(d.reportId)).signer).toBeNull();
  });

  it("T3: a signer not on the list of authorised signatories is refused signer_credentials_missing", async () => {
    const other = await mkUser(db, "dr.new", ["radiologist"]);
    const s = await acquired();
    const d = await draft(s.studyId);
    await expect(withTx(db, (tx) => signReport(tx, other.actor, { studyId: s.studyId, reportId: d.reportId, secondFactorAt: FRESH, now: NOW })))
      .rejects.toMatchObject({ code: "signer_credentials_missing", detail: { missing: ["signatory_listing"] } });
  });

  it("T3: with no signatories book published, nobody signs — and the refusal names the book", async () => {
    await db.delete(imagingDefinitions).where(eq(imagingDefinitions.kind, "report_signatories"));
    const s = await acquired();
    const d = await draft(s.studyId);
    await expect(sign(s.studyId, d.reportId))
      .rejects.toMatchObject({ code: "signer_credentials_missing", detail: { missing: ["signatories_book"] } });
  });

  it("T3: a blank council number falls back to the OPD doctor record; absent everywhere, it is refused", async () => {
    await publishBook("report_signatories", { signatories: [{ user_id: fx.radiologist.id, qualification: "MD (Radiodiagnosis)" }] });
    const s1 = await acquired();
    const d1 = await draft(s1.studyId);
    await expect(sign(s1.studyId, d1.reportId))
      .rejects.toMatchObject({ code: "signer_credentials_missing", detail: { missing: ["council_registration"] } });

    const deptId = newId();
    await db.insert(opdDepartments).values({ id: deptId, code: "RAD", name: "Radiology", createdBy: "t", updatedBy: "t" } as never);
    await db.insert(opdDoctors).values({
      id: newId(), userId: fx.radiologist.id, displayName: "Dr Rao", code: "DR-0602", registrationNo: "JSMC 2014/1187",
      departmentId: deptId, createdBy: "t", updatedBy: "t",
    });
    const signed = await sign(s1.studyId, d1.reportId);
    expect((await signedRow(signed.reportId)).signer).toMatchObject({
      councilRegNo: "JSMC 2014/1187", councilRegSource: "opd_doctor", doctorCode: "DR-0602",
    });
  });

  it("T3/T5: the print carries the signer block and the coded line; a draft never prints", async () => {
    await publishBook("report_templates", { templates: [{
      key: "usg_breast", name: "USG breast", modalities: ["usg"],
      sections: [{ key: "findings", label: "Findings" }, { key: "impression", label: "Impression" }],
      coded: [{ system: "birads", required: true }],
    }] });
    const s = await acquired();
    const d = await draft(s.studyId, { templateKey: "usg_breast", body: { findings: "Irregular mass.", coded: { birads: { value: "4A" } } } });
    expect(await reportPrintView(db, fx.radiologist, d.reportId)).toBeNull();
    const signed = await sign(s.studyId, d.reportId);
    const print = await reportPrintView(db, fx.radiologist, signed.reportId);
    expect(print).toMatchObject({
      codedLines: ["BI-RADS 4A — Low suspicion for malignancy — tissue diagnosis"],
      signer: { name: "dr.rao", qualification: FIXTURE_QUALIFICATION, councilRegNo: FIXTURE_COUNCIL_REG },
      sections: [{ key: "findings", text: "Irregular mass." }],
    });
    /** Ruling 4 — the REFERRER is a Doctor ID + department, never a name (the fixture's is no OPD doctor). */
    expect(print!.referrer).toEqual({ doctorCode: null, department: null });
    expect(JSON.stringify(print!.referrer)).not.toContain("mehra");
  });

  /* ═══════════════════════ T1 — the governed book ═══════════════════════ */

  it("T1: the report_templates schema refuses a template with no impression and two templates sharing a key", () => {
    const t = { key: "a", name: "A", modalities: ["ct"], sections: [{ key: "impression", label: "Impression" }] };
    expect(() => parseDefinitionBody("report_templates", { templates: [{ ...t, sections: [{ key: "findings", label: "F" }] }] }))
      .toThrow(/impression/);
    expect(() => parseDefinitionBody("report_templates", { templates: [t, t] })).toThrow(/share a key/);
    expect(parseDefinitionBody("report_templates", { templates: [t] }).templates[0]!.coded).toEqual([]);
  });

  it("T1: the reference template set in docs parses as a report_templates book (the HOD's paste works)", () => {
    const raw = readFileSync(join(__dirname, "../../../../../docs/runbooks/radiology-report-templates.reference.json"), "utf8");
    const book = parseDefinitionBody("report_templates", JSON.parse(raw));
    const systems = new Set(book.templates.flatMap((x) => x.coded.map((c) => c.system)));
    expect([...systems].sort()).toEqual(["aspects", "birads", "fleischner", "lirads", "lungrads", "orads", "pirads", "tirads"]);
  });

  /* ═══════════════════════ T4 — the reading room's reads ═══════════════════════ */

  it("T4: the TAT class — STAT 30 min, urgent (ER) 60, bedside (IPD) 6 h, otherwise OPD 24 h", () => {
    expect([tatClassOf("stat", "Ward 3"), tatClassOf("urgent", null), tatClassOf("routine", "Ward 3 · bed 12"), tatClassOf("routine", null)])
      .toEqual(["stat", "er", "ipd", "opd"]);
  });

  it("T4: the worklist — urgency first, the clock from images-in, the report state, and who is reading", async () => {
    const a = await acquired();
    const b = await acquired();
    await db.update(imagingStudies).set({ priority: "routine" }).where(eq(imagingStudies.id, b.studyId));
    const colleague = await mkUser(db, "dr.sahay", ["radiologist"]);
    await db.insert(imagingImageViews).values({
      id: newId(), studyId: b.studyId, viewerId: colleague.id, via: "external_pacs", urlHost: "pacs.local", viewedAt: new Date(),
    });
    /** The reader's OWN view is not a lock on themselves. */
    await db.insert(imagingImageViews).values({
      id: newId(), studyId: a.studyId, viewerId: fx.radiologist.id, via: "external_pacs", urlHost: "pacs.local", viewedAt: new Date(),
    });
    await draft(a.studyId);
    const rows = await readingWorklist(db, fx.radiologist);
    expect(rows.map((r) => [r.studyId, r.tatClass, r.reportState])).toEqual([
      [a.studyId, "stat", "draft"], [b.studyId, "opd", "none"],
    ]);
    const [ra, rb] = rows;
    expect(ra!.dueAt!.getTime() - ra!.acquiredAt!.getTime()).toBe(30 * 60_000);
    expect(rb!.readingBy).toMatchObject({ userId: colleague.id, name: "dr.sahay" });
    expect(ra!.readingBy).toBeNull();
  });

  it("T4: the worklist is the reader's — a radiographer without reports.write is refused", async () => {
    await expect(readingWorklist(db, fx.radiographer)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("T4: the study in hand — clinical question, priors, governed templates, the working draft", async () => {
    await publishBook("report_templates", { templates: [
      { key: "usg_abdo", name: "USG abdomen", modalities: ["usg"], sections: [{ key: "findings", label: "Findings", normal: "Liver normal." }, { key: "impression", label: "Impression", normal: "Normal study." }] },
      { key: "ct_head", name: "CT head", modalities: ["ct"], sections: [{ key: "impression", label: "Impression" }] },
    ] });
    const prior = await acquired();
    const pd = await draft(prior.studyId, { impression: "Gallstones." });
    await sign(prior.studyId, pd.reportId);
    await withTx(db, (tx) => publishReport(tx, fx.radiologist, fx.decls, { studyId: prior.studyId }));

    const s = await acquired();
    const w = await draft(s.studyId, { templateKey: "usg_abdo" });
    const ctx = await readingContext(db, fx.radiologist, s.studyId);
    expect(ctx).toMatchObject({
      clinicalQuestion: "clinical suspicion",
      priors: [{ studyId: prior.studyId, impression: "Gallstones." }],
      templates: [{ key: "usg_abdo", governed: true, sections: [{ key: "findings", normal: "Liver normal." }, { key: "impression" }] }],
      defaultTemplateKey: "usg_abdo",
      working: { reportId: w.reportId, templateKey: "usg_abdo" },
      signed: null,
    });
    expect(ctx!.templates).toHaveLength(1);
  });

  it("T4: with no templates book, the study gets its built-in skeleton", async () => {
    const s = await acquired();
    const ctx = await readingContext(db, fx.radiologist, s.studyId);
    expect(ctx!.templates).toEqual([expect.objectContaining({ key: "usg", governed: false })]);
    expect(ctx!.templates[0]!.sections.map((x) => x.key)).toEqual(["technique", "findings", "impression", "recommendation"]);
  });

  it("the book schema's study-type rule: a type-named template wins over the modality's", async () => {
    await publishBook("report_templates", { templates: [
      { key: "usg_generic", name: "USG", modalities: ["usg"], sections: [{ key: "impression", label: "Impression" }] },
      { key: "usg_abdo_own", name: "USG abdomen (own)", modalities: ["usg"], study_type_codes: ["USG-ABDO"], sections: [{ key: "impression", label: "Impression" }] },
    ] });
    const s = await acquired();
    const ctx = await readingContext(db, fx.radiologist, s.studyId);
    expect(ctx!.templates.map((t) => t.key)).toEqual(["usg_abdo_own", "usg_generic"]);
  });
});
