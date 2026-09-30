import { and, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { acquireStudy, setupRadiologyFixture } from "../../../test/helpers/radiology";
import { mkUser } from "../../../test/helpers/opd";
import { events, imagingFollowups, imagingStudies, orders } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { amendReport, cosignReport, draftReport, signReport } from "./reports";
import {
  addInterval, bookFollowup, closeFollowup, doctorFollowups, followupBoard, followupsFromBody, markFollowupNotified,
  sweepOverdueFollowups,
} from "./followups";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18-S RS8c T1 — **THE FOLLOW-UP TRACKER.** A recommendation in a signed report becomes a row
 * with a due day (IST); the row is told, booked through the existing ordering door under the
 * treating doctor, or closed with a reason; the daily sweep speaks once when it is overdue.
 *
 * Every instant is a FIXED clock (`NOW` + offsets) and every day is IST (memory: a fixed-date
 * fixture compared against the real clock is a time bomb).
 */

describe("follow-ups — which recommendations open a row (pure)", () => {
  it("BI-RADS 3, a TI-RADS 'follow up', LI-RADS 3/4, Lung-RADS 3/4A, Fleischner and the radiologist's tick each open one", () => {
    const drafts = followupsFromBody({
      coded: {
        birads: { value: "3" },
        tirads: { value: "TR4", inputs: { composition: "solid", echogenicity: "hypo", shape: "wider_than_tall", margin: "smooth", foci: ["none"], sizeCm: 1.2 } },
        lirads: { value: "LR-3" },
        lungrads: { value: "4A" },
        fleischner: { value: "x", inputs: { type: "solid", count: "single", sizeMm: 7, risk: "high" } },
      },
      followup: { text: "Repeat X-ray to confirm union", weeks: 6 },
    });
    expect(drafts.map((d) => [d.source, d.intervalLabel])).toEqual([
      ["birads", "6 months"], ["tirads", "1 year"], ["lirads", "3 months"], ["lungrads", "3 months"],
      ["fleischner", "6 months"], ["other", "6 weeks"],
    ]);
  });

  it("opens nothing for a category with no imaging interval (BI-RADS 2, TI-RADS 'FNA', LR-5, a mass) or no inputs", () => {
    expect(followupsFromBody({
      coded: {
        birads: { value: "2" },
        tirads: { value: "TR5", inputs: { composition: "solid", echogenicity: "very_hypo", shape: "taller_than_wide", margin: "lobulated_irregular", foci: ["punctate"], sizeCm: 2 } },
        lirads: { value: "LR-5" },
        fleischner: { value: "mass", inputs: { type: "solid", count: "single", sizeMm: 34, risk: "high" } },
        lungrads: "4A",
      },
    }).map((d) => d.source)).toEqual(["lungrads"]);
    expect(followupsFromBody({ findings: "Normal." })).toEqual([]);
  });

  it("refuses a tick that cannot be dated (no interval, both intervals, no words)", () => {
    for (const followup of [{ text: "Repeat scan" }, { text: "Repeat scan", weeks: 2, months: 1 }, { text: "", months: 3 }]) {
      expect(() => followupsFromBody({ followup })).toThrow(expect.objectContaining({ code: "evidence_invalid" }));
    }
  });

  it("counts months on the calendar and clamps the 31st", () => {
    expect(addInterval("2026-08-31", { months: 6 })).toBe("2027-02-28");
    expect(addInterval("2026-01-31", { months: 1 })).toBe("2026-02-28");
    expect(addInterval("2026-09-29", { weeks: 6 })).toBe("2026-11-10");
  });
});

describe("follow-ups — the tracker (18-S RS8c T1)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;
  let seq = 0;

  /** 06:00 UTC = 11:30 IST: the signed day is 2026-08-31 in IST and in UTC alike, by construction. */
  const NOW = new Date("2026-08-31T06:00:00.000Z");
  const SLOT = new Date("2026-08-31T09:00:00.000Z");
  const FRESH = new Date(NOW.getTime() - 60_000);

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: "2026-08-31", now: NOW });
    seq = 0;
  });
  afterEach(() => { fx.unregister(); });

  const acquired = async () => {
    seq += 1;
    const at = new Date(NOW.getTime() + seq * 25 * 3_600_000);
    const s = await acquireStudy(db, fx, { idemKey: `fu${String(seq)}`, now: at, slot: new Date(SLOT.getTime() + seq * 3_600_000) });
    return { ...s, at };
  };
  const signWith = async (who: Actor, studyId: string, body: Record<string, unknown>, at: Date) => {
    const d = await withTx(db, (tx) => draftReport(tx, who, { studyId, body, impression: "As above." }));
    return await withTx(db, (tx) => signReport(tx, who, {
      studyId, reportId: d.reportId, secondFactorAt: new Date(at.getTime() - 60_000), now: at,
    }));
  };
  const rowsOf = (studyId: string) => db.select().from(imagingFollowups).where(eq(imagingFollowups.studyId, studyId));
  const BIRADS3 = { findings: "Oval circumscribed mass, 8 mm.", coded: { birads: { value: "3" } } };

  it("a signature carrying BI-RADS 3 opens ONE row due six months from the signed IST day; a plain one opens none", async () => {
    const s = await acquired();
    const signed = await signWith(fx.radiologist, s.studyId, BIRADS3, s.at);
    const rows = await rowsOf(s.studyId);
    expect(rows.map((r) => [r.source, r.state, r.dueOn, r.reportId, r.patientId])).toEqual([
      ["birads", "open", "2027-03-01", signed.reportId, fx.patientId],
    ]);

    const plain = await acquired();
    await signWith(fx.radiologist, plain.studyId, { findings: "Normal liver." }, plain.at);
    expect(await rowsOf(plain.studyId)).toHaveLength(0);
  });

  it("a resident's signature opens nothing; the consultant's co-sign opens the row (RS8b composes)", async () => {
    const { actor: resident } = await mkUser(db, "dr.resident", ["radiology_resident"]);
    const s = await acquired();
    const d = await withTx(db, (tx) => draftReport(tx, resident, { studyId: s.studyId, body: BIRADS3, impression: "Probably benign." }));
    const awaiting = await withTx(db, (tx) => signReport(tx, resident, { studyId: s.studyId, reportId: d.reportId, secondFactorAt: FRESH, now: NOW }));
    expect(await rowsOf(s.studyId)).toHaveLength(0);
    const co = await withTx(db, (tx) => cosignReport(tx, fx.radiologist, { studyId: s.studyId, reportId: awaiting.reportId, secondFactorAt: FRESH, now: NOW }));
    const rows = await rowsOf(s.studyId);
    expect(rows.map((r) => [r.source, r.reportId])).toEqual([["birads", co.reportId]]);
  });

  it("an amendment that drops the recommendation withdraws the row; one that keeps it keeps the SAME row", async () => {
    const s = await acquired();
    await signWith(fx.radiologist, s.studyId, { ...BIRADS3, coded: { birads: { value: "3" }, lungrads: { value: "3" } } }, s.at);
    const before = await rowsOf(s.studyId);
    expect(before.map((r) => r.source).sort()).toEqual(["birads", "lungrads"]);
    await withTx(db, (tx) => amendReport(tx, fx.radiologist, {
      studyId: s.studyId, reason: "Lung nodule was a nipple shadow.", secondFactorAt: new Date(s.at.getTime() - 60_000), now: s.at,
      body: BIRADS3, impression: "As above.",
    }));
    const after = await rowsOf(s.studyId);
    const byId = new Map(after.map((r) => [r.id, r]));
    const birads = before.find((r) => r.source === "birads")!;
    const lung = before.find((r) => r.source === "lungrads")!;
    expect(byId.get(birads.id)!.state).toBe("open");
    expect([byId.get(lung.id)!.state, byId.get(lung.id)!.closeReason]).toEqual(["closed", "withdrawn_by_amendment"]);
    expect(after).toHaveLength(2);
  });

  it("the sweep speaks ONCE for a row past its due day (IST), and never for one due today", async () => {
    const s = await acquired();
    await signWith(fx.radiologist, s.studyId, { findings: "Fracture.", followup: { text: "Repeat X-ray for union", weeks: 6 } }, s.at);
    const [row] = await rowsOf(s.studyId);
    expect(row!.dueOn).toBe("2026-10-13");
    /** 2026-10-13T18:00Z is 23:30 IST on the due day itself — not overdue. */
    expect((await sweepOverdueFollowups(db, new Date("2026-10-13T18:00:00.000Z"))).chased).toEqual([]);
    /** 18:40Z is 00:10 IST on the 14th — overdue by one day. */
    const late = new Date("2026-10-13T18:40:00.000Z");
    expect((await sweepOverdueFollowups(db, late)).chased).toEqual([row!.id]);
    expect((await sweepOverdueFollowups(db, late)).chased).toEqual([]);
    const evs = await db.select().from(events).where(eq(events.name, "imaging.followup_overdue"));
    expect(evs.map((e) => (e.payload as { overdueDays: number }).overdueDays)).toEqual([1]);
    const board = await followupBoard(db, fx.radiologist, late);
    expect(board.rows[0]).toMatchObject({ followupId: row!.id, overdue: true, state: "open" });
    expect(board.tiles.overdue).toBe(1);
  });

  it("BOOK IT places a NEW imaging order through the ordering door, under the study's treating doctor, and the row is booked once", async () => {
    const s = await acquired();
    await signWith(fx.radiologist, s.studyId, BIRADS3, s.at);
    const [row] = await rowsOf(s.studyId);
    const later = new Date(s.at.getTime() + 60 * 86_400_000);
    const out = await bookFollowup(db, fx.doctor, fx.decls, { followupId: row!.id, now: later });
    const [placed] = await db.select().from(orders).where(eq(orders.id, out.orderId));
    expect([placed!.orderingClinicianId, placed!.kind, placed!.indication?.startsWith(`Follow-up of ${s.accessionNo}`)]).toEqual(["dr-consultant", "imaging", true]);
    const [after] = await rowsOf(s.studyId);
    expect([after!.state, after!.bookedOrderId, after!.bookedBy]).toEqual(["booked", out.orderId, fx.doctor.id]);
    await expect(bookFollowup(db, fx.doctor, fx.decls, { followupId: row!.id, now: later })).rejects.toMatchObject({ code: "already_resolved" });
    expect(await db.select().from(events).where(eq(events.name, "imaging.followup_booked"))).toHaveLength(1);
  });

  it("booking is an ORDER: somebody who may not place one (the radiologist) books nothing", async () => {
    const s = await acquired();
    await signWith(fx.radiologist, s.studyId, BIRADS3, s.at);
    const [row] = await rowsOf(s.studyId);
    await expect(bookFollowup(db, fx.radiologist, fx.decls, { followupId: row!.id, now: new Date(s.at.getTime() + 60 * 86_400_000) }))
      .rejects.toMatchObject({ code: "permission_denied" });
    const [after] = await rowsOf(s.studyId);
    expect([after!.state, after!.bookedOrderId]).toEqual(["open", null]);
  });

  it("the booked study's own signed report closes the follow-up as done here", async () => {
    const s = await acquired();
    /** The second scan is acquired first (so the duplicate window never sees the booked order), then re-pointed at it. */
    const s2 = await acquired();
    await signWith(fx.radiologist, s.studyId, BIRADS3, s.at);
    const [row] = await rowsOf(s.studyId);
    const later = new Date(s.at.getTime() + 60 * 86_400_000);
    const out = await bookFollowup(db, fx.doctor, fx.decls, { followupId: row!.id, now: later });
    await db.update(imagingStudies).set({ orderId: out.orderId }).where(eq(imagingStudies.id, s2.studyId));
    await signWith(fx.radiologist, s2.studyId, { findings: "Stable." }, s2.at);
    const [closed] = await rowsOf(s.studyId);
    expect([closed!.state, closed!.closeReason]).toEqual(["closed", "done_here"]);
  });

  it("a notice is a channel and a person; a close is a reason and a line — never by being forgotten", async () => {
    const s = await acquired();
    await signWith(fx.radiologist, s.studyId, BIRADS3, s.at);
    const [row] = await rowsOf(s.studyId);
    await expect(withTx(db, (tx) => markFollowupNotified(tx, fx.radiologist, { followupId: row!.id, channel: "pigeon" })))
      .rejects.toMatchObject({ code: "evidence_invalid" });
    await withTx(db, (tx) => markFollowupNotified(tx, fx.radiologist, { followupId: row!.id, channel: "phone", note: "Told Dr Mehra", now: s.at }));
    expect((await rowsOf(s.studyId))[0]).toMatchObject({ state: "notified", notifiedChannel: "phone", notifiedBy: fx.radiologist.id });
    await expect(withTx(db, (tx) => closeFollowup(tx, fx.radiologist, { followupId: row!.id, reason: "patient_declines", note: "" })))
      .rejects.toMatchObject({ code: "reason_required" });
    await expect(withTx(db, (tx) => closeFollowup(tx, fx.radiologist, { followupId: row!.id, reason: "withdrawn_by_amendment", note: "because" })))
      .rejects.toMatchObject({ code: "evidence_invalid" });
    await withTx(db, (tx) => closeFollowup(tx, fx.radiologist, { followupId: row!.id, reason: "patient_declines", note: "Informed refusal on file", now: s.at }));
    expect((await rowsOf(s.studyId))[0]).toMatchObject({ state: "closed", closeReason: "patient_declines" });
    await expect(withTx(db, (tx) => closeFollowup(tx, fx.radiologist, { followupId: row!.id, reason: "done_elsewhere", note: "twice" })))
      .rejects.toMatchObject({ code: "already_resolved" });
  });

  it("the doctor's inbox lists the follow-ups of studies they treat, and nobody else's", async () => {
    const s = await acquired();
    await db.update(orders).set({ orderingClinicianId: fx.doctor.id }).where(eq(orders.id, s.orderId));
    await signWith(fx.radiologist, s.studyId, BIRADS3, s.at);
    const { actor: other } = await mkUser(db, "dr.other", ["doctor"]);
    const mine = await doctorFollowups(db, fx.doctor, s.at);
    expect(mine.map((r) => [r.accessionNo, r.source, r.patientName])).toEqual([[s.accessionNo, "birads", "Asha Devi"]]);
    expect(await doctorFollowups(db, other, s.at)).toEqual([]);
    const rows = await db.select().from(imagingFollowups).where(and(eq(imagingFollowups.studyId, s.studyId)));
    expect(rows).toHaveLength(1);
  });
});
