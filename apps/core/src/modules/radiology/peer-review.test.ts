import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { FIXTURE_COUNCIL_REG, FIXTURE_QUALIFICATION, acquireStudy, setupRadiologyFixture } from "../../../test/helpers/radiology";
import { mkUser } from "../../../test/helpers/opd";
import { newId } from "@hmis/contracts";
import { imagingDefinitions, imagingPeerReviews } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { amendReport, draftReport, signReport } from "./reports";
import {
  drawPeerSample, istMonthWindow, peerBoard, peerCase, previousIstMonth, sampleSize, scorePeerReview,
} from "./peer-review";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18-S RS8c T2 — **PEER REVIEW (RADPEER), BLIND.** A random ⌈3 %⌉ (at least one) of each
 * reader's first signatures per IST month, plus every amended version; the reviewer never sees who
 * wrote it, never gets their own, and a discrepancy says what it was. Fixed clocks only.
 */
describe("peer review — the sample size and the IST month (pure)", () => {
  it("samples ⌈3 %⌉ of a reader's month, at least one", () => {
    expect([0, 1, 33, 34, 100, 1000].map(sampleSize)).toEqual([0, 1, 1, 2, 3, 30]);
  });
  it("an IST month starts at 18:30 UTC the evening before", () => {
    expect(istMonthWindow("2026-09")).toEqual({
      start: new Date("2026-08-31T18:30:00.000Z"), end: new Date("2026-09-30T18:30:00.000Z"),
    });
    /** 2026-09-30T19:00Z is 00:30 IST on 1 October — the month just closed is September. */
    expect(previousIstMonth(new Date("2026-09-30T19:00:00.000Z"))).toBe("2026-09");
    expect(previousIstMonth(new Date("2026-09-30T18:00:00.000Z"))).toBe("2026-08");
  });
});

describe("peer review (18-S RS8c T2)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;
  let second: Actor;
  let seq = 0;

  const NOW = new Date("2026-08-03T06:00:00.000Z");
  const SLOT = new Date("2026-08-03T09:00:00.000Z");

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: "2026-08-03", now: NOW });
    seq = 0;
    ({ actor: second } = await mkUser(db, "dr.second", ["radiologist"]));
    await db.update(imagingDefinitions).set({ status: "superseded" }).where(eq(imagingDefinitions.kind, "report_signatories"));
    await db.insert(imagingDefinitions).values({
      id: newId(), kind: "report_signatories", version: 2, status: "active", draftedBy: "t", publishedBy: "t", publishedAt: NOW,
      body: {
        signatories: [
          { user_id: fx.radiologist.id, qualification: FIXTURE_QUALIFICATION, council_reg_no: FIXTURE_COUNCIL_REG },
          { user_id: second.id, qualification: FIXTURE_QUALIFICATION, council_reg_no: "KMC 55555" },
        ],
      },
    });
  });
  afterEach(() => { fx.unregister(); });

  /** Each study 25 h after the last, so a run of N stays inside August (IST) while N ≤ 20. */
  const signed = async (who: Actor, body: Record<string, unknown> = { findings: "Liver normal." }) => {
    seq += 1;
    const at = new Date(NOW.getTime() + seq * 25 * 3_600_000);
    const s = await acquireStudy(db, fx, { idemKey: `pr${String(seq)}`, now: at, slot: new Date(SLOT.getTime() + seq * 3_600_000) });
    const d = await withTx(db, (tx) => draftReport(tx, who, { studyId: s.studyId, body, impression: "Normal study." }));
    const out = await withTx(db, (tx) => signReport(tx, who, { studyId: s.studyId, reportId: d.reportId, secondFactorAt: new Date(at.getTime() - 60_000), now: at }));
    return { ...s, at, reportId: out.reportId };
  };
  const cases = () => db.select().from(imagingPeerReviews);

  it("draws ⌈3 %⌉ of EACH reader's August, idempotently, and nothing from another month", async () => {
    for (let i = 0; i < 3; i++) await signed(fx.radiologist);
    await signed(second);
    const first = await drawPeerSample(db, "2026-08");
    expect(first.opened).toBe(2);
    const rows = await cases();
    expect(rows.map((r) => [r.readerId, r.trigger, r.sampleMonth, r.state]).sort()).toEqual([
      [fx.radiologist.id, "random", "2026-08", "open"], [second.id, "random", "2026-08", "open"],
    ].sort());
    expect((await drawPeerSample(db, "2026-08")).opened).toBe(0);
    expect((await drawPeerSample(db, "2026-07")).opened).toBe(0);
  });

  it("an amendment sends the version it superseded to review, read by whoever signed it", async () => {
    const s = await signed(fx.radiologist);
    await withTx(db, (tx) => amendReport(tx, second, {
      studyId: s.studyId, reason: "Missed a 6 mm calculus.", secondFactorAt: new Date(s.at.getTime() - 60_000), now: s.at,
      body: { findings: "6 mm calculus, left kidney." }, impression: "Left renal calculus.",
    }));
    expect((await cases()).map((r) => [r.reportId, r.readerId, r.trigger])).toEqual([[s.reportId, fx.radiologist.id, "amendment"]]);
  });

  it("BLIND: my own reports are not in my queue, the case carries no name, and I cannot open or score my own", async () => {
    const mine = await signed(fx.radiologist, { findings: "Liver normal.", technique: "Transabdominal." });
    await drawPeerSample(db, "2026-08");
    const [c] = await cases();
    expect((await peerBoard(db, fx.radiologist, mine.at)).queue).toEqual([]);
    const theirs = await peerBoard(db, second, mine.at);
    expect(theirs.queue.map((q) => q.reviewId)).toEqual([c!.id]);
    const blind = await peerCase(db, second, c!.id, mine.at);
    expect(blind).toMatchObject({ studyId: mine.studyId, impression: "Normal study.", sections: { findings: "Liver normal.", technique: "Transabdominal." } });
    expect(JSON.stringify(blind)).not.toContain(fx.radiologist.id);
    expect(JSON.stringify(blind)).not.toMatch(/dr\.rao|Rao/i);
    await expect(peerCase(db, fx.radiologist, c!.id, mine.at)).rejects.toMatchObject({ code: "peer_review_own_report" });
    await expect(withTx(db, (tx) => scorePeerReview(tx, fx.radiologist, { reviewId: c!.id, score: "1" })))
      .rejects.toMatchObject({ code: "peer_review_own_report" });
  });

  it("a discrepancy says what it was; a case is scored once; the reader's agreement is counted", async () => {
    await signed(fx.radiologist);
    await signed(fx.radiologist);
    await drawPeerSample(db, "2026-08");
    const [c] = await cases();
    await expect(withTx(db, (tx) => scorePeerReview(tx, second, { reviewId: c!.id, score: "2b", note: "" })))
      .rejects.toMatchObject({ code: "reason_required" });
    await expect(withTx(db, (tx) => scorePeerReview(tx, second, { reviewId: c!.id, score: "5" })))
      .rejects.toMatchObject({ code: "evidence_invalid" });
    const at = new Date("2026-08-20T06:00:00.000Z");
    await withTx(db, (tx) => scorePeerReview(tx, second, { reviewId: c!.id, score: "2b", note: "Missed a 4 mm nodule.", learningCase: true, now: at }));
    await expect(withTx(db, (tx) => scorePeerReview(tx, second, { reviewId: c!.id, score: "1" })))
      .rejects.toMatchObject({ code: "already_resolved" });
    const board = await peerBoard(db, second, at);
    expect(board.readers).toEqual([expect.objectContaining({ readerId: fx.radiologist.id, readerName: expect.any(String), scored: 1, concur: 0, minor: 1, significant: 0, agreementPct: 0 })]);
    expect(board.recent).toEqual([expect.objectContaining({ score: "2b", learningCase: true, note: "Missed a 4 mm nodule." })]);
    expect(JSON.stringify(board.recent)).not.toContain(fx.radiologist.id);
  });

  it("the database refuses a reviewer scoring their own report even past the code", async () => {
    const s = await signed(fx.radiologist);
    await expect(db.insert(imagingPeerReviews).values({
      id: newId(), reportId: s.reportId, studyId: s.studyId, readerId: fx.radiologist.id, trigger: "amendment",
      state: "scored", reviewerId: fx.radiologist.id, score: "1", scoredAt: NOW,
    })).rejects.toThrow(/imaging_peer_reviews_not_own_ck/);
  });
});
