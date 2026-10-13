import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { IPD_INTENTS, IpdOrderPlacedPayloadSchema, newId } from "@hmis/contracts";
import { EPISODE_SERIES } from "../../../kernel/episodes/series";
import {
  alerts, events, ipdAdmissions, ipdChargeExceptions, ipdChargeLines, ipdOrders, ipdRounds, opdDoctors, patients, rosterHolidays,
} from "../../../kernel/db/schema";
import { resolveEncounterByPrefix } from "../../../kernel/episodes/encounter-resolvers";
import { withTx } from "../../../kernel/db/client";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkRoundsWorld } from "../../../../test/helpers/ipd";
import { ensureRole, mkUser } from "../../../../test/helpers/opd";
import { addAllergy } from "../../patients";
import {
  IPD_ADMISSION_NO_RE, IpdRefusal, closeConsult, cosignRound, intendedPayerOfAdmission, markIpdOrderIssuedIn, placeIpOrder,
  readRoundPatient, readRoundsList, registerIpdEncounterResolver, requestConsult, resolveBackdatedVisit, signRound, stopIpOrder,
  sweepIpdRoundsClock,
} from "../index";
import type { Db } from "../../../kernel/db/client";
import type { RoundsWorld } from "../../../../test/helpers/ipd";
import type { Actor } from "@hmis/contracts";

/**
 * E4.2 (#734) — THE REVIEW OF 72f10b68, as checks. Each leg below failed on 72f10b68 and passes on the fix. Explicit IST
 * instants; nothing reads the real clock. 2026-03-11 is a Wednesday.
 */
jest.setTimeout(240_000);

const ist = (s: string): Date => new Date(`${s}+05:30`);
const key = () => randomUUID();

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof IpdRefusal) return e.code;
    if (e instanceof Error && e.name === "ZodError") return "invalid_input";
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("E4.2 rounds — review of 72f10b68", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: RoundsWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkRoundsWorld(db); });

  const sign = (by: Actor, admissionId: string, seenAt: Date, now: Date = seenAt, extra: Record<string, unknown> = {}) =>
    signRound(db, by, { idempotencyKey: key(), admissionId, seenAt: seenAt.toISOString(), mode: "bedside", soap: { plan: "Continue" }, ...extra }, { now });
  const visits = async (admissionId: string) =>
    db.select().from(ipdChargeLines).where(and(eq(ipdChargeLines.admissionId, admissionId), eq(ipdChargeLines.source, "ipd.visit")));
  const drug = (admissionId: string, itemId: string, at: Date, extra: Record<string, unknown> = {}, by: Actor = w.consultant) => placeIpOrder(db, by, {
    idempotencyKey: key(), admissionId, kind: "drug",
    drug: { itemId, dose: { value: 500, unit: "mg" }, route: "oral", frequency: "TDS", startAt: at.toISOString(), antibiotic: false, durationDays: 5, ...extra },
  }, { now: at });

  it("RED 1 — the round page refuses anyone off the team; the team, a consulted consultant and the covering consultant read it", async () => {
    const { admissionId } = await w.admitMed(ist("2026-03-10T10:00:00"));
    const at = ist("2026-03-11T09:00:00");
    expect(await refusal(readRoundPatient(db, w.outsider, admissionId, at))).toBe("not_treating_team");
    expect(await refusal(readRoundPatient(db, w.cross, admissionId, at))).toBe("not_treating_team");
    await requestConsult(db, w.consultant, { idempotencyKey: key(), admissionId, consultantId: w.cross.id, question: "Opinion", urgency: "routine" }, { now: at });
    expect((await readRoundPatient(db, w.cross, admissionId, at)).admissionId).toBe(admissionId);
    expect((await readRoundPatient(db, w.unitResident, admissionId, at)).admissionId).toBe(admissionId);
    await db.update(ipdAdmissions).set({ coveringFor: w.outsider.id }).where(eq(ipdAdmissions.id, admissionId));
    expect((await readRoundPatient(db, w.outsider, admissionId, at)).admissionId).toBe(admissionId);
  });

  it("RED 2 / YELLOW 7 — a sealed patient keeps the allergy and isolation words; name, UHID, bed, admission no., diagnosis and time are masked", async () => {
    const { admissionId, patientId } = await w.admitMed(ist("2026-03-10T10:00:00"));
    await db.update(ipdAdmissions).set({ isolation: "contact", provisionalDiagnosis: "Synthetic diagnosis" }).where(eq(ipdAdmissions.id, admissionId));
    await withTx(db, (tx) => addAllergy(tx, w.admitDesk, patientId, { substance: "Penicillin", severity: "severe", source: "consult" }));
    await db.update(patients).set({ sensitiveContext: true }).where(eq(patients.id, patientId));
    const page = await readRoundPatient(db, w.consultant, admissionId, ist("2026-03-11T09:00:00"));
    expect(page.alerts).toEqual(expect.arrayContaining(["Allergy: Penicillin (severe)", "Isolation: contact"]));
    expect([page.patient.sealed, page.patient.uhid, page.bedCode, page.admissionNo, page.provisionalDiagnosis, page.admittedAt])
      .toEqual([true, "", null, null, null, null]);
    expect(page.patient.name).not.toMatch(/Test Patient/);
    const row = (await readRoundsList(db, w.consultant, ist("2026-03-11T09:00:00"))).rows.find((r) => r.admissionId === admissionId)!;
    expect([row.admissionNo, row.bedCode, row.wardName, row.patient.uhid]).toEqual([null, null, null, ""]);
  });

  it("RED 3 — a weight-based dose, and every child's dose, needs a weight", async () => {
    const { admissionId } = await w.admitMed(ist("2026-03-10T10:00:00"));
    const para = await w.medicine("Paracetamol", undefined, { strength: "500 mg", form: "tablet" });
    const at = ist("2026-03-11T09:00:00");
    expect(await refusal(drug(admissionId, para, at, { weightBasedPerKg: true, dose: { value: 15, unit: "mg" } }))).toBe("weight_required");
    const ok = await drug(admissionId, para, at, { weightBasedPerKg: true, dose: { value: 15, unit: "mg" }, weightKg: 62 });
    expect((await db.select().from(ipdOrders).where(eq(ipdOrders.id, ok.orderId)))[0]!.weightKg).toBe(62);
    // A child (10 years): always weight-based.
    const child = await w.admitMed(ist("2026-03-10T11:00:00"));
    const dob = new Date("2016-01-15T00:00:00Z");
    const pid = (await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, child.admissionId)))[0]!.patientId;
    await db.update(patients).set({ dob }).where(eq(patients.id, pid));
    expect(await refusal(drug(child.admissionId, para, at))).toBe("weight_required");
    expect((await drug(child.admissionId, para, at, { weightKg: 28 })).status).toBe("pending_verify");
  });

  it("RED 4 — a lab order is never an orphan and never placed twice: one transaction, keyed by the act's idempotency key", async () => {
    const { admissionId } = await w.admitMed(ist("2026-03-10T10:00:00"));
    const at = ist("2026-03-11T09:00:00");
    let calls = 0;
    let failAfterPlacing = true;
    const door = {
      routeTests: async (_e: unknown, ids: readonly string[]) => ({ lab: [...ids], imaging: [], outside: [], inHospital: [], unknown: [] }),
      orderTests: async (_db: unknown, _a: unknown, _d: unknown, _i: unknown, _n: unknown, o: { tx?: unknown } = {}) => {
        calls += 1;
        // The department writes in the caller's transaction (a marker stands in for the lab's rows) …
        await (o.tx as Db).insert(alerts).values({ id: newId(), userId: w.consultant.id, kind: "lab_marker", title: "t", body: "b", refType: "x", refId: "y", sourceEventId: `marker:${String(calls)}`, createdAt: at });
        // … and the first attempt dies after placing: nothing it wrote may survive.
        if (failAfterPlacing) { failAfterPlacing = false; throw new Error("connection lost after the door"); }
        return { routed: { lab: [], imaging: [], outside: [], inHospital: [], unknown: [] }, lab: { orderId: "lab-order-1" }, imaging: null, skipped: [] };
      },
    } as never;
    const body = { idempotencyKey: key(), admissionId, kind: "lab", tests: { serviceIds: ["svc-cbc"], indication: "Fever" } };
    await expect(placeIpOrder(db, w.consultant, body, { now: at, door })).rejects.toThrow("connection lost");
    expect(await db.select().from(alerts).where(eq(alerts.kind, "lab_marker"))).toEqual([]);
    expect(await db.select().from(ipdOrders).where(eq(ipdOrders.admissionId, admissionId))).toEqual([]);
    // The retry with the same key places once; a second retry asks no department.
    const first = await placeIpOrder(db, w.consultant, body, { now: at, door });
    const again = await placeIpOrder(db, w.consultant, { ...body }, { now: at, door });
    expect(again.orderId).toBe(first.orderId);
    expect(calls).toBe(2);
    const rows = await db.select().from(ipdOrders).where(eq(ipdOrders.admissionId, admissionId));
    expect(rows.map((r) => [r.departmentOrderId, r.idempotencyKey])).toEqual([["lab-order-1", body.idempotencyKey]]);
    expect(await db.select().from(alerts).where(eq(alerts.kind, "lab_marker"))).toHaveLength(1);
  });

  it("RED 5 — the eMAR's issue stamp: issued, already issued, and never on a stopped or cancelled order", async () => {
    const { admissionId } = await w.admitMed(ist("2026-03-10T10:00:00"));
    const at = ist("2026-03-11T09:00:00");
    const a = await drug(admissionId, await w.medicine("Ondansetron", undefined, { strength: "4 mg" }), at, { dose: { value: 4, unit: "mg" } });
    const b = await drug(admissionId, await w.medicine("Pantoprazole", undefined, { strength: "40 mg" }), at, { dose: { value: 40, unit: "mg" } });
    await stopIpOrder(db, w.consultant, { idempotencyKey: key(), orderId: b.orderId, reason: "Not needed" }, { now: at });
    expect(await withTx(db, (tx) => markIpdOrderIssuedIn(tx, b.orderId, at))).toBe("not_active");
    expect((await db.select().from(ipdOrders).where(eq(ipdOrders.id, b.orderId)))[0]!.issuedAt).toBeNull();
    expect(await withTx(db, (tx) => markIpdOrderIssuedIn(tx, a.orderId, at))).toBe("issued");
    expect(await withTx(db, (tx) => markIpdOrderIssuedIn(tx, a.orderId, ist("2026-03-11T10:00:00")))).toBe("already_issued");
    expect(await withTx(db, (tx) => markIpdOrderIssuedIn(tx, newId(), at))).toBe("not_found");
  });

  it("RED 6 — the cadre decides: a resident WITH a doctor-master row is still a draft, posts no visit, cannot co-sign", async () => {
    const dept = (await db.select().from(opdDoctors))[0]!.departmentId;
    await db.insert(opdDoctors).values({ id: newId(), userId: w.unitResident.id, displayName: "Dr Resident", code: "DR-9100", registrationNo: "BMC/9", departmentId: dept, createdBy: "t", updatedBy: "t" });
    const { admissionId } = await w.admitMed(ist("2026-03-10T10:00:00"));
    const r = await sign(w.unitResident, admissionId, ist("2026-03-11T09:00:00"));
    expect(r.status).toBe("awaiting_cosign");
    expect(await visits(admissionId)).toEqual([]);
    expect(await refusal(cosignRound(db, w.unitResident, { idempotencyKey: key(), roundId: r.roundId }, { now: ist("2026-03-11T09:10:00") }))).toBe("not_treating_consultant");
    // No roster membership: the role key decides — `resident` is not a consultant even on the doctor master.
    await ensureRole(db, "resident");
    const roleResident = (await mkUser(db, "rnd.roleres", ["doctor", "resident"])).actor;
    await db.insert(opdDoctors).values({ id: newId(), userId: roleResident.id, displayName: "Dr Role", code: "DR-9101", registrationNo: "BMC/10", departmentId: dept, createdBy: "t", updatedBy: "t" });
    await db.update(ipdAdmissions).set({ coveringFor: roleResident.id }).where(eq(ipdAdmissions.id, admissionId));
    expect((await sign(roleResident, admissionId, ist("2026-03-11T10:00:00"))).status).toBe("awaiting_cosign");
    expect(await visits(admissionId)).toEqual([]);
  });

  it("YELLOW 8–11 — stop after now, 14-day antibiotic course, SOS both ways, the shared frequency words, dose range, unit and route", async () => {
    const { admissionId } = await w.admitMed(ist("2026-03-10T10:00:00"));
    const at = ist("2026-03-11T09:00:00");
    const cef = await w.medicine("Ceftriaxone", "Watch");
    const gel = await w.medicine("Diclofenac gel", undefined, { routeClass: "topical", strength: "1%", form: "gel" });
    const para = await w.medicine("Paracetamol", undefined, { strength: "500 mg", form: "tablet" });
    const abx = (extra: Record<string, unknown>) => drug(admissionId, cef, at, { dose: { value: 1, unit: "g" }, route: "iv", frequency: "BD", durationDays: undefined, ...extra });
    expect(await refusal(abx({ stopAt: ist("2026-03-11T08:00:00").toISOString() }))).toBe("stop_date_past");
    expect(await refusal(abx({ stopAt: ist("2026-03-30T09:00:00").toISOString() }))).toBe("course_too_long");
    expect((await abx({ stopAt: ist("2026-03-30T09:00:00").toISOString(), longCourseReason: "Osteomyelitis" })).status).toBe("pending_verify");
    expect(await refusal(drug(admissionId, para, at, { frequency: "SOS" }))).toBe("prn_mismatch");
    expect(await refusal(drug(admissionId, para, at, { prn: { minIntervalMinutes: 360, max24h: 4 } }))).toBe("prn_mismatch");
    expect(await refusal(drug(admissionId, para, at, { frequency: "q6h" }))).toBe("invalid_input");
    expect(await refusal(drug(admissionId, para, at, { dose: { value: 50, unit: "g" } }))).toBe("dose_out_of_range");
    expect(await refusal(drug(admissionId, para, at, { dose: { value: 500, unit: "iu" } }))).toBe("dose_unit_mismatch");
    expect(await refusal(drug(admissionId, gel, at, { dose: { value: 1, unit: "drop" }, route: "iv" }))).toBe("route_mismatch");
    expect(await refusal(drug(admissionId, para, at, { route: "topical" }))).toBe("route_mismatch");
  });

  it("YELLOW 12 — an allergy conflict is refused unless overridden with a reason; the override is recorded and flagged for the pharmacist", async () => {
    const { admissionId, patientId } = await w.admitMed(ist("2026-03-10T10:00:00"));
    await withTx(db, (tx) => addAllergy(tx, w.admitDesk, patientId, { substance: "Ceftriaxone", severity: "moderate", source: "consult" }));
    const cef = await w.medicine("Ceftriaxone", "Watch");
    const at = ist("2026-03-11T09:00:00");
    const place = (extra: Record<string, unknown>) => drug(admissionId, cef, at, { dose: { value: 1, unit: "g" }, route: "iv", frequency: "BD", durationDays: undefined, stopAt: ist("2026-03-15T09:00:00").toISOString(), ...extra });
    expect(await refusal(place({}))).toBe("allergy_conflict");
    const ok = await place({ allergyOverrideReason: "Rash only; benefit outweighs" });
    expect((await db.select().from(ipdOrders).where(eq(ipdOrders.id, ok.orderId)))[0]!.allergyOverrideReason).toBe("Rash only; benefit outweighs");
    const ev = IpdOrderPlacedPayloadSchema.parse((await db.select().from(events).where(eq(events.name, "ipd.order.placed")))[0]!.payload);
    expect(ev.allergyOverride).toBe(true);
  });

  it("YELLOW 13 — a round older than today (or yesterday before 10:00) is recorded, not charged, and goes to the bill desk", async () => {
    const { admissionId } = await w.admitMed(ist("2026-03-10T10:00:00"));
    // A night round written up at 09:00 the next morning: yesterday's visit, charged.
    await sign(w.consultant, admissionId, ist("2026-03-11T22:00:00"), ist("2026-03-12T09:00:00"));
    expect((await visits(admissionId)).map((v) => v.serviceDate)).toEqual(["2026-03-11"]);
    // Yesterday's round entered at 11:00: recorded, not charged, an exception for billing.
    const late = await sign(w.consultant, admissionId, ist("2026-03-12T20:00:00"), ist("2026-03-13T11:00:00"));
    expect(late.status).toBe("signed");
    expect((await db.select().from(ipdRounds).where(eq(ipdRounds.id, late.roundId)))[0]!.visitOutcome).toBe("backdated");
    expect((await visits(admissionId)).map((v) => v.serviceDate)).toEqual(["2026-03-11"]);
    const x = (await db.select().from(ipdChargeExceptions).where(eq(ipdChargeExceptions.reason, "visit_backdated")))[0]!;
    expect([x.serviceDate, x.component]).toEqual(["2026-03-12", "visit"]);
    // Billing's act, never the doctor's (decision 0058).
    await expect(resolveBackdatedVisit(db, w.consultant, { exceptionId: x.id, decision: "charge" })).rejects.toMatchObject({ code: "ipd_forbidden" });
    expect((await resolveBackdatedVisit(db, w.billDesk, { exceptionId: x.id, decision: "charge" }, { now: ist("2026-03-13T12:00:00") })).outcome).toBe("charged");
    expect((await visits(admissionId)).map((v) => v.serviceDate).sort()).toEqual(["2026-03-11", "2026-03-12"]);
  });

  it("YELLOW 14 / 15 — a unit consultant bills `visit`; another unit's bills `cross_visit`; a missing cross rate is an exception, never the visit rate", async () => {
    const { admissionId } = await w.admitMed(ist("2026-03-10T10:00:00"));
    await sign(w.head, admissionId, ist("2026-03-11T09:00:00"));
    expect((await visits(admissionId)).map((v) => [v.consultantUserId, v.component])).toEqual([[w.head.id, "visit"]]);
    // A private bed: the fixture prices `visit` there and no `cross_visit`.
    const priv = await w.admitAt("private", ist("2026-03-10T11:00:00"));
    await db.update(ipdAdmissions).set({ department: "MED" }).where(eq(ipdAdmissions.id, priv.admissionId));
    await requestConsult(db, w.consultant, { idempotencyKey: key(), admissionId: priv.admissionId, consultantId: w.cross.id, question: "Opinion", urgency: "routine" }, { now: ist("2026-03-11T08:00:00") });
    await sign(w.cross, priv.admissionId, ist("2026-03-11T09:30:00"));
    expect(await visits(priv.admissionId)).toEqual([]);
    const x = (await db.select().from(ipdChargeExceptions).where(eq(ipdChargeExceptions.admissionId, priv.admissionId)))[0]!;
    expect([x.reason, x.component]).toEqual(["rate_missing", "cross_visit"]);
  });

  it("YELLOW 16 / 20 — no nudge on a declared holiday; a stranded draft on an ended stay is queued and nudged once", async () => {
    const { admissionId } = await w.admitMed(ist("2026-03-10T10:00:00"));
    await db.insert(rosterHolidays).values({ istDate: "2026-03-11", kind: "gazetted", declaredBy: w.consultant.id, createdBy: w.consultant.id, updatedBy: w.consultant.id } as never);
    expect((await sweepIpdRoundsClock(db, ist("2026-03-11T14:00:00"))).nudges).toBe(0);
    expect((await sweepIpdRoundsClock(db, ist("2026-03-12T14:00:00"))).nudges).toBe(1);
    const draft = await sign(w.unitResident, admissionId, ist("2026-03-12T09:00:00"));
    await w.discharge(admissionId, ist("2026-03-12T12:00:00"));
    const queue = (await readRoundsList(db, w.consultant, ist("2026-03-14T09:00:00"))).cosignQueue.map((q) => q.roundId);
    expect(queue).toEqual([draft.roundId]);
    expect((await readRoundsList(db, w.consultant, ist("2026-03-21T09:00:00"))).cosignQueue).toEqual([]);
    expect((await sweepIpdRoundsClock(db, ist("2026-03-13T14:00:00"))).drafts).toBe(1);
    expect((await sweepIpdRoundsClock(db, ist("2026-03-13T14:01:00"))).drafts).toBe(0);
    expect(await refusal(cosignRound(db, w.cross, { idempotencyKey: key(), roundId: draft.roundId }, { now: ist("2026-03-13T15:00:00") }))).toBe("not_treating_consultant");
    expect((await cosignRound(db, w.consultant, { idempotencyKey: key(), roundId: draft.roundId }, { now: ist("2026-03-13T15:00:00") })).status).toBe("signed");
  });

  it("YELLOW 18 / BLUE 24 — the IP resolver answers only the admission-number grammar; reimbursement is self-pay", async () => {
    const unregister = registerIpdEncounterResolver();
    try {
      const { admissionId, patientId } = await w.admitMed(ist("2026-03-10T10:00:00"));
      const no = (await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, admissionId)))[0]!.admissionNo!;
      expect(IPD_ADMISSION_NO_RE.test(no)).toBe(true);
      expect(await resolveEncounterByPrefix(db, no)).toEqual({ matched: true, resolved: { patientId, intendedPayer: "self" } });
      expect(await resolveEncounterByPrefix(db, `${no}X`)).toEqual({ matched: true, resolved: null });
      expect(await resolveEncounterByPrefix(db, "IPX2603110001")).toEqual({ matched: true, resolved: null });
      // No episode series is a prefix of `IP` or begins with it; the "leading letters" readers read `IP`.
      for (const p of Object.values(EPISODE_SERIES)) expect([p, "IP".startsWith(p) || p.startsWith("IP")]).toEqual([p, false]);
      expect(/^[A-Z]+/.exec(no)?.[0]).toBe("IP");
    } finally {
      unregister();
    }
    expect(intendedPayerOfAdmission("insurance_reimbursement")).toBe("self");
    expect(intendedPayerOfAdmission("insurance_cashless")).toBe("tpa");
    expect(IPD_INTENTS.cosign_round.copilotProposable).toBe(false);
  });

  it("RED 21 — negatives, one visit under a race, and no money VALUE in any doctor answer", async () => {
    const { admissionId } = await w.admitMed(ist("2026-03-10T10:00:00"));
    const at = ist("2026-03-11T09:00:00");
    // Two sign-rounds at once: one visit line.
    const [r1, r2] = await Promise.all([sign(w.consultant, admissionId, at), sign(w.consultant, admissionId, ist("2026-03-11T09:01:00"))]);
    expect(await visits(admissionId)).toHaveLength(1);
    // Negatives.
    expect(await refusal(sign(w.consultant, admissionId, ist("2026-03-11T12:00:00"), at))).toBe("time_in_future");
    expect(await refusal(requestConsult(db, w.consultant, { idempotencyKey: key(), admissionId, consultantId: w.unitResident.id, question: "x", urgency: "routine" }, { now: at }))).toBe("consultant_not_found");
    const c = await requestConsult(db, w.consultant, { idempotencyKey: key(), admissionId, consultantId: w.cross.id, question: "x", urgency: "routine" }, { now: at });
    expect(await refusal(closeConsult(db, w.unitResident, { idempotencyKey: key(), consultId: c.consultId }, { now: at }))).toBe("not_treating_team");
    expect(await refusal(cosignRound(db, w.consultant, { idempotencyKey: key(), roundId: newId() }, { now: at }))).toBe("round_not_found");
    expect(await refusal(placeIpOrder(db, w.consultant, { idempotencyKey: key(), admissionId, kind: "drug", roundId: newId(), drug: {
      itemId: await w.medicine("Ondansetron", undefined, { strength: "4 mg" }), dose: { value: 4, unit: "mg" }, route: "iv", frequency: "TDS", startAt: at.toISOString(), antibiotic: false, durationDays: 2,
    } }, { now: at }))).toBe("round_not_found");
    await w.discharge(admissionId, ist("2026-03-11T12:00:00"));
    expect(await refusal(sign(w.consultant, admissionId, ist("2026-03-11T13:00:00")))).toBe("admission_wrong_state");
    // Money by VALUE, not only by key: no paise figure or rupee sign in a doctor's answer.
    const answers = JSON.stringify([r1, r2, await readRoundsList(db, w.consultant, at), await readRoundPatient(db, w.consultant, admissionId, at)]);
    expect(answers).not.toMatch(/₹|paise|rupee/i);
    for (const n of [80_000, 100_000, 150_000]) expect(answers.includes(String(n))).toBe(false);
  });
});
