import { eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { acquireStudy, setupRadiologyFixture } from "../../../../test/helpers/radiology";
import { mkUser } from "../../../../test/helpers/opd";
import { events, imagingDefinitions, imagingStudies } from "../../../kernel/db/schema";
import { withTx } from "../../../kernel/db/client";
import { ModuleRegistry } from "../../../kernel/modules/loader";
import { grantPermissionToRole, syncPermissions } from "../../../kernel/auth/permissions";
import * as radiology from "../index";
import { offlineTemplateDrafter, setActiveDrafter } from "../drafter";
import type { ReportDrafter } from "../drafter";
import type { RadiologyFixture } from "../../../../test/helpers/radiology";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../../kernel/db/client";

/**
 * ACCEPTANCE — issue #1081, spec docs/specs/1081-imaging-reading-room.md (owner APPROVED 2026-11-14):
 * draft autosave with history, a reading claim without PACS, reading pools and "my list", and the
 * drafter's comparison line with a source per drafted section and a numbers check.
 *
 * The new acts are reached through the module's `index.ts` by name, so each check fails on its own
 * before they exist. The new columns are read with SQL for the same reason.
 *
 * Every act and read is given its instant; nothing here reads the clock. The fixture's day is the
 * shared radiology fixture's.
 */

type Fn = (...args: never[]) => Promise<unknown>;
function act<T extends Fn>(name: string): T {
  const f = (radiology as Record<string, unknown>)[name];
  if (typeof f !== "function") throw new Error(`radiology does not export ${name}`);
  return f as T;
}

type AutosaveInput = {
  studyId: string; body: Record<string, unknown>; impression?: string | null; templateKey?: string; now: Date;
};
type Autosave = (tx: Tx, actor: Actor, input: AutosaveInput) => Promise<{ reportId: string; version: number }>;
type Claim = (tx: Tx, actor: Actor, input: { studyId: string; now: Date; takeOver?: boolean }) => Promise<unknown>;
type Assign = (tx: Tx, actor: Actor, input: { studyId: string; readerId: string | null; now?: Date }) => Promise<unknown>;
type ListRow = { studyId: string; readingBy: { userId: string; name: string } | null };
type List = (db: Db, actor: Actor, now: Date, opts?: { view?: "mine" | "all" }) => Promise<ListRow[]>;
type Context = (db: Db, actor: Actor, studyId: string, now: Date) => Promise<{
  working: { reportId: string; body: Record<string, unknown> } | null;
} | null>;
type Propose = (tx: Tx, actor: Actor, input: { studyId: string; now: Date }) => Promise<{
  body: Record<string, string>;
  provenance: { sections?: Record<string, { sources: { kind: string; ref: string }[] }> };
}>;
type Draft = (tx: Tx, actor: Actor, input: { studyId: string; body: Record<string, unknown>; impression?: string | null }) => Promise<{ reportId: string }>;
type Sign = (tx: Tx, actor: Actor, input: { studyId: string; reportId: string; secondFactorAt: Date | null; now: Date }) => Promise<unknown>;

type ReportRowSql = { id: string; version: number; status: string; body: Record<string, unknown>; drafted_by: string | null };

describe("spec #1081 — the reading room", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;
  let readerB: Actor;
  let seq = 0;

  const DAY = "2026-08-31";
  const NOW = new Date("2026-08-31T06:00:00.000Z");
  const SLOT = new Date("2026-08-31T09:00:00.000Z");
  /** Every act below happens on the tenth day, after the studies' own (25-hour-spaced) instants. */
  const T = new Date(NOW.getTime() + 10 * 86_400_000);
  const min = (m: number): Date => new Date(T.getTime() + m * 60_000);

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    seq = 0;
    setActiveDrafter(null);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    const perms = ["radiology.reports.write", "radiology.reports.read", "radiology.reports.amend", "radiology.reports.sign"];
    const registry = new ModuleRegistry();
    registry.install({ key: "radiology", title: "R", menu: [], permissions: perms, subscriptions: [] });
    await syncPermissions(db, registry);
    for (const p of perms) await grantPermissionToRole(db, registry, "radiologist", p);
    ({ actor: readerB } = await mkUser(db, "dr.iyer", ["radiologist"]));
  });
  afterEach(() => { fx.unregister(); setActiveDrafter(null); });

  const acquired = async (over: { serviceCode?: string; deviceKey?: string; dose?: boolean } = {}) => {
    seq += 1;
    return await acquireStudy(db, fx, {
      idemKey: `rr1081-${String(seq)}`, now: new Date(NOW.getTime() + seq * 25 * 3_600_000),
      slot: new Date(SLOT.getTime() + seq * 3_600_000), ...over,
    });
  };
  const ct = () => acquired({ serviceCode: "CT-HEAD", deviceKey: "ct", dose: true });
  const mri = () => acquired({ serviceCode: "MRI-BRAIN", deviceKey: "mri" });
  const versions = async (studyId: string): Promise<ReportRowSql[]> =>
    (await db.execute(sql`select id, version, status, body, drafted_by from imaging_reports where study_id = ${studyId} order by version`)).rows as ReportRowSql[];
  const autosave = (actor: Actor, input: AutosaveInput) =>
    withTx(db, (tx) => act<Autosave>("autosaveDraft")(tx, actor, input));
  const claim = (actor: Actor, studyId: string, now: Date, takeOver?: boolean) =>
    withTx(db, (tx) => act<Claim>("claimReading")(tx, actor, { studyId, now, ...(takeOver === undefined ? {} : { takeOver }) }));
  const publishSignatories = async (extra: Record<string, unknown>) => {
    await db.update(imagingDefinitions).set({ status: "superseded" }).where(eq(imagingDefinitions.kind, "report_signatories"));
    await db.insert(imagingDefinitions).values({
      id: newId(), kind: "report_signatories", version: 9, status: "active", draftedBy: "t", publishedBy: "t", publishedAt: NOW,
      body: {
        signatories: [{ user_id: fx.radiologist.id, qualification: "MBBS, MD (Radiodiagnosis)", council_reg_no: "Jharkhand State Medical Council · 2014/1187" }],
        ...extra,
      },
    });
  };
  const POOLS = () => ({
    reading_pools: [
      { name: "CT", modalities: ["ct"], readers: [fx.radiologist.id] },
      { name: "Neuro MRI", modalities: ["mri"], readers: [readerB.id] },
    ],
  });
  const signFor = async (studyId: string, impression: string) => {
    const d = await withTx(db, (tx) => act<Draft>("draftReport")(tx, fx.radiologist, {
      studyId, body: { technique: "CT head.", findings: "No acute intracranial abnormality." }, impression,
    }));
    await withTx(db, (tx) => act<Sign>("signReport")(tx, fx.radiologist, {
      studyId, reportId: d.reportId, secondFactorAt: new Date(min(0).getTime() - 60_000), now: min(0),
    }));
  };

  /* ───────────────────────────── D1–D4: autosave ───────────────────────────── */

  it("spec #1081 D1: two autosaves within 10 minutes leave one draft version holding the second text, with drafted_by the reader", async () => {
    const s = await acquired();
    const first = await autosave(fx.radiologist, { studyId: s.studyId, body: { findings: "Liver nor" }, impression: "", now: min(0) });
    const second = await autosave(fx.radiologist, { studyId: s.studyId, body: { findings: "Liver normal in size." }, impression: "Normal study.", now: min(4) });
    const rows = await versions(s.studyId);
    expect(rows).toHaveLength(1);
    expect(second.reportId).toBe(first.reportId);
    expect([rows[0]!.status, rows[0]!.body.findings, rows[0]!.drafted_by]).toEqual(["draft", "Liver normal in size.", fx.radiologist.id]);
  });

  it("spec #1081 D2: an autosave 11 minutes after the first cuts a second version and leaves the first unchanged", async () => {
    const s = await acquired();
    await autosave(fx.radiologist, { studyId: s.studyId, body: { findings: "First words." }, now: min(0) });
    await autosave(fx.radiologist, { studyId: s.studyId, body: { findings: "First words. Second words." }, now: min(11) });
    const rows = await versions(s.studyId);
    expect(rows.map((r) => [r.version, r.status, r.body.findings, r.drafted_by])).toEqual([
      [1, "draft", "First words.", fx.radiologist.id],
      [2, "draft", "First words. Second words.", fx.radiologist.id],
    ]);
  });

  it("spec #1081 D3: the reading context returns the reader's working draft after an autosave", async () => {
    const s = await acquired();
    const saved = await autosave(fx.radiologist, { studyId: s.studyId, body: { findings: "Gall bladder calculus, 9 mm." }, impression: "Cholelithiasis.", now: min(0) });
    const ctx = await act<Context>("readingContext")(db, fx.radiologist, s.studyId, min(1));
    expect(ctx!.working).toMatchObject({ reportId: saved.reportId, body: { findings: "Gall bladder calculus, 9 mm." } });
  });

  it("spec #1081 D4: an autosave on a study whose report is signed is refused and writes nothing", async () => {
    const s = await ct();
    await signFor(s.studyId, "Normal CT head.");
    const before = await versions(s.studyId);
    await expect(autosave(fx.radiologist, { studyId: s.studyId, body: { findings: "Late words." }, now: min(2) }))
      .rejects.toMatchObject({ code: "already_signed" });
    expect(await versions(s.studyId)).toEqual(before);
  });

  /* ───────────────────────────── D5–D6: the claim ───────────────────────────── */

  it("spec #1081 D5: after reader A claims a study, reader B's list shows A as reading, with no PACS configured and no image view recorded", async () => {
    const s = await acquired();
    await claim(fx.radiologist, s.studyId, min(0));
    expect(await radiology.pacsArchiveConfigured(db)).toBe(false);
    expect((await db.execute(sql`select count(*)::int as n from imaging_image_views`)).rows[0]).toEqual({ n: 0 });
    const rows = await act<List>("readingWorklist")(db, readerB, min(5));
    expect(rows.find((r) => r.studyId === s.studyId)!.readingBy).toMatchObject({ userId: fx.radiologist.id, name: "dr.rao" });
  });

  it("spec #1081 D6: a claim 61 minutes old is not shown; B's take-over appends an event naming A", async () => {
    const s = await acquired();
    await claim(fx.radiologist, s.studyId, min(0));
    const rows = await act<List>("readingWorklist")(db, readerB, min(61));
    expect(rows.find((r) => r.studyId === s.studyId)!.readingBy).toBeNull();
    await claim(readerB, s.studyId, min(61), true);
    const claimed = await db.select().from(events).where(eq(events.name, "imaging.reading_claimed"));
    const last = claimed.map((e) => e.payload as Record<string, unknown>).filter((p) => p.readerId === readerB.id);
    expect(last).toHaveLength(1);
    expect(last[0]).toMatchObject({ studyId: s.studyId, readerId: readerB.id, previousReaderId: fx.radiologist.id });
  });

  /* ───────────────────────────── D7–D8: pools ───────────────────────────── */

  it("spec #1081 D7: acquisition of a CT stamps the pool the published book maps CT to; with no pools published the pool is empty", async () => {
    const pool = async (studyId: string) =>
      ((await db.execute(sql`select reading_pool from imaging_studies where id = ${studyId}`)).rows[0] as { reading_pool: string | null }).reading_pool;
    const unpooled = await ct();
    expect(await pool(unpooled.studyId)).toBeNull();
    await publishSignatories(POOLS());
    const pooled = await ct();
    expect(await pool(pooled.studyId)).toBe("CT");
  });

  it("spec #1081 D8: \"my list\" for a CT-pool reader returns CT studies and studies assigned to them, and no MRI-pool study; \"all\" returns both", async () => {
    await publishSignatories(POOLS());
    const ctStudy = await ct();
    const mriOther = await mri();
    const mriAssigned = await mri();
    const stamped = await db.execute(sql`select id, reading_pool from imaging_studies where id in (${ctStudy.studyId}, ${mriOther.studyId}, ${mriAssigned.studyId})`);
    expect(new Set((stamped.rows as { reading_pool: string }[]).map((r) => r.reading_pool))).toEqual(new Set(["CT", "Neuro MRI"]));
    await withTx(db, (tx) => act<Assign>("assignReader")(tx, readerB, { studyId: mriAssigned.studyId, readerId: fx.radiologist.id, now: min(0) }));

    const list = act<List>("readingWorklist");
    const mine = (await list(db, fx.radiologist, min(1), { view: "mine" })).map((r) => r.studyId);
    expect(mine).toEqual(expect.arrayContaining([ctStudy.studyId, mriAssigned.studyId]));
    expect(mine).not.toContain(mriOther.studyId);
    const all = (await list(db, fx.radiologist, min(1), { view: "all" })).map((r) => r.studyId);
    expect(all).toEqual(expect.arrayContaining([ctStudy.studyId, mriOther.studyId, mriAssigned.studyId]));
  });

  /* ───────────────────────────── D9–D10: the drafter ───────────────────────────── */

  it("spec #1081 D9: the proposed draft carries a comparison line naming the latest prior's date and accession, with that report as the section's source; with no prior the section is empty", async () => {
    const propose = act<Propose>("proposeDraft");
    const first = await ct();
    const none = await withTx(db, (tx) => propose(tx, fx.radiologist, { studyId: first.studyId, now: min(0) }));
    expect(none.body.comparison ?? "").toBe("");
    expect(none.provenance.sections?.comparison).toBeUndefined();

    await signFor(first.studyId, "Normal CT head.");
    /** A different modality, signed later: not a comparison for a CT head. */
    const xr = await acquired({ serviceCode: "XR-CHEST", deviceKey: "xray", dose: true });
    const dXr = await withTx(db, (tx) => act<Draft>("draftReport")(tx, fx.radiologist, { studyId: xr.studyId, body: { findings: "Clear lungs." }, impression: "Normal chest radiograph." }));
    await withTx(db, (tx) => act<Sign>("signReport")(tx, fx.radiologist, { studyId: xr.studyId, reportId: dXr.reportId, secondFactorAt: min(1), now: min(2) }));

    const second = await ct();
    const out = await withTx(db, (tx) => propose(tx, fx.radiologist, { studyId: second.studyId, now: min(3) }));
    const [prior] = (await db.execute(sql`
      select s.accession_no, s.acquired_at, r.id as report_id from imaging_studies s
      join imaging_reports r on r.study_id = s.id and r.status = 'signed' where s.id = ${first.studyId}`)).rows as { accession_no: string; acquired_at: Date | string; report_id: string }[];
    const priorDay = new Date(prior!.acquired_at).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    expect(out.body.comparison).toContain(priorDay);
    expect(out.body.comparison).toContain(prior!.accession_no);
    expect(out.provenance.sections?.comparison?.sources).toEqual([expect.objectContaining({ kind: "prior_report", ref: prior!.report_id })]);
  });

  it("spec #1081 D10: a drafter fixture that emits a number absent from its named source rows is refused", async () => {
    const s = await ct();
    const inventive: ReportDrafter = {
      key: "inventive", version: "0",
      draft: async (facts, now) => {
        const p = await offlineTemplateDrafter.draft(facts, now);
        return {
          ...p,
          body: { ...p.body, technique: "CT: Study CT-HEAD. Dose: CTDIvol 9.9 mGy." },
          provenance: {
            ...p.provenance, drafter: "inventive",
            sections: { technique: { sources: [{ kind: "study_type", ref: "CT-HEAD", values: { code: "CT-HEAD", name: "Study CT-HEAD", modality: "ct" } }] } },
          } as never,
        };
      },
    };
    setActiveDrafter(inventive);
    await expect(withTx(db, (tx) => act<Propose>("proposeDraft")(tx, fx.radiologist, { studyId: s.studyId, now: min(0) })))
      .rejects.toMatchObject({ code: "drafted_number_unsourced" });
    expect(await versions(s.studyId)).toHaveLength(0);
    expect((await db.select().from(imagingStudies).where(eq(imagingStudies.id, s.studyId)))[0]!.status).toBe("acquired");
  });
});
