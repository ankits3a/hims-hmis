import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { acquireStudy, setupRadiologyFixture } from "../../../test/helpers/radiology";
import { imagingFollowups, orders } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { draftReport } from "./report-authoring";
import { signReport } from "./report-signature";
import { FOLLOWUP_PROMPT_DAYS, radiologyWaitingMine } from "./waiting";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { Db } from "../../kernel/db/client";

/**
 * #1084 (A7) — the treating doctor's "follow-ups to book" line, beside acceptance D5: the 14-day edge, an
 * overdue one still waiting, and the states that are no longer the doctor's (booked, closed).
 */
describe("follow-ups due soon in the treating doctor's waiting items (#1084)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;
  const NOW = new Date("2026-08-31T06:00:00.000Z");
  const LOOKING = new Date("2026-09-10T05:00:00.000Z");
  const day = (n: number) => new Date(Date.parse("2026-09-10T00:00:00.000Z") + n * 86_400_000).toISOString().slice(0, 10);
  let seq = 0;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: "2026-08-31", now: NOW });
    seq = 0;
  });
  afterEach(() => { fx.unregister(); });

  /** A signed study with one follow-up, ordered by `fx.doctor`, due on `dueOn` in `state`. */
  const followup = async (dueOn: string, state = "open") => {
    seq += 1;
    const at = new Date(NOW.getTime() + seq * 25 * 3_600_000);
    const s = await acquireStudy(db, fx, { idemKey: `fd${String(seq)}`, now: at, slot: new Date(at.getTime() + 3_600_000) });
    await db.update(orders).set({ orderingClinicianId: fx.doctor.id }).where(eq(orders.id, s.orderId));
    const d = await withTx(db, (tx) => draftReport(tx, fx.radiologist, {
      studyId: s.studyId, body: { findings: "Simple cyst.", followup: { text: "Repeat ultrasound", months: 6 } }, impression: "As above.",
    }));
    await withTx(db, (tx) => signReport(tx, fx.radiologist, {
      studyId: s.studyId, reportId: d.reportId, secondFactorAt: new Date(at.getTime() - 60_000), now: at,
    }));
    const at2 = new Date(at.getTime() + 60_000);
    const extra = state === "notified" ? { notifiedAt: at2, notifiedBy: fx.doctor.id, notifiedChannel: "phone" }
      : state === "booked" ? { bookedOrderId: s.orderId, bookedOrderNo: "X-FIXTURE", bookedAt: at2, bookedBy: fx.doctor.id }
      : state === "closed" ? { closedAt: at2, closedBy: fx.doctor.id, closeReason: "done_elsewhere", closeNote: "Done at the district hospital." }
      : {};
    await db.update(imagingFollowups).set({ dueOn, state, ...extra }).where(eq(imagingFollowups.studyId, s.studyId));
  };
  const due = async () => (await radiologyWaitingMine.waiting!({ db, actor: fx.doctor, reader: fx.doctor, date: "2026-09-10", now: LOOKING }))
    .find((i) => i.kind === "radiology.followupsDue");

  it("counts the 14th day, an overdue one and a notified one; not the 15th day, a booked one or a closed one", async () => {
    expect(FOLLOWUP_PROMPT_DAYS).toBe(14);
    await followup(day(14));
    await followup(day(-3));
    await followup(day(5), "notified");
    await followup(day(15));
    await followup(day(2), "booked");
    await followup(day(2), "closed");
    expect(await due()).toEqual({ kind: "radiology.followupsDue", count: 3, oldestAt: null, tone: "calm", href: "/opd/consult" });
  });
});
