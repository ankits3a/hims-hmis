import { Test } from "@nestjs/testing";
import { APP_GUARD } from "@nestjs/core";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { acquireStudy, setupRadiologyFixture } from "../../../test/helpers/radiology";
import { mkUser } from "../../../test/helpers/opd";
import { events, imagingDefinitions } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { CONFIG, DB, MODULE_REGISTRY } from "../../kernel/tokens";
import { RadiologyReadingController } from "./radiology-reading.controller";
import { RadiologyReportsController } from "./radiology-reports.controller";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { autosaveDraft, draftReport, proposeDraft } from "./report-authoring";
import { signReport } from "./report-signature";
import { assignReader, claimReading } from "./reading-claim";
import { readingContext, readingWorklist } from "./reading";
import { offlineTemplateDrafter, proposalNumberHits } from "./drafter";
import { parseDefinitionBody, readingPoolFor } from "./definitions";
import type { DrafterFacts } from "./drafter";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { CanActivate, ExecutionContext } from "@nestjs/common";

/** The route's own permission guard is not under test here; the actor is the one the test names. */
class ActorFromHeader implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ headers: Record<string, string>; hmisActor?: Actor }>();
    req.hmisActor = { type: "user", id: req.headers["x-actor"] ?? "nobody" };
    return true;
  }
}

/**
 * #1081 — the reading room beyond its done-means checks: the edges of autosave (a Save is a frozen
 * version, another reader's draft is never written over), the claim's take-over and refresh, the
 * assignment's guards, the proposal the reading context carries, and the numbers check on the
 * sentences the offline drafter actually writes. Every act is given its instant.
 */
describe("the reading room (#1081)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;
  let readerB: Actor;
  let clerk: Actor;
  let seq = 0;
  const DAY = "2026-08-31";
  const NOW = new Date("2026-08-31T06:00:00.000Z");
  const SLOT = new Date("2026-08-31T09:00:00.000Z");
  const T = new Date(NOW.getTime() + 10 * 86_400_000);
  const min = (m: number): Date => new Date(T.getTime() + m * 60_000);

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    seq = 0;
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    const perms = ["radiology.reports.write", "radiology.reports.read", "radiology.reports.amend", "radiology.reports.sign"];
    const registry = new ModuleRegistry();
    registry.install({ key: "radiology", title: "R", menu: [], permissions: perms, subscriptions: [] });
    await syncPermissions(db, registry);
    for (const p of perms) await grantPermissionToRole(db, registry, "radiologist", p);
    await grantPermissionToRole(db, registry, "radiographer", "radiology.reports.write");
    ({ actor: readerB } = await mkUser(db, "dr.iyer", ["radiologist"]));
    ({ actor: clerk } = await mkUser(db, "desk.clerk", ["doctor"]));
  });
  afterEach(() => { fx.unregister(); });

  const acquired = async (over: { serviceCode?: string; deviceKey?: string; dose?: boolean } = {}) => {
    seq += 1;
    return await acquireStudy(db, fx, {
      idemKey: `rr-${String(seq)}`, now: new Date(NOW.getTime() + seq * 25 * 3_600_000),
      slot: new Date(SLOT.getTime() + seq * 3_600_000), ...over,
    });
  };
  const versions = async (studyId: string) =>
    (await db.execute(sql`select id, version, status, body, drafted_by, autosaved_at from imaging_reports where study_id = ${studyId} order by version`))
      .rows as { id: string; version: number; status: string; body: Record<string, unknown>; drafted_by: string | null; autosaved_at: Date | null }[];
  const autosave = (actor: Actor, studyId: string, findings: string, now: Date) =>
    withTx(db, (tx) => autosaveDraft(tx, actor, { studyId, body: { findings }, impression: "", now }));
  const claimed = async () => (await db.select().from(events).where(eq(events.name, "imaging.reading_claimed")))
    .map((e) => e.payload as Record<string, unknown>);

  /* ── autosave ── */

  it("a Save after an autosave is its own frozen version; the next autosave cuts another after it", async () => {
    const s = await acquired();
    await autosave(fx.radiologist, s.studyId, "Typed.", min(0));
    const saved = await withTx(db, (tx) => draftReport(tx, fx.radiologist, { studyId: s.studyId, body: { findings: "Typed. Saved." } }));
    const next = await autosave(fx.radiologist, s.studyId, "Typed. Saved. More.", min(2));
    const rows = await versions(s.studyId);
    expect(rows.map((r) => [r.version, r.body.findings, r.drafted_by, r.autosaved_at === null])).toEqual([
      [1, "Typed.", fx.radiologist.id, false],
      [2, "Typed. Saved.", fx.radiologist.id, true],
      [3, "Typed. Saved. More.", fx.radiologist.id, false],
    ]);
    expect([saved.version, next.version, next.cut]).toEqual([2, 3, true]);
  });

  it("never writes over another reader's draft: B's autosave is B's own version, A's text stays", async () => {
    const s = await acquired();
    await autosave(fx.radiologist, s.studyId, "A's words.", min(0));
    await autosave(readerB, s.studyId, "B's words.", min(1));
    const rows = await versions(s.studyId);
    expect(rows.map((r) => [r.body.findings, r.drafted_by])).toEqual([["A's words.", fx.radiologist.id], ["B's words.", readerB.id]]);
  });

  it("is refused to somebody who does not write reports, and on a study still on the table", async () => {
    const s = await acquired();
    await expect(autosave(clerk, s.studyId, "x", min(0))).rejects.toMatchObject({ code: "forbidden" });
    await db.execute(sql`update imaging_studies set status = 'in_acquisition' where id = ${s.studyId}`);
    await expect(autosave(fx.radiologist, s.studyId, "x", min(0))).rejects.toMatchObject({ code: "report_not_signed" });
    expect(await versions(s.studyId)).toHaveLength(0);
  });

  it("the signature copies the autosaved text; the reading list calls the study signed, and nobody is shown reading it", async () => {
    const s = await acquired({ serviceCode: "XR-CHEST", deviceKey: "xray", dose: true });
    await withTx(db, (tx) => claimReading(tx, readerB, { studyId: s.studyId, now: min(0) }));
    const a = await withTx(db, (tx) => autosaveDraft(tx, fx.radiologist, {
      studyId: s.studyId, body: { findings: "Clear lungs." }, impression: "Normal chest radiograph.", now: min(1),
    }));
    await withTx(db, (tx) => signReport(tx, fx.radiologist, { studyId: s.studyId, reportId: a.reportId, secondFactorAt: min(1), now: min(2) }));
    const row = (await readingWorklist(db, fx.radiologist, min(3), { view: "all" })).find((r) => r.studyId === s.studyId)!;
    expect([row.reportState, row.readingBy]).toEqual(["signed", null]);
    const ctx = await readingContext(db, fx.radiologist, s.studyId, min(3));
    expect([ctx!.readingBy, ctx!.proposal, (ctx!.signed!.body as { findings: string }).findings]).toEqual([null, null, "Clear lungs."]);
  });

  /* ── the claim ── */

  it("a live claim is not taken by opening: B is told A holds it and nothing is written; B's take-over names A", async () => {
    const s = await acquired();
    await withTx(db, (tx) => claimReading(tx, fx.radiologist, { studyId: s.studyId, now: min(0) }));
    const held = await withTx(db, (tx) => claimReading(tx, readerB, { studyId: s.studyId, now: min(10) }));
    expect(held).toMatchObject({ claimed: false, heldBy: { userId: fx.radiologist.id, name: "dr.rao" } });
    expect(await claimed()).toHaveLength(1);
    const taken = await withTx(db, (tx) => claimReading(tx, readerB, { studyId: s.studyId, now: min(11), takeOver: true }));
    expect(taken).toMatchObject({ claimed: true, previousReaderId: fx.radiologist.id });
    expect((await claimed()).find((e) => e.readerId === readerB.id)).toEqual({ studyId: s.studyId, readerId: readerB.id, previousReaderId: fx.radiologist.id, tookOver: true });
    /** A's list now shows B reading. */
    const row = (await readingWorklist(db, fx.radiologist, min(12))).find((r) => r.studyId === s.studyId)!;
    expect(row.readingBy).toMatchObject({ userId: readerB.id });
  });

  it("re-opening one's own live claim refreshes it without an event, and an autosave keeps it alive past the hour", async () => {
    const s = await acquired();
    await withTx(db, (tx) => claimReading(tx, fx.radiologist, { studyId: s.studyId, now: min(0) }));
    await withTx(db, (tx) => claimReading(tx, fx.radiologist, { studyId: s.studyId, now: min(30) }));
    await autosave(fx.radiologist, s.studyId, "Still reading.", min(80));
    expect(await claimed()).toHaveLength(1);
    const row = (await readingWorklist(db, readerB, min(130))).find((r) => r.studyId === s.studyId)!;
    expect(row.readingBy).toMatchObject({ userId: fx.radiologist.id });
    expect((await readingWorklist(db, readerB, min(141))).find((r) => r.studyId === s.studyId)!.readingBy).toBeNull();
  });

  /* ── assignment and pools ── */

  it("assignment needs the consultant's grant and a reader; the assignee's name rides the list row", async () => {
    const s = await acquired();
    await expect(withTx(db, (tx) => assignReader(tx, fx.radiographer, { studyId: s.studyId, readerId: readerB.id })))
      .rejects.toMatchObject({ code: "forbidden" });
    await expect(withTx(db, (tx) => assignReader(tx, fx.radiologist, { studyId: s.studyId, readerId: clerk.id })))
      .rejects.toMatchObject({ code: "not_a_reader" });
    await withTx(db, (tx) => assignReader(tx, fx.radiologist, { studyId: s.studyId, readerId: readerB.id }));
    const row = (await readingWorklist(db, fx.radiologist, min(0))).find((r) => r.studyId === s.studyId)!;
    expect(row.assignedTo).toEqual({ userId: readerB.id, name: "dr.iyer" });
    await withTx(db, (tx) => assignReader(tx, fx.radiologist, { studyId: s.studyId, readerId: null }));
    expect((await readingWorklist(db, fx.radiologist, min(1))).find((r) => r.studyId === s.studyId)!.assignedTo).toBeNull();
  });

  it("the book refuses two pools of one name; body parts narrow a pool; a consultant's context lists the assignable readers", async () => {
    const book = (pools: unknown) => ({
      signatories: [{ user_id: fx.radiologist.id, qualification: "MBBS, MD (Radiodiagnosis)", council_reg_no: "JSMC · 2014/1187" }],
      reading_pools: pools,
    });
    expect(() => parseDefinitionBody("report_signatories", book([
      { name: "CT", modalities: ["ct"], readers: ["a"] }, { name: "CT", modalities: ["mri"], readers: ["b"] },
    ]))).toThrow(/two reading pools share a name/);
    const pools = parseDefinitionBody("report_signatories", book([
      { name: "Neuro", modalities: ["ct", "mri"], body_parts: ["head"], readers: [readerB.id] },
      { name: "Body CT", modalities: ["ct"], readers: [fx.radiologist.id] },
    ])).reading_pools!;
    expect([readingPoolFor(pools, { modality: "ct", body_part: "head" }), readingPoolFor(pools, { modality: "ct", body_part: "abdomen" }),
      readingPoolFor(pools, { modality: "usg", body_part: "abdomen" })]).toEqual(["Neuro", "Body CT", null]);

    await db.update(imagingDefinitions).set({ status: "superseded" }).where(eq(imagingDefinitions.kind, "report_signatories"));
    await db.insert(imagingDefinitions).values({
      id: newId(), kind: "report_signatories", version: 9, status: "active", draftedBy: "t", publishedBy: "t", publishedAt: NOW,
      body: book([{ name: "Neuro", modalities: ["ct"], readers: [readerB.id, clerk.id] }]),
    });
    const s = await acquired();
    const ctx = await readingContext(db, fx.radiologist, s.studyId, min(0));
    expect(ctx!.readers.map((r) => r.name)).toEqual(["dr.iyer", "dr.rao"]);
  });

  /* ── the routes ── */

  it("the three new routes parse their bodies and reach the acts: claim with no body, autosave, assign; and the list's view", async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [RadiologyReadingController, RadiologyReportsController],
      providers: [
        { provide: DB, useValue: db },
        { provide: MODULE_REGISTRY, useValue: new ModuleRegistry() },
        { provide: CONFIG, useValue: { secondFactorWindowMinutes: 15 } },
        { provide: APP_GUARD, useClass: ActorFromHeader },
      ],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    try {
      const server = app.getHttpServer() as Parameters<typeof request>[0];
      const s = await acquired();
      const as = (r: request.Test) => r.set("x-actor", fx.radiologist.id);
      const claim = await as(request(server).post(`/radiology/reading/studies/${s.studyId}/claim`));
      expect([claim.status, claim.body.claimed]).toEqual([201, true]);
      expect((await as(request(server).post(`/radiology/reading/studies/${s.studyId}/claim`).send({ takeOver: "yes" }))).status).toBe(400);

      const saved = await as(request(server).post(`/radiology/studies/${s.studyId}/reports/autosave`).send({ body: { findings: "Typed." }, impression: "" }));
      expect([saved.status, saved.body.cut]).toEqual([201, true]);
      expect((await as(request(server).post(`/radiology/studies/${s.studyId}/reports/autosave`).send({ body: "Typed." }))).status).toBe(400);

      expect((await as(request(server).post(`/radiology/reading/studies/${s.studyId}/assign`).send({ readerId: readerB.id, note: "x" }))).status).toBe(400);
      const assigned = await as(request(server).post(`/radiology/reading/studies/${s.studyId}/assign`).send({ readerId: readerB.id }));
      expect([assigned.status, assigned.body.assignedReaderId]).toEqual([201, readerB.id]);

      const mine = await request(server).get("/radiology/reading/worklist").set("x-actor", readerB.id);
      const all = await request(server).get("/radiology/reading/worklist?view=all").set("x-actor", readerB.id);
      expect([mine.status, all.status]).toEqual([200, 200]);
      expect(all.body.rows.find((r: { studyId: string }) => r.studyId === s.studyId).assignedTo).toEqual({ userId: readerB.id, name: "dr.iyer" });
    } finally {
      await app.close();
    }
  });

  /* ── the drafter ── */

  it("the reading context carries the newest proposal with its per-section sources until a human writes", async () => {
    const s = await acquired({ serviceCode: "CT-HEAD", deviceKey: "ct", dose: true });
    const p = await withTx(db, (tx) => proposeDraft(tx, fx.radiologist, { studyId: s.studyId, now: min(0) }));
    const ctx = await readingContext(db, fx.radiologist, s.studyId, min(1));
    expect(ctx!.working).toBeNull();
    expect(ctx!.proposal).toMatchObject({ reportId: p.reportId, body: { technique: p.body.technique } });
    expect(ctx!.proposal!.sections.technique!.sources.map((x) => x.kind)).toEqual(["study_type"]);
  });

  it("the numbers check passes every sentence the offline drafter writes, and catches a rounded dose", async () => {
    const FACTS: DrafterFacts = {
      studyId: "s1", accessionNo: "X1",
      studyType: { code: "CT-ABDO", name: "CT abdomen 3-phase", modality: "ct", body_part: "abdomen", contrast_option: "required", ionising: true },
      laterality: "left", lockoutTier: "coded", contrastGiven: true, contrastAgent: "Iohexol 350", contrastVolumeMl: "80.00",
      dose: { ctdivol: "6.400", dlp: "320.500", dap: "12.000", fluoroSeconds: 45 }, outside: null,
      prior: { reportId: "r0", studyId: "s0", accessionNo: "X2608010001", studyDate: "2026-08-01", studyTypeName: "CT abdomen 3-phase" },
      contrastAdministrationIds: ["ca1"],
    };
    for (const facts of [FACTS, { ...FACTS, outside: { id: "o1", centreName: "Sector 5 Imaging", studyDate: "2026-02-14", arrival: "cd" } }]) {
      const p = await offlineTemplateDrafter.draft(facts, NOW);
      expect(proposalNumberHits(p)).toEqual([]);
    }
    const p = await offlineTemplateDrafter.draft(FACTS, NOW);
    expect(p.body.comparison).toBe("Compared with CT abdomen 3-phase of 2026-08-01, accession X2608010001.");
    expect(p.provenance.sections!.technique!.sources.map((x) => x.kind)).toEqual(["study_type", "contrast_register", "dose_record"]);
    const rounded = { ...p, body: { ...p.body, technique: p.body.technique!.replace("6.400", "6.4") } };
    expect(proposalNumberHits(rounded)).toEqual([{ section: "technique", number: "6.4" }]);
    const findings = { ...p, body: { ...p.body, findings: "A 12 mm cyst." } };
    expect(proposalNumberHits(findings)).toEqual([{ section: "findings", number: "12" }]);
  });
});
