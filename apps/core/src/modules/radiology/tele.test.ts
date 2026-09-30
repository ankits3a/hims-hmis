import { and, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { acquireStudy, setupRadiologyFixture } from "../../../test/helpers/radiology";
import { mkUser } from "../../../test/helpers/opd";
import { newId } from "@hmis/contracts";
import { events, imagingDefinitions, imagingPeerReviews, imagingReports, imagingStudies, imagingTeleReads, orders } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { amendReport, draftReport, overReadNightPrelim, publishReport, savePrelim, signReport } from "./reports";
import { parseDefinitionBody } from "./definitions";
import { teleBoard } from "./tele";
import { doctorResultsInbox } from "./closed-loop";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18-S RS8c T3 — **NIGHT READS (ruling 7).** A radiologist listed in the teleradiology book
 * issues PRELIMS only; the prelim opens an over-read row with the reader's NMC number and the
 * ruling's clock; the morning consultant concurs or corrects, the hospital's report is signed and
 * released in that act, and a discrepancy goes to blind peer review. Fixed clocks only.
 */
describe("night reads (18-S RS8c T3)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;
  let tele: Actor;
  let seq = 0;

  const NOW = new Date("2026-08-31T20:00:00.000Z"); // 01:30 IST — a night read
  const SLOT = new Date("2026-08-31T09:00:00.000Z");

  const BOOK = (readerId: string) => ({
    providers: [{
      key: "nightrad", name: "NightRad Teleradiology Pvt Ltd", dpa_signed_on: "2026-07-01", data_in_india: true,
      readers: [{ user_id: readerId, name: "Dr Kavya Menon", nmc_reg_no: "NMC/KA/2011/4471" }],
    }],
  });

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: "2026-08-31", now: NOW });
    seq = 0;
    ({ actor: tele } = await mkUser(db, "tele.menon", ["radiology_resident"]));
    await db.insert(imagingDefinitions).values({
      id: newId(), kind: "teleradiology", version: 1, status: "active", draftedBy: "t", publishedBy: "t", publishedAt: NOW,
      body: parseDefinitionBody("teleradiology", BOOK(tele.id)),
    });
  });
  afterEach(() => { fx.unregister(); });

  const acquired = async () => {
    seq += 1;
    const at = new Date(NOW.getTime() + seq * 25 * 3_600_000);
    const s = await acquireStudy(db, fx, { idemKey: `tr${String(seq)}`, now: at, slot: new Date(SLOT.getTime() + seq * 3_600_000) });
    return { ...s, at };
  };
  const prelim = async (studyId: string, at: Date) =>
    await withTx(db, (tx) => savePrelim(tx, tele, {
      studyId, body: { findings: "Liver normal. No free fluid." }, impression: "No acute abdominal finding.",
    }).then(async (r) => { await tx.update(imagingTeleReads).set({ prelimAt: at }).where(eq(imagingTeleReads.prelimReportId, r.reportId)); return r; }));
  const over = (who: Actor, teleReadId: string, grade: string, extra: Record<string, unknown> = {}, at = NOW) =>
    withTx(db, (tx) => overReadNightPrelim(tx, who, fx.decls, {
      teleReadId, grade, secondFactorAt: new Date(at.getTime() - 60_000), now: at, ...extra,
    }));
  const teleRow = async (studyId: string) => (await db.select().from(imagingTeleReads).where(eq(imagingTeleReads.studyId, studyId)))[0]!;

  it("the book refuses a provider that cannot say the data stays in India, or a reader with no NMC number", () => {
    const b = BOOK("u1");
    expect(() => parseDefinitionBody("teleradiology", { ...b, providers: [{ ...b.providers[0]!, data_in_india: false }] })).toThrow(/definition is invalid/);
    expect(() => parseDefinitionBody("teleradiology", { ...b, providers: [{ ...b.providers[0]!, readers: [{ user_id: "u1", name: "Dr X", nmc_reg_no: "" }] }] })).toThrow(/definition is invalid/);
    expect(parseDefinitionBody("teleradiology", b).prelim_minutes).toEqual({ stat: 30, urgent: 60 });
  });

  it("a listed reader's prelim carries the provider and opens ONE over-read row with the NMC number and the STAT clock", async () => {
    const s = await acquired();
    const p1 = await prelim(s.studyId, s.at);
    const [row] = await db.select().from(imagingReports).where(eq(imagingReports.id, p1.reportId));
    expect([row!.status, row!.externalReporterId]).toEqual(["prelim", "nightrad"]);
    const t = await teleRow(s.studyId);
    expect(t).toMatchObject({ state: "awaiting", readerId: tele.id, readerName: "Dr Kavya Menon", readerNmcNo: "NMC/KA/2011/4471", providerName: "NightRad Teleradiology Pvt Ltd", priority: "stat", targetMinutes: 30 });
    const p2 = await prelim(s.studyId, s.at);
    const again = await db.select().from(imagingTeleReads).where(eq(imagingTeleReads.studyId, s.studyId));
    expect(again.map((r) => r.prelimReportId)).toEqual([p2.reportId]);
    /** An in-house prelim carries no provider and opens nothing. */
    const s2 = await acquired();
    const own = await withTx(db, (tx) => savePrelim(tx, fx.radiologist, { studyId: s2.studyId, body: { findings: "x y z" }, impression: "Normal." }));
    expect((await db.select().from(imagingReports).where(eq(imagingReports.id, own.reportId)))[0]!.externalReporterId).toBeNull();
    expect(await db.select().from(imagingTeleReads).where(eq(imagingTeleReads.studyId, s2.studyId))).toHaveLength(0);
  });

  it("a listed reader never signs, even holding the consultant's role — the identity decides, not the grant", async () => {
    const { actor: both } = await mkUser(db, "tele.both", ["radiologist"]);
    await db.update(imagingDefinitions).set({ body: parseDefinitionBody("teleradiology", BOOK(both.id)) }).where(eq(imagingDefinitions.kind, "teleradiology"));
    const s = await acquired();
    const d = await withTx(db, (tx) => draftReport(tx, both, { studyId: s.studyId, body: { findings: "Normal." }, impression: "Normal." }));
    await expect(withTx(db, (tx) => signReport(tx, both, { studyId: s.studyId, reportId: d.reportId, secondFactorAt: new Date(s.at.getTime() - 60_000), now: s.at })))
      .rejects.toMatchObject({ code: "tele_reader_prelim_only" });
    const d2 = await withTx(db, (tx) => draftReport(tx, fx.radiologist, { studyId: s.studyId, body: { findings: "Normal." }, impression: "Normal." }));
    await withTx(db, (tx) => signReport(tx, fx.radiologist, { studyId: s.studyId, reportId: d2.reportId, secondFactorAt: new Date(s.at.getTime() - 60_000), now: s.at }));
    await expect(withTx(db, (tx) => amendReport(tx, both, {
      studyId: s.studyId, reason: "x", secondFactorAt: new Date(s.at.getTime() - 60_000), now: s.at, body: { findings: "y" }, impression: "y",
    }))).rejects.toMatchObject({ code: "tele_reader_prelim_only" });
  });

  it("CONCUR signs the prelim's words as the hospital's report and releases it; no peer case", async () => {
    const s = await acquired();
    await prelim(s.studyId, s.at);
    const t = await teleRow(s.studyId);
    const out = await over(fx.radiologist, t.id, "concur", {}, s.at);
    const [final] = await db.select().from(imagingReports).where(eq(imagingReports.id, out.finalReportId));
    expect([final!.status, final!.signerId, final!.impression, final!.externalReporterId, final!.publishedAt !== null])
      .toEqual(["signed", fx.radiologist.id, "No acute abdominal finding.", null, true]);
    expect(await teleRow(s.studyId)).toMatchObject({ state: "concur", overreadBy: fx.radiologist.id, finalReportId: out.finalReportId });
    expect(await db.select().from(imagingPeerReviews)).toHaveLength(0);
    const evs = await db.select().from(events).where(eq(events.name, "imaging.overread_recorded"));
    expect(evs.map((e) => (e.payload as { grade: string }).grade)).toEqual(["concur"]);
    await expect(over(fx.radiologist, t.id, "concur", {}, s.at)).rejects.toMatchObject({ code: "already_resolved" });
  });

  it("MAJOR signs the consultant's corrected words, logs the line and opens a blind peer case against the night reader", async () => {
    const s = await acquired();
    await prelim(s.studyId, s.at);
    const t = await teleRow(s.studyId);
    await expect(over(fx.radiologist, t.id, "major", { impression: "Splenic laceration." }, s.at)).rejects.toMatchObject({ code: "reason_required" });
    await expect(over(fx.radiologist, t.id, "major", { note: "Missed splenic laceration" }, s.at)).rejects.toMatchObject({ code: "impression_required" });
    const out = await over(fx.radiologist, t.id, "major", {
      note: "Missed a grade II splenic laceration", findings: "Grade II splenic laceration with perisplenic fluid.", impression: "Splenic laceration.",
    }, s.at);
    const [final] = await db.select().from(imagingReports).where(eq(imagingReports.id, out.finalReportId));
    expect([final!.status, final!.impression, (final!.body as { findings: string }).findings])
      .toEqual(["signed", "Splenic laceration.", "Grade II splenic laceration with perisplenic fluid."]);
    expect(await teleRow(s.studyId)).toMatchObject({ state: "major", overreadNote: "Missed a grade II splenic laceration" });
    const peer = await db.select().from(imagingPeerReviews);
    expect(peer.map((p) => [p.readerId, p.trigger, p.reportId])).toEqual([[tele.id, "overread_discrepancy", t.prelimReportId]]);
    /** The treating doctor's inbox shows the released report UNREAD, with the major discrepancy beside it. */
    await db.update(orders).set({ orderingClinicianId: fx.doctor.id }).where(eq(orders.id, s.orderId));
    const inbox = await doctorResultsInbox(db, fx.doctor, s.at);
    expect(inbox.map((r) => [r.reportId, r.state, r.overread])).toEqual([[out.finalReportId, "unread", { grade: "major", providerName: "NightRad Teleradiology Pvt Ltd" }]]);
  });

  it("the over-read is a consultant's: a resident and the night reader are refused", async () => {
    const s = await acquired();
    await prelim(s.studyId, s.at);
    const t = await teleRow(s.studyId);
    const { actor: resident } = await mkUser(db, "dr.resident", ["radiology_resident"]);
    await expect(over(resident, t.id, "concur", {}, s.at)).rejects.toMatchObject({ code: "overread_not_consultant" });
    await expect(over(tele, t.id, "concur", {}, s.at)).rejects.toMatchObject({ code: "tele_reader_prelim_only" });
    expect(await teleRow(s.studyId)).toMatchObject({ state: "awaiting" });
  });

  it("a report already signed in the morning is AMENDED by a minor over-read, the reason naming the partner", async () => {
    const s = await acquired();
    await prelim(s.studyId, s.at);
    const d = await withTx(db, (tx) => draftReport(tx, fx.radiologist, { studyId: s.studyId, body: { findings: "Liver normal." }, impression: "Normal." }));
    const first = await withTx(db, (tx) => signReport(tx, fx.radiologist, { studyId: s.studyId, reportId: d.reportId, secondFactorAt: new Date(s.at.getTime() - 60_000), now: s.at }));
    await withTx(db, (tx) => publishReport(tx, fx.radiologist, fx.decls, { studyId: s.studyId, now: s.at }));
    const t = await teleRow(s.studyId);
    const out = await over(fx.radiologist, t.id, "minor", { note: "Gallbladder polyp not mentioned", impression: "4 mm gallbladder polyp." }, s.at);
    const [final] = await db.select().from(imagingReports).where(eq(imagingReports.id, out.finalReportId));
    expect([final!.supersedesId, final!.amendmentReason?.includes("NightRad Teleradiology Pvt Ltd"), final!.publishedAt !== null]).toEqual([first.reportId, true, true]);
    const [st] = await db.select().from(imagingStudies).where(eq(imagingStudies.id, s.studyId));
    expect(st!.status).toBe("published");
  });

  it("the board: the queue with the TAT against the ruling's clock, then the discrepancy log", async () => {
    const s = await acquired();
    await prelim(s.studyId, new Date(s.at.getTime() + 42 * 60_000));
    const board = await teleBoard(db, fx.radiologist, new Date(s.at.getTime() + 3_600_000));
    expect(board.configured).toBe(true);
    expect(board.queue).toEqual([expect.objectContaining({ accessionNo: s.accessionNo, tatMinutes: 42, targetMinutes: 30, late: true, readerNmcNo: "NMC/KA/2011/4471" })]);
    expect(board.summary).toMatchObject({ prelims30: 1, late30: 1, awaiting: 1 });
    await over(fx.radiologist, board.queue[0]!.teleReadId, "minor", { note: "Measured 9 not 6 mm", impression: "9 mm cyst." }, s.at);
    const after = await teleBoard(db, fx.radiologist, new Date(s.at.getTime() + 3_600_000));
    expect([after.queue.length, after.log.map((l) => l.state), after.summary.minor30]).toEqual([0, ["minor"], 1]);
    expect(await db.select().from(imagingTeleReads).where(and(eq(imagingTeleReads.studyId, s.studyId), eq(imagingTeleReads.state, "awaiting")))).toHaveLength(0);
  });
});
