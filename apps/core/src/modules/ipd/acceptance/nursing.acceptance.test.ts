import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ROLE_MODEL } from "../../../../scripts/seed-roles";
import { sql } from "drizzle-orm";
import { alerts, events, ipdAdmissions, ipdNursingAlerts, ipdNursingNotes, ipdVitals, patients, users } from "../../../kernel/db/schema";
import { loadDesk } from "../../../kernel/desk/registry";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkNursingWorld } from "../../../../test/helpers/ipd";
import {
  acceptShiftHandover, acknowledgeEwsAlert, addNursingNote, giveShiftHandover, recordIntakeOutput, ipdManifest, isNightIst, readNurseStation,
  recordNursingAssessment, recordVitals, sweepIpdNursing,
} from "../index";
import { IpdError, IpdRefusal } from "../errors";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";
import type { NursingWorld } from "../../../../test/helpers/ipd";

/**
 * E4.1 (#733) — "DONE MEANS" FOR IPD NURSING (plan M4 E4.1; spec SPEC-ipd-core §4.5, §4.9 C/D1, §4.10 edge 12):
 *   (i)   an admission with no nursing assessment within 1 h raises an alert — once;
 *   (ii)  NEWS2 for adults, MEOWS for obstetric patients, PEWS for children — chosen by patient type;
 *   (iii) one alert per breach: no repeat while it stands; a new alert when the score gets a band worse;
 *   (iv)  the offline vitals queue: a set stamped with the time it was TAKEN replays idempotently by its client key;
 *   (v)   night mode 22:00–06:00 IST, decided by the server's clock;
 *   plus the escalation (NEWS2 5+ or a single 3 tells the duty doctor; 7+ is the emergency band), the four Now cards each
 *   behind its own permission, and the condition word staying the doctor's.
 * Every act takes an EXPLICIT instant (IST); nothing here reads the clock for a decision it asserts.
 */

jest.setTimeout(240_000);

const ist = (s: string): Date => new Date(`${s}+05:30`);
const plus = (d: Date, minutes: number): Date => new Date(d.getTime() + minutes * 60_000);
const key = (): string => randomUUID();

/** NEWS2 sets. NORMAL scores 0; FIVE scores 5 (RR 21 → 2, SpO2 94 → 1, pulse 111 → 2); SEVEN 7 (adds SBP 100 → 2). */
const NORMAL = { temperatureC: 37, pulse: 80, respRate: 16, systolic: 125, diastolic: 80, spo2: 97, onOxygen: false, consciousness: "alert" as const };
const FIVE = { ...NORMAL, respRate: 21, spo2: 94, pulse: 111 };
const SEVEN = { ...FIVE, systolic: 100 };
/** A single red: new confusion alone scores 3 (low–medium band) and tells the doctor. */
const SINGLE_RED = { ...NORMAL, consciousness: "confused" as const };

async function refusalOf(p: Promise<unknown>): Promise<IpdRefusal | IpdError> {
  try { await p; } catch (e) { if (e instanceof IpdRefusal || e instanceof IpdError) return e; throw e; }
  throw new Error("expected a refusal, the act succeeded");
}

describe("E4.1 ipd-nursing — acceptance", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: NursingWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    w = await mkNursingWorld(db);
  });

  const vitals = (actor: Actor, admissionId: string, at: Date, values: Record<string, unknown>, k = key()) =>
    recordVitals(db, actor, { idempotencyKey: k, admissionId, observedAt: at.toISOString(), source: "person", values }, { now: at });
  const assess = (admissionId: string, at: Date, extra: Record<string, unknown> = {}) =>
    recordNursingAssessment(db, w.nurse, {
      idempotencyKey: key(), admissionId, happenedAt: at.toISOString(), source: "person", morse: 30, braden: 18, nutrition: "no_risk",
      allergyChecked: true, allergies: [], homeMedicines: [], painScore: 2, pressureInjuriesOnAdmission: [], ...extra,
    }, { now: at });
  const noticesTo = async (userId: string, kind: string) =>
    db.select().from(alerts).where(and(eq(alerts.userId, userId), eq(alerts.kind, kind)));
  const eventsNamed = async (name: string) => db.select().from(events).where(eq(events.name, name));

  it("(i) no nursing assessment one hour after admission raises ONE alert to the nursing supervisor", async () => {
    const t0 = ist("2026-03-10T10:00:00");
    const late = await w.admitPatient(t0);
    const done = await w.admitPatient(t0);
    await assess(done.admissionId, plus(t0, 40));

    expect(await sweepIpdNursing(db, plus(t0, 59))).toMatchObject({ assessmentOverdue: 0, ewsUnacked: 0 });
    expect(await sweepIpdNursing(db, plus(t0, 61))).toMatchObject({ assessmentOverdue: 1, ewsUnacked: 0 });
    expect(await sweepIpdNursing(db, plus(t0, 62))).toMatchObject({ assessmentOverdue: 0, ewsUnacked: 0 });

    const raised = await db.select().from(ipdNursingAlerts).where(eq(ipdNursingAlerts.kind, "assessment_overdue"));
    expect(raised.map((r) => r.admissionId)).toEqual([late.admissionId]);
    expect(await noticesTo(w.supervisor.id, "ipd.assessment_overdue")).toHaveLength(1);
    expect(await eventsNamed("ipd.nursing.assessment_overdue")).toHaveLength(1);

    // The assessment answers it; it is never raised again for this admission.
    await assess(late.admissionId, plus(t0, 70));
    const after = await db.select().from(ipdNursingAlerts).where(eq(ipdNursingAlerts.admissionId, late.admissionId));
    expect(after[0]!.clearedAt).not.toBeNull();
    expect(await sweepIpdNursing(db, plus(t0, 90))).toMatchObject({ assessmentOverdue: 0, ewsUnacked: 0 });
  });

  it("(ii) NEWS2 for an adult, MEOWS for a pregnant woman or an obstetric admission, PEWS for a child", async () => {
    const t0 = ist("2026-03-10T10:00:00");
    const adult = await w.admitPatient(t0, { sex: "male", ageYears: 54 });
    const pregnant = await w.admitPatient(t0, { sex: "female", ageYears: 27 });
    const obg = await w.admitPatient(t0, { sex: "female", ageYears: 31 });
    const child = await w.admitPatient(t0, { sex: "male", ageYears: 8 });
    await assess(pregnant.admissionId, plus(t0, 10), { obstetric: "pregnant" });
    await db.update(ipdAdmissions).set({ department: "OBG" }).where(eq(ipdAdmissions.id, obg.admissionId));

    const at = plus(t0, 30);
    expect((await vitals(w.nurse, adult.admissionId, at, NORMAL)).score?.kind).toBe("news2");
    expect((await vitals(w.nurse, pregnant.admissionId, at, NORMAL)).score?.kind).toBe("meows");
    expect((await vitals(w.nurse, obg.admissionId, at, NORMAL)).score?.kind).toBe("meows");
    // A child's pulse of 120 and breathing of 25 are normal for 8 years; NEWS2 would score them 5 (pulse 120 → 2, RR 25 → 3).
    const kid = await vitals(w.nurse, child.admissionId, at, { pulse: 120, respRate: 25, consciousness: "alert", spo2: 98 });
    expect(kid.score).toEqual({ kind: "pews", value: 0, band: "low" });
    const asAdult = await vitals(w.nurse, adult.admissionId, plus(at, 1), { pulse: 120, respRate: 25, consciousness: "alert", spo2: 98 });
    expect(asAdult.score).toEqual({ kind: "news2", value: 5, band: "medium" });
  });

  it("(iii) one alert per breach: told once, not again while it stands, again when a band worse, a new alert after it clears", async () => {
    const t0 = ist("2026-03-10T10:00:00");
    const p = await w.admitPatient(t0);
    await assess(p.admissionId, plus(t0, 5));
    const doctorNotices = async () => (await noticesTo(w.doctor.id, "ipd.ews_breach")).length;

    const first = await vitals(w.nurse, p.admissionId, plus(t0, 10), FIVE);
    expect(first).toMatchObject({ score: { kind: "news2", value: 5, band: "medium" }, alertRaised: true });
    expect(await doctorNotices()).toBe(1);

    const same = await vitals(w.nurse, p.admissionId, plus(t0, 20), FIVE);
    expect(same.alertRaised).toBe(false);
    // A set below the notify band (NEWS2 4: RR 21 → 2, SpO2 94 → 1, pulse 105 → 1) clears the breach.
    const lower = await vitals(w.nurse, p.admissionId, plus(t0, 30), { ...FIVE, pulse: 105 });
    expect(lower.score).toEqual({ kind: "news2", value: 4, band: "low" });
    const open = await db.select().from(ipdNursingAlerts).where(eq(ipdNursingAlerts.admissionId, p.admissionId));
    expect(open).toHaveLength(1);
    expect(open[0]!.clearedAt).not.toBeNull();
    expect(await doctorNotices()).toBe(1);

    // A new breach is a new alert; a band worse re-raises it (the doctor is told again); the same band again is quiet.
    const again = await vitals(w.nurse, p.admissionId, plus(t0, 40), FIVE);
    expect(again.alertRaised).toBe(true);
    const worse = await vitals(w.nurse, p.admissionId, plus(t0, 50), SEVEN);
    expect(worse).toMatchObject({ score: { value: 7, band: "high" }, alertRaised: true });
    const stillHigh = await vitals(w.nurse, p.admissionId, plus(t0, 55), SEVEN);
    expect(stillHigh.alertRaised).toBe(false);
    expect(await doctorNotices()).toBe(3);

    const rows = await db.select().from(ipdNursingAlerts).where(and(eq(ipdNursingAlerts.admissionId, p.admissionId), eq(ipdNursingAlerts.kind, "ews")));
    expect(rows).toHaveLength(2);
    const live = rows.find((r) => r.clearedAt === null)!;
    expect(live.band).toBe("high");
    // G7's instrument: the breach event is the same alert id on the re-raise.
    const breaches = (await eventsNamed("ipd.ews.breached")).map((e) => (e.payload as { alertId: string }).alertId);
    expect(breaches).toHaveLength(3);
    expect(breaches.filter((id) => id === live.id)).toHaveLength(2);
    // The emergency band also tells the nursing supervisor.
    expect(await noticesTo(w.supervisor.id, "ipd.ews_breach")).toHaveLength(1);
  });

  it("escalation: a single 3 (new confusion) tells the duty doctor; ten minutes unacknowledged tells the supervisor, once", async () => {
    const t0 = ist("2026-03-10T10:00:00");
    const p = await w.admitPatient(t0);
    await assess(p.admissionId, plus(t0, 5));
    const red = await vitals(w.nurse, p.admissionId, plus(t0, 10), SINGLE_RED);
    expect(red).toMatchObject({ score: { value: 3, band: "low_medium" }, alertRaised: true });
    expect(await noticesTo(w.doctor.id, "ipd.ews_breach")).toHaveLength(1);

    expect((await sweepIpdNursing(db, plus(t0, 19))).ewsUnacked).toBe(0);
    expect((await sweepIpdNursing(db, plus(t0, 21))).ewsUnacked).toBe(1);
    expect((await sweepIpdNursing(db, plus(t0, 22))).ewsUnacked).toBe(0);
    expect(await noticesTo(w.supervisor.id, "ipd.ews_unacknowledged")).toHaveLength(1);

    const alert = (await db.select().from(ipdNursingAlerts).where(eq(ipdNursingAlerts.admissionId, p.admissionId)))[0]!;
    await acknowledgeEwsAlert(db, w.doctor, { idempotencyKey: key(), alertId: alert.id }, { now: plus(t0, 25) });
    const ack = await eventsNamed("ipd.ews.acknowledged");
    expect(ack.map((e) => (e.payload as { byKind: string }).byKind)).toEqual(["doctor"]);
    // A ward nurse may not acknowledge (the permission is the doctor's and the supervisor's).
    expect((await refusalOf(acknowledgeEwsAlert(db, w.nurse, { idempotencyKey: key(), alertId: alert.id }, { now: plus(t0, 26) }))).code).toBe("ipd_forbidden");
  });

  it("(iv) an offline set keeps the time it was taken and records once however often it is replayed", async () => {
    const t0 = ist("2026-03-10T10:00:00");
    const p = await w.admitPatient(t0);
    await assess(p.admissionId, plus(t0, 5));
    const taken = plus(t0, 30);
    const sentAt = plus(t0, 55); // queued on the phone for 25 minutes
    const k = key();
    const body = { idempotencyKey: k, admissionId: p.admissionId, observedAt: taken.toISOString(), source: "person", values: NORMAL };
    const one = await recordVitals(db, w.nurse, body, { now: sentAt });
    const two = await recordVitals(db, w.nurse, body, { now: plus(sentAt, 1) });
    // The same set reaching the server by another person's session (a shared phone) is still the same set.
    const three = await recordVitals(db, w.nurse2, body, { now: plus(sentAt, 2) });
    expect(two.vitalsId).toBe(one.vitalsId);
    expect(three.vitalsId).toBe(one.vitalsId);
    const rows = await db.select().from(ipdVitals).where(eq(ipdVitals.admissionId, p.admissionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.observedAt.toISOString()).toBe(taken.toISOString());
    expect(rows[0]!.recordedAt.toISOString()).toBe(sentAt.toISOString());
    expect(one.lateEntry).toBe(true);
    expect(await eventsNamed("ipd.vitals.recorded")).toHaveLength(1);
    // A set stamped in the future (a wrong phone clock) is refused, not shifted.
    const future = await refusalOf(recordVitals(db, w.nurse, { ...body, idempotencyKey: key(), observedAt: plus(sentAt, 30).toISOString() }, { now: sentAt }));
    expect(future.code).toBe("time_in_future");
  });

  it("(v) night mode 22:00–06:00 IST on the station, from the server's clock", async () => {
    expect(isNightIst(ist("2026-03-10T21:59:00"))).toBe(false);
    expect(isNightIst(ist("2026-03-10T22:00:00"))).toBe(true);
    expect(isNightIst(ist("2026-03-11T05:59:00"))).toBe(true);
    expect(isNightIst(ist("2026-03-11T06:00:00"))).toBe(false);
    const t0 = ist("2026-03-10T21:00:00");
    await w.admitPatient(t0);
    expect((await readNurseStation(db, w.nurse, { now: ist("2026-03-10T23:30:00") })).night).toBe(true);
    expect((await readNurseStation(db, w.nurse, { now: ist("2026-03-11T09:30:00") })).night).toBe(false);
  });

  it("a value outside physiological limits asks for confirmation; a refused set is recorded as refused", async () => {
    const t0 = ist("2026-03-10T10:00:00");
    const p = await w.admitPatient(t0);
    const typo = await refusalOf(vitals(w.nurse, p.admissionId, plus(t0, 10), { ...NORMAL, pulse: 18 }));
    expect(typo.code).toBe("value_needs_confirm");
    const confirmed = await recordVitals(db, w.nurse, {
      idempotencyKey: key(), admissionId: p.admissionId, observedAt: plus(t0, 11).toISOString(), source: "person",
      values: { ...NORMAL, pulse: 18 }, confirmedOutOfRange: true,
    }, { now: plus(t0, 11) });
    expect(confirmed.score?.value).toBeGreaterThanOrEqual(3);
    const refused = await recordVitals(db, w.nurse, {
      idempotencyKey: key(), admissionId: p.admissionId, observedAt: plus(t0, 20).toISOString(), source: "person", values: {}, refused: true,
    }, { now: plus(t0, 20) });
    expect(refused.score).toBeNull();
    expect((await db.select().from(ipdVitals).where(eq(ipdVitals.id, refused.vitalsId)))[0]!.refused).toBe(true);
  });

  it("the shift handover: the next nurse accepts; the giver cannot; the Now card waits for it", async () => {
    const t0 = ist("2026-03-10T13:30:00");
    const p = await w.admitPatient(t0);
    const sbar = { situation: "Stable", background: "Pneumonia day 2", assessment: "NEWS2 1", recommendation: "Vitals 4-hourly" };
    const given = await giveShiftHandover(db, w.nurse, { idempotencyKey: key(), admissionId: p.admissionId, sbar }, { now: plus(t0, 20) });
    const own = await refusalOf(acceptShiftHandover(db, w.nurse, { idempotencyKey: key(), handoverId: given.handoverId }, { now: plus(t0, 25) }));
    expect(own.code).toBe("shift_handover_own");
    const ctx = (actor: Actor, now: Date) => ({ db, actor, reader: actor, date: "", now });
    const cards = async (actor: Actor, now: Date) => (await loadDesk(ipdManifest.desk!, ctx(actor, now))).cards.map((c) => c.key);
    expect(await cards(w.nurse2, plus(t0, 30))).toContain("ipd.handover_pending");
    await acceptShiftHandover(db, w.nurse2, { idempotencyKey: key(), handoverId: given.handoverId }, { now: plus(t0, 35) });
    expect(await cards(w.nurse2, plus(t0, 40))).not.toContain("ipd.handover_pending");
  });

  it("the four nursing Now cards: each behind its own permission; a stable, assessed patient makes none", async () => {
    const t0 = ist("2026-03-10T10:00:00");
    const p = await w.admitPatient(t0);
    const ctx = (actor: Actor, now: Date) => ({ db, actor, reader: actor, date: "", now });
    const cards = async (actor: Actor, now: Date) => (await loadDesk(ipdManifest.desk!, ctx(actor, now))).cards.map((c) => c.key);
    expect(await cards(w.nurse, plus(t0, 30))).toContain("ipd.assessment_due");
    await assess(p.admissionId, plus(t0, 40));
    await vitals(w.nurse, p.admissionId, plus(t0, 45), NORMAL);
    const stable = await cards(w.nurse, plus(t0, 60));
    for (const k of ["ipd.assessment_due", "ipd.overdue_vitals", "ipd.ews_rising", "ipd.handover_pending"]) expect([k, stable.includes(k)]).toEqual([k, false]);
    // NEWS2 0 is due again in 12 hours: past that, overdue_vitals.
    expect(await cards(w.nurse, plus(t0, 45 + 12 * 60 + 5))).toContain("ipd.overdue_vitals");
    await vitals(w.nurse, p.admissionId, plus(t0, 50), FIVE);
    // ews_rising is the responders' card: the supervisor sees it, the ward nurse (no ipd.ews.respond) does not.
    expect(await cards(w.supervisor, plus(t0, 55))).toContain("ipd.ews_rising");
    expect(await cards(w.nurse, plus(t0, 55))).not.toContain("ipd.ews_rising");
    const decl = Object.fromEntries(ipdManifest.desk!.map((d) => [d.key, d.permission]));
    expect([decl["ipd.overdue_vitals"], decl["ipd.assessment_due"], decl["ipd.ews_rising"], decl["ipd.handover_pending"]])
      .toEqual(["ipd.vitals.record", "ipd.assessment.record", "ipd.ews.respond", "ipd.handover.shift"]);
  });

  it("the condition word stays the doctor's: no nursing role holds ipd.condition.set; the supervisor works the family's callbacks", () => {
    const holders = ROLE_MODEL.filter((r) => r.permissions.includes("ipd.condition.set")).map((r) => r.roleKey);
    expect(holders).toEqual(["doctor"]);
    const role = (k: string) => ROLE_MODEL.find((r) => r.roleKey === k)?.permissions ?? [];
    for (const k of ["ward_nurse", "nursing_supervisor", "nursing_superintendent"]) expect([k, role(k).length > 0]).toEqual([k, true]);
    expect(role("nursing_supervisor")).toEqual(expect.arrayContaining(["ipd.family.issue", "ipd.discharge.view", "ipd.ews.respond"]));
    expect(role("ward_nurse")).toEqual(expect.arrayContaining(["ipd.vitals.record", "ipd.assessment.record", "ipd.handover.shift", "ipd.transfer.accept"]));
  });

  // ═══════════════════════════════ E4.1 review (b0334887) — each leg failed first on b0334887 ═══════════════════════════════

  const setActive = (id: string, active: boolean) => db.update(users).set({ active }).where(eq(users.id, id));
  const ewsAlertOf = async (admissionId: string) =>
    (await db.select().from(ipdNursingAlerts).where(and(eq(ipdNursingAlerts.admissionId, admissionId), eq(ipdNursingAlerts.kind, "ews"))))
      .find((r) => r.clearedAt === null);

  it("review 1: a relapse re-notifies — high → medium → high, and medium → low–medium → medium", async () => {
    const t0 = ist("2026-03-10T10:00:00");
    const p = await w.admitPatient(t0);
    const q = await w.admitPatient(t0);
    await assess(p.admissionId, plus(t0, 5));
    await assess(q.admissionId, plus(t0, 5));
    const told = async (admissionId: string) => (await db.select().from(alerts)
      .where(and(eq(alerts.userId, w.doctor.id), eq(alerts.kind, "ipd.ews_breach"), eq(alerts.refId, admissionId)))).length;

    expect((await vitals(w.nurse, p.admissionId, plus(t0, 10), SEVEN)).alertRaised).toBe(true);
    expect((await vitals(w.nurse, p.admissionId, plus(t0, 20), FIVE)).alertRaised).toBe(false);
    expect((await ewsAlertOf(p.admissionId))!.band).toBe("medium");
    expect((await vitals(w.nurse, p.admissionId, plus(t0, 30), SEVEN)).alertRaised).toBe(true);
    expect(await told(p.admissionId)).toBe(2);

    expect((await vitals(w.nurse, q.admissionId, plus(t0, 10), FIVE)).alertRaised).toBe(true);
    expect((await vitals(w.nurse, q.admissionId, plus(t0, 20), SINGLE_RED)).alertRaised).toBe(false);
    expect((await vitals(w.nurse, q.admissionId, plus(t0, 30), FIVE)).alertRaised).toBe(true);
    expect(await told(q.admissionId)).toBe(2);
  });

  it("review 2 + 10: no doctor → the nursing chain now (\"No doctor reached\"); nobody at all → not stamped, retried next tick", async () => {
    const t0 = ist("2026-03-10T10:00:00");
    const p = await w.admitPatient(t0);
    await assess(p.admissionId, plus(t0, 5));
    await setActive(w.doctor.id, false);
    const first = await vitals(w.nurse, p.admissionId, plus(t0, 10), FIVE);
    expect(first).toMatchObject({ alertRaised: true, doctorReached: false });
    const toSup = await noticesTo(w.supervisor.id, "ipd.ews_breach");
    expect(toSup).toHaveLength(1);
    expect(toSup[0]!.body).toContain("No doctor reached — call");
    expect((await readNurseStation(db, w.nurse, { now: plus(t0, 11) })).beds.find((b) => b.alert !== null)!.alert!.doctorReached).toBe(false);

    // Nobody at all: the alert stands un-notified and the sweep retries it once somebody exists.
    const q = await w.admitPatient(t0);
    await assess(q.admissionId, plus(t0, 5));
    await setActive(w.supervisor.id, false);
    const nobody = await vitals(w.nurse, q.admissionId, plus(t0, 12), FIVE);
    expect(nobody.alertRaised).toBe(false);
    expect((await ewsAlertOf(q.admissionId))!.notifiedAt).toBeNull();
    expect((await sweepIpdNursing(db, plus(t0, 13))).ewsRetried).toBe(0);
    await setActive(w.supervisor.id, true);
    expect((await sweepIpdNursing(db, plus(t0, 14))).ewsRetried).toBe(1);
    expect((await ewsAlertOf(q.admissionId))!.notifiedAt).not.toBeNull();
  });

  it("review 2: an overdue assessment with nobody to tell is retried next tick, not stamped", async () => {
    const t0 = ist("2026-03-10T10:00:00");
    const p = await w.admitPatient(t0);
    await setActive(w.supervisor.id, false);
    expect((await sweepIpdNursing(db, plus(t0, 61))).assessmentOverdue).toBe(0);
    expect(await eventsNamed("ipd.nursing.assessment_overdue")).toHaveLength(0);
    await setActive(w.supervisor.id, true);
    expect((await sweepIpdNursing(db, plus(t0, 62))).assessmentOverdue).toBe(1);
    expect((await noticesTo(w.supervisor.id, "ipd.assessment_overdue")).map((n) => n.refId)).toEqual([p.admissionId]);
  });

  it("review 2 + 11 + 15: the 10-minute step needs a DOCTOR's acknowledgement; a supervisor's is 'seen'; nobody to tell → retried", async () => {
    const t0 = ist("2026-03-10T10:00:00");
    const p = await w.admitPatient(t0);
    await assess(p.admissionId, plus(t0, 5));
    await vitals(w.nurse, p.admissionId, plus(t0, 10), FIVE);
    const alert = (await ewsAlertOf(p.admissionId))!;
    const seen = await acknowledgeEwsAlert(db, w.supervisor, { idempotencyKey: key(), alertId: alert.id, note: "Seen, calling the RMO" }, { now: plus(t0, 12) });
    expect(seen).toMatchObject({ byDoctor: false, acknowledgedAt: null });
    const row = (await ewsAlertOf(p.admissionId))!;
    expect([row.seenBy, row.acknowledgedAt, row.ackNote]).toEqual([w.supervisor.id, null, "Seen, calling the RMO"]);
    // An inactive supervisor is never told; with nobody active the step waits and is retried.
    await setActive(w.supervisor.id, false);
    expect((await sweepIpdNursing(db, plus(t0, 21))).ewsUnacked).toBe(0);
    await setActive(w.supervisor.id, true);
    expect((await sweepIpdNursing(db, plus(t0, 22))).ewsUnacked).toBe(1);

    // A doctor's acknowledgement stops it for the next breach; the note rides the event.
    const q = await w.admitPatient(t0);
    await assess(q.admissionId, plus(t0, 5));
    await vitals(w.nurse, q.admissionId, plus(t0, 30), FIVE);
    const qa = (await ewsAlertOf(q.admissionId))!;
    await acknowledgeEwsAlert(db, w.doctor, { idempotencyKey: key(), alertId: qa.id, note: "Reviewed, fluids" }, { now: plus(t0, 32) });
    expect((await sweepIpdNursing(db, plus(t0, 45))).ewsUnacked).toBe(0);
    const ack = (await eventsNamed("ipd.ews.acknowledged")).map((e) => e.payload as { byKind: string; note: string | null; stopsEscalation: boolean });
    expect(ack).toEqual(expect.arrayContaining([
      expect.objectContaining({ byKind: "doctor", note: "Reviewed, fluids", stopsEscalation: true }),
      expect.objectContaining({ byKind: "supervisor", stopsEscalation: false }),
    ]));
  });

  it("review 3 + 4: a SEALED patient: notices say 'Sealed patient' with no bed or IP number; the station card carries none either", async () => {
    const t0 = ist("2026-03-10T10:00:00");
    const p = await w.admitPatient(t0);
    await db.update(patients).set({ sensitiveContext: true }).where(eq(patients.id, p.patientId));
    await assess(p.admissionId, plus(t0, 5));
    await vitals(w.nurse, p.admissionId, plus(t0, 10), FIVE);
    const notice = (await noticesTo(w.doctor.id, "ipd.ews_breach"))[0]!;
    expect(notice.body).toBe("Sealed patient · Review now");
    const admissionNo = (await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, p.admissionId)))[0]!.admissionNo!;
    const station = await readNurseStation(db, w.nurse, { now: plus(t0, 11) });
    const card = station.beds.find((b) => b.patient?.admissionId === p.admissionId)!;
    expect([card.code, card.consultant, card.patient!.admissionNo, card.dayOfStay, card.patient!.uhid]).toEqual([null, null, null, null, ""]);
    expect(JSON.stringify(card)).not.toContain(admissionNo);
    expect(JSON.stringify(card)).not.toContain("NRS-B");
  });

  it("review 8: a set older than 24 h is refused; past the 30-minute queue it is accepted and marked late 'offline'", async () => {
    const t0 = ist("2026-03-10T10:00:00");
    const p = await w.admitPatient(t0);
    const at = plus(t0, 26 * 60);
    const old = await refusalOf(recordVitals(db, w.nurse, {
      idempotencyKey: key(), admissionId: p.admissionId, observedAt: plus(at, -(24 * 60 + 1)).toISOString(), source: "person", values: NORMAL,
    }, { now: at }));
    expect(old.code).toBe("observation_too_old");
    const offline = await recordVitals(db, w.nurse, {
      idempotencyKey: key(), admissionId: p.admissionId, observedAt: plus(at, -40).toISOString(), source: "person", values: NORMAL,
    }, { now: at });
    expect(offline.lateEntry).toBe(true);
    expect((await db.select().from(ipdVitals).where(eq(ipdVitals.id, offline.vitalsId)))[0]!.lateReason).toBe("offline");
    const typed = await recordVitals(db, w.nurse, {
      idempotencyKey: key(), admissionId: p.admissionId, observedAt: plus(at, -20).toISOString(), source: "person", values: NORMAL,
    }, { now: at });
    expect((await db.select().from(ipdVitals).where(eq(ipdVitals.id, typed.vitalsId)))[0]!.lateReason).toBe("typed_late");
  });

  it("review 9: one failing row in the sweep does not block the others", async () => {
    const t0 = ist("2026-03-10T10:00:00");
    const bad = await w.admitPatient(t0);
    const good = await w.admitPatient(t0);
    const r = await sweepIpdNursing(db, plus(t0, 61), { beforeRow: (id) => { if (id === bad.admissionId) throw new Error("synthetic row failure"); } });
    expect(r).toMatchObject({ assessmentOverdue: 1, failed: 1 });
    expect((await noticesTo(w.supervisor.id, "ipd.assessment_overdue")).map((n) => n.refId)).toEqual([good.admissionId]);
  });

  it("review 12: the nursing record tables are append-only in the database", async () => {
    const t0 = ist("2026-03-10T10:00:00");
    const p = await w.admitPatient(t0);
    const v = await vitals(w.nurse, p.admissionId, plus(t0, 10), NORMAL);
    const n = await addNursingNote(db, w.nurse, {
      idempotencyKey: key(), admissionId: p.admissionId, observedAt: plus(t0, 11).toISOString(), source: "person", category: "general", text: "Settled",
    }, { now: plus(t0, 11) });
    await expect(db.update(ipdVitals).set({ pulse: 60 }).where(eq(ipdVitals.id, v.vitalsId))).rejects.toThrow(/append-only|ipd_nursing_append_only/);
    await expect(db.delete(ipdNursingNotes).where(eq(ipdNursingNotes.id, n.noteId))).rejects.toThrow(/append-only|ipd_nursing_append_only/);
    await expect(db.execute(sql`update ipd_nursing_assessments set morse = 0`)).resolves.toBeDefined(); // no rows yet: nothing to refuse
    await assess(p.admissionId, plus(t0, 12));
    await expect(db.execute(sql`update ipd_nursing_assessments set morse = 0`)).rejects.toThrow(/append-only|ipd_nursing_append_only/);
    await recordIntakeOutput(db, w.nurse, {
      idempotencyKey: key(), admissionId: p.admissionId, observedAt: plus(t0, 13).toISOString(), source: "person", direction: "in", kind: "oral", volumeMl: 200,
    }, { now: plus(t0, 13) });
    await expect(db.execute(sql`update ipd_intake_output set volume_ml = 1`)).rejects.toThrow(/append-only|ipd_nursing_append_only/);
  });

  it("review 16: a replay answers what the first act raised", async () => {
    const t0 = ist("2026-03-10T10:00:00");
    const p = await w.admitPatient(t0);
    await assess(p.admissionId, plus(t0, 5));
    const k = key();
    const body = { idempotencyKey: k, admissionId: p.admissionId, observedAt: plus(t0, 10).toISOString(), source: "person", values: FIVE };
    const first = await recordVitals(db, w.nurse, body, { now: plus(t0, 10) });
    const replay = await recordVitals(db, w.nurse2, body, { now: plus(t0, 11) });
    expect(first.alertRaised).toBe(true);
    expect(replay).toMatchObject({ vitalsId: first.vitalsId, alertRaised: true, doctorReached: true });
  });
});
