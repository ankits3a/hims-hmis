import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { IpdOrderPlacedPayloadSchema } from "@hmis/contracts";
import { events, ipdAdmissions, ipdChargeLines, ipdDischargeConfirmations, ipdDischarges, ipdRounds } from "../../../kernel/db/schema";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkRoundsWorld } from "../../../../test/helpers/ipd";
import { IpdRefusal, cosignRound, placeIpOrder, readRoundPatient, readRoundsList, requestConsult, signRound } from "../index";
import type { Db } from "../../../kernel/db/client";
import type { RoundsWorld } from "../../../../test/helpers/ipd";
import type { Actor } from "@hmis/contracts";

/**
 * E4.2 (#734) — "DONE MEANS" FOR ROUNDS (spec SPEC-ipd-core §4.5A, plan E4.2; decisions 0058, 0067, 0072). Every act is
 * called with an EXPLICIT instant written in IST; no test reads or pins the real clock. The fixture tariff prices the
 * general visit and cross-visit (`CHARGE_RATES`).
 *
 *   (i)   the doctor's list: own unit + consulted; a boarded patient on another ward is on it, marked with that ward
 *   (ii)  one chargeable visit per consultant per patient per day
 *   (iii) a resident's or intern's entry is a draft until the consultant co-signs — a resident cannot finalise
 *   (iv)  fit for discharge from the round starts the discharge cascade
 *   (v)   an antibiotic order without a stop date is refused
 *   (vi)  a remote review is recorded as such and is not charged
 */

jest.setTimeout(240_000);

const ist = (s: string): Date => new Date(`${s}+05:30`);
const key = () => randomUUID();
const MONEY_WORDS = /paise|rupee|amount|fee|charge|dues|payable|price|deposit|bill/i;

async function refusal(p: Promise<unknown>): Promise<IpdRefusal> {
  try {
    await p;
  } catch (e) {
    if (e instanceof IpdRefusal) return e;
    throw e;
  }
  throw new Error("expected a refusal");
}

function moneyKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) moneyKeys(v, out);
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) { if (MONEY_WORDS.test(k)) out.push(k); moneyKeys(v, out); }
  }
  return out;
}

describe("E4.2 rounds — acceptance", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: RoundsWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkRoundsWorld(db); });

  const sign = (by: Actor, admissionId: string, at: Date, extra: Record<string, unknown> = {}) =>
    signRound(db, by, { idempotencyKey: key(), admissionId, seenAt: at.toISOString(), mode: "bedside", soap: { assessment: "Improving", plan: "Continue" }, ...extra }, { now: at });
  const visitLines = async (admissionId: string) =>
    (await db.select().from(ipdChargeLines).where(and(eq(ipdChargeLines.admissionId, admissionId), eq(ipdChargeLines.source, "ipd.visit"))));

  it("(i) the list holds own-unit and consulted patients; a boarded patient on another ward is included and marked with its ward", async () => {
    const own = await w.admitMed(ist("2026-03-10T10:00:00"));
    const boarded = await w.admitMed(ist("2026-03-10T11:00:00"));
    await w.board(boarded.admissionId, ist("2026-03-10T12:00:00"));
    const headsPatient = await w.admitMed(ist("2026-03-10T13:00:00"), w.head.id);
    const elsewhere = await w.admitMed(ist("2026-03-10T14:00:00"), w.cross.id);
    const now = ist("2026-03-11T09:00:00");

    const list = await readRoundsList(db, w.consultant, now);
    const rows = new Map(list.rows.map((r) => [r.admissionId, r] as const));
    expect(rows.get(own.admissionId)).toMatchObject({ why: "own", boarded: false, wardCode: "F-T-W" });
    // Boarded: on the SUR ward while admitted under MED — on the list, marked with the ward it lies on.
    expect(rows.get(boarded.admissionId)).toMatchObject({ why: "own", boarded: true, wardCode: "F-T-W2" });
    // The unit head's patient is on the unit's list; another unit's patient is not — until this doctor is consulted.
    expect(rows.get(headsPatient.admissionId)).toMatchObject({ why: "unit" });
    expect(rows.has(elsewhere.admissionId)).toBe(false);
    // The resident of the unit sees the whole unit.
    expect((await readRoundsList(db, w.unitResident, now)).rows.map((r) => r.admissionId).sort())
      .toEqual([own.admissionId, boarded.admissionId, headsPatient.admissionId].sort());

    await requestConsult(db, w.cross, {
      idempotencyKey: key(), admissionId: elsewhere.admissionId, consultantId: w.consultant.id, question: "Fever work-up please", urgency: "routine",
    }, { now });
    const after = new Map((await readRoundsList(db, w.consultant, now)).rows.map((r) => [r.admissionId, r] as const));
    expect(after.get(elsewhere.admissionId)).toMatchObject({ why: "consult" });
    expect(after.get(elsewhere.admissionId)?.consultId).not.toBeNull();
    // A doctor on no patient's team has an empty list.
    expect((await readRoundsList(db, w.outsider, now)).rows).toEqual([]);
    // No money anywhere on the list (decision 0058).
    expect(moneyKeys(await readRoundsList(db, w.consultant, now))).toEqual([]);
  });

  it("(ii) one chargeable visit per consultant per patient per day; a cross-consultant's is a cross visit", async () => {
    const { admissionId } = await w.admitMed(ist("2026-03-10T10:00:00"));
    await sign(w.consultant, admissionId, ist("2026-03-11T09:00:00"));
    await sign(w.consultant, admissionId, ist("2026-03-11T18:00:00"));
    expect((await visitLines(admissionId)).filter((l) => l.serviceDate === "2026-03-11")).toHaveLength(1);

    // A consult puts the other unit's consultant on the patient; their round bills as a cross visit, once that day.
    await requestConsult(db, w.consultant, {
      idempotencyKey: key(), admissionId, consultantId: w.cross.id, question: "Surgical opinion", urgency: "urgent",
    }, { now: ist("2026-03-11T10:00:00") });
    await sign(w.cross, admissionId, ist("2026-03-11T11:00:00"));
    await sign(w.cross, admissionId, ist("2026-03-11T16:00:00"));
    const day = (await visitLines(admissionId)).filter((l) => l.serviceDate === "2026-03-11");
    expect(day.map((l) => [l.consultantUserId, l.component]).sort()).toEqual([
      [w.consultant.id, "visit"], [w.cross.id, "cross_visit"],
    ].sort());
    // The next IST day is a new chargeable visit.
    await sign(w.consultant, admissionId, ist("2026-03-12T09:00:00"));
    expect((await visitLines(admissionId)).filter((l) => l.consultantUserId === w.consultant.id)).toHaveLength(2);
  });

  it("(iii) a resident's round is a draft until the consultant co-signs; a resident cannot finalise", async () => {
    const { admissionId } = await w.admitMed(ist("2026-03-10T10:00:00"));
    const draft = await sign(w.unitResident, admissionId, ist("2026-03-11T08:00:00"));
    expect(draft.status).toBe("awaiting_cosign");
    expect(await visitLines(admissionId)).toEqual([]);

    // A resident cannot co-sign (their own or anyone's), nor declare fit from a round.
    expect((await refusal(cosignRound(db, w.unitResident, { idempotencyKey: key(), roundId: draft.roundId }, { now: ist("2026-03-11T08:30:00") }))).code)
      .toBe("not_treating_consultant");
    expect((await refusal(sign(w.unitResident, admissionId, ist("2026-03-11T08:40:00"), { fit: { when: "today", disposition: "home" } }))).code)
      .toBe("consultant_cosign_required");
    expect((await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, admissionId)))[0]!.state).toBe("admitted");

    // The consultant sees it in the co-sign queue and co-signs; co-signing is not a visit.
    const queue = (await readRoundsList(db, w.consultant, ist("2026-03-11T09:00:00"))).cosignQueue;
    expect(queue.map((q) => q.roundId)).toEqual([draft.roundId]);
    const done = await cosignRound(db, w.consultant, { idempotencyKey: key(), roundId: draft.roundId }, { now: ist("2026-03-11T09:05:00") });
    expect(done.status).toBe("signed");
    const row = (await db.select().from(ipdRounds).where(eq(ipdRounds.id, draft.roundId)))[0]!;
    expect([row.status, row.cosignedBy]).toEqual(["signed", w.consultant.id]);
    expect(await visitLines(admissionId)).toEqual([]);
    expect((await refusal(cosignRound(db, w.consultant, { idempotencyKey: key(), roundId: draft.roundId }, { now: ist("2026-03-11T09:06:00") }))).code)
      .toBe("round_not_awaiting_cosign");
  });

  it("(iv) fit for discharge from the round starts the discharge cascade", async () => {
    const { admissionId } = await w.admitMed(ist("2026-03-10T10:00:00"));
    const at = ist("2026-03-12T09:30:00");
    const out = await sign(w.consultant, admissionId, at, { fit: { when: "today", disposition: "home" } });
    expect(out.fitDeclaredAt).toBe(at.toISOString());
    expect((await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, admissionId)))[0]!.state).toBe("fit_declared");
    const d = (await db.select().from(ipdDischarges).where(eq(ipdDischarges.admissionId, admissionId)))[0]!;
    expect([d.status, d.fitWhen, d.declaredBy]).toEqual(["active", "today", w.consultant.id]);
    const departments = (await db.select().from(ipdDischargeConfirmations).where(eq(ipdDischargeConfirmations.dischargeId, d.id))).map((c) => c.department).sort();
    expect(departments).toEqual(expect.arrayContaining(["billing", "ward"]));
    expect((await db.select().from(events).where(eq(events.name, "ipd.discharge.fit_declared")))).toHaveLength(1);
    expect((await db.select().from(ipdRounds).where(eq(ipdRounds.admissionId, admissionId)))[0]!.dischargeId).toBe(d.id);
    // Only the treating consultant: the cross-consultant's fit is refused and nothing moves.
    const other = await w.admitMed(ist("2026-03-10T11:00:00"));
    await requestConsult(db, w.consultant, { idempotencyKey: key(), admissionId: other.admissionId, consultantId: w.cross.id, question: "Opinion", urgency: "routine" }, { now: at });
    expect((await refusal(sign(w.cross, other.admissionId, at, { fit: { when: "today", disposition: "home" } }))).code).toBe("not_treating_consultant");
    expect((await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, other.admissionId)))[0]!.state).toBe("admitted");
  });

  it("(v) an antibiotic order without a stop date is refused — by the formulary's class as well as the flag", async () => {
    const { admissionId } = await w.admitMed(ist("2026-03-10T10:00:00"));
    const ceftriaxone = await w.medicine("Ceftriaxone", "Watch");
    const at = ist("2026-03-11T09:00:00");
    const drug = (extra: Record<string, unknown>) => placeIpOrder(db, w.consultant, {
      idempotencyKey: key(), admissionId, kind: "drug",
      drug: { itemId: ceftriaxone, dose: { value: 1, unit: "g" }, route: "iv", frequency: "BD", startAt: at.toISOString(), antibiotic: false, ...extra },
    }, { now: at });
    // Not flagged by the prescriber, a course in days — still refused: AWaRe says it is an antibiotic.
    expect((await refusal(drug({ durationDays: 5 }))).code).toBe("antibiotic_stop_date_required");
    expect((await refusal(drug({ antibiotic: true, durationDays: 5 }))).code).toBe("antibiotic_stop_date_required");
    const placed = await drug({ stopAt: ist("2026-03-16T09:00:00").toISOString() });
    expect(placed.status).toBe("pending_verify");
    // The eMAR's contract: the event parses with the shared schema and carries the stop time and the antibiotic mark.
    const ev = (await db.select().from(events).where(eq(events.name, "ipd.order.placed")))[0]!;
    const payload = IpdOrderPlacedPayloadSchema.parse(ev.payload);
    expect([payload.kind, payload.drug?.antibiotic, payload.drug?.stopAt]).toEqual(["drug", true, ist("2026-03-16T09:00:00").toISOString()]);
  });

  it("(vi) a remote review is recorded as a remote review and is not charged", async () => {
    const { admissionId } = await w.admitMed(ist("2026-03-10T10:00:00"));
    const remote = await sign(w.consultant, admissionId, ist("2026-03-11T07:00:00"), { mode: "remote_review" });
    expect([remote.status, remote.mode]).toEqual(["signed", "remote_review"]);
    expect(await visitLines(admissionId)).toEqual([]);
    const page = await readRoundPatient(db, w.consultant, admissionId, ist("2026-03-11T07:05:00"));
    expect(page.rounds.map((r) => r.mode)).toEqual(["remote_review"]);
    expect(moneyKeys(page)).toEqual([]);
    expect(moneyKeys(remote)).toEqual([]);
    // The bedside round later that day is the day's one chargeable visit.
    await sign(w.consultant, admissionId, ist("2026-03-11T10:00:00"));
    expect(await visitLines(admissionId)).toHaveLength(1);
  });
});
