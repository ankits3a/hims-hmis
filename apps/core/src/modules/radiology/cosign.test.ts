import { and, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { newId } from "@hmis/contracts";
import { FIXTURE_COUNCIL_REG, FIXTURE_QUALIFICATION, acquireStudy, setupRadiologyFixture } from "../../../test/helpers/radiology";
import { mkUser } from "../../../test/helpers/opd";
import { imagingCriticalFindings, imagingDefinitions, imagingReports, imagingStudies } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { cosignReport, draftReport, publishReport, signReport } from "./reports";
import { readingContext, readingWorklist } from "./reading";
import { assignRole, grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { ModuleRegistry } from "../../kernel/modules/loader";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { SignerBlock } from "./signer";

/**
 * PLAN 18-S RS8b T1 — **CO-SIGN.** A resident's signature is `awaiting_cosign`; nothing publishes
 * (`cosign_required`) until a consultant co-signs under their own second factor; the resident can
 * neither co-sign nor co-sign their own; the checks run again at the co-sign; the consultant's
 * signer block names the resident who drafted it.
 */
describe("co-sign (18-S RS8b T1)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;
  let resident: Actor;
  let consultant2: Actor;

  const DAY = "2026-08-31";
  const NOW = new Date("2026-08-31T06:00:00.000Z");
  const SLOT = new Date("2026-08-31T09:00:00.000Z");
  const FRESH = new Date(NOW.getTime() - 60_000);
  let seq = 0;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    seq = 0;
    ({ actor: resident } = await mkUser(db, "dr.resident", ["radiology_resident"]));
    ({ actor: consultant2 } = await mkUser(db, "dr.second", ["radiologist"]));
    /** The book names both consultants (the resident is deliberately NOT on it — they are not the signatory of record). */
    await db.update(imagingDefinitions).set({ status: "superseded" }).where(eq(imagingDefinitions.kind, "report_signatories"));
    await db.insert(imagingDefinitions).values({
      id: newId(), kind: "report_signatories", version: 2, status: "active", draftedBy: "t", publishedBy: "t", publishedAt: NOW,
      body: {
        signatories: [
          { user_id: fx.radiologist.id, qualification: FIXTURE_QUALIFICATION, designation: "Consultant Radiologist", council_reg_no: FIXTURE_COUNCIL_REG },
          { user_id: consultant2.id, qualification: FIXTURE_QUALIFICATION, designation: "Consultant Radiologist", council_reg_no: "KMC 55555" },
        ],
      },
    });
    const perms = ["radiology.reports.write", "radiology.reports.read"];
    const registry = new ModuleRegistry();
    registry.install({ key: "radiology", title: "R", menu: [], permissions: perms, subscriptions: [] });
    await syncPermissions(db, registry);
    for (const p of perms) {
      await grantPermissionToRole(db, registry, "radiologist", p);
      await grantPermissionToRole(db, registry, "radiology_resident", p);
    }
  });
  afterEach(() => { fx.unregister(); });

  const acquired = async () => {
    seq += 1;
    return await acquireStudy(db, fx, {
      idemKey: `cs${String(seq)}`, now: new Date(NOW.getTime() + seq * 25 * 3_600_000),
      slot: new Date(SLOT.getTime() + seq * 3_600_000),
    });
  };
  const draft = (who: Actor, studyId: string, over: Record<string, unknown> = {}) =>
    withTx(db, (tx) => draftReport(tx, who, {
      studyId, body: { technique: "Transabdominal.", findings: "Liver normal." }, impression: "Normal study.", ...over,
    }));
  const sign = (who: Actor, studyId: string, reportId: string, over: Record<string, unknown> = {}) =>
    withTx(db, (tx) => signReport(tx, who, { studyId, reportId, secondFactorAt: FRESH, now: NOW, ...over }));
  const cosign = (who: Actor, studyId: string, reportId: string, over: Record<string, unknown> = {}) =>
    withTx(db, (tx) => cosignReport(tx, who, { studyId, reportId, secondFactorAt: FRESH, now: NOW, ...over }));
  const publish = (who: Actor, studyId: string) =>
    withTx(db, (tx) => publishReport(tx, who, fx.decls, { studyId, now: NOW }));
  const row = async (id: string) => (await db.select().from(imagingReports).where(eq(imagingReports.id, id)))[0]!;

  it("a resident's Sign produces awaiting_cosign, not a signed report", async () => {
    const s = await acquired();
    const d = await draft(resident, s.studyId);
    const out = await sign(resident, s.studyId, d.reportId);
    expect(out.awaitingCosign).toBe(true);
    const r = await row(out.reportId);
    expect([r.status, r.signerId]).toEqual(["awaiting_cosign", resident.id]);
    expect(r.signer).toMatchObject({ kind: "resident", userId: resident.id, role: "radiology_resident" });
    expect(r.signChecks).toMatchObject({ acknowledgedBy: resident.id });
    const signed = await db.select().from(imagingReports).where(and(eq(imagingReports.studyId, s.studyId), eq(imagingReports.status, "signed")));
    expect(signed).toHaveLength(0);
  });

  it("the resident cannot publish: cosign_required, and the study stays unpublished", async () => {
    const s = await acquired();
    const d = await draft(resident, s.studyId);
    await sign(resident, s.studyId, d.reportId);
    await expect(publish(resident, s.studyId)).rejects.toMatchObject({ code: "cosign_required" });
    await expect(publish(fx.radiologist, s.studyId)).rejects.toMatchObject({ code: "cosign_required" });
    const [st] = await db.select().from(imagingStudies).where(eq(imagingStudies.id, s.studyId));
    expect(st!.status).toBe("acquired");
  });

  it("a consultant's co-sign publishes, and the signer block records both: resident drafted, consultant signed", async () => {
    const s = await acquired();
    const d = await draft(resident, s.studyId);
    const awaiting = await sign(resident, s.studyId, d.reportId);
    const co = await cosign(fx.radiologist, s.studyId, awaiting.reportId);
    expect(co.cosignedId).toBe(awaiting.reportId);
    const signed = await row(co.reportId);
    expect([signed.status, signed.signerId]).toEqual(["signed", fx.radiologist.id]);
    const block = signed.signer as SignerBlock;
    expect(block.userId).toBe(fx.radiologist.id);
    expect(block.councilRegNo).toBe(FIXTURE_COUNCIL_REG);
    expect(block.draftedBy).toMatchObject({ kind: "resident", userId: resident.id, reportId: awaiting.reportId });
    expect(signed.impression).toBe("Normal study.");
    expect((await row(awaiting.reportId)).status).toBe("cosigned");

    const pub = await publish(fx.radiologist, s.studyId);
    expect(pub.reportId).toBe(co.reportId);
  });

  it("the resident cannot co-sign (cosign_not_consultant), and nobody co-signs their own (cosign_own_report)", async () => {
    const s = await acquired();
    const d = await draft(resident, s.studyId);
    const awaiting = await sign(resident, s.studyId, d.reportId);
    await expect(cosign(resident, s.studyId, awaiting.reportId)).rejects.toMatchObject({ code: "cosign_not_consultant" });

    /** The resident is promoted before the co-sign: a consultant now, and it is still their own signature. */
    await assignRole(db, { userId: resident.id, roleKey: "radiologist", scopeType: "hospital" });
    await expect(cosign(resident, s.studyId, awaiting.reportId)).rejects.toMatchObject({ code: "cosign_own_report" });
    expect((await row(awaiting.reportId)).status).toBe("awaiting_cosign");
  });

  it("the co-sign needs the consultant's OWN fresh second factor", async () => {
    const s = await acquired();
    const d = await draft(resident, s.studyId);
    const awaiting = await sign(resident, s.studyId, d.reportId);
    await expect(cosign(fx.radiologist, s.studyId, awaiting.reportId, { secondFactorAt: null }))
      .rejects.toMatchObject({ code: "second_factor_required" });
    await expect(cosign(fx.radiologist, s.studyId, awaiting.reportId, { secondFactorAt: new Date(NOW.getTime() - 60 * 60_000) }))
      .rejects.toMatchObject({ code: "second_factor_required" });
  });

  it("the pre-sign checks run again at the co-sign: the consultant acknowledges the warnings in their own name", async () => {
    const s = await acquired();
    const d = await draft(resident, s.studyId, { impression: "Small pneumothorax at the right apex." });
    const awaiting = await sign(resident, s.studyId, d.reportId, { acknowledgedWarnings: ["critical_term"] });
    await expect(cosign(fx.radiologist, s.studyId, awaiting.reportId)).rejects.toMatchObject({ code: "checks_unacknowledged" });
    const co = await cosign(fx.radiologist, s.studyId, awaiting.reportId, { acknowledgedWarnings: ["critical_term"] });
    expect((await row(co.reportId)).signChecks).toMatchObject({ acknowledgedBy: fx.radiologist.id });
  });

  it("two consultants co-signing one report make ONE signature", async () => {
    const s = await acquired();
    const d = await draft(resident, s.studyId);
    const awaiting = await sign(resident, s.studyId, d.reportId);
    await cosign(fx.radiologist, s.studyId, awaiting.reportId);
    await expect(cosign(consultant2, s.studyId, awaiting.reportId)).rejects.toMatchObject({ code: "stale_state" });
  });

  it("a second resident signature on the same study is refused while one waits", async () => {
    const s = await acquired();
    const d1 = await draft(resident, s.studyId);
    await sign(resident, s.studyId, d1.reportId);
    const d2 = await draft(resident, s.studyId, { impression: "Normal study, second look." });
    await expect(sign(resident, s.studyId, d2.reportId)).rejects.toMatchObject({ code: "already_signed" });
  });

  it("a resident's RED critical is raised at their signature — the call does not wait for the co-sign — and the co-sign raises no second", async () => {
    const s = await acquired();
    const d = await draft(resident, s.studyId, { impression: "Large left pneumothorax." });
    const awaiting = await sign(resident, s.studyId, d.reportId, { criticalCategory: "red" });
    const calls = await db.select().from(imagingCriticalFindings).where(eq(imagingCriticalFindings.reportId, awaiting.reportId));
    expect(calls).toHaveLength(1);
    await cosign(fx.radiologist, s.studyId, awaiting.reportId);
    expect(await db.select().from(imagingCriticalFindings)).toHaveLength(1);
  });

  it("the consultant's reading list puts the resident's report on top as awaiting_cosign; the study view offers the co-sign", async () => {
    const other = await acquired();
    const s = await acquired();
    await db.update(imagingStudies).set({ priority: "stat" }).where(eq(imagingStudies.id, other.studyId));
    const d = await draft(resident, s.studyId);
    const awaiting = await sign(resident, s.studyId, d.reportId);

    const list = await readingWorklist(db, fx.radiologist, NOW);
    expect(list[0]).toMatchObject({ studyId: s.studyId, reportState: "awaiting_cosign" });
    const ctx = (await readingContext(db, fx.radiologist, s.studyId, NOW))!;
    expect(ctx.awaitingCosign).toMatchObject({ reportId: awaiting.reportId, residentId: resident.id, residentName: "dr.resident" });
    expect(ctx.viewer).toEqual({ consultant: true, resident: false });
    const rctx = (await readingContext(db, resident, s.studyId, NOW))!;
    expect(rctx.viewer).toEqual({ consultant: false, resident: true });
  });

  it("a consultant signing directly is unchanged: signed, publishable, no co-sign asked", async () => {
    const s = await acquired();
    const d = await draft(fx.radiologist, s.studyId);
    const out = await sign(fx.radiologist, s.studyId, d.reportId);
    expect(out.awaitingCosign).toBeUndefined();
    expect((await row(out.reportId)).status).toBe("signed");
    await publish(fx.radiologist, s.studyId);
  });
});
