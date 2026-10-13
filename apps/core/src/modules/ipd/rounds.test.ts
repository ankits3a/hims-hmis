import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { alerts, events, ipdAdmissions, ipdChargeLines, ipdOrders, staffAbsences } from "../../kernel/db/schema";
import { resolveEncounterByPrefix } from "../../kernel/episodes/encounter-resolvers";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkRoundsWorld } from "../../../test/helpers/ipd";
import {
  IPD_COVER_KIND, IPD_ROUND_NUDGE_HEAD_KIND, IPD_ROUND_NUDGE_KIND, IpdRefusal, cancelIpOrder, closeConsult, markIpdOrderIssuedIn, placeIpOrder,
  readRoundsList, registerIpdEncounterResolver, requestConsult, signRound, stopIpOrder, sweepIpdRoundsClock,
} from "./index";
import { withTx } from "../../kernel/db/client";
import type { Db } from "../../kernel/db/client";
import type { RoundsWorld } from "../../../test/helpers/ipd";
import type { Actor } from "@hmis/contracts";

/**
 * E4.2 (#734) — the rounds lane's own legs beyond the acceptance file: order stop / cancel around the eMAR's issue stamp,
 * the order refusals, the 08:00 cover hand-over and the 14:00 / 16:00 nudges, the `IP` episode resolver. Explicit IST
 * instants throughout; nothing reads the real clock. 2026-03-11 is a Wednesday, 2026-03-15 a Sunday.
 */
jest.setTimeout(240_000);

const ist = (s: string): Date => new Date(`${s}+05:30`);
const key = () => randomUUID();

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof IpdRefusal) return e.code;
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("E4.2 rounds — orders, clock and episode", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: RoundsWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkRoundsWorld(db); });

  const sign = (by: Actor, admissionId: string, at: Date, extra: Record<string, unknown> = {}) =>
    signRound(db, by, { idempotencyKey: key(), admissionId, seenAt: at.toISOString(), mode: "bedside", soap: { plan: "Continue" }, ...extra }, { now: at });
  const drug = (by: Actor, admissionId: string, itemId: string, at: Date, extra: Record<string, unknown> = {}) => placeIpOrder(db, by, {
    idempotencyKey: key(), admissionId, kind: "drug",
    drug: { itemId, dose: { value: 500, unit: "mg" }, route: "oral", frequency: "TDS", startAt: at.toISOString(), antibiotic: false, durationDays: 5, ...extra },
  }, { now: at });

  it("stop before issue owes nothing; after the eMAR's issue a cancel is refused and a stop owes the return", async () => {
    const { admissionId } = await w.admitMed(ist("2026-03-10T10:00:00"));
    const para = await w.medicine("Paracetamol");
    const pan = await w.medicine("Pantoprazole");
    const at = ist("2026-03-11T09:00:00");
    const a = await drug(w.consultant, admissionId, para, at);
    expect(a.status).toBe("pending_verify");
    // A second active order of the same medicine by the same route is a duplicate.
    expect(await refusal(drug(w.consultant, admissionId, para, at))).toBe("duplicate_order");
    const stopped = await stopIpOrder(db, w.consultant, { idempotencyKey: key(), orderId: a.orderId, reason: "Afebrile" }, { now: at });
    expect([stopped.status, stopped.returnOwed]).toEqual(["stopped", false]);
    expect(await refusal(cancelIpOrder(db, w.consultant, { idempotencyKey: key(), orderId: a.orderId, reason: "x" }, { now: at }))).toBe("order_not_active");

    const b = await drug(w.unitResident, admissionId, pan, at);
    expect(await withTx(db, (tx) => markIpdOrderIssuedIn(tx, b.orderId, ist("2026-03-11T10:00:00")))).toBe(true);
    expect(await withTx(db, (tx) => markIpdOrderIssuedIn(tx, b.orderId, ist("2026-03-11T11:00:00")))).toBe(false);
    expect(await refusal(cancelIpOrder(db, w.consultant, { idempotencyKey: key(), orderId: b.orderId, reason: "Wrong patient" }, { now: at })))
      .toBe("order_already_issued");
    const after = await stopIpOrder(db, w.consultant, { idempotencyKey: key(), orderId: b.orderId, reason: "Wrong patient" }, { now: at });
    expect(after.returnOwed).toBe(true);
    const ev = (await db.select().from(events).where(eq(events.name, "ipd.order.stopped"))).map((e) => (e.payload as { afterIssue: boolean }).afterIssue);
    expect(ev.sort()).toEqual([false, true]);

    // Cancel before issue, with its reason, is allowed and leaves the row cancelled.
    const c = await drug(w.consultant, admissionId, para, at);
    await cancelIpOrder(db, w.consultant, { idempotencyKey: key(), orderId: c.orderId, reason: "Wrong patient" }, { now: at });
    const row = (await db.select().from(ipdOrders).where(eq(ipdOrders.id, c.orderId)))[0]!;
    expect([row.status, row.cancelReason, row.orderedByKind]).toEqual(["cancelled", "Wrong patient", "consultant"]);
    expect((await db.select().from(ipdOrders).where(eq(ipdOrders.id, b.orderId)))[0]!.orderedByKind).toBe("resident");
  });

  it("order refusals: duration, unknown medicine, another lane's kind, a test of another department, not the team", async () => {
    const { admissionId } = await w.admitMed(ist("2026-03-10T10:00:00"));
    const para = await w.medicine("Paracetamol");
    const at = ist("2026-03-11T09:00:00");
    expect(await refusal(drug(w.consultant, admissionId, para, at, { durationDays: undefined }))).toBe("duration_required");
    expect(await refusal(drug(w.consultant, admissionId, newId(), at))).toBe("medicine_not_found");
    expect(await refusal(placeIpOrder(db, w.consultant, { idempotencyKey: key(), admissionId, kind: "diet" }, { now: at }))).toBe("order_kind_not_here");
    expect(await refusal(placeIpOrder(db, w.consultant, {
      idempotencyKey: key(), admissionId, kind: "lab", tests: { serviceIds: ["svc-not-a-lab-test"], indication: "Fever" },
    }, { now: at }))).toBe("test_not_orderable");
    expect(await refusal(drug(w.outsider, admissionId, para, at))).toBe("not_treating_team");
    // A lab order, once placed, is its department's: rounds neither stops nor cancels it.
    const labRow = newId();
    const pid = (await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, admissionId)))[0]!.patientId;
    await db.insert(ipdOrders).values({
      id: labRow, admissionId, patientId: pid, kind: "lab", status: "active", serviceIds: ["svc-x"], department: "lab",
      orderedBy: w.consultant.id, orderedByKind: "consultant", orderedAt: at, provenance: "person",
    });
    expect(await refusal(cancelIpOrder(db, w.consultant, { idempotencyKey: key(), orderId: labRow, reason: "x" }, { now: at }))).toBe("order_kind_not_here");
    expect(await refusal(stopIpOrder(db, w.consultant, { idempotencyKey: key(), orderId: labRow, reason: "x" }, { now: at }))).toBe("order_kind_not_here");
    expect(await refusal(sign(w.outsider, admissionId, at))).toBe("not_treating_team");
  });

  it("a consult closes and the patient leaves the consultant's list", async () => {
    const { admissionId } = await w.admitMed(ist("2026-03-10T10:00:00"));
    const at = ist("2026-03-11T09:00:00");
    const c = await requestConsult(db, w.consultant, { idempotencyKey: key(), admissionId, consultantId: w.cross.id, question: "Opinion", urgency: "urgent" }, { now: at });
    expect(await refusal(requestConsult(db, w.consultant, { idempotencyKey: key(), admissionId, consultantId: w.cross.id, question: "Again", urgency: "routine" }, { now: at })))
      .toBe("consult_already_open");
    // The asked consultant's bell row names no patient.
    const bell = (await db.select().from(alerts).where(eq(alerts.userId, w.cross.id)))[0]!;
    expect(`${bell.title} ${bell.body}`).not.toMatch(/Test Patient/);
    expect((await readRoundsList(db, w.cross, at)).rows.map((r) => r.why)).toEqual(["consult"]);
    await closeConsult(db, w.cross, { idempotencyKey: key(), consultId: c.consultId }, { now: at });
    expect((await readRoundsList(db, w.cross, at)).rows).toEqual([]);
    expect(await refusal(closeConsult(db, w.cross, { idempotencyKey: key(), consultId: c.consultId }, { now: at }))).toBe("consult_closed");
  });

  it("08:00: a consultant on approved leave is covered by the unit head — list, visit as the treating team, one bell row; cleared on return", async () => {
    const { admissionId } = await w.admitMed(ist("2026-03-10T10:00:00"));
    await db.insert(staffAbsences).values({
      id: newId(), userId: w.consultant.id, kind: "CL", startsAt: ist("2026-03-11T00:00:00"), endsAt: ist("2026-03-12T00:00:00"),
      status: "approved", requestedBy: w.consultant.id, approvedBy: w.head.id, decidedAt: ist("2026-03-10T12:00:00"), createdBy: w.consultant.id, updatedBy: w.consultant.id,
    } as never);
    expect(await sweepIpdRoundsClock(db, ist("2026-03-11T07:59:00"))).toEqual({ covers: 0, nudges: 0 });
    expect((await sweepIpdRoundsClock(db, ist("2026-03-11T08:00:00"))).covers).toBe(1);
    expect((await sweepIpdRoundsClock(db, ist("2026-03-11T08:01:00"))).covers).toBe(0);
    expect((await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, admissionId)))[0]!.coveringFor).toBe(w.head.id);
    const bells = await db.select().from(alerts).where(and(eq(alerts.userId, w.head.id), eq(alerts.kind, IPD_COVER_KIND)));
    expect(bells).toHaveLength(1);
    expect(bells[0]!.body).toMatch(/^You cover 1 inpatient of /);
    expect((await readRoundsList(db, w.head, ist("2026-03-11T09:00:00"))).rows.map((r) => r.why)).toEqual(["covering"]);
    // The covering consultant's visit is the treating consultant's `visit`, not a cross visit.
    await sign(w.head, admissionId, ist("2026-03-11T09:30:00"));
    const lines = await db.select().from(ipdChargeLines).where(and(eq(ipdChargeLines.admissionId, admissionId), eq(ipdChargeLines.source, "ipd.visit")));
    expect(lines.map((l) => [l.consultantUserId, l.component])).toEqual([[w.head.id, "visit"]]);
    // Back from leave the next morning: the cover is cleared.
    expect((await sweepIpdRoundsClock(db, ist("2026-03-12T08:00:00"))).covers).toBe(1);
    expect((await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, admissionId)))[0]!.coveringFor).toBeNull();
  });

  it("14:00 on a weekday: one nudge to the consultant, at 16:00 one to the unit head; none for a rounded patient or on Sunday", async () => {
    const unrounded = await w.admitMed(ist("2026-03-10T10:00:00"));
    const rounded = await w.admitMed(ist("2026-03-10T11:00:00"));
    await w.admitMed(ist("2026-03-11T09:00:00")); // admitted today: not expected to be rounded yet
    await sign(w.consultant, rounded.admissionId, ist("2026-03-11T10:00:00"));
    // A resident's draft and a remote review do not count as the consultant's round.
    await sign(w.unitResident, unrounded.admissionId, ist("2026-03-11T10:30:00"));
    await sign(w.consultant, unrounded.admissionId, ist("2026-03-11T11:00:00"), { mode: "remote_review" });

    expect((await sweepIpdRoundsClock(db, ist("2026-03-11T13:59:00"))).nudges).toBe(0);
    expect((await sweepIpdRoundsClock(db, ist("2026-03-11T14:00:00"))).nudges).toBe(1);
    expect((await sweepIpdRoundsClock(db, ist("2026-03-11T14:01:00"))).nudges).toBe(0);
    const mine = await db.select().from(alerts).where(and(eq(alerts.userId, w.consultant.id), eq(alerts.kind, IPD_ROUND_NUDGE_KIND)));
    expect(mine.map((a) => a.body)).toEqual(["1 inpatient has no consultant round today. Open Rounds."]);
    expect((await sweepIpdRoundsClock(db, ist("2026-03-11T16:00:00"))).nudges).toBe(1);
    expect((await sweepIpdRoundsClock(db, ist("2026-03-11T16:05:00"))).nudges).toBe(0);
    expect(await db.select().from(alerts).where(and(eq(alerts.userId, w.head.id), eq(alerts.kind, IPD_ROUND_NUDGE_HEAD_KIND)))).toHaveLength(1);
    // Nothing after 20:00, and nothing on a Sunday.
    expect((await sweepIpdRoundsClock(db, ist("2026-03-12T20:00:00"))).nudges).toBe(0);
    expect((await sweepIpdRoundsClock(db, ist("2026-03-15T14:00:00"))).nudges).toBe(0);
  });

  it("the IP episode resolves to the admission's patient and payer bucket (the ordering door's lookup)", async () => {
    const unregister = registerIpdEncounterResolver();
    try {
      const { admissionId, patientId } = await w.admitMed(ist("2026-03-10T10:00:00"));
      const no = (await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, admissionId)))[0]!.admissionNo!;
      expect(no.startsWith("IP")).toBe(true);
      expect(await resolveEncounterByPrefix(db, no)).toEqual({ matched: true, resolved: { patientId, intendedPayer: "self" } });
      expect(await resolveEncounterByPrefix(db, "IP99-999999")).toEqual({ matched: true, resolved: null });
    } finally {
      unregister();
    }
  });
});
